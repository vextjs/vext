import { createLoggerCore } from "./logger/core.js";
import { createStdoutSink } from "./logger/sinks/stdout.js";
import type { LoggerCore, LoggerLifecycle, LogSink } from "./logger/types.js";
import { requestContext } from "./request-context.js";
import type {
  VextLogger,
  VextLoggerConfig,
  VextLoggerLike,
  VextRuntimeLogger,
} from "../types/app.js";

// Symbol.for keeps logger lifecycle metadata visible when CommonJS consumers
// mix independently bundled public entrypoints such as vextjs and
// vextjs/testing in the same process.
const LOGGER_LIFECYCLE = Symbol.for("vext.logger.lifecycle");

export interface CreateLoggerOptions {
  requestContextEnabled?: boolean;
  sink?: LogSink;
}

type VextLoggerWithLifecycle = VextLogger & {
  [LOGGER_LIFECYCLE]?: LoggerLifecycle;
};

type PrettyColorMode = NonNullable<VextLoggerConfig["prettyColor"]>;
type LoggerMethodName = "trace" | "info" | "warn" | "error" | "debug" | "fatal";
type LoggerMethod = (...args: unknown[]) => void;

function wrapCoreAsVextLogger(core: LoggerCore): VextRuntimeLogger {
  const logger: VextRuntimeLogger = {
    trace(...args: unknown[]) {
      core.trace(...args);
    },

    info(...args: unknown[]) {
      core.info(...args);
    },

    warn(...args: unknown[]) {
      core.warn(...args);
    },

    error(...args: unknown[]) {
      core.error(...args);
    },

    debug(...args: unknown[]) {
      core.debug(...args);
    },

    fatal(...args: unknown[]) {
      core.fatal(...args);
    },

    getLevel() {
      return core.getLevel();
    },

    setLevel(level) {
      core.setLevel(level);
    },

    child(bindings: Record<string, unknown>): VextRuntimeLogger {
      return wrapCoreAsVextLogger(core.child(bindings));
    },
  };

  Object.defineProperty(logger, LOGGER_LIFECYCLE, {
    value: core,
    enumerable: false,
  });

  return logger;
}

export function getLoggerLifecycle(
  logger: VextLogger,
): LoggerLifecycle | undefined {
  return (logger as VextLoggerWithLifecycle)[LOGGER_LIFECYCLE];
}

export function normalizeVextLogger(
  original: VextRuntimeLogger,
  candidate: VextLoggerLike | null | undefined,
  /**
   * Optional factory that produced `candidate` from `original`.
   * When present, child loggers re-invoke the factory against the child core
   * so wrapper methods close over the child (preserving bindings) instead of
   * the parent logger. Without this, partial wrappers that capture `original`
   * in setLogger() would drop child bindings on every child.info() call.
   */
  wrapperFactory?: (original: VextRuntimeLogger) => VextLoggerLike,
): VextRuntimeLogger {
  const wrapped = candidate ?? {};
  const logger: VextRuntimeLogger = {
    trace: bindLoggerMethod(
      wrapped,
      original,
      "trace",
    ) as VextRuntimeLogger["trace"],
    info: bindLoggerMethod(wrapped, original, "info") as VextLogger["info"],
    warn: bindLoggerMethod(wrapped, original, "warn") as VextLogger["warn"],
    error: bindLoggerMethod(wrapped, original, "error") as VextLogger["error"],
    debug: bindLoggerMethod(wrapped, original, "debug") as VextLogger["debug"],
    fatal: bindLoggerMethod(wrapped, original, "fatal") as VextLogger["fatal"],

    getLevel() {
      const getLevel = wrapped.getLevel;
      if (typeof getLevel === "function") {
        return getLevel.call(wrapped);
      }
      return original.getLevel();
    },

    setLevel(level) {
      const setLevel = wrapped.setLevel;
      if (typeof setLevel === "function") {
        setLevel.call(wrapped, level);
        return;
      }
      original.setLevel(level);
    },

    child(bindings: Record<string, unknown>): VextRuntimeLogger {
      const originalChild = original.child(bindings);
      const createChild = wrapped.child;
      if (typeof createChild === "function") {
        try {
          const childCandidate = createChild.call(wrapped, bindings);
          return normalizeVextLogger(
            originalChild,
            childCandidate,
            wrapperFactory,
          );
        } catch {
          // Fall through to factory re-bind / original child.
        }
      }

      // Re-apply the setLogger factory against the child so closed-over
      // `original` references the child core (bindings, level share, sink).
      if (wrapperFactory) {
        try {
          const childCandidate = wrapperFactory(originalChild);
          return normalizeVextLogger(
            originalChild,
            childCandidate,
            wrapperFactory,
          );
        } catch {
          return originalChild;
        }
      }

      // No factory available: reusing parent wrapper methods would call the
      // parent core and drop child bindings. Prefer the unbound child.
      return originalChild;
    },
  };

  const lifecycle = getLoggerLifecycle(original);
  if (lifecycle) {
    Object.defineProperty(logger, LOGGER_LIFECYCLE, {
      value: lifecycle,
      enumerable: false,
    });
  }

  return logger;
}

