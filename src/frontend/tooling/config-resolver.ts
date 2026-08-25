import path from "node:path";
import type {
  VextFrontendDeployUploadAdapter,
  VextFrontendDeployUploadAdapterName,
  VextFrontendExternalRuntimeEntry,
  VextFrontendImageFormat,
  VextFrontendMediaConfig,
  VextFrontendSeoConfig,
  ResolvedVextFrontendConfig,
  VextFrontendBuildBudgetsConfig,
  VextFrontendSpaFallbackConfig,
  VextFrontendSpaFallbackScope,
  VextFrontendVendorChunksConfig,
  VextFrontendMode,
  VextFrontendUserConfig,
} from "../contract/types.js";
import {
  normalizeSeoMetadata,
  normalizeSeoSafeText,
  normalizeSeoTextList,
} from "../contract/seo-normalization.js";
import {
  assertPathInside,
  assertSafeProjectOutputDirectory,
  normalizeSafeRelativePath,
} from "../../lib/path-boundary.js";

export interface ResolveFrontendConfigOptions {
  rootDir: string;
  mode: VextFrontendMode;
}

const DEFAULT_FALLBACK_EXCLUDE = [
  "/api/**",
  "/openapi.json",
  "/docs/**",
  "/_vext/docs/**",
];

export function resolveFrontendConfig(
  input: VextFrontendUserConfig | undefined,
  options: ResolveFrontendConfigOptions,
): ResolvedVextFrontendConfig {
  const raw =
    input === true
      ? { enabled: true }
      : input === false
        ? { enabled: false }
        : input;
  const enabled = raw?.enabled ?? false;
  const root = resolveProjectPath(
    options.rootDir,
    raw?.root ?? "src/frontend",
    "config.frontend.root",
  );
  const pages = raw?.pages ?? {};
  const pagesDir = resolveFrontendPath(
    options.rootDir,
    root,
    pages.dir ?? "pages",
    "config.frontend.pages.dir",
  );
  const pageExtensions = pages.extensions ?? [".tsx", ".jsx", ".ts", ".js"];
  const componentsDir = resolveFrontendPath(
    options.rootDir,
    root,
    raw?.componentsDir ?? "components",
    "config.frontend.componentsDir",
  );
  const styles = raw?.styles ?? {};
  const stylesEntry = resolveFrontendPath(
    options.rootDir,
    root,
    styles.entry ?? path.join("styles", "index.css"),
    "config.frontend.styles.entry",
  );
  const jscss =
    typeof styles.jscss === "boolean"
      ? { enabled: styles.jscss }
      : (styles.jscss ?? {});
  const assetsDir = resolveFrontendPath(
    options.rootDir,
    root,
    raw?.assetsDir ?? "assets",
    "config.frontend.assetsDir",
  );
  const outDir = resolveProjectPath(
    options.rootDir,
    raw?.outDir ??
      (options.mode === "development" ? ".vext/client" : "dist/client"),
    "config.frontend.outDir",
  );
  assertSafeProjectOutputDirectory(
    options.rootDir,
    outDir,
    "config.frontend.outDir",
  );
  const publicDir = resolveProjectPath(
    options.rootDir,
    raw?.publicDir ?? "public",
    "config.frontend.publicDir",
  );
  const entry = resolveProjectPath(
    options.rootDir,
    raw?.entry ??
      path.join(".vext", "generated", "frontend", "browser-entry.tsx"),
    "config.frontend.entry",
  );
  const indexHtml = resolveProjectPath(
    options.rootDir,
    raw?.indexHtml ?? path.join("src", "frontend", "pages", "_document.html"),
    "config.frontend.indexHtml",
  );
  const spaFallback = normalizeSpaFallback(raw?.spaFallback);
  const seo = normalizeSeo(raw?.seo);
  const apiClient = raw?.apiClient;
  const media = normalizeMedia(raw?.media);
  const build = raw?.build ?? {};
  const target = build.target
    ? Array.isArray(build.target)
      ? build.target
      : [build.target]
    : ["es2022"];
  const clientBuild = build.client ?? {};
  const clientAssetsDir = normalizeSafeRelativePath(
    clientBuild.assetsDir ?? "assets",
    "config.frontend.build.client.assetsDir",
  );
  const clientEntryNames = normalizeSafeRelativePath(
    clientBuild.entryNames ?? "[name]-[hash]",
    "config.frontend.build.client.entryNames",
  );
  const clientChunkNames = normalizeSafeRelativePath(
    clientBuild.chunkNames ?? "[name]-[hash]",
    "config.frontend.build.client.chunkNames",
  );
  const clientAssetNames = normalizeSafeRelativePath(
    clientBuild.assetNames ?? "[name]-[hash]",
    "config.frontend.build.client.assetNames",
  );
  const clientTarget = normalizeTarget(
    clientBuild.target ?? build.target,
    "es2022",
  );
  const serverBuild = build.server ?? {};
  const serverOutFile = resolveProjectPath(
    options.rootDir,
    serverBuild.outFile ?? path.join(outDir, "server", "renderer.cjs"),
    "config.frontend.build.server.outFile",
  );
  assertPathInside(
    outDir,
    serverOutFile,
    "config.frontend.build.server.outFile",
  );
  const serverTarget = normalizeTarget(serverBuild.target, "node20");
  assertSupportedBuildTargetKeys(
    clientBuild,
    "config.frontend.build.client",
    ["outDir", "outFile", "manifest"],
    "Browser builds write to config.frontend.outDir and always emit the Vext manifest family.",
  );
  assertSupportedBuildTargetKeys(
    serverBuild,
    "config.frontend.build.server",
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
    "The frontend SSR renderer supports config.frontend.build.server.outFile, target, minify, sourcemap, and external.",
  );

  return {
    enabled,
    framework: raw?.framework ?? "react",
    root,
    pages: {
      dir: pagesDir,
      extensions: pageExtensions,
      document: resolveFrontendPath(
        options.rootDir,
        root,
        pages.document ?? path.join("pages", "_document.html"),
        "config.frontend.pages.document",
      ),
      errorDir: resolveFrontendPath(
        options.rootDir,
        root,
        pages.errorDir ?? path.join("pages", "error"),
        "config.frontend.pages.errorDir",
      ),
    },
    componentsDir,
    styles: {
      entry: stylesEntry,
      jscss: {
        enabled: jscss.enabled ?? true,
        files: jscss.files ?? ["**/*.style.ts", "**/*.style.js", "**/*.css.ts"],
        runtimeAdapter: jscss.runtimeAdapter ?? "css-variables",
        dynamicVars: jscss.dynamicVars ?? true,
        recipes: jscss.recipes ?? true,
      },
    },
    assetsDir,
    media,
    entry,
    indexHtml,
    outDir,
    publicDir,
    publicPath: normalizePublicPath(raw?.publicPath ?? "/"),
    alias: resolveAlias(options.rootDir, root, raw?.alias),
    spaFallback,
    apiClient: {
      enabled:
        typeof apiClient === "boolean"
          ? apiClient
          : (apiClient?.enabled ?? true),
    },
    build: {
      minify: build.minify ?? options.mode === "production",
      sourcemap: build.sourcemap ?? options.mode === "development",
      target,
      client: {
        outDir,
        assetsDir: clientAssetsDir,
        target: clientTarget,
        minify:
          clientBuild.minify ?? build.minify ?? options.mode === "production",
        sourcemap:
          clientBuild.sourcemap ??
          build.sourcemap ??
          options.mode === "development",
        splitting: clientBuild.splitting ?? true,
        entryNames: clientEntryNames,
        chunkNames: clientChunkNames,
        assetNames: clientAssetNames,
        external: clientBuild.external ?? [],
        externalRuntime: normalizeExternalRuntime(
          clientBuild.externalRuntime,
          "config.frontend.build.client.externalRuntime",
        ),
      },
      server: {
        outFile: serverOutFile,
        target: serverTarget,
        minify: serverBuild.minify ?? false,
        sourcemap: serverBuild.sourcemap ?? options.mode === "development",
        external: serverBuild.external ?? [],
      },
      vendorChunks: normalizeVendorChunks(build.vendorChunks),
      budgets: normalizeBudgets(build.budgets),
      assets: {
        inlineLimit: build.assets?.inlineLimit ?? 0,
      },
      css: {
        modules: build.css?.modules ?? true,
      },
      diagnostics: {
        metafile: build.diagnostics?.metafile ?? true,
        sizeReport: build.diagnostics?.sizeReport ?? true,
        performanceReport: build.diagnostics?.performanceReport ?? true,
        leakScan: build.diagnostics?.leakScan ?? true,
      },
    },
    deploy: {
      assetBaseUrl: normalizeAssetBaseUrl(raw?.deploy?.assetBaseUrl),
      crossOrigin: raw?.deploy?.crossOrigin,
      integrity: raw?.deploy?.integrity ?? false,
      upload: normalizeDeployUpload(raw?.deploy?.upload, options.rootDir),
    },
    render: {
      ssr: raw?.render?.ssr ?? true,
      streaming: raw?.render?.streaming ?? "buffered",
      fallback: raw?.render?.fallback ?? "client",
      timeoutMs: raw?.render?.timeoutMs ?? 3000,
      layout: raw?.render?.layout ?? true,
    },
    errorPages: {
      default: raw?.errorPages?.default ?? "error/default",
      status: normalizeErrorPages(raw?.errorPages?.status),
    },
    seo,
    i18n: {
      enabled: raw?.i18n?.enabled ?? false,
      source: resolveFrontendPath(
        options.rootDir,
        root,
        raw?.i18n?.source ?? "locales",
        "config.frontend.i18n.source",
      ),
      defaultLocale: raw?.i18n?.defaultLocale ?? "inherit",
      detect: raw?.i18n?.detect ?? ["accept-language"],
      inject: raw?.i18n?.inject ?? "used",
      clientLoad: normalizeI18nClientLoad(raw?.i18n?.clientLoad),
      clientSwitch: raw?.i18n?.clientSwitch ?? "reload",
      htmlLang: raw?.i18n?.htmlLang ?? true,
      vary: raw?.i18n?.vary ?? true,
    },
    dev: {
      hot: raw?.dev?.hot ?? true,
      fastRefresh: raw?.dev?.fastRefresh ?? true,
      transport: raw?.dev?.transport ?? "sse",
      overlay: raw?.dev?.overlay ?? true,
      debounceMs: raw?.dev?.debounceMs ?? 50,
      renderRefresh: raw?.dev?.renderRefresh ?? "prompt",
    },
    adapter: raw?.adapter,
  };
}

