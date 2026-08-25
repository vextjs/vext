/**
 * config-loader.ts — 配置加载器
 *
 * 负责加载并合并配置文件（default → config profile → local），
 * 执行 Fail Fast 校验，然后 deepFreeze 返回只读配置对象。
 *
 * 合并规则（含 CJS interop 支持）：
 *   - 普通标量（port、host）：覆盖（后者优先）
 *   - 普通对象（logger、cors）：深度合并（只覆盖写了的子字段）
 *   - middlewares[] 数组：按 name patch 合并（匹配则浅合并，未匹配则追加）
 *
 * 配置文件结构：
 *   src/config/
 *   ├── default.ts       — 基准配置（必须存在）
 *   ├── development.ts   — 开发 profile 覆盖（可选）
 *   ├── production.ts    — 生产 profile 覆盖（可选）
 *   └── local.ts         — 本地覆盖（最高优先级，可选，不提交 git）
 *
 * @module lib/config-loader
 * @see 05-config.md §5（配置合并规则）
 * @see IMPLEMENTATION-PLAN.md 任务 1.1
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type {
  VextConfig,
  VextCorsConfig,
  VextMiddlewareConfig,
} from "../types/app.js";
import { DEFAULT_CONFIG } from "./app.js";
import {
  BUILT_IN_ADAPTER_NAMES,
  createUnknownAdapterError,
} from "./adapter-resolver.js";
import {
  loadBootstrapConfigPatch,
  type BootstrapCommand,
} from "./bootstrap-config.js";
import {
  getDefaultRuntimeMode,
  resolveConfigProfile,
  validateConfigProfileName,
  type RuntimeMode,
} from "./config-profile.js";
import { importUserModule } from "./user-module-loader.js";
import { assertCorsCredentialPolicy } from "./cors-config.js";

// ── 常量 ────────────────────────────────────────────────────

const FETCH_PROXY_RESERVED_TARGET_NAMES = new Set(["then"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OPENAPI_DOCS_ACCESS_MODES = ["off", "visibility-only", "enforce"];
const OPENAPI_DOCS_DEFAULT_VIEWS = ["overview", "api", "code"];
const OPENAPI_DOCS_THEMES = ["system", "light", "dark"];
const OPENAPI_DOCS_DENSITIES = ["comfortable", "compact"];
const OPENAPI_DOCS_SCAN_MODES = ["lazy", "background"];
const OPENAPI_DOCS_OPENAPI_JSON_MODES = ["filtered", "public"];
const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * 支持的配置文件扩展名（按优先级排序）
 *
 * 优先 .ts（TypeScript 项目推荐），其次 .js / .mjs / .cjs（兼容纯 JS 项目）。
 */
const EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;
const resolvedConfigFiles = new Map<string, string | null>();

// ── 中间件声明类型 ──────────────────────────────────────────

/**
 * 中间件声明的两种形式：
 *   - 字符串：中间件名称（如 'auth'）
 *   - 对象：带配置的中间件声明（如 { name: 'auth', options: { ... } }）
 */
type MiddlewareDecl = string | (VextMiddlewareConfig & { enabled?: boolean });

export interface LoadConfigMetadata {
  providerPatch?: Record<string, unknown>;
}

export interface LoadConfigOptions {
  rootDir?: string;
  command?: BootstrapCommand;
  isBuilt?: boolean;
  configProfile?: string;
  mode?: RuntimeMode;
  env?: NodeJS.ProcessEnv;
  meta?: LoadConfigMetadata;
}

// ── 文件解析 ────────────────────────────────────────────────

/**
 * 在 configDir 下查找指定名称的配置文件
 *
 * 按 EXTENSIONS 顺序尝试，返回第一个存在的文件路径。
 *
 * @param configDir 配置目录绝对路径
 * @param name      文件名（不含扩展名），如 'default'、'production'、'local'
 * @returns 完整文件路径，或 null（不存在）
 */
function resolveConfigFile(configDir: string, name: string): string | null {
  const cacheKey = `${configDir}\0${name}`;
  if (resolvedConfigFiles.has(cacheKey)) {
    return resolvedConfigFiles.get(cacheKey) ?? null;
  }

  for (const ext of EXTENSIONS) {
    const full = path.join(configDir, `${name}${ext}`);
    if (existsSync(full)) {
      resolvedConfigFiles.set(cacheKey, full);
      return full;
    }
  }
  resolvedConfigFiles.set(cacheKey, null);
  return null;
}

// ── 深度合并 ────────────────────────────────────────────────

/**
 * 深度合并两个对象（target 上叠加 source）
 *
 * 合并策略：
 *   - 普通对象：递归合并（只覆盖 source 中有的字段，其余继承 target）
 *   - 数组：整体覆盖（非 middlewares，middlewares 走专用 patch）
 *   - 标量 / null / undefined：source 覆盖 target
 *
 * 注意：middlewares 字段不在此函数中处理，由 patchMiddlewares 单独处理。
 *
 * @param target 基准对象
 * @param source 覆盖对象
 * @returns 合并后的新对象（不修改 target 和 source）
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  return deepMergeRecords(target, source, new WeakMap(), true) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPrototypePollutionKey(key: string): boolean {
  return PROTOTYPE_POLLUTION_KEYS.has(key);
}

function cloneConfigValue<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached as T;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneConfigValue(item, seen));
    return result as T;
  }

  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    if (isPrototypePollutionKey(key)) continue;
    result[key] = cloneConfigValue(item, seen);
  }
  return result as T;
}

function deepMergeRecords(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceSeen: WeakMap<object, unknown>,
  skipMiddlewares: boolean,
): Record<string, unknown> {
  const cached = sourceSeen.get(source);
  if (cached !== undefined) return cached as Record<string, unknown>;

  const result = cloneConfigValue(target);
  sourceSeen.set(source, result);

  for (const key of Object.keys(source)) {
    if (isPrototypePollutionKey(key)) continue;

    const sv = source[key];
    const tv = target[key];

    // 跳过 middlewares — 由 patchMiddlewares 专门处理
    if (skipMiddlewares && key === "middlewares") continue;

    if (isPlainObject(sv) && isPlainObject(tv)) {
      // 两边都是普通对象 → 递归深度合并
      result[key] = deepMergeRecords(tv, sv, sourceSeen, false);
    } else {
      // 标量、数组、null → 独立克隆后覆盖
      result[key] = cloneConfigValue(sv, sourceSeen);
    }
  }

  return result;
}

function mergeIntoOwnedRecord(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceSeen = new WeakMap<object, unknown>(),
  skipMiddlewares = true,
): Record<string, unknown> {
  sourceSeen.set(source, target);
  for (const [key, sourceValue] of Object.entries(source)) {
    if (isPrototypePollutionKey(key)) continue;
    if (skipMiddlewares && key === "middlewares") continue;

    const targetValue = target[key];
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      const cached = sourceSeen.get(sourceValue);
      if (cached !== undefined) {
        target[key] = cached;
        continue;
      }
      const nestedTarget = Object.isFrozen(targetValue)
        ? { ...targetValue }
        : targetValue;
      target[key] = mergeIntoOwnedRecord(
        nestedTarget,
        sourceValue,
        sourceSeen,
        false,
      );
    } else {
      target[key] = cloneConfigValue(sourceValue, sourceSeen);
    }
  }
  return target;
}

// ── middlewares patch 合并 ───────────────────────────────────

/**
 * 提取中间件声明的 name
 */
function getMiddlewareName(decl: MiddlewareDecl): string {
  return typeof decl === "string" ? decl : decl.name;
}

/**
 * middlewares 专用 patch 合并
 *
 * 按 name 匹配：
 *   1. 以 base 数组为基准（保持原始顺序）
 *   2. override 中每一项按 name 在 base 中查找
 *   3. 匹配到 → 浅合并该项（options / enabled 等字段覆盖）
 *   4. 未匹配到 → 追加到数组末尾
 *
 * @param base     基准数组（来自 default.ts 或上一层合并结果）
 * @param override 覆盖数组（来自 env.ts 或 local.ts）
 * @returns 合并后的新数组
 */
function patchMiddlewares(
  base: MiddlewareDecl[],
  override: MiddlewareDecl[],
): MiddlewareDecl[] {
  // 拷贝 base，统一为独立引用
  const result = cloneConfigValue(base);
  const layerNames = new Set<string>();

  for (const item of override) {
    const name = getMiddlewareName(item);
    if (layerNames.has(name)) {
      throw new Error(
        `[vextjs] config.middlewares contains duplicate name "${name}" in the same configuration layer.`,
      );
    }
    layerNames.add(name);
    const idx = result.findIndex((d) => getMiddlewareName(d) === name);

    if (idx !== -1) {
      // 匹配到 → 声明级浅合并：options / enabled 等字段整项覆盖，不深度合并 options
      const existing = result[idx]!;
      const baseObj =
        typeof existing === "string"
          ? { name: existing }
          : { ...(existing as VextMiddlewareConfig) };
      const overrideObj =
        typeof item === "string"
          ? { name: item }
          : { ...(item as VextMiddlewareConfig) };
      const merged = {
        ...baseObj,
        ...overrideObj,
      } as VextMiddlewareConfig;
      if (merged.options !== undefined) {
        merged.options = cloneConfigValue(merged.options);
      }
      result[idx] = merged;
    } else {
      // 未匹配到 → 追加
      result.push(cloneConfigValue(item));
    }
  }

  return result;
}

function applyConfigLayer(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const beforeOverride = { ...base };
  const merged = mergeIntoOwnedRecord(base, override);

  if (override.middlewares !== undefined) {
    merged.middlewares = Array.isArray(override.middlewares)
      ? patchMiddlewares(
          (beforeOverride.middlewares as MiddlewareDecl[] | undefined) ?? [],
          override.middlewares as MiddlewareDecl[],
        )
      : override.middlewares;
  }

  return merged;
}

function applyCliOverrides(
  merged: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (env.VEXT_PORT) {
    const rawPort = env.VEXT_PORT.trim();
    const cliPort = Number(rawPort);
    if (
      /^\d+$/.test(rawPort) &&
      Number.isInteger(cliPort) &&
      cliPort >= 1 &&
      cliPort <= 65535
    ) {
      merged.port = cliPort;
    }
  }

  if (env.VEXT_HOST) {
    merged.host = env.VEXT_HOST;
  }

  if (env.VEXT_LIFECYCLE_LEVEL) {
    const lifecycleLevel = env.VEXT_LIFECYCLE_LEVEL;
    if (lifecycleLevel === "concise" || lifecycleLevel === "verbose") {
      const logger = {
        ...((merged.logger as Record<string, unknown> | undefined) ?? {}),
        lifecycleLevel,
      };
      merged.logger = logger;
    }
  }

  return merged;
}

// ── deepFreeze ──────────────────────────────────────────────

