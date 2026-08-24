import { existsSync } from "node:fs";
import { join, relative, win32 } from "node:path";

import { runTypegen } from "../../tooling/typegen/index.js";
import { runLocalTsc } from "./local-tsc.js";

export type TsDiagnosticsMode = "blocking" | "async" | "skip";

export interface DevPreflightOptions {
  rootDir: string;
  language: "ts" | "js";
  reason: string;
  tsDiagnosticsMode?: TsDiagnosticsMode;
  logTypegenDetails?: boolean;
}

export interface DevPreflightResult {
  ok: boolean;
  typegenOk: boolean;
  tsOk: boolean;
  tsDiagnosticsPending?: boolean;
  tsDiagnosticsTask?: Promise<TsDiagnosticsResult>;
}

interface TsDiagnosticsResult {
  ok: boolean;
  errorCount: number;
  formatted?: string;
}

export async function runDevPreflight(
  options: DevPreflightOptions,
): Promise<DevPreflightResult> {
  const {
    rootDir,
    language,
    reason,
    tsDiagnosticsMode = "blocking",
    logTypegenDetails = true,
  } = options;

  const typegenResult = await runTypegen({
    rootDir,
    generateServices: true,
    generateAppExtensions: true,
    generateShim: language === "ts",
  });

  logTypegenResult(rootDir, typegenResult, { logDetails: logTypegenDetails });

  if (!typegenResult.ok) {
    console.error(
      `[vext dev] typegen reported blocking issues during ${reason}.`,
    );
  }

  if (language !== "ts" || tsDiagnosticsMode === "skip") {
    return {
      ok: typegenResult.ok,
      typegenOk: typegenResult.ok,
      tsOk: true,
    };
  }

  if (tsDiagnosticsMode === "async") {
    const tsDiagnosticsTask = runTypeScriptDiagnostics(rootDir)
      .then((diagnostics) => {
        logTypeScriptDiagnostics(reason, diagnostics, "async");
        return diagnostics;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[vext dev] TypeScript diagnostics failed after ${reason}: ${message}`,
        );
        return { ok: false, errorCount: 1 } satisfies TsDiagnosticsResult;
      });

    return {
      ok: typegenResult.ok,
      typegenOk: typegenResult.ok,
      tsOk: true,
      tsDiagnosticsPending: true,
      tsDiagnosticsTask,
    };
  }

  const tsDiagnostics = await runTypeScriptDiagnostics(rootDir);
  logTypeScriptDiagnostics(reason, tsDiagnostics, "blocking");

  return {
    ok: typegenResult.ok && tsDiagnostics.ok,
    typegenOk: typegenResult.ok,
    tsOk: tsDiagnostics.ok,
  };
}

function logTypeScriptDiagnostics(
  reason: string,
  diagnostics: TsDiagnosticsResult,
  mode: TsDiagnosticsMode,
): void {
  if (diagnostics.ok) {
    return;
  }

  const timing = mode === "async" ? `after ${reason}` : `during ${reason}`;
  const suffix =
    mode === "async"
      ? " Use --strict-preflight or VEXT_DEV_STRICT_PREFLIGHT=1 to block on these checks."
      : "";

  console.error(
    `[vext dev] TypeScript reported ${diagnostics.errorCount} blocking error(s) ${timing}.${suffix}`,
  );
  if (diagnostics.formatted) {
    console.error(diagnostics.formatted);
  }
}

function logTypegenResult(
  rootDir: string,
  result: Awaited<ReturnType<typeof runTypegen>>,
  options: { logDetails: boolean },
): void {
  if (options.logDetails) {
    for (const file of result.files) {
      if (file.status === "written") {
        console.log(
          `[vext dev] generated ${toRelativePath(rootDir, file.filePath)}`,
        );
      }
    }

    if (result.manifest?.status === "written") {
      console.log(
        `[vext dev] generated ${toRelativePath(rootDir, result.manifest.filePath)}`,
      );
    }
  }

  for (const warning of result.warnings) {
    console.warn(`[vext dev] typegen warning: ${warning}`);
  }

  for (const diagnostic of result.diagnostics) {
    if (diagnostic.level === "info" && !options.logDetails) {
      continue;
    }
    const logger = diagnostic.level === "error" ? console.error : console.log;
    logger(`[vext dev] typegen ${diagnostic.level}: ${diagnostic.message}`);
  }
}

async function runTypeScriptDiagnostics(
  rootDir: string,
): Promise<TsDiagnosticsResult> {
  const tsconfigPath = join(rootDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return { ok: true, errorCount: 0 };
  }

  const result = await runLocalTsc(rootDir);
  if (result.exitCode === 0) {
    return { ok: true, errorCount: 0 };
  }

  const formatted = normalizeTscOutput(result.output);
  return {
    ok: false,
    errorCount: countTypeScriptErrors(formatted),
    formatted,
  };
}

function normalizeTscOutput(output: string): string {
  return output.replace(/\r\n/g, "\n").trim();
}

function countTypeScriptErrors(output: string): number {
  const matches = output.match(/\berror TS\d+:/gu);
  return Math.max(1, matches?.length ?? 0);
}

function toRelativePath(rootDir: string, filePath: string): string {
  const pathRelative =
    isWindowsAbsolutePath(rootDir) && isWindowsAbsolutePath(filePath)
      ? win32.relative(rootDir, filePath)
      : relative(rootDir, filePath);

  return pathRelative.replace(/\\/g, "/");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value);
}
