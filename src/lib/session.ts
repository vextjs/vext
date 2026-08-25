import { randomBytes } from "node:crypto";
import type { VextMiddleware } from "../types/middleware.js";
import type { VextRequest } from "../types/request.js";
import type { VextResponse } from "../types/response.js";
import type { CookieSerializeOptions } from "../types/cookies.js";
import type { VextHeaders } from "../types/headers.js";
import type {
  VextSession,
  VextSessionConfig,
  VextSessionCookieOptions,
  VextSessionData,
  VextRouteSessionOptions,
  VextSessionStore,
} from "../types/session.js";
import type { RouteOptions } from "../types/app.js";
import {
  appendSetCookie,
  serializeClearCookie,
  serializeCookie,
} from "./cookies.js";

export type {
  VextSession,
  VextSessionConfig,
  VextSessionCookieOptions,
  VextSessionData,
  VextRouteSessionOptions,
  VextSessionStore,
} from "../types/session.js";

const DEFAULT_SESSION_CONFIG: Required<
  Pick<
    VextSessionConfig,
    "enabled" | "name" | "ttl" | "rolling" | "autoCommit" | "idLength"
  >
> & { cookie: VextSessionCookieOptions } = {
  enabled: true,
  name: "vext.sid",
  ttl: 86400,
  rolling: false,
  autoCommit: true,
  idLength: 32,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: "auto",
  },
};

interface MemorySessionEntry {
  data: VextSessionData;
  expiresAt: number;
}

export interface VextMemorySessionStore extends VextSessionStore {
  clearExpired(maxEntries?: number): void;
  size(): number;
}

export function createMemorySessionStore(): VextMemorySessionStore {
  const entries = new Map<string, MemorySessionEntry>();
  const opportunisticSweepInterval = 64;
  const opportunisticSweepBatchSize = 32;
  let operationsUntilSweep = opportunisticSweepInterval;
  let sweepIterator: MapIterator<[string, MemorySessionEntry]> | undefined;

  function now(): number {
    return Date.now();
  }

  function expiresIn(ttlSeconds: number): number {
    // Match createCacheSessionStore: reject non-positive / non-finite TTL so
    // NaN never freezes an entry as non-expiring and 0/-1 are fail-fast.
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(
        "[vextjs] session memory store ttlSeconds must be a positive finite number.",
      );
    }
    return now() + ttlSeconds * 1000;
  }

  function isExpired(entry: MemorySessionEntry): boolean {
    return entry.expiresAt <= now();
  }

  function maybeSweepExpired(): void {
    operationsUntilSweep -= 1;
    if (operationsUntilSweep > 0) return;
    operationsUntilSweep = opportunisticSweepInterval;
    store.clearExpired(opportunisticSweepBatchSize);
  }

  const store: VextMemorySessionStore = {
    get(id) {
      maybeSweepExpired();
      const entry = entries.get(id);
      if (!entry) return null;
      if (isExpired(entry)) {
        entries.delete(id);
        return null;
      }
      // Deep snapshot: nested object/array mutations must not alias the store.
      return cloneSessionData(entry.data);
    },

    set(id, data, ttlSeconds) {
      maybeSweepExpired();
      entries.set(id, {
        data: cloneSessionData(data),
        expiresAt: expiresIn(ttlSeconds),
      });
    },

    delete(id) {
      maybeSweepExpired();
      entries.delete(id);
    },

    touch(id, ttlSeconds) {
      maybeSweepExpired();
      const entry = entries.get(id);
      if (!entry) return;
      if (isExpired(entry)) {
        entries.delete(id);
        return;
      }
      entry.expiresAt = expiresIn(ttlSeconds);
    },

    clearExpired(maxEntries = Number.POSITIVE_INFINITY) {
      if (entries.size === 0) {
        sweepIterator = undefined;
        return;
      }
      sweepIterator ??= entries.entries();
      let inspected = 0;
      while (inspected < maxEntries) {
        const item = sweepIterator.next();
        if (item.done) {
          sweepIterator = undefined;
          break;
        }
        inspected += 1;
        const [id, entry] = item.value;
        if (isExpired(entry)) entries.delete(id);
      }
    },

    size() {
      store.clearExpired?.();
      return entries.size;
    },
  };

  return store;
}

/**
 * Snapshot session data so callers cannot mutate the store through nested refs.
 * Prefer structuredClone; fall back to JSON for exotic values that clone rejects.
 */
function cloneSessionData(data: VextSessionData): VextSessionData {
  try {
    return structuredClone(data);
  } catch {
    return JSON.parse(JSON.stringify(data)) as VextSessionData;
  }
}