/**
 * 递归深冻结对象
 *
 * Object.freeze 只冻结顶层属性（浅冻结），嵌套对象仍可被修改。
 * deepFreeze 递归冻结所有层级，确保 config 完全只读。
 *
 * 跳过规则：
 *   - null / 非对象 / 已冻结对象 → 避免无意义递归
 *   - Date / RegExp / Buffer / Map / Set 等非纯对象 →
 *     冻结这些对象会破坏其内部状态（如 Date.setTime() 失效）
 *   - 跳过非纯对象的检查（Q23：不要冻结非纯对象）
 *
 * @param obj 待冻结对象
 * @returns 冻结后的对象（同一引用）
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }

  // 跳过非纯对象（Date / RegExp / Buffer / TypedArray / Map / Set 等）
  // 这些对象有内部 slot，冻结后其变异方法会静默失败或抛错
  if (
    obj instanceof Date ||
    obj instanceof RegExp ||
    obj instanceof Map ||
    obj instanceof Set ||
    ArrayBuffer.isView(obj) // Buffer / TypedArray
  ) {
    return obj;
  }

  // Redis clients and other class instances may keep mutable internal slots.
  // Freeze only arrays and plain objects so config files can carry advanced
  // object references without breaking their runtime behavior.
  const proto = Object.getPrototypeOf(obj);
  if (!Array.isArray(obj) && proto !== Object.prototype && proto !== null) {
    return obj;
  }

  Object.freeze(obj);

  for (const value of Object.values(obj as Record<string, unknown>)) {
    deepFreeze(value);
  }

  return obj;
}

let internalDefaultConfig: Readonly<Record<string, unknown>> | undefined;

function getInternalDefaultConfig(): Readonly<Record<string, unknown>> {
  internalDefaultConfig ??= deepFreeze(
    cloneConfigValue(DEFAULT_CONFIG as unknown as Record<string, unknown>),
  );
  return internalDefaultConfig;
}

// ── 配置校验（Fail Fast）───────────────────────────────────

/**
 * 配置校验（启动时 Fail Fast）
 *
 * 在应用启动时立即校验配置合法性，发现问题立即抛出错误终止启动，
 * 避免运行时出现难以追踪的配置问题。
 *
 * @param config 合并后的配置对象
 * @throws Error 配置不合法时抛出描述性错误
 */
function validateConfig(config: Record<string, unknown>): void {
  // ── port ──────────────────────────────────────────────
  const port = config.port as number | undefined;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  ) {
    throw new Error(
      `[vextjs] config.port must be an integer between 1 and 65535, got: ${port}`,
    );
  }

  if (config.host !== undefined && typeof config.host !== "string") {
    throw new Error("[vextjs] config.host must be a string.");
  }
  if (
    config.trustProxy !== undefined &&
    typeof config.trustProxy !== "boolean"
  ) {
    throw new Error("[vextjs] config.trustProxy must be a boolean.");
  }

  // ── adapter（字符串标识 | 工厂函数 | 适配器对象）──────
  const adapter = config.adapter;
  if (adapter !== undefined) {
    if (typeof adapter === "string") {
      if (
        !BUILT_IN_ADAPTER_NAMES.includes(
          adapter as (typeof BUILT_IN_ADAPTER_NAMES)[number],
        )
      ) {
        throw createUnknownAdapterError(adapter);
      }
    } else if (typeof adapter === "function") {
      // factory form accepted; resolveAdapter validates the produced instance
    } else if (
      typeof adapter === "object" &&
      adapter !== null &&
      !Array.isArray(adapter)
    ) {
      // Reject incomplete objects early (e.g. {}). Full method checks stay in
      // resolveAdapter so documented partial name-only objects still load, but
      // empty / nameless objects must not pass config validation.
      const adapterName = (adapter as { name?: unknown }).name;
      if (typeof adapterName !== "string" || adapterName.trim().length === 0) {
        throw new Error(
          `[vextjs] config.adapter object is incomplete: missing non-empty "name".\n` +
            `         Provide a VextAdapter object (name + adapter methods), a factory function, or a built-in adapter string.`,
        );
      }
    } else {
      throw new Error(
        `[vextjs] config.adapter must be a string (built-in name), a factory function, or an adapter object,` +
          ` got: ${adapter === null ? "null" : typeof adapter}`,
      );
    }
  }

  // ── middlewares ────────────────────────────────────────
  const middlewares = config.middlewares as unknown[] | undefined;
  if (middlewares !== undefined) {
    if (!Array.isArray(middlewares)) {
      throw new Error("[vextjs] config.middlewares must be an array.");
    }
    const names = new Set<string>();
    for (let i = 0; i < middlewares.length; i++) {
      const m = middlewares[i];
      if (typeof m === "string") {
        if (m.trim().length === 0) {
          throw new Error(
            `[vextjs] config.middlewares[${i}] must be a non-empty string.`,
          );
        }
      } else if (!isPlainObject(m)) {
        throw new Error(
          `[vextjs] config.middlewares[${i}] must be a string or { name, options?, enabled? } object.`,
        );
      } else {
        if (typeof m.name !== "string" || m.name.trim().length === 0) {
          throw new Error(
            `[vextjs] config.middlewares[${i}].name must be a non-empty string.`,
          );
        }
        if (m.options !== undefined && !isPlainObject(m.options)) {
          throw new Error(
            `[vextjs] config.middlewares[${i}].options must be an object.`,
          );
        }
        if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
          throw new Error(
            `[vextjs] config.middlewares[${i}].enabled must be a boolean.`,
          );
        }
      }

      const name = typeof m === "string" ? m : (m.name as string);
      if (names.has(name)) {
        throw new Error(
          `[vextjs] config.middlewares contains duplicate name "${name}".`,
        );
      }
      names.add(name);
    }
  }

  validateCorsConfig(config.cors, "config.cors");
  validateRequestIdConfig(config.requestId, "config.requestId");
  validateBodyParserConfig(config.bodyParser, "config.bodyParser");
  validateMultipartConfig(config.multipart, "config.multipart");

  // ── rateLimit ─────────────────────────────────────────
  const rateLimit = config.rateLimit as Record<string, unknown> | undefined;
  if (rateLimit !== undefined) {
    if (typeof rateLimit !== "object" || rateLimit === null) {
      throw new Error("[vextjs] config.rateLimit must be an object.");
    }
    const max = rateLimit.max;
    if (max !== undefined && (typeof max !== "number" || max < 1)) {
      throw new Error(
        `[vextjs] config.rateLimit.max must be a positive number, got: ${max}`,
      );
    }
    const window = rateLimit.window;
    if (window !== undefined && (typeof window !== "number" || window < 1)) {
      throw new Error(
        `[vextjs] config.rateLimit.window must be a positive number (seconds), got: ${window}`,
      );
    }
  }

  // ── cluster ───────────────────────────────────────────
  const cluster = config.cluster as Record<string, unknown> | undefined;
  if (cluster !== undefined) {
    if (
      typeof cluster !== "object" ||
      cluster === null ||
      Array.isArray(cluster)
    ) {
      throw new Error("[vextjs] config.cluster must be an object.");
    }

    const workers = cluster.workers;
    if (workers !== undefined) {
      const validWorkerStrings = ["auto", "auto-1"];
      if (
        typeof workers === "string" &&
        !validWorkerStrings.includes(workers)
      ) {
        throw new Error(
          `[vextjs] config.cluster.workers must be a positive integer, "auto", or "auto-1", got: "${workers}"`,
        );
      } else if (
        typeof workers === "number" &&
        (!Number.isInteger(workers) || workers < 1)
      ) {
        throw new Error(
          `[vextjs] config.cluster.workers must be a positive integer, got: ${workers}`,
        );
      } else if (typeof workers !== "string" && typeof workers !== "number") {
        throw new Error(
          `[vextjs] config.cluster.workers must be a positive integer, "auto", or "auto-1", got: ${typeof workers}`,
        );
      }
    }

    if (cluster.enabled !== undefined && typeof cluster.enabled !== "boolean") {
      throw new Error("[vextjs] config.cluster.enabled must be a boolean.");
    }

    for (const field of ["maxRestarts"] as const) {
      const value = cluster[field];
      if (
        value !== undefined &&
        (!Number.isInteger(value) || (value as number) < 1)
      ) {
        throw new Error(
          `[vextjs] config.cluster.${field} must be a positive integer.`,
        );
      }
    }

    for (const field of [
      "restartWindow",
      "restartBaseDelay",
      "restartMaxDelay",
      "memoryThreshold",
    ] as const) {
      const value = cluster[field];
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      ) {
        throw new Error(
          `[vextjs] config.cluster.${field} must be a positive number.`,
        );
      }
    }

    for (const field of ["pidFile", "titlePrefix"] as const) {
      const value = cluster[field];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`[vextjs] config.cluster.${field} must be a string.`);
      }
    }

    if (
      cluster.sticky !== undefined &&
      !["none", "ip"].includes(String(cluster.sticky))
    ) {
      throw new Error('[vextjs] config.cluster.sticky must be "none" or "ip".');
    }

    for (const sectionName of ["healthCheck", "reload"] as const) {
      const section = cluster[sectionName];
      if (section === undefined) continue;
      if (
        typeof section !== "object" ||
        section === null ||
        Array.isArray(section)
      ) {
        throw new Error(
          `[vextjs] config.cluster.${sectionName} must be an object.`,
        );
      }
      const typed = section as Record<string, unknown>;
      if (typed.enabled !== undefined && typeof typed.enabled !== "boolean") {
        throw new Error(
          `[vextjs] config.cluster.${sectionName}.enabled must be a boolean.`,
        );
      }
      for (const [key, value] of Object.entries(typed)) {
        if (key === "enabled") continue;
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        ) {
          throw new Error(
            `[vextjs] config.cluster.${sectionName}.${key} must be a positive number.`,
          );
        }
      }
    }
  }

  // ── locale ────────────────────────────────────────────
  const locale = config.locale as Record<string, unknown> | undefined;
  if (locale !== undefined) {
    if (typeof locale !== "object" || locale === null) {
      throw new Error("[vextjs] config.locale must be an object.");
    }
    if (locale.default !== undefined && typeof locale.default !== "string") {
      throw new Error(
        `[vextjs] config.locale.default must be a string (e.g. "zh-CN"), got: ${typeof locale.default}`,
      );
    }
    if (locale.supported !== undefined) {
      if (!Array.isArray(locale.supported)) {
        throw new Error(
          "[vextjs] config.locale.supported must be an array of locale strings.",
        );
      }
      for (const s of locale.supported) {
        if (typeof s !== "string") {
          throw new Error(
            `[vextjs] config.locale.supported[] items must be strings, got: ${typeof s}`,
          );
        }
      }
    }
  }

  // ── logger ────────────────────────────────────────────
  const logger = config.logger as Record<string, unknown> | undefined;
  if (logger !== undefined) {
    if (typeof logger !== "object" || logger === null) {
      throw new Error("[vextjs] config.logger must be an object.");
    }
    const level = logger.level;
    if (level !== undefined) {
      const validLevels = [
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "silent",
      ];
      if (typeof level !== "string" || !validLevels.includes(level)) {
        throw new Error(
          `[vextjs] config.logger.level must be one of: ${validLevels.join(", ")}, got: "${level}"`,
        );
      }
    }
    if (logger.pretty !== undefined && typeof logger.pretty !== "boolean") {
      throw new Error("[vextjs] config.logger.pretty must be a boolean.");
    }
    if (logger.prettyColor !== undefined) {
      const validPrettyColors = ["auto", "always", "never"];
      if (
        typeof logger.prettyColor !== "string" ||
        !validPrettyColors.includes(logger.prettyColor)
      ) {
        throw new Error(
          `[vextjs] config.logger.prettyColor must be one of: ${validPrettyColors.join(", ")}, got: "${logger.prettyColor}"`,
        );
      }
    }
    if (logger.redactKeys !== undefined) {
      if (
        !Array.isArray(logger.redactKeys) ||
        logger.redactKeys.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          "[vextjs] config.logger.redactKeys must be an array of strings.",
        );
      }
    }
    if (logger.redactPaths !== undefined) {
      if (
        !Array.isArray(logger.redactPaths) ||
        logger.redactPaths.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          "[vextjs] config.logger.redactPaths must be an array of strings.",
        );
      }
    }
    if (
      logger.redactValue !== undefined &&
      typeof logger.redactValue !== "string"
    ) {
      throw new Error("[vextjs] config.logger.redactValue must be a string.");
    }
    if (logger.lifecycleLevel !== undefined) {
      const validLifecycleLevels = ["concise", "verbose"];
      if (
        typeof logger.lifecycleLevel !== "string" ||
        !validLifecycleLevels.includes(logger.lifecycleLevel)
      ) {
        throw new Error(
          `[vextjs] config.logger.lifecycleLevel must be one of: ${validLifecycleLevels.join(", ")}, got: "${logger.lifecycleLevel}"`,
        );
      }
    }
  }

  // ── shutdown ──────────────────────────────────────────
  const shutdown = config.shutdown as Record<string, unknown> | undefined;
  if (shutdown !== undefined) {
    if (typeof shutdown !== "object" || shutdown === null) {
      throw new Error("[vextjs] config.shutdown must be an object.");
    }
    const timeout = shutdown.timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
    ) {
      throw new Error(
        `[vextjs] config.shutdown.timeout must be a finite non-negative number (seconds), got: ${timeout}`,
      );
    }
  }

  // ── server ────────────────────────────────────────────
  validateServerConfig(config.server, "config.server");

  // ── accessLog ─────────────────────────────────────────
  const accessLog = config.accessLog as Record<string, unknown> | undefined;
  if (accessLog !== undefined) {
    if (typeof accessLog !== "object" || accessLog === null) {
      throw new Error("[vextjs] config.accessLog must be an object.");
    }
    if (
      accessLog.enabled !== undefined &&
      typeof accessLog.enabled !== "boolean"
    ) {
      throw new Error("[vextjs] config.accessLog.enabled must be a boolean.");
    }
    const alLevel = accessLog.level;
    if (alLevel !== undefined) {
      const validAlLevels = ["info", "debug"];
      if (typeof alLevel !== "string" || !validAlLevels.includes(alLevel)) {
        throw new Error(
          `[vextjs] config.accessLog.level must be one of: ${validAlLevels.join(", ")}, got: "${alLevel}"`,
        );
      }
    }
    if (accessLog.skipPaths !== undefined) {
      if (!Array.isArray(accessLog.skipPaths)) {
        throw new Error(
          "[vextjs] config.accessLog.skipPaths must be an array of strings.",
        );
      }
      for (const sp of accessLog.skipPaths) {
        if (typeof sp !== "string") {
          throw new Error(
            `[vextjs] config.accessLog.skipPaths[] items must be strings, got: ${typeof sp}`,
          );
        }
      }
    }
  }

  // ── openapi ───────────────────────────────────────────
  validateOpenAPIConfig(config.openapi, "config.openapi");

  // ── frontend ──────────────────────────────────────────
  validateFrontendConfig(config.frontend, "config.frontend");

  // ── requestContext ────────────────────────────────────
  const requestContext = config.requestContext as
    | Record<string, unknown>
    | undefined;
  if (requestContext !== undefined) {
    if (typeof requestContext !== "object" || requestContext === null) {
      throw new Error("[vextjs] config.requestContext must be an object.");
    }
    if (
      requestContext.enabled !== undefined &&
      typeof requestContext.enabled !== "boolean"
    ) {
      throw new Error(
        "[vextjs] config.requestContext.enabled must be a boolean.",
      );
    }
  }

  // ── session ────────────────────────────────────────────
  validateSessionConfig(config.session, "config.session");

  // ── csrf ───────────────────────────────────────────────
  validateCsrfConfig(config.csrf, "config.csrf");

  // ── securityHeaders ───────────────────────────────────
  validateSecurityHeadersConfig(
    config.securityHeaders,
    "config.securityHeaders",
  );

  // ── fetch ──────────────────────────────────────────────
  validateFetchConfig(config.fetch, "config.fetch");

  // ── cache ──────────────────────────────────────────────
  const cache = config.cache as Record<string, unknown> | undefined;
  if (cache !== undefined) {
    if (typeof cache !== "object" || cache === null) {
      throw new Error("[vextjs] config.cache must be an object.");
    }
    if (cache.enabled !== undefined && typeof cache.enabled !== "boolean") {
      throw new Error("[vextjs] config.cache.enabled must be a boolean.");
    }
    const defaultTtl = cache.defaultTtl;
    if (
      defaultTtl !== undefined &&
      (typeof defaultTtl !== "number" || defaultTtl <= 0)
    ) {
      throw new Error(
        `[vextjs] config.cache.defaultTtl must be a positive number (milliseconds), got: ${defaultTtl}`,
      );
    }
    const maxEntries = cache.maxEntries;
    if (
      maxEntries !== undefined &&
      (typeof maxEntries !== "number" ||
        !Number.isInteger(maxEntries) ||
        maxEntries < 1)
    ) {
      throw new Error(
        `[vextjs] config.cache.maxEntries must be a positive integer, got: ${maxEntries}`,
      );
    }
    const maxMemory = cache.maxMemory;
    if (
      maxMemory !== undefined &&
      (typeof maxMemory !== "number" || maxMemory <= 0)
    ) {
      throw new Error(
        `[vextjs] config.cache.maxMemory must be a positive number (bytes), got: ${maxMemory}`,
      );
    }
    const cleanupInterval = cache.cleanupInterval;
    if (
      cleanupInterval !== undefined &&
      (typeof cleanupInterval !== "number" || cleanupInterval < 0)
    ) {
      throw new Error(
        `[vextjs] config.cache.cleanupInterval must be a non-negative number (milliseconds), got: ${cleanupInterval}`,
      );
    }
    validateCacheHubConfig(cache.cacheHub, "config.cache.cacheHub");
  }
}

