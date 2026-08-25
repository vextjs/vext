import {
  createLogger,
  getLoggerLifecycle,
  normalizeVextLogger,
} from "./logger.js";
import { createDefaultThrow } from "./default-throw.js";
import { createHookManager } from "./hooks.js";
import { schemaAdapter } from "./schema-adapter.js";
import type { DslDefinition } from "./schema-adapter.js";
import type { VextAdapter } from "../types/adapter.js";
import type {
  VextApp,
  VextConfig,
  VextServices,
  VextValidator,
  VextRateLimiter,
  VextRuntimeLogger,
  VextLoggerLike,
} from "../types/app.js";
import type { VextFetch } from "./fetch.js";
import type { VextMiddleware } from "../types/middleware.js";
import type { VextServerHandle } from "../types/adapter.js";
import { createResponseCache } from "response-cache-kit";
import { resolveVextResponseCacheOptions } from "./response-cache-config.js";
import type { VextRuntimeMode } from "../types/hooks.js";

function resolveLifecycleMode(config: VextConfig): VextRuntimeMode {
  const internalMode = (config as { _runtimeMode?: VextRuntimeMode })
    ._runtimeMode;
  if (internalMode) return internalMode;
  return config._testMode ? "test" : "production";
}

function resolveLifecycleSource(mode: VextRuntimeMode): string {
  if (mode === "development") return "dev-worker";
  if (mode === "test") return "test-app";
  return "bootstrap";
}

/**
 * 框架内部方法接口（不暴露给用户，仅 bootstrap 使用）
 *
 * 通过 createApp() 返回的 { app, internals } 中的 internals 访问。
 * 这些方法控制框架生命周期的关键节点，用户代码不应直接调用。
 */
export interface AppInternals {
  /**
   * 锁定 app.use()
   *
   * 在步骤⑤ router-loader 完成后由 bootstrap 显式调用。
   * 锁定后再调用 app.use() 将抛出错误，
   * 确保路由注册后不会有新的全局中间件插入导致行为不一致。
   */
  lockUse(): void;

  /**
   * 标记插件 setup 执行窗口。
   *
   * app.use() 只允许在该窗口内调用；bootstrap、dev-bootstrap 和
   * createTestApp 在执行用户/内置插件 setup 时进入此窗口。
   */
  enterPluginSetup(): void;

  /**
   * 结束插件 setup 执行窗口。
   */
  exitPluginSetup(): void;

  /**
   * 执行所有 onReady 钩子
   *
   * 在步骤⑧ HTTP 监听后由 bootstrap 调用。
   * 执行完毕后清空 hooks 数组，释放闭包引用。
   */
  runReady(): Promise<void>;

  /**
   * 获取全局中间件列表
   *
   * router-loader 组装路由链时使用，
   * 将全局中间件拼接在路由级中间件之前。
   */
  getGlobalMiddlewares(): VextMiddleware[];

  /**
   * 优雅关闭
   *
   * 流程：
   *   1. 停止接受新请求（serverHandle.close()）
   *   2. 等待飞行中请求完成（config.shutdown.timeout 超时保护）
   *   3. 按 LIFO 顺序执行所有 onClose 钩子
   *   4. process.exit(0)（测试模式 或 skipExit 时跳过）
   *
   * @param serverHandle VextServerHandle（可选，由 bootstrap 传入）
   * @param options.skipExit 为 true 时跳过 process.exit()，仅执行资源清理。
   *        用于 bootstrap catch 块中：启动失败时需要清理资源，
   *        但不应 process.exit(0)（否则会吞掉启动错误 + 返回错误的退出码）。
   */
  shutdown(
    serverHandle?: VextServerHandle,
    options?: { skipExit?: boolean },
  ): Promise<void>;

  /**
   * 获取用户自定义速率限制器（如果通过 app.setRateLimiter() 设置）
   *
   * bootstrap 将此 getter 传递给 createRateLimitMiddleware 工厂，
   * 使中间件在运行时动态读取最新的 limiter 实例。
   */
  getRateLimiter(): VextRateLimiter | null;

