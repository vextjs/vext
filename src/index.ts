// ── vextjs 公共导出入口 ────────────────────────────────────────
//
// 用户通过 import { ... } from 'vextjs' 访问所有公共 API 和类型。
// 内部实现模块不在此处导出，仅暴露用户需要的接口。

// 确保通过根入口只导入类型时，内置数据库的 VextApp 模块扩展仍会生效。
import "./lib/plugins/monsqlize/types.js";

// ── 类型导出 ────────────────────────────────────────────────────
export type {
  // 中间件类型
  VextMiddleware,
  VextErrorMiddleware,
  VextHandler,
  VextDefinedMiddleware,
  VextMiddlewareFactory,
  VextMiddlewareExport,

  // 请求 / 响应类型
  VextRequest,
  ParsedFile,
  InferVextSchema,
  InferVextValidation,
  VextDefaultValidatedData,
  VextValidatedData,
  VextValidationLocation,
  VextResponse,
  VextPublicResponse,
  VextRenderErrorOptions,
  VextRenderHeadOptions,
  VextRenderOptions,
  VextHeaderValue,
  VextHeaders,
  CookieParseOptions,
  CookieSerializeOptions,
  VextCookieJar,
  VextCookiePriority,
  VextCookieSameSite,
  VextSession,
  VextCacheLike,
  VextCacheSessionStoreOptions,
  VextSessionConfig,
  VextSessionCookieOptions,
  VextSessionData,
  VextRouteSessionOptions,
  VextSessionStore,
  VextSessionStoreSerializer,
  VextCsrfConfig,
  VextCsrfCookieConfig,
  VextCsrfErrorCode,
  VextCsrfMode,
  VextCsrfOriginConfig,
  VextContentSecurityPolicyConfig,
  VextCspDirectiveValue,
  VextHstsConfig,
  VextPermissionsPolicyConfig,
  VextSecurityHeadersConfig,
  VextSecurityHeadersPreset,
  VextAuthAssert,
  VextAuthCan,
  VextAuthContext,
  VextAuthContextSnapshot,
  VextAuthErrorCode,
  VextAuthMiddlewareOptions,
  VextAuthRequirement,
  VextAuthResult,
  VextAuthSource,
  VextPermissionRequirement,

  // 错误类型
  HttpErrorOptions,
  VextErrorDetails,
  VextJsonPrimitive,
  VextJsonValue,
  VextValidationFieldError,

  // Adapter 类型
  VextAdapter,
  VextServerHandle,

  // App / Config / Services 类型
  VextApp,
  VextServices,
  VextLogger,
  VextRuntimeLogger,
  VextLoggerLike,
  VextRateLimiter,
  VextValidator,
  VextConfig,
  VextConfigOverride,
  VextConfigOverrideAtomicPathRegistry,
  VextUserConfig,
  VextMiddlewareDecl,
  VextMiddlewareConfig,
  VextCorsConfig,
  VextRateLimitConfig,
  VextRequestIdConfig,
  VextLoggerConfig,
  VextShutdownConfig,
  VextResponseConfig,
  VextLogErrorsConfig,
  VextOpenAPIConfig,
  VextOpenAPITagGroup,
  VextBodyParserConfig,
  VextAccessLogConfig,
  VextClusterConfig,
  RouteOptions,
  RouteRecord,
  RouteDocsConfig,
  VextResponseSchemaConfig,
  VextResponseSchemaDefinition,
  VextRouteResponsesConfig,
  VextMiddlewareRef,

  // 缓存类型
  RouteCacheOptions,
  VextCacheConfig,
  VextResponseCacheHubOptions,
  VextCacheStats,

  // 插件类型
  VextPlugin,
  VextPluginContext,

  // Hook 类型
  VextHookHandler,
  VextHookName,
  VextHookPayloadMap,
  VextHookReturn,
  VextHooks,
  VextRouteHookInfo,
  VextResponseBeforePatch,
  VextResponseKind,

  // 路由类型
  RouteDefinition,
  RouteCollector,
  RouteFactory,
} from "./types/index.js";

// Keep the root declaration file visibly tied to the request/response type modules.
export type {} from "./types/request.js";
export type {} from "./types/response.js";

// ── 值导出（类 / 函数 / 常量）──────────────────────────────────

// 错误类
export { HttpError, VextValidationError } from "./types/errors.js";

// schema-dsl 防腐层（内部模块也通过此处访问 schema-dsl）
export { schemaAdapter, I18nError } from "./lib/schema-adapter.js";
export type {
  JSONSchema,
  ValidationResult,
  ValidateOptions,
  DslDefinition,
  DslBuilder,
} from "./lib/schema-adapter.js";

