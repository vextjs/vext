import path from "node:path";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolveModelEntry } from "../plugins/monsqlize/model-loader.js";
import { loadMonSQLizeModelClass } from "../plugins/monsqlize/module.js";
import {
  replaceAppModelSources,
  validateModelRegistration,
} from "../plugins/monsqlize/model-registry.js";
import type {
  ModelRegistryClass,
  PlannedModelRegistration,
} from "../plugins/monsqlize/model-registry.js";

// 在 ESM 环境中通过 createRequire 获取 CJS 的 require 函数。
// model-reloader 需要 require() 加载 .vext/dev/models/ 下的 CJS 编译产物，
// 以及 require.resolve 来解析模块路径。
const esmRequire = createRequire(import.meta.url);

/**
 * model-reloader.ts — 选择性 Model 定义重载（monSQLize 热重载集成）
 *
 * Soft Reload 时只重新加载 invalidation set 中包含的 model 定义文件，
 * 其他 model 定义保持不变。使用 monSQLize 3.3.0 的 registry API。
 *
 * 核心流程：
 *
 *   1. 扫描 outDir/models/ 下所有 .js 文件
 *   2. 筛选出在 invalidation set 中的文件（需要重载的）
 *   3. require/resolve 全部受影响文件并形成 validated plan
 *   4. 通过 app-owned registry 事务一次提交
 *   5. 如果 commit 失败，恢复所有受影响 key 的旧定义
 *
 * 安全保证：
 *
 *   | 场景                          | 行为                                              |
 *   |-------------------------------|---------------------------------------------------|
 *   | model 文件不在失效集合中       | 完全不触碰，定义保持不变                            |
 *   | require() 新模块失败           | 提交前失败，registry 保持不变并向上抛出错误           |
 *   | Model.redefine() 失败          | 回滚所有受影响 model 到旧定义，向上抛出错误          |
 *   | 嵌套目录（admin/role）         | 正确映射为 AdminRole（复用 deriveModelName）         |
 *   | 无 models/ 目录                | 静默跳过，返回空结果                                |
 *
 * @module lib/dev/model-reloader
 * @see model-loader.ts（初始加载逻辑，deriveModelName 复用）
 * @see service-reloader.ts（设计模式参考）
 */

// ── 类型定义 ────────────────────────────────────────────────

/**
 * 最小化的 VextApp 接口（仅包含 model-reloader 需要的字段）
 *
 * 使用局部接口避免对完整 VextApp 类型的直接依赖，
 * 便于单元测试中构造 mock 对象。
 */
export interface ModelReloaderApp {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

/**
 * Model 重载结果
 */
export interface ModelReloadResult {
  /** 受影响（重载）的 model 数量 */
  reloaded: number;

  /** 未受影响（保持不变）的 model 数量 */
  unchanged: number;

  /** 重载的 model collection name 列表 */
  reloadedNames: string[];
}

// ── Model 静态类获取 ────────────────────────────────────────

/**
 * ModelClassAPI — model-reloader 所需的 Model 静态方法接口
 *
 * 全部使用 monSQLize 3.3.0 原生 API：
 *   - define(name, definition)    — 注册新 model
 *   - redefine(name, definition)  — 更新已有 model 定义（v1.1.7+）
 *   - undefine(name)              — 移除 model 定义（v1.1.7+）
 *   - has(name)                   — 检查 model 是否已注册
 *   - get(name)                   — 获取 registry entry 与原始 definition
 */
/**
 * getModelClass — 获取 monSQLize 的 Model 静态类
 *
 * monSQLize 3.3.0 原生提供 define / has / get / redefine / undefine。
 *
 * @returns 统一的 Model 操作接口
 */
async function getModelClass(): Promise<ModelRegistryClass> {
  const ModelStatic = (await loadMonSQLizeModelClass()) as {
    define: (name: string, definition: unknown) => void;
    redefine: (name: string, definition: unknown) => void;
    undefine: (name: string) => boolean;
    has: (name: string) => boolean;
    get: (
      name: string,
    ) => { collectionName: string; definition: unknown } | undefined;
  };

  return ModelStatic;
}

// ── 扫描 models 目录 ───────────────────────────────────────

/**
 * scanModelDirectory — 递归扫描 models/ 目录下的所有 .js 文件
 *
 * 只扫描编译产物（.js），忽略 .map / .d.ts 等辅助文件。
 * 跳过以 _ 或 . 开头的文件/目录。
 *
 * @param dir 当前扫描的目录路径
 * @returns 所有 model .js 文件的绝对路径数组
 */
async function scanModelDirectory(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // 跳过 _ 或 . 开头的目录
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const subFiles = await scanModelDirectory(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      // 只扫描 .js 文件（编译产物）
      if (!entry.name.endsWith(".js")) continue;
      // 跳过 source map 和类型声明
      if (entry.name.endsWith(".js.map") || entry.name.endsWith(".d.ts"))
        continue;
      // 跳过 _ 开头的文件
      if (entry.name.startsWith("_")) continue;
      files.push(fullPath);
    }
  }

