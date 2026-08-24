/**
 * MonSQLize Model 自动加载器
 *
 * 支持两种 Model 来源（可同时使用）：
 *   1. 共享 Model 包（@project/models）— 微服务场景下多服务共享 Model 定义
 *   2. 本地 models/ 目录（src/models/*.ts）— 项目本地 Model 定义
 *
 * 加载顺序：先 shared 包 → 再本地目录（本地可覆盖 shared）。
 *
 * 文件名推断 Model 名称规则（deriveModelName）：
 *   - user.ts           → 'User'
 *   - order-item.ts     → 'OrderItem'
 *   - admin/role.ts     → 'AdminRole'
 *   - billing/invoice.ts → 'BillingInvoice'
 *
 * 排除规则：
 *   - 以 _ 开头的文件（如 _base.ts）
 *   - .d.ts 声明文件
 *   - .test. / .spec. 测试文件
 *
 * @module lib/plugins/monsqlize/model-loader
 * @see 13-monsqlize-plugin.md §2.5（Model 自动加载）
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { MonSQLize } from "monsqlize";
import type { VextPluginContext } from "../../../types/plugin.js";
import type { MonSQLizeDatabaseConfig } from "./types.js";
import { loadMonSQLizeModelClass } from "./module.js";

/**
 * 获取 MonSQLize 的 Model 类（静态注册器）
 *
 * MonSQLize 通过 `Model.define(collectionName, definition)` 注册 Model，
 * 通过 `monsqlize.model(collectionName)` 获取已注册的 Model 实例。
 * 这两个 API 不可混淆：前者是静态注册，后者是实例获取。
 *
 * @returns Model 类（含 define / has / get 静态方法）
 */
async function getModelClass(): Promise<{
  define: (name: string, definition: any) => void;
  redefine: (name: string, definition: any) => void;
  has: (name: string) => boolean;
}> {
  return loadMonSQLizeModelClass();
}

/**
 * 加载 Model 定义
 *
 * 支持两种来源（可同时使用）：
 *   1. 共享 Model 包（config.sharedPackage）
 *   2. 本地 models/ 目录（config.dir，默认 'models'）
 *
 * @param monsqlize    MonSQLize 实例（已连接）
 * @param modelsConfig Model 配置（来自 app.config.database.models）
 * @param app          插件上下文（用于日志）
 * @param srcDir       src/ 目录的绝对路径（用于定位 models/ 目录）
 */
export async function loadModels(
  monsqlize: MonSQLize,
  modelsConfig: MonSQLizeDatabaseConfig["models"] | undefined,
  app: VextPluginContext,
  srcDir: string,
): Promise<void> {
  const config = {
    dir: modelsConfig?.dir ?? "models",
    autoRegister: modelsConfig?.autoRegister ?? true,
    sharedPackage: modelsConfig?.sharedPackage,
  };

  if (!config.autoRegister) {
    app.logger.debug("[monsqlize] model auto-register disabled");
    return;
  }

  let modelCount = 0;
  let sharedKeys = new Set<string>();

  // ── 1. 加载共享 Model 包 ──────────────────────────────────
  if (config.sharedPackage) {
    const shared = await loadSharedModels(monsqlize, config.sharedPackage, app);
    modelCount += shared.count;
    sharedKeys = shared.keys;
  }

  // ── 2. 加载本地 models/ 目录 ──────────────────────────────
  const modelsDir = join(srcDir, config.dir);

  if (!existsSync(modelsDir)) {
    if (!config.sharedPackage) {
      app.logger.debug(
        "[monsqlize] no models/ directory found — skipping model loading",
      );
    }
    if (modelCount > 0) {
      app.logger.info(
        `[monsqlize] ${modelCount} model(s) loaded (shared only)`,
      );
    }
    return;
  }

  modelCount += await loadLocalModels(monsqlize, modelsDir, app, sharedKeys);

  if (modelCount > 0) {
    app.logger.info(`[monsqlize] ${modelCount} model(s) loaded`);
  }
}

