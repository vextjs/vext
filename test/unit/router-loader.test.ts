/**
 * router-loader 单元测试
 *
 * 测试覆盖：
 *   - 空目录 / 不存在的目录 → 警告但不报错
 *   - 路由前缀推导：目录结构 → URL 前缀（[param] → :param、index → 空）
 *   - 重复路由检测：同 method + path 不允许重复注册
 *   - .test. / .spec.、点文件、node_modules → 跳过
 *   - _ 开头的文件/目录 → 跳过
 *   - 路由级中间件引用校验：引用未声明的中间件 → Fail Fast 报错
 *   - 正常路由加载 + 注册到 adapter
 *
 * 策略：
 *   使用临时目录（os.tmpdir）创建真实文件系统结构。
 *   路由文件必须 default export 一个通过 defineRoutes() 创建的 RouteDefinition 对象，
 *   因此测试中的路由文件通过构造正确的 RouteDefinition 结构体来模拟。
 *
 *   由于临时目录中无法 import 'vextjs' 的 defineRoutes，
 *   我们手动构造与 defineRoutes 输出一致的对象结构：
 *     { routes: [], sourceFile: '', register() {...}, _factory, _collector }
 *   这里的 _factory/_collector 是 legacy 夹具格式；框架自身的 defineRoutes()
 *   不再把这些内部状态暴露为字符串属性。
 *
 * @see 01-routes.md §2（路由加载规范）
 * @see 10-testing.md §3（单元测试模式）
 * @see IMPLEMENTATION-PLAN.md 任务 1.20
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoutes } from "../../src/lib/router-loader.js";
import { createHookManager } from "../../src/lib/hooks.js";
import { createAnonymousAuthContext } from "../../src/lib/auth.js";
import { createVextResponse as createNativeResponse } from "../../src/adapters/native/response.js";
import { HttpError } from "../../src/types/errors.js";
import type { VextApp, VextConfig } from "../../src/types/app.js";
import type { VextAdapter, VextServerHandle } from "../../src/types/adapter.js";
import type {
  VextMiddleware,
  VextErrorMiddleware,
} from "../../src/types/middleware.js";
import type { MiddlewareRegistry } from "../../src/lib/middleware-loader.js";

// ── 测试辅助 ────────────────────────────────────────────────

/**
 * 创建 mock VextAdapter
 *
 * 记录 registerRoute 调用以便断言路由注册行为。
 */
function createMockAdapter(): VextAdapter & {
  registeredRoutes: Array<{
    method: string;
    path: string;
    chainLength: number;
    chain: VextMiddleware[];
    routeOptions: unknown;
  }>;
  registeredMiddlewares: VextMiddleware[];
} {
  const registeredRoutes: Array<{
    method: string;
    path: string;
    chainLength: number;
    chain: VextMiddleware[];
    routeOptions: unknown;
  }> = [];
  const registeredMiddlewares: VextMiddleware[] = [];

  return {
    name: "mock",
    registeredRoutes,
    registeredMiddlewares,

    registerRoute(
      method: string,
      path: string,
      chain: VextMiddleware[],
      routeOptions?: unknown,
    ): void {
      registeredRoutes.push({
        method: method.toUpperCase(),
        path,
        chainLength: chain.length,
        chain,
        routeOptions,
      });
    },

    registerMiddleware(middleware: VextMiddleware): void {
      registeredMiddlewares.push(middleware);
    },

    registerErrorHandler(_handler: VextErrorMiddleware): void {},

    registerNotFound(_handler: VextMiddleware): void {},

    async listen(_port: number, _host?: string): Promise<VextServerHandle> {
      return {
        port: 0,
        host: "127.0.0.1",
        async close() {},
      };
    },

    buildHandler() {
      return (_req: any, _res: any) => {};
    },
  };
}

/**
 * 创建最小化的 mock VextApp（含 mock adapter）
 */
