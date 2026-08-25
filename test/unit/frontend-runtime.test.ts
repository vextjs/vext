import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import * as ts from "typescript";
import { describe, expect, it, afterEach } from "vitest";
import { resolveFrontendConfig } from "../../src/frontend/tooling/config-resolver.js";
import {
  assertClientContractMatchesRouteManifest,
  buildClientContract,
  writeClientContractFromRouteManifest,
} from "../../src/frontend/tooling/client-contract-writer.js";
import { buildFrontendClient } from "../../src/frontend/tooling/client-build-compiler.js";
import { buildFrontendDeployManifest } from "../../src/frontend/deploy/manifest.js";
import { writeFrontendMediaArtifacts } from "../../src/frontend/tooling/media-artifact-writer.js";
import { createFrontendRenderMiddleware } from "../../src/frontend/runtime/renderer.js";
import { createFrontendDevEventBus } from "../../src/frontend/runtime/dev-events.js";
import {
  VextApiError,
  createVextApiClient,
  defineFont,
  deployFrontendAssets,
  isVextApiError,
} from "../../src/frontend/index.js";
import {
  assertFrontendOutputReady,
  createFrontendNotFoundHandler,
} from "../../src/frontend/runtime/static-mount.js";

const tempDirs: string[] = [];
const pendingStreams: Promise<void>[] = [];

