import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRouteIndex,
  createRouteSourceSnapshot,
  type RouteIndexEntry,
} from "../project-index/scan-routes.js";
import { inferOperationId } from "../../lib/openapi/operation-id.js";
import { createRouteId } from "../../frontend/contract/schema-ir.js";
import type {
  VextRouteFreshnessIdentity,
  VextRouteSchemaContractV1,
} from "../../frontend/contract/types.js";
import type { VextOpenAPIDocsKind } from "../../lib/openapi/types.js";
import type { GeneratedFileResult } from "../typegen/write-generated-file.js";
import { writeRouteInspectFile } from "./write-route-inspect.js";
import {
  writeRouteManifestFile,
  type RouteManifestPayload,
} from "./write-route-manifest.js";

export type DoctorTarget = "routes" | "all";
export type DoctorLevel = "error" | "warn" | "info";
export type DoctorGroup = "routing" | "docs" | "tooling";

export interface DoctorDiagnostic {
  level: DoctorLevel;
  group: DoctorGroup;
  blocking: boolean;
  code:
    | "duplicate-route"
    | "missing-docs-summary"
    | "auto-operation-id"
    | "missing-tags"
    | "deprecated-docs-tags"
    | "doctor-routes-ok"
    | "doctor-no-routes";
  message: string;
  filePath?: string;
  fileRelativePath?: string;
  method?: string;
  path?: string;
  suggestedValue?: string;
}

export interface RunDoctorOptions {
  rootDir: string;
  target?: DoctorTarget;
  writeInspect?: boolean;
  writeManifest?: boolean;
  refresh?: boolean;
  /** Read the stored manifest as an explicit snapshot, even when stale. */
  manifestOnly?: boolean;
}

export interface DoctorSummary {
  errors: number;
  warnings: number;
  infos: number;
  blocking: number;
  byCode: Record<string, number>;
  byGroup: Record<string, number>;
}

export interface DoctorRouteRecord {
  filePath: string;
  fileRelativePath: string;
  method: string;
  path: string;
  prefix: string;
  docsSummary: string | null;
  operationId: string | null;
  effectiveOperationId: string;
  operationIdSource: "explicit" | "inferred";
  tags: string[];
  hidden: boolean;
  docsKind: VextOpenAPIDocsKind;
  schema: VextRouteSchemaContractV1;
  freshness: VextRouteFreshnessIdentity;
}

export interface DoctorResult {
  ok: boolean;
  target: DoctorTarget;
  routeFileCount: number;
  routeCount: number;
  summary: DoctorSummary;
  diagnostics: DoctorDiagnostic[];
  routes: DoctorRouteRecord[];
  inspect?: GeneratedFileResult;
  manifest?: GeneratedFileResult;
  sourceFingerprint: string;
  sourceFiles: string[];
}

export async function runDoctor(
  options: RunDoctorOptions,
): Promise<DoctorResult> {
  const target = options.target ?? "routes";
  const writeInspect = options.writeInspect ?? false;
  const writeManifest = options.writeManifest ?? false;
  if (options.manifestOnly && writeManifest) {
    throw new Error(
      "[vextjs] doctor --manifest-only cannot be combined with --write-manifest because a stale snapshot must not be re-attested as current.",
    );
  }
  const sourceSnapshot = await createRouteSourceSnapshot(options.rootDir);
  let routeEntries: RouteIndexEntry[];
  if (options.manifestOnly) {
    const snapshot = readRouteEntriesFromManifest(options.rootDir);
    if (!snapshot) {
      throw new Error(
        "[vextjs] doctor --manifest-only requires an existing .vext/manifest/routes.json snapshot.",
      );
    }
    routeEntries = snapshot;
  } else if (options.refresh === true) {
    routeEntries = await buildRouteIndex(options.rootDir);
  } else {
    routeEntries =
      readRouteEntriesFromManifest(
        options.rootDir,
        sourceSnapshot.fingerprint,
      ) ?? (await buildRouteIndex(options.rootDir));
  }
  const diagnostics = analyzeRoutes(routeEntries);
  const routes = routeEntries.map((entry) => toDoctorRouteRecord(entry));
  const summary = summarizeDiagnostics(diagnostics);
  const inspect = writeInspect
    ? await writeRouteInspectFile(options.rootDir, {
        schemaVersion: 1,
        target: "routes",
        routeFileCount: new Set(routeEntries.map((item) => item.filePath)).size,
        routeCount: routeEntries.length,
        summary,
        diagnostics,
        routes,
      })
    : undefined;
  const manifest = writeManifest
    ? await writeRouteManifestFile(
        options.rootDir,
        buildRouteManifestPayload(routes, diagnostics, sourceSnapshot),
      )
    : undefined;

  return {
    ok: !diagnostics.some((item) => item.level === "error"),
    target,
    routeFileCount: new Set(routeEntries.map((item) => item.filePath)).size,
    routeCount: routeEntries.length,
    summary,
    diagnostics,
    routes,
    inspect,
    manifest,
    sourceFingerprint: sourceSnapshot.fingerprint,
    sourceFiles: sourceSnapshot.files,
  };
}

