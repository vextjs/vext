import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFrontendConfig } from "../../src/frontend/tooling/config-resolver.js";
import {
  renderRobotsTxt,
  renderSitemapDocuments,
  validateSitemapEntries,
  writeFrontendSeoArtifacts,
} from "../../src/frontend/tooling/seo-artifact-writer.js";
import {
  resolveSeoHead,
  selectRuntimeOrigin,
} from "../../src/frontend/runtime/seo.js";
import {
  assertNoFrontendSeoRouteConflicts,
  registerFrontendSeoEndpoints,
} from "../../src/frontend/runtime/seo-endpoints.js";
import { getFrontendContentType } from "../../src/frontend/deploy/content-type.js";
import { RouteMetadataCollector } from "../../src/lib/openapi/collector.js";
import { createRouteFreshnessIdentity } from "../../src/frontend/contract/schema-ir.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("frontend SEO head", () => {
  it("derives a different canonical for each pathname and preserves merge order", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test/site/",
          titleTemplate: "%s | Vext",
          defaults: {
            title: "Default",
            description: "Default description",
            openGraph: { siteName: "Vext" },
          },
        },
      },
      { rootDir, mode: "production" },
    );

    const first = resolveSeoHead({
      config: config.seo,
      pathname: "/posts/first",
      route: { title: "Route title", description: "Route description" },
      render: {
        title: "First post",
        openGraph: {
          images: [
            { url: "/images/first.png", alt: "First", width: 1200 },
            "/images/second.png",
          ],
        },
        twitter: { card: "summary_large_image", images: ["/images/card.png"] },
        jsonLd: { "@type": "Article", headline: "First post" },
      },
    });
    const second = resolveSeoHead({
      config: config.seo,
      pathname: "/posts/second",
      render: { title: "Second post" },
    });

    expect(first.title).toBe("First post | Vext");
    expect(first.description).toBe("Route description");
    expect(first.links).toContainEqual({
      rel: "canonical",
      href: "https://www.example.test/site/posts/first",
    });
    expect(second.links).toContainEqual({
      rel: "canonical",
      href: "https://www.example.test/site/posts/second",
    });
    expect(first.properties).toMatchObject({
      "og:title": "First post",
      "og:description": "Route description",
      "og:site_name": "Vext",
      "og:url": "https://www.example.test/site/posts/first",
    });
    expect(first.propertyMeta).toEqual([
      {
        property: "og:image",
        content: "https://www.example.test/site/images/first.png",
      },
      { property: "og:image:alt", content: "First" },
      { property: "og:image:width", content: "1200" },
      {
        property: "og:image",
        content: "https://www.example.test/site/images/second.png",
      },
    ]);
    expect(first.nameMeta).toEqual([
      {
        name: "twitter:image",
        content: "https://www.example.test/site/images/card.png",
      },
    ]);
  });

  it("keeps structured repeated metadata unless legacy head overrides the same semantic key", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
        },
      },
      { rootDir, mode: "production" },
    );

    const merged = resolveSeoHead({
      config: config.seo,
      pathname: "/post",
      route: {
        twitter: { images: ["/twitter.png"] },
        openGraph: { images: ["/og.png"] },
      },
      head: {
        nameMeta: [{ name: "author", content: "Ada" }],
        propertyMeta: [{ property: "article:section", content: "Engineering" }],
      },
    });

    expect(merged.nameMeta).toEqual([
      {
        name: "twitter:image",
        content: "https://www.example.test/twitter.png",
      },
      { name: "author", content: "Ada" },
    ]);
    expect(merged.propertyMeta).toEqual([
      {
        property: "og:image",
        content: "https://www.example.test/og.png",
      },
      { property: "article:section", content: "Engineering" },
    ]);

    const overridden = resolveSeoHead({
      config: config.seo,
      pathname: "/post",
      route: { twitter: { images: ["/structured.png"] } },
      head: {
        nameMeta: [
          { name: "twitter:image", content: "https://cdn.example/legacy.png" },
        ],
      },
    });
    expect(overridden.nameMeta).toEqual([
      { name: "twitter:image", content: "https://cdn.example/legacy.png" },
    ]);
  });

  it("selects only declared finite origins and rejects unknown keys", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          origins: { cn: "https://cn.example.test:8443/base" },
        },
      },
      { rootDir, mode: "production" },
    );

    expect(selectRuntimeOrigin(config.seo, "CN.EXAMPLE.TEST:8443")).toEqual({
      origin: "https://cn.example.test:8443/base",
      originKey: "cn",
    });
    expect(
      selectRuntimeOrigin(config.seo, "unknown.example.test"),
    ).toBeUndefined();
    expect(() =>
      resolveSeoHead({
        config: config.seo,
        pathname: "/",
        route: { originKey: "missing" },
      }),
    ).toThrow(/originKey "missing" is not declared/u);
  });

  it("deeply normalizes SEO metadata and rejects incomplete or unsafe values", async () => {
    const rootDir = await tempRoot();
    const normalized = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          defaults: {
            title: "  Default title  ",
            robots: [" index ", " follow "],
            alternates: [{ hrefLang: " en ", href: "/en" }],
            openGraph: {
              images: [
                {
                  url: "/cover.png",
                  alt: " Cover ",
                  width: 1200,
                  height: 630,
                },
              ],
            },
          },
        },
      },
      { rootDir, mode: "production" },
    );

    expect(normalized.seo.defaults).toMatchObject({
      title: "Default title",
      robots: ["index", "follow"],
      alternates: [{ hrefLang: "en", href: "/en" }],
      openGraph: {
        images: [
          {
            url: "/cover.png",
            alt: "Cover",
            width: 1200,
            height: 630,
          },
        ],
      },
    });

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: {
            defaults: {
              alternates: [{ hrefLang: "en" } as any],
            },
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/defaults\.alternates\[0\]\.href must be a non-empty string/u);
    expect(() =>
      createRouteFreshnessIdentity({
        frontend: {
          seo: { alternates: [{ href: "/en" } as any] },
        },
      }),
    ).toThrow(/alternates\[0\]\.hrefLang must be a non-empty string/u);
    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: {
            defaults: { openGraph: { images: [{} as any] } },
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/openGraph\.images\[0\]\.url must be a non-empty string/u);
    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: { defaults: { twitter: { images: [""] } } },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/twitter\.images\[0\] must be a non-empty string/u);
    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: { defaults: { robots: "index\nX-Injected: true" } },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/must not contain control characters/u);
    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: { defaults: { robots: "index\u0081noindex" } },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/must not contain control characters/u);
    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: {
            publicOrigin: "https://www.example.test",
            robots: {
              groups: [{ userAgent: "*\nDisallow: /private" }],
            },
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/must not contain control characters/u);

    expect(() =>
      resolveSeoHead({
        config: normalized.seo,
        pathname: "/",
        render: { alternates: [{ hrefLang: "en" } as any] },
      }),
    ).toThrow(/res\.render\(\.\.\.\)\.seo\.alternates\[0\]\.href/u);

    expect(() =>
      resolveSeoHead({
        config: normalized.seo,
        pathname: "/",
        render: { jsonLd: new Date() as any },
      }),
    ).toThrow(/jsonLd must contain JSON-safe values/u);

    const cyclicJsonLd: Record<string, unknown> = {};
    cyclicJsonLd.self = cyclicJsonLd;
    expect(() =>
      resolveSeoHead({
        config: normalized.seo,
        pathname: "/",
        render: { jsonLd: cyclicJsonLd as any },
      }),
    ).toThrow(/jsonLd\.self must contain JSON-safe values/u);

    expect(() =>
      resolveSeoHead({
        config: normalized.seo,
        pathname: "/",
        render: { jsonLd: new Array(1) as any },
      }),
    ).toThrow(/jsonLd must contain JSON-safe values/u);
  });

  it("rejects origin declarations that share a request host", async () => {
    const rootDir = await tempRoot();

    expect(() =>
      resolveFrontendConfig(
        {
          enabled: true,
          seo: {
            publicOrigin: "https://www.example.test/base",
            origins: { shop: "https://www.example.test/shop" },
          },
        },
        { rootDir, mode: "production" },
      ),
    ).toThrow(/share request host "www\.example\.test"/u);
  });
});

