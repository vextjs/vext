import type { VextApp } from "./app.js";
import type { VextAuthContext } from "./auth.js";
import type { VextCookieJar } from "./cookies.js";
import type { VextSession } from "./session.js";
import type {
  VextDefaultValidatedData,
  VextValidatedData,
  VextValidationLocation,
} from "./validation.js";

/**
 * ParsedFile — 已解析的上传文件
 *
 * 由内置 multipart 解析器或自定义上传插件填充到 req.files。
 * 内置解析通过 config.multipart 或 RouteOptions.multipart 启用；
 * 内置路径为纯内存解析：请求体和 `buffer` 都不会写入框架管理的临时目录。
 * 因此没有内置 tmpDir、文件 TTL 或定时清理任务；不再被请求/业务代码引用的 Buffer
 * 由 Node.js 垃圾回收。需要持久化或流式落盘时，应由应用/插件明确接管。
 * 需要流式落盘等高级场景时，也可以由插件引入 busboy / formidable 等库接管。
 *
 * @example
 * // 内置解析或自定义上传插件填充后：
 * req.files = parsedFiles  // ParsedFile[]
 * // 在路由 handler 中：
 * const avatar = req.files?.[0]
 * console.log(avatar.filename, avatar.size)
 */
export interface ParsedFile {
  /** 表单字段名（<input name="avatar"> 中的 "avatar"） */
  fieldname: string;
  /** 原始文件名（客户端文件系统中的名称，可能含路径，需自行处理安全） */
  filename: string;
  /** MIME 类型（如 'image/jpeg'、'application/pdf'） */
  mimetype: string;
  /**
   * 文件二进制数据。内置 multipart 解析只保存在内存中，不会创建临时文件。
   * 如需长期保存，请由业务代码或自定义流式上传插件写入目标存储。
   */
  buffer: Buffer;
  /** 文件大小（字节数） */
  size: number;
}

/**
 * VextRequest — 框架统一请求对象接口
 *
 * 由各 Adapter 负责将底层框架的请求对象转换为此接口。
 * 路由 handler 和中间件通过此接口访问请求数据，
 * 与底层框架解耦，确保切换 Adapter 时用户代码无需改动。
 */
export interface VextRequest<
  TValidated extends VextValidatedData = VextDefaultValidatedData,
