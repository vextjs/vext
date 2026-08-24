import { readdir, stat, readFile, writeFile, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import type { VextApp, VextLogger } from "../types/app.js";
import type { VextInternalHooks } from "../types/hooks.js";
import { resolveModuleDefault } from "./interop.js";
import { pathToFileURL } from "node:url";
import {
  SUPPORTED_SERVICE_EXTENSIONS,
  shouldExcludeServiceFileName,
  filePathToServiceKeys,
} from "../shared/service-paths.js";
import { wrapServiceInstance } from "./service-hooks.js";

/**
 * service-loader.ts — 服务层自动加载器
 *
 * 扫描用户项目的 src/services/ 目录，自动加载所有 service 文件，
 * 通过 new ServiceClass(app) 实例化后按文件路径映射为嵌套 key
 * 注入到 app.services 对象上。
 *
 * 核心流程：
 *   1. 递归扫描 servicesDir 下的所有 .ts/.js/.mjs/.cjs 文件
 *   2. 排除 _ 开头的文件/目录、.d.ts、.test./.spec. 文件
 *   3. 动态 import 每个文件，获取 default export（必须是 class / 构造函数）
 *   4. 文件路径 → 嵌套 service key（kebab-case → camelCase）
 *   5. new mod.default(app) 实例化，通过 setNestedKey 挂载到 app.services
 *   6. Fail Fast：key 冲突、非 class 导出
 *   7. 所有 service 加载完成后，执行循环依赖静态检测（源码正则分析 + DFS）
 *
 * 路径映射示例：
 *   services/user.ts            → app.services.user
 *   services/user-profile.ts    → app.services.userProfile
 *   services/payment/stripe.ts  → app.services.payment.stripe
 *   services/payment/alipay.ts  → app.services.payment.alipay
 *   services/_helpers.ts        → 跳过（_ 前缀）
 *
 * Fail Fast 检测项：
 *   - 文件无 default export 或导出非 class/构造函数
 *   - service key 冲突（两个文件映射到相同的 key 路径）
 *   - service 之间循环依赖（静态源码分析 + DFS）
 *
 * @module lib/service-loader
 * @see IMPLEMENTATION-PLAN.md 任务 1.12
 * @see 02-services.md §4（框架内部 service-loader.ts）
 * @see 02-services.md §7.1（循环依赖运行时检测）
 */

// ── 公共类型 ──────────────────────────────────────────────────

/**
 * loadServices 配置选项
 */
export interface LoadServicesOptions {
  /**
   * 是否执行循环依赖检测
   *
   * 生产环境（vext start）和开发环境（vext dev）均默认开启。
   * 可通过此选项关闭（仅用于特殊测试场景）。
   *
   * @default true
   */
  checkCircularDeps?: boolean;
}

// ── 主函数 ────────────────────────────────────────────────────

/**
 * loadServices — 扫描 services/ 目录，实例化并注入到 app.services
 *
 * @param app         VextApp 实例（service 构造函数接收此对象）
 * @param servicesDir services/ 目录的绝对路径（如 /path/to/my-app/src/services）
 * @param options     加载选项
 *
 * @example
 * ```typescript
 * // bootstrap 内部
 * await loadServices(app, path.join(rootDir, 'src/services'), {
 *   checkCircularDeps: true,
 * })
 * ```
 */
export async function loadServices(
  app: VextApp,
  servicesDir: string,
  options: LoadServicesOptions = {},
): Promise<void> {
  const { checkCircularDeps = true } = options;
  const lifecycleLevel = app.config.logger?.lifecycleLevel ?? "concise";
  const hooks = app.hooks as VextInternalHooks;

  // ── 1. 检查 services/ 目录是否存在 ────────────────────────
  const dirExists = await directoryExists(servicesDir);
  if (!dirExists) {
    app.logger.debug(
      "[vextjs] Services directory not found, skipping service loading.",
    );
    return;
  }

  // ── 2. 递归扫描所有 service 文件 ──────────────────────────
  const serviceFiles = await scanServiceFiles(servicesDir);

  if (serviceFiles.length === 0) {
    app.logger.debug(
      "[vextjs] No service files found, skipping service loading.",
    );
    return;
  }

  // ── 3. 按文件名排序（确定性加载顺序）──────────────────────
  serviceFiles.sort((a, b) => a.localeCompare(b));

  // ── 4. 逐个加载、实例化、挂载 ─────────────────────────────
  //
  // serviceFileMap 用于循环依赖检测：记录 serviceKey → 源文件路径
  //
  const serviceFileMap = new Map<string, string>();

  for (const filePath of serviceFiles) {
    // 4.1 计算 service key（文件路径 → 嵌套 key 数组）
    const keys = filePathToServiceKeys(filePath, servicesDir);
    const flatKey = keys.join(".");

    // 4.2 动态 import 获取 default export
    const ServiceClass = await loadServiceFile(filePath, flatKey);

    // 4.3 实例化 service（new ServiceClass(app)）
    let instance: unknown;
    try {
      instance = new (ServiceClass as new (app: VextApp) => unknown)(app);
    } catch (err) {
      throw new Error(
        `[vextjs] Failed to instantiate service "${flatKey}".\n` +
          `         File: ${filePath}\n` +
          `         ${(err as Error).message}\n` +
          `         Service classes must accept (app: VextApp) as the constructor argument.`,
      );
    }

    // 4.4 挂载到 app.services（嵌套 key）
    instance = wrapServiceInstance(hooks, flatKey, instance);
    setNestedKey(
      app.services as Record<string, unknown>,
      keys,
      instance,
      filePath,
    );
    hooks.emitSafeSync("service:loaded", {
      name: flatKey,
      instance,
      filePath,
    });

    // 4.5 记录文件映射（供循环依赖检测使用）
    serviceFileMap.set(flatKey, filePath);

    if (lifecycleLevel === "verbose") {
      app.logger.info(`[service-loader] loaded: ${flatKey}`);
    }
  }

  // ── 5. 循环依赖检测 ───────────────────────────────────────
  if (checkCircularDeps && serviceFileMap.size > 0) {
    await checkServiceCircularDeps(
      app.services as Record<string, unknown>,
      serviceFileMap,
      app.logger,
    );
  }

  app.logger.info(`[vextjs] ${serviceFileMap.size} service(s) loaded`);
}

// ── 文件扫描 ──────────────────────────────────────────────────

/**
 * 支持的 service 文件扩展名
 */
/**
 * 递归扫描 services/ 目录下的所有 service 文件
 *
 * @param dir 当前扫描的目录路径
 * @returns 所有 service 文件的绝对路径数组
 */
async function scanServiceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // 跳过以 _ 或 . 开头的目录
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

      // 递归扫描子目录
      const subFiles = await scanServiceFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!SUPPORTED_SERVICE_EXTENSIONS.has(ext)) continue;
      if (shouldExcludeServiceFileName(entry.name)) continue;

      files.push(fullPath);
    }
  }

  return files;
}