describe("frontend sitemap and robots", () => {
  it("validates, sorts, escapes and chunks sitemap documents deterministically", () => {
    const entries = validateSitemapEntries(
      [
        { pathname: "/z", priority: 0.5 },
        { pathname: "/a&b", lastmod: "2026-08-20" },
      ],
      "https://www.example.test/base",
      {},
    );
    const documents = renderSitemapDocuments(
      entries,
      "https://www.example.test/base",
      "/sitemap.xml",
      1,
    );

    expect(entries.map((entry) => entry.pathname)).toEqual(["/a&b", "/z"]);
    expect(documents.map((document) => document.pathname)).toEqual([
      "/sitemap.xml",
      "/sitemap-1.xml",
      "/sitemap-2.xml",
    ]);
    expect(documents[0]?.content).toContain(
      "https://www.example.test/sitemap-1.xml",
    );
    expect(documents[1]?.content).toContain(
      "https://www.example.test/base/a&amp;b",
    );
    expect(() =>
      validateSitemapEntries(
        [{ pathname: "/same" }, { pathname: "/same" }],
        "https://www.example.test",
        {},
      ),
    ).toThrow(/duplicate sitemap URL/u);
    expect(() =>
      validateSitemapEntries(
        [{ pathname: "/bad", priority: 2 }],
        "https://www.example.test",
        {},
      ),
    ).toThrow(/priority/u);
    expect(() =>
      validateSitemapEntries(
        [{ pathname: "/bad", changefreq: "sometimes" } as any],
        "https://www.example.test",
        {},
      ),
    ).toThrow(/changefreq/u);
    expect(() =>
      validateSitemapEntries(
        [{ pathname: "/../escape" }],
        "https://www.example.test",
        {},
      ),
    ).toThrow(/pathname/u);
  });

  it.each([
    "/../escape.xml",
    "/..\\escape.xml",
    "C:\\escape.xml",
    "C:escape.xml",
    "\\\\server\\share\\escape.xml",
  ])(
    "defends the writer boundary against portable path %s",
    async (unsafePath) => {
      const rootDir = await tempRoot();
      const config = resolveFrontendConfig(
        {
          enabled: true,
          seo: {
            publicOrigin: "https://www.example.test",
            sitemap: {},
            robots: false,
          },
        },
        { rootDir, mode: "production" },
      );
      (config.seo.sitemap as { path: string }).path = unsafePath;

      await expect(
        writeFrontendSeoArtifacts({
          rootDir,
          config,
          staticArtifacts: [],
        }),
      ).rejects.toThrow(/outside config\.frontend\.outDir/u);
      expect(existsSync(config.outDir)).toBe(false);
      expect(existsSync(path.join(rootDir, "dist", "escape.xml"))).toBe(false);
    },
  );

  it("normalizes a safe nested writer path across separators", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: {},
          robots: false,
        },
      },
      { rootDir, mode: "production" },
    );
    (config.seo.sitemap as { path: string }).path = "/seo\\nested/sitemap.xml";

    const result = await writeFrontendSeoArtifacts({
      rootDir,
      config,
      staticArtifacts: [],
    });

    expect(result.artifacts[0]?.file).toBe("seo/nested/sitemap.xml");
    expect(
      existsSync(path.join(config.outDir, "seo", "nested", "sitemap.xml")),
    ).toBe(true);
  });

  it("propagates build cancellation to the sitemap provider", async () => {
    const rootDir = await tempRoot();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: {
            entries: ({ signal }) =>
              new Promise<readonly never[]>((_resolve, reject) => {
                providerStarted();
                signal.addEventListener(
                  "abort",
                  () => reject(new Error("build provider aborted")),
                  { once: true },
                );
              }),
          },
          robots: false,
        },
      },
      { rootDir, mode: "production" },
    );
    const controller = new AbortController();
    const write = writeFrontendSeoArtifacts({
      rootDir,
      config,
      staticArtifacts: [],
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(write).rejects.toThrow("build provider aborted");
  });

  it("writes build artifacts, reports MIME types, and fails closed on public conflicts", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test/base",
          sitemap: {
            includeStatic: true,
            entries: () => [{ pathname: "/news/a&b" }],
          },
          robots: {},
        },
      },
      { rootDir, mode: "production" },
    );
    await mkdir(config.outDir, { recursive: true });

    const result = await writeFrontendSeoArtifacts({
      rootDir,
      config,
      staticArtifacts: [
        {
          routeId: "route_about",
          routePath: "/about",
          page: "about",
          params: {},
          html: "about/index.html",
          data: "about/__vext.page.json",
          bytes: 10,
          assets: [],
        },
      ],
    });
    const sitemap = await readFile(
      path.join(config.outDir, "sitemap.xml"),
      "utf-8",
    );
    const robots = await readFile(
      path.join(config.outDir, "robots.txt"),
      "utf-8",
    );

    expect(result.artifacts.map((artifact) => artifact.pathname)).toEqual([
      "/sitemap.xml",
      "/robots.txt",
    ]);
    expect(sitemap).toContain("https://www.example.test/base/about");
    expect(sitemap).toContain("https://www.example.test/base/news/a&amp;b");
    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Sitemap: https://www.example.test/sitemap.xml");
    expect(getFrontendContentType("sitemap.xml")).toBe(
      "application/xml; charset=utf-8",
    );

    const conflictRoot = await tempRoot();
    const conflictConfig = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: {},
          robots: {},
        },
      },
      { rootDir: conflictRoot, mode: "production" },
    );
    await mkdir(conflictConfig.outDir, { recursive: true });
    await writeFile(
      path.join(conflictConfig.outDir, "sitemap.xml"),
      "user-owned",
    );

    await expect(
      writeFrontendSeoArtifacts({
        rootDir: conflictRoot,
        config: conflictConfig,
        staticArtifacts: [],
      }),
    ).rejects.toThrow(/conflicts with an existing public\/build file/u);
    expect(
      await readFile(path.join(conflictConfig.outDir, "sitemap.xml"), "utf-8"),
    ).toBe("user-owned");
    expect(existsSync(path.join(conflictConfig.outDir, "robots.txt"))).toBe(
      false,
    );
  });

  it("renders robots groups with the selected sitemap", () => {
    expect(
      renderRobotsTxt(
        [{ userAgent: ["ExampleBot", "OtherBot"], disallow: "/private" }],
        "https://www.example.test/sitemap.xml",
      ),
    ).toBe(
      "User-agent: ExampleBot\nUser-agent: OtherBot\nDisallow: /private\n\nSitemap: https://www.example.test/sitemap.xml\n",
    );
  });
});

