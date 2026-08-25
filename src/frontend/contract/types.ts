import type { VextJsonValue } from "../../types/errors.js";

export type VextFrontendFramework = "react" | (string & {});

export type {
  VextPageEnvelopeCacheV1,
  VextPageEnvelopeErrorResultV1,
  VextPageEnvelopePageResultV1,
  VextPageEnvelopeRedirectResultV1,
  VextPageEnvelopeResultV1,
  VextPageEnvelopeV1,
} from "./page-envelope.js";

export type VextFrontendMode = "development" | "production";

export interface VextFrontendPagesConfig {
  dir?: string;
  extensions?: string[];
  document?: string;
  errorDir?: string;
}

export interface VextFrontendSpaFallbackScope {
  basePath: string;
  page: string;
  ssr?: boolean;
  exclude?: string[];
  status?: number;
}

export interface VextFrontendSpaFallbackConfig {
  enabled?: boolean;
  exclude?: string[];
  scopes?: VextFrontendSpaFallbackScope[];
}

export interface VextFrontendJscssConfig {
  enabled?: boolean;
  files?: string[];
  runtimeAdapter?: "css-variables" | "none" | false;
  dynamicVars?: boolean;
  recipes?: boolean;
}

export interface VextFrontendStylesConfig {
  entry?: string;
  jscss?: boolean | VextFrontendJscssConfig;
}

export interface VextFrontendBuildTargetConfig {
  assetsDir?: string;
  target?: string | string[];
  minify?: boolean;
  sourcemap?: boolean;
  splitting?: boolean;
  entryNames?: string;
  chunkNames?: string;
  assetNames?: string;
  external?: string[];
  externalRuntime?: Record<string, string | VextFrontendExternalRuntimeEntry>;
}

export interface VextFrontendServerBuildTargetConfig {
  outFile?: string;
  target?: string | string[];
  minify?: boolean;
  sourcemap?: boolean;
  external?: string[];
}

export interface VextFrontendExternalRuntimeEntry {
  url: string;
  integrity?: string;
  crossOrigin?: "anonymous" | "use-credentials";
}

export interface VextFrontendVendorChunksConfig {
  enabled?: boolean;
  packages?: string[];
  entryName?: string;
}

export interface VextFrontendBuildBudgetsConfig {
  maxAssetBytes?: number;
  maxInitialJsBytes?: number;
  maxInitialJsGzipBytes?: number;
  maxInitialJsBrotliBytes?: number;
  maxRouteInitialJsBrotliBytes?: number;
  maxAppOwnedInitialJsBrotliBytes?: number;
  maxTotalBytes?: number;
  warnOnly?: boolean;
}

export interface VextFrontendBuildConfig {
  /**
   * Browser build shorthand. The client section can override these defaults;
   * the SSR renderer keeps its own Node-oriented target and diagnostics.
   */
  minify?: boolean;
  sourcemap?: boolean;
  target?: string | string[];
  client?: VextFrontendBuildTargetConfig;
  server?: VextFrontendServerBuildTargetConfig;
  vendorChunks?: boolean | VextFrontendVendorChunksConfig;
  budgets?: VextFrontendBuildBudgetsConfig;
  assets?: {
    inlineLimit?: number;
  };
  css?: {
    modules?: boolean;
  };
  diagnostics?: {
    metafile?: boolean;
    sizeReport?: boolean;
    performanceReport?: boolean;
    leakScan?: boolean;
  };
}

export type VextFrontendImageFormat = "original" | "webp" | "avif";

export interface VextFrontendMediaImagesConfig {
  /** Width candidates used for local responsive image variants. */
  widths?: number[];
  /** `original` preserves the source codec; modern variants remain local. */
  formats?: VextFrontendImageFormat[];
  quality?: number;
  /** Refuse decoder work for unexpectedly large local image inputs. */
  maxInputPixels?: number;
  /** Refuse an image definition that would emit too many local variants. */
  maxVariants?: number;
}

