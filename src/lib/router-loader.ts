import { readdir, stat } from "node:fs/promises";
import { join, relative, extname, sep } from "node:path";
import type { VextApp, RouteOptions } from "../types/app.js";
import type { VextHandler, VextMiddleware } from "../types/middleware.js";
import type { RouteDefinition } from "../types/route.js";
import { executeRouteFactory } from "./define-routes.js";
import { buildValidateMiddleware } from "./validate-middleware.js";
import type { MiddlewareRegistry } from "./middleware-loader.js";
import { resolveModuleDefault } from "./interop.js";
import {
  resolveMiddlewares,
  validateMiddlewareRefs,
} from "./middleware-loader.js";
import {
  normalizeCacheOptions,
  buildRouteCacheMiddleware,
} from "./middlewares/route-cache.js";
import { buildFrontendFreshnessMiddleware } from "./middlewares/frontend-freshness.js";
import { buildRouteAuthGuardMiddleware } from "./auth.js";
import { createRouteMultipartMiddleware } from "./middlewares/body-parser.js";
import { createRouteTimeoutMiddleware } from "./middlewares/route-timeout.js";
import { waitForResponseSend } from "./response-hooks.js";
import { prepareRouteResponseSerializers } from "./response-serializer.js";
import type { RouteMetadataCollector } from "./openapi/collector.js";
import { pathToFileURL } from "node:url";
import type { VextInternalHooks, VextRouteHookInfo } from "../types/hooks.js";
import {
  isUnsupportedCommonJsRouteFileName,
  shouldDescendIntoRouteDirectory,
  shouldIncludeRouteFileName,
} from "./route-file-policy.js";
import { compareRoutePriority } from "./route-priority.js";
import {
  createCanonicalRouteIdentity,
  normalizeRegisteredRoutePath,
} from "./route-contract.js";

/**
 * router-loader.ts — 路由自动加载器（Phase 1 升级版）
 *
 * 扫描用户项目的 src/routes/ 目录，自动加载所有路由文件，
 * 提取挂载前缀，依次注册到底层 adapter。
 *
 * Phase 1 升级内容（相对 Phase 0 骨架）：
 *   - 集成 MiddlewareRegistry（替换 Phase 0 的 Map<string, VextMiddleware>）
 *   - 集成 buildValidateMiddleware：为有 validate 配置的路由自动构建校验中间件
 *   - 重复路由检测：同 method + path 不允许重复注册
 *   - validateMiddlewareRefs：所有路由加载后统一验证中间件引用合法性
 *   - 路由级中间件通过 resolveMiddlewares 从 registry 解析（支持工厂参数合并）
 *   - 测试文件检测：routes/ 内不应包含 .test. / .spec. 文件（Fail Fast 警告）
 *
 * 核心流程：
 *   1. 递归扫描 routesDir 下的所有 .ts/.js/.mjs/.cjs 文件
 *   2. 排除 _ 开头的文件/目录、.d.ts 文件
 *   3. 检测 .test./.spec. 文件 → Fail Fast 报错
 *   4. 按文件路径推导路由前缀（[param] → :param、index → 空）
 *   5. 检测前缀冲突
 *   6. 静态段文件排在动态段文件之前（排序）
 *   7. 对每个文件：import → 获取 RouteDefinition → 执行 factory → 收集路由
 *   8. 重复路由检测（同 method + path）
 *   9. 路由级中间件解析（MiddlewareRegistry）+ validate 中间件构建
 *  10. 注册到 adapter
 *  11. 所有路由加载后统一验证中间件引用（validateMiddlewareRefs）
 *
 * Fail Fast 策略：
 *   - 前缀冲突 → 启动时报错
 *   - 文件无 default export → 启动时报错
 *   - routes/ 内存在 .test./.spec. 文件 → 启动时报错
 *   - 重复路由（同 method + path）→ 启动时报错
 *   - 中间件引用不在 registry 中 → 启动时报错
 *
 * @module lib/router-loader
 * @see IMPLEMENTATION-PLAN.md 任务 1.14
 * @see 01d-router-loader.md（router-loader 内部实现详细方案）
 */

// ── 公共类型 ──────────────────────────────────────────────────

/**
 * router-loader 配置选项
 *
 * 由 bootstrap 在调用 loadRoutes 时传入，
 * 包含已加载的中间件注册表和全局中间件列表。
 */
