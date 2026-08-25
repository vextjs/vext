import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VextMiddleware } from "../types/middleware.js";
import type { VextRequest } from "../types/request.js";
import type { VextResponse } from "../types/response.js";
import type { RouteOptions } from "../types/app.js";
import type {
  VextCsrfConfig,
  VextCsrfCookieConfig,
  VextCsrfErrorCode,
  VextCsrfMode,
  VextCsrfOriginConfig,
} from "../types/csrf.js";
import { HttpError } from "../types/errors.js";

export type {
  VextCsrfConfig,
  VextCsrfCookieConfig,
  VextCsrfErrorCode,
  VextCsrfMode,
  VextCsrfOriginConfig,
} from "../types/csrf.js";

const SESSION_TOKEN_KEY = "__vext_csrf";

const DEFAULT_CSRF_CONFIG: Required<
  Pick<
    VextCsrfConfig,
    | "enabled"
    | "mode"
    | "methods"
    | "headerNames"
    | "bodyField"
    | "fetchMetadata"
  >
> & {
  cookie: Required<Pick<VextCsrfCookieConfig, "name" | "path" | "httpOnly">> &
    Omit<VextCsrfCookieConfig, "name" | "path" | "httpOnly">;
  origin: false | VextCsrfOriginConfig;
} = {
  enabled: true,
  mode: "auto",
  methods: ["POST", "PUT", "PATCH", "DELETE"],
  headerNames: ["x-csrf-token", "x-xsrf-token"],
  bodyField: "_csrf",
  cookie: {
    name: "vext.csrf",
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    secure: "auto",
  },
  fetchMetadata: true,
  origin: false,
};

interface ResolvedCsrfConfig {
  enabled: boolean;
  mode: VextCsrfMode;
  secret?: string;
  methods: Set<string>;
  headerNames: string[];
  bodyField: string | false;
  cookie: VextCsrfCookieConfig & { name: string; path: string };
  fetchMetadata: boolean;
  origin: false | VextCsrfOriginConfig;
}

interface SignedCookieToken {
  token: string;
  signature: string;
}

export function createCsrfMiddleware(
  options: VextCsrfConfig = {},
): VextMiddleware {
  return async (req, res, next) => {
    const config = resolveCsrfConfig(req.app.config.csrf, options);
    if (!config.enabled) {
      await next();
      return;
    }

    attachCsrfToken(req, res, config);

    if (shouldSkipCsrf(req, config)) {
      await next();
      return;
    }

    assertFetchMetadata(req, config);
    assertOrigin(req, config);
    assertSubmittedToken(req, config);

    await next();
  };
}

export const csrf = createCsrfMiddleware;

function resolveCsrfConfig(
  appConfig: VextCsrfConfig | undefined,
  options: VextCsrfConfig,
): ResolvedCsrfConfig {
  const { enabled: _appEnabled, ...appDefaults } = appConfig ?? {};
  const merged: VextCsrfConfig = {
    ...DEFAULT_CSRF_CONFIG,
    ...appDefaults,
    ...options,
    cookie: {
      ...DEFAULT_CSRF_CONFIG.cookie,
      ...(appConfig?.cookie ?? {}),
      ...(options.cookie ?? {}),
    },
  };

  return {
    enabled: merged.enabled ?? DEFAULT_CSRF_CONFIG.enabled,
    mode: merged.mode ?? DEFAULT_CSRF_CONFIG.mode,
    secret: merged.secret,
    methods: new Set(
      (merged.methods ?? DEFAULT_CSRF_CONFIG.methods).map((method) =>
        method.toUpperCase(),
      ),
    ),
    headerNames: normalizeHeaderNames(
      merged.headerNames ?? DEFAULT_CSRF_CONFIG.headerNames,
    ),
    bodyField: merged.bodyField ?? DEFAULT_CSRF_CONFIG.bodyField,
    cookie: {
      ...DEFAULT_CSRF_CONFIG.cookie,
      ...(merged.cookie ?? {}),
      name: merged.cookie?.name ?? DEFAULT_CSRF_CONFIG.cookie.name,
      path: merged.cookie?.path ?? DEFAULT_CSRF_CONFIG.cookie.path,
    },
    fetchMetadata: merged.fetchMetadata ?? DEFAULT_CSRF_CONFIG.fetchMetadata,
    origin: merged.origin ?? DEFAULT_CSRF_CONFIG.origin,
  };
}

function attachCsrfToken(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedCsrfConfig,
): void {
  let cachedToken: string | undefined;

  req.csrfToken = () => {
    if (cachedToken) return cachedToken;

    const mode = resolveMode(req, config);
    cachedToken =
      mode === "session"
        ? ensureSessionToken(req)
        : ensureSignedCookieToken(req, res, config);
    res.setHeader("Cache-Control", "no-store");
    return cachedToken;
  };
}

function shouldSkipCsrf(req: VextRequest, config: ResolvedCsrfConfig): boolean {
  const routeOptions = getRouteOptions(req);
  if (routeOptions?.csrf === false) return true;
  return !config.methods.has(req.method.toUpperCase());
}

function getRouteOptions(req: VextRequest): RouteOptions | undefined {
  return (req as { _routeOptions?: RouteOptions })._routeOptions;
}

function assertFetchMetadata(
  req: VextRequest,
  config: ResolvedCsrfConfig,
): void {
  if (!config.fetchMetadata) return;
  const site = req.headers["sec-fetch-site"]?.toLowerCase();
  if (site === "cross-site") {
    throwCsrfError(
      "CSRF_FETCH_METADATA_REJECTED",
      "CSRF request rejected by Fetch Metadata",
    );
  }
}

