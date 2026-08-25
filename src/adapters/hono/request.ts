import type { Context } from "hono";
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
 * HonoContext → VextRequest 转换
 *
 * 将 Hono 的 Context 对象转换为 vext 框架的统一请求接口。
 * 所有底层框架特有的 API 在此处适配，后续代码只与 VextRequest 交互。
 *
 * 转换要点：
 *   - query: 从 URL searchParams 解析（🆕 懒解析，首次访问时才解析）
 *   - body: 由 body-parser 中间件后续填充（初始 undefined）
 *   - params: 从 Hono 路由参数提取（🆕 懒解析，首次访问时才提取）
 *   - headers: 从原始请求头提取（key 全小写）（🆕 懒解析，首次访问时才遍历）
 *   - requestId: 由 requestId 中间件后续填充（初始空字符串）
 *   - ip: 根据 trustProxy 配置决定从 X-Forwarded-For 或 socket 读取
 *   - protocol: 根据 trustProxy 配置决定从 X-Forwarded-Proto 或默认值读取
 *   - onClose: 注册请求关闭钩子，连接断开时触发
 *   - valid: 获取 validate 中间件校验后的数据
 *
 * 🆕 性能优化（懒解析）：
 *   query / headers / params 使用 getter + 缓存模式。
 *   大部分中间件和 handler 只访问其中 1-2 个字段，
 *   懒解析避免了每请求都遍历所有 headers 和构造 URL 对象的开销。
 *   首次访问时解析并缓存，后续访问直接返回缓存值。
 *
 * @param c           Hono Context 对象
 * @param app         VextApp 实例
 * @returns VextRequest 实例
 */
