import type { CookieSerializeOptions } from "./cookies.js";
import type { VextHeaderValue, VextHeaders } from "./headers.js";
import type { VextRenderSeoOptions } from "../frontend/contract/types.js";
import type { VextJsonValue } from "./errors.js";

/**
 * VextResponse — 框架统一响应对象接口
 *
 * 由各 Adapter 负责将底层框架的响应能力转换为此接口。
 * 路由 handler 和中间件通过此接口发送响应，
 * 与底层框架解耦，确保切换 Adapter 时用户代码无需改动。
 *
 * 出口包装机制：
 *   response-wrapper 中间件调用 _enableWrap() 开启包装标志后，
 *   json() 自动将响应体包装为 { code: 0, data, requestId } 格式。
 *   rawJson() 始终绕过包装，仅供框架内部错误处理使用。
 */

/**
 * 用户可见的 VextResponse 接口
 *
 * 通过 Omit 排除 rawJson 和所有下划线前缀的内部方法，
 * 后续新增内部响应 API 也不会意外进入公共类型。
 */
type VextInternalResponseKey =
  | "rawJson"
  | Extract<keyof VextResponse, `_${string}`>;

export type VextPublicResponse = Omit<VextResponse, VextInternalResponseKey>;

export interface VextRenderHeadOptions {
  title?: string;
  description?: string;
  meta?: Record<string, string>;
  /** @internal Ordered repeated name-based meta projected from options.seo. */
  nameMeta?: ReadonlyArray<{ name: string; content: string }>;
  /** @internal Structured property-based meta projected from options.seo. */
  properties?: Record<string, string>;
  /** @internal Ordered repeated property-based meta projected from options.seo. */
  propertyMeta?: ReadonlyArray<{ property: string; content: string }>;
  links?: Array<Record<string, string>>;
  /** @internal JSON-LD projected from options.seo. */
  jsonLd?: VextJsonValue | readonly VextJsonValue[];
}

export interface VextRenderOptions {
  /**
   * HTML response status. Defaults to the current response status or 200.
   */
  status?: number;
  headers?: VextHeaders;
  head?: VextRenderHeadOptions;
  /** Per-render SEO metadata merged after app and route defaults. */
  seo?: VextRenderSeoOptions;
  nonce?: string;
  locale?: string;
  messages?: Record<string, unknown>;
  ssr?: boolean;
  layout?: boolean | string | string[];
  layoutData?: Record<string, unknown>;
}

export interface VextRenderErrorOptions extends VextRenderOptions {
  page?: string;
  props?: Record<string, unknown>;
  code?: string | number;
  message?: string;
  details?: unknown;
  expose?: boolean;
}

/**
 * Internal, buffered result used by the route-side frontend freshness layer.
 * It keeps cache storage at the page-envelope boundary rather than persisting
 * final HTML, so each request can still negotiate its own document response.
 *
 * @internal
 */
export interface VextFrontendRenderCapture {
  payload: unknown;
  status: number;
  headers: VextHeaders;
}

export interface VextResponse {
  /**
   * 返回 JSON 响应
   *
   * 当出口包装开启时（response-wrapper 中间件已执行 _enableWrap()），
   * 自动包装为：{ code: 0, data, requestId }
   * 当包装未开启时，直接发送原始 data。
   *
   * 204 特殊处理：无论包装是否开启，204 均不发送消息体（RFC 9110 §15.3.5）。
   *
   * @param data   业务数据，直接传，框架自动包装
   * @param status HTTP 状态码（可选，默认使用 .status() 设置的值或 200）
   *
   * @example
   * // 成功响应 → { code: 0, data: { id: 1, name: '...' }, requestId: '...' }
   * res.json({ id: 1, name: 'Alice' })
   *
   * @example
   * // 201 Created
   * res.json(data, 201)
   *
   * @example
   * // 204 No Content（删除等操作）
   * res.status(204).json(null)
   */
  json(data: unknown, status?: number): void;

  /**
   * 返回原始 JSON（不经过出口包装）
   *
   * 仅框架内部错误处理使用，用户代码不应直接调用。
   * 通过 VextPublicResponse 类型从用户可见接口中排除。
   *
   * @internal
   * @param data   原始 JSON 数据
   * @param status HTTP 状态码
   */
  rawJson(data: unknown, status?: number): void;

  /**
   * 返回纯文本响应（不经过出口包装）
   *
   * @param content 文本内容
   * @param status  HTTP 状态码（可选，默认使用 .status() 设置的值或 200）
   */
  text(content: string, status?: number): void;

