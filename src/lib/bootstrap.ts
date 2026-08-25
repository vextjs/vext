import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import cluster from "node:cluster";
import {
  finalizeConfig,
  loadConfig,
  type LoadConfigMetadata,
  loadRawConfig,
} from "./config-loader.js";
import {
  CLUSTER_BOOTSTRAP_PATCH_ENV,
  type BootstrapCommand,
} from "./bootstrap-config.js";
import {
  getDefaultRuntimeMode,
  resolveConfigProfile,
} from "./config-profile.js";
import {
  assertFrontendOutputReady,
  createFrontendNotFoundHandler,
} from "../frontend/runtime/static-mount.js";
import { createFrontendRenderMiddleware } from "../frontend/runtime/renderer.js";
import {
  needsFrontendSeoRuntimeEndpoints,
  registerFrontendSeoEndpoints,
} from "../frontend/runtime/seo-endpoints.js";
import { resolveFrontendConfig } from "../frontend/tooling/config-resolver.js";
import { createApp } from "./app.js";
import type { AppInternals } from "./app.js";
import { resolveAdapter } from "./adapter-resolver.js";
import { loadI18n } from "./i18n-loader.js";
import { schemaAdapter } from "./schema-adapter.js";
import { loadPlugins } from "./plugin-loader.js";
import {
  createMonSQLizePlugin,
  shouldLoadMonSQLize,
} from "./plugins/monsqlize/index.js";
import { loadMiddlewares } from "./middleware-loader.js";
import { loadServices } from "./service-loader.js";
import { loadRoutes } from "./router-loader.js";
import { createRequestIdMiddleware } from "./middlewares/request-id.js";
import { createCorsMiddleware } from "./middlewares/cors.js";
import { createBodyParserMiddleware } from "./middlewares/body-parser.js";
import { createRateLimitMiddleware } from "./middlewares/rate-limit.js";
import { responseWrapper } from "./middlewares/response-wrapper.js";
import { createAccessLogMiddleware } from "./middlewares/access-log.js";
import { createCsrfMiddleware } from "./csrf.js";
import {
  createConfiguredSessionRuntime,
  isSessionMiddleware,
} from "./session.js";
import { createAuthContextMiddleware } from "./auth.js";
import {
  createSecurityHeadersMiddleware,
  withSecurityHeadersErrorHandler,
  withSecurityHeadersNotFoundHandler,
} from "./security-headers.js";
import { createErrorHandler } from "./middlewares/error-handler.js";
import {
  createRequestHookMiddleware,
  emitNotFoundRequestHooks,
} from "./middlewares/request-hook.js";
import { createVextFetch, type VextFetchConfig } from "./fetch.js";
import { setupShutdown } from "./shutdown.js";
import { RouteMetadataCollector } from "./openapi/collector.js";
import {
  OpenAPIGenerator,
  createDeprecatedRouteDocsTagsWarning,
} from "./openapi/generator.js";
import { generateOpenAPIDocumentWithHooks } from "./openapi/hook-lifecycle.js";
import { registerDocEndpoints } from "./openapi/doc-endpoints.js";
import type { VextServerHandle } from "../types/adapter.js";
import type { VextApp } from "../types/app.js";
import type { VextInternalHooks } from "../types/hooks.js";
import type { VextMiddleware } from "../types/middleware.js";
import { printReadyLog } from "./utils/network.js";
import {
  normalizePortConflictStrategy,
  resolvePortConflict,
} from "./port-conflict.js";
import {
  requestPortConflictDecisionFromParent,
  sendLifecycleLevelToParent,
} from "./ipc-port-conflict.js";
import { quietStartupLogger } from "./startup-logger.js";
import { createStartupProfilerFromEnv } from "./startup-profiler.js";