function normalizeSeo(
  value: VextFrontendSeoConfig | undefined,
): ResolvedVextFrontendConfig["seo"] {
  if (value === undefined) {
    return {
      configured: false,
      enabled: false,
      origins: {},
      defaults: {},
      sitemap: false,
      robots: false,
    };
  }

  const publicOrigin = normalizePublicOrigin(
    value.publicOrigin,
    "config.frontend.seo.publicOrigin",
  );
  const origins = Object.fromEntries(
    Object.entries(value.origins ?? {})
      .map(([key, origin]) => {
        if (!/^[a-z0-9._-]+$/iu.test(key)) {
          throw new Error(
            `[vextjs] config.frontend.seo.origins key "${key}" is invalid.`,
          );
        }
        return [
          key,
          normalizePublicOrigin(origin, `config.frontend.seo.origins.${key}`)!,
        ] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assertUniqueSeoOriginHosts(publicOrigin, origins);
  const titleTemplate =
    value.titleTemplate === undefined
      ? undefined
      : normalizeSeoSafeText(
          value.titleTemplate,
          "config.frontend.seo.titleTemplate",
        );
  if (titleTemplate && !titleTemplate.includes("%s")) {
    throw new Error(
      '[vextjs] config.frontend.seo.titleTemplate must contain the "%s" placeholder.',
    );
  }
  const defaults =
    normalizeSeoMetadata(value.defaults, "config.frontend.seo.defaults") ?? {};

  const sitemap = normalizeSitemap(value.sitemap);
  const robots = normalizeRobots(value.robots);
  if (sitemap !== false && robots !== false && sitemap.path === robots.path) {
    throw new Error(
      "[vextjs] config.frontend.seo sitemap and robots paths must be different.",
    );
  }
  if (
    value.enabled !== false &&
    (sitemap !== false || robots !== false) &&
    !publicOrigin &&
    Object.keys(origins).length === 0
  ) {
    throw new Error(
      "[vextjs] config.frontend.seo requires publicOrigin or declared origins when sitemap or robots is enabled.",
    );
  }

  return {
    configured: true,
    enabled: value.enabled !== false,
    publicOrigin,
    origins,
    titleTemplate,
    defaults,
    sitemap,
    robots,
  };
}

function normalizeSitemap(
  value: VextFrontendSeoConfig["sitemap"],
): ResolvedVextFrontendConfig["seo"]["sitemap"] {
  if (value === undefined || value === false) return false;
  const mode = value.mode ?? "build";
  if (mode !== "build" && mode !== "runtime") {
    throw new Error(
      '[vextjs] config.frontend.seo.sitemap.mode must be "build" or "runtime".',
    );
  }
  const maxUrlsPerFile = value.maxUrlsPerFile ?? 50_000;
  if (
    !Number.isInteger(maxUrlsPerFile) ||
    maxUrlsPerFile <= 0 ||
    maxUrlsPerFile > 50_000
  ) {
    throw new Error(
      "[vextjs] config.frontend.seo.sitemap.maxUrlsPerFile must be an integer from 1 through 50000.",
    );
  }
  const maxUrls = value.maxUrls ?? 100_000;
  const maxBytes = value.maxBytes ?? 50 * 1024 * 1024;
  const timeoutMs = value.timeoutMs ?? 5_000;
  for (const [name, limit, maximum] of [
    ["maxUrls", maxUrls, 1_000_000],
    ["maxBytes", maxBytes, 1024 * 1024 * 1024],
    ["timeoutMs", timeoutMs, 120_000],
  ] as const) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > maximum) {
      throw new Error(
        `[vextjs] config.frontend.seo.sitemap.${name} must be an integer from 1 through ${maximum}.`,
      );
    }
  }
  if (value.entries !== undefined && typeof value.entries !== "function") {
    throw new Error(
      "[vextjs] config.frontend.seo.sitemap.entries must be a function.",
    );
  }
  return {
    mode,
    path: normalizeSeoOutputPath(
      value.path ?? "/sitemap.xml",
      "config.frontend.seo.sitemap.path",
    ),
    includeStatic: value.includeStatic ?? true,
    entries: value.entries,
    maxUrlsPerFile,
    maxUrls,
    maxBytes,
    timeoutMs,
  };
}

function normalizeRobots(
  value: VextFrontendSeoConfig["robots"],
): ResolvedVextFrontendConfig["seo"]["robots"] {
  if (value === undefined || value === false) return false;
  const mode = value.mode ?? "build";
  if (mode !== "build" && mode !== "runtime") {
    throw new Error(
      '[vextjs] config.frontend.seo.robots.mode must be "build" or "runtime".',
    );
  }
  if (value.path !== undefined && value.path !== "/robots.txt") {
    throw new Error(
      '[vextjs] config.frontend.seo.robots.path must be "/robots.txt".',
    );
  }
  const groups = (value.groups ?? [{ userAgent: "*", allow: "/" }]).map(
    (group, index) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        throw new Error(
          `[vextjs] config.frontend.seo.robots.groups[${index}] must be an object.`,
        );
      }
      const userAgent = normalizeSeoTextList(
        group.userAgent,
        `config.frontend.seo.robots.groups[${index}].userAgent`,
      );
      const allow =
        group.allow === undefined
          ? undefined
          : normalizeSeoTextList(
              group.allow,
              `config.frontend.seo.robots.groups[${index}].allow`,
            );
      const disallow =
        group.disallow === undefined
          ? undefined
          : normalizeSeoTextList(
              group.disallow,
              `config.frontend.seo.robots.groups[${index}].disallow`,
            );
      if (
        group.crawlDelay !== undefined &&
        (!Number.isFinite(group.crawlDelay) || group.crawlDelay < 0)
      ) {
        throw new Error(
          `[vextjs] config.frontend.seo.robots.groups[${index}].crawlDelay must be a non-negative number.`,
        );
      }
      return {
        userAgent,
        ...(allow !== undefined ? { allow } : {}),
        ...(disallow !== undefined ? { disallow } : {}),
        ...(group.crawlDelay !== undefined
          ? { crawlDelay: group.crawlDelay }
          : {}),
      };
    },
  );
  return { mode, path: "/robots.txt", groups };
}

