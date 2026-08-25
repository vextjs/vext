import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  VextFrontendDeployManifest,
  VextFrontendDeployUploadAdapter,
} from "../../src/frontend/contract/types.js";
import {
  createSha256,
  createSriSha256,
} from "../../src/frontend/deploy/integrity.js";
import { getFrontendContentType } from "../../src/frontend/deploy/content-type.js";
import { deployFrontendAssets } from "../../src/frontend/deploy/uploader.js";
import { resolveFrontendConfig } from "../../src/frontend/tooling/config-resolver.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("frontend deploy manifest validation", () => {
  it.each([
    {
      name: "traversal file",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets[0]!.file = "../../secret.txt";
      },
    },
    {
      name: "absolute file",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets[0]!.file = path.resolve("outside.txt");
      },
    },
    {
      name: "hash drift",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets[0]!.sha256 = "0".repeat(64);
      },
    },
    {
      name: "size drift",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets[0]!.bytes += 1;
      },
    },
    {
      name: "duplicate canonical identity",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets.push({ ...manifest.assets[0]! });
      },
    },
    {
      name: "inconsistent upload key",
      mutate(manifest: VextFrontendDeployManifest) {
        manifest.assets[0]!.uploadKey = "other.txt";
      },
    },
  ])("rejects $name before upload or state mutation", async ({ mutate }) => {
    const fixture = await createFixture();
    const manifest = structuredClone(fixture.manifest);
    mutate(manifest);
    await writeFile(
      fixture.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    let uploadCalls = 0;
    const adapter: VextFrontendDeployUploadAdapter = {
      name: "probe",
      async upload() {
        uploadCalls += 1;
        return { uploaded: true };
      },
    };

    await expect(
      deployFrontendAssets({
        config: fixture.config,
        manifestPath: fixture.manifestPath,
        adapter,
      }),
    ).rejects.toThrow(/deploy manifest|deploy asset|asset\[0\]|duplicate/iu);

    expect(uploadCalls).toBe(0);
    expect(existsSync(fixture.config.deploy.upload.stateFile)).toBe(false);
  });

  it("rejects non-canonical deploy state keys before planning uploads", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.manifestPath,
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      "utf-8",
    );
    await mkdir(path.dirname(fixture.config.deploy.upload.stateFile), {
      recursive: true,
    });
    const stateText = `${JSON.stringify({
      schemaVersion: 1,
      kind: "frontend-deploy-state",
      updatedAt: new Date(0).toISOString(),
      assets: {
        "../outside": {
          sha256: fixture.manifest.assets[0]!.sha256,
          bytes: fixture.manifest.assets[0]!.bytes,
          uploadedAt: new Date(0).toISOString(),
        },
      },
    })}\n`;
    await writeFile(fixture.config.deploy.upload.stateFile, stateText, "utf-8");
    let uploadCalls = 0;

    await expect(
      deployFrontendAssets({
        config: fixture.config,
        manifestPath: fixture.manifestPath,
        adapter: {
          name: "probe",
          async upload() {
            uploadCalls += 1;
            return { uploaded: true };
          },
        },
      }),
    ).rejects.toThrow(/deploy state upload key/iu);

    expect(uploadCalls).toBe(0);
    expect(
      await readFile(fixture.config.deploy.upload.stateFile, "utf-8"),
    ).toBe(stateText);
  });
});

async function createFixture() {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "vext-deploy-manifest-"),
  );
  tempDirs.push(rootDir);
  const config = resolveFrontendConfig(
    {
      enabled: true,
      deploy: {
        upload: { enabled: true, adapter: "mock", prefix: "release" },
      },
    },
    { rootDir, mode: "production" },
  );
  await mkdir(config.outDir, { recursive: true });
  const content = Buffer.from("asset-content\n");
  await writeFile(path.join(config.outDir, "asset.txt"), content);
  const manifestPath = path.join(
    config.outDir,
    "deploy-manifest.external.json",
  );
  const manifest: VextFrontendDeployManifest = {
    schemaVersion: 1,
    kind: "frontend-deploy-manifest",
    generatedAt: new Date(0).toISOString(),
    mode: "production",
    outDir: "dist/client",
    publicPath: "/",
    upload: {
      enabled: true,
      adapter: "mock",
      prefix: "release",
      stateFile: ".vext/deploy/frontend-assets-state.json",
      dryRun: false,
    },
    assets: [
      {
        file: "asset.txt",
        path: "/asset.txt",
        uploadKey: "release/asset.txt",
        bytes: content.byteLength,
        sha256: createSha256(content),
        integrity: createSriSha256(content),
        contentType: getFrontendContentType("asset.txt"),
        source: "public",
        entry: false,
        immutable: false,
      },
    ],
  };
  return { rootDir, config, manifest, manifestPath };
}
