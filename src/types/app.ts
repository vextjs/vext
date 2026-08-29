import type { VextAdapter } from "./adapter.js";
import type { VextMiddleware, VextHandler } from "./middleware.js";
import type { VextHooks } from "./hooks.js";
import type { VextFetch, VextFetchConfig } from "../lib/fetch.js";
import type { DslBuilder } from "../lib/schema-adapter.js";
import type {
  VextDocsConfig,
  VextRouteDocsAccessConfig,
  VextScalarConfig,
} from "../lib/docs/types.js";
import type {
  ResponseCache,
  ResponseCacheHubOptions,
  ResponseCacheStats,
} from "response-cache-kit";
import type {
  VextFrontendUserConfig,
  VextRouteFrontendSeoOptions,
} from "../frontend/contract/types.js";
import type { VextRouteSessionOptions, VextSessionConfig } from "./session.js";
import type { VextCsrfConfig } from "./csrf.js";
import type { VextSecurityHeadersConfig } from "./security-headers.js";
import type { VextAuthRequirement } from "./auth.js";
import type { InferVextValidation } from "./validation.js";

/**
 * VextServices — 服务集合类型
 *
 * service-loader 扫描 src/services/ 目录后，
 * 将所有 service 实例注入到 app.services 中。
 *
 * 用户通过 declare module 'vextjs' 扩展此接口获得类型提示：
 * @example
 * declare module 'vextjs' {
 *   interface VextServices {
 *     user: UserService
 *     order: OrderService
 *   }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface VextServices {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * VextLogger — plugin-wrapper-compatible logger interface
 *
 * 内置实现基于 Vext logger kernel，插件可通过 app.setLogger() 包装公开 logger。
 * 普通插件不会替换默认 logger kernel。Wrapper 可只实现基础日志方法与 child；
 * 框架会补齐 trace / getLevel / setLevel 等高级运行时能力。
 * 所有日志方法自动携带 requestId（通过 AsyncLocalStorage + logger mixin 实现）。
 */