/**
 * 加载共享 Model 包
 *
 * 支持两种导出格式：
 *   - export default { User: { ... }, Order: { ... } }
 *   - export function registerModels(monsqlize) { ... }
 *
 * @param monsqlize     MonSQLize 实例
 * @param packageName   共享包名（如 '@project/models'）
 * @param app           插件上下文
 * @returns 加载数量及本次共享对象导出拥有的注册键
 */
async function loadSharedModels(
  monsqlize: MonSQLize,
  packageName: string,
  app: VextPluginContext,
): Promise<{ count: number; keys: Set<string> }> {
  let count = 0;
  const keys = new Set<string>();

  try {
    const sharedModels = await import(packageName);

    if (
      sharedModels.default &&
      typeof sharedModels.default === "object" &&
      !Array.isArray(sharedModels.default)
    ) {
      // 格式 1：export default { User: { ... }, Order: { ... } }
      const ModelClass = await getModelClass();
      const definitions = Object.entries(sharedModels.default).flatMap(
        ([name, definition]) => {
          if (!definition || typeof definition !== "object") return [];
          const collectionName =
            ((definition as Record<string, unknown>).collection as
              | string
              | undefined) ??
            ((definition as Record<string, unknown>).name as
              | string
              | undefined) ??
            name;
          return [{ collectionName, definition }];
        },
      );
      for (const { collectionName } of definitions) {
        if (keys.has(collectionName) || ModelClass.has(collectionName)) {
          throw new Error(
            `[monsqlize] shared model key '${collectionName}' is already registered`,
          );
        }
        keys.add(collectionName);
      }
      for (const { collectionName, definition } of definitions) {
        ModelClass.define(collectionName, definition as any);
        count++;
        app.logger.debug(
          `[monsqlize] model loaded from shared: ${collectionName}`,
        );
      }
    } else if (
      sharedModels.registerModels &&
      typeof sharedModels.registerModels === "function"
    ) {
      // 格式 2：export function registerModels(monsqlize) { ... }
      await sharedModels.registerModels(monsqlize);
      app.logger.debug("[monsqlize] models loaded via registerModels()");
      // registerModels 内部注册，无法精确计数，标记为 1
      count++;
    } else {
      app.logger.warn(
        `[monsqlize] shared package "${packageName}" has no valid export ` +
          "(expected default object or registerModels function)",
      );
    }

    app.logger.info(`[monsqlize] shared models loaded from "${packageName}"`);
  } catch (err) {
    throw new Error(
      `[monsqlize] Failed to load shared model package "${packageName}":\n` +
        `  ${(err as Error).message}\n` +
        `  Make sure the package is installed: npm install ${packageName}`,
    );
  }

  return { count, keys };
}

interface ModelRegistryClass {
  define: (name: string, definition: any) => void;
  redefine: (name: string, definition: any) => void;
  has: (name: string) => boolean;
}

export interface LocalModelRegistrationState {
  sharedKeys: Set<string>;
  localKeys: Set<string>;
}

export function registerLocalModelEntry(
  ModelClass: ModelRegistryClass,
  entry: { registryKey: string; finalDef: Record<string, unknown> },
  aliasKey: string | undefined,
  file: string,
  state: LocalModelRegistrationState,
): "defined" | "redefined" {
  const { registryKey, finalDef } = entry;
  if (state.localKeys.has(registryKey)) {
    throw new Error(
      `[monsqlize] models/${file} — duplicate local model key '${registryKey}'`,
    );
  }

  const primaryExists = ModelClass.has(registryKey);
  if (primaryExists && !state.sharedKeys.has(registryKey)) {
    throw new Error(
      `[monsqlize] models/${file} — model key '${registryKey}' is already registered outside the configured shared model object`,
    );
  }

  if (
    aliasKey &&
    aliasKey !== registryKey &&
    (state.localKeys.has(aliasKey) ||
      state.sharedKeys.has(aliasKey) ||
      ModelClass.has(aliasKey))
  ) {
    throw new Error(
      `[monsqlize] models/${file} — model alias key '${aliasKey}' is already registered`,
    );
  }

  const action = primaryExists ? "redefined" : "defined";
  if (primaryExists) {
    ModelClass.redefine(registryKey, finalDef as any);
  } else {
    ModelClass.define(registryKey, finalDef as any);
  }
  state.localKeys.add(registryKey);

  if (aliasKey && aliasKey !== registryKey) {
    ModelClass.define(aliasKey, finalDef as any);
    state.localKeys.add(aliasKey);
  }

  return action;
}