export interface LoadRoutesOptions {
  /**
   * 已加载的路由级中间件注册表
   *
   * Phase 1 升级：从 Map<string, VextMiddleware> 改为 MiddlewareRegistry，
   * 支持工厂中间件参数合并和显式类型检测。
   *
   * 为了向后兼容 Phase 0 bootstrap 中的 `new Map()` 调用，
   * 同时接受 Map<string, VextMiddleware> 类型（空 map 场景）。
   */
  middlewareDefs: MiddlewareRegistry | Map<string, VextMiddleware>;

  /** 全局中间件列表（插件通过 app.use() 注册的） */
  globalMiddlewares: VextMiddleware[];

  /** 应用级 Session Runtime middleware，供全局关闭时的 route opt-in 复用。 */
  sessionMiddleware?: VextMiddleware;

  /** 应用级 CORS middleware，供全局关闭时的 route override 复用。 */
  corsMiddleware?: VextMiddleware;

  /** 开发热重载使用 fresh import 读取更新后的路由模块。 */
  freshImports?: boolean;

  /** Project root used by the persistent frontend freshness store. */
  rootDir?: string;

  /** Runtime mode used to locate the generated frontend build identity. */
  frontendMode?: "development" | "production";
}

function resolveRouteTimeout(
  options?: RouteOptions,
): number | false | undefined {
  return options?.timeout ?? options?.override?.timeout;
}

function isPromise(value: unknown): value is Promise<void> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function createHandlerLifecycleMiddleware(
  handler: VextHandler,
  hooks: VextInternalHooks,
  route: VextRouteHookInfo,
): VextMiddleware {
  return (req, res, _next) => {
    const startedAt = performance.now();
    const emitAfter = (): void | Promise<void> => {
      if (!hooks.has("handler:after")) return;
      return waitForResponseSend(res)
        .then(() =>
          hooks.emitSafe("handler:after", {
            req,
            res,
            route,
            requestId: req.requestId,
            durationMs: Math.round(performance.now() - startedAt),
          }),
        )
        .then(() => undefined);
    };
    const emitError = (error: unknown): void | Promise<void> => {
      if (!hooks.has("handler:error")) throw error;
      return hooks
        .emitSafe("handler:error", {
          req,
          res,
          route,
          error,
          requestId: req.requestId,
        })
        .then(() => {
          throw error;
        });
    };
    const invoke = (): void | Promise<void> => {
      try {
        const result = handler(req, res);
        return isPromise(result)
          ? result.then(() => emitAfter(), emitError)
          : emitAfter();
      } catch (error) {
        return emitError(error);
      }
    };

    if (!hooks.has("handler:before")) {
      return invoke();
    }
    return hooks
      .emit("handler:before", {
        req,
        res,
        route,
        requestId: req.requestId,
      })
      .then(() => invoke());
  };
}

/**
 * loadRoutes — 扫描 routes/ 目录加载路由文件并注册到 adapter
 *
 * @param app       VextApp 实例
 * @param routesDir routes/ 目录的绝对路径（如 /path/to/my-app/src/routes）
 * @param options   加载选项（中间件注册表 + 全局中间件）
 * @param collector 🆕 OpenAPI 路由元信息收集器（可选，未配置 openapi 时为 null）
 *
 * @example
 * ```typescript
 * // bootstrap 内部（Phase 1）
 * await loadRoutes(app, path.join(rootDir, 'src/routes'), {
 *   middlewareDefs: middlewareRegistry,
 *   globalMiddlewares: internals.getGlobalMiddlewares(),
 * }, collector)
 * ```
 */