export interface VextFrontendMediaFontsConfig {
  /** Upper bound for one generated local WOFF2 subset. */
  maxBytes?: number;
}

export interface VextFrontendMediaConfig {
  /** Upper bound for the complete generated local image and font closure. */
  maxBytes?: number;
  images?: VextFrontendMediaImagesConfig;
  fonts?: VextFrontendMediaFontsConfig;
}

export interface VextFrontendDeployConfig {
  assetBaseUrl?: string;
  crossOrigin?: "anonymous" | "use-credentials";
  integrity?: boolean;
  upload?: boolean | VextFrontendDeployUploadConfig;
}

export type VextFrontendDeployUploadAdapterName =
  | "filesystem"
  | "mock"
  | (string & {});

export interface VextFrontendDeployUploadAdapter {
  name: string;
  upload(
    input: VextFrontendDeployUploadAdapterInput,
  ): Promise<VextFrontendDeployUploadAdapterResult>;
}

export interface VextFrontendDeployUploadAdapterInput {
  asset: VextFrontendDeployManifestAsset;
  sourcePath: string;
  uploadKey: string;
  dryRun: boolean;
}

export interface VextFrontendDeployUploadAdapterResult {
  uploaded: boolean;
  url?: string;
  etag?: string;
}

export interface VextFrontendDeployUploadConfig {
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

export interface VextFrontendRenderConfig {
  ssr?: boolean;
  /**
   * Transport preference only. Existing applications remain buffered until
   * they opt in; the streaming implementation arrives in the next phase.
   */
  streaming?: "auto" | "buffered";
  fallback?: "client" | "error";
  timeoutMs?: number;
  layout?: boolean;
}

export interface VextFrontendErrorPagesConfig {
  default?: string;
  status?: Record<string | number, string>;
}

export type VextFrontendI18nClientLoad = "current" | "all";

export interface VextFrontendI18nConfig {
  enabled?: boolean;
  source?: string;
  defaultLocale?: "inherit" | string;
  detect?: string[];
  inject?: "used" | "all";
  clientLoad?: VextFrontendI18nClientLoad;
  clientSwitch?: "reload";
  htmlLang?: boolean;
  vary?: boolean;
}

export interface VextFrontendDevConfig {
  hot?: boolean;
  fastRefresh?: boolean;
  transport?: "sse";
  overlay?: boolean;
  debounceMs?: number;
  renderRefresh?: "prompt" | "auto" | "off";
}

export interface VextFrontendApiClientConfig {
  enabled?: boolean;
}

export type VextSeoRobotsDirective = string | readonly string[];

export interface VextSeoImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  type?: string;
}

export interface VextOpenGraphMetadata {
  title?: string;
  description?: string;
  type?: string;
  url?: string;
  siteName?: string;
  locale?: string;
  images?: readonly (string | VextSeoImage)[];
}

export interface VextTwitterMetadata {
  card?: "summary" | "summary_large_image" | "app" | "player";
  site?: string;
  creator?: string;
  title?: string;
  description?: string;
  images?: readonly string[];
}

export interface VextSeoAlternate {
  hrefLang: string;
  href: string;
}

export interface VextSeoMetadata {
  title?: string;
  description?: string;
  robots?: VextSeoRobotsDirective;
  /** Absolute site pathname. The configured public origin is added later. */
  canonical?: string;
  openGraph?: VextOpenGraphMetadata;
  twitter?: VextTwitterMetadata;
  alternates?: readonly VextSeoAlternate[];
  jsonLd?: VextJsonValue | readonly VextJsonValue[];
}

export interface VextRouteFrontendSeoOptions extends VextSeoMetadata {
  /** Selects one of the finite origins declared by frontend.seo.origins. */
  originKey?: string;
  /** Set false to exclude a materialized page from generated sitemaps. */
  index?: boolean;
}

export interface VextRenderSeoOptions extends VextSeoMetadata {
  originKey?: string;
}

export interface VextSitemapEntry {
  originKey?: string;
  pathname: string;
  lastmod?: string | Date;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
}