  /**
   * 获取用户自定义 requestId 生成器（如果通过 app.setRequestIdGenerator() 设置）
   *
   * bootstrap 将此 getter 传递给 createRequestIdMiddleware 工厂，
   * 使中间件在运行时动态读取最新的生成器。
   */
  getRequestIdGenerator(): (() => string) | null;
}

export interface AppMutationTransaction {
  commit(): void;
  rollback(): void;
}

const appMutationTransactionFactories = new WeakMap<
  VextApp,
  () => AppMutationTransaction
>();

/**
 * Captures the framework-owned mutable app state used during plugin setup.
 * The fallback descriptor snapshot keeps direct loadPlugins() consumers safe;
 * createApp() instances additionally restore closure-backed registries.
 */
export function beginAppMutationTransaction(
  app: VextApp,
): AppMutationTransaction {
  return (
    appMutationTransactionFactories.get(app)?.() ??
    createDescriptorMutationTransaction(app)
  );
}

/**
 * createApp — 框架应用工厂函数
 *
 * 创建 VextApp 实例和框架内部方法集合。
 * 是整个 vext 框架的核心入口点。
 *
 * 返回 { app, internals }：
 *   - app: 用户可见的应用实例（VextApp 接口）
 *   - internals: 框架内部方法（仅 bootstrap 使用）
 *
 * 初始化流程：
 *   1. 创建 app 对象，挂载 logger / throw / config / services 等内置模块
 *   2. 通过 resolveAdapter 解析 config.adapter 创建底层适配器实例
 *   3. 返回 { app, internals }
 *
 * 后续由 bootstrap 编排完整的启动流程（plugin → middleware → service → route → listen）。
 *
 * Phase 1 升级说明（相对 Phase 0）：
 *   - logger: Phase 0 的 console 封装 → 内置结构化 logger，支持 pretty/JSON 双模式 + requestId 自动注入
 *   - throw:  Phase 0 的内联简化实现 → createDefaultThrow()，通过 schema-adapter 防腐层联动 I18nError
 *   - validator: Phase 0 的 pass-through → schema-adapter 封装的 compile + validate
 *
 * @param config 框架运行时配置（已经过 config-loader 三层合并 + deepFreeze）
 * @returns { app, internals }
 */