interface ResolvedSessionConfig {
  enabled: boolean;
  name: string;
  ttl: number;
  rolling: boolean;
  autoCommit: boolean;
  idLength: number;
  cookie: VextSessionCookieOptions;
  store: VextSessionStore;
}

interface SessionState {
  id: string;
  isNew: boolean;
  destroyed: boolean;
  dirty: boolean;
  saved: boolean;
  clearWritten: boolean;
  target: Record<string, unknown>;
  pendingCommit?: Promise<void>;
  proxy?: VextSession;
}

const RESERVED_SESSION_KEYS = new Set([
  "id",
  "isNew",
  "isDestroyed",
  "save",
  "regenerate",
  "destroy",
]);

const SESSION_ATTACHED_SYMBOL = Symbol("vext.session.attached");
const SESSION_MIDDLEWARE_SYMBOL = Symbol.for("vext.session.middleware");

export interface VextSessionRuntime {
  middleware: VextMiddleware;
  close(): Promise<void>;
}

type SessionRuntimeMode = "configured" | "manual";

export function createConfiguredSessionRuntime(
  options: VextSessionConfig = {},
): VextSessionRuntime {
  return createSessionRuntime(options, "configured");
}

export function createSessionMiddleware(
  options: VextSessionConfig = {},
): VextMiddleware {
  return createSessionRuntime(options, "manual").middleware;
}

export function isSessionMiddleware(value: unknown): value is VextMiddleware {
  return Boolean(
    typeof value === "function" &&
    (value as unknown as Record<PropertyKey, unknown>)[
      SESSION_MIDDLEWARE_SYMBOL
    ] === true,
  );
}

function createSessionRuntime(
  options: VextSessionConfig,
  mode: SessionRuntimeMode,
): VextSessionRuntime {
  let runtimeStore = options.store;
  let closeRegistered = false;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runtimeStore?.close?.();
  };

  const middleware: VextMiddleware = async (req, res, next) => {
    const routeOptions = getRouteSessionOptions(req);
    if (
      !isSessionEnabled(req.app.config.session, options, routeOptions, mode)
    ) {
      await next();
      return;
    }

    const requestState = req as unknown as Record<PropertyKey, unknown>;
    if (requestState[SESSION_ATTACHED_SYMBOL] === true) {
      await next();
      return;
    }

    runtimeStore ??=
      options.store ??
      req.app.config.session?.store ??
      createMemorySessionStore();

    if (mode === "manual" && !closeRegistered && runtimeStore.close) {
      closeRegistered = true;
      req.app.onClose(close);
    }

    const config = resolveSessionConfig(
      req.app.config.session,
      mergeRouteSessionOptions(options, routeOptions),
      runtimeStore,
    );
    assertSessionConfig(config);

    const state = await createSessionState(req, config);
    requestState[SESSION_ATTACHED_SYMBOL] = true;
    req.session = createSessionProxy(req, res, config, state);
    let committedOnSend = false;
    let unsafeTerminalSend = false;
    const previousOnBeforeSend = res._onBeforeSend;

    res._onBeforeSend = (kind, data, statusCode, headers) => {
      if (config.autoCommit) {
        if (
          (kind === "stream" || kind === "download") &&
          shouldCommitSession(state, config.rolling)
        ) {
          unsafeTerminalSend = true;
          throw new Error(
            "[vextjs] Dirty sessions must await req.session.save() before stream() or download().",
          );
        }
        commitSessionForSend(req, res, config, state, {
          force: config.rolling,
          headers,
        });
        committedOnSend = true;
      }
      previousOnBeforeSend?.(kind, data, statusCode, headers);
    };

    let downstreamError: unknown;
    try {
      await next();
    } catch (error) {
      downstreamError = error;
    }

    let commitError: unknown;
    if (config.autoCommit && !unsafeTerminalSend) {
      try {
        if (committedOnSend) {
          await state.pendingCommit;
        } else {
          await commitSession(req, res, config, state, {
            force: config.rolling,
          });
        }
      } catch (error) {
        commitError = error;
      }
    }

    if (
      (downstreamError || commitError) &&
      (committedOnSend || unsafeTerminalSend)
    ) {
      const discarded = res._discardPendingSend?.();
      if (discarded === false && res._isSent()) {
        req.app.logger.error(
          {
            error: toErrorMessage(commitError ?? downstreamError),
          },
          "[vextjs] session failure occurred after the response was already flushed",
        );
      }
    }
    if (downstreamError) throw downstreamError;
    if (commitError) throw commitError;
  };

  Object.defineProperty(middleware, SESSION_MIDDLEWARE_SYMBOL, {
    value: true,
  });

  return { middleware, close };
}

