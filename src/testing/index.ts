// ── vextjs/testing — 测试工具入口 ──────────────────────────────
//
// 通过 import { createTestApp } from 'vextjs/testing' 使用。
// 提供零配置的测试 App 工厂，支持 mock services、链式 HTTP 请求模拟。
//
// 设计要点：
//   - TestRequest 内部不启动 HTTP 服务器，直接通过 adapter.buildHandler()
//     构造 Node.js (req, res) handler，用内存中的 MockRequest/MockResponse 模拟请求。
//     比 supertest 更快（无网络 I/O），CI 中可并行运行无端口冲突。
//   - config._testMode = true 阻止 shutdown() 调用 process.exit(0)
//   - 默认禁用 rateLimit / healthCheck / 日志静默
//
// @see 10-testing.md §2（createTestApp 接口）
// @see 10-testing.md §6（TestRequest API）
// @see 10-testing.md §11（内部实现概览）
// @see IMPLEMENTATION-PLAN.md 任务 1.19

import type {} from "../lib/plugins/monsqlize/types.js";
import { createApp, DEFAULT_CONFIG } from "../lib/app.js";
import { resolveAdapter } from "../lib/adapter-resolver.js";
import { loadPlugins } from "../lib/plugin-loader.js";
import { loadMiddlewares } from "../lib/middleware-loader.js";
import type { MiddlewareRegistry } from "../lib/middleware-loader.js";
import { loadServices } from "../lib/service-loader.js";
import { loadRoutes } from "../lib/router-loader.js";
import { createRequestIdMiddleware } from "../lib/middlewares/request-id.js";
import { createCorsMiddleware } from "../lib/middlewares/cors.js";
import { createBodyParserMiddleware } from "../lib/middlewares/body-parser.js";
import { createRateLimitMiddleware } from "../lib/middlewares/rate-limit.js";
import { createAccessLogMiddleware } from "../lib/middlewares/access-log.js";
import { responseWrapper } from "../lib/middlewares/response-wrapper.js";
import { createErrorHandler } from "../lib/middlewares/error-handler.js";
import { createCsrfMiddleware } from "../lib/csrf.js";
import {
  createConfiguredSessionRuntime,
  isSessionMiddleware,
} from "../lib/session.js";
import { getHandlerDone } from "../lib/handler-completion.js";
import { createAuthContextMiddleware } from "../lib/auth.js";
import {
  createSecurityHeadersMiddleware,
  withSecurityHeadersErrorHandler,
  withSecurityHeadersNotFoundHandler,
} from "../lib/security-headers.js";
import {
  createRequestHookMiddleware,
  emitNotFoundRequestHooks,
} from "../lib/middlewares/request-hook.js";
import { _deepMerge } from "../lib/config-loader.js";
import type {
  VextApp,
  VextConfig,
  VextConfigOverride,
  VextServices,
} from "../types/app.js";
import type { VextInternalHooks } from "../types/hooks.js";
import { createVextFetch, type VextFetchConfig } from "../lib/fetch.js";
import type { VextMiddleware } from "../types/middleware.js";

