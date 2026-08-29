import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { typegenCommand } from "../../../src/cli/typegen.js";

const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

const FIXTURES_DIR = join(process.cwd(), "test", "fixtures", "typegen");
const GOLDEN_DIR = join(process.cwd(), "test", "golden", "typegen");
const SERVICE_SUPPORT_FIXTURE = join(
  process.cwd(),
  "test",
  "fixtures",
  "service-support-boundaries",
);

async function makeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) await makeTreeWritable(entryPath);
      else await chmod(entryPath, 0o600);
    }),
  );
  await chmod(root, 0o700);
}

async function copyFixtureToTemp(fixtureName: string): Promise<string> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), `vext-typegen-${fixtureName}-`),
  );
  const projectRoot = join(tempRoot, "project");
  await cp(join(FIXTURES_DIR, fixtureName), projectRoot, { recursive: true });
  await makeTreeWritable(projectRoot);
  return projectRoot;
}

async function copyServiceSupportFixtureToTemp(): Promise<string> {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "vext-typegen-service-support-"),
  );
  await cp(join(SERVICE_SUPPORT_FIXTURE, "src"), join(projectRoot, "src"), {
    recursive: true,
  });
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "service-support-boundaries", type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    join(projectRoot, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { module: "NodeNext" } }, null, 2)}\n`,
  );
  await mkdir(join(projectRoot, "src", "config"), { recursive: true });
  await writeFile(
    join(projectRoot, "src", "config", "default.ts"),
    "export default { port: 3000 };\n",
  );
  await makeTreeWritable(projectRoot);
  return projectRoot;
}

async function readNormalized(filePath: string): Promise<string> {
  return (await readFile(filePath, "utf-8")).replace(/\r\n/g, "\n").trimEnd();
}

describe("typegenCommand", () => {
  let projectRoot: string;

  afterEach(async () => {
    consoleLog.mockClear();
    consoleWarn.mockClear();
    consoleError.mockClear();

    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("matches golden outputs for the TypeScript fixture and ignores app.extend outside plugin lifecycles", async () => {
    projectRoot = await copyFixtureToTemp("ts-basic");

    await typegenCommand(["--root", projectRoot, "--write-manifest"]);

    const servicesGenerated = await readNormalized(
      join(projectRoot, ".vext/types/services.generated.d.ts"),
    );
    const appExtensionsGenerated = await readNormalized(
      join(projectRoot, ".vext/types/app-extensions.generated.d.ts"),
    );
    const expectedServices = await readNormalized(
      join(GOLDEN_DIR, "ts-basic", "services.generated.d.ts"),
    );
    const expectedAppExtensions = await readNormalized(
      join(GOLDEN_DIR, "ts-basic", "app-extensions.generated.d.ts"),
    );
    const servicesManifest = await readNormalized(
      join(projectRoot, ".vext/manifest/services.json"),
    );
    const shimGenerated = await readNormalized(
      join(projectRoot, "src/types/generated/index.d.ts"),
    );
    const expectedServicesManifest = await readNormalized(
      join(GOLDEN_DIR, "ts-basic", "services.manifest.json"),
    );

    expect(servicesGenerated).toBe(expectedServices);
    expect(servicesGenerated).toContain(
      '"2026Report": import("../../src/services/2026-report.js").default;',
    );
    expect(servicesGenerated).toContain(
      '"default": import("../../src/services/default.js").default;',
    );
    expect(servicesGenerated).toContain(
      '"stripe.v2": import("../../src/services/payment/stripe.v2.js").default;',
    );
    expect(appExtensionsGenerated).toBe(expectedAppExtensions);
    expect(appExtensionsGenerated).toContain(
      '"dash-key": typeof import("../../src/plugins/mailer.js").appExtensions["dash-key"];',
    );
    expect(appExtensionsGenerated).toContain(
      '"default": typeof import("../../src/plugins/mailer.js").appExtensions["default"];',
    );
    expect(appExtensionsGenerated).toContain(
      '"metrics.v2": typeof import("../../src/plugins/mailer.js").appExtensions["metrics.v2"];',
    );
    expect(appExtensionsGenerated).not.toContain("bad-key");
    expect(servicesManifest).toBe(expectedServicesManifest);
    expect(shimGenerated).toContain(".vext/types/services.generated.d.ts");
    expect(shimGenerated).toContain(
      ".vext/types/app-extensions.generated.d.ts",
    );
    expect(appExtensionsGenerated).not.toContain("ignoredOutsideLifecycle");
  });

  it("matches golden outputs for the JavaScript fixture with graceful fallback", async () => {
    projectRoot = await copyFixtureToTemp("js-basic");

    await typegenCommand(["--root", projectRoot]);

    const servicesGenerated = await readNormalized(
      join(projectRoot, ".vext/types/services.generated.d.ts"),
    );
    const appExtensionsGenerated = await readNormalized(
      join(projectRoot, ".vext/types/app-extensions.generated.d.ts"),
    );
    const expectedServices = await readNormalized(
      join(GOLDEN_DIR, "js-basic", "services.generated.d.ts"),
    );
    const expectedAppExtensions = await readNormalized(
      join(GOLDEN_DIR, "js-basic", "app-extensions.generated.d.ts"),
    );

    expect(servicesGenerated).toBe(expectedServices);
    expect(appExtensionsGenerated).toBe(expectedAppExtensions);
    await expect(
      readFile(join(projectRoot, "src/types/generated/index.d.ts"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("indexes only the service owner from the service support boundaries fixture", async () => {
    projectRoot = await copyServiceSupportFixtureToTemp();

    await typegenCommand([
      "--root",
      projectRoot,
      "--services",
      "--write-manifest",
    ]);

    const servicesGenerated = await readNormalized(
      join(projectRoot, ".vext/types/services.generated.d.ts"),
    );
    const servicesManifest = JSON.parse(
      await readFile(
        join(projectRoot, ".vext/manifest/services.json"),
        "utf-8",
      ),
    ) as {
      serviceCount: number;
      services: Array<{ serviceKey: string; fileRelativePath: string }>;
    };

    expect(servicesGenerated).toContain(
      'order: import("../../src/services/order.js").default;',
    );
    expect(servicesGenerated).not.toContain("types/server/services");
    expect(servicesGenerated).not.toContain("types/shared");
    expect(servicesGenerated).not.toContain("constants/services");
    expect(servicesManifest.serviceCount).toBe(1);
    expect(servicesManifest.services).toEqual([
      {
        serviceKey: "order",
        keySegments: ["order"],
        fileRelativePath: "src/services/order.ts",
        importPath: "../../src/services/order.js",
      },
    ]);
  });

  it("falls back to unknown when multiple plugins extend the same key with conflicting types", async () => {
    projectRoot = await copyFixtureToTemp("conflict-case");

    await typegenCommand(["--root", projectRoot, "--app-extensions"]);

    const appExtensionsGenerated = await readNormalized(
      join(projectRoot, ".vext/types/app-extensions.generated.d.ts"),
    );
    const expectedAppExtensions = await readNormalized(
      join(GOLDEN_DIR, "conflict-case", "app-extensions.generated.d.ts"),
    );

    expect(appExtensionsGenerated).toBe(expectedAppExtensions);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Conflicting inferred types for app.extend("shared")',
      ),
    );
  });

  it("fails in --check mode when generated files are stale", async () => {
    projectRoot = await copyFixtureToTemp("ts-basic");
    const generatedFilePath = join(
      projectRoot,
      ".vext/types/services.generated.d.ts",
    );
    await mkdir(dirname(generatedFilePath), { recursive: true });
    await writeFile(generatedFilePath, "// stale file\n", "utf-8");

    await expect(
      typegenCommand(["--root", projectRoot, "--services", "--check"]),
    ).rejects.toThrow(/typegen found blocking issues/);
  });

  it("rejects unknown positional arguments in text mode", async () => {
    await expect(typegenCommand(["extra"])).rejects.toThrow(
      '[vextjs] Unknown argument: "extra"',
    );

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("rejects unknown positional arguments in JSON mode", async () => {
    await expect(typegenCommand(["--json", "extra"])).rejects.toThrow(
      '[vextjs] Unknown argument: "extra"',
    );

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("rejects missing and flag-shaped --root values", async () => {
    await expect(typegenCommand(["--root"])).rejects.toThrow(
      '[vextjs] Option "--root" requires a value: <path>',
    );
    await expect(typegenCommand(["-C"])).rejects.toThrow(
      '[vextjs] Option "-C" requires a value: <path>',
    );
    await expect(typegenCommand(["--root", "--json"])).rejects.toThrow(
      '[vextjs] Option "--root" requires a value: <path>; received option-like value "--json"',
    );

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
