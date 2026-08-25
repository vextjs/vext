import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ResolvedVextFrontendConfig,
  VextClientContract,
  VextFrontendStaticArtifact,
  VextRobotsGroup,
  VextSitemapEntry,
} from "../contract/types.js";
import { joinPublicUrl, normalizePathname } from "../runtime/seo.js";

export interface WriteFrontendSeoArtifactsOptions {
  rootDir: string;
  config: ResolvedVextFrontendConfig;
  staticArtifacts: readonly VextFrontendStaticArtifact[];
  signal?: AbortSignal;
}

export interface VextFrontendSeoArtifact {
  file: string;
  pathname: string;
  contentType: "application/xml; charset=utf-8" | "text/plain; charset=utf-8";
}

export interface WriteFrontendSeoArtifactsResult {
  artifacts: VextFrontendSeoArtifact[];
}

export async function writeFrontendSeoArtifacts(
  options: WriteFrontendSeoArtifactsOptions,
): Promise<WriteFrontendSeoArtifactsResult> {
  const seo = options.config.seo;
  if (!seo.enabled) return { artifacts: [] };
  const files = new Map<
    string,
    {
      pathname: string;
      content: string;
      contentType: VextFrontendSeoArtifact["contentType"];
    }
  >();

  if (seo.sitemap !== false && seo.sitemap.mode === "build") {
    if (!seo.publicOrigin) {
      throw new Error(
        "[vextjs] build-mode sitemap requires config.frontend.seo.publicOrigin; finite alternate origins must be built separately.",
      );
    }
    const entries = await collectBuildSitemapEntries(options);
    const documents = renderSitemapDocuments(
      entries,
      seo.publicOrigin,
      seo.sitemap.path,
      seo.sitemap.maxUrlsPerFile,
    );
    assertSitemapResourceLimits(
      entries,
      documents,
      seo.sitemap.maxUrls,
      seo.sitemap.maxBytes,
    );
    for (const document of documents) {
      files.set(document.pathname, {
        pathname: document.pathname,
        content: document.content,
        contentType: "application/xml; charset=utf-8",
      });
    }
  }

  if (seo.robots !== false && seo.robots.mode === "build") {
    if (!seo.publicOrigin) {
      throw new Error(
        "[vextjs] build-mode robots requires config.frontend.seo.publicOrigin.",
      );
    }
    const sitemapUrl =
      seo.sitemap !== false
        ? joinPublicUrl(seo.publicOrigin, seo.sitemap.path)
        : undefined;
    files.set(seo.robots.path, {
      pathname: seo.robots.path,
      content: renderRobotsTxt(seo.robots.groups, sitemapUrl),
      contentType: "text/plain; charset=utf-8",
    });
  }

  const planned = [...files.values()].map((file) => ({
    ...file,
    file: toOutputFile(file.pathname),
  }));
  for (const artifact of planned) {
    const target = resolveContainedOutputPath(
      options.config.outDir,
      artifact.file,
    );
    if (existsSync(target)) {
      throw new Error(
        `[vextjs] SEO output conflicts with an existing public/build file: ${artifact.pathname}`,
      );
    }
  }
  if (planned.length === 0) return { artifacts: [] };

  const stage = path.join(
    options.config.outDir,
    `.vext-seo-stage-${randomUUID()}`,
  );
  const committedTargets: string[] = [];
  try {
    for (const artifact of planned) {
      const staged = resolveContainedOutputPath(stage, artifact.file);
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, artifact.content, "utf-8");
    }
    for (const artifact of planned) {
      const target = resolveContainedOutputPath(
        options.config.outDir,
        artifact.file,
      );
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(
        resolveContainedOutputPath(stage, artifact.file),
        target,
        constants.COPYFILE_EXCL,
      );
      committedTargets.push(target);
    }
  } catch (error) {
    for (const target of committedTargets) {
      await rm(target, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  return {
    artifacts: planned.map(({ file, pathname, contentType }) => ({
      file,
      pathname,
      contentType,
    })),
  };
}

export async function collectBuildSitemapEntries(
  options: WriteFrontendSeoArtifactsOptions,
): Promise<VextSitemapEntry[]> {
  const sitemap = options.config.seo.sitemap;
  if (sitemap === false) return [];
  const contract = await readClientContract(options.config.outDir);
  const routesById = new Map(
    contract.routes.map((route) => [
      route.routeId ?? `${route.method} ${route.path}`,
      route,
    ]),
  );
  const entries: VextSitemapEntry[] = [];
  if (sitemap.includeStatic) {
    for (const artifact of options.staticArtifacts) {
      const route = routesById.get(artifact.routeId);
      const seo = route?.freshness?.seo;
      if (seo?.index === false || hasNoIndex(seo?.robots)) continue;
      entries.push({
        ...(seo?.originKey ? { originKey: seo.originKey } : {}),
        pathname: seo?.canonical ?? artifact.routePath,
      });
    }
  }
  if (sitemap.entries) {
    const abortScope = createBuildProviderAbortScope(options.signal);
    let provided: readonly VextSitemapEntry[];
    try {
      provided = await sitemap.entries({
        mode: "build",
        origin: options.config.seo.publicOrigin!,
        signal: abortScope.signal,
      });
    } finally {
      abortScope.dispose();
    }
    if (!Array.isArray(provided)) {
      throw new Error(
        "[vextjs] sitemap entries provider must return an array.",
      );
    }
    entries.push(...provided);
  }
  return validateSitemapEntries(
    entries,
    options.config.seo.publicOrigin!,
    options.config.seo.origins,
    undefined,
  );
}

export async function collectRuntimeSitemapEntries(input: {
  config: ResolvedVextFrontendConfig;
  origin: string;
  originKey?: string;
  signal: AbortSignal;
}): Promise<VextSitemapEntry[]> {
  const sitemap = input.config.seo.sitemap;
  if (sitemap === false) return [];
  const contract = await readClientContract(input.config.outDir);
  const routesById = new Map(
    contract.routes.map((route) => [
      route.routeId ?? `${route.method} ${route.path}`,
      route,
    ]),
  );
  const staticArtifacts = await readStaticArtifacts(input.config.outDir);
  const entries: VextSitemapEntry[] = [];
  if (sitemap.includeStatic) {
    for (const artifact of staticArtifacts) {
      const route = routesById.get(artifact.routeId);
      const seo = route?.freshness?.seo;
      if (seo?.index === false || hasNoIndex(seo?.robots)) continue;
      if ((seo?.originKey ?? undefined) !== input.originKey) continue;
      entries.push({
        ...(seo?.originKey ? { originKey: seo.originKey } : {}),
        pathname: seo?.canonical ?? artifact.routePath,
      });
    }
  }
  if (sitemap.entries) {
    const provided = await sitemap.entries({
      mode: "runtime",
      origin: input.origin,
      originKey: input.originKey,
      signal: input.signal,
    });
    if (!Array.isArray(provided)) {
      throw new Error(
        "[vextjs] sitemap entries provider must return an array.",
      );
    }
    entries.push(...provided);
  }
  return validateSitemapEntries(
    entries,
    input.origin,
    input.config.seo.origins,
    input.originKey,
  );
}

export function validateSitemapEntries(
  entries: readonly VextSitemapEntry[],
  origin: string,
  origins: Readonly<Record<string, string>>,
  expectedOriginKey?: string,
): VextSitemapEntry[] {
  const seen = new Set<string>();
  return entries
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`[vextjs] sitemap entry ${index} must be an object.`);
      }
      const pathname = normalizePathname(entry.pathname);
      if (entry.originKey !== undefined) {
        const declared = origins[entry.originKey];
        if (!declared) {
          throw new Error(
            `[vextjs] sitemap entry ${index} uses unknown originKey "${entry.originKey}".`,
          );
        }
        if (expectedOriginKey !== entry.originKey || declared !== origin) {
          throw new Error(
            `[vextjs] sitemap entry ${index} crosses the selected origin boundary.`,
          );
        }
      } else if (expectedOriginKey !== undefined) {
        throw new Error(
          `[vextjs] sitemap entry ${index} must declare originKey "${expectedOriginKey}".`,
        );
      }
      if (
        entry.priority !== undefined &&
        (!Number.isFinite(entry.priority) ||
          entry.priority < 0 ||
          entry.priority > 1)
      ) {
        throw new Error(
          `[vextjs] sitemap entry ${index} priority must be between 0 and 1.`,
        );
      }
      if (
        entry.changefreq !== undefined &&
        !SITEMAP_CHANGE_FREQUENCIES.has(entry.changefreq)
      ) {
        throw new Error(
          `[vextjs] sitemap entry ${index} changefreq is invalid.`,
        );
      }
      const lastmod = normalizeLastModified(entry.lastmod, index);
      const url = joinPublicUrl(origin, pathname);
      if (seen.has(url)) {
        throw new Error(`[vextjs] duplicate sitemap URL: ${url}`);
      }
      seen.add(url);
      return {
        ...(entry.originKey ? { originKey: entry.originKey } : {}),
        pathname,
        ...(lastmod ? { lastmod } : {}),
        ...(entry.changefreq ? { changefreq: entry.changefreq } : {}),
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      };
    })
    .sort((left, right) => left.pathname.localeCompare(right.pathname));
}

