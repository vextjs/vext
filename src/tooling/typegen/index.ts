import type { GeneratedFileResult } from "./write-generated-file.js";
import { buildProjectIndex } from "../project-index/index.js";
import {
  analyzeServiceDependencies,
  type ServiceDependencyDiagnostic,
} from "../diagnostics/service-deps.js";
import { generateServicesDts } from "./generate-services-dts.js";
import {
  generateAppExtensionsDts,
  type AppExtensionsGenerationResult,
} from "./generate-app-extensions-dts.js";
import { writeServiceManifestFile } from "./write-service-manifest.js";
import { generateTypegenShim } from "./generate-typegen-shim.js";

export interface RunTypegenOptions {
  rootDir: string;
  generateServices: boolean;
  generateAppExtensions: boolean;
  generateShim?: boolean;
  checkOnly?: boolean;
  writeManifest?: boolean;
}

export interface TypegenResult {
  ok: boolean;
  files: GeneratedFileResult[];
  diagnostics: ServiceDependencyDiagnostic[];
  warnings: string[];
  manifest?: GeneratedFileResult;
}

export async function runTypegen(
  options: RunTypegenOptions,
): Promise<TypegenResult> {
  const {
    rootDir,
    generateServices,
    generateAppExtensions,
    generateShim = true,
    checkOnly = false,
    writeManifest = false,
  } = options;

  const index = await buildProjectIndex(rootDir);
  const files: GeneratedFileResult[] = [];
  const warnings: string[] = [];

  if (generateServices) {
    files.push(
      await generateServicesDts(rootDir, index.serviceEntries, { checkOnly }),
    );
  }

  if (generateAppExtensions) {
    const appExtensionsResult: AppExtensionsGenerationResult =
      await generateAppExtensionsDts(rootDir, index.appExtensions, {
        checkOnly,
      });
    files.push(appExtensionsResult.file);
    warnings.push(...appExtensionsResult.warnings);
  }

  if (generateShim && files.length > 0) {
    files.push(
      await generateTypegenShim(
        rootDir,
        files.map((file) => file.filePath),
        { checkOnly },
      ),
    );
  }

  const serviceDeps = await analyzeServiceDependencies(rootDir, { index });
  const manifest = writeManifest
    ? await writeServiceManifestFile(
        rootDir,
        index.serviceEntries,
        index.appExtensions,
        serviceDeps,
        { checkOnly },
      )
    : undefined;
  const staleFiles = files.filter((file) => file.status === "stale");
  const staleManifest = manifest?.status === "stale";
  const hasErrors =
    staleFiles.length > 0 ||
    staleManifest ||
    serviceDeps.diagnostics.some((diagnostic) => diagnostic.level === "error");

  for (const staleFile of staleFiles) {
    warnings.push(`Generated file is stale: ${staleFile.filePath}`);
  }

  if (staleManifest && manifest) {
    warnings.push(`Generated file is stale: ${manifest.filePath}`);
  }

  return {
    ok: !hasErrors,
    files,
    diagnostics: serviceDeps.diagnostics,
    warnings,
    manifest,
  };
}
