import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDocsConfig } from "../../../src/lib/docs/index.js";
import {
  createCodeDocsProvider,
  loadCodeDocs,
} from "../../../src/lib/docs/sources/code-jsdoc-source.js";

const SERVICE_SUPPORT_FIXTURE = join(
  process.cwd(),
  "test",
  "fixtures",
  "service-support-boundaries",
  "src",
);

describe("loadCodeDocs", () => {
  let rootDir: string;
  let srcDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vext-code-docs-"));
    srcDir = join(rootDir, "src");
    await mkdir(join(srcDir, "services", "admin"), { recursive: true });
    await mkdir(join(srcDir, "utils"), { recursive: true });
    await mkdir(join(srcDir, "model", "tenant"), { recursive: true });
    await mkdir(join(srcDir, "frontend", "components"), { recursive: true });
    await mkdir(join(srcDir, "plugins"), { recursive: true });
    await mkdir(join(srcDir, "middlewares"), { recursive: true });
    await mkdir(join(srcDir, "locales", "common"), { recursive: true });
    await mkdir(join(srcDir, "frontend", "locales"), { recursive: true });
    await mkdir(join(srcDir, "config"), { recursive: true });
    await mkdir(join(srcDir, "frontend", "styles"), { recursive: true });
    await mkdir(join(rootDir, "preload"), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("loads code docs sources without importing files", async () => {
    await writeFile(
      join(srcDir, "services", "admin", "user-service.ts"),
      `
/**
 * User service.
 */
export class UserService {
  /**
   * List users.
   * @returns {Promise<Array>} Users.
   */
  async listUsers() {
    throw new Error("should not execute")
  }
}
`,
    );
    await writeFile(
      join(srcDir, "utils", "date.ts"),
      `
/**
 * Format a date.
 * @param {Date} value - Date value.
 */
export function formatDate(value: Date) {
  return value.toISOString()
}
`,
    );
    await writeFile(
      join(srcDir, "model", "tenant", "order.ts"),
      `
/**
 * Tenant order model.
 */
export default {
  name: "Order",
  collection: "orders",
  schema: (dsl: any) => dsl({
    orderNo: "string:1-64!",
    amount: "number:0-!",
    status: "string?"
  }),
  enums: {
    status: "draft|paid"
  },
  options: {
    timestamps: true
  },
  indexes: [
    { key: { orderNo: 1 }, unique: true }
  ]
}
`,
    );
    await writeFile(
      join(srcDir, "frontend", "components", "app-shell.tsx"),
      `
/**
 * Application shell component.
 * @param {object} props - Component props.
 */
export function AppShell(props: { children?: unknown }) {
  return props.children
}
`,
    );
    await writeFile(
      join(srcDir, "plugins", "hello.ts"),
      `
/**
 * Hello plugin.
 */
export default definePlugin({
  name: "hello",
  dependencies: ["database"],
  setup(app) {
    app.extend("hello", { greeting: () => "hi" })
    app.use(async (_req, _res, next) => next())
  },
  onReady() {},
  onClose() {}
})
`,
    );
    await writeFile(
      join(srcDir, "middlewares", "check-role.ts"),
      `
/**
 * Check role middleware.
 */
export default defineMiddlewareFactory<{ roles: string[] }>((options) => {
  return async (_req, _res, next) => next()
})
`,
    );
    await writeFile(
      join(srcDir, "locales", "common", "en-US.ts"),
      `
export default {
  "user.name": "Name",
  submit: "Submit"
}
`,
    );
    await writeFile(
      join(srcDir, "frontend", "locales", "en-US.ts"),
      `
export default {
  title: "Dashboard"
}
`,
    );
    await writeFile(
      join(srcDir, "config", "default.ts"),
      `
export default {
  port: 3000,
  logger: {
    level: "info"
  }
}
`,
    );
    await writeFile(
      join(rootDir, "preload", "bootstrap.ts"),
      `
export function bootstrap() {
  return true
}
`,
    );
    await writeFile(
      join(srcDir, "frontend", "styles", "dashboard.style.ts"),
      `
export const dashboardRoot = "dashboard-root"
`,
    );

    const docs = await loadCodeDocs({
      rootDir,
      srcDir,
      modelsDir: "model",
      config: normalizeDocsConfig({}),
    });

    expect(docs.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "service:admin.userService#UserService",
        "service:admin.userService#listUsers",
        "utils:date#formatDate",
        "model:TenantOrder#default",
        "component:app-shell#AppShell",
        "plugin:hello#default",
        "middleware:check-role#default",
      ]),
    );
    expect(docs.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining([
        "locale:common/en-US#default",
        "locale:frontend/en-US#default",
        "config:default#default",
        "preload:bootstrap#file",
        "style:dashboard.style#file",
      ]),
    );
    expect(
      docs.items.find((item) => item.id === "utils:date#formatDate"),
    ).toMatchObject({
      kind: "utils",
      sourceFile: "utils/date.ts",
      sourceLocation: { file: "utils/date.ts", line: 2 },
      summary: "Format a date.",
    });
    expect(
      docs.items.find((item) => item.id === "model:TenantOrder#default"),
    ).toMatchObject({
      model: {
        registryKey: "TenantOrder",
        name: "Order",
        collection: "orders",
        connection: { database: "tenant" },
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: "orderNo",
            required: true,
            raw: "string:1-64!",
          }),
          expect.objectContaining({
            name: "amount",
            required: true,
            raw: "number:0-!",
          }),
        ]),
        enums: [{ name: "status", values: ["draft", "paid"] }],
        options: [{ name: "timestamps", value: "true" }],
        indexes: [
          expect.objectContaining({
            keys: "{ orderNo: 1 }",
            unique: true,
          }),
        ],
        usage: 'const Model = app.db.use("tenant").model("Order");',
      },
    });
    expect(
      docs.items.find((item) => item.id === "plugin:hello#default"),
    ).toMatchObject({
      kind: "plugin",
      title: "plugins.hello",
      plugin: {
        name: "hello",
        dependencies: ["database"],
        lifecycle: { setup: true, onReady: true, onClose: true },
        extensions: ["hello"],
        globalMiddlewares: true,
      },
    });
    expect(
      docs.items.find((item) => item.id === "middleware:check-role#default"),
    ).toMatchObject({
      kind: "middleware",
      title: "middlewares.check-role",
      middleware: {
        name: "check-role",
        type: "factory",
        usage: 'middlewares: [{ name: "check-role", options: { /* ... */ } }]',
      },
    });
  });

  it("projects only the service owner from the service support boundaries fixture", async () => {
    await cp(SERVICE_SUPPORT_FIXTURE, srcDir, { recursive: true });

    const docs = await loadCodeDocs({
      rootDir,
      srcDir,
      modelsDir: "models",
      config: normalizeDocsConfig({}),
    });
    const serviceItems = docs.items.filter((item) => item.kind === "service");

    expect(serviceItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "service:order#default",
        "service:order#currentStatus",
        "service:order#findById",
      ]),
    );
    expect([...new Set(serviceItems.map((item) => item.sourceFile))]).toEqual([
      "services/order.ts",
    ]);
    expect(docs.items.map((item) => item.sourceFile).join("\n")).not.toMatch(
      /(?:^|\/)(?:types|constants)\//u,
    );
  });

  it("loads optional static docs sources when explicitly enabled", async () => {
    await writeFile(
      join(srcDir, "locales", "common", "en-US.ts"),
      `
export default {
  "user.name": "Name",
  submit: "Submit"
}
`,
    );
    await writeFile(
      join(srcDir, "frontend", "locales", "en-US.ts"),
      `
export default {
  title: "Dashboard"
}
`,
    );
    await writeFile(
      join(srcDir, "config", "default.ts"),
      `
export default {
  port: 3000,
  logger: {
    level: "info"
  }
}
`,
    );
    await writeFile(
      join(rootDir, "preload", "bootstrap.ts"),
      `
export function bootstrap() {
  return true
}
`,
    );
    await writeFile(
      join(srcDir, "frontend", "styles", "dashboard.style.ts"),
      `
export const dashboardRoot = "dashboard-root"
`,
    );

    const docs = await loadCodeDocs({
      rootDir,
      srcDir,
      modelsDir: "model",
      config: normalizeDocsConfig({
        docs: {
          code: {
            services: false,
            utils: false,
            models: false,
            components: false,
            plugins: false,
            middlewares: false,
            locales: true,
            config: true,
            preload: true,
            styles: true,
          },
        },
      }),
    });

    expect(docs.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "locale:common/en-US#default",
        "locale:frontend/en-US#default",
        "config:default#default",
        "preload:bootstrap#file",
        "style:dashboard.style#file",
      ]),
    );
    expect(
      docs.items.find((item) => item.id === "locale:common/en-US#default"),
    ).toMatchObject({
      kind: "locale",
      sourceFile: "locales/common/en-US.ts",
      summary: "Backend locale resource for en-US.",
    });
    expect(
      docs.items.find((item) => item.id === "locale:frontend/en-US#default"),
    ).toMatchObject({
      kind: "locale",
      sourceFile: "frontend/locales/en-US.ts",
      summary: "Frontend locale resource for en-US.",
    });
    expect(
      docs.items.find((item) => item.id === "config:default#default"),
    ).toMatchObject({
      kind: "config",
      sourceFile: "config/default.ts",
      description: expect.stringContaining("logger"),
    });
    expect(
      docs.items.find((item) => item.id === "preload:bootstrap#file"),
    ).toMatchObject({
      kind: "preload",
      sourceFile: "preload/bootstrap.ts",
      description: expect.stringContaining("bootstrap"),
    });
    expect(
      docs.items.find((item) => item.id === "style:dashboard.style#file"),
    ).toMatchObject({
      kind: "style",
      sourceFile: "frontend/styles/dashboard.style.ts",
      description: expect.stringContaining("dashboardRoot"),
    });
  });

  it("uses MonSQLize model loader scan and depth rules", async () => {
    await mkdir(join(srcDir, "models", "a", "b", "c"), { recursive: true });
    await writeFile(
      join(srcDir, "models", "_base.ts"),
      `
/**
 * Base model.
 */
export default {}
`,
    );
    await writeFile(
      join(srcDir, "models", "a", "b", "c", "too-deep.ts"),
      `
/**
 * Too deep model.
 */
export default {}
`,
    );
    await writeFile(
      join(srcDir, "models", "a", "order.ts"),
      `
/**
 * Order model.
 */
export default {}
`,
    );
    await writeFile(
      join(srcDir, "models", "log-entry.ts"),
      `export default {}`,
    );

    const docs = await loadCodeDocs({
      rootDir,
      srcDir,
      config: normalizeDocsConfig({
        docs: {
          code: {
            services: false,
            utils: false,
            models: true,
          },
        },
      }),
    });

    expect(docs.items.map((item) => item.id)).toEqual([
      "model:AOrder#default",
      "model:LogEntry#default",
    ]);
    expect(
      docs.items.find((item) => item.id === "model:LogEntry#default"),
    ).toMatchObject({
      sourceFile: "models/log-entry.ts",
      summary: "Model entry for models.LogEntry.",
    });
  });

  it("prefers root src for JSDoc when runtime srcDir points to built output", async () => {
    const distDir = join(rootDir, "dist");
    await mkdir(join(distDir, "utils"), { recursive: true });
    await mkdir(join(distDir, "models"), { recursive: true });
    await mkdir(join(srcDir, "models"), { recursive: true });
    await writeFile(
      join(distDir, "utils", "date.js"),
      `export function formatDate(value) { return String(value) }`,
    );
    await writeFile(
      join(distDir, "models", "product.js"),
      `module.exports = {}`,
    );
    await writeFile(
      join(srcDir, "utils", "date.ts"),
      `
/**
 * Format a source date.
 */
export function formatDate(value: Date) {
  return value.toISOString()
}
`,
    );
    await writeFile(
      join(srcDir, "models", "product.ts"),
      `
/**
 * Source product model.
 */
export default {}
`,
    );

    const docs = await loadCodeDocs({
      rootDir,
      srcDir: distDir,
      config: normalizeDocsConfig({
        docs: {
          code: {
            services: false,
            utils: true,
            models: true,
          },
        },
      }),
    });

    expect(docs.items.map((item) => item.id)).toEqual([
      "utils:date#formatDate",
      "model:Product#default",
    ]);
    expect(docs.items[0]).toMatchObject({
      sourceFile: "utils/date.ts",
      summary: "Format a source date.",
    });
  });

  it("returns empty docs when code docs are disabled", async () => {
    await writeFile(
      join(srcDir, "utils", "date.ts"),
      `
/**
 * Format a date.
 */
export function formatDate() {}
`,
    );

    const docs = await loadCodeDocs({
      rootDir,
      srcDir,
      config: normalizeDocsConfig({ docs: { code: { enabled: false } } }),
    });

    expect(docs.items).toEqual([]);
  });

  it("rescans source files on each lazy provider call", async () => {
    const file = join(srcDir, "utils", "date.ts");
    await writeFile(
      file,
      `
/**
 * Format the original date.
 */
export function formatDate() {}
`,
    );
    const provider = createCodeDocsProvider({
      rootDir,
      srcDir,
      config: normalizeDocsConfig({
        docs: {
          code: {
            services: false,
            utils: true,
            models: false,
            components: false,
            plugins: false,
            middlewares: false,
            scan: "lazy",
          },
        },
      }),
    });

    const first = await provider();
    expect(first.items[0]).toMatchObject({
      id: "utils:date#formatDate",
      summary: "Format the original date.",
    });

    await writeFile(
      file,
      `
/**
 * Format the refreshed date.
 */
export function formatDate() {}
`,
    );

    const second = await provider();
    expect(second.items[0]).toMatchObject({
      id: "utils:date#formatDate",
      summary: "Format the refreshed date.",
    });
  });

  it("warms and reuses a background provider snapshot", async () => {
    const file = join(srcDir, "utils", "date.ts");
    await writeFile(
      file,
      `
/**
 * Format the warmed date.
 */
export function formatDate() {}
`,
    );
    const provider = createCodeDocsProvider({
      rootDir,
      srcDir,
      config: normalizeDocsConfig({
        docs: {
          code: {
            services: false,
            utils: true,
            models: false,
            components: false,
            plugins: false,
            middlewares: false,
            scan: "background",
          },
        },
      }),
    });

    const first = await provider();
    expect(first.items[0]).toMatchObject({
      id: "utils:date#formatDate",
      summary: "Format the warmed date.",
    });

    await writeFile(
      file,
      `
/**
 * Format the later date.
 */
export function formatDate() {}
`,
    );

    const second = await provider();
    expect(second).toBe(first);
    expect(second.items[0]).toMatchObject({
      id: "utils:date#formatDate",
      summary: "Format the warmed date.",
    });
  });

  it("documents code docs scan lifecycle in config guides", async () => {
    for (const file of [
      "website/docs/en/api/config.md",
      "website/docs/zh/api/config.md",
      "website/docs/en/guide/configuration.md",
      "website/docs/zh/guide/configuration.md",
    ]) {
      const content = await readFile(file, "utf8");
      expect(content).toContain("docs.code.scan");
      expect(content).toContain("background");
      expect(content).toContain("lazy");
    }
  });
});