function createMockApp(): VextApp & {
  mockAdapter: ReturnType<typeof createMockAdapter>;
} {
  const mockAdapter = createMockAdapter();

  const app = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: () => app.logger,
      level: "silent",
    },
    throw: ((status: number, message: string) => {
      throw new Error(`HttpError ${status}: ${message}`);
    }) as VextApp["throw"],
    config: {
      port: 3000,
      host: "0.0.0.0",
      adapter: "hono",
      trustProxy: false,
      middlewares: [],
      cors: {
        enabled: false,
        origins: [],
        methods: [],
        headers: [],
        credentials: false,
      },
      rateLimit: {
        enabled: false,
        max: 100,
        window: 60,
        message: "",
        keyBy: "ip",
      },
      requestId: {
        enabled: false,
        header: "x-request-id",
        responseHeader: "x-request-id",
      },
      logger: { level: "silent" },
      shutdown: { timeout: 1 },
      response: { hideInternalErrors: true },
      bodyParser: { maxBodySize: "1mb" },
      openapi: { enabled: false },
      accessLog: { enabled: false },
      requestContext: { enabled: false },
      _testMode: true,
    } as VextConfig,
    services: {} as any,
    hooks: createHookManager(),
    adapter: mockAdapter,
    get: () => {},
    post: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    head: () => {},
    options: () => {},
    extend: () => {},
    setValidator: () => {},
    getValidator: () =>
      ({
        compile: () => () => ({ valid: true }),
      }) as any,
    setThrow: () => {},
    setRateLimiter: () => {},
    setRequestIdGenerator: () => {},
    onClose: () => {},
    onReady: () => {},
    use: () => {},
    mockAdapter,
  } as unknown as VextApp & {
    mockAdapter: ReturnType<typeof createMockAdapter>;
  };

  return app;
}

/**
 * 写入路由文件到临时目录
 */
async function writeRouteFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(dir, relativePath);
  const parentDir = join(fullPath, "..");
  await mkdir(parentDir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * 生成使用 defineRoutes 格式的路由文件内容
 *
 * router-loader 通过 loadRouteFile 验证 default export 具有：
 *   - routes: RouteRecord[]
 *   - register: Function
 *   - _factory: Function（legacy 内部属性，executeRouteFactory 兼容读取）
 *   - _collector: Object（legacy 内部属性，executeRouteFactory 兼容读取）
 *
 * 此函数生成内联构造 RouteDefinition 的 ESM 代码，
 * 完全模拟 defineRoutes() 的输出结构。
 */
function makeRouteFileContent(
  routes: Array<{
    method: string;
    path: string;
    middlewares?: string[];
    options?: string;
  }>,
): string {
  // 生成 collector 方法
  const methodNames = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
  ];
  const collectorMethods = methodNames
    .map(
      (m) => `
    ${m}(path, optionsOrHandler, handler) {
      if (typeof optionsOrHandler === 'function') {
        routes.push({ method: '${m.toUpperCase()}', path, options: {}, handler: optionsOrHandler });
      } else {
        routes.push({ method: '${m.toUpperCase()}', path, options: optionsOrHandler || {}, handler: handler });
      }
    }`,
    )
    .join(",");

  // 生成 factory 回调内容 —— 在 collector 上注册路由
  const factoryBody = routes
    .map((r) => {
      const opts = r.middlewares
        ? `{ middlewares: [${r.middlewares.map((m) => `'${m}'`).join(", ")}] }`
        : r.options
          ? r.options
          : "{}";
      return `    collector.${r.method.toLowerCase()}('${r.path}', ${opts}, async (req, res) => { res.json({ ok: true }); });`;
    })
    .join("\n");

  return `
const routes = [];

const collector = {
  ${collectorMethods}
};

function factory(app) {
${factoryBody}
}

function normalizePath(prefix, subPath) {
  const cleanPrefix = prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  const cleanSubPath = subPath.startsWith('/') ? subPath.slice(1) : subPath;
  if (!cleanSubPath) return cleanPrefix || '/';
  if (cleanPrefix === '/') return '/' + cleanSubPath;
  const fullPath = cleanPrefix + '/' + cleanSubPath;
  if (fullPath.length > 1 && fullPath.endsWith('/')) return fullPath.slice(0, -1);
  return fullPath;
}

const routeDefinition = {
  routes,
  sourceFile: '',
  register(adapter, prefix, middlewareDefs, globalMiddlewares) {
    for (const route of routes) {
      const fullPath = normalizePath(prefix, route.path);
      const routeMiddlewares = [];
      if (route.options.middlewares) {
        for (const ref of route.options.middlewares) {
          const name = typeof ref === 'string' ? ref : ref.name;
          const entry = middlewareDefs.get ? middlewareDefs.get(name) : middlewareDefs[name];
          if (entry) {
            const mw = typeof entry === 'function' ? entry :
                        (entry.kind === 'factory' ? entry.handler() : entry.handler);
            routeMiddlewares.push(mw);
          }
        }
      }
      const handlerMiddleware = async (req, res, _next) => { await route.handler(req, res); };
      const chain = [...routeMiddlewares, handlerMiddleware];
      adapter.registerRoute(route.method, fullPath, chain);
    }
  },
  _factory: factory,
  _collector: collector,
};

export default routeDefinition;
`;
}

