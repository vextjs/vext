import type { FastifyRequest } from "fastify";
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
 * Fastify Request → VextRequest 转换
 *
 * 将 Fastify 的 Request 对象转换为 vext 框架的统一请求接口。
 * 所有底层框架特有的 API 在此处适配，后续代码只与 VextRequest 交互。
 *
 * 转换要点：
 *   - query: Fastify 已解析好 query 对象，直接使用
 *   - body: 由 body-parser 中间件后续填充（初始 undefined）
 *   - params: Fastify 已解析好 params 对象，直接使用
 *   - headers: Fastify 的 request.headers 是 Node.js 原生 headers 对象（key 全小写）
 *   - requestId: 由 requestId 中间件后续填充（初始空字符串）
 *   - ip: 根据 trustProxy 配置决定从 X-Forwarded-For 或 socket 读取
 *   - protocol: 根据 trustProxy 配置决定从 X-Forwarded-Proto 或默认值读取
 *   - onClose: 注册请求关闭钩子，连接断开时触发（通过 request.raw.on('close')）
 *   - valid: 获取 validate 中间件校验后的数据
 *   - _getRawBody: 从 Fastify request.body（Buffer，由通用 content-type parser 提供）
 *     转为字符串，供 vext body-parser 中间件使用
 *
 * 与 Hono Adapter 的差异：
 *   - Hono 通过 c.req.text() 读取 Web Request body（ReadableStream）
 *   - Fastify 通过 removeAllContentTypeParsers + addContentTypeParser('*', parseAs: 'buffer')
 *     将原始 body 作为 Buffer 传入 request.body
 *   - 两者最终都通过 req._getRawBody() 返回 string 供 body-parser 使用
 *
 * @param request Fastify Request 对象
 * @param app     VextApp 实例
 * @returns VextRequest 实例（含 _getRawBody 内部方法供 body-parser 使用）
 *
 * @see 08a-fastify-adapter.md §4（请求转换）
 * @see adapters/hono/request.ts（Hono Adapter 对应实现）
 */
