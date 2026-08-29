// ── 中间件类型 ──────────────────────────────────────────────
export type {
  VextMiddleware,
  VextErrorMiddleware,
  VextHandler,
  VextDefinedMiddleware,
  VextMiddlewareFactory,
  VextMiddlewareExport,
} from "./middleware.js";

export { MIDDLEWARE_SYMBOL, MIDDLEWARE_FACTORY_SYMBOL } from "./middleware.js";

// ── 请求 / 响应类型 ────────────────────────────────────────
export type { VextRequest, ParsedFile } from "./request.js";
export type {
  InferVextSchema,
  InferVextValidation,
  VextDefaultValidatedData,
  VextValidatedData,
  VextValidationLocation,
} from "./validation.js";
export type {
  VextResponse,
  VextPublicResponse,
  VextRenderErrorOptions,
  VextRenderHeadOptions,
  VextRenderOptions,
} from "./response.js";
export type { VextHeaderValue, VextHeaders } from "./headers.js";
export type {
  CookieParseOptions,
  CookieSerializeOptions,
  VextCookieJar,
  VextCookiePriority,
  VextCookieSameSite,
} from "./cookies.js";
export type {
  VextSession,
  VextCacheLike,
  VextCacheSessionStoreOptions,
  VextSessionConfig,
  VextSessionCookieOptions,
  VextSessionData,
  VextRouteSessionOptions,
  VextSessionStore,
  VextSessionStoreSerializer,
} from "./session.js";
export type {
  VextCsrfConfig,
  VextCsrfCookieConfig,
  VextCsrfErrorCode,
  VextCsrfMode,
  VextCsrfOriginConfig,
} from "./csrf.js";
export type {
  VextContentSecurityPolicyConfig,
  VextCspDirectiveValue,
  VextHstsConfig,
  VextPermissionsPolicyConfig,
  VextSecurityHeadersConfig,
  VextSecurityHeadersPreset,
} from "./security-headers.js";
export type {
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
} from "./auth.js";

// ── 错误类型 ────────────────────────────────────────────────
export { HttpError, VextValidationError } from "./errors.js";
export type {
  HttpErrorOptions,
  VextErrorDetails,
  VextJsonPrimitive,
  VextJsonValue,
  VextValidationFieldError,
} from "./errors.js";

// ── Hook 类型 ───────────────────────────────────────────────
export type {
  VextHookHandler,
  VextHookName,
  VextHookPayloadMap,
  VextHookReturn,
  VextHooks,
  VextRouteHookInfo,
  VextResponseBeforePatch,
  VextResponseKind,
} from "./hooks.js";

// ── Adapter 类型 ────────────────────────────────────────────
export type {
  VextAdapter,
  VextAdapterListenOptions,
  VextServerHandle,
} from "./adapter.js";

// ── App / Config / Services 类型 ────────────────────────────
export type {
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
  VextServerConfig,
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
  RouteCacheOptions,
  VextCacheConfig,
  VextResponseCacheHubOptions,
  VextCacheStats,
} from "./app.js";

// ── 插件类型 ────────────────────────────────────────────────
export type { VextPlugin, VextPluginContext } from "./plugin.js";
export { definePlugin, defineAppExtensions } from "./plugin.js";

// ── 路由类型 ────────────────────────────────────────────────
export type { RouteDefinition, RouteCollector, RouteFactory } from "./route.js";