function validateCorsConfig(value: unknown, pathName: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`[vextjs] ${pathName} must be an object.`);
  }
  for (const field of ["enabled", "credentials"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(`[vextjs] ${pathName}.${field} must be a boolean.`);
    }
  }
  for (const field of ["origins", "methods", "headers"] as const) {
    const items = value[field];
    if (
      items !== undefined &&
      (!Array.isArray(items) || items.some((item) => typeof item !== "string"))
    ) {
      throw new Error(
        `[vextjs] ${pathName}.${field} must be an array of strings.`,
      );
    }
  }
  if (
    value.maxAge !== undefined &&
    (typeof value.maxAge !== "number" ||
      !Number.isFinite(value.maxAge) ||
      value.maxAge < 0)
  ) {
    throw new Error(
      `[vextjs] ${pathName}.maxAge must be a finite non-negative number.`,
    );
  }
  assertCorsCredentialPolicy(value as VextCorsConfig, pathName);
}

function validateRequestIdConfig(value: unknown, pathName: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`[vextjs] ${pathName} must be an object.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`[vextjs] ${pathName}.enabled must be a boolean.`);
  }
  for (const field of ["header", "responseHeader"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].trim().length === 0)
    ) {
      throw new Error(
        `[vextjs] ${pathName}.${field} must be a non-empty string.`,
      );
    }
  }
  if (value.generate !== undefined && typeof value.generate !== "function") {
    throw new Error(`[vextjs] ${pathName}.generate must be a function.`);
  }
}

function validateBodyParserConfig(value: unknown, pathName: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`[vextjs] ${pathName} must be an object.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`[vextjs] ${pathName}.enabled must be a boolean.`);
  }
  const maxBodySize = value.maxBodySize;
  if (
    maxBodySize !== undefined &&
    ((typeof maxBodySize !== "string" && typeof maxBodySize !== "number") ||
      (typeof maxBodySize === "number" &&
        (!Number.isFinite(maxBodySize) || maxBodySize <= 0)))
  ) {
    throw new Error(
      `[vextjs] ${pathName}.maxBodySize must be a size string or a positive finite number.`,
    );
  }
}