export function createVextRequest(c: Context, app: VextApp): VextRequest {
  const trustProxy = app.config.trustProxy ?? false;
  const publicUrl = parsePublicUrl(c.req.url);

  // ── 懒解析缓存 ──────────────────────────────────────────
  let _queryCache: Record<string, string> | undefined;
  let _headersCache: Record<string, string | undefined> | undefined;
  let _paramsCache: Record<string, string> | undefined;
  let _cookiesCache: VextCookieJar | undefined;

  // ── 缓存原始请求体（body-parser 用）───────────────────────
  // 使用 Buffer 作为主缓存（arrayBuffer() 读取一次），字符串从中惰性派生。
  // 这样 _getRawBodyBuffer() 和 _getRawBody() 都不会重复消费 ReadableStream。
  let _rawBufferCache: Buffer | undefined;
  let _rawStringCache: string | undefined;

  async function getRawBodyBuffer(maxBytes?: number): Promise<Buffer> {
    if (_rawBufferCache !== undefined) {
      assertBodySize(_rawBufferCache.byteLength, maxBytes);
      return _rawBufferCache;
    }

    const body = c.req.raw.body;
    if (body) {
      const reader = body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (maxBytes !== undefined && total > maxBytes) {
          throw createPayloadTooLargeError(maxBytes);
        }
        chunks.push(chunk);
      }
      _rawBufferCache = Buffer.concat(chunks);
      return _rawBufferCache;
    }

    const ab = await c.req.arrayBuffer();
    _rawBufferCache = Buffer.from(ab);
    assertBodySize(_rawBufferCache.byteLength, maxBytes);
    return _rawBufferCache;
  }

  async function getRawBody(maxBytes?: number): Promise<string> {
    if (_rawStringCache !== undefined) {
      assertBodySize(Buffer.byteLength(_rawStringCache, "utf-8"), maxBytes);
      return _rawStringCache;
    }
    const buf = await getRawBodyBuffer(maxBytes);
    _rawStringCache = buf.toString("utf-8");
    return _rawStringCache;
  }

  // ── 懒解析函数 ──────────────────────────────────────────

  /**
   * 懒解析 query 参数
   *
   * 仅在首次访问 req.query 时执行 new URL() + Object.fromEntries()。
   * GET /json 等不需要 query 的场景完全跳过此开销。
   */
  function parseQuery(): Record<string, string> {
    if (_queryCache !== undefined) return _queryCache;
    // First-wins multi-value semantics — keep adapter parity.
    _queryCache = parseQueryString(publicUrl.queryString);
    return _queryCache;
  }

  /**
   * 懒解析 headers
   *
   * 仅在首次访问 req.headers 时遍历原始 Headers 对象。
   * 大部分中间件通过 c.req.header() 直接读取单个 header，
   * 但某些场景（如 validate header / 用户代码遍历）需要完整对象。
   *
   * 🆕 优化：中间件内部直接读取单个 header 时（如 requestId / cors / bodyParser），
   * 通过 req.headers['key'] 触发此懒解析，首次调用后缓存。
   */
  function parseHeaders(): Record<string, string | undefined> {
    if (_headersCache !== undefined) return _headersCache;
    const record: Record<string, string | undefined> = {};
    // Prefer Node IncomingMessage headers when the Node bridge is present so
    // empty values (e.g. x-probe: "") survive. Web Headers often drops them.
    const env = c.env as
      | {
          incoming?: {
            headers?: Record<string, string | string[] | undefined>;
          };
        }
      | undefined;
    const nodeHeaders = env?.incoming?.headers;
    if (nodeHeaders && typeof nodeHeaders === "object") {
      for (const [key, value] of Object.entries(nodeHeaders)) {
        const lower = key.toLowerCase();
        if (Array.isArray(value)) {
          record[lower] = value[0] ?? "";
        } else if (value === undefined) {
          record[lower] = undefined;
        } else {
          record[lower] = value;
        }
      }
    } else {
      c.req.raw.headers.forEach((value, key) => {
        record[key] = value;
      });
    }
    _headersCache = record;
    return _headersCache;
  }

  /**
   * 懒解析路由参数
   *
   * c.req.param() 在某些 Hono 版本中，当路由无动态段时可能抛出异常。
   * 使用 try-catch 防御，降级为空对象。
   * 仅在首次访问 req.params 时执行。
   */
  function parseParams(): Record<string, string> {
    if (_paramsCache !== undefined) return _paramsCache;
    try {
      _paramsCache = (c.req.param() ?? {}) as Record<string, string>;
    } catch {
      _paramsCache = {};
    }
    return _paramsCache;
  }

  function getCookies(): VextCookieJar {
    if (_cookiesCache !== undefined) return _cookiesCache;
    _cookiesCache = parseCookies(parseHeaders().cookie);
    return _cookiesCache;
  }

  // ── 构造 VextRequest 对象 ────────────────────────────────
  //
  // 🆕 性能优化：query / headers / params 使用 Object.defineProperty
  // 定义为 getter + 缓存（lazy evaluation）。首次访问时解析，后续直接返回缓存值。
  // 这样 GET /json 这类简单场景不会触发 new URL() / headers 遍历等重操作。
  //
  // 实现方式：先在对象字面量中放占位符值（满足 TypeScript 类型检查），
  // 然后立即用 Object.defineProperty 覆盖为 getter。
  // 首次访问 getter 时执行解析并用 value descriptor 替换 getter（后续不重复解析）。
  //

  const requestAbortController = new AbortController();
  const req: VextRequest = {
    // ── 占位符（立即被 defineProperty 覆盖）─────────────
    query: null as unknown as Record<string, string>,
    headers: null as unknown as Record<string, string | undefined>,
    cookies: null as unknown as VextCookieJar,
    params: null as unknown as Record<string, string>,

    // ── 立即可用字段 ────────────────────────────────────
    body: undefined, // body-parser 中间件负责填充
    auth: createAnonymousAuthContext(),
    method: c.req.method.toUpperCase(),
    url: publicUrl.rawUrl,
    path: publicUrl.path,
    route: "", // registerRoute handler 覆写为真实路由模板（F-01）

    // ── 元信息 ──────────────────────────────────────────
    app,
    signal: requestAbortController.signal,
    requestId: "", // requestId 中间件负责填充
    ip: resolveIp(c, trustProxy),
    protocol: resolveProtocol(c, trustProxy),

    // ── 生命周期 ────────────────────────────────────────
    onClose(handler: () => void) {
      addRequestCloseHandler(req, handler);
    },

    // ── 校验数据 ────────────────────────────────────────
    valid<T = Record<string, any>>(
      location: "query" | "body" | "param" | "header" | "cookie",
    ): T {
      // validate 中间件将校验后的数据存储在 req._validated_<location> 上
      return (req as Record<string, any>)[`_validated_${location}`] as T;
    },

    cookie(name: string): string | undefined {
      return getCookies()[name];
    },

    csrfToken(): string {
      throw new Error(
        "[vextjs] req.csrfToken() requires CSRF middleware. Enable config.csrf.enabled or register csrf().",
      );
    },

    // ── 内部方法（body-parser 中间件使用）───────────────────
    // 从 Hono Context 读取原始请求体，带缓存（流只能消费一次）。
    _getRawBody: getRawBody,
    _getRawBodyBuffer: getRawBodyBuffer,

    // ── 内部方法（body-parser multipart 解析用）────────────
    // 返回 Hono 原生 Web Request 对象，供 body-parser 直接调用
    // c.req.raw.formData()，跳过 Buffer 中转，性能更优。
    // 仅供框架内部使用，不建议用户代码直接调用。
    _getHonoRawRequest(): Request {
      return c.req.raw;
    },
  };

  // ── 定义懒解析 getter（query / headers / params）────────
  //
  // 使用 defineProperty 覆盖占位符值，实现：
  //   1. 首次访问时调用解析函数
  //   2. 解析后用 value descriptor 覆盖 getter（后续访问不重复解析）
  //   3. 仍然支持写入（如测试场景下直接赋值）
  //
  // 注意：configurable: true 是必须的，否则首次访问后无法覆盖为 value descriptor。
  //

  Object.defineProperty(req, "query", {
    get() {
      const value = parseQuery();
      // 用 value descriptor 覆盖 getter，后续访问直接返回已解析值
      Object.defineProperty(req, "query", {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return value;
    },
    set(v: Record<string, string>) {
      // 支持直接赋值（如测试场景）
      _queryCache = v;
      Object.defineProperty(req, "query", {
        value: v,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(req, "headers", {
    get() {
      const value = parseHeaders();
      Object.defineProperty(req, "headers", {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return value;
    },
    set(v: Record<string, string | undefined>) {
      _headersCache = v;
      _cookiesCache = undefined;
      Object.defineProperty(req, "headers", {
        value: v,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(req, "cookies", {
    get() {
      const value = getCookies();
      Object.defineProperty(req, "cookies", {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return value;
    },
    set(v: VextCookieJar) {
      _cookiesCache = v;
      Object.defineProperty(req, "cookies", {
        value: v,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(req, "params", {
    get() {
      const value = parseParams();
      Object.defineProperty(req, "params", {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return value;
    },
    set(v: Record<string, string>) {
      _paramsCache = v;
      Object.defineProperty(req, "params", {
        value: v,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
    configurable: true,
    enumerable: true,
  });

  // Host close/abort + finishResponseSend both fire exactly-once shared handlers.
  // Prefer Node IncomingMessage 'close' when the Node bridge provides
  // env.incoming (fires on both normal completion and client abort).
  // Fall back to AbortSignal for pure Web Request environments.
  try {
    const env = c.env as
      | { incoming?: { on?: (event: string, cb: () => void) => void } }
      | undefined;
    const incoming = env?.incoming;
    if (incoming && typeof incoming.on === "function") {
      incoming.on("close", () => {
        fireRequestCloseHandlers(req);
      });
    } else {
      const signal = c.req.raw.signal;
      if (signal) {
        if (signal.aborted) {
          fireRequestCloseHandlers(req);
        } else {
          signal.addEventListener(
            "abort",
            () => {
              fireRequestCloseHandlers(req);
            },
            { once: true },
          );
        }
      }
    }
  } catch {
    // 某些环境下 close/abort 监听可能不可用，静默忽略
  }

  addRequestCloseHandler(req, () => {
    requestAbortController.abort(new Error("[vextjs] Request closed"));
  });

  return req;
}

function parsePublicUrl(rawUrl: string): {
  rawUrl: string;
  path: string;
  queryString: string;
} {
  try {
    const url = new URL(rawUrl, "http://localhost");
    return {
      rawUrl: `${url.pathname}${url.search}`,
      path: url.pathname,
      queryString: url.search.startsWith("?") ? url.search.slice(1) : "",
    };
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    return {
      rawUrl,
      path: queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex),
      queryString: queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1),
    };
  }
}

/**
 * 解析客户端 IP 地址
 *
 * trustProxy = true 时，从 X-Forwarded-For 请求头读取第一个 IP（代理链的原始客户端 IP）。
 * trustProxy = false 时，从底层 socket 的 remoteAddress 读取。
 *
 * @param c          Hono Context
 * @param trustProxy 是否信任代理
 * @returns 客户端 IP 地址
 */
function resolveIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const firstIp = xff.split(",")[0];
      if (firstIp) return firstIp.trim();
    }
  }

  // Hono node-server 通过 c.env.incoming 暴露原始 IncomingMessage
  // 从其 socket.remoteAddress 获取客户端 IP
  try {
    const env = c.env as Record<string, any> | undefined;
    const incoming = env?.incoming as
      | { socket?: { remoteAddress?: string } }
      | undefined;
    if (incoming?.socket?.remoteAddress) {
      return incoming.socket.remoteAddress;
    }
  } catch {
    // 环境不支持时降级
  }

  return "127.0.0.1";
}

/**
 * 解析请求协议
 *
 * trustProxy = true 时，从 X-Forwarded-Proto 请求头读取。
 * trustProxy = false 时，默认为 'http'。
 *
 * @param c          Hono Context
 * @param trustProxy 是否信任代理
 * @returns 请求协议 'http' | 'https'
 */
function resolveProtocol(c: Context, trustProxy: boolean): "http" | "https" {
  if (trustProxy) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto === "https") return "https";
  }
  return "http";
}