/**
 * 加载本地 models/ 目录下的 Model 定义文件
 *
 * 递归扫描目录，按文件名字母排序加载。
 * 每个文件应 export default 一个 Model 定义对象。
 *
 * @param monsqlize  MonSQLize 实例
 * @param modelsDir  models/ 目录绝对路径
 * @param app        插件上下文
 * @returns 加载的 Model 数量
 */
async function loadLocalModels(
  monsqlize: MonSQLize,
  modelsDir: string,
  app: VextPluginContext,
  sharedKeys: Set<string>,
): Promise<number> {
  let count = 0;

  // 使用 fast-glob 扫描（vext 已有此依赖）
  const { default: fg } = await import("fast-glob");
  const files = await fg("**/*.{ts,js,mjs,cjs}", {
    cwd: modelsDir,
    ignore: [
      "**/_*.{ts,js,mjs,cjs}",
      "**/*.d.ts",
      "**/*.test.{ts,js,mjs,cjs}",
      "**/*.spec.{ts,js,mjs,cjs}",
    ],
  });
  const ModelClass = await getModelClass();
  const registrationState: LocalModelRegistrationState = {
    sharedKeys,
    localKeys: new Set<string>(),
  };

  // 按字母序排列，确保加载顺序可预测
  for (const file of files.sort()) {
    const filePath = join(modelsDir, file);

    let mod: Record<string, unknown>;
    try {
      mod = await importModelFile(filePath);
    } catch (err) {
      app.logger.warn(
        `[monsqlize] models/${file} — failed to import: ${(err as Error).message}`,
      );
      continue;
    }

    // CJS/ESM interop 处理：
    // esbuild 将 ESM 编译为 CJS 时会输出 { __esModule: true, default: { ... } }。
    // Node.js 动态 import() CJS 模块时，把 module.exports 整体当作 default，
    // 导致 mod.default = { __esModule: true, default: { name, schema, ... } }（双层嵌套）。
    // 需要解包到真正的 definition 对象。
    let definition = mod.default;
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
      app.logger.warn(
        `[monsqlize] models/${file} — invalid export (expected default object), skipped`,
      );
      continue;
    }

    // 集合名称：定义对象中的 collection 字段优先，其次 name 字段，最后从文件名推断
    const def = definition as Record<string, unknown>;

    // N4: 使用 resolveModelEntry 统一处理 0-depth / 1-depth / 2-depth 逻辑
    const entry = resolveModelEntry(file, def);
    if (!entry) {
      const depthCount = file.replace(/\.\w+$/, "").split(/[/\\]/).length - 1;
      app.logger.warn(
        `[monsqlize] models/${file} — directory depth ${depthCount} exceeds maximum (2), skipped`,
      );
      continue;
    }
    const { registryKey, finalDef } = entry;
    const aliasKey = def.key as string | undefined;
    const action = registerLocalModelEntry(
      ModelClass,
      { registryKey, finalDef },
      aliasKey,
      file,
      registrationState,
    );
    count++;
    app.logger.debug(
      `[monsqlize] model ${action}: ${registryKey} (from ${file})`,
    );

    if (aliasKey && aliasKey !== registryKey) {
      app.logger.debug(
        `[monsqlize] model alias '${aliasKey}' registered (from ${file})`,
      );
    }
  }

  return count;
}

/**
 * 导入 Model 文件
 *
 * 处理 Windows ESM 路径问题（ERR_UNSUPPORTED_ESM_URL_SCHEME），
 * 使用 pathToFileURL 转换为 file:// URL。
 *
 * @param filePath Model 文件绝对路径
 * @returns 模块导出对象
 */
