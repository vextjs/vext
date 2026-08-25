import { Readable } from "node:stream";
import { requestContext } from "./request-context.js";
import type { VextLogger } from "../types/app.js";
import type { VextInternalHooks } from "../types/hooks.js";
import type { VextRequest } from "../types/request.js";
import type { VextResponse } from "../types/response.js";

/**
 * fetch.ts — app.fetch 内置 HTTP 客户端
 *
 * 封装 Node.js 20+ 内置 fetch，提供：
 *   1. 自动传播 requestId（从 requestContext AsyncLocalStorage 读取）
 *   2. 结构化日志记录（出站请求 method/url/status/duration）
 *   3. 超时控制（AbortController + setTimeout）
 *   4. 快捷方法（get/post/put/patch/delete）
 *   5. create() 工厂（baseURL + 默认配置）
 *   6. proxy() / proxy.<target>() 请求代理能力（仅根 app.fetch 暴露）
 *
 * 挂载位置：app.fetch（与 app.logger / app.throw 同级）
 *
 * 与 requestContext 的关系：
 *   requestId 中间件在请求进入时将 requestId 写入 requestContext store。
 *   app.fetch 在发送出站请求时从 requestContext.getStore() 读取 requestId，
 *   自动注入到出站请求的 x-request-id 头，实现跨服务请求追踪。
 *
 * 配置项（config.fetch）：
 *   - timeout:          全局默认请求超时（毫秒，默认 10000）
 *   - retry:            默认重试次数（仅幂等方法，默认 0）
 *   - retryDelay:       默认重试间隔（毫秒，默认 1000）
 *   - propagateHeaders: 除 x-request-id 外还需自动传播的请求头
 *   - proxy:            上游代理目标列表（仅根 app.fetch.proxy 使用）
 *
 * 超时配置优先级：
 *   单次请求 init.timeout > create() 的 options.timeout > config.fetch.timeout
 *
 * 当前版本未暴露 app.setFetch() 公共 API；自定义实现需在框架内部注入。
 *
 * @module lib/fetch
 * @see IMPLEMENTATION-PLAN.md 任务 1.8b
 * @see 06d-fetch.md §1~§4
 */

// ── 类型定义 ────────────────────────────────────────────────

/**
 * 扩展的 fetch 初始化选项
 *
 * 在标准 RequestInit 基础上增加 vext 特有的配置项：
 *   - timeout:             请求超时（毫秒）
 *   - retry:               重试次数（仅幂等方法）
 *   - retryDelay:          重试间隔（毫秒）或指数退避函数
 *   - propagateRequestId:  是否自动注入 requestId 头
 *   - propagateHeaders:    额外需要传播的请求头
 */
export interface VextFetchInit extends RequestInit {
  /** 请求超时（毫秒），必须 > 0 且 <= 2147483647，默认使用全局配置 config.fetch.timeout */
  timeout?: number;

  /** 重试次数（仅对幂等方法 GET/HEAD/OPTIONS/PUT/DELETE 生效），默认 0 */
  retry?: number;

  /** 重试间隔（毫秒），必须 >= 0 且 <= 2147483647；支持函数形式实现指数退避 */
  retryDelay?: number | ((attempt: number) => number);

  /**
   * 是否自动注入 requestId 头
   * 默认 true；设为 false 可禁用（如调用不支持此头的外部 API）
   */
  propagateRequestId?: boolean;

  /**
   * 自定义传播头（除 requestId 外还要传播的请求头）
   * 例如 ['x-trace-id', 'x-tenant-id']
   */
  propagateHeaders?: string[];
}

/**
 * create() 工厂选项
 */
export interface VextFetchClientOptions {
  /** 基础 URL，所有请求自动拼接 */
  baseURL: string;

  /** 默认请求头 */
  headers?: Record<string, string>;

  /** 默认超时（毫秒），必须 > 0 且 <= 2147483647 */
  timeout?: number;

  /** 默认重试 */
  retry?: number;

  /** 默认重试间隔（毫秒）或指数退避函数，返回值必须 >= 0 且 <= 2147483647 */
  retryDelay?: number | ((attempt: number) => number);
}

interface FetchClientContext {
  clientId: string;
  parentClientId?: string;
  baseURL?: string;
  defaultHeaders?: RequestInit["headers"];
}

/**
 * 可写入代理上游的请求头值。
 */
type ProxyHeaderValue = string | number | boolean | null | undefined;
type ProxyRequestBody =
  | Exclude<RequestInit["body"], null | undefined>
  | Buffer
  | Uint8Array;

/**
 * 代理动态注入 headers 的上下文。
 */
export interface VextFetchProxyHeaderContext {
  req: VextRequest;
  target?: VextFetchProxyTargetConfig;
  options: VextFetchProxyOptions;
}

/**
 * 代理 headers 配置。
 */
export type VextFetchProxyHeaders =
  | Record<string, ProxyHeaderValue>
  | ((
      ctx: VextFetchProxyHeaderContext,
    ) =>
      | Record<string, ProxyHeaderValue>
      | Promise<Record<string, ProxyHeaderValue>>);

/**
 * config.fetch.proxy[] 的单个代理目标配置。
 */
export interface VextFetchProxyTargetConfig {
  /** 目标名称，对应 app.fetch.proxy.<name>() */
  name: string;

  /** 上游基础地址，会与调用时 options.path 拼接 */
  baseURL: string;

  /** 目标级固定 headers，优先级最低 */
  headers?: Record<string, string>;