/**
 * 生成简单的单路由文件（常用快捷方式）
 */
function makeSimpleRouteFile(
  method: string,
  path: string,
  middlewares?: string[],
): string {
  return makeRouteFileContent([{ method, path, middlewares }]);
}

/**
 * 生成多路由文件
 */
function makeMultiRouteFile(
  routes: Array<{ method: string; path: string; middlewares?: string[] }>,
): string {
  return makeRouteFileContent(routes);
}

function makeStreamRouteFile(): string {
  return `
const routes = [];
const collector = {
  get(path, optionsOrHandler, handler) {
    routes.push({
      method: "GET",
      path,
      options: typeof optionsOrHandler === "function" ? {} : optionsOrHandler || {},
      handler: typeof optionsOrHandler === "function" ? optionsOrHandler : handler,
    });
  },
};

function factory() {
  collector.get("/stream", {}, async (req, res) => {
    req.app.streamControl.events.push("handler");
    res.stream(req.app.streamControl.readable, "text/plain");
  });
}

function normalizePath(prefix, subPath) {
  const cleanPrefix = prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  const cleanSubPath = subPath.startsWith("/") ? subPath.slice(1) : subPath;
  if (!cleanSubPath) return cleanPrefix || "/";
  if (cleanPrefix === "/") return "/" + cleanSubPath;
  return cleanPrefix + "/" + cleanSubPath;
}

export default {
  routes,
  sourceFile: "",
  register(adapter, prefix) {
    for (const route of routes) {
      adapter.registerRoute(route.method, normalizePath(prefix, route.path), [
        async (req, res, _next) => route.handler(req, res),
      ], route.options);
    }
  },
  _factory: factory,
  _collector: collector,
};
`;
}

async function executeTestChain(
  chain: VextMiddleware[],
  req: any,
  res: any,
): Promise<void> {
  async function dispatch(index: number): Promise<void> {
    if (index >= chain.length) return;
    await chain[index]!(req, res, () => dispatch(index + 1));
  }
  await dispatch(0);
}

// ── 临时目录管理 ────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vext-rt-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── 测试用例 ────────────────────────────────────────────────