// 配置加载器
export { loadConfig } from "./lib/config-loader.js";
export { defineBootstrapConfig } from "./lib/bootstrap-config.js";
export type {
  BootstrapConfigContext,
  BootstrapConfigDefinition,
  BootstrapConfigProvider,
} from "./lib/bootstrap-config.js";

// 日志（Vext 内置 logger kernel）
export {
  createLogger,
  getLoggerLifecycle,
  normalizeVextLogger,
} from "./lib/logger.js";
export type { CreateLoggerOptions } from "./lib/logger.js";
export { createMemoryLogSink } from "./lib/logger/sinks/memory.js";
export type { MemoryLogSink } from "./lib/logger/sinks/memory.js";
export { createStdoutSink } from "./lib/logger/sinks/stdout.js";
export type {
  LogSink,
  LoggerLifecycle,
  LogRecord,
  LogLevelName,
} from "./lib/logger/types.js";

// 启动剖析（LOG-008 / PERF-07-W10 public surface）
export {
  createStartupProfiler,
  createStartupProfilerFromEnv,
  mergeStartupProfiles,
  formatStartupSummary,
  formatStartupProfile,
  writeStartupProfileJson,
} from "./lib/startup-profiler.js";
export type {
  StartupProfiler,
  StartupProfilerOptions,
  StartupProfileEvent,
  StartupProfileSnapshot,
  StartupProfileEventOptions,
  StartupProfileMergeOptions,
  StartupProfileFormatOptions,
} from "./lib/startup-profiler.js";

// 默认错误抛出（I18nError 联动）
export { createDefaultThrow } from "./lib/default-throw.js";
export type { VextThrowFn, VextThrowOptions } from "./lib/default-throw.js";

// 内置中间件工厂函数
export { createRequestIdMiddleware } from "./lib/middlewares/request-id.js";
export { createCorsMiddleware } from "./lib/middlewares/cors.js";
export {
  createBodyParserMiddleware,
  parseBytes,
} from "./lib/middlewares/body-parser.js";
export { createRateLimitMiddleware } from "./lib/middlewares/rate-limit.js";
export { responseWrapper } from "./lib/middlewares/response-wrapper.js";
export { createAccessLogMiddleware } from "./lib/middlewares/access-log.js";
export { createErrorHandler } from "./lib/middlewares/error-handler.js";

// Cookies / sessions
export {
  appendSetCookie,
  parseCookies,
  serializeClearCookie,
  serializeCookie,
} from "./lib/cookies.js";
export {
  createMemorySessionStore,
  createSessionMiddleware,
  session,
} from "./lib/session.js";
export type { VextMemorySessionStore } from "./lib/session.js";
export type {
  ResolvedVextFrontendSeoConfig,
  VextFrontendRobotsConfig,
  VextFrontendSeoConfig,
  VextFrontendSitemapConfig,
  VextOpenGraphMetadata,
  VextRenderSeoOptions,
  VextRobotsGroup,
  VextRouteFrontendSeoOptions,
  VextSeoAlternate,
  VextSeoImage,
  VextSeoMetadata,
  VextSeoRobotsDirective,
  VextSitemapEntriesContext,
  VextSitemapEntriesProvider,
  VextSitemapEntry,
  VextTwitterMetadata,
} from "./frontend/contract/types.js";
export { createCacheSessionStore } from "./lib/session-store-adapters.js";
export { createCsrfMiddleware, csrf } from "./lib/csrf.js";
export {
  createSecurityHeadersMiddleware,
  securityHeaders,
} from "./lib/security-headers.js";
export {
  assertRouteAuth,
  auth,
  authRequirementToOpenApiSecurity,
  buildRouteAuthGuardMiddleware,
  createAnonymousAuthContext,
  createAuthContext,
  createAuthContextMiddleware,
  createAuthMiddleware,
  createInvalidAuthContext,
  normalizeAuthRequirement,
  setRequestAuth,
} from "./lib/auth.js";

// 中间件定义辅助函数（用户使用）
export {
  defineMiddleware,
  defineMiddlewareFactory,
  isMiddleware,
  isMiddlewareFactory,
} from "./lib/define-middleware.js";
export type {
  TaggedMiddleware,
  TaggedMiddlewareFactory,
} from "./lib/define-middleware.js";

// 路由级校验中间件（框架内部 + 高级用法）
export { buildValidateMiddleware } from "./lib/validate-middleware.js";
export type { ValidateConfig } from "./lib/validate-middleware.js";

