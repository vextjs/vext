import { basename, extname, relative, sep } from "node:path";

/** Vext 2 route source modules are ESM; CommonJS route files fail closed. */
export const ROUTE_FILE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

/** Discovery includes .cjs so callers can reject it with a precise error. */
export const ROUTE_SOURCE_PATTERNS = ["**/*.{ts,js,mjs,cjs}"];

export const ROUTE_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/_*/**",
  "**/_*",
  "**/.*",
  "**/.*/**",
  "**/*.d.ts",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.__vext_compiled__*",
];

export function shouldDescendIntoRouteDirectory(dirname: string): boolean {
  return (
    dirname !== "node_modules" &&
    !dirname.startsWith("_") &&
    !dirname.startsWith(".")
  );
}

export function isRouteTestFileName(filename: string): boolean {
  return filename.includes(".test.") || filename.includes(".spec.");
}

export function shouldIncludeRouteFileName(filename: string): boolean {
  const ext = extname(filename);
  return (
    ROUTE_FILE_EXTENSIONS.has(ext) &&
    !filename.startsWith("_") &&
    !filename.startsWith(".") &&
    !filename.endsWith(".d.ts") &&
    !isRouteTestFileName(filename) &&
    !filename.includes(".__vext_compiled__")
  );
}

export function isUnsupportedCommonJsRouteFileName(filename: string): boolean {
  return (
    extname(filename) === ".cjs" &&
    !filename.startsWith("_") &&
    !filename.startsWith(".") &&
    !isRouteTestFileName(filename) &&
    !filename.includes(".__vext_compiled__")
  );
}

export function shouldIncludeRouteFilePath(
  filePath: string,
  routesDir: string,
): boolean {
  const rel = relative(routesDir, filePath).split(sep).join("/");
  if (rel.startsWith("..") || rel.startsWith("/")) return false;

  const segments = rel.split("/");
  for (const segment of segments.slice(0, -1)) {
    if (!shouldDescendIntoRouteDirectory(segment)) return false;
  }

  return shouldIncludeRouteFileName(basename(rel));
}