export async function loadRoutes(
  app: VextApp,
  routesDir: string,
  options: LoadRoutesOptions,
  collector?: RouteMetadataCollector | null,
): Promise<void> {
  const hooks = app.hooks as VextInternalHooks;
  // ── 规范化 middlewareDefs（兼容 Phase 0 的 Map 和 Phase 1 的 Registry）──
  const registry = normalizeMiddlewareDefs(options.middlewareDefs);

  // ── 1. 检查 routes/ 目录是否存在 ──────────────────────────
  const dirExists = await directoryExists(routesDir);
  if (!dirExists) {
    app.logger.warn(
      `[vextjs] Routes directory not found: ${routesDir}. No routes loaded.`,
    );
    return;
  }

  // ── 2. 递归扫描所有路由文件 ────────────────────────────────
  const routeFiles = await scanRouteFiles(routesDir);

  if (routeFiles.length === 0) {
    app.logger.warn(`[vextjs] No route files found in: ${routesDir}`);
    return;
  }

  // ── 3. 按文件路径推导路由前缀 ──────────────────────────────
  const routeEntries: RouteEntry[] = routeFiles.map((filePath) => ({
    filePath,
    prefix: filePathToPrefix(filePath, routesDir),
  }));

  // ── 4. 检测前缀冲突 ──────────────────────────────────────
  detectPrefixConflicts(routeEntries);

  // ── 5. 排序：静态段优先于动态段 ───────────────────────────
  routeEntries.sort(compareRouteEntries);

  // ── 6. 逐个加载、收集、预校验 ─────────────────────────────
  const allRouteDefs: Array<{
    routes: Array<{
      method: string;
      path: string;
      options: { middlewares?: Array<string | { name: string }> };
    }>;
    sourceFile: string;
  }> = [];

  // 重复路由检测：'METHOD /path' → sourceFile
  const registeredRoutes = new Map<string, string>();
  const loadedDefinitions: Array<{
    routeDefinition: RouteDefinition;
    entry: RouteEntry;
  }> = [];

  for (const entry of routeEntries) {
    const routeDefinition = await loadRouteFile(
      entry.filePath,
      app,
      options.freshImports === true,
    );

    if (!routeDefinition) {
      continue;
    }

    // 设置来源文件路径（用于错误信息）
    routeDefinition.sourceFile = entry.filePath;

    // ── 6.1 重复路由检测 ─────────────────────────────────
    for (const route of routeDefinition.routes) {
      const fullPath = normalizeRegisteredRoutePath(entry.prefix, route.path);
      const routeKey = createCanonicalRouteIdentity(route.method, fullPath);
      const existingFile = registeredRoutes.get(routeKey);

      if (existingFile) {
        throw new Error(
          `[vextjs] Duplicate route: ${routeKey}\n` +
            `         Already registered by: ${existingFile}\n` +
            `         Conflict in: ${entry.filePath}\n` +
            `         Rename the route or use a different path/method.`,
        );
      }

      registeredRoutes.set(routeKey, entry.filePath);
    }

    // 收集用于后续统一验证
    allRouteDefs.push({
      routes: routeDefinition.routes.map((r) => ({
        method: r.method,
        path: normalizeRegisteredRoutePath(entry.prefix, r.path),
        options: r.options ?? {},
      })),
      sourceFile: entry.filePath,
    });
    loadedDefinitions.push({ routeDefinition, entry });
  }

  // ── 7. 启动时统一验证所有路由的中间件引用 ─────────────────
  validateMiddlewareRefs(allRouteDefs, registry);

  // ── 8. 先构建完整注册计划，全部成功后才写入 adapter / manifest ─────
  const routeRegistrations = loadedDefinitions.flatMap(
    ({ routeDefinition, entry }) =>
      prepareRouteDefinitionRegistrations(
        routeDefinition,
        app,
        entry.prefix,
        registry,
        options,
      ),
  );
  routeRegistrations.sort((a, b) => {
    const priority = compareRoutePriority(a, b);
    return priority !== 0 ? priority : a.order - b.order;
  });

  for (const registration of routeRegistrations) {
    app.adapter.registerRoute(
      registration.method,
      registration.path,
      registration.chain,
      registration.routeOptions,
    );

    if (collector) {
      collector.addRoute(
        registration.method,
        registration.path,
        registration.routeOptions,
        registration.sourceFile,
        registration.handler,
      );
    }
  }

  app.logger.info(
    `[vextjs] ${routeRegistrations.length} route(s) loaded from ${routeEntries.length} file(s)`,
  );
  await hooks.emitSafe("routes:ready", {
    count: routeRegistrations.length,
    routes: allRouteDefs.flatMap(({ routes, sourceFile }) =>
      routes.map((route) => ({
        method: route.method,
        path: route.path,
        options:
          route.options as unknown as import("../types/app.js").RouteOptions,
        sourceFile,
      })),
    ),
    collector,
  });
}

// ── 路由注册（含中间件解析 + validate 构建）──────────────────