export interface VextSitemapEntriesContext {
  readonly mode: "build" | "runtime";
  readonly origin: string;
  readonly originKey?: string;
  readonly signal: AbortSignal;
}

export type VextSitemapEntriesProvider = (
  context: VextSitemapEntriesContext,
) => readonly VextSitemapEntry[] | PromiseLike<readonly VextSitemapEntry[]>;

export interface VextFrontendSitemapConfig {
  mode?: "build" | "runtime";
  path?: string;
  includeStatic?: boolean;
  entries?: VextSitemapEntriesProvider;
  maxUrlsPerFile?: number;
  /** Maximum URLs accepted across the complete sitemap set. */
  maxUrls?: number;
  /** Maximum UTF-8 bytes across the rendered sitemap documents. */
  maxBytes?: number;
  /** Runtime provider/read/render deadline in milliseconds. */
  timeoutMs?: number;
}

export interface VextRobotsGroup {
  userAgent: string | readonly string[];
  allow?: string | readonly string[];
  disallow?: string | readonly string[];
  crawlDelay?: number;
}

export interface VextFrontendRobotsConfig {
  mode?: "build" | "runtime";
  path?: "/robots.txt";
  groups?: readonly VextRobotsGroup[];
}

export interface VextFrontendSeoConfig {
  enabled?: boolean;
  publicOrigin?: string;
  origins?: Readonly<Record<string, string>>;
  titleTemplate?: string;
  defaults?: VextSeoMetadata;
  sitemap?: false | VextFrontendSitemapConfig;
  robots?: false | VextFrontendRobotsConfig;
}

export interface ResolvedVextFrontendSeoConfig {
  /** Distinguishes omission from an explicit enabled:false override. */
  configured: boolean;
  enabled: boolean;
  publicOrigin?: string;
  origins: Readonly<Record<string, string>>;
  titleTemplate?: string;
  defaults: VextSeoMetadata;
  sitemap:
    | false
    | {
        mode: "build" | "runtime";
        path: string;
        includeStatic: boolean;
        entries?: VextSitemapEntriesProvider;
        maxUrlsPerFile: number;
        maxUrls: number;
        maxBytes: number;
        timeoutMs: number;
      };
  robots:
    | false
    | {
        mode: "build" | "runtime";
        path: "/robots.txt";
        groups: readonly VextRobotsGroup[];
      };
}

export interface VextFrontendConfig {
  enabled?: boolean;
  framework?: VextFrontendFramework;
  root?: string;
  pages?: VextFrontendPagesConfig;
  componentsDir?: string;
  styles?: VextFrontendStylesConfig;
  assetsDir?: string;
  media?: VextFrontendMediaConfig;
  entry?: string;
  indexHtml?: string;
  outDir?: string;
  publicDir?: string;
  publicPath?: string;
  alias?: Record<string, string>;
  spaFallback?: boolean | VextFrontendSpaFallbackConfig;
  apiClient?: boolean | VextFrontendApiClientConfig;
  build?: VextFrontendBuildConfig;
  deploy?: VextFrontendDeployConfig;
  render?: VextFrontendRenderConfig;
  errorPages?: VextFrontendErrorPagesConfig;
  seo?: VextFrontendSeoConfig;
  i18n?: VextFrontendI18nConfig;
  dev?: VextFrontendDevConfig;
  adapter?: VextFrontendAdapter;
}

export type VextFrontendUserConfig = boolean | VextFrontendConfig;

export interface ResolvedVextFrontendSpaFallbackScope {
  basePath: string;
  page: string;
  ssr: boolean;
  exclude: string[];
  status: number;
}

