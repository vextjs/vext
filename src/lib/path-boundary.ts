import { realpathSync } from "node:fs";
import path from "node:path";

export interface ResolvePathInsideOptions {
  allowRoot?: boolean;
  realpath?: boolean;
}

const DEFAULT_PROTECTED_PROJECT_ROOTS = [
  ".git",
  ".github",
  "node_modules",
  "src",
  "test",
  "tests",
];

/**
 * Normalizes a config or manifest path into a portable relative path.
 * Traversal is rejected instead of normalized away so the result is safe to
 * use as a canonical identity.
 */
export function normalizeSafeRelativePath(
  value: string,
  label: string,
): string {
  if (value.includes("\0")) {
    throw new Error(`[vextjs] ${label} must not contain NUL bytes.`);
  }
  if (
    value === "" ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`[vextjs] ${label} must be a non-empty relative path.`);
  }

  const portable = value.replace(/\\/gu, "/");
  const segments = portable.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `[vextjs] ${label} must not contain empty, ".", or ".." path segments.`,
    );
  }
  return segments.join("/");
}

export function isPathInside(
  rootDir: string,
  candidatePath: string,
  allowRoot = false,
): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === "") return allowRoot;
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertPathInside(
  rootDir: string,
  candidatePath: string,
  label: string,
  allowRoot = false,
): string {
  const candidate = path.resolve(candidatePath);
  if (!isPathInside(rootDir, candidate, allowRoot)) {
    throw new Error(
      `[vextjs] ${label} must resolve inside ${path.resolve(rootDir)}.`,
    );
  }
  return candidate;
}

export function assertRealPathInside(
  rootDir: string,
  candidatePath: string,
  label: string,
  allowRoot = false,
): string {
  const root = resolvePathThroughExistingAncestor(rootDir);
  const candidate = resolvePathThroughExistingAncestor(candidatePath);
  if (!isPathInside(root, candidate, allowRoot)) {
    throw new Error(
      `[vextjs] ${label} must remain inside ${path.resolve(rootDir)} after resolving symbolic links.`,
    );
  }
  return candidate;
}

export function resolvePathInside(
  rootDir: string,
  relativePath: string,
  label: string,
  options: ResolvePathInsideOptions = {},
): string {
  const normalized = normalizeSafeRelativePath(relativePath, label);
  const candidate = assertPathInside(
    rootDir,
    path.resolve(rootDir, ...normalized.split("/")),
    label,
    options.allowRoot ?? false,
  );
  if (options.realpath) {
    assertRealPathInside(rootDir, candidate, label, options.allowRoot ?? false);
  }
  return candidate;
}

export function assertSafeProjectOutputDirectory(
  projectRoot: string,
  outputDir: string,
  label: string,
  protectedRoots: readonly string[] = DEFAULT_PROTECTED_PROJECT_ROOTS,
): string {
  const root = path.resolve(projectRoot);
  const output = assertPathInside(root, outputDir, label);

  for (const relativeProtectedRoot of protectedRoots) {
    const protectedRoot = path.resolve(root, relativeProtectedRoot);
    if (
      isPathInside(protectedRoot, output, true) ||
      isPathInside(output, protectedRoot, true)
    ) {
      throw new Error(
        `[vextjs] ${label} must not overlap protected project path ${relativeProtectedRoot}.`,
      );
    }
  }

  assertRealPathInside(root, output, label);
  return output;
}

function resolvePathThroughExistingAncestor(value: string): string {
  let cursor = path.resolve(value);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const real = realpathSync.native(cursor);
      return path.resolve(real, ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
