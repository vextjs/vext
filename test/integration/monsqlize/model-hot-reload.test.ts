/**
 * Model 热重载集成测试
 *
 * 验证 model-reloader.ts 的 reloadModels() 函数在真实文件系统环境下的行为：
 *
 *   1. 修改 model 文件后，reloadModels 正确重载新定义
 *   2. model 文件语法错误时，回滚到旧定义（原子性保证）
 *   3. 修改无关文件时，model reload 跳过（不触碰已有定义）
 *   4. 新增 model 文件的首次注册
 *   5. 多个 model 文件同时变更
 *   6. ESM/CJS interop 双层解包
 *
 * 策略：
 *   - 使用临时目录模拟 outDir/models/ 结构
 *   - 直接调用 reloadModels()，不依赖 SoftReloader 完整流程
 *   - 使用真实的 monSQLize Model 静态类（非 mock）
 *   - 每个测试用例前后清理 Model registry 和 require.cache
 *
 * @module test/integration/monsqlize/model-hot-reload
 * @see model-reloader.ts（被测模块）
 * @see plugin-lifecycle.test.ts（参考格式）
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import MonSQLize from "monsqlize";

import {
  reloadModels,
  type ModelReloaderApp,
  type ModelReloadResult,
} from "../../../src/lib/dev/model-reloader.js";

const esmRequire = createRequire(import.meta.url);

const Model = (MonSQLize as Record<string, unknown>).Model as {
  has: (name: string) => boolean;
  get: (
    name: string,
  ) => { collectionName: string; definition: unknown } | undefined;
  _clear: () => void;
};

// ── 辅助函数 ──────────────────────────────────────────────

function createMockApp(): ModelReloaderApp {
  return {
    logger: {
      info: (..._args: unknown[]) => {},
      warn: (..._args: unknown[]) => {},
      debug: (..._args: unknown[]) => {},
      error: (..._args: unknown[]) => {},
    },
  };
}

/**
 * 写入一个 CJS model 文件到 models/ 目录
 */