  /** 从当前 req.headers 白名单透传的 header 名称 */
  forwardHeaders?: string[];

  /** 目标级动态注入 headers，覆盖 headers / forwardHeaders */
  defaultInjectHeaders?: VextFetchProxyHeaders;

  /** 是否允许从当前请求透传原始 Authorization header */
  allowAuthorizationForward?: boolean;

  /** 目标级超时（毫秒），必须 > 0 且 <= 2147483647 */
  timeout?: number;

  /** 目标级重试次数，表示额外尝试次数 */
  retry?: number;

  /** 目标级重试间隔（毫秒）或指数退避函数，返回值必须 >= 0 且 <= 2147483647 */
  retryDelay?: number | ((attempt: number) => number);
}

/**
 * app.fetch.proxy 调用选项。
 */
export interface VextFetchProxyOptions {
  /** 命名目标模式下必传：拼接到 target.baseURL 的路径 */
  path?: string;

  /** 直接 URL 模式下必传：app.fetch.proxy(req, res, { url }) */
  url?: string;

  /** 默认使用当前 req.method */
  method?: string;

  /** 默认透传当前 req.query；同名 key 由 options.query 覆盖 */
  query?: Record<string, ProxyHeaderValue>;

  /** 显式请求体；未传时非 GET/HEAD 会读取当前 req 原始 body Buffer */
  body?: ProxyRequestBody;

  /** 读取当前 req 原始 body 的最大字节数 */
  maxBodySize?: number;

  /** 调用级固定 headers，覆盖目标级配置和透传 headers */
  headers?: Record<string, string>;

  /** 调用级追加 header 透传白名单 */
  forwardHeaders?: string[];

  /** 调用级动态注入 headers，优先级最高 */
  injectHeaders?: VextFetchProxyHeaders;

  /** 调用级是否允许透传原始 Authorization header */
  allowAuthorizationForward?: boolean;

  /** 调用级超时（毫秒），必须 > 0 且 <= 2147483647 */
  timeout?: number;

  /** 调用级重试次数，表示额外尝试次数 */
  retry?: number;

  /** 调用级重试间隔（毫秒）或指数退避函数，返回值必须 >= 0 且 <= 2147483647 */
  retryDelay?: number | ((attempt: number) => number);
}

/**
 * 命名目标代理处理函数。
 */
export type VextFetchProxyHandler = (
  req: VextRequest,
  res: VextResponse,
  options: VextFetchProxyOptions,
) => Promise<void>;

/**
 * app.fetch.proxy 接口。
 *
 * - app.fetch.proxy(req, res, { url })：直接 URL 代理
 * - app.fetch.proxy.<target>(req, res, { path })：config.fetch.proxy[] 目标代理
 */
export type VextFetchProxy = {
  (
    req: VextRequest,
    res: VextResponse,
    options: VextFetchProxyOptions,
  ): Promise<void>;
} & Record<string, VextFetchProxyHandler>;

/**
 * app.fetch.create() 返回的纯出站 HTTP 客户端。
 *
 * 子客户端不暴露 proxy，避免 app.fetch.create().proxy 带来额外心智负担。
 */
export interface VextFetchClient {
  (input: string | URL | Request, init?: VextFetchInit): Promise<Response>;
  get(url: string, init?: VextFetchInit): Promise<Response>;
  post(url: string, body?: unknown, init?: VextFetchInit): Promise<Response>;
  put(url: string, body?: unknown, init?: VextFetchInit): Promise<Response>;
  patch(url: string, body?: unknown, init?: VextFetchInit): Promise<Response>;
  delete(url: string, init?: VextFetchInit): Promise<Response>;
  create(options: VextFetchClientOptions): VextFetchClient;
}

/**
 * 根 VextFetch 接口
 *
 * 既是可调用的函数（与原生 fetch 签名一致），
 * 又挂载了快捷方法（get/post/put/patch/delete）、create() 工厂和 proxy。
 */
export interface VextFetch extends VextFetchClient {
  proxy: VextFetchProxy;
  create(options: VextFetchClientOptions): VextFetchClient;
}

/**
 * fetch 模块配置（从 VextConfig 中提取）
 */
export interface VextFetchConfig {
  timeout?: number;
  retry?: number;
  retryDelay?: number | ((attempt: number) => number);
  propagateHeaders?: string[];
  proxy?: VextFetchProxyTargetConfig[];
}

type FetchConfig = VextFetchConfig;

// ── 幂等方法集合（用于判断是否可重试）─────────────────────────

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

const AUTHORIZATION_HEADER = "authorization";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const BODYLESS_STATUS = new Set([204, 304]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
let outboundSequence = 0;

type FetchRetryDelay = number | ((attempt: number) => number);

function nextOutboundId(prefix: "fetch" | "fetch-client" | "proxy"): string {
  outboundSequence =
    outboundSequence >= Number.MAX_SAFE_INTEGER ? 1 : outboundSequence + 1;
  return `${prefix}-${outboundSequence.toString(36)}`;
}

function describeFetchOptionValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isNaN(value) ? "NaN" : String(value);
  }
  if (typeof value === "function") {
    return "function";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function createFetchOptionError(
  name: string,
  expected: string,
  value: unknown,
): Error {
  return new Error(
    `[vextjs] app.fetch ${name} must be ${expected}, got: ${describeFetchOptionValue(value)}.`,
  );
}

function normalizeFetchTimeout(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw createFetchOptionError(
      name,
      `a finite positive number no greater than ${MAX_TIMER_DELAY_MS} milliseconds`,
      value,
    );
  }
  return value;
}