export function renderSitemapDocuments(
  entries: readonly VextSitemapEntry[],
  origin: string,
  sitemapPath: string,
  maxUrlsPerFile: number,
): Array<{ pathname: string; content: string }> {
  const chunks: VextSitemapEntry[][] = [];
  for (let index = 0; index < entries.length; index += maxUrlsPerFile) {
    chunks.push(entries.slice(index, index + maxUrlsPerFile));
  }
  if (chunks.length <= 1) {
    return [
      {
        pathname: sitemapPath,
        content: renderUrlSet(chunks[0] ?? [], origin),
      },
    ];
  }
  const chunkPaths = chunks.map((_, index) =>
    sitemapChunkPath(sitemapPath, index + 1),
  );
  return [
    {
      pathname: sitemapPath,
      content: renderSitemapIndex(chunkPaths, origin),
    },
    ...chunks.map((chunk, index) => ({
      pathname: chunkPaths[index]!,
      content: renderUrlSet(chunk, origin),
    })),
  ];
}

export function assertSitemapResourceLimits(
  entries: readonly VextSitemapEntry[],
  documents: ReadonlyArray<{ content: string }>,
  maxUrls: number,
  maxBytes: number,
): void {
  if (entries.length > maxUrls) {
    throw new Error(
      `[vextjs] sitemap contains ${entries.length} URLs, exceeding config.frontend.seo.sitemap.maxUrls (${maxUrls}).`,
    );
  }
  const renderedBytes = documents.reduce(
    (total, document) => total + Buffer.byteLength(document.content, "utf-8"),
    0,
  );
  if (renderedBytes > maxBytes) {
    throw new Error(
      `[vextjs] rendered sitemap documents contain ${renderedBytes} UTF-8 bytes, exceeding config.frontend.seo.sitemap.maxBytes (${maxBytes}).`,
    );
  }
}

