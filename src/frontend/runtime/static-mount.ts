import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { VextMiddleware } from "../../types/middleware.js";
import {
  assertPathInside,
  assertRealPathInside,
} from "../../lib/path-boundary.js";
import type {
  ResolvedVextFrontendConfig,
  ResolvedVextFrontendSpaFallbackScope,
  VextFrontendRenderManifest,
  VextFrontendMode,
  VextFrontendUserConfig,
} from "../contract/types.js";
import { getFrontendStaticCacheControl } from "../asset-cache-policy.js";
import { resolveFrontendConfig } from "../tooling/config-resolver.js";
import { createFrontendRenderer } from "./renderer.js";

export interface CreateFrontendNotFoundHandlerOptions {
  rootDir: string;
  mode: VextFrontendMode;
  config: VextFrontendUserConfig | undefined;
  fallbackHandler: VextMiddleware;
  onNotFound?: (req: Parameters<VextMiddleware>[0]) => Promise<void> | void;
}

export function createFrontendNotFoundHandler(
  options: CreateFrontendNotFoundHandlerOptions,
): VextMiddleware {
  const config = resolveFrontendConfig(options.config, {
    rootDir: options.rootDir,
    mode: options.mode,
  });
  if (!config.enabled) {
    return options.fallbackHandler;
  }
  const renderer = createFrontendRenderer(options);

  return async (req, res, next) => {
    if (!isStaticMethod(req.method)) {
      return options.fallbackHandler(req, res, next);
    }

    const assetPath = resolveAssetPath(
      config.outDir,
      config.publicPath,
      req.path,
    );
    if (assetPath) {
      const served = serveFile(
        req,
        res,
        assetPath,
        getAssetCacheControl(config, assetPath),
      );
      if (served) return;
    }

    const fallbackScope = resolveSpaFallbackScope(
      req.path,
      req.headers.accept,
      config.spaFallback,
    );
    if (fallbackScope) {
      await options.onNotFound?.(req);
      const rendered = tryRenderScopedFallback(res, renderer, fallbackScope);
      if (rendered) return;
    }

    if (shouldRenderHtmlNotFound(req.path, req.headers.accept, config)) {
      await options.onNotFound?.(req);
      const rendered = tryRenderHtmlNotFound(req, res, renderer);
      if (rendered) return;
    }

    return options.fallbackHandler(req, res, next);
  };
}

export function assertFrontendOutputReady(
  options: CreateFrontendNotFoundHandlerOptions,
): void {
  const config = resolveFrontendConfig(options.config, {
    rootDir: options.rootDir,
    mode: options.mode,
  });
  if (!config.enabled) return;
  if (options.mode !== "production") return;

  const indexPath = path.join(config.outDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(
      `[vextjs] frontend output is missing: ${path.relative(options.rootDir, indexPath)}. Run "vext build" first.`,
    );
  }

  const manifestPath = path.join(config.outDir, "render-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[vextjs] frontend render-manifest.json is missing: ${path.relative(options.rootDir, manifestPath)}. Run "vext build" first.`,
    );
  }

  const manifest = readFrontendRenderManifest(
    options.rootDir,
    config.outDir,
    manifestPath,
  );
  if (!manifest.routeAssets) {
    throw new Error(
      `[vextjs] frontend render-manifest.json is missing routeAssets. Run "vext build" again before starting production SSR.`,
    );
  }

  const rendererPath = resolveManifestFilePath(
    config.outDir,
    manifest.serverRenderer,
    "render-manifest.json serverRenderer",
  );
  if (!existsSync(rendererPath)) {
    throw new Error(
      `[vextjs] frontend server renderer is missing: ${path.relative(options.rootDir, rendererPath)}. Run "vext build" first.`,
    );
  }
}

