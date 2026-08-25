/**
 * route-cache.ts — 路由级响应缓存中间件工厂
 *
 * 职责：
 *   1. normalizeCacheOptions：统一 false/number/object → RouteCacheOptions | null
 *   2. defaultCacheKey：默认 key 生成（method:path?sortedQuery|varyHeaders）
 *   3. buildRouteCacheMiddleware：构建路由级响应缓存中间件
 *
 * 设计：
 *   - 缓存中间件插入在路由级中间件之后、validate 之前
 *   - HIT：直接发送 response-cache-kit 结果（跳过 validate + handler）
 *   - MISS：注册 res._onSend 钩子，handler 执行 res.json() 时捕获原始 data
 *   - 204 / 非 JSON 响应不缓存
 *   - 空 key 跳过缓存
 *
 * @module lib/middlewares/route-cache
 * @see 15-route-cache.md §4（内部架构）
 */

import type { VextMiddleware } from "../../types/middleware.js";
import type { RouteCacheOptions } from "../../types/app.js";
import type { VextRequest } from "../../types/request.js";
import type { VextInternalHooks } from "../../types/hooks.js";
import type { VextHeaders } from "../../types/headers.js";
import { hasHeader, setHeader } from "../headers.js";
import {
  VEXT_CACHEABLE_STATUSES,
  createResponseCacheHeaders,
  createVextLegacyKey,
  normalizeResponseCacheRequest,
} from "response-cache-kit";
import type {
  HeaderBag,
  ResponseCache,
  ResponseCacheHandleOptions,
  ResponseCacheKeyBuilder,
  ResponseCacheOriginResponse,
} from "response-cache-kit";

// ── normalizeCacheOptions ──────────────────────────────────────

/**
 * 统一路由级 cache 配置
 *
 * @param cache RouteOptions.cache 原始值
 * @param globalDefaultTtl 全局默认 TTL（来自 config.cache.defaultTtl）
 * @returns 规范化的 RouteCacheOptions | null（null 表示不缓存）
 *
 * 规则：
 *   - `undefined` → null（未配置，不缓存）
 *   - `false`     → null（显式禁用）
 *   - `0` 或负值  → null（数字简写禁用）
 *   - `number > 0` → { ttl: number }（数字简写）
 *   - `{ ttl, ... }` → 原样返回（对象形式）
 */
export function normalizeCacheOptions(
  cache: false | number | RouteCacheOptions | undefined,
  globalDefaultTtl?: number,
): RouteCacheOptions | null {
  if (cache === undefined || cache === false) {
    return null;
  }

  if (typeof cache === "number") {
    if (cache <= 0) return null;
    return { ttl: cache };
  }

  // 对象形式
  if (!cache.ttl && globalDefaultTtl && globalDefaultTtl > 0) {
    return { ...cache, ttl: globalDefaultTtl };
  }

  if (cache.ttl <= 0) {
    return null;
  }

  return cache;
}

// ── defaultCacheKey ────────────────────────────────────────────

/**
 * 默认缓存 key 生成
 *
 * 格式: `${method}:${path}[?${sortedQuery}][|${varyValues}]`
 *
 * 设计原则:
 *   1. method + path 天然区分不同路由和动态参数
 *      (req.path = '/users/42' 而非 '/users/:id')
 *   2. query 参数排序确保 ?a=1&b=2 ≡ ?b=2&a=1
 *   3. vary headers 区分同路径不同语言/编码
 *   4. 不含 auth/cookie → 安全默认
 *
 * 示例:
 *   GET /products               → 'GET:/products'
 *   GET /products?limit=10&page=2 → 'GET:/products?limit=10&page=2'
 *   GET /products + zh-CN         → 'GET:/products|accept-language=zh-CN'
 */