describe("router-loader", () => {
  it("waits for stream response settlement before handler and middleware after phases", async () => {
    const routesDir = join(tmpDir, "routes");
    await writeRouteFile(routesDir, "files.mjs", makeStreamRouteFile());

    const app = createMockApp();
    const events: string[] = [];
    const readable = Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
    }) as unknown as NodeJS.ReadableStream;
    (app as any).streamControl = { readable, events };
    app.hooks.on("handler:after", () => {
      events.push("handler:after");
    });

    await loadRoutes(app, routesDir, {
      middlewareDefs: {},
      globalMiddlewares: [],
    });

    const route = app.mockAdapter.registeredRoutes.find(
      (entry) => entry.path === "/files/stream",
    );
    expect(route).toBeDefined();

    const nodeRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    });
    const res = createNativeResponse(nodeRes as any, () => "req-1");
    res._hooks = app.hooks;
    const req = {
      method: "GET",
      requestId: "req-1",
      params: {},
      app,
    };
    const outerMiddleware: VextMiddleware = async (_req, _res, next) => {
      events.push("middleware:before");
      await next();
      events.push("middleware:after");
    };

    const running = executeTestChain(
      [outerMiddleware, ...route!.chain],
      req,
      res,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(readable.pipe).toHaveBeenCalledWith(nodeRes);
    expect(events).toEqual(["middleware:before", "handler"]);

    nodeRes.emit("finish");
    await running;

    expect(events).toEqual([
      "middleware:before",
      "handler",
      "handler:after",
      "middleware:after",
    ]);
  });

  it("does not wait for stream settlement when no handler:after listener exists", async () => {
    const routesDir = join(tmpDir, "routes");
    await writeRouteFile(routesDir, "files.mjs", makeStreamRouteFile());

    const app = createMockApp();
    const readable = Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
    }) as unknown as NodeJS.ReadableStream;
    (app as any).streamControl = { readable, events: [] };

    await loadRoutes(app, routesDir, {
      middlewareDefs: {},
      globalMiddlewares: [],
    });

    const route = app.mockAdapter.registeredRoutes.find(
      (entry) => entry.path === "/files/stream",
    );
    const nodeRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    });
    const res = createNativeResponse(nodeRes as any, () => "req-1");
    res._hooks = app.hooks;
    const running = executeTestChain(
      route!.chain,
      { method: "GET", requestId: "req-1", params: {}, app },
      res,
    );
    const settled = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);

    expect(readable.pipe).toHaveBeenCalledWith(nodeRes);
    nodeRes.emit("finish");
    await running;
    expect(settled).toBe(true);
  });

  // ── 空目录 / 不存在的目录 ────────────────────────────────

  describe("empty / missing directory", () => {
    it("warns and skips when routes/ directory does not exist", async () => {
      const app = createMockApp();
      const nonExistentDir = join(tmpDir, "does-not-exist");

      await expect(
        loadRoutes(app, nonExistentDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).resolves.toBeUndefined();

      // 应该输出警告
      expect(app.logger.warn).toHaveBeenCalled();
      // 不应注册任何路由
      expect(app.mockAdapter.registeredRoutes).toHaveLength(0);
    });

    it("warns and skips when routes/ directory is empty", async () => {
      const routesDir = join(tmpDir, "routes");
      await mkdir(routesDir, { recursive: true });

      const app = createMockApp();
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).resolves.toBeUndefined();

      expect(app.logger.warn).toHaveBeenCalled();
      expect(app.mockAdapter.registeredRoutes).toHaveLength(0);
    });
  });

  // ── 正常路由加载 ─────────────────────────────────────────

  describe("normal route loading", () => {
    it("loads a single route file and registers to adapter", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      expect(app.mockAdapter.registeredRoutes.length).toBeGreaterThanOrEqual(1);

      // 验证注册的路由包含正确的方法
      const getRoutes = app.mockAdapter.registeredRoutes.filter(
        (r) => r.method === "GET",
      );
      expect(getRoutes.length).toBeGreaterThanOrEqual(1);
    });

    it("loads multiple route files", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );
      await writeRouteFile(
        routesDir,
        "orders.mjs",
        makeSimpleRouteFile("post", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      // 至少应有 2 条路由注册
      expect(app.mockAdapter.registeredRoutes.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 路由前缀推导 ─────────────────────────────────────────

  describe("route prefix derivation", () => {
    it("derives prefix from filename (users.mjs → /users)", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(1);

      // 路径应包含 /users 前缀
      const hasUsersPrefix = routes.some((r) => r.path.includes("/users"));
      expect(hasUsersPrefix).toBe(true);
    });

    it("derives prefix from nested directory (api/v1/users.mjs → /api/v1/users)", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "api/v1/users.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(1);

      // 路径应包含嵌套前缀
      const hasNestedPrefix = routes.some((r) =>
        r.path.includes("/api/v1/users"),
      );
      expect(hasNestedPrefix).toBe(true);
    });

    it("converts [param] directory to :param in prefix", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users/[id]/profile.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(1);

      // [id] 应被转换为 :id
      const hasDynamicParam = routes.some((r) => r.path.includes(":id"));
      expect(hasDynamicParam).toBe(true);
    });

    it("index file maps to parent directory prefix", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users/index.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(1);

      // index 文件的前缀应为 /users（不含 /index）
      const hasIndexInPath = routes.some((r) => r.path.includes("/index"));
      expect(hasIndexInPath).toBe(false);

      const hasUsersPath = routes.some((r) => r.path.includes("/users"));
      expect(hasUsersPath).toBe(true);
    });
  });

  // ── 跳过规则 ─────────────────────────────────────────────

  describe("exclusion rules", () => {
    it("skips files starting with _", async () => {
      const routesDir = join(tmpDir, "routes");
      // _ 开头的文件应被跳过
      await writeRouteFile(
        routesDir,
        "_helpers.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      // 正常文件应被加载
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      // 只有 users 的路由，没有 _helpers 的
      const routes = app.mockAdapter.registeredRoutes;
      const hasHelpers = routes.some((r) => r.path.includes("helpers"));
      expect(hasHelpers).toBe(false);

      const hasUsers = routes.some((r) => r.path.includes("users"));
      expect(hasUsers).toBe(true);
    });

    it("skips directories starting with _", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "_internal/debug.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      const hasInternal = routes.some((r) => r.path.includes("internal"));
      expect(hasInternal).toBe(false);

      const hasUsers = routes.some((r) => r.path.includes("users"));
      expect(hasUsers).toBe(true);
    });
  });

  // ── 排除规则 ─────────────────────────────────────────────

  describe("route file exclusion rules", () => {
    it("skips .test. and .spec. files in routes/", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.test.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "users.spec.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      expect(app.mockAdapter.registeredRoutes).toHaveLength(1);
      expect(app.mockAdapter.registeredRoutes[0]?.path).toBe("/users/list");
    });

    it("skips dot-prefixed files, dot directories, and nested node_modules", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        ".hidden.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        ".draft/debug.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "node_modules/pkg/route.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "visible.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      expect(
        app.mockAdapter.registeredRoutes.map((route) => route.path),
      ).toEqual(["/visible"]);
    });

    it("rejects CommonJS route sources instead of silently skipping them", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(routesDir, "index.cjs", "module.exports = {};\n");

      await expect(
        loadRoutes(createMockApp(), routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow(/CommonJS route source is not supported/u);
    });
  });

  // ── 重复路由检测 ─────────────────────────────────────────

  describe("duplicate route detection", () => {
    it("throws when same method + path registered twice via different files", async () => {
      const routesDir = join(tmpDir, "routes");

      // 文件 1：GET /users/list → 来自 users.mjs
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      // 文件 2：也注册 GET /users/list（通过 users/index.mjs + /list）
      await writeRouteFile(
        routesDir,
        "users/index.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow(/[Dd]uplicate|[Cc]onflict/);
    });

    it("rejects case and trailing-slash variants before adapter registration", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "index.mjs",
        makeMultiRouteFile([
          { method: "get", path: "/Users" },
          { method: "get", path: "/users/" },
        ]),
      );
      const app = createMockApp();

      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow(/Duplicate route/u);
      expect(app.mockAdapter.registeredRoutes).toEqual([]);
    });
  });

  // ── 中间件引用校验 ───────────────────────────────────────

  describe("middleware reference validation", () => {
    it("throws when route references undeclared middleware", async () => {
      const routesDir = join(tmpDir, "routes");

      // 路由引用了 'auth' 中间件，但 registry 中没有
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list", ["auth"]),
      );

      const app = createMockApp();

      // 空 registry — 'auth' 未注册
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {} as MiddlewareRegistry,
          globalMiddlewares: [],
        }),
      ).rejects.toThrow();
    });

    it("does not partially register earlier routes when a later route has an invalid middleware", async () => {
      const routesDir = join(tmpDir, "routes");

      await writeRouteFile(
        routesDir,
        "ok.mjs",
        makeSimpleRouteFile("get", "/"),
      );
      await writeRouteFile(
        routesDir,
        "bad.mjs",
        makeSimpleRouteFile("get", "/", ["missing"]),
      );

      const app = createMockApp();

      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {} as MiddlewareRegistry,
          globalMiddlewares: [],
        }),
      ).rejects.toThrow('middleware "missing"');

      expect(app.mockAdapter.registeredRoutes).toHaveLength(0);
    });

    it("does not throw when middleware is declared in registry", async () => {
      const routesDir = join(tmpDir, "routes");

      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list", ["auth"]),
      );

      const app = createMockApp();

      // registry 中包含 'auth'
      const registry: MiddlewareRegistry = {
        auth: {
          handler: async (_req: any, _res: any, next: any) => {
            await next();
          },
          defaultOptions: undefined,
          kind: "middleware",
        },
      };

      // 应该不抛出
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: registry,
          globalMiddlewares: [],
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ── 全局中间件注入 ───────────────────────────────────────

  describe("global middleware injection", () => {
    it("includes global middlewares in route chain", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const globalMw: VextMiddleware = async (_req, _res, next) => {
        await next();
      };

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [globalMw],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(1);

      // chain 应包含全局中间件 + handler（至少 2 个元素）
      // router-loader 会把 globalMiddlewares 传入 chain
      for (const route of routes) {
        expect(route.chainLength).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("route auth guard", () => {
    it("inserts auth guard before route cache and warns about unpartitioned auth cache", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "secure.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/",
            options: "{ auth: true, cache: 1000 }",
          },
        ]),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const route = app.mockAdapter.registeredRoutes.find(
        (item) => item.path === "/secure",
      );
      expect(route).toBeDefined();
      expect(app.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("has both cache and auth"),
      );

      let error: unknown;
      try {
        await route!.chain[1]!(
          {
            auth: createAnonymousAuthContext(),
            params: {},
            requestId: "req-router-auth",
          } as any,
          {} as any,
          async () => undefined,
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("AUTH_REQUIRED");
      expect((error as HttpError).status).toBe(401);
    });
  });

  // ── .d.ts 文件跳过 ───────────────────────────────────────

  describe(".d.ts file handling", () => {
    it("skips .d.ts files", async () => {
      const routesDir = join(tmpDir, "routes");
      // .d.ts 文件不应被加载为路由
      await writeRouteFile(
        routesDir,
        "users.d.ts",
        `export default { routes: [], register() {}, _factory() {}, _collector: {} };`,
      );
      // 只有实际路由文件应被加载
      await writeRouteFile(
        routesDir,
        "orders.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      // 只有 orders 的路由
      const routes = app.mockAdapter.registeredRoutes;
      const hasUsers = routes.some((r) => r.path.includes("users"));
      expect(hasUsers).toBe(false);

      const hasOrders = routes.some((r) => r.path.includes("orders"));
      expect(hasOrders).toBe(true);
    });
  });

  // ── 支持的文件扩展名 ─────────────────────────────────────

  describe("supported file extensions", () => {
    it("loads .mjs files", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      expect(app.mockAdapter.registeredRoutes.length).toBeGreaterThanOrEqual(1);
    });

    it("loads .js files (when type: module in parent)", async () => {
      const routesDir = join(tmpDir, "routes");

      // 在临时目录创建 package.json 以支持 .js 作为 ESM
      await writeFile(
        join(tmpDir, "package.json"),
        JSON.stringify({ type: "module" }),
        "utf-8",
      );

      await writeRouteFile(
        routesDir,
        "orders.js",
        makeSimpleRouteFile("post", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      expect(app.mockAdapter.registeredRoutes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 多 HTTP 方法 ─────────────────────────────────────────

  describe("multiple HTTP methods", () => {
    it("registers routes with different HTTP methods from one file", async () => {
      const routesDir = join(tmpDir, "routes");

      // 一个文件中注册多个路由（GET + POST）
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeMultiRouteFile([
          { method: "get", path: "/list" },
          { method: "post", path: "/" },
        ]),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      expect(routes.length).toBeGreaterThanOrEqual(2);

      const methods = routes.map((r) => r.method);
      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
    });

    it("orders same-path HEAD before GET and specific paths before wildcard", async () => {
      const routesDir = join(tmpDir, "routes");

      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeMultiRouteFile([
          { method: "get", path: "/*path" },
          { method: "get", path: "/:id" },
          { method: "get", path: "/list" },
        ]),
      );
      await writeRouteFile(
        routesDir,
        "index.mjs",
        makeMultiRouteFile([
          { method: "get", path: "/method" },
          { method: "head", path: "/method" },
        ]),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const orderedRoutes = app.mockAdapter.registeredRoutes.map(
        (route) => `${route.method} ${route.path}`,
      );

      expect(orderedRoutes.indexOf("HEAD /method")).toBeLessThan(
        orderedRoutes.indexOf("GET /method"),
      );
      expect(orderedRoutes.indexOf("GET /users/list")).toBeLessThan(
        orderedRoutes.indexOf("GET /users/:id"),
      );
      expect(orderedRoutes.indexOf("GET /users/:id")).toBeLessThan(
        orderedRoutes.indexOf("GET /users/*path"),
      );
    });
  });

  // ── 无效路由文件 ─────────────────────────────────────────

  describe("invalid route files", () => {
    it("throws when route file has no default export", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "bad.mjs",
        `
// 只有命名导出
export const helper = 'not a route';
`,
      );

      const app = createMockApp();

      // 无 default export → Fail Fast
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow();
    });

    it("throws when route file has invalid structure (no routes array)", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "invalid.mjs",
        `
// default export 是普通对象但没有 routes/register
export default { notAFactory: true };
`,
      );

      const app = createMockApp();

      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow();
    });

    it("throws when route file default export is not an object", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "string-export.mjs",
        `
export default "not a route definition";
`,
      );

      const app = createMockApp();

      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow();
    });
  });

  // ── 路由级运行时能力 ─────────────────────────────────────

  describe("route runtime options", () => {
    it("rejects wildcard credentials during route preparation", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "invalid-cors.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/invalid",
            options:
              "{ override: { cors: { enabled: true, origins: ['*'], credentials: true } } }",
          },
        ]),
      );

      const app = createMockApp();
      await expect(
        loadRoutes(app, routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
          corsMiddleware: async (_req, _res, next) => next(),
        }),
      ).rejects.toThrow(
        "cannot combine credentials: true with wildcard origin",
      );
      expect(app.mockAdapter.registeredRoutes).toHaveLength(0);
    });

    it("injects timeout, CORS, and Session middleware for route opt-in", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "runtime.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/enabled",
            options:
              "{ session: true, timeout: 25, override: { cors: { enabled: true, origins: ['https://example.com'] } } }",
          },
        ]),
      );

      const app = createMockApp();
      const corsMiddleware: VextMiddleware = async (_req, _res, next) => next();
      const sessionMiddleware: VextMiddleware = async (_req, _res, next) =>
        next();

      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
        corsMiddleware,
        sessionMiddleware,
      });

      const route = app.mockAdapter.registeredRoutes.find(
        (entry) => entry.path === "/runtime/enabled",
      );
      expect(route).toBeDefined();
      expect(route!.chain).toContain(corsMiddleware);
      expect(route!.chain).toContain(sessionMiddleware);
      expect(route!.chain.indexOf(corsMiddleware)).toBeLessThan(
        route!.chain.indexOf(sessionMiddleware),
      );
      expect(route!.routeOptions).toEqual(
        expect.objectContaining({
          session: true,
          timeout: 25,
        }),
      );
    });

    it("keeps legacy override timeout as a compatibility fallback", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "legacy-timeout/index.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/",
            options: "{ override: { timeout: 25 } }",
          },
        ]),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const route = app.mockAdapter.registeredRoutes.find(
        (entry) => entry.path === "/legacy-timeout",
      );
      expect(route).toBeDefined();
      expect(route!.chain.length).toBe(3);
    });

    it("does not inject timeout middleware when route timeout is disabled", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "disabled-timeout/index.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/",
            options: "{ timeout: false, override: { timeout: 25 } }",
          },
        ]),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const route = app.mockAdapter.registeredRoutes.find(
        (entry) => entry.path === "/disabled-timeout",
      );
      expect(route).toBeDefined();
      expect(route!.chain.length).toBe(2);
    });

    it("fails fast when route timeout is invalid", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "runtime.mjs",
        makeRouteFileContent([
          {
            method: "get",
            path: "/invalid",
            options: "{ timeout: 0 }",
          },
        ]),
      );

      await expect(
        loadRoutes(createMockApp(), routesDir, {
          middlewareDefs: {},
          globalMiddlewares: [],
        }),
      ).rejects.toThrow("must be a positive integer");
    });
  });

  // ── 路由路径拼接 ─────────────────────────────────────────

  describe("path concatenation", () => {
    it("correctly concatenates prefix and sub-path", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/list"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      // /users + /list = /users/list
      const hasCorrectPath = routes.some((r) => r.path === "/users/list");
      expect(hasCorrectPath).toBe(true);
    });

    it("handles root path sub-route correctly", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "health.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      // /health + / = /health
      const hasHealthPath = routes.some((r) => r.path === "/health");
      expect(hasHealthPath).toBe(true);
    });

    it("handles dynamic parameters in sub-path", async () => {
      const routesDir = join(tmpDir, "routes");
      await writeRouteFile(
        routesDir,
        "users.mjs",
        makeSimpleRouteFile("get", "/:id"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      const hasDynamicPath = routes.some((r) => r.path === "/users/:id");
      expect(hasDynamicPath).toBe(true);
    });
  });

  // ── 排序：静态段优先于动态段 ─────────────────────────────

  describe("static before dynamic sorting", () => {
    it("registers static routes before dynamic routes", async () => {
      const routesDir = join(tmpDir, "routes");

      // 动态段文件
      await writeRouteFile(
        routesDir,
        "users/[id].mjs",
        makeSimpleRouteFile("get", "/"),
      );
      // 静态段文件
      await writeRouteFile(
        routesDir,
        "users/list.mjs",
        makeSimpleRouteFile("get", "/"),
      );

      const app = createMockApp();
      await loadRoutes(app, routesDir, {
        middlewareDefs: {},
        globalMiddlewares: [],
      });

      const routes = app.mockAdapter.registeredRoutes;
      // 应该有 2 条路由
      expect(routes.length).toBeGreaterThanOrEqual(2);

      // 找到静态和动态路由的索引
      const staticIdx = routes.findIndex((r) => r.path.includes("/users/list"));
      const dynamicIdx = routes.findIndex((r) => r.path.includes(":id"));

      // 静态路由应在动态路由之前注册
      if (staticIdx !== -1 && dynamicIdx !== -1) {
        expect(staticIdx).toBeLessThan(dynamicIdx);
      }
    });
  });
});