function normalizeFetchRetry(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw createFetchOptionError(name, "a non-negative integer", value);
  }
  return value;
}

function normalizeFetchRetryDelayValue(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw createFetchOptionError(
      name,
      `a finite non-negative number no greater than ${MAX_TIMER_DELAY_MS} milliseconds`,
      value,
    );
  }
  return value;
}

function normalizeFetchRetryDelay(
  value: unknown,
  name: string,
): FetchRetryDelay {
  if (typeof value === "function") {
    const resolveDelay = value as (attempt: number) => unknown;
    return (attempt: number) =>
      normalizeFetchRetryDelayValue(resolveDelay(attempt), `${name} result`);
  }
  return normalizeFetchRetryDelayValue(value, name);
}

interface NormalizedOutboundRequest {
  request: Request;
  nativeInit: RequestInit;
  url: string;
  method: string;
  headers: Headers;
  callerSignal: AbortSignal;
}

function toNativeRequestInit(init: VextFetchInit | undefined): RequestInit {
  if (!init) return {};
  const nativeInit = { ...init } as Record<string, unknown>;
  delete nativeInit.timeout;
  delete nativeInit.retry;
  delete nativeInit.retryDelay;
  delete nativeInit.propagateRequestId;
  delete nativeInit.propagateHeaders;
  return nativeInit as RequestInit;
}

function normalizeOutboundRequest(
  input: string | URL | Request,
  init: VextFetchInit | undefined,
  defaultHeaders: RequestInit["headers"] | undefined,
): NormalizedOutboundRequest {
  const nativeInit = toNativeRequestInit(init);
  const request = new Request(input, nativeInit);
  const headers = new Headers(defaultHeaders);
  for (const [name, value] of request.headers) {
    headers.set(name, value);
  }

  return {
    request,
    nativeInit,
    url: request.url,
    method: request.method.toUpperCase(),
    headers,
    callerSignal: request.signal,
  };
}

function createJsonRequestInit(
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  init: VextFetchInit | undefined,
): VextFetchInit {
  const headers = new Headers(init?.headers);
  if (body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return {
    ...init,
    method,
    body: body != null ? JSON.stringify(body) : undefined,
    headers,
  };
}

interface AttemptLease {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}

function createAttemptLease(
  parentSignal: AbortSignal,
  timeout: number,
  timeoutReason: Error,
): AttemptLease {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort(parentSignal.reason);
  };

  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(() => {
      timer = undefined;
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(timeoutReason);
    }, timeout);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

function isReplayableBodyValue(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return false;
}

function isReplayableOutboundRequest(
  input: string | URL | Request,
  request: Request,
  nativeInit: RequestInit,
): boolean {
  if (!request.body) return true;
  if (input instanceof Request && nativeInit.body === undefined) return false;
  return isReplayableBodyValue(nativeInit.body);
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => {
      // Best-effort resource cleanup must not hide the retry outcome.
    });
  } catch {
    // Best-effort resource cleanup must not hide the retry outcome.
  }
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── 核心实现 ────────────────────────────────────────────────

/**
 * createVextFetch — 创建 app.fetch 内置 HTTP 客户端
 *
 * 在 bootstrap 阶段调用，将返回的 VextFetch 挂载到 app.fetch。
 *
 * @param logger          app.logger 实例（用于结构化日志）
 * @param fetchConfig     config.fetch 配置
 * @param requestIdHeader requestId 传播使用的头名称（默认 'x-request-id'）
 * @returns VextFetch 实例
 */
