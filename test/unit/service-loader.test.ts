/**
 * service-loader 单元测试
 *
 * 测试覆盖：
 *   - 空目录 / 不存在的目录 → 静默跳过（不报错）
 *   - 非 class default export → Fail Fast 报错
 *   - 正常 class → 实例化注入 app.services
 *   - 文件路径 → service key 映射（kebab-case → camelCase、嵌套目录）
 *   - _ 开头的文件/目录 → 跳过
 *   - .test. / .spec. 文件 → 静默跳过
 *   - key 冲突检测
 *   - 循环依赖静态检测（DFS）
 *   - TypeScript .ts 文件加载（esbuild 内联编译）
 *     - 自包含 .ts service 文件（无内部 import）
 *     - 含跨文件 .js 扩展名 import 的 .ts service（验证 .js → .ts 重映射）
 *     - 嵌套目录 .ts 文件
 *
 * 策略：
 *   使用临时目录（os.tmpdir）创建真实文件系统结构，
 *   通过 loadServices() 加载并断言 app.services 上的挂载结果。
 *
 * .mjs vs .ts 文件选择说明：
 *   现有测试套件使用 .mjs 文件，因为 .mjs 可被 Node.js 原生 ESM 直接加载，
 *   无需任何 TypeScript 转换，测试速度更快且无外部依赖。
 *   ".ts 文件加载" 套件专门验证 esbuild 编译路径（BUG-033 修复），
 *   其余套件继续使用 .mjs 以保持独立性。
 *
 * @see 02-services.md §4（service-loader 设计）
 * @see 10-testing.md §3（Service 单元测试模式）
 * @see IMPLEMENTATION-PLAN.md 任务 1.20
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadServices } from "../../src/lib/service-loader.js";
import { createHookManager } from "../../src/lib/hooks.js";
import type { VextApp, VextConfig } from "../../src/types/app.js";

// ── 测试辅助 ────────────────────────────────────────────────

/**
 * 创建最小化的 mock VextApp
 *
 * service-loader 只需要 app.services、app.logger、app.config。
 * 其他字段使用 stub 填充。
 */
function createMockApp(overrides?: Partial<VextApp>): VextApp {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => createMockApp().logger,
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
    adapter: null as any,
    get: () => {},
    post: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    head: () => {},
    options: () => {},
    extend: () => {},
    setValidator: () => {},
    getValidator: () => ({ compile: () => () => ({ valid: true }) }) as any,
    setThrow: () => {},
    setRateLimiter: () => {},
    setRequestIdGenerator: () => {},
    onClose: () => {},
    onReady: () => {},
    use: () => {},
    ...overrides,
  } as VextApp;
}

/**
 * 写入 ESM 格式的 service 文件（.mjs）
 *
 * service-loader 要求 default export 是一个 class（构造函数）。
 * 使用 .mjs 扩展名确保 Node.js 按 ESM 直接处理，无需 TypeScript 转换。
 *
 * 注意：.ts 文件的加载路径（esbuild 内联编译）由专项套件"TypeScript .ts 文件加载"覆盖，
 * 其余测试套件使用 .mjs 以保持简洁和快速。
 */