export function defaultCacheKey(
  req: VextRequest,
  vary: string[] | "*" = [],
): string {
  let key = `${req.method}:${req.path}`;

  const queryKeys = Object.keys(req.query);
  if (queryKeys.length > 0) {
    queryKeys.sort();
    key += "?" + queryKeys.map((k) => `${k}=${req.query[k]}`).join("&");
  }

  const varyHeaders = vary === "*" ? Object.keys(req.headers).sort() : vary;
  if (varyHeaders.length > 0) {
    for (const h of varyHeaders) {
      key += `|${h}=${req.headers[h.toLowerCase()] ?? ""}`;
    }
  }

  return key;
}

// ── buildRouteCacheMiddleware ──────────────────────────────────

/**
 * 构建路由级响应缓存中间件
 *
 * @param cacheOpts 规范化后的缓存配置（null 时返回 null，不构建中间件）
 * @param getResponseCache 延迟获取 ResponseCache 实例（避免在路由注册时实例尚未就绪）
 * @returns VextMiddleware | null
 */
export function buildRouteCacheMiddleware(
  cacheOpts: RouteCacheOptions | null,
  getResponseCache: () => ResponseCache,
  hooks?: VextInternalHooks,
): VextMiddleware | null {
  if (!cacheOpts) return null;

  const {
    ttl,
    key: keyFn,
    condition,
    vary = [],
    cacheControl = true,
    partitionKey,
    allowAuthorizationCache = false,
    allowCookieCache = false,
  } = cacheOpts;

  const cacheMiddleware: VextMiddleware = async (req, res, next) => {
    // ── condition 检查 ───────────────────────────────────
    if (condition && !condition(req)) {
      res.setHeader("X-Cache", "MISS");
      hooks?.emitSafeSync("cache:miss", {
        req,
        route: req.route,
        state: "skipped",
      });
      await next();
      return;
    }

    // ── 生成缓存 key ────────────────────────────────────
    const cacheKey =
      typeof keyFn === "function"
        ? keyFn(req)
        : typeof keyFn === "string"
          ? keyFn
          : defaultCacheKey(req, vary);

    // 空 key 跳过缓存
    if (!cacheKey) {
      hooks?.emitSafeSync("cache:miss", {
        req,
        route: req.route,
        state: "skipped",
      });
      await next();
      return;
    }

    const resolvedPartitionKey = resolvePartitionKey(req, partitionKey);
    const request = normalizeResponseCacheRequest({
      method: req.method,
      url: req.url || req.path,
      headers: req.headers,
      partitionKey: resolvedPartitionKey,
    });
    const requestAllowsCache = isCacheableRequest(
      req,
      resolvedPartitionKey,
      allowAuthorizationCache,
      allowCookieCache,
    );
    const handleOptions = createHandleOptions(
      cacheKey,
      cacheOpts,
      keyFn !== undefined,
    );
    const responseCache = getResponseCache();

    res.setHeader("X-Cache", "MISS");
    hooks?.emitSafeSync("cache:miss", {
      req,
      route: req.route,
      key: cacheKey,
      state: "miss",
    });

    const origin = createOrigin(req, res, next, {
      requestAllowsCache,
      ttl,
      cacheControl,
      hooks,
      cacheKey,
    });
    let result: Awaited<ReturnType<ResponseCache["handle"]>>;
    try {
      result = await responseCache.handle(request, origin, handleOptions);
    } catch (error) {
      hooks?.emitSafeSync("cache:error", {
        req,
        route: req.route,
        key: cacheKey,
        state: "error",
        error,
      });
      throw error;
    }

    if (
      result.metadata.state === "hit" ||
      result.metadata.state === "deduped"
    ) {
      hooks?.emitSafeSync("cache:hit", {
        req,
        route: req.route,
        key: cacheKey,
        state: result.metadata.state,
        metadata: result.metadata,
      });
      const headers = createVextHeaders(result, cacheControl);
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      if (isRenderCacheHit(result.body)) {
        sendCachedRender(res, result.body, result.status, headers);
        return;
      }
      if (isLegacyHtmlCacheHit(result.body, headers)) {
        sendCachedHtml(res, String(result.body), result.status, headers);
        return;
      }
      res.json(result.body, result.status);
    }
  };

  return cacheMiddleware;
}