function validateMultipartConfig(value: unknown, pathName: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`[vextjs] ${pathName} must be an object.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`[vextjs] ${pathName}.enabled must be a boolean.`);
  }
  if (
    value.maxFileSize !== undefined &&
    (typeof value.maxFileSize !== "number" ||
      !Number.isFinite(value.maxFileSize) ||
      value.maxFileSize <= 0)
  ) {
    throw new Error(
      `[vextjs] ${pathName}.maxFileSize must be a positive finite number.`,
    );
  }
  if (
    value.maxFiles !== undefined &&
    (!Number.isInteger(value.maxFiles) || (value.maxFiles as number) < 1)
  ) {
    throw new Error(
      `[vextjs] ${pathName}.maxFiles must be a positive integer.`,
    );
  }
  if (
    value.allowedMimeTypes !== undefined &&
    (!Array.isArray(value.allowedMimeTypes) ||
      value.allowedMimeTypes.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `[vextjs] ${pathName}.allowedMimeTypes must be an array of strings.`,
    );
  }
}

function validateFrontendConfig(value: unknown, path: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }

  const frontend = value as Record<string, unknown>;
  if (frontend.enabled !== undefined && typeof frontend.enabled !== "boolean") {
    throw new Error(`[vextjs] ${path}.enabled must be a boolean.`);
  }
  for (const key of [
    "framework",
    "root",
    "componentsDir",
    "assetsDir",
    "entry",
    "indexHtml",
    "outDir",
    "publicDir",
    "publicPath",
  ]) {
    if (frontend[key] !== undefined && typeof frontend[key] !== "string") {
      throw new Error(`[vextjs] ${path}.${key} must be a string.`);
    }
  }
  if (
    typeof frontend.publicPath === "string" &&
    /^[a-z]+:\/\//i.test(frontend.publicPath)
  ) {
    throw new Error(`[vextjs] ${path}.publicPath must be a path, not a URL.`);
  }

  const pages = validateOptionalFrontendObject(frontend.pages, `${path}.pages`);
  if (pages) {
    validateOptionalString(pages.dir, `${path}.pages.dir`);
    validateOptionalStringArray(pages.extensions, `${path}.pages.extensions`);
    validateOptionalString(pages.document, `${path}.pages.document`);
    validateOptionalString(pages.errorDir, `${path}.pages.errorDir`);
  }

  const styles = validateOptionalFrontendObject(
    frontend.styles,
    `${path}.styles`,
  );
  if (styles) {
    validateOptionalString(styles.entry, `${path}.styles.entry`);
    validateFrontendBooleanOrObject(styles.jscss, `${path}.styles.jscss`, [
      "enabled",
      "dynamicVars",
      "recipes",
    ]);
    const jscss = styles.jscss as Record<string, unknown> | undefined;
    if (jscss && typeof jscss === "object" && !Array.isArray(jscss)) {
      validateOptionalStringArray(jscss.files, `${path}.styles.jscss.files`);
      if (jscss.runtimeAdapter !== false) {
        validateEnum(
          jscss.runtimeAdapter,
          `${path}.styles.jscss.runtimeAdapter`,
          ["css-variables", "none"],
        );
      }
      validateOptionalBoolean(
        jscss.dynamicVars,
        `${path}.styles.jscss.dynamicVars`,
      );
      validateOptionalBoolean(jscss.recipes, `${path}.styles.jscss.recipes`);
    }
  }

  validateStringRecord(frontend.alias, `${path}.alias`);

  validateFrontendBooleanOrObject(frontend.apiClient, `${path}.apiClient`, [
    "enabled",
  ]);
  validateFrontendBooleanOrObject(frontend.spaFallback, `${path}.spaFallback`, [
    "enabled",
  ]);
  const spaFallback = frontend.spaFallback as
    | Record<string, unknown>
    | undefined;
  if (
    spaFallback &&
    typeof spaFallback === "object" &&
    !Array.isArray(spaFallback)
  ) {
    validateOptionalStringArray(
      spaFallback.exclude,
      `${path}.spaFallback.exclude`,
    );
    validateSpaFallbackScopes(spaFallback.scopes, `${path}.spaFallback.scopes`);
  }

  const build = frontend.build;
  if (build !== undefined) {
    if (typeof build !== "object" || build === null || Array.isArray(build)) {
      throw new Error(`[vextjs] ${path}.build must be an object.`);
    }
    const typed = build as Record<string, unknown>;
    for (const key of ["minify", "sourcemap"]) {
      if (typed[key] !== undefined && typeof typed[key] !== "boolean") {
        throw new Error(`[vextjs] ${path}.build.${key} must be a boolean.`);
      }
    }
    if (
      typed.target !== undefined &&
      typeof typed.target !== "string" &&
      (!Array.isArray(typed.target) ||
        typed.target.some((item) => typeof item !== "string"))
    ) {
      throw new Error(
        `[vextjs] ${path}.build.target must be a string or string array.`,
      );
    }
    validateFrontendClientBuildTarget(typed.client, `${path}.build.client`);
    validateFrontendServerBuildTarget(typed.server, `${path}.build.server`);
    validateFrontendVendorChunks(
      typed.vendorChunks,
      `${path}.build.vendorChunks`,
    );
    validateFrontendBudgets(typed.budgets, `${path}.build.budgets`);
    const assets = validateOptionalFrontendObject(
      typed.assets,
      `${path}.build.assets`,
    );
    if (assets && assets.inlineLimit !== undefined) {
      validateNonNegativeInteger(
        assets.inlineLimit,
        `${path}.build.assets.inlineLimit`,
      );
    }
    const css = validateOptionalFrontendObject(typed.css, `${path}.build.css`);
    if (css) {
      validateOptionalBoolean(css.modules, `${path}.build.css.modules`);
    }
    const diagnostics = validateOptionalFrontendObject(
      typed.diagnostics,
      `${path}.build.diagnostics`,
    );
    if (diagnostics) {
      for (const key of [
        "metafile",
        "sizeReport",
        "performanceReport",
        "leakScan",
      ]) {
        validateOptionalBoolean(
          diagnostics[key],
          `${path}.build.diagnostics.${key}`,
        );
      }
    }
  }

  const deploy = validateOptionalFrontendObject(
    frontend.deploy,
    `${path}.deploy`,
  );
  if (deploy) {
    validateOptionalString(deploy.assetBaseUrl, `${path}.deploy.assetBaseUrl`);
    if (
      typeof deploy.assetBaseUrl === "string" &&
      !/^[a-z]+:\/\//i.test(deploy.assetBaseUrl)
    ) {
      throw new Error(
        `[vextjs] ${path}.deploy.assetBaseUrl must be an absolute URL.`,
      );
    }
    validateEnum(deploy.crossOrigin, `${path}.deploy.crossOrigin`, [
      "anonymous",
      "use-credentials",
    ]);
    validateOptionalBoolean(deploy.integrity, `${path}.deploy.integrity`);
    validateFrontendDeployUpload(deploy.upload, `${path}.deploy.upload`);
  }

  const render = validateOptionalFrontendObject(
    frontend.render,
    `${path}.render`,
  );
  if (render) {
    validateOptionalBoolean(render.ssr, `${path}.render.ssr`);
    validateEnum(render.fallback, `${path}.render.fallback`, [
      "client",
      "error",
    ]);
    if (render.timeoutMs !== undefined) {
      validatePositiveNumber(render.timeoutMs, `${path}.render.timeoutMs`);
    }
    validateOptionalBoolean(render.layout, `${path}.render.layout`);
  }

  const errorPages = validateOptionalFrontendObject(
    frontend.errorPages,
    `${path}.errorPages`,
  );
  if (errorPages) {
    validateOptionalString(errorPages.default, `${path}.errorPages.default`);
    validateStringRecord(errorPages.status, `${path}.errorPages.status`);
  }

  const i18n = validateOptionalFrontendObject(frontend.i18n, `${path}.i18n`);
  if (i18n) {
    validateOptionalBoolean(i18n.enabled, `${path}.i18n.enabled`);
    validateOptionalString(i18n.source, `${path}.i18n.source`);
    validateOptionalString(i18n.defaultLocale, `${path}.i18n.defaultLocale`);
    validateOptionalStringArray(i18n.detect, `${path}.i18n.detect`);
    validateEnum(i18n.inject, `${path}.i18n.inject`, ["used", "all"]);
    validateEnum(i18n.clientLoad, `${path}.i18n.clientLoad`, [
      "current",
      "all",
    ]);
    validateEnum(i18n.clientSwitch, `${path}.i18n.clientSwitch`, ["reload"]);
    validateOptionalBoolean(i18n.htmlLang, `${path}.i18n.htmlLang`);
    validateOptionalBoolean(i18n.vary, `${path}.i18n.vary`);
  }

  const dev = validateOptionalFrontendObject(frontend.dev, `${path}.dev`);
  if (dev) {
    for (const key of ["hot", "fastRefresh", "overlay"]) {
      validateOptionalBoolean(dev[key], `${path}.dev.${key}`);
    }
    validateEnum(dev.transport, `${path}.dev.transport`, ["sse"]);
    if (dev.debounceMs !== undefined) {
      validateNonNegativeInteger(dev.debounceMs, `${path}.dev.debounceMs`);
    }
    validateEnum(dev.renderRefresh, `${path}.dev.renderRefresh`, [
      "prompt",
      "auto",
      "off",
    ]);
  }
}

function validateOpenAPIConfig(value: unknown, pathName: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${pathName} must be an object.`);
  }

  const openapi = value as Record<string, unknown>;
  validateOptionalBoolean(openapi.enabled, `${pathName}.enabled`);
  validateOptionalUrlPath(openapi.docsPath, `${pathName}.docsPath`);
  validateOptionalUrlPath(openapi.jsonPath, `${pathName}.jsonPath`);
  validateOptionalUrlPath(openapi.jsonPublicPath, `${pathName}.jsonPublicPath`);
  validateOpenAPIServers(openapi.servers, `${pathName}.servers`);

  if (openapi.scalar !== undefined) {
    if (
      typeof openapi.scalar !== "object" ||
      openapi.scalar === null ||
      Array.isArray(openapi.scalar)
    ) {
      throw new Error(`[vextjs] ${pathName}.scalar must be an object.`);
    }
  }

  validateOpenAPIDocsConfig(openapi, pathName);
}

function validateOpenAPIDocsConfig(
  openapi: Record<string, unknown>,
  pathName: string,
): void {
  const docsValue = openapi.docs;
  if (docsValue === undefined) {
    return;
  }
  if (
    typeof docsValue !== "object" ||
    docsValue === null ||
    Array.isArray(docsValue)
  ) {
    throw new Error(`[vextjs] ${pathName}.docs must be an object.`);
  }

  const docs = docsValue as Record<string, unknown>;
  validateOptionalUrlPath(docs.path, `${pathName}.docs.path`);
  validateOptionalUrlPath(docs.assetsPath, `${pathName}.docs.assetsPath`);
  validateOptionalUrlPath(
    docs.assetsPublicPath,
    `${pathName}.docs.assetsPublicPath`,
  );
  validateDocsRenderer(docs.renderer, `${pathName}.docs.renderer`);
  validateDocsUiConfig(docs.ui, `${pathName}.docs.ui`);
  validateDocsCodeConfig(docs.code, `${pathName}.docs.code`);
  validateDocsAccessConfig(docs.access, `${pathName}.docs.access`);
  validateDocsTryItOutConfig(docs.tryItOut, `${pathName}.docs.tryItOut`);
  validateDocsSourcesConfig(docs.sources, `${pathName}.docs.sources`);

  const docsPath = docs.path ?? openapi.docsPath;
  const specPath = openapi.jsonPath;
  const specPublicPath = openapi.jsonPublicPath;
  const assetsPath = docs.assetsPath;
  const assetsPublicPath = docs.assetsPublicPath;
  if (
    typeof assetsPath === "string" &&
    ((typeof docsPath === "string" && assetsPath === docsPath) ||
      (typeof specPath === "string" && assetsPath === specPath))
  ) {
    throw new Error(
      `[vextjs] ${pathName}.docs.assetsPath must not equal docs or OpenAPI JSON paths.`,
    );
  }
  if (
    typeof assetsPublicPath === "string" &&
    ((typeof docsPath === "string" && assetsPublicPath === docsPath) ||
      (typeof specPath === "string" && assetsPublicPath === specPath) ||
      (typeof specPublicPath === "string" &&
        assetsPublicPath === specPublicPath))
  ) {
    throw new Error(
      `[vextjs] ${pathName}.docs.assetsPublicPath must not equal docs or OpenAPI JSON paths.`,
    );
  }
}

function validateDocsRenderer(value: unknown, pathName: string): void {
  if (value === undefined || value === "vext") {
    return;
  }
  throw new Error(
    `[vextjs] ${pathName} only supports "vext". Third-party docs renderer objects are no longer supported; external tools can consume /openapi.json.`,
  );
}

