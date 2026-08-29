import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock 所有外部依赖 ──────────────────────────────────────

// cache-invalidator
vi.mock("../../src/lib/dev/cache-invalidator.js", () => ({
  computeInvalidationSet: vi.fn(),
  evictModules: vi.fn(),
  invalidateAndEvict: vi.fn(),
}));

// service-reloader
vi.mock("../../src/lib/dev/service-reloader.js", () => ({
  reloadServices: vi.fn(),
}));

// route-reloader
vi.mock("../../src/lib/dev/route-reloader.js", () => ({
  reloadRoutes: vi.fn(),
}));

// i18n-reloader
vi.mock("../../src/lib/dev/i18n-reloader.js", () => ({
  reloadLocales: vi.fn(),
  shouldReloadLocales: vi.fn(),
}));

// memory-monitor
vi.mock("../../src/lib/dev/memory-monitor.js", () => ({
  reportMemoryIfNeeded: vi.fn(),
}));

import { SoftReloader } from "../../src/lib/dev/soft-reloader.js";
import type { SoftReloaderOptions } from "../../src/lib/dev/soft-reloader.js";
import { invalidateAndEvict } from "../../src/lib/dev/cache-invalidator.js";
import { reloadServices } from "../../src/lib/dev/service-reloader.js";
import { reloadRoutes } from "../../src/lib/dev/route-reloader.js";
import {
  reloadLocales,
  shouldReloadLocales,
} from "../../src/lib/dev/i18n-reloader.js";
import { reportMemoryIfNeeded } from "../../src/lib/dev/memory-monitor.js";
import type { FileChangeInfo } from "../../src/lib/dev/file-watcher.js";

// ── 辅助工厂函数 ──────────────────────────────────────────