async function writeServiceFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(dir, relativePath);
  const parentDir = join(fullPath, "..");
  await mkdir(parentDir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

// ── 临时目录管理 ────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vext-svc-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── 测试用例 ────────────────────────────────────────────────

describe("service-loader", () => {
  // ── 空目录 / 不存在的目录 ────────────────────────────────

  describe("empty / missing directory", () => {
    it("silently skips when services/ directory does not exist", async () => {
      const app = createMockApp();
      const nonExistentDir = join(tmpDir, "does-not-exist");

      // 不应抛出错误
      await expect(loadServices(app, nonExistentDir)).resolves.toBeUndefined();
      // app.services 应保持为空对象
      expect(Object.keys(app.services)).toHaveLength(0);
    });

    it("silently skips when services/ directory is empty", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(servicesDir, { recursive: true });

      const app = createMockApp();
      await expect(loadServices(app, servicesDir)).resolves.toBeUndefined();
      expect(Object.keys(app.services)).toHaveLength(0);
    });
  });

  // ── 正常 class 加载 ──────────────────────────────────────

  describe("normal class loading", () => {
    it("loads a single service and injects into app.services", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "user.mjs",
        `
export default class UserService {
  constructor(app) {
    this.app = app;
  }

  findAll() {
    return { list: [], total: 0 };
  }
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("user");
      const userService = (app.services as any).user;
      expect(userService).toBeDefined();
      expect(typeof userService.findAll).toBe("function");
      expect(userService.findAll()).toEqual({ list: [], total: 0 });
    });

    it("passes app instance to service constructor", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "echo.mjs",
        `
export default class EchoService {
  constructor(app) {
    this.port = app.config.port;
  }

  getPort() {
    return this.port;
  }
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      const echoService = (app.services as any).echo;
      expect(echoService.getPort()).toBe(3000);
    });

    it("wraps service methods with before/after/error hooks", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "user.mjs",
        `
export default class UserService {
  findOne(id) {
    return { id };
  }

  fail() {
    throw new Error("service failed");
  }
}
`,
      );

      const app = createMockApp();
      const before = vi.fn();
      const after = vi.fn();
      const onError = vi.fn();
      app.hooks.on("service:beforeCall", before);
      app.hooks.on("service:afterCall", after);
      app.hooks.on("service:error", onError);

      await loadServices(app, servicesDir, { checkCircularDeps: false });

      const userService = (app.services as any).user;
      expect(userService.findOne("u1")).toEqual({ id: "u1" });
      expect(() => userService.fail()).toThrow("service failed");

      expect(before).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "user",
          method: "findOne",
          args: ["u1"],
        }),
      );
      expect(after).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "user",
          method: "findOne",
          result: { id: "u1" },
        }),
      );
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          service: "user",
          method: "fail",
          error: expect.any(Error),
        }),
      );
    });
  });

  // ── 文件路径 → service key 映射 ──────────────────────────

  describe("file path to service key mapping", () => {
    it("maps kebab-case filename to camelCase key", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "user-profile.mjs",
        `
export default class UserProfileService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("userProfile");
    });

    it("maps nested directory to nested service key", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "payment/stripe.mjs",
        `
export default class StripeService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("payment");
      expect((app.services as any).payment).toHaveProperty("stripe");
    });

    it("maps index file to parent directory key", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "notification/index.mjs",
        `
export default class NotificationService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("notification");
      // notification 本身应该是 service 实例（不是嵌套对象）
      expect(typeof (app.services as any).notification).toBe("object");
    });
  });

  // ── 跳过规则 ─────────────────────────────────────────────

  describe("exclusion rules", () => {
    it("skips files starting with _", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "_helpers.mjs",
        `
export default class HelpersService {
  constructor() {}
}
`,
      );
      await writeServiceFile(
        servicesDir,
        "user.mjs",
        `
export default class UserService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).not.toHaveProperty("Helpers");
      expect(app.services).not.toHaveProperty("_helpers");
      expect(app.services).not.toHaveProperty("helpers");
      expect(app.services).toHaveProperty("user");
    });

    it("skips directories starting with _", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "_internal/cache.mjs",
        `
export default class CacheService {
  constructor() {}
}
`,
      );
      await writeServiceFile(
        servicesDir,
        "user.mjs",
        `
export default class UserService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).not.toHaveProperty("_internal");
      expect(app.services).toHaveProperty("user");
    });

    it("skips .d.ts files", async () => {
      const servicesDir = join(tmpDir, "services");
      // .d.ts 文件不应被加载
      await writeServiceFile(
        servicesDir,
        "user.d.ts",
        `export default class UserService {}`,
      );
      // 只有实际的 service 文件被加载
      await writeServiceFile(
        servicesDir,
        "order.mjs",
        `
export default class OrderService {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      // user（从 .d.ts）不应存在
      expect(app.services).not.toHaveProperty("user");
      expect(app.services).toHaveProperty("order");
    });
  });

  // ── Fail Fast 错误 ───────────────────────────────────────

  describe("fail fast errors", () => {
    it("throws when default export is not a class/constructor", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "bad.mjs",
        `
// 普通对象而非 class
export default {
  findAll() { return []; }
};
`,
      );

      const app = createMockApp();
      await expect(
        loadServices(app, servicesDir, { checkCircularDeps: false }),
      ).rejects.toThrow();
    });

    it("throws when no default export exists", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "missing.mjs",
        `
// 只有命名导出，没有 default export
export const helper = () => {};
`,
      );

      const app = createMockApp();
      await expect(
        loadServices(app, servicesDir, { checkCircularDeps: false }),
      ).rejects.toThrow();
    });

    it("silently skips .test. files in services/", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "user.test.mjs",
        `
export default class UserTest {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      // service-loader 对 .test. 文件是静默排除（shouldExclude），不是 Fail Fast 抛错
      await expect(
        loadServices(app, servicesDir, { checkCircularDeps: false }),
      ).resolves.toBeUndefined();
      // 不应作为 service 加载
      expect(Object.keys(app.services)).toHaveLength(0);
    });

    it("silently skips .spec. files in services/", async () => {
      const servicesDir = join(tmpDir, "services");
      await writeServiceFile(
        servicesDir,
        "user.spec.mjs",
        `
export default class UserSpec {
  constructor() {}
}
`,
      );

      const app = createMockApp();
      // service-loader 对 .spec. 文件是静默排除（shouldExclude），不是 Fail Fast 抛错
      await expect(
        loadServices(app, servicesDir, { checkCircularDeps: false }),
      ).resolves.toBeUndefined();
      // 不应作为 service 加载
      expect(Object.keys(app.services)).toHaveLength(0);
    });
  });

  // ── 多 service 加载 ──────────────────────────────────────

  describe("multiple services", () => {
    it("loads multiple services into app.services", async () => {
      const servicesDir = join(tmpDir, "services");

      await writeServiceFile(
        servicesDir,
        "user.mjs",
        `
export default class UserService {
  constructor() {}
  name() { return 'user'; }
}
`,
      );

      await writeServiceFile(
        servicesDir,
        "order.mjs",
        `
export default class OrderService {
  constructor() {}
  name() { return 'order'; }
}
`,
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("user");
      expect(app.services).toHaveProperty("order");
      expect((app.services as any).user.name()).toBe("user");
      expect((app.services as any).order.name()).toBe("order");
    });
  });

  // ── TypeScript .ts 文件加载（esbuild 内联编译）────────

  describe("TypeScript .ts file loading", () => {
    it("loads a self-contained .ts service file", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(servicesDir, { recursive: true });
      // 写入自包含的 .ts service（无内部 import）
      await writeFile(
        join(servicesDir, "greeting.ts"),
        `
export default class GreetingService {
  private prefix: string;

  constructor(_app: any) {
    this.prefix = 'Hello';
  }

  greet(name: string): string {
    return \`\${this.prefix}, \${name}!\`;
  }
}
`,
        "utf-8",
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("greeting");
      const svc = (app.services as any).greeting;
      expect(typeof svc.greet).toBe("function");
      expect(svc.greet("World")).toBe("Hello, World!");
    });

    it("loads a .ts service with TypeScript-specific syntax (types, generics)", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(servicesDir, { recursive: true });
      // TypeScript 特有语法：接口、泛型、访问修饰符
      await writeFile(
        join(servicesDir, "typed.ts"),
        `
interface Item {
  id: string;
  value: number;
}

export default class TypedService {
  private items: Item[] = [];

  constructor(_app: any) {}

  add(item: Item): void {
    this.items.push(item);
  }

  getAll(): Item[] {
    return this.items;
  }

  find<T extends Item>(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate as any) as T | undefined;
  }
}
`,
        "utf-8",
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("typed");
      const svc = (app.services as any).typed;
      svc.add({ id: "1", value: 42 });
      expect(svc.getAll()).toEqual([{ id: "1", value: 42 }]);
    });

    it("loads a .ts service that imports a local .js-extension dependency (.js → .ts remapping)", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(servicesDir, { recursive: true });

      // 辅助模块放在 services/ 的父目录（tmpDir），模拟真实项目中
      // src/utils/ 或 src/lib/ 下的工具函数，不作为 service 被扫描。
      await writeFile(
        join(tmpDir, "formatter.ts"),
        `
// formatter.ts — 被 report.ts 通过 .js 扩展名导入（TypeScript ESM 约定）
export function formatCount(n: number): string {
  return \`total:\${n}\`;
}
`,
        "utf-8",
      );

      // 主服务文件：用 .js 扩展名 import 父目录的 formatter（TypeScript ESM 约定）。
      // 这正是 BUG-033 的场景：Node.js 原生不做 .js → .ts 重映射，
      // esbuild bundle:true 在编译阶段将 ../formatter.ts 内联，完整解析此映射。
      await writeFile(
        join(servicesDir, "report.ts"),
        `
import { formatCount } from '../formatter.js';

export default class ReportService {
  constructor(_app: any) {}

  summary(count: number): string {
    return formatCount(count);
  }
}
`,
        "utf-8",
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      // formatter.ts 在 services/ 外，不被扫描，不挂载为 service
      expect(app.services).not.toHaveProperty("formatter");
      // report.ts 正常加载，依赖已由 esbuild 内联解析
      expect(app.services).toHaveProperty("report");
      const svc = (app.services as any).report;
      expect(typeof svc.summary).toBe("function");
      expect(svc.summary(5)).toBe("total:5");
    });

    it("loads a nested .ts service file", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(join(servicesDir, "analytics"), { recursive: true });
      await writeFile(
        join(servicesDir, "analytics", "report.ts"),
        `
export default class ReportService {
  constructor(_app: any) {}
  path(): string { return 'analytics.report'; }
}
`,
        "utf-8",
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      expect(app.services).toHaveProperty("analytics");
      expect((app.services as any).analytics).toHaveProperty("report");
      expect((app.services as any).analytics.report.path()).toBe(
        "analytics.report",
      );
      expect(
        (await readdir(join(servicesDir, "analytics"))).filter((file) =>
          file.includes(".__vext_compiled__"),
        ),
      ).toEqual([]);
    });

    it("temp compiled file (.__vext_compiled__) is excluded from scanning", async () => {
      const servicesDir = join(tmpDir, "services");
      await mkdir(servicesDir, { recursive: true });

      // 模拟一个遗留的临时编译产物（正常情况下不应存在，测试防御性过滤）
      await writeFile(
        join(servicesDir, "user.__vext_compiled__1234567890.mjs"),
        `export default class UserService { constructor() {} }`,
        "utf-8",
      );
      // 真实服务文件
      await writeFile(
        join(servicesDir, "user.ts"),
        `export default class UserService { constructor(_app: any) {} name() { return 'user'; } }`,
        "utf-8",
      );

      const app = createMockApp();
      await loadServices(app, servicesDir, { checkCircularDeps: false });

      // 只有 user.ts 被加载，临时文件被过滤
      expect(app.services).toHaveProperty("user");
      expect((app.services as any).user.name()).toBe("user");
    });
  });

  // ── 循环依赖检测 ─────────────────────────────────────

  describe("circular dependency detection", () => {
    it("does not throw when checkCircularDeps is false", async () => {
      const servicesDir = join(tmpDir, "services");

      // 两个 service 互相引用（通过 app.services）
      await writeServiceFile(
        servicesDir,
        "a.mjs",
        `
// import 引用 b（静态检测会发现）
// 注意：实际运行时通过 app.services.b 访问
export default class AService {
  constructor(app) {
    this.app = app;
  }
  getB() {
    return this.app.services.b;
  }
}
`,
      );

      await writeServiceFile(
        servicesDir,
        "b.mjs",
        `
export default class BService {
  constructor(app) {
    this.app = app;
  }
  getA() {
    return this.app.services.a;
  }
}
`,
      );

      const app = createMockApp();
      // checkCircularDeps = false 应该不做循环检测
      await expect(
        loadServices(app, servicesDir, { checkCircularDeps: false }),
      ).resolves.toBeUndefined();
    });
  });
});