function createHandleOptions(
  cacheKey: string,
  cacheOpts: RouteCacheOptions,
  hasCustomKey: boolean,
): ResponseCacheHandleOptions {
  const options: ResponseCacheHandleOptions = {
    ttl: cacheOpts.ttl,
    vary: cacheOpts.vary ?? [],
    tags: cacheOpts.tags ?? [],
    cacheableStatuses: VEXT_CACHEABLE_STATUSES,
    allowAuthorizationCache: cacheOpts.allowAuthorizationCache === true,
    keyBuilder: hasCustomKey
      ? createVextCustomKeyBuilder(cacheKey)
      : createVextLegacyKey,
  };

  return options;
}

function createVextCustomKeyBuilder(baseKey: string): ResponseCacheKeyBuilder {
  return (request, context) => {
    const parts = [baseKey];
    if (request.partitionKey) {
      parts.push(`partition=${request.partitionKey}`);
    }

    const headers = normalizeRequestHeaders(request.headers);
    for (const rawName of context.vary) {
      const name = rawName.toLowerCase();
      const value = headers[name];
      if (value !== undefined) {
        parts.push(`${name}=${value}`);
      }
    }

    return parts.join("|");
  };
}

function createOrigin(
  req: VextRequest,
  res: Parameters<VextMiddleware>[1],
  next: () => Promise<void>,
  options: {
    requestAllowsCache: boolean;
    ttl: number;
    cacheControl: boolean;
    hooks?: VextInternalHooks;
    cacheKey: string;
  },
): () => Promise<ResponseCacheOriginResponse> {
  return () =>
    new Promise<ResponseCacheOriginResponse>((resolve, reject) => {
      let settled = false;
      const previousOnSend = res._onSend;

      res._onSend = (data, statusCode, headers = {}) => {
        previousOnSend?.(data, statusCode, headers);

        // headers is the post-_onBeforeSend bag (includes Session Set-Cookie).
        // Mutate it so adapter replaceHeaders applies Cache-Control to the wire.
        const hasSetCookie = hasHeader(headers, "Set-Cookie");
        const hasPendingSessionCommit = res._sessionCommitPending === true;
        const responseHeaders = toCacheHeaderBag(headers);
        if (
          !options.requestAllowsCache ||
          hasSetCookie ||
          hasPendingSessionCommit
        ) {
          res.setHeader("Cache-Control", "no-store");
          setHeader(headers, "Cache-Control", "no-store");
          responseHeaders["Cache-Control"] = "no-store";
        } else if (
          options.cacheControl &&
          shouldSetMissCacheControl(statusCode, responseHeaders)
        ) {
          const value = `public, max-age=${Math.ceil(options.ttl / 1000)}`;
          res.setHeader("Cache-Control", value);
          setHeader(headers, "Cache-Control", value);
          responseHeaders["Cache-Control"] = value;
        }

        if (!settled) {
          options.hooks?.emitSafeSync("cache:write", {
            req,
            route: req.route,
            key: options.cacheKey,
            state: "write",
          });
          settled = true;
          resolve({ body: data, status: statusCode, headers: responseHeaders });
        }
      };

      next()
        .then(() => {
          if (!settled) {
            settled = true;
            resolve({
              body: undefined,
              status: res.statusCode,
              headers: { "Cache-Control": "no-store" },
            });
          }
        })
        .catch((error: unknown) => {
          if (!settled) {
            settled = true;
            reject(error);
            return;
          }
          reject(error);
        });
    });
}

