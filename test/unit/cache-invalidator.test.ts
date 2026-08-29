import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildReverseDependencyGraph,
  computeInvalidationSet,
  evictModules,
  detectCircularInvalidation,
  invalidateAndEvict,
} from "../../src/lib/dev/cache-invalidator.js";

import path from "node:path";

// ── 测试工具 ────────────────────────────────────────────────

/**
 * 保存和恢复 require.cache 状态
 *
 * 测试中需要操作 require.cache，测试后必须恢复，
 * 避免影响其他测试或 vitest 自身的模块加载。
 */
let savedCache: Record<string, NodeModule | undefined>;

function saveCache(): void {
  savedCache = { ...require.cache };
}

function restoreCache(): void {
  // 删除测试中新增的条目
  for (const key of Object.keys(require.cache)) {
    if (!(key in savedCache)) {
      delete require.cache[key];
    }
  }
  // 恢复被删除的条目
  for (const [key, mod] of Object.entries(savedCache)) {
    if (mod) {
      require.cache[key] = mod;
    }
  }
}

/**
 * 创建模拟的 NodeModule 条目并注入到 require.cache
 *
 * @param filename 模块的绝对路径
 * @param childrenFilenames 该模块依赖的子模块路径列表
 * @param parentFilename 父模块路径（可选）
 * @returns 创建的模拟 module
 */
function injectCacheEntry(
  filename: string,
  childrenFilenames: string[] = [],
  parentFilename?: string,
): NodeModule {
  const mod: NodeModule = {
    id: filename,
    filename,
    loaded: true,
    children: [],
    exports: {},
    isPreloading: false,
    require: (() => {}) as any,
    path: path.dirname(filename),
    paths: [],
  };

  // 设置 parent 引用
  if (parentFilename && require.cache[parentFilename]) {
    mod.parent = require.cache[parentFilename]!;
  }

  // 设置 children 引用（指向已存在的 cache 条目）
  for (const childFilename of childrenFilenames) {
    const childMod = require.cache[childFilename];
    if (childMod) {
      mod.children.push(childMod);
    }
  }

  require.cache[filename] = mod;
  return mod;
}

/**
 * 构建一个简单的模块依赖图并注入到 require.cache
 *
 * 返回所有创建的模块路径。
 *
 * 依赖关系（→ 表示 requires）：
 *   A → B → D
 *   A → C
 *   B → C
 *
 * 反向依赖图应为：
 *   B ← A
 *   C ← A, B
 *   D ← B
 */
function buildSimpleGraph(baseDir: string): {
  pathA: string;
  pathB: string;
  pathC: string;
  pathD: string;
} {
  const pathA = path.join(baseDir, "a.js");
  const pathB = path.join(baseDir, "b.js");
  const pathC = path.join(baseDir, "c.js");
  const pathD = path.join(baseDir, "d.js");

  // 先创建叶子节点（无 children）
  injectCacheEntry(pathD);
  injectCacheEntry(pathC);

  // B depends on C, D
  injectCacheEntry(pathB, [pathC, pathD]);

  // A depends on B, C
  injectCacheEntry(pathA, [pathB, pathC]);

  return { pathA, pathB, pathC, pathD };
}

// ── 平台相关路径 ────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

/**
 * 生成跨平台的测试绝对路径
 */
function testPath(...segments: string[]): string {
  if (IS_WINDOWS) {
    return path.join("C:\\projects\\myapp\\.vext\\dev", ...segments);
  }
  return path.join("/projects/myapp/.vext/dev", ...segments);
}

function testOutDir(): string {
  if (IS_WINDOWS) {
    return "C:\\projects\\myapp\\.vext\\dev";
  }
  return "/projects/myapp/.vext/dev";
}

// ── 测试 ────────────────────────────────────────────────────