export function createVextRequest(
  request: FastifyRequest,
  app: VextApp,
): VextRequest {
  const trustProxy = app.config.trustProxy ?? false;

  // ── 解析 path（Fastify 无直接 .path 属性）──────────────
  //
  // Fastify 的 request.url 包含 query string（如 /users?page=1），
  // 需要手动提取路径部分。
  //
  // request.routeOptions?.url 是路由模板（如 /users/:id），不是实际路径，
  // 因此使用 request.url 手动分割。
  //
  const urlPath = request.url.split("?")[0] ?? "/";

  // ── 缓存原始请求体（body-parser 用）───────────────────────
  //
  // Fastify 通过 removeAllContentTypeParsers + addContentTypeParser('*', parseAs: 'buffer')
  // 将所有 Content-Type 的请求体以 Buffer 形式放入 request.body。
  //
  // _getRawBody 将 Buffer 转为 string 供 vext body-parser 中间件解析。
  // 使用缓存确保多次调用返回相同结果（虽然 Fastify 的 request.body
  // 本身是稳定引用，但 Buffer.toString 每次都会创建新字符串，缓存更高效）。
  //
  let _rawBufferCache: Buffer | undefined;
  let _rawBodyCache: string | undefined;
  let _cookiesCache: VextCookieJar | undefined;

  function getCookies(): VextCookieJar {
    if (_cookiesCache !== undefined) return _cookiesCache;
    _cookiesCache = parseCookies(request.headers.cookie);
    return _cookiesCache;
  }

  function getRawBody(maxBytes?: number): Promise<string> {
    if (_rawBodyCache !== undefined) {
      assertBodySize(Buffer.byteLength(_rawBodyCache, "utf-8"), maxBytes);
      return Promise.resolve(_rawBodyCache);
    }

    return getRawBodyBuffer(maxBytes).then((body) => {
      _rawBodyCache = body.toString("utf-8");
      return _rawBodyCache;
    });
  }

  function getRawBodyBuffer(maxBytes?: number): Promise<Buffer> {
    if (_rawBufferCache !== undefined) {
      assertBodySize(_rawBufferCache.byteLength, maxBytes);
      return Promise.resolve(_rawBufferCache);
    }

    const body = request.body;
    if (body === undefined || body === null) {
      _rawBufferCache = Buffer.alloc(0);
      return Promise.resolve(_rawBufferCache);
    }

    if (Buffer.isBuffer(body)) {
      assertBodySize(body.byteLength, maxBytes);
      _rawBufferCache = body;
      return Promise.resolve(_rawBufferCache);
    }

    if (typeof body === "string") {
      const rawBuffer = Buffer.from(body, "utf-8");
      assertBodySize(rawBuffer.byteLength, maxBytes);
      _rawBufferCache = rawBuffer;
      return Promise.resolve(_rawBufferCache);
    }

    _rawBufferCache = Buffer.alloc(0);
    return Promise.resolve(_rawBufferCache);
  }

  // ── 解析 IP 和 Protocol ──────────────────────────────────
  //
  // 从 utils.ts 中导入的 resolveIp / resolveProtocol 已在 adapter.ts 中
  // 通过参数传递，但为了 request.ts 的独立性，这里内联解析逻辑。
  //
  // 实际上为了代码复用，IP 和 Protocol 的解析在 adapter.ts 创建 VextRequest
  // 时直接调用 utils.ts 的函数。但 createVextRequest 也需要能独立工作
  // （如在 registerNotFound / registerErrorHandler 中直接调用），
  // 所以这里也做内联解析。
  //
  let ip: string;
  if (trustProxy) {
    const xff = request.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const firstIp = xff.split(",")[0];
      ip = firstIp
        ? firstIp.trim()
        : (request.raw.socket.remoteAddress ?? "127.0.0.1");
    } else if (Array.isArray(xff) && xff.length > 0) {
      const firstEntry = xff[0];
      const firstIp = firstEntry ? firstEntry.split(",")[0] : undefined;
      ip = firstIp
        ? firstIp.trim()
        : (request.raw.socket.remoteAddress ?? "127.0.0.1");
    } else {
      ip = request.raw.socket.remoteAddress ?? "127.0.0.1";
    }
  } else {
    ip = request.raw.socket.remoteAddress ?? "127.0.0.1";
  }

  let protocol: "http" | "https";
  if (trustProxy) {
    const proto = request.headers["x-forwarded-proto"];
    protocol = proto === "https" ? "https" : "http";
  } else {
    const encrypted = (request.raw.socket as unknown as Record<string, unknown>)
      ?.encrypted;
    protocol = encrypted ? "https" : "http";
  }

  // ── 构造 VextRequest 对象 ────────────────────────────────

  const requestAbortController = new AbortController();
  const req: VextRequest = {
    // ── 原始数据 ────────────────────────────────────────
    // Flatten host multi-value query (string[]) to first string for Vext parity.
    query: flattenQueryRecord(request.query),
    body: undefined, // body-parser 中间件负责填充
    params: (request.params as Record<string, string>) ?? {},
    headers: request.headers as Record<string, string | undefined>,
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
    method: request.method.toUpperCase(),
    url: request.url,
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
    //
    // validate 中间件将校验后的数据存储在 req._validated_<location> 上。
    // valid() 方法从对应的 key 中读取数据返回。
    //
    valid<T = Record<string, any>>(
      location: "query" | "body" | "param" | "header" | "cookie",
    ): T {
      return (req as Record<string, any>)[`_validated_${location}`] as T;
    },

    // ── 内部方法（body-parser 中间件使用）───────────────────
    //
    // 通过 (req as any)._getRawBody() 访问，不暴露在 VextRequest 公共类型中。
    // 从 Fastify request.body（Buffer，由通用 content-type parser 提供）
    // 转为 string，供 body-parser 中间件解析。
    //
    _getRawBody: getRawBody,
    _getRawBodyBuffer: getRawBodyBuffer,
  };

  // Host close + finishResponseSend both fire exactly-once shared handlers.
  request.raw.on("close", () => {
    fireRequestCloseHandlers(req);
  });

  addRequestCloseHandler(req, () => {
    requestAbortController.abort(new Error("[vextjs] Request closed"));
  });

  return req;
}