function getLifecycleLevel(
  config: Record<string, unknown>,
): "concise" | "verbose" {
  const logger = config.logger as Record<string, unknown> | undefined;
  return logger?.lifecycleLevel === "verbose" ? "verbose" : "concise";
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

async function resolveStartupConfig(
  rootDir: string,
  configDir: string,
  command: BootstrapCommand,
  isBuilt: boolean,
  metadata?: LoadConfigMetadata,
): Promise<Record<string, unknown>> {
  const resolvedConfigProfile = resolveConfigProfile({
    env: process.env,
    command,
  });
  const rawConfig = await loadRawConfig(configDir, {
    rootDir,
    command,
    isBuilt,
    mode: getDefaultRuntimeMode(command),
    configProfile: resolvedConfigProfile.profile,
    meta: metadata,
  });

  if (!cluster.isWorker) {
    const strategy = normalizePortConflictStrategy(
      process.env.VEXT_PORT_CONFLICT,
    );
    const resolution = await resolvePortConflict({
      host: rawConfig.host as string | undefined,
      port: rawConfig.port as number,
      strategy,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      requestDecision: (request) =>
        requestPortConflictDecisionFromParent(request),
    });

    if (resolution.changed) {
      rawConfig.port = resolution.port;
      process.env.VEXT_PORT = String(resolution.port);
      console.log(
        `[vextjs] port conflict resolved: using next available port ${resolution.port}`,
      );
    } else if (resolution.action === "kill" && resolution.details?.pid) {
      console.log(
        `[vextjs] port conflict resolved: stopped process ${resolution.details.pid} on ${resolution.port}`,
      );
    }
  }

  return rawConfig;
}

/**
 * bootstrap — 框架完整启动编排（Phase 1）
 *
 * 启动流程（步骤 0 ~ ⑨）：
 *
 *   0. config-loader：加载 default → env → local 三层配置 + deepFreeze
 *   ①  createApp(config)：创建 app + internals（logger / throw / validator / adapter）
 *   ①+ i18n 语言包自动加载：src/locales/ 存在时通过 schemaAdapter.configure 注册
 *   ②  plugin-loader：扫描 src/plugins/，拓扑排序 + setup()（app.use() 可用窗口）
 *   ③  middleware-loader：按 config.middlewares 白名单加载路由级中间件定义
 *   ④  service-loader：扫描 src/services/，实例化注入 app.services
 *   ⑤  router-loader：扫描 src/routes/，注册路由到 adapter
 *   ⑤+ lockUse()：锁定 app.use()，后续调用抛错
 *   ⑥  注册内置中间件（requestId → cors → body-parser → rate-limit → response-wrapper）
 *       + 注册插件全局中间件（app.use() 收集的）
 *       + 注册错误处理 + 404 兜底
 *   ⑦  HTTP 开始监听（adapter.listen）
 *   ⑧  注册信号处理（SIGTERM / SIGINT → shutdown）
 *   ⑨  执行 onReady 钩子 + 打印启动日志
 *
 * 错误边界：
 *   启动过程中任何步骤抛出异常，都会尝试清理已分配的资源：
 *     - 如果 server 已绑定端口 → serverHandle.close()
 *     - 如果 internals 已创建 → internals.shutdown()（执行 onClose hooks）
 *     - 重新抛出错误，由外层 .catch() 处理
 *
 * 注意：内置中间件（requestId / cors / body-parser / rate-limit / response-wrapper）
 * 在步骤⑥通过 adapter.registerMiddleware() 注册，而非 app.use()。
 * 这些中间件在所有路由之前执行（adapter 层保证顺序）。
 * 插件通过 app.use() 注册的全局中间件也在步骤⑥注册到 adapter。
 *
 * @param rootDir 用户项目根目录（包含 src/ 的目录）
 * @returns 启动后的资源句柄（用于测试或 cluster Worker）
 *
 * @see 06-built-ins.md §4（createApp 内部概览 + bootstrap 完整调用顺序）
 * @see 09-cli.md §5（bootstrap.ts 框架内部启动文件）
 * @see IMPLEMENTATION-PLAN.md 任务 1.15
 */
export async function bootstrap(
  rootDir = process.cwd(),
): Promise<BootstrapResult> {
  // 资源引用（用于错误边界清理）
  let internals: AppInternals | null = null;
  let serverHandle: VextServerHandle | null = null;
  let restoreStartupLogger: (() => void) | undefined;
  const startupProfiler = createStartupProfilerFromEnv(process.env);

  try {
    // ── 源码 vs 编译产物目录切换 ──────────────────────────
    //
    // VEXT_BUILT=1 时（vext build 产物存在，vext start 检测到 dist/）：
    //   → 从 dist/ 加载所有模块（编译后的 JS，无需 tsx）
    //
    // 否则（默认）：
    //   → 从 src/ 加载源码（tsx 运行时或 dev 模式）
    //
    // 所有 loader（loadConfig / loadPlugins / loadMiddlewares / loadServices / loadRoutes）
    // 已使用相对路径扫描目录，只需切换根路径即可，loader 代码无需修改。
    //
    const isBuilt = process.env.VEXT_BUILT === "1";
    const srcDir = isBuilt ? join(rootDir, "dist") : join(rootDir, "src");

    // ── 步骤 0: config-loader ─────────────────────────────
    // default → env → local 三层合并 + deepFreeze
    const rawConfig = await startupProfiler.time(
      "start.config.raw",
      () =>
        resolveStartupConfig(rootDir, join(srcDir, "config"), "start", isBuilt),
      { phase: "config" },
    );
    const config = await startupProfiler.time(
      "start.config.finalize",
      () => finalizeConfig(rawConfig),
      { phase: "config" },
    );
    const lifecycleLevel = getLifecycleLevel(rawConfig);
    sendLifecycleLevelToParent(lifecycleLevel);

    // ── 步骤 ①: createApp ─────────────────────────────────
    // 创建 app + internals（logger / throw / validator 已初始化，adapter 延迟解析）
    const result = await startupProfiler.time(
      "start.createApp",
      () => createApp(config),
      { phase: "config" },
    );
    const app = result.app;
    const hooks = app.hooks as VextInternalHooks;
    internals = result.internals;
    const sessionRuntime = createConfiguredSessionRuntime(config.session);
    app.onClose(sessionRuntime.close);
    const corsMiddleware = createCorsMiddleware(config.cors);
    const parentReadyLog = isEnvFlagEnabled(
      process.env.VEXT_START_PARENT_READY_LOG,
    );
    restoreStartupLogger = quietStartupLogger(
      app,
      parentReadyLog &&
        lifecycleLevel !== "verbose" &&
        !isEnvFlagEnabled(process.env.VEXT_START_STARTUP_PROFILE_HUMAN),
    );

    // ── 步骤 ①a: resolveAdapter（异步按需加载）─────────────
    // 动态 import() 按需加载用户选择的 adapter 框架包。
    // 默认 native adapter（零外部依赖），其他 adapter 需用户额外安装对应框架。
    app.adapter = await startupProfiler.time(
      "start.adapter",
      () => resolveAdapter(config, app),
      { phase: "config" },
    );

    app.logger.info("[vextjs] initializing...");

    // ── 步骤 ①+: i18n 语言包自动加载 ─────────────────────
    //
    // 两种模式自动检测：
    //   Mode A（平铺文件）：src/locales/zh-CN.ts → loadI18n() 动态 import + 注册
    //   Mode B（子目录）  ：src/locales/order/zh-CN.js → schema-dsl 递归扫描
    //
    // 优先尝试 Mode A；若未找到平铺语言文件，则回退 Mode B
    // （schema-dsl 的 dsl.config({ i18n: path }) 支持递归子目录扫描）
    //
    await startupProfiler.time(
      "start.i18n",
      async () => {
        const localesDir = join(srcDir, "locales");
        if (existsSync(localesDir)) {
          const loadedLocales = await loadI18n(localesDir, app.logger);
          if (loadedLocales.length > 0) {
            // Mode A: 平铺文件加载成功
            app.logger.info(
              `[vextjs] i18n locales loaded: ${loadedLocales.join(", ")}`,
            );
          } else {
            // Mode B fallback: 检查是否存在子目录（如 order/, user/）
            // 如果有子目录，交给 schema-dsl 的内置递归扫描处理
            try {
              const entries = readdirSync(localesDir, { withFileTypes: true });
              const hasSubDirs = entries.some((e) => e.isDirectory());
              if (hasSubDirs) {
                schemaAdapter.configure({ i18n: localesDir });
                const subDirs = entries
                  .filter((e) => e.isDirectory())
                  .map((e) => e.name);
                app.logger.info(
                  `[vextjs] i18n locales loaded (subdirectory mode): ${subDirs.join(", ")}`,
                );
              }
            } catch (err) {
              app.logger.warn(
                { error: (err as Error).message },
                "[vextjs] Failed to scan locales subdirectories, i18n may not work",
              );
            }
          }
        }
      },
      { phase: "i18n" },
    );

    // ── 步骤 ①++: 内置插件（MonSQLize）条件加载 ──────────
    //
    // 仅当 config.database 存在时才启用 MonSQLize 内置插件。
    // 在用户插件之前执行，确保用户插件可安全依赖完整的原始 app.db。
    // 无 database 配置则跳过 setup，不加载数据库运行时与 hook。
    //
    if (shouldLoadMonSQLize(config as unknown as Record<string, unknown>)) {
      const monsqlizePlugin = createMonSQLizePlugin(srcDir);
      app.logger.debug(
        "[vextjs] built-in plugin: monsqlize (database config detected)",
      );
      const startedAt = performance.now();
      hooks.emitSafeSync("plugin:beforeSetup", {
        plugin: monsqlizePlugin.name,
        sourceFile: "builtin:monsqlize",
        builtin: true,
      });
      internals.enterPluginSetup();
      try {
        await startupProfiler.time(
          "start.builtinPlugin.monsqlize",
          () =>
            monsqlizePlugin.setup(app, {
              signal: new AbortController().signal,
            }),
          { phase: "database", detail: { builtin: true } },
        );
        hooks.emitSafeSync("plugin:afterSetup", {
          plugin: monsqlizePlugin.name,
          sourceFile: "builtin:monsqlize",
          builtin: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        hooks.emitSafeSync("plugin:error", {
          plugin: monsqlizePlugin.name,
          sourceFile: "builtin:monsqlize",
          builtin: true,
          durationMs: Math.round(performance.now() - startedAt),
          error,
        });
        throw error;
      } finally {
        internals.exitPluginSetup();
      }
      app.logger.info("[vextjs] built-in plugin: monsqlize loaded");
    }

    // ── 步骤 ②: plugin-loader ─────────────────────────────
    // 扫描 src/plugins/，拓扑排序（Kahn 算法），依次执行 setup()
    // 此阶段 app.use() 可用，插件可注册全局中间件
    internals.enterPluginSetup();
    try {
      await loadPlugins(app, join(srcDir, "plugins"), { startupProfiler });
    } finally {
      internals.exitPluginSetup();
    }

    // ── 步骤 ③: middleware-loader ─────────────────────────
    // 按 config.middlewares 白名单从 src/middlewares/ 加载路由级中间件定义
    // 返回 MiddlewareRegistry 供 router-loader 解析路由级中间件引用
    const middlewareRegistry = await startupProfiler.time(
      "start.middlewares",
      () =>
        loadMiddlewares(
          join(srcDir, "middlewares"),
          config.middlewares ?? [],
          app.logger,
          config.logger?.lifecycleLevel ?? "concise",
        ),
      { phase: "middleware" },
    );

    // ── 步骤 ④: service-loader ────────────────────────────
    // 扫描 src/services/，实例化（new ServiceClass(app)）注入 app.services
    // 加载完成后执行循环依赖静态检测（正则 + DFS）
    await startupProfiler.time(
      "start.services",
      () => loadServices(app, join(srcDir, "services")),
      { phase: "services" },
    );

    // ── 步骤 ④+: 挂载 app.fetch（在 loadRoutes 之前）─────
    //
    // 🐛 修复 BUG-005：app.fetch 必须在 loadRoutes 之前赋值。
    // 原因：executeRouteFactory 会让 route handler 闭包捕获真实 app。
    // app.fetch 必须在 loadRoutes 前赋值，路由中才能立即访问同一个
    // 运行时 app 实例上的出站 fetch 能力。
    //
    const fetchConfig = config.fetch as VextFetchConfig | undefined;
    const requestIdHeader = config.requestId?.header ?? "x-request-id";
    await startupProfiler.time(
      "start.fetch",
      () => {
        app.fetch = createVextFetch(
          app.logger,
          fetchConfig ?? {},
          requestIdHeader,
          hooks,
        ) as unknown as VextApp["fetch"];
      },
      { phase: "fetch" },
    );

    // ── 步骤 ⑤: router-loader ────────────────────────────
    // 扫描 src/routes/，解析路由级中间件引用，注册到 adapter
    //
    // 🆕 OpenAPI 集成：若 openapi.enabled，创建 collector 传入 loadRoutes，
    // 在每条路由注册到 adapter 时同步收集元信息（method / path / options / sourceFile）。
    const openapiConfig = config.openapi;
    const openapiEnabled =
      openapiConfig?.enabled ?? process.env.NODE_ENV !== "production";
    const frontendRuntimeConfig = resolveFrontendConfig(config.frontend, {
      rootDir,
      mode: "production",
    });
    const frontendSeoRuntimeEnabled = needsFrontendSeoRuntimeEndpoints(
      frontendRuntimeConfig,
    );

    const collector =
      openapiEnabled || frontendSeoRuntimeEnabled
        ? new RouteMetadataCollector()
        : null;

    await startupProfiler.time(
      "start.routes",
      () =>
        loadRoutes(
          app,
          join(srcDir, "routes"),
          {
            middlewareDefs: middlewareRegistry,
            globalMiddlewares: internals!.getGlobalMiddlewares(),
            sessionMiddleware: sessionRuntime.middleware,
            corsMiddleware,
            rootDir,
            frontendMode: "production",
          },
          collector,
        ),
      { phase: "routes" },
    );

    registerFrontendSeoEndpoints(app, frontendRuntimeConfig, {
      existingRoutes: collector?.getRegisteredRoutes() ?? [],
    });

    // ── 步骤 ⑤+: 🆕 OpenAPI 文档生成 ─────────────────────
    //
    // 在所有路由注册完成后、lockUse() 之前生成 OpenAPI 文档。
    // 使用 collector 收集到的路由元信息 + config.openapi 配置，
    // 生成 OpenAPI 3.0 spec 并注册 /docs + /openapi.json 端点。
    //
    const openapiStartedAt = performance.now();
    if (openapiEnabled && collector) {
      const generator = new OpenAPIGenerator(
        {
          title: openapiConfig?.title,
          description: openapiConfig?.description,
          version: openapiConfig?.version,
          servers: (openapiConfig as Record<string, unknown>)?.servers as
            | Array<{ url: string; description?: string }>
            | undefined,
          tags: (openapiConfig as Record<string, unknown>)?.tags as
            | Array<{ name: string; description?: string }>
            | undefined,
          tagGroups: (openapiConfig as Record<string, unknown>)?.tagGroups as
            | Array<{ name: string; tags: string[] }>
            | undefined,
          securitySchemes: (openapiConfig as Record<string, unknown>)
            ?.securitySchemes as Record<
            string,
            {
              type: "http" | "apiKey" | "oauth2" | "openIdConnect";
              scheme?: string;
              bearerFormat?: string;
              description?: string;
            }
          >,
          guardSecurityMap: (openapiConfig as Record<string, unknown>)
            ?.guardSecurityMap as Record<string, string> | undefined,
          contact: (openapiConfig as Record<string, unknown>)?.contact as
            | { name?: string; email?: string; url?: string }
            | undefined,
          license: (openapiConfig as Record<string, unknown>)?.license as
            | { name: string; url?: string }
            | undefined,
        },
        { responseWrap: config.response?.wrap !== false },
      );

      const routes = collector.getRoutes();
      const docsTagsWarning = createDeprecatedRouteDocsTagsWarning(routes);
      if (docsTagsWarning) app.logger.warn(docsTagsWarning);
      const spec = generateOpenAPIDocumentWithHooks(app, generator, routes);

      registerDocEndpoints(app, spec, {
        specPath: openapiConfig?.jsonPath ?? "/openapi.json",
        specPublicPath: (openapiConfig as Record<string, unknown>)
          ?.jsonPublicPath as string | undefined,
        docsPath: openapiConfig?.docsPath ?? "/docs",
        title: openapiConfig?.title,
        docs: openapiConfig?.docs,
        scalar: (openapiConfig as Record<string, unknown>)?.scalar as
          | Record<string, unknown>
          | undefined,
        rootDir,
        srcDir,
        modelsDir: resolveConfiguredModelsDir(config),
      });

      app.logger.info(`[openapi] ${collector.getCount()} route(s) documented`);
    }
    startupProfiler.mark(
      "start.openapi",
      performance.now() - openapiStartedAt,
      { phase: "openapi", detail: { routes: collector?.getCount() ?? 0 } },
    );

    // ── 步骤 ⑤+: 锁定 app.use() ──────────────────────────
    // 路由注册后立即锁定，后续调用 app.use() 将抛出错误
    internals.lockUse();

    // ── 步骤 ⑥: 注册内置中间件（禁用项不进入请求链）────────
    //
    // 注册顺序决定执行顺序：
    //   1. requestId — 生成/透传请求唯一标识
    //   2. authContext — 初始化 req.auth 并同步安全 requestContext 快照
    //   3. requestHook — 请求生命周期 hook
    //   4. securityHeaders — 安全响应头（可选，放在 CORS 前）
    //   5. cors      — 处理跨域预检和响应头
    //   6. body-parser — 解析 JSON / URL-encoded 请求体
    //   7. rate-limit — 速率限制（仅显式启用时）
    //   8. response-wrapper — 开启出口包装标志
    //   9. access-log — 洋葱模型 after-middleware（记录耗时/状态码/路径）
    //
    // 按各中间件合同注册；rate-limit 是 opt-in，仅 enabled === true 时注册。
    // 禁用的中间件完全不进入中间件链，避免额外的请求级调度（之前是
    // 函数仍被调用但 fast-return，每请求仍有函数调用 + await next() 开销）。
    //
    // 这些中间件通过 adapter.registerMiddleware() 注册，
    // 在所有路由（含路由级中间件）之前执行。

    const builtinMiddlewaresStartedAt = performance.now();

    // 1. requestId（config.requestId.enabled，默认 true）
    if (config.requestId?.enabled !== false) {
      const localeConfig = config.locale as
        | import("../types/app.js").VextLocaleConfig
        | undefined;
      const requestIdMiddleware = createRequestIdMiddleware(
        config.requestId,
        () => internals!.getRequestIdGenerator(),
        fetchConfig?.propagateHeaders ?? [],
        localeConfig,
      );
      app.adapter.registerMiddleware(requestIdMiddleware);
    }

    if (config.requestContext?.enabled !== false) {
      app.adapter.registerMiddleware(createAuthContextMiddleware());
    }

    app.adapter.registerMiddleware(createRequestHookMiddleware(hooks));

    if (config.securityHeaders?.enabled === true) {
      app.adapter.registerMiddleware(
        createSecurityHeadersMiddleware(config.securityHeaders),
      );
    }

    // 2. cors（config.cors.enabled，默认 true）
    if (config.cors?.enabled !== false) {
      app.adapter.registerMiddleware(corsMiddleware);
    }

    // 3. body-parser（config.bodyParser.enabled，默认 true）
    if (config.bodyParser?.enabled !== false) {
      const bodyParserMiddleware = createBodyParserMiddleware(
        config.bodyParser,
        config.multipart,
      );
      app.adapter.registerMiddleware(bodyParserMiddleware);
    }

    // 4. rate-limit（默认关闭，仅 enabled=true 时注册）
    if (config.rateLimit?.enabled === true) {
      const rateLimitMiddleware = createRateLimitMiddleware(
        config.rateLimit,
        () => internals!.getRateLimiter(),
      );
      app.adapter.registerMiddleware(rateLimitMiddleware);
    }

    // 5. response-wrapper（config.response.wrap，默认 true）
    //
    // 🔴 修复：之前 responseWrapper 始终注册，用户配置 response.wrap: false 无效。
    // 现在通过 config.response.wrap 控制是否注册，禁用时 res.json() 直接发送
    // 原始数据，不做 { code: 0, data, requestId } 包装。
    //
    if (config.response?.wrap !== false) {
      app.adapter.registerMiddleware(responseWrapper);
    }

    // frontend disabled 时不要注册 noop renderer。否则每个请求都会多一次
    // async middleware / next() 调度，违背此处“禁用即不进入请求链”的约定。
    if (isFrontendEnabled(config.frontend)) {
      app.adapter.registerMiddleware(
        createFrontendRenderMiddleware({
          rootDir,
          mode: "production",
          config: config.frontend,
        }),
      );
    }

    // 6. access-log（config.accessLog.enabled，默认 true）
    if (config.accessLog?.enabled !== false) {
      const accessLogMiddleware = createAccessLogMiddleware(
        config.accessLog ?? {},
        app.logger,
      );
      app.adapter.registerMiddleware(accessLogMiddleware);
    }

    if (config.session?.enabled === true) {
      if (internals.getGlobalMiddlewares().some(isSessionMiddleware)) {
        app.logger.warn(
          "[vextjs] config.session.enabled already auto-registers Session; remove manual app.use(session()) to avoid redundant middleware.",
        );
      }
      app.adapter.registerMiddleware(sessionRuntime.middleware);
    }

    // ── 注册插件全局中间件（app.use() 收集的）─────────────
    // 插件在步骤②中通过 app.use() 注册的全局中间件
    // 在内置中间件之后、路由级中间件之前执行
    for (const mw of internals.getGlobalMiddlewares()) {
      app.adapter.registerMiddleware(mw);
    }

    if (config.csrf?.enabled === true) {
      app.adapter.registerMiddleware(createCsrfMiddleware(config.csrf));
    }

    // ── 注册错误处理 + 404 兜底 ──────────────────────────
    const errorHandler = createErrorHandler(
      config.response ?? {},
      undefined,
      app.logger,
      hooks,
    );
    app.adapter.registerErrorHandler(
      withSecurityHeadersErrorHandler(errorHandler, config.securityHeaders),
    );

    const notFoundHandler = createNotFoundHandler(hooks);
    assertFrontendOutputReady({
      rootDir,
      mode: "production",
      config: config.frontend,
      fallbackHandler: notFoundHandler,
    });
    const frontendNotFoundHandler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: config.frontend,
      fallbackHandler: notFoundHandler,
      onNotFound: async (req) => {
        await emitNotFoundRequestHooks(hooks, req);
      },
    });
    app.adapter.registerNotFound(
      withSecurityHeadersNotFoundHandler(
        frontendNotFoundHandler,
        config.securityHeaders,
      ),
    );
    startupProfiler.mark(
      "start.builtinMiddlewares",
      performance.now() - builtinMiddlewaresStartedAt,
      { phase: "middleware" },
    );

    // ── 步骤 ⑦: HTTP 开始监听 ────────────────────────────
    serverHandle = await startupProfiler.time(
      "start.listen",
      async () => {
        await hooks.emit("server:beforeListen", {
          host: config.host ?? "0.0.0.0",
          port: config.port,
          adapter: app.adapter,
          mode: "production",
          source: isBuilt ? "built-start" : "source-start",
          app,
        });
        return app.adapter.listen(config.port, config.host, {
          server: config.server,
        });
      },
      { phase: "listen" },
    );

    // ── 步骤 ⑧: 注册信号处理 ────────────────────────────
    // 通过 shutdown 模块注册 SIGTERM / SIGINT 信号处理器
    // testMode 下跳过注册，由 createTestApp 控制生命周期
    const shutdownCleanup = setupShutdown({
      internals,
      serverHandle,
      logger: app.logger,
      testMode: config._testMode,
    });
    app.onClose(shutdownCleanup);

    // ── 步骤 ⑧b: 注册致命错误处理 ──────────────────────
    //
    // 捕获 uncaughtException / unhandledRejection，在进程退出前：
    //   1. 记录 fatal 级别日志
    //   2. 调用用户配置的 onFatalError 回调（如有）— 用于通知运维
    //   3. 执行优雅关闭（onClose hooks 清理资源）
    //   4. process.exit(1)
    //
    // testMode 下不注册（避免干扰测试进程）
    //
    if (!config._testMode) {
      const onFatalError = config.shutdown?.onFatalError;
      const FATAL_TIMEOUT_MS = 10_000; // 致命错误处理超时保护

      const handleFatal = async (
        error: Error,
        origin: "uncaughtException" | "unhandledRejection",
      ) => {
        // 记录致命日志
        app.logger.fatal(
          { err: error, origin },
          `[vextjs] ${origin}: ${error.message}`,
        );

        // 调用用户回调（如有），带超时保护
        if (onFatalError) {
          try {
            await Promise.race([
              Promise.resolve(onFatalError(error, origin)),
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  app.logger.warn(
                    "[vextjs] onFatalError callback timed out, forcing exit",
                  );
                  resolve();
                }, FATAL_TIMEOUT_MS),
              ),
            ]);
          } catch (cbErr) {
            app.logger.error(
              { err: cbErr },
              "[vextjs] onFatalError callback threw an error",
            );
          }
        }

        // 执行优雅关闭（清理资源）
        if (internals) {
          try {
            await internals.shutdown(serverHandle ?? undefined, {
              skipExit: true,
            });
          } catch {
            // 静默忽略，避免掩盖原始致命错误
          }
        }

        process.exit(1);
      };

      const onUncaughtException = (error: Error) => {
        void handleFatal(error, "uncaughtException");
      };
      const onUnhandledRejection = (reason: unknown) => {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        void handleFatal(error, "unhandledRejection");
      };

      process.on("uncaughtException", onUncaughtException);
      process.on("unhandledRejection", onUnhandledRejection);
      app.onClose(() => {
        process.removeListener("uncaughtException", onUncaughtException);
        process.removeListener("unhandledRejection", onUnhandledRejection);
      });
    }

    // ── 步骤 ⑨: 执行 onReady 钩子 + 打印启动日志 ─────────
    await startupProfiler.time("start.onReady", () => internals!.runReady(), {
      phase: "onReady",
    });

    restoreStartupLogger?.();
    restoreStartupLogger = undefined;

    if (parentReadyLog && process.send && !cluster.isWorker) {
      process.send({
        type: "ready",
        server: {
          host: serverHandle.host,
          port: serverHandle.port,
        },
        startupProfile: startupProfiler.toJSON(),
        detail: {
          mode: "start",
          cluster: false,
        },
      });
    }

    if (!parentReadyLog) {
      printReadyLog(app.logger, serverHandle.host, serverHandle.port, {
        prefix: "[vextjs]",
      });
    }

    return { app, serverHandle, internals };
  } catch (err) {
    restoreStartupLogger?.();

    // ── 错误边界：清理已分配的资源 ─────────────────────────
    //
    // 启动过程中任何步骤抛出异常时的清理逻辑：
    //   1. 如果 server 已绑定端口 → 先关闭 server（停止接受新连接）
    //   2. 如果 internals 已创建 → 执行 shutdown（onClose hooks 清理 DB/缓存等）
    //   3. 重新抛出原始错误，由外层 .catch() 处理（如 CLI 层的 process.exit(1)）
    //

    // 关闭已监听的 server（如果有）
    if (serverHandle) {
      try {
        await serverHandle.close();
      } catch {
        // 静默忽略 server 关闭错误，避免掩盖原始启动错误
      }
    }

    // 执行 onClose hooks 清理资源（DB 连接、缓存等插件注册的清理逻辑）
    //
    // 🔴 传 skipExit: true — 仅执行资源清理，不调用 process.exit()。
    // 原因：
    //   1. 启动失败时应把原始错误 throw 给外层（CLI / 测试层）处理，
    //      而非被 process.exit(0) 吞掉。
    //   2. process.exit(0) 退出码为 0，掩盖了启动失败的事实。
    //   3. 用户只会看到 "优雅关闭" 日志，无法定位真正的启动错误。
    //
    if (internals) {
      try {
        await internals.shutdown(undefined, { skipExit: true });
      } catch {
        // 静默忽略 shutdown 错误，避免掩盖原始启动错误
      }
    }

    // 重新抛出，让外层处理（CLI 层 / 测试层）
    throw err;
  }
}