export function createApp(config: VextConfig): {
  app: VextApp;
  internals: AppInternals;
} {
  assertCreateAppConfig(config);
  const lifecycleMode = resolveLifecycleMode(config);
  const lifecycleSource = resolveLifecycleSource(lifecycleMode);

  const closeHooks: Array<() => Promise<void> | void> = [];
  const readyHooks: Array<() => Promise<void> | void> = [];
  const globalMiddlewares: VextMiddleware[] = [];

  let _validator: VextValidator = createSchemaAdapterValidator();
  let _rateLimiter: VextRateLimiter | null = null;
  let _requestIdGenerator: (() => string) | null = null;
  let _locked = false; // 路由注册完成后锁定（步骤⑤之后），禁止 app.use()
  let _pluginSetupDepth = 0;
  let _readyState: "pending" | "running" | "completed" = "pending";
  let _readyPromise: Promise<void> | null = null;
  let _closeState: "open" | "running" | "closed" = "open";
  let _shutdownPromise: Promise<void> | null = null;

  // ── 创建 logger（内置结构化 logger，Phase 1 升级）────────────
  //
  // 替换 Phase 0 的 createSimpleLogger（console 封装）。
  // 内置 logger 提供：
  //   - 结构化 JSON 日志（生产环境）
  //   - pretty 可读输出（开发环境）
  //   - mixin 自动注入 requestId（从 AsyncLocalStorage 读取）
  //   - child logger（携带 service 名称等额外字段）
  //
  const logger = createLogger(config.logger, {
    requestContextEnabled: config.requestContext?.enabled !== false,
  });
  const loggerLifecycle = getLoggerLifecycle(logger);

  // ── 创建 defaultThrow（I18nError 联动，Phase 1 升级）────────
  //
  // 替换 Phase 0 的内联简化实现。
  // 通过 schema-adapter 防腐层访问 schema-dsl I18nError：
  //   - message 作为 i18n key 查找已注册的语言包
  //   - 从 requestContext（AsyncLocalStorage）获取请求级 locale（并发安全）
  //   - 翻译后的 message + 业务码 封装为 HttpError 抛出
  //
  const defaultThrow = createDefaultThrow();

  // ── 创建响应缓存核心（response-cache-kit）────────────────
  //
  // 在 createApp 阶段初始化（与 app.logger / app.throw 同模式），
  // config 在 createApp 参数中已可用，无需等到 bootstrap 阶段。
  //
  const responseCache = createResponseCache({
    ...resolveVextResponseCacheOptions(config.cache),
  });
  const hooks = createHookManager(logger);

  // ── 创建 app 对象 ──────────────────────────────────────────

  const app: VextApp = {
    // ── 内置模块（插件可覆盖）──────────────────────────────
    logger,
    throw: defaultThrow,

    // ── 运行时数据（不可覆盖）─────────────────────────────
    config,
    services: {} as VextServices,
    hooks,
    adapter: null as unknown as VextAdapter, // 稍后由 resolveAdapter 赋值

    // ── HTTP 方法占位（defineRoutes 的 collector 才真正使用）──
    // 这些方法在 app 上定义为占位，实际路由注册通过 defineRoutes 的 collector 完成。
    // 直接在 app 上调用会抛出错误，提示用户使用 defineRoutes。
    get: createRouteMethodPlaceholder("GET"),
    post: createRouteMethodPlaceholder("POST"),
    put: createRouteMethodPlaceholder("PUT"),
    patch: createRouteMethodPlaceholder("PATCH"),
    delete: createRouteMethodPlaceholder("DELETE"),
    head: createRouteMethodPlaceholder("HEAD"),
    options: createRouteMethodPlaceholder("OPTIONS"),

    // ── 框架扩展 API ──────────────────────────────────────
    extend<K extends string, V>(key: K, value: V) {
      assertExtensionKey(key, app);
      if (Object.hasOwn(app, key)) {
        throw new Error(
          `[vextjs] app.extend("${key}") cannot override an existing app property. ` +
            "Use a different extension name.",
        );
      }
      Object.defineProperty(app, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    },

    setValidator(v: VextValidator) {
      assertValidator(v);
      _validator = v;
    },

    getValidator() {
      return _validator;
    },

    setThrow(wrapper: (original: VextApp["throw"]) => VextApp["throw"]) {
      assertFunction(wrapper, "app.setThrow() wrapper");
      const nextThrow = wrapper(app.throw.bind(app));
      assertFunction(nextThrow, "app.setThrow() wrapper result");
      app.throw = nextThrow as VextApp["throw"];
    },

    setLogger(wrapper: (original: VextRuntimeLogger) => VextLoggerLike) {
      assertFunction(wrapper, "app.setLogger() wrapper");
      const previous = app.logger;
      const nextLogger = wrapper(previous);
      assertPlainRecord(nextLogger, "app.setLogger() wrapper result");
      assertLoggerLike(nextLogger, "app.setLogger() wrapper result");
      // Pass the factory so child() can re-bind wrapper methods against the
      // child core. Otherwise partial wrappers that close over `original`
      // would silently drop child bindings (B04-F05 / LOG-004 / LOG-007).
      app.logger = normalizeVextLogger(previous, nextLogger, wrapper);
    },

    setRateLimiter(limiter: VextRateLimiter) {
      assertRateLimiter(limiter);
      _rateLimiter = limiter;
      Object.defineProperty(app, RATE_LIMITER_OVERRIDDEN_KEY, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: true,
      });
    },

    setRequestIdGenerator(generate: () => string) {
      assertFunction(generate, "app.setRequestIdGenerator() generator");
      _requestIdGenerator = generate;
    },

    onClose(handler: () => Promise<void> | void) {
      assertFunction(handler, "app.onClose() handler");
      if (_closeState !== "open") {
        throw new Error(
          "[vextjs] app.onClose() cannot be registered after shutdown has started.",
        );
      }
      closeHooks.push(handler);
    },

    onReady(handler: () => Promise<void> | void) {
      assertFunction(handler, "app.onReady() handler");
      if (_readyState !== "pending") {
        throw new Error(
          "[vextjs] app.onReady() cannot be registered after readiness has started.",
        );
      }
      readyHooks.push(handler);
    },

    use(middleware: VextMiddleware) {
      if (_locked) {
        throw new Error(
          "[vextjs] app.use() is locked after route registration. " +
            "Global middleware must be registered in plugin setup().",
        );
      }
      if (_pluginSetupDepth <= 0) {
        throw new Error(
          "[vextjs] app.use() can only be called during plugin setup().",
        );
      }
      assertFunction(middleware, "app.use() middleware");
      globalMiddlewares.push(middleware);
    },

    // ── 缓存管理 API（路由级响应缓存）───────────────────────
    cache: {
      async invalidate(tag: string) {
        await responseCache.invalidateTag(tag);
      },
      async delete(key: string) {
        await responseCache.delete(key);
      },
      async clear() {
        await responseCache.clear();
      },
      stats() {
        const stats = responseCache.stats();
        return {
          ...stats,
          entries: stats.entries ?? 0,
          hits: stats.hits ?? 0,
          misses: stats.misses ?? 0,
          hitRate: stats.hitRate ?? 0,
        };
      },
      _getResponseCache() {
        return responseCache;
      },
    },

    // ── fetch 占位（由 bootstrap 在步骤 ④+ 覆盖为 createVextFetch 实例）──
    //
    // 在 createApp 阶段 fetch 尚未初始化（需要 config.fetch + requestId 配置）。
    // 提供占位实现确保类型为非可选，bootstrap 会在 loadRoutes 之前赋值真实实现。
    // 若路由 handler 在 bootstrap 赋值前调用 app.fetch，会收到明确的错误提示。
    fetch: Object.assign(
      async (_input: unknown, _init?: unknown): Promise<Response> => {
        throw new Error(
          "[vextjs] app.fetch is not initialized yet. " +
            "It is available after bootstrap completes step ④+.",
        );
      },
      {
        get: async () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        post: async () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        put: async () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        patch: async () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        delete: async () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        create: () => {
          throw new Error("[vextjs] app.fetch not initialized");
        },
        proxy: new Proxy(
          async () => {
            throw new Error("[vextjs] app.fetch.proxy not initialized");
          },
          {
            get(_target, prop) {
              if (prop === "then") return undefined;
              return async () => {
                throw new Error("[vextjs] app.fetch.proxy not initialized");
              };
            },
          },
        ),
      },
    ) as unknown as VextFetch,
  };

  appMutationTransactionFactories.set(app, () => {
    const descriptors = captureOwnDescriptors(app);
    const closeHooksLength = closeHooks.length;
    const readyHooksLength = readyHooks.length;
    const middlewaresLength = globalMiddlewares.length;
    const validator = _validator;
    const rateLimiter = _rateLimiter;
    const requestIdGenerator = _requestIdGenerator;
    let settled = false;

    return {
      commit() {
        settled = true;
      },
      rollback() {
        if (settled) return;
        settled = true;
        restoreOwnDescriptors(app, descriptors);
        closeHooks.length = closeHooksLength;
        readyHooks.length = readyHooksLength;
        globalMiddlewares.length = middlewaresLength;
        _validator = validator;
        _rateLimiter = rateLimiter;
        _requestIdGenerator = requestIdGenerator;
        if (!descriptors.has(RATE_LIMITER_OVERRIDDEN_KEY)) {
          const descriptor = Object.getOwnPropertyDescriptor(
            app,
            RATE_LIMITER_OVERRIDDEN_KEY,
          );
          if (descriptor && !descriptor.configurable) {
            Object.defineProperty(app, RATE_LIMITER_OVERRIDDEN_KEY, {
              value: false,
            });
          }
        }
      },
    };
  });

  // ── adapter 延迟赋值 ──────────────────────────────────────
  // adapter 不再在 createApp 中同步解析，而是由 bootstrap / devBootstrap / createTestApp
  // 在 createApp 之后异步调用 resolveAdapter 并赋值到 app.adapter。
  // 这样 adapter-resolver.ts 可以使用动态 import() 按需加载框架依赖。

  // ── 框架内部方法（通过 internals 返回，不暴露在 VextApp 接口类型里）──

  const internals: AppInternals = {
    lockUse() {
      _locked = true;
    },

    enterPluginSetup() {
      _pluginSetupDepth += 1;
    },

    exitPluginSetup() {
      _pluginSetupDepth = Math.max(0, _pluginSetupDepth - 1);
    },

    runReady() {
      if (_readyPromise) return _readyPromise;
      _readyState = "running";
      _readyPromise = (async () => {
        await hooks.emitSafe("app:ready", {
          app,
          phase: "before",
          mode: lifecycleMode,
          source: lifecycleSource,
        });
        for (const h of readyHooks) {
          try {
            await h();
          } catch (err) {
            app.logger.error(
              { error: (err as Error).message },
              "[vextjs] onReady hook failed",
            );
          }
        }
        // 执行完后清空，释放 hooks 持有的闭包引用
        readyHooks.length = 0;
        await hooks.emitSafe("app:ready", {
          app,
          phase: "after",
          mode: lifecycleMode,
          source: lifecycleSource,
        });
        _readyState = "completed";
      })();
      return _readyPromise;
    },

    getGlobalMiddlewares() {
      return [...globalMiddlewares];
    },

    getRateLimiter() {
      return _rateLimiter;
    },

    getRequestIdGenerator() {
      return _requestIdGenerator;
    },

    shutdown(
      serverHandle?: VextServerHandle,
      options?: { skipExit?: boolean },
    ) {
      if (_closeState === "closed") return Promise.resolve();
      if (_shutdownPromise) return _shutdownPromise;
      _closeState = "running";
      const shutdownPromise = (async () => {
        app.logger.info("[vextjs] starting graceful shutdown...");
        await hooks.emitSafe("app:close", {
          app,
          phase: "before",
          mode: lifecycleMode,
          source: lifecycleSource,
        });

        const shutdownTimeout = (config.shutdown?.timeout ?? 10) * 1000;
        let shutdownError: unknown = null;

        // ── 步骤 1：停止接受新请求 + 等待飞行中请求完成 ──
        if (serverHandle) {
          try {
            await closeServerWithTimeout(
              serverHandle,
              shutdownTimeout,
              app.logger,
            );
          } catch (err) {
            shutdownError = err;
          }
        }

        // ── 步骤 2：按 LIFO 顺序执行 onClose 钩子 ──
        for (const h of [...closeHooks].reverse()) {
          try {
            await h();
          } catch (err) {
            app.logger.error(
              { error: (err as Error).message },
              "[vextjs] onClose hook failed",
            );
          }
        }
        // 执行完后清空，释放 hooks 持有的资源引用
        closeHooks.length = 0;

        // ── 步骤 3：关闭响应缓存运行时资源 ──
        try {
          await responseCache.close?.();
        } catch (err) {
          app.logger.error(
            { error: (err as Error).message },
            "[vextjs] response cache close failed",
          );
        }
        await hooks.emitSafe("app:close", {
          app,
          phase: "after",
          mode: lifecycleMode,
          source: lifecycleSource,
        });

        // 默认 logger 可能持有异步 sink，必须在所有 close hook 和 app:close after 之后收尾。
        try {
          await loggerLifecycle?.close();
        } catch (err) {
          console.error(
            `[vextjs] logger close failed: ${(err as Error).message}`,
          );
        }

        _closeState = "closed";

        if (shutdownError) {
          throw shutdownError;
        }

        // ── 步骤 4：退出进程 ──
        //
        // 跳过 process.exit 的场景：
        //   - _testMode: 测试模式，由 createTestApp 控制生命周期
        //   - skipExit:  bootstrap catch 块中调用，仅需清理资源，
        //                不应 exit（否则吞掉启动错误 + 退出码 0 掩盖失败）
        //
        if (!config._testMode && !options?.skipExit) {
          process.exit(0);
        }
      })();
      _shutdownPromise = shutdownPromise.finally(() => {
        if (_closeState === "closed") {
          _shutdownPromise = null;
        }
      });
      return _shutdownPromise;
    },
  };

  return { app, internals };
}

