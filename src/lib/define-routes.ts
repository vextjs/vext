import type { VextApp, RouteOptions, RouteRecord } from "../types/app.js";
import type { VextMiddleware, VextHandler } from "../types/middleware.js";
import type { VextAdapter } from "../types/adapter.js";
import type { RouteDefinition, RouteFactory } from "../types/route.js";
import { prepareRouteResponseSerializers } from "./response-serializer.js";

const ROUTE_INTERNALS_SYMBOL = Symbol.for("vext.routeDefinition.internals");

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async function () {});

interface RouteDefinitionInternals {
  factory: RouteFactory;
  collector: Record<string, unknown>;
}

const routeDefinitionInternals = new WeakMap<
  RouteDefinition,
  RouteDefinitionInternals
>();

/**
 * defineRoutes — 路由定义辅助函数
 *
 * 提供路由收集模式：用户在 factory 回调中调用 app.get/post/... 注册路由，
 * 实际并不直接注册到 adapter，而是收集到 routes 数组中。
 * 后续由 router-loader 调用 routeDef.register() 统一注册到底层适配器。
 *
 * 设计说明：
 *   - factory 接收真实 VextApp，保证 handler 闭包中的 app 与 req.app 身份一致
 *   - 执行 factory 时临时把 app.get/post/... 指向 collector，将调用推入 routes 数组
 *   - 返回 RouteDefinition { routes, sourceFile, register }
 *   - register() 负责拼接前缀、组装中间件链、注册到 adapter
 *
 * 执行流程：
 *   1. defineRoutes(factory) 被调用
 *   2. 内部创建 collector（实现 HTTP 方法）
 *   3. router-loader 传入真实 app 执行 factory(app)
 *   4. 临时 HTTP 方法 collector 将每条路由推入 routes 数组
 *   5. 返回 RouteDefinition
 *   6. 稍后 router-loader 调用 routeDef.register(adapter, prefix, ...)
 *
 * @param factory 路由工厂函数，接收真实 app 并在其上注册路由
 * @returns RouteDefinition 对象
 *
 * @example
 * // src/routes/users.ts
 * import { defineRoutes } from 'vextjs'
 *
 * export default defineRoutes((app) => {
 *   app.get('/list', {
 *     validate: { query: { page: 'number:1-', limit: 'number:1-100' } },
 *   }, async (req, res) => {
 *     const { page, limit } = req.valid('query')
 *     const users = await app.services.user.findAll({ page, limit })
 *     res.json(users)
 *   })
 *
 *   app.post('/', {
 *     validate: { body: { name: 'string:1-50', email: 'email' } },
 *   }, async (req, res) => {
 *     const user = await app.services.user.create(req.valid('body'))
 *     res.json(user, 201)
 *   })
 * })
 */