describe("cache-invalidator", () => {
  beforeEach(() => {
    saveCache();
  });

  afterEach(() => {
    restoreCache();
  });

  // ── buildReverseDependencyGraph ─────────────────────────

  describe("buildReverseDependencyGraph", () => {
    it("空 require.cache 应返回空图", () => {
      // 清除所有缓存条目（测试后会恢复）
      const keys = Object.keys(require.cache);
      for (const key of keys) {
        delete require.cache[key];
      }

      const graph = buildReverseDependencyGraph();
      expect(graph.size).toBe(0);
    });

    it("无 children 的模块不产生反向依赖边", () => {
      const basePath = testPath("isolated");
      const modPath = path.join(basePath, "standalone.js");

      // 清除其他缓存以隔离测试
      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      injectCacheEntry(modPath, []);

      const graph = buildReverseDependencyGraph();

      // standalone 没有被任何模块依赖，也没有 children
      // 所以反向图中不应该有它作为 key
      expect(graph.has(modPath)).toBe(false);
    });

    it("应正确构建简单依赖关系的反向图", () => {
      const baseDir = testPath("simple-graph");

      // 清除其他缓存以隔离测试
      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const { pathA, pathB, pathC, pathD } = buildSimpleGraph(baseDir);

      const graph = buildReverseDependencyGraph();

      // B 被 A 依赖
      expect(graph.has(pathB)).toBe(true);
      expect(graph.get(pathB)!.has(pathA)).toBe(true);

      // C 被 A 和 B 依赖
      expect(graph.has(pathC)).toBe(true);
      expect(graph.get(pathC)!.has(pathA)).toBe(true);
      expect(graph.get(pathC)!.has(pathB)).toBe(true);

      // D 被 B 依赖
      expect(graph.has(pathD)).toBe(true);
      expect(graph.get(pathD)!.has(pathB)).toBe(true);

      // A 没有被任何模块依赖（它是根）
      expect(graph.has(pathA)).toBe(false);
    });

    it("应处理多个独立的依赖子图", () => {
      const baseDir = testPath("multi-graph");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 子图 1: X → Y
      const pathX = path.join(baseDir, "x.js");
      const pathY = path.join(baseDir, "y.js");
      injectCacheEntry(pathY);
      injectCacheEntry(pathX, [pathY]);

      // 子图 2: P → Q
      const pathP = path.join(baseDir, "p.js");
      const pathQ = path.join(baseDir, "q.js");
      injectCacheEntry(pathQ);
      injectCacheEntry(pathP, [pathQ]);

      const graph = buildReverseDependencyGraph();

      // Y 被 X 依赖
      expect(graph.get(pathY)?.has(pathX)).toBe(true);
      // Q 被 P 依赖
      expect(graph.get(pathQ)?.has(pathP)).toBe(true);
      // X 和 P 不互相关联
      expect(graph.get(pathY)?.has(pathP)).toBeFalsy();
      expect(graph.get(pathQ)?.has(pathX)).toBeFalsy();
    });

    it("应处理钻石型依赖（A→B→D, A→C→D）", () => {
      const baseDir = testPath("diamond");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const pathA = path.join(baseDir, "a.js");
      const pathB = path.join(baseDir, "b.js");
      const pathC = path.join(baseDir, "c.js");
      const pathD = path.join(baseDir, "d.js");

      injectCacheEntry(pathD);
      injectCacheEntry(pathB, [pathD]);
      injectCacheEntry(pathC, [pathD]);
      injectCacheEntry(pathA, [pathB, pathC]);

      const graph = buildReverseDependencyGraph();

      // D 被 B 和 C 依赖
      expect(graph.get(pathD)?.size).toBe(2);
      expect(graph.get(pathD)?.has(pathB)).toBe(true);
      expect(graph.get(pathD)?.has(pathC)).toBe(true);
    });

    it("应忽略没有 children 属性的 cache 条目", () => {
      const baseDir = testPath("no-children");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const modPath = path.join(baseDir, "broken.js");
      // 注入一个残缺的 cache 条目（没有 children）
      require.cache[modPath] = {
        id: modPath,
        filename: modPath,
        loaded: true,
        exports: {},
      } as any;

      // 不应抛错
      expect(() => buildReverseDependencyGraph()).not.toThrow();
    });

    it("应忽略 children 中 filename 为空的条目", () => {
      const baseDir = testPath("empty-filename");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const modPath = path.join(baseDir, "parent.js");

      // 注入一个 children 中包含无 filename 的条目
      const parentMod: NodeModule = {
        id: modPath,
        filename: modPath,
        loaded: true,
        children: [{ filename: "" } as any, { filename: undefined } as any],
        exports: {},
        isPreloading: false,
        require: (() => {}) as any,
        path: path.dirname(modPath),
        paths: [],
      };
      require.cache[modPath] = parentMod;

      expect(() => buildReverseDependencyGraph()).not.toThrow();
      const graph = buildReverseDependencyGraph();
      // 空 filename 的条目不应产生反向依赖
      expect(graph.size).toBe(0);
    });
  });

  // ── computeInvalidationSet ──────────────────────────────

  describe("computeInvalidationSet", () => {
    it("空文件列表应返回空失效集合", () => {
      const result = computeInvalidationSet([], testOutDir());

      expect(result.invalidated.size).toBe(0);
      expect(result.cascadeDetected).toBe(false);
    });

    it("不在 require.cache 中的文件应被跳过（不报错）", () => {
      const nonExistent = testPath("nonexistent", "ghost.js");

      const result = computeInvalidationSet([nonExistent], testOutDir());

      // require.resolve 会失败 → 跳过
      expect(result.invalidated.size).toBe(0);
      expect(result.cascadeDetected).toBe(false);
    });

    it("应正确计算单文件的失效集合（含上游传播）", () => {
      const baseDir = testPath("invalidation-single");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const { pathC, pathA, pathB } = buildSimpleGraph(baseDir);

      // 修改 C → 应失效 C, A（依赖 C）, B（依赖 C）
      const result = computeInvalidationSet([pathC], baseDir);

      expect(result.invalidated.has(pathC)).toBe(true);
      expect(result.invalidated.has(pathA)).toBe(true);
      expect(result.invalidated.has(pathB)).toBe(true);
    });

    it("应正确计算叶子节点变更的失效集合", () => {
      const baseDir = testPath("invalidation-leaf");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const { pathD, pathA, pathB, pathC } = buildSimpleGraph(baseDir);

      // 修改 D → 应失效 D, B（依赖 D）, A（依赖 B）
      const result = computeInvalidationSet([pathD], baseDir);

      expect(result.invalidated.has(pathD)).toBe(true);
      expect(result.invalidated.has(pathB)).toBe(true);
      expect(result.invalidated.has(pathA)).toBe(true);

      // C 不依赖 D，不应被失效
      expect(result.invalidated.has(pathC)).toBe(false);
    });

    it("应正确计算多文件变更的合并失效集合", () => {
      const baseDir = testPath("invalidation-multi");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const { pathC, pathD, pathA, pathB } = buildSimpleGraph(baseDir);

      // 同时修改 C 和 D → 合并失效集合
      const result = computeInvalidationSet([pathC, pathD], baseDir);

      expect(result.invalidated.has(pathC)).toBe(true);
      expect(result.invalidated.has(pathD)).toBe(true);
      expect(result.invalidated.has(pathA)).toBe(true);
      expect(result.invalidated.has(pathB)).toBe(true);
    });

    it("根节点变更应只失效自身", () => {
      const baseDir = testPath("invalidation-root");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      const { pathA, pathB, pathC, pathD } = buildSimpleGraph(baseDir);

      // 修改 A（根节点，无人依赖它）→ 只失效 A
      const result = computeInvalidationSet([pathA], baseDir);

      expect(result.invalidated.has(pathA)).toBe(true);
      expect(result.invalidated.size).toBe(1);
    });

    // ── 安全边界测试 ──────────────────────────────────────

    describe("安全边界", () => {
      it("不应将失效传播到 node_modules 中的模块", () => {
        const baseDir = testPath("boundary-nm");

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        const srcPath = path.join(baseDir, "routes", "user.js");
        const nmPath = path.join(
          baseDir,
          "..",
          "..",
          "node_modules",
          "express",
          "index.js",
        );

        // user.js → express (node_modules)
        injectCacheEntry(nmPath);
        injectCacheEntry(srcPath, [nmPath]);

        // express 也依赖 user.js（模拟不正常情况，但安全边界应阻止）
        // 实际上通过反向图，如果 express 也依赖了 user，那修改 express 时 user 应被失效
        // 但这里测试的是：user 变更不应传播到 node_modules
        const result = computeInvalidationSet([srcPath], baseDir);

        expect(result.invalidated.has(srcPath)).toBe(true);
        // node_modules 中的模块不应被失效
        expect(result.invalidated.has(nmPath)).toBe(false);
      });

      it("传播链中遇到 node_modules 应停止", () => {
        const baseDir = testPath("boundary-nm-chain");

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        const utilPath = path.join(baseDir, "utils", "helper.js");
        const nmModPath = path.join(
          baseDir,
          "..",
          "..",
          "node_modules",
          "lodash",
          "chunk.js",
        );
        const appPath = path.join(baseDir, "app.js");

        // helper → lodash (node_modules)
        // lodash ← app（app 依赖 lodash）
        injectCacheEntry(utilPath);
        injectCacheEntry(nmModPath, [utilPath]); // lodash 依赖 helper（不正常，但测试边界）
        injectCacheEntry(appPath, [nmModPath]);

        const result = computeInvalidationSet([utilPath], baseDir);

        expect(result.invalidated.has(utilPath)).toBe(true);
        // 传播到 lodash 时被 node_modules 边界阻止
        expect(result.invalidated.has(nmModPath)).toBe(false);
        // app 通过 lodash 间接依赖 helper，但链被 node_modules 切断
        expect(result.invalidated.has(appPath)).toBe(false);
      });

      it("不应将失效传播到 config 目录", () => {
        const outDir = testOutDir();
        const baseDir = outDir;

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        const servicePath = path.join(baseDir, "services", "user.js");
        const configPath = path.join(baseDir, "config", "default.js");

        // config 依赖 service（不正常场景，但安全边界应保护）
        injectCacheEntry(servicePath);
        injectCacheEntry(configPath, [servicePath]);

        const result = computeInvalidationSet([servicePath], outDir);

        expect(result.invalidated.has(servicePath)).toBe(true);
        // config 目录被安全边界保护
        expect(result.invalidated.has(configPath)).toBe(false);
      });

      it("config 子目录也应被安全边界保护", () => {
        const outDir = testOutDir();
        const baseDir = outDir;

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        const libPath = path.join(baseDir, "lib", "utils.js");
        const configSubPath = path.join(
          baseDir,
          "config",
          "database",
          "mysql.js",
        );

        injectCacheEntry(libPath);
        injectCacheEntry(configSubPath, [libPath]);

        const result = computeInvalidationSet([libPath], outDir);

        expect(result.invalidated.has(libPath)).toBe(true);
        expect(result.invalidated.has(configSubPath)).toBe(false);
      });
    });

    // ── BFS 传播正确性 ────────────────────────────────────

    describe("BFS 传播", () => {
      it("应避免重复处理（相同模块出现在多条传播路径中）", () => {
        const baseDir = testPath("bfs-dedup");

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        // 钻石型依赖: A→B→D, A→C→D
        // 修改 D → BFS 传播: D→B→A, D→C→A
        // A 应只出现一次
        const pathA = path.join(baseDir, "a.js");
        const pathB = path.join(baseDir, "b.js");
        const pathC = path.join(baseDir, "c.js");
        const pathD = path.join(baseDir, "d.js");

        injectCacheEntry(pathD);
        injectCacheEntry(pathB, [pathD]);
        injectCacheEntry(pathC, [pathD]);
        injectCacheEntry(pathA, [pathB, pathC]);

        const result = computeInvalidationSet([pathD], baseDir);

        // 所有节点都应被失效
        expect(result.invalidated.size).toBe(4);
        expect(result.invalidated.has(pathD)).toBe(true);
        expect(result.invalidated.has(pathB)).toBe(true);
        expect(result.invalidated.has(pathC)).toBe(true);
        expect(result.invalidated.has(pathA)).toBe(true);
      });

      it("深层依赖链应完整传播", () => {
        const baseDir = testPath("bfs-deep");

        const originalKeys = Object.keys(require.cache);
        for (const key of originalKeys) {
          delete require.cache[key];
        }

        // 链式: E → D → C → B → A
        const paths = ["a", "b", "c", "d", "e"].map((name) =>
          path.join(baseDir, `${name}.js`),
        );

        // 先创建叶子
        injectCacheEntry(paths[0]); // A (叶子)
        // 每个后续节点依赖前一个
        for (let i = 1; i < paths.length; i++) {
          injectCacheEntry(paths[i], [paths[i - 1]]);
        }

        // 修改 A → 应传播到 B → C → D → E
        const result = computeInvalidationSet([paths[0]], baseDir);

        expect(result.invalidated.size).toBe(5);
        for (const p of paths) {
          expect(result.invalidated.has(p)).toBe(true);
        }
      });
    });
  });

  // ── evictModules ────────────────────────────────────────

  describe("evictModules", () => {
    it("空集合应返回 evicted=0, skipped=0", () => {
      const result = evictModules(new Set());

      expect(result.evicted).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("应从 require.cache 中删除指定模块", () => {
      const baseDir = testPath("evict-basic");

      const modPath = path.join(baseDir, "target.js");
      injectCacheEntry(modPath);

      expect(require.cache[modPath]).toBeDefined();

      const result = evictModules(new Set([modPath]));

      expect(require.cache[modPath]).toBeUndefined();
      expect(result.evicted).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it("不在 cache 中的路径应计入 skipped", () => {
      const fakePath = testPath("evict-skip", "nonexistent.js");

      const result = evictModules(new Set([fakePath]));

      expect(result.evicted).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("混合场景：部分存在部分不存在", () => {
      const baseDir = testPath("evict-mixed");
      const existsPath = path.join(baseDir, "exists.js");
      const ghostPath = path.join(baseDir, "ghost.js");

      injectCacheEntry(existsPath);

      const result = evictModules(new Set([existsPath, ghostPath]));

      expect(result.evicted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(require.cache[existsPath]).toBeUndefined();
    });

    it("应批量删除多个模块", () => {
      const baseDir = testPath("evict-batch");
      const paths = Array.from({ length: 5 }, (_, i) =>
        path.join(baseDir, `mod-${i}.js`),
      );

      for (const p of paths) {
        injectCacheEntry(p);
      }

      const result = evictModules(new Set(paths));

      expect(result.evicted).toBe(5);
      expect(result.skipped).toBe(0);

      for (const p of paths) {
        expect(require.cache[p]).toBeUndefined();
      }
    });

    it("驱逐时应清理父模块的 children 引用", () => {
      const baseDir = testPath("evict-children-cleanup");

      const parentPath = path.join(baseDir, "parent.js");
      const childPath = path.join(baseDir, "child.js");

      // 创建 child
      injectCacheEntry(childPath);
      // 创建 parent，child 在其 children 中
      injectCacheEntry(parentPath, [childPath]);

      // 设置 child 的 parent 引用
      const childMod = require.cache[childPath]!;
      childMod.parent = require.cache[parentPath]!;

      const parentMod = require.cache[parentPath]!;
      expect(parentMod.children).toHaveLength(1);

      // 驱逐 child
      evictModules(new Set([childPath]));

      // parent 的 children 应已清理
      expect(parentMod.children).toHaveLength(0);
    });

    it("重复驱逐同一模块不应出错", () => {
      const baseDir = testPath("evict-double");
      const modPath = path.join(baseDir, "double.js");

      injectCacheEntry(modPath);

      const result1 = evictModules(new Set([modPath]));
      expect(result1.evicted).toBe(1);

      // 再次驱逐，模块已不在 cache 中
      const result2 = evictModules(new Set([modPath]));
      expect(result2.evicted).toBe(0);
      expect(result2.skipped).toBe(1);
    });
  });

  // ── detectCircularInvalidation ──────────────────────────

  describe("detectCircularInvalidation", () => {
    it("空集合不应触发级联检测", () => {
      expect(detectCircularInvalidation(new Set())).toBe(false);
    });

    it("小于 80% 不应触发级联检测", () => {
      const baseDir = testPath("cascade-ok");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 创建 20 个模块
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 失效 10 个 (50%)
      const invalidated = new Set(paths.slice(0, 10));
      expect(detectCircularInvalidation(invalidated)).toBe(false);
    });

    it("超过 80% 应触发级联检测", () => {
      const baseDir = testPath("cascade-boom");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 创建 20 个模块
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 失效 17 个 (85%)
      const invalidated = new Set(paths.slice(0, 17));
      expect(detectCircularInvalidation(invalidated)).toBe(true);
    });

    it("恰好 80% 不应触发（>80% 才触发）", () => {
      const baseDir = testPath("cascade-exact");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 创建 10 个模块
      const paths: string[] = [];
      for (let i = 0; i < 10; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 失效 8 个 (80%)
      const invalidated = new Set(paths.slice(0, 8));
      expect(detectCircularInvalidation(invalidated)).toBe(false);
    });

    it("81% 应触发级联检测", () => {
      const baseDir = testPath("cascade-81");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 创建 100 个模块
      const paths: string[] = [];
      for (let i = 0; i < 100; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 失效 81 个 (81%)
      const invalidated = new Set(paths.slice(0, 81));
      expect(detectCircularInvalidation(invalidated)).toBe(true);
    });

    it("require.cache 条目少于 10 个时不触发级联检测", () => {
      const baseDir = testPath("cascade-small");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 只有 5 个模块
      const paths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 全部 5 个 (100%)，但总数 <10 → 不触发
      const invalidated = new Set(paths);
      expect(detectCircularInvalidation(invalidated)).toBe(false);
    });
  });

  // ── invalidateAndEvict ──────────────────────────────────

  describe("invalidateAndEvict", () => {
    it("空文件列表应返回零驱逐", () => {
      const result = invalidateAndEvict([], testOutDir());

      expect(result.invalidated.size).toBe(0);
      expect(result.cascadeDetected).toBe(false);
      expect(result.evicted).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("正常场景应计算失效集合并驱逐", () => {
      const baseDir = testPath("combo-normal");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 添加足够多的模块以避免触发 <10 的跳过逻辑
      const fillerPaths: string[] = [];
      for (let i = 0; i < 15; i++) {
        const p = path.join(baseDir, `filler-${i}.js`);
        injectCacheEntry(p);
        fillerPaths.push(p);
      }

      const { pathC, pathD } = buildSimpleGraph(baseDir);

      // 修改 D → 应失效 D + B + A（C 不受影响）
      const result = invalidateAndEvict([pathD], baseDir);

      expect(result.cascadeDetected).toBe(false);
      expect(result.invalidated.has(pathD)).toBe(true);
      // 已驱逐的模块不应再在 require.cache 中
      for (const modulePath of result.invalidated) {
        expect(require.cache[modulePath]).toBeUndefined();
      }
      expect(result.evicted).toBe(result.invalidated.size);
    });

    it("级联检测时不应执行驱逐", () => {
      const baseDir = testPath("combo-cascade");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 创建一个相互依赖的大型图（所有模块互相依赖 → 修改一个会传播到所有）
      const modCount = 20;
      const paths: string[] = [];
      for (let i = 0; i < modCount; i++) {
        const p = path.join(baseDir, `mod-${i}.js`);
        injectCacheEntry(p);
        paths.push(p);
      }

      // 让所有模块依赖第一个模块 → 修改 mod-0 会失效所有
      for (let i = 1; i < modCount; i++) {
        const mod = require.cache[paths[i]]!;
        mod.children.push(require.cache[paths[0]]!);
      }

      // 同时让 mod-0 依赖其他所有模块 → 形成大规模传播
      const mod0 = require.cache[paths[0]]!;
      for (let i = 1; i < modCount; i++) {
        mod0.children.push(require.cache[paths[i]]!);
      }

      // 修改 mod-0 → 应级联到所有模块 → 触发级联检测
      const result = invalidateAndEvict([paths[0]], baseDir);

      // 级联检测触发
      expect(result.cascadeDetected).toBe(true);
      // 不执行驱逐
      expect(result.evicted).toBe(0);
      // skipped 等于失效集合大小
      expect(result.skipped).toBe(result.invalidated.size);

      // require.cache 应保持完整（未被驱逐）
      for (const p of paths) {
        expect(require.cache[p]).toBeDefined();
      }
    });

    it("不在 cache 中的文件不影响其他文件的正确驱逐", () => {
      const baseDir = testPath("combo-ghost");

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 足够多的 filler 避免级联检测
      for (let i = 0; i < 15; i++) {
        injectCacheEntry(path.join(baseDir, `filler-${i}.js`));
      }

      const existsPath = path.join(baseDir, "exists.js");
      const ghostPath = path.join(baseDir, "ghost-not-in-cache.js");

      injectCacheEntry(existsPath);

      // 传入一个存在的和一个不存在的文件
      const result = invalidateAndEvict([existsPath, ghostPath], baseDir);

      expect(result.cascadeDetected).toBe(false);
      // 只有 existsPath 应被处理
      expect(result.invalidated.has(existsPath)).toBe(true);
    });
  });

  // ── 集成场景 ────────────────────────────────────────────

  describe("集成场景", () => {
    it("模拟典型 soft reload 流程：修改一个路由文件", () => {
      const outDir = testOutDir();

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 模拟项目结构
      const routeUser = path.join(outDir, "routes", "user.js");
      const routeOrder = path.join(outDir, "routes", "order.js");
      const serviceUser = path.join(outDir, "services", "user.js");
      const serviceOrder = path.join(outDir, "services", "order.js");
      const utilHelper = path.join(outDir, "lib", "helper.js");
      const routerLoader = path.join(outDir, "lib", "router-loader.js");

      // 足够 filler 避免级联检测
      for (let i = 0; i < 20; i++) {
        injectCacheEntry(path.join(outDir, `filler-${i}.js`));
      }

      // 依赖关系：
      //   routeUser → serviceUser → utilHelper
      //   routeOrder → serviceOrder
      //   routerLoader → routeUser, routeOrder
      injectCacheEntry(utilHelper);
      injectCacheEntry(serviceUser, [utilHelper]);
      injectCacheEntry(serviceOrder);
      injectCacheEntry(routeUser, [serviceUser]);
      injectCacheEntry(routeOrder, [serviceOrder]);
      injectCacheEntry(routerLoader, [routeUser, routeOrder]);

      // 修改 serviceUser → 应失效：
      //   serviceUser (直接), routeUser (依赖 serviceUser),
      //   routerLoader (依赖 routeUser)
      // 不应失效：serviceOrder, routeOrder, utilHelper
      const result = invalidateAndEvict([serviceUser], outDir);

      expect(result.cascadeDetected).toBe(false);
      expect(result.invalidated.has(serviceUser)).toBe(true);
      expect(result.invalidated.has(routeUser)).toBe(true);
      expect(result.invalidated.has(routerLoader)).toBe(true);

      // 不受影响的模块
      expect(result.invalidated.has(serviceOrder)).toBe(false);
      expect(result.invalidated.has(routeOrder)).toBe(false);
      expect(result.invalidated.has(utilHelper)).toBe(false);

      // 被驱逐的模块不在 cache 中
      expect(require.cache[serviceUser]).toBeUndefined();
      expect(require.cache[routeUser]).toBeUndefined();
      expect(require.cache[routerLoader]).toBeUndefined();

      // 未受影响的模块仍在 cache 中
      expect(require.cache[serviceOrder]).toBeDefined();
      expect(require.cache[routeOrder]).toBeDefined();
      expect(require.cache[utilHelper]).toBeDefined();
    });

    it("模拟工具模块修改影响多条链路", () => {
      const outDir = testOutDir();

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      // 足够 filler 避免级联检测
      for (let i = 0; i < 20; i++) {
        injectCacheEntry(path.join(outDir, `filler-${i}.js`));
      }

      const utilPath = path.join(outDir, "lib", "shared-util.js");
      const svcA = path.join(outDir, "services", "a.js");
      const svcB = path.join(outDir, "services", "b.js");
      const routeA = path.join(outDir, "routes", "a.js");
      const routeB = path.join(outDir, "routes", "b.js");

      // util ← svcA ← routeA
      // util ← svcB ← routeB
      injectCacheEntry(utilPath);
      injectCacheEntry(svcA, [utilPath]);
      injectCacheEntry(svcB, [utilPath]);
      injectCacheEntry(routeA, [svcA]);
      injectCacheEntry(routeB, [svcB]);

      // 修改 util → 所有模块都应被失效
      const result = invalidateAndEvict([utilPath], outDir);

      expect(result.cascadeDetected).toBe(false);
      expect(result.invalidated.size).toBe(5);
      expect(result.invalidated.has(utilPath)).toBe(true);
      expect(result.invalidated.has(svcA)).toBe(true);
      expect(result.invalidated.has(svcB)).toBe(true);
      expect(result.invalidated.has(routeA)).toBe(true);
      expect(result.invalidated.has(routeB)).toBe(true);
    });

    it("invalidates an importing service when its runtime service constant changes", () => {
      const outDir = testOutDir();

      for (const key of Object.keys(require.cache)) {
        delete require.cache[key];
      }
      for (let index = 0; index < 20; index++) {
        injectCacheEntry(path.join(outDir, `filler-${index}.js`));
      }

      const orderStatus = path.join(
        outDir,
        "constants",
        "services",
        "order-status.js",
      );
      const orderService = path.join(outDir, "services", "order.js");
      const orderRoute = path.join(outDir, "routes", "order.js");

      injectCacheEntry(orderStatus);
      injectCacheEntry(orderService, [orderStatus]);
      injectCacheEntry(orderRoute, [orderService]);

      const result = invalidateAndEvict([orderStatus], outDir);

      expect(result.cascadeDetected).toBe(false);
      expect(result.invalidated).toEqual(
        new Set([orderStatus, orderService, orderRoute]),
      );
      expect(require.cache[orderStatus]).toBeUndefined();
      expect(require.cache[orderService]).toBeUndefined();
      expect(require.cache[orderRoute]).toBeUndefined();
    });

    it("config 目录文件在 invalidation 传播中应被安全边界阻止", () => {
      const outDir = testOutDir();

      const originalKeys = Object.keys(require.cache);
      for (const key of originalKeys) {
        delete require.cache[key];
      }

      for (let i = 0; i < 15; i++) {
        injectCacheEntry(path.join(outDir, `filler-${i}.js`));
      }

      const utilPath = path.join(outDir, "lib", "db.js");
      const configDb = path.join(outDir, "config", "database.js");

      // config/database.js 依赖 lib/db.js
      injectCacheEntry(utilPath);
      injectCacheEntry(configDb, [utilPath]);

      // 修改 db.js → 应失效 db.js，但 config/database.js 被边界保护
      const result = invalidateAndEvict([utilPath], outDir);

      expect(result.invalidated.has(utilPath)).toBe(true);
      expect(result.invalidated.has(configDb)).toBe(false);

      // config 文件仍在 cache 中
      expect(require.cache[configDb]).toBeDefined();
    });
  });
});
