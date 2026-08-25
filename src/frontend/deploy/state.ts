import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VextFrontendDeployManifestAsset } from "../contract/types.js";
import { normalizeSafeRelativePath } from "../../lib/path-boundary.js";

export interface VextFrontendDeployState {
  schemaVersion: 1;
  kind: "frontend-deploy-state";
  updatedAt: string;
  assets: Record<
    string,
    {
      sha256: string;
      bytes: number;
      uploadedAt: string;
    }
  >;
}

export async function readFrontendDeployState(
  stateFile: string,
): Promise<VextFrontendDeployState> {
  if (!existsSync(stateFile)) {
    return createEmptyDeployState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(stateFile, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[vextjs] Invalid frontend deploy state JSON: ${message}`);
  }
  return parseFrontendDeployState(parsed);
}

export async function writeFrontendDeployState(
  stateFile: string,
  assets: VextFrontendDeployManifestAsset[],
): Promise<void> {
  const uploadedAt = new Date().toISOString();
  const state: VextFrontendDeployState = {
    schemaVersion: 1,
    kind: "frontend-deploy-state",
    updatedAt: uploadedAt,
    assets: Object.fromEntries(
      assets.map((asset) => [
        asset.uploadKey,
        {
          sha256: asset.sha256,
          bytes: asset.bytes,
          uploadedAt,
        },
      ]),
    ),
  };
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function createEmptyDeployState(): VextFrontendDeployState {
  return {
    schemaVersion: 1,
    kind: "frontend-deploy-state",
    updatedAt: new Date(0).toISOString(),
    assets: {},
  };
}

function parseFrontendDeployState(value: unknown): VextFrontendDeployState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[vextjs] frontend deploy state must be an object.");
  }
  const state = value as Record<string, unknown>;
  const unknownKeys = Object.keys(state).filter(
    (key) => !["schemaVersion", "kind", "updatedAt", "assets"].includes(key),
  );
  if (
    state.schemaVersion !== 1 ||
    state.kind !== "frontend-deploy-state" ||
    unknownKeys.length > 0
  ) {
    throw new Error(
      "[vextjs] frontend deploy state must use schemaVersion 1, the expected kind, and supported fields only.",
    );
  }
  const updatedAt = expectStateDate(state.updatedAt, "updatedAt");
  if (
    typeof state.assets !== "object" ||
    state.assets === null ||
    Array.isArray(state.assets)
  ) {
    throw new Error("[vextjs] frontend deploy state.assets must be an object.");
  }

  const assets: VextFrontendDeployState["assets"] = {};
  for (const [uploadKey, rawEntry] of Object.entries(
    state.assets as Record<string, unknown>,
  )) {
    let canonicalKey: string;
    try {
      canonicalKey = normalizeSafeRelativePath(
        uploadKey,
        "frontend deploy state upload key",
      );
    } catch {
      throw new Error(
        `[vextjs] Invalid frontend deploy state upload key: ${uploadKey}`,
      );
    }
    if (canonicalKey !== uploadKey) {
      throw new Error(
        `[vextjs] frontend deploy state upload key must use canonical POSIX separators: ${uploadKey}`,
      );
    }
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      throw new Error(
        `[vextjs] frontend deploy state entry ${uploadKey} must be an object.`,
      );
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) => !["sha256", "bytes", "uploadedAt"].includes(key),
      ) ||
      typeof entry.sha256 !== "string" ||
      entry.sha256 === "" ||
      /[\u0000-\u001F\u007F]/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0
    ) {
      throw new Error(
        `[vextjs] frontend deploy state entry ${uploadKey} has invalid integrity metadata.`,
      );
    }
    assets[uploadKey] = {
      sha256: entry.sha256,
      bytes: entry.bytes as number,
      uploadedAt: expectStateDate(entry.uploadedAt, `${uploadKey}.uploadedAt`),
    };
  }
  return {
    schemaVersion: 1,
    kind: "frontend-deploy-state",
    updatedAt,
    assets,
  };
}

function expectStateDate(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(
      `[vextjs] frontend deploy state ${label} must be a date string.`,
    );
  }
  return value;
}