function readRouteEntriesFromManifest(
  rootDir: string,
  expectedFingerprint?: string,
): RouteIndexEntry[] | null {
  const manifestPath = join(rootDir, ".vext", "manifest", "routes.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  const payload = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    sourceFingerprint?: string;
    routes?: Array<{
      fileRelativePath?: string;
      source?: string;
      prefix?: string;
      method?: string;
      path?: string;
      docsKind?: VextOpenAPIDocsKind;
      docsSummary?: string | null;
      summary?: string | null;
      operationId?: string | null;
      operationIdSource?: "explicit" | "inferred";
      tags?: string[];
      hidden?: boolean;
      schema?: VextRouteSchemaContractV1;
      freshness?: VextRouteFreshnessIdentity;
    }>;
  };
  if (
    expectedFingerprint !== undefined &&
    payload.sourceFingerprint !== expectedFingerprint
  ) {
    return null;
  }

  return (payload.routes ?? [])
    .map((route) => {
      const fileRelativePath = route.fileRelativePath ?? route.source ?? "";
      const docsSummary = route.docsSummary ?? route.summary ?? null;
      const operationId =
        route.operationIdSource === "explicit"
          ? (route.operationId ?? null)
          : null;
      return {
        filePath: join(rootDir, fileRelativePath),
        fileRelativePath,
        prefix: route.prefix ?? "",
        method: route.method ?? "GET",
        path: route.path ?? "/",
        docsSummary,
        hasDocsSummary: Boolean(docsSummary?.trim()),
        operationId,
        tags: route.tags ?? [],
        hidden: route.hidden ?? false,
        docsKind: route.docsKind ?? "backend-api",
        schema: route.schema ?? {
          schemaVersion: 1,
          request: {},
          responses: [],
        },
        freshness: route.freshness ?? {
          mode: "dynamic",
          source: "legacy-default",
        },
      } satisfies RouteIndexEntry;
    })
    .sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
}

function analyzeRoutes(routeEntries: RouteIndexEntry[]): DoctorDiagnostic[] {
  if (routeEntries.length === 0) {
    return [
      {
        level: "info",
        group: "tooling",
        blocking: false,
        code: "doctor-no-routes",
        message: "No route files were found under src/routes.",
      },
    ];
  }

  const diagnostics: DoctorDiagnostic[] = [];
  const duplicateMap = new Map<string, RouteIndexEntry[]>();

  for (const entry of routeEntries) {
    const routeKey = `${entry.method} ${entry.path}`;
    const bucket = duplicateMap.get(routeKey) ?? [];
    bucket.push(entry);
    duplicateMap.set(routeKey, bucket);
  }

  for (const [routeKey, entries] of duplicateMap) {
    if (entries.length < 2) continue;

    const locations = entries.map((entry) => entry.filePath).join("; ");
    diagnostics.push({
      level: "error",
      group: "routing",
      blocking: true,
      code: "duplicate-route",
      message: `Duplicate static route definition detected for ${routeKey}. Sources: ${locations}`,
      filePath: entries[0]?.filePath,
      fileRelativePath: entries[0]?.fileRelativePath,
      method: entries[0]?.method,
      path: entries[0]?.path,
    });
  }

  for (const entry of routeEntries) {
    if (entry.hidden) {
      continue;
    }

    if (!entry.hasDocsSummary) {
      diagnostics.push({
        level: "warn",
        group: "docs",
        blocking: false,
        code: "missing-docs-summary",
        message: `${entry.method} ${entry.path} is missing docs.summary.`,
        filePath: entry.filePath,
        fileRelativePath: entry.fileRelativePath,
        method: entry.method,
        path: entry.path,
      });
    }

    if (!entry.operationId) {
      diagnostics.push({
        level: "info",
        group: "tooling",
        blocking: false,
        code: "auto-operation-id",
        message: `${entry.method} ${entry.path} will use inferred operationId at runtime.`,
        filePath: entry.filePath,
        fileRelativePath: entry.fileRelativePath,
        method: entry.method,
        path: entry.path,
        suggestedValue: inferOperationId(entry.method, entry.path),
      });
    }

    if (entry.tags.length > 0) {
      diagnostics.push({
        level: "info",
        group: "docs",
        blocking: false,
        code: "deprecated-docs-tags",
        message: `${entry.method} ${entry.path} uses deprecated docs.tags; Vext ignores it and infers operation tags automatically.`,
        filePath: entry.filePath,
        fileRelativePath: entry.fileRelativePath,
        method: entry.method,
        path: entry.path,
      });
    }
  }

  if (diagnostics.length === 0) {
    diagnostics.push({
      level: "info",
      group: "tooling",
      blocking: false,
      code: "doctor-routes-ok",
      message: `Route doctor passed for ${routeEntries.length} route(s).`,
    });
  }

  return diagnostics;
}

