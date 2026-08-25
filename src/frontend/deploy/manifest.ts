import { existsSync } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  normalizeSafeRelativePath,
  resolvePathInside,
} from "../../lib/path-boundary.js";
import type {
  ResolvedVextFrontendConfig,
  VextFrontendDeployManifest,
  VextFrontendDeployManifestAsset,
  VextFrontendManifest,
  VextFrontendMode,
} from "../contract/types.js";
import { STABLE_FRONTEND_GENERATED_AT } from "../contract/metadata.js";
import { isImmutableFrontendBundleAsset } from "../asset-cache-policy.js";
import { getFrontendContentType } from "./content-type.js";
import { createSha256, createSriSha256 } from "./integrity.js";

export interface BuildFrontendDeployManifestOptions {
  rootDir: string;
  config: ResolvedVextFrontendConfig;
  mode: VextFrontendMode;
  browserManifest: VextFrontendManifest;
}

const METADATA_FILES = new Set([
  "deploy-manifest.json",
  "index.html",
  "manifest.json",
  "messages-manifest.json",
  "media-manifest.json",
  "render-manifest.json",
  "size-report.json",
  "static-manifest.json",
]);

export async function buildFrontendDeployManifest(
  options: BuildFrontendDeployManifestOptions,
): Promise<VextFrontendDeployManifest> {
  const files = await scanDeployableFiles(options.config);
  const entryFiles = new Set(
    options.browserManifest.assets
      .filter((asset) => asset.entryPoint)
      .map((asset) => asset.entryPoint),
  );
  const assets: VextFrontendDeployManifestAsset[] = [];

  for (const file of files) {
    const absolutePath = resolvePathInside(
      options.config.outDir,
      file,
      "frontend deploy asset file",
      { realpath: true },
    );
    const [content, fileStat, linkStat] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
      lstat(absolutePath),
    ]);
    if (!fileStat.isFile() || linkStat.isSymbolicLink()) {
      throw new Error(
        `[vextjs] frontend deploy asset must be a regular file inside outDir: ${file}`,
      );
    }
    const source = classifyDeployAssetSource(options.config, file);
    assets.push({
      file,
      path: joinPublicPath(getAssetBase(options.config), file),
      uploadKey: joinUploadKey(options.config.deploy.upload.prefix, file),
      bytes: fileStat.size,
      sha256: createSha256(content),
      integrity: createSriSha256(content),
      contentType: getFrontendContentType(file),
      source,
      entry: entryFiles.has(file),
      immutable: isImmutableFrontendBundleAsset(
        file,
        options.config.build.client.assetsDir,
      ),
    });
  }

  return {
    schemaVersion: 1,
    kind: "frontend-deploy-manifest",
    generatedAt: STABLE_FRONTEND_GENERATED_AT,
    mode: options.mode,
    outDir: toProjectRelativePath(options.rootDir, options.config.outDir),
    publicPath: options.config.publicPath,
    assetBaseUrl: options.config.deploy.assetBaseUrl,
    upload: {
      enabled: options.config.deploy.upload.enabled,
      adapter: readAdapterName(options.config.deploy.upload.adapter),
      prefix: options.config.deploy.upload.prefix,
      publicBaseUrl: options.config.deploy.upload.publicBaseUrl,
      stateFile: toProjectRelativePath(
        options.rootDir,
        options.config.deploy.upload.stateFile,
      ),
      dryRun: options.config.deploy.upload.dryRun,
    },
    assets: assets.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

export function joinUploadKey(prefix: string, file: string): string {
  const normalizedFile = normalizeRelativeFile(file);
  const normalizedPrefix = prefix
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/gu, "");
  return normalizedPrefix
    ? `${normalizedPrefix}/${normalizedFile}`
    : normalizedFile;
}

export function joinPublicPath(
  publicPath: string,
  relativePath: string,
): string {
  return `${publicPath}${relativePath.replace(/^\/+/u, "")}`;
}

export function getAssetBase(config: ResolvedVextFrontendConfig): string {
  return config.deploy.assetBaseUrl ?? config.publicPath;
}

async function scanDeployableFiles(
  config: ResolvedVextFrontendConfig,
): Promise<string[]> {
  if (!existsSync(config.outDir)) return [];
  const files = await fg(config.deploy.upload.include, {
    cwd: config.outDir,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: ["server/**", ...config.deploy.upload.exclude],
  });
  return files
    .map(normalizeRelativeFile)
    .filter((file) => !METADATA_FILES.has(file));
}

function classifyDeployAssetSource(
  config: ResolvedVextFrontendConfig,
  file: string,
): VextFrontendDeployManifestAsset["source"] {
  if (file.startsWith(`${config.build.client.assetsDir}/`)) return "bundle";
  return "public";
}

function normalizeRelativeFile(value: string): string {
  try {
    return normalizeSafeRelativePath(value, "frontend deploy asset path");
  } catch {
    throw new Error(`[vextjs] Invalid frontend deploy asset path: ${value}`);
  }
}

function readAdapterName(
  adapter: ResolvedVextFrontendConfig["deploy"]["upload"]["adapter"],
): string {
  return typeof adapter === "string" ? adapter : adapter.name;
}

function toProjectRelativePath(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, "/");
}
