import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const esmRequire = createRequire(import.meta.url);

// Mock monsqlize 的 Model 静态类
// monSQLize v1.1.8 原生提供 define/redefine/undefine/has/get
const mockRegistry = new Map<
  string,
  { collectionName: string; definition: unknown }
>();

const mockModel = {
  define: vi.fn((name: string, definition: unknown) => {
    if (mockRegistry.has(name)) {
      throw new Error(`Model '${name}' is already defined.`);
    }
    mockRegistry.set(name, { collectionName: name, definition });
  }),
  redefine: vi.fn((name: string, definition: unknown) => {
    mockRegistry.delete(name);
    if (mockRegistry.has(name)) {
      throw new Error(`Model '${name}' is already defined.`);
    }
    mockRegistry.set(name, { collectionName: name, definition });
  }),
  undefine: vi.fn((name: string) => {
    return mockRegistry.delete(name);
  }),
  has: vi.fn((name: string) => mockRegistry.has(name)),
  get: vi.fn((name: string) => mockRegistry.get(name)),
};

vi.mock("monsqlize", () => ({
  default: { Model: mockModel },
  Model: mockModel,
}));

// Mock deriveModelName
vi.mock("../../src/lib/plugins/monsqlize/model-loader.js", () => {
  const deriveModelNameFn = vi.fn((relativePath: string) => {
    // 简化版：user.js → User, order-item.js → OrderItem
    const base = relativePath.replace(/\.js$/, "").replace(/\\/g, "/");
    const parts = base.split("/");
    return parts
      .map((p: string) =>
        p
          .split("-")
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(""),
      )
      .join("");
  });

  return {
    deriveModelName: deriveModelNameFn,
    resolveModelEntry: vi.fn((file: string, def: Record<string, unknown>) => {
      const withoutExt = file.replace(/\.\w+$/, "");
      const parts = withoutExt.replace(/\\/g, "/").split("/");
      const depth = parts.length - 1;

      if (depth >= 3) return null;

      if (depth === 0) {
        const registryKey =
          (def.collection as string | undefined) ??
          (def.name as string | undefined) ??
          deriveModelNameFn(file);
        return { registryKey, finalDef: def, depth };
      }

      const registryKey = deriveModelNameFn(file);
      const rawBase = parts[parts.length - 1]!;
      const finalDef: Record<string, unknown> = { ...def };
      if (!def.collection && !def.name) {
        finalDef.name = rawBase;
      }
      if (!def.connection) {
        if (depth === 1) {
          finalDef.connection = { database: parts[0] };
        } else {
          finalDef.connection = { pool: parts[0], database: parts[1] };
        }
      }
      return { registryKey, finalDef, depth };
    }),
  };
});

import {
  reloadModels,
  type ModelReloaderApp,
  type ModelReloadResult,
} from "../../src/lib/dev/model-reloader.js";
import { registerModelPlan } from "../../src/lib/plugins/monsqlize/model-registry.js";

// ── 辅助函数 ──────────────────────────────────────────────

function createMockApp(): ModelReloaderApp {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  };
}

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vext-model-reloader-test-"));
}

function cleanupRequireCache(prefix: string): void {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) {
      delete require.cache[key];
    }
  }
}

// ── 测试 ──────────────────────────────────────────────────