export const session = createSessionMiddleware;

function getRouteSessionOptions(
  req: VextRequest,
): boolean | VextRouteSessionOptions | undefined {
  const routeOptions = (req as { _routeOptions?: RouteOptions })._routeOptions;
  return routeOptions?.session;
}

function isSessionEnabled(
  appConfig: VextSessionConfig | undefined,
  options: VextSessionConfig,
  routeOptions: boolean | VextRouteSessionOptions | undefined,
  mode: SessionRuntimeMode,
): boolean {
  if (routeOptions === false) return false;
  if (routeOptions === true) return true;
  if (routeOptions && typeof routeOptions === "object") {
    return routeOptions.enabled ?? true;
  }
  return mode === "manual"
    ? (options.enabled ?? true)
    : (options.enabled ?? appConfig?.enabled ?? false);
}

function mergeRouteSessionOptions(
  options: VextSessionConfig,
  routeOptions: boolean | VextRouteSessionOptions | undefined,
): VextSessionConfig {
  const routeConfig =
    routeOptions && typeof routeOptions === "object" ? routeOptions : {};
  return {
    ...options,
    ...routeConfig,
    enabled: true,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createSessionState(
  req: VextRequest,
  config: ResolvedSessionConfig,
): Promise<SessionState> {
  const incomingId = req.cookie(config.name);
  if (incomingId) {
    const stored = await config.store.get(incomingId);
    if (stored) {
      return {
        id: incomingId,
        isNew: false,
        destroyed: false,
        dirty: false,
        saved: false,
        clearWritten: false,
        target: { ...stored },
      };
    }
  }

  return {
    id: generateSessionId(config.idLength),
    isNew: true,
    destroyed: false,
    dirty: false,
    saved: false,
    clearWritten: false,
    target: {},
  };
}

function createSessionProxy(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedSessionConfig,
  state: SessionState,
): VextSession {
  const methods = {
    save: async () => {
      await commitSession(req, res, config, state, { force: true });
    },
    regenerate: async () => {
      if (!state.destroyed) {
        await config.store.delete(state.id);
      }
      state.id = generateSessionId(config.idLength);
      state.isNew = true;
      state.destroyed = false;
      state.dirty = true;
      state.saved = false;
      state.clearWritten = false;
    },
    destroy: async () => {
      if (!state.destroyed) {
        await config.store.delete(state.id);
      }
      state.destroyed = true;
      state.dirty = false;
      state.saved = false;
      writeClearCookie(req, res, config, state);
    },
  };

  Object.defineProperties(state.target, {
    id: {
      enumerable: false,
      get: () => state.id,
    },
    isNew: {
      enumerable: false,
      get: () => state.isNew,
    },
    isDestroyed: {
      enumerable: false,
      get: () => state.destroyed,
    },
    save: {
      enumerable: false,
      value: methods.save,
    },
    regenerate: {
      enumerable: false,
      value: methods.regenerate,
    },
    destroy: {
      enumerable: false,
      value: methods.destroy,
    },
  });

  state.proxy = new Proxy(state.target, {
    set(target, property, value) {
      if (typeof property === "string" && RESERVED_SESSION_KEYS.has(property)) {
        return false;
      }
      state.dirty = true;
      state.saved = false;
      return Reflect.set(target, property, value);
    },

    deleteProperty(target, property) {
      if (typeof property === "string" && RESERVED_SESSION_KEYS.has(property)) {
        return false;
      }
      state.dirty = true;
      state.saved = false;
      return Reflect.deleteProperty(target, property);
    },
  }) as VextSession;

  return state.proxy;
}

async function commitSession(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedSessionConfig,
  state: SessionState,
  options: { force: boolean },
): Promise<void> {
  if (state.destroyed) {
    writeClearCookie(req, res, config, state);
    return;
  }

  if (state.saved && !state.dirty) {
    return;
  }

  if (!state.dirty && !options.force) {
    return;
  }

  const data = extractSessionData(state.target);
  if (!state.dirty && options.force && !state.isNew && config.store.touch) {
    await config.store.touch(state.id, config.ttl);
  } else {
    await config.store.set(state.id, data, config.ttl);
  }

  writeSessionCookie(req, res, config, state);
  state.isNew = false;
  state.dirty = false;
  state.saved = true;
}

function commitSessionForSend(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedSessionConfig,
  state: SessionState,
  options: { force: boolean; headers: VextHeaders },
): void {
  if (state.destroyed) {
    writeClearCookie(req, res, config, state, options.headers);
    return;
  }

  if (state.saved && !state.dirty) {
    return;
  }

  if (!state.dirty && !options.force) {
    return;
  }

  const data = extractSessionData(state.target);
  res._sessionCommitPending = true;
  state.pendingCommit = Promise.resolve()
    .then(() =>
      !state.dirty && options.force && !state.isNew && config.store.touch
        ? config.store.touch(state.id, config.ttl)
        : config.store.set(state.id, data, config.ttl),
    )
    .then(() => {
      writeSessionCookie(req, res, config, state, options.headers);
      state.isNew = false;
      state.dirty = false;
      state.saved = true;
    })
    .finally(() => {
      res._sessionCommitPending = false;
    });
  // Attach an observer immediately: an already-rejected store promise can
  // otherwise be reported as unhandled before onion unwinding reaches the
  // barrier await below. The original promise remains rejected and is still
  // propagated to the adapter error path.
  void state.pendingCommit.catch(() => {});
}

function shouldCommitSession(state: SessionState, force: boolean): boolean {
  if (state.destroyed) return false;
  if (state.saved && !state.dirty) return false;
  return state.dirty || force;
}

function extractSessionData(target: Record<string, unknown>): VextSessionData {
  const data: VextSessionData = {};
  for (const [key, value] of Object.entries(target)) {
    if (!RESERVED_SESSION_KEYS.has(key)) data[key] = value;
  }
  return data;
}

function writeClearCookie(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedSessionConfig,
  state: SessionState,
  headers?: VextHeaders,
): void {
  if (state.clearWritten) return;
  const options = resolveCookieOptions(req, config);
  res.clearCookie(config.name, options);
  if (headers) {
    appendSetCookie(headers, serializeClearCookie(config.name, options));
  }
  state.clearWritten = true;
}

function writeSessionCookie(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedSessionConfig,
  state: SessionState,
  headers?: VextHeaders,
): void {
  const options = resolveCookieOptions(req, config);
  res.cookie(config.name, state.id, options);
  if (headers) {
    appendSetCookie(headers, serializeCookie(config.name, state.id, options));
  }
}

function resolveSessionConfig(
  appConfig: VextSessionConfig | undefined,
  options: VextSessionConfig,
  fallbackStore: VextSessionStore,
): ResolvedSessionConfig {
  const merged: VextSessionConfig = {
    ...DEFAULT_SESSION_CONFIG,
    ...(appConfig ?? {}),
    ...options,
    cookie: {
      ...DEFAULT_SESSION_CONFIG.cookie,
      ...(appConfig?.cookie ?? {}),
      ...(options.cookie ?? {}),
    },
  };

  return {
    enabled: merged.enabled ?? DEFAULT_SESSION_CONFIG.enabled,
    name: merged.name ?? DEFAULT_SESSION_CONFIG.name,
    ttl: merged.ttl ?? DEFAULT_SESSION_CONFIG.ttl,
    rolling: merged.rolling ?? DEFAULT_SESSION_CONFIG.rolling,
    autoCommit: merged.autoCommit ?? DEFAULT_SESSION_CONFIG.autoCommit,
    idLength: merged.idLength ?? DEFAULT_SESSION_CONFIG.idLength,
    cookie: merged.cookie ?? DEFAULT_SESSION_CONFIG.cookie,
    store: options.store ?? appConfig?.store ?? fallbackStore,
  };
}

function resolveCookieOptions(
  req: VextRequest,
  config: ResolvedSessionConfig,
): CookieSerializeOptions {
  const { secure, maxAge, ...rest } = config.cookie;
  return {
    ...rest,
    maxAge: maxAge ?? config.ttl,
    secure: secure === "auto" ? req.protocol === "https" : secure,
  };
}

function generateSessionId(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function assertSessionConfig(config: ResolvedSessionConfig): void {
  if (!config.name) {
    throw new Error("[vextjs] session.name must not be empty");
  }
  if (!Number.isFinite(config.ttl) || config.ttl <= 0) {
    throw new Error(
      "[vextjs] session.ttl must be a positive number of seconds",
    );
  }
  if (
    !Number.isInteger(config.idLength) ||
    config.idLength < 16 ||
    config.idLength > 128
  ) {
    throw new Error(
      "[vextjs] session.idLength must be an integer from 16 to 128",
    );
  }
}