export interface ResolvedVextFrontendConfig {
  enabled: boolean;
  framework: VextFrontendFramework;
  root: string;
  pages: {
    dir: string;
    extensions: string[];
    document: string;
    errorDir: string;
  };
  componentsDir: string;
  styles: {
    entry: string;
    jscss: {
      enabled: boolean;
      files: string[];
      runtimeAdapter: "css-variables" | "none" | false;
      dynamicVars: boolean;
      recipes: boolean;
    };
  };
  assetsDir: string;
  media: {
    maxBytes: number;
    images: {
      widths: number[];
      formats: VextFrontendImageFormat[];
      quality: number;
      maxInputPixels: number;
      maxVariants: number;
    };
    fonts: {
      maxBytes: number;
    };
  };
  entry: string;
  indexHtml: string;
  outDir: string;
  publicDir: string;
  publicPath: string;
  alias: Record<string, string>;
  spaFallback: {
    enabled: boolean;
    exclude: string[];
    scopes: ResolvedVextFrontendSpaFallbackScope[];
  };
  apiClient: {
    enabled: boolean;
  };
  build: Omit<
    Required<VextFrontendBuildConfig>,
    | "target"
    | "client"
    | "server"
    | "vendorChunks"
    | "budgets"
    | "assets"
    | "css"
    | "diagnostics"
  > & {
    target: string[];
    client: Required<
      Omit<VextFrontendBuildTargetConfig, "target" | "externalRuntime">
    > & {
      outDir: string;
      target: string[];
      externalRuntime: Record<string, VextFrontendExternalRuntimeEntry>;
    };
    server: Required<Omit<VextFrontendServerBuildTargetConfig, "target">> & {
      target: string[];
    };
    vendorChunks: Required<VextFrontendVendorChunksConfig>;
    budgets: Required<VextFrontendBuildBudgetsConfig>;
    assets: {
      inlineLimit: number;
    };
    css: {
      modules: boolean;
    };
    diagnostics: {
      metafile: boolean;
      sizeReport: boolean;
      performanceReport: boolean;
      leakScan: boolean;
    };
  };
  deploy: {
    assetBaseUrl?: string;
    crossOrigin?: "anonymous" | "use-credentials";
    integrity: boolean;
    upload: {
      enabled: boolean;
      adapter:
        | VextFrontendDeployUploadAdapterName
        | VextFrontendDeployUploadAdapter;
      targetDir?: string;
      publicBaseUrl?: string;
      prefix: string;
      stateFile: string;
      dryRun: boolean;
      concurrency: number;
      include: string[];
      exclude: string[];
    };
  };
  render: Required<VextFrontendRenderConfig>;
  errorPages: {
    default: string;
    status: Record<string, string>;
  };
  seo: ResolvedVextFrontendSeoConfig;
  i18n: Required<VextFrontendI18nConfig>;
  dev: Required<VextFrontendDevConfig>;
  adapter?: VextFrontendAdapter;
}