function assertUniqueSeoOriginHosts(
  publicOrigin: string | undefined,
  origins: Readonly<Record<string, string>>,
): void {
  const owners = new Map<string, string>();
  const candidates = [
    ...(publicOrigin
      ? [["config.frontend.seo.publicOrigin", publicOrigin] as const]
      : []),
    ...Object.entries(origins).map(
      ([key, origin]) =>
        [`config.frontend.seo.origins.${key}`, origin] as const,
    ),
  ];
  for (const [label, origin] of candidates) {
    const host = new URL(origin).host.toLowerCase();
    const existing = owners.get(host);
    if (existing) {
      throw new Error(
        `[vextjs] ${existing} and ${label} share request host "${host}"; runtime Host selection cannot disambiguate path-specific origins.`,
      );
    }
    owners.set(host, label);
  }
}

function normalizePublicOrigin(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[vextjs] ${label} must be an absolute http(s) URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `[vextjs] ${label} must be an absolute http(s) URL without userinfo, query, or hash.`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function normalizeSeoOutputPath(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(
      `[vextjs] ${label} must be a root absolute file pathname without query, hash, or traversal.`,
    );
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.endsWith("/") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    decoded.includes("\\") ||
    hasDotPathSegment(value) ||
    hasDotPathSegment(decoded)
  ) {
    throw new Error(
      `[vextjs] ${label} must be a root absolute file pathname without query, hash, or traversal.`,
    );
  }
  return value;
}