describe("reloadModels", () => {
  let tempDir: string;
  let outDir: string;
  let modelsDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    outDir = tempDir;
    modelsDir = join(tempDir, "models");
    await mkdir(modelsDir, { recursive: true });

    // 重置所有 mock
    vi.clearAllMocks();
    mockRegistry.clear();

    // 恢复 has/get/define 的默认实现（vi.clearAllMocks 会清除 mockImplementation）
    mockModel.has.mockImplementation((name: string) => mockRegistry.has(name));
    mockModel.get.mockImplementation((name: string) => mockRegistry.get(name));
    mockModel.define.mockImplementation((name: string, definition: unknown) => {
      if (mockRegistry.has(name)) {
        throw new Error(`Model '${name}' is already defined.`);
      }
      mockRegistry.set(name, { collectionName: name, definition });
    });
  });

  afterEach(async () => {
    cleanupRequireCache(tempDir);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("基础行为", () => {
    it("应在 models 目录不存在时静默跳过", async () => {
      const emptyOutDir = await createTempDir();
      const app = createMockApp();
      const result = await reloadModels(app, emptyOutDir, new Set());
      expect(result).toEqual({ reloaded: 0, unchanged: 0, reloadedNames: [] });
      await rm(emptyOutDir, { recursive: true, force: true });
    });

    it("应在 models 目录为空时静默跳过", async () => {
      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set());
      expect(result).toEqual({ reloaded: 0, unchanged: 0, reloadedNames: [] });
    });

    it("应在无 model 被影响时跳过（返回 unchanged 数量）", async () => {
      // 创建 model 文件但 invalidated 集合不包含它
      await writeFile(
        join(modelsDir, "user.js"),
        'module.exports = { name: "User", collection: "users", schema: { name: "string" } };',
      );

      const app = createMockApp();
      const result = await reloadModels(
        app,
        outDir,
        new Set(["some/other/path.js"]),
      );
      expect(result.reloaded).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(result.reloadedNames).toEqual([]);
    });
  });

  describe("选择性重载", () => {
    it("应在 model 文件被删除时原子释放该 source 的 registry key", async () => {
      const userFile = join(modelsDir, "user.js");
      await writeFile(
        userFile,
        'module.exports = { collection: "users", schema: {} };',
      );
      const app = createMockApp();
      const handle = registerModelPlan(mockModel, app, [
        {
          key: "users",
          definition: { collection: "users", schema: {} },
          source: "local:user.js",
        },
      ]);
      expect(mockRegistry.has("users")).toBe(true);

      await rm(userFile);
      const result = await reloadModels(app, outDir, new Set([userFile]));

      expect(result).toEqual({
        reloaded: 0,
        unchanged: 0,
        reloadedNames: [],
      });
      expect(handle.keys).toEqual([]);
      expect(mockRegistry.has("users")).toBe(false);
      handle.release();
    });

    it("应仅重载 invalidation set 中的 model", async () => {
      const userFile = join(modelsDir, "user.js");
      const orderFile = join(modelsDir, "order.js");

      await writeFile(
        userFile,
        'module.exports = { name: "User", collection: "users", schema: { name: "string" } };',
      );
      await writeFile(
        orderFile,
        'module.exports = { name: "Order", collection: "orders", schema: { total: "number" } };',
      );

      const app = createMockApp();
      const invalidated = new Set([userFile]);

      const result = await reloadModels(app, outDir, invalidated);

      expect(result.reloaded).toBe(1);
      expect(result.unchanged).toBe(1);
      expect(result.reloadedNames).toContain("users");
      expect(result.reloadedNames).not.toContain("orders");
    });

    it("应重载多个受影响的 model", async () => {
      const userFile = join(modelsDir, "user.js");
      const orderFile = join(modelsDir, "order.js");

      await writeFile(
        userFile,
        'module.exports = { name: "User", collection: "users", schema: { name: "string" } };',
      );
      await writeFile(
        orderFile,
        'module.exports = { name: "Order", collection: "orders", schema: { total: "number" } };',
      );

      const app = createMockApp();
      const invalidated = new Set([userFile, orderFile]);

      const result = await reloadModels(app, outDir, invalidated);

      expect(result.reloaded).toBe(2);
      expect(result.unchanged).toBe(0);
      expect(result.reloadedNames).toContain("users");
      expect(result.reloadedNames).toContain("orders");
    });
  });

  describe("collectionName 优先级", () => {
    it("应优先使用 definition.collection 字段", async () => {
      const file = join(modelsDir, "user.js");
      await writeFile(
        file,
        'module.exports = { name: "UserModel", collection: "users", schema: {} };',
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloadedNames).toContain("users");
    });

    it("应在无 collection 时使用 definition.name 字段", async () => {
      const file = join(modelsDir, "item.js");
      await writeFile(file, 'module.exports = { name: "Item", schema: {} };');

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloadedNames).toContain("Item");
    });

    it("应在无 collection 和 name 时从文件名推断（deriveModelName）", async () => {
      const file = join(modelsDir, "order-item.js");
      await writeFile(
        file,
        'module.exports = { schema: { price: "number" } };',
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      // deriveModelName("order-item.js") → "OrderItem"
      expect(result.reloadedNames.length).toBe(1);
    });
  });

  describe("Model.redefine vs Model.define 调用", () => {
    it("应对已注册的 model 调用 Model.redefine()", async () => {
      const file = join(modelsDir, "user.js");
      await writeFile(
        file,
        'module.exports = { collection: "users", schema: { name: "string" } };',
      );

      // 预注册 model（模拟已存在）
      const oldDef = { schema: { name: "string" } };
      mockRegistry.set("users", {
        collectionName: "users",
        definition: oldDef,
      });

      const app = createMockApp();
      await reloadModels(app, outDir, new Set([file]));

      // monSQLize v1.1.8 原生 redefine — 直接调用 Model.redefine()
      expect(mockModel.redefine).toHaveBeenCalledWith(
        "users",
        expect.any(Object),
      );
      expect(mockRegistry.has("users")).toBe(true);
    });

    it("应对未注册的 model 调用 Model.define()", async () => {
      const file = join(modelsDir, "user.js");
      await writeFile(
        file,
        'module.exports = { collection: "users", schema: { name: "string" } };',
      );

      // registry 为空 → model 未注册
      const app = createMockApp();
      await reloadModels(app, outDir, new Set([file]));

      expect(mockModel.define).toHaveBeenCalledWith(
        "users",
        expect.any(Object),
      );
      // 未注册时直接 define，不经过 _registry.delete
      expect(mockRegistry.has("users")).toBe(true);
    });
  });

  describe("回滚机制", () => {
    it("应在任一 require 失败时保持全部旧定义且不进入提交", async () => {
      // 文件名确保 aaa-good 在 zzz-bad 之前被处理（字母序）
      const goodFile = join(modelsDir, "aaa-good.js");
      const badFile = join(modelsDir, "zzz-bad.js");

      await writeFile(
        goodFile,
        'module.exports = { collection: "goods", schema: {} };',
      );
      await writeFile(badFile, "throw new Error('syntax error');");

      // good model 已注册，有旧定义
      const oldGoodDef = { schema: { old: true } };
      mockRegistry.set("goods", {
        collectionName: "goods",
        definition: oldGoodDef,
      });

      const app = createMockApp();
      await expect(
        reloadModels(app, outDir, new Set([goodFile, badFile])),
      ).rejects.toThrow();

      expect(mockModel.redefine).not.toHaveBeenCalled();
      expect(mockRegistry.get("goods")?.definition).toBe(oldGoodDef);
    });

    it("应对新增的 model（无旧定义）调用 Model.undefine 进行回滚", async () => {
      // 文件名确保 aaa-good 在 zzz-bad 之前被处理
      const goodFile = join(modelsDir, "aaa-good.js");
      const badFile = join(modelsDir, "zzz-bad.js");

      await writeFile(
        goodFile,
        'module.exports = { collection: "goods", schema: {} };',
      );
      await writeFile(badFile, "throw new Error('load error');");

      // registry 为空 → 都是新 model（无旧定义）

      const app = createMockApp();
      await expect(
        reloadModels(app, outDir, new Set([goodFile, badFile])),
      ).rejects.toThrow();

      // 全文件 import/resolve 先于 commit，因此 good 也从未注册。
      expect(mockRegistry.has("goods")).toBe(false);
      expect(mockModel.define).not.toHaveBeenCalled();
    });

    it("应把提交前的加载失败直接上抛而不伪报回滚", async () => {
      const badFile = join(modelsDir, "bad.js");
      await writeFile(badFile, "throw new Error('load error');");

      const app = createMockApp();
      await expect(
        reloadModels(app, outDir, new Set([badFile])),
      ).rejects.toThrow();

      expect(app.logger.error).not.toHaveBeenCalled();
    });
  });

  describe("ESM/CJS interop", () => {
    it("应正确解包 { __esModule: true, default: {...} } 格式", async () => {
      const file = join(modelsDir, "esm-model.js");
      // 模拟 esbuild CJS 输出的 ESM interop 格式
      await writeFile(
        file,
        `Object.defineProperty(exports, "__esModule", { value: true });
         exports.default = { collection: "esmModels", schema: { field: "string" } };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("esmModels");
    });

    it("应正确处理 module.exports = { ... } 格式（CJS 直接导出）", async () => {
      const file = join(modelsDir, "cjs-model.js");
      await writeFile(
        file,
        'module.exports = { collection: "cjsModels", schema: { field: "number" } };',
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("cjsModels");
    });
  });

  describe("无效导出处理", () => {
    it("应拒绝导出 null 的 model 文件", async () => {
      const file = join(modelsDir, "null-model.js");
      // module.exports = { default: null } 模拟 CJS 包装
      // 直接 module.exports = null 会导致 mod 为 null，
      await writeFile(file, "module.exports = null;");

      const app = createMockApp();
      await expect(reloadModels(app, outDir, new Set([file]))).rejects.toThrow(
        "invalid export",
      );
      expect(app.logger.warn).not.toHaveBeenCalled();
    });

    it("应拒绝导出数组的 model 文件", async () => {
      const file = join(modelsDir, "array-model.js");
      await writeFile(file, "module.exports = [1, 2, 3];");

      const app = createMockApp();
      await expect(reloadModels(app, outDir, new Set([file]))).rejects.toThrow(
        "invalid export",
      );
      expect(app.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("目录扫描", () => {
    it("应递归扫描子目录中的 model 文件", async () => {
      const subDir = join(modelsDir, "admin");
      await mkdir(subDir, { recursive: true });
      const file = join(subDir, "role.js");
      await writeFile(
        file,
        'module.exports = { collection: "roles", schema: {} };',
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloaded).toBe(1);
      // N4: depth-1 registryKey = deriveModelName("admin/role.js") = "AdminRole"
      expect(result.reloadedNames).toContain("AdminRole");
    });

    it("应跳过 _ 开头的文件", async () => {
      await writeFile(
        join(modelsDir, "_helper.js"),
        'module.exports = { collection: "helpers", schema: {} };',
      );
      await writeFile(
        join(modelsDir, "user.js"),
        'module.exports = { collection: "users", schema: {} };',
      );

      const app = createMockApp();
      // 即使 _helper.js 在 invalidated 中也应被跳过
      const helperFile = join(modelsDir, "_helper.js");
      const userFile = join(modelsDir, "user.js");
      const result = await reloadModels(
        app,
        outDir,
        new Set([helperFile, userFile]),
      );

      // _helper.js 被 scanModelDirectory 跳过，只有 user.js
      expect(result.reloaded).toBe(1);
      expect(result.unchanged).toBe(0);
    });

    it("应跳过 . 开头的目录", async () => {
      const hiddenDir = join(modelsDir, ".hidden");
      await mkdir(hiddenDir, { recursive: true });
      await writeFile(
        join(hiddenDir, "secret.js"),
        'module.exports = { collection: "secrets", schema: {} };',
      );

      const app = createMockApp();
      const file = join(hiddenDir, "secret.js");
      const result = await reloadModels(app, outDir, new Set([file]));

      expect(result.reloaded).toBe(0);
    });

    it("应忽略非 .js 文件", async () => {
      await writeFile(join(modelsDir, "readme.md"), "# Models");
      await writeFile(join(modelsDir, "user.d.ts"), "export interface User {}");

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set());
      expect(result).toEqual({ reloaded: 0, unchanged: 0, reloadedNames: [] });
    });
  });

  describe("结果统计", () => {
    it("应正确统计 reloaded 和 unchanged 数量", async () => {
      const userFile = join(modelsDir, "user.js");
      const orderFile = join(modelsDir, "order.js");
      const itemFile = join(modelsDir, "item.js");

      await writeFile(
        userFile,
        'module.exports = { collection: "users", schema: {} };',
      );
      await writeFile(
        orderFile,
        'module.exports = { collection: "orders", schema: {} };',
      );
      await writeFile(
        itemFile,
        'module.exports = { collection: "items", schema: {} };',
      );

      const app = createMockApp();
      // 只有 user 在 invalidated 中
      const result = await reloadModels(app, outDir, new Set([userFile]));

      expect(result.reloaded).toBe(1);
      expect(result.unchanged).toBe(2);
      expect(result.reloadedNames).toEqual(["users"]);
    });

    it("应在日志中输出重载统计信息", async () => {
      const file = join(modelsDir, "user.js");
      await writeFile(
        file,
        'module.exports = { collection: "users", schema: {} };',
      );

      const app = createMockApp();
      await reloadModels(app, outDir, new Set([file]));

      expect(app.logger.info).toHaveBeenCalled();
      const infoArgs = (app.logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const hasReloadLog = infoArgs.some((args: unknown[]) =>
        String(args[0]).includes("models reloaded"),
      );
      expect(hasReloadLog).toBe(true);
    });
  });
});