import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import { type IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

// ── 公共类型 ────────────────────────────────────────────────

/**
 * createTestApp 选项
 *
 * @see 10-testing.md §2.1
 */
export interface CreateTestAppOptions {
  /**
   * 覆盖默认配置（深度合并到 test 默认配置之上）
   *
   * createTestApp 不加载项目的 src/config/default.ts。若新增内置默认值中不存在的
   * 可选 section（例如 database），仍须提供该 section 的完整必填配置。
   */
  config?: VextConfigOverride;

  /**
   * 是否加载 src/plugins/（默认 false — 测试环境默认不加载插件）
   */
  plugins?: boolean;

  /**
   * 手动注册插件（替代自动扫描，精确控制测试依赖）
   */
  setupPlugins?: (app: VextApp) => Promise<void> | void;

  /**
   * Optional dev error overlay renderer.
   * When provided, Accept: text/html error responses use this HTML body
   * (mirrors production createErrorHandler(devOverlay) wiring).
   */
  devOverlay?: (error: unknown) => string;

  /**
   * 是否加载 `src/services/`（默认 true）
   *
   * 为 `true` 时，`service-loader` 扫描 `src/services/` 并自动加载所有 `.ts` 服务文件。
   * `.ts` 文件通过 esbuild bundle 编译后加载，完整支持：
   *   - TypeScript 语法及类型擦除
   *   - 服务文件内部的 `.js` 扩展名 import（TypeScript ESM 约定）
   *   - 相对路径模块依赖（esbuild bundle 内联解析）
   *
   * **单元测试推荐**：设为 `false` + 配合 `mockServices`，避免加载真实服务：
   *
   * ```typescript
   * await createTestApp({
   *   services: false,
   *   mockServices: { user: mockUserService },
   * })
   * ```
   */
  services?: boolean;

  /**
   * 手动注入 mock services（覆盖 service-loader 扫描结果）
   *
   * 如果同时 services=true，先加载真实 services，再用 mockServices 覆盖。
   * 如果 services=false，仅使用 mockServices。
   */
  mockServices?: Partial<VextServices>;

  /**
   * 是否加载 src/routes/（默认 true — 集成测试需要路由）
   */
  routes?: boolean;

  /**
   * 是否加载 src/middlewares/（默认 true）
   */
  middlewares?: boolean;

  /**
   * 项目根目录（默认 process.cwd()）
   *
   * 用于定位 src/routes、src/services 等目录。
   */
  rootDir?: string;
}

/**
 * 测试 App 实例
 *
 * @see 10-testing.md §2.1
 */
export interface TestApp {
  /** 底层 VextApp 实例 */
  app: VextApp;

  /**
   * 发送模拟 HTTP 请求（无需启动 HTTP 服务器）
   * 类似 supertest 的 API 风格
   */
  request: TestRequest;

  /**
   * 关闭 test app（触发 onClose 钩子、清理资源）
   * 务必在 afterEach / afterAll 中调用
   */
  close(): Promise<void>;
}

/**
 * HTTP 请求模拟器
 *
 * @see 10-testing.md §6
 */
export interface TestRequest {
  get(path: string): TestRequestBuilder;
  post(path: string): TestRequestBuilder;
  put(path: string): TestRequestBuilder;
  patch(path: string): TestRequestBuilder;
  delete(path: string): TestRequestBuilder;
  options(path: string): TestRequestBuilder;
  head(path: string): TestRequestBuilder;
}

/**
 * 链式请求构造器
 *
 * 支持链式调用设置请求参数，最终通过 await 或 .then() 执行请求。
 *
 * @see 10-testing.md §6
 */
export interface TestRequestBuilder extends PromiseLike<TestResponse> {
  /** 设置请求头 */
  set(key: string, value: string): this;

  /** 设置多个请求头 */
  headers(headers: Record<string, string>): this;

  /** 设置 query 参数 */
  query(params: Record<string, string | number | boolean>): this;

  /** 设置请求体（自动序列化为 JSON，设置 Content-Type） */
  send(body: unknown): this;

  /** 设置 Content-Type */
  type(contentType: string): this;
}

export type TestResponseHeaderValue = string | string[];

/**
 * 模拟 HTTP 响应
 *
 * @see 10-testing.md §6
 */
export interface TestResponse {
  /** HTTP 状态码 */
  status: number;

  /** 响应头 */
  headers: Record<string, TestResponseHeaderValue>;

  /** Set-Cookie 响应头数组 */
  cookies: string[];

  /** 读取单个响应头（多值头返回第一个值） */
  header(name: string): string | undefined;

  /** 读取响应头的所有值 */
  headerValues(name: string): string[];

  /** 自动解析的 JSON 响应体 */
  body: any;

  /** 原始响应文本 */
  text: string;
}

// ── 测试默认配置 ────────────────────────────────────────────

/**
 * 测试环境默认配置
 *
 * 专为测试优化：
 *   - port=0：随机端口，避免冲突
 *   - logger.level='silent'：测试输出不被日志污染
 *   - rateLimit.enabled=false：测试不需要限流
 *   - shutdown.timeout=1：快速关闭（秒）
 *   - _testMode=true：阻止 process.exit()
 *
 * @see 10-testing.md §2.2
 */
const TEST_DEFAULTS: Partial<VextConfig> = {
  port: 0,
  host: "127.0.0.1",
  logger: {
    level: "silent",
  },
  rateLimit: {
    enabled: false,
    max: 100,
    window: 60,
    message: "Too Many Requests",
    keyBy: "ip",
  },
  accessLog: {
    enabled: false,
    level: "info",
    skipPaths: [],
  },
  shutdown: {
    timeout: 1,
  },
  _testMode: true,
};

// ── createTestApp ───────────────────────────────────────────

/**
 * createTestApp — 测试用 App 工厂
 *
 * 零配置创建测试用 app 实例，支持 mock services、路由级集成测试。
 * 内部不启动 HTTP 服务器，通过 adapter.buildHandler() 模拟请求。
 *
 * ---
 *
 * ### TypeScript 服务文件与 ESM 加载
 *
 * 当 `services: true`（默认）时，`createTestApp()` 调用 `loadServices(app, 'src/services/')`
 * 加载 `.ts` 源文件。`service-loader` 内部会自动用 esbuild 将 `.ts` 文件
 * bundle 编译为 `.mjs` 后加载，解决两个原生问题：
 *
 *   1. `ERR_UNKNOWN_FILE_EXTENSION` — Node.js 原生 ESM 不支持 `.ts` 扩展名
 *   2. `.js → .ts` 重映射缺失 — TypeScript ESM 约定使用 `.js` 扩展名，
 *      Node.js / Vite resolver 均不自动回退到 `.ts`；
 *      esbuild bundle 阶段已完整处理此映射
 *
 * **单元测试推荐**：若只测试路由逻辑，使用 `mockServices` 跳过真实服务加载，
 * 速度更快且完全隔离：
 *
 * ```typescript
 * const t = await createTestApp({
 *   services: false,   // 不加载真实 .ts 服务文件
 *   mockServices: {
 *     user: { findAll: vi.fn().mockResolvedValue([]) },
 *   },
 * })
 * ```
 *
 * **集成测试**：保持 `services: true`（默认），`service-loader` 自动处理编译。
 *
 * @param options 创建选项（全部可选）
 * @returns 包含 app、request、close 的测试 App 实例
 *
 * @example
 * ```typescript
 * const t = await createTestApp({
 *   routes: true,
 *   mockServices: {
 *     user: { findAll: async () => ({ list: [], total: 0 }) },
 *   },
 * })
 * const res = await t.request.get('/users/list').query({ page: 1, limit: 10 })
 * expect(res.status).toBe(200)
 * await t.close()
 * ```
 *
 * @see 10-testing.md §2（接口规范）
 * @see 10-testing.md §11（内部实现概览）
 * @see IMPLEMENTATION-PLAN.md 任务 1.19
 */
export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  const {
    config: userConfig = {},
    plugins: shouldLoadPlugins = false,
    setupPlugins: setupPluginsFn,
    services: shouldLoadServices = true,
    mockServices,
    routes: shouldLoadRoutes = true,
    middlewares: shouldLoadMiddlewares = true,
    rootDir = process.cwd(),
    devOverlay,
  } = options;

  const srcDir = join(rootDir, "src");

  // ── 1. 合并测试默认配置 + 用户覆盖 ────────────────────
  //
  // 三层合并：DEFAULT_CONFIG → TEST_DEFAULTS → userConfig
  // 使用 config-loader 内部的 deepMerge（跳过 middlewares key）
  // 然后手动合并 middlewares（测试环境通常为空数组或用户指定的白名单）
  const baseConfig = _deepMerge(
    DEFAULT_CONFIG as Record<string, unknown>,
    TEST_DEFAULTS as Record<string, unknown>,
  ) as VextConfig;

  const finalConfig = _deepMerge(
    baseConfig as Record<string, unknown>,
    userConfig as Record<string, unknown>,
  ) as VextConfig;

  // 确保 _testMode 始终为 true（即使用户覆盖了也不允许关闭）
  (finalConfig as Record<string, unknown>)._testMode = true;

  // middlewares 合并：优先用户覆盖，否则保留默认
  if (userConfig.middlewares) {
    finalConfig.middlewares = userConfig.middlewares;
  } else if (!finalConfig.middlewares) {
    finalConfig.middlewares = [];
  }

  // ── 2. 创建 app ──────────────────────────────────────
  const { app, internals } = createApp(finalConfig);
  const hooks = app.hooks as VextInternalHooks;
  const sessionRuntime = createConfiguredSessionRuntime(finalConfig.session);
  app.onClose(sessionRuntime.close);
  const corsMiddleware = createCorsMiddleware(finalConfig.cors);

  // ── 2a. resolveAdapter（异步按需加载）─────────────────
  app.adapter = await resolveAdapter(finalConfig, app);

  const fetchCfg = finalConfig.fetch as VextFetchConfig | undefined;
  app.fetch = createVextFetch(
    app.logger,
    fetchCfg ?? {},
    finalConfig.requestId?.header ?? "x-request-id",
    hooks,
  ) as VextApp["fetch"];

  // ── 3. 插件 ──────────────────────────────────────────
  if (setupPluginsFn) {
    // 用户提供的手动插件注册函数（精确控制依赖）
    internals.enterPluginSetup();
    try {
      await setupPluginsFn(app);
    } finally {
      internals.exitPluginSetup();
    }
  } else if (shouldLoadPlugins) {
    // 自动扫描 src/plugins/
    internals.enterPluginSetup();
    try {
      await loadPlugins(app, join(srcDir, "plugins"));
    } finally {
      internals.exitPluginSetup();
    }
  }

  // ── 4. 中间件 ────────────────────────────────────────
  let middlewareRegistry: MiddlewareRegistry | undefined;
  if (shouldLoadMiddlewares && finalConfig.middlewares?.length) {
    middlewareRegistry = await loadMiddlewares(
      join(srcDir, "middlewares"),
      finalConfig.middlewares,
      app.logger,
      finalConfig.logger?.lifecycleLevel ?? "concise",
    );
  }

  // ── 5. Services ──────────────────────────────────────
  if (shouldLoadServices) {
    await loadServices(app, join(srcDir, "services"));
  }
  // mock services 覆盖（后执行，优先级更高）
  if (mockServices) {
    Object.assign(app.services, mockServices);
  }

  // ── 6. Routes ────────────────────────────────────────
  if (shouldLoadRoutes) {
    await loadRoutes(app, join(srcDir, "routes"), {
      middlewareDefs: middlewareRegistry ?? {},
      globalMiddlewares: internals.getGlobalMiddlewares(),
      sessionMiddleware: sessionRuntime.middleware,
      corsMiddleware,
      rootDir,
      frontendMode: "development",
    });
    internals.lockUse(); // 测试环境也需锁定，保持行为一致
  }

  // ── 7. 注册内置中间件（与 bootstrap 步骤⑥ 一致）────
  //
  // 测试环境也需要注册内置中间件以保证行为与生产一致：
  //   requestId → authContext → requestHook → securityHeaders → cors → body-parser → response-wrapper
  //   + 错误处理 + 404 兜底
  //
  // 注意：rate-limit 默认禁用（TEST_DEFAULTS），但如果用户显式启用则注册。
  //
  // 🔧 同步 bootstrap.ts / dev-bootstrap.ts：
  //   - rate-limit 仅在 enabled === true 时注册；其他中间件保持各自条件守卫
  //   - createRequestIdMiddleware 补传第 3/4 参（propagateHeaders / localeConfig）

  // requestId（config.requestId.enabled，默认 true）
  if (finalConfig.requestId?.enabled !== false) {
    const requestIdMiddleware = createRequestIdMiddleware(
      finalConfig.requestId,
      () => internals.getRequestIdGenerator(),
      fetchCfg?.propagateHeaders ?? [],
      (finalConfig as Record<string, unknown>).locale as
        | import("../types/app.js").VextLocaleConfig
        | undefined,
    );
    app.adapter.registerMiddleware(requestIdMiddleware);
  }

  if (finalConfig.requestContext?.enabled !== false) {
    app.adapter.registerMiddleware(createAuthContextMiddleware());
  }

  app.adapter.registerMiddleware(createRequestHookMiddleware(hooks));

  if (finalConfig.securityHeaders?.enabled === true) {
    app.adapter.registerMiddleware(
      createSecurityHeadersMiddleware(finalConfig.securityHeaders),
    );
  }

  // cors（config.cors.enabled，默认 true）
  if (finalConfig.cors?.enabled !== false) {
    app.adapter.registerMiddleware(corsMiddleware);
  }

  // body-parser（config.bodyParser.enabled，默认 true）
  if (finalConfig.bodyParser?.enabled !== false) {
    const bodyParserMiddleware = createBodyParserMiddleware(
      finalConfig.bodyParser,
      finalConfig.multipart,
    );
    app.adapter.registerMiddleware(bodyParserMiddleware);
  }

  if (finalConfig.rateLimit?.enabled === true) {
    app.adapter.registerMiddleware(
      createRateLimitMiddleware(finalConfig.rateLimit, () =>
        internals.getRateLimiter(),
      ),
    );
  }

  // response-wrapper（config.response.wrap，默认 true）
  if (finalConfig.response?.wrap !== false) {
    app.adapter.registerMiddleware(responseWrapper);
  }

  if (finalConfig.accessLog?.enabled !== false) {
    app.adapter.registerMiddleware(
      createAccessLogMiddleware(finalConfig.accessLog ?? {}, app.logger),
    );
  }

  if (finalConfig.session?.enabled === true) {
    if (internals.getGlobalMiddlewares().some(isSessionMiddleware)) {
      app.logger.warn(
        "[vextjs] config.session.enabled already auto-registers Session; remove manual app.use(session()) to avoid redundant middleware.",
      );
    }
    app.adapter.registerMiddleware(sessionRuntime.middleware);
  }

  // 插件全局中间件
  for (const mw of internals.getGlobalMiddlewares()) {
    app.adapter.registerMiddleware(mw);
  }

  if (finalConfig.csrf?.enabled === true) {
    app.adapter.registerMiddleware(createCsrfMiddleware(finalConfig.csrf));
  }

  // 错误处理 + 404 兜底（可选 devOverlay 与 CLI/dev bootstrap 对齐）
  const errorHandler = createErrorHandler(
    finalConfig.response ?? {},
    devOverlay,
    app.logger,
    hooks,
  );
  app.adapter.registerErrorHandler(
    withSecurityHeadersErrorHandler(errorHandler, finalConfig.securityHeaders),
  );

  const notFoundHandler = createNotFoundHandler(hooks);
  app.adapter.registerNotFound(
    withSecurityHeadersNotFoundHandler(
      notFoundHandler,
      finalConfig.securityHeaders,
    ),
  );

  // ── 8. onReady 生命周期 ──────────────────────────────
  // Match bootstrap: plugins/services that register app.onReady must run
  // before the first test request (B08 env lifecycle / ready hooks).
  await internals.runReady();

  // ── 9. 构造 TestRequest ──────────────────────────────
  //
  // 获取 adapter 的 buildHandler() 构建请求处理函数，
  // 通过内存中的 mock IncomingMessage / ServerResponse 模拟 HTTP 请求，
  // 无需启动 TCP 监听。
  const handler = app.adapter.buildHandler();
  const request = createTestRequest(handler);

  return {
    app,
    request,

    async close(): Promise<void> {
      // 触发所有 onClose 钩子（测试环境无 server，不传 serverHandle）
      // config._testMode = true → shutdown() 内部不会调用 process.exit(0)
      await internals.shutdown();
    },
  };
}

