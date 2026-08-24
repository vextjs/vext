import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const mocks = vi.hoisted(() => {
  const existsSync = vi.fn();
  const runTypegen = vi.fn();
  const spawn = vi.fn();
  const state = {
    tscExitCode: 0,
    tscOutput: "",
  };

  function createEmitter() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        const wrapped = (...args: unknown[]) => {
          listener(...args);
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((item) => item !== wrapped),
          );
        };
        listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    };
  }

  return {
    existsSync,
    runTypegen,
    spawn,
    state,
    createEmitter,
  };
});

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../../../src/tooling/typegen/index.js", () => ({
  runTypegen: mocks.runTypegen,
}));

import { runDevPreflight } from "../../../src/cli/utils/dev-preflight.js";

describe("runDevPreflight", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.runTypegen.mockResolvedValue({
      ok: true,
      files: [],
      diagnostics: [],
      warnings: [],
    });
    mocks.state.tscExitCode = 0;
    mocks.state.tscOutput = "";
    mocks.spawn.mockImplementation(() => {
      const child = mocks.createEmitter() as ReturnType<
        typeof mocks.createEmitter
      > & {
        stdout: ReturnType<typeof mocks.createEmitter>;
        stderr: ReturnType<typeof mocks.createEmitter>;
      };
      child.stdout = mocks.createEmitter();
      child.stderr = mocks.createEmitter();
      queueMicrotask(() => {
        if (mocks.state.tscOutput) {
          child.stdout.emit("data", Buffer.from(mocks.state.tscOutput));
        }
        child.emit("close", mocks.state.tscExitCode);
      });
      return child;
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips TypeScript diagnostics for JavaScript projects while logging typegen output", async () => {
    mocks.runTypegen.mockResolvedValueOnce({
      ok: false,
      files: [
        {
          filePath: "E:\\app\\.vext\\types\\services.generated.d.ts",
          status: "written",
        },
      ],
      diagnostics: [{ level: "error", message: "service dependency issue" }],
      warnings: ["manual review suggested"],
      manifest: {
        filePath: "E:\\app\\.vext\\manifest\\services.json",
        status: "written",
      },
    });

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "js",
      reason: "initial start",
      logTypegenDetails: true,
    });

    expect(result).toEqual({
      ok: false,
      typegenOk: false,
      tsOk: true,
    });
    expect(mocks.runTypegen).toHaveBeenCalledWith({
      rootDir: "E:\\app",
      generateServices: true,
      generateAppExtensions: true,
      generateShim: false,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[vext dev] generated .vext/types/services.generated.d.ts",
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[vext dev] generated .vext/manifest/services.json",
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[vext dev] typegen warning: manual review suggested",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] typegen error: service dependency issue",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] typegen reported blocking issues during initial start.",
    );
  });

  it("treats missing tsconfig.json as a non-blocking TypeScript project", async () => {
    mocks.existsSync.mockReturnValue(false);

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "soft reload",
    });

    expect(result).toEqual({
      ok: true,
      typegenOk: true,
      tsOk: true,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("can suppress successful typegen details while keeping warnings and errors visible", async () => {
    mocks.runTypegen.mockResolvedValueOnce({
      ok: false,
      files: [
        {
          filePath: "E:\\app\\.vext\\types\\services.generated.d.ts",
          status: "written",
        },
      ],
      diagnostics: [
        { level: "info", message: "Path service dependency check passed" },
        { level: "error", message: "service dependency issue" },
      ],
      warnings: ["manual review suggested"],
      manifest: {
        filePath: "E:\\app\\.vext\\manifest\\services.json",
        status: "written",
      },
    });

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "js",
      reason: "initial start",
      logTypegenDetails: false,
    });

    expect(result.ok).toBe(false);
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("generated"),
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("typegen info"),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[vext dev] typegen warning: manual review suggested",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] typegen error: service dependency issue",
    );
  });

  it("reports formatted TypeScript diagnostics when semantic errors exist", async () => {
    mocks.state.tscExitCode = 2;
    mocks.state.tscOutput =
      "src/index.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.";

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "soft reload",
    });

    expect(result).toEqual({
      ok: false,
      typegenOk: true,
      tsOk: false,
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        join("E:\\app", "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--pretty",
        "true",
      ],
      {
        cwd: "E:\\app",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] TypeScript reported 1 blocking error(s) during soft reload.",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "src/index.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  it("fails clearly without using a network fallback when local tsc is missing", async () => {
    mocks.existsSync.mockImplementation((filePath: unknown) =>
      String(filePath).endsWith("tsconfig.json"),
    );

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "initial start",
    });

    expect(result).toEqual({
      ok: false,
      typegenOk: true,
      tsOk: false,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Local TypeScript compiler not found"),
    );
  });

  it("runs TypeScript diagnostics asynchronously without blocking the preflight result", async () => {
    mocks.state.tscExitCode = 2;
    mocks.state.tscOutput = "src/index.ts(1,1): error TS2322: async TS error";

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "initial start",
      tsDiagnosticsMode: "async",
    });

    expect(result.ok).toBe(true);
    expect(result.typegenOk).toBe(true);
    expect(result.tsOk).toBe(true);
    expect(result.tsDiagnosticsPending).toBe(true);
    expect(result.tsDiagnosticsTask).toBeInstanceOf(Promise);

    await result.tsDiagnosticsTask;

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "TypeScript reported 1 blocking error(s) after initial start.",
      ),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "src/index.ts(1,1): error TS2322: async TS error",
    );
  });

  it("can skip TypeScript diagnostics while keeping typegen blocking", async () => {
    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "soft reload",
      tsDiagnosticsMode: "skip",
    });

    expect(result).toEqual({
      ok: true,
      typegenOk: true,
      tsOk: true,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("keeps both failure channels visible when typegen and TypeScript diagnostics fail together", async () => {
    mocks.runTypegen.mockResolvedValueOnce({
      ok: false,
      files: [],
      diagnostics: [],
      warnings: [],
    });
    mocks.state.tscExitCode = 2;
    mocks.state.tscOutput = [
      "src/a.ts(1,1): error TS2322: first",
      "src/b.ts(1,1): error TS2345: second",
    ].join("\n");

    const result = await runDevPreflight({
      rootDir: "E:\\app",
      language: "ts",
      reason: "cold restart preflight",
    });

    expect(result).toEqual({
      ok: false,
      typegenOk: false,
      tsOk: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] typegen reported blocking issues during cold restart preflight.",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[vext dev] TypeScript reported 2 blocking error(s) during cold restart preflight.",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(mocks.state.tscOutput);
  });
});
