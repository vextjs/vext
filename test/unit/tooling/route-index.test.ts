import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildRouteIndex } from "../../../src/tooling/project-index/scan-routes.js";
import { runDoctor } from "../../../src/tooling/doctor/index.js";

async function writeProjectFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(rootDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

describe("buildRouteIndex", () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("extracts normalized route paths and docs metadata from defineRoutes files", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-"));

    await writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify({ name: "route-index", type: "module" }, null, 2),
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
      "src/routes/api/v2/index.ts",
      `import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/health", {
    docs: {
      summary: "Health check",
      operationId: "getApiV2Health",
      tags: ["system", "health"],
    },
  }, async (_req, res) => {
    res.json({ ok: true });
  });
});
`,
    );

    const routeEntries = await buildRouteIndex(projectRoot);

    expect(routeEntries).toHaveLength(1);
    expect(routeEntries[0]).toMatchObject({
      fileRelativePath: "src/routes/api/v2/index.ts",
      method: "GET",
      prefix: "/api/v2",
      path: "/api/v2/health",
      docsSummary: "Health check",
      hasDocsSummary: true,
      operationId: "getApiV2Health",
      tags: ["system", "health"],
      hidden: false,
    });
  });

  it("uses the same route file exclusion policy as runtime loading", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-policy-"));

    await writeProjectFile(
      projectRoot,
      "src/routes/.hidden.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", async (_req, res) => res.json({ hidden: true }));
});
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/users.test.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", async (_req, res) => res.json({ test: true }));
});
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/node_modules/pkg/route.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", async (_req, res) => res.json({ pkg: true }));
});
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/users.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", async (_req, res) => res.json({ ok: true }));
});
`,
    );

    const routeEntries = await buildRouteIndex(projectRoot);

    expect(routeEntries.map((entry) => entry.fileRelativePath)).toEqual([
      "src/routes/users.ts",
    ]);
    expect(routeEntries[0]?.path).toBe("/users");
  });

  it("projects literal RouteOptions.frontend into the build manifest identity", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-freshness-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/posts/[slug].ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", {
    frontend: {
      mode: "static",
      staticParams: [{ slug: "hello", page: 2 }, {}],
      hydration: "none",
      seo: {
        title: "Static post",
        description: "A statically rendered post",
        robots: ["index", "follow"],
        canonical: "/posts/hello",
        openGraph: {
          type: "article",
          images: [{ url: "/og/post.png", width: 1200 }],
        },
        twitter: { card: "summary_large_image" },
        alternates: [{ hrefLang: "en", href: "/posts/hello" }],
        jsonLd: { "@type": "Article", headline: "Hello" },
        originKey: "primary",
        index: true,
      },
      tags: ["posts", "news"],
      page: "posts/detail",
      staticBudget: { maxParams: 4, maxBytes: 4096 },
    },
  }, async (_req, res) => res.render("posts/detail"));
});
`,
    );

    const [entry] = await buildRouteIndex(projectRoot);

    expect(entry?.freshness).toEqual({
      mode: "static",
      source: "route-options",
      staticParams: [{ page: "2", slug: "hello" }, {}],
      hydration: "none",
      seo: {
        title: "Static post",
        description: "A statically rendered post",
        robots: ["index", "follow"],
        canonical: "/posts/hello",
        openGraph: {
          type: "article",
          images: [{ url: "/og/post.png", width: 1200 }],
        },
        twitter: { card: "summary_large_image" },
        alternates: [{ hrefLang: "en", href: "/posts/hello" }],
        jsonLd: { "@type": "Article", headline: "Hello" },
        originKey: "primary",
        index: true,
      },
      tags: ["news", "posts"],
      page: "posts/detail",
      staticBudget: { maxParams: 4, maxBytes: 4096 },
    });
  });

  it("resolves const frontend metadata when it is statically projectable", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-dynamic-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";

const serverOnly = {
  hydration: "none" as const,
  seo: { title: "Dynamic declaration" },
};

export default defineRoutes((app) => {
  app.get("/dynamic", { frontend: serverOnly }, async (_req, res) => {
    res.render("index");
  });
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).resolves.toEqual([
      expect.objectContaining({
        path: "/dynamic",
        freshness: expect.objectContaining({
          hydration: "none",
          seo: { title: "Dynamic declaration" },
        }),
      }),
    ]);
  });

  it("resolves a complete const route options expression", async () => {
    projectRoot = await mkdtemp(
      join(tmpdir(), "vext-route-index-options-expression-"),
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";

const routeOptions = {
  frontend: { hydration: "none" as const },
};

export default defineRoutes((app) => {
  app.get("/dynamic", routeOptions, async (_req, res) => {
    res.render("index");
  });
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).resolves.toEqual([
      expect.objectContaining({
        path: "/dynamic",
        freshness: expect.objectContaining({ hydration: "none" }),
      }),
    ]);
  });

  it("uses lexical masking and projects same-file const route contracts", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-static-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";

const ROUTE_PATH = "/items/:id" as const;
const validation = {
  param: { id: "string!" },
  query: { page: "number:1-!", search: "string?" },
};
const routeOptions = {
  ignored: { docs: { summary: "Nested decoy" } },
  validate: validation,
  docs: {
    summary: "Static item",
    operationId: "getStaticItem",
  },
  frontend: { mode: "dynamic", tags: ["items"] },
};
const unicodeDecoy = "😀 app.get('/unicode-decoy', {}, handler)";
const fakePattern = /app\\.get\\(\"\\/fake\", { docs: { summary: \"Fake\" } }\\)/;

export default defineRoutes((app) => {
  // app.get("/commented", {}, handler);
  app.get(
    ROUTE_PATH,
    routeOptions,
    async (req, res) => res.json({ id: req.params.id }),
  );
});
`,
    );

    const [entry] = await buildRouteIndex(projectRoot);

    expect(entry).toMatchObject({
      method: "GET",
      path: "/items/:id",
      docsSummary: "Static item",
      operationId: "getStaticItem",
      freshness: { mode: "dynamic", source: "route-options", tags: ["items"] },
      schema: {
        request: {
          params: expect.objectContaining({
            source: "validate",
            sourcePath: "validate.param",
          }),
          query: expect.objectContaining({
            source: "validate",
            sourcePath: "validate.query",
          }),
        },
      },
    });
    expect(entry?.schema.request.params?.schema).toMatchObject({
      type: "object",
      required: ["id"],
    });
    expect(entry?.schema.request.query?.schema).toMatchObject({
      type: "object",
      required: ["page"],
    });
  });

  it("fails closed for route options helper calls with migration context", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-helper-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
const routeOptions = { frontend: { mode: "dynamic" } };
function forceStatic(options) {
  return { ...options, frontend: { mode: "static", static: true } };
}
export default defineRoutes((app) => {
  app.get("/items", forceStatic(routeOptions), handler);
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(
      /src\/routes\/index\.ts GET \/items route options helper calls.*inline.*same-file const/u,
    );
  });

  it("projects canonical schemaAdapter field builders with static arguments", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-builder-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes, schemaAdapter as schema } from "vextjs";
const CONTENT_RULE = "string:1-20000!";
const CONTENT_DESCRIPTION = "Text to translate";
const contentField = schema
  .compileField(CONTENT_RULE)
  .description(CONTENT_DESCRIPTION);

export default defineRoutes((app) => {
  app.post("/translate", {
    validate: {
      body: {
        content: contentField,
        format: schema.compileField("enum:plain_text,preserve_line_breaks!"),
      },
    },
  }, handler);
});
`,
    );

    const [entry] = await buildRouteIndex(projectRoot);
    expect(entry?.schema.request.body?.schema).toMatchObject({
      type: "object",
      required: ["content", "format"],
      properties: {
        content: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Text to translate",
        },
        format: {
          type: "string",
          enum: ["plain_text", "preserve_line_breaks"],
        },
      },
    });
  });

  it.each([
    [
      "dynamic builder argument",
      `import { defineRoutes, schemaAdapter } from "vextjs";
export default defineRoutes((app) => {
  app.post("/items", { validate: { body: {
    name: schemaAdapter.compileField(getRule()),
  } } }, handler);
});
`,
      /schemaAdapter\.compileField.*statically resolvable string argument/u,
    ],
    [
      "unknown builder chain",
      `import { defineRoutes, schemaAdapter } from "vextjs";
export default defineRoutes((app) => {
  app.post("/items", { validate: { body: {
    name: schemaAdapter.compileField("string!").description("Name").optional(),
  } } }, handler);
});
`,
      /unsupported schemaAdapter call chain/u,
    ],
    [
      "opaque third-party schema",
      `import { defineRoutes } from "vextjs";
import { z } from "zod";
export default defineRoutes((app) => {
  app.post("/items", { validate: { body: { name: z.string() } } }, handler);
});
`,
      /opaque\/imported schema objects and other call chains are not supported/u,
    ],
    [
      "untrusted schemaAdapter provenance",
      `import { defineRoutes } from "vextjs";
import { schemaAdapter } from "./schema.js";
export default defineRoutes((app) => {
  app.post("/items", { validate: { body: {
    name: schemaAdapter.compileField("string!"),
  } } }, handler);
});
`,
      /opaque\/imported schema objects and other call chains are not supported/u,
    ],
  ])(
    "fails closed for unsupported schema value: %s",
    async (_label, source, error) => {
      projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-schema-"));
      await writeProjectFile(projectRoot, "src/routes/index.ts", source);

      await expect(buildRouteIndex(projectRoot)).rejects.toThrow(error);
    },
  );

  it("does not treat a property-chain lookalike as the defineRoutes receiver", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-receiver-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  services.app.get("/not-a-vext-route", dynamicOptions, handler);
  app.get("/real", async (_req, res) => res.json({ ok: true }));
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).resolves.toEqual([
      expect.objectContaining({ method: "GET", path: "/real" }),
    ]);
  });

  it("does not treat a property-chain defineRoutes lookalike as a route block", async () => {
    projectRoot = await mkdtemp(
      join(tmpdir(), "vext-route-index-define-routes-receiver-"),
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";

helpers.defineRoutes((app) => {
  app.get("/not-a-vext-route", dynamicOptions, handler);
});

export default defineRoutes((app) => {
  app.get("/real", async (_req, res) => res.json({ ok: true }));
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).resolves.toEqual([
      expect.objectContaining({ method: "GET", path: "/real" }),
    ]);
  });

  it("projects only the supported default-exported defineRoutes shapes", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-exports-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/alias.ts",
      `import { defineRoutes as routes } from "vextjs";
export default routes(function (app) {
  app.get("/", handler);
});
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/bound.ts",
      `import { defineRoutes } from "vextjs";
const routeDefinition = defineRoutes((app) => {
  app.get("/", handler);
});
export default routeDefinition;
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/named.ts",
      `import { defineRoutes } from "vextjs";
const routeDefinition = defineRoutes((app) => {
  app.get("/", handler);
});
export { routeDefinition as default };
`,
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/phantom.ts",
      `import { defineRoutes } from "vextjs";
const unused = defineRoutes((app) => {
  app.get("/not-exported", dynamicOptions, handler);
});
export default defineRoutes((app) => {
  app.get("/", handler);
});
`,
    );

    const routePaths = (await buildRouteIndex(projectRoot))
      .map((entry) => entry.path)
      .sort();
    expect(routePaths).toEqual(["/alias", "/bound", "/named", "/phantom"]);
  });

  it.each([
    [
      "async factory",
      `import { defineRoutes } from "vextjs";
export default defineRoutes(async (app) => {
  app.get("/", handler);
});
`,
      /src\/routes\/index\.ts.*factory must be synchronous/u,
    ],
    [
      "missing default export",
      `import { defineRoutes } from "vextjs";
export const routeDefinition = defineRoutes((app) => {
  app.get("/", handler);
});
`,
      /src\/routes\/index\.ts.*must default-export/u,
    ],
    [
      "default re-export",
      `import { defineRoutes } from "vextjs";
export { routeDefinition as default } from "./shared.js";
`,
      /src\/routes\/index\.ts.*must not re-export/u,
    ],
    [
      "callback identifier",
      `import { defineRoutes } from "vextjs";
const register = (app) => app.get("/", handler);
export default defineRoutes(register);
`,
      /src\/routes\/index\.ts.*requires an inline arrow or function expression/u,
    ],
    [
      "property callee",
      `import { defineRoutes } from "vextjs";
export default helpers.defineRoutes((app) => {
  app.get("/", handler);
});
`,
      /src\/routes\/index\.ts.*default export must be a local defineRoutes/u,
    ],
  ])(
    "fails closed for unsupported route module shape: %s",
    async (_label, source, error) => {
      projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-shape-"));
      await writeProjectFile(projectRoot, "src/routes/index.ts", source);

      await expect(buildRouteIndex(projectRoot)).rejects.toThrow(error);
    },
  );

  it("fails closed for route registration nested under runtime control flow", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-nested-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  if (process.env.ENABLE_INTERNAL_ROUTE) {
    app.get("/conditional", async (_req, res) => res.json({ ok: true }));
  }
  app.get("/real", async (_req, res) => res.json({ ok: true }));
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(
      /src\/routes\/index\.ts GET.*direct top-level statement/u,
    );
  });

  it("fails closed for an unbraced conditional route registration", async () => {
    projectRoot = await mkdtemp(
      join(tmpdir(), "vext-route-index-unbraced-conditional-"),
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  if (process.env.ENABLE_INTERNAL_ROUTE)
    app.get("/conditional", async (_req, res) => res.json({ ok: true }));
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(
      /src\/routes\/index\.ts GET.*direct top-level statement/u,
    );
  });

  it("mirrors JavaScript last-property-wins semantics for indexed options", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-duplicate-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.js",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/items", {
    validate: { query: { first: "string!" } },
    validate: { query: { last: "integer!" } },
  }, handler);
});
`,
    );

    const [entry] = await buildRouteIndex(projectRoot);
    expect(entry?.schema.request.query?.schema).toMatchObject({
      properties: { last: expect.any(Object) },
      required: ["last"],
    });
    expect(entry?.schema.request.query?.schema).not.toHaveProperty(
      "properties.first",
    );
  });

  it("fails closed instead of silently ignoring computed route-option keys", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-computed-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.js",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/items", {
    ["validate"]: { query: { page: "integer!" } },
  }, handler);
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(
      /route options.*computed property keys/u,
    );
  });

  it.each([
    [
      "dynamic path",
      'const suffix = "items"; app.get(`/api/${suffix}`, {}, handler);',
      /src\/routes\/index\.ts GET.*route path.*statically resolvable/u,
    ],
    [
      "unsupported escaped path literal",
      'app.get("/caf\\u00e9", {}, handler);',
      /src\/routes\/index\.ts GET.*route path.*statically resolvable/u,
    ],
    [
      "dynamic validate schema",
      'app.get("/items", { validate: { query: createSchema() } }, handler);',
      /src\/routes\/index\.ts GET \/items.*validate.*statically resolvable/u,
    ],
    [
      "dynamic response schema",
      'app.get("/items", { responses: { 200: { schema: createSchema() } } }, handler);',
      /src\/routes\/index\.ts GET \/items.*responses\.200\.schema.*statically resolvable/u,
    ],
  ])("fails closed with context for %s", async (_label, declaration, error) => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-closed-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  ${declaration}
});
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(error);
  });

  it("fails closed when a referenced same-file const binding is ambiguous", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-ambiguous-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";

const routeOptions = { validate: { query: { page: "number!" } } };

export default defineRoutes((app) => {
  app.get("/items", routeOptions, handler);
});

function shadowedScope() {
  const routeOptions = { validate: { query: { cursor: "string!" } } };
  return routeOptions;
}
`,
    );

    await expect(buildRouteIndex(projectRoot)).rejects.toThrow(
      /src\/routes\/index\.ts GET \/items route options.*ambiguous same-file const binding "routeOptions"/u,
    );
  });

  it("keeps literal response schemas and page-route classification in the static build manifest", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "vext-route-index-contract-"));
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/", {}, async (_req, res) => {
    res.render("index", { message: "Hello" });
  });

  app.get("/api/health", {
    responses: {
      "2XX": {
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            timestamp: { type: "number" },
          },
          required: ["status", "timestamp"],
          additionalProperties: false,
        },
      },
    },
    docs: {
      summary: "Health check",
      responses: {
        "2xx": {
          contentType: "application/json",
          description: "Healthy",
        },
      },
    },
  }, async (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });
});
`,
    );

    const result = await runDoctor({
      rootDir: projectRoot,
      target: "routes",
      refresh: true,
      writeManifest: true,
    });
    const page = result.routes.find((route) => route.path === "/");
    const api = result.routes.find((route) => route.path === "/api/health");

    expect(page?.docsKind).toBe("frontend-route");
    expect(api?.docsKind).toBe("backend-api");
    expect(api?.schema.responses[0]).toMatchObject({
      status: "2xx",
      contentType: "application/json",
      schema: {
        source: "responses",
        sourcePath: "responses.2xx.schema",
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            timestamp: { type: "number" },
          },
          required: ["status", "timestamp"],
          additionalProperties: false,
        },
      },
    });

    const manifest = JSON.parse(
      await readFile(
        join(projectRoot, ".vext", "manifest", "routes.json"),
        "utf-8",
      ),
    ) as { routes: Array<{ path: string; docsKind: string; schema: unknown }> };
    expect(manifest.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/", docsKind: "frontend-route" }),
        expect.objectContaining({
          path: "/api/health",
          docsKind: "backend-api",
          schema: expect.objectContaining({
            responses: expect.arrayContaining([
              expect.objectContaining({
                status: "2xx",
                schema: expect.objectContaining({ source: "responses" }),
              }),
            ]),
          }),
        }),
      ]),
    );
  });

  it("keeps docs-only response schemas out of RouteOptions.responses", async () => {
    projectRoot = await mkdtemp(
      join(tmpdir(), "vext-route-index-docs-response-"),
    );
    await writeProjectFile(
      projectRoot,
      "src/routes/index.ts",
      `import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/api/health", {
    docs: {
      summary: "Health check",
      responses: {
        200: {
          description: "Healthy",
          schema: { status: "string", timestamp: "number" },
        },
      },
    },
  }, async (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });
});
`,
    );

    const result = await runDoctor({
      rootDir: projectRoot,
      target: "routes",
      refresh: true,
      writeManifest: true,
    });
    const api = result.routes.find((route) => route.path === "/api/health");

    expect(api?.schema.responses).toEqual([
      expect.objectContaining({
        status: "200",
        schema: expect.objectContaining({
          source: "docs.responses",
          sourcePath: "docs.responses.200.schema",
          schema: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]);
  });
});