export interface VextFrontendAdapter {
  name: string;
  framework: VextFrontendFramework;
  resolveBuildOptions?(
    config: ResolvedVextFrontendConfig,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type VextClientRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface VextSchemaIRV1 {
  schemaVersion: 1;
  kind: "vext-schema-ir";
  source: "validate" | "responses" | "docs.responses";
  sourcePath: string;
  schema: Record<string, unknown>;
  digest: string;
  ref?: string;
}

export interface VextRouteResponseSchemaV1 {
  status: string;
  contentType: string;
  schema?: VextSchemaIRV1;
}

export interface VextRouteSchemaContractV1 {
  schemaVersion: 1;
  request: {
    params?: VextSchemaIRV1;
    query?: VextSchemaIRV1;
    headers?: VextSchemaIRV1;
    cookies?: VextSchemaIRV1;
    body?: VextSchemaIRV1;
  };
  responses: VextRouteResponseSchemaV1[];
}

export interface VextRouteFreshnessIdentity {
  mode: "dynamic" | "static" | "revalidate";
  source: "legacy-default" | "route-options";
  /** Revalidation interval in seconds when `mode` is `revalidate`. */
  revalidate?: number;
  /** Normalized, deterministic static parameter combinations. */
  staticParams?: ReadonlyArray<Record<string, string>>;
  /** Present only when SSR body rendering is intentionally disabled. */
  clientOnly?: true;
  /** Present only for routes that intentionally omit Vext browser hydration. */
  hydration?: "none";
  /** Normalized route-level SEO declaration used by renderer/static identity. */
  seo?: VextRouteFrontendSeoOptions;
  /** Route-side persistent freshness invalidation tags. */
  tags?: readonly string[];
  /** Explicit frontend page id for static materialization. */
  page?: string;
  /** Bounded static-output budget declared on the existing route. */
  staticBudget?: {
    maxParams?: number;
    maxDurationMs?: number;
    maxBytes?: number;
  };
}

export interface VextRouteLayoutIdentity {
  state: "unresolved" | "resolved";
  paths: readonly string[];
}

export interface VextClientSchemaReference {
  type: "unknown" | "schema";
  schema?: VextSchemaIRV1;
  diagnostic?: string;
}

export interface VextClientResponseContract {
  status: string;
  contentType: string;
  schema: VextClientSchemaReference;
}

export interface VextClientRouteContract {
  /** Added in contract protocol v1; omitted by legacy generated contracts. */
  routeId?: string;
  method: VextClientRouteMethod;
  path: string;
  operationId: string;
  summary?: string | null;
  tags?: readonly string[];
  input?: {
    params?: VextClientSchemaReference;
    query?: VextClientSchemaReference;
    body?: VextClientSchemaReference;
    headers?: VextClientSchemaReference;
    cookies?: VextClientSchemaReference;
  };
  response?: VextClientSchemaReference;
  responses?: readonly VextClientResponseContract[];
  freshness?: VextRouteFreshnessIdentity;
  layout?: VextRouteLayoutIdentity;
}

export interface VextClientContract {
  schemaVersion: 1;
  kind: "client-contract";
  source: "routes-manifest";
  generatedAt: string;
  protocolVersion?: 1;
  routeManifestDigest?: string;
  digest?: string;
  routes: readonly VextClientRouteContract[];
  warnings: readonly string[];
}

export interface VextFrontendManifestAsset {
  path: string;
  bytes: number;
  entry?: boolean;
  entryPoint?: string;
  source?: "bundle" | "public" | "external";
  sha256?: string;
  integrity?: string;
  contentType?: string;
}

export interface VextFrontendManifest {
  schemaVersion: 1;
  kind: "frontend-manifest";
  generatedAt: string;
  mode: VextFrontendMode;
  publicPath: string;
  indexHtml: string;
  entrypoints: string[];
  assets: VextFrontendManifestAsset[];
}

export interface VextFrontendDeployManifestAsset {
  file: string;
  path: string;
  uploadKey: string;
  bytes: number;
  sha256: string;
  integrity: string;
  contentType: string;
  source: "bundle" | "public";
  entry?: boolean;
  immutable: boolean;
}

export interface VextFrontendDeployManifest {
  schemaVersion: 1;
  kind: "frontend-deploy-manifest";
  generatedAt: string;
  mode: VextFrontendMode;
  outDir: string;
  publicPath: string;
  assetBaseUrl?: string;
  upload: {
    enabled: boolean;
    adapter: string;
    prefix: string;
    publicBaseUrl?: string;
    stateFile: string;
    dryRun: boolean;
  };
  assets: VextFrontendDeployManifestAsset[];
}

export interface VextFrontendDeployPlanItem {
  asset: VextFrontendDeployManifestAsset;
  sourcePath: string;
  status: "upload" | "skip";
  reason: "missing-state" | "hash-changed" | "unchanged";
  previousSha256?: string;
}

export interface VextFrontendDeployPlan {
  manifestPath: string;
  outDir: string;
  items: VextFrontendDeployPlanItem[];
  summary: {
    total: number;
    upload: number;
    skip: number;
    bytes: number;
    uploadBytes: number;
  };
}

export interface VextFrontendDeployResult {
  manifestPath: string;
  stateFile: string;
  dryRun: boolean;
  uploaded: number;
  skipped: number;
  bytesUploaded: number;
  assets: Array<{
    file: string;
    uploadKey: string;
    status: "uploaded" | "skipped" | "planned";
    url?: string;
  }>;
}

export interface VextFrontendPageRegistryEntry {
  id: string;
  file: string;
  routePath: string;
}

export interface VextFrontendLayoutRegistryEntry {
  id: string;
  file: string;
  directory: string;
}

export interface VextFrontendErrorPageRegistryEntry {
  id: string;
  file: string;
  status?: number;
}

export interface VextFrontendLocaleRegistryEntry {
  locale: string;
  file: string;
}

export type VextFrontendAssetGroup =
  | "entry"
  | "shared"
  | "page"
  | "layout"
  | "locale"
  | "style"
  | "asset"
  | "external";

export interface VextFrontendSizeMetric {
  path: string;
  bytes: number;
  gzipBytes: number;
  brotliBytes: number;
  source: "bundle" | "public" | "external";
  group: VextFrontendAssetGroup;
  entry?: boolean;
  entryPoint?: string;
}

export interface VextFrontendRouteInitialAssets {
  page: string;
  routePath: string;
  layouts: string[];
  locale?: string;
  scripts: string[];
  styles: string[];
  assets: string[];
  externalScripts: string[];
  initialJsBytes?: number;
  initialJsGzipBytes?: number;
  initialJsBrotliBytes?: number;
  appOwnedInitialJsBrotliBytes?: number;
}

export interface VextFrontendRouteAssetsManifest {
  schemaVersion: 1;
  routes: VextFrontendRouteInitialAssets[];
}

export interface VextFrontendSizeReport {
  schemaVersion: 1;
  kind: "frontend-size-report";
  generatedAt: string;
  totalBytes: number;
  totalGzipBytes: number;
  totalBrotliBytes: number;
  /**
   * Largest complete first-load JS closure across generated page routes.
   * Deferred route and error-page dynamic imports are excluded.
   */
  initialJsBytes: number;
  /** Gzip size of the largest complete first-load JS closure. */
  initialJsGzipBytes: number;
  /** Brotli size of the largest complete first-load JS closure. */
  initialJsBrotliBytes: number;
  /** App-owned brotli size for that largest first-load closure. */
  appOwnedInitialJsBrotliBytes: number;
  assets: VextFrontendSizeMetric[];
  routes?: VextFrontendRouteInitialAssets[];
}

export interface VextFrontendRenderManifest {
  schemaVersion: 1;
  kind: "frontend-render-manifest";
  buildId: string;
  generatedAt: string;
  mode: VextFrontendMode;
  framework: VextFrontendFramework;
  root: string;
  publicPath: string;
  assetBaseUrl?: string;
  indexHtml: string;
  browserManifest: string;
  serverRenderer: string;
  pages: VextFrontendPageRegistryEntry[];
  layouts: VextFrontendLayoutRegistryEntry[];
  errorPages: VextFrontendErrorPageRegistryEntry[];
  i18n: {
    enabled: boolean;
    defaultLocale: string;
    locales: VextFrontendLocaleRegistryEntry[];
  };
  diagnostics: {
    metafile: boolean;
    sizeReport: boolean;
    performanceReport: boolean;
    leakScan: boolean;
  };
  routeAssets?: VextFrontendRouteAssetsManifest;
}

export interface VextFrontendStaticArtifact {
  routeId: string;
  routePath: string;
  page: string;
  params: Record<string, string>;
  html: string;
  /** Omitted for hydration:none documents. */
  data?: string;
  bytes: number;
  assets: string[];
}

export interface VextFrontendStaticManifest {
  schemaVersion: 1;
  kind: "frontend-static-manifest";
  buildId: string;
  generatedAt: string;
  artifacts: VextFrontendStaticArtifact[];
}

export interface VextFrontendMessagesManifest {
  schemaVersion: 1;
  kind: "frontend-messages-manifest";
  buildId: string;
  generatedAt: string;
  defaultLocale: string;
  locales: VextFrontendLocaleRegistryEntry[];
}