  return files;
}

function localModelSource(
  modelsDir: string,
  compiledFile: string,
): string | undefined {
  const relativePath = path.relative(modelsDir, compiledFile);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    !relativePath.endsWith(".js")
  ) {
    return undefined;
  }
  const segments = relativePath.split(path.sep);
  if (
    segments.some(
      (segment) => segment.startsWith("_") || segment.startsWith("."),
    )
  ) {
    return undefined;
  }
  return `local:${relativePath.replaceAll("\\", "/")}`;
}

// ── 主函数 ──────────────────────────────────────────────────

/**
 * reloadModels — 选择性重载 model 定义
 *
 * 只重新加载变更的 model 定义文件，其他 model 保持不变。
 * 使用 monSQLize 3.3.0 registry API 与 VextJS app ownership 事务更新定义。
 *
 * 流程：
 *   1. 扫描 outDir/models/ 下所有 .js 文件
 *   2. 筛选出在 invalidation set 中的文件
 *   3. require/resolve 全部受影响 model，形成 validated plan
 *   4. 一次提交全部 primary/alias key
 *   5. commit 失败时按 journal 回滚；app close 时仅释放本 app key
 *
 * @param app VextApp 实例（需要 app.logger）
 * @param outDir 编译产物目录（.vext/dev/ 的绝对路径）
 * @param invalidated require.cache 失效集合（绝对路径集合）
 * @returns 重载结果（重载数 / 未变更数 / 重载的 name 列表）
 * @throws 重载失败时抛出错误（已回滚受影响 model）
 */
