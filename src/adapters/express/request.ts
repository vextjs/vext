import type { Request as ExpressRequest } from "express";
import type { VextRequest } from "../../types/request.js";
import type { VextApp } from "../../types/app.js";
import type { VextCookieJar } from "../../types/cookies.js";
import { createAnonymousAuthContext } from "../../lib/auth.js";
import { parseCookies } from "../../lib/cookies.js";
import { assertBodySize } from "../../lib/middlewares/body-parser.js";
import { flattenQueryRecord } from "../../lib/query.js";
import {
  addRequestCloseHandler,
  fireRequestCloseHandlers,
} from "../../lib/request-close.js";

/**
 * Express Request → VextRequest 转换
 *
 * 将 Express 的 Request 对象转换为 vext 框架的统一请求接口。
 * 所有底层框架特有的 API 在此处适配，后续代码只与 VextRequest 交互。
 *
 * 转换要点：
 *   - query: Express 已解析好 query 对象，直接使用（转为 Record<string, string>）
 *   - body: 由 body-parser 中间件后续填充（初始 undefined）
 *   - params: Express 已解析好 params 对象，直接使用
 *   - headers: Express 的 req.headers 是 Node.js 原生 headers 对象（key 全小写）
 *   - requestId: 由 requestId 中间件后续填充（初始空字符串）
 *   - ip: 根据 trustProxy 配置决定从 X-Forwarded-For 或 socket 读取
 *   - protocol: 根据 trustProxy 配置决定从 X-Forwarded-Proto 或默认值读取
 *   - onClose: 注册请求关闭钩子，连接断开时触发（通过 req.on('close')）
 *   - valid: 获取 validate 中间件校验后的数据
 *   - _getRawBody: 从请求流中读取原始请求体文本，供 vext body-parser 中间件使用
 *
 * 与 Hono / Fastify Adapter 的差异：
 *   - Hono 通过 c.req.text() 读取 Web Request body（ReadableStream）
 *   - Fastify 通过 removeAllContentTypeParsers + addContentTypeParser('*', parseAs: 'buffer')
 *     将原始 body 作为 Buffer 传入 request.body
 *   - Express: 禁用 Express 内置 body-parser，通过监听 req 的 'data'/'end' 事件
 *     手动收集原始 body 为 Buffer（在 adapter 层完成），存入 (req as any)._vextRawBody
 *   - 三者最终都通过 req._getRawBody() 返回 string 供 vext body-parser 使用
 *
 * @param expressReq Express Request 对象
 * @param app        VextApp 实例
 * @param rawBody    预收集的原始请求体 Buffer（由 adapter 层在路由 handler 前收集）
 * @returns VextRequest 实例（含 _getRawBody 内部方法供 body-parser 使用）
 *
 * @see adapters/hono/request.ts（Hono Adapter 对应实现）
 * @see adapters/fastify/request.ts（Fastify Adapter 对应实现）
 */
