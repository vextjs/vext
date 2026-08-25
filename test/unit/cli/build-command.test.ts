import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    runLocalTsc: vi.fn(async () => {
      order.push("typecheck");
      return { exitCode: 0, output: "" };
    }),
    detectProject: vi.fn(() => ({
      rootDir: "E:/app",
      srcDir: "E:/app/src",
      language: "ts",
    })),
    runTypegen: vi.fn(async () => {
      order.push("typegen");
      return {
        ok: true,
        files: [],
        diagnostics: [],
        warnings: [],
      };
    }),
    runDoctor: vi.fn(async () => {
      order.push("doctor");
      return {
        ok: true,
      };
    }),
    build: vi.fn(async () => {
      order.push("build");
      return {
        success: true,
        fileCount: 1,
        totalFiles: 1,
        elapsed: 1,
        outDir: "E:/app/dist",
        warnings: [],
        errors: [],
      };
    }),
    loadConfig: vi.fn(async () => {
      order.push("loadConfig");
      return {
        frontend: {
          enabled: false,
        },
      };
    }),
    buildFrontendClient: vi.fn(async () => {
      order.push("frontend");
      return {
        skipped: true,
        config: {
          enabled: false,
          framework: "react",
          root: "E:/app/src/frontend",
          entry: "E:/app/.vext/generated/frontend/browser-entry.tsx",
          indexHtml: "E:/app/src/frontend/pages/_document.html",
          outDir: "E:/app/dist/client",
          publicDir: "E:/app/public",
          publicPath: "/",
          apiClient: {
            enabled: true,
            outFile: "E:/app/.vext/client/api.generated.ts",
            contractFile: "E:/app/.vext/client/client-contract.json",
          },
          spaFallback: true,
          build: {
            target: "es2022",
            minify: false,
            sourcemap: true,
          },
        },
        warnings: [],
      };
    }),
  };
});

vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  existsSync: mocks.existsSync,
  rmSync: mocks.rmSync,
}));

vi.mock("../../../src/cli/utils/detect-project.js", () => ({
  detectProject: mocks.detectProject,
}));

vi.mock("../../../src/tooling/typegen/index.js", () => ({
  runTypegen: mocks.runTypegen,
}));

vi.mock("../../../src/tooling/doctor/index.js", () => ({
  runDoctor: mocks.runDoctor,
}));

vi.mock("../../../src/cli/utils/local-tsc.js", () => ({
  runLocalTsc: mocks.runLocalTsc,
}));

vi.mock("../../../src/lib/build/build-compiler.js", () => ({
  BuildCompiler: vi.fn().mockImplementation(function () {
    return {
      build: mocks.build,
    };
  }),
}));

vi.mock("../../../src/lib/config-loader.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../../src/frontend/tooling/client-build-compiler.js", () => ({
  buildFrontendClient: mocks.buildFrontendClient,
}));

import { buildCommand } from "../../../src/cli/build.js";

describe("buildCommand", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("refreshes generated artifacts before optional TypeScript typecheck", async () => {
    await buildCommand(["--typecheck"]);

    expect(mocks.order).toEqual([
      "typegen",
      "doctor",
      "typecheck",
      "build",
      "loadConfig",
      "frontend",
    ]);
    expect(mocks.runTypegen).toHaveBeenCalledWith({
      rootDir: "E:/app",
      generateServices: true,
      generateAppExtensions: true,
      writeManifest: true,
    });
    expect(mocks.runDoctor).toHaveBeenCalledWith({
      rootDir: "E:/app",
      target: "routes",
      writeManifest: true,
      refresh: true,
    });
    expect(mocks.runLocalTsc).toHaveBeenCalledWith("E:/app", {
      pretty: false,
      stdio: "inherit",
    });
    expect(mocks.loadConfig).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]dist[\\/]config$/),
      {
        rootDir: "E:/app",
        command: "build",
        mode: "production",
        configProfile: "production",
        isBuilt: true,
      },
    );
    expect(mocks.buildFrontendClient).toHaveBeenCalledWith({
      rootDir: "E:/app",
      config: {
        enabled: false,
      },
      mode: "production",
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("passes custom build outdir to frontend output when outDir is omitted", async () => {
    mocks.loadConfig.mockImplementationOnce(async () => {
      mocks.order.push("loadConfig");
      return {
        frontend: {
          enabled: true,
          entry: "src/frontend/custom-entry.tsx",
        },
      };
    });

    await buildCommand(["--outdir", "build"]);

    expect(mocks.loadConfig).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]build[\\/]config$/),
      {
        rootDir: "E:/app",
        command: "build",
        mode: "production",
        configProfile: "production",
        isBuilt: true,
      },
    );
    expect(mocks.buildFrontendClient).toHaveBeenCalledWith({
      rootDir: "E:/app",
      config: expect.objectContaining({
        enabled: true,
        entry: "src/frontend/custom-entry.tsx",
        outDir: expect.stringMatching(/^build[\\/]client$/),
      }),
      mode: "production",
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it.each([".", "src", "..", "../..", "E:/"])(
    "rejects destructive build outdir %s before cleanup",
    async (outdir) => {
      mocks.existsSync.mockReturnValue(true);

      await expect(
        buildCommand(["--clean", "--outdir", outdir]),
      ).rejects.toThrow(/outdir|output directory|project root/iu);

      expect(mocks.rmSync).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    },
  );
});