// ── 路径映射 ──────────────────────────────────────────────────

// ── 嵌套 key 设置 ────────────────────────────────────────────

/**
 * setNestedKey — 将 service 实例设置到嵌套对象路径上
 *
 * 支持多层嵌套（如 ['payment', 'stripe']），
 * 中间层不存在时自动创建空对象。
 *
 * Fail Fast：如果目标 key 已存在，说明两个文件映射到了相同的 key 路径。
 *
 * @param obj        目标对象（app.services）
 * @param keys       key 路径数组（如 ['payment', 'stripe']）
 * @param value      service 实例
 * @param sourceFile 源文件路径（用于错误信息）
 * @throws key 冲突时抛出错误
 */
function setNestedKey(
  obj: Record<string, unknown>,
  keys: string[],
  value: unknown,
  sourceFile: string,
): void {
  let cur = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (cur[key] === undefined) {
      cur[key] = {};
    } else if (
      typeof cur[key] !== "object" ||
      cur[key] === null ||
      // Class instances are objects; only plain namespace objects may nest further.
      Object.getPrototypeOf(cur[key]) !== Object.prototype
    ) {
      // 中间段已经被一个 service 实例占用
      // 例如：services/payment.ts (→ services.payment = instance)
      //       services/payment/stripe.ts (→ services.payment.stripe = ?)
      // payment 已经是实例，无法继续嵌套
      throw new Error(
        `[vextjs] Service key conflict: "${keys.slice(0, i + 1).join(".")}" is already ` +
          `registered as a service instance, but "${keys.join(".")}" requires it to be a namespace.\n` +
          `         Conflicting file: ${sourceFile}\n` +
          `         Rename one of the files to resolve the conflict.`,
      );
    }
    cur = cur[key] as Record<string, unknown>;
  }

  const last = keys[keys.length - 1]!;
  if (cur[last] !== undefined) {
    throw new Error(
      `[vextjs] Service key "${keys.join(".")}" is already registered.\n` +
        `         Conflicting file: ${sourceFile}\n` +
        `         Rename the file to resolve the conflict.`,
    );
  }

  cur[last] = value;
}