  /**
   * 渲染 Vext 内置前端页面。
   *
   * URL 仍由 `src/routes/**` 定义；page 参数指向
   * `src/frontend/pages/**` 下的 page id，不是 URL 或绝对路径。
   * props / layoutData / messages 必须是 JSON-safe 数据，服务端代码不会进入浏览器 bundle。
   *
   * @param page    页面 id，例如 "dashboard" 或 "users/detail"
   * @param props   传给页面组件的 JSON-safe 数据
   * @param options HTML 响应、head、layout、nonce、locale、messages 等渲染选项
   */
  render(
    page: string,
    props?: Record<string, unknown>,
    options?: VextRenderOptions,
  ): void;

  /**
   * 渲染统一错误页面。
   *
   * 第一个参数是错误对象、HTTP 状态码或错误码；第二个参数可以是错误页面
   * page id，也可以直接传 options；第三个参数在第二个参数为 page id 时使用。
   */
  renderError(
    errorOrStatus?: Error | number | string,
    pageOrOptions?:
      | string
      | Record<string, unknown>
      | unknown[]
      | VextRenderErrorOptions,
    options?: VextRenderErrorOptions,
  ): void;

  /**
   * 流式响应（大文件传输、实时数据流）
   *
   * @param readable    Node.js Readable stream
   * @param contentType MIME 类型，默认 'application/octet-stream'
   */
  stream(readable: NodeJS.ReadableStream, contentType?: string): void;

  /**
   * 文件下载（触发浏览器下载行为）
   *
   * 自动设置 Content-Disposition: attachment 头，
   * 并为非 ASCII 或危险字符文件名生成安全 fallback / filename*。
   *
   * @param readable    文件流
   * @param filename    下载文件名（浏览器显示，会进行响应头安全编码）
   * @param contentType MIME 类型，默认 'application/octet-stream'
   */
  download(
    readable: NodeJS.ReadableStream,
    filename: string,
    contentType?: string,
  ): void;

