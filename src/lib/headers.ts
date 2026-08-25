import { validateHeaderName, validateHeaderValue } from "node:http";
import type { VextHeaderValue, VextHeaders } from "../types/headers.js";
import { defineEnumerableOwn } from "./own-property.js";

export type { VextHeaderValue, VextHeaders } from "../types/headers.js";

export function isSetCookieHeader(name: string): boolean {
  return name.toLowerCase() === "set-cookie";
}

export function findHeaderName(
  headers: VextHeaders,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted);
}

export function getHeader(
  headers: VextHeaders,
  name: string,
): VextHeaderValue | undefined {
  const key = findHeaderName(headers, name);
  return key ? headers[key] : undefined;
}

export function getHeaderValues(headers: VextHeaders, name: string): string[] {
  const value = getHeader(headers, name);
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [String(value)];
}

export function hasHeader(headers: VextHeaders, name: string): boolean {
  return findHeaderName(headers, name) !== undefined;
}

export function setHeader(
  headers: VextHeaders,
  name: string,
  value: VextHeaderValue,
): boolean {
  // Fail-fast on invalid tokens/values (CRLF injection, non-token names, etc.).
  // Matches Node validateHeaderName/Value and public res.setHeader() contract tests.
  assertValidHeader(name, value);
  const existing = findHeaderName(headers, name);
  if (existing && existing !== name) {
    delete headers[existing];
  }
  defineEnumerableOwn(
    headers,
    name,
    Array.isArray(value) ? [...value] : String(value),
  );
  return true;
}

export function appendHeader(
  headers: VextHeaders,
  name: string,
  value: string,
): boolean {
  assertValidHeader(name, value);
  const existing = findHeaderName(headers, name);
  if (!existing) {
    defineEnumerableOwn(headers, name, value);
    return true;
  }

  const current = headers[existing];
  defineEnumerableOwn(
    headers,
    existing,
    Array.isArray(current) ? [...current, value] : [String(current), value],
  );
  return true;
}

export function mergeHeaders(
  target: VextHeaders,
  source: VextHeaders | undefined,
): void {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) {
    if (isSetCookieHeader(name)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) appendHeader(target, name, String(item));
      continue;
    }
    setHeader(target, name, value);
  }
}

export function replaceHeaders(target: VextHeaders, source: VextHeaders): void {
  for (const name of Object.keys(target)) {
    delete target[name];
  }
  mergeHeaders(target, source);
}

export function cloneHeaders(headers: VextHeaders): VextHeaders {
  const cloned: VextHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    defineEnumerableOwn(
      cloned,
      name,
      Array.isArray(value) ? [...value] : value,
    );
  }
  return cloned;
}

function isValidHeader(name: string, value: VextHeaderValue): boolean {
  try {
    validateHeaderName(name);
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      validateHeaderValue(name, String(item));
    }
    return true;
  } catch {
    return false;
  }
}

export function assertValidHeader(name: string, value: VextHeaderValue): void {
  if (!isValidHeader(name, value)) {
    // Keep a throw path for callers that need fail-fast (e.g. cookie serialize).
    validateHeaderName(name);
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      validateHeaderValue(name, String(item));
    }
  }
}
