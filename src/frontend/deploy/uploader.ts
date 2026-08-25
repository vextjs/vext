import type {
  ResolvedVextFrontendConfig,
  VextFrontendDeployManifestAsset,
  VextFrontendDeployManifest,
  VextFrontendDeployResult,
  VextFrontendDeployUploadAdapter,
} from "../contract/types.js";
import { createFilesystemDeployAdapter } from "./adapters/filesystem.js";
import { createMockDeployAdapter } from "./adapters/mock.js";
import { joinUploadKey } from "./manifest.js";
import { readFrontendDeployManifestFile } from "./manifest-validator.js";
import { createFrontendDeployPlan } from "./planner.js";
import { writeFrontendDeployState } from "./state.js";

export interface DeployFrontendAssetsOptions {
  config: ResolvedVextFrontendConfig;
  manifestPath: string;
  dryRun?: boolean;
  adapter?: VextFrontendDeployUploadAdapter;
}

export async function deployFrontendAssets(
  options: DeployFrontendAssetsOptions,
): Promise<VextFrontendDeployResult> {
  const manifest = applyDeployConfigOverrides(
    await readFrontendDeployManifestFile(options.manifestPath),
    options.config,
  );
  const dryRun = options.dryRun ?? options.config.deploy.upload.dryRun;
  const plan = await createFrontendDeployPlan(
    manifest,
    options.config,
    options.manifestPath,
  );
  const adapter = options.adapter ?? resolveDeployAdapter(options.config);
  const validatedAssets = plan.items.map((item) => item.asset);
  const uploadedAssets: VextFrontendDeployManifestAsset[] = [];
  const confirmedStateUploadKeys = new Set<string>();
  const assets: VextFrontendDeployResult["assets"] = [];

  await runWithConcurrency(
    plan.items,
    options.config.deploy.upload.concurrency,
    async (item) => {
      if (item.status === "skip") {
        assets.push({
          file: item.asset.file,
          uploadKey: item.asset.uploadKey,
          status: "skipped",
        });
        confirmedStateUploadKeys.add(item.asset.uploadKey);
        return;
      }
      const result = await adapter.upload({
        asset: item.asset,
        sourcePath: item.sourcePath,
        uploadKey: item.asset.uploadKey,
        dryRun,
      });
      assets.push({
        file: item.asset.file,
        uploadKey: item.asset.uploadKey,
        status: dryRun ? "planned" : result.uploaded ? "uploaded" : "skipped",
        url: result.url,
      });
      if (!dryRun && result.uploaded) {
        uploadedAssets.push(item.asset);
        confirmedStateUploadKeys.add(item.asset.uploadKey);
      }
    },
  );

  if (!dryRun) {
    await writeFrontendDeployState(
      options.config.deploy.upload.stateFile,
      validatedAssets.filter((asset) =>
        confirmedStateUploadKeys.has(asset.uploadKey),
      ),
    );
  }

  return {
    manifestPath: options.manifestPath,
    stateFile: options.config.deploy.upload.stateFile,
    dryRun,
    uploaded: dryRun ? 0 : uploadedAssets.length,
    skipped: assets.filter((asset) => asset.status === "skipped").length,
    bytesUploaded: dryRun
      ? 0
      : uploadedAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    assets: assets.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function applyDeployConfigOverrides(
  manifest: VextFrontendDeployManifest,
  config: ResolvedVextFrontendConfig,
): VextFrontendDeployManifest {
  const prefix = config.deploy.upload.prefix;
  if (prefix === manifest.upload.prefix) {
    return manifest;
  }
  return {
    ...manifest,
    upload: {
      ...manifest.upload,
      prefix,
      dryRun: config.deploy.upload.dryRun,
    },
    assets: manifest.assets.map((asset) => ({
      ...asset,
      uploadKey: joinUploadKey(prefix, asset.file),
    })),
  };
}

function resolveDeployAdapter(
  config: ResolvedVextFrontendConfig,
): VextFrontendDeployUploadAdapter {
  const adapter = config.deploy.upload.adapter;
  if (typeof adapter !== "string") return adapter;
  if (adapter === "mock") return createMockDeployAdapter();
  if (adapter === "filesystem") {
    if (!config.deploy.upload.targetDir) {
      throw new Error(
        "[vextjs] config.frontend.deploy.upload.targetDir is required for filesystem upload.",
      );
    }
    return createFilesystemDeployAdapter(
      config.deploy.upload.targetDir,
      config.deploy.upload.publicBaseUrl ?? config.deploy.assetBaseUrl,
    );
  }
  throw new Error(`[vextjs] Unsupported frontend deploy adapter: ${adapter}`);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await worker(item);
        }
      }
    }),
  );
}
