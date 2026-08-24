import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LocalTscOptions {
  pretty?: boolean;
  stdio?: "pipe" | "inherit";
}

export interface LocalTscResult {
  exitCode: number | null;
  output: string;
}

export function runLocalTsc(
  rootDir: string,
  options: LocalTscOptions = {},
): Promise<LocalTscResult> {
  const localTscEntry = join(
    rootDir,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  if (!existsSync(localTscEntry)) {
    return Promise.resolve({
      exitCode: 1,
      output:
        `[vextjs] Local TypeScript compiler not found at ${localTscEntry}. ` +
        "Install project dependencies before running TypeScript diagnostics.",
    });
  }

  const captureOutput = options.stdio !== "inherit";
  const args = [
    "--noEmit",
    "--pretty",
    options.pretty === false ? "false" : "true",
  ];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [localTscEntry, ...args], {
      cwd: rootDir,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: LocalTscResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    if (captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    }
    child.once("error", (error) => {
      finish({ exitCode: 1, output: error.message });
    });
    child.once("close", (exitCode) => {
      finish({
        exitCode,
        output: Buffer.concat(chunks).toString("utf-8"),
      });
    });
  });
}