function hasDotPathSegment(value: string): boolean {
  return value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function normalizeExternalRuntime(
  value: Record<string, string | VextFrontendExternalRuntimeEntry> | undefined,
  label: string,
): Record<string, VextFrontendExternalRuntimeEntry> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).map(([specifier, entry]) => {
      const normalized =
        typeof entry === "string" ? { url: entry } : { ...entry };
      if (!/^[a-z]+:\/\//i.test(normalized.url)) {
        throw new Error(
          `[vextjs] ${label}.${specifier}.url must be an absolute URL.`,
        );
      }
      return [specifier, normalized];
    }),
  );
}

function normalizeVendorChunks(
  value: boolean | VextFrontendVendorChunksConfig | undefined,
): Required<VextFrontendVendorChunksConfig> {
  if (value === false) {
    return { enabled: false, packages: [], entryName: "vext-vendor" };
  }
  const raw = value === true ? { enabled: true } : (value ?? {});
  return {
    enabled: raw.enabled ?? true,
    packages: raw.packages ?? ["react", "react-dom", "react-dom/client"],
    entryName: raw.entryName ?? "vext-vendor",
  };
}

function normalizeBudgets(
  value: VextFrontendBuildBudgetsConfig | undefined,
): Required<VextFrontendBuildBudgetsConfig> {
  return {
    maxAssetBytes: value?.maxAssetBytes ?? 0,
    maxInitialJsBytes: value?.maxInitialJsBytes ?? 0,
    maxInitialJsGzipBytes: value?.maxInitialJsGzipBytes ?? 0,
    maxInitialJsBrotliBytes: value?.maxInitialJsBrotliBytes ?? 0,
    maxRouteInitialJsBrotliBytes: value?.maxRouteInitialJsBrotliBytes ?? 0,
    maxAppOwnedInitialJsBrotliBytes:
      value?.maxAppOwnedInitialJsBrotliBytes ?? 0,
    maxTotalBytes: value?.maxTotalBytes ?? 0,
    warnOnly: value?.warnOnly ?? false,
  };
}