export function createLogger(
  config: VextLoggerConfig = {},
  options?: CreateLoggerOptions,
): VextRuntimeLogger {
  validateLoggerConfig(config);
  const level = config.level ?? "info";
  const pretty = config.pretty ?? process.env.NODE_ENV !== "production";
  const alsEnabled = options?.requestContextEnabled !== false;
  const prettyIgnoreFields = config.prettyIgnore ?? "pid,hostname,requestId";
  const prettySingleLine = config.prettySingleLine !== false;
  const sink = options?.sink ?? createStdoutSink();
  const prettyColor = resolvePrettyColor({
    pretty,
    mode: config.prettyColor ?? "auto",
    sink,
    env: process.env,
  });
  let mixinWarnEmitted = false;
  let core: LoggerCore;

  const emitMixinWarning = (
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    if (mixinWarnEmitted) {
      return;
    }
    mixinWarnEmitted = true;
    if (meta) {
      core.warn(meta, message);
    } else {
      core.warn(message);
    }
  };

  const userMixin = config.mixin
    ? () => {
        try {
          const mixinResult = config.mixin?.();
          if (isPromiseLike(mixinResult)) {
            emitMixinWarning(
              "[vextjs] config.logger.mixin 返回了 Promise，mixin 必须是同步函数，已降级为 {}",
            );
            return undefined;
          }
          return mixinResult ?? undefined;
        } catch (err) {
          emitMixinWarning(
            "[vextjs] config.logger.mixin 抛出异常，已降级为 {}",
            { err },
          );
          return undefined;
        }
      }
    : undefined;

  const createdCore = createLoggerCore({
    level,
    sink,
    timestamp: "iso",
    format: pretty ? "pretty" : "json",
    pretty: {
      ignore: prettyIgnoreFields,
      singleLine: prettySingleLine,
      color: prettyColor,
    },
    contextProvider: alsEnabled
      ? () => {
          // requestId 是框架追踪字段，后续合并时会保护，避免用户 mixin 伪造。
          const store = requestContext.getStore();
          if (!store) {
            return undefined;
          }
          const builtIn: Record<string, unknown> = {};
          if (store.requestId) builtIn.requestId = store.requestId;
          if (store.traceId) builtIn.trace_id = store.traceId;
          if (store.spanId) builtIn.span_id = store.spanId;
          return builtIn;
        }
      : undefined,
    mixin: userMixin,
    redaction: {
      keys: config.redactKeys,
      paths: config.redactPaths,
      value: config.redactValue,
    },
  });

  core = createdCore;
  return wrapCoreAsVextLogger(createdCore);
}

function validateLoggerConfig(config: VextLoggerConfig): void {
  if (!isRecord(config) || Array.isArray(config)) {
    throw new Error("[vextjs] logger config must be an object.");
  }
  if (config.pretty !== undefined && typeof config.pretty !== "boolean") {
    throw new Error("[vextjs] logger.pretty must be a boolean.");
  }
  if (
    config.prettyColor !== undefined &&
    (typeof config.prettyColor !== "string" ||
      !["auto", "always", "never"].includes(config.prettyColor))
  ) {
    throw new Error(
      '[vextjs] logger.prettyColor must be one of: "auto", "always", "never".',
    );
  }
  if (
    config.prettyIgnore !== undefined &&
    typeof config.prettyIgnore !== "string"
  ) {
    throw new Error("[vextjs] logger.prettyIgnore must be a string.");
  }
  if (
    config.prettySingleLine !== undefined &&
    typeof config.prettySingleLine !== "boolean"
  ) {
    throw new Error("[vextjs] logger.prettySingleLine must be a boolean.");
  }
  assertStringArray(config.redactKeys, "logger.redactKeys");
  assertStringArray(config.redactPaths, "logger.redactPaths");
  if (
    config.redactValue !== undefined &&
    typeof config.redactValue !== "string"
  ) {
    throw new Error("[vextjs] logger.redactValue must be a string.");
  }
  if (config.mixin !== undefined && typeof config.mixin !== "function") {
    throw new Error("[vextjs] logger.mixin must be a synchronous function.");
  }
}

function assertStringArray(value: unknown, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`[vextjs] ${name} must be an array of strings.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolvePrettyColor({
  pretty,
  mode,
  sink,
  env,
}: {
  pretty: boolean;
  mode: PrettyColorMode;
  sink: LogSink;
  env: NodeJS.ProcessEnv;
}): boolean {
  // Priority: format guard, explicit config, env overrides, then sink TTY.
  if (!pretty) {
    return false;
  }
  if (mode === "never") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== "0";
  }
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return sink.isTTY === true;
}

function isPromiseLike(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

function bindLoggerMethod(
  candidate: VextLoggerLike,
  original: VextRuntimeLogger,
  name: LoggerMethodName,
): LoggerMethod {
  const method = candidate[name];
  if (typeof method === "function") {
    return (...args: unknown[]) => {
      (method as LoggerMethod).apply(candidate, args);
    };
  }

  const fallback = original[name] as LoggerMethod;
  return (...args: unknown[]) => {
    fallback.apply(original, args);
  };
}
