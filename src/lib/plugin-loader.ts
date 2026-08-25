import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname, relative } from "node:path";
import { createRequire } from "node:module";
import type { VextApp } from "../types/app.js";
import type { VextInternalHooks } from "../types/hooks.js";
import type { VextPlugin, VextPluginContext } from "../types/plugin.js";
import { resolveModuleDefault } from "./interop.js";
import { pathToFileURL } from "node:url";
import type { StartupProfiler } from "./startup-profiler.js";
import { beginAppMutationTransaction } from "./app.js";

// ── ESM-only 包兼容层 ─────────────────────────────────────────
//
// vext dev 编译器将用户代码输出为 CJS，当用户插件 import 了一个
// ESM-only 包（package.json 有 "type":"module" 但无 "require" 条件）时，
// CJS require() 会抛 ERR_REQUIRE_ESM。
//
// 解决方案：
//   1. 加载插件前扫描其 require() 调用
//   2. 对 ESM-only 包提前 await import() 拿到模块命名空间
//   3. 注入 Module._load 缓存，让后续 require() 命中预加载值
//
// 注意：plugin-loader.ts 以 ESM 格式编译（vextjs 使用 NodeNext module），
//       不能使用全局 require()，所有 CJS 调用必须通过 createRequire 创建的 _req。

/** module-level CJS require，供 ESM 兼容层内部使用 */
const _req = createRequire(import.meta.url);

type ModuleResolver = NodeJS.Require;

interface PackageRequest {
  packageId: string;
  exportKey: string;
}

/** ESM-only 包的预加载缓存：实际入口绝对路径 → 模块命名空间对象 */
const _esmPreloadCache = new Map<string, Record<string, unknown>>();
const _esmPreloadedRequests = new Set<string>();

let _moduleLoadPatchUsers = 0;
let _restoreModuleLoadPatch: (() => void) | undefined;

/**
 * （一次性）patch Node.js Module._load，拦截对已预加载 ESM 包的 require()。
 *
 * 使用 _req("node:module") 而非全局 require()（ESM 上下文无全局 require）。
 */
function _acquireModuleLoadPatch(): () => void {
  const Module = _req("node:module") as {
    _load: (request: string, ...args: unknown[]) => unknown;
  };
  if (_moduleLoadPatchUsers === 0) {
    const originalLoad = Module._load;
    const patchedLoad = function (
      this: unknown,
      request: string,
      ...args: unknown[]
    ) {
      const parent = args[0] as { filename?: string } | undefined;
      if (_esmPreloadedRequests.has(request) && parent?.filename) {
        const resolver = createRequire(parent.filename);
        const entryPath = _resolveEsmEntryPath(request, resolver);
        if (entryPath && _esmPreloadCache.has(entryPath)) {
          return _esmPreloadCache.get(entryPath);
        }
      }
      return originalLoad.call(this, request, ...args);
    };
    Module._load = patchedLoad;
    _restoreModuleLoadPatch = () => {
      if (Module._load === patchedLoad) {
        Module._load = originalLoad;
      }
    };
  }
  _moduleLoadPatchUsers += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    _moduleLoadPatchUsers -= 1;
    if (_moduleLoadPatchUsers === 0) {
      _restoreModuleLoadPatch?.();
      _restoreModuleLoadPatch = undefined;
      _esmPreloadCache.clear();
      _esmPreloadedRequests.clear();
    }
  };
}

/**
 * 读取包的 package.json。
 *
 * 两步策略：
 *   1. 直接 _req.resolve('pkg/package.json')（快速路径，但 strict exports 会报错）
 *   2. 回退：_req.resolve('pkg') 定位主文件，向上遍历目录找 package.json
 *
 * @returns 解析后的 package.json 对象，找不到返回 null
 */