export function createVextFetch(
  logger: VextLogger,
  fetchConfig: FetchConfig = {},
  requestIdHeader: string = "x-request-id",
  hooks?: VextInternalHooks,
  clientContext?: FetchClientContext,
): VextFetch {
  const globalTimeout = normalizeFetchTimeout(
    fetchConfig.timeout ?? 10_000,
    "config.fetch.timeout",
  );
  const globalRetry = normalizeFetchRetry(
    fetchConfig.retry ?? 0,
    "config.fetch.retry",
  );
  const globalRetryDelay = normalizeFetchRetryDelay(
    fetchConfig.retryDelay ?? 1000,
    "config.fetch.retryDelay",
  );
  const globalPropagateHeaders = fetchConfig.propagateHeaders ?? [];
  const proxyTargets = fetchConfig.proxy ?? [];
  const context =
    clientContext ??
    ({
      clientId: nextOutboundId("fetch-client"),
    } satisfies FetchClientContext);

  /**
   * 核心 fetch 函数
   */
  async function vextFetch(
    input: string | URL | Request,
    init?: VextFetchInit,
  ): Promise<Response> {
    const normalized = normalizeOutboundRequest(
      input,
      init,
      context.defaultHeaders,
    );
    const { request, nativeInit, url, method, headers, callerSignal } =
      normalized;
    const timeout =
      init?.timeout === undefined
        ? globalTimeout
        : normalizeFetchTimeout(init.timeout, "init.timeout");
    const propagate = init?.propagateRequestId !== false;

    // ── 1. 构建请求头（注入追踪头）────────────────────────
    const store = requestContext.getStore();

    // ── 1a. 注入 requestId（受 propagateRequestId 控制）──
    if (propagate && store?.requestId && !headers.has(requestIdHeader)) {
      headers.set(requestIdHeader, store.requestId);
    }

    // ── 1b. 透传 propagatedHeaders（始终生效，不受 propagateRequestId 控制）──
    // store.propagatedHeaders 由 request-id 中间件在入站请求阶段
    // 从原始请求头中捕获并写入（根据 config.fetch.propagateHeaders 列表）。
    // 此处从 store 中读取并注入到出站请求头，实现"入站头 → 出站头"完整透传链路。
    //
    // 优先级：init.headers 手动设置 > store.propagatedHeaders（不覆盖用户显式设置的头）
    //
    // 单次请求可通过 init.propagateHeaders 指定额外透传头（已在入站阶段写入 store，
    // 但仅当 request-id 中间件的 propagateHeaderNames 包含该头时才有值）。
    // 如需透传未在全局配置中声明的头，直接在 init.headers 中手动设置即可。
    if (store?.propagatedHeaders) {
      for (const [key, value] of Object.entries(store.propagatedHeaders)) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
    }

    // ── 2. 确定重试配置 ──────────────────────────────────
    const configuredRetries =
      init?.retry === undefined
        ? globalRetry
        : normalizeFetchRetry(init.retry, "init.retry");
    const replayableBody = isReplayableOutboundRequest(
      input,
      request,
      nativeInit,
    );
    const maxRetries =
      IDEMPOTENT_METHODS.has(method) && replayableBody ? configuredRetries : 0;
    const retryDelay =
      init?.retryDelay === undefined
        ? globalRetryDelay
        : normalizeFetchRetryDelay(init.retryDelay, "init.retryDelay");
    const requestId = store?.requestId;
    const operationId = nextOutboundId("fetch");
    const emitFetchError = async (reason: unknown, attempt: number) => {
      await hooks?.emitSafe("fetch:error", {
        url,
        method,
        error: toError(reason),
        requestId,
        operationId,
        clientId: context.clientId,
        parentClientId: context.parentClientId,
        baseURL: context.baseURL,
        attempt,
        maxRetries,
      });
    };

    await hooks?.emit("fetch:before", {
      url,
      method,
      headers,
      requestId,
      operationId,
      clientId: context.clientId,
      parentClientId: context.parentClientId,
      baseURL: context.baseURL,
      attempt: 0,
      maxRetries,
      init: init as (RequestInit & Record<string, unknown>) | undefined,
    });

    // ── 3. 执行请求（含重试循环）────────────────────────
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 重试等待（首次请求不等待）
      if (attempt > 0) {
        const delay =
          typeof retryDelay === "function" ? retryDelay(attempt) : retryDelay;
        try {
          await sleepWithSignal(delay, callerSignal);
        } catch (reason) {
          await emitFetchError(reason, attempt);
          throw reason;
        }

        logger.debug(
          {
            type: "outbound",
            method,
            url,
            attempt,
            maxRetries,
          },
          `→ ${method} ${url} RETRY attempt ${attempt}/${maxRetries}`,
        );
      }

      // ── 超时控制 ──────────────────────────────────────
      const timeoutError = new Error(
        `[app.fetch] ${method} ${url} timed out after ${timeout}ms`,
      );
      timeoutError.name = "TimeoutError";
      const lease = createAttemptLease(callerSignal, timeout, timeoutError);

      const startTime = performance.now();

      try {
        const response = await fetch(
          input instanceof Request ? request : input,
          {
            ...nativeInit,
            method,
            headers,
            signal: lease.signal,
          },
        );

        lease.dispose();

        const duration = Math.round(performance.now() - startTime);

        // ── 日志记录 ────────────────────────────────────
        const level = response.ok
          ? "debug"
          : response.status >= 500
            ? "error"
            : "warn";

        logger[level](
          {
            type: "outbound",
            method,
            url,
            status: response.status,
            duration,
            requestId: requestContext.getStore()?.requestId,
          },
          `→ ${method} ${url} ${response.status} ${duration}ms`,
        );

        // 非幂等方法 或 非服务端错误 → 不重试，直接返回
        if (!IDEMPOTENT_METHODS.has(method) || response.status < 500) {
          await hooks?.emitSafe("fetch:after", {
            url,
            method,
            response,
            durationMs: duration,
            requestId,
            operationId,
            clientId: context.clientId,
            parentClientId: context.parentClientId,
            baseURL: context.baseURL,
            attempt,
            maxRetries,
          });
          return response;
        }

        // 幂等方法 + 5xx → 如果还有重试机会则继续
        if (attempt < maxRetries) {
          lastError = new Error(
            `[app.fetch] ${method} ${url} returned ${response.status}`,
          );
          cancelResponseBody(response);
          continue;
        }

        // 最后一次重试也失败了，返回响应（让调用方处理）
        await hooks?.emitSafe("fetch:after", {
          url,
          method,
          response,
          durationMs: duration,
          requestId,
          operationId,
          clientId: context.clientId,
          parentClientId: context.parentClientId,
          baseURL: context.baseURL,
          attempt,
          maxRetries,
        });
        return response;
      } catch (err: unknown) {
        const timedOut = lease.didTimeout();
        lease.dispose();
        const duration = Math.round(performance.now() - startTime);
        const error = toError(err);

        if (timedOut) {
          logger.error(
            {
              type: "outbound",
              method,
              url,
              error: "timeout",
              duration,
              timeout,
              requestId: requestContext.getStore()?.requestId,
            },
            `→ ${method} ${url} TIMEOUT ${duration}ms (limit: ${timeout}ms)`,
          );

          await emitFetchError(timeoutError, attempt);
          throw timeoutError;
        }

        if (callerSignal.aborted) {
          const reason = callerSignal.reason;
          const callerError = toError(reason);
          logger.debug(
            {
              type: "outbound",
              method,
              url,
              error: callerError.message,
              duration,
              requestId: requestContext.getStore()?.requestId,
            },
            `→ ${method} ${url} ABORTED ${duration}ms`,
          );
          await emitFetchError(reason, attempt);
          throw reason;
        }

        logger.error(
          {
            type: "outbound",
            method,
            url,
            error: error.message,
            duration,
            requestId: requestContext.getStore()?.requestId,
          },
          `→ ${method} ${url} ERROR ${duration}ms: ${error.message}`,
        );

        lastError = error;

        // 还有重试机会且是幂等方法 → 继续
        if (attempt < maxRetries && IDEMPOTENT_METHODS.has(method)) {
          continue;
        }

        await emitFetchError(error, attempt);
        throw error;
      }
    }

    // 理论上不应到达此处，但作为防御性编码
    const finalError =
      lastError ?? new Error(`[app.fetch] ${method} ${url} failed`);
    await hooks?.emitSafe("fetch:error", {
      url,
      method,
      error: finalError,
      requestId,
      operationId,
      clientId: context.clientId,
      parentClientId: context.parentClientId,
      baseURL: context.baseURL,
      attempt: maxRetries,
      maxRetries,
    });
    throw finalError;
  }

  // ── 快捷方法 ──────────────────────────────────────────────

  vextFetch.get = (url: string, init?: VextFetchInit) =>
    vextFetch(url, { ...init, method: "GET" });

  vextFetch.post = (url: string, body?: unknown, init?: VextFetchInit) =>
    vextFetch(url, createJsonRequestInit("POST", body, init));

  vextFetch.put = (url: string, body?: unknown, init?: VextFetchInit) =>
    vextFetch(url, createJsonRequestInit("PUT", body, init));

  vextFetch.patch = (url: string, body?: unknown, init?: VextFetchInit) =>
    vextFetch(url, createJsonRequestInit("PATCH", body, init));

  vextFetch.delete = (url: string, init?: VextFetchInit) =>
    vextFetch(url, { ...init, method: "DELETE" });

  // ── create() 工厂 ────────────────────────────────────────

  vextFetch.create = (options: VextFetchClientOptions): VextFetchClient => {
    const baseURL = options.baseURL.replace(/\/+$/, "");
    const childFetchConfig: FetchConfig = {
      timeout:
        options.timeout === undefined
          ? globalTimeout
          : normalizeFetchTimeout(options.timeout, "create.timeout"),
      retry:
        options.retry === undefined
          ? globalRetry
          : normalizeFetchRetry(options.retry, "create.retry"),
      retryDelay:
        options.retryDelay === undefined
          ? globalRetryDelay
          : normalizeFetchRetryDelay(options.retryDelay, "create.retryDelay"),
      propagateHeaders: globalPropagateHeaders,
    };

    // 创建子 VextFetch（递归使用 createVextFetch）
    const child = createVextFetch(
      logger,
      childFetchConfig,
      requestIdHeader,
      hooks,
      {
        clientId: nextOutboundId("fetch-client"),
        parentClientId: context.clientId,
        baseURL,
        defaultHeaders: options.headers,
      },
    );

    const wrappedFetch: VextFetchClient = ((
      input: string | URL | Request,
      init?: VextFetchInit,
    ) => {
      const resolvedInput =
        typeof input === "string"
          ? `${baseURL}${input.startsWith("/") ? "" : "/"}${input}`
          : input;

      return child(resolvedInput, init);
    }) as VextFetchClient;

    // 快捷方法也拼接 baseURL
    wrappedFetch.get = (url: string, init?: VextFetchInit) =>
      wrappedFetch(url, { ...init, method: "GET" });

    wrappedFetch.post = (url: string, body?: unknown, init?: VextFetchInit) =>
      wrappedFetch(url, createJsonRequestInit("POST", body, init));

    wrappedFetch.put = (url: string, body?: unknown, init?: VextFetchInit) =>
      wrappedFetch(url, createJsonRequestInit("PUT", body, init));

    wrappedFetch.patch = (url: string, body?: unknown, init?: VextFetchInit) =>
      wrappedFetch(url, createJsonRequestInit("PATCH", body, init));

    wrappedFetch.delete = (url: string, init?: VextFetchInit) =>
      wrappedFetch(url, { ...init, method: "DELETE" });

    // create() 也可以在子实例上再调用
    wrappedFetch.create = vextFetch.create;

    return wrappedFetch;
  };

  vextFetch.proxy = createFetchProxy({
    logger,
    targets: proxyTargets,
    timeout: globalTimeout,
    retry: globalRetry,
    retryDelay: globalRetryDelay,
    hooks,
    clientId: context.clientId,
  });

  return vextFetch as VextFetch;
}