export interface VextLogger {
  trace?(msg: string, ...args: unknown[]): void;
  trace?(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  info(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  warn(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  error(err: Error, msg?: string, ...args: unknown[]): void;
  error(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  debug(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  fatal(msg: string, ...args: unknown[]): void;
  fatal(err: Error, msg?: string, ...args: unknown[]): void;
  fatal(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;

  /** 获取当前有效日志级别。 */
  getLevel?(): NonNullable<VextLoggerConfig["level"]>;

  /**
   * 调整后续日志输出级别。
   * 已创建的 child logger 与父 logger 共享同一个 runtime level controller。
   */
  setLevel?(level: NonNullable<VextLoggerConfig["level"]>): void;

  /**
   * 创建子 logger（携带额外上下文字段）
   * @param bindings 额外的上下文键值对
   */
  child(bindings: Record<string, unknown>): VextLogger;
}

/**
 * VextRuntimeLogger — complete logger guaranteed by `app.logger`.
 */
export interface VextRuntimeLogger extends VextLogger {
  trace: NonNullable<VextLogger["trace"]>;
  getLevel: NonNullable<VextLogger["getLevel"]>;
  setLevel: NonNullable<VextLogger["setLevel"]>;
  child(bindings: Record<string, unknown>): VextRuntimeLogger;
}

/**
 * VextLoggerLike — app.setLogger() wrapper return type.
 *
 * A wrapper may override only the methods it cares about; missing methods are
 * inherited from the original logger by the framework runtime.
 */
export type VextLoggerLike = Partial<VextLogger>;

/**
 * VextRateLimiter — 速率限制器接口
 *
 * 全局限流显式启用时，内置实现基于 flex-rate-limit；插件可通过
 * app.setRateLimiter() 替换实现，但该调用本身不会启用限流。
 */
export interface VextRateLimiter {
  /** 检查是否允许请求通过 */
  check(
    key: string,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

/**
 * VextValidator — 校验引擎接口
 *
 * 内置实现基于 schema-dsl，插件可通过 app.setValidator() 替换为 Zod / Yup 等。
 */
export interface VextValidator {
  /**
   * 编译 schema 并返回校验函数
   * @param schema 原始 schema 定义
   * @returns 校验函数，接收数据返回校验结果
   */
  compile(schema: Record<string, unknown>): (data: unknown) => {
    valid: boolean;
    errors?: Array<{ field: string; message: string }>;
    data?: unknown;
  };
}

// ── 缓存类型定义 ────────────────────────────────────────────

/**
 * RouteCacheOptions — 路由级响应缓存配置
 *
 * 在 RouteOptions.cache 中使用。
 *
 * @see 15-route-cache.md §3.2
 */
export interface RouteCacheOptions {
  /** 缓存有效期（毫秒），必须 > 0 */
  ttl: number;

  /**
   * 自定义 key。
   *
   * 默认: `JSON.stringify(["v2", method, path, queryTuples, varyTuples])`
   * 字符串适合固定业务缓存名；函数适合按参数、角色等维度生成 key。
   */
  key?: string | ((req: import("./request.js").VextRequest) => string);

  /**
   * 条件缓存：返回 true 时才走缓存逻辑
   *
   * 典型场景：
   * - `(req) => !req.query.refresh`（跳过刷新请求）
   * - `(req) => !req.headers.authorization`（登录用户不走缓存）
   */
  condition?: (req: import("./request.js").VextRequest) => boolean;

  /**
   * Vary headers：不同 header 值视为不同缓存条目。
   *
   * 类似 HTTP Vary 语义。
   * 常用：`['accept-language', 'accept-encoding']`。
   * 使用 `"*"` 时所有请求头都参与 key，适合调试或强隔离场景。
   */
  vary?: string[] | "*";

  /**
   * 分区 key，用于按用户、租户或其他业务维度隔离缓存。
   *
   * 设置后，请求带 Authorization 时仍可安全缓存不同分区的响应。
   *
   * @example
   * partitionKey: (req) => req.headers['x-tenant-id']
   */
  partitionKey?:
    | string
    | ((req: import("./request.js").VextRequest) => string | null | undefined);

  /**
   * 显式允许带 Authorization 的请求在没有 partitionKey 时被缓存。
   *
   * 默认 false。多数业务应优先使用 partitionKey 做用户/租户隔离。
   */
  allowAuthorizationCache?: boolean;

  /**
   * 允许携带 Cookie 的请求进入缓存（默认 false）。
   *
   * Cookie 常用于用户态或 session 标识，默认绕过以避免缓存污染。
   */
  allowCookieCache?: boolean;

  /** 是否设置 Cache-Control 响应头（默认 true） */
  cacheControl?: boolean;

  /** 缓存失效标签（用于 `app.cache.invalidate(tag)` 批量失效） */
  tags?: string[];
}

/**
 * VextCacheConfig — 全局缓存配置
 *
 * @see 15-route-cache.md §3.3
 */
export interface VextCacheConfig {
  /** 是否启用路由级响应缓存（默认 true） */
  enabled?: boolean;
  /** 默认 TTL 毫秒数（路由未配置 ttl 时回退，默认 60000） */
  defaultTtl?: number;
  /** Memory 模式快捷配置：最大缓存条目数（默认 1000） */
  maxEntries?: number;
  /** Memory 模式快捷配置：最大内存占用 bytes */
  maxMemory?: number;
  /** Memory 模式快捷配置：过期条目周期清理间隔，0 表示只做惰性清理 */
  cleanupInterval?: number;
  /**
   * 底层响应缓存运行时配置。
   *
   * 不配置时使用 cache-hub Memory；设置 `mode: "redis"` 或
   * `mode: "multi-level"` 可启用 Redis / 多级缓存、lease 与分布式标签失效。
   * 该字段只接受 response-cache-kit/cache-hub 配置，不接受自定义 Store。
   */
  cacheHub?: ResponseCacheHubOptions;
}

export type VextResponseCacheHubOptions = ResponseCacheHubOptions;

export interface VextCacheStats extends ResponseCacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * CacheStore — 缓存存储接口
 *
 * @internal
 * 旧版 MemoryCacheStore 测试与内部兼容类型。vext 用户侧响应缓存底座由
 * response-cache-kit/cache-hub 承接，不再通过此接口配置自定义 Store。
 *
 * @see 15-route-cache.md §3.4
 */
export interface CacheStore {
  /** 获取缓存（内存存储同步返回，外部存储返回 Promise） */
  get(key: string): CacheEntry | null | Promise<CacheEntry | null>;
  /** 写入缓存 */
  set(key: string, entry: CacheEntry, ttl: number): void | Promise<void>;
  /** 删除单条 */
  delete(key: string): void | Promise<void>;
  /** 按标签批量失效 */
  invalidateByTag(tag: string): void | Promise<void>;
  /** 清空 */
  clear(): void | Promise<void>;
}

/**
 * CacheEntry — 缓存条目
 *
 * @see 15-route-cache.md §3.4
 */
export interface CacheEntry {
  /** 缓存的响应数据（包装前的原始 data） */
  body: unknown;
  /** 响应状态码 */
  statusCode: number;
  /** 缓存写入时间戳（ms） */
  cachedAt: number;
  /** 关联标签 */
  tags: string[];
}

// ── 配置类型定义 ────────────────────────────────────────────

/**
 * 中间件配置项
 */
export interface VextMiddlewareConfig {
  /** 中间件名称（对应 src/middlewares/ 下的文件名，不含扩展名） */
  name: string;
  /** 中间件配置选项（传给 middlewareFactory(options)） */
  options?: Record<string, unknown>;
  /** 是否启用该中间件声明（用于环境配置 patch） */
  enabled?: boolean;
}

/**
 * 中间件声明（config.middlewares 数组元素）
 *
 * - string: 简写形式，如 "auth"
 * - object: 完整形式，如 { name: "auth", options: {...}, enabled: true }
 */
export type VextMiddlewareDecl = string | VextMiddlewareConfig;

/**
 * CORS 配置
 */
export interface VextCorsConfig {
  enabled?: boolean;
  origins?: string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/**
 * 速率限制配置
 */
export interface VextRateLimitConfig {
  /** 是否启用全局速率限制（默认 false；仅显式 true 时注册） */
  enabled?: boolean;
  /** 时间窗口内最大请求数（默认 100） */
  max?: number;
  /** 时间窗口（秒，默认 60） */
  window?: number;
  /** 超过限制时的错误消息（默认 'Too Many Requests'） */
  message?: string;
  /** 用于标识请求来源的 key（默认 'ip'）：'ip' | 'user' | 自定义函数 */
  keyBy?: string | ((req: import("./request.js").VextRequest) => string);
}

/**
 * RequestId 配置
 */
export interface VextRequestIdConfig {
  /** 是否启用请求 ID 追踪（默认 true）；设为 false 时 req.requestId 为空字符串 */
  enabled?: boolean;
  /** 从哪个请求头读取 requestId（网关透传），不存在则调用 generate()（默认 'x-request-id'） */
  header?: string;
  /** 将 requestId 写入响应头（默认 'x-request-id'） */
  responseHeader?: string;
  /** 自定义 ID 生成函数；undefined 时框架使用内置 crypto.randomUUID() */
  generate?: () => string;
}

/**
 * i18n Locale 配置
 *
 * 控制框架的多语言行为：
 *   - default:   默认语言（Accept-Language 无匹配时回退）
 *   - supported: 支持的语言列表（用于 Accept-Language 匹配）
 *   - directory: 语言包目录路径（可选，bootstrap 默认使用 src/locales/）
 */
export interface VextLocaleConfig {
  /** 默认语言代码（如 'zh-CN'），Accept-Language 无匹配时使用（默认 'en-US'） */
  default?: string;
  /** 支持的语言代码列表（如 ['zh-CN', 'en-US']），用于 Accept-Language 头匹配 */
  supported?: string[];
  /** 语言包目录路径（可选） */
  directory?: string;
}

/**
 * 日志配置
 */
export interface VextLoggerConfig {
  /** 日志级别（默认 'info'） */
  level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** 生命周期系统日志级别（默认 'concise'） */
  lifecycleLevel?: "concise" | "verbose";
  /** 是否美化输出（默认 development 时启用） */
  pretty?: boolean;
  /**
   * pretty 模式下是否为 level label 输出 ANSI 颜色。
   *
   * 默认值: `"auto"`
   * - `"auto"`：TTY 中自动启用；`FORCE_COLOR=1` 强制启用且优先于 `NO_COLOR`；
   *   `FORCE_COLOR=0`、`NO_COLOR`、`TERM=dumb` 或非 TTY 禁用
   * - `"always"`：pretty 模式下强制启用
   * - `"never"`：禁用
   *
   * 仅影响 pretty 文本输出；生产 JSON 输出不包含 ANSI。
   */
  prettyColor?: "auto" | "always" | "never";
  /**
   * pretty 模式下忽略的字段列表（逗号分隔）
   *
   * 默认值: `"pid,hostname,requestId"`
   * - `requestId` 默认被忽略，避免 mixin 注入的 requestId 在开发模式下形成多余噪音
   * - 生产模式（JSON 输出）不受影响，requestId 仍然存在于结构化日志中
   *
   * @example
   * ```typescript
   * // 只忽略 pid 和 hostname，保留 requestId 在 pretty 输出中
   * { prettyIgnore: "pid,hostname" }
   *
   * // 额外忽略自定义字段
   * { prettyIgnore: "pid,hostname,requestId,traceId" }
   * ```
   */
  prettyIgnore?: string;
  /**
   * pretty 模式下是否将额外字段压缩到消息同一行
   *
   * 默认值: `true`
   * - 启用后，结构化字段以 JSON 内联形式附加在消息末尾（单行输出）
   * - 禁用后，结构化字段展开为多行缩进格式
   * - 仅影响 pretty 模式（开发环境），生产环境 JSON 输出不受影响
   *
   * @example
   * ```typescript
   * // 默认行为（单行）:
   * // [2026-03-05 14:23:05] INFO: Seed data loaded {"count":3,"service":"UserService"}
   * { prettySingleLine: true }
   *
   * // 多行展开:
   * // [2026-03-05 14:23:05] INFO: Seed data loaded
   * //     count: 3
   * //     service: "UserService"
   * { prettySingleLine: false }
   * ```
   */
  prettySingleLine?: boolean;

  /**
   * 按字段名脱敏任意层级结构化日志字段。
   *
   * 仅支持 exact key，不支持 wildcard / glob / regex。
   * 顶层 `level` 为日志协议保留字段，不会被改写。
   */
  redactKeys?: string[];

  /**
   * 按 dot notation 精确路径脱敏结构化日志字段。
   *
   * 支持对象路径和数组数字下标，例如 `user.password`、`users.0.password`。
   * 不支持 wildcard、bracket notation、remove 或 function censor。
   */
  redactPaths?: string[];

  /** 脱敏替换值（默认 `"[Redacted]"`）。 */
  redactValue?: string;

  /**
   * 自定义 mixin 函数（日志字段扩展）
   *
   * 在每条日志写入前调用，返回值会与框架内置字段（`requestId` / `trace_id` / `span_id`）
   * 合并输出。合并优先级：
   *   - `requestId`：框架强制注入，**不可**被用户 mixin 覆盖
   *   - 其余字段：用户 mixin 返回值优先（可覆盖框架注入的 `trace_id` / `span_id`）
   *
   * 框架不关心 mixin 的具体实现，用户可在此注入任意自定义字段，
   * 包括但不限于 OTEL trace context、租户 ID、环境标识等。
   *
   * ⚠️ 注意：mixin 函数必须是**同步**函数，不支持 async。
   * 若 mixin 抛出异常，框架会降级为空对象并输出一次 warn 日志（防日志风暴）。
   *
   * @example
   * ```typescript
   * // vext.config.ts — 注入 OTEL trace context（与特定后端无关）
   * import { trace } from '@opentelemetry/api'
   *
   * export default {
   *   logger: {
   *     mixin() {
   *       const span = trace.getActiveSpan()
   *       if (!span?.isRecording()) return {}
   *       const ctx = span.spanContext()
   *       return { trace_id: ctx.traceId, span_id: ctx.spanId }
   *     }
   *   }
   * }
   * ```
   */
  mixin?: () => Record<string, unknown>;
}

/**
 * 优雅关闭配置
 */
export interface VextShutdownConfig {
  /** 整个关闭流水线的绝对期限（秒，默认 10） */
  timeout?: number;

  /**
   * 致命错误回调（uncaughtException / unhandledRejection）
   *
   * 当进程捕获到未处理的异常或 Promise rejection 时调用。
   * 适合接入告警通知（钉钉、企微、Slack、Webhook 等），
   * 在进程退出前通知运维人员。
   *
   * 注意：
   *   - 回调执行有 10 秒超时保护，超时后强制退出进程
   *   - 回调内部不应抛出异常（框架会捕获并静默忽略）
   *   - uncaughtException 触发后进程处于不确定状态，回调应尽量轻量
   *
   * @param error  捕获到的错误对象
   * @param origin 错误来源：'uncaughtException' | 'unhandledRejection'
   *
   * @example
   * ```typescript
   * // src/config/production.ts
   * export default {
   *   shutdown: {
   *     timeout: 10,
   *     onFatalError: async (error, origin) => {
   *       await fetch('https://webhook.example.com/alert', {
   *         method: 'POST',
   *         headers: { 'Content-Type': 'application/json' },
   *         body: JSON.stringify({
   *           app: 'my-service',
   *           origin,
   *           error: error.message,
   *           stack: error.stack,
   *           time: new Date().toISOString(),
   *         }),
   *       });
   *     },
   *   },
   * };
   * ```
   */
  onFatalError?: (
    error: Error,
    origin: "uncaughtException" | "unhandledRejection",
  ) => void | Promise<void>;
}

/**
 * VextServerConfig — Node.js HTTP server 层配置
 *
 * 这些配置只影响服务端入站 HTTP server，不影响 app.fetch 出站请求。
 * 未设置的字段保持 Node.js / adapter 默认值。
 */
export interface VextServerConfig {
  /** 接收完整请求的最大时间（毫秒）。0 表示禁用该超时。 */
  requestTimeout?: number;

  /** 接收完整 HTTP headers 的最大时间（毫秒）。0 表示禁用该超时。 */
  headersTimeout?: number;

  /** 响应完成后等待同一连接新请求的 keep-alive 时间（毫秒）。0 表示禁用。 */
  keepAliveTimeout?: number;

  /** socket inactivity timeout，对应 Node.js server.timeout（毫秒）。0 表示禁用。 */
  socketTimeout?: number;

  /** 最大请求头大小（bytes）。 */
  maxHeaderSize?: number;

  /** 单个 keep-alive socket 可处理的最大请求数。0 表示不限。 */
  maxRequestsPerSocket?: number;

  /** 检查未完成请求 headers/request timeout 的间隔（毫秒）。 */
  connectionsCheckingInterval?: number;
}

/**
 * 错误日志配置
 *
 * 控制 error-handler 在捕获到各类错误时是否向 logger 输出日志。
 * 未传时全部使用默认值。
 *
 * @see VextResponseConfig.logErrors
 */
export interface VextLogErrorsConfig {
  /**
   * 是否记录未知 500 错误（含完整 err 对象和 stack trace）
   * 默认 true — 未知错误属于意外异常，必须在控制台可见
   */
  unknownErrors?: boolean;

  /**
   * 是否记录 HttpError 5xx（输出 error 级别日志，含 status 和 message）
   * 默认 true — 5xx 是服务端责任，需要在控制台可见
   */
  http5xx?: boolean;

  /**
   * 是否记录 HttpError 4xx（输出 warn 级别日志，含 status 和 message）
   * 默认 false — 4xx 属于客户端错误，高流量场景避免日志噪音
   */
  http4xx?: boolean;
}

/**
 * 响应配置
 */
export interface VextResponseConfig {
  /**
   * 是否隐藏内部错误详情（默认 true）
   * 生产环境建议开启，500 错误不暴露 stack trace
   */
  hideInternalErrors?: boolean;

  /**
   * 是否启用出口包装（默认 true）
   *
   * 启用时，res.json(data) 自动包装为 { code: 0, data, requestId }。
   * 禁用时，res.json(data) 直接发送原始 data，不做任何包装。
   *
   * 典型禁用场景：
   *   - 性能基准测试（减少 JSON 序列化开销）
   *   - 微服务间通信（不需要统一包装格式）
   *   - 与第三方 API 规范对齐（如 RESTful 纯净响应）
   */
  wrap?: boolean;

  /**
   * 错误日志配置（可选，未传时使用各字段默认值）
   *
   * 控制 error-handler 捕获到各类错误时是否向 logger 输出日志。
   * 与 hideInternalErrors（控制响应体内容）正交：
   *   - hideInternalErrors 决定"响应给客户端什么"
   *   - logErrors 决定"控制台记录什么"
   */
  logErrors?: VextLogErrorsConfig;
}

/**
 * OpenAPI 文档配置
 */
export interface VextOpenAPITagGroup {
  name: string;
  tags: string[];
}

export interface VextOpenAPIConfig {
  /** 是否启用 OpenAPI 文档生成（默认：dev 启用，production 关闭） */
  enabled?: boolean;
  /** 文档标题 */
  title?: string;
  /** 文档版本 */
  version?: string;
  /** 文档描述 */
  description?: string;
  /** 文档页面路径（默认 '/docs'），保留为 openapi.docs.path 的兼容别名 */
  docsPath?: string;
  /** OpenAPI JSON 路径（默认 '/openapi.json'） */
  jsonPath?: string;
  /**
   * OpenAPI JSON 的公开访问路径（用于文档页面引用 spec 的 URL）
   *
   * 仅影响文档页面里的 spec URL，**不影响** vext 内部路由注册路径。
   * 未设置时默认与 `jsonPath` 相同。
   *
   * **使用场景**：应用部署在反向代理路径前缀下，且代理**剥离**前缀后转发给 vext。
   * 此时 vext 内部路由是 `/openapi.json`，但浏览器必须通过 `/admin/openapi.json` 访问。
   * 如果不配置此字段，文档页面会引用 `/openapi.json`（绝对路径），
   * 浏览器会请求 `https://example.com/openapi.json`（丢失代理前缀）导致 404。
   *
   * @example
   * ```typescript
   * // Nginx: /admin/* → vext（剥离 /admin 前缀）
   * openapi: {
   *   jsonPath: '/openapi.json',             // vext 内部路由
   *   jsonPublicPath: '/admin/openapi.json', // 文档页引用地址
   * }
   * ```
   */
  jsonPublicPath?: string;

  /** Vext 内置文档页面、系统资产、Code JSDoc 与菜单权限配置 */
  docs?: VextDocsConfig;

  /** @deprecated Scalar 已退出默认文档实现。保留为历史兼容字段；外部工具请直接消费 /openapi.json。 */
  scalar?: VextScalarConfig;

  /** 联系信息 */
  contact?: { name?: string; email?: string; url?: string };
  /** 许可证 */
  license?: { name: string; url?: string };

  /** 服务器地址列表 */
  servers?: Array<{
    url: string;
    description?: string;
    variables?: Record<
      string,
      { default: string; enum?: string[]; description?: string }
    >;
  }>;
  /** 全局标签定义 */
  tags?: Array<{ name: string; description?: string }>;

  /**
   * 显式 x-tagGroups vendor extension。
   *
   * 默认 Vext Docs 使用 OpenAPI path segment 生成递归导航；此字段仅在
   * 下游 OpenAPI 工具明确消费 x-tagGroups 时作为 vendor extension 原样输出。
   */
  tagGroups?: VextOpenAPITagGroup[];

  /**
   * Guard → Security Scheme 映射
   *
   * 用于从路由 middlewares 名称推断安全方案。
   * 例如: { auth: 'bearerAuth', apiKey: 'apiKeyAuth' }
   */
  guardSecurityMap?: Record<string, string>;

  /** 安全方案定义 */
  securitySchemes?: Record<
    string,
    {
      type: "http" | "apiKey" | "oauth2" | "openIdConnect";
      scheme?: string;
      bearerFormat?: string;
      name?: string;
      in?: "header" | "query" | "cookie";
      description?: string;
    }
  >;

  /** @deprecated 默认 Vext Docs 不读取此字段。此字段仅为向后兼容保留 */
  tryItOutEnabled?: boolean;
  /** @deprecated 默认 Vext Docs 不读取此字段。此字段仅为向后兼容保留 */
  docExpansion?: "none" | "list" | "full";
}

/**
 * Body 解析配置
 */
export interface VextBodyParserConfig {
  /**
   * 是否启用 body 解析（默认 true）
   *
   * 禁用时，body-parser 中间件不会注册到中间件链中，
   * req.body 始终为 undefined。适用于纯 GET 服务或自定义 body 解析场景。
   */
  enabled?: boolean;

  /** 最大请求体大小（默认 '1mb'） */
  maxBodySize?: string | number;
}

/**
 * Multipart / 文件上传全局配置
 *
 * 内置解析会把请求体和 ParsedFile.buffer 保存在内存中，不创建框架管理的临时文件或目录。
 * 因而没有 tmpDir、磁盘持久化、TTL 或定时清理配置；大文件、流式写入和持久化
 * 应由应用或自定义上传插件负责。
 */
export interface VextMultipartConfig {
  /**
   * 是否启用内置 multipart 解析（默认 false）
   *
   * 设为 true 后，body-parser 在检测到 multipart/form-data 请求时
   * 自动填充 req.files，无需用户编写解析插件。
   * 未启用时对性能零影响。
   */
  enabled?: boolean;

  /** 单个文件最大大小（字节，默认 10MB） */
  maxFileSize?: number;

  /** 单次请求最多文件数（默认 10） */
  maxFiles?: number;

  /**
   * 允许的 MIME 类型列表（不设置则允许所有）
   * @example ['image/jpeg', 'image/png', 'application/pdf']
   */
  allowedMimeTypes?: string[];
}

/**
 * 路由级单个文件字段配置
 */
export interface MultipartFileFieldConfig {
  /** 字段说明（供 OpenAPI 文档使用） */
  description?: string;

  /** 是否必传（默认 false） */
  required?: boolean;
}

/**
 * 路由级 Multipart 配置
 */
export interface MultipartRouteConfig {
  /**
   * 是否为此路由启用 multipart 解析（覆盖全局 multipart.enabled）
   *
   * - `true`：即使全局 `multipart.enabled = false`，此路由也启用内置解析
   * - `false`：即使全局 `multipart.enabled = true`，此路由也跳过内置解析
   * - 未设置：跟随全局 `multipart.enabled`
   */
  enabled?: boolean;

  /**
   * 此路由单个文件最大大小（字节，覆盖全局 multipart.maxFileSize）
   * 若全局已解析则对已解析结果执行二次校验
   */
  maxFileSize?: number;

  /**
   * 此路由最多文件数（覆盖全局 multipart.maxFiles）
   */
  maxFiles?: number;

  /**
   * 此路由允许的 MIME 类型白名单（覆盖全局 multipart.allowedMimeTypes）
   */
  allowedMimeTypes?: string[];

  /**
   * 文件字段列表，键为表单字段名
   *
   * 字符串值为字段说明，对象形式可配置 required 等选项。
   * required=true 会在运行时强制至少上传一个同名文件；未声明字段仍允许上传，
   * 并继续受 maxFiles / maxFileSize / allowedMimeTypes 限制。
   * @example { avatar: 'Profile avatar image', doc: { description: 'PDF document', required: true } }
   */
  files?: Record<string, string | MultipartFileFieldConfig>;
}

/**
 * Access Log 配置
 *
 * 控制内置 access-log 中间件的行为。
 * 利用洋葱模型 after-middleware（`await next()` 后）记录请求耗时、状态码、路径等。
 *
 * 配置位置：src/config/default.ts → config.accessLog
 */
export interface VextAccessLogConfig {
  /** 是否启用 access-log（默认 true） */
  enabled?: boolean;

  /**
   * 日志输出级别（默认 'info'）
   *
   * 使用 app.logger 对应级别的方法输出。
   * 设为 'debug' 可在生产环境通过 logger.level 初始阈值或 app.logger.setLevel() 统一控制是否输出。
   */
  level?: "info" | "debug";

  /**
   * 跳过记录的路径列表（精确匹配）
   *
   * 常见用途：排除健康检查、metrics 等高频探针路径，减少日志噪音。
   *
   * @example ['/health', '/ready', '/metrics']
   */
  skipPaths?: string[];

  /**
   * 跳过记录的路径前缀列表（前缀匹配）
   *
   * 与 skipPaths（精确匹配）互补，适用于需要跳过整个路径树的场景。
   * 例如 '/internal' 会跳过 '/internal/health'、'/internal/metrics' 等所有子路径。
   *
   * @example ['/internal', '/_debug']
   */
  skipPathPrefixes?: string[];

  /**
   * 慢请求阈值（毫秒，默认不启用）
   *
   * 设置后，响应时间超过此阈值的请求会自动提升为 warn 级别，
   * 并在日志消息末尾附加 [SLOW] 标记，便于监控和排查。
   *
   * @example 1000  // 超过 1 秒的请求标记为慢请求
   */
  slowThreshold?: number;

  /**
   * 是否对 4xx 响应自动提升日志级别为 warn（默认 false）
   *
   * 启用后，4xx 状态码的请求以 warn 级别输出（而非默认的 info/debug），
   * 便于在日志系统中快速过滤客户端错误。
   * 注意：5xx 始终自动提升为 error 级别，不受此选项控制。
   */
  warnOn4xx?: boolean;

  /**
   * 是否记录响应体大小（默认 false）
   *
   * 启用后，在日志消息中追加 Content-Length 值（如 " 1.2kB"），
   * 便于分析带宽消耗和异常大响应。
   * 若响应未设置 Content-Length 头，则显示 "-"。
   */
  logResponseSize?: boolean;
}

/**
 * Cluster 配置
 *
 * 控制多进程模式的行为。
 * 也可通过 VEXT_CLUSTER=1 环境变量开启。
 *
 * 配置位置：src/config/default.ts → config.cluster
 *
 * @see 12-cluster.md（多进程 Cluster 设计方案）
 * @see 12a-master.md §3.1（完整配置项）
 */
/**
 * AsyncLocalStorage 请求上下文配置
 *
 * 控制是否启用 AsyncLocalStorage（requestContext.run()）包裹请求处理。
 *
 * 启用时（默认）：
 *   - app.throw 的 I18nError 可通过 requestContext 获取请求级 locale
 *   - app.logger 的 mixin 自动注入 requestId 到每条日志
 *   - app.fetch 自动传播 requestId 到出站请求
 *   - 中间件/handler 可通过 requestContext.getStore() 访问请求级数据
 *
 * 禁用时（enabled: false）：
 *   - 跳过 requestContext.run() 调用；实际性能影响取决于 Node.js 版本、adapter 与业务负载
 *   - ⚠️ app.throw 的 I18nError locale 解析失效（回退到默认 locale）
 *   - ⚠️ app.logger 不自动注入 requestId（日志中无 requestId 字段）
 *   - ⚠️ app.fetch 不自动传播 requestId（需手动设置 x-request-id header）
 *   - ⚠️ requestContext.getStore() 始终返回 undefined
 *
 * 适用场景：
 *   - 纯 API 网关 / 代理层，不需要 I18n / requestId 日志关联
 *   - 极致性能要求的微服务（可接受上述功能降级）
 *
 * 配置位置：src/config/default.ts → config.requestContext
 *
 * @see request-context.ts（AsyncLocalStorage 实例）
 * @see IMPLEMENTATION-PLAN.md 任务 5.7
 */
export interface VextRequestContextConfig {
  /**
   * 是否启用 AsyncLocalStorage 请求上下文
   *
   * @default true
   */
  enabled: boolean;
}

export interface VextClusterConfig {
  /** 是否启用 cluster 模式。也可通过 VEXT_CLUSTER=1 开启 @default false */
  enabled: boolean;

  /**
   * Worker 数量
   *
   * - 'auto':   等于 CPU 核心数（感知 Docker cgroups）
   * - 'auto-1': 等于 CPU 核心数 - 1（为 Master 预留一个核心）
   * - number:   显式指定（clamp 到 [1, 64]）
   *
   * @default 'auto'
   */
  workers: "auto" | "auto-1" | number;

  /** Worker 崩溃后自动重启 @default true */
  autoRestart: boolean;

  /** 允许在窗口内重启的最大次数（第 N+1 次触发限流）@default 5 */
  maxRestarts: number;

  /** 快速重启检测窗口（毫秒）@default 60000 */
  restartWindow: number;

  /** 重启间隔退避基数（毫秒）@default 1000 */
  restartBaseDelay: number;

  /** 重启间隔上限（毫秒）@default 30000 */
  restartMaxDelay: number;

  /** Worker 内存阈值（字节），超过后由 worker 触发诊断/退出。 */
  memoryThreshold?: number;

  /** 健康检查配置 */
  healthCheck: {
    /** 是否启用健康检查 @default true */
    enabled: boolean;
    /** Master 检查间隔（毫秒）@default 15000 */
    interval: number;
    /** 心跳超时（毫秒）@default 30000 */
    timeout: number;
  };

  /** 零停机重启配置 */
  reload: {
    /** 替换下一个 Worker 前的等待时间（毫秒）@default 2000 */
    workerDelay: number;
    /** Worker 就绪超时（毫秒）@default 30000 */
    readyTimeout: number;
    /** Worker 关闭超时（毫秒）@default 10000 */
    shutdownTimeout: number;
  };

  /** PID 文件路径 @default '.vext.pid' */
  pidFile: string;

  /** 进程标题前缀 @default 'vext' */
  titlePrefix: string;

  /** 粘性会话模式 @default 'none' */
  sticky: "none" | "ip";
}

/**
 * VextDevOverlayConfig — Dev 模式错误覆盖层配置
 *
 * 控制开发模式下浏览器访问出错路由时的 HTML 错误覆盖层行为。
 * 仅在 dev 模式（vext dev）下生效，生产模式自动忽略。
 *
 * @example
 * // src/config/default.ts
 * export default {
 *   dev: {
 *     errorOverlay: { theme: 'light', maxFrames: 10 }
 *   }
 * }
 */
export interface VextDevOverlayConfig {
  /**
   * 是否启用 dev 错误覆盖层
   * @default true
   */
  enabled?: boolean;

  /**
   * 主题：深色 / 浅色
   * @default 'dark'
   */
  theme?: "dark" | "light";

  /**
   * 最多显示的堆栈帧数
   * @default 25
   */
  maxFrames?: number;
}

/**
 * VextDevConfig — Dev 模式专属配置
 *
 * 仅在开发模式下读取，生产模式忽略所有字段。
 */
export interface VextDevConfig {
  /** Dev 模式错误覆盖层配置 */
  errorOverlay?: VextDevOverlayConfig;
}

/**
 * VextConfig — 框架运行时配置（只读）
 *
 * 由 config-loader 通过 default → env → local 三层合并后 deepFreeze 生成。
 * 运行时通过 app.config 访问，不可修改。
 *
 * 配置文件位置：
 *   - src/config/default.ts    — 所有配置项的基准值
 *   - src/config/{env}.ts      — 环境覆盖（development / production / ...）
 *   - src/config/local.ts      — 本地覆盖（最高优先级，不提交 git）
 */
export interface VextConfig {
  /** HTTP 监听端口（默认 3000） */
  port: number;

  /** HTTP 监听地址（默认 '0.0.0.0'） */
  host: string;

  /**
   * 底层适配器
   *
   * 字符串：内置 adapter 标识（如 'hono'、'fastify'）
   * 函数：adapter 工厂函数（如 fastifyAdapter({ bodyLimit: 5MB })）
   * 对象：第三方 adapter 实例（必须实现 VextAdapter 接口）
   */
  adapter: string | ((app: VextApp) => VextAdapter) | VextAdapter;

  /** 是否信任代理（影响 req.ip / req.protocol 从 X-Forwarded-* 读取） */
  trustProxy: boolean;

  /** 路由级中间件白名单（支持字符串简写或对象完整声明） */
  middlewares: VextMiddlewareDecl[];

  /** CORS 配置 */
  cors: VextCorsConfig;

  /** 全局速率限制配置 */
  rateLimit: VextRateLimitConfig;

  /** RequestId 配置 */
  requestId: VextRequestIdConfig;

  /** 日志配置 */
  logger: VextLoggerConfig;

  /** 优雅关闭配置 */
  shutdown: VextShutdownConfig;

  /** Node.js HTTP server 层配置 */
  server: VextServerConfig;

  /** 响应配置 */
  response: VextResponseConfig;

  /** Session 配置（enabled=true 时由框架自动装配） */
  session?: VextSessionConfig;

  /** CSRF 防护配置（默认关闭；启用后自动保护 unsafe methods） */
  csrf?: VextCsrfConfig;

  /** Security Headers 配置（默认关闭；启用后自动写入低破坏安全响应头） */
  securityHeaders?: VextSecurityHeadersConfig;

  /** Body 解析配置 */
  bodyParser: VextBodyParserConfig;

  /** Multipart / 文件上传配置 */
  multipart?: VextMultipartConfig;

  /** Access Log 配置 */
  accessLog: VextAccessLogConfig;

  /** OpenAPI 文档配置 */
  openapi: VextOpenAPIConfig;

  /**
   * 内置前端运行时配置。
   *
   * 默认禁用，启用后由 `vext build/dev/start` 接管 client bundle、
   * typed API client 与静态资源 fallback。
   */
  frontend?: VextFrontendUserConfig;

  /**
   * AsyncLocalStorage 请求上下文配置
   *
   * 控制是否启用 requestContext.run() 包裹请求处理。
   * 禁用后会跳过 AsyncLocalStorage 包裹，但 logger requestId 自动注入、
   * app.throw locale 解析、app.fetch requestId 传播均失效；请按真实负载评估取舍。
   *
   * @see VextRequestContextConfig
   */
  requestContext: VextRequestContextConfig;

  /**
   * 内置 app.fetch 配置。
   *
   * 控制出站 HTTP 客户端的 timeout / retry / header 传播行为，
   * 以及根 app.fetch.proxy 使用的配置化上游代理目标。
   */
  fetch?: VextFetchConfig;

  /**
   * Cluster 多进程配置
   *
   * 启用后 Master 进程管理多个 Worker 进程，
   * 利用多核 CPU 并支持零停机重启。
   *
   * 也可通过 VEXT_CLUSTER=1 环境变量开启。
   *
   * @see 12-cluster.md（设计方案）
   */
  cluster?: Partial<VextClusterConfig>;

  /**
   * 路由级响应缓存配置
   *
   * 控制 response-cache-kit/cache-hub 的运行时行为。
   * 路由级配置通过 RouteOptions.cache 声明。
   *
   * @see 15-route-cache.md §2.2（全局配置）
   */
  cache?: VextCacheConfig;

  /**
   * 测试模式标志（内部使用）
   *
   * createTestApp 设置为 true，阻止 shutdown 中的 process.exit()。
   * 用户不应手动设置此字段。
   *
   * @internal
   */
  _testMode?: boolean;

  /**
   * 运行时模式标记（内部使用）
   *
   * dev bootstrap 设置为 development，生命周期 hook 用它披露稳定运行入口。
   *
   * @internal
   */
  _runtimeMode?: "production" | "development" | "test";

  /**
   * Dev 模式专属配置（仅在开发模式下读取）
   *
   * 用于控制 Dev Error Overlay 等开发辅助功能。
   * 生产模式下所有字段被忽略。
   */
  dev?: VextDevConfig;

  /**
   * 允许用户扩展自定义配置字段
   *
   * 插件可通过 declare module 'vextjs' 扩展 VextConfig 接口获得类型提示。
   */
  [key: string]: unknown;
}

/**
 * 基线/独立配置输入类型。
 *
 * 顶层字段可选；一旦声明嵌套 section，该 section 必须满足完整类型合同。
 * 环境与本地覆盖层请使用 {@link VextConfigOverride}。
 */
export type VextUserConfig = Partial<VextConfig>;

/**
 * 配置覆盖中必须整体替换的 capability 路径。
 *
 * 插件可通过 module augmentation 增加自定义原子路径；路径相对于
 * {@link VextConfig} 根对象，使用点号分隔。
 */
export interface VextConfigOverrideAtomicPathRegistry {
  adapter: true;
  "session.store": true;
  "frontend.adapter": true;
  "frontend.deploy.upload.adapter": true;
  "cache.cacheHub": true;
  "database.monsqlizeOptions.schemaDsl.runtime": true;
}

type VextConfigOverrideFunction = (...args: never[]) => unknown;

type VextConfigOverrideBuiltinAtomic =
  | Date
  | RegExp
  | Error
  | Promise<unknown>
  | Map<unknown, unknown>
  | ReadonlyMap<unknown, unknown>
  | Set<unknown>
  | ReadonlySet<unknown>
  | WeakMap<WeakKey, unknown>
  | WeakSet<WeakKey>
  | ArrayBuffer
  | ArrayBufferView;

type VextConfigOverrideChildPath<
  Parent extends string,
  Key extends PropertyKey,
> = Key extends string ? `${Parent}.${Key}` : Parent;

type VextConfigOverrideValue<
  T,
  Path extends string,
> = Path extends keyof VextConfigOverrideAtomicPathRegistry
  ? T
  : T extends VextConfigOverrideFunction
    ? T
    : T extends readonly unknown[]
      ? T
      : T extends VextConfigOverrideBuiltinAtomic
        ? T
        : T extends object
          ? {
              [K in keyof T]?: VextConfigOverrideValue<
                T[K],
                VextConfigOverrideChildPath<Path, K>
              >;
            }
          : T;

/**
 * 环境、local 与测试配置使用的路径感知递归 patch 类型。
 *
 * 普通对象可递归省略字段；数组、函数、内建对象与注册的 capability
 * 路径保持原类型并整体替换，与 config-loader 的运行时合并边界一致。
 */
export type VextConfigOverride = {
  [K in keyof VextConfig]?: K extends string
    ? VextConfigOverrideValue<VextConfig[K], K>
    : VextConfig[K];
};

// ── VextApp 类型定义 ────────────────────────────────────────

/**
 * VextApp — 框架应用实例
 *
 * 通过 createApp(config) 创建，是整个应用的核心对象。
 * 挂载配置、服务、日志、错误抛出等内置能力，
 * 并通过 extend() / use() 等方法支持插件扩展。
 *
 * 路由 handler 通过 defineRoutes(app => ...) 闭包访问 app。
 * 中间件通过 req.app 访问 app。
 *
 * 生命周期：
 *   createApp(config)
 *     → plugin-loader（app.use() 可用）
 *     → middleware-loader
 *     → service-loader（app.services 注入）
 *     → router-loader（路由注册）
 *     → lockUse()（禁止 app.use()）
 *     → listen()（HTTP 开始监听）
 *     → onReady 钩子
 *     → SIGTERM/SIGINT → shutdown
 */
export interface VextApp {
  // ── HTTP 方法（三段式：path, options, handler）──────────

  get<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  get(path: string, handler: VextHandler): void;

  post<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  post(path: string, handler: VextHandler): void;

  put<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  put(path: string, handler: VextHandler): void;

  patch<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  patch(path: string, handler: VextHandler): void;

  delete<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  delete(path: string, handler: VextHandler): void;

  head<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  head(path: string, handler: VextHandler): void;

  options<const TOptions extends RouteOptions>(
    path: string,
    options: TOptions,
    handler: VextHandler<InferVextValidation<TOptions["validate"]>>,
  ): void;
  options(path: string, handler: VextHandler): void;

  // ── 内置模块（插件可覆盖）──────────────────────────────

  /**
   * 结构化日志（内置 Vext logger kernel，插件可通过 app.setLogger() 包装）
   * 自动携带 requestId，支持 .child() 创建子 logger
   */
  logger: VextRuntimeLogger;

  /**
   * 抛出 HTTP 错误，框架统一转为 { code, message, requestId } 响应
   *
   * 内部基于 schema-dsl I18nError 实现，支持多语言 + 错误码映射。
   * 无 i18n 语言包时退化为原始 message 传递。
   *
   * 支持三种调用形式：
   *
   * **快捷方式**（i18n key，status 从 i18n 配置读取，默认 400）：
   * @example app.throw('balance.insufficient')
   * @example app.throw('balance.insufficient', { balance: 50 })
   *
   * **标准调用**（显式指定 HTTP 状态码）：
   * @example app.throw(404, 'user.not_found')
   * @example app.throw(400, '邮箱已注册', 10001)
   * @example app.throw(401, '缺少认证令牌', 'UNAUTHORIZED')
   * @example app.throw(400, 'balance.insufficient', { balance: 50 })
   * @example app.throw(400, 'balance.insufficient', { balance: 50 }, 20001)
   * @example app.throw(502, 'payment.failed', { orderId }, { provider: 'stripe', providerCode: 'card_declined' })
   * @example app.throw({ status: 502, message: 'payment.failed', code: 'PAYMENT_FAILED', details: { provider: 'stripe' } })
   */
  throw(messageKey: string): never;
  throw(messageKey: string, params: Record<string, unknown>): never;
  throw(options: import("../lib/default-throw.js").VextThrowOptions): never;
  throw(
    status: number,
    message: string,
    paramsOrCode?: Record<string, unknown> | number | string,
    codeOrDetails?: number | string | unknown[] | Record<string, unknown>,
  ): never;

  // ── 运行时数据（不可覆盖）─────────────────────────────

  /**
   * 最终合并后的运行时配置（只读）
   *
   * 由 config-loader 加载 default → env → local 三层合并并 deepFreeze。
   */
  config: Readonly<VextConfig>;

  /**
   * service-loader 注入的所有 service 实例
   *
   * 通过 app.services.<name> 方式访问。
   * service-loader 在 router-loader 之前执行，
   * 因此 handler 中访问 app.services 是安全的。
   */
  services: VextServices;

  /**
   * 框架生命周期 Hook Manager。
   *
   * 用于在插件或业务启动阶段注册 request/route/validation/response/error/fetch/service
   * 等生命周期钩子。`app.hooks` 是保留属性，不能再通过 app.extend("hooks") 覆盖。
   */
  hooks: VextHooks;

  /**
   * 底层适配器实例（由 adapter-resolver 解析后挂载）
   *
   * bootstrap 通过 app.adapter 注册中间件、路由、错误处理等。
   * 用户代码不应直接使用此属性。
   *
   * @internal
   */
  adapter: VextAdapter;

  // ── 框架扩展 API ──────────────────────────────────────

  /**
   * 向 app 挂载自定义属性（插件专用）
   *
   * 只有插件可以通过此方法扩展 app 对象。
   * 配合 declare module 'vextjs' 获得类型提示。
   *
   * @param key   属性名
   * @param value 属性值
   *
   * @example
   * // 在插件中
   * app.extend('redis', new RedisCache())
   *
   * // 类型声明
   * declare module 'vextjs' {
   *   interface VextApp { redis: RedisCache }
   * }
   */
  extend<K extends keyof VextApp>(key: K, value: VextApp[K]): void;
  extend<K extends string, V>(
    key: K extends keyof VextApp ? never : K,
    value: V,
  ): void;

  /**
   * 替换全局校验引擎（插件专用）
   *
   * 默认：schema-dsl
   * 可替换为 Zod / Yup 等第三方校验库。
   *
   * @param validator 新的校验引擎实例
   */
  setValidator(validator: VextValidator): void;

  /**
   * 获取当前校验引擎
   * @returns 当前校验引擎实例
   */
  getValidator(): VextValidator;

  /**
   * 包装或替换 app.throw 的实现（插件专用）
   *
   * 常见用途：
   *   - 对默认错误做统一映射
   *   - 在抛错前注入自定义日志或监控埋点
   *   - 对接业务错误码体系
   *
   * @param wrapper 接收原始 throw 实现，返回新的 throw 实现
   */
  setThrow(wrapper: (original: VextApp["throw"]) => VextApp["throw"]): void;

  /**
   * 包装或替换 app.logger 的实现（插件专用）
   *
   * 与 setThrow 模式一致：接收原始实现，返回新实现。
   * 返回值可以只覆盖部分 logger 方法，未返回的方法会由框架回退到原始 logger。
   * 常见用途：
   *   - 将日志同时转发到外部系统（OTel Logs、Sentry、自定义聚合）
   *   - 在所有日志中注入全局字段（tenant.id、app.version 等）
   *   - 过滤或采样日志
   *
   * @param wrapper 接收原始 logger，返回完整或部分新 logger
   *
   * @example
   * // 在插件中将所有日志转发到 OTel
   * app.setLogger((original) => ({
   *   ...original,
   *   info(msgOrObj: unknown, ...args: unknown[]) {
   *     otelBridge.emit("info", ...)
   *     ;(original.info as (...a: unknown[]) => void)(msgOrObj, ...args)
   *   },
   *   child: (b) => original.child(b),
   * }))
   */
  setLogger(wrapper: (original: VextRuntimeLogger) => VextLoggerLike): void;

  /**
   * 替换全局速率限制实现（插件专用）
   *
   * 显式启用限流时默认使用 flex-rate-limit；本方法不会修改 enabled。
   * @param limiter 新的速率限制器实例
   */
  setRateLimiter(limiter: VextRateLimiter): void;

  /**
   * 覆盖 requestId 生成算法（插件专用）
   *
   * 默认：crypto.randomUUID()
   * 常见替换：APM traceId、Snowflake ID 等。
   *
   * @param generate 新的 ID 生成函数
   */
  setRequestIdGenerator(generate: () => string): void;

  /**
   * 注册优雅关闭钩子（LIFO 顺序执行）
   *
   * SIGTERM/SIGINT 信号触发时，按注册的逆序执行所有关闭钩子。
   * 适合：关闭应用自有连接、刷新日志缓冲区、取消定时任务等。
   * 内置数据库插件会自动关闭 app.db。
   *
   * @param handler 关闭时执行的回调
   *
   * @example
   * app.onClose(async () => {
   *   await app.redis.quit()
   * })
   */
  onClose(handler: () => Promise<void> | void): void;

  /**
   * 注册就绪钩子（HTTP 监听后执行）
   *
   * 所有插件加载完成、HTTP 开始监听之后触发。
   * 适合：预热缓存、检查外部依赖、打印启动信息。
   *
   * @param handler 就绪时执行的回调
   *
   * @example
   * app.onReady(async () => {
   *   await warmupCache()
   *   app.logger.info('Cache warmed up')
   * })
   */
  onReady(handler: () => Promise<void> | void): void;

  /**
   * 注册全局 HTTP 中间件（插件专用）
   *
   * 对所有路由生效，在路由级 middlewares 之前执行。
   * 只能在插件 setup() 中调用，路由注册完成后调用将抛出错误。
   *
   * @param middleware 标准 VextMiddleware
   *
   * @example
   * definePlugin({
   *   name: "security",
   *   setup(app) {
   *     app.use(securityHeaders({ preset: "strict" }))
   *   },
   * })
   */
  use(middleware: VextMiddleware): void;

  /**
   * 缓存管理 API
   *
   * 提供缓存失效、删除、清空、统计等操作。
   * 在 createApp 中初始化 response-cache-kit 并挂载。
   *
   * @see 15-route-cache.md §2.3（运行时 API）
   */
  cache: {
    /** 按标签批量失效 */
    invalidate(tag: string): Promise<void>;
    /** 删除指定 key */
    delete(key: string): Promise<void>;
    /** 清空所有缓存 */
    clear(): Promise<void>;
    /** 缓存统计 */
    stats(): VextCacheStats;
    /** @internal 获取响应缓存核心实例 */
    _getResponseCache(): ResponseCache;
  };

  /**
   * 内置 HTTP 客户端（封装 Node.js fetch）
   *
   * 自动传播 requestId，结构化日志记录请求/响应。
   * 支持 timeout / retry / retryDelay / propagateRequestId 等扩展选项。
   * 当前版本未暴露 app.setFetch() 公共 API；如需替换需在框架内部注入。
   *
   * @see 06d-fetch.md
   */
  fetch: VextFetch;

  // ── 允许插件扩展（declare module 方式）──────────────────
  [key: string]: unknown;
}

// ── 路由相关类型 ────────────────────────────────────────────

/**
 * 路由级中间件引用
 *
 * 字符串引用：对应 config.middlewares 白名单中的 name
 * 对象引用：带配置覆盖的中间件引用
 */
export type VextMiddlewareRef = string | { name: string; options?: unknown };

/**
 * VextSchemaField — 路由校验和 OpenAPI 响应 schema 的字段定义。
 *
 * 支持 schema-dsl 字符串、字段级 DslBuilder、嵌套对象和对象数组。
 * DslBuilder 主要用于字段级业务描述：
 * `schemaAdapter.compileField("string:1-50!").description("用户名")`。
 */
export type VextSchemaField =
  | string
  | DslBuilder
  | readonly VextSchemaField[]
  | { [key: string]: VextSchemaField };

/**
 * Runtime response data schema compiled once during route registration.
 *
 * Accepts a schema-dsl field map, a self-contained raw JSON Schema object, or
 * a JSON Schema reference string. Raw schemas intentionally use `unknown`
 * values so keywords such as `type`, `required`, `$defs`, and boolean
 * `additionalProperties` remain representable by the public type.
 */
export type VextResponseSchemaDefinition = Record<string, unknown> | string;

export interface VextResponseSchemaConfig {
  schema: VextResponseSchemaDefinition;
}

export type VextRouteResponsesConfig = Record<
  string | number,
  VextResponseSchemaConfig
>;

/**
 * OpenAPI 文档配置（路由级）
 *
 * 在路由 options.docs 中声明，控制 OpenAPI 文档生成行为。
 * 所有字段均可选，未声明时使用自动推断值。
 *
 * @see 14-openapi.md §1.1（docs 配置接口）
 */
export interface RouteDocsConfig {
  /** 接口摘要（一句话描述），映射到 OpenAPI operation.summary */
  summary?: string;

  /** 接口详细描述（支持 Markdown），映射到 OpenAPI operation.description */
  description?: string;

  /** @deprecated `docs.tags` 已忽略；OpenAPI operation.tags 现在会从路由 path/source 自动推断 */
  tags?: string[];

  /**
   * 操作标识（全局唯一），映射到 OpenAPI operation.operationId。
   * 默认自动推断：POST /users → 'createUsers'
   * 显式值或自动推断值重复时，OpenAPI 生成会报错。
   */
  operationId?: string;

  /** 是否从文档中隐藏此路由 @default false */
  hidden?: boolean;

  /** 文档菜单权限 metadata，仅作用于未 hidden 的文档项 */
  access?: VextRouteDocsAccessConfig | string;

  /** 是否已废弃，映射到 OpenAPI operation.deprecated @default false */
  deprecated?: boolean;

  /**
   * 安全方案覆盖。
   * 默认从 middlewares 推断（如 middlewares: ['auth'] → bearer token）。
   * 设为 [] 表示无需认证。
   */
  security?: Array<Record<string, string[]>>;

  /**
   * 自定义扩展字段（x- 前缀），映射到 OpenAPI operation 的 x-* 字段。
   */
  extensions?: Record<string, unknown>;

  /**
   * 响应定义，映射到 OpenAPI operation.responses。
   * key 为 HTTP 状态码（数字或字符串）。
   */
  responses?: Record<
    string | number,
    {
      /** 响应描述 */
      description?: string;
      /**
       * 响应体 schema（schema-dsl 字符串对象、字段级 DslBuilder 或引用字符串）
       */
      schema?: Record<string, VextSchemaField> | string;
      /** Content-Type @default 'application/json' */
      contentType?: string;
      /** 响应示例 */
      example?: unknown;
      /** 多个响应示例 */
      examples?: Record<
        string,
        {
          summary?: string;
          description?: string;
          value: unknown;
        }
      >;
      /** 响应头 */
      headers?: Record<
        string,
        {
          description?: string;
          schema?: { type: string };
        }
      >;
    }
  >;
}

/**
 * RouteOptions — 路由三段式的第二个参数（options）
 *
 * 声明式配置对象，描述中间件、参数校验、文档元信息等。
 * 暴露给文档生成工具，也用于框架内部的中间件组装。
 *
 * @example
 * app.post('/users', {
 *   validate: { body: { name: 'string:1-50', email: 'email' } },
 *   middlewares: ['audit-log'],
 *   docs: { summary: '创建用户' },
 * }, handler)
 */
export interface RouteOptions {
  /**
   * 请求数据校验（schema-dsl DSL 对象）
   *
   * 框架内部统一调用 dsl() + validate()，用户无需 import schema-dsl。
   * 校验顺序：param → query → header → cookie → body
   */
  validate?: {
    query?: Record<string, VextSchemaField>;
    body?: Record<string, VextSchemaField>;
    param?: Record<string, VextSchemaField>;
    header?: Record<string, VextSchemaField>;
    cookie?: Record<string, VextSchemaField>;
  };

  /**
   * Runtime JSON response schemas keyed by exact status (200), status family
   * (2xx), or `default`. Schemas describe the business data passed to
   * `res.json()` and are compiled once during route registration.
   *
   * `docs.responses` remains docs metadata. Do not repeat a schema there for
   * the same selector.
   */
  responses?: VextRouteResponsesConfig;

  /**
   * 路由级中间件引用
   *
   * 在 config/default.ts 的 middlewares[] 白名单中声明后才可引用。
   * 字符串引用名称，对象可附带配置覆盖。
   */
  middlewares?: VextMiddlewareRef[];

  /**
   * OpenAPI 文档配置（可选）
   */
  docs?: RouteDocsConfig;

  /**
   * 路由级响应缓存
   *
   * - `false`：显式禁用
   * - `number`：TTL 毫秒数简写（等价 `{ ttl: number }`）
   * - `RouteCacheOptions`：完整配置
   *
   * @see 15-route-cache.md §3.1
   */
  cache?: false | number | RouteCacheOptions;

  /**
   * Frontend route freshness and static-output policy.
   *
   * This remains part of the existing route declaration: it does not create a
   * second page or route DSL. `revalidate` is expressed in seconds.
   */
  frontend?: VextRouteFrontendOptions;

  /**
   * Route-level auth guard.
   *
   * - `true`: require an authenticated request.
   * - object: require an authenticated request by default; `required: false`
   *   keeps the route public/optional unless roles, scopes, permissions or a
   *   custom check are present.
   * - `false`: explicitly public, and OpenAPI auth inference is disabled.
   *
   * Identity is filled by `auth()` middleware or user middleware that assigns
   * `req.auth`; this option only protects the route.
   */
  auth?: false | true | VextAuthRequirement;

  /**
   * 路由级 CSRF 跳过开关。
   *
   * 仅支持 `false`，用于 webhook、第三方回调或纯 bearer API 等明确不走 CSRF 的路由。
   */
  csrf?: false;

  /**
   * 路由级 Security Headers 跳过开关。
   *
   * 仅支持 `false`，用于嵌入页面、第三方回调或需要自定义响应头的路由。
   */
  securityHeaders?: false;

  /**
   * 路由级 Session 开关或安全行为覆盖。
   *
   * Store、cookie name 和 idLength 保持应用级，不允许按路由切换。
   */
  session?: boolean | VextRouteSessionOptions;

  /**
   * 路由级请求超时（毫秒）。
   *
   * `false` 表示显式不启用路由超时中间件；顶层配置优先于兼容保留的
   * `override.timeout`。
   */
  timeout?: number | false;

  /** 路由级 body 解析配置；优先级高于全局 bodyParser。 */
  bodyParser?: VextBodyParserConfig;

  /**
   * 路由级覆盖（覆盖 config/default.ts 中的全局配置）
   */
  override?: {
    rateLimit?: { max?: number; window?: number; keyBy?: string } | false;
    /** @deprecated 请使用顶层 `timeout`。 */
    timeout?: number;
    maxBodySize?: string | number;
    cors?: VextCorsConfig;
  };

  /**
   * 路由级 multipart / 文件上传配置
   *
   * 配置后 OpenAPI 生成器会自动输出 multipart/form-data requestBody。
   */
  multipart?: MultipartRouteConfig;
}

/**
 * Route-side frontend policy consumed by the route manifest, renderer and
 * filesystem freshness store.
 */
export interface VextRouteFrontendOptions {
  /** Dynamic by default; static and revalidate participate in freshness storage. */
  mode?: "dynamic" | "static" | "revalidate";

  /** Revalidation interval in seconds. Required for `mode: "revalidate"`. */
  revalidate?: number;

  /** Concrete parameter combinations to materialize for a static route. */
  staticParams?: ReadonlyArray<Record<string, string | number | boolean>>;

  /** Prevent server page-body rendering while preserving document/data/assets. */
  clientOnly?: boolean;

  /**
   * Browser hydration policy. `none` keeps SSR HTML/CSS but omits the Vext and
   * React browser runtime. It cannot be combined with clientOnly.
   */
  hydration?: "full" | "none";

  /** Static, JSON-safe SEO metadata merged before per-render overrides. */
  seo?: VextRouteFrontendSeoOptions;

  /** Stable invalidation tags for persisted public freshness entries. */
  tags?: ReadonlyArray<string>;

  /** Frontend page id used by static materialization when route and page paths differ. */
  page?: string;

  /** Optional build-time limits for one static route closure. */
  staticBudget?: {
    maxParams?: number;
    maxDurationMs?: number;
    maxBytes?: number;
  };
}

// ── 路由内部类型 ────────────────────────────────────────────

/**
 * 路由记录（内部数据结构）
 *
 * defineRoutes 收集到的单条路由信息，
 * 由 router-loader 调用 register() 注册到 adapter。
 */
export interface RouteRecord {
  /** HTTP 方法（大写） */
  method: string;
  /** 相对子路径（未含前缀） */
  path: string;
  /** 路由配置（validate / middlewares / docs） */
  options: RouteOptions;
  /** 路由处理函数 */
  handler: VextHandler;
}
