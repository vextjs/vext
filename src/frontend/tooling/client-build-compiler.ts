import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ResolvedVextFrontendConfig,
  VextFrontendManifest,
  VextFrontendManifestAsset,
  VextFrontendMessagesManifest,
  VextFrontendMode,
  VextFrontendRouteAssetsManifest,
  VextFrontendRenderManifest,
  VextFrontendUserConfig,
} from "../contract/types.js";
import { resolveFrontendConfig } from "./config-resolver.js";
import { writeClientContractFromRouteManifest } from "./client-contract-writer.js";
import {
  type FrontendRenderRegistryResult,
  writeFrontendRenderRegistry,
} from "./render-registry-writer.js";
import { buildFrontendDeployManifest } from "../deploy/manifest.js";
import { getFrontendContentType } from "../deploy/content-type.js";
import { createSha256, createSriSha256 } from "../deploy/integrity.js";
import { STABLE_FRONTEND_GENERATED_AT } from "../contract/metadata.js";
import {
  assertFrontendBudgets,
  buildFrontendSizeReport,
} from "./size-report.js";
import { buildFrontendRouteAssets } from "./route-assets.js";
import { createJscssBuildDefines } from "./jscss-extractor.js";
import { writeStaticFrontendArtifacts } from "./static-artifact-writer.js";
import { writeFrontendMediaArtifacts } from "./media-artifact-writer.js";
import { writeFrontendSeoArtifacts } from "./seo-artifact-writer.js";
import {
  assertPathInside,
  assertSafeProjectOutputDirectory,
} from "../../lib/path-boundary.js";

export interface BuildFrontendClientOptions {
  rootDir: string;
  config: VextFrontendUserConfig | undefined;
  mode: VextFrontendMode;
  signal?: AbortSignal;
}

export interface BuildFrontendClientResult {
  skipped: boolean;
  config: ResolvedVextFrontendConfig;
  manifestPath?: string;
  deployManifestPath?: string;
  renderManifestPath?: string;
  messagesManifestPath?: string;
  serverRendererPath?: string;
  generatedDir?: string;
  contractPath?: string;
  modulePath?: string;
  staticManifestPath?: string;
  mediaManifestPath?: string;
  seoArtifactPaths?: string[];
  routeCount?: number;
  warnings: string[];
}