/**
 * registerRouteDefinition — 将一个 RouteDefinition 的所有路由注册到 adapter
 *
 * 对每条路由：
 *   1. 拼接完整路径：fullPath = prefix + route.path
 *   2. 从 MiddlewareRegistry 解析路由级中间件引用 → VextMiddleware[]
 *   3. 构建 validate 中间件（若有 options.validate）
 *   4. 将 handler 包装为 VextMiddleware（执行链的最后一环）
 *   5. 组装执行链：[...routeMiddlewares, validateMiddleware?, handlerMiddleware]
 *   6. adapter.registerRoute(method, fullPath, chain)
 *
 * 注意：全局中间件由 adapter 内部拼接（registerMiddleware 已收集），
 * 这里只处理路由级链。
 *
 * @param routeDef          RouteDefinition 对象
 * @param app               VextApp 实例
 * @param prefix            文件路径推导出的路由前缀
 * @param registry          已加载的中间件注册表
 * @param _globalMiddlewares 全局中间件列表（当前由 adapter 内部处理，预留参数）
 */
function prepareRouteDefinitionRegistrations(
  routeDef: RouteDefinition,
  app: VextApp,
  prefix: string,
  registry: MiddlewareRegistry,
  options: LoadRoutesOptions,
): PreparedRouteRegistration[] {
  const hooks = app.hooks as VextInternalHooks;
  const registrations: PreparedRouteRegistration[] = [];

  for (const [index, route] of routeDef.routes.entries()) {
    // ── 1. 拼接完整路径 ──────────────────────────────────
    const fullPath = normalizeRegisteredRoutePath(prefix, route.path);
    const routeOptions = route.options ?? {};
    prepareRouteResponseSerializers(routeOptions, {
      method: route.method,
      path: fullPath,
      sourceFile: routeDef.sourceFile,
    });
    const routeInfo: VextRouteHookInfo = {
      method: route.method.toUpperCase(),
      path: fullPath,
      options: routeOptions,
      sourceFile: routeDef.sourceFile,
    };

    // ── 2. 解析路由级中间件引用 ─────────────────────────
    const routeMiddlewares: VextMiddleware[] = [];

    if (route.options?.middlewares && route.options.middlewares.length > 0) {
      const resolved = resolveMiddlewares(
        route.options.middlewares as Array<
          string | { name: string; options?: Record<string, unknown> }
        >,
        registry,
      );
      routeMiddlewares.push(...resolved);
    }

    // ── 2.5 auth guard + auth/cache 安全警告 ─────────────
    const authGuard = buildRouteAuthGuardMiddleware(route.options?.auth);
    if (authGuard) {
      routeMiddlewares.push(authGuard);
    }

    if (route.options?.cache) {
      const hasRouteAuth =
        route.options.auth !== undefined && route.options.auth !== false;
      const hasLegacyAuth = Boolean(
        route.options.middlewares?.some((m) =>
          (typeof m === "string" ? m : m.name).toLowerCase().includes("auth"),
        ),
      );
      const cacheOpts = normalizeCacheOptions(
        route.options.cache,
        app.config.cache?.defaultTtl,
      );
      if (
        (hasRouteAuth || hasLegacyAuth) &&
        cacheOpts &&
        !cacheOpts.partitionKey &&
        !cacheOpts.allowAuthorizationCache
      ) {
        app.logger.warn(
          `[vextjs] ⚠️ Route ${route.method} "${fullPath}" has both cache and auth middleware. ` +
            `Authorization requests bypass response cache unless partitionKey or allowAuthorizationCache is configured. ` +
            `Prefer partitionKey for user or tenant isolation.`,
        );
      }
    }

    // ── 2.6 构建路由级响应缓存中间件 ──────────────────────
    if (app.config.cache?.enabled !== false) {
      const cacheOpts = normalizeCacheOptions(
        route.options?.cache,
        app.config.cache?.defaultTtl,
      );
      const cacheMiddleware = buildRouteCacheMiddleware(
        cacheOpts,
        () => app.cache._getResponseCache(),
        hooks,
      );
      if (cacheMiddleware) {
        routeMiddlewares.push(cacheMiddleware);
      }
    }

    // ── 2.65 frontend route freshness ──────────────────────
    // This consumes the existing RouteOptions.frontend declaration after
    // route-auth/session middleware and after generic response-cache policy.
    // It owns only public page render payloads; non-render responses fall
    // through unchanged.
    const frontendFreshnessMiddleware = buildFrontendFreshnessMiddleware(
      route.options,
      {
        rootDir: options.rootDir ?? process.cwd(),
        config: app.config.frontend,
        mode:
          options.frontendMode ??
          (process.env.NODE_ENV === "production"
            ? "production"
            : "development"),
      },
    );
    if (frontendFreshnessMiddleware) {
      routeMiddlewares.push(frontendFreshnessMiddleware);
    }

    // ── 2.7 路由级 multipart 解析中间件 ──────────────────
    //
    // 当路由声明 multipart.enabled = true 时，自动注入路由级解析中间件。
    // 插入到用户中间件链之前（第一个执行），确保 req.files 对所有后续中间件可见。
    // 行为：
    //   - 若全局 body-parser 已解析（req.files 不为 undefined）：只做路由级二次校验
    //   - 若全局未解析：用合并配置（路由级覆盖全局默认值）解析 multipart
    //
    if (
      (route.options as { multipart?: { enabled?: boolean } })?.multipart
        ?.enabled === true
    ) {
      const routeMultipartMW = createRouteMultipartMiddleware(
        route.options
          .multipart as import("../types/app.js").MultipartRouteConfig,
        app.config.multipart,
        app.config.bodyParser,
      );
      routeMiddlewares.unshift(routeMultipartMW);
    }

    const builtinRouteMiddlewares: VextMiddleware[] = [];
    const routeTimeout = resolveRouteTimeout(route.options);
    if (routeTimeout !== undefined && routeTimeout !== false) {
      builtinRouteMiddlewares.push(createRouteTimeoutMiddleware(routeTimeout));
    }

    const routeCors = route.options?.override?.cors;
    if (
      app.config.cors?.enabled === false &&
      routeCors?.enabled !== false &&
      options.corsMiddleware
    ) {
      builtinRouteMiddlewares.push(options.corsMiddleware);
    }

    const routeSession = route.options?.session;
    if (
      app.config.session?.enabled !== true &&
      routeSession !== undefined &&
      routeSession !== false &&
      (routeSession === true || routeSession.enabled !== false) &&
      options.sessionMiddleware
    ) {
      builtinRouteMiddlewares.push(options.sessionMiddleware);
    }

    if (builtinRouteMiddlewares.length > 0) {
      routeMiddlewares.unshift(...builtinRouteMiddlewares);
    }

    // ── 3. 构建 validate 中间件（Phase 1 升级）──────────
    //
    // 当 route.options.validate 存在时，通过 buildValidateMiddleware()
    // 在启动时预编译 schema，生成校验中间件。
    // 校验中间件插入到路由级中间件之后、handler 之前。
    //
    const validateMiddleware = buildValidateMiddleware(
      route.options?.validate as
        | import("./validate-middleware.js").ValidateConfig
        | undefined,
      () => app.getValidator(),
      hooks,
      routeInfo,
    );

    // ── 4. 将 handler 包装为 VextMiddleware ─────────────
    // handler 是执行链的最后一环，不调用 next()
    const handlerMiddleware = createHandlerLifecycleMiddleware(
      route.handler,
      hooks,
      routeInfo,
    );

    // ── 5. 组装执行链 ──────────────────────────────────
    const routeMatchedMiddleware: VextMiddleware = (req, _res, next) => {
      if (!hooks.has("route:matched")) {
        return next();
      }
      return hooks
        .emit("route:matched", {
          req,
          route: routeInfo,
          params: req.params,
          requestId: req.requestId,
        })
        .then(() => next());
    };

    const chain: VextMiddleware[] = [
      routeMatchedMiddleware,
      ...routeMiddlewares,
    ];

    if (validateMiddleware) {
      chain.push(validateMiddleware);
    }

    chain.push(handlerMiddleware);

    registrations.push({
      method: route.method,
      path: fullPath,
      chain,
      routeOptions,
      sourceFile: routeDef.sourceFile,
      handler: route.handler,
      order: index,
    });
  }

  return registrations;
}