function validateDocsUiConfig(value: unknown, pathName: string): void {
  const ui = validateOptionalFrontendObject(value, pathName);
  if (!ui) {
    return;
  }
  validateOptionalString(ui.title, `${pathName}.title`);
  validateOptionalBoolean(ui.tryItOut, `${pathName}.tryItOut`);
  validateEnum(
    ui.defaultView,
    `${pathName}.defaultView`,
    OPENAPI_DOCS_DEFAULT_VIEWS,
  );
  validateEnum(ui.theme, `${pathName}.theme`, OPENAPI_DOCS_THEMES);
  validateEnum(ui.density, `${pathName}.density`, OPENAPI_DOCS_DENSITIES);
}

function validateDocsCodeConfig(value: unknown, pathName: string): void {
  const code = validateOptionalFrontendObject(value, pathName);
  if (!code) {
    return;
  }
  if (
    code.enabled !== undefined &&
    code.enabled !== "auto" &&
    typeof code.enabled !== "boolean"
  ) {
    throw new Error(
      `[vextjs] ${pathName}.enabled must be a boolean or "auto".`,
    );
  }
  validateEnum(code.scan, `${pathName}.scan`, OPENAPI_DOCS_SCAN_MODES);
  validateDocsCodeSource(code.services, `${pathName}.services`);
  validateDocsCodeSource(code.utils, `${pathName}.utils`);
  validateDocsCodeSource(code.models, `${pathName}.models`);
  validateDocsCodeSource(code.components, `${pathName}.components`);
  validateDocsCodeSource(code.plugins, `${pathName}.plugins`);
  validateDocsCodeSource(code.middlewares, `${pathName}.middlewares`);
  validateDocsCodeSource(code.locales, `${pathName}.locales`);
  validateDocsCodeSource(code.config, `${pathName}.config`);
  validateDocsCodeSource(code.preload, `${pathName}.preload`);
  validateDocsCodeSource(code.styles, `${pathName}.styles`);
}

function validateDocsCodeSource(value: unknown, pathName: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  const source = validateOptionalFrontendObject(value, pathName);
  if (!source) {
    return;
  }
  validateOptionalBoolean(source.enabled, `${pathName}.enabled`);
  validateOptionalRelativeProjectPath(source.dir, `${pathName}.dir`);
  validateOptionalString(source.title, `${pathName}.title`);
  validateOptionalStringArray(source.include, `${pathName}.include`);
  validateOptionalStringArray(source.exclude, `${pathName}.exclude`);
}

function validateDocsAccessConfig(value: unknown, pathName: string): void {
  const access = validateOptionalFrontendObject(value, pathName);
  if (!access) {
    return;
  }
  validateEnum(access.mode, `${pathName}.mode`, OPENAPI_DOCS_ACCESS_MODES);
  validateEnum(
    access.openapiJson,
    `${pathName}.openapiJson`,
    OPENAPI_DOCS_OPENAPI_JSON_MODES,
  );
  if (access.resolver !== undefined && typeof access.resolver !== "function") {
    throw new Error(`[vextjs] ${pathName}.resolver must be a function.`);
  }
  if (access.cacheKey !== undefined) {
    throw new Error(
      `[vextjs] ${pathName}.cacheKey is not supported by the current docs access pipeline.`,
    );
  }
}

function validateDocsTryItOutConfig(value: unknown, pathName: string): void {
  const tryItOut = validateOptionalFrontendObject(value, pathName);
  if (!tryItOut) {
    return;
  }
  validateOptionalString(tryItOut.hookScript, `${pathName}.hookScript`);
  validateOptionalString(tryItOut.hookGlobal, `${pathName}.hookGlobal`);
  validateOptionalString(tryItOut.defaultServer, `${pathName}.defaultServer`);
  validateOptionalBoolean(tryItOut.customServer, `${pathName}.customServer`);
  validateOptionalString(
    tryItOut.customServerUrl,
    `${pathName}.customServerUrl`,
  );
  if (
    tryItOut.sameOrigin !== undefined &&
    typeof tryItOut.sameOrigin !== "boolean" &&
    tryItOut.sameOrigin !== "auto"
  ) {
    throw new Error(
      `[vextjs] ${pathName}.sameOrigin must be a boolean or "auto".`,
    );
  }
}

function validateOpenAPIServers(value: unknown, pathName: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${pathName} must be an array.`);
  }
  for (const [index, item] of value.entries()) {
    const itemPath = `${pathName}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`[vextjs] ${itemPath} must be an object.`);
    }
    const server = item as Record<string, unknown>;
    validateRequiredString(server.url, `${itemPath}.url`);
    validateOptionalString(server.description, `${itemPath}.description`);
    if (server.variables === undefined) {
      continue;
    }
    if (
      typeof server.variables !== "object" ||
      server.variables === null ||
      Array.isArray(server.variables)
    ) {
      throw new Error(`[vextjs] ${itemPath}.variables must be an object.`);
    }
    for (const [name, variable] of Object.entries(
      server.variables as Record<string, unknown>,
    )) {
      const variablePath = `${itemPath}.variables.${name}`;
      if (
        typeof variable !== "object" ||
        variable === null ||
        Array.isArray(variable)
      ) {
        throw new Error(`[vextjs] ${variablePath} must be an object.`);
      }
      const typed = variable as Record<string, unknown>;
      validateRequiredString(typed.default, `${variablePath}.default`);
      validateOptionalStringArray(typed.enum, `${variablePath}.enum`);
      validateOptionalString(typed.description, `${variablePath}.description`);
    }
  }
}

function validateDocsSourcesConfig(value: unknown, pathName: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${pathName} must be an array.`);
  }
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${pathName}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`[vextjs] ${itemPath} must be an object.`);
    }
    const source = item as Record<string, unknown>;
    validateRequiredString(source.id, `${itemPath}.id`);
    const id = (source.id as string).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) {
      throw new Error(
        `[vextjs] ${itemPath}.id must contain only letters, numbers, "_" or "-".`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`[vextjs] ${itemPath}.id must be unique.`);
    }
    seen.add(id);
    validateOptionalString(source.label, `${itemPath}.label`);
    validateDocsSourceMatch(source.match, `${itemPath}.match`);
    validateOptionalString(source.version, `${itemPath}.version`);
    validateOptionalString(source.description, `${itemPath}.description`);
    validateOptionalBoolean(source.default, `${itemPath}.default`);
    validateDocsSourceAccess(source.access, `${itemPath}.access`);
    const code = validateOptionalFrontendObject(
      source.code,
      `${itemPath}.code`,
    );
    if (code) {
      validateOptionalStringArray(code.include, `${itemPath}.code.include`);
      validateOptionalStringArray(code.exclude, `${itemPath}.code.exclude`);
    }
  }
}

function validateDocsSourceAccess(value: unknown, pathName: string): void {
  if (value === undefined || typeof value === "string") {
    return;
  }
  const access = validateOptionalFrontendObject(value, pathName);
  if (!access) {
    return;
  }
  validateOptionalStringArray(access.roles, `${pathName}.roles`);
  validateOptionalStringArray(access.permissions, `${pathName}.permissions`);
  validateOptionalBoolean(access.visible, `${pathName}.visible`);
  validateOptionalBoolean(access.tryItOut, `${pathName}.tryItOut`);
  validateOptionalString(access.group, `${pathName}.group`);
}

function validateDocsSourceMatch(value: unknown, pathName: string): void {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new Error(`[vextjs] ${pathName} must not be empty.`);
    }
    return;
  }
  validateOptionalStringArray(value, pathName);
  if (Array.isArray(value) && value.length === 0) {
    throw new Error(`[vextjs] ${pathName} must not be empty.`);
  }
}

function validateOptionalUrlPath(value: unknown, pathName: string): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
  ) {
    throw new Error(
      `[vextjs] ${pathName} must be a URL path starting with "/".`,
    );
  }
}

function validateOptionalRelativeProjectPath(
  value: unknown,
  pathName: string,
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(
      `[vextjs] ${pathName} must be a relative path inside the project root.`,
    );
  }
}

function validateOptionalFrontendObject(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function validateOptionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`[vextjs] ${path} must be a boolean.`);
  }
}

function validateEnum(
  value: unknown,
  path: string,
  allowed: readonly string[],
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(
      `[vextjs] ${path} must be ${allowed
        .map((item) => `"${item}"`)
        .join(" or ")}.`,
    );
  }
}

function validateSpaFallbackScopes(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an array.`);
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`[vextjs] ${itemPath} must be an object.`);
    }
    const scope = item as Record<string, unknown>;
    validateRequiredString(scope.basePath, `${itemPath}.basePath`);
    validateRequiredString(scope.page, `${itemPath}.page`);
    validateOptionalBoolean(scope.ssr, `${itemPath}.ssr`);
    validateOptionalStringArray(scope.exclude, `${itemPath}.exclude`);
    if (scope.status !== undefined) {
      if (
        typeof scope.status !== "number" ||
        !Number.isInteger(scope.status) ||
        scope.status < 100 ||
        scope.status > 599
      ) {
        throw new Error(
          `[vextjs] ${itemPath}.status must be an HTTP status code between 100 and 599.`,
        );
      }
    }
  });
}

function validateFrontendClientBuildTarget(value: unknown, path: string): void {
  const target = validateOptionalFrontendObject(value, path);
  if (!target) {
    return;
  }
  rejectUnsupportedFrontendBuildKeys(
    target,
    path,
    ["outDir", "outFile", "manifest"],
    "Browser builds write to config.frontend.outDir and always emit the Vext manifest family.",
  );
  for (const key of ["assetsDir", "entryNames", "chunkNames", "assetNames"]) {
    validateOptionalString(target[key], `${path}.${key}`);
  }
  if (
    target.target !== undefined &&
    typeof target.target !== "string" &&
    (!Array.isArray(target.target) ||
      target.target.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `[vextjs] ${path}.target must be a string or string array.`,
    );
  }
  for (const key of ["minify", "sourcemap", "splitting"]) {
    validateOptionalBoolean(target[key], `${path}.${key}`);
  }
  validateOptionalStringArray(target.external, `${path}.external`);
  validateFrontendExternalRuntime(
    target.externalRuntime,
    `${path}.externalRuntime`,
  );
}

function validateFrontendServerBuildTarget(value: unknown, path: string): void {
  const target = validateOptionalFrontendObject(value, path);
  if (!target) {
    return;
  }
  rejectUnsupportedFrontendBuildKeys(
    target,
    path,
    [
      "outDir",
      "assetsDir",
      "entryNames",
      "chunkNames",
      "assetNames",
      "splitting",
      "manifest",
      "externalRuntime",
    ],
    "The frontend SSR renderer supports outFile, target, minify, sourcemap, and external.",
  );
  validateOptionalString(target.outFile, `${path}.outFile`);
  if (
    target.target !== undefined &&
    typeof target.target !== "string" &&
    (!Array.isArray(target.target) ||
      target.target.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      `[vextjs] ${path}.target must be a string or string array.`,
    );
  }
  for (const key of ["minify", "sourcemap"]) {
    validateOptionalBoolean(target[key], `${path}.${key}`);
  }
  validateOptionalStringArray(target.external, `${path}.external`);
}