function createDescriptorMutationTransaction(
  app: VextApp,
): AppMutationTransaction {
  const descriptors = captureOwnDescriptors(app);
  let settled = false;
  return {
    commit() {
      settled = true;
    },
    rollback() {
      if (settled) return;
      settled = true;
      restoreOwnDescriptors(app, descriptors);
    },
  };
}

function captureOwnDescriptors(
  value: object,
): Map<PropertyKey, PropertyDescriptor> {
  return new Map(
    Reflect.ownKeys(value).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key)!,
    ]),
  );
}

function restoreOwnDescriptors(
  value: object,
  descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (descriptors.has(key)) continue;
    const current = Object.getOwnPropertyDescriptor(value, key);
    if (current?.configurable) Reflect.deleteProperty(value, key);
  }
  for (const [key, descriptor] of descriptors) {
    const current = Object.getOwnPropertyDescriptor(value, key);
    if (!current || current.configurable) {
      Object.defineProperty(value, key, descriptor);
      continue;
    }
    if ("value" in descriptor && current.writable) {
      Reflect.set(value, key, descriptor.value);
    }
  }
}

// ── 辅助函数 ────────────────────────────────────────────────

const RESERVED_EXTENSION_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "toString",
  "valueOf",
  "hasOwnProperty",
]);
const VALID_EXTENSION_KEY_PATTERN =
  /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;