// ── 404 兜底处理（与 bootstrap.ts 一致）──────────────────────

/**
 * 创建 404 兜底处理函数（测试环境复用同一实现）
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

// ── TestRequest 实现 ────────────────────────────────────────

/**
 * 创建 TestRequest 实例
 *
 * 内部通过 Node.js 的 IncomingMessage / ServerResponse mock 实现，
 * 将请求直接传递给 adapter 的 buildHandler() 返回的处理函数。
 *
 * 优势：
 *   - 无网络 I/O（不启动 HTTP 服务器）
 *   - CI 中可并行运行，无端口冲突
 *   - 比 supertest 更快
 *
 * @param handler adapter.buildHandler() 返回的 (req, res) => void 函数
 */
function createTestRequest(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): TestRequest {
  function createBuilder(method: string, path: string): TestRequestBuilder {
    // 请求参数累积
    const _headers: Record<string, string> = {};
    let _queryParams: Record<string, string | number | boolean> | null = null;
    let _body: unknown;
    let _contentType: string | null = null;

    const builder: TestRequestBuilder = {
      set(key: string, value: string) {
        _headers[key.toLowerCase()] = value;
        return builder;
      },

      headers(headers: Record<string, string>) {
        for (const [k, v] of Object.entries(headers)) {
          _headers[k.toLowerCase()] = v;
        }
        return builder;
      },

      query(params: Record<string, string | number | boolean>) {
        _queryParams = params;
        return builder;
      },

      send(body: unknown) {
        _body = body;
        // 自动设置 Content-Type（如果未手动指定）
        if (!_contentType && !_headers["content-type"]) {
          _contentType = "application/json";
        }
        return builder;
      },

      type(contentType: string) {
        _contentType = contentType;
        return builder;
      },

      then<TResult1 = TestResponse, TResult2 = never>(
        resolve?:
          | ((value: TestResponse) => TResult1 | PromiseLike<TResult1>)
          | null,
        reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        const promise = executeRequest(
          handler,
          method,
          path,
          _headers,
          _queryParams,
          _body,
          _contentType,
        );
        return promise.then(resolve, reject);
      },
    };

    return builder;
  }

  return {
    get: (path) => createBuilder("GET", path),
    post: (path) => createBuilder("POST", path),
    put: (path) => createBuilder("PUT", path),
    patch: (path) => createBuilder("PATCH", path),
    delete: (path) => createBuilder("DELETE", path),
    options: (path) => createBuilder("OPTIONS", path),
    head: (path) => createBuilder("HEAD", path),
  };
}