function _findPkgJsonPath(
  pkgId: string,
  resolver: ModuleResolver,
): string | null {
  try {
    // 方法 1：直接解析 package.json（包允许访问时最快）
    try {
      return resolver.resolve(`${pkgId}/package.json`);
    } catch {
      // strict exports 不导出 ./package.json 时继续走 node_modules 搜索路径
    }

    // 方法 2：基于当前插件文件的 module resolution paths 手动定位包目录
    const searchPaths = resolver.resolve.paths(pkgId) ?? [];
    const pkgSegments = pkgId.split("/");
    for (const searchPath of searchPaths) {
      const candidate = join(searchPath, ...pkgSegments, "package.json");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function _readPkgJson(
  pkgId: string,
  resolver: ModuleResolver,
): Record<string, unknown> | null {
  try {
    const pkgJsonPath = _findPkgJsonPath(pkgId, resolver);
    if (!pkgJsonPath) return null;
    return JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function _parsePackageRequest(requestId: string): PackageRequest {
  const parts = requestId.split("/");
  const packageParts = requestId.startsWith("@")
    ? parts.slice(0, 2)
    : parts.slice(0, 1);
  const subpathParts = parts.slice(packageParts.length);

  return {
    packageId: packageParts.join("/"),
    exportKey: subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`,
  };
}

function _getExportEntry(
  pkgJson: Record<string, unknown>,
  exportKey: string,
): unknown {
  const exports = pkgJson["exports"];
  if (exports === undefined) return undefined;
  if (typeof exports !== "object" || exports === null) {
    return exportKey === "." ? exports : undefined;
  }

  const exportsMap = exports as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(exportsMap, exportKey)) {
    return exportsMap[exportKey];
  }

  return exportKey === "." ? exportsMap : undefined;
}

function _resolveEsmEntryPath(
  requestId: string,
  resolver: ModuleResolver,
): string | null {
  const { packageId, exportKey } = _parsePackageRequest(requestId);
  const pkgJsonPath = _findPkgJsonPath(packageId, resolver);
  if (!pkgJsonPath) return null;

  const pkgJson = _readPkgJson(packageId, resolver);
  if (!pkgJson) return null;

  const pkgDir = dirname(pkgJsonPath);
  const entry = _getExportEntry(pkgJson, exportKey);

  if (typeof entry === "string") {
    return join(pkgDir, entry);
  }

  if (entry !== null && typeof entry === "object") {
    const cond = entry as Record<string, unknown>;
    if (typeof cond["import"] === "string") {
      return join(pkgDir, cond["import"] as string);
    }
    if (typeof cond["default"] === "string") {
      return join(pkgDir, cond["default"] as string);
    }
  }

  if (exportKey !== ".") return null;

  if (typeof pkgJson["main"] === "string") {
    return join(pkgDir, pkgJson["main"] as string);
  }

  return join(pkgDir, "index.js");
}

/**
 * 检测一个外部包是否为 ESM-only（无法被 CJS require() 加载）。
 *
 * 判断标准：
 *   - package.json 中 "type" === "module" 且
 *   - exports["."] 只有 "import" 条件，无 "require" / "default" 条件
 */
function _isEsmOnly(requestId: string, resolver: ModuleResolver): boolean {
  const { packageId, exportKey } = _parsePackageRequest(requestId);
  const pkgJson = _readPkgJson(packageId, resolver);
  if (!pkgJson) return false;
  if (pkgJson["type"] !== "module") return false;

  const exports = pkgJson["exports"];
  if (!exports) return true; // type:module 无 exports → ESM-only

  const entry = _getExportEntry(pkgJson, exportKey);

  if (typeof entry !== "object" || entry === null) return false;
  const cond = entry as Record<string, unknown>;

  // 有 require 或 default 条件 → 支持 CJS
  if (cond["require"] !== undefined || cond["default"] !== undefined) {
    return false;
  }
  // 只有 import / types → ESM-only
  return cond["import"] !== undefined;
}

/**
 * 扫描已编译的 CJS 插件文件，找出其中 require() 的 ESM-only 包，
 * 提前 await import() 并注入缓存，避免运行时 ERR_REQUIRE_ESM 错误。
 *
 * @param compiledFilePath 编译产物的绝对路径（.vext/dev/plugins/xxx.js）
 */
async function _preloadEsmDeps(compiledFilePath: string): Promise<void> {
  const resolver = createRequire(compiledFilePath);
  let content: string;
  try {
    content = await readFile(compiledFilePath, "utf-8");
  } catch {
    return; // 文件不存在或读取失败，跳过
  }

  // 提取所有 require('pkg') / require("pkg") 中的外部包名（排除相对路径）
  const requireRegex = /require\s*\(\s*["']([^./][^"']*?)["']\s*\)/g;
  const candidates = new Set<string>();
  for (const m of content.matchAll(requireRegex)) {
    candidates.add(m[1]!);
  }

  for (const requestId of candidates) {
    if (!_isEsmOnly(requestId, resolver)) continue;

    try {
      const esmEntryPath = _resolveEsmEntryPath(requestId, resolver);
      if (!esmEntryPath) continue;
      if (!_esmPreloadCache.has(esmEntryPath)) {
        const mod = await import(pathToFileUrl(esmEntryPath));
        _esmPreloadCache.set(esmEntryPath, mod as Record<string, unknown>);
      }
      _esmPreloadedRequests.add(requestId);
    } catch {
      // 预加载失败，忽略（让 require() 在运行时自然报错，给出真实错误信息）
    }
  }
}

/**
 * plugin-loader.ts — 插件自动加载器
 *
 * 扫描用户项目的 src/plugins/ 目录，自动加载所有插件文件，
 * 按拓扑排序（基于 dependencies/after 声明）依次执行 setup()。
 *
 * 核心流程：
 *   1. 递归扫描 pluginsDir 下的所有 .ts/.js/.mjs/.cjs 文件
 *   2. 排除 _ 开头的文件/目录、.d.ts、.test./.spec. 文件
 *   3. 动态 import 每个文件，获取 default export（必须是 definePlugin 结果）
 *   4. Fail Fast 验证：名称重复、依赖不存在、循环依赖
 *   5. 按 dependencies 字段拓扑排序（Kahn 算法）
 *   6. 依次执行 plugin.setup(app)，带超时保护（默认 30s）
 *   7. 每次 setup 完成后 clearTimeout，防止定时器泄漏
 *
 * Fail Fast 检测项：
 *   - 文件无 default export 或格式错误
 *   - 插件名称重复
 *   - dependencies 引用不存在的插件
 *   - 循环依赖
 *   - setup() 超时
 *   - setup() 抛出异常
 *
 * @module lib/plugin-loader
 * @see IMPLEMENTATION-PLAN.md 任务 1.9
 * @see 04-plugins.md §2（目录结构与加载规则）
 * @see 04-plugins.md §4（框架内部 plugin-loader.ts）
 */

/**
 * 插件加载配置
 */
export interface LoadPluginsOptions {
  /**
   * 插件 setup() 超时时间（毫秒）
   *
   * 每个插件的 setup() 必须在此时间内完成，否则抛出超时错误。
   * 超时后框架 clearTimeout 并 reject，启动终止。
   *
   * @default 30_000 (30 秒)
   */
  setupTimeout?: number;

  /**
   * Optional startup profiler used by dev bootstrap diagnostics.
   *
   * Omitted in production/testing paths unless the caller explicitly wants
   * startup timing events.
   */
  startupProfiler?: StartupProfiler;
}

/**
 * loadPlugins — 扫描 plugins/ 目录，拓扑排序后依次执行 setup
 *
 * @param app        VextApp 实例（plugin 的 setup 接收此对象）
 * @param pluginsDir plugins/ 目录的绝对路径（如 /path/to/my-app/src/plugins）
 * @param options    加载选项
 *
 * @example
 * ```typescript
 * // bootstrap 内部
 * await loadPlugins(app, path.join(rootDir, 'src/plugins'), {
 *   setupTimeout: app.config.plugin?.setupTimeout ?? 30_000,
 * })
 * ```
 */
export async function loadPlugins(
  app: VextApp,
  pluginsDir: string,
  options: LoadPluginsOptions = {},
): Promise<void> {
  const { setupTimeout = 30_000, startupProfiler } = options;

  // ── 1. 检查 plugins/ 目录是否存在 ─────────────────────────
  const dirExists = await directoryExists(pluginsDir);
  if (!dirExists) {
    app.logger.debug(
      "[vextjs] Plugins directory not found, skipping plugin loading.",
    );
    return;
  }

  // ── 2. 递归扫描所有插件文件 ────────────────────────────────
  const pluginFiles =
    (await startupProfiler?.time(
      "worker.plugins.scan",
      () => scanPluginFiles(pluginsDir),
      { phase: "plugins", detail: { pluginsDir } },
    )) ?? (await scanPluginFiles(pluginsDir));

  if (pluginFiles.length === 0) {
    app.logger.debug(
      "[vextjs] No plugin files found, skipping plugin loading.",
    );
    return;
  }

  // ── 3. 动态 import 每个文件，收集 VextPlugin 实例 ──────────
  const plugins: Array<{ plugin: VextPlugin; sourceFile: string }> = [];
  const nameSet = new Map<string, string>(); // name → sourceFile（重复检测）

  for (const filePath of pluginFiles) {
    const relativeFile = relative(pluginsDir, filePath);
    const plugin =
      (await startupProfiler?.time(
        `worker.plugins.import.${toEventNamePart(relativeFile)}`,
        () => loadPluginFile(filePath, pluginsDir),
        { phase: "plugins", detail: { file: relativeFile } },
      )) ?? (await loadPluginFile(filePath, pluginsDir));

    // Fail Fast：插件名称重复
    const existing = nameSet.get(plugin.name);
    if (existing) {
      throw new Error(
        `[vextjs] Plugin name "${plugin.name}" is already registered.\n` +
          `         First:    ${existing}\n` +
          `         Conflict: ${filePath}\n` +
          `         Each plugin must have a unique name.`,
      );
    }

    nameSet.set(plugin.name, filePath);
    plugins.push({ plugin, sourceFile: filePath });
  }

  // ── 4. 拓扑排序（按 dependencies 字段）────────────────────
  const sorted =
    (await startupProfiler?.time(
      "worker.plugins.toposort",
      () => topoSort(plugins, nameSet),
      { phase: "plugins" },
    )) ?? topoSort(plugins, nameSet);
  const lifecycleLevel = app.config.logger?.lifecycleLevel ?? "concise";

  // ── 5. 依次执行 setup（含超时保护）────────────────────────
  for (const { plugin, sourceFile } of sorted) {
    if (lifecycleLevel === "verbose") {
      app.logger.info(`[plugin] loading: ${plugin.name}`);
    }

    if (startupProfiler) {
      await startupProfiler.time(
        `worker.plugins.setup.${toEventNamePart(plugin.name)}`,
        () => executeSetupWithTimeout(plugin, app, setupTimeout, sourceFile),
        { phase: "plugins", detail: { plugin: plugin.name, sourceFile } },
      );
    } else {
      await executeSetupWithTimeout(plugin, app, setupTimeout, sourceFile);
    }

    if (lifecycleLevel === "verbose") {
      app.logger.info(`[plugin] loaded:  ${plugin.name}`);
    }
  }

  app.logger.info(`[vextjs] ${sorted.length} plugin(s) loaded`);
}

// ── 文件扫描 ──────────────────────────────────────────────────

/**
 * 支持的插件文件扩展名
 */
const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);

/**

 * 应排除的文件
 */
function shouldExclude(filename: string): boolean {
  // 排除 _ / . 开头的文件（约定：辅助/私有/隐藏文件）
  if (filename.startsWith("_") || filename.startsWith(".")) return true;
  // 排除测试文件
  if (filename.includes(".test.") || filename.includes(".spec.")) return true;
  // 排除类型声明文件
  if (filename.endsWith(".d.ts")) return true;
  return false;
}

/**
 * 递归扫描 plugins/ 目录下的所有插件文件
 *
 * @param dir 当前扫描的目录路径
 * @returns 所有插件文件的绝对路径数组
 */
async function scanPluginFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // 跳过以 _ 或 . 开头的目录
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

      // 递归扫描子目录
      const subFiles = await scanPluginFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (shouldExclude(entry.name)) continue;

      files.push(fullPath);
    }
  }

  return files;
}

// ── 文件加载 ──────────────────────────────────────────────────

/**
 * 加载单个插件文件
 *
 * 通过 dynamic import 加载插件模块，获取其 default export。
 * default export 必须是包含 name + setup 的对象（即 definePlugin 返回值）。
 *
 * @param filePath   插件文件的绝对路径
 * @param pluginsDir plugins/ 目录的绝对路径（用于错误信息中的相对路径显示）
 * @returns VextPlugin 对象
 * @throws 文件无 default export 或格式不合法
 */
async function loadPluginFile(
  filePath: string,
  _pluginsDir: string,
): Promise<VextPlugin> {
  let releaseModuleLoadPatch: (() => void) | undefined;
  try {
    // ESM-only 兼容：预加载此插件依赖的 ESM-only 包，注入 Module._load 缓存
    await _preloadEsmDeps(filePath);
    releaseModuleLoadPatch = _acquireModuleLoadPatch();

    const fileUrl = pathToFileUrl(filePath);
    const mod = await import(fileUrl);

    const plugin = resolveModuleDefault<VextPlugin>(mod);

    // Fail Fast：无 default export
    if (!plugin) {
      throw new Error(
        `[vextjs] Plugin file has no default export.\n` +
          `         File: ${filePath}\n` +
          `         Must export default definePlugin({ name, setup })`,
      );
    }

    // Fail Fast：default export 不是合法的 plugin 对象
    if (
      typeof plugin !== "object" ||
      plugin === null ||
      typeof plugin.name !== "string" ||
      !plugin.name ||
      typeof plugin.setup !== "function"
    ) {
      throw new Error(
        `[vextjs] Plugin file default export is not a valid plugin.\n` +
          `         File: ${filePath}\n` +
          `         Expected: definePlugin({ name: string, setup: (app) => void | Promise<void> })\n` +
          `         Got: ${describeValue(plugin)}`,
      );
    }

    // 验证 dependencies 字段（如果存在必须是字符串数组）
    if (plugin.dependencies !== undefined) {
      if (
        !Array.isArray(plugin.dependencies) ||
        !plugin.dependencies.every((d: unknown) => typeof d === "string")
      ) {
        throw new Error(
          `[vextjs] Plugin "${plugin.name}" has invalid dependencies field.\n` +
            `         File: ${filePath}\n` +
            `         Expected: string[] | undefined\n` +
            `         Got: ${describeValue(plugin.dependencies)}`,
        );
      }
    }

    return plugin as VextPlugin;
  } catch (err) {
    // 如果是我们自己抛出的 vextjs 错误，直接抛出
    if (err instanceof Error && err.message.startsWith("[vextjs]")) {
      throw err;
    }

    // 其他错误（语法错误、模块找不到等），包装后抛出
    throw new Error(
      `[vextjs] Failed to load plugin file: ${filePath}\n` +
        `         ${(err as Error).message}`,
    );
  } finally {
    releaseModuleLoadPatch?.();
  }
}

// ── 拓扑排序（Kahn 算法）──────────────────────────────────────

/**
 * topoSort — 按 dependencies 字段对插件进行拓扑排序
 *
 * 使用 Kahn 算法：
 *   1. 构建邻接表和入度表
 *   2. 将入度为 0 的节点入队
 *   3. BFS 逐个处理，减少后继节点入度
 *   4. 处理完毕后若有节点未访问 → 存在循环依赖
 *
 * Fail Fast 检测：
 *   - dependencies 引用不存在的插件名 → 抛错
 *   - 循环依赖 → 抛错（附带环路链描述）
 *
 * @param plugins 所有已加载的插件（含源文件信息）
 * @param nameMap 插件名 → 源文件路径映射
 * @returns 拓扑排序后的插件数组
 */
function topoSort(
  plugins: Array<{ plugin: VextPlugin; sourceFile: string }>,
  _nameMap: Map<string, string>,
): Array<{ plugin: VextPlugin; sourceFile: string }> {
  // 按名称建索引
  const byName = new Map<string, { plugin: VextPlugin; sourceFile: string }>();
  for (const entry of plugins) {
    byName.set(entry.plugin.name, entry);
  }

  // 构建邻接表（name → 依赖它的 names）和入度表
  const adjacency = new Map<string, string[]>(); // 被依赖 → 依赖者列表
  const inDegree = new Map<string, number>();

  for (const entry of plugins) {
    const name = entry.plugin.name;
    if (!adjacency.has(name)) adjacency.set(name, []);
    if (!inDegree.has(name)) inDegree.set(name, 0);
  }

  for (const entry of plugins) {
    const name = entry.plugin.name;
    const deps = entry.plugin.dependencies ?? [];

    for (const dep of deps) {
      // Fail Fast：依赖的插件不存在
      if (!byName.has(dep)) {
        throw new Error(
          `[vextjs] Plugin "${name}" depends on "${dep}" which is not found.\n` +
            `         File: ${entry.sourceFile}\n` +
            `         Available plugins: ${[...byName.keys()].join(", ") || "(none)"}\n` +
            `         Make sure the dependency plugin exists in src/plugins/.`,
        );
      }

      // dep → name（dep 完成后 name 才能执行）
      adjacency.get(dep)!.push(name);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  // Kahn BFS
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  // 入度为 0 的节点按字母序排列（保证确定性顺序）
  queue.sort();

  const sorted: Array<{ plugin: VextPlugin; sourceFile: string }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(byName.get(current)!);

    const dependents = adjacency.get(current) ?? [];
    for (const dep of dependents) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        // 插入时保持字母序（确定性排序）
        const insertIdx = queue.findIndex((q) => q.localeCompare(dep) > 0);
        if (insertIdx === -1) {
          queue.push(dep);
        } else {
          queue.splice(insertIdx, 0, dep);
        }
      }
    }
  }

  // 检测循环依赖：如果有节点未被处理，则存在环
  if (sorted.length !== plugins.length) {
    const remaining = plugins
      .filter((p) => !sorted.some((s) => s.plugin.name === p.plugin.name))
      .map((p) => p.plugin.name);

    // 尝试找出一个具体的环路（用 DFS）
    const cycle = findCycle(remaining, plugins);

    throw new Error(
      `[vextjs] Circular dependency detected in plugins: ${cycle}\n` +
        `         Break the cycle by removing or restructuring dependencies.`,
    );
  }

  return sorted;
}

/**
 * findCycle — 在剩余未排序的节点中找出一个循环依赖链
 *
 * @param remaining 未被 Kahn 算法处理的插件名列表
 * @param plugins   所有插件
 * @returns 循环链的字符串表示（如 "a → b → c → a"）
 */
function findCycle(
  remaining: string[],
  plugins: Array<{ plugin: VextPlugin; sourceFile: string }>,
): string {
  const remainingSet = new Set(remaining);

  // 只在环路涉及的节点中构建依赖图
  const deps = new Map<string, string[]>();
  for (const entry of plugins) {
    if (remainingSet.has(entry.plugin.name)) {
      deps.set(
        entry.plugin.name,
        (entry.plugin.dependencies ?? []).filter((d) => remainingSet.has(d)),
      );
    }
  }

  // DFS 找环
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string | null {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node].join(" → ");
    }
    if (visited.has(node)) return null;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const dep of deps.get(node) ?? []) {
      const result = dfs(dep);
      if (result) return result;
    }

    stack.delete(node);
    path.pop();
    return null;
  }

  for (const name of remaining) {
    if (!visited.has(name)) {
      const result = dfs(name);
      if (result) return result;
    }
  }

  // 兜底：无法找出具体环路时返回列表
  return `${remaining.join(" → ")} → ...`;
}

// ── setup 超时保护 ────────────────────────────────────────────

/**
 * executeSetupWithTimeout — 执行 plugin.setup() 并施加超时保护
 *
 * 关键设计：
 *   - 使用 Promise.race([setup, timeout]) 实现超时保护
 *   - setup 完成后**必须** clearTimeout，防止定时器泄漏
 *     （定时器持有 reject 闭包 → 闭包持有 plugin/app 引用 → GC 无法回收）
 *   - setup 抛出异常时，也 clearTimeout（finally 语义）
 *
 * @param plugin       插件对象
 * @param app          VextApp 实例
 * @param timeoutMs    超时时间（毫秒）
 * @param sourceFile   源文件路径（用于错误信息）
 */
async function executeSetupWithTimeout(
  plugin: VextPlugin,
  app: VextApp,
  timeoutMs: number,
  sourceFile: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();
  const hooks = app.hooks as VextInternalHooks;
  const controller = new AbortController();
  const transaction = beginAppMutationTransaction(app);
  const setupContext = createRevocablePluginContext(app, plugin.name);

  try {
    await hooks.emit("plugin:beforeSetup", {
      plugin: plugin.name,
      sourceFile,
    });

    const setupPromise = Promise.resolve().then(() =>
      plugin.setup(setupContext.context, { signal: controller.signal }),
    );
    await Promise.race([
      setupPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timer = undefined;
          reject(
            new Error(
              `[vextjs] Plugin "${plugin.name}" setup() timed out after ${timeoutMs}ms.\n` +
                `         File: ${sourceFile}\n` +
                `         Check for unresolved async operations (e.g. database connection without timeout).\n` +
                `         You can increase the timeout via config.plugin.setupTimeout.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    setupContext.revoke();

    // Auto lifecycle hooks are committed only after setup wins the deadline.
    if (typeof plugin.onReady === "function") {
      app.onReady(() => plugin.onReady!(app));
    }
    if (typeof plugin.onClose === "function") {
      app.onClose(() => plugin.onClose!(app));
    }
    transaction.commit();
    hooks.emitSafeSync("plugin:afterSetup", {
      plugin: plugin.name,
      sourceFile,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    if (!controller.signal.aborted) controller.abort(err);
    setupContext.revoke();
    transaction.rollback();
    // 确保异常时也清理定时器
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    hooks.emitSafeSync("plugin:error", {
      plugin: plugin.name,
      sourceFile,
      durationMs: Math.round(performance.now() - startedAt),
      error: err,
    });

    // 如果是我们自己的超时错误或 vextjs 错误，直接抛出
    if (err instanceof Error && err.message.startsWith("[vextjs]")) {
      throw err;
    }

    // 包装 setup 中抛出的其他错误
    throw new Error(
      `[vextjs] Plugin "${plugin.name}" setup() failed.\n` +
        `         File: ${sourceFile}\n` +
        `         ${(err as Error).message}`,
    );
  }
}

const PLUGIN_SETUP_MUTATION_METHODS = new Set<PropertyKey>([
  "extend",
  "setValidator",
  "setThrow",
  "setLogger",
  "setRateLimiter",
  "setRequestIdGenerator",
  "onClose",
  "onReady",
  "use",
]);

function createRevocablePluginContext(
  app: VextApp,
  pluginName: string,
): { context: VextPluginContext; revoke(): void } {
  let active = true;
  const methodCache = new Map<PropertyKey, unknown>();
  const assertActive = (operation: PropertyKey): void => {
    if (!active) {
      throw new Error(
        `[vextjs] Plugin "${pluginName}" setup context is closed; ${String(operation)} cannot run after setup completion or timeout.`,
      );
    }
  };
  const context = new Proxy(app, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (
        typeof value !== "function" ||
        !PLUGIN_SETUP_MUTATION_METHODS.has(property)
      ) {
        return value;
      }
      if (!methodCache.has(property)) {
        methodCache.set(property, (...args: unknown[]) => {
          assertActive(property);
          return Reflect.apply(value, target, args);
        });
      }
      return methodCache.get(property);
    },
    set(target, property, value) {
      assertActive(property);
      return Reflect.set(target, property, value, target);
    },
    deleteProperty(target, property) {
      assertActive(property);
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property, descriptor) {
      assertActive(property);
      if (descriptor.configurable === false) {
        throw new Error(
          `[vextjs] Plugin "${pluginName}" cannot define a non-configurable app property during setup.`,
        );
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
  }) as unknown as VextPluginContext;
  return {
    context,
    revoke() {
      active = false;
    },
  };
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 检查目录是否存在
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 将文件系统路径转为 file:// URL
 *
 * dynamic import 在 Windows 上需要 file:// 协议前缀才能正确加载。
 */
function pathToFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * 描述一个值的类型（用于错误信息）
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    return `{ ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""} }`;
  }
  return `${typeof value}: ${String(value).slice(0, 50)}`;
}

function toEventNamePart(value: string): string {
  return value
    .replace(/[\\/]+/g, ".")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