function rejectUnsupportedFrontendBuildKeys(
  target: Record<string, unknown>,
  path: string,
  keys: string[],
  guidance: string,
): void {
  for (const key of keys) {
    if (target[key] !== undefined) {
      throw new Error(`[vextjs] ${path}.${key} is not supported. ${guidance}`);
    }
  }
}

function validateFrontendExternalRuntime(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }
  for (const [specifier, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const itemPath = `${path}.${specifier}`;
    if (typeof entry === "string") {
      if (!/^[a-z]+:\/\//i.test(entry)) {
        throw new Error(`[vextjs] ${itemPath} must be an absolute URL.`);
      }
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `[vextjs] ${itemPath} must be a URL string or an object.`,
      );
    }
    const typed = entry as Record<string, unknown>;
    validateRequiredString(typed.url, `${itemPath}.url`);
    if (!/^[a-z]+:\/\//i.test(typed.url as string)) {
      throw new Error(`[vextjs] ${itemPath}.url must be an absolute URL.`);
    }
    validateOptionalString(typed.integrity, `${itemPath}.integrity`);
    validateEnum(typed.crossOrigin, `${itemPath}.crossOrigin`, [
      "anonymous",
      "use-credentials",
    ]);
  }
}

function validateFrontendVendorChunks(value: unknown, path: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }
  const typed = value as Record<string, unknown>;
  validateOptionalBoolean(typed.enabled, `${path}.enabled`);
  validateOptionalStringArray(typed.packages, `${path}.packages`);
  validateOptionalString(typed.entryName, `${path}.entryName`);
}

function validateFrontendBudgets(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }
  const typed = value as Record<string, unknown>;
  for (const key of [
    "maxAssetBytes",
    "maxInitialJsBytes",
    "maxInitialJsGzipBytes",
    "maxInitialJsBrotliBytes",
    "maxRouteInitialJsBrotliBytes",
    "maxAppOwnedInitialJsBrotliBytes",
    "maxTotalBytes",
  ]) {
    if (typed[key] !== undefined) {
      validateNonNegativeInteger(typed[key], `${path}.${key}`);
    }
  }
  validateOptionalBoolean(typed.warnOnly, `${path}.warnOnly`);
}

function validateFrontendDeployUpload(value: unknown, path: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }
  const typed = value as Record<string, unknown>;
  validateOptionalBoolean(typed.enabled, `${path}.enabled`);
  if (
    typed.adapter !== undefined &&
    typeof typed.adapter !== "string" &&
    (typeof typed.adapter !== "object" || typed.adapter === null)
  ) {
    throw new Error(
      `[vextjs] ${path}.adapter must be a string or adapter object.`,
    );
  }
  validateOptionalString(typed.targetDir, `${path}.targetDir`);
  validateOptionalString(typed.publicBaseUrl, `${path}.publicBaseUrl`);
  if (
    typeof typed.publicBaseUrl === "string" &&
    !/^[a-z]+:\/\//i.test(typed.publicBaseUrl)
  ) {
    throw new Error(`[vextjs] ${path}.publicBaseUrl must be an absolute URL.`);
  }
  validateOptionalString(typed.prefix, `${path}.prefix`);
  validateOptionalString(typed.stateFile, `${path}.stateFile`);
  validateOptionalBoolean(typed.dryRun, `${path}.dryRun`);
  if (typed.concurrency !== undefined) {
    validatePositiveInteger(typed.concurrency, `${path}.concurrency`);
  }
  validateOptionalStringArray(typed.include, `${path}.include`);
  validateOptionalStringArray(typed.exclude, `${path}.exclude`);
}

function validateFrontendBooleanOrObject(
  value: unknown,
  path: string,
  booleanKeys: string[],
): void {
  if (value === undefined || typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of booleanKeys) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`[vextjs] ${path}.${key} must be a boolean.`);
    }
  }
}

function validateFetchConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const fetchConfig = value as Record<string, unknown>;
  if (fetchConfig.timeout !== undefined) {
    validatePositiveTimerNumber(fetchConfig.timeout, `${path}.timeout`);
  }
  if (fetchConfig.retry !== undefined) {
    validateNonNegativeInteger(fetchConfig.retry, `${path}.retry`);
  }
  validateRetryDelay(fetchConfig.retryDelay, `${path}.retryDelay`);
  validateOptionalStringArray(
    fetchConfig.propagateHeaders,
    `${path}.propagateHeaders`,
  );

  const proxy = fetchConfig.proxy;
  if (proxy === undefined) {
    return;
  }
  if (!Array.isArray(proxy)) {
    throw new Error(`[vextjs] ${path}.proxy must be an array.`);
  }

  const names = new Set<string>();
  proxy.forEach((item, index) => {
    const itemPath = `${path}.proxy[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`[vextjs] ${itemPath} must be an object.`);
    }

    const target = item as Record<string, unknown>;
    validateRequiredString(target.name, `${itemPath}.name`);
    const name = target.name as string;
    if (FETCH_PROXY_RESERVED_TARGET_NAMES.has(name)) {
      throw new Error(
        `[vextjs] ${itemPath}.name "${name}" is reserved and cannot be used.`,
      );
    }
    if (names.has(name)) {
      throw new Error(`[vextjs] ${itemPath}.name "${name}" is duplicated.`);
    }
    names.add(name);

    validateRequiredString(target.baseURL, `${itemPath}.baseURL`);
    try {
      new URL(target.baseURL as string);
    } catch {
      throw new Error(`[vextjs] ${itemPath}.baseURL must be a valid URL.`);
    }

    validateStringRecord(target.headers, `${itemPath}.headers`);
    validateOptionalStringArray(
      target.forwardHeaders,
      `${itemPath}.forwardHeaders`,
    );
    validateProxyHeaderSource(
      target.defaultInjectHeaders,
      `${itemPath}.defaultInjectHeaders`,
    );
    if (
      target.allowAuthorizationForward !== undefined &&
      typeof target.allowAuthorizationForward !== "boolean"
    ) {
      throw new Error(
        `[vextjs] ${itemPath}.allowAuthorizationForward must be a boolean.`,
      );
    }
    if (target.timeout !== undefined) {
      validatePositiveTimerNumber(target.timeout, `${itemPath}.timeout`);
    }
    if (target.retry !== undefined) {
      validateNonNegativeInteger(target.retry, `${itemPath}.retry`);
    }
    validateRetryDelay(target.retryDelay, `${itemPath}.retryDelay`);
  });
}

function validateSessionConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const session = value as Record<string, unknown>;
  validateOptionalBoolean(session.enabled, `${path}.enabled`);
  validateOptionalString(session.name, `${path}.name`);
  if (session.ttl !== undefined) {
    validatePositiveNumber(session.ttl, `${path}.ttl`);
  }
  validateOptionalBoolean(session.rolling, `${path}.rolling`);
  validateOptionalBoolean(session.autoCommit, `${path}.autoCommit`);
  if (session.idLength !== undefined) {
    validatePositiveInteger(session.idLength, `${path}.idLength`);
    const idLength = session.idLength as number;
    if (idLength < 16 || idLength > 128) {
      throw new Error(
        `[vextjs] ${path}.idLength must be an integer from 16 to 128.`,
      );
    }
  }

  validateSessionCookieConfig(session.cookie, `${path}.cookie`);
  validateSessionStoreConfig(session.store, `${path}.store`);
}

function validateSessionCookieConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const cookie = value as Record<string, unknown>;
  validateOptionalString(cookie.domain, `${path}.domain`);
  validateOptionalString(cookie.path, `${path}.path`);
  validateOptionalBoolean(cookie.httpOnly, `${path}.httpOnly`);
  if (
    cookie.secure !== undefined &&
    typeof cookie.secure !== "boolean" &&
    cookie.secure !== "auto"
  ) {
    throw new Error(`[vextjs] ${path}.secure must be a boolean or "auto".`);
  }
  if (
    cookie.sameSite !== undefined &&
    typeof cookie.sameSite !== "boolean" &&
    !["lax", "strict", "none"].includes(String(cookie.sameSite))
  ) {
    throw new Error(
      `[vextjs] ${path}.sameSite must be a boolean, "lax", "strict", or "none".`,
    );
  }
  if (
    cookie.priority !== undefined &&
    !["low", "medium", "high"].includes(String(cookie.priority))
  ) {
    throw new Error(
      `[vextjs] ${path}.priority must be "low", "medium", or "high".`,
    );
  }
  validateOptionalBoolean(cookie.partitioned, `${path}.partitioned`);
  if (cookie.maxAge !== undefined) {
    validatePositiveNumber(cookie.maxAge, `${path}.maxAge`);
  }
  if (
    cookie.expires !== undefined &&
    !(
      cookie.expires instanceof Date &&
      Number.isFinite(cookie.expires.valueOf())
    )
  ) {
    throw new Error(`[vextjs] ${path}.expires must be a valid Date.`);
  }
  if (cookie.encode !== undefined && typeof cookie.encode !== "function") {
    throw new Error(`[vextjs] ${path}.encode must be a function.`);
  }
}

function validateSessionStoreConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const store = value as Record<string, unknown>;
  for (const key of ["get", "set", "delete"]) {
    if (typeof store[key] !== "function") {
      throw new Error(`[vextjs] ${path}.${key} must be a function.`);
    }
  }
  for (const key of ["touch", "clearExpired", "close"]) {
    if (store[key] !== undefined && typeof store[key] !== "function") {
      throw new Error(`[vextjs] ${path}.${key} must be a function.`);
    }
  }
}

function validateCsrfConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const csrf = value as Record<string, unknown>;
  validateOptionalBoolean(csrf.enabled, `${path}.enabled`);
  if (
    csrf.mode !== undefined &&
    !["auto", "session", "signed-cookie"].includes(String(csrf.mode))
  ) {
    throw new Error(
      `[vextjs] ${path}.mode must be "auto", "session", or "signed-cookie".`,
    );
  }
  validateOptionalString(csrf.secret, `${path}.secret`);
  if (csrf.mode === "signed-cookie") {
    validateRequiredString(csrf.secret, `${path}.secret`);
  }
  validateOptionalStringArray(csrf.methods, `${path}.methods`);
  validateOptionalStringArray(csrf.headerNames, `${path}.headerNames`);
  if (
    csrf.bodyField !== undefined &&
    csrf.bodyField !== false &&
    typeof csrf.bodyField !== "string"
  ) {
    throw new Error(`[vextjs] ${path}.bodyField must be a string or false.`);
  }
  validateOptionalBoolean(csrf.fetchMetadata, `${path}.fetchMetadata`);
  validateCsrfCookieConfig(csrf.cookie, `${path}.cookie`);
  validateCsrfOriginConfig(csrf.origin, `${path}.origin`);
}

function validateCsrfCookieConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const cookie = value as Record<string, unknown>;
  validateOptionalString(cookie.name, `${path}.name`);
  validateSessionCookieConfig(value, path);
}

function validateCsrfOriginConfig(value: unknown, path: string): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be false or an object.`);
  }

  const origin = value as Record<string, unknown>;
  validateOptionalStringArray(origin.trustedOrigins, `${path}.trustedOrigins`);
}

function validateSecurityHeadersConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  validateOptionalBoolean(config.enabled, `${path}.enabled`);
  validateEnum(config.preset, `${path}.preset`, ["basic", "strict", "custom"]);
  validateEnumOrFalse(config.contentTypeOptions, `${path}.contentTypeOptions`, [
    "nosniff",
  ]);
  validateOptionalStringOrFalse(
    config.referrerPolicy,
    `${path}.referrerPolicy`,
  );
  validateEnumOrFalse(config.frameOptions, `${path}.frameOptions`, [
    "DENY",
    "SAMEORIGIN",
  ]);
  validateSecurityHeadersHsts(config.hsts, `${path}.hsts`);
  validateSecurityHeadersCsp(
    config.contentSecurityPolicy,
    `${path}.contentSecurityPolicy`,
  );
  validateSecurityHeadersPermissionsPolicy(
    config.permissionsPolicy,
    `${path}.permissionsPolicy`,
  );
  validateEnumOrFalse(
    config.crossOriginOpenerPolicy,
    `${path}.crossOriginOpenerPolicy`,
    ["same-origin", "same-origin-allow-popups", "unsafe-none"],
  );
  validateEnumOrFalse(
    config.crossOriginEmbedderPolicy,
    `${path}.crossOriginEmbedderPolicy`,
    ["require-corp", "credentialless", "unsafe-none"],
  );
  validateEnumOrFalse(
    config.crossOriginResourcePolicy,
    `${path}.crossOriginResourcePolicy`,
    ["same-origin", "same-site", "cross-origin"],
  );
  validateSecurityHeaderMap(config.headers, `${path}.headers`);
  validateSecurityHeadersSkipPaths(config.skipPaths, `${path}.skipPaths`);
}

function validateOptionalStringOrFalse(value: unknown, path: string): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value === "string") {
    validateNoHeaderControlChars(value, path);
    return;
  }
  throw new Error(`[vextjs] ${path} must be a string or false.`);
}

function validateEnumOrFalse(
  value: unknown,
  path: string,
  allowed: readonly string[],
): void {
  if (value === false) {
    return;
  }
  validateEnum(value, path, allowed);
}

function validateSecurityHeadersHsts(value: unknown, path: string): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be false or an object.`);
  }
  const hsts = value as Record<string, unknown>;
  validateOptionalBoolean(hsts.enabled, `${path}.enabled`);
  validateOptionalBoolean(hsts.includeSubDomains, `${path}.includeSubDomains`);
  validateOptionalBoolean(hsts.preload, `${path}.preload`);
  validateOptionalBoolean(hsts.force, `${path}.force`);
  if (hsts.maxAge !== undefined) {
    validateNonNegativeInteger(hsts.maxAge, `${path}.maxAge`);
  }
}

function validateSecurityHeadersCsp(value: unknown, path: string): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value === "string") {
    validateNoHeaderControlChars(value, path);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be false, a string, or an object.`);
  }
  const csp = value as Record<string, unknown>;
  validateOptionalBoolean(csp.reportOnly, `${path}.reportOnly`);
  if (csp.directives === undefined) {
    return;
  }
  if (
    typeof csp.directives !== "object" ||
    csp.directives === null ||
    Array.isArray(csp.directives)
  ) {
    throw new Error(`[vextjs] ${path}.directives must be an object.`);
  }
  for (const [name, directiveValue] of Object.entries(
    csp.directives as Record<string, unknown>,
  )) {
    validateSecurityHeaderToken(name, `${path}.directives.${name}`);
    if (
      directiveValue === true ||
      directiveValue === false ||
      typeof directiveValue === "string"
    ) {
      if (typeof directiveValue === "string") {
        validateNoHeaderControlChars(
          directiveValue,
          `${path}.directives.${name}`,
        );
      }
      continue;
    }
    if (
      Array.isArray(directiveValue) &&
      directiveValue.every((item) => typeof item === "string")
    ) {
      directiveValue.forEach((item, index) =>
        validateNoHeaderControlChars(
          item,
          `${path}.directives.${name}[${index}]`,
        ),
      );
      continue;
    }
    throw new Error(
      `[vextjs] ${path}.directives.${name} must be a string, string array, boolean true, or false.`,
    );
  }
}

function validateSecurityHeadersPermissionsPolicy(
  value: unknown,
  path: string,
): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value === "string") {
    validateNoHeaderControlChars(value, path);
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be false, a string, or an object.`);
  }
  for (const [feature, allowList] of Object.entries(
    value as Record<string, unknown>,
  )) {
    validateSecurityHeaderToken(feature, `${path}.${feature}`);
    if (typeof allowList === "boolean") {
      continue;
    }
    if (
      Array.isArray(allowList) &&
      allowList.every((item) => typeof item === "string")
    ) {
      allowList.forEach((item, index) =>
        validateNoHeaderControlChars(item, `${path}.${feature}[${index}]`),
      );
      continue;
    }
    throw new Error(
      `[vextjs] ${path}.${feature} must be a boolean or an array of strings.`,
    );
  }
}

function validateSecurityHeaderMap(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }
  for (const [name, headerValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    validateSecurityHeaderToken(name, `${path}.${name}`);
    if (typeof headerValue !== "string") {
      throw new Error(`[vextjs] ${path}.${name} must be a string.`);
    }
    validateNoHeaderControlChars(headerValue, `${path}.${name}`);
  }
}

function validateSecurityHeadersSkipPaths(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an array of strings.`);
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (
      typeof item !== "string" ||
      !item.startsWith("/") ||
      item.startsWith("//") ||
      item.length === 0
    ) {
      throw new Error(
        `[vextjs] ${itemPath} must be a URL path starting with "/".`,
      );
    }
    const firstStar = item.indexOf("*");
    if (firstStar !== -1 && firstStar !== item.length - 1) {
      throw new Error(
        `[vextjs] ${itemPath} may only use "*" as the final character.`,
      );
    }
  });
}

function validateSecurityHeaderToken(value: string, path: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
    throw new Error(`[vextjs] ${path} must be a non-empty HTTP header token.`);
  }
}

function validateNoHeaderControlChars(value: string, path: string): void {
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error(`[vextjs] ${path} must not contain control characters.`);
  }
}

function validateRetryDelay(value: unknown, path: string): void {
  if (value === undefined || typeof value === "function") {
    return;
  }
  validateNonNegativeTimerNumber(value, path);
}

function validateProxyHeaderSource(value: unknown, path: string): void {
  if (value === undefined || typeof value === "function") {
    return;
  }
  validateStringRecord(value, path);
}

function validateStringRecord(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new Error(`[vextjs] ${path}.${key} must be a string.`);
    }
  }
}

function validateRequiredString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[vextjs] ${path} must be a non-empty string.`);
  }
}

function validateOptionalStringArray(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an array of strings.`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`[vextjs] ${path}[] items must be strings.`);
    }
  }
}

function validateServerConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const server = value as Record<string, unknown>;
  for (const key of [
    "requestTimeout",
    "headersTimeout",
    "keepAliveTimeout",
    "socketTimeout",
  ]) {
    if (server[key] !== undefined) {
      validateNonNegativeFiniteNumber(server[key], `${path}.${key}`);
    }
  }

  if (server.maxHeaderSize !== undefined) {
    validatePositiveInteger(server.maxHeaderSize, `${path}.maxHeaderSize`);
  }
  if (server.maxRequestsPerSocket !== undefined) {
    validateNonNegativeInteger(
      server.maxRequestsPerSocket,
      `${path}.maxRequestsPerSocket`,
    );
  }
  if (server.connectionsCheckingInterval !== undefined) {
    validatePositiveInteger(
      server.connectionsCheckingInterval,
      `${path}.connectionsCheckingInterval`,
    );
  }
}

function validateCacheHubConfig(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`[vextjs] ${path} must be an object.`);
  }

  const cacheHub = value as Record<string, unknown>;
  const mode = cacheHub.mode ?? "memory";
  if (!["memory", "redis", "multi-level"].includes(mode as string)) {
    throw new Error(
      `[vextjs] ${path}.mode must be "memory", "redis", or "multi-level", got: ${String(mode)}`,
    );
  }

  if (mode === "memory") {
    validateMemoryCacheHubConfig(cacheHub, path);
    return;
  }

  if (mode === "redis") {
    validateRedisTargetConfig(cacheHub, path);
    validateLeaseConfig(cacheHub.lease, `${path}.lease`);
    validateDistributedConfig(cacheHub.distributed, `${path}.distributed`);
    return;
  }

  validateMultiLevelCacheHubConfig(cacheHub, path);
}