> {
  // ── 原始数据 ──────────────────────────────────────────────

  /** URL 查询参数（已解析为键值对） */
  query: Record<string, string>;

  /**
   * 请求体（由 body-parser 中间件负责填充）
   * 中间件执行前为 undefined，执行后为解析后的对象
   */
  body: unknown;

  /** 路径动态参数（如 /users/:id 中的 { id: '123' }） */
  params: Record<string, string>;

  /** 请求头（全部小写 key） */
  headers: Record<string, string | undefined>;

  /** Cookie 参数（从 Cookie 请求头解析，first-wins） */
  cookies: VextCookieJar;

  /** 读取单个 cookie 值 */
  cookie(name: string): string | undefined;

  /**
   * 获取当前请求的 CSRF token。
   *
   * 仅在 `config.csrf.enabled` 或手动 `csrf()` middleware 生效的请求中保证可用。
   */
  csrfToken(): string;

  /**
   * Request authentication context.
   *
   * Defaults to an anonymous context on every request. Register `auth()` to
   * populate identity metadata, then protect routes with `RouteOptions.auth`.
   */
  auth: VextAuthContext;

  /** HTTP 方法（大写，如 'GET'、'POST'） */
  method: string;

  /** 完整请求 URL */
  url: string;

  /** 路径部分（不含 query string） */
  path: string;

  /**
   * 当前请求匹配的路由模板（如 `/users/:id`）
   *
   * 由各 Adapter 在路由匹配完成后注入，值为路由注册时使用的模板字符串。
   * 与 `path`（实际请求路径，如 `/users/abc-123`）不同，`route` 是低基数字段，
   * 适合作为 Prometheus / OTEL 指标的维度标签，可避免高基数问题。
   *
   * 未匹配到路由时（如 404 场景），值为空字符串 `''`。
   *
   * @example
   * // 注册：app.get('/users/:id', ...)
   * // 请求：GET /users/abc-123
   * req.path   // '/users/abc-123'（实际路径，高基数）
   * req.route  // '/users/:id'（路由模板，低基数）✅
   *
   * @example
   * // 404 场景（无匹配路由）
   * req.route  // ''
   */
  route: string;

  // ── 请求元信息 ────────────────────────────────────────────

  /**
   * 当前请求所属的 app 实例
   *
   * 设计说明：路由 handler 通过 defineRoutes(app => ...) 闭包访问 app，
   * 不需要 req.app。但路由级中间件没有闭包，必须通过 req.app 访问
   * throw/logger 等能力。选择挂在 req.app 而非 req.throw/req.logger，
   * 是为了保持 VextRequest 接口职责清晰——业务扩展字段（req.user 等）
   * 和框架核心能力（app）通过命名空间隔离。
   */
  app: VextApp;

  /**
   * 请求生命周期取消信号。
   *
   * 连接关闭或响应完成后会进入 aborted 状态；配置了 RouteOptions.timeout 时，
   * 超时也会触发取消。执行数据库、远程请求或队列写入等可取消操作时，应把该
   * signal 继续传给下游，并在不可取消的提交前检查 `req.signal.aborted`。
   * 框架会阻止超时后的重复响应，但业务侧外部副作用仍需协作式取消。
   */
  signal: AbortSignal;

  /**
   * 请求唯一标识
   *
   * - 默认：从 x-request-id 请求头透传，不存在则框架自动生成 UUID v4
   * - 可选：插件通过覆盖 config.requestId.generate 替换生成算法
   *
   * 由 requestId 中间件负责填充，创建时为空字符串。
   */
  requestId: string;

  /**
   * 客户端 IP
   *
   * 当 config.trustProxy = true 时从 X-Forwarded-For 请求头读取第一个 IP，
   * 否则从底层 socket 的 remoteAddress 读取。
   */
  ip: string;

  /**
   * 请求协议
   *
   * 当 config.trustProxy = true 时从 X-Forwarded-Proto 请求头读取，
   * 否则默认为 'http'。
   */
  protocol: "http" | "https";

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * 注册请求关闭钩子（连接断开时触发）
   *
   * 主要用于 SSE / WebSocket：客户端断开时清理资源。
   * 内存安全：框架在 hooks 执行完毕后自动清空 hooks 数组，
   * 无需手动移除，不会因闭包引用造成内存泄漏。
   * 每个 handler 作为底层 close listener 注册，并按 exactly-once 语义调用。
   *
   * @param handler 关闭时执行的回调
   * @example req.onClose(() => sseStream.close())
   */
  onClose(handler: () => void): void;

  // ── 校验后数据 ────────────────────────────────────────────

  /**
   * 获取经过 validate 校验并类型转换后的数据
   *
   * 必须在 options.validate 配置了对应位置后调用，
   * 未配置对应位置时返回 undefined。
   * schema-dsl 会自动做类型转换（如 query 中的数字字符串 → number）。
   *
   * location 与数据源映射：
   *   'query'  → req.query   （URL 查询参数）
   *   'body'   → req.body    （请求体）
   *   'param'  → req.params  （路径动态参数，如 /:id）
   *   'header' → req.headers （请求头）
   *   'cookie' → req.cookies （Cookie 参数）
   *
   * 注意：location 使用单数 'param'（与 validate 配置的 key 一致），
   * 但底层数据源是复数 req.params。框架内部已正确映射。
   *
   * @param location 校验数据位置
   * @returns 校验后的数据对象；路由 schema 可用时由框架自动推导
   *
   * @example
   * // 直接使用（推荐，validator 已保证数据正确性）
   * const { page, limit } = req.valid('query')
   *
   * @example
   * // 显式泛型仍可覆盖自动推导（兼容既有代码）
   * const param = req.valid<{ id: string }>('param')
   * param.id  // IDE 知道是 string
   */
  valid<
    TOverride = never,
    TLocation extends VextValidationLocation = VextValidationLocation,
  >(
    location: TLocation,
  ): [TOverride] extends [never] ? TValidated[TLocation] : TOverride;

  // ── 国际化（插件注入，可选）────────────────────────────

  /**
   * 翻译函数（i18n 插件注入）
   * @example req.t('user.not_found')        → '用户不存在'
   * @example req.t('welcome', { name: 'Alice' })  → '欢迎, Alice'
   */
  t?: (key: string, params?: Record<string, unknown>) => string;

  // ── 文件上传 ────────────────────────────────────────────

  /**
   * 已解析的上传文件列表（由内置 multipart 解析或自定义上传插件填充）
   *
   * 全局 `config.multipart.enabled = true` 时自动解析 multipart/form-data；
   * 单个路由可通过 `multipart.enabled = true/false` 覆盖启用或跳过。
   * 自定义插件也可以在内置解析关闭或 `req.files === undefined` 时填充此字段。
   * 内置解析不会创建框架管理的临时文件；`buffer` 仅在内存中保留。
   * 非文件上传请求此字段为 undefined。
   *
   * @example
   * app.post('/upload', { multipart: { enabled: true } }, async (req, res) => {
   *   const file = req.files?.[0]
   *   if (!file) return res.json({ error: '未收到文件' })
   *   // 处理 file.buffer ...
   * })
   */
  files?: ParsedFile[];

  /** Session 对象（全局或路由级 Session 启用后可用） */
  session?: VextSession;

  // ── 内部方法（框架/插件使用）────────────────────────────

  /**
   * 获取原始请求体字符串（框架内部使用）
   *
   * 供 body-parser 中间件读取，不建议用户代码直接调用。
   * 多次调用返回相同字符串（带缓存，流只消费一次）。
   * GET / HEAD / OPTIONS 等无 body 方法返回空字符串。
   *
   * @internal 由各 adapter 注入实现
   */
  _getRawBody(maxBytes?: number): Promise<string>;

  /**
   * 获取原始请求体 Buffer（框架/插件使用）
   *
   * 返回未经任何编码转换的原始字节，是内置 multipart 与自定义解析插件的基础。
   * 多次调用返回相同 Buffer 实例（带缓存，流只消费一次）。
   * GET / HEAD / OPTIONS 等无 body 方法返回空 Buffer（length = 0）。
   *
   * @example
   * // 在自定义 multipart 解析插件中：
   * const buffer = await req._getRawBodyBuffer()
   * // 将 buffer 传递给 busboy / formidable 解析
   *
   * @internal 由各 adapter 注入实现
   */
  _getRawBodyBuffer(maxBytes?: number): Promise<Buffer>;

  // ── 中间件 / 插件扩展字段 ────────────────────────────────

  /**
   * 允许中间件或插件在 req 上挂载自定义字段。
   *
   * 通过 declare module 'vextjs' 扩展 VextRequest 接口可获得类型提示：
   * @example
   * declare module 'vextjs' {
   *   interface VextRequest {
   *     user?: { id: string; role: string }
   *   }
   * }
   */
  [key: string]: unknown;
}
