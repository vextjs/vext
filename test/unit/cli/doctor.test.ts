import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { doctorCommand } from "../../../src/cli/doctor.js";

const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

async function writeProjectFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(rootDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

describe("doctorCommand", () => {
  let projectRoot: string;

  afterEach(async () => {
    consoleLog.mockClear();
    consoleWarn.mockClear();
    consoleError.mockClear();

    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("prints help output", async () => {
    await doctorCommand(["--help"]);

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Usage: vext doctor <target> [options]"),
    );
  });

  it("rejects missing and flag-shaped root option values", async () => {
    await expect(doctorCommand(["routes", "--root"])).rejects.toThrow(
      '[vextjs] Option "--root" requires a value: <path>',
    );
    await expect(doctorCommand(["routes", "-C"])).rejects.toThrow(
      '[vextjs] Option "-C" requires a value: <path>',
    );
    await expect(doctorCommand(["routes", "--root", "--json"])).rejects.toThrow(
      '[vextjs] Option "--root" requires a value: <path>; received option-like value "--json"',
    );

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("outputs JSON diagnostics for static route metadata checks", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-doctor-"));

    await writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify({ name: "doctor-json", type: "module" }, null, 2),
    );
    await writeProjectFile(
      projectRoot,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts", "src/**/*.d.ts"],
        },
        null,
        2,
      ),
    );
    await writeProjectFile(
      projectRoot,
      "src/config/default.ts",
      "export default { port: 3000 }\n",
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/users.ts",
      `import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/", {
    docs: {
      summary: "List users",
      operationId: "listUsers",
      tags: ["users"],
    },
  }, async (_req, res) => {
    res.json([]);
  });
});
`,
    );

    await doctorCommand(["routes", "--root", projectRoot, "--json"]);

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.ok).toBe(true);
    expect(payload.routeCount).toBe(1);
    expect(payload.summary.warnings).toBe(0);
    expect(payload.summary.infos).toBe(1);
    expect(payload.diagnostics[0]?.code).toBe("deprecated-docs-tags");
    expect(payload.diagnostics[0]?.suggestedValue).toBeUndefined();
  });

  it("writes inspect and manifest output for inferred operationIds", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-doctor-inspect-"));

    await writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify({ name: "doctor-inspect", type: "module" }, null, 2),
    );
    await writeProjectFile(
      projectRoot,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts", "src/**/*.d.ts"],
        },
        null,
        2,
      ),
    );
    await writeProjectFile(
      projectRoot,
      "src/config/default.ts",
      "export default { port: 3000 }\n",
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/users.ts",
      `import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/:id", {
    docs: {
      summary: "Get user detail",
      tags: ["users"],
    },
  }, async (_req, res) => {
    res.json({ ok: true });
  });
});
`,
    );

    await doctorCommand([
      "routes",
      "--root",
      projectRoot,
      "--json",
      "--write-inspect",
      "--write-manifest",
    ]);

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(payload.ok).toBe(true);
    expect(payload.summary.warnings).toBe(0);
    expect(payload.summary.infos).toBe(2);
    expect(payload.diagnostics[0]?.code).toBe("auto-operation-id");
    expect(payload.diagnostics[0]?.suggestedValue).toBe("getUsersById");
    expect(payload.diagnostics[1]?.code).toBe("deprecated-docs-tags");
    expect(payload.inspect?.status).toBe("written");
    expect(payload.manifest?.status).toBe("written");

    const inspectPayload = JSON.parse(
      await readFile(join(projectRoot, ".vext/inspect/routes.json"), "utf-8"),
    );
    expect(inspectPayload.routes[0]?.effectiveOperationId).toBe("getUsersById");
    expect(inspectPayload.routes[0]?.operationIdSource).toBe("inferred");
    expect(inspectPayload.summary.byCode["auto-operation-id"]).toBe(1);

    const manifestPayload = JSON.parse(
      await readFile(join(projectRoot, ".vext/manifest/routes.json"), "utf-8"),
    );
    expect(manifestPayload.kind).toBe("routes-manifest");
    expect(manifestPayload.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifestPayload.sourceFiles).toEqual(["src/routes/users.ts"]);
    expect(manifestPayload.summary.inferredOperationIds).toBe(1);
    expect(manifestPayload.summary.explicitOperationIds).toBe(0);
    expect(manifestPayload.routes[0]?.operationId).toBe("getUsersById");
    expect(manifestPayload.routes[0]?.operationIdSource).toBe("inferred");
  });

  it("automatically rebuilds stale manifests and reserves stale reads for --manifest-only", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-doctor-fingerprint-"));
    await writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify({ name: "doctor-fingerprint", type: "module" }, null, 2),
    );
    await writeProjectFile(
      projectRoot,
      "src/config/default.js",
      "export default { port: 3000 };\n",
    );
    const routeSource = (
      routePath: string,
    ) => `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("${routePath}", { docs: { summary: "Probe" } }, handler);
});
`;
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      routeSource("/before"),
    );
    await doctorCommand([
      "routes",
      "--root",
      projectRoot,
      "--json",
      "--write-manifest",
    ]);
    const first = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(first.routes[0]?.path).toBe("/before");

    consoleLog.mockClear();
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      routeSource("/after"),
    );
    await doctorCommand(["routes", "--root", projectRoot, "--json"]);
    const current = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(current.routes[0]?.path).toBe("/after");
    expect(current.sourceFingerprint).not.toBe(first.sourceFingerprint);

    consoleLog.mockClear();
    await doctorCommand([
      "routes",
      "--root",
      projectRoot,
      "--json",
      "--manifest-only",
    ]);
    const snapshot = JSON.parse(String(consoleLog.mock.calls[0]?.[0] ?? "{}"));
    expect(snapshot.routes[0]?.path).toBe("/before");

    await expect(
      doctorCommand([
        "routes",
        "--root",
        projectRoot,
        "--refresh",
        "--manifest-only",
      ]),
    ).rejects.toThrow(/mutually exclusive/u);
  });
});