// i18n 语言包加载器（框架内部 + 高级用法）
export { loadI18n } from "./lib/i18n-loader.js";

// 内置 HTTP 客户端（app.fetch）
export { createVextFetch } from "./lib/fetch.js";
export type {
  VextFetch,
  VextFetchClient,
  VextFetchConfig,
  VextFetchInit,
  VextFetchClientOptions,
  VextFetchProxy,
  VextFetchProxyHandler,
  VextFetchProxyHeaderContext,
  VextFetchProxyHeaders,
  VextFetchProxyOptions,
  VextFetchProxyTargetConfig,
} from "./lib/fetch.js";

// 插件加载器（框架内部 + 高级用法）
export { loadPlugins } from "./lib/plugin-loader.js";
export type { LoadPluginsOptions } from "./lib/plugin-loader.js";

// 中间件加载器（框架内部 + 高级用法）
export {
  loadMiddlewares,
  resolveMiddleware,
  resolveMiddlewares,
  validateMiddlewareRefs,
} from "./lib/middleware-loader.js";
export type {
  MiddlewareDecl,
  MiddlewareRegistryEntry,
  MiddlewareRegistry,
} from "./lib/middleware-loader.js";

// 服务加载器（框架内部 + 高级用法）
export { loadServices } from "./lib/service-loader.js";
export type { LoadServicesOptions } from "./lib/service-loader.js";

// 中间件 Symbol 标记
export {
  MIDDLEWARE_SYMBOL,
  MIDDLEWARE_FACTORY_SYMBOL,
} from "./types/middleware.js";

// 插件定义辅助函数
export { definePlugin, defineAppExtensions } from "./types/plugin.js";

// 内置 MonSQLize 插件（开箱即用）
export {
  createMonSQLizePlugin,
  shouldLoadMonSQLize,
} from "./lib/plugins/monsqlize/index.js";
export type {
  MonSQLizeConnection,
  MonSQLizeDatabaseConfig,
  VextDatabase,
  VextModelDefinition,
  VextMonSQLizeOptions,
} from "./lib/plugins/monsqlize/index.js";

// 路由定义辅助函数
export { defineRoutes } from "./lib/define-routes.js";

// 框架启动
export { bootstrap } from "./lib/bootstrap.js";
export type { BootstrapResult } from "./lib/bootstrap.js";

// 优雅关闭（信号注册 + 编排）
export { setupShutdown, createShutdownHandler } from "./lib/shutdown.js";
export type { ShutdownOptions, ShutdownCleanup } from "./lib/shutdown.js";

// CLI 工具（项目检测）
export {
  detectProject,
  findProjectRoot,
  hasDistBuild,
  resolveEntryFile,
} from "./cli/utils/detect-project.js";
export type { ProjectInfo } from "./cli/utils/detect-project.js";

// createApp（高级用法，通常用户不直接调用）
export { createApp, DEFAULT_CONFIG } from "./lib/app.js";
export type { AppInternals } from "./lib/app.js";

// Cluster 多进程管理
export {
  ClusterMaster,
  DEFAULT_CLUSTER_CONFIG,
  workerMain,
  resolveWorkerCount,
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  DEFAULT_PID_FILE,
  checkClusterCompatibility,
} from "./lib/cluster/index.js";
export type {
  ClusterMasterConfig,
  ClusterMasterEvents,
  WorkerConfig,
  PidFileResult,
  ClusterCheckResult,
  WorkerToMasterMessage,
  WorkerReadyMessage,
  WorkerHeartbeatMessage,
  WorkerMetricsMessage,
  WorkerRequestRestartMessage,
  MasterToWorkerMessage,
  MasterSetTitleMessage,
  MasterShutdownMessage,
  MasterHealthCheckMessage,
  MasterBroadcastMessage,
  WorkerMeta,
  WorkerMetrics,
  WorkerState,
} from "./lib/cluster/index.js";

// 请求上下文（高级用法，插件可能需要访问）
export { requestContext } from "./lib/request-context.js";
export type { RequestContextStore } from "./lib/request-context.js";

// ── 测试工具（通过 'vextjs/testing' 子路径导入）─────────────
//
// 用户通过 import { createTestApp } from 'vextjs/testing' 访问。
// 此处不 re-export testing 模块内容到主入口，避免测试依赖污染生产代码。
// 子路径导出配置见 package.json 的 "exports" 字段。
//
// 如需从主入口访问测试类型（仅类型，不含运行时值）：
export type {
  CreateTestAppOptions,
  TestApp,
  TestRequest,
  TestRequestBuilder,
  TestResponse,
} from "./testing/index.js";