function resolveConfiguredModelsDir(config: unknown): string | undefined {
  const database =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>).database
      : undefined;
  if (typeof database !== "object" || database === null) {
    return undefined;
  }
  const models = (database as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null) {
    return undefined;
  }
  const dir = (models as Record<string, unknown>).dir;
  return typeof dir === "string" ? dir : undefined;
}

// ── 返回类型 ────────────────────────────────────────────────

/**
 * bootstrap 返回结果
 *
 * 包含启动后的资源引用，主要用于：
 *   - 测试中关闭服务器（serverHandle.close()）
 *   - 访问 app 实例进行断言
 *   - Cluster Worker 需要 app/internals 引用
 *   - 手动触发 shutdown（如集成测试收尾）
 */
export interface BootstrapResult {
  app: VextApp;
  serverHandle: VextServerHandle;
  internals: AppInternals;
}

// ── 404 兜底处理 ────────────────────────────────────────────

/**
 * 创建 404 兜底处理函数
 *
 * 当没有任何路由匹配时返回标准 404 响应。
 *
 * 注意：
 *   notFound 不经过常规中间件链，requestId 由 adapter 内联生成。
 *   使用 rawJson 发送响应，绕过出口包装（避免 404 被包装为 { code: 0, data: ... }）。
 *
 * @returns VextMiddleware（作为 notFound handler 使用）
 */
