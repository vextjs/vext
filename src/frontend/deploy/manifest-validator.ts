import { lstat, readFile, stat } from "node:fs/promises";
import type {
  ResolvedVextFrontendConfig,
  VextFrontendDeployManifest,
  VextFrontendDeployManifestAsset,
} from "../contract/types.js";
import { isImmutableFrontendBundleAsset } from "../asset-cache-policy.js";
import {
  normalizeSafeRelativePath,
  resolvePathInside,
} from "../../lib/path-boundary.js";
import { getFrontendContentType } from "./content-type.js";
import { createSha256, createSriSha256 } from "./integrity.js";
import { joinPublicPath, joinUploadKey } from "./manifest.js";

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_ASSETS = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SRI_SHA256_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/u;

export async function readFrontendDeployManifestFile(
  manifestPath: string,
): Promise<VextFrontendDeployManifest> {
  const manifestStat = await stat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(
      `[vextjs] frontend deploy manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vextjs] Invalid frontend deploy manifest JSON: ${message}`,
    );
  }
  return parseFrontendDeployManifest(parsed);
}

export function parseFrontendDeployManifest(
  value: unknown,
): VextFrontendDeployManifest {
  const root = expectObject(value, "frontend deploy manifest");
  assertOnlyKeys(
    root,
    [
      "schemaVersion",
      "kind",
      "generatedAt",
      "mode",
      "outDir",
      "publicPath",
      "assetBaseUrl",
      "upload",
      "assets",
    ],
    "frontend deploy manifest",
  );
  if (root.schemaVersion !== 1 || root.kind !== "frontend-deploy-manifest") {
    throw new Error(
      '[vextjs] frontend deploy manifest must use schemaVersion 1 and kind "frontend-deploy-manifest".',
    );
  }
  const generatedAt = expectDateString(
    root.generatedAt,
    "frontend deploy manifest.generatedAt",
  );
  const mode = root.mode;
  if (mode !== "development" && mode !== "production") {
    throw new Error(
      '[vextjs] frontend deploy manifest.mode must be "development" or "production".',
    );
  }
  const outDir = expectCanonicalRelativePath(
    root.outDir,
    "frontend deploy manifest.outDir",
  );
  const publicPath = expectBasePath(
    root.publicPath,
    "frontend deploy manifest.publicPath",
    true,
  );
  const assetBaseUrl = expectOptionalBasePath(
    root.assetBaseUrl,
    "frontend deploy manifest.assetBaseUrl",
  );
  const upload = parseUpload(root.upload);
  if (!Array.isArray(root.assets) || root.assets.length > MAX_MANIFEST_ASSETS) {
    throw new Error(
      `[vextjs] frontend deploy manifest.assets must be an array with at most ${MAX_MANIFEST_ASSETS} entries.`,
    );
  }

  const files = new Set<string>();
  const uploadKeys = new Set<string>();
  const assetBase = assetBaseUrl ?? publicPath;
  const assets = root.assets.map((asset, index) => {
    const parsed = parseAsset(asset, index);
    const expectedPath = joinPublicPath(assetBase, parsed.file);
    const expectedUploadKey = joinUploadKey(upload.prefix, parsed.file);
    if (parsed.path !== expectedPath) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].path must equal ${expectedPath}.`,
      );
    }
    if (parsed.uploadKey !== expectedUploadKey) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].uploadKey must equal ${expectedUploadKey}.`,
      );
    }
    if (files.has(parsed.file) || uploadKeys.has(parsed.uploadKey)) {
      throw new Error(
        `[vextjs] frontend deploy manifest contains duplicate asset identity at asset[${index}].`,
      );
    }
    files.add(parsed.file);
    uploadKeys.add(parsed.uploadKey);
    return parsed;
  });

  return {
    schemaVersion: 1,
    kind: "frontend-deploy-manifest",
    generatedAt,
    mode,
    outDir,
    publicPath,
    ...(assetBaseUrl === undefined ? {} : { assetBaseUrl }),
    upload,
    assets,
  };
}