async function importModelFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  const { pathToFileURL } = await import("node:url");
  const fileUrl = pathToFileURL(filePath).href;
  return import(fileUrl);
}

/**
 * 从文件路径推断 Model 名称
 *
 * 规则：
 *   - 去除扩展名
 *   - 按目录分隔符拆分
 *   - 每段按 - 或 _ 拆分，首字母大写后拼接
 *   - 所有段拼接（PascalCase）
 *
 * @example
 * deriveModelName('user.ts')             → 'User'
 * deriveModelName('order-item.ts')       → 'OrderItem'
 * deriveModelName('admin/role.ts')       → 'AdminRole'
 * deriveModelName('billing/invoice.ts')  → 'BillingInvoice'
 * deriveModelName('user_profile.ts')     → 'UserProfile'
 */
export function deriveModelName(filePath: string): string {
  // 去除扩展名
  const withoutExt = filePath.replace(/\.\w+$/, "");
  // 按目录分隔符拆分（支持 / 和 \）
  const parts = withoutExt.split(/[/\\]/);

  return parts
    .map((part) =>
      part
        .split(/[-_]/)
        .map(
          (segment) =>
            segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase(),
        )
        .join(""),
    )
    .join("");
}

/**
 * resolveModelEntry — 计算 Model 注册信息
 *
 * 根据文件相对路径和定义对象，返回：
 *   - registryKey：注册到 MonSQLize 的键名（用于 app.db.model()）
 *   - finalDef：最终定义对象（深度 >= 1 时自动注入 name / connection）
 *   - depth：目录深度（文件名以外的路径段数）
 *
 * **深度规则：**
 *
 * | 深度 | 示例                   | 行为                                         |
 * |------|------------------------|----------------------------------------------|
 * | 0    | `order.ts`             | 行为不变，registry key = def.collection ?? def.name ?? PascalCase(file) |
 * | 1    | `a/order.ts`           | key = 'AOrder'，自动注入 name:'order', connection:{database:'a'} |
 * | 2    | `c/a/order.ts`         | key = 'CAOrder'，自动注入 name:'order', connection:{pool:'c',database:'a'} |
 * | >= 3 | `x/c/a/order.ts`       | 返回 null（调用方应发出警告并跳过）               |
 *
 * **优先级：**
 * - 用户在定义对象中显式设置的 `collection` / `name` / `connection` 字段均会覆盖自动推断值。
 *
 * @param file  相对于 models/ 目录的文件路径，如 'a/order.ts' 或 'order.ts'
 * @param def   Model 定义对象（来自文件的 export default）
 * @returns     注册信息，或 null（深度超限时）
 */
export function resolveModelEntry(
  file: string,
  def: Record<string, unknown>,
): {
  registryKey: string;
  finalDef: Record<string, unknown>;
  depth: number;
} | null {
  const withoutExt = file.replace(/\.\w+$/, "");
  const parts = withoutExt.split(/[/\\]/);
  const depth = parts.length - 1;

  if (depth >= 3) {
    return null;
  }

  if (depth === 0) {
    // 0-depth：保持现有行为不变
    const registryKey =
      (def.collection as string | undefined) ??
      (def.name as string | undefined) ??
      deriveModelName(file);
    return { registryKey, finalDef: def, depth };
  }

  // 1-2 depth：N4 目录路由
  const registryKey = deriveModelName(file);
  const rawBase = parts[parts.length - 1]!; // 原始文件名（不含扩展名，不做 PascalCase）
  const finalDef: Record<string, unknown> = { ...def };

  // 未设置 collection/name 时，自动以文件名作为 MongoDB 集合名
  if (!def.collection && !def.name) {
    finalDef.name = rawBase;
  }

  // 未设置 connection 时，根据目录层级自动注入路由信息
  if (!def.connection) {
    if (depth === 1) {
      finalDef.connection = { database: parts[0] };
    } else {
      // depth === 2
      finalDef.connection = { pool: parts[0], database: parts[1] };
    }
  }

  return { registryKey, finalDef, depth };
}
