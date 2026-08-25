import type { VextJsonValue } from "../../types/errors.js";
import type {
  VextOpenGraphMetadata,
  VextRenderSeoOptions,
  VextRouteFrontendSeoOptions,
  VextSeoImage,
  VextSeoMetadata,
  VextTwitterMetadata,
} from "./types.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function normalizeSeoMetadata(
  value: unknown,
  label: string,
): VextSeoMetadata | undefined {
  if (value === undefined) return undefined;
  const metadata = requireRecord(value, label);
  assertKnownKeys(metadata, label, [
    "title",
    "description",
    "robots",
    "canonical",
    "openGraph",
    "twitter",
    "alternates",
    "jsonLd",
  ]);
  return normalizeMetadataRecord(metadata, label);
}

export function normalizeRouteSeoOptions(
  value: unknown,
): VextRouteFrontendSeoOptions | undefined {
  if (value === undefined) return undefined;
  const label = "RouteOptions.frontend.seo";
  const metadata = requireRecord(value, label);
  assertKnownKeys(metadata, label, [
    "title",
    "description",
    "robots",
    "canonical",
    "openGraph",
    "twitter",
    "alternates",
    "jsonLd",
    "originKey",
    "index",
  ]);
  const normalized = normalizeMetadataRecord(metadata, label);
  const originKey = optionalSafeText(metadata.originKey, `${label}.originKey`);
  if (metadata.index !== undefined && typeof metadata.index !== "boolean") {
    throw new Error(`[vextjs] ${label}.index must be a boolean.`);
  }
  return {
    ...normalized,
    ...(originKey ? { originKey } : {}),
    ...(metadata.index !== undefined ? { index: metadata.index } : {}),
  };
}

export function normalizeRenderSeoOptions(
  value: unknown,
): VextRenderSeoOptions | undefined {
  if (value === undefined) return undefined;
  const label = "res.render(...).seo";
  const metadata = requireRecord(value, label);
  assertKnownKeys(metadata, label, [
    "title",
    "description",
    "robots",
    "canonical",
    "openGraph",
    "twitter",
    "alternates",
    "jsonLd",
    "originKey",
  ]);
  const normalized = normalizeMetadataRecord(metadata, label);
  const originKey = optionalSafeText(metadata.originKey, `${label}.originKey`);
  return { ...normalized, ...(originKey ? { originKey } : {}) };
}

export function normalizeSeoSafeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[vextjs] ${label} must be a non-empty string.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(
      `[vextjs] ${label} must not contain control characters or line separators.`,
    );
  }
  return value.trim();
}

export function normalizeSeoTextList(
  value: unknown,
  label: string,
): string | readonly string[] {
  if (typeof value === "string") {
    return normalizeSeoSafeText(value, label);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `[vextjs] ${label} must be a non-empty string or string array.`,
    );
  }
  return value.map((entry, index) =>
    normalizeSeoSafeText(entry, `${label}[${index}]`),
  );
}

export function normalizeSeoPathname(value: unknown, label: string): string {
  const pathname = normalizeSeoSafeText(value, label);
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.includes("\\")
  ) {
    throw new Error(
      `[vextjs] ${label} must be an absolute pathname without query or hash.`,
    );
  }
  const segments = pathname.split("/").map((segment, index) => {
    if (index === 0) return "";
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`[vextjs] ${label} contains invalid URL encoding.`);
    }
    if (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded === "." ||
      decoded === ".." ||
      CONTROL_CHARACTERS.test(decoded)
    ) {
      throw new Error(
        `[vextjs] ${label} contains a non-canonical or unsafe path segment.`,
      );
    }
    return encodeURIComponent(decoded).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  });
  const normalized = segments.join("/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

function normalizeMetadataRecord(
  metadata: Record<string, unknown>,
  label: string,
): VextSeoMetadata {
  const title = optionalSafeText(metadata.title, `${label}.title`);
  const description = optionalSafeText(
    metadata.description,
    `${label}.description`,
  );
  const robots =
    metadata.robots === undefined
      ? undefined
      : normalizeSeoTextList(metadata.robots, `${label}.robots`);
  const canonical =
    metadata.canonical === undefined
      ? undefined
      : normalizeSeoPathname(metadata.canonical, `${label}.canonical`);
  const openGraph = normalizeOpenGraph(
    metadata.openGraph,
    `${label}.openGraph`,
  );
  const twitter = normalizeTwitter(metadata.twitter, `${label}.twitter`);
  const alternates = normalizeAlternates(
    metadata.alternates,
    `${label}.alternates`,
  );
  const jsonLd = normalizeJsonValue(metadata.jsonLd, `${label}.jsonLd`);

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(robots ? { robots } : {}),
    ...(canonical ? { canonical } : {}),
    ...(openGraph ? { openGraph } : {}),
    ...(twitter ? { twitter } : {}),
    ...(alternates ? { alternates } : {}),
    ...(jsonLd !== undefined ? { jsonLd } : {}),
  };
}