// ── proxy 实现 ──────────────────────────────────────────────

interface FetchProxyRuntime {
  logger: VextLogger;
  targets: VextFetchProxyTargetConfig[];
  timeout: number;
  retry: number;
  retryDelay: number | ((attempt: number) => number);
  hooks?: VextInternalHooks;
  clientId: string;
}

interface ResolvedProxyRequest {
  target?: VextFetchProxyTargetConfig;
  targetName: string;
  url: string;
  method: string;
  headers: Headers;
  body?: ProxyRequestBody;
  timeout: number;
  retry: number;
  retryDelay: number | ((attempt: number) => number);
  replayableBody: boolean;
}

interface ProxyFetchResult {
  response: Response;
  attempt: number;
  maxRetries: number;
  durationMs: number;
  lease: AttemptLease;
}

class ProxyLocalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProxyLocalError";
  }
}

class ProxyTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeout: number,
  ) {
    super(message);
    this.name = "ProxyTimeoutError";
  }
}

class ProxyClientAbortError extends Error {
  constructor() {
    super("Client aborted proxy request");
    this.name = "ProxyClientAbortError";
  }
}

function createFetchProxy(runtime: FetchProxyRuntime): VextFetchProxy {
  const targetMap = new Map<string, VextFetchProxyTargetConfig>();
  for (const target of runtime.targets) {
    targetMap.set(target.name, target);
  }

  const directProxy = (async (
    req: VextRequest,
    res: VextResponse,
    options: VextFetchProxyOptions,
  ) => {
    await handleProxyRequest(runtime, req, res, undefined, options);
  }) as VextFetchProxy;

  return new Proxy(directProxy, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "then") {
        return undefined;
      }
      const configuredTarget = targetMap.get(prop);
      if (configuredTarget) {
        return async (
          req: VextRequest,
          res: VextResponse,
          options: VextFetchProxyOptions,
        ) => {
          await handleProxyRequest(
            runtime,
            req,
            res,
            configuredTarget,
            options,
          );
        };
      }
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return async (req: VextRequest, res: VextResponse) => {
        writeProxyLocalError(
          req,
          res,
          500,
          "FETCH_PROXY_TARGET_NOT_FOUND",
          `[app.fetch.proxy] target "${prop}" is not configured.`,
        );
      };
    },
  });
}

