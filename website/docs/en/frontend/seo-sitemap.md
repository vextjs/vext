# SEO, Sitemap, and Robots

Vext provides SEO as a framework capability for full-stack applications. It
merges application defaults, route metadata, and per-render metadata into the
server-rendered document, and can generate `sitemap.xml` and `robots.txt` at
build time or serve them at runtime.

The feature is opt-in. Omitting `frontend.seo` keeps the existing rendering and
build output unchanged.

## Basic Configuration

```ts
import type { VextUserConfig } from "vextjs";

const config: VextUserConfig = {
  frontend: {
    enabled: true,
    seo: {
      publicOrigin: process.env.PUBLIC_ORIGIN ?? "https://www.example.com",
      titleTemplate: "%s | Example",
      defaults: {
        description: "Example full-stack application",
        robots: ["index", "follow"],
        openGraph: {
          siteName: "Example",
          type: "website",
        },
        twitter: { card: "summary_large_image" },
      },
      sitemap: {},
      robots: {},
    },
  },
};

export default config;
```

`publicOrigin` is the deployment origin, not one fixed page URL. Vext combines
it with the current request pathname. For example, `/posts/hello` and
`/posts/release-notes` produce different canonical URLs even though they share
one `publicOrigin`.

Set `PUBLIC_ORIGIN` per environment when preview, staging, and production use
different domains. It must be an absolute HTTP(S) URL without user info, query,
or hash.

## Page-level Metadata

Static, JSON-safe metadata belongs on the existing route declaration. Its
finite static grammar treats inline objects as the simplest form and also
accepts same-file `const` bindings and TypeScript static wrappers. A route
options helper call is rejected because the index does not execute helper
bodies and cannot know their final metadata. Inline the final object or pass a
same-file `const`. Imported values, computed expressions, and interpolated
templates are not executed:

```ts
app.get(
  "/about",
  {
    frontend: {
      seo: {
        title: "About",
        canonical: "/about",
        openGraph: { type: "profile" },
      },
    },
  },
  async (_req, res) => res.render("about"),
);
```

Data-dependent metadata belongs in the third argument to `res.render()`:

```ts
app.get(
  "/posts/:slug",
  { frontend: { seo: { openGraph: { type: "article" } } } },
  async (req, res) => {
    const post = await app.services.posts.find(req.params.slug);

    res.render(
      "posts/detail",
      { post },
      {
        seo: {
          title: post.title,
          description: post.summary,
          canonical: `/posts/${post.slug}`,
          openGraph: { images: [post.image] },
          jsonLd: post.articleJsonLd,
        },
      },
    );
  },
);
```

Merge order is `frontend.seo.defaults` → `RouteOptions.frontend.seo` →
`res.render(..., { seo })`. Canonical, alternate, and relative Open Graph URLs
require a declared origin. Canonical and sitemap values are absolute pathnames;
query strings and hashes are rejected so accidental duplicate URLs fail early.

Supported metadata includes title, description, robots directives, canonical,
Open Graph, Twitter cards, language alternates, and JSON-LD. Existing
`res.render(..., { head })` remains available; explicit legacy head fields are
merged after structured SEO for compatibility.

## Build-time Sitemap

`sitemap: {}` defaults to build mode. Successful static artifacts are included
automatically, and an entries provider can add dynamic paths known during the
build:

```ts
seo: {
  publicOrigin: "https://www.example.com",
  sitemap: {
    mode: "build",
    includeStatic: true,
    entries: async ({ signal }) => {
      const response = await fetch("https://cms.example.com/seo/posts", {
        signal,
      });
      const posts = (await response.json()) as Array<{
        slug: string;
        updatedAt: string;
      }>;
      return posts.map((post) => ({
        pathname: `/posts/${post.slug}`,
        lastmod: post.updatedAt,
        changefreq: "weekly" as const,
        priority: 0.7,
      }));
    },
  },
  robots: {},
}
```

Build mode requires `publicOrigin`. Output is written into the frontend build
closure and included in the deploy manifest with the correct XML/TXT content
types. Static routes with `frontend.seo.index: false` or a `noindex` robots
directive are excluded. More than `maxUrlsPerFile` entries produce a sitemap
index and numbered chunks; the limit defaults to 50,000.

The provider receives only `{ mode, origin, originKey, signal }`; Vext does not
inject `app`, services, or `app.db` into configuration callbacks. Read dynamic
entries from a build-safe module or external content source, and honor the
abort signal.

## Runtime Sitemap and Dynamic Domains

Use runtime mode when entries or the public domain must be selected per
request:

```ts
seo: {
  publicOrigin: "https://www.example.com",
  origins: {
    cn: "https://www.example.cn",
    docs: "https://docs.example.com",
  },
  sitemap: {
    mode: "runtime",
    entries: async ({ originKey, signal }) => {
      const response = await fetch(
        `https://cms.example.com/seo/paths?site=${originKey ?? "default"}`,
        { signal },
      );
      const paths = (await response.json()) as string[];
      return paths.map((pathname) => ({
        pathname,
        ...(originKey ? { originKey } : {}),
      }));
    },
  },
  robots: { mode: "runtime" },
}
```

At runtime, the request `Host` must exactly match `publicOrigin` or one entry in
`origins`. Unknown hosts return 404 instead of generating attacker-controlled
canonical or sitemap URLs. A route or render can select a finite named origin
with `seo.originKey`; undeclared keys fail closed.

Runtime sitemap and robots responses use `Cache-Control: no-store`. Add an
explicit cache at your reverse proxy only after defining its host and refresh
policy.

## Robots

```ts
robots: {
  mode: "build",
  groups: [
    { userAgent: "*", allow: "/", disallow: ["/admin", "/preview"] },
    { userAgent: "ExampleBot", crawlDelay: 2 },
  ],
}
```

The path is `/robots.txt`. When sitemap is enabled, the generated robots file
also includes its URL. Runtime SEO endpoints fail startup if they conflict with
an existing user `GET` or `HEAD` route.

## SEO without Browser Hydration

SEO is applied before the document policy, so a route with
`frontend.hydration: "none"` keeps SSR HTML, CSS, canonical metadata, Open
Graph, JSON-LD, and user-authored document scripts while omitting the Vext and
React browser runtime. See [Hydration](/frontend/hydration) for the exact
boundary.

This is page-level server-only rendering. It is not Selective or Partial
Hydration, an Islands architecture, React Server Components, or Partial
Prerendering (PPR).
