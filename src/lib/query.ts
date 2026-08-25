import { defineEnumerableOwn } from "./own-property.js";

/**
 * Normalize host-framework query objects into VextRequest.query.
 *
 * Public contract: `Record<string, string>`.
 * Multi-value keys collapse to the **first** string value so native,
 * express, fastify, hono, and koa adapters share identical semantics.
 */
export function flattenQueryRecord(query: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!query || typeof query !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === "string") {
      defineEnumerableOwn(result, key, value);
      continue;
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      if (typeof first === "string") {
        defineEnumerableOwn(result, key, first);
      }
      continue;
    }
    if (
      value !== null &&
      value !== undefined &&
      (typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint")
    ) {
      defineEnumerableOwn(result, key, String(value));
    }
  }

  return result;
}

/**
 * Parse a raw query string with first-wins multi-value semantics.
 */
export function parseQueryString(
  rawQueryString: string,
): Record<string, string> {
  if (!rawQueryString) {
    return {};
  }
  const searchParams = new URLSearchParams(
    rawQueryString.startsWith("?") ? rawQueryString.slice(1) : rawQueryString,
  );
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!Object.hasOwn(result, key)) {
      defineEnumerableOwn(result, key, value);
    }
  }
  return result;
}