function validateMemoryCacheHubConfig(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.maxEntries !== undefined) {
    validatePositiveInteger(value.maxEntries, `${path}.maxEntries`);
  }
  if (value.maxMemory !== undefined) {
    validatePositiveNumber(value.maxMemory, `${path}.maxMemory`);
  }
  if (value.cleanupInterval !== undefined) {
    validateNonNegativeNumber(value.cleanupInterval, `${path}.cleanupInterval`);
  }
  if (
    value.enableStats !== undefined &&
    typeof value.enableStats !== "boolean"
  ) {
    throw new Error(`[vextjs] ${path}.enableStats must be a boolean.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`[vextjs] ${path}.enabled must be a boolean.`);
  }
}

function validateMultiLevelCacheHubConfig(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.memory !== undefined) {
    if (typeof value.memory !== "object" || value.memory === null) {
      throw new Error(`[vextjs] ${path}.memory must be an object.`);
    }
    validateMemoryCacheHubConfig(
      value.memory as Record<string, unknown>,
      `${path}.memory`,
    );
  }
  if (value.redis !== undefined) {
    if (typeof value.redis !== "object" || value.redis === null) {
      throw new Error(`[vextjs] ${path}.redis must be an object.`);
    }
    validateRedisTargetConfig(
      value.redis as Record<string, unknown>,
      `${path}.redis`,
    );
  }
  if (
    value.writePolicy !== undefined &&
    !["both", "local-first-async-remote"].includes(value.writePolicy as string)
  ) {
    throw new Error(
      `[vextjs] ${path}.writePolicy must be "both" or "local-first-async-remote".`,
    );
  }
  if (
    value.backfillOnRemoteHit !== undefined &&
    typeof value.backfillOnRemoteHit !== "boolean"
  ) {
    throw new Error(`[vextjs] ${path}.backfillOnRemoteHit must be a boolean.`);
  }
  if (value.remoteTimeout !== undefined) {
    validatePositiveNumber(value.remoteTimeout, `${path}.remoteTimeout`);
  }
  if (
    value.remoteInvalidationErrors !== undefined &&
    !["ignore", "throw"].includes(value.remoteInvalidationErrors as string)
  ) {
    throw new Error(
      `[vextjs] ${path}.remoteInvalidationErrors must be "ignore" or "throw".`,
    );
  }
  validateLeaseConfig(value.lease, `${path}.lease`);
  validateDistributedConfig(value.distributed, `${path}.distributed`);
}

function validateRedisTargetConfig(
  value: Record<string, unknown>,
  path: string,
): void {
  validateOptionalString(value.url, `${path}.url`);
  validateOptionalString(value.metaKeyPrefix, `${path}.metaKeyPrefix`);
  if (
    value.client !== undefined &&
    (typeof value.client !== "object" || value.client === null)
  ) {
    throw new Error(`[vextjs] ${path}.client must be an object.`);
  }
  if (value.scanCount !== undefined) {
    validatePositiveInteger(value.scanCount, `${path}.scanCount`);
  }
  if (
    value.deleteCommand !== undefined &&
    !["del", "unlink"].includes(value.deleteCommand as string)
  ) {
    throw new Error(
      `[vextjs] ${path}.deleteCommand must be "del" or "unlink".`,
    );
  }
}

function validateLeaseConfig(value: unknown, path: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }
  const lease = value as Record<string, unknown>;
  if (lease.enabled !== undefined && typeof lease.enabled !== "boolean") {
    throw new Error(`[vextjs] ${path}.enabled must be a boolean.`);
  }
  if (lease.ttl !== undefined) {
    validatePositiveNumber(lease.ttl, `${path}.ttl`);
  }
  if (lease.waitForOwner !== undefined) {
    validatePositiveNumber(lease.waitForOwner, `${path}.waitForOwner`);
  }
  if (lease.pollInterval !== undefined) {
    validatePositiveNumber(lease.pollInterval, `${path}.pollInterval`);
  }
  if (
    lease.onTimeout !== undefined &&
    !["fetch", "throw"].includes(lease.onTimeout as string)
  ) {
    throw new Error(`[vextjs] ${path}.onTimeout must be "fetch" or "throw".`);
  }
  validateOptionalString(lease.keyPrefix, `${path}.keyPrefix`);
  validateOptionalString(lease.ownerId, `${path}.ownerId`);
}

function validateDistributedConfig(value: unknown, path: string): void {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`[vextjs] ${path} must be a boolean or an object.`);
  }
  const distributed = value as Record<string, unknown>;
  if (
    distributed.enabled !== undefined &&
    typeof distributed.enabled !== "boolean"
  ) {
    throw new Error(`[vextjs] ${path}.enabled must be a boolean.`);
  }
  validateOptionalString(distributed.redisUrl, `${path}.redisUrl`);
  validateOptionalString(distributed.channel, `${path}.channel`);
  validateOptionalString(distributed.instanceId, `${path}.instanceId`);
  if (
    distributed.redis !== undefined &&
    (typeof distributed.redis !== "object" || distributed.redis === null)
  ) {
    throw new Error(`[vextjs] ${path}.redis must be an object.`);
  }
}

function validateOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`[vextjs] ${path} must be a string.`);
  }
}

function validatePositiveInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `[vextjs] ${path} must be a positive integer, got: ${value}`,
    );
  }
}

function validateNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `[vextjs] ${path} must be a non-negative integer, got: ${value}`,
    );
  }
}

function validatePositiveNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || value <= 0) {
    throw new Error(
      `[vextjs] ${path} must be a positive number, got: ${value}`,
    );
  }
}

function validateNonNegativeNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || value < 0) {
    throw new Error(
      `[vextjs] ${path} must be a non-negative number, got: ${value}`,
    );
  }
}

function validatePositiveTimerNumber(value: unknown, path: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `[vextjs] ${path} must be a finite positive number no greater than ${MAX_TIMER_DELAY_MS}, got: ${value}`,
    );
  }
}

function validateNonNegativeTimerNumber(value: unknown, path: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `[vextjs] ${path} must be a finite non-negative number no greater than ${MAX_TIMER_DELAY_MS}, got: ${value}`,
    );
  }
}

function validateNonNegativeFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `[vextjs] ${path} must be a non-negative finite number, got: ${value}`,
    );
  }
}

// ── 动态导入辅助 ────────────────────────────────────────────

/**
 * 动态导入配置文件并提取 default export
 *
 * 使用 file:// URL 确保 Windows 路径兼容性。
 * 配置文件必须使用 `export default { ... }` 导出。
 *
 * @param filePath 配置文件绝对路径
 * @returns 配置对象
 */
async function importConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  // 延迟导入 interop 工具（避免循环依赖风险）
  const { resolveModuleDefault } = await import("./interop.js");

  const mod = await importUserModule(filePath);

  const defaultExport = resolveModuleDefault<Record<string, unknown>>(mod);

  if (!defaultExport || typeof defaultExport !== "object") {
    throw new Error(
      `[vextjs] Config file "${filePath}" must use \`export default { ... }\`.\n` +
        `         Got: ${typeof defaultExport}`,
    );
  }

  return defaultExport;
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * 加载并合并配置文件
 *
 * 合并顺序：default → {configProfile} → local
 * 合并完成后执行 Fail Fast 校验，通过后 deepFreeze 返回只读对象。
 *
 * @param configDir 配置目录绝对路径（通常为 path.join(projectRoot, 'src/config')）
 * @returns 合并、校验、冻结后的 VextConfig
 * @throws Error 配置文件缺失或配置不合法时抛出
 *
 * @example
 * ```typescript
 * import { loadConfig } from './config-loader.js'
 * import path from 'node:path'
 *
 * const config = await loadConfig(path.join(process.cwd(), 'src/config'))
 * // config 已 deepFreeze，运行时不可修改
 * ```
 */
export async function loadRawConfig(
  configDir: string,
  options: LoadConfigOptions = {},
): Promise<Record<string, unknown>> {
  const processEnv = options.env ?? process.env;
  const configProfile =
    options.configProfile !== undefined
      ? validateConfigProfileName(options.configProfile, "configProfile")
      : resolveConfigProfile({
          env: processEnv,
          command: options.command,
        }).profile;
  const mode = options.mode ?? getDefaultRuntimeMode(options.command);

  // ── 1. 加载 default（必须存在）────────────────────────
  const defaultFile = resolveConfigFile(configDir, "default");
  if (!defaultFile) {
    throw new Error(
      `[vextjs] src/config/default.ts not found in "${configDir}".\n` +
        `         This file is required. It defines all configuration defaults.`,
    );
  }
  const userDefaultConfig = await importConfigFile(defaultFile);

  // ── 1b. 以 DEFAULT_CONFIG 为基底，深度合并用户 default ──
  //
  // 用户的 config/default.ts 可能只覆盖部分字段（如 port / logger.level），
  // 缺省字段从框架内置的 DEFAULT_CONFIG 补全。
  // 这确保 requestId / rateLimit / cors 等必要配置始终有值，
  // 即使用户未显式声明也不会导致 bootstrap 崩溃。
  //
  const defaultConfig = mergeIntoOwnedRecord(
    { ...getInternalDefaultConfig() },
    userDefaultConfig,
  );

  // ── 1c. 手动合并用户 default.ts 中的 middlewares ────────
  //
  // deepMerge 会跳过 middlewares 键（由 patchMiddlewares 专门处理 env/local 覆盖），
  // 但用户的 config/default.ts 中声明的 middlewares 是基础白名单，应直接替换
  // DEFAULT_CONFIG.middlewares（空数组）。否则用户声明的路由级中间件永远不会被加载。
  //
  // 🐛 修复：BUG-004 — middlewares 在 deepMerge(DEFAULT_CONFIG, userDefaultConfig) 中被跳过，
  //    导致 loadMiddlewares 收到空数组，路由引用中间件时报 "not registered"。
  //
  if (userDefaultConfig.middlewares !== undefined) {
    (defaultConfig as Record<string, unknown>).middlewares = Array.isArray(
      userDefaultConfig.middlewares,
    )
      ? patchMiddlewares([], userDefaultConfig.middlewares as MiddlewareDecl[])
      : userDefaultConfig.middlewares;
  }

  // ── 2. 加载 profile 文件（可选）──────────────────────────
  const profileFile = resolveConfigFile(configDir, configProfile);
  const profileConfig = profileFile ? await importConfigFile(profileFile) : {};

  // ── 3. 加载 local（可选，不存在则静默跳过）──────────────
  const localFile = resolveConfigFile(configDir, "local");
  const localConfig = localFile ? await importConfigFile(localFile) : {};

  // ── 4. 合并 ────────────────────────────────────────────
  let merged = applyConfigLayer(defaultConfig, profileConfig);
  merged = applyConfigLayer(merged, localConfig);

  const rootDir = options.rootDir ?? path.dirname(path.dirname(configDir));
  const providerPatch = await loadBootstrapConfigPatch({
    rootDir,
    configDir,
    mode,
    configProfile,
    command: options.command ?? "start",
    isBuilt: options.isBuilt ?? false,
    baseConfig: merged,
    processEnv,
  });
  if (options.meta) {
    options.meta.providerPatch = providerPatch;
  }
  merged = applyConfigLayer(merged, providerPatch);

  // ── 4c. CLI 环境变量覆盖（最高优先级）─────────────────
  //
  // vext start --port N / --host H 通过环境变量传递给 fork 子进程：
  //   VEXT_PORT → 覆盖 merged.port
  //   VEXT_HOST → 覆盖 merged.host
  //
  // 优先级链：DEFAULT_CONFIG < user default < env < local < CLI 环境变量
  //
  // 🐛 修复：BUG-013 — CLI --port/--host 参数设置了 VEXT_PORT/VEXT_HOST 环境变量，
  //    但 loadConfig 从未读取这些环境变量，导致端口覆盖静默失效。
  //
  return applyCliOverrides(merged, processEnv);
}

export function finalizeConfig(rawConfig: Record<string, unknown>): VextConfig {
  validateConfig(rawConfig);
  return deepFreeze(rawConfig) as VextConfig;
}

export async function loadConfig(
  configDir: string,
  options: LoadConfigOptions = {},
): Promise<VextConfig> {
  return finalizeConfig(await loadRawConfig(configDir, options));
}

// ── 导出辅助函数（供测试使用）───────────────────────────────

export {
  deepMerge as _deepMerge,
  deepFreeze as _deepFreeze,
  patchMiddlewares as _patchMiddlewares,
  applyCliOverrides as _applyCliOverrides,
  applyConfigLayer as _applyConfigLayer,
  validateConfig as _validateConfig,
  resolveConfigFile as _resolveConfigFile,
};