function readFrontendRenderManifest(
  rootDir: string,
  outDir: string,
  manifestPath: string,
): VextFrontendRenderManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vextjs] frontend render-manifest.json is invalid: ${path.relative(rootDir, manifestPath)}. Run "vext build" again before starting production SSR. ${message}`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { kind?: unknown }).kind !== "frontend-render-manifest" ||
    typeof (parsed as { serverRenderer?: unknown }).serverRenderer !==
      "string" ||
    !(parsed as { serverRenderer: string }).serverRenderer
  ) {
    throw new Error(
      `[vextjs] frontend render-manifest.json is invalid: ${path.relative(rootDir, manifestPath)}. Run "vext build" again before starting production SSR.`,
    );
  }

  resolveManifestFilePath(
    outDir,
    (parsed as { serverRenderer: string }).serverRenderer,
    "render-manifest.json serverRenderer",
  );
  return parsed as VextFrontendRenderManifest;
}

function resolveManifestFilePath(
  outDir: string,
  value: string,
  label: string,
): string {
  const resolved = assertPathInside(
    outDir,
    path.resolve(outDir, value),
    `frontend ${label}`,
  );
  assertRealPathInside(outDir, resolved, `frontend ${label}`);
  return resolved;
}

function isStaticMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function resolveAssetPath(
  staticRoot: string,
  publicPath: string,
  requestPath: string,
): string | null {
  const pathname = safeDecodePath(requestPath);
  if (!pathname) return null;

  const normalizedPublicPath =
    publicPath === "/" ? "/" : publicPath.replace(/\/$/, "");
  if (normalizedPublicPath !== "/" && pathname !== normalizedPublicPath) {
    if (!pathname.startsWith(`${normalizedPublicPath}/`)) return null;
  }

  const relativeAsset =
    normalizedPublicPath === "/"
      ? pathname.replace(/^\/+/, "")
      : pathname.slice(normalizedPublicPath.length).replace(/^\/+/, "");
  if (!relativeAsset || relativeAsset.endsWith("/")) return null;

  const normalizedAsset = path.posix.normalize(relativeAsset);
  if (normalizedAsset.startsWith("../")) return null;

  let candidate: string;
  try {
    candidate = assertPathInside(
      staticRoot,
      path.resolve(staticRoot, normalizedAsset),
      "frontend static asset path",
    );
    assertRealPathInside(staticRoot, candidate, "frontend static asset path");
  } catch {
    return null;
  }
  return candidate;
}

function serveFile(
  req: { method: string; headers: Record<string, string | undefined> },
  res: Parameters<VextMiddleware>[1],
  filePath: string,
  cacheControl: string,
  forcedContentType?: string,
): boolean {
  if (!existsSync(filePath)) return false;

  const stat = statSync(filePath);
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
  res
    .setHeader("ETag", etag)
    .setHeader("Last-Modified", stat.mtime.toUTCString())
    .setHeader("Cache-Control", cacheControl)
    .setHeader("Content-Type", forcedContentType ?? mimeTypeFor(filePath));

  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch === etag) {
      res.status(304).text("");
      return true;
    }
  } else if (isNotModifiedSince(req.headers["if-modified-since"], stat)) {
    res.status(304).text("");
    return true;
  }

  res.setHeader("Content-Length", String(stat.size));

  if (req.method === "HEAD") {
    res.status(200).text("");
    return true;
  }

  res.stream(
    createReadStream(filePath),
    forcedContentType ?? mimeTypeFor(filePath),
  );
  return true;
}

function isNotModifiedSince(
  header: string | undefined,
  stat: { mtimeMs: number },
): boolean {
  if (!header) return false;
  const sinceMs = Date.parse(header);
  if (!Number.isFinite(sinceMs)) return false;
  return Math.trunc(stat.mtimeMs / 1000) <= Math.trunc(sinceMs / 1000);
}

function resolveSpaFallbackScope(
  requestPath: string,
  acceptHeader: string | undefined,
  fallback: ResolvedVextFrontendConfig["spaFallback"],
): ResolvedVextFrontendSpaFallbackScope | null {
  if (!fallback.enabled || fallback.scopes.length === 0) return null;
  if (!acceptsHtml(acceptHeader)) return null;
  const pathname = safeDecodePath(requestPath);
  if (!pathname) return null;
  if (path.extname(pathname)) return null;
  if (fallback.exclude.some((pattern) => matchPathPattern(pathname, pattern))) {
    return null;
  }

  return (
    fallback.scopes
      .filter((scope) => matchesScope(pathname, scope))
      .sort((a, b) => b.basePath.length - a.basePath.length)[0] ?? null
  );
}

function shouldRenderHtmlNotFound(
  requestPath: string,
  acceptHeader: string | undefined,
  config: ResolvedVextFrontendConfig,
): boolean {
  if (!acceptsHtml(acceptHeader)) return false;
  const pathname = safeDecodePath(requestPath);
  if (!pathname) return false;
  if (path.extname(pathname)) return false;
  if (isApiPath(pathname)) return false;
  if (
    config.spaFallback.exclude.some((pattern) =>
      matchPathPattern(pathname, pattern),
    )
  ) {
    return false;
  }
  return true;
}

function matchesScope(
  pathname: string,
  scope: ResolvedVextFrontendSpaFallbackScope,
): boolean {
  const base = scope.basePath === "/" ? "/" : scope.basePath.replace(/\/$/, "");
  const inScope =
    base === "/" ? true : pathname === base || pathname.startsWith(`${base}/`);
  if (!inScope) return false;
  return !scope.exclude.some((pattern) => matchPathPattern(pathname, pattern));
}

function tryRenderScopedFallback(
  res: Parameters<VextMiddleware>[1],
  renderer: ReturnType<typeof createFrontendRenderer>,
  scope: ResolvedVextFrontendSpaFallbackScope,
): boolean {
  if (!res._sendHtml) return false;
  try {
    const rendered = renderer.renderPage(
      scope.page,
      {},
      {
        status: scope.status,
        headers: { Vary: "Accept" },
        ssr: scope.ssr,
      },
      res.statusCode,
    );
    res._sendHtml(
      rendered.html,
      rendered.status,
      rendered.headers,
      "render",
      rendered.payload,
    );
    return true;
  } catch {
    return false;
  }
}

function tryRenderHtmlNotFound(
  req: Parameters<VextMiddleware>[0],
  res: Parameters<VextMiddleware>[1],
  renderer: ReturnType<typeof createFrontendRenderer>,
): boolean {
  if (!res._sendHtml) return false;
  try {
    const rendered = renderer.renderError(
      404,
      {
        details: { path: req.path },
      },
      undefined,
      404,
      req.requestId,
    );
    res._sendHtml(
      rendered.html,
      rendered.status,
      { ...rendered.headers, Vary: "Accept" },
      "render",
      rendered.payload,
    );
    return true;
  } catch {
    return false;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function acceptsHtml(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return true;
  return acceptHeader
    .split(",")
    .map((entry) => entry.trim().toLowerCase().split(";")[0])
    .some((type) => type === "text/html" || type === "*/*");
}

function matchPathPattern(pathname: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -"/**".length);
    return pathname === base || pathname.startsWith(`${base}/`);
  }
  return pathname === pattern;
}

function safeDecodePath(value: string): string | null {
  const raw = value.split("?")[0] || "/";
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes("\0")) return null;
    return decoded.startsWith("/") ? decoded : `/${decoded}`;
  } catch {
    return null;
  }
}

function getAssetCacheControl(
  config: ResolvedVextFrontendConfig,
  filePath: string,
): string {
  return getFrontendStaticCacheControl(
    path.relative(config.outDir, filePath),
    config.build.client.assetsDir,
  );
}

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