/**
 * 执行模拟 HTTP 请求
 *
 * 构造 mock IncomingMessage / ServerResponse，传给 handler，
 * 收集响应数据并解析为 TestResponse。
 *
 * @param handler        adapter 的请求处理函数
 * @param method         HTTP 方法
 * @param path           请求路径
 * @param headers        请求头
 * @param queryParams    查询参数
 * @param body           请求体
 * @param contentType    Content-Type
 */
function executeRequest(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  path: string,
  headers: Record<string, string>,
  queryParams: Record<string, string | number | boolean> | null,
  body: unknown,
  contentType: string | null,
): Promise<TestResponse> {
  return new Promise<TestResponse>((resolve, reject) => {
    try {
      // ── 构造 URL ──────────────────────────────────────
      let url = path;
      if (queryParams) {
        const searchParams = new URLSearchParams();
        for (const [k, v] of Object.entries(queryParams)) {
          searchParams.set(k, String(v));
        }
        const qs = searchParams.toString();
        if (qs) {
          url += (url.includes("?") ? "&" : "?") + qs;
        }
      }

      // ── 序列化 body ──────────────────────────────────
      let bodyStr: string | null = null;
      if (body !== undefined) {
        if (typeof body === "string") {
          bodyStr = body;
        } else {
          bodyStr = JSON.stringify(body);
        }
      }

      // ── 构建 headers ─────────────────────────────────
      const finalHeaders: Record<string, string> = {
        host: "localhost",
        ...headers,
      };

      if (contentType) {
        finalHeaders["content-type"] = contentType;
      }

      if (bodyStr !== null && !finalHeaders["content-length"]) {
        finalHeaders["content-length"] = String(
          Buffer.byteLength(bodyStr, "utf-8"),
        );
      }

      // ── 构造 rawHeaders 数组 ──────────────────────────
      // Node.js IncomingMessage.rawHeaders 是 [key, value, key, value, ...] 格式
      const rawHeaders: string[] = [];
      for (const [k, v] of Object.entries(finalHeaders)) {
        rawHeaders.push(k, v);
      }

      // ── 构造 mock IncomingMessage ─────────────────────
      //
      // 使用 Readable stream 模拟请求体。
      // 通过 Object.assign 为 stream 添加 IncomingMessage 需要的属性。
      const socket = new Socket();
      const bodyStream =
        bodyStr !== null
          ? Readable.from(Buffer.from(bodyStr, "utf-8"))
          : Readable.from(Buffer.alloc(0));

      const mockReq = Object.assign(bodyStream, {
        method: method.toUpperCase(),
        url,
        headers: finalHeaders,
        rawHeaders,
        httpVersion: "1.1",
        httpVersionMajor: 1,
        httpVersionMinor: 1,
        socket,
        connection: socket,
        // statusCode / statusMessage（IncomingMessage 字段，请求中不常用）
        statusCode: null,
        statusMessage: null,
        // complete 标志
        complete: true,
        // aborted（已弃用但某些库仍检查）
        aborted: false,
        // trailers
        trailers: {},
        rawTrailers: [],
      }) as unknown as IncomingMessage;

      // ── 构造 mock ServerResponse ─────────────────────
      //
      // 收集 handler 写入的响应头和响应体。
      const shouldCollectResponseBody = method.toUpperCase() !== "HEAD";
      const responseChunks: Buffer[] = [];
      const responseHeaders: Record<string, TestResponseHeaderValue> = {};
      let statusCode = 200;

      function recordResponseHeader(
        name: string,
        value: number | string | string[],
      ): void {
        responseHeaders[name.toLowerCase()] = Array.isArray(value)
          ? value.map(String)
          : String(value);
      }

      // 创建 writable stream 作为 mock ServerResponse
      const mockRes = new ServerResponse(mockReq);

      // 使用可写的内存流承接 ServerResponse 输出，避免异步响应写入
      // 尚未连接的 net.Socket 时触发 ERR_SOCKET_CLOSED。
      const resSocket = new PassThrough() as unknown as Socket;
      resSocket.resume();
      mockRes.assignSocket(resSocket);

      // 拦截 writeHead
      const originalWriteHead = mockRes.writeHead.bind(mockRes);
      (mockRes as any).writeHead = (
        code: number,
        ...args: any[]
      ): ServerResponse => {
        statusCode = code;

        // writeHead 可以接受 (statusCode, headers) 或 (statusCode, reasonPhrase, headers)
        let headersArg: Record<string, string | string[]> | undefined;
        if (args.length === 1 && typeof args[0] === "object") {
          headersArg = args[0] as Record<string, string | string[]>;
        } else if (args.length === 2 && typeof args[1] === "object") {
          headersArg = args[1] as Record<string, string | string[]>;
        }

        if (headersArg) {
          for (const [k, v] of Object.entries(headersArg)) {
            recordResponseHeader(k, v);
          }
        }

        return originalWriteHead(code, ...args);
      };

      // 拦截 write
      const originalWrite = mockRes.write.bind(mockRes);
      (mockRes as any).write = (chunk: any, ...args: any[]): boolean => {
        if (shouldCollectResponseBody) {
          appendResponseChunk(responseChunks, chunk);
        }
        return originalWrite(chunk, ...args);
      };

      // 拦截 end
      const originalEnd = mockRes.end.bind(mockRes);
      (mockRes as any).end = (chunk?: any, ...args: any[]): ServerResponse => {
        if (shouldCollectResponseBody) {
          appendResponseChunk(responseChunks, chunk);
        }

        // 响应完成后收集结果
        // 使用 queueMicrotask 确保 handler 的 Promise 链完成
        queueMicrotask(() => {
          void (async () => {
            await getHandlerDone(mockRes);

            // 获取最终 statusCode（ServerResponse 自身也会设置）
            const finalStatus = mockRes.statusCode ?? statusCode;

            // 收集通过 setHeader 设置的 headers
            const headerNames = mockRes.getHeaderNames();
            for (const name of headerNames) {
              const value = mockRes.getHeader(name);
              if (value !== undefined) {
                recordResponseHeader(name, value as string | string[]);
              }
            }

            // 组合响应体
            const bodyBuffer = Buffer.concat(responseChunks);
            const text = bodyBuffer.toString("utf-8");

            // 尝试解析 JSON
            let parsedBody: any = text;
            const ct = firstHeaderValue(responseHeaders, "content-type") ?? "";
            if (ct.includes("application/json") || ct.includes("+json")) {
              try {
                parsedBody = JSON.parse(text);
              } catch {
                // 非法 JSON，保留原始文本
                parsedBody = text;
              }
            }

            // 清理 socket
            try {
              socket.destroy();
              resSocket.destroy();
            } catch {
              // 静默忽略
            }

            const headersSnapshot = { ...responseHeaders };
            const cookies = headerValues(headersSnapshot, "set-cookie");

            resolve({
              status: finalStatus,
              headers: headersSnapshot,
              cookies,
              header(name: string): string | undefined {
                return firstHeaderValue(headersSnapshot, name);
              },
              headerValues(name: string): string[] {
                return headerValues(headersSnapshot, name);
              },
              body: parsedBody,
              text,
            });
          })().catch((err: unknown) => {
            try {
              socket.destroy();
              resSocket.destroy();
            } catch {
              // 静默忽略
            }
            reject(err);
          });
        });

        return originalEnd(chunk, ...args);
      };

      // ── 执行 handler ─────────────────────────────────
      handler(mockReq, mockRes);
    } catch (err) {
      reject(err);
    }
  });
}

function appendResponseChunk(chunks: Buffer[], chunk: unknown): void {
  if (!chunk) {
    return;
  }

  if (Buffer.isBuffer(chunk)) {
    chunks.push(chunk);
  } else if (typeof chunk === "string") {
    chunks.push(Buffer.from(chunk, "utf-8"));
  } else if (chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk));
  }
}

function firstHeaderValue(
  headers: Record<string, TestResponseHeaderValue>,
  name: string,
): string | undefined {
  const values = headerValues(headers, name);
  return values[0];
}

function headerValues(
  headers: Record<string, TestResponseHeaderValue>,
  name: string,
): string[] {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