const RATE_LIMITER_OVERRIDDEN_KEY = Symbol.for("vextjs.rateLimiterOverridden");
const LOGGER_LIKE_METHODS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "child",
  "getLevel",
  "setLevel",
] as const;
const REQUIRED_CONFIG_KEYS = [
  "port",
  "host",
  "adapter",
  "trustProxy",
  "middlewares",
  "cors",
  "rateLimit",
  "requestId",
  "logger",
  "shutdown",
  "server",
  "response",
  "bodyParser",
  "accessLog",
  "openapi",
  "requestContext",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new TypeError(`[vextjs] ${label} must be an object.`);
  }
}

function assertFunction(
  value: unknown,
  label: string,
): asserts value is Function {
  if (typeof value !== "function") {
    throw new TypeError(`[vextjs] ${label} must be a function.`);
  }
}

function assertLoggerLike(
  value: Record<string, unknown>,
  label: string,
): asserts value is VextLoggerLike {
  for (const method of LOGGER_LIKE_METHODS) {
    if (value[method] !== undefined && typeof value[method] !== "function") {
      throw new TypeError(
        `[vextjs] ${label}.${method} must be a function when provided.`,
      );
    }
  }
}

function assertCreateAppConfig(value: unknown): asserts value is VextConfig {
  assertPlainRecord(value, "createApp() config");
  const config = value as Record<string, unknown>;
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (config[key] === undefined) {
      throw new TypeError(
        `[vextjs] createApp() config.${key} is required. ` +
          "Pass a fully resolved VextConfig such as DEFAULT_CONFIG or loadConfig() output.",
      );
    }
  }
  for (const key of [
    "logger",
    "requestContext",
    "shutdown",
    "cache",
    "response",
    "requestId",
  ]) {
    if (config[key] !== undefined) {
      assertPlainRecord(config[key], `createApp() config.${key}`);
    }
  }
  if (config.middlewares !== undefined && !Array.isArray(config.middlewares)) {
    throw new TypeError(
      "[vextjs] createApp() config.middlewares must be an array.",
    );
  }
}