// ── 文件加载 ──────────────────────────────────────────────────

/**
 * loadServiceFile — 加载单个 service 文件
 *
 * 通过 dynamic import 加载 service 模块，获取其 default export。
 * default export 必须是 class / 构造函数。
 *
 * TypeScript 源文件（.ts）的处理：
 *   当 filePath 以 .ts 结尾时（`createTestApp()` 指向 src/services/ 时触发），
 *   存在两层问题：
 *     1. Node.js 原生 ESM 不支持 .ts 扩展名（ERR_UNKNOWN_FILE_EXTENSION）
 *     2. .ts 文件内使用 TypeScript ESM 约定（如 import './dep.js'），
 *        Node.js / Vite resolver 均不做 .js → .ts 自动回退
 *   修复：调用 esbuild build()（bundle:true）将 .ts 及所有本地相对依赖
 *   打包为单一 .mjs，npm 包保持 external 以复用项目 node_modules。
 *   临时文件写到源文件同目录（确保 npm 包 node_modules 查找路径正确），
 *   import 完成后在 finally 中清理。
 *
 * @param filePath service 文件的绝对路径
 * @param flatKey  service key 的扁平化表示（用于错误信息，如 'payment.stripe'）
 * @returns default export（class 构造函数）
 * @throws 文件无 default export 或导出非 class/构造函数
 */
async function loadServiceFile(
  filePath: string,
  flatKey: string,
): Promise<Function> {
  let tmpFile: string | undefined;

  try {
    let fileUrl: string;

    if (extname(filePath) === ".ts") {
      // ── TypeScript 源文件：esbuild bundle → 临时 .mjs → import ──────
      //
      // bundle:true    — 将所有本地相对 import 递归解析并内联，
      //                  esbuild 原生理解 .ts，自动完成 .js → .ts 重映射
      // packages:external — npm 包保持原样，Node.js 从源文件所在目录向上查找
      // write:false    — 编译产物通过 outputFiles 返回，不写磁盘
      // tmpFile 写到源文件同目录，命名含 .__vext_compiled__ 使 shouldExclude()
      // 将其过滤，避免被 scanServiceFiles() 重复扫描
      //
      const { build } = await import("esbuild");
      const buildResult = await build({
        entryPoints: [filePath],
        bundle: true,
        packages: "external",
        format: "esm",
        platform: "node",
        target: "node20",
        write: false,
        logLevel: "silent",
      });

      const compiledCode = buildResult.outputFiles![0]!.text;

      tmpFile = `${filePath.slice(0, -3)}.__vext_compiled__${Date.now()}.mjs`;
      await writeFile(tmpFile, compiledCode, "utf-8");
      fileUrl = pathToFileUrl(tmpFile);
    } else {
      fileUrl = pathToFileUrl(filePath);
    }

    const mod = await import(fileUrl);

    const ServiceClass = resolveModuleDefault<Function>(mod);

    // Fail Fast：无 default export
    if (!ServiceClass) {
      throw new Error(
        `[vextjs] Service file has no default export.\n` +
          `         File: ${filePath}\n` +
          `         Service key: ${flatKey}\n` +
          `         Must export default a class:\n` +
          `           export default class ${toPascalCase(flatKey)}Service {\n` +
          `             constructor(app: VextApp) {}\n` +
          `           }`,
      );
    }

    // Fail Fast：default export 不是函数/class
    if (typeof ServiceClass !== "function") {
      throw new Error(
        `[vextjs] ${filePath} must export default a class.\n` +
          `         Service key: ${flatKey}\n` +
          `         Got: ${typeof ServiceClass}\n` +
          `         Example: export default class ${toPascalCase(flatKey)}Service { constructor(app: VextApp) {} }`,
      );
    }

    return ServiceClass;
  } catch (err) {
    // 如果是我们自己抛出的 vextjs 错误，直接抛出
    if (err instanceof Error && err.message.startsWith("[vextjs]")) {
      throw err;
    }

    // 其他错误（语法错误、模块找不到等），包装后抛出
    throw new Error(
      `[vextjs] Failed to load service file: ${filePath}\n` +
        `         Service key: ${flatKey}\n` +
        `         ${(err as Error).message}`,
    );
  } finally {
    // 返回调用方前完成 best-effort 清理，避免目录清理与未决 unlink 竞态。
    if (tmpFile) {
      await unlink(tmpFile).catch(() => {});
    }
  }
}