// ── 内部类型 ──────────────────────────────────────────────────

interface RouteEntry {
  filePath: string;
  prefix: string;
}

interface PreparedRouteRegistration {
  method: string;
  path: string;
  chain: VextMiddleware[];
  routeOptions: RouteOptions;
  sourceFile: string;
  handler: import("../types/middleware.js").VextHandler;
  order: number;
}

// ── 文件扫描 ──────────────────────────────────────────────────

/**
 * 递归扫描 routes/ 目录下的所有路由文件
 *
 * @param dir 当前扫描的目录路径
 * @returns 所有路由文件的绝对路径数组
 */
async function scanRouteFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldDescendIntoRouteDirectory(entry.name)) continue;

      // 递归扫描子目录
      const subFiles = await scanRouteFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      if (isUnsupportedCommonJsRouteFileName(entry.name)) {
        throw new Error(
          `[vextjs] CommonJS route source is not supported in Vext 2: ${fullPath}. Rename it to .js/.mjs in an ESM project or convert it to TypeScript.`,
        );
      }
      if (!shouldIncludeRouteFileName(entry.name)) continue;

      files.push(fullPath);
    }
  }

  return files;
}

// ── 路径映射 ──────────────────────────────────────────────────

/**
 * 文件路径 → 路由前缀转换
 *
 * 转换规则：
 *   1. 取相对路径（去掉 routesDir 前缀）
 *   2. 统一路径分隔符为 /
 *   3. 去掉扩展名
 *   4. index → 空字符串（使用上级目录路径）
 *   5. [param] 段 → :param（动态段转换）
 *   6. 确保以 / 开头
 *
 * @param filePath  路由文件的绝对路径
 * @param routesDir routes/ 目录的绝对路径
 * @returns 路由前缀（如 /users、/api/users、/users/:id）
 *
 * @example
 * filePathToPrefix('/app/src/routes/users.ts', '/app/src/routes')
 * // → '/users'
 *
 * filePathToPrefix('/app/src/routes/api/index.ts', '/app/src/routes')
 * // → '/api'
 *
 * filePathToPrefix('/app/src/routes/users/[id].ts', '/app/src/routes')
 * // → '/users/:id'
 */