function normalizeOpenGraph(
  value: unknown,
  label: string,
): VextOpenGraphMetadata | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, label);
  assertKnownKeys(input, label, [
    "title",
    "description",
    "type",
    "url",
    "siteName",
    "locale",
    "images",
  ]);
  const images = normalizeOpenGraphImages(input.images, `${label}.images`);
  const url = optionalSeoUrl(input.url, `${label}.url`);
  return {
    ...copyOptionalTextFields(input, label, [
      "title",
      "description",
      "type",
      "siteName",
      "locale",
    ]),
    ...(url ? { url } : {}),
    ...(images ? { images } : {}),
  };
}

function normalizeOpenGraphImages(
  value: unknown,
  label: string,
): readonly (string | VextSeoImage)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[vextjs] ${label} must be a non-empty array.`);
  }
  return value.map((image, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof image === "string") return normalizeSeoUrl(image, itemLabel);
    const input = requireRecord(image, itemLabel);
    assertKnownKeys(input, itemLabel, [
      "url",
      "alt",
      "width",
      "height",
      "type",
    ]);
    const url = normalizeSeoUrl(input.url, `${itemLabel}.url`);
    const alt = optionalSafeText(input.alt, `${itemLabel}.alt`);
    const type = optionalSafeText(input.type, `${itemLabel}.type`);
    const width = optionalPositiveInteger(input.width, `${itemLabel}.width`);
    const height = optionalPositiveInteger(input.height, `${itemLabel}.height`);
    return {
      url,
      ...(alt ? { alt } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(type ? { type } : {}),
    };
  });
}

function normalizeTwitter(
  value: unknown,
  label: string,
): VextTwitterMetadata | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, label);
  assertKnownKeys(input, label, [
    "card",
    "site",
    "creator",
    "title",
    "description",
    "images",
  ]);
  const card = optionalSafeText(input.card, `${label}.card`);
  if (
    card !== undefined &&
    !["summary", "summary_large_image", "app", "player"].includes(card)
  ) {
    throw new Error(
      `[vextjs] ${label}.card must be "summary", "summary_large_image", "app", or "player".`,
    );
  }
  let images: string[] | undefined;
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length === 0) {
      throw new Error(`[vextjs] ${label}.images must be a non-empty array.`);
    }
    images = input.images.map((image, index) =>
      normalizeSeoUrl(image, `${label}.images[${index}]`),
    );
  }
  return {
    ...(card ? { card: card as NonNullable<VextTwitterMetadata["card"]> } : {}),
    ...copyOptionalTextFields(input, label, [
      "site",
      "creator",
      "title",
      "description",
    ]),
    ...(images ? { images } : {}),
  };
}

function normalizeAlternates(
  value: unknown,
  label: string,
): Array<{ hrefLang: string; href: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`[vextjs] ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const input = requireRecord(entry, itemLabel);
    assertKnownKeys(input, itemLabel, ["hrefLang", "href"]);
    return {
      hrefLang: normalizeSeoSafeText(input.hrefLang, `${itemLabel}.hrefLang`),
      href: normalizeSeoPathname(input.href, `${itemLabel}.href`),
    };
  });
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  ancestors = new WeakSet<object>(),
): VextJsonValue | readonly VextJsonValue[] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
    }
    ancestors.add(value);
    try {
      return Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
        }
        const normalized = normalizeJsonValue(
          value[index],
          `${label}[${index}]`,
          ancestors,
        );
        if (normalized === undefined) {
          throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
        }
        return normalized as VextJsonValue;
      });
    } finally {
      ancestors.delete(value);
    }
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
    }
    ancestors.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          const normalized = normalizeJsonValue(
            entry,
            `${label}.${key}`,
            ancestors,
          );
          if (normalized === undefined) {
            throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
          }
          return [key, normalized];
        }),
      ) as VextJsonValue;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error(`[vextjs] ${label} must contain JSON-safe values.`);
}

function normalizeSeoUrl(value: unknown, label: string): string {
  const text = normalizeSeoSafeText(value, label);
  if (text.startsWith("/")) return normalizeSeoPathname(text, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`[vextjs] ${label} must be an absolute URL or pathname.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `[vextjs] ${label} must use http or https without userinfo.`,
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.href);
  } catch {
    throw new Error(`[vextjs] ${label} contains invalid URL encoding.`);
  }
  if (CONTROL_CHARACTERS.test(decoded)) {
    throw new Error(
      `[vextjs] ${label} must not contain control characters or line separators.`,
    );
  }
  return url.href;
}

function optionalSeoUrl(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeSeoUrl(value, label);
}

function optionalSafeText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeSeoSafeText(value, label);
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`[vextjs] ${label} must be a positive integer.`);
  }
  return value as number;
}

function copyOptionalTextFields(
  input: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const normalized = optionalSafeText(input[key], `${label}.${key}`);
      return normalized ? [[key, normalized]] : [];
    }),
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`[vextjs] ${label} must be an object.`);
  }
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(`[vextjs] ${label}.${unknown} is not supported.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