export async function buildFrontendClient(
  options: BuildFrontendClientOptions,
): Promise<BuildFrontendClientResult> {
  const config = resolveFrontendConfig(options.config, {
    rootDir: options.rootDir,
    mode: options.mode,
  });
  if (!config.enabled) {
    return { skipped: true, config, warnings: [] };
  }

  assertSafeProjectOutputDirectory(
    options.rootDir,
    config.outDir,
    "config.frontend.outDir",
  );
  assertPathInside(
    config.outDir,
    config.build.server.outFile,
    "config.frontend.build.server.outFile",
  );

  await rm(config.outDir, { recursive: true, force: true });
  await mkdir(config.outDir, { recursive: true });

  if (existsSync(config.publicDir)) {
    await cp(config.publicDir, config.outDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }

  const registry = await writeFrontendRenderRegistry({
    rootDir: options.rootDir,
    config,
    mode: options.mode,
  });
  if (config.build.diagnostics.leakScan) {
    await assertRegistrySourcesHaveNoServerLeaks(
      config,
      options.rootDir,
      registry,
    );
  }

  if (!existsSync(config.entry)) {
    throw new Error(
      `[vextjs] frontend entry not found: ${path.relative(options.rootDir, config.entry)}`,
    );
  }

  const contract = config.apiClient.enabled
    ? await writeClientContractFromRouteManifest({
        rootDir: options.rootDir,
        outDir: config.outDir,
      })
    : undefined;
  const nodePaths = resolveFrontendNodePaths(options.rootDir);

  const browserEntryPoints = [config.entry, registry.vendorEntryPath].filter(
    (entryPoint): entryPoint is string => Boolean(entryPoint),
  );
  assertBrowserExternalRuntimeMappings(config);
  const buildResult = await esbuild.build({
    entryPoints: browserEntryPoints,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: config.build.client.target,
    outdir: config.build.client.outDir,
    entryNames: path.posix.join(
      config.build.client.assetsDir,
      config.build.client.entryNames,
    ),
    chunkNames: path.posix.join(
      config.build.client.assetsDir,
      config.build.client.chunkNames,
    ),
    assetNames: path.posix.join(
      config.build.client.assetsDir,
      config.build.client.assetNames,
    ),
    sourcemap: config.build.client.sourcemap,
    minify: config.build.client.minify,
    splitting: config.build.client.splitting,
    metafile: true,
    external: config.build.client.external,
    jsx: "automatic",
    loader: {
      ".png": "file",
      ".jpg": "file",
      ".jpeg": "file",
      ".gif": "file",
      ".webp": "file",
      ".svg": "file",
      ".ico": "file",
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".eot": "file",
      ".css": "css",
    },
    define: {
      "process.env.NODE_ENV":
        options.mode === "production" ? '"production"' : '"development"',
      ...createJscssBuildDefines(config),
    },
    plugins: [
      createAssetInlineLimitPlugin(config),
      createCssModulesPlugin(config),
      createReactRefreshRegistrationPlugin(
        config,
        options.rootDir,
        options.mode,
      ),
      createFrontendResolverPlugin(config, options.rootDir),
    ].filter((plugin): plugin is esbuild.Plugin => Boolean(plugin)),
    nodePaths,
    logLevel: "warning",
  });
  if (config.build.diagnostics.leakScan) {
    assertBrowserMetafileHasNoServerLeaks(
      config,
      options.rootDir,
      buildResult.metafile,
    );
  }

  await mkdir(path.dirname(config.build.server.outFile), { recursive: true });
  const serverBuildResult = await esbuild.build({
    entryPoints: [registry.serverEntryPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: config.build.server.target,
    outfile: config.build.server.outFile,
    sourcemap: config.build.server.sourcemap,
    minify: config.build.server.minify,
    splitting: false,
    metafile: true,
    jsx: "automatic",
    external: config.build.server.external,
    define: {
      "process.env.NODE_ENV":
        options.mode === "production" ? '"production"' : '"development"',
      ...createJscssBuildDefines(config),
    },
    plugins: [createFrontendServerResolverPlugin(config)],
    nodePaths,
    logLevel: "warning",
  });

  const manifest = await attachManifestAssetMetadata(
    config,
    buildManifest(config, buildResult.metafile, options.mode),
  );
  const manifestPath = path.join(config.outDir, "manifest.json");
  const routeAssets = await buildFrontendRouteAssets({
    rootDir: options.rootDir,
    config,
    manifest,
    metafile: buildResult.metafile,
    registry,
  });
  const manifestRouteAssets = config.build.diagnostics.performanceReport
    ? routeAssets
    : stripRouteAssetPerformanceMetrics(routeAssets);
  const buildId = createBuildId({
    manifest,
    mode: options.mode,
    registry,
    routeAssets: manifestRouteAssets,
  });
  const renderManifest = buildRenderManifest({
    config,
    registry,
    buildId,
    manifestPath,
    mode: options.mode,
    rootDir: options.rootDir,
    routeAssets: manifestRouteAssets,
  });
  const renderManifestPath = path.join(config.outDir, "render-manifest.json");
  const messagesManifest = buildMessagesManifest({
    config,
    registry,
    buildId,
  });
  const messagesManifestPath = path.join(
    config.outDir,
    "messages-manifest.json",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    renderManifestPath,
    `${JSON.stringify(renderManifest, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    messagesManifestPath,
    `${JSON.stringify(messagesManifest, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    path.join(config.outDir, "index.html"),
    await renderIndexHtml(config, manifest),
    "utf-8",
  );
  const mediaArtifacts = await writeFrontendMediaArtifacts({
    rootDir: options.rootDir,
    config,
    mode: options.mode,
  });
  const staticArtifacts = await writeStaticFrontendArtifacts({
    rootDir: options.rootDir,
    config,
    mode: options.mode,
  });
  const seoArtifacts = await writeFrontendSeoArtifacts({
    rootDir: options.rootDir,
    config,
    staticArtifacts: staticArtifacts.artifacts,
    signal: options.signal,
  });
  const deployManifest = await buildFrontendDeployManifest({
    rootDir: options.rootDir,
    config,
    mode: options.mode,
    browserManifest: manifest,
  });
  const sizeReport = await buildFrontendSizeReport({
    config,
    deployManifest,
    routes: routeAssets.routes,
  });
  assertFrontendBudgets(config, sizeReport);
  if (config.build.diagnostics.sizeReport) {
    const persistedSizeReport = config.build.diagnostics.performanceReport
      ? sizeReport
      : stripSizeReportRouteMetrics(sizeReport);
    await writeFile(
      path.join(config.outDir, "size-report.json"),
      `${JSON.stringify(persistedSizeReport, null, 2)}\n`,
      "utf-8",
    );
  }
  const deployManifestPath = path.join(config.outDir, "deploy-manifest.json");
  await writeFile(
    deployManifestPath,
    `${JSON.stringify(deployManifest, null, 2)}\n`,
    "utf-8",
  );

  return {
    skipped: false,
    config,
    manifestPath,
    deployManifestPath,
    renderManifestPath,
    messagesManifestPath,
    serverRendererPath: config.build.server.outFile,
    generatedDir: registry.generatedDir,
    contractPath: contract?.contractPath,
    modulePath: contract?.modulePath,
    staticManifestPath: staticArtifacts.manifestPath,
    mediaManifestPath: mediaArtifacts.manifestPath,
    seoArtifactPaths: seoArtifacts.artifacts.map((artifact) => artifact.file),
    routeCount: contract?.routeCount,
    warnings: [
      ...buildResult.warnings.map((item) => item.text),
      ...serverBuildResult.warnings.map((item) => item.text),
      ...registry.warnings,
      ...(contract?.warnings ?? []),
    ],
  };
}

function createAssetInlineLimitPlugin(
  config: ResolvedVextFrontendConfig,
): esbuild.Plugin | undefined {
  if (config.build.assets.inlineLimit <= 0) return undefined;
  return {
    name: "vext-asset-inline-limit",
    setup(build) {
      build.onLoad(
        {
          filter: /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/,
        },
        async (args) => {
          const content = await readFile(args.path);
          if (content.byteLength > config.build.assets.inlineLimit) {
            return undefined;
          }
          return {
            contents: content,
            loader: "dataurl",
          };
        },
      );
    },
  };
}

function createCssModulesPlugin(
  config: ResolvedVextFrontendConfig,
): esbuild.Plugin | undefined {
  if (!config.build.css.modules) return undefined;
  return {
    name: "vext-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, async (args) => ({
        contents: await readFile(args.path, "utf-8"),
        loader: "local-css",
      }));
    },
  };
}

