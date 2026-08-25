import type { IncomingMessage } from "node:http";
import type { VextRequest } from "../../types/request.js";
import type { VextApp } from "../../types/app.js";
import type { VextCookieJar } from "../../types/cookies.js";
import { createAnonymousAuthContext } from "../../lib/auth.js";
import { parseCookies } from "../../lib/cookies.js";
import {
  assertBodySize,
  createPayloadTooLargeError,
} from "../../lib/middlewares/body-parser.js";
import { parseQueryString } from "../../lib/query.js";
import {
  addRequestCloseHandler,
  fireRequestCloseHandlers,
} from "../../lib/request-close.js";

/**
 * 预解析的 URL 信息（由 adapter.ts handleRequest 传入，避免重复解析）
 *
 * handleRequest 在路由匹配前已执行 indexOf('?') 分割 URL，
 * 将结果传入 createVextRequest，消除 request.ts 中的冗余解析。
 */
export interface ParsedUrl {
  /** 原始 URL（含 query string），如 /users?page=1 */
  rawUrl: string;
  /** 路径部分（不含 query string），如 /users */
  path: string;
  /** 原始 query string（不含 ?），如 page=1；无 query 时为空字符串 */
  queryString: string;
}

/**
 * Native Request → VextRequest 转换
 *
 * 直接从 Node.js IncomingMessage 构造 VextRequest，不经过第三方 HTTP 框架层。
 * 这是 Native Adapter 的核心性能优势之一：跳过 Fastify/Koa/Express 等
 * 框架的请求对象包装层，直接操作原生对象。
 *
 * 转换要点：
 *   - query: 懒解析（首次访问时从 URL 解析，结果缓存）
 *   - body: 由 body-parser 中间件后续填充（初始 undefined）
 *   - params: 由 route-core 路由匹配后外部注入
 *   - headers: 直接使用 IncomingMessage.headers（key 全小写，Node.js 保证）
 *   - requestId: 由 requestId 中间件后续填充（初始空字符串）
 *   - ip: 根据 trustProxy 配置决定从 X-Forwarded-For 或 socket 读取
 *   - protocol: 根据 trustProxy 配置决定从 X-Forwarded-Proto 或默认值读取
 *   - onClose: 注册请求关闭钩子，连接断开时触发（通过 req.on('close')）
 *   - valid: 获取 validate 中间件校验后的数据
 *   - _getRawBody: 从 IncomingMessage 读取原始 body（Buffer）转为字符串，
 *     供 vext body-parser 中间件使用
 *
 * 性能优化：
 *   - query 使用 getter + 缓存，未访问 query 时不执行解析
 *   - path 仅做一次 indexOf('?') 分割，避免 new URL() 的完整解析开销
 *   - headers 直接引用 IncomingMessage.headers，无拷贝
 *   - _getRawBody 使用 Buffer 拼接 + 缓存，多次调用返回同一字符串
 *
 * 与 Fastify Adapter 的差异：
 *   - Fastify: 通过 Fastify 的 request 对象间接访问（已预解析 query/params）
 *   - Native: 直接操作 IncomingMessage，手动解析（但可懒解析跳过不需要的字段）
 *   - Native 省去了 Fastify 框架本身的对象包装开销
 *
 * @param incoming   Node.js IncomingMessage 原始请求对象
 * @param app        VextApp 实例
 * @param params     路由参数（由 route-core 匹配结果提供）
 * @param parsedUrl  预解析的 URL 信息（由 handleRequest 传入，避免重复 indexOf('?')）
 * @returns VextRequest 实例（含 _getRawBody 内部方法供 body-parser 使用）
 *
 * @see adapters/fastify/request.ts（Fastify Adapter 对应实现）
 * @see adapters/hono/request.ts（Hono Adapter 对应实现）
 */
