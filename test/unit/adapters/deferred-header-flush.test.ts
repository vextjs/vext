import { describe, expect, it } from "vitest";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestApp } from "../../../src/testing/index.js";

const ADAPTERS = ["native", "express", "fastify", "koa", "hono"] as const;

describe("onion post-next header flush", () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter} applies setHeader after await next() on the final response`, async () => {
      const root = resolve(
        process.cwd(),
        `tmp-deferred-header-test-${adapter}`,
      );
      const distEntry = resolve(process.cwd(), "dist/index.js");
      try {
        await access(distEntry);
      } catch {
        throw new Error(
          `deferred-header-flush requires built dist at ${distEntry}; run npm run build first`,
        );
      }
      const esm = pathToFileURL(distEntry).href;
      await rm(root, { recursive: true, force: true });
      await mkdir(resolve(root, "src/middlewares"), { recursive: true });
      await mkdir(resolve(root, "src/routes"), { recursive: true });
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      await writeFile(
        resolve(root, "src/middlewares/after.mjs"),
        `import { defineMiddleware } from ${JSON.stringify(esm)};
export default defineMiddleware(async (req, res, next) => {
  req.tag = "before";
  await next();
  res.setHeader("x-after", "1");
});
`,
      );
      await writeFile(
        resolve(root, "src/routes/index.mjs"),
        `import { defineRoutes } from ${JSON.stringify(esm)};
export default defineRoutes((app) => {
  app.get("/ok", { middlewares: ["after"] }, async (req, res) => {
    res.setHeader("x-handler", "1").json({ tag: req.tag });
  });
});
`,
      );

      // Prefer source createTestApp against built adapters via package layout.
      const app = await createTestApp({
        rootDir: root,
        services: false,
        middlewares: true,
        config: {
          adapter,
          logger: { level: "silent" },
          response: { wrap: false },
          cors: { enabled: false },
          rateLimit: { enabled: false },
          accessLog: { enabled: false },
          middlewares: ["after"],
        },
      });

      try {
        const response = await app.request.get("/ok");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ tag: "before" });
        expect(response.headers["x-handler"]).toBe("1");
        expect(response.headers["x-after"]).toBe("1");
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`${adapter} replaces a staged success when session persistence fails`, async () => {
      const root = resolve(
        process.cwd(),
        `tmp-session-barrier-test-${adapter}`,
      );
      const distEntry = resolve(process.cwd(), "dist/index.js");
      const esm = pathToFileURL(distEntry).href;
      await rm(root, { recursive: true, force: true });
      await mkdir(resolve(root, "src/routes"), { recursive: true });
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      await writeFile(
        resolve(root, "src/routes/index.mjs"),
        `import { defineRoutes } from ${JSON.stringify(esm)};
export default defineRoutes((app) => {
  app.get("/session-failure", async (req, res) => {
    req.session.userId = "u1";
    res.json({ ok: true });
  });
});
`,
      );
      const store = {
        async get() {
          return null;
        },
        async set() {
          throw new Error("store unavailable");
        },
        async delete() {},
      };
      const app = await createTestApp({
        rootDir: root,
        services: false,
        middlewares: false,
        config: {
          adapter,
          logger: { level: "silent" },
          response: { wrap: false },
          cors: { enabled: false },
          rateLimit: { enabled: false },
          accessLog: { enabled: false },
          session: { enabled: true, store, ttl: 60 },
        },
      });

      try {
        const response = await app.request.get("/session-failure");
        expect(response.status).toBe(500);
        expect(response.body).not.toEqual({ ok: true });
        expect(response.headers["set-cookie"]).toBeUndefined();
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