afterEach(async () => {
  await Promise.allSettled(pendingStreams.splice(0));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("frontend config resolver", () => {
  it("defaults to disabled frontend", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(undefined, {
      rootDir,
      mode: "production",
    });

    expect(config.enabled).toBe(false);
    expect(config.framework).toBe("react");
    expect(config.root).toBe(path.join(rootDir, "src", "frontend"));
    expect(config.entry).toBe(
      path.join(rootDir, ".vext", "generated", "frontend", "browser-entry.tsx"),
    );
    expect(config.pages.dir).toBe(
      path.join(rootDir, "src", "frontend", "pages"),
    );
    expect(config.styles.jscss.enabled).toBe(true);
    expect(config.styles.jscss.files).toEqual([
      "**/*.style.ts",
      "**/*.style.js",
      "**/*.css.ts",
    ]);
    expect(config.styles.jscss.dynamicVars).toBe(true);
    expect(config.styles.jscss.recipes).toBe(true);
    expect(config.publicPath).toBe("/");
    expect(config.build.vendorChunks.enabled).toBe(true);
    expect(config.build.budgets.maxInitialJsGzipBytes).toBe(0);
    expect(config.build.budgets.maxInitialJsBrotliBytes).toBe(0);
    expect(config.build.budgets.maxRouteInitialJsBrotliBytes).toBe(0);
    expect(config.build.budgets.maxAppOwnedInitialJsBrotliBytes).toBe(0);
    expect(config.build.diagnostics.performanceReport).toBe(true);
    expect(config.render.streaming).toBe("buffered");
    expect(config.i18n.clientLoad).toBe("current");
    expect(config.deploy.upload.enabled).toBe(false);
    expect(config.deploy.upload.exclude).toEqual(["**/*.map"]);
  });

  it("normalizes enabled frontend paths inside project root", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(true, {
      rootDir,
      mode: "development",
    });

    expect(config.enabled).toBe(true);
    expect(config.outDir).toBe(path.join(rootDir, ".vext", "client"));
    expect(config.spaFallback.exclude).toEqual([
      "/api/**",
      "/openapi.json",
      "/docs/**",
      "/_vext/docs/**",
    ]);
    expect(config.spaFallback.scopes).toEqual([]);
    expect(config.dev.fastRefresh).toBe(true);
    expect(config.build.diagnostics.leakScan).toBe(true);
    expect(
      resolveFrontendConfig(
        { enabled: true, render: { streaming: "auto" } },
        { rootDir, mode: "development" },
      ).render.streaming,
    ).toBe("auto");
  });

  it("applies the shared browser target and allows a client override", async () => {
    const rootDir = await tempRoot();
    const inherited = resolveFrontendConfig(
      { enabled: true, build: { target: "es2020" } },
      { rootDir, mode: "production" },
    );
    const overridden = resolveFrontendConfig(
      {
        enabled: true,
        build: { target: "es2020", client: { target: "es2022" } },
      },
      { rootDir, mode: "production" },
    );

    expect(inherited.build.client.target).toEqual(["es2020"]);
    expect(inherited.build.server.target).toEqual(["node20"]);
    expect(overridden.build.client.target).toEqual(["es2022"]);
  });

  it("documents the default SPA fallback exclusions from the resolver", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(true, {
      rootDir,
      mode: "production",
    });
    const docs = await Promise.all([
      readFile(path.join("website", "docs", "en", "api", "config.md"), "utf-8"),
      readFile(path.join("website", "docs", "zh", "api", "config.md"), "utf-8"),
    ]);

    for (const exclude of config.spaFallback.exclude) {
      expect(docs[0]).toContain(exclude);
      expect(docs[1]).toContain(exclude);
    }
  });

  it("normalizes B1 frontend page, alias, i18n, and scoped fallback config", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        pages: { dir: "pages", document: "pages/_document.html" },
        alias: { "@features": "features" },
        i18n: {
          enabled: true,
          defaultLocale: "zh-CN",
          clientLoad: "all",
        },
        build: {
          client: {
            external: ["react"],
            externalRuntime: {
              react: "https://cdn.example.com/react.mjs",
            },
          },
          budgets: {
            maxTotalBytes: 1_000_000,
            maxInitialJsGzipBytes: 120_000,
            maxInitialJsBrotliBytes: 100_000,
            maxRouteInitialJsBrotliBytes: 80_000,
            maxAppOwnedInitialJsBrotliBytes: 70_000,
          },
          diagnostics: {
            performanceReport: false,
          },
        },
        deploy: {
          assetBaseUrl: "https://cdn.example.com/app",
          upload: {
            enabled: true,
            targetDir: ".deploy/cdn",
            prefix: "v1",
          },
        },
        spaFallback: {
          scopes: [{ basePath: "/admin/app", page: "admin/app/shell" }],
        },
      },
      { rootDir, mode: "production" },
    );

    expect(config.pages.document).toBe(
      path.join(rootDir, "src", "frontend", "pages", "_document.html"),
    );
    expect(config.alias["@components"]).toBe(
      path.join(rootDir, "src", "frontend", "components"),
    );
    expect(config.alias["@features"]).toBe(
      path.join(rootDir, "src", "frontend", "features"),
    );
    expect(config.i18n.enabled).toBe(true);
    expect(config.i18n.defaultLocale).toBe("zh-CN");
    expect(config.i18n.clientLoad).toBe("all");
    expect(config.build.budgets.maxInitialJsGzipBytes).toBe(120_000);
    expect(config.build.budgets.maxInitialJsBrotliBytes).toBe(100_000);
    expect(config.build.budgets.maxRouteInitialJsBrotliBytes).toBe(80_000);
    expect(config.build.budgets.maxAppOwnedInitialJsBrotliBytes).toBe(70_000);
    expect(config.build.diagnostics.performanceReport).toBe(false);
    expect(config.deploy.assetBaseUrl).toBe("https://cdn.example.com/app/");
    expect(config.build.client.externalRuntime.react.url).toBe(
      "https://cdn.example.com/react.mjs",
    );
    expect(config.deploy.upload.enabled).toBe(true);
    expect(config.deploy.upload.prefix).toBe("v1");
    expect(config.spaFallback.scopes[0]).toMatchObject({
      basePath: "/admin/app/",
      page: "admin/app/shell",
      ssr: false,
      status: 200,
    });
  });

  it("rejects paths outside project root", async () => {
    const rootDir = await tempRoot();

    expect(() =>
      resolveFrontendConfig(
        { enabled: true, outDir: "../outside" },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.outDir");
  });

  it("rejects destructive frontend output roots and traversal-capable build paths", async () => {
    const rootDir = await tempRoot();

    expect(() =>
      resolveFrontendConfig(
        { enabled: true, outDir: "src" },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.outDir");

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: { client: { assetsDir: "../../outside" } },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.client.assetsDir");

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: { client: { entryNames: "../../[name]-[hash]" } },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.client.entryNames");

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: {
            server: { outFile: path.join(rootDir, "..", "renderer.cjs") },
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.server.outFile");
  });

  it("rejects invalid i18n clientLoad values", async () => {
    const rootDir = await tempRoot();

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          i18n: { clientLoad: "lazy" as any },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow('config.frontend.i18n.clientLoad must be "current" or "all"');
  });

  it("rejects unsupported frontend build target fields before build", async () => {
    const rootDir = await tempRoot();

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: {
            client: { outFile: "dist/client/app.js" } as any,
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.client.outFile is not supported");

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: {
            client: { manifest: false } as any,
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.client.manifest is not supported");

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          build: {
            server: { manifest: false } as any,
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow("config.frontend.build.server.manifest is not supported");
  });
});

describe("frontend dev event bus", () => {
  it("serves Vext development events over SSE", async () => {
    const bus = createFrontendDevEventBus();
    let closeHandler: (() => void) | undefined;
    const chunks: string[] = [];
    const res = {
      headers: {} as Record<string, string>,
      streamType: "",
      setHeader(name: string, value: string) {
        this.headers[name] = value;
        return this;
      },
      stream(readable: NodeJS.ReadableStream, contentType: string) {
        this.streamType = contentType;
        readable.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk).toString("utf-8"));
        });
      },
    };

    await bus.middleware(
      {
        method: "GET",
        path: "/__vext/dev/events",
        onClose(handler: () => void) {
          closeHandler = handler;
        },
      } as any,
      res as any,
      async () => {
        throw new Error("next should not be called for dev SSE endpoint");
      },
    );

    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers.Connection).toBe("keep-alive");
    expect(res.streamType).toBe("text/event-stream; charset=utf-8");
    expect(bus.getClientCount()).toBe(1);

    bus.publish({
      type: "frontend:built",
      action: "fast-refresh",
      entry: "/assets/browser-entry.js",
      styles: ["/assets/browser-entry.css"],
      buildId: "dev-build",
    });
    await Promise.resolve();

    const frame = chunks.join("");
    expect(frame).toContain("retry: 500");
    expect(frame).toContain("event: vext");
    expect(frame).toContain('"type":"frontend:built"');
    expect(frame).toContain('"action":"fast-refresh"');

    closeHandler?.();
    expect(bus.getClientCount()).toBe(0);
    bus.close();
  });

  it("replays the latest frontend build event to late dev SSE clients", async () => {
    const bus = createFrontendDevEventBus();
    const chunks: string[] = [];
    let closeHandler: (() => void) | undefined;

    bus.publish({
      type: "frontend:built",
      action: "reload",
      entry: "/assets/browser-entry-next.js",
      styles: [],
      buildId: "late-build",
      files: ["src/frontend/locales/zh-CN.ts"],
    });

    await bus.middleware(
      {
        method: "GET",
        path: "/__vext/dev/events",
        onClose(handler: () => void) {
          closeHandler = handler;
        },
      } as any,
      {
        setHeader() {
          return this;
        },
        stream(readable: NodeJS.ReadableStream) {
          readable.on("data", (chunk) => {
            chunks.push(Buffer.from(chunk).toString("utf-8"));
          });
        },
      } as any,
      async () => {
        throw new Error("next should not be called for dev SSE endpoint");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    const frame = chunks.join("");
    expect(frame).toContain("retry: 500");
    expect(frame).toContain('"type":"frontend:built"');
    expect(frame).toContain('"replay":true');
    expect(frame).toContain('"entry":"/assets/browser-entry-next.js"');
    expect(frame).toContain("src/frontend/locales/zh-CN.ts");

    closeHandler?.();
    bus.close();
  });

  it("passes non-SSE requests to the next middleware", async () => {
    const bus = createFrontendDevEventBus();
    let nextCalled = false;

    await bus.middleware(
      { method: "GET", path: "/health" } as any,
      {} as any,
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(bus.getClientCount()).toBe(0);
    bus.close();
  });
});

describe("frontend client contract", () => {
  it("builds a public client contract from route manifest records", () => {
    const contract = buildClientContract({
      routes: [
        {
          method: "GET",
          path: "/api/hello",
          operationId: "getApiHello",
          docsSummary: "Hello",
          tags: ["example"],
        },
        {
          method: "GET",
          path: "/internal",
          operationId: "getInternal",
          hidden: true,
        },
      ],
    });

    expect(contract.kind).toBe("client-contract");
    expect(contract.routes).toHaveLength(1);
    expect(contract.routes[0]?.path).toBe("/api/hello");
  });

  it("keeps every supported route method in the public client contract", () => {
    const methods = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ] as const;
    const contract = buildClientContract({
      routes: methods.map((method) => ({
        method,
        path: `/api/${method.toLowerCase()}`,
        operationId: `${method.toLowerCase()}Api`,
      })),
    });

    expect(contract.routes.map((route) => route.method)).toEqual(methods);
  });

  it("writes byte-stable client contract artifacts for identical route manifests", async () => {
    const rootDir = await tempRoot();
    const manifestDir = path.join(rootDir, ".vext", "manifest");
    const outDir = path.join(rootDir, ".vext", "client");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "routes.json"),
      JSON.stringify(
        {
          routes: [
            {
              method: "GET",
              path: "/api/stable",
              operationId: "getApiStable",
              docsSummary: "Stable",
              tags: ["contract"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await writeClientContractFromRouteManifest({ rootDir, outDir });
    const firstContract = await readFile(
      path.join(outDir, "client-contract.json"),
      "utf-8",
    );
    const firstModule = await readFile(
      path.join(outDir, "api.generated.ts"),
      "utf-8",
    );

    await writeClientContractFromRouteManifest({ rootDir, outDir });

    expect(
      await readFile(path.join(outDir, "client-contract.json"), "utf-8"),
    ).toBe(firstContract);
    expect(await readFile(path.join(outDir, "api.generated.ts"), "utf-8")).toBe(
      firstModule,
    );
    expect(JSON.parse(firstContract).generatedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("projects route schema IR, status responses, diagnostics, and generated types", () => {
    const contract = buildClientContract({
      routes: [
        {
          method: "POST",
          path: "/users/:id",
          routeId: "route_create_user",
          operationId: "createUser",
          source: "src/routes/users.ts",
          schema: {
            schemaVersion: 1,
            request: {
              params: {
                schemaVersion: 1,
                kind: "vext-schema-ir",
                source: "validate",
                sourcePath: "validate.param",
                digest: "a".repeat(64),
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              },
              body: {
                schemaVersion: 1,
                kind: "vext-schema-ir",
                source: "validate",
                sourcePath: "validate.body",
                digest: "b".repeat(64),
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    nickname: { type: "string", nullable: true },
                    tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["name"],
                },
              },
            },
            responses: [
              {
                status: "201",
                contentType: "application/json",
                schema: {
                  schemaVersion: 1,
                  kind: "vext-schema-ir",
                  source: "docs.responses",
                  sourcePath: "docs.responses.201.schema",
                  digest: "c".repeat(64),
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      active: { type: "boolean" },
                    },
                    required: ["id", "active"],
                  },
                },
              },
              { status: "204", contentType: "text/plain" },
            ],
          },
        },
      ],
    });

    expect(contract.routes[0]).toMatchObject({
      routeId: "route_create_user",
      response: { type: "schema", schema: { digest: "c".repeat(64) } },
      responses: [
        {
          status: "201",
          contentType: "application/json",
          schema: { type: "schema" },
        },
        {
          status: "204",
          contentType: "text/plain",
          schema: { type: "unknown" },
        },
      ],
    });
    expect(contract.warnings).toContain(
      "POST /users/:id (src/routes/users.ts; route_create_user):204 has no runtime or documented response schema; emitted unknown.",
    );
    expect(contract.routeManifestDigest).toHaveLength(64);
    expect(contract.digest).toHaveLength(64);
  });

  it("selects a runtime 2xx family response as the generated success type", () => {
    const digest = "d".repeat(64);
    const contract = buildClientContract({
      routes: [
        {
          method: "GET",
          path: "/users",
          operationId: "getUsers",
          schema: {
            schemaVersion: 1,
            request: {},
            responses: [
              {
                status: "2xx",
                contentType: "application/json",
                schema: {
                  schemaVersion: 1,
                  kind: "vext-schema-ir",
                  source: "responses",
                  sourcePath: "responses.2xx.schema",
                  digest,
                  schema: {
                    type: "object",
                    properties: { id: { type: "integer" } },
                  },
                },
              },
            ],
          },
        },
      ],
    });

    expect(contract.routes[0]?.response).toMatchObject({
      type: "schema",
      schema: { digest },
    });
    expect(contract.warnings).toEqual([]);
  });

  it("keeps HTML frontend routes out of API response-schema warnings", () => {
    const contract = buildClientContract({
      routes: [
        {
          method: "GET",
          path: "/",
          routeId: "route_home",
          operationId: "getHome",
          source: "src/routes/index.ts",
          docsKind: "frontend-route",
        },
      ],
    });

    expect(contract.warnings).toEqual([]);
    expect(contract.routes[0]?.response).toEqual({
      type: "unknown",
      diagnostic:
        "GET / (src/routes/index.ts; route_home) renders an HTML document; emitted unknown.",
    });
  });

  it("rejects a client contract when the current route manifest has drifted", () => {
    const payload = {
      routes: [
        {
          method: "GET",
          path: "/api/contracts",
          operationId: "getContracts",
        },
      ],
    };
    const contract = buildClientContract(payload);

    expect(() =>
      assertClientContractMatchesRouteManifest(contract, {
        routes: [
          {
            method: "GET",
            path: "/api/contracts",
            operationId: "getContractsChanged",
          },
        ],
      }),
    ).toThrow("route manifest digest differs");
  });

  it("keeps frontend API client docs aligned with public exports", async () => {
    const docs = await Promise.all([
      readFile(
        path.join(
          process.cwd(),
          "website",
          "docs",
          "en",
          "frontend",
          "api-client-and-contracts.md",
        ),
        "utf-8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "website",
          "docs",
          "zh",
          "frontend",
          "api-client-and-contracts.md",
        ),
        "utf-8",
      ),
    ]);

    for (const content of docs) {
      expect(content).toContain("createVextApiClient");
      expect(content).not.toContain("createVextFetchAdapter");
    }
    expect(docs[0]).toContain("VextSchemaIRV1");
    expect(docs[0]).toContain("`$ref` values are retained in the contract");
    expect(docs[1]).toContain("VextSchemaIRV1");
    expect(docs[1]).toContain("`$ref` 会保留在契约中");
  });
});

describe("frontend client build", () => {
  it("writes bounded local image variants and fails closed for remote font descriptors", async () => {
    const rootDir = await tempRoot();
    const assetsDir = path.join(rootDir, "src", "frontend", "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, "hero.png"),
      await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 16, g: 32, b: 64, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    const config = resolveFrontendConfig(
      {
        enabled: true,
        media: {
          maxBytes: 64 * 1024,
          images: {
            widths: [1, 320],
            formats: ["original", "webp"],
            quality: 70,
            maxInputPixels: 4,
            maxVariants: 2,
          },
          fonts: { maxBytes: 64 * 1024 },
        },
      },
      { rootDir, mode: "production" },
    );
    await mkdir(config.outDir, { recursive: true });

    const result = await writeFrontendMediaArtifacts({
      rootDir,
      config,
      mode: "production",
    });
    expect(result.manifest.images).toHaveLength(1);
    expect(result.manifest.images[0]).toMatchObject({
      source: "assets/hero.png",
      width: 1,
      height: 1,
      originalFormat: "png",
    });
    expect(
      result.manifest.images[0]!.variants.map((variant) => variant.format),
    ).toEqual(["png", "webp"]);
    expect(
      result.manifest.images[0]!.variants.every(
        (variant) => variant.width === 1,
      ),
    ).toBe(true);
    expect(
      result.manifest.images[0]!.variants.every((variant) =>
        existsSync(path.join(config.outDir, variant.file)),
      ),
    ).toBe(true);

    await writeFile(
      path.join(rootDir, "src", "frontend", "fonts.ts"),
      'export const blocked = defineFont({ src: "https://fonts.example.test/font.ttf", family: "Blocked", license: "OFL-1.1" });\n',
    );
    await expect(
      writeFrontendMediaArtifacts({ rootDir, config, mode: "production" }),
    ).rejects.toThrow(/remote source/u);
  });

  it("rejects remote font declarations before they can become a build input", () => {
    expect(() =>
      defineFont({
        src: "https://fonts.example.test/font.ttf",
        family: "Blocked",
        license: "OFL-1.1",
      }),
    ).toThrow(/local font source/u);
  });

  it("injects bundled CSS and entry script into index.html", async () => {
    const rootDir = await tempRoot();
    const clientDir = path.join(rootDir, "src", "frontend", "entry");
    await mkdir(clientDir, { recursive: true });
    await writeFile(
      path.join(clientDir, "main.js"),
      'import "./styles.css";\ndocument.body.dataset.ready = "1";\n',
    );
    await writeFile(
      path.join(clientDir, "styles.css"),
      "body { color: red; }\n",
    );
    await writeFile(
      path.join(clientDir, "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        entry: "src/frontend/entry/main.js",
        indexHtml: "src/frontend/entry/index.html",
        apiClient: false,
      },
    });

    const html = await readFile(
      path.join(result.config.outDir, "index.html"),
      "utf-8",
    );
    expect(html).toMatch(
      /<link rel="stylesheet" href="\/assets\/main-[^"]+\.css" data-vext-style>/,
    );
    expect(html).toMatch(
      /<script type="module" src="\/assets\/main-[^"]+\.js" data-vext-entry><\/script>/,
    );
    expect(result.renderManifestPath).toBeDefined();
    expect(result.deployManifestPath).toBeDefined();
    expect(result.messagesManifestPath).toBeDefined();
    expect(result.serverRendererPath).toBeDefined();
  });

  it("materializes static route HTML/data closure into the physical deploy manifest", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, "src", "frontend", "pages", "posts"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "posts", "[slug].tsx"),
      "export default function Post({ params }: { params: { slug: string } }) { return <main>{params.slug}</main>; }\n",
    );
    await mkdir(path.join(rootDir, ".vext", "manifest"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".vext", "manifest", "routes.json"),
      `${JSON.stringify(
        {
          routes: [
            {
              routeId: "route_posts",
              method: "GET",
              path: "/posts/:slug",
              operationId: "getPost",
              docsSummary: "Post",
              tags: [],
              hidden: false,
              schema: { schemaVersion: 1, request: {}, responses: [] },
              freshness: {
                mode: "static",
                source: "route-options",
                page: "posts/[slug]",
                staticParams: [{ slug: "hello" }, { slug: "world" }],
                tags: ["posts"],
              },
              layout: { state: "unresolved", paths: [] },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const staticManifest = JSON.parse(
      await readFile(result.staticManifestPath!, "utf-8"),
    );
    const deployManifest = JSON.parse(
      await readFile(result.deployManifestPath!, "utf-8"),
    );

    expect(staticManifest.artifacts).toHaveLength(2);
    expect(staticManifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routePath: "/posts/hello",
          html: "posts/hello/index.html",
          data: "posts/hello/__vext.page.json",
          params: { slug: "hello" },
        }),
      ]),
    );
    expect(
      await readFile(
        path.join(result.config.outDir, "posts", "hello", "__vext.page.json"),
        "utf-8",
      ),
    ).toContain('"slug": "hello"');
    expect(
      deployManifest.assets.map((asset: { file: string }) => asset.file),
    ).toEqual(
      expect.arrayContaining([
        "posts/hello/index.html",
        "posts/hello/__vext.page.json",
        "posts/world/index.html",
        "posts/world/__vext.page.json",
      ]),
    );
  });

  it("rejects static route parameters that escape stage or publish roots", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, ".vext", "manifest"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".vext", "manifest", "routes.json"),
      `${JSON.stringify({
        routes: [
          {
            routeId: "route_escape",
            method: "GET",
            path: "/:first/:second",
            operationId: "escape",
            docsSummary: "Escape",
            tags: [],
            hidden: false,
            schema: { schemaVersion: 1, request: {}, responses: [] },
            freshness: {
              mode: "static",
              source: "route-options",
              page: "index",
              staticParams: [{ first: "..", second: ".." }],
            },
            layout: { state: "unresolved", paths: [] },
          },
        ],
      })}\n`,
      "utf-8",
    );

    await expect(
      buildFrontendClient({
        rootDir,
        mode: "production",
        config: { enabled: true, apiClient: false },
      }),
    ).rejects.toThrow(/static route|relative path|inside|path segments/iu);
  });

  it("does not include files reached through an outDir junction in deploy manifests", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const config = resolveFrontendConfig(true, {
      rootDir,
      mode: "production",
    });
    await mkdir(config.outDir, { recursive: true });
    await writeFile(path.join(config.outDir, "safe.txt"), "safe");
    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await symlink(
      outsideDir,
      path.join(config.outDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const manifest = await buildFrontendDeployManifest({
      rootDir,
      config,
      mode: "production",
      browserManifest: { assets: [] } as any,
    });

    expect(manifest.assets.map((asset) => asset.file)).toContain("safe.txt");
    expect(manifest.assets.map((asset) => asset.file)).not.toContain(
      "linked/secret.txt",
    );
  });

  it("writes deploy manifest, injects SRI, and uploads only changed assets", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, "public", "static"), { recursive: true });
    await writeFile(
      path.join(rootDir, "public", "static", "logo.txt"),
      "logo-v1",
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        deploy: {
          integrity: true,
          upload: {
            enabled: true,
            targetDir: ".deploy/cdn",
            publicBaseUrl: "https://cdn.example.com/app/",
            prefix: "app/v1",
          },
        },
      },
    });
    const html = await readFile(
      path.join(result.config.outDir, "index.html"),
      "utf-8",
    );
    const deployManifest = JSON.parse(
      await readFile(result.deployManifestPath!, "utf-8"),
    );

    expect(html).toContain('integrity="sha256-');
    expect(deployManifest.kind).toBe("frontend-deploy-manifest");
    expect(
      deployManifest.assets.some((asset: any) => asset.file === "index.html"),
    ).toBe(false);
    expect(
      deployManifest.assets.some(
        (asset: any) =>
          asset.file === "static/logo.txt" &&
          asset.uploadKey === "app/v1/static/logo.txt",
      ),
    ).toBe(true);
    expect(
      deployManifest.assets.find(
        (asset: any) => asset.file === "static/logo.txt",
      )?.immutable,
    ).toBe(false);
    expect(
      deployManifest.assets.find(
        (asset: any) => asset.source === "bundle" && asset.file.endsWith(".js"),
      )?.immutable,
    ).toBe(true);

    const firstUpload = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath!,
    });
    expect(firstUpload.uploaded).toBeGreaterThan(0);
    expect(
      existsSync(
        path.join(rootDir, ".deploy", "cdn", "app", "v1", "static", "logo.txt"),
      ),
    ).toBe(true);

    const secondUpload = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath!,
    });
    expect(secondUpload.uploaded).toBe(0);
    expect(secondUpload.skipped).toBe(deployManifest.assets.length);

    const deployState = JSON.parse(
      await readFile(result.config.deploy.upload.stateFile, "utf-8"),
    );
    expect(Object.keys(deployState.assets)).toHaveLength(
      deployManifest.assets.length,
    );
    expect(deployState.assets["app/v1/static/logo.txt"]).toMatchObject({
      sha256: expect.any(String),
      bytes: "logo-v1".length,
    });
  });

  it("does not persist deploy state for unconfirmed custom adapter uploads", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        deploy: {
          upload: {
            enabled: true,
            adapter: "mock",
          },
        },
      },
    });
    const deployManifest = JSON.parse(
      await readFile(result.deployManifestPath!, "utf-8"),
    );
    const stateFile = result.config.deploy.upload.stateFile;
    const declinedAdapter = {
      name: "declined",
      async upload() {
        return { uploaded: false };
      },
    };

    const dryRun = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath!,
      dryRun: true,
      adapter: declinedAdapter,
    });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.uploaded).toBe(0);
    expect(existsSync(stateFile)).toBe(false);

    const declined = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath!,
      adapter: declinedAdapter,
    });
    const emptyState = JSON.parse(await readFile(stateFile, "utf-8"));

    expect(declined.uploaded).toBe(0);
    expect(declined.skipped).toBe(deployManifest.assets.length);
    expect(Object.keys(emptyState.assets)).toHaveLength(0);

    let successCalls = 0;
    const successful = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath!,
      adapter: {
        name: "successful",
        async upload() {
          successCalls += 1;
          return { uploaded: true };
        },
      },
    });
    const populatedState = await readFile(stateFile, "utf-8");

    expect(successful.uploaded).toBe(deployManifest.assets.length);
    expect(successCalls).toBe(deployManifest.assets.length);
    expect(Object.keys(JSON.parse(populatedState).assets)).toHaveLength(
      deployManifest.assets.length,
    );

    const staleState = JSON.parse(populatedState);
    const staleUploadKey = Object.keys(staleState.assets)[0];
    staleState.assets[staleUploadKey].sha256 = "stale";
    const staleStateText = `${JSON.stringify(staleState, null, 2)}\n`;
    await writeFile(stateFile, staleStateText, "utf-8");

    await expect(
      deployFrontendAssets({
        config: result.config,
        manifestPath: result.deployManifestPath!,
        adapter: {
          name: "throwing",
          async upload() {
            throw new Error("upload failed");
          },
        },
      }),
    ).rejects.toThrow("upload failed");
    expect(await readFile(stateFile, "utf-8")).toBe(staleStateText);
  });

  it("renders an import map for configured browser external runtime modules", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        build: {
          client: {
            external: ["react"],
            externalRuntime: {
              react: "https://cdn.example.com/react.mjs",
            },
          },
        },
      },
    });
    const html = await readFile(
      path.join(result.config.outDir, "index.html"),
      "utf-8",
    );

    expect(html).toContain(
      '<script type="importmap" data-vext-external-runtime>',
    );
    expect(html).toContain('"react":"https://cdn.example.com/react.mjs"');
  });

  it("fails fast when browser React externals are missing runtime mappings", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    await expect(
      buildFrontendClient({
        rootDir,
        mode: "production",
        config: {
          enabled: true,
          apiClient: false,
          build: {
            client: {
              external: ["react"],
            },
          },
        },
      }),
    ).rejects.toThrow(
      "frontend browser external runtime mapping is incomplete",
    );
  });

  it("generates page, layout, error, i18n, and render manifests", async () => {
    const rootDir = await tempRoot();
    const frontendDir = path.join(rootDir, "src", "frontend");
    await mkdir(path.join(frontendDir, "pages", "admin"), {
      recursive: true,
    });
    await mkdir(path.join(frontendDir, "pages", "error"), {
      recursive: true,
    });
    await mkdir(path.join(frontendDir, "styles"), { recursive: true });
    await mkdir(path.join(frontendDir, "locales"), { recursive: true });
    await writeFile(
      path.join(frontendDir, "pages", "_document.html"),
      "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
    );
    await writeFile(
      path.join(frontendDir, "pages", "index.tsx"),
      "export default function Page() { return null; }\n",
    );
    await writeFile(
      path.join(frontendDir, "pages", "admin", "layout.tsx"),
      "export default function Layout(props) { return props.children; }\n",
    );
    await writeFile(
      path.join(frontendDir, "pages", "admin", "index.tsx"),
      "export default function Admin() { return null; }\n",
    );
    await writeFile(
      path.join(frontendDir, "pages", "error", "default.tsx"),
      "export default function ErrorPage() { return null; }\n",
    );
    await writeFile(
      path.join(frontendDir, "locales", "en-US.ts"),
      "export default { title: 'Hello' };\n",
    );
    await writeFile(
      path.join(frontendDir, "styles", "index.css"),
      ":root { color-scheme: light; }\n",
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });

    const renderManifest = JSON.parse(
      await readFile(result.renderManifestPath!, "utf-8"),
    );
    const messagesManifest = JSON.parse(
      await readFile(result.messagesManifestPath!, "utf-8"),
    );
    const generatedRegistry = await readFile(
      path.join(result.generatedDir!, "page-registry.ts"),
      "utf-8",
    );
    const html = await readFile(
      path.join(result.config.outDir, "index.html"),
      "utf-8",
    );

    expect(renderManifest.kind).toBe("frontend-render-manifest");
    expect(renderManifest.pages.map((page: any) => page.id)).toEqual([
      "admin/index",
      "index",
    ]);
    expect(renderManifest.layouts[0]).toMatchObject({
      id: "admin",
      directory: "admin",
    });
    expect(renderManifest.errorPages[0]).toMatchObject({
      id: "error/default",
    });
    expect(renderManifest.serverRenderer).toBe("server/renderer.cjs");
    expect(renderManifest.routeAssets.schemaVersion).toBe(1);
    expect(
      renderManifest.routeAssets.routes.map((route: any) => route.page),
    ).toContain("admin/index");
    expect(
      renderManifest.routeAssets.routes.find(
        (route: any) => route.page === "admin/index",
      )?.initialJsBrotliBytes,
    ).toBeGreaterThan(0);
    expect(messagesManifest.locales[0]).toMatchObject({ locale: "en-US" });
    expect(generatedRegistry).toContain("export const pages");
    expect(html).toContain('id="__VEXT_DATA__"');
    expect(html).toContain("data-vext-root");
    expect(html).not.toContain("%VEXT");
    expect(html).not.toContain("{vext.");
  });

  it("skips locale scanning and imports when frontend i18n is disabled", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, "src", "frontend", "locales"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "locales", "en-US.ts"),
      "export default { title: 'Hello' };\n",
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: false, defaultLocale: "en-US" },
      },
    });
    const messagesManifest = JSON.parse(
      await readFile(result.messagesManifestPath!, "utf-8"),
    );
    const renderManifest = JSON.parse(
      await readFile(result.renderManifestPath!, "utf-8"),
    );
    const generatedRegistry = await readFile(
      path.join(result.generatedDir!, "page-registry.ts"),
      "utf-8",
    );
    const browserEntry = await readFile(
      path.join(result.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const serverEntry = await readFile(
      path.join(result.generatedDir!, "server-renderer.ts"),
      "utf-8",
    );

    expect(messagesManifest.locales).toEqual([]);
    expect(renderManifest.i18n).toMatchObject({
      enabled: false,
      locales: [],
    });
    expect(generatedRegistry).toContain("export const locales = [] as const;");
    expect(browserEntry).not.toContain("localeModule0");
    expect(serverEntry).not.toContain("localeModule0");
    expect(browserEntry).not.toContain("locales/en-US");
    expect(serverEntry).not.toContain("locales/en-US");
    expect(serverEntry).toContain("renderToPipeableStream");
    expect(serverEntry).toContain("export function renderPageStream");
  });

  it("generates i18n clientLoad mode and hydration telemetry in the browser entry", async () => {
    const currentRootDir = await tempRoot();
    await createMinimalFrontend(currentRootDir);
    await mkdir(path.join(currentRootDir, "src", "frontend", "locales"), {
      recursive: true,
    });
    await writeFile(
      path.join(currentRootDir, "src", "frontend", "locales", "en-US.ts"),
      "export default { title: 'Hello' };\n",
    );
    await writeFile(
      path.join(currentRootDir, "src", "frontend", "locales", "zh-CN.ts"),
      "export default { title: '你好' };\n",
    );

    const currentResult = await buildFrontendClient({
      rootDir: currentRootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });
    const currentEntry = await readFile(
      path.join(currentResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );

    expect(currentEntry).toContain('const clientLoad = "current";');
    expect(currentEntry).toContain("markVextHydrationStart(root)");
    expect(currentEntry).toContain('root.dataset.vextHydration = "done"');
    expect(currentEntry).toContain("performance.measure(name, start, end)");

    const allRootDir = await tempRoot();
    await createMinimalFrontend(allRootDir);
    await mkdir(path.join(allRootDir, "src", "frontend", "locales"), {
      recursive: true,
    });
    await writeFile(
      path.join(allRootDir, "src", "frontend", "locales", "en-US.ts"),
      "export default { title: 'Hello' };\n",
    );
    await writeFile(
      path.join(allRootDir, "src", "frontend", "locales", "zh-CN.ts"),
      "export default { title: 'Ni hao' };\n",
    );

    const allResult = await buildFrontendClient({
      rootDir: allRootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: {
          enabled: true,
          defaultLocale: "en-US",
          clientLoad: "all",
        },
      },
    });
    const allEntry = await readFile(
      path.join(allResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );

    expect(allEntry).toContain('const clientLoad = "all";');
  });

  it("extracts Vext JSCSS modules into the bundled CSS asset", async () => {
    const rootDir = await tempRoot();
    const frontendDir = path.join(rootDir, "src", "frontend");
    await mkdir(path.join(frontendDir, "pages"), { recursive: true });
    await mkdir(path.join(frontendDir, "styles"), { recursive: true });
    await writeFile(
      path.join(frontendDir, "pages", "_document.html"),
      "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
    );
    await writeFile(
      path.join(frontendDir, "styles", "card.style.ts"),
      [
        'import { createVar, recipe, setVar, style, vars } from "vextjs/style";',
        'export const accent = createVar("accent", "#0f766e");',
        "export const card = style({",
        "  color: accent,",
        "  padding: 12,",
        "  opacity: 0.9,",
        '  "&:hover": { color: "tomato" },',
        '  "@media (min-width: 640px)": { padding: 16 },',
        '}, "card");',
        "export const action = recipe({",
        '  name: "action",',
        "  base: { borderRadius: 6 },",
        "  variants: {",
        "    tone: {",
        '      primary: { backgroundColor: "black", color: "white" },',
        "    },",
        "  },",
        '  defaultVariants: { tone: "primary" },',
        "});",
        'export const accentStyle = vars(setVar(accent, "#123456"));',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(frontendDir, "pages", "index.tsx"),
      [
        'import { action, card } from "../styles/card.style";',
        "export default function Page() {",
        "  return <main className={`${card} ${action()}`}>JSCSS</main>;",
        "}",
        "",
      ].join("\n"),
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const generatedCss = await readFile(
      path.join(result.generatedDir!, "vext-jscss.css"),
      "utf-8",
    );
    const browserEntry = await readFile(
      path.join(result.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf-8"));
    const cssAssetPath = manifest.assets.find((asset: any) =>
      asset.path.endsWith(".css"),
    )?.path;
    expect(cssAssetPath).toBeDefined();
    const cssAsset = String(cssAssetPath).replace(/^\/+/, "");
    const bundledCss = await readFile(
      path.join(result.config.outDir, cssAsset),
      "utf-8",
    );

    expect(browserEntry).toContain("vext-jscss.css");
    expect(generatedCss).toContain(".vext-card-");
    expect(generatedCss).toContain("color:var(--vext-accent, #0f766e)");
    expect(generatedCss).toContain("padding:12px");
    expect(generatedCss).toContain("@media (min-width: 640px)");
    expect(bundledCss).toContain(".vext-card-");
    expect(bundledCss).toContain(".vext-action-tone-primary-");
  });

  it("builds and renders the JSCSS user-guide examples", async () => {
    const fixtureDir = path.join(
      process.cwd(),
      "test",
      "fixtures",
      "frontend",
      "jscss-user-guide",
    );
    const [buttonStyle, buttonComponent] = await Promise.all([
      readFile(path.join(fixtureDir, "button.style.ts"), "utf-8"),
      readFile(path.join(fixtureDir, "Button.tsx"), "utf-8"),
    ]);
    const rootDir = await tempRoot();
    const frontendDir = path.join(rootDir, "src", "frontend");
    const stylePath = path.join(frontendDir, "styles", "button.style.ts");
    const componentPath = path.join(frontendDir, "components", "Button.tsx");

    await mkdir(path.join(frontendDir, "pages"), { recursive: true });
    await mkdir(path.dirname(stylePath), { recursive: true });
    await mkdir(path.dirname(componentPath), { recursive: true });
    await writeFile(
      path.join(frontendDir, "pages", "_document.html"),
      "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
    );
    await writeFile(stylePath, buttonStyle);
    await writeFile(componentPath, buttonComponent);
    await writeFile(
      path.join(frontendDir, "pages", "index.tsx"),
      [
        'import { Button } from "../components/Button";',
        "export default function Page() {",
        '  return <Button intent="primary">Publish</Button>;',
        "}",
        "",
      ].join("\n"),
    );

    const diagnostics = typecheckJscssUserGuide([stylePath, componentPath]);
    expect(diagnostics).toEqual([]);

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const generatedCss = await readFile(
      path.join(result.generatedDir!, "vext-jscss.css"),
      "utf-8",
    );
    expect(generatedCss).toContain(".vext-button-");
    expect(generatedCss).toContain(".vext-button-intent-primary-");
    expect(generatedCss).toContain("color:var(--vext-color-text, #111827)");

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const res = createRenderMockResponse();
    await middleware(createMockRequest("/"), res, async () => {});
    res.render("index");

    const html = res.sent?.html ?? "";
    expect(html).toContain("vext-button-intent-primary-");
    expect(html).toContain("Publish");
  });

  it("honors Vext JSCSS runtime adapter, dynamic vars, and recipes flags", async () => {
    async function buildJscssCase(
      jscss: NonNullable<
        NonNullable<
          Parameters<typeof buildFrontendClient>[0]["config"]
        >["styles"]
      >["jscss"],
    ) {
      const rootDir = await tempRoot();
      const frontendDir = path.join(rootDir, "src", "frontend");
      await mkdir(path.join(frontendDir, "pages"), { recursive: true });
      await mkdir(path.join(frontendDir, "styles"), { recursive: true });
      await writeFile(
        path.join(frontendDir, "pages", "_document.html"),
        "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
      );
      await writeFile(
        path.join(frontendDir, "styles", "card.style.ts"),
        [
          'import { createVar, recipe, setVar, style, vars } from "vextjs/style";',
          'const accent = createVar("accent", "#0f766e");',
          "export const card = style({",
          "  ...vars(setVar(accent, '#123456')),",
          "  color: accent,",
          "  padding: 12,",
          '}, "card");',
          "export const action = recipe({",
          '  name: "action",',
          "  base: { borderRadius: 6 },",
          "  variants: {",
          "    tone: {",
          '      primary: { backgroundColor: "black", color: "white" },',
          "    },",
          "  },",
          '  defaultVariants: { tone: "primary" },',
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(frontendDir, "pages", "index.tsx"),
        [
          'import { action, card } from "../styles/card.style";',
          "export default function Page() {",
          "  return <main className={`${card} ${action()}`}>JSCSS</main>;",
          "}",
          "",
        ].join("\n"),
      );

      const result = await buildFrontendClient({
        rootDir,
        mode: "production",
        config: {
          enabled: true,
          apiClient: false,
          styles: {
            jscss,
          },
        },
      });
      const generatedCss = await readFile(
        path.join(result.generatedDir!, "vext-jscss.css"),
        "utf-8",
      );
      const middleware = createFrontendRenderMiddleware({
        rootDir,
        mode: "production",
        config: { enabled: true },
      });
      const res = createRenderMockResponse();
      await middleware(createMockRequest("/"), res, async () => {});
      res.render("index");

      return {
        generatedCss,
        html: res.sent?.html ?? "",
      };
    }

    const defaultCase = await buildJscssCase({ enabled: true });
    expect(defaultCase.generatedCss).toContain("--vext-accent:#123456");
    expect(defaultCase.generatedCss).toContain(
      "color:var(--vext-accent, #0f766e)",
    );
    expect(defaultCase.generatedCss).toContain(".vext-action-tone-primary-");
    expect(defaultCase.html).toContain("vext-action-tone-primary-");

    const noRuntimeAdapterCase = await buildJscssCase({
      enabled: true,
      runtimeAdapter: "none",
    });
    expect(noRuntimeAdapterCase.generatedCss).toContain("color:#0f766e");
    expect(noRuntimeAdapterCase.generatedCss).not.toContain("--vext-accent");
    expect(noRuntimeAdapterCase.generatedCss).not.toContain("var(--vext");

    const noDynamicVarsCase = await buildJscssCase({
      enabled: true,
      dynamicVars: false,
    });
    expect(noDynamicVarsCase.generatedCss).toContain("color:#0f766e");
    expect(noDynamicVarsCase.generatedCss).not.toContain("--vext-accent");
    expect(noDynamicVarsCase.generatedCss).not.toContain("var(--vext");

    const noRecipesCase = await buildJscssCase({
      enabled: true,
      recipes: false,
    });
    expect(noRecipesCase.generatedCss).toContain(".vext-action-");
    expect(noRecipesCase.generatedCss).not.toContain(
      ".vext-action-tone-primary-",
    );
    expect(noRecipesCase.html).toContain("vext-action-");
    expect(noRecipesCase.html).not.toContain("vext-action-tone-primary-");
  });

  it("honors the frontend size report diagnostics flag", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    const defaultResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    expect(
      existsSync(path.join(defaultResult.config.outDir, "size-report.json")),
    ).toBe(true);
    const sizeReport = JSON.parse(
      await readFile(
        path.join(defaultResult.config.outDir, "size-report.json"),
        "utf-8",
      ),
    );
    expect(sizeReport.kind).toBe("frontend-size-report");
    expect(sizeReport.totalBytes).toBeGreaterThan(0);
    expect(sizeReport.totalGzipBytes).toBeGreaterThan(0);
    expect(sizeReport.totalBrotliBytes).toBeGreaterThan(0);
    expect(sizeReport.initialJsBrotliBytes).toBeGreaterThan(0);
    expect(sizeReport.appOwnedInitialJsBrotliBytes).toBeGreaterThan(0);
    expect(sizeReport.assets[0]).toHaveProperty("gzipBytes");
    expect(sizeReport.assets[0]).toHaveProperty("brotliBytes");

    const disabledRootDir = await tempRoot();
    await createMinimalFrontend(disabledRootDir);

    const disabledResult = await buildFrontendClient({
      rootDir: disabledRootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        build: {
          diagnostics: {
            sizeReport: false,
          },
        },
      },
    });

    expect(
      existsSync(path.join(disabledResult.config.outDir, "size-report.json")),
    ).toBe(false);
  });

  it("honors the frontend performance report diagnostics flag", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    const defaultResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const defaultRenderManifest = JSON.parse(
      await readFile(defaultResult.renderManifestPath!, "utf-8"),
    );
    const defaultSizeReport = JSON.parse(
      await readFile(
        path.join(defaultResult.config.outDir, "size-report.json"),
        "utf-8",
      ),
    );
    const defaultBrowserManifest = JSON.parse(
      await readFile(defaultResult.manifestPath!, "utf-8"),
    );
    const browserEntry = defaultBrowserManifest.assets.find(
      (asset: { entry?: boolean; path: string }) =>
        asset.entry &&
        asset.path.endsWith(".js") &&
        asset.path.includes("browser-entry-"),
    );
    expect(browserEntry).toBeDefined();
    const routeAssets = defaultRenderManifest.routeAssets.routes[0];
    const assetsByPath = new Map(
      defaultBrowserManifest.assets.map(
        (asset: { bytes: number; path: string }) => [asset.path, asset],
      ),
    );
    const staticClosurePaths = new Set<string>();
    const addStaticClosure = async (assetPath: string): Promise<void> => {
      if (staticClosurePaths.has(assetPath)) return;
      const asset = assetsByPath.get(assetPath) as
        | { bytes: number; path: string }
        | undefined;
      if (!asset?.path.endsWith(".js")) return;
      staticClosurePaths.add(asset.path);
      const source = await readFile(
        path.join(defaultResult.config.outDir, asset.path.replace(/^\//u, "")),
        "utf-8",
      );
      for (const match of source.matchAll(
        /(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+\.js)["']/gu,
      )) {
        await addStaticClosure(
          path.posix.join(path.posix.dirname(asset.path), match[1]!),
        );
      }
    };
    await addStaticClosure(browserEntry.path);
    for (const assetPath of routeAssets.scripts) {
      await addStaticClosure(assetPath);
    }
    const expectedInitialJsBytes = [...staticClosurePaths]
      .map((assetPath) => assetsByPath.get(assetPath)!)
      .reduce(
        (total: number, asset: { bytes: number }) => total + asset.bytes,
        0,
      );
    expect(
      routeAssets.scripts.some((assetPath: string) => {
        const asset = assetsByPath.get(assetPath) as
          | { entry?: boolean }
          | undefined;
        return asset?.entry === true;
      }),
    ).toBe(true);
    expect(routeAssets.initialJsBrotliBytes).toBeGreaterThan(0);
    expect(defaultSizeReport.routes[0].initialJsBrotliBytes).toBeGreaterThan(0);
    expect(routeAssets.initialJsBytes).toBe(expectedInitialJsBytes);
    expect(defaultSizeReport.routes[0].initialJsBytes).toBe(
      expectedInitialJsBytes,
    );
    expect(defaultSizeReport.initialJsBytes).toBe(expectedInitialJsBytes);
    expect(defaultSizeReport.initialJsBytes).toBe(
      defaultSizeReport.routes[0].initialJsBytes,
    );

    const disabledRootDir = await tempRoot();
    await createMinimalFrontend(disabledRootDir);

    const disabledResult = await buildFrontendClient({
      rootDir: disabledRootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        build: {
          diagnostics: {
            performanceReport: false,
          },
        },
      },
    });
    const disabledRenderManifest = JSON.parse(
      await readFile(disabledResult.renderManifestPath!, "utf-8"),
    );
    const disabledSizeReport = JSON.parse(
      await readFile(
        path.join(disabledResult.config.outDir, "size-report.json"),
        "utf-8",
      ),
    );
    expect(disabledRenderManifest.routeAssets.routes[0].scripts).toEqual(
      expect.any(Array),
    );
    expect(disabledRenderManifest.routeAssets.routes[0]).not.toHaveProperty(
      "initialJsBrotliBytes",
    );
    expect(disabledSizeReport.initialJsBrotliBytes).toBeGreaterThan(0);
    expect(disabledSizeReport).not.toHaveProperty("routes");
  });

  it("writes byte-stable frontend build manifest artifacts for identical inputs", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    const firstResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const firstArtifacts = await readFrontendManifestFamily(
      firstResult.config.outDir,
    );
    const firstRenderManifest = JSON.parse(
      firstArtifacts["render-manifest.json"],
    );

    const secondResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const secondArtifacts = await readFrontendManifestFamily(
      secondResult.config.outDir,
    );
    const secondRenderManifest = JSON.parse(
      secondArtifacts["render-manifest.json"],
    );

    expect(secondArtifacts).toEqual(firstArtifacts);
    expect(secondRenderManifest.buildId).toBe(firstRenderManifest.buildId);
    for (const content of Object.values(firstArtifacts)) {
      expect(JSON.parse(content).generatedAt).toBe("1970-01-01T00:00:00.000Z");
    }

    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      "export default function Page() { return <main>Changed</main>; }\n",
    );
    const changedResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const changedRenderManifest = JSON.parse(
      (await readFrontendManifestFamily(changedResult.config.outDir))[
        "render-manifest.json"
      ],
    );

    expect(changedRenderManifest.buildId).not.toBe(firstRenderManifest.buildId);
  });

  it("fails with a friendly error when compressed frontend budgets are exceeded", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    await expect(
      buildFrontendClient({
        rootDir,
        mode: "production",
        config: {
          enabled: true,
          apiClient: false,
          build: {
            budgets: {
              maxInitialJsBrotliBytes: 1,
            },
          },
        },
      }),
    ).rejects.toThrow("maxInitialJsBrotliBytes");
  });

  it("injects React Fast Refresh only into development browser builds", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);

    const devResult = await buildFrontendClient({
      rootDir,
      mode: "development",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const devBrowserEntry = await readFile(
      path.join(devResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const devBundle = (
      await readTextFiles(devResult.config.outDir, ".js")
    ).join("\n");

    expect(devBrowserEntry).toContain("react-refresh/runtime");
    expect(devBrowserEntry).toContain('EventSource("/__vext/dev/events")');
    expect(devBrowserEntry).toContain("performReactRefresh");
    expect(devBrowserEntry).toContain("isCurrentVextBuild");
    expect(devBrowserEntry).toContain("getCurrentVextBuildId");
    expect(devBrowserEntry).toContain("payload.buildId === currentBuildId");
    expect(devBrowserEntry).toContain("isCurrentVextEntry");
    expect(devBrowserEntry).toContain("payload.replay === true");
    expect(devBrowserEntry).toContain("showVextDevErrorOverlay");
    expect(devBrowserEntry).toContain("showVextRenderRefreshPrompt");
    expect(devBundle).toContain("src/frontend/pages/index.tsx Page");

    const productionResult = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });
    const productionBrowserEntry = await readFile(
      path.join(productionResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const productionBundle = (
      await readTextFiles(productionResult.config.outDir, ".js")
    ).join("\n");

    expect(productionBrowserEntry).not.toContain("react-refresh/runtime");
    expect(productionBundle).not.toContain("react-refresh");

    const disabledResult = await buildFrontendClient({
      rootDir,
      mode: "development",
      config: {
        enabled: true,
        apiClient: false,
        dev: { fastRefresh: false },
      },
    });
    const disabledBrowserEntry = await readFile(
      path.join(disabledResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const disabledBundle = (
      await readTextFiles(disabledResult.config.outDir, ".js")
    ).join("\n");

    expect(disabledBrowserEntry).toContain('EventSource("/__vext/dev/events")');
    expect(disabledBrowserEntry).not.toContain("react-refresh/runtime");
    expect(disabledBundle).not.toContain("react-refresh");

    const overlayOffResult = await buildFrontendClient({
      rootDir,
      mode: "development",
      config: {
        enabled: true,
        apiClient: false,
        dev: { overlay: false },
      },
    });
    const overlayOffBrowserEntry = await readFile(
      path.join(overlayOffResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );

    expect(overlayOffBrowserEntry).toContain(
      'EventSource("/__vext/dev/events")',
    );
    expect(overlayOffBrowserEntry).toContain("frontend rebuild failed");
    expect(overlayOffBrowserEntry).not.toContain("showVextDevErrorOverlay");
    expect(overlayOffBrowserEntry).not.toContain("showVextRenderRefreshPrompt");

    const hotOffResult = await buildFrontendClient({
      rootDir,
      mode: "development",
      config: {
        enabled: true,
        apiClient: false,
        dev: { hot: false },
      },
    });
    const hotOffBrowserEntry = await readFile(
      path.join(hotOffResult.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );

    expect(hotOffBrowserEntry).not.toContain(
      'EventSource("/__vext/dev/events")',
    );
    expect(hotOffBrowserEntry).not.toContain("react-refresh/runtime");
  }, 60_000);

  it("explains browser boundary leaks before esbuild reports low-level errors", async () => {
    const rootDir = await tempRoot();
    await mkdir(path.join(rootDir, "src", "frontend", "entry"), {
      recursive: true,
    });
    await mkdir(path.join(rootDir, "src", "services"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "frontend", "entry", "main.js"),
      'import { db } from "../../services/db.js";\nconsole.log(db);\n',
    );
    await writeFile(
      path.join(rootDir, "src", "services", "db.js"),
      "export const db = {};\n",
    );

    await expect(
      buildFrontendClient({
        rootDir,
        mode: "production",
        config: {
          enabled: true,
          entry: "src/frontend/entry/main.js",
          apiClient: false,
        },
      }),
    ).rejects.toThrow("你跨越了前后端物理边界");
  });

  it("explains server imports written inside generated page sources", async () => {
    const rootDir = await tempRoot();
    await mkdir(path.join(rootDir, "src", "frontend", "pages"), {
      recursive: true,
    });
    await mkdir(path.join(rootDir, "src", "services"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'import { db } from "../../services/db.js";\nexport default function Page() { return db; }\n',
    );
    await writeFile(
      path.join(rootDir, "src", "services", "db.js"),
      "export const db = {};\n",
    );

    await expect(
      buildFrontendClient({
        rootDir,
        mode: "production",
        config: {
          enabled: true,
          apiClient: false,
        },
      }),
    ).rejects.toThrow("src/frontend/pages/index.tsx");
  });

  it("generates the browser navigation runtime without server-only imports", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      [
        'import { Image, Link, defineFont, useNavigation, useRouteData } from "vextjs/frontend";',
        "export default function Page(props) {",
        "  const navigation = useNavigation();",
        "  const data = useRouteData() ?? props;",
        '  return <main data-font-factory={typeof defineFont}><span>{navigation.phase}</span><span>{data.title}</span><Image src="/assets/fixture.png" width={1} height={1} alt="fixture" /><Link href="/next">Next</Link></main>;',
        "}",
        "",
      ].join("\n"),
    );

    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const runtime = await readFile(
      path.join(result.generatedDir!, "vext-runtime.tsx"),
      "utf-8",
    );
    const browserEntry = await readFile(
      path.join(result.generatedDir!, "browser-entry.tsx"),
      "utf-8",
    );
    const browserOutputs = await readTextFiles(result.config.outDir, ".js");

    expect(runtime).toContain('from "vextjs/frontend/navigation-runtime"');
    expect(runtime).toContain('from "vextjs/frontend/media-runtime"');
    expect(runtime).toContain("defineImageLoader");
    expect(runtime).toContain("useRouteData");
    expect(browserEntry).toContain("configureVextBrowserRuntime");
    expect(browserEntry).toContain("createInitialVextEnvelope");
    expect(browserEntry).toContain("rootController.render(nextTree)");
    for (const output of browserOutputs) {
      expect(output).not.toMatch(
        /from["']node:|require\(["']node:|["']src\/(?:routes|services)\/|["'][^"']+\.server\.[cm]?[jt]sx?["']/u,
      );
    }
  });
});

describe("frontend render middleware", () => {
  it("binds res.render() to built frontend output", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/dashboard"), res, async () => {});
    res.render(
      "index",
      { title: "<Dashboard>" },
      {
        status: 202,
        headers: { "X-Render": "yes" },
        nonce: "abc123",
        head: { title: "Dashboard", meta: { robots: "noindex" } },
      },
    );

    expect(res.sent?.status).toBe(202);
    expect(res.sent?.headers["X-Render"]).toBe("yes");
    expect(res.sent?.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.sent?.kind).toBe("render");
    expect(res.sent?.html).toContain(
      '<title data-vext-managed-head="title">Dashboard</title>',
    );
    expect(res.sent?.html).toContain('rel="modulepreload"');
    expect(res.sent?.html).toContain("data-vext-route-preload");
    expect(res.sent?.html).toContain('data-vext-entry nonce="abc123"');
    expect(res.sent?.html).toContain('data-vext-data nonce="abc123"');
    expect(res.sent?.html).toContain('data-vext-page="index"');
    expect(res.sent?.html).toContain('"page":"index"');
    expect(res.sent?.html).toContain("\\u003cDashboard\\u003e");
    expect(res.onSendPayload?.__vextResponseKind).toBe("render");
    expect(res.onSendPayload?.payload.page).toBe("index");
  });

  it("negotiates a page envelope on the same document route", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });

    const documentReq = createMockRequest("/dashboard?tab=activity", {
      accept: "text/html",
    });
    documentReq.path = "/dashboard";
    documentReq.route = "/dashboard";
    const documentRes = createRenderMockResponse();
    await middleware(documentReq, documentRes as any, async () => {});
    documentRes.render("index", { count: 1 }, { head: { title: "Dashboard" } });

    const navigationReq = createMockRequest("/dashboard?tab=activity", {
      accept: "application/vnd.vext.page+json;v=1",
      "vext-navigation": "1",
      "vext-build-id": "consumer-build",
    });
    navigationReq.path = "/dashboard";
    navigationReq.route = "/dashboard";
    const navigationRes = createRenderMockResponse();
    await middleware(navigationReq, navigationRes as any, async () => {});
    navigationRes.render(
      "index",
      { count: 1 },
      { head: { title: "Dashboard" } },
    );

    const documentPayload = documentRes.sent?.data as any;
    const envelope = navigationRes.rawJsonSent?.data as any;
    expect(navigationRes.sent).toBeUndefined();
    expect(navigationRes.rawJsonSent?.status).toBe(200);
    expect(navigationRes.headers["Content-Type"]).toBe(
      "application/vnd.vext.page+json;v=1; charset=utf-8",
    );
    expect(navigationRes.headers.Vary).toContain("Vext-Navigation");
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      routeId: documentPayload.routeId,
      url: "/dashboard?tab=activity",
      result: {
        kind: "page",
        page: "index",
        props: { count: 1 },
        layouts: [],
        head: { title: "Dashboard" },
      },
      cache: { partition: "public", noStore: false },
    });
    expect(envelope.result.assets.length).toBeGreaterThan(0);
    expect(navigationRes.onSendPayload?.payload.routeId).toBe(
      documentPayload.routeId,
    );
  });

  it("encodes redirect and error results and keeps private envelopes no-store", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });
    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const headers = {
      accept: "application/vnd.vext.page+json;v=1",
      "vext-navigation": "1",
    };

    const redirectReq = createMockRequest("/submit", headers);
    redirectReq.method = "POST";
    redirectReq.route = "/submit";
    const redirectRes = createRenderMockResponse();
    await middleware(redirectReq, redirectRes as any, async () => {});
    redirectRes.redirect("/done", 303);
    expect(redirectRes.rawJsonSent?.data).toMatchObject({
      result: {
        kind: "redirect",
        location: "/done",
        status: 303,
        replace: true,
      },
    });
    expect(redirectRes.rawJsonSent?.status).toBe(200);

    const errorReq = createMockRequest("/private", headers);
    errorReq.route = "/private";
    errorReq.auth = {
      isAuthenticated: true,
      subject: "user-1",
      roles: ["member"],
      scopes: [],
      claims: {},
    };
    const errorRes = createRenderMockResponse();
    await middleware(errorReq, errorRes as any, async () => {});
    errorRes.renderError(403, { message: "Forbidden", code: "DENIED" });
    const errorEnvelope = errorRes.rawJsonSent?.data as any;
    expect(errorEnvelope.result).toEqual({
      kind: "error",
      status: 403,
      code: "DENIED",
      message: "Forbidden",
      requestId: "req-1",
    });
    expect(errorEnvelope.cache.noStore).toBe(true);
    expect(errorEnvelope.cache.partition).toMatch(/^private-/u);
    expect(errorEnvelope.cache.partition).not.toContain("user-1");
    expect(errorRes.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("marks development frontend renders as no-store by default", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "development",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "development",
      config: { enabled: true },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/dashboard"), res, async () => {});
    res.render("index");

    expect(res.sent?.headers["Cache-Control"]).toBe("no-store");

    const explicitRes = createRenderMockResponse();
    await middleware(
      createMockRequest("/dashboard"),
      explicitRes,
      async () => {},
    );
    explicitRes.render(
      "index",
      {},
      { headers: { "cache-control": "private" } },
    );

    expect(explicitRes.sent?.headers["cache-control"]).toBe("private");
    expect(explicitRes.sent?.headers["Cache-Control"]).toBeUndefined();
  });

  it("binds res.renderError() to configured error pages", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/missing"), res as any, async () => {});
    res.renderError(404);

    expect(res.sent?.status).toBe(404);
    expect(res.sent?.html).toContain('data-vext-page="error/404"');
    expect(res.onSendPayload?.__vextResponseKind).toBe("render");
    expect(res.onSendPayload?.payload.page).toBe("error/404");
  });

  it("falls back when custom renderError page is missing and preserves details", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/missing"), res as any, async () => {});
    res.renderError(404, { resource: "user" }, { page: "error/custom-404" });

    const payload = res.sent?.data as any;
    expect(res.sent?.status).toBe(404);
    expect(res.sent?.html).toContain('data-vext-page="error/404"');
    expect(payload.props.error.details).toEqual({ resource: "user" });
  });

  it("renders React page with nested layout and useVextI18n()", async () => {
    const rootDir = await tempRoot();
    const frontendDir = path.join(rootDir, "src", "frontend");
    await mkdir(path.join(frontendDir, "pages", "admin"), {
      recursive: true,
    });
    await mkdir(path.join(frontendDir, "locales"), { recursive: true });
    await writeFile(
      path.join(frontendDir, "pages", "_document.html"),
      "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
    );
    await writeFile(
      path.join(frontendDir, "pages", "admin", "layout.tsx"),
      'export default function AdminLayout(props) { return <section data-layout="admin"><nav>{props.data?.menu}</nav>{props.children}</section>; }\n',
    );
    await writeFile(
      path.join(frontendDir, "pages", "admin", "index.tsx"),
      'import { useVextI18n } from "vextjs/frontend";\nexport default function AdminPage(props) { const i18n = useVextI18n(); return <main><h1>{i18n.title}</h1><span>{props.stats.users}</span></main>; }\n',
    );
    await writeFile(
      path.join(frontendDir, "locales", "en-US.ts"),
      "export default { title: 'Admin Home' };\n",
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/admin"), res as any, async () => {});
    res.render(
      "admin/index",
      { stats: { users: 7 } },
      { layoutData: { admin: { menu: "Overview" } }, locale: "en-US" },
    );

    expect(res.sent?.html).toContain('data-layout="admin"');
    expect(res.sent?.html).toContain("<h1>Admin Home</h1>");
    expect(res.sent?.html).toContain("<span>7</span>");
    expect(res.sent?.html).toContain("<nav>Overview</nav>");
  });

  it("renders a client shell without server body when ssr is false", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'export default function Page() { return <main data-ssr-body="yes">Server body</main>; }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const res = createRenderMockResponse();

    await middleware(
      createMockRequest("/client-only"),
      res as any,
      async () => {},
    );
    res.render("index", {}, { ssr: false });

    expect(res.sent?.html).toContain(
      '<div id="root" data-vext-root data-vext-page="index"></div>',
    );
    expect(res.sent?.html).not.toContain("data-ssr-body");
    expect(res.sent?.html).not.toContain("Server body");
    expect(res.onSendPayload?.payload.options.ssr).toBe(false);
  });

  it("honors global render.ssr=false for client shell rendering", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'export default function Page() { return <main data-global-ssr="yes">Global SSR body</main>; }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true, render: { ssr: false } },
    });
    const res = createRenderMockResponse();

    await middleware(
      createMockRequest("/global-csr"),
      res as any,
      async () => {},
    );
    res.render("index");

    expect(res.sent?.html).toContain(
      '<div id="root" data-vext-root data-vext-page="index"></div>',
    );
    expect(res.sent?.html).not.toContain("data-global-ssr");
    expect(res.sent?.html).not.toContain("Global SSR body");
  });

  it("updates document html lang from the render locale", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "_document.html"),
      '<!doctype html><html lang="{vext.lang}"><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>',
    );
    await mkdir(path.join(rootDir, "src", "frontend", "locales"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "locales", "en-US.ts"),
      "export default { common: { title: 'Hello' } };\n",
    );
    await writeFile(
      path.join(rootDir, "src", "frontend", "locales", "zh-CN.ts"),
      "export default { common: { title: '你好' } };\n",
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });
    const zhRes = createRenderMockResponse();
    await middleware(createMockRequest("/zh"), zhRes as any, async () => {});
    zhRes.render("index", {}, { locale: "zh-CN" });

    expect(zhRes.sent?.html).toContain('<html lang="zh-CN">');
    expect(zhRes.sent?.html).not.toContain("data-vext-lang");
    expect(zhRes.sent?.html).not.toContain("{vext.lang}");

    const defaultRes = createRenderMockResponse();
    await middleware(
      createMockRequest("/default"),
      defaultRes as any,
      async () => {},
    );
    defaultRes.render("index");

    expect(defaultRes.sent?.html).toContain('<html lang="en-US">');
  });

  it("updates static document html lang when htmlLang is managed", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "_document.html"),
      '<!doctype html><html lang="en"><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>',
    );
    await mkdir(path.join(rootDir, "src", "frontend", "locales"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "locales", "en-US.ts"),
      "export default { title: 'Hello' };\n",
    );
    await writeFile(
      path.join(rootDir, "src", "frontend", "locales", "zh-CN.ts"),
      "export default { title: '你好' };\n",
    );
    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });
    const builtDocument = await readFile(
      path.join(result.config.outDir, "index.html"),
      "utf-8",
    );

    expect(builtDocument).toContain('<html lang="en-US" data-vext-lang>');

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        i18n: { enabled: true, defaultLocale: "en-US" },
      },
    });
    const res = createRenderMockResponse();
    await middleware(
      createMockRequest("/static-lang"),
      res as any,
      async () => {},
    );
    res.render("index", {}, { locale: "zh-CN" });

    expect(res.sent?.html).toContain('<html lang="zh-CN">');
    expect(res.sent?.html).not.toContain("data-vext-lang");
  });

  it("removes the document html lang marker when htmlLang is false", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "_document.html"),
      '<!doctype html><html lang="{vext.lang}"><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
        i18n: { enabled: true, defaultLocale: "en-US", htmlLang: false },
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        i18n: { enabled: true, defaultLocale: "en-US", htmlLang: false },
      },
    });
    const res = createRenderMockResponse();

    await middleware(
      createMockRequest("/html-lang-off"),
      res as any,
      async () => {},
    );
    res.render("index", {}, { locale: "zh-CN" });

    expect(res.sent?.html).toContain("<html>");
    expect(res.sent?.html).not.toMatch(/\s+lang=/u);
    expect(res.sent?.html).not.toContain("data-vext-lang");
    expect(res.sent?.html).not.toContain("{vext.lang}");
  });

  it("falls back to a client shell when SSR exceeds render.timeoutMs", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'export default function Page() { const started = Date.now(); while (Date.now() - started < 20) {} return <main data-slow-ssr="yes">Slow SSR body</main>; }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        render: { timeoutMs: 1, fallback: "client" },
      },
    });
    const res = createRenderMockResponse();

    await middleware(createMockRequest("/slow"), res as any, async () => {});
    res.render("index");

    expect(res.sent?.html).toContain('data-vext-page="index"');
    expect(res.sent?.html).not.toContain("data-slow-ssr");
    expect(res.sent?.html).not.toContain("Slow SSR body");
  });

  it("falls back to a client shell when SSR throws and fallback is client", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'export default function Page() { throw new Error("SSR boom"); }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        render: { fallback: "client" },
      },
    });
    const res = createRenderMockResponse();

    await middleware(
      createMockRequest("/throw-client"),
      res as any,
      async () => {},
    );
    expect(() => res.render("index")).not.toThrow();
    expect(res.sent?.html).toContain('data-vext-page="index"');
  });

  it("throws when SSR fails and render.fallback is error", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "index.tsx"),
      'export default function Page() { throw new Error("SSR boom"); }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        render: { fallback: "error" },
      },
    });
    const res = createRenderMockResponse();

    await middleware(
      createMockRequest("/throw-error"),
      res as any,
      async () => {},
    );

    expect(() => res.render("index")).toThrow("SSR boom");
  });

  it("caches production render assets after the first render", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    const result = await buildFrontendClient({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        apiClient: false,
      },
    });

    const middleware = createFrontendRenderMiddleware({
      rootDir,
      mode: "production",
      config: { enabled: true },
    });
    const firstRes = createRenderMockResponse();
    await middleware(createMockRequest("/"), firstRes as any, async () => {});
    firstRes.render("index", { title: "Cached" });

    await writeFile(
      result.renderManifestPath!,
      JSON.stringify({
        kind: "frontend-render-manifest",
        buildId: "broken",
        generatedAt: "test",
        pages: [{ id: "other", route: "/other", file: "other.tsx" }],
        layouts: [],
        errorPages: [],
        serverRenderer: "server/renderer.cjs",
      }),
    );
    await writeFile(
      path.join(result.config.outDir, "index.html"),
      "<!doctype html><html><body>Broken</body></html>",
    );

    const secondRes = createRenderMockResponse();
    await middleware(
      createMockRequest("/again"),
      secondRes as any,
      async () => {},
    );
    secondRes.render("index", { title: "Cached" });

    expect(secondRes.sent?.html).toContain('data-vext-page="index"');
    expect(secondRes.sent?.html).not.toContain("Broken");
  });
});

describe("frontend api client", () => {
  const contract = {
    schemaVersion: 1,
    kind: "client-contract",
    source: "routes-manifest",
    generatedAt: "test",
    routes: [{ method: "GET", path: "/api/hello", operationId: "getApiHello" }],
    warnings: [],
  } as const;

  it("unwraps standard vext JSON responses", async () => {
    const api = createVextApiClient(contract, {
      baseUrl: "https://example.test",
      fetch: async () =>
        new Response(JSON.stringify({ code: 0, data: { ok: true } }), {
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(api.GET("/api/hello")).resolves.toEqual({ ok: true });
  });

  it("throws VextApiError for non-2xx responses", async () => {
    const api = createVextApiClient(contract, {
      baseUrl: "https://example.test",
      fetch: async () =>
        new Response(JSON.stringify({ code: 404, message: "Missing" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(api.GET("/api/hello")).rejects.toBeInstanceOf(VextApiError);
    try {
      await api.GET("/api/hello");
    } catch (error) {
      expect(isVextApiError(error)).toBe(true);
      expect((error as VextApiError).status).toBe(404);
    }
  });

  it("exposes HEAD and OPTIONS helpers for generated route methods", async () => {
    const methodContract = {
      schemaVersion: 1,
      kind: "client-contract",
      source: "routes-manifest",
      generatedAt: "test",
      routes: [
        { method: "HEAD", path: "/api/ping", operationId: "headApiPing" },
        {
          method: "OPTIONS",
          path: "/api/options",
          operationId: "optionsApiOptions",
        },
      ],
      warnings: [],
    } as const;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createVextApiClient(methodContract, {
      baseUrl: "https://example.test",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 204 });
      },
    });

    await expect(
      api.HEAD("/api/ping", { body: { ignored: true } }),
    ).resolves.toBeNull();
    await expect(
      api.OPTIONS("/api/options", {
        body: { ok: true },
        query: { preflight: "1" },
      }),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://example.test/api/ping");
    expect(calls[0]?.init?.method).toBe("HEAD");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[1]?.url).toBe("https://example.test/api/options?preflight=1");
    expect(calls[1]?.init?.method).toBe("OPTIONS");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ ok: true }));
  });
});

describe("frontend static mount", () => {
  it("fails production output readiness for incomplete SSR artifacts", async () => {
    const rootDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(outDir, { recursive: true });
    const options = {
      rootDir,
      mode: "production" as const,
      config: { enabled: true },
      fallbackHandler: async () => {},
    };

    expect(() => assertFrontendOutputReady(options)).toThrow(
      "frontend output is missing",
    );

    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");
    expect(() => assertFrontendOutputReady(options)).toThrow(
      "frontend render-manifest.json is missing",
    );

    await writeFile(path.join(outDir, "render-manifest.json"), "{");
    expect(() => assertFrontendOutputReady(options)).toThrow(
      "frontend render-manifest.json is invalid",
    );

    await writeFile(
      path.join(outDir, "render-manifest.json"),
      JSON.stringify({
        kind: "frontend-render-manifest",
        buildId: "test",
        generatedAt: "test",
        pages: [],
        layouts: [],
        errorPages: [],
        serverRenderer: "server/renderer.cjs",
      }),
    );
    expect(() => assertFrontendOutputReady(options)).toThrow(
      "frontend render-manifest.json is missing routeAssets",
    );

    await writeFile(
      path.join(outDir, "render-manifest.json"),
      JSON.stringify({
        kind: "frontend-render-manifest",
        buildId: "test",
        generatedAt: "test",
        pages: [],
        layouts: [],
        errorPages: [],
        serverRenderer: "server/renderer.cjs",
        routeAssets: { schemaVersion: 1, routes: [] },
      }),
    );
    expect(() => assertFrontendOutputReady(options)).toThrow(
      "frontend server renderer is missing",
    );

    await mkdir(path.join(outDir, "server"), { recursive: true });
    await writeFile(
      path.join(outDir, "server", "renderer.cjs"),
      "exports.renderPage = () => ({ html: '' });\n",
    );

    expect(() => assertFrontendOutputReady(options)).not.toThrow();
  });

  it("does not serve SPA fallback without an explicit scope", async () => {
    const rootDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");

    let fallbackCalled = 0;
    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        fallbackCalled += 1;
        res.rawJson({ code: 404 }, 404);
      },
    });

    const pageRes = createMockResponse();
    await handler(
      createMockRequest("/dashboard", { accept: "text/html" }),
      pageRes,
      async () => {},
    );
    expect(pageRes.streamed).toBe(false);
    expect(fallbackCalled).toBe(1);
    expect(pageRes.statusCode).toBe(404);

    const jsonRes = createMockResponse();
    await handler(
      createMockRequest("/dashboard", { accept: "application/json" }),
      jsonRes,
      async () => {},
    );
    expect(fallbackCalled).toBe(2);
    expect(jsonRes.statusCode).toBe(404);

    const apiRes = createMockResponse();
    await handler(createMockRequest("/api/missing"), apiRes, async () => {});
    expect(fallbackCalled).toBe(3);
    expect(apiRes.statusCode).toBe(404);
  });

  it("serves scoped SPA fallback from the configured page", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, "src", "frontend", "pages", "app"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "app", "shell.tsx"),
      "export default function AppShell() { return null; }\n",
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });

    let fallbackCalled = 0;
    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        spaFallback: {
          scopes: [{ basePath: "/app", page: "app/shell" }],
        },
      },
      fallbackHandler: async (_req, res) => {
        fallbackCalled += 1;
        res.rawJson({ code: 404 }, 404);
      },
    });
    const res = createRenderMockResponse();

    await handler(
      createMockRequest("/app/settings", { accept: "text/html" }),
      res as any,
      async () => {},
    );

    expect(fallbackCalled).toBe(0);
    expect(res.sent?.status).toBe(200);
    expect(res.sent?.headers.Vary).toBe("Accept");
    expect(res.sent?.html).toContain('data-vext-page="app/shell"');
  });

  it("separates scoped SPA fallback SSR and CSR shell modes", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await mkdir(path.join(rootDir, "src", "frontend", "pages", "app"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, "src", "frontend", "pages", "app", "shell.tsx"),
      'export default function AppShell() { return <main data-shell-ssr="yes">Shell SSR</main>; }\n',
    );
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });

    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: {
        enabled: true,
        spaFallback: {
          scopes: [
            { basePath: "/app", page: "app/shell", ssr: false },
            { basePath: "/ssr-app", page: "app/shell", ssr: true },
          ],
        },
      },
      fallbackHandler: async (_req, res) => {
        res.rawJson({ code: 404 }, 404);
      },
    });

    const csrRes = createRenderMockResponse();
    await handler(
      createMockRequest("/app/settings", { accept: "text/html" }),
      csrRes as any,
      async () => {},
    );

    const ssrRes = createRenderMockResponse();
    await handler(
      createMockRequest("/ssr-app/settings", { accept: "text/html" }),
      ssrRes as any,
      async () => {},
    );

    expect(csrRes.sent?.html).toContain('data-vext-page="app/shell"');
    expect(csrRes.sent?.html).not.toContain("data-shell-ssr");
    expect((csrRes.sent?.data as any).options.ssr).toBe(false);
    expect(ssrRes.sent?.html).toContain("data-shell-ssr");
    expect((ssrRes.sent?.data as any).options.ssr).toBe(true);
  });

  it("does not serve SPA fallback for Vext docs system routes", async () => {
    const rootDir = await tempRoot();
    let fallbackCalled = 0;
    let onNotFoundCalled = 0;
    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true, spaFallback: true },
      onNotFound: () => {
        onNotFoundCalled += 1;
      },
      fallbackHandler: async (_req, res) => {
        fallbackCalled += 1;
        res.rawJson({ code: 404 }, 404);
      },
    });
    const res = createMockResponse();

    await handler(
      createMockRequest("/_vext/docs/internal", { accept: "text/html" }),
      res,
      async () => {},
    );

    expect(onNotFoundCalled).toBe(0);
    expect(fallbackCalled).toBe(1);
    expect(res.statusCode).toBe(404);
  });

  it("renders HTML 404 error page for non-fallback navigation", async () => {
    const rootDir = await tempRoot();
    await createMinimalFrontend(rootDir);
    await buildFrontendClient({
      rootDir,
      mode: "production",
      config: { enabled: true, apiClient: false },
    });

    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        res.rawJson({ code: 404 }, 404);
      },
    });
    const res = createRenderMockResponse();

    await handler(
      createMockRequest("/missing-page", { accept: "text/html" }),
      res as any,
      async () => {},
    );

    const payload = res.sent?.data as any;
    expect(res.sent?.status).toBe(404);
    expect(res.sent?.headers.Vary).toBe("Accept");
    expect(res.sent?.html).toContain('data-vext-page="error/404"');
    expect(payload.props.error).toMatchObject({
      status: 404,
      code: 404,
      requestId: "req-1",
    });
  });

  it("keeps missing static assets on the JSON 404 path", async () => {
    const rootDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");

    let fallbackCalled = 0;
    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        fallbackCalled += 1;
        res.rawJson({ code: 404 }, 404);
      },
    });

    const res = createMockResponse();
    await handler(
      createMockRequest("/assets/missing.js", { accept: "text/html" }),
      res,
      async () => {},
    );

    expect(fallbackCalled).toBe(1);
    expect(res.statusCode).toBe(404);
    expect(res.streamed).toBe(false);
  });

  it("does not serve a file through a junction that escapes staticRoot", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");
    await writeFile(path.join(outsideDir, "secret.txt"), "outside-secret");
    await symlink(
      outsideDir,
      path.join(outDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    let fallbackCalled = 0;
    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        fallbackCalled += 1;
        res.rawJson({ code: 404 }, 404);
      },
    });
    const res = createMockResponse();

    await handler(createMockRequest("/linked/secret.txt"), res, async () => {});

    expect(res.streamed).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(fallbackCalled).toBe(1);
  });

  it("uses immutable cache only for content-hashed bundle assets", async () => {
    const rootDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(path.join(outDir, "assets"), { recursive: true });
    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");
    await writeFile(path.join(outDir, "favicon.svg"), "<svg />");
    await writeFile(path.join(outDir, "assets", "main-Q3BPGNZI.js"), "app");
    await writeFile(path.join(outDir, "assets", "main.js"), "app");
    await writeFile(path.join(outDir, "assets", "main-Q3BPGNZI.js.map"), "{}");

    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        res.rawJson({ code: 404 }, 404);
      },
    });

    const indexRes = createMockResponse();
    await handler(createMockRequest("/index.html"), indexRes, async () => {});
    expect(indexRes.headers["Cache-Control"]).toBe("no-cache");

    const publicRes = createMockResponse();
    await handler(createMockRequest("/favicon.svg"), publicRes, async () => {});
    expect(publicRes.headers["Cache-Control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );

    const hashedBundleRes = createMockResponse();
    await handler(
      createMockRequest("/assets/main-Q3BPGNZI.js"),
      hashedBundleRes,
      async () => {},
    );
    expect(hashedBundleRes.headers["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    const unhashedBundleRes = createMockResponse();
    await handler(
      createMockRequest("/assets/main.js"),
      unhashedBundleRes,
      async () => {},
    );
    expect(unhashedBundleRes.headers["Cache-Control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );

    const sourceMapRes = createMockResponse();
    await handler(
      createMockRequest("/assets/main-Q3BPGNZI.js.map"),
      sourceMapRes,
      async () => {},
    );
    expect(sourceMapRes.headers["Cache-Control"]).toBe(
      "no-cache, max-age=0, must-revalidate",
    );
  });

  it("serves conditional static requests without source entity length on 304", async () => {
    const rootDir = await tempRoot();
    const outDir = path.join(rootDir, "dist", "client");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), "<main>app</main>");

    const handler = createFrontendNotFoundHandler({
      rootDir,
      mode: "production",
      config: { enabled: true },
      fallbackHandler: async (_req, res) => {
        res.rawJson({ code: 404 }, 404);
      },
    });

    const firstRes = createMockResponse();
    await handler(createMockRequest("/index.html"), firstRes, async () => {});
    expect(firstRes.headers.ETag).toBeDefined();
    expect(firstRes.headers["Last-Modified"]).toBeDefined();
    expect(firstRes.headers["Content-Length"]).toBe("16");

    const etagRes = createMockResponse();
    await handler(
      createMockRequest("/index.html", {
        "if-none-match": firstRes.headers.ETag,
      }),
      etagRes,
      async () => {},
    );

    expect(etagRes.statusCode).toBe(304);
    expect(etagRes.headers["Content-Length"]).not.toBe("16");
    expect(etagRes.streamed).toBe(false);

    const modifiedSinceRes = createMockResponse();
    await handler(
      createMockRequest("/index.html", {
        "if-modified-since": firstRes.headers["Last-Modified"],
      }),
      modifiedSinceRes,
      async () => {},
    );

    expect(modifiedSinceRes.statusCode).toBe(304);
    expect(modifiedSinceRes.headers["Content-Length"]).not.toBe("16");
    expect(modifiedSinceRes.streamed).toBe(false);

    const headReq = createMockRequest("/index.html", {
      "if-modified-since": firstRes.headers["Last-Modified"],
    });
    headReq.method = "HEAD";
    const headRes = createMockResponse();
    await handler(headReq, headRes, async () => {});

    expect(headRes.statusCode).toBe(304);
    expect(headRes.headers["Content-Length"]).not.toBe("16");
    expect(headRes.streamed).toBe(false);

    const mismatchedEtagRes = createMockResponse();
    await handler(
      createMockRequest("/index.html", {
        "if-none-match": 'W/"stale"',
        "if-modified-since": firstRes.headers["Last-Modified"],
      }),
      mismatchedEtagRes,
      async () => {},
    );

    expect(mismatchedEtagRes.statusCode).toBe(200);
    expect(mismatchedEtagRes.headers["Content-Length"]).toBe("16");
    expect(mismatchedEtagRes.streamed).toBe(true);
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vext-frontend-"));
  tempDirs.push(dir);
  return dir;
}

function typecheckJscssUserGuide(files: string[]): string[] {
  const sourceRoot = process.cwd();
  const documentedFiles = new Set(files.map((file) => path.resolve(file)));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: sourceRoot,
    paths: {
      react: ["node_modules/@types/react/index.d.ts"],
      "react/jsx-runtime": ["node_modules/@types/react/jsx-runtime.d.ts"],
      "vextjs/style": ["src/frontend/style/index.ts"],
    },
  });

  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file &&
        documentedFiles.has(path.resolve(diagnostic.file.fileName)),
    )
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      );

      return `${diagnostic.file!.fileName}: ${message}`;
    });
}

async function createMinimalFrontend(rootDir: string): Promise<void> {
  const frontendDir = path.join(rootDir, "src", "frontend");
  await mkdir(path.join(frontendDir, "pages", "error"), {
    recursive: true,
  });
  await mkdir(path.join(frontendDir, "styles"), { recursive: true });
  await writeFile(
    path.join(frontendDir, "pages", "_document.html"),
    "<!doctype html><html><head>{vext.styles}</head><body>{vext.root}{vext.data}{vext.entry}</body></html>",
  );
  await writeFile(
    path.join(frontendDir, "pages", "index.tsx"),
    "export default function Page() { return null; }\n",
  );
  await writeFile(
    path.join(frontendDir, "pages", "error", "404.tsx"),
    "export default function NotFound() { return null; }\n",
  );
  await writeFile(
    path.join(frontendDir, "styles", "index.css"),
    "body { margin: 0; }\n",
  );
}

async function readFrontendManifestFamily(
  outDir: string,
): Promise<Record<string, string>> {
  const files = [
    "manifest.json",
    "render-manifest.json",
    "messages-manifest.json",
    "deploy-manifest.json",
    "size-report.json",
  ];
  const entries = await Promise.all(
    files.map(async (file) => [
      file,
      await readFile(path.join(outDir, file), "utf-8"),
    ]),
  );
  return Object.fromEntries(entries);
}

async function readTextFiles(
  dir: string,
  extension: string,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await readTextFiles(filePath, extension)));
      continue;
    }
    if (entry.name.endsWith(extension)) {
      results.push(await readFile(filePath, "utf-8"));
    }
  }
  return results;
}

function createMockRequest(
  pathname: string,
  headers: Record<string, string | undefined> = {},
) {
  return {
    method: "GET",
    path: pathname,
    url: pathname,
    route: pathname,
    headers,
    requestId: "req-1",
    auth: {
      isAuthenticated: false,
      roles: [],
      scopes: [],
      claims: {},
    },
  } as any;
}

function createMockResponse() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    streamed: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    text(_content: string, status?: number) {
      if (status) this.statusCode = status;
    },
    rawJson(_data: unknown, status?: number) {
      if (status) this.statusCode = status;
    },
    stream(readable: NodeJS.ReadableStream) {
      trackReadable(readable);
      this.streamed = true;
    },
  };
  return res as any;
}

function createRenderMockResponse() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, any>,
    rawJsonSent: undefined as
      | { data: unknown; status: number; headers: Record<string, any> }
      | undefined,
    sent: undefined as
      | {
          html: string;
          status: number;
          headers: Record<string, string>;
          kind: "html" | "render";
          data?: unknown;
        }
      | undefined,
    onSendPayload: undefined as any,
    _onSend(data: any) {
      this.onSendPayload = data;
    },
    setHeader(name: string, value: any) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    rawJson(data: unknown, status?: number) {
      this.statusCode = status ?? this.statusCode;
      this.rawJsonSent = {
        data,
        status: this.statusCode,
        headers: { ...this.headers },
      };
    },
    redirect() {},
    _sendHtml(
      html: string,
      status: number,
      headers: Record<string, string>,
      kind: "html" | "render",
      data?: unknown,
    ) {
      this.statusCode = status;
      this.sent = { html, status, headers, kind, data };
    },
  };
  return res;
}

function trackReadable(readable: NodeJS.ReadableStream): void {
  pendingStreams.push(
    new Promise<void>((resolve) => {
      let settled = false;
      const stream = readable as NodeJS.ReadableStream & {
        off?: (event: string, listener: () => void) => void;
        resume?: () => unknown;
      };
      const done = () => {
        if (settled) return;
        settled = true;
        stream.off?.("close", done);
        stream.off?.("end", done);
        stream.off?.("error", done);
        resolve();
      };

      stream.once("close", done);
      stream.once("end", done);
      stream.once("error", done);
      stream.resume?.();
    }),
  );
}