function createVextHeaders(
  result: Parameters<typeof createResponseCacheHeaders>[0],
  cacheControl: boolean,
): HeaderBag {
  const headers: HeaderBag = {};
  for (const [name, value] of Object.entries(result.headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "x-cache") continue;
    if (cacheControl && normalized === "cache-control") continue;
    headers[name] = value;
  }
  Object.assign(
    headers,
    createResponseCacheHeaders(result, {
      cacheControl,
      cacheHeaderName: false,
    }),
  );
  headers["X-Cache"] =
    result.metadata.state === "hit" || result.metadata.state === "deduped"
      ? "HIT"
      : "MISS";
  const cacheControlValue = headers["Cache-Control"];
  if (cacheControlValue) {
    headers["Cache-Control"] = cacheControlValue.replace(
      "public,max-age",
      "public, max-age",
    );
  }
  return headers;
}

function isRenderCacheHit(body: unknown): boolean {
  return isRecord(body) && body.__vextResponseKind === "render";
}

function sendCachedRender(
  res: Parameters<VextMiddleware>[1],
  payload: unknown,
  status: number,
  headers: HeaderBag,
): void {
  if (!res._renderCached) {
    throw new Error(
      "[vextjs] cached render response requires frontend renderer middleware. Ensure frontend render middleware is registered before route cache.",
    );
  }
  res._renderCached(payload, status, headers);
}

function isLegacyHtmlCacheHit(body: unknown, headers: HeaderBag): boolean {
  if (typeof body !== "string") return false;
  const contentType = getHeaderValue(headers, "Content-Type");
  return contentType.toLowerCase().includes("text/html");
}

function sendCachedHtml(
  res: Parameters<VextMiddleware>[1],
  html: string,
  status: number,
  headers: HeaderBag,
): void {
  if (res._sendHtml) {
    res._sendHtml(html, status, headers, "render");
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.text(html, status);
}

function getHeaderValue(headers: HeaderBag, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePartitionKey(
  req: VextRequest,
  partitionKey: RouteCacheOptions["partitionKey"],
): string | undefined {
  if (typeof partitionKey === "function") {
    const value = partitionKey(req);
    return value == null || value === "" ? undefined : String(value);
  }
  return partitionKey;
}

function isCacheableRequest(
  req: VextRequest,
  partitionKey: string | undefined,
  allowAuthorizationCache: boolean,
  allowCookieCache: boolean,
): boolean {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const cacheControl = req.headers["cache-control"] ?? "";
  if (hasCacheControlToken(cacheControl, "no-store")) return false;
  if (hasCacheControlToken(cacheControl, "no-cache")) return false;

  if (req.headers.authorization && !allowAuthorizationCache && !partitionKey) {
    return false;
  }

  if (hasHeader(req.headers as VextHeaders, "Cookie") && !allowCookieCache) {
    return false;
  }

  return true;
}

function shouldSetMissCacheControl(
  statusCode: number,
  headers: HeaderBag,
): boolean {
  if (!VEXT_CACHEABLE_STATUSES.includes(statusCode)) return false;
  if (hasHeader(headers, "Cache-Control")) return false;
  if (hasHeader(headers, "Set-Cookie")) return false;
  return true;
}

function hasCacheControlToken(value: string, token: string): boolean {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes(token);
}

function toCacheHeaderBag(headers: VextHeaders): HeaderBag {
  const cacheHeaders: HeaderBag = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie") continue;
    cacheHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return cacheHeaders;
}

function normalizeRequestHeaders(
  headers: Parameters<ResponseCacheKeyBuilder>[0]["headers"],
): HeaderBag {
  const normalized: HeaderBag = {};
  if (!headers) return normalized;

  if (typeof (headers as { forEach?: unknown }).forEach === "function") {
    (
      headers as {
        forEach(callback: (value: string, key: string) => void): void;
      }
    ).forEach((value, key) => {
      normalized[key.toLowerCase()] = String(value);
    });
    return normalized;
  }

  if (Symbol.iterator in Object(headers)) {
    for (const [key, value] of headers as Iterable<
      readonly [string, unknown]
    >) {
      if (value !== undefined && value !== null) {
        normalized[String(key).toLowerCase()] = String(value);
      }
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (value !== undefined && value !== null) {
      normalized[key.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    }
  }
  return normalized;
}