function createNotFoundHandler(hooks?: VextInternalHooks): VextMiddleware {
  return async (req, res, _next) => {
    if (hooks) {
      await emitNotFoundRequestHooks(hooks, req);
    }
    res.rawJson(
      {
        code: 404,
        message: "Not Found",
        requestId: req.requestId,
      },
      404,
    );
  };
}

// ── 自执行入口 ──────────────────────────────────────────────
//
// 当此文件作为入口直接被 fork 执行时（CLI 通过 fork(bootstrap.js) 启动），
// 自动执行 bootstrap 并处理错误。
//
// 检测方式：
//   1. CLI fork 时设置 VEXT_MODE 环境变量（'start' 或 'dev'）
//   2. 检查 process.argv[1] 是否是当前文件（直接运行场景）
//
// 如果是被其他模块 import（如测试、cluster Worker），
// 则只导出 bootstrap 函数，不自动执行。
//
// Cluster 分支：
//   当 VEXT_MODE='start' 且检测到 cluster 配置启用时：
//     - cluster.isPrimary → 启动 ClusterMaster（fork Worker 进程）
//     - cluster.isWorker  → 执行 workerMain（调用 bootstrap 完成启动）
//   非 cluster 模式时行为不变（直接调用 bootstrap）。
//

// ── 防重入保护 ──────────────────────────────────────────────
//
// 当 bootstrap.js 被 CLI fork 的子进程直接运行时，模块级代码会检测
// VEXT_MODE 环境变量并自动调用 detectAndStart() → bootstrap()。
//
// 问题：dist/index.cjs（CJS bundle）将 bootstrap.js 的全部代码打包在内，
// 当用户编译后的 CJS 代码（如 plugin）执行 require("vextjs") 时，
// index.cjs 的模块级代码也会执行，再次检测到 VEXT_MODE="start"，
// 触发第二次 detectAndStart() → bootstrap()，导致：
//   - i18n key 冲突（schema-dsl 重复注册）
//   - 插件/服务/路由重复加载
//   - 端口争用（EADDRINUSE）
//
// 修复：使用 globalThis 标志位确保自执行入口只触发一次。
// 第一次进入时设置标志位，后续 require("vextjs") 触发的模块级代码
// 检测到标志位已设置，跳过自动执行。
//
const isDirectRun =
  process.env.VEXT_MODE === "start" || process.env.VEXT_MODE === "dev";