export function renderRobotsTxt(
  groups: readonly VextRobotsGroup[],
  sitemapUrl?: string,
): string {
  const lines: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) lines.push("");
    for (const agent of toStringList(group.userAgent))
      lines.push(`User-agent: ${agent}`);
    for (const allow of toStringList(group.allow))
      lines.push(`Allow: ${allow}`);
    for (const disallow of toStringList(group.disallow))
      lines.push(`Disallow: ${disallow}`);
    if (group.crawlDelay !== undefined)
      lines.push(`Crawl-delay: ${group.crawlDelay}`);
  }
  if (sitemapUrl) lines.push("", `Sitemap: ${sitemapUrl}`);
  return `${lines.join("\n")}\n`;
}

async function readClientContract(outDir: string): Promise<VextClientContract> {
  const file = path.join(outDir, "client-contract.json");
  if (!existsSync(file)) {
    return {
      schemaVersion: 1,
      kind: "client-contract",
      source: "routes-manifest",
      generatedAt: new Date(0).toISOString(),
      routes: [],
      warnings: [],
    };
  }
  return JSON.parse(await readFile(file, "utf-8")) as VextClientContract;
}

async function readStaticArtifacts(
  outDir: string,
): Promise<VextFrontendStaticArtifact[]> {
  const file = path.join(outDir, "static-manifest.json");
  if (!existsSync(file)) return [];
  const payload = JSON.parse(await readFile(file, "utf-8")) as {
    artifacts?: VextFrontendStaticArtifact[];
  };
  return Array.isArray(payload.artifacts) ? payload.artifacts : [];
}