function filePathToPrefix(filePath: string, routesDir: string): string {
  // 1. 取相对路径
  let rel = relative(routesDir, filePath);

  // 2. 统一路径分隔符为 /（Windows 兼容）
  rel = rel.split(sep).join("/");

  // 3. 去掉扩展名
  const ext = extname(rel);
  rel = rel.slice(0, -ext.length);

  // 4. 处理 index（去除末尾的 /index）
  if (rel === "index") {
    rel = "";
  } else if (rel.endsWith("/index")) {
    rel = rel.slice(0, -"/index".length);
  }

  // 5. 动态段转换：[param] → :param
  rel = rel.replace(/\[([^\]]+)\]/g, ":$1");

  // 6. 确保以 / 开头
  if (!rel.startsWith("/")) {
    rel = `/${rel}`;
  }

  // 去除尾部 /（根路径 / 除外）
  if (rel.length > 1 && rel.endsWith("/")) {
    rel = rel.slice(0, -1);
  }

  return rel;
}

// ── 前缀冲突检测 ────────────────────────────────────────────

/**
 * 检测前缀冲突
 *
 * 两个不同的文件映射到相同的路由前缀时 Fail Fast 报错。
 * 典型冲突：routes/users.ts 和 routes/users/index.ts（两者前缀均为 /users）。
 *
 * @param entries 所有路由条目
 * @throws 存在前缀冲突时抛出错误
 */
function detectPrefixConflicts(entries: RouteEntry[]): void {
  const prefixMap = new Map<string, string>();

  for (const entry of entries) {
    const prefixIdentity = entry.prefix.toLocaleLowerCase("en-US");
    const existing = prefixMap.get(prefixIdentity);
    if (existing) {
      throw new Error(
        `[vextjs] Route prefix conflict detected:\n` +
          `         Prefix: "${entry.prefix}"\n` +
          `         File 1: ${existing}\n` +
          `         File 2: ${entry.filePath}\n` +
          `         Two route files cannot map to the same prefix. ` +
          `Consider merging them into a single file or reorganizing the directory structure.`,
      );
    }
    prefixMap.set(prefixIdentity, entry.filePath);
  }
}

// ── 排序 ────────────────────────────────────────────────────

/**
 * 路由条目排序比较函数
 *
 * 规则：静态段优先于动态段
 *   - 不含 : 的路径排在前面
 *   - 同类型按字母序排列
 *
 * 这确保了 /users/profile 在 /users/:id 之前注册，
 * 防止动态段路由拦截静态路径。
 *
 * @param a 路由条目 A
 * @param b 路由条目 B
 * @returns 排序值（负数 = a 在前，正数 = b 在前）
 */