function normalizeMedia(
  value: VextFrontendMediaConfig | undefined,
): ResolvedVextFrontendConfig["media"] {
  const image = value?.images ?? {};
  const widths = [...new Set(image.widths ?? [320, 640, 960, 1280, 1600])].sort(
    (left, right) => left - right,
  );
  if (
    widths.length === 0 ||
    widths.some((width) => !Number.isInteger(width) || width <= 0)
  ) {
    throw new Error(
      "[vextjs] config.frontend.media.images.widths must contain positive integer widths.",
    );
  }
  const requestedFormats = [
    ...new Set(image.formats ?? ["original", "webp", "avif"]),
  ];
  if (
    requestedFormats.length === 0 ||
    requestedFormats.some((format) => !isImageFormat(format))
  ) {
    throw new Error(
      '[vextjs] config.frontend.media.images.formats only supports "original", "webp", and "avif".',
    );
  }
  const formats = requestedFormats as VextFrontendImageFormat[];
  const quality = image.quality ?? 75;
  const maxInputPixels = image.maxInputPixels ?? 40_000_000;
  const maxVariants = image.maxVariants ?? 24;
  const maxBytes = value?.maxBytes ?? 20 * 1024 * 1024;
  const fontMaxBytes = value?.fonts?.maxBytes ?? 5 * 1024 * 1024;
  for (const [label, limit] of [
    ["quality", quality],
    ["maxInputPixels", maxInputPixels],
    ["maxVariants", maxVariants],
    ["maxBytes", maxBytes],
    ["fonts.maxBytes", fontMaxBytes],
  ] as const) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(
        `[vextjs] config.frontend.media.${label} must be a positive number.`,
      );
    }
  }
  if (!Number.isInteger(quality) || quality > 100) {
    throw new Error(
      "[vextjs] config.frontend.media.images.quality must be an integer from 1 through 100.",
    );
  }
  return {
    maxBytes,
    images: {
      widths,
      formats,
      quality,
      maxInputPixels,
      maxVariants,
    },
    fonts: {
      maxBytes: fontMaxBytes,
    },
  };
}