const alreadyStarted =
  (globalThis as Record<string, unknown>).__vext_bootstrap_started === true;

if (isDirectRun && !alreadyStarted) {
  (globalThis as Record<string, unknown>).__vext_bootstrap_started = true;
  // 被 CLI fork 时自动执行
  // rootDir 由 CLI 通过 VEXT_ROOT 环境变量传入，
  // 降级使用 process.cwd()
  const rootDir = process.env.VEXT_ROOT || process.cwd();

  // ── Cluster 模式检测 ──────────────────────────────────
  //
  // Cluster 启用条件（满足其一）：
  //   1. VEXT_CLUSTER=1 环境变量
  //   2. config.cluster.enabled = true（需预加载配置检测）
  //
  // 对于 isWorker 进程，由 Master fork 时已确定是 cluster 模式，
  // 直接进入 workerMain（无需再检测配置）。
  //
  const isClusterEnv = process.env.VEXT_CLUSTER === "1";

  if (cluster.isWorker) {
    // ── Worker 进程 ────────────────────────────────────
    //
    // Worker 是由 ClusterMaster.forkWorker() 通过 cluster.fork() 创建的。
    // 执行 workerMain：内部调用 bootstrap() 完成完整启动流程，
    // 然后注册 IPC 处理器、心跳、指标上报等。
    //
    import("./cluster/worker.js")
      .then(({ workerMain }) => workerMain(rootDir, bootstrap))
      .catch((err) => {
        console.error("[vextjs] worker startup failed:");
        console.error(err);
        process.exit(1);
      });
  } else if (isClusterEnv && cluster.isPrimary) {
    // ── Master 进程（环境变量触发）─────────────────────
    //
    // 通过 VEXT_CLUSTER=1 环境变量触发 cluster 模式。
    // 启动 ClusterMaster，由 Master 负责 fork Worker 进程。
    //
    // Master 不执行 bootstrap（不处理 HTTP 请求），
    // 仅管理 Worker 生命周期。
    //
    startClusterMaster(rootDir).catch((err) => {
      console.error("[vextjs] cluster master startup failed:");
      console.error(err);
      process.exit(1);
    });
  } else if (cluster.isPrimary) {
    // ── 可能需要检测配置中的 cluster.enabled ─────────────
    //
    // 没有 VEXT_CLUSTER 环境变量时，尝试预加载配置检测 cluster.enabled。
    // 这是一个轻量级检测（仅加载配置，不执行完整 bootstrap）。
    //
    detectAndStart(rootDir).catch((err) => {
      console.error("[vextjs] startup failed:");
      console.error(err);
      process.exit(1);
    });
  } else {
    // 非 primary 也非 worker（理论上不会到达）
    bootstrap(rootDir).catch((err) => {
      console.error("[vextjs] startup failed:");
      console.error(err);
      process.exit(1);
    });
  }
}