function compareRouteEntries(a: RouteEntry, b: RouteEntry): number {
  const aIsDynamic = a.prefix.includes(":");
  const bIsDynamic = b.prefix.includes(":");

  // 静态路由优先
  if (!aIsDynamic && bIsDynamic) return -1;
  if (aIsDynamic && !bIsDynamic) return 1;

  // 同类型按字母序
  return a.prefix.localeCompare(b.prefix);
}

// ── 文件加载 ────────────────────────────────────────────────

/**
 * 加载单个路由文件
 *
 * 通过 dynamic import 加载路由模块，获取其 default export。
 * default export 必须是 defineRoutes() 返回的 RouteDefinition 对象。
 *
 * Fail Fast：
 *   - 无 default export → 报错
 *   - default export 不是有效的 RouteDefinition → 报错
 *
 * @param filePath 路由文件的绝对路径
 * @param app      VextApp 实例
 * @returns RouteDefinition 对象，加载失败时返回 null
 */
async function loadRouteFile(
  filePath: string,
  app: VextApp,
  freshImport = false,
): Promise<RouteDefinition | null> {
  try {
    // 将 Windows 路径转换为 file:// URL（dynamic import 兼容性）
    // 普通启动与测试使用稳定 URL，避免重复加载大量临时路由时堆积 ESM module cache；
    // 开发热重载由调用方显式开启 fresh import，确保读取最新编译产物。
    const fileUrl = freshImport
      ? `${pathToFileUrl(filePath)}?t=${Date.now()}`
      : pathToFileUrl(filePath);
    const mod = await import(fileUrl);

    const routeDefinition = resolveModuleDefault<RouteDefinition>(mod);

    if (!routeDefinition) {
      throw new Error(
        `[vextjs] Route file "${filePath}" has no default export.\n` +
          `         Route files must use: export default defineRoutes((app) => { ... })`,
      );
    }

    // 验证是否为有效的 RouteDefinition（至少有 routes 数组和 register 方法）
    if (
      !Array.isArray(routeDefinition.routes) ||
      typeof routeDefinition.register !== "function"
    ) {
      throw new Error(
        `[vextjs] Route file "${filePath}" default export is not a valid RouteDefinition.\n` +
          `         Make sure to use defineRoutes() to create the route definition.`,
      );
    }

    // 执行 factory 回调（传入真正的 app 引用，收集路由）
    executeRouteFactory(routeDefinition, app);

    return routeDefinition;
  } catch (err) {
    // 如果是我们自己抛出的 vextjs 错误，直接抛出（Fail Fast）
    if (err instanceof Error && err.message.startsWith("[vextjs]")) {
      throw err;
    }

    // 其他错误（如语法错误、模块找不到），包装后抛出
    throw new Error(
      `[vextjs] Failed to load route file: ${filePath}\n` +
        `         ${(err as Error).message}`,
    );
  }
}

// ── MiddlewareRegistry 兼容层 ────────────────────────────────

/**
 * normalizeMiddlewareDefs — 将 Phase 0 的 Map 或 Phase 1 的 Registry 统一为 MiddlewareRegistry
 *
 * Phase 0 bootstrap 传入 `new Map()` → 转换为空 MiddlewareRegistry
 * Phase 1 bootstrap 传入 MiddlewareRegistry → 直接使用
 *
 * @param defs 中间件定义（Map 或 Registry）
 * @returns MiddlewareRegistry
 */
function normalizeMiddlewareDefs(
  defs: MiddlewareRegistry | Map<string, VextMiddleware>,
): MiddlewareRegistry {
  // 如果是 Map 类型（Phase 0 兼容），转换为 Registry 格式
  if (defs instanceof Map) {
    const registry = Object.create(null) as MiddlewareRegistry;
    for (const [name, handler] of defs.entries()) {
      registry[name] = {
        handler,
        defaultOptions: undefined,
        kind: "middleware",
      };
    }
    return registry;
  }

  // 已经是 MiddlewareRegistry 对象
  return defs;
}

// ── 工具函数 ────────────────────────────────────────────────

/**
 * 检查目录是否存在
 *
 * @param dirPath 目录路径
 * @returns 目录是否存在
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 将文件系统路径转为 file:// URL
 *
 * dynamic import 在 Windows 上需要 file:// 协议前缀才能正确加载。
 * Unix 系统上也兼容 file:// URL。
 *
 * @param filePath 文件的绝对路径
 * @returns file:// URL 字符串
 */
function pathToFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