export function defineRoutes<TFactory extends RouteFactory>(
  factory: TFactory &
    (ReturnType<TFactory> extends PromiseLike<unknown> ? never : unknown),
): RouteDefinition {
  if (typeof factory !== "function") {
    throw new Error("[vextjs] defineRoutes(factory) expects a function.");
  }
  assertSynchronousRouteFactory(factory);

  const routes: RouteRecord[] = [];

  // ── 创建路由收集方法 ────────────────────────────────────
  // 支持三段式 (path, options, handler) 和两段式 (path, handler)
  function createMethodCollector(method: string) {
    return (
      path: string,
      optionsOrHandler: RouteOptions | VextHandler,
      handler?: VextHandler,
    ): void => {
      assertRoutePath(method, path);

      if (typeof optionsOrHandler === "function") {
        // 两段式：(path, handler) — 无 options
        routes.push({
          method: method.toUpperCase(),
          path,
          options: {},
          handler: optionsOrHandler,
        });
      } else {
        // 三段式：(path, options, handler)
        if (handler === undefined) {
          throw new Error(
            `[vextjs] ${method.toUpperCase()} "${path}": handler is required when options are provided. ` +
              `Usage: app.${method}(path, options, handler) or app.${method}(path, handler)`,
          );
        }
        assertRouteOptions(method, path, optionsOrHandler);
        assertRouteHandler(method, path, handler);
        routes.push({
          method: method.toUpperCase(),
          path,
          options: optionsOrHandler,
          handler,
        });
      }
    };
  }

  // ── 创建 collector（临时替换 VextApp 的 HTTP 方法）──────
  // collector 只负责把 app.get/post/... 调用收集到 routes 数组。
  // executeRouteFactory 会让 factory 接收真实 app，并仅在收集期间
  // 临时把真实 app 的 HTTP 方法指向这些 collector 方法。
  const collector = {
    get: createMethodCollector("get"),
    post: createMethodCollector("post"),
    put: createMethodCollector("put"),
    patch: createMethodCollector("patch"),
    delete: createMethodCollector("delete"),
    head: createMethodCollector("head"),
    options: createMethodCollector("options"),
  };

  // ── RouteDefinition 对象 ────────────────────────────────

  const routeDefinition: RouteDefinition = {
    routes,
    sourceFile: "", // router-loader 在加载模块后设置此字段

    /**
     * 将收集到的路由注册到底层适配器
     *
     * 由 router-loader 对每个路由文件调用此方法：
     *   1. 拼接完整路径：fullPath = prefix + route.path
     *   2. 解析 middlewares 引用 → VextMiddleware[]
     *   3. 构建 validate 中间件（若有 options.validate）
     *   4. 将 handler 包装为 VextMiddleware（执行链的最后一环）
     *   5. 组装执行链：[...routeMiddlewares, validateMiddleware?, handlerMiddleware]
     *   6. adapter.registerRoute(method, fullPath, chain)
     *
     * 注意：全局中间件由 adapter 内部拼接（registerMiddleware 已收集），
     * 这里只处理路由级链。
     *
     * @param adapter           底层适配器实例
     * @param prefix            文件路径推导出的路由前缀
     * @param middlewareDefs    已加载的中间件定义映射（name → VextMiddleware）
     * @param globalMiddlewares 全局中间件列表（当前未使用，由 adapter 内部处理）
     */
    register(
      adapter: VextAdapter,
      prefix: string,
      middlewareDefs: Map<string, VextMiddleware>,
      _globalMiddlewares: VextMiddleware[],
    ): void {
      for (const route of routes) {
        // ── 1. 拼接完整路径 ──────────────────────────────
        const fullPath = normalizePath(prefix, route.path);
        prepareRouteResponseSerializers(route.options, {
          method: route.method,
          path: fullPath,
          sourceFile: routeDefinition.sourceFile,
        });

        // ── 2. 解析路由级中间件引用 ─────────────────────
        const routeMiddlewares: VextMiddleware[] = [];
        if (route.options.middlewares) {
          for (const ref of route.options.middlewares) {
            const name = typeof ref === "string" ? ref : ref.name;
            const middleware = middlewareDefs.get(name);
            if (!middleware) {
              throw new Error(
                `[vextjs] Route ${route.method} "${fullPath}" references middleware "${name}" ` +
                  `which is not registered in config.middlewares whitelist.\n` +
                  `         Source: ${routeDefinition.sourceFile}\n` +
                  `         Available middlewares: ${[...middlewareDefs.keys()].join(", ") || "(none)"}`,
              );
            }
            routeMiddlewares.push(middleware);
          }
        }

        // ── 3. 构建 validate 中间件（Phase 0 跳过，Phase 1 实现）──
        // 当 route.options.validate 存在时，在 Phase 1 将创建 validate 中间件
        // 并插入到 routeMiddlewares 末尾（handler 之前）

        // ── 4. 将 handler 包装为 VextMiddleware ─────────
        // handler 是执行链的最后一环，不调用 next()
        const handlerMiddleware: VextMiddleware = (req, res, _next) =>
          route.handler(req, res);

        // ── 5. 组装执行链 ──────────────────────────────
        const chain: VextMiddleware[] = [
          ...routeMiddlewares,
          handlerMiddleware,
        ];

        // ── 6. 注册到 adapter ──────────────────────────
        adapter.registerRoute(route.method, fullPath, chain, route.options);
      }
    },
  };

  // ── 存储 factory 引用，供 router-loader 后续调用 ──────────
  // router-loader 会：
  //   1. import 路由文件获取 RouteDefinition
  //   2. 传入真正的 app 引用调用 factory
  //   3. 调用 routeDefinition.register() 注册到 adapter
  //
  // 这里暂时不执行 factory——延迟到 router-loader 传入真实 app 后执行。
  // 内部 factory/collector 存在 WeakMap 和非枚举 Symbol 中，避免污染公共对象形状。
  const internals = {
    factory,
    collector,
  } satisfies RouteDefinitionInternals;

  routeDefinitionInternals.set(routeDefinition, internals);
  Object.defineProperty(routeDefinition, ROUTE_INTERNALS_SYMBOL, {
    value: internals,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return routeDefinition;
}

/**
 * 执行路由收集（由 router-loader 调用）
 *
 * 在真实 app 上临时挂载 HTTP 方法 collector，然后执行 factory 回调。
 * 执行后 routeDefinition.routes 就包含了所有收集到的路由记录。
 *
 * factory 接收到的 app 与请求期 req.app 是同一对象；收集完成后会恢复 app 原有
 * HTTP 方法，避免污染运行期 app 形状。
 *
 * @param routeDefinition defineRoutes 返回的路由定义对象
 * @param app             真正的 VextApp 实例
 */
export function executeRouteFactory(
  routeDefinition: RouteDefinition,
  app: VextApp,
): void {
  const internals = getRouteDefinitionInternals(routeDefinition);

  if (!internals) {
    throw new Error(
      "[vextjs] Invalid route definition. Make sure to use defineRoutes() to create route files.",
    );
  }

  assertSynchronousRouteFactory(internals.factory);

  // 清空 routes 数组，避免重复调用时路由累积
  // （测试场景中 createTestApp 可能多次加载同一路由文件）
  routeDefinition.routes.length = 0;

  const collector = internals.collector;

  // 临时把真实 app 的 HTTP 方法替换为 collector 方法，让 factory 闭包仍捕获
  // 真实 app，同时把注册调用收集到 routeDefinition.routes。
  const httpMethods = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
  ] as const;
  const appRecord = app as unknown as Record<string, unknown>;
  const originals = new Map<
    (typeof httpMethods)[number],
    { hadOwn: boolean; value: unknown }
  >();

  for (const method of httpMethods) {
    originals.set(method, {
      hadOwn: Object.prototype.hasOwnProperty.call(appRecord, method),
      value: appRecord[method],
    });
    appRecord[method] = collector[method];
  }

  try {
    const result = (internals.factory as (factoryApp: VextApp) => unknown)(app);
    if (isPromiseLike(result)) {
      throw synchronousFactoryError();
    }
  } catch (error) {
    // Route collection is transactional: a failed factory must not leave a
    // partial definition that a later reload or test execution could reuse.
    routeDefinition.routes.length = 0;
    throw error;
  } finally {
    for (const method of httpMethods) {
      const original = originals.get(method);
      if (!original) continue;

      if (original.hadOwn) {
        appRecord[method] = original.value;
      } else {
        delete appRecord[method];
      }
    }
  }

  // 保留内部 factory/collector：允许重复调用 executeRouteFactory
  // （测试场景多次 createTestApp、Phase 2 热重载都需要重新执行 factory）
}

function assertSynchronousRouteFactory(factory: RouteFactory): void {
  if (Object.getPrototypeOf(factory) === ASYNC_FUNCTION_PROTOTYPE) {
    throw synchronousFactoryError();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) ||
    typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

function synchronousFactoryError(): Error {
  return new Error(
    "[vextjs] defineRoutes(factory) requires a synchronous factory. " +
      "Async route factories are not supported because routes must be statically projectable.",
  );
}

function getRouteDefinitionInternals(
  routeDefinition: RouteDefinition,
): RouteDefinitionInternals | null {
  const weakMapInternals = routeDefinitionInternals.get(routeDefinition);
  if (weakMapInternals) return weakMapInternals;

  const symbolInternals = (
    routeDefinition as unknown as Record<symbol, unknown>
  )[ROUTE_INTERNALS_SYMBOL];
  if (isRouteDefinitionInternals(symbolInternals)) return symbolInternals;

  const legacy = routeDefinition as RouteDefinition & {
    _factory?: unknown;
    _collector?: unknown;
  };
  if (typeof legacy._factory === "function" && isRecord(legacy._collector)) {
    return {
      factory: legacy._factory as RouteFactory,
      collector: legacy._collector,
    };
  }

  return null;
}

function isRouteDefinitionInternals(
  value: unknown,
): value is RouteDefinitionInternals {
  return (
    isRecord(value) &&
    typeof value.factory === "function" &&
    isRecord(value.collector)
  );
}

function assertRoutePath(
  method: string,
  path: unknown,
): asserts path is string {
  if (typeof path !== "string") {
    throw new Error(
      `[vextjs] ${method.toUpperCase()} route path must be a string.`,
    );
  }
}

function assertRouteOptions(
  method: string,
  path: string,
  options: unknown,
): asserts options is RouteOptions {
  if (!isPlainRecord(options)) {
    throw new Error(
      `[vextjs] ${method.toUpperCase()} "${path}": route options must be a plain object when provided.`,
    );
  }
}

function assertRouteHandler(
  method: string,
  path: string,
  handler: unknown,
): asserts handler is VextHandler {
  if (typeof handler !== "function") {
    throw new Error(
      `[vextjs] ${method.toUpperCase()} "${path}": handler must be a function.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 规范化路由路径
 *
 * 将前缀和子路径拼接为完整路径，处理边界情况：
 *   - 去除重复的 /
 *   - 确保路径以 / 开头
 *   - 去除尾部 /（根路径 / 除外）
 *
 * @param prefix  文件路径推导出的路由前缀（如 /api/users）
 * @param subPath 文件内注册的子路径（如 /list、/:id、/）
 * @returns 规范化后的完整路径
 *
 * @example
 * normalizePath('/users', '/list')   → '/users/list'
 * normalizePath('/users', '/')       → '/users'
 * normalizePath('/users', '/:id')    → '/users/:id'
 * normalizePath('/', '/')            → '/'
 * normalizePath('/api/users', '')    → '/api/users'
 */
function normalizePath(prefix: string, subPath: string): string {
  // 去除前缀尾部 /（根路径 '/' 除外）
  const cleanPrefix =
    prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;

  // 去除子路径的前导 /（避免拼接后出现 //）
  const cleanSubPath = subPath.startsWith("/") ? subPath.slice(1) : subPath;

  // 拼接
  if (!cleanSubPath) {
    // 子路径为空或 '/'，直接使用前缀
    return cleanPrefix || "/";
  }

  // 当 prefix 是根路径 '/' 时，直接拼接为 '/' + subPath，避免 '//health'
  if (cleanPrefix === "/") {
    return `/${cleanSubPath}`;
  }

  const fullPath = `${cleanPrefix}/${cleanSubPath}`;

  // 去除尾部 /（根路径除外）
  if (fullPath.length > 1 && fullPath.endsWith("/")) {
    return fullPath.slice(0, -1);
  }

  return fullPath;
}