export function createVextRequest(
  incoming: IncomingMessage,
  app: VextApp,
  params: Record<string, string>,
  parsedUrl: ParsedUrl,
): VextRequest {
  const trustProxy = app.config.trustProxy ?? false;

  // ── 使用预解析的 URL 信息（P2 优化：消除重复 URL 解析）──
  //
  // handleRequest 在路由匹配前已执行 indexOf('?') 分割 URL，
  // 直接使用传入的结果，避免 request.ts 中的冗余解析。
  //
  const { rawUrl, path: urlPath, queryString: rawQueryString } = parsedUrl;

  // ── query 懒解析（对象字面量 getter + 访问后物化）─────────
  //
  // P1 优化：初始对象形状包含 query getter，首次访问后将 query 物化为
  // value descriptor，让后续读取直接返回已解析值，同时保持公开对象描述符稳定。
  //
  // 大量场景（如 GET /json）不需要 query 参数。
  // 使用 getter + 缓存实现懒解析，首次访问时从 URL 解析，结果缓存。
  //
  let _queryCache: Record<string, string> | undefined;
  let _cookiesCache: VextCookieJar | undefined;

  // ── 缓存原始请求体（body-parser 用）───────────────────────
  //
  // 直接从 IncomingMessage 读取 body 数据流。
  // 以 Buffer 为主缓存（流只能消费一次），字符串从中惰性派生。
  // 这样 _getRawBodyBuffer() 和 _getRawBody() 都不会重复消费数据流。
  //
  let _rawBufferPromise: Promise<Buffer> | undefined;
  let _rawStringPromise: Promise<string> | undefined;

  function getRawBodyBuffer(maxBytes?: number): Promise<Buffer> {
    if (_rawBufferPromise !== undefined) {
      return _rawBufferPromise.then((buf) => {
        assertBodySize(buf.byteLength, maxBytes);
        return buf;
      });
    }

    _rawBufferPromise = new Promise<Buffer>((resolve, reject) => {
      // 对于无 body 方法，快速返回空 Buffer
      const method = incoming.method?.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        resolve(Buffer.alloc(0));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bufferChunk.byteLength;
        if (maxBytes !== undefined && total > maxBytes) {
          settled = true;
          reject(createPayloadTooLargeError(maxBytes));
          return;
        }
        chunks.push(bufferChunk);
      });

      incoming.on("end", () => {
        if (settled) return;
        settled = true;
        const buffer =
          chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
        assertBodySize(buffer.byteLength, maxBytes);
        resolve(buffer);
      });

      incoming.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });

    return _rawBufferPromise.then((buf) => {
      assertBodySize(buf.byteLength, maxBytes);
      return buf;
    });
  }

  function getRawBody(maxBytes?: number): Promise<string> {
    if (_rawStringPromise !== undefined) {
      return _rawStringPromise.then((raw) => {
        assertBodySize(Buffer.byteLength(raw, "utf-8"), maxBytes);
        return raw;
      });
    }
    _rawStringPromise = getRawBodyBuffer(maxBytes).then((buf) =>
      buf.toString("utf-8"),
    );
    return _rawStringPromise;
  }

  function getCookies(): VextCookieJar {
    if (_cookiesCache !== undefined) return _cookiesCache;
    _cookiesCache = parseCookies(incoming.headers.cookie);
    return _cookiesCache;
  }

  function getQuery(): Record<string, string> {
    if (_queryCache !== undefined) return _queryCache;

    if (!rawQueryString) {
      _queryCache = {};
      return _queryCache;
    }

    // First-wins multi-value semantics — keep adapter parity with Express/Koa/Fastify.
    _queryCache = parseQueryString(rawQueryString);
    return _queryCache;
  }

  // ── 解析 IP ──────────────────────────────────────────────
  //
  // trustProxy = true 时，从 X-Forwarded-For 请求头读取第一个 IP。
  // trustProxy = false 时，从底层 socket 的 remoteAddress 读取。
  //
  let ip: string;
  if (trustProxy) {
    const xff = incoming.headers["x-forwarded-for"];
    if (typeof xff === "string") {
      const firstIp = xff.split(",")[0];
      ip = firstIp
        ? firstIp.trim()
        : (incoming.socket.remoteAddress ?? "127.0.0.1");
    } else if (Array.isArray(xff) && xff.length > 0) {
      const firstEntry = xff[0];
      const firstIp = firstEntry ? firstEntry.split(",")[0] : undefined;
      ip = firstIp
        ? firstIp.trim()
        : (incoming.socket.remoteAddress ?? "127.0.0.1");
    } else {
      ip = incoming.socket.remoteAddress ?? "127.0.0.1";
    }
  } else {
    ip = incoming.socket.remoteAddress ?? "127.0.0.1";
  }

  // ── 解析 Protocol ────────────────────────────────────────
  //
  // trustProxy = true 时，从 X-Forwarded-Proto 请求头读取。
  // trustProxy = false 时，检查 socket 是否为 TLS 加密连接。
  //
  let protocol: "http" | "https";
  if (trustProxy) {
    const proto = incoming.headers["x-forwarded-proto"];
    protocol = proto === "https" ? "https" : "http";
  } else {
    const encrypted = (incoming.socket as unknown as Record<string, unknown>)
      ?.encrypted;
    protocol = encrypted ? "https" : "http";
  }

  // ── 构造 VextRequest 对象 ────────────────────────────────
  //
  // P1 优化：使用对象字面量 getter 替代 Object.defineProperty。
  // 对象形状在创建时即确定，V8 可保持快速属性模式（Hidden Class 优化）。
  //

  const requestAbortController = new AbortController();
  const req: VextRequest = {
    // ── 原始数据 ────────────────────────────────────────
    // P1 优化：query 先用 getter 懒解析，首次访问后物化为 value property。
    get query(): Record<string, string> {
      const value = getQuery();
      Object.defineProperty(req, "query", {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return value;
    },
    body: undefined, // body-parser 中间件负责填充
    params,
    headers: incoming.headers as Record<string, string | undefined>,
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
    method: (incoming.method ?? "GET").toUpperCase(),
    url: rawUrl,
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
    // 从 IncomingMessage 数据流读取原始 body 并转为 string/Buffer，
    // 供 body-parser 中间件解析。
    //
    _getRawBody: getRawBody,
    _getRawBodyBuffer: getRawBodyBuffer,
  };

  // Host close + finishResponseSend both fire exactly-once shared handlers.
  incoming.on("close", () => {
    fireRequestCloseHandlers(req);
  });

  addRequestCloseHandler(req, () => {
    requestAbortController.abort(new Error("[vextjs] Request closed"));
  });

  return req;
}