function toDoctorRouteRecord(entry: RouteIndexEntry): DoctorRouteRecord {
  return {
    filePath: entry.filePath,
    fileRelativePath: entry.fileRelativePath,
    method: entry.method,
    path: entry.path,
    prefix: entry.prefix,
    docsSummary: entry.docsSummary,
    operationId: entry.operationId,
    effectiveOperationId:
      entry.operationId ?? inferOperationId(entry.method, entry.path),
    operationIdSource: entry.operationId ? "explicit" : "inferred",
    tags: entry.tags,
    hidden: entry.hidden,
    docsKind: entry.docsKind,
    schema: entry.schema,
    freshness: entry.freshness,
  };
}

function summarizeDiagnostics(diagnostics: DoctorDiagnostic[]): DoctorSummary {
  const summary: DoctorSummary = {
    errors: 0,
    warnings: 0,
    infos: 0,
    blocking: 0,
    byCode: {},
    byGroup: {},
  };

  for (const diagnostic of diagnostics) {
    if (diagnostic.level === "error") summary.errors += 1;
    if (diagnostic.level === "warn") summary.warnings += 1;
    if (diagnostic.level === "info") summary.infos += 1;
    if (diagnostic.blocking) summary.blocking += 1;
    summary.byCode[diagnostic.code] =
      (summary.byCode[diagnostic.code] ?? 0) + 1;
    summary.byGroup[diagnostic.group] =
      (summary.byGroup[diagnostic.group] ?? 0) + 1;
  }

  return summary;
}

function buildRouteManifestPayload(
  routes: DoctorRouteRecord[],
  diagnostics: DoctorDiagnostic[],
  sourceSnapshot: { fingerprint: string; files: string[] },
): RouteManifestPayload {
  const missingDocsSummary = diagnostics.filter(
    (item) => item.code === "missing-docs-summary",
  ).length;
  const missingTags = diagnostics.filter(
    (item) => item.code === "missing-tags",
  ).length;
  const duplicateRoutes = diagnostics.filter(
    (item) => item.code === "duplicate-route",
  ).length;
  const explicitOperationIds = routes.filter(
    (item) => item.operationIdSource === "explicit",
  ).length;
  const inferredOperationIds = routes.filter(
    (item) => item.operationIdSource === "inferred",
  ).length;
  const hiddenRoutes = routes.filter((item) => item.hidden).length;
  const publicRoutes = routes.length - hiddenRoutes;

  return {
    schemaVersion: 1,
    kind: "routes-manifest",
    target: "routes",
    sourceFingerprint: sourceSnapshot.fingerprint,
    sourceFiles: sourceSnapshot.files,
    routeFileCount: new Set(routes.map((item) => item.fileRelativePath)).size,
    routeCount: routes.length,
    summary: {
      publicRoutes,
      hiddenRoutes,
      explicitOperationIds,
      inferredOperationIds,
      missingDocsSummary,
      missingTags,
      duplicateRoutes,
    },
    routes: routes.map((item) => ({
      fileRelativePath: item.fileRelativePath,
      source: item.fileRelativePath,
      prefix: item.prefix,
      method: item.method,
      path: item.path,
      docsKind: item.docsKind,
      docsSummary: item.docsSummary,
      summary: item.docsSummary,
      routeId: createRouteId(item.method, item.path),
      operationId: item.effectiveOperationId,
      operationIdSource: item.operationIdSource,
      tags: item.tags,
      hidden: item.hidden,
      schema: item.schema,
      freshness: item.freshness,
      layout: { state: "unresolved", paths: [] },
    })),
  };
}