function assertOrigin(req: VextRequest, config: ResolvedCsrfConfig): void {
  if (config.origin === false) return;

  let candidate: string | undefined;
  if (Object.hasOwn(req.headers, "origin")) {
    candidate = parseSerializedOrigin(req.headers.origin);
    if (!candidate) {
      throwCsrfError("CSRF_ORIGIN_REJECTED", "CSRF origin rejected");
    }
  } else if (Object.hasOwn(req.headers, "referer")) {
    candidate = parseRefererOrigin(req.headers.referer);
    if (!candidate) {
      throwCsrfError("CSRF_ORIGIN_REJECTED", "CSRF origin rejected");
    }
  } else {
    return;
  }

  const requestOrigin = parseSerializedOrigin(getRequestOrigin(req));
  const trusted = new Set<string>();
  for (const configuredOrigin of config.origin.trustedOrigins ?? []) {
    const normalized = parseSerializedOrigin(configuredOrigin);
    if (normalized) trusted.add(normalized);
  }
  if (candidate !== requestOrigin && !trusted.has(candidate)) {
    throwCsrfError("CSRF_ORIGIN_REJECTED", "CSRF origin rejected");
  }
}

function assertSubmittedToken(
  req: VextRequest,
  config: ResolvedCsrfConfig,
): void {
  const submitted = getSubmittedToken(req, config);
  if (!submitted) {
    throwCsrfError("CSRF_TOKEN_MISSING", "CSRF token missing");
  }

  const mode = resolveMode(req, config);
  if (mode === "session") {
    const stored = getSessionToken(req);
    if (!stored || !constantTimeEqual(stored, submitted)) {
      throwCsrfError("CSRF_TOKEN_INVALID", "CSRF token invalid");
    }
    return;
  }

  const cookieToken = readSignedCookieToken(req, config);
  if (!cookieToken || !isSignedCookieTokenValid(cookieToken, config)) {
    throwCsrfError("CSRF_COOKIE_INVALID", "CSRF cookie invalid");
  }
  if (!constantTimeEqual(cookieToken.token, submitted)) {
    throwCsrfError("CSRF_TOKEN_INVALID", "CSRF token invalid");
  }
}

function resolveMode(
  req: VextRequest,
  config: ResolvedCsrfConfig,
): "session" | "signed-cookie" {
  if (config.mode === "session") return "session";
  if (config.mode === "signed-cookie") return "signed-cookie";
  if (req.session) return "session";
  if (config.secret) return "signed-cookie";
  throwCsrfError(
    "CSRF_CONFIGURATION_ERROR",
    "CSRF requires session middleware or config.csrf.secret",
    500,
  );
}

function ensureSessionToken(req: VextRequest): string {
  const existing = getSessionToken(req);
  if (existing) return existing;
  if (!req.session) {
    throwCsrfError(
      "CSRF_CONFIGURATION_ERROR",
      "CSRF session mode requires session middleware",
      500,
    );
  }
  const token = generateToken();
  req.session[SESSION_TOKEN_KEY] = token;
  return token;
}

function getSessionToken(req: VextRequest): string | undefined {
  const value = req.session?.[SESSION_TOKEN_KEY];
  return typeof value === "string" && value ? value : undefined;
}

function ensureSignedCookieToken(
  req: VextRequest,
  res: VextResponse,
  config: ResolvedCsrfConfig,
): string {
  const existing = readSignedCookieToken(req, config);
  if (existing && isSignedCookieTokenValid(existing, config)) {
    return existing.token;
  }

  const token = generateToken();
  const signature = signToken(token, config);
  const { name, secure, ...cookieOptions } = config.cookie;
  res.cookie(name, `${token}.${signature}`, {
    ...cookieOptions,
    secure: secure === "auto" ? req.protocol === "https" : secure,
  });
  return token;
}

function readSignedCookieToken(
  req: VextRequest,
  config: ResolvedCsrfConfig,
): SignedCookieToken | undefined {
  const raw = req.cookie(config.cookie.name);
  if (!raw) return undefined;
  const index = raw.lastIndexOf(".");
  if (index <= 0 || index === raw.length - 1) return undefined;
  return {
    token: raw.slice(0, index),
    signature: raw.slice(index + 1),
  };
}

function isSignedCookieTokenValid(
  value: SignedCookieToken,
  config: ResolvedCsrfConfig,
): boolean {
  return constantTimeEqual(signToken(value.token, config), value.signature);
}

function signToken(token: string, config: ResolvedCsrfConfig): string {
  if (!config.secret) {
    throwCsrfError(
      "CSRF_CONFIGURATION_ERROR",
      "CSRF signed-cookie mode requires config.csrf.secret",
      500,
    );
  }
  return createHmac("sha256", config.secret).update(token).digest("base64url");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function getSubmittedToken(
  req: VextRequest,
  config: ResolvedCsrfConfig,
): string | undefined {
  for (const name of config.headerNames) {
    const value = req.headers[name];
    if (typeof value === "string" && value) return value;
  }

  if (config.bodyField === false || !isRecord(req.body)) {
    return undefined;
  }
  const value = req.body[config.bodyField];
  return typeof value === "string" && value ? value : undefined;
}

function normalizeHeaderNames(names: string[]): string[] {
  return names.map((name) => name.toLowerCase());
}

function getRequestOrigin(req: VextRequest): string {
  const host = req.headers.host ?? "localhost";
  return `${req.protocol}://${host}`;
}

function parseSerializedOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value === "null") {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin === "null" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function parseRefererOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin === "null" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

function throwCsrfError(
  code: VextCsrfErrorCode,
  message: string,
  status = 403,
): never {
  throw new HttpError(status, message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