/**
 * detectAndStart — 检测配置中的 cluster.enabled 并决定启动方式
 *
 * 预加载 config-loader 获取 cluster 配置：
 *   - cluster.enabled = true → 启动 ClusterMaster
 *   - 否则 → 直接执行 bootstrap（单进程模式）
 *
 * @param rootDir 用户项目根目录
 */
async function detectAndStart(rootDir: string): Promise<void> {
  const isBuilt = process.env.VEXT_BUILT === "1";
  ensureStartBuildReady(rootDir, isBuilt);
  const srcDir = isBuilt ? join(rootDir, "dist") : join(rootDir, "src");

  // ── 1. 预加载配置（仅用于检测 cluster.enabled）──────────
  //
  // try/catch 仅包裹 loadConfig，不包裹 bootstrap() / startClusterMaster()。
  // 如果 bootstrap() 运行时出错（如 EADDRINUSE），应直接向上抛出，
  // 由调用方（CLI）捕获并退出，避免在同一进程内二次调用 bootstrap 导致
  // 重复初始化（i18n key 冲突、端口争用等）。
  //
  let clusterEnabled = false;

  try {
    const resolvedConfigProfile = resolveConfigProfile({
      env: process.env,
      command: "start",
    });
    const config = await loadConfig(join(srcDir, "config"), {
      rootDir,
      command: "start",
      isBuilt,
      mode: "production",
      configProfile: resolvedConfigProfile.profile,
    });
    const clusterConfig = config.cluster as { enabled?: boolean } | undefined;
    clusterEnabled = clusterConfig?.enabled === true;
  } catch (err) {
    // 配置加载失败 → 降级为单进程模式（bootstrap 内部会重新加载配置并报错）
    console.warn(
      `[vextjs] config pre-load failed, falling back to single process: ${(err as Error).message}`,
    );
  }

  // ── 2. 根据 cluster 配置决定启动方式 ────────────────────
  //
  // 此处不再被 try/catch 包裹：运行时错误直接向上传播。
  //
  if (clusterEnabled) {
    await startClusterMaster(rootDir);
  } else {
    await bootstrap(rootDir);
  }
}