function isImageFormat(value: unknown): value is VextFrontendImageFormat {
  return value === "original" || value === "webp" || value === "avif";
}

function assertSupportedBuildTargetKeys(
  value: object,
  path: string,
  unsupportedKeys: string[],
  guidance: string,
): void {
  const target = value as Record<string, unknown>;
  for (const key of unsupportedKeys) {
    if (target[key] !== undefined) {
      throw new Error(`[vextjs] ${path}.${key} is not supported. ${guidance}`);
    }
  }
}

function normalizeI18nClientLoad(
  value: unknown,
): ResolvedVextFrontendConfig["i18n"]["clientLoad"] {
  if (value === undefined) {
    return "current";
  }
  if (value === "current" || value === "all") {
    return value;
  }
  throw new Error(
    '[vextjs] config.frontend.i18n.clientLoad must be "current" or "all".',
  );
}

function normalizeDeployUpload(
  value:
    | boolean
    | {
        enabled?: boolean;
        adapter?:
          | VextFrontendDeployUploadAdapterName
          | VextFrontendDeployUploadAdapter;
        targetDir?: string;
        publicBaseUrl?: string;
        prefix?: string;
        stateFile?: string;
        dryRun?: boolean;
        concurrency?: number;
        include?: string[];
        exclude?: string[];
      }
    | undefined,
  rootDir: string,
): ResolvedVextFrontendConfig["deploy"]["upload"] {
  const raw = typeof value === "boolean" ? { enabled: value } : (value ?? {});
  const enabled = raw.enabled ?? false;
  const targetDir = raw.targetDir
    ? resolveProjectPath(
        rootDir,
        raw.targetDir,
        "config.frontend.deploy.upload.targetDir",
      )
    : enabled
      ? resolveProjectPath(
          rootDir,
          path.join(".vext", "deploy", "frontend-assets"),
          "config.frontend.deploy.upload.targetDir",
        )
      : undefined;
  const stateFile = resolveProjectPath(
    rootDir,
    raw.stateFile ?? path.join(".vext", "deploy", "frontend-assets-state.json"),
    "config.frontend.deploy.upload.stateFile",
  );
  return {
    enabled,
    adapter: raw.adapter ?? "filesystem",
    targetDir,
    publicBaseUrl: normalizeOptionalAbsoluteUrl(
      raw.publicBaseUrl,
      "config.frontend.deploy.upload.publicBaseUrl",
    ),
    prefix: normalizeUploadPrefix(raw.prefix ?? ""),
    stateFile,
    dryRun: raw.dryRun ?? false,
    concurrency: raw.concurrency ?? 4,
    include: raw.include ?? ["**/*"],
    exclude: raw.exclude ?? ["**/*.map"],
  };
}

function normalizeTarget(
  value: string | string[] | undefined,
  fallback: string,
): string[] {
  if (!value) return [fallback];
  return Array.isArray(value) ? value : [value];
}