describe("frontend runtime SEO endpoints", () => {
  it("uses exact declared hosts, no-store and the configured MIME", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          origins: { cn: "https://cn.example.test" },
          sitemap: {
            mode: "runtime",
            includeStatic: false,
            entries: ({ originKey }) => [
              { pathname: `/${originKey ?? "default"}`, originKey },
            ],
          },
          robots: { mode: "runtime" },
        },
      },
      { rootDir, mode: "production" },
    );
    const registered: Array<{
      method: string;
      path: string;
      chain: Array<(req: any, res: any) => Promise<void>>;
    }> = [];
    const app = {
      adapter: {
        registerRoute(method: string, routePath: string, chain: any[]) {
          registered.push({ method, path: routePath, chain });
        },
      },
    } as any;
    registerFrontendSeoEndpoints(app, config);

    expect(registered.map((route) => route.path)).toEqual([
      "/sitemap.xml",
      "/sitemap-:chunk.xml",
      "/robots.txt",
    ]);
    const sitemapRoute = registered.find(
      (route) => route.path === "/sitemap.xml",
    )!;
    const ok = createTextResponse();
    await sitemapRoute.chain[0]!(
      {
        path: "/sitemap.xml",
        headers: { host: "cn.example.test" },
        onClose() {},
      },
      ok,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["Content-Type"]).toBe("application/xml; charset=utf-8");
    expect(ok.headers["Cache-Control"]).toBe("no-store");
    expect(ok.body).toContain("https://cn.example.test/cn");

    const unknown = createTextResponse();
    await sitemapRoute.chain[0]!(
      {
        path: "/sitemap.xml",
        headers: { host: "unknown.example.test" },
        onClose() {},
      },
      unknown,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it("tracks hidden user routes and rejects reserved endpoint conflicts", async () => {
    const rootDir = await tempRoot();
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: { mode: "runtime" },
        },
      },
      { rootDir, mode: "production" },
    );
    const collector = new RouteMetadataCollector();
    collector.addRoute(
      "GET",
      "/sitemap.xml",
      { docs: { hidden: true } },
      "src/routes/sitemap.ts",
    );

    expect(collector.getRoutes()).toEqual([]);
    expect(collector.getRegisteredRoutes()).toEqual([
      {
        method: "GET",
        path: "/sitemap.xml",
        sourceFile: "src/routes/sitemap.ts",
      },
    ]);
    expect(() =>
      assertNoFrontendSeoRouteConflicts(
        config,
        collector.getRegisteredRoutes(),
      ),
    ).toThrow(/conflicts with user route GET \/sitemap\.xml/u);

    for (const conflictingPath of [
      "/sitemap-:id.xml",
      "/sitemap-1.xml",
      "/:document",
      "/*document",
      "/*",
      "/SITEMAP.XML",
    ]) {
      expect(() =>
        assertNoFrontendSeoRouteConflicts(config, [
          { method: "GET", path: conflictingPath },
        ]),
      ).toThrow(/conflicts with user route/u);
    }
    expect(() =>
      assertNoFrontendSeoRouteConflicts(config, [
        { method: "POST", path: "/sitemap-1.xml" },
        { method: "GET", path: "/sitemap-other.json" },
      ]),
    ).not.toThrow();
  });

  it("aborts a runtime sitemap provider when the request closes", async () => {
    const rootDir = await tempRoot();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: {
            mode: "runtime",
            includeStatic: false,
            entries: ({ signal }) =>
              new Promise<readonly never[]>((_resolve, reject) => {
                providerStarted();
                signal.addEventListener(
                  "abort",
                  () => reject(new Error("runtime provider aborted")),
                  { once: true },
                );
              }),
          },
          robots: false,
        },
      },
      { rootDir, mode: "production" },
    );
    const registered: Array<{
      path: string;
      chain: Array<(req: any, res: any) => Promise<void>>;
    }> = [];
    registerFrontendSeoEndpoints(
      {
        adapter: {
          registerRoute(_method: string, routePath: string, chain: any[]) {
            registered.push({ path: routePath, chain });
          },
        },
      } as any,
      config,
    );
    let closeHandler!: () => void;
    const request = registered[0]!.chain[0]!(
      {
        path: "/sitemap.xml",
        headers: { host: "www.example.test" },
        onClose(handler: () => void) {
          closeHandler = handler;
        },
      },
      createTextResponse(),
    );
    await started;
    closeHandler();

    await expect(request).rejects.toThrow("runtime provider aborted");
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vext-seo-"));
  tempDirs.push(dir);
  return dir;
}

function createTextResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    text(body: string) {
      this.body = body;
      return this;
    },
  };
}