export async function reloadModels(
  app: ModelReloaderApp,
  outDir: string,
  invalidated: Set<string>,
): Promise<ModelReloadResult> {
  const modelsDir = path.join(outDir, "models");

  // ── 1. 扫描所有 model 文件 ────────────────────────────
  const allModelFiles = await scanModelDirectory(modelsDir);
  const affectedSources = new Set<string>();
  for (const invalidatedFile of invalidated) {
    const source = localModelSource(modelsDir, invalidatedFile);
    if (source) affectedSources.add(source);
  }

  if (allModelFiles.length === 0 && affectedSources.size === 0) {
    app.logger.debug("[hot-reload] no models found, skipping model reload");
    return { reloaded: 0, unchanged: 0, reloadedNames: [] };
  }

  // ── 2. 筛选出需要重载的 model 文件 ────────────────────
  //
  // 一个 model 文件需要重载，当且仅当它（或它的编译产物）
  // 出现在 invalidation set 中。
  //
  // 检查逻辑：
  //   a. 直接检查 invalidated 集合中是否包含该文件的绝对路径
  //   b. 尝试 require.resolve 后再检查（处理扩展名补全场景）
  //
  const affectedFiles: string[] = [];
  for (const file of allModelFiles) {
    // 直接匹配
    if (invalidated.has(file)) {
      affectedFiles.push(file);
      continue;
    }

    // 尝试 resolve 后匹配（处理路径规范化差异）
    try {
      const resolved = esmRequire.resolve(file);
      if (invalidated.has(resolved)) {
        affectedFiles.push(file);
      }
    } catch {
      // require.resolve 失败（文件可能已被删除），跳过
    }
  }

  // 如果没有 model 被影响，直接跳过
  if (affectedFiles.length === 0 && affectedSources.size === 0) {
    app.logger.debug("[hot-reload] no models affected, skipping model reload");
    return {
      reloaded: 0,
      unchanged: allModelFiles.length,
      reloadedNames: [],
    };
  }

  // ── 3. 获取 Model 静态类 ──────────────────────────────
  const ModelClass = await getModelClass();

  // ── 4. 导入并解析全部受影响文件，形成不可变提交计划 ───
  const registrations: PlannedModelRegistration[] = [];
  const plannedKeys = new Map<string, string>();
  const reloadedNames: string[] = [];

  for (const file of affectedFiles) {
    const relativePath = path.relative(modelsDir, file);
    const source = localModelSource(modelsDir, file);
    if (!source) {
      throw new Error(
        `[hot-reload] models/${relativePath} — compiled model path is outside the models boundary`,
      );
    }
    affectedSources.add(source);

    const mod = esmRequire(file);
    if (mod == null) {
      throw new Error(
        `[hot-reload] models/${relativePath} — invalid export (expected default object)`,
      );
    }

    let definition = mod.default !== undefined ? mod.default : mod;
    if (
      definition &&
      typeof definition === "object" &&
      (definition as Record<string, unknown>).__esModule &&
      (definition as Record<string, unknown>).default
    ) {
      definition = (definition as Record<string, unknown>).default;
    }
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    ) {
      throw new Error(
        `[hot-reload] models/${relativePath} — invalid export (expected default object)`,
      );
    }

    const def = definition as Record<string, unknown>;
    const entry = resolveModelEntry(relativePath, def);
    if (!entry) {
      const depthCount =
        relativePath.replace(/\.\w+$/, "").split(/[/\\]/).length - 1;
      throw new Error(
        `[hot-reload] models/${relativePath} — directory depth ${depthCount} exceeds maximum (2)`,
      );
    }

    const primary: PlannedModelRegistration = {
      key: entry.registryKey,
      definition: entry.finalDef,
      source,
    };
    validateModelRegistration(primary);
    if (plannedKeys.has(primary.key)) {
      throw new Error(
        `[hot-reload] models/${relativePath} — model key '${primary.key}' conflicts with ${plannedKeys.get(primary.key)}`,
      );
    }
    plannedKeys.set(primary.key, source);
    registrations.push(primary);
    reloadedNames.push(primary.key);

    const aliasValue = def.key;
    if (aliasValue !== undefined && aliasValue !== entry.registryKey) {
      const alias: PlannedModelRegistration = {
        key: aliasValue as string,
        definition: entry.finalDef,
        source,
      };
      validateModelRegistration(alias);
      if (plannedKeys.has(alias.key)) {
        throw new Error(
          `[hot-reload] models/${relativePath} — model alias '${String(aliasValue)}' conflicts with ${plannedKeys.get(alias.key)}`,
        );
      }
      plannedKeys.set(alias.key, source);
      registrations.push(alias);
    }
  }

  // ── 5. 单次提交；失败由共享 registry 事务完整回滚 ──────
  replaceAppModelSources(ModelClass, app, affectedSources, registrations);
  for (const name of reloadedNames) {
    app.logger.debug(`[hot-reload] model "${name}" reloaded`);
  }
  app.logger.info(
    `[hot-reload] models reloaded: ${reloadedNames.length} changed` +
      ` (${allModelFiles.length - affectedFiles.length} unchanged, kept)`,
  );

  return {
    reloaded: reloadedNames.length,
    unchanged: allModelFiles.length - affectedFiles.length,
    reloadedNames,
  };
}