/**
 * startClusterMaster — 启动 Cluster Master 进程
 *
 * 创建 ClusterMaster 实例并调用 start()。
 * Master 不执行 bootstrap，只负责 fork 和管理 Worker 进程。
 *
 * 配置读取：
 *   从 config-loader 加载配置，提取 cluster 部分传给 ClusterMaster。
 *   同时将 rootDir 和构建标志通过 cluster.setupPrimary() 传递给 Worker。
 *
 * @param rootDir 用户项目根目录
 */
export function applyClusterWorkerEnv(args: {
  rootDir: string;
  workerCount: number;
  providerPatch?: unknown;
  port: number;
  host?: string;
  isBuilt: boolean;
  clusterConfig?: Record<string, unknown>;
}): void {
  process.env.VEXT_ROOT = args.rootDir;
  process.env.VEXT_WORKER_COUNT = String(args.workerCount);
  process.env[CLUSTER_BOOTSTRAP_PATCH_ENV] = JSON.stringify(
    args.providerPatch ?? {},
  );
  process.env.VEXT_PORT = String(args.port);

  if (args.clusterConfig?.memoryThreshold !== undefined) {
    process.env.VEXT_MEMORY_THRESHOLD = String(
      args.clusterConfig.memoryThreshold,
    );
  } else {
    delete process.env.VEXT_MEMORY_THRESHOLD;
  }

  if (args.host) {
    process.env.VEXT_HOST = args.host;
  }
  if (args.isBuilt) {
    process.env.VEXT_BUILT = "1";
  }
}