function createReactRefreshRegistrationPlugin(
  config: ResolvedVextFrontendConfig,
  rootDir: string,
  mode: VextFrontendMode,
): esbuild.Plugin | undefined {
  if (
    mode !== "development" ||
    config.framework !== "react" ||
    !config.dev.hot ||
    !config.dev.fastRefresh
  ) {
    return undefined;
  }

  return {
    name: "vext-react-refresh-register",
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
        if (!isPathInside(args.path, config.root)) {
          return undefined;
        }

        const source = await readFile(args.path, "utf-8");
        const registrations = collectRefreshRegistrations(
          source,
          args.path,
          rootDir,
        );
        if (registrations.length === 0) {
          return undefined;
        }

        const loader = args.path.endsWith(".tsx") ? "tsx" : "jsx";
        return {
          loader,
          contents:
            'import * as __VEXT_REFRESH_RUNTIME__ from "react-refresh/runtime";\n' +
            source +
            "\n" +
            renderRefreshRegistrations(registrations),
        };
      });
    },
  };
}

function collectRefreshRegistrations(
  source: string,
  filePath: string,
  rootDir: string,
): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+default\s+function\s+([A-Z][A-Za-z0-9_$]*)/gu,
    /export\s+default\s+class\s+([A-Z][A-Za-z0-9_$]*)/gu,
    /export\s+function\s+([A-Z][A-Za-z0-9_$]*)/gu,
    /export\s+class\s+([A-Z][A-Za-z0-9_$]*)/gu,
    /export\s+const\s+([A-Z][A-Za-z0-9_$]*)\s*=/gu,
    /export\s+default\s+([A-Z][A-Za-z0-9_$]*)\s*;?/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }

  const moduleId = toProjectRelativePath(rootDir, filePath);
  return [...names].map((name) => `${moduleId} ${name}:${name}`);
}