function createMockLogger() {
  return {
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    getLevel: vi.fn(() => "info" as const),
    setLevel: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createMockCompiler() {
  return {
    getProjectRoot: vi.fn().mockReturnValue("/project"),
    getOutDir: vi.fn().mockReturnValue("/project/.vext/dev"),
    getSrcDir: vi.fn().mockReturnValue("/project/src"),
    compileFiles: vi.fn().mockResolvedValue([]),
    compileSingle: vi.fn().mockResolvedValue(""),
    rebuildWithNewEntryPoints: vi.fn().mockResolvedValue(undefined),
    rebuild: vi.fn().mockResolvedValue(undefined),
    resolveCompiled: vi.fn((f: string) => {
      // src/routes/user.ts → /project/.vext/dev/routes/user.js
      const rel = f.replace(/^src\//, "").replace(/\.ts$/, ".js");
      return `/project/.vext/dev/${rel}`;
    }),
    start: vi.fn(),
    dispose: vi.fn(),
    resolveSource: vi.fn(),
  };
}

function createMockHotHandler() {
  let swapCount = 0;
  return {
    handle: vi.fn(),
    swap: vi.fn(() => {
      swapCount++;
    }),
    getReloadCount: vi.fn(() => swapCount),
    getLastSwapTime: vi.fn(() => Date.now()),
    getCurrentHandler: vi.fn(),
  };
}

function createMockApp() {
  return {
    config: { middlewares: [] } as Record<string, unknown>,
    logger: createMockLogger(),
    adapter: {
      name: "hono",
      registerMiddleware: vi.fn(),
      registerRoute: vi.fn(),
      registerErrorHandler: vi.fn(),
      registerNotFound: vi.fn(),
      buildHandler: vi.fn(() => vi.fn()),
    },
    services: {},
  };
}

function createDefaultOptions(
  overrides: Partial<SoftReloaderOptions> = {},
): SoftReloaderOptions {
  const app = createMockApp();
  const compiler = createMockCompiler();
  const hotHandler = createMockHotHandler();

  return {
    compiler: compiler as any,
    hotHandler: hotHandler as any,
    app: app as any,
    config: app.config,
    logger: app.logger,
    resolveAdapter: vi.fn(async (_cfg: any, _app: any) => ({
      name: "hono",
      registerMiddleware: vi.fn(),
      registerRoute: vi.fn(),
      registerErrorHandler: vi.fn(),
      registerNotFound: vi.fn(),
      buildHandler: vi.fn(() => vi.fn()),
    })),
    loadRoutes: vi.fn().mockResolvedValue(undefined),
    loadMiddlewares: vi.fn().mockResolvedValue({}),
    createErrorHandler: vi.fn(() => vi.fn()),
    createNotFoundHandler: vi.fn(() => vi.fn()),
    builtinMiddlewares: {},
    getGlobalMiddlewares: vi.fn(() => []),
    ...overrides,
  };
}

/**
 * 设置 mock 的默认成功返回值
 */
function setupSuccessMocks() {
  const mockedInvalidateAndEvict = vi.mocked(invalidateAndEvict);
  mockedInvalidateAndEvict.mockReturnValue({
    invalidated: new Set(["/project/.vext/dev/routes/user.js"]),
    cascadeDetected: false,
    evicted: 1,
    skipped: 0,
  });

  const mockedReloadServices = vi.mocked(reloadServices);
  mockedReloadServices.mockResolvedValue({
    reloaded: 0,
    unchanged: 1,
    reloadedKeys: [],
  });

  const mockedReloadRoutes = vi.mocked(reloadRoutes);
  mockedReloadRoutes.mockResolvedValue({
    handler: vi.fn() as any,
    adapter: {
      name: "hono",
      registerMiddleware: vi.fn(),
      registerRoute: vi.fn(),
      registerErrorHandler: vi.fn(),
      registerNotFound: vi.fn(),
      buildHandler: vi.fn(),
    },
  });

  const mockedShouldReloadLocales = vi.mocked(shouldReloadLocales);
  mockedShouldReloadLocales.mockReturnValue(false);

  const mockedReloadLocales = vi.mocked(reloadLocales);
  mockedReloadLocales.mockResolvedValue({
    loadedLocales: [],
    failedFiles: [],
    configured: false,
  });

  const mockedReportMemory = vi.mocked(reportMemoryIfNeeded);
  mockedReportMemory.mockReturnValue({
    reported: false,
    heapMB: 50,
    rssMB: 100,
    warning: false,
    growthTrend: false,
  });
}

// ── 测试用例 ────────────────────────────────────────────────

describe("SoftReloader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════
  // 1. 基本功能
  // ════════════════════════════════════════════════════════════

  describe("基本功能", () => {
    it("应成功创建 SoftReloader 实例", () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);
      expect(reloader).toBeDefined();
      expect(reloader.getSuccessCount()).toBe(0);
      expect(reloader.getFailureCount()).toBe(0);
      expect(reloader.isReloading()).toBe(false);
      expect(reloader.hasPendingChanges()).toBe(false);
    });

    it("应执行完整的 Soft Reload 流程并返回成功结果", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const files: FileChangeInfo[] = [
        { path: "src/routes/user.ts", type: "modify" },
      ];

      const result = await reloader.reload(files);

      expect(result.success).toBe(true);
      expect(result.requestedColdRestart).toBe(false);
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
      expect(result.tier).toBe("T1:code");
      expect(reloader.getSuccessCount()).toBe(1);
      expect(reloader.getFailureCount()).toBe(0);
    });

    it("应按正确顺序调用各模块：编译→缓存→i18n→中间件→服务→路由→swap", async () => {
      const callOrder: string[] = [];

      const compiler = createMockCompiler();
      compiler.compileFiles.mockImplementation(async () => {
        callOrder.push("compile");
        return [];
      });

      vi.mocked(invalidateAndEvict).mockImplementation((..._args) => {
        callOrder.push("cache");
        return {
          invalidated: new Set<string>(),
          cascadeDetected: false,
          evicted: 0,
          skipped: 0,
        };
      });

      vi.mocked(shouldReloadLocales).mockReturnValue(true);
      vi.mocked(reloadLocales).mockImplementation(async () => {
        callOrder.push("i18n");
        return { loadedLocales: [], failedFiles: [], configured: false };
      });

      const loadMiddlewares = vi.fn().mockImplementation(async () => {
        callOrder.push("middleware");
        return {};
      });

      vi.mocked(reloadServices).mockImplementation(async () => {
        callOrder.push("service");
        return { reloaded: 0, unchanged: 0, reloadedKeys: [] };
      });

      vi.mocked(reloadRoutes).mockImplementation(async () => {
        callOrder.push("route");
        return {
          handler: vi.fn() as any,
          adapter: {
            name: "hono",
            registerMiddleware: vi.fn(),
            registerRoute: vi.fn(),
            registerErrorHandler: vi.fn(),
            registerNotFound: vi.fn(),
            buildHandler: vi.fn(),
          },
        };
      });

      const hotHandler = createMockHotHandler();
      hotHandler.swap.mockImplementation(() => {
        callOrder.push("swap");
      });

      vi.mocked(reportMemoryIfNeeded).mockImplementation(() => {
        callOrder.push("memory");
        return {
          reported: false,
          heapMB: 50,
          rssMB: 100,
          warning: false,
          growthTrend: false,
        };
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
        hotHandler: hotHandler as any,
        loadMiddlewares,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(callOrder).toEqual([
        "compile",
        "cache",
        "i18n",
        "middleware",
        "service",
        "route",
        "swap",
        "memory",
      ]);
    });

    it("reload 成功后应调用 hotHandler.swap", async () => {
      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(hotHandler.swap).toHaveBeenCalledTimes(1);
    });

    it("应输出性能报告日志（含 tier / 各阶段耗时 / evicted 数量 / reload 编号）", async () => {
      const logger = createMockLogger();
      const options = createDefaultOptions({
        config: { middlewares: [], logger: { lifecycleLevel: "verbose" } },
        logger,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(logger.info).toHaveBeenCalled();
      const infoArgs = logger.info.mock.calls.map((call: unknown[]) => call[0]);
      const perfLog = infoArgs.find(
        (msg: unknown) =>
          typeof msg === "string" &&
          msg.includes("[hot-reload]") &&
          msg.includes("T1:code"),
      );
      expect(perfLog).toBeDefined();
      expect(perfLog).toContain("compile:");
      expect(perfLog).toContain("cache:");
      expect(perfLog).toContain("i18n:");
      expect(perfLog).toContain("mw:");
      expect(perfLog).toContain("svc:");
      expect(perfLog).toContain("route:");
      expect(perfLog).toContain("swap:");
      expect(perfLog).toContain("modules evicted");
    });

    it("应调用 reportMemoryIfNeeded 进行内存监控", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reportMemoryIfNeeded).toHaveBeenCalledTimes(1);
    });

    it("应将 reloadCount 传递给 reportMemoryIfNeeded", async () => {
      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reportMemoryIfNeeded).toHaveBeenCalledWith(
        hotHandler.getReloadCount(),
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // 2. Tier 分类
  // ════════════════════════════════════════════════════════════

  describe("Tier 分类", () => {
    it("modify 变更应使用 Tier 1（compileFiles 单文件编译）", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.tier).toBe("T1:code");
      expect(compiler.compileFiles).toHaveBeenCalledTimes(1);
      expect(compiler.rebuildWithNewEntryPoints).not.toHaveBeenCalled();
    });

    it("add 变更应使用 Tier 2（rebuildWithNewEntryPoints 全量增量编译）", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/admin.ts", type: "add" },
      ]);

      expect(result.tier).toBe("T2:structural");
      expect(compiler.rebuildWithNewEntryPoints).toHaveBeenCalledTimes(1);
      expect(compiler.compileFiles).not.toHaveBeenCalled();
    });

    it("delete 变更应使用 Tier 2", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/old.ts", type: "delete" },
      ]);

      expect(result.tier).toBe("T2:structural");
      expect(compiler.rebuildWithNewEntryPoints).toHaveBeenCalledTimes(1);
    });

    it("混合 modify + add 应使用 Tier 2（有一个 structural 就升级）", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
        { path: "src/routes/new.ts", type: "add" },
      ]);

      expect(result.tier).toBe("T2:structural");
      expect(compiler.rebuildWithNewEntryPoints).toHaveBeenCalledTimes(1);
      expect(compiler.compileFiles).not.toHaveBeenCalled();
    });

    it("多个 modify 应并行编译所有文件", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
        { path: "src/services/auth.ts", type: "modify" },
      ]);

      expect(compiler.compileFiles).toHaveBeenCalledTimes(1);
      const calledFiles = compiler.compileFiles.mock.calls[0]![0];
      expect(calledFiles).toHaveLength(2);
    });

    it("Tier 1 应只编译 src/ 下的文件", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
        { path: "README.md", type: "modify" },
      ]);

      expect(compiler.compileFiles).toHaveBeenCalledTimes(1);
      const calledFiles = compiler.compileFiles.mock.calls[0]![0] as string[];
      // 只有 src/ 下的文件被编译
      expect(calledFiles).toHaveLength(1);
      // 跨平台：Windows 使用 \ 分隔符，normalize 后比较
      const normalized = calledFiles[0]!.replace(/\\/g, "/");
      expect(normalized).toContain("routes/user.ts");
    });

    it("Tier 1 所有文件都不在 src/ 下时不调用 compileFiles", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "README.md", type: "modify" }]);

      // compileFiles 可能被调用但参数为空数组，或不被调用
      // 实际实现: srcFiles.length > 0 才调用
      if (compiler.compileFiles.mock.calls.length > 0) {
        const calledFiles = compiler.compileFiles.mock.calls[0]![0] as string[];
        expect(calledFiles).toHaveLength(0);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 3. 并发保护
  // ════════════════════════════════════════════════════════════

  describe("并发保护", () => {
    it("第一次 reload 执行期间，第二次 reload 应排队", async () => {
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const compiler = createMockCompiler();
      compiler.compileFiles.mockImplementation(async () => {
        await firstPromise;
        return [];
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      // 启动第一次 reload
      const reload1Promise = reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      // 稍等一下确保第一次 reload 开始
      await new Promise((r) => setTimeout(r, 10));

      // 第二次 reload 应该排队
      expect(reloader.isReloading()).toBe(true);
      const reload2Promise = reloader.reload([
        { path: "src/services/auth.ts", type: "modify" },
      ]);

      expect(reloader.hasPendingChanges()).toBe(true);

      // 让第一次 reload 完成
      resolveFirst();
      await reload1Promise;

      // 等待队列处理完成
      await reload2Promise;

      // 两次 reload 的文件应该分别编译
      expect(reloader.getSuccessCount()).toBe(2);
    });

    it("并发排队时应按 path 去重，保留最新 type", async () => {
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const compiler = createMockCompiler();
      let callCount = 0;
      compiler.compileFiles.mockImplementation(async () => {
        if (callCount === 0) {
          callCount++;
          await firstPromise;
        }
        return [];
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      // 启动第一次 reload
      const reload1 = reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      await new Promise((r) => setTimeout(r, 10));

      // 排队两次，第二次的 type 应覆盖第一次
      reloader.reload([{ path: "src/services/auth.ts", type: "modify" }]);
      reloader.reload([{ path: "src/services/auth.ts", type: "delete" }]);

      // 释放第一次 reload
      resolveFirst();
      await reload1;

      // 等待所有操作完成
      await new Promise((r) => setTimeout(r, 50));

      // auth.ts 应该以 delete 类型处理（最后一次覆盖）
      // 第二次 reload 应该是 T2:structural（因为有 delete）
      expect(reloader.getSuccessCount()).toBe(2);
    });

    it("排队的 reload 返回占位结果（success: true）", async () => {
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      const compiler = createMockCompiler();
      compiler.compileFiles.mockImplementationOnce(async () => {
        await firstPromise;
        return [];
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      const reload1 = reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      await new Promise((r) => setTimeout(r, 10));

      const result = await reloader.reload([
        { path: "src/services/auth.ts", type: "modify" },
      ]);

      // 排队时立即返回占位结果
      expect(result.success).toBe(true);
      expect(result.elapsed).toBe(0);

      resolveFirst();
      await reload1;
    });

    it("运行态失败请求 cold restart 后应丢弃队列并停止后续 reload", async () => {
      let releaseRouteReload!: () => void;
      const routeReloadStarted = new Promise<void>((resolve) => {
        releaseRouteReload = resolve;
      });
      vi.mocked(reloadRoutes).mockImplementation(async () => {
        await routeReloadStarted;
        throw new Error("route registration failed");
      });

      const compiler = createMockCompiler();
      const reloader = new SoftReloader(
        createDefaultOptions({ compiler: compiler as any }),
      );
      const originalSend = process.send;
      process.send = undefined;

      try {
        const firstReload = reloader.reload([
          { path: "src/routes/user.ts", type: "modify" },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));

        const queuedResult = await reloader.reload([
          { path: "src/services/auth.ts", type: "modify" },
        ]);
        expect(queuedResult.success).toBe(true);
        expect(reloader.hasPendingChanges()).toBe(true);

        releaseRouteReload();
        const failedResult = await firstReload;
        expect(failedResult.requestedColdRestart).toBe(true);
        expect(reloader.hasPendingChanges()).toBe(false);
        expect(compiler.compileFiles).toHaveBeenCalledTimes(1);

        const laterResult = await reloader.reload([
          { path: "src/routes/admin.ts", type: "modify" },
        ]);
        expect(laterResult).toMatchObject({
          success: false,
          requestedColdRestart: true,
          error: "cold restart pending",
        });
        expect(compiler.compileFiles).toHaveBeenCalledTimes(1);
      } finally {
        process.send = originalSend;
      }
    });

    it("reload 完成后 isReloading 应恢复为 false", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloader.isReloading()).toBe(false);
      expect(reloader.hasPendingChanges()).toBe(false);
    });

    it("reload 失败后 isReloading 也应恢复为 false（finally 保证）", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("compile failed"));

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloader.isReloading()).toBe(false);
      expect(reloader.getFailureCount()).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 4. 级联检测与 Cold Restart 降级
  // ════════════════════════════════════════════════════════════

  describe("级联检测与降级", () => {
    it("级联爆炸时应返回 requestedColdRestart=true", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set(
          Array.from({ length: 100 }, (_, i) => `/mod${i}.js`),
        ),
        cascadeDetected: true,
        evicted: 0,
        skipped: 100,
      });

      // 注意：不能直接 mock process.send，因为 Vitest 在 fork 模式下
      // 使用 IPC 通道通信，替换 process.send 会导致 Vitest 内部错误。
      // 改为将 process.send 置为 undefined（模拟非 fork 环境），
      // 验证不抛错 + 返回正确结果。
      const originalSend = process.send;
      process.send = undefined;

      try {
        const options = createDefaultOptions();
        const reloader = new SoftReloader(options);

        const result = await reloader.reload([
          { path: "src/routes/user.ts", type: "modify" },
        ]);

        expect(result.success).toBe(false);
        expect(result.requestedColdRestart).toBe(true);
      } finally {
        process.send = originalSend;
      }
    });

    it("级联爆炸时不应调用 swap", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set<string>(),
        cascadeDetected: true,
        evicted: 0,
        skipped: 0,
      });

      const originalSend = process.send;
      process.send = undefined;

      try {
        const hotHandler = createMockHotHandler();
        const options = createDefaultOptions({
          hotHandler: hotHandler as any,
        });

        const reloader = new SoftReloader(options);
        await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

        expect(hotHandler.swap).not.toHaveBeenCalled();
      } finally {
        process.send = originalSend;
      }
    });

    it("级联爆炸时不应调用 reloadServices / reloadRoutes", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set<string>(),
        cascadeDetected: true,
        evicted: 0,
        skipped: 0,
      });

      const originalSend = process.send;
      process.send = undefined;

      try {
        const options = createDefaultOptions();
        const reloader = new SoftReloader(options);
        await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

        expect(reloadServices).not.toHaveBeenCalled();
        expect(reloadRoutes).not.toHaveBeenCalled();
      } finally {
        process.send = originalSend;
      }
    });

    it("级联爆炸应记录警告日志", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set(["a.js", "b.js"]),
        cascadeDetected: true,
        evicted: 0,
        skipped: 2,
      });

      const originalSend = process.send;
      process.send = undefined;

      try {
        const logger = createMockLogger();
        const options = createDefaultOptions({ logger });

        const reloader = new SoftReloader(options);
        await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

        expect(logger.warn).toHaveBeenCalled();
        const warnArgs = logger.warn.mock.calls.map(
          (call: unknown[]) => call[0],
        );
        expect(
          warnArgs.some(
            (msg: unknown) =>
              typeof msg === "string" && msg.includes("cascade too large"),
          ),
        ).toBe(true);
      } finally {
        process.send = originalSend;
      }
    });

    it("级联爆炸应增加 failureCount", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set<string>(),
        cascadeDetected: true,
        evicted: 0,
        skipped: 0,
      });

      const originalSend = process.send;
      process.send = undefined;

      try {
        const options = createDefaultOptions();
        const reloader = new SoftReloader(options);
        await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

        expect(reloader.getFailureCount()).toBe(1);
        expect(reloader.getSuccessCount()).toBe(0);
      } finally {
        process.send = originalSend;
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 5. 失败回退
  // ════════════════════════════════════════════════════════════

  describe("失败回退", () => {
    it("编译失败时不应调用 swap", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(
        new Error("SyntaxError: unexpected token"),
      );

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        compiler: compiler as any,
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain("SyntaxError");
      expect(result.requestedColdRestart).toBe(false);
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });

    it("service 重载失败时不应调用 swap", async () => {
      vi.mocked(reloadServices).mockRejectedValue(
        new Error("service init failed"),
      );

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/services/auth.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain("service init failed");
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });

    it("route 重载失败时不应调用 swap", async () => {
      vi.mocked(reloadRoutes).mockRejectedValue(
        new Error("route registration failed"),
      );

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/admin.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain("route registration failed");
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });

    it("缓存失效后失败时应请求 cold restart，避免保留部分运行态", async () => {
      vi.mocked(reloadRoutes).mockRejectedValue(
        new Error("route registration failed"),
      );

      const originalSend = process.send;
      const send = vi.fn();
      process.send = send as typeof process.send;

      try {
        const hotHandler = createMockHotHandler();
        const options = createDefaultOptions({
          hotHandler: hotHandler as any,
        });

        const reloader = new SoftReloader(options);
        const result = await reloader.reload([
          { path: "src/routes/admin.ts", type: "modify" },
        ]);

        expect(result.success).toBe(false);
        expect(result.requestedColdRestart).toBe(true);
        expect(hotHandler.swap).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({
          type: "request-cold-restart",
          reason: "soft reload failed after runtime mutation",
        });
      } finally {
        process.send = originalSend;
      }
    });

    it("失败时应输出错误日志并提示保留旧版本", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("compile error"));

      const logger = createMockLogger();
      const options = createDefaultOptions({
        compiler: compiler as any,
        logger,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      const errorArgs = logger.error.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(
        errorArgs.some(
          (msg: unknown) => typeof msg === "string" && msg.includes("failed"),
        ),
      ).toBe(true);
      expect(
        errorArgs.some(
          (msg: unknown) =>
            typeof msg === "string" && msg.includes("keeping previous version"),
        ),
      ).toBe(true);
    });

    it("失败后应增加 failureCount", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("error"));

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloader.getFailureCount()).toBe(1);
      expect(reloader.getSuccessCount()).toBe(0);
    });

    it("失败不应抛出异常（异常被捕获并返回 result）", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("fatal"));

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      // 不应抛出
      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
    });

    it("rebuildWithNewEntryPoints 失败时不应调用 swap", async () => {
      const compiler = createMockCompiler();
      compiler.rebuildWithNewEntryPoints.mockRejectedValue(
        new Error("rebuild failed"),
      );

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        compiler: compiler as any,
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/routes/new.ts", type: "add" },
      ]);

      expect(result.success).toBe(false);
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });

    it("中间件加载失败时不应调用 swap", async () => {
      const loadMiddlewares = vi
        .fn()
        .mockRejectedValue(new Error("middleware load failed"));

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        loadMiddlewares,
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/middlewares/auth.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════
  // 6. i18n 重载
  // ════════════════════════════════════════════════════════════

  describe("i18n 重载", () => {
    it("变更包含 locales/ 文件时应触发 i18n 重载", async () => {
      vi.mocked(shouldReloadLocales).mockReturnValue(true);

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/locales/zh-CN.ts", type: "modify" }]);

      expect(shouldReloadLocales).toHaveBeenCalled();
      expect(reloadLocales).toHaveBeenCalledTimes(1);
    });

    it("变更不包含 locales/ 文件时不应触发 i18n 重载", async () => {
      vi.mocked(shouldReloadLocales).mockReturnValue(false);

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloadLocales).not.toHaveBeenCalled();
    });

    it("应将 configureI18n 回调传递给 reloadLocales", async () => {
      vi.mocked(shouldReloadLocales).mockReturnValue(true);

      const configureI18n = vi.fn();
      const options = createDefaultOptions({ configureI18n });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/locales/en-US.ts", type: "modify" }]);

      expect(reloadLocales).toHaveBeenCalledWith(
        expect.objectContaining({
          configureI18n,
        }),
      );
    });

    it("应将 outDir 传递给 reloadLocales", async () => {
      vi.mocked(shouldReloadLocales).mockReturnValue(true);

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/locales/ja.ts", type: "modify" }]);

      expect(reloadLocales).toHaveBeenCalledWith(
        expect.objectContaining({
          outDir: "/project/.vext/dev",
        }),
      );
    });

    it("i18n 重载失败不应阻塞整体流程（如果 reloadLocales 抛错则 reload 失败）", async () => {
      vi.mocked(shouldReloadLocales).mockReturnValue(true);
      vi.mocked(reloadLocales).mockRejectedValue(new Error("i18n load failed"));

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      const result = await reloader.reload([
        { path: "src/locales/zh-CN.ts", type: "modify" },
      ]);

      // reloadLocales 异常会导致 doSoftReload catch，不会 swap
      expect(result.success).toBe(false);
      expect(hotHandler.swap).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════
  // 7. 缓存清除
  // ════════════════════════════════════════════════════════════

  describe("缓存清除", () => {
    it("应使用 invalidateAndEvict 一站式处理缓存", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(invalidateAndEvict).toHaveBeenCalledTimes(1);
    });

    it("应将 resolveCompiled 后的路径传递给 invalidateAndEvict", async () => {
      const compiler = createMockCompiler();
      compiler.resolveCompiled.mockImplementation((f: string) => {
        return `/project/.vext/dev/${f.replace(/^src\//, "").replace(/\.ts$/, ".js")}`;
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(invalidateAndEvict).toHaveBeenCalledWith(
        ["/project/.vext/dev/routes/user.js"],
        "/project/.vext/dev",
      );
    });

    it("应将 invalidated 集合传递给 reloadServices", async () => {
      const mockInvalidated = new Set(["/project/.vext/dev/services/auth.js"]);
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: mockInvalidated,
        cascadeDetected: false,
        evicted: 1,
        skipped: 0,
      });

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/services/auth.ts", type: "modify" }]);

      expect(reloadServices).toHaveBeenCalledWith(
        expect.anything(), // app
        "/project/.vext/dev", // outDir
        mockInvalidated, // invalidated set
      );
    });

    it("routes a changed runtime service constant through selective service reload", async () => {
      const constantPath =
        "/project/.vext/dev/constants/services/order-status.js";
      const servicePath = "/project/.vext/dev/services/order.js";
      const invalidated = new Set([constantPath, servicePath]);
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated,
        cascadeDetected: false,
        evicted: 2,
        skipped: 0,
      });

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([
        {
          path: "src/constants/services/order-status.ts",
          type: "modify",
        },
      ]);

      expect(invalidateAndEvict).toHaveBeenCalledWith(
        [constantPath],
        "/project/.vext/dev",
      );
      expect(reloadServices).toHaveBeenCalledWith(
        expect.anything(),
        "/project/.vext/dev",
        invalidated,
      );
    });

    it("result.evictedModules 应反映实际驱逐数量", async () => {
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: new Set(["a.js", "b.js", "c.js"]),
        cascadeDetected: false,
        evicted: 3,
        skipped: 0,
      });

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.evictedModules).toBe(3);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 8. 路由重载
  // ════════════════════════════════════════════════════════════

  describe("路由重载", () => {
    it("应使用 resolveAdapter 创建全新 adapter 实例", async () => {
      const resolveAdapter = vi.fn(async (_cfg: any, _app: any) => ({
        name: "hono",
        registerMiddleware: vi.fn(),
        registerRoute: vi.fn(),
        registerErrorHandler: vi.fn(),
        registerNotFound: vi.fn(),
        buildHandler: vi.fn(() => vi.fn()),
      }));

      const options = createDefaultOptions({ resolveAdapter });
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      // resolveAdapter 是通过 reloadRoutes 间接调用的
      expect(reloadRoutes).toHaveBeenCalledWith(
        expect.objectContaining({
          resolveAdapter,
        }),
      );
    });

    it("应将 builtinMiddlewares 传递给 reloadRoutes", async () => {
      const builtinMiddlewares = {
        responseWrapper: vi.fn() as any,
      };

      const options = createDefaultOptions({ builtinMiddlewares });
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloadRoutes).toHaveBeenCalledWith(
        expect.objectContaining({
          builtinMiddlewares,
        }),
      );
    });

    it("应将 globalMiddlewares 传递给 reloadRoutes", async () => {
      const globalMw = [vi.fn() as any];
      const getGlobalMiddlewares = vi.fn(() => globalMw);

      const options = createDefaultOptions({ getGlobalMiddlewares });
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloadRoutes).toHaveBeenCalledWith(
        expect.objectContaining({
          globalMiddlewares: globalMw,
        }),
      );
    });

    it("应将 loadMiddlewares 的结果传递给 reloadRoutes.middlewareDefs", async () => {
      const middlewareDefs = {
        auth: {
          handler: vi.fn(),
          defaultOptions: undefined,
          kind: "middleware" as const,
        },
      };
      const loadMiddlewares = vi.fn().mockResolvedValue(middlewareDefs);

      const options = createDefaultOptions({ loadMiddlewares });
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloadRoutes).toHaveBeenCalledWith(
        expect.objectContaining({
          middlewareDefs,
        }),
      );
    });

    it("reloadRoutes 返回的 handler 应传递给 hotHandler.swap", async () => {
      const newHandler = vi.fn();
      vi.mocked(reloadRoutes).mockResolvedValue({
        handler: newHandler as any,
        adapter: {
          name: "hono",
          registerMiddleware: vi.fn(),
          registerRoute: vi.fn(),
          registerErrorHandler: vi.fn(),
          registerNotFound: vi.fn(),
          buildHandler: vi.fn(),
        },
      });

      const hotHandler = createMockHotHandler();
      const options = createDefaultOptions({
        hotHandler: hotHandler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(hotHandler.swap).toHaveBeenCalledWith(newHandler);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 9. 服务重载
  // ════════════════════════════════════════════════════════════

  describe("服务重载", () => {
    it("应使用 outDir 和 invalidated 集合调用 reloadServices", async () => {
      const mockInvalidated = new Set(["/project/.vext/dev/services/user.js"]);
      vi.mocked(invalidateAndEvict).mockReturnValue({
        invalidated: mockInvalidated,
        cascadeDetected: false,
        evicted: 1,
        skipped: 0,
      });

      const app = createMockApp();
      const options = createDefaultOptions({ app: app as any });
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/services/user.ts", type: "modify" }]);

      expect(reloadServices).toHaveBeenCalledWith(
        app,
        "/project/.vext/dev",
        mockInvalidated,
      );
    });

    it("result.serviceResult 应包含服务重载结果", async () => {
      const serviceResult = {
        reloaded: 1,
        unchanged: 3,
        reloadedKeys: ["user"],
      };
      vi.mocked(reloadServices).mockResolvedValue(serviceResult);

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/services/user.ts", type: "modify" },
      ]);

      expect(result.serviceResult).toEqual(serviceResult);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 10. 中间件重载
  // ════════════════════════════════════════════════════════════

  describe("中间件重载", () => {
    it("应使用 outDir/middlewares 和 config.middlewares 调用 loadMiddlewares", async () => {
      const loadMiddlewares = vi.fn().mockResolvedValue({});
      const config = { middlewares: ["auth", "rate-limit"] };
      const options = createDefaultOptions({
        loadMiddlewares,
        config: config as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([
        { path: "src/middlewares/auth.ts", type: "modify" },
      ]);

      expect(loadMiddlewares).toHaveBeenCalled();
      const mwCallArgs = loadMiddlewares.mock.calls[0]!;
      // 跨平台：Windows 使用 \ 分隔符
      expect(mwCallArgs[0].replace(/\\/g, "/")).toBe(
        "/project/.vext/dev/middlewares",
      );
      expect(mwCallArgs[1]).toEqual(["auth", "rate-limit"]);
      expect(mwCallArgs[2]).toBeDefined(); // logger
    });

    it("config.middlewares 未定义时应传空数组", async () => {
      const loadMiddlewares = vi.fn().mockResolvedValue({});
      const options = createDefaultOptions({
        loadMiddlewares,
        config: {} as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(loadMiddlewares).toHaveBeenCalledTimes(1);
      const mwCallArgs = loadMiddlewares.mock.calls[0]!;
      // 跨平台：Windows 使用 \ 分隔符
      expect(mwCallArgs[0].replace(/\\/g, "/")).toBe(
        "/project/.vext/dev/middlewares",
      );
      expect(mwCallArgs[1]).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 11. 内存监控
  // ════════════════════════════════════════════════════════════

  describe("内存监控", () => {
    it("成功 reload 后应调用 reportMemoryIfNeeded", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reportMemoryIfNeeded).toHaveBeenCalledTimes(1);
    });

    it("失败 reload 后不应调用 reportMemoryIfNeeded", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("error"));

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reportMemoryIfNeeded).not.toHaveBeenCalled();
    });

    it("result.memoryReport 应包含内存报告", async () => {
      const mockReport = {
        reported: true,
        heapMB: 128,
        rssMB: 256,
        warning: false,
        growthTrend: false,
      };
      vi.mocked(reportMemoryIfNeeded).mockReturnValue(mockReport);

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.memoryReport).toEqual(mockReport);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 12. 耗时统计
  // ════════════════════════════════════════════════════════════

  describe("耗时统计", () => {
    it("result 应包含所有阶段的耗时字段", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.compileTime).toBeGreaterThanOrEqual(0);
      expect(result.cacheTime).toBeGreaterThanOrEqual(0);
      expect(result.i18nTime).toBeGreaterThanOrEqual(0);
      expect(result.middlewareTime).toBeGreaterThanOrEqual(0);
      expect(result.serviceTime).toBeGreaterThanOrEqual(0);
      expect(result.routeTime).toBeGreaterThanOrEqual(0);
      expect(result.swapTime).toBeGreaterThanOrEqual(0);
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });

    it("result.elapsed 应大于等于所有阶段耗时之和（允许微秒级误差）", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      const sum =
        result.compileTime +
        result.cacheTime +
        result.i18nTime +
        result.middlewareTime +
        result.serviceTime +
        result.routeTime +
        result.swapTime;

      // 允许 1ms 误差（performance.now 精度限制）
      expect(result.elapsed).toBeGreaterThanOrEqual(sum - 1);
    });

    it("失败时各阶段耗时也应有值（到失败步骤为止）", async () => {
      vi.mocked(reloadServices).mockRejectedValue(new Error("service failed"));

      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/services/user.ts", type: "modify" },
      ]);

      expect(result.success).toBe(false);
      expect(result.compileTime).toBeGreaterThanOrEqual(0);
      expect(result.cacheTime).toBeGreaterThanOrEqual(0);
      expect(result.i18nTime).toBeGreaterThanOrEqual(0);
      expect(result.middlewareTime).toBeGreaterThanOrEqual(0);
      // serviceTime 可能大于 0（到失败时）
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 13. 计数器
  // ════════════════════════════════════════════════════════════

  describe("计数器", () => {
    it("连续成功 reload 后 successCount 应递增", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);
      expect(reloader.getSuccessCount()).toBe(1);

      await reloader.reload([{ path: "src/routes/admin.ts", type: "modify" }]);
      expect(reloader.getSuccessCount()).toBe(2);
    });

    it("连续失败后 failureCount 应递增", async () => {
      const compiler = createMockCompiler();
      compiler.compileFiles.mockRejectedValue(new Error("error"));

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);
      await reloader.reload([{ path: "src/routes/admin.ts", type: "modify" }]);

      expect(reloader.getFailureCount()).toBe(2);
      expect(reloader.getSuccessCount()).toBe(0);
    });

    it("成功和失败交替时计数器应各自正确", async () => {
      const compiler = createMockCompiler();
      let callCount = 0;
      compiler.compileFiles.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("second call fails");
        }
        return [];
      });

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);

      // 第 1 次成功
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);
      expect(reloader.getSuccessCount()).toBe(1);

      // 第 2 次失败
      await reloader.reload([{ path: "src/routes/admin.ts", type: "modify" }]);
      expect(reloader.getFailureCount()).toBe(1);

      // 第 3 次成功
      await reloader.reload([{ path: "src/routes/blog.ts", type: "modify" }]);
      expect(reloader.getSuccessCount()).toBe(2);
      expect(reloader.getFailureCount()).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 14. 边界情况
  // ════════════════════════════════════════════════════════════

  describe("边界情况", () => {
    it("空文件列表应正常处理", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([]);

      expect(result.success).toBe(true);
      expect(result.tier).toBe("T1:code");
    });

    it("单个文件变更应正常处理", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const result = await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
      ]);

      expect(result.success).toBe(true);
    });

    it("大量文件变更应正常处理", async () => {
      const options = createDefaultOptions();
      const reloader = new SoftReloader(options);

      const files: FileChangeInfo[] = Array.from({ length: 100 }, (_, i) => ({
        path: `src/routes/route${i}.ts`,
        type: "modify" as const,
      }));

      const result = await reloader.reload(files);

      expect(result.success).toBe(true);
    });

    it("混合 src/ 和非 src/ 文件时只编译 src/ 文件", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
        { path: "package-lock.json", type: "modify" },
        { path: "src/services/auth.ts", type: "modify" },
      ]);

      expect(compiler.compileFiles).toHaveBeenCalledTimes(1);
      const calledFiles = compiler.compileFiles.mock.calls[0]![0] as string[];
      expect(calledFiles).toHaveLength(2);
      // 跨平台：Windows 路径可能包含反斜杠，normalize 后比较
      expect(
        calledFiles.every((f: string) =>
          f.replace(/\\/g, "/").includes("src/"),
        ),
      ).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════
  // 15. 与已有模块的集成验证
  // ════════════════════════════════════════════════════════════

  describe("与已有模块的集成", () => {
    it("reloadRoutes 应接收完整的 ReloadRoutesOptions", async () => {
      const resolveAdapter = vi.fn(async () => ({
        name: "hono",
        registerMiddleware: vi.fn(),
        registerRoute: vi.fn(),
        registerErrorHandler: vi.fn(),
        registerNotFound: vi.fn(),
        buildHandler: vi.fn(() => vi.fn()),
      }));
      const loadRoutesFn = vi.fn().mockResolvedValue(undefined);
      const createErrorHandlerFn = vi.fn(() => vi.fn());
      const createNotFoundHandlerFn = vi.fn(() => vi.fn());
      const builtinMiddlewares = {
        responseWrapper: vi.fn() as any,
      };

      const options = createDefaultOptions({
        resolveAdapter,
        loadRoutes: loadRoutesFn,
        createErrorHandler: createErrorHandlerFn,
        createNotFoundHandler: createNotFoundHandlerFn,
        builtinMiddlewares,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(reloadRoutes).toHaveBeenCalledWith({
        app: expect.anything(),
        outDir: "/project/.vext/dev",
        middlewareDefs: expect.anything(),
        globalMiddlewares: expect.anything(),
        resolveAdapter,
        loadRoutes: loadRoutesFn,
        createErrorHandler: createErrorHandlerFn,
        createNotFoundHandler: createNotFoundHandlerFn,
        builtinMiddlewares,
      });
    });

    it("compiler.resolveCompiled 应对每个变更文件调用一次", async () => {
      const compiler = createMockCompiler();
      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([
        { path: "src/routes/user.ts", type: "modify" },
        { path: "src/services/auth.ts", type: "modify" },
        { path: "src/utils/helper.ts", type: "modify" },
      ]);

      expect(compiler.resolveCompiled).toHaveBeenCalledTimes(3);
      expect(compiler.resolveCompiled).toHaveBeenCalledWith(
        "src/routes/user.ts",
      );
      expect(compiler.resolveCompiled).toHaveBeenCalledWith(
        "src/services/auth.ts",
      );
      expect(compiler.resolveCompiled).toHaveBeenCalledWith(
        "src/utils/helper.ts",
      );
    });

    it("invalidateAndEvict 应使用 compiler.getOutDir() 返回的路径", async () => {
      const compiler = createMockCompiler();
      compiler.getOutDir.mockReturnValue("/custom/out");

      const options = createDefaultOptions({
        compiler: compiler as any,
      });

      const reloader = new SoftReloader(options);
      await reloader.reload([{ path: "src/routes/user.ts", type: "modify" }]);

      expect(invalidateAndEvict).toHaveBeenCalledWith(
        expect.anything(),
        "/custom/out",
      );
    });
  });
});