async function startClusterMaster(rootDir: string): Promise<void> {
  const startupProfiler = createStartupProfilerFromEnv(process.env);
  const isBuilt = process.env.VEXT_BUILT === "1";
  ensureStartBuildReady(rootDir, isBuilt);
  const srcDir = isBuilt ? join(rootDir, "dist") : join(rootDir, "src");

  // 加载配置
  const configMeta: LoadConfigMetadata = {};
  const rawConfig = await startupProfiler.time(
    "start.config.raw",
    () =>
      resolveStartupConfig(
        rootDir,
        join(srcDir, "config"),
        "start",
        isBuilt,
        configMeta,
      ),
    { phase: "config" },
  );
  const config = await startupProfiler.time(
    "start.config.finalize",
    () => finalizeConfig(rawConfig),
    { phase: "config" },
  );
  const clusterConfig = (config.cluster ?? {}) as Record<string, unknown>;

  // 动态导入 ClusterMaster（避免非 cluster 场景加载 node:cluster 相关模块）
  const { ClusterMaster, resolveWorkerCount } =
    await import("./cluster/index.js");

  // 计算 Worker 数量（传给 Worker 进程用于 cluster-checks）
  const workers = (clusterConfig.workers ?? "auto") as
    | "auto"
    | "auto-1"
    | number;
  const workerCount = resolveWorkerCount(workers);

  // 解析实际入口文件（与 cli/start.ts 中 resolveEntryFile 逻辑一致）
  // Worker 进程直接运行 bootstrap.ts/bootstrap.js
  const entryFile = isBuilt
    ? join(rootDir, "node_modules", "vextjs", "dist", "lib", "bootstrap.js")
    : join(rootDir, "node_modules", "vextjs", "dist", "lib", "bootstrap.js");

  // 配置 cluster.setupPrimary — 设置 Worker 进程的执行参数
  const execArgv: string[] = [];

  // ── 注入预加载模块（vext.preload 字段）──────────────
  //
  // 动态导入 resolvePreloads（CLI 工具函数，仅 cluster master 路径需要）。
  // 扫描直接依赖的 vext.preload 字段，将预加载文件以 --import 形式
  // 注入到 Worker 进程的 execArgv，使 Worker 继承预加载能力。
  //
  const { resolvePreloads } = await import("../cli/utils/preload.js");
  const preloads = await resolvePreloads(rootDir);
  for (const fileUrl of preloads) {
    execArgv.push("--import", fileUrl);
  }

  cluster.setupPrimary({
    exec: entryFile,
    execArgv,
  });

  // 设置 Worker 继承的环境变量
  // cluster.fork(env) 会在 forkWorker 中设置，
  // 这里通过 process.env 设置 Worker 继承的全局变量
  applyClusterWorkerEnv({
    rootDir,
    workerCount,
    providerPatch: configMeta.providerPatch,
    port: config.port,
    host: config.host,
    isBuilt,
    clusterConfig,
  });

  // 传递 CLI 覆盖参数（--port / --host）
  // 这些已经在 process.env 中（由 cli/start.ts 设置）

  // 创建并启动 Master
  const master = new ClusterMaster({
    workers,
    autoRestart: (clusterConfig.autoRestart as boolean | undefined) ?? true,
    maxRestarts: (clusterConfig.maxRestarts as number | undefined) ?? 5,
    restartWindow:
      (clusterConfig.restartWindow as number | undefined) ?? 60_000,
    restartBaseDelay:
      (clusterConfig.restartBaseDelay as number | undefined) ?? 1_000,
    restartMaxDelay:
      (clusterConfig.restartMaxDelay as number | undefined) ?? 30_000,
    healthCheck: (clusterConfig.healthCheck ?? {}) as Record<string, unknown>,
    reload: (clusterConfig.reload ?? {}) as Record<string, unknown>,
    pidFile: (clusterConfig.pidFile as string) ?? ".vext.pid",
    titlePrefix: (clusterConfig.titlePrefix as string) ?? "vext",
    sticky: (clusterConfig.sticky as "none" | "ip") ?? "none",
  });

  await startupProfiler.time("start.listen", () => master.start(), {
    phase: "listen",
    detail: { cluster: true, workers: workerCount },
  });

  const readyWorkers = master.getReadyWorkerCount();
  const parentReadyLog = isEnvFlagEnabled(
    process.env.VEXT_START_PARENT_READY_LOG,
  );
  if (parentReadyLog && process.send) {
    process.send({
      type: "ready",
      server: {
        host: config.host ?? "0.0.0.0",
        port: config.port,
      },
      startupProfile: startupProfiler.toJSON(),
      detail: {
        mode: "start",
        cluster: true,
        workers: readyWorkers,
        totalWorkers: master.getTargetWorkerCount(),
      },
    });
  }

  if (!parentReadyLog) {
    printReadyLog(console, config.host ?? "0.0.0.0", config.port, {
      prefix: "[vextjs]",
      suffix: `(workers=${readyWorkers}/${master.getTargetWorkerCount()})`,
    });
  }
}

function isFrontendEnabled(
  frontend:
    | import("../frontend/contract/types.js").VextFrontendUserConfig
    | undefined,
): boolean {
  return (
    frontend === true ||
    (typeof frontend === "object" && frontend.enabled === true)
  );
}

function ensureStartBuildReady(rootDir: string, isBuilt: boolean): void {
  if (isBuilt || !existsSync(join(rootDir, "tsconfig.json"))) {
    return;
  }

  throw new Error(
    "[vextjs] Cannot run TypeScript project with vext start before build. " +
      'Run "vext build" first, or use "vext dev" during development.',
  );
}