function renderRefreshRegistrations(registrations: string[]): string {
  const lines = registrations.map((entry) => {
    const [id, name] = entry.split(":");
    return `  __vextRefreshRegister(${name}, ${JSON.stringify(id)});`;
  });
  return `if (typeof window !== "undefined") {
  const __vextRefreshRegister =
    globalThis.$RefreshReg$ ??
    ((type, id) => __VEXT_REFRESH_RUNTIME__.register(type, id));
${lines.join("\n")}
}`;
}

function buildManifest(
  config: ResolvedVextFrontendConfig,
  metafile: esbuild.Metafile | undefined,
  mode: VextFrontendMode,
): VextFrontendManifest {
  const outputs = Object.entries(metafile?.outputs ?? {});
  const assets: VextFrontendManifestAsset[] = outputs
    .filter(([filePath]) => !filePath.endsWith(".map"))
    .map(([filePath, output]) => {
      const relativePath = toPublicAssetPath(config, filePath);
      const entryPoint = output.entryPoint
        ? toProjectRelativePath(config.outDir, path.resolve(filePath))
        : undefined;
      return {
        path: relativePath,
        bytes: output.bytes,
        entry: Boolean(output.entryPoint),
        entryPoint,
        source: "bundle" as const,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    schemaVersion: 1,
    kind: "frontend-manifest",
    generatedAt: STABLE_FRONTEND_GENERATED_AT,
    mode,
    publicPath: getAssetBase(config),
    indexHtml: joinPublicPath(config.publicPath, "index.html"),
    entrypoints: assets
      .filter((asset) => asset.entry)
      .sort((a, b) => {
        const aMain = isBrowserEntrypoint(config, a);
        const bMain = isBrowserEntrypoint(config, b);
        if (aMain !== bMain) return aMain ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
      .map((asset) => asset.path),
    assets,
  };
}

async function attachManifestAssetMetadata(
  config: ResolvedVextFrontendConfig,
  manifest: VextFrontendManifest,
): Promise<VextFrontendManifest> {
  const assets = await Promise.all(
    manifest.assets.map(async (asset) => {
      const filePath = publicAssetPathToFile(config, asset.path);
      const content = await readFile(filePath);
      return {
        ...asset,
        sha256: createSha256(content),
        integrity: createSriSha256(content),
        contentType: getFrontendContentType(filePath),
      };
    }),
  );
  return { ...manifest, assets };
}

function buildRenderManifest(input: {
  config: ResolvedVextFrontendConfig;
  registry: FrontendRenderRegistryResult;
  buildId: string;
  manifestPath: string;
  mode: VextFrontendMode;
  routeAssets: VextFrontendRouteAssetsManifest;
  rootDir: string;
}): VextFrontendRenderManifest {
  return {
    schemaVersion: 1,
    kind: "frontend-render-manifest",
    buildId: input.buildId,
    generatedAt: STABLE_FRONTEND_GENERATED_AT,
    mode: input.mode,
    framework: input.config.framework,
    root: toProjectRelativePath(input.rootDir, input.config.root),
    publicPath: input.config.publicPath,
    assetBaseUrl: input.config.deploy.assetBaseUrl,
    indexHtml: "index.html",
    browserManifest: toProjectRelativePath(
      input.config.outDir,
      input.manifestPath,
    ),
    serverRenderer: toProjectRelativePath(
      input.config.outDir,
      input.config.build.server.outFile,
    ),
    pages: input.registry.pages,
    layouts: input.registry.layouts,
    errorPages: input.registry.errorPages,
    i18n: {
      enabled: input.config.i18n.enabled,
      defaultLocale: input.config.i18n.defaultLocale,
      locales: input.registry.locales,
    },
    diagnostics: {
      metafile: input.config.build.diagnostics.metafile,
      sizeReport: input.config.build.diagnostics.sizeReport,
      performanceReport: input.config.build.diagnostics.performanceReport,
      leakScan: input.config.build.diagnostics.leakScan,
    },
    routeAssets: input.routeAssets,
  };
}

function buildMessagesManifest(input: {
  config: ResolvedVextFrontendConfig;
  registry: FrontendRenderRegistryResult;
  buildId: string;
}): VextFrontendMessagesManifest {
  return {
    schemaVersion: 1,
    kind: "frontend-messages-manifest",
    buildId: input.buildId,
    generatedAt: STABLE_FRONTEND_GENERATED_AT,
    defaultLocale: input.config.i18n.defaultLocale,
    locales: input.registry.locales,
  };
}

function stripRouteAssetPerformanceMetrics(
  routeAssets: VextFrontendRouteAssetsManifest,
): VextFrontendRouteAssetsManifest {
  return {
    schemaVersion: routeAssets.schemaVersion,
    routes: routeAssets.routes.map(
      ({
        initialJsBytes: _initialJsBytes,
        initialJsGzipBytes: _initialJsGzipBytes,
        initialJsBrotliBytes: _initialJsBrotliBytes,
        appOwnedInitialJsBrotliBytes: _appOwnedInitialJsBrotliBytes,
        ...route
      }) => route,
    ),
  };
}

function stripSizeReportRouteMetrics(
  report: Awaited<ReturnType<typeof buildFrontendSizeReport>>,
): Awaited<ReturnType<typeof buildFrontendSizeReport>> {
  const { routes: _routes, ...sanitizedReport } = report;
  return sanitizedReport;
}

function toPublicAssetPath(
  config: ResolvedVextFrontendConfig,
  filePath: string,
): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(config.outDir, absolute).replace(/\\/g, "/");
  return joinPublicPath(getAssetBase(config), relative);
}

function publicAssetPathToFile(
  config: ResolvedVextFrontendConfig,
  assetPath: string,
): string {
  const base = getAssetBase(config);
  if (!assetPath.startsWith(base)) {
    throw new Error(
      `[vextjs] frontend asset path is outside public base: ${assetPath}`,
    );
  }
  return path.join(config.outDir, assetPath.slice(base.length));
}

function isBrowserEntrypoint(
  config: ResolvedVextFrontendConfig,
  asset: VextFrontendManifestAsset,
): boolean {
  const prefix = joinPublicPath(
    getAssetBase(config),
    `${config.build.client.assetsDir}/browser-entry`,
  );
  return asset.path.startsWith(prefix);
}

function joinPublicPath(publicPath: string, relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, "");
  return `${publicPath}${trimmed}`;
}

function getAssetBase(config: ResolvedVextFrontendConfig): string {
  return config.deploy.assetBaseUrl ?? config.publicPath;
}

function resolveFrontendNodePaths(rootDir: string): string[] {
  return [
    path.join(rootDir, "node_modules"),
    path.resolve("node_modules"),
  ].filter(
    (dir, index, dirs) => dirs.indexOf(dir) === index && existsSync(dir),
  );
}

function toProjectRelativePath(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, "/");
}

function isPathInside(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function createBuildId(input: {
  manifest: VextFrontendManifest;
  mode: VextFrontendMode;
  registry: FrontendRenderRegistryResult;
  routeAssets: VextFrontendRouteAssetsManifest;
}): string {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        manifest: input.manifest,
        mode: input.mode,
        pages: input.registry.pages,
        layouts: input.registry.layouts,
        errorPages: input.registry.errorPages,
        locales: input.registry.locales,
        routeAssets: input.routeAssets,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `vext-${digest}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

async function renderIndexHtml(
  config: ResolvedVextFrontendConfig,
  manifest: VextFrontendManifest,
): Promise<string> {
  const entryScript = manifest.entrypoints[0];
  const entryAsset = manifest.assets.find(
    (asset) => asset.path === entryScript,
  );
  const entryAttrs = entryAsset ? renderAssetAttrs(config, entryAsset) : "";
  const externalRuntimeTags = renderExternalRuntimeTags(config);
  const scriptTag = entryScript
    ? `<script type="module" src="${entryScript}"${entryAttrs} data-vext-entry></script>`
    : "";
  const rootTag = '<div id="root" data-vext-root></div>';
  const dataTag =
    '<script type="application/json" id="__VEXT_DATA__" data-vext-data>{}</script>';
  const styleTags = manifest.assets
    .filter((asset) => asset.path.endsWith(".css"))
    .map(
      (asset) =>
        `<link rel="stylesheet" href="${asset.path}"${renderAssetAttrs(
          config,
          asset,
        )} data-vext-style>`,
    )
    .join("\n");
  const template = existsSync(config.indexHtml)
    ? await readFile(config.indexHtml, "utf-8")
    : '<!doctype html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Vext</title>{vext.styles}</head>\n<body>{vext.root}{vext.data}{vext.entry}</body>\n</html>\n';

  let output = template;
  let stylesInjected = false;
  if (output.includes("{vext.styles}")) {
    output = output.replaceAll("{vext.styles}", styleTags);
    stylesInjected = true;
  } else if (styleTags && output.includes("</head>")) {
    output = output.replace("</head>", `  ${styleTags}\n</head>`);
    stylesInjected = true;
  }
  if (
    externalRuntimeTags &&
    !output.includes("{vext.head}") &&
    output.includes("</head>")
  ) {
    output = output.replace("</head>", `  ${externalRuntimeTags}\n</head>`);
  }

  output = renderDocumentLangPlaceholder(output, config)
    .replaceAll("{vext.head}", externalRuntimeTags)
    .replaceAll("{vext.root}", rootTag)
    .replaceAll("{vext.data}", dataTag);

  if (output.includes("{vext.entry}")) {
    return output.replaceAll("{vext.entry}", scriptTag);
  }
  if (output.includes("</body>")) {
    const bodyAssets = [stylesInjected ? "" : styleTags, scriptTag]
      .filter(Boolean)
      .join("\n");
    return output.replace("</body>", `  ${bodyAssets}\n</body>`);
  }
  return `${output}\n${[styleTags, scriptTag].filter(Boolean).join("\n")}\n`;
}

function renderDocumentLangPlaceholder(
  template: string,
  config: ResolvedVextFrontendConfig,
): string {
  const htmlLangAttribute = /<html\b([^>]*?)\slang=(["'])[^"']*\2([^>]*)>/iu;
  const htmlWithoutLang = /<html\b((?:(?!\slang=)[^>])*)>/iu;
  const tokenLangAttribute = /\s+lang=(["'])\{vext\.lang\}\1/giu;
  if (!config.i18n.htmlLang) {
    return template
      .replace(tokenLangAttribute, "")
      .replaceAll("{vext.lang}", "");
  }

  const lang =
    config.i18n.defaultLocale === "inherit" ? "" : config.i18n.defaultLocale;
  const langAttribute = escapeAttribute(lang);
  return template
    .replace(
      htmlLangAttribute,
      `<html$1 lang="${langAttribute}" data-vext-lang$3>`,
    )
    .replace(htmlWithoutLang, `<html lang="${langAttribute}" data-vext-lang$1>`)
    .replace(tokenLangAttribute, ` lang="${langAttribute}" data-vext-lang`)
    .replaceAll("{vext.lang}", langAttribute);
}

function renderAssetAttrs(
  config: ResolvedVextFrontendConfig,
  asset: VextFrontendManifestAsset,
): string {
  const attrs: string[] = [];
  if (config.deploy.crossOrigin) {
    attrs.push(`crossorigin="${config.deploy.crossOrigin}"`);
  }
  if (config.deploy.integrity && asset.integrity) {
    attrs.push(`integrity="${asset.integrity}"`);
  }
  return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function renderExternalRuntimeTags(config: ResolvedVextFrontendConfig): string {
  const entries = Object.entries(config.build.client.externalRuntime);
  if (entries.length === 0) return "";
  const importMap = {
    imports: Object.fromEntries(
      entries.map(([specifier, runtime]) => [specifier, runtime.url]),
    ),
  };
  const preloadTags = entries
    .map(([, runtime]) => {
      const attrs = [
        'rel="modulepreload"',
        `href="${runtime.url}"`,
        runtime.crossOrigin || config.deploy.crossOrigin
          ? `crossorigin="${runtime.crossOrigin ?? config.deploy.crossOrigin}"`
          : undefined,
        runtime.integrity ? `integrity="${runtime.integrity}"` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      return `<link ${attrs} data-vext-external-runtime>`;
    })
    .join("\n");
  return [
    `<script type="importmap" data-vext-external-runtime>${JSON.stringify(importMap)}</script>`,
    preloadTags,
  ]
    .filter(Boolean)
    .join("\n");
}

function assertBrowserExternalRuntimeMappings(
  config: ResolvedVextFrontendConfig,
): void {
  const reactRuntimeSpecifiers = new Set([
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
  ]);
  const missing = config.build.client.external.filter(
    (specifier) =>
      reactRuntimeSpecifiers.has(specifier) &&
      !config.build.client.externalRuntime[specifier],
  );
  if (missing.length === 0) return;
  throw new Error(
    [
      "[vextjs] frontend browser external runtime mapping is incomplete.",
      `Externalized modules: ${missing.join(", ")}`,
      "Browser external modules are not bundled; Vext must write import map URLs for them.",
      "Add mappings under config.frontend.build.client.externalRuntime, for example:",
      '  externalRuntime: { react: "https://cdn.example.com/react.mjs" }',
    ].join("\n"),
  );
}

const FRONTEND_RESOLVE_EXTENSIONS = [
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".css",
  ".json",
];

async function assertRegistrySourcesHaveNoServerLeaks(
  config: ResolvedVextFrontendConfig,
  rootDir: string,
  registry: FrontendRenderRegistryResult,
): Promise<void> {
  const entries = [
    ...registry.pages,
    ...registry.layouts,
    ...registry.errorPages,
  ];
  for (const entry of entries) {
    const sourcePath = path.resolve(rootDir, entry.file);
    const source = await readFile(sourcePath, "utf-8");
    for (const importPath of findImportSpecifiers(source)) {
      const candidate = resolveImportCandidate(config, importPath, sourcePath);
      if (!candidate) continue;
      const leak = classifyBrowserBoundaryLeak(candidate, rootDir);
      if (leak) {
        throw new Error(formatBoundaryLeakError(leak, rootDir, sourcePath));
      }
    }
  }
}

function findImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s*(?:[^'"]*?\s+from\s*)?["']([^"']+)["']/gu,
    /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /require\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveImportCandidate(
  config: ResolvedVextFrontendConfig,
  importPath: string,
  importer: string,
): string | undefined {
  if (importPath.startsWith("node:")) return importPath;
  const runtimeTarget = resolveVextFrontendRuntimeImport(config, importPath);
  if (runtimeTarget) return runtimeTarget;
  const aliasTarget = resolveAliasImport(config, importPath);
  if (aliasTarget) return aliasTarget;
  if (importPath.startsWith(".") || path.isAbsolute(importPath)) {
    return path.isAbsolute(importPath)
      ? importPath
      : path.resolve(path.dirname(importer), importPath);
  }
  return undefined;
}

function createFrontendResolverPlugin(
  config: ResolvedVextFrontendConfig,
  rootDir: string,
): esbuild.Plugin {
  return {
    name: "vext-frontend-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const runtimeTarget = resolveVextFrontendRuntimeImport(
          config,
          args.path,
        );
        if (runtimeTarget) {
          return { path: runtimeTarget };
        }

        if (args.path.startsWith("node:")) {
          if (config.build.diagnostics.leakScan) {
            return {
              errors: [
                {
                  text: formatBoundaryLeakError(
                    {
                      filePath: args.path,
                      reason: "Node.js builtin module",
                    },
                    rootDir,
                    args.importer,
                  ),
                },
              ],
            };
          }
          return undefined;
        }

        const aliasTarget = resolveAliasImport(config, args.path);
        if (aliasTarget) {
          const leak = classifyBrowserBoundaryLeak(aliasTarget, rootDir);
          if (leak && config.build.diagnostics.leakScan) {
            return {
              errors: [
                {
                  text: formatBoundaryLeakError(leak, rootDir, args.importer),
                },
              ],
            };
          }
          return { path: resolveExistingModulePath(aliasTarget) };
        }

        if (
          args.path.startsWith(".") ||
          path.isAbsolute(args.path) ||
          args.path.includes("\\")
        ) {
          const candidate = path.isAbsolute(args.path)
            ? args.path
            : path.resolve(args.resolveDir, args.path);
          const leak = classifyBrowserBoundaryLeak(candidate, rootDir);
          if (leak && config.build.diagnostics.leakScan) {
            return {
              errors: [
                {
                  text: formatBoundaryLeakError(leak, rootDir, args.importer),
                },
              ],
            };
          }
        }

        return undefined;
      });
    },
  };
}

function createFrontendServerResolverPlugin(
  config: ResolvedVextFrontendConfig,
): esbuild.Plugin {
  return {
    name: "vext-frontend-server-resolver",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const runtimeTarget = resolveVextFrontendRuntimeImport(
          config,
          args.path,
        );
        if (runtimeTarget) {
          return { path: runtimeTarget };
        }
        const aliasTarget = resolveAliasImport(config, args.path);
        if (aliasTarget) {
          return { path: resolveExistingModulePath(aliasTarget) };
        }
        return undefined;
      });
    },
  };
}

function resolveVextFrontendRuntimeImport(
  config: ResolvedVextFrontendConfig,
  importPath: string,
): string | undefined {
  if (importPath === "vextjs/frontend/navigation-runtime") {
    return resolveVextNavigationRuntimeModule();
  }
  if (importPath === "vextjs/frontend/media-runtime") {
    return resolveVextMediaRuntimeModule();
  }
  if (importPath === "vextjs/frontend") {
    return path.join(path.dirname(config.entry), "vext-runtime.tsx");
  }
  if (importPath === "vextjs/style") {
    return resolveVextStyleModule();
  }
  return undefined;
}

function resolveVextNavigationRuntimeModule(): string {
  const sourcePath = fileURLToPath(
    new URL("../runtime/navigation.ts", import.meta.url),
  );
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL("../runtime/navigation.js", import.meta.url));
}

function resolveVextMediaRuntimeModule(): string {
  const sourcePath = fileURLToPath(
    new URL("../media/index.ts", import.meta.url),
  );
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL("../media/index.js", import.meta.url));
}

function resolveVextStyleModule(): string {
  const sourcePath = fileURLToPath(
    new URL("../style/index.ts", import.meta.url),
  );
  if (existsSync(sourcePath)) return sourcePath;
  return fileURLToPath(new URL("../style/index.js", import.meta.url));
}

function resolveAliasImport(
  config: ResolvedVextFrontendConfig,
  importPath: string,
): string | undefined {
  for (const [alias, target] of Object.entries(config.alias)) {
    if (importPath === alias) return target;
    if (importPath.startsWith(`${alias}/`)) {
      return path.join(target, importPath.slice(alias.length + 1));
    }
  }
  return undefined;
}

function resolveExistingModulePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  for (const extension of FRONTEND_RESOLVE_EXTENSIONS) {
    const candidate = `${filePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of FRONTEND_RESOLVE_EXTENSIONS) {
    const candidate = path.join(filePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return filePath;
}

function assertBrowserMetafileHasNoServerLeaks(
  config: ResolvedVextFrontendConfig,
  rootDir: string,
  metafile: esbuild.Metafile | undefined,
): void {
  if (!metafile || !config.build.diagnostics.leakScan) return;
  for (const inputPath of Object.keys(metafile.inputs)) {
    const leak = classifyBrowserBoundaryLeak(path.resolve(inputPath), rootDir);
    if (leak) {
      throw new Error(formatBoundaryLeakError(leak, rootDir));
    }
  }
}

function classifyBrowserBoundaryLeak(
  filePath: string,
  rootDir: string,
): { filePath: string; reason: string } | undefined {
  if (filePath.startsWith("node:")) {
    return { filePath, reason: "Node.js builtin module" };
  }

  const normalized = toProjectRelativePath(rootDir, path.resolve(filePath));
  const serverDirectories = ["src/routes", "src/services", "src/config"];
  const directory = serverDirectories.find(
    (candidate) =>
      normalized === candidate || normalized.startsWith(`${candidate}/`),
  );
  if (directory) {
    return {
      filePath,
      reason: `server-only directory ${directory}/**`,
    };
  }

  if (/(^|\/)[^/]+\.server\.[cm]?[jt]sx?$/u.test(normalized)) {
    return {
      filePath,
      reason: "server-only *.server.* module",
    };
  }

  return undefined;
}

function formatBoundaryLeakError(
  leak: { filePath: string; reason: string },
  rootDir: string,
  importer?: string,
): string {
  const fileLabel = leak.filePath.startsWith("node:")
    ? leak.filePath
    : toProjectRelativePath(rootDir, path.resolve(leak.filePath));
  const importerLabel = importer
    ? `\nImporter: ${toProjectRelativePath(rootDir, path.resolve(importer))}`
    : "";
  return [
    `[vextjs] Frontend boundary leak: browser bundle imported "${fileLabel}" (${leak.reason}).`,
    "你跨越了前后端物理边界：浏览器入口、页面和公共组件不能直接 import src/routes/**、src/services/**、src/config/**、node:* 或 *.server.*。",
    "请把服务端数据读取放到 route handler / service 调用链中，再通过 res.render(page, props, options) 传给页面。",
    importerLabel,
  ]
    .filter(Boolean)
    .join("\n");
}