function normalizeSpaFallback(
  input: VextFrontendSpaFallbackConfig | boolean | undefined,
): ResolvedVextFrontendConfig["spaFallback"] {
  if (input === false) {
    return { enabled: false, exclude: DEFAULT_FALLBACK_EXCLUDE, scopes: [] };
  }
  if (input === undefined) {
    return { enabled: true, exclude: DEFAULT_FALLBACK_EXCLUDE, scopes: [] };
  }
  if (input === true) {
    return {
      enabled: true,
      exclude: DEFAULT_FALLBACK_EXCLUDE,
      scopes: [
        {
          basePath: "/",
          page: "index",
          ssr: false,
          exclude: [],
          status: 200,
        },
      ],
    };
  }
  return {
    enabled: input.enabled ?? true,
    exclude: input.exclude ?? DEFAULT_FALLBACK_EXCLUDE,
    scopes: (input.scopes ?? []).map(normalizeSpaFallbackScope),
  };
}

function normalizeSpaFallbackScope(
  scope: VextFrontendSpaFallbackScope,
): ResolvedVextFrontendConfig["spaFallback"]["scopes"][number] {
  return {
    basePath: normalizeUrlPath(
      scope.basePath,
      "config.frontend.spaFallback.scopes[].basePath",
    ),
    page: scope.page,
    ssr: scope.ssr ?? false,
    exclude: scope.exclude ?? [],
    status: scope.status ?? 200,
  };
}

function normalizePublicPath(value: string): string {
  if (/^[a-z]+:\/\//i.test(value)) {
    throw new Error(
      "[vextjs] config.frontend.publicPath must be a path, not a URL.",
    );
  }
  return normalizeUrlPath(value, "config.frontend.publicPath");
}

function normalizeUrlPath(value: string, label: string): string {
  if (/^[a-z]+:\/\//i.test(value)) {
    throw new Error(`[vextjs] ${label} must be a path, not a URL.`);
  }
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  const collapsed = withLeading.replace(/\/+/g, "/");
  return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

function normalizeAssetBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[a-z]+:\/\//i.test(value)) {
    throw new Error(
      "[vextjs] config.frontend.deploy.assetBaseUrl must be an absolute URL.",
    );
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeOptionalAbsoluteUrl(
  value: string | undefined,
  label: string,
): string | undefined {
  if (!value) return undefined;
  if (!/^[a-z]+:\/\//i.test(value)) {
    throw new Error(`[vextjs] ${label} must be an absolute URL.`);
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeUploadPrefix(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/u, "");
  if (normalized.includes("..")) {
    throw new Error(
      "[vextjs] config.frontend.deploy.upload.prefix must not contain '..'.",
    );
  }
  return normalized.replace(/\/+$/u, "");
}

function normalizeErrorPages(
  value: Record<string | number, string> | undefined,
): Record<string, string> {
  if (!value) {
    return {
      "404": "error/404",
      "500": "error/500",
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([status, page]) => [String(status), page]),
  );
}

function resolveAlias(
  rootDir: string,
  frontendRoot: string,
  alias: Record<string, string> | undefined,
): Record<string, string> {
  const defaults: Record<string, string> = {
    "@frontend": ".",
    "@pages": "pages",
    "@components": "components",
    "@styles": "styles",
    "@assets": "assets",
  };
  return Object.fromEntries(
    Object.entries({ ...defaults, ...(alias ?? {}) }).map(([key, value]) => [
      key,
      resolveFrontendPath(
        rootDir,
        frontendRoot,
        value,
        `config.frontend.alias.${key}`,
      ),
    ]),
  );
}

function resolveFrontendPath(
  rootDir: string,
  frontendRoot: string,
  value: string,
  label: string,
): string {
  const resolved = path.isAbsolute(value)
    ? value
    : path.resolve(frontendRoot, value);
  ensureInsideProject(rootDir, resolved, label);
  return resolved;
}

function resolveProjectPath(
  rootDir: string,
  value: string,
  label: string,
): string {
  const resolved = path.resolve(rootDir, value);
  ensureInsideProject(rootDir, resolved, label);
  return resolved;
}

function ensureInsideProject(
  rootDir: string,
  resolved: string,
  label: string,
): void {
  const relative = path.relative(rootDir, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`[vextjs] ${label} must resolve inside the project root.`);
  }
}