export async function validateFrontendDeployManifest(
  value: unknown,
  config: ResolvedVextFrontendConfig,
): Promise<VextFrontendDeployManifest> {
  const manifest = parseFrontendDeployManifest(value);
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const asset = manifest.assets[index]!;
    const sourcePath = resolvePathInside(
      config.outDir,
      asset.file,
      `frontend deploy manifest asset[${index}].file`,
      { realpath: true },
    );
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}] must reference a regular file inside outDir.`,
      );
    }
    const content = await readFile(sourcePath);
    const actualSha256 = createSha256(content);
    const actualIntegrity = createSriSha256(content);
    if (asset.bytes !== content.byteLength) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].bytes does not match the source file.`,
      );
    }
    if (asset.sha256 !== actualSha256 || asset.integrity !== actualIntegrity) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}] integrity does not match the source file.`,
      );
    }
    const expectedContentType = getFrontendContentType(asset.file);
    if (asset.contentType !== expectedContentType) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].contentType must equal ${expectedContentType}.`,
      );
    }
    const expectedSource = asset.file.startsWith(
      `${config.build.client.assetsDir}/`,
    )
      ? "bundle"
      : "public";
    if (asset.source !== expectedSource) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].source must equal ${expectedSource}.`,
      );
    }
    const expectedImmutable = isImmutableFrontendBundleAsset(
      asset.file,
      config.build.client.assetsDir,
    );
    if (asset.immutable !== expectedImmutable) {
      throw new Error(
        `[vextjs] frontend deploy manifest asset[${index}].immutable is inconsistent with its file name.`,
      );
    }
  }
  return manifest;
}

function parseUpload(value: unknown): VextFrontendDeployManifest["upload"] {
  const upload = expectObject(value, "frontend deploy manifest.upload");
  assertOnlyKeys(
    upload,
    ["enabled", "adapter", "prefix", "publicBaseUrl", "stateFile", "dryRun"],
    "frontend deploy manifest.upload",
  );
  const enabled = expectBoolean(
    upload.enabled,
    "frontend deploy manifest.upload.enabled",
  );
  const adapter = expectNonEmptyString(
    upload.adapter,
    "frontend deploy manifest.upload.adapter",
  );
  const rawPrefix = expectString(
    upload.prefix,
    "frontend deploy manifest.upload.prefix",
  );
  const prefix =
    rawPrefix === ""
      ? ""
      : expectCanonicalRelativePath(
          rawPrefix,
          "frontend deploy manifest.upload.prefix",
        );
  const publicBaseUrl = expectOptionalBasePath(
    upload.publicBaseUrl,
    "frontend deploy manifest.upload.publicBaseUrl",
  );
  const stateFile = expectCanonicalRelativePath(
    upload.stateFile,
    "frontend deploy manifest.upload.stateFile",
  );
  const dryRun = expectBoolean(
    upload.dryRun,
    "frontend deploy manifest.upload.dryRun",
  );
  return {
    enabled,
    adapter,
    prefix,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    stateFile,
    dryRun,
  };
}

function parseAsset(
  value: unknown,
  index: number,
): VextFrontendDeployManifestAsset {
  const label = `frontend deploy manifest asset[${index}]`;
  const asset = expectObject(value, label);
  assertOnlyKeys(
    asset,
    [
      "file",
      "path",
      "uploadKey",
      "bytes",
      "sha256",
      "integrity",
      "contentType",
      "source",
      "entry",
      "immutable",
    ],
    label,
  );
  const file = expectCanonicalRelativePath(asset.file, `${label}.file`);
  const publicAssetPath = expectNonEmptyString(asset.path, `${label}.path`);
  const uploadKey = expectCanonicalRelativePath(
    asset.uploadKey,
    `${label}.uploadKey`,
  );
  const bytes = expectNonNegativeInteger(asset.bytes, `${label}.bytes`);
  const sha256 = expectString(asset.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(
      `[vextjs] ${label}.sha256 must be a lowercase SHA-256 hex digest.`,
    );
  }
  const integrity = expectString(asset.integrity, `${label}.integrity`);
  if (!SRI_SHA256_PATTERN.test(integrity)) {
    throw new Error(
      `[vextjs] ${label}.integrity must be a SHA-256 SRI digest.`,
    );
  }
  const contentType = expectNonEmptyString(
    asset.contentType,
    `${label}.contentType`,
  );
  const source = asset.source;
  if (source !== "bundle" && source !== "public") {
    throw new Error(`[vextjs] ${label}.source must be "bundle" or "public".`);
  }
  const entry =
    asset.entry === undefined
      ? undefined
      : expectBoolean(asset.entry, `${label}.entry`);
  const immutable = expectBoolean(asset.immutable, `${label}.immutable`);
  return {
    file,
    path: publicAssetPath,
    uploadKey,
    bytes,
    sha256,
    integrity,
    contentType,
    source,
    ...(entry === undefined ? {} : { entry }),
    immutable,
  };
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[vextjs] ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `[vextjs] ${label} contains unsupported field(s): ${unknown.join(", ")}.`,
    );
  }
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(
      `[vextjs] ${label} must be a control-character-free string.`,
    );
  }
  return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
  const result = expectString(value, label);
  if (result === "") throw new Error(`[vextjs] ${label} must not be empty.`);
  return result;
}

function expectCanonicalRelativePath(value: unknown, label: string): string {
  const raw = expectString(value, label);
  let normalized: string;
  try {
    normalized = normalizeSafeRelativePath(raw, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[vextjs] Invalid ${label}: ${message}`);
  }
  if (normalized !== raw) {
    throw new Error(`[vextjs] ${label} must use canonical POSIX separators.`);
  }
  return normalized;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`[vextjs] ${label} must be a boolean.`);
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`[vextjs] ${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function expectDateString(value: unknown, label: string): string {
  const result = expectNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`[vextjs] ${label} must be an ISO-compatible date string.`);
  }
  return result;
}

function expectBasePath(
  value: unknown,
  label: string,
  requireLeadingSlash: boolean,
): string {
  const result = expectNonEmptyString(value, label);
  if (
    !result.endsWith("/") ||
    (requireLeadingSlash && !result.startsWith("/"))
  ) {
    throw new Error(
      `[vextjs] ${label} must be a normalized base ending in "/".`,
    );
  }
  return result;
}

function expectOptionalBasePath(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : expectBasePath(value, label, false);
}