// ── 循环依赖检测 ──────────────────────────────────────────────

/**
 * checkServiceCircularDeps — 静态分析 service 间循环依赖
 *
 * 检测策略（静态源码分析）：
 *   1. 读取每个 service 文件的源码文本
 *   2. 正则匹配 this.app.services.<key> 或 app.services.<key> 调用
 *   3. 构建有向依赖图（serviceKey → 依赖的 serviceKey 集合）
 *   4. DFS 检测环路，发现环路则 Fail Fast
 *
 * 优点：在 bootstrap 阶段完成检测，不增加请求路径检查
 * 缺点：无法检测动态拼接的 key（如 app.services[name]），但此模式极少见
 *
 * @param services       app.services 对象（用于获取所有 key）
 * @param serviceFiles   serviceKey → 源文件绝对路径的映射
 * @param logger         VextLogger 实例
 */
async function checkServiceCircularDeps(
  services: Record<string, unknown>,
  serviceFiles: Map<string, string>,
  logger: VextLogger,
): Promise<void> {
  // 1. 获取所有扁平化的 service key
  const allKeys = flattenServiceKeys(services);

  if (allKeys.length <= 1) {
    // 只有 0 或 1 个 service，不可能存在循环依赖
    return;
  }

  // 2. 构建依赖图
  const graph = new Map<string, Set<string>>();

  for (const key of allKeys) {
    graph.set(key, new Set());
  }

  for (const key of allKeys) {
    const filePath = serviceFiles.get(key);
    if (!filePath) continue;

    let source: string;
    try {
      source = await readFile(filePath, "utf-8");
    } catch {
      // 文件读取失败时跳过该 service 的依赖分析
      logger.debug(
        `[service-loader] Could not read source for circular dep check: ${filePath}`,
      );
      continue;
    }

    const deps = graph.get(key)!;

    // 匹配 this.app.services.xxx 或 app.services.xxx
    // 支持嵌套访问如 app.services.payment.stripe
    // 注意：访问可能带方法调用（app.services.b.value()），需回退到已知 service key 前缀
    const regex =
      /(?:this\.)?app\.services\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      let dep = match[1]!;
      // 最长前缀匹配：payment.stripe.charge -> payment.stripe -> payment
      while (dep && !allKeys.includes(dep)) {
        const idx = dep.lastIndexOf(".");
        if (idx < 0) {
          dep = "";
          break;
        }
        dep = dep.slice(0, idx);
      }
      // 跳过自引用与未知 key
      if (!dep || dep === key) continue;
      deps.add(dep);
    }
  }

  // 3. DFS 检测环路
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = [...path.slice(cycleStart), node].join(" → ");
      throw new Error(
        `[vextjs] Circular dependency detected in services: ${cycle}\n` +
          `         Break the cycle by extracting shared logic into a separate service or utility.`,
      );
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    const deps = graph.get(node);
    if (deps) {
      for (const dep of deps) {
        dfs(dep, [...path]);
      }
    }

    stack.delete(node);
    path.pop();
  }

  for (const key of allKeys) {
    if (!visited.has(key)) {
      dfs(key, []);
    }
  }

  logger.debug(
    `[service-loader] Circular dependency check passed (${allKeys.length} services)`,
  );
}

/**
 * flattenServiceKeys — 将嵌套的 services 对象扁平化为 key 列表
 *
 * 遍历 services 对象，将叶节点（非纯对象的值）的路径拼接为扁平 key。
 * 纯对象（命名空间）继续递归展开。
 *
 * 示例：
 *   { user: UserService, payment: { stripe: StripeService } }
 *   → ['user', 'payment.stripe']
 *
 * @param obj    services 对象（或子对象）
 * @param prefix 当前路径前缀
 * @returns 所有叶节点的扁平化 key 数组
 */
function flattenServiceKeys(
  obj: Record<string, unknown>,
  prefix: string = "",
): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      // 纯对象 → 命名空间，继续递归
      keys.push(
        ...flattenServiceKeys(value as Record<string, unknown>, fullKey),
      );
    } else {
      // 叶节点 → service 实例
      keys.push(fullKey);
    }
  }

  return keys;
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
 * 将扁平 key 转为 PascalCase（用于错误信息中建议的类名）
 *
 * 示例：
 *   'user'           → 'User'
 *   'payment.stripe' → 'PaymentStripe'
 *   'userProfile'    → 'UserProfile'
 */
function toPascalCase(flatKey: string): string {
  return flatKey
    .split(".")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}