  /**
   * 重定向
   *
   * Non-ASCII Location bytes are percent-encoded; CR/LF/NUL are rejected.
   * Only 301/302/303/307/308 are honored; other status values coerce to 302.
   *
   * @param url    目标 URL
   * @param status 重定向状态码（默认 302；允许 301/302/303/307/308）
   */
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): void;

  /**
   * 设置 HTTP 状态码（链式调用）
   *
   * @param code HTTP 状态码
   * @returns this，支持链式调用
   *
   * @example
   * res.status(201).json(data)
   * res.status(204).json(null)
   */
  status(code: number): this;

  /**
   * 设置响应头（链式调用）
   *
   * @param name  响应头名称
   * @param value 响应头值
   * @returns this，支持链式调用
   *
   * @example
   * res.setHeader('X-Custom', 'value').json(data)
   */
  setHeader(name: string, value: VextHeaderValue): this;

  /**
   * 追加 Set-Cookie 响应头（链式调用）。
   *
   * 多次调用会生成多个 Set-Cookie header，不会用逗号合并。
   * options 支持 `expires`、`maxAge`、`httpOnly`、`secure`、
   * `sameSite`、`priority`、`partitioned`、`domain` 和 `path`。
   */
  cookie(name: string, value: string, options?: CookieSerializeOptions): this;

  /**
   * 清除 cookie（追加一个过期的 Set-Cookie header）。
   */
  clearCookie(name: string, options?: CookieSerializeOptions): this;

  // ── 状态码（只读）─────────────────────────────────────

  /**
   * 当前 HTTP 状态码（只读）
   *
   * 返回通过 .status() 设置的值，或 json/rawJson/text 等方法
   * 传入的 status 参数所确定的最终状态码。默认 200。
   *
   * 主要用途：洋葱模型 after-middleware 在 `await next()` 后
   * 读取响应状态码（如 access-log 中间件记录请求耗时与状态码）。
   *
   * @example
   * const accessLog: VextMiddleware = async (req, res, next) => {
   *   await next()
   *   console.log(`${req.method} ${req.path} → ${res.statusCode}`)
   * }
   */
  readonly statusCode: number;

  /**
   * 响应是否已经进入终态发送。
   *
   * 与内部 `_isSent()` 保持同源，提供更熟悉的 public 只读字段，
   * 方便用户在复杂中间件中判断响应是否 already sent / terminal。
   */
  readonly headersSent: boolean;

  // ── 内部方法（用户不可见）──────────────────────────────

  /**
   * 开启出口包装标志（内部方法）
   *
   * 仅由 response-wrapper 中间件调用，用户代码不应直接调用。
   * 调用后 json() 将自动包装响应为 { code: 0, data, requestId }。
   * 通过 VextPublicResponse 类型从用户可见接口中排除。
   *
   * @internal
   */
  _enableWrap(): void;

  /** 返回当前响应是否已经开始发送。@internal */
  _isSent(): boolean;

  /**
   * Flush a deferred body/header write after the onion middleware chain unwinds.
   *
   * Buffered sends (`json` / `rawJson` / `text` / `_sendHtml` / empty redirects)
   * stage the payload on first call so post-`await next()` middleware can still
   * mutate headers (e.g. `X-Response-Time`, audit order). Adapters must call
   * `_flush()` once after `executeChain` (and after error/404 handlers).
   * Streaming exits flush eagerly and make this a no-op.
   *
   * @internal
   */
  _flush?(): void;

  /**
   * Discard a buffered terminal response before it reaches the host.
   * Used by commit barriers (for example Session persistence) so a failed
   * prerequisite can re-enter the adapter's normal error response path.
   * Returns false once an eager/streaming response has already flushed.
   *
   * @internal
   */
  _discardPendingSend?(): boolean;

  /**
   * 发送前拦截钩子（内部方法）
   *
   * cache MISS 时由响应缓存中间件注册，json()/render() 发送时回调以捕获
   * 原始 JSON data 或 render payload。
   * JSON 在包装逻辑（_wrapEnabled）之前调用，缓存的是原始 data 而非包装后的响应体。
   * Adapter 在 `_onBeforeSend`（Session Set-Cookie 注入）之后调用本钩子，
   * 并把 post-session headers 传入，以便 route-cache 识别 Set-Cookie 并拒绝缓存。
   * 当前单钩子设计（覆盖赋值）。
   *
   * @internal
   * @see 15-route-cache.md §4.3（_onSend 钩子设计）
   */
  _onSend?: (data: unknown, statusCode: number, headers?: VextHeaders) => void;

  /**
   * 所有响应出口共享的发送前内部钩子。
   *
   * 与仅用于 JSON/render cache capture 的 `_onSend` 分离，供 Session 等
   * 必须在 headers 提交前完成同步 header 注入的 Runtime 使用。
   * 在 `beginResponseSend` 内先于 `response:before` 与 `_onSend` 执行。
   *
   * @internal
   */
  _onBeforeSend?: (
    kind: import("./hooks.js").VextResponseKind,
    data: unknown,
    statusCode: number,
    headers: VextHeaders,
  ) => void;

  /**
   * Session persistence is in flight for the staged response. Route cache uses
   * this marker to avoid capturing a response before its session outcome is
   * known. Cleared before buffered adapter flush.
   *
   * @internal
   */
  _sessionCommitPending?: boolean;

  /**
   * Hook Manager 引用（内部方法）
   *
   * Adapter 创建响应对象后注入，用于 response:before/after send lifecycle。
   *
   * @internal
   */
  _hooks?: import("./hooks.js").VextHooks;

  /**
   * 发送 HTML 响应（内部方法）
   *
   * 由前端 renderer middleware 绑定 `render()` / `renderError()` 后调用。
   * Adapter 负责把 HTML 写入宿主响应对象，并统一触发 response hooks。
   *
   * @internal
   */
  _sendHtml?(
    html: string,
    status: number,
    headers: VextHeaders,
    kind: "html" | "render",
    data?: unknown,
  ): void;

  /**
   * 回放缓存中的 render payload（内部方法）
   *
   * route-cache HIT 时不重新执行 route handler，但必须用当前前端 renderer
   * 重新生成 document，避免缓存最终 HTML 后造成 manifest/template/head 注入失真。
   *
   * @internal
   */
  _renderCached?(payload: unknown, status: number, headers: VextHeaders): void;

  /**
   * Produces the render payload without sending it. Route freshness uses this
   * to persist a source-neutral page envelope then delegates normal response
   * negotiation back to `_renderCached()` for every cache hit.
   *
   * @internal
   */
  _captureFrontendRender?(
    page: string,
    props?: Record<string, unknown>,
    options?: VextRenderOptions,
  ): VextFrontendRenderCapture;

  // ── 实时通信（插件注入，可选）────────────────────────

  /**
   * 将当前请求升级为 SSE 连接（Server-Sent Events）
   * 需安装 vextjs-plugin-sse 插件
   */
  sse?(): unknown;

  /**
   * 将当前请求升级为 WebSocket 连接
   * 需安装 vextjs-plugin-ws 插件
   */
  upgrade?(): unknown;
}
