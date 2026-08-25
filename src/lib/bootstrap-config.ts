import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeMode } from "./config-profile.js";
import { importUserModule } from "./user-module-loader.js";

const EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;
const resolvedBootstrapFiles = new Map<string, string | null>();
const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const CLUSTER_BOOTSTRAP_PATCH_ENV = "VEXT_CLUSTER_BOOTSTRAP_PATCH";

export type BootstrapCommand = "start" | "dev" | "test" | "build";

export interface BootstrapConfigContext {
  rootDir: string;
  configDir: string;
  mode: RuntimeMode;
  configProfile: string;
  /** @deprecated Use ctx.mode for runtime mode or ctx.configProfile for profile names. */
  env: string;
  command: BootstrapCommand;
  isBuilt: boolean;
  baseConfig: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface BootstrapConfigProvider {
  name: string;
  timeoutMs?: number;
  required?: boolean;
  load(
    ctx: BootstrapConfigContext,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}

export interface BootstrapConfigDefinition {
  providers: BootstrapConfigProvider[];
}

export interface LoadBootstrapConfigOptions {
  rootDir: string;
  configDir: string;
  mode: RuntimeMode;
  configProfile: string;
  env?: string;
  command: BootstrapCommand;
  isBuilt: boolean;
  baseConfig: Readonly<Record<string, unknown>>;
  processEnv?: NodeJS.ProcessEnv;
}

export function defineBootstrapConfig(
  definition: BootstrapConfigDefinition,
): BootstrapConfigDefinition {
  return definition;
}

function resolveBootstrapConfigFile(configDir: string): string | null {
  if (resolvedBootstrapFiles.has(configDir)) {
    return resolvedBootstrapFiles.get(configDir) ?? null;
  }
  for (const ext of EXTENSIONS) {
    const filePath = path.join(configDir, `bootstrap${ext}`);
    if (existsSync(filePath)) {
      resolvedBootstrapFiles.set(configDir, filePath);
      return filePath;
    }
  }
  resolvedBootstrapFiles.set(configDir, null);
  return null;
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

function isJsonLike(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonLike(item));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((item) => isJsonLike(item));
}

function normalizeDefinition(
  rawExport: unknown,
  filePath: string,
): BootstrapConfigDefinition {
  const definition = Array.isArray(rawExport)
    ? { providers: rawExport as BootstrapConfigProvider[] }
    : rawExport;

  if (
    !definition ||
    typeof definition !== "object" ||
    !Array.isArray((definition as { providers?: unknown[] }).providers)
  ) {
    throw new Error(
      `[vextjs] Bootstrap config file "${filePath}" must export defineBootstrapConfig({ providers: [...] }).`,
    );
  }

  const providers = (definition as { providers: unknown[] }).providers;
  providers.forEach((provider, index) =>
    validateProviderDefinition(provider, index),
  );
  return definition as BootstrapConfigDefinition;
}

function validateProviderDefinition(
  provider: unknown,
  index: number,
): asserts provider is BootstrapConfigProvider {
  const pathName = `providers[${index}]`;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`[vextjs] Bootstrap config ${pathName} must be an object.`);
  }

  const value = provider as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error(
      `[vextjs] Bootstrap config ${pathName}.name must be a non-empty string.`,
    );
  }
  if (typeof value.load !== "function") {
    throw new Error(
      `[vextjs] Bootstrap config provider "${value.name}" must implement load(ctx).`,
    );
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error(
      `[vextjs] Bootstrap config provider "${value.name}" required must be a boolean.`,
    );
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isFinite(value.timeoutMs) ||
      value.timeoutMs < 0)
  ) {
    throw new Error(
      `[vextjs] Bootstrap config provider "${value.name}" timeoutMs must be a finite non-negative number.`,
    );
  }
}

async function importBootstrapDefinition(
  filePath: string,
): Promise<BootstrapConfigDefinition> {
  const { resolveModuleDefault } = await import("./interop.js");
  const mod = await importUserModule(filePath);
  const rawExport = resolveModuleDefault<unknown>(mod);
  return normalizeDefinition(rawExport, filePath);
}

async function executeProvider(
  provider: BootstrapConfigProvider,
  ctx: Omit<BootstrapConfigContext, "signal">,
): Promise<Record<string, unknown> | null> {
  const timeoutMs = provider.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeoutError = new Error(`Provider timeout after ${timeoutMs}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const providerResult = Promise.resolve().then(() =>
    provider.load({
      ...ctx,
      signal: controller.signal,
    }),
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const patch = await Promise.race([providerResult, deadline]);

    if (patch === null || patch === undefined) {
      return null;
    }

    if (!isPlainObject(patch)) {
      throw new Error(
        `[vextjs] Bootstrap config provider "${provider.name}" must return a plain object patch or null.`,
      );
    }

    if (!isJsonLike(patch)) {
      throw new Error(
        `[vextjs] Bootstrap config provider "${provider.name}" returned a non JSON-like patch. Functions, class instances, and symbols are not supported.`,
      );
    }

    return patch;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function readInjectedBootstrapConfigPatch(
  processEnv: NodeJS.ProcessEnv | undefined,
): Record<string, unknown> | null {
  const raw = processEnv?.[CLUSTER_BOOTSTRAP_PATCH_ENV];
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vextjs] Failed to parse ${CLUSTER_BOOTSTRAP_PATCH_ENV}: ${reason}`,
    );
  }

  if (!isPlainObject(parsed) || !isJsonLike(parsed)) {
    throw new Error(
      `[vextjs] ${CLUSTER_BOOTSTRAP_PATCH_ENV} must contain a JSON object patch.`,
    );
  }

  return parsed;
}

export async function loadBootstrapConfigPatch(
  options: LoadBootstrapConfigOptions,
): Promise<Record<string, unknown>> {
  const injectedPatch = readInjectedBootstrapConfigPatch(options.processEnv);
  if (injectedPatch) {
    return injectedPatch;
  }

  const bootstrapFile = resolveBootstrapConfigFile(options.configDir);
  if (!bootstrapFile) {
    return {};
  }

  const definition = await importBootstrapDefinition(bootstrapFile);
  let mergedPatch: Record<string, unknown> = {};

  for (const provider of definition.providers) {
    const required =
      provider.required ?? (options.mode === "production" ? true : false);

    try {
      const patch = await executeProvider(provider, {
        rootDir: options.rootDir,
        configDir: options.configDir,
        mode: options.mode,
        configProfile: options.configProfile,
        env: options.env ?? options.mode,
        command: options.command,
        isBuilt: options.isBuilt,
        baseConfig: options.baseConfig,
      });

      if (patch) {
        mergedPatch = mergeProviderPatches(mergedPatch, patch);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `[vextjs] Bootstrap config provider "${provider.name}" failed: ${reason}`;

      if (required) {
        throw new Error(message);
      }

      console.warn(`${message} (optional provider, fallback continues)`);
    }
  }

  return mergedPatch;
}

function mergeProviderPatches(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPrototypePollutionKey(key)) continue;
    const previous = base[key];
    result[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeProviderPatches(previous, value)
        : Array.isArray(value)
          ? value.map((item) => cloneJsonValue(item))
          : isPlainObject(value)
            ? mergeProviderPatches({}, value)
            : value;
  }
  return result;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (isPlainObject(value)) return mergeProviderPatches({}, value);
  return value;
}