function renderUrlSet(
  entries: readonly VextSitemapEntry[],
  origin: string,
): string {
  const urls = entries.map((entry) => {
    const fields = [
      `<loc>${escapeXml(joinPublicUrl(origin, entry.pathname))}</loc>`,
    ];
    if (entry.lastmod)
      fields.push(`<lastmod>${escapeXml(String(entry.lastmod))}</lastmod>`);
    if (entry.changefreq)
      fields.push(`<changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined)
      fields.push(`<priority>${entry.priority}</priority>`);
    return `  <url>${fields.join("")}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

function renderSitemapIndex(
  paths: readonly string[],
  rootOrigin: string,
): string {
  const entries = paths.map(
    (pathname) =>
      `  <sitemap><loc>${escapeXml(joinPublicUrl(rootOrigin, pathname))}</loc></sitemap>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</sitemapindex>\n`;
}

function normalizeLastModified(
  value: string | Date | undefined,
  index: number,
): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`[vextjs] sitemap entry ${index} lastmod is invalid.`);
  }
  return date.toISOString();
}

function hasNoIndex(value: string | readonly string[] | undefined): boolean {
  const directives = typeof value === "string" ? [value] : (value ?? []);
  return directives.some((directive) =>
    directive
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .includes("noindex"),
  );
}

function sitemapChunkPath(base: string, index: number): string {
  const extension = path.posix.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  return `${stem}-${index}${extension || ".xml"}`;
}

function toOutputFile(pathname: string): string {
  const portable = pathname.replaceAll("\\", "/");
  if (portable.startsWith("//") || /^[A-Za-z]:/u.test(portable)) {
    return portable;
  }
  return portable.replace(/^\/+/, "");
}

const SITEMAP_CHANGE_FREQUENCIES = new Set<string>([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

function resolveContainedOutputPath(rootDir: string, file: string): string {
  // Host-native path parsing is not a security boundary: Linux otherwise
  // accepts Windows traversal separators as ordinary filename characters.
  const portable = file.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    portable.includes("\0") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    /^[A-Za-z]:/u.test(portable) ||
    segments.includes("..")
  ) {
    throw new Error(
      `[vextjs] SEO output resolves outside config.frontend.outDir: ${file}`,
    );
  }

  const root = path.resolve(rootDir);
  const target = path.resolve(
    root,
    ...segments.filter((segment) => segment !== "" && segment !== "."),
  );
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `[vextjs] SEO output resolves outside config.frontend.outDir: ${file}`,
    );
  }
  return target;
}

function createBuildProviderAbortScope(external?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onExternalAbort = () => abort(external?.reason);
  const onSigint = () => abort(new Error("build interrupted by SIGINT"));
  const onSigterm = () => abort(new Error("build interrupted by SIGTERM"));

  if (external?.aborted) abort(external.reason);
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    dispose() {
      external?.removeEventListener("abort", onExternalAbort);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function toStringList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