async function writeModelFile(
  modelsDir: string,
  fileName: string,
  content: string,
): Promise<string> {
  const filePath = join(modelsDir, fileName);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/**
 * 清除指定路径的 require.cache 条目
 */
function clearRequireCache(filePath: string): void {
  try {
    const resolved = esmRequire.resolve(filePath);
    delete esmRequire.cache[resolved];
  } catch {
    // 文件不存在或无法 resolve，忽略
  }
}

/**
 * 清除 models/ 目录下所有文件的 require.cache
 */
function clearAllModelCache(modelsDir: string, fileNames: string[]): void {
  for (const name of fileNames) {
    clearRequireCache(join(modelsDir, name));
  }
}

// ── 测试套件 ──────────────────────────────────────────────

describe("Model 热重载集成测试", () => {
  let tempDir: string;
  let outDir: string;
  let modelsDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vext-model-reload-int-"));
    outDir = join(tempDir, "out");
    modelsDir = join(outDir, "models");
    await mkdir(modelsDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 清理 Model registry，确保测试隔离
    if (typeof Model._clear === "function") {
      Model._clear();
    }
  });

  afterEach(() => {
    // 清理 Model registry
    if (typeof Model._clear === "function") {
      Model._clear();
    }
  });

  // ── 1. 基本重载：修改 model 文件后新定义生效 ──────────

  describe("基本重载", () => {
    it("应成功重载单个 model 文件的新定义", async () => {
      const fileName = "user.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "users",
          schema: function(dsl) { return dsl({ name: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const invalidated = new Set([filePath]);

      const result = await reloadModels(app, outDir, invalidated);

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("users");
      expect(Model.has("users")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });

    it("应在修改 model 文件后使用新定义替换旧定义", async () => {
      const fileName = "item.js";

      // 第一版定义
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "items",
          schema: function(dsl) { return dsl({ title: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const invalidated = new Set([filePath]);

      // 首次加载
      const result1 = await reloadModels(app, outDir, invalidated);
      expect(result1.reloaded).toBe(1);
      expect(Model.has("items")).toBe(true);

      const oldDef = Model.get("items");
      expect(oldDef).toBeDefined();

      // 清除 require.cache 模拟 invalidator 行为
      clearRequireCache(filePath);

      // 第二版定义（增加 price 字段）
      await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "items",
          schema: function(dsl) { return dsl({ title: "string!", price: "number" }); }
        };`,
      );

      // 再次重载
      const result2 = await reloadModels(app, outDir, invalidated);
      expect(result2.reloaded).toBe(1);
      expect(result2.reloadedNames).toContain("items");

      // 验证定义已更新
      const newDef = Model.get("items");
      expect(newDef).toBeDefined();
      // 新旧定义应不同（引用不等）
      expect(newDef!.definition).not.toBe(oldDef!.definition);

      // 清理
      clearRequireCache(filePath);
    });
  });

  // ── 2. 回滚机制：语法错误时恢复旧定义 ─────────────────

  describe("回滚机制", () => {
    it("应在 model 文件加载失败时回滚已有定义", async () => {
      // 先注册一个正常的 model
      const goodFileName = "aaa-product.js";
      const goodFilePath = await writeModelFile(
        modelsDir,
        goodFileName,
        `module.exports = {
          collection: "products",
          schema: function(dsl) { return dsl({ name: "string!" }); }
        };`,
      );

      const app = createMockApp();

      // 首次加载 — 成功
      const result1 = await reloadModels(app, outDir, new Set([goodFilePath]));
      expect(result1.reloaded).toBe(1);
      expect(Model.has("products")).toBe(true);

      const savedDef = Model.get("products");
      clearRequireCache(goodFilePath);

      // 写入一个会抛错的 model 文件（排序在 good 之后）
      const badFileName = "zzz-broken.js";
      const badFilePath = await writeModelFile(
        modelsDir,
        badFileName,
        `throw new Error("intentional load error for testing");`,
      );

      // 同时重载两个文件 — 应失败并回滚
      await expect(
        reloadModels(app, outDir, new Set([goodFilePath, badFilePath])),
      ).rejects.toThrow("intentional load error");

      // 回滚后 products 的定义应仍然存在
      expect(Model.has("products")).toBe(true);

      // 清理
      clearRequireCache(goodFilePath);
      clearRequireCache(badFilePath);
      // 清理坏文件，避免影响其他测试
      await rm(badFilePath, { force: true });
    });
  });

  // ── 3. 跳过无关文件 ───────────────────────────────────

  describe("无关文件跳过", () => {
    it("应在 invalidation set 不包含 model 文件时跳过重载", async () => {
      // 写入一个 model 文件但不包含在 invalidated 中
      const fileName = "category.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "categories",
          schema: function(dsl) { return dsl({ name: "string!" }); }
        };`,
      );

      const app = createMockApp();

      // invalidated 集合包含的是一个不存在于 models/ 的路径
      const unrelatedPath = join(outDir, "services", "some-service.js");
      const result = await reloadModels(app, outDir, new Set([unrelatedPath]));

      expect(result.reloaded).toBe(0);
      expect(result.unchanged).toBeGreaterThanOrEqual(1);
      expect(result.reloadedNames).toHaveLength(0);

      // model 不应被注册（因为没有触发重载）
      expect(Model.has("categories")).toBe(false);

      // 清理
      clearRequireCache(filePath);
    });

    it("应只重载受影响的 model，保持其他 model 不变", async () => {
      const userFile = await writeModelFile(
        modelsDir,
        "user2.js",
        `module.exports = {
          collection: "users2",
          schema: function(dsl) { return dsl({ name: "string!" }); }
        };`,
      );
      const orderFile = await writeModelFile(
        modelsDir,
        "order.js",
        `module.exports = {
          collection: "orders",
          schema: function(dsl) { return dsl({ total: "number" }); }
        };`,
      );

      const app = createMockApp();

      // 首先加载两个 model
      const result1 = await reloadModels(
        app,
        outDir,
        new Set([userFile, orderFile]),
      );
      expect(result1.reloaded).toBe(2);

      clearRequireCache(userFile);
      clearRequireCache(orderFile);

      // 只修改 user2，order 不在 invalidated 中
      await writeModelFile(
        modelsDir,
        "user2.js",
        `module.exports = {
          collection: "users2",
          schema: function(dsl) { return dsl({ name: "string!", email: "string" }); }
        };`,
      );

      const result2 = await reloadModels(app, outDir, new Set([userFile]));

      expect(result2.reloaded).toBe(1);
      expect(result2.reloadedNames).toContain("users2");
      expect(result2.reloadedNames).not.toContain("orders");
      // orders 应保持不变（unchanged 计数）
      expect(result2.unchanged).toBeGreaterThanOrEqual(1);

      // 清理
      clearAllModelCache(modelsDir, ["user2.js", "order.js"]);
    });
  });

  // ── 4. 新增 model 文件 ────────────────────────────────

  describe("新增 model 文件", () => {
    it("应成功注册首次出现的新 model 文件", async () => {
      const fileName = "payment.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "payments",
          schema: function(dsl) { return dsl({ amount: "number!", status: "string" }); }
        };`,
      );

      // 确保 model 未注册
      expect(Model.has("payments")).toBe(false);

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("payments");
      expect(Model.has("payments")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });

    it("应在回滚时 undefine 新增的 model（无旧定义）", async () => {
      // aaa-new 会先成功 define，然后 zzz-bad 抛错触发回滚
      const newFile = await writeModelFile(
        modelsDir,
        "aaa-new-model.js",
        `module.exports = {
          collection: "newthings",
          schema: function(dsl) { return dsl({ data: "string!" }); }
        };`,
      );
      const badFile = await writeModelFile(
        modelsDir,
        "zzz-will-fail.js",
        `throw new Error("load error for rollback test");`,
      );

      const app = createMockApp();

      await expect(
        reloadModels(app, outDir, new Set([newFile, badFile])),
      ).rejects.toThrow("load error for rollback test");

      // 回滚后新增的 model 应被 undefine
      expect(Model.has("newthings")).toBe(false);

      // 清理
      clearRequireCache(newFile);
      clearRequireCache(badFile);
      await rm(join(modelsDir, "aaa-new-model.js"), { force: true });
      await rm(join(modelsDir, "zzz-will-fail.js"), { force: true });
    });
  });

  // ── 5. 多个 model 文件同时变更 ────────────────────────

  describe("多文件并发变更", () => {
    it("应同时重载多个受影响的 model 文件", async () => {
      const files: string[] = [];
      const names = ["alpha", "beta", "gamma"];

      for (const name of names) {
        const filePath = await writeModelFile(
          modelsDir,
          `${name}.js`,
          `module.exports = {
            collection: "${name}",
            schema: function(dsl) { return dsl({ value: "string!" }); }
          };`,
        );
        files.push(filePath);
      }

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set(files));

      expect(result.reloaded).toBe(3);
      expect(result.reloadedNames).toHaveLength(3);
      for (const name of names) {
        expect(result.reloadedNames).toContain(name);
        expect(Model.has(name)).toBe(true);
      }

      // 清理
      for (const file of files) {
        clearRequireCache(file);
      }
    });

    it("应正确统计 reloaded 和 unchanged 数量", async () => {
      // 先注册 3 个 model
      const fileA = await writeModelFile(
        modelsDir,
        "stat-a.js",
        `module.exports = {
          collection: "statA",
          schema: function(dsl) { return dsl({ x: "string!" }); }
        };`,
      );
      const fileB = await writeModelFile(
        modelsDir,
        "stat-b.js",
        `module.exports = {
          collection: "statB",
          schema: function(dsl) { return dsl({ y: "string!" }); }
        };`,
      );
      const fileC = await writeModelFile(
        modelsDir,
        "stat-c.js",
        `module.exports = {
          collection: "statC",
          schema: function(dsl) { return dsl({ z: "string!" }); }
        };`,
      );

      const app = createMockApp();
      // 首次加载全部
      await reloadModels(app, outDir, new Set([fileA, fileB, fileC]));

      clearRequireCache(fileA);
      clearRequireCache(fileB);
      clearRequireCache(fileC);

      // 只修改 A，B 和 C 不在 invalidated 中
      await writeModelFile(
        modelsDir,
        "stat-a.js",
        `module.exports = {
          collection: "statA",
          schema: function(dsl) { return dsl({ x: "string!", updated: "boolean" }); }
        };`,
      );

      const result = await reloadModels(app, outDir, new Set([fileA]));

      expect(result.reloaded).toBe(1);
      // unchanged 应至少包含 B 和 C
      expect(result.unchanged).toBeGreaterThanOrEqual(2);

      // 清理
      clearAllModelCache(modelsDir, ["stat-a.js", "stat-b.js", "stat-c.js"]);
    });
  });

  // ── 6. ESM/CJS interop ────────────────────────────────

  describe("ESM/CJS interop", () => {
    it("应正确解包 __esModule + default 格式", async () => {
      const fileName = "esm-compat.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `Object.defineProperty(exports, "__esModule", { value: true });
         exports.default = {
           collection: "esmCompat",
           schema: function(dsl) { return dsl({ data: "string!" }); }
         };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("esmCompat");
      expect(Model.has("esmCompat")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });

    it("应正确处理 CJS 直接导出格式", async () => {
      const fileName = "cjs-direct.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "cjsDirect",
          schema: function(dsl) { return dsl({ info: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames).toContain("cjsDirect");
      expect(Model.has("cjsDirect")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });
  });

  // ── 7. 无效导出处理 ───────────────────────────────────

  describe("无效导出处理", () => {
    it("应拒绝导出 null 的 model 文件", async () => {
      const fileName = "null-export.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = null;`,
      );

      const app = createMockApp();
      await expect(
        reloadModels(app, outDir, new Set([filePath])),
      ).rejects.toThrow("invalid export");

      // 清理
      clearRequireCache(filePath);
    });

    it("应拒绝导出数组的 model 文件", async () => {
      const fileName = "array-export.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = [1, 2, 3];`,
      );

      const app = createMockApp();
      await expect(
        reloadModels(app, outDir, new Set([filePath])),
      ).rejects.toThrow("invalid export");

      // 清理
      clearRequireCache(filePath);
    });
  });

  // ── 8. models 目录不存在 ──────────────────────────────

  describe("边界情况", () => {
    it("应在 models 目录不存在时静默返回空结果", async () => {
      const emptyOutDir = join(tempDir, "empty-out");
      await mkdir(emptyOutDir, { recursive: true });
      // 不创建 models/ 子目录

      const app = createMockApp();
      const result = await reloadModels(app, emptyOutDir, new Set(["foo.js"]));

      expect(result.reloaded).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.reloadedNames).toHaveLength(0);

      await rm(emptyOutDir, { recursive: true, force: true });
    });

    it("应在 invalidated 集合为空时跳过所有 model", async () => {
      // 确保 models/ 下有文件
      const filePath = await writeModelFile(
        modelsDir,
        "skip-all.js",
        `module.exports = {
          collection: "skipAll",
          schema: function(dsl) { return dsl({ x: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set());

      expect(result.reloaded).toBe(0);
      expect(result.unchanged).toBeGreaterThanOrEqual(1);

      // 清理
      clearRequireCache(filePath);
    });
  });

  // ── 9. collectionName 推断优先级 ──────────────────────

  describe("collectionName 推断优先级", () => {
    it("应优先使用 definition.collection 字段", async () => {
      const fileName = "my-model.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          collection: "customName",
          name: "shouldBeIgnored",
          schema: function(dsl) { return dsl({ x: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloadedNames).toContain("customName");
      expect(Model.has("customName")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });

    it("应在无 collection 时使用 definition.name 字段", async () => {
      const fileName = "named-model.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          name: "namedModel",
          schema: function(dsl) { return dsl({ x: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloadedNames).toContain("namedModel");
      expect(Model.has("namedModel")).toBe(true);

      // 清理
      clearRequireCache(filePath);
    });

    it("应在无 collection 和 name 时从文件名推断", async () => {
      const fileName = "order-item.js";
      const filePath = await writeModelFile(
        modelsDir,
        fileName,
        `module.exports = {
          schema: function(dsl) { return dsl({ qty: "number" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      // deriveModelName("order-item.js") → "OrderItem"
      expect(result.reloaded).toBe(1);
      expect(result.reloadedNames.length).toBe(1);

      // 清理
      clearRequireCache(filePath);
    });
  });

  // ── 10. 子目录扫描 ────────────────────────────────────

  describe("子目录扫描", () => {
    it("应递归扫描子目录中的 model 文件", async () => {
      const subDir = join(modelsDir, "admin");
      await mkdir(subDir, { recursive: true });

      const filePath = await writeModelFile(
        subDir,
        "role.js",
        `module.exports = {
          collection: "adminRoles",
          schema: function(dsl) { return dsl({ roleName: "string!" }); }
        };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([filePath]));

      expect(result.reloaded).toBe(1);
      // N4: depth-1 registryKey = deriveModelName("admin/role.js") = "AdminRole"
      // collection: "adminRoles" still sets the MongoDB collection name, not the registry key
      expect(result.reloadedNames).toContain("AdminRole");
      expect(Model.has("AdminRole")).toBe(true);

      // 清理
      clearRequireCache(filePath);
      await rm(subDir, { recursive: true, force: true });
    });

    it("应跳过 _ 开头的文件", async () => {
      const helperFile = await writeModelFile(
        modelsDir,
        "_helper.js",
        `module.exports = { collection: "helper", schema: function(dsl) { return dsl({}); } };`,
      );

      const app = createMockApp();
      const result = await reloadModels(app, outDir, new Set([helperFile]));

      // _ 开头的文件应被扫描阶段排除
      expect(result.reloaded).toBe(0);
      expect(Model.has("helper")).toBe(false);

      // 清理
      clearRequireCache(helperFile);
      await rm(helperFile, { force: true });
    });
  });
});
