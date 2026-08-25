import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadPlugins } from "../../src/lib/plugin-loader.js";
import { createHookManager } from "../../src/lib/hooks.js";
import { createApp, DEFAULT_CONFIG } from "../../src/lib/app.js";

describe("plugin-loader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("preloads import-only packages from the plugin project's node_modules", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-plugin-loader-"),
    );
    tempDirs.push(projectRoot);

    const pluginsDir = path.join(projectRoot, ".vext", "dev", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });

    const esmPkgDir = path.join(projectRoot, "node_modules", "esm-only-pkg");
    fs.mkdirSync(esmPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(esmPkgDir, "package.json"),
      JSON.stringify(
        {
          name: "esm-only-pkg",
          type: "module",
          exports: {
            ".": {
              import: "./index.js",
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(esmPkgDir, "index.js"),
      "export const value = 42;\n",
    );

    fs.writeFileSync(
      path.join(pluginsDir, "esm-only-plugin.js"),
      [
        '"use strict";',
        'const esmOnly = require("esm-only-pkg");',
        "module.exports = {",
        '  name: "esm-only-plugin",',
        "  async setup(app) {",
        '    app.extend("esmOnlyValue", esmOnly.value);',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const extensions: Record<string, unknown> = {};
    const app = {
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hooks: createHookManager(),
      extend(key: string, value: unknown) {
        extensions[key] = value;
      },
      onReady: () => {},
      onClose: () => {},
    } as any;

    await loadPlugins(app, pluginsDir, { setupTimeout: 1_000 });

    expect(extensions.esmOnlyValue).toBe(42);
  });

  it("isolates import-only packages by project and restores Module._load", async () => {
    const testRequire = createRequire(import.meta.url);
    const Module = testRequire("node:module") as {
      _load: (...args: unknown[]) => unknown;
    };
    const originalLoad = Module._load;
    const extensions: Record<string, unknown> = {};

    const loadProject = async (label: string, value: string) => {
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `vext-plugin-${label}-`),
      );
      tempDirs.push(projectRoot);
      const pluginsDir = path.join(projectRoot, ".vext", "dev", "plugins");
      const esmPkgDir = path.join(projectRoot, "node_modules", "shared-esm");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.mkdirSync(esmPkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(esmPkgDir, "package.json"),
        JSON.stringify({
          name: "shared-esm",
          type: "module",
          exports: { ".": { import: "./index.js" } },
        }),
      );
      fs.writeFileSync(
        path.join(esmPkgDir, "index.js"),
        `export const value = ${JSON.stringify(value)};\n`,
      );
      fs.writeFileSync(
        path.join(pluginsDir, `${label}.js`),
        [
          'const dependency = require("shared-esm");',
          "module.exports = {",
          `  name: ${JSON.stringify(label)},`,
          "  setup(app) {",
          `    app.extend(${JSON.stringify(label)}, dependency.value);`,
          "  },",
          "};",
        ].join("\n"),
      );

      const app = {
        config: {},
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        hooks: createHookManager(),
        extend(key: string, nextValue: unknown) {
          extensions[key] = nextValue;
        },
        onReady: () => {},
        onClose: () => {},
      } as any;
      await loadPlugins(app, pluginsDir, { setupTimeout: 1_000 });
      expect(Module._load).toBe(originalLoad);
    };

    await loadProject("project-a", "A-1.0.0");
    await loadProject("project-b", "B-2.0.0");

    expect(extensions["project-a"]).toBe("A-1.0.0");
    expect(extensions["project-b"]).toBe("B-2.0.0");
    expect(Module._load).toBe(originalLoad);
  });

  it("preloads import-only package subpaths from the plugin project's node_modules", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-plugin-loader-"),
    );
    tempDirs.push(projectRoot);

    const pluginsDir = path.join(projectRoot, ".vext", "dev", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });

    const esmPkgDir = path.join(projectRoot, "node_modules", "esm-only-pkg");
    fs.mkdirSync(esmPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(esmPkgDir, "package.json"),
      JSON.stringify(
        {
          name: "esm-only-pkg",
          type: "module",
          exports: {
            "./subpath": {
              import: "./subpath.js",
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(esmPkgDir, "subpath.js"),
      "export const subpathValue = 84;\n",
    );

    fs.writeFileSync(
      path.join(pluginsDir, "esm-only-subpath-plugin.js"),
      [
        '"use strict";',
        'const subpath = require("esm-only-pkg/subpath");',
        "module.exports = {",
        '  name: "esm-only-subpath-plugin",',
        "  async setup(app) {",
        '    app.extend("esmOnlySubpathValue", subpath.subpathValue);',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const extensions: Record<string, unknown> = {};
    const app = {
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hooks: createHookManager(),
      extend(key: string, value: unknown) {
        extensions[key] = value;
      },
      onReady: () => {},
      onClose: () => {},
    } as any;

    await loadPlugins(app, pluginsDir, { setupTimeout: 1_000 });

    expect(extensions.esmOnlySubpathValue).toBe(84);
  });

  it("emits plugin setup hooks around user plugin setup", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-plugin-loader-"),
    );
    tempDirs.push(projectRoot);

    const pluginsDir = path.join(projectRoot, "src", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "observed.js"),
      [
        "export default {",
        '  name: "observed",',
        "  setup(app) {",
        '    app.extend("observed", true);',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const extensions: Record<string, unknown> = {};
    const hooks = createHookManager();
    const before = vi.fn();
    const after = vi.fn();
    hooks.on("plugin:beforeSetup", before);
    hooks.on("plugin:afterSetup", after);
    const app = {
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hooks,
      extend(key: string, value: unknown) {
        extensions[key] = value;
      },
      onReady: () => {},
      onClose: () => {},
    } as any;

    await loadPlugins(app, pluginsDir, { setupTimeout: 1_000 });

    expect(extensions.observed).toBe(true);
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: "observed",
        sourceFile: expect.stringContaining("observed.js"),
      }),
    );
    expect(after).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: "observed",
        sourceFile: expect.stringContaining("observed.js"),
        durationMs: expect.any(Number),
      }),
    );
  });

  it("records optional startup profiler events without changing plugin loading", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-plugin-loader-"),
    );
    tempDirs.push(projectRoot);

    const pluginsDir = path.join(projectRoot, "src", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "observed.js"),
      [
        "export default {",
        '  name: "observed",',
        "  setup(app) {",
        '    app.extend("observed", true);',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const extensions: Record<string, unknown> = {};
    const recorded: Array<{ name: string; phase?: string }> = [];
    const startupProfiler = {
      enabled: true,
      async time<T>(
        name: string,
        action: () => Promise<T> | T,
        options?: { phase?: string },
      ): Promise<T> {
        recorded.push({ name, phase: options?.phase });
        return await action();
      },
      mark: vi.fn(),
      toJSON: vi.fn(),
    };
    const app = {
      config: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hooks: createHookManager(),
      extend(key: string, value: unknown) {
        extensions[key] = value;
      },
      onReady: () => {},
      onClose: () => {},
    } as any;

    await loadPlugins(app, pluginsDir, {
      setupTimeout: 1_000,
      startupProfiler: startupProfiler as any,
    });

    expect(extensions.observed).toBe(true);
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "worker.plugins.scan" }),
        expect.objectContaining({
          name: "worker.plugins.import.observed.js",
          phase: "plugins",
        }),
        expect.objectContaining({ name: "worker.plugins.toposort" }),
        expect.objectContaining({
          name: "worker.plugins.setup.observed",
          phase: "plugins",
        }),
      ]),
    );
  });

  it("rolls back and revokes framework mutations when setup times out", async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-plugin-loader-"),
    );
    tempDirs.push(projectRoot);
    const pluginsDir = path.join(projectRoot, "src", "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "late.js"),
      [
        "export default {",
        '  name: "late-plugin",',
        "  async setup(app, { signal }) {",
        '    app.extend("partialExtension", { signal });',
        "    app.use(async (_req, _res, next) => next());",
        "    await new Promise((resolve) => setTimeout(resolve, 40));",
        '    app.extend("lateExtension", true);',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const { app, internals } = createApp(DEFAULT_CONFIG);

    internals.enterPluginSetup();
    try {
      await expect(
        loadPlugins(app, pluginsDir, { setupTimeout: 10 }),
      ).rejects.toThrow("setup() timed out");
    } finally {
      internals.exitPluginSetup();
    }

    expect(Object.hasOwn(app, "partialExtension")).toBe(false);
    expect(internals.getGlobalMiddlewares()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(Object.hasOwn(app, "lateExtension")).toBe(false);
  });
});