async function handleProxyRequest(
  runtime: FetchProxyRuntime,
  req: VextRequest,
  res: VextResponse,
  target: VextFetchProxyTargetConfig | undefined,
  options: VextFetchProxyOptions | undefined,
): Promise<void> {
  const operationId = nextOutboundId("proxy");
  let resolved: ResolvedProxyRequest | undefined;
  try {
    resolved = await resolveProxyRequest(runtime, req, target, options);
    const maxRetries = proxyMaxRetries(resolved);
    await runtime.hooks?.emit("proxy:before", {
      req,
      target: resolved.targetName,
      url: resolved.url,
      method: resolved.method,
      headers: resolved.headers,
      requestId: req.requestId,
      operationId,
      clientId: runtime.clientId,
      attempt: 0,
      maxRetries,
    });
    const result = await fetchProxyWithRetry(runtime, req, resolved);
    await runtime.hooks?.emitSafe("proxy:after", {
      req,
      target: resolved.targetName,
      url: resolved.url,
      method: resolved.method,
      status: result.response.status,
      requestId: req.requestId,
      operationId,
      clientId: runtime.clientId,
      attempt: result.attempt,
      maxRetries: result.maxRetries,
      durationMs: result.durationMs,
    });
    try {
      writeProxyResponse(result.response, res, result.lease);
    } catch (error) {
      result.lease.dispose();
      throw error;
    }
  } catch (err) {
    const proxyTarget = resolved?.targetName ?? target?.name;
    const proxyError = err instanceof Error ? err : new Error(String(err));
    await runtime.hooks?.emitSafe("proxy:error", {
      req,
      target: proxyTarget,
      error: proxyError,
      requestId: req.requestId,
      operationId,
      clientId: runtime.clientId,
      url: resolved?.url,
      method: resolved?.method,
      maxRetries: resolved ? proxyMaxRetries(resolved) : 0,
    });

    if (err instanceof ProxyClientAbortError) {
      runtime.logger.debug(
        {
          type: "proxy",
          requestId: req.requestId,
          event: "client_abort",
        },
        "[app.fetch.proxy] client aborted request",
      );
      return;
    }

    if (err instanceof ProxyLocalError) {
      writeProxyLocalError(req, res, err.status, err.code, err.message);
      return;
    }

    if (err instanceof ProxyTimeoutError) {
      writeProxyLocalError(req, res, 504, "FETCH_PROXY_TIMEOUT", err.message);
      return;
    }

    const error = err instanceof Error ? err : new Error(String(err));
    runtime.logger.error(
      {
        type: "proxy",
        requestId: req.requestId,
        error: error.message,
      },
      `[app.fetch.proxy] upstream request failed: ${error.message}`,
    );
    writeProxyLocalError(
      req,
      res,
      502,
      "FETCH_PROXY_UPSTREAM_ERROR",
      "Upstream request failed.",
    );
  }
}

async function resolveProxyRequest(
  runtime: FetchProxyRuntime,
  req: VextRequest,
  target: VextFetchProxyTargetConfig | undefined,
  options: VextFetchProxyOptions | undefined,
): Promise<ResolvedProxyRequest> {
  const proxyOptions = options ?? {};
  const method = (proxyOptions.method ?? req.method ?? "GET").toUpperCase();
  const url = resolveProxyUrl(target, proxyOptions);
  applyProxyQuery(url, req.query, proxyOptions.query);

  const headers = await resolveProxyHeaders(req, target, proxyOptions);
  const body = await resolveProxyBody(req, method, proxyOptions);
  const retry = normalizeProxyRetry(
    proxyOptions.retry ?? target?.retry ?? runtime.retry,
    "retry",
  );
  const replayableBody = isReplayableProxyBody(body);

  return {
    target,
    targetName: target?.name ?? "direct",
    url: url.href,
    method,
    headers,
    body,
    timeout: normalizeProxyTimeout(
      proxyOptions.timeout ?? target?.timeout ?? runtime.timeout,
      "timeout",
    ),
    retry,
    retryDelay: normalizeProxyRetryDelay(
      proxyOptions.retryDelay ?? target?.retryDelay ?? runtime.retryDelay,
      "retryDelay",
    ),
    replayableBody,
  };
}