function assertExtensionKey(key: unknown, app: VextApp): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      "[vextjs] app.extend() key must be a non-empty string.",
    );
  }
  if (!VALID_EXTENSION_KEY_PATTERN.test(key)) {
    throw new Error(
      `[vextjs] app.extend("${key}") key must be a valid JavaScript identifier.`,
    );
  }
  if (RESERVED_EXTENSION_KEYS.has(key) || key in Object.prototype) {
    throw new Error(
      `[vextjs] app.extend("${key}") uses a reserved app extension key.`,
    );
  }
  if (key in app && !Object.hasOwn(app, key)) {
    throw new Error(
      `[vextjs] app.extend("${key}") cannot shadow an inherited app property.`,
    );
  }
}

function assertValidator(value: unknown): asserts value is VextValidator {
  assertPlainRecord(value, "app.setValidator() validator");
  assertFunction(value.compile, "app.setValidator() validator.compile");
}

function assertRateLimiter(value: unknown): asserts value is VextRateLimiter {
  assertPlainRecord(value, "app.setRateLimiter() limiter");
  assertFunction(value.check, "app.setRateLimiter() limiter.check");
}

async function closeServerWithTimeout(
  serverHandle: VextServerHandle,
  timeoutMs: number,
  logger: VextRuntimeLogger,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      serverHandle.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          logger.warn(
            "[vextjs] in-flight request wait timed out, forcing shutdown",
          );
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    logger.error(
      { error: (err as Error).message },
      "[vextjs] server close failed during shutdown",
    );
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 创建 HTTP 方法占位函数
 *
 * 直接在 app 上调用 app.get/post/... 会抛出错误，
 * 提示用户应通过 defineRoutes 注册路由。
 * 实际路由收集由 defineRoutes 内部的 collector 完成。
 */
function createRouteMethodPlaceholder(
  method: string,
): (...args: unknown[]) => void {
  return () => {
    throw new Error(
      `[vextjs] app.${method.toLowerCase()}() cannot be called directly on the app instance. ` +
        `Use defineRoutes(app => { app.${method.toLowerCase()}(...) }) in route files.`,
    );
  };
}

/**
 * 创建基于 schema-adapter 防腐层的校验引擎（Phase 1 升级）
 *
 * 替换 Phase 0 的 pass-through 校验器。
 * 通过 schemaAdapter 封装 schema-dsl 的 compile + validate 流程：
 *   1. compile(schema) → 将 DSL 定义编译为 JSON Schema
 *   2. 返回的校验函数调用 schemaAdapter.validate() 执行同步校验
 *
 * 插件可通过 app.setValidator() 替换为 Zod / Yup 等第三方校验库。
 */
function createSchemaAdapterValidator(): VextValidator {
  return {
    compile(schema: Record<string, unknown>) {
      // 将 DSL 定义编译为 JSON Schema（通过防腐层）
      const compiledSchema = schemaAdapter.compile(schema as DslDefinition);

      // 返回校验函数
      return (data: unknown) => {
        const result = schemaAdapter.validate(compiledSchema, data);

        return {
          valid: result.valid,
          data: result.valid ? result.data : undefined,
          errors: result.valid
            ? undefined
            : schemaAdapter.mapValidationErrors(result.errors),
        };
      };
    },
  };
}

/**
 * 默认配置值
 *
 * 由 config-loader 在三层合并时使用。
 * 也可用于 createApp 的快速启动（跳过 config-loader 直接传入默认配置）。
 */
export const DEFAULT_CONFIG: VextConfig = {
  port: 3000,
  host: "0.0.0.0",
  adapter: "native",
  trustProxy: false,
  middlewares: [],
  cors: {
    enabled: true,
    origins: ["*"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    headers: ["Content-Type", "Authorization", "X-Request-Id"],
    credentials: false,
  },
  rateLimit: {
    enabled: false,
    max: 100,
    window: 60,
    message: "Too Many Requests",
    keyBy: "ip",
  },
  requestId: {
    enabled: true,
    header: "x-request-id",
    responseHeader: "x-request-id",
  },
  logger: {
    level: "info",
  },
  shutdown: {
    timeout: 10,
  },
  server: {},
  response: {
    hideInternalErrors: true,
    wrap: true,
  },
  session: {
    enabled: false,
    name: "vext.sid",
    ttl: 86400,
    rolling: false,
    autoCommit: true,
    idLength: 32,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: "auto",
    },
  },
  csrf: {
    enabled: false,
    mode: "auto",
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    headerNames: ["x-csrf-token", "x-xsrf-token"],
    bodyField: "_csrf",
    cookie: {
      name: "vext.csrf",
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      secure: "auto",
    },
    fetchMetadata: true,
    origin: false,
  },
  securityHeaders: {
    enabled: false,
    preset: "basic",
  },
  bodyParser: {
    enabled: true,
    maxBodySize: "1mb",
  },
  accessLog: {
    enabled: true,
    level: "info",
    skipPaths: [],
  },
  openapi: {
    enabled: false,
  },
  frontend: {
    enabled: false,
  },
  requestContext: {
    enabled: true,
  },
};
