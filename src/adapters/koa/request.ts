import type Koa from "koa";
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
 * Koa Context → VextRequest 转换
 *
 * 将 Koa 的 Context 对象转换为 vext 框架的统一请求接口。
 * 所有底层框架特有的 API 在此处适配，后续代码只与 VextRequest 交互。
 *
 * 转换要点：
 *   - query: Koa 已解析好 ctx.query 对象，直接使用
 *   - body: 由 body-parser 中间件后续填充（初始 undefined）
 *   - params: Koa 原生不支持路由参数，由 adapter 层通过路由匹配提取后传入
 *   - headers: Koa 的 ctx.headers 是 Node.js 原生 headers 对象（key 全小写）
 *   - requestId: 由 requestId 中间件后续填充（初始空字符串）
 *   - ip: 根据 trustProxy 配置决定从 X-Forwarded-For 或 socket 读取
 *   - protocol: 根据 trustProxy 配置决定从 X-Forwarded-Proto 或默认值读取
 *   - onClose: 注册请求关闭钩子，连接断开时触发（通过 ctx.req.on('close')）
 *   - valid: 获取 validate 中间件校验后的数据
 *   - _getRawBody: 从预收集的原始请求体 Buffer 转为字符串，供 vext body-parser 中间件使用
 *
 * 与 Hono / Fastify / Express Adapter 的差异：
 *   - Hono 通过 c.req.text() 读取 Web Request body（ReadableStream）
 *   - Fastify 通过 removeAllContentTypeParsers + addContentTypeParser('*', parseAs: 'buffer')
 *     将原始 body 作为 Buffer 传入 request.body
 *   - Express 在 route handler 前手动收集 req stream 为 Buffer
 *   - Koa: 同 Express，在路由 handler 前手动收集 ctx.req stream 为 Buffer，
 *     通过 rawBody 参数传入
 *   - 四者最终都通过 req._getRawBody() 返回 string 供 vext body-parser 使用
 *
 * @param ctx      Koa Context 对象
 * @param vextApp  VextApp 实例
 * @param params   路由参数（由 adapter 层路由匹配提取）
 * @param rawBody  预收集的原始请求体 Buffer（由 adapter 层在路由 handler 前收集）
 * @returns VextRequest 实例（含 _getRawBody 内部方法供 body-parser 使用）
 *
 * @see adapters/hono/request.ts（Hono Adapter 对应实现）
 * @see adapters/fastify/request.ts（Fastify Adapter 对应实现）
 * @see adapters/express/request.ts（Express Adapter 对应实现）
 */
export function createVextRequest(
  ctx: Koa.Context,
  vextApp: VextApp,
  params: Record<string, string>,
  rawBody?: Buffer,
): VextRequest {
  const trustProxy = vextApp.config.trustProxy ?? false;

  // ── 解析 query 参数 ──────────────────────────────────────
  //
  // Koa 的 ctx.query 值为 string 或 string[]；统一 first-wins 扁平化。
  const queryRecord = flattenQueryRecord(ctx.query);

  // ── 解析 path（不含 query string）────────────────────────
  //
  // Koa 的 ctx.path 已是不含 query string 的路径部分。
  // 但为保持与其他 adapter 一致的防御性处理，使用 ctx.url 手动分割。
  //
  const urlPath = ctx.url.split("?")[0] ?? "/";

  // ── 缓存原始请求体（body-parser 用）───────────────────────
  //
  // rawBody 由 adapter 层在路由 handler 执行前通过监听 ctx.req 的 data/end 事件
  // 预先收集为 Buffer。_getRawBody 将其转为 string 供 vext body-parser 中间件解析。
  //
  let _rawBodyCache: string | undefined;
  let _cookiesCache: VextCookieJar | undefined;

  function getCookies(): VextCookieJar {
    if (_cookiesCache !== undefined) return _cookiesCache;
    _cookiesCache = parseCookies(ctx.headers.cookie);
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
  // 不使用 Koa 的 ctx.ip（受 Koa 自身 proxy 配置影响），
  // 自行解析以保持跨 Adapter 行为一致性。
  //
  let ip: string;
  if (trustProxy) {
    const xff = ctx.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const firstIp = xff.split(",")[0];
      ip = firstIp
        ? firstIp.trim()
        : (ctx.req.socket.remoteAddress ?? "127.0.0.1");
    } else if (Array.isArray(xff) && xff.length > 0) {
      const firstEntry = xff[0];
      const firstIp = firstEntry ? firstEntry.split(",")[0] : undefined;
      ip = firstIp
        ? firstIp.trim()
        : (ctx.req.socket.remoteAddress ?? "127.0.0.1");
    } else {
      ip = ctx.req.socket.remoteAddress ?? "127.0.0.1";
    }
  } else {
    ip = ctx.req.socket.remoteAddress ?? "127.0.0.1";
  }

  // ── 解析 Protocol ────────────────────────────────────────

  let protocol: "http" | "https";
  if (trustProxy) {
    const proto = ctx.headers["x-forwarded-proto"];
    protocol = proto === "https" ? "https" : "http";
  } else {
    const encrypted = (ctx.req.socket as unknown as Record<string, unknown>)
      ?.encrypted;
    protocol = encrypted ? "https" : "http";
  }

  // ── 构造 VextRequest 对象 ────────────────────────────────

  const requestAbortController = new AbortController();
  const req: VextRequest = {
    // ── 原始数据 ────────────────────────────────────────
    query: queryRecord,
    body: undefined, // body-parser 中间件负责填充
    params: params ?? {},
    headers: ctx.headers as Record<string, string | undefined>,
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
    method: ctx.method.toUpperCase(),
    url: ctx.originalUrl ?? ctx.url,
    path: urlPath,
    route: "", // F-01: 由 registerKoaMiddleware 在路由匹配后覆写为真实路由模板

    // ── 元信息 ──────────────────────────────────────────
    app: vextApp,
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
    // 从预收集的 rawBody（Buffer）转为 string，供 body-parser 中间件解析。
    //
    _getRawBody: getRawBody,
    _getRawBodyBuffer: getRawBodyBuffer,
  };

  // Host close + finishResponseSend both fire exactly-once shared handlers.
  ctx.req.on("close", () => {
    fireRequestCloseHandlers(req);
  });

  addRequestCloseHandler(req, () => {
    requestAbortController.abort(new Error("[vextjs] Request closed"));
  });

  return req;
}
