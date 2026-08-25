import type {
  ResolvedVextFrontendSeoConfig,
  VextOpenGraphMetadata,
  VextRenderSeoOptions,
  VextRouteFrontendSeoOptions,
  VextSeoMetadata,
  VextTwitterMetadata,
} from "../contract/types.js";
import type { VextRenderHeadOptions } from "../../types/response.js";
import {
  normalizeRenderSeoOptions,
  normalizeRouteSeoOptions,
  normalizeSeoPathname,
} from "../contract/seo-normalization.js";

export interface ResolveSeoHeadInput {
  config: ResolvedVextFrontendSeoConfig;
  pathname: string;
  route?: VextRouteFrontendSeoOptions;
  render?: VextRenderSeoOptions;
  head?: VextRenderHeadOptions;
}

/**
 * Resolves the single managed SEO/head view shared by initial SSR and page
 * envelopes. Existing `head` values are applied last for compatibility.
 */
export function resolveSeoHead(
  input: ResolveSeoHeadInput,
): VextRenderHeadOptions {
  const structuredEnabled =
    input.config.enabled ||
    (!input.config.configured && Boolean(input.route || input.render));
  if (!structuredEnabled) return cloneHead(input.head);

  const normalizedRoute = normalizeRouteSeoOptions(input.route);
  const normalizedRender = normalizeRenderSeoOptions(input.render);

  const { metadata: route, originKey: routeOriginKey } =
    splitRouteSeo(normalizedRoute);
  const { metadata: render, originKey: renderOriginKey } =
    splitRenderSeo(normalizedRender);
  const metadata = mergeSeoMetadata(
    mergeSeoMetadata(input.config.defaults, route),
    render,
  );
  const origin = resolveDeclaredOrigin(
    input.config,
    renderOriginKey ?? routeOriginKey,
  );
  const pathname = normalizePathname(metadata.canonical ?? input.pathname);
  if (
    !origin &&
    (metadata.canonical !== undefined ||
      (metadata.alternates?.length ?? 0) > 0 ||
      isRelativeSeoUrl(metadata.openGraph?.url))
  ) {
    throw new Error(
      "[vextjs] SEO canonical, alternate, or relative Open Graph URLs require a declared public origin.",
    );
  }

  const canonical = origin ? joinPublicUrl(origin, pathname) : undefined;
  const title = applyTitleTemplate(metadata.title, input.config.titleTemplate);
  const meta: Record<string, string> = {};
  const nameMeta: Array<{ name: string; content: string }> = [];
  const properties: Record<string, string> = {};
  const propertyMeta: Array<{ property: string; content: string }> = [];
  const links: Array<Record<string, string>> = [];

  if (metadata.robots) {
    meta.robots =
      typeof metadata.robots === "string"
        ? metadata.robots
        : metadata.robots.join(", ");
  }
  renderTwitterMetadata(metadata.twitter, origin, meta, nameMeta);
  renderOpenGraphMetadata(
    {
      ...(metadata.openGraph ?? {}),
      ...(metadata.openGraph?.title === undefined && metadata.title
        ? { title: metadata.title }
        : {}),
      ...(metadata.openGraph?.description === undefined && metadata.description
        ? { description: metadata.description }
        : {}),
      ...(metadata.openGraph?.url === undefined && canonical
        ? { url: canonical }
        : {}),
    },
    origin,
    properties,
    propertyMeta,
  );
  if (canonical) links.push({ rel: "canonical", href: canonical });
  for (const alternate of metadata.alternates ?? []) {
    if (!origin) {
      throw new Error(
        "[vextjs] SEO alternates require a declared public origin.",
      );
    }
    links.push({
      rel: "alternate",
      hreflang: alternate.hrefLang,
      href: joinPublicUrl(origin, normalizePathname(alternate.href)),
    });
  }

  return mergeLegacyHead(
    {
      ...(title ? { title } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(nameMeta.length > 0 ? { nameMeta } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(propertyMeta.length > 0 ? { propertyMeta } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(metadata.jsonLd !== undefined ? { jsonLd: metadata.jsonLd } : {}),
    },
    input.head,
  );
}

export function resolveDeclaredOrigin(
  config: ResolvedVextFrontendSeoConfig,
  originKey?: string,
): string | undefined {
  if (originKey !== undefined) {
    const origin = config.origins[originKey];
    if (!origin) {
      throw new Error(
        `[vextjs] SEO originKey "${originKey}" is not declared in config.frontend.seo.origins.`,
      );
    }
    return origin;
  }
  return config.publicOrigin;
}

export function selectRuntimeOrigin(
  config: ResolvedVextFrontendSeoConfig,
  host: string | undefined,
): { origin: string; originKey?: string } | undefined {
  if (!host) return undefined;
  const candidates: Array<{ origin: string; originKey?: string }> = [
    ...(config.publicOrigin ? [{ origin: config.publicOrigin }] : []),
    ...Object.entries(config.origins).map(([originKey, origin]) => ({
      origin,
      originKey,
    })),
  ];
  return candidates.find((candidate) => {
    const originUrl = new URL(candidate.origin);
    return (
      normalizeSeoAuthority(host, originUrl.protocol) ===
      normalizeSeoAuthority(originUrl.host, originUrl.protocol)
    );
  });
}

function normalizeSeoAuthority(
  authority: string,
  protocol: string,
): string | undefined {
  const trimmed = authority.trim();
  if (!trimmed || /[\\/?#@]/u.test(trimmed)) return undefined;
  try {
    const parsed = new URL(`${protocol}//${trimmed}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
    if (!hostname) return undefined;
    const defaultPort = protocol === "https:" ? "443" : "80";
    const port = parsed.port || defaultPort;
    return `${hostname}:${port}`;
  } catch {
    return undefined;
  }
}

export function joinPublicUrl(origin: string, pathname: string): string {
  const normalizedOrigin = origin.replace(/\/+$/u, "");
  const normalizedPathname = normalizePathname(pathname);
  return `${normalizedOrigin}${normalizedPathname}`;
}

export function normalizePathname(value: string): string {
  return normalizeSeoPathname(value, "SEO pathname");
}

function splitRouteSeo(value: VextRouteFrontendSeoOptions | undefined): {
  metadata: VextSeoMetadata;
  originKey?: string;
} {
  if (!value) return { metadata: {} };
  const { originKey, index: _index, ...metadata } = value;
  return { metadata, originKey };
}

function splitRenderSeo(value: VextRenderSeoOptions | undefined): {
  metadata: VextSeoMetadata;
  originKey?: string;
} {
  if (!value) return { metadata: {} };
  const { originKey, ...metadata } = value;
  return { metadata, originKey };
}

function mergeSeoMetadata(
  base: VextSeoMetadata,
  overlay: VextSeoMetadata,
): VextSeoMetadata {
  return {
    ...base,
    ...overlay,
    ...(base.openGraph || overlay.openGraph
      ? { openGraph: { ...base.openGraph, ...overlay.openGraph } }
      : {}),
    ...(base.twitter || overlay.twitter
      ? { twitter: { ...base.twitter, ...overlay.twitter } }
      : {}),
  };
}

function applyTitleTemplate(
  title: string | undefined,
  template: string | undefined,
): string | undefined {
  if (!title || !template) return title;
  return template.replaceAll("%s", title);
}

function renderTwitterMetadata(
  twitter: VextTwitterMetadata | undefined,
  origin: string | undefined,
  target: Record<string, string>,
  repeated: Array<{ name: string; content: string }>,
): void {
  if (!twitter) return;
  for (const [key, value] of Object.entries(twitter)) {
    if (value === undefined) continue;
    if (key === "images") {
      const images = value as readonly string[];
      images.forEach((image) =>
        repeated.push({
          name: "twitter:image",
          content: resolveSeoUrl(image, origin, "Twitter image"),
        }),
      );
      continue;
    }
    target[`twitter:${toSeoFieldName(key)}`] = String(value);
  }
}

function renderOpenGraphMetadata(
  openGraph: VextOpenGraphMetadata,
  origin: string | undefined,
  target: Record<string, string>,
  repeated: Array<{ property: string; content: string }>,
): void {
  for (const [key, value] of Object.entries(openGraph)) {
    if (value === undefined) continue;
    if (key === "images") {
      for (const image of value as NonNullable<
        VextOpenGraphMetadata["images"]
      >) {
        const normalized = typeof image === "string" ? { url: image } : image;
        repeated.push({
          property: "og:image",
          content: resolveSeoUrl(normalized.url, origin, "Open Graph image"),
        });
        if (normalized.alt)
          repeated.push({ property: "og:image:alt", content: normalized.alt });
        if (normalized.width !== undefined)
          repeated.push({
            property: "og:image:width",
            content: String(normalized.width),
          });
        if (normalized.height !== undefined)
          repeated.push({
            property: "og:image:height",
            content: String(normalized.height),
          });
        if (normalized.type)
          repeated.push({
            property: "og:image:type",
            content: normalized.type,
          });
      }
      continue;
    }
    const field = `og:${toSeoFieldName(key)}`;
    target[field] =
      key === "url"
        ? resolveSeoUrl(String(value), origin, "Open Graph URL")
        : String(value);
  }
}

function resolveSeoUrl(
  value: string,
  origin: string | undefined,
  label: string,
): string {
  if (value.startsWith("/")) {
    if (!origin)
      throw new Error(`[vextjs] ${label} requires a declared origin.`);
    return joinPublicUrl(origin, value);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[vextjs] ${label} must be an absolute URL or pathname.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[vextjs] ${label} must use http or https.`);
  }
  return url.href;
}

function isRelativeSeoUrl(value: string | undefined): boolean {
  return value?.startsWith("/") ?? false;
}

function toSeoFieldName(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function mergeLegacyHead(
  structured: VextRenderHeadOptions,
  legacy: VextRenderHeadOptions | undefined,
): VextRenderHeadOptions {
  if (!legacy) return structured;
  return {
    ...structured,
    ...legacy,
    meta: { ...(structured.meta ?? {}), ...(legacy.meta ?? {}) },
    properties: {
      ...(structured.properties ?? {}),
      ...(legacy.properties ?? {}),
    },
    nameMeta: mergeRepeatedMeta(structured.nameMeta, legacy.nameMeta, (entry) =>
      entry.name.toLowerCase(),
    ),
    propertyMeta: mergeRepeatedMeta(
      structured.propertyMeta,
      legacy.propertyMeta,
      (entry) => entry.property.toLowerCase(),
    ),
    links: mergeLinks(structured.links ?? [], legacy.links ?? []),
  };
}

function mergeRepeatedMeta<T>(
  base: readonly T[] | undefined,
  overlay: readonly T[] | undefined,
  identity: (entry: T) => string,
): T[] | undefined {
  if (overlay === undefined) return base ? [...base] : undefined;
  if (overlay.length === 0) return [];
  const overridden = new Set(overlay.map(identity));
  return [
    ...(base ?? []).filter((entry) => !overridden.has(identity(entry))),
    ...overlay,
  ];
}

function mergeLinks(
  base: Array<Record<string, string>>,
  overlay: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const links = new Map<string, Record<string, string>>();
  for (const link of [...base, ...overlay]) links.set(linkIdentity(link), link);
  return [...links.values()];
}

function linkIdentity(link: Record<string, string>): string {
  const rel = link.rel?.toLowerCase() ?? "";
  if (rel === "canonical") return "canonical";
  if (rel === "alternate")
    return `alternate:${(link.hreflang ?? link.hrefLang ?? "").toLowerCase()}`;
  return `${rel}:${link.href ?? JSON.stringify(link)}`;
}

function cloneHead(
  head: VextRenderHeadOptions | undefined,
): VextRenderHeadOptions {
  if (!head) return {};
  return {
    ...head,
    meta: head.meta ? { ...head.meta } : undefined,
    nameMeta: head.nameMeta?.map((entry) => ({ ...entry })),
    properties: head.properties ? { ...head.properties } : undefined,
    propertyMeta: head.propertyMeta?.map((entry) => ({ ...entry })),
    links: head.links?.map((link) => ({ ...link })),
  };
}