function resolveProxyUrl(
  target: VextFetchProxyTargetConfig | undefined,
  options: VextFetchProxyOptions,
): URL {
  if (!target) {
    if (!options.url) {
      throw new ProxyLocalError(
        400,
        "FETCH_PROXY_URL_REQUIRED",
        "[app.fetch.proxy] options.url is required for direct proxy calls.",
      );
    }
    try {
      return new URL(options.url);
    } catch {
      throw new ProxyLocalError(
        400,
        "FETCH_PROXY_INVALID_URL",
        "[app.fetch.proxy] options.url must be a valid absolute URL.",
      );
    }
  }

  if (!options.path) {
    throw new ProxyLocalError(
      400,
      "FETCH_PROXY_PATH_REQUIRED",
      `[app.fetch.proxy.${target.name}] options.path is required.`,
    );
  }

  const baseURL = target.baseURL.replace(/\/+$/, "");
  const path = options.path.replace(/^\/+/, "");
  return new URL(`${baseURL}/${path}`);
}

function applyProxyQuery(
  url: URL,
  reqQuery: Record<string, string>,
  optionQuery?: Record<string, ProxyHeaderValue>,
): void {
  for (const [key, value] of Object.entries(reqQuery)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  if (!optionQuery) return;

  for (const [key, value] of Object.entries(optionQuery)) {
    if (value === undefined || value === null) {
      url.searchParams.delete(key);
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

async function resolveProxyHeaders(
  req: VextRequest,
  target: VextFetchProxyTargetConfig | undefined,
  options: VextFetchProxyOptions,
): Promise<Headers> {
  const headers = new Headers();
  const headerContext: VextFetchProxyHeaderContext = { req, target, options };

  applyStaticHeaders(headers, target?.headers);

  const forwardHeaders = mergeHeaderNames(
    target?.forwardHeaders,
    options.forwardHeaders,
  );
  const allowAuthorization =
    target?.allowAuthorizationForward === true ||
    options.allowAuthorizationForward === true;

  if (forwardHeaders.includes(AUTHORIZATION_HEADER) && !allowAuthorization) {
    throw new ProxyLocalError(
      400,
      "FETCH_PROXY_AUTHORIZATION_FORWARD_FORBIDDEN",
      "[app.fetch.proxy] forwarding authorization requires allowAuthorizationForward: true.",
    );
  }

  for (const headerName of forwardHeaders) {
    const value = req.headers[headerName];
    if (value !== undefined) {
      headers.set(headerName, value);
    }
  }

  await applyProxyHeaders(headers, target?.defaultInjectHeaders, headerContext);
  applyStaticHeaders(headers, options.headers);
  await applyProxyHeaders(headers, options.injectHeaders, headerContext);

  return headers;
}

function mergeHeaderNames(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const group of groups) {
    for (const name of group ?? []) {
      const normalized = name.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function applyStaticHeaders(
  headers: Headers,
  source?: Record<string, ProxyHeaderValue>,
): void {
  if (!source) return;

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
}

async function applyProxyHeaders(
  headers: Headers,
  source: VextFetchProxyHeaders | undefined,
  ctx: VextFetchProxyHeaderContext,
): Promise<void> {
  if (!source) return;

  const resolved = typeof source === "function" ? await source(ctx) : source;
  applyStaticHeaders(headers, resolved);
}

async function resolveProxyBody(
  req: VextRequest,
  method: string,
  options: VextFetchProxyOptions,
): Promise<ProxyRequestBody | undefined> {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }
  if (options.body !== undefined) {
    return options.body;
  }
  return req._getRawBodyBuffer(options.maxBodySize);
}

function normalizeProxyTimeout(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new ProxyLocalError(
      400,
      "FETCH_PROXY_INVALID_TIMEOUT",
      `[app.fetch.proxy] ${name} must be a finite positive number no greater than ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }
  return value;
}

function normalizeProxyRetry(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProxyLocalError(
      400,
      "FETCH_PROXY_INVALID_RETRY",
      `[app.fetch.proxy] ${name} must be a non-negative integer.`,
    );
  }
  return value;
}

function normalizeProxyRetryDelayValue(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new ProxyLocalError(
      400,
      "FETCH_PROXY_INVALID_RETRY_DELAY",
      `[app.fetch.proxy] ${name} must be a finite non-negative number no greater than ${MAX_TIMER_DELAY_MS} milliseconds or a function that returns one.`,
    );
  }
  return value;
}

function normalizeProxyRetryDelay(
  value: unknown,
  name: string,
): number | ((attempt: number) => number) {
  if (typeof value === "function") {
    const resolveDelay = value as (attempt: number) => unknown;
    return (attempt: number) => {
      let delay: unknown;
      try {
        delay = resolveDelay(attempt);
      } catch (err) {
        throw new ProxyLocalError(
          400,
          "FETCH_PROXY_INVALID_RETRY_DELAY",
          err instanceof Error
            ? err.message
            : `[app.fetch.proxy] ${name} function must return a finite non-negative number no greater than ${MAX_TIMER_DELAY_MS} milliseconds.`,
        );
      }
      return normalizeProxyRetryDelayValue(delay, `${name} result`);
    };
  }
  return normalizeProxyRetryDelayValue(value, name);
}

function isReplayableProxyBody(body: ProxyRequestBody | undefined): boolean {
  return isReplayableBodyValue(body);
}

function proxyMaxRetries(resolved: ResolvedProxyRequest): number {
  return IDEMPOTENT_METHODS.has(resolved.method) && resolved.replayableBody
    ? resolved.retry
    : 0;
}

async function fetchProxyWithRetry(
  runtime: FetchProxyRuntime,
  req: VextRequest,
  resolved: ResolvedProxyRequest,
): Promise<ProxyFetchResult> {
  const retryableMethod = IDEMPOTENT_METHODS.has(resolved.method);
  const maxRetries = proxyMaxRetries(resolved);
  const clientController = new AbortController();

  req.onClose(() => {
    if (!clientController.signal.aborted) {
      clientController.abort(new ProxyClientAbortError());
    }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      if (clientController.signal.aborted) {
        throw new ProxyClientAbortError();
      }
      const delay =
        typeof resolved.retryDelay === "function"
          ? resolved.retryDelay(attempt)
          : resolved.retryDelay;
      try {
        await sleepWithSignal(delay, clientController.signal);
      } catch (reason) {
        if (clientController.signal.aborted) {
          throw new ProxyClientAbortError();
        }
        throw reason;
      }
      runtime.logger.debug(
        {
          type: "proxy",
          target: resolved.targetName,
          method: resolved.method,
          url: resolved.url,
          attempt,
          maxRetries,
          requestId: req.requestId,
        },
        `[app.fetch.proxy] retry ${attempt}/${maxRetries}: ${resolved.method} ${resolved.url}`,
      );
    }

    if (clientController.signal.aborted) {
      throw new ProxyClientAbortError();
    }

    const timeoutError = new ProxyTimeoutError(
      `[app.fetch.proxy] ${resolved.method} ${resolved.url} timed out after ${resolved.timeout}ms.`,
      resolved.timeout,
    );
    const lease = createAttemptLease(
      clientController.signal,
      resolved.timeout,
      timeoutError,
    );

    const startTime = performance.now();

    try {
      const response = await fetch(resolved.url, {
        method: resolved.method,
        headers: resolved.headers,
        body: resolved.body,
        signal: lease.signal,
        redirect: "manual",
      });

      const duration = Math.round(performance.now() - startTime);
      const level = response.ok
        ? "debug"
        : response.status >= 500
          ? "error"
          : "warn";
      runtime.logger[level](
        {
          type: "proxy",
          target: resolved.targetName,
          method: resolved.method,
          url: resolved.url,
          status: response.status,
          duration,
          requestId: req.requestId,
        },
        `[app.fetch.proxy] ${resolved.method} ${resolved.url} ${response.status} ${duration}ms`,
      );

      if (
        response.status >= 500 &&
        retryableMethod &&
        resolved.replayableBody &&
        attempt < maxRetries
      ) {
        cancelResponseBody(response);
        lease.dispose();
        continue;
      }

      // The lease remains active until writeProxyResponse observes source
      // stream settlement, so timeout/client-close still cover the body phase.
      return { response, attempt, maxRetries, durationMs: duration, lease };
    } catch (err) {
      const timedOut = lease.didTimeout();
      lease.dispose();

      const error = toError(err);
      if (clientController.signal.aborted) {
        throw new ProxyClientAbortError();
      }
      if (timedOut) {
        throw timeoutError;
      }

      runtime.logger.error(
        {
          type: "proxy",
          target: resolved.targetName,
          method: resolved.method,
          url: resolved.url,
          error: error.message,
          requestId: req.requestId,
        },
        `[app.fetch.proxy] ${resolved.method} ${resolved.url} ERROR: ${error.message}`,
      );

      if (retryableMethod && resolved.replayableBody && attempt < maxRetries) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `[app.fetch.proxy] ${resolved.method} ${resolved.url} failed.`,
  );
}

function writeProxyResponse(
  response: Response,
  res: VextResponse,
  lease: AttemptLease,
): void {
  const contentType = response.headers.get("content-type") ?? undefined;

  res.status(response.status);

  if (BODYLESS_STATUS.has(response.status)) {
    copyProxyResponseHeaders(response, res);
    lease.dispose();
    res.text("", response.status);
    return;
  }

  copyProxyResponseHeaders(response, res);
  if (!response.body) {
    lease.dispose();
    res.text("", response.status);
    return;
  }

  const stream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  bindLeaseToProxyStream(stream, lease);
  try {
    res.stream(stream, contentType ?? "application/octet-stream");
  } catch (error) {
    lease.dispose();
    stream.destroy(toError(error));
    throw error;
  }
}

function copyProxyResponseHeaders(response: Response, res: VextResponse): void {
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length") return;
    if (lower === "content-encoding" || lower === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookies = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();
  if (setCookies && setCookies.length > 0) {
    res.setHeader("Set-Cookie", setCookies);
  }
}

function bindLeaseToProxyStream(stream: Readable, lease: AttemptLease): void {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    lease.dispose();
  };
  stream.once("end", settle);
  stream.once("close", settle);
  stream.once("error", settle);
  if (stream.readableEnded || stream.destroyed) queueMicrotask(settle);
}

function writeProxyLocalError(
  req: VextRequest,
  res: VextResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.rawJson(
    {
      code,
      message,
      requestId: req.requestId,
    },
    status,
  );
}