export function createVextRequest(
  expressReq: ExpressRequest,
  app: VextApp,
  rawBody?: Buffer,
): VextRequest {
  const trustProxy = app.config.trustProxy ?? false;

  // ── 解析 query 参数 ──────────────────────────────────────
  //
  // Express 的 req.query 是 qs 解析的结果，可能包含嵌套对象 / 数组。
  // VextRequest.query 期望 Record<string, string>，统一 first-wins 扁平化。
  const queryRecord = flattenQueryRecord(expressReq.query);

  // ── 解析 path（不含 query string）────────────────────────
  //
  // Express 的 req.path 已是不含 query string 的路径部分。
  // 但当 Express 挂载在子路由时 req.path 可能是相对路径，
  // 这里使用 req.url 手动分割以保持与其他 adapter 一致。
  //
  const urlPath = expressReq.url.split("?")[0] ?? "/";

  // ── 缓存原始请求体（body-parser 用）───────────────────────
  //
  // rawBody 由 adapter 层在路由 handler 执行前通过监听 req 的 data/end 事件
  // 预先收集为 Buffer。_getRawBody 将其转为 string 供 vext body-parser 解析。
  //
  let _rawBodyCache: string | undefined;
  let _cookiesCache: VextCookieJar | undefined;

  function getCookies(): VextCookieJar {
    if (_cookiesCache !== undefined) return _cookiesCache;
    _cookiesCache = parseCookies(expressReq.headers.cookie);
    return _cookiesCache;
  }

  function getRawBody(maxBytes?: number): Promise<string> {
    if (_rawBodyCache !== undefined) {
      assertBodySize(Buffer.byteLength(_rawBodyCache, "utf-8"), maxBytes);
      return Promise.resolve(_rawBodyCache);
    }

    if (rawBody === undefined || rawBody === null) {
      _rawBodyCache = "";
      return Promise.resolve(_rawBodyCache);
    }

    if (Buffer.isBuffer(rawBody)) {
      assertBodySize(rawBody.byteLength, maxBytes);
      _rawBodyCache = rawBody.toString("utf-8");
      return Promise.resolve(_rawBodyCache);
    }

    // 兜底：如果 rawBody 已经是 string（理论上不会发生）
    if (typeof rawBody === "string") {
      assertBodySize(Buffer.byteLength(rawBody, "utf-8"), maxBytes);
      _rawBodyCache = rawBody;
      return Promise.resolve(_rawBodyCache);
    }

    _rawBodyCache = "";
    return Promise.resolve(_rawBodyCache);
  }

  function getRawBodyBuffer(maxBytes?: number): Promise<Buffer> {
    if (rawBody === undefined || rawBody === null)
      return Promise.resolve(Buffer.alloc(0));
    if (Buffer.isBuffer(rawBody)) {
      assertBodySize(rawBody.byteLength, maxBytes);
      return Promise.resolve(rawBody);
    }
    return Promise.resolve(Buffer.alloc(0));
  }

  // ── 解析 IP ──────────────────────────────────────────────
  //
  // 不使用 Express 的 req.ip（受 Express 自身 trust proxy 配置影响），
  // 自行解析以保持跨 Adapter 行为一致性。
  //
  let ip: string;
  if (trustProxy) {
    const xff = expressReq.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const firstIp = xff.split(",")[0];
      ip = firstIp
        ? firstIp.trim()
        : (expressReq.socket.remoteAddress ?? "127.0.0.1");
    } else if (Array.isArray(xff) && xff.length > 0) {
      const firstEntry = xff[0];
      const firstIp = firstEntry ? firstEntry.split(",")[0] : undefined;
      ip = firstIp
        ? firstIp.trim()
        : (expressReq.socket.remoteAddress ?? "127.0.0.1");
    } else {
      ip = expressReq.socket.remoteAddress ?? "127.0.0.1";
    }
  } else {
    ip = expressReq.socket.remoteAddress ?? "127.0.0.1";
  }

  // ── 解析 Protocol ────────────────────────────────────────

  let protocol: "http" | "https";
  if (trustProxy) {
    const proto = expressReq.headers["x-forwarded-proto"];
    protocol = proto === "https" ? "https" : "http";
  } else {
    const encrypted = (expressReq.socket as unknown as Record<string, unknown>)
      ?.encrypted;
    protocol = encrypted ? "https" : "http";
  }

  // ── 构造 VextRequest 对象 ────────────────────────────────

  const requestAbortController = new AbortController();
  const req: VextRequest = {
    // ── 原始数据 ────────────────────────────────────────
    query: queryRecord,
    body: undefined, // body-parser 中间件负责填充
    params: normalizeParams(
      (expressReq.params as Record<string, string | string[]>) ?? {},
    ),
    headers: expressReq.headers as Record<string, string | undefined>,
    get cookies(): VextCookieJar {
      return getCookies();
    },
    cookie(name: string): string | undefined {
      return getCookies()[name];
    },
    csrfToken(): string {
      throw new Error(
        "[vextjs] req.csrfToken() requires CSRF middleware. Enable config.csrf.enabled or register csrf().",
      );
    },
    auth: createAnonymousAuthContext(),
    method: expressReq.method.toUpperCase(),
    url: expressReq.originalUrl ?? expressReq.url,
    path: urlPath,
    route: "", // F-01: 由 registerRoute handler 在路由匹配后覆写为真实路由模板

    // ── 元信息 ──────────────────────────────────────────
    app,
    signal: requestAbortController.signal,
    requestId: "", // requestId 中间件负责填充
    ip,
    protocol,

    // ── 生命周期 ────────────────────────────────────────
    onClose(handler: () => void): void {
      addRequestCloseHandler(req, handler);
    },

    // ── 校验数据 ────────────────────────────────────────
    valid<T = Record<string, any>>(
      location: "query" | "body" | "param" | "header" | "cookie",
    ): T {
      return (req as Record<string, any>)[`_validated_${location}`] as T;
    },

    // ── 内部方法（body-parser 中间件使用）───────────────────
    _getRawBody: getRawBody,
    _getRawBodyBuffer: getRawBodyBuffer,
  };

  // Host close + finishResponseSend both fire exactly-once shared handlers.
  expressReq.on("close", () => {
    fireRequestCloseHandlers(req);
  });

  addRequestCloseHandler(req, () => {
    requestAbortController.abort(new Error("[vextjs] Request closed"));
  });

  return req;
}

function normalizeParams(
  params: Record<string, string | string[]>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[key] = Array.isArray(value) ? value.join("/") : value;
  }
  return normalized;
}
