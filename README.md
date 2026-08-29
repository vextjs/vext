# VextJS

[![npm version](https://img.shields.io/npm/v/vextjs.svg)](https://www.npmjs.com/package/vextjs)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.19.0-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs-devcodex--labs.github.io-informational)](https://devcodex-labs.github.io/vextjs/)

> **Build AI-assisted APIs and server-rendered React pages in one Node.js application.**

VextJS is an **AI-first full-stack Node.js application framework** built around one route model and request lifecycle. Routes, services, validation, security, OpenAPI, typed contracts, and React SSR evolve together without introducing a second routing system.

AI-first describes the engineering surface: conventions, scaffolding, typed contracts, OpenAPI, and machine-readable documentation give AI coding assistants explicit inputs for AI-assisted development. VextJS does not include a built-in LLM, Agent, RAG system, or inference runtime.

The npm package name is `vextjs`; the CLI binary is `vext`. Requires **Node.js >=20.19.0**. Cold-start from the registry with **`npx vextjs …`**. After install, use project scripts or local `npx vext`.

**Docs:** https://devcodex-labs.github.io/vextjs/ · **Migration:** [MIGRATION.md](./MIGRATION.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

---

| One route model                                                                  | Contracts stay connected                                                                 | Start with only what you need                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| JSON and HTML use `src/routes/**`, shared services, and the same security chain. | Route contracts drive validation, OpenAPI, interactive docs, and generated client types. | The default starter is full-stack; API-only remains a first-class template. |

---

## Get started

```bash
# Package name is vextjs — runs the published `vext` binary from this package.
npx vextjs create my-app
cd my-app
npm run dev
```

Default scaffold: **TypeScript + fullstack React + native adapter**.

```bash
# API-only
npx vextjs create my-api --template api --frontend none

# Other adapters / JS
npx vextjs create my-app --adapter hono
npx vextjs create my-app --js
```

Open `http://localhost:3000/` and, with OpenAPI enabled, `http://localhost:3000/docs`.

The package is `vextjs`; its installed CLI binary is `vext`. Use `npx vextjs create` before installation, then project scripts or local `npx vext`.

---

## Why VextJS

| When the application grows                           | VextJS keeps                                                  | Practical result                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| An API also needs server-rendered pages              | URL ownership in `src/routes/**`                              | No second route or data-loading language                |
| Validation, docs, and clients start to drift         | Contracts beside the handler                                  | OpenAPI, live docs, and typed clients share one source  |
| Authentication, sessions, cache, and errors multiply | One request lifecycle                                         | JSON, HTML, and page navigation cross the same policies |
| Tooling becomes a project of its own                 | CLI, esbuild frontend delivery, testing, and production start | A shorter path from scaffold to deployable Node service |

## 2.0.0 candidate highlights

- **Framework-level SEO** — configure metadata, canonical URLs, robots, and
  build/runtime sitemaps through `frontend.seo`; route/render metadata can vary
  per page while deployment origins stay explicit and fail closed.
- **Pure HTML SSR routes** — set `hydration: "none"` on a rendered route to emit
  server HTML without a React browser entry, page payload, or React runtime.
- **One database surface** — `app.db` is the raw MonSQLize instance, including
  transactions, pools, events, diagnostics, and the Vext-provided read-only
  Mongo client getter; `app.monsqlize` is removed.
- **Safer defaults** — global rate limiting is off until
  `rateLimit.enabled: true` is configured.
- **Coherent tooling** — OpenAPI Docs uses the Vext mark, favicon, teal/cyan
  light/dark tokens, and green/amber mark accents; executable Hello World and MongoDB CRUD fixtures
  verify install, typecheck, build, runtime, and OpenAPI contracts.
- **Clear type ownership** — new TypeScript full-stack projects separate
  `src/types/shared`, `src/types/frontend`, and framework-owned
  `src/types/generated`; existing project trees are not rewritten.

## One route model

The default starter demonstrates the same service feeding a server-rendered page and a documented API route:

```ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/", {}, async (_req, res) => {
    const greeting = await app.services.example.greeting("Vext");
    res.render("index", { greeting, renderedAt: new Date().toISOString() });
  });

  app.get(
    "/api/hello",
    {
      docs: { summary: "Get the starter greeting" },
    },
    async (_req, res) => {
      res.json(await app.services.example.greeting("Vext"));
    },
  );
});
```

Routes remain the URL authority. Services own reusable business work. `res.json()` and `res.render()` choose the representation without bypassing middleware, validation, auth, cache, redirects, or error handling.

---

## What you get

### Runtime

- **Convention routing** — file path under `src/routes/**` → URL prefix; `(path, options, handler)` API
- **Plugins & services** — topological plugin load; `src/services/**` → `app.services`
- **Validation & route contracts** — [schema-dsl](https://www.npmjs.com/package/schema-dsl), response schemas, OpenAPI, and generated client types
- **OpenAPI + branded Docs Renderer** — `/openapi.json` and interactive first-party `/docs`
- **Database lifecycle** — setting `config.database` activates the raw MonSQLize instance at `app.db`, model loading, and cleanup
- **Route cache** — `cache: 60` / tags / Vary
- **Session, cookies, CSRF, auth, security headers** — first-party contracts
- **Production lifecycle** — graceful shutdown, cluster workers, heartbeats, and rolling restart
- **Startup lifecycle** — bootstrap configuration providers and `src/preload/**` process-early hooks

### Full-stack UI (same routes)

- React **SSR / hydration** via `res.render()`, plus route-level `hydration: "none"` for pure HTML
- **Same-route client navigation** — browser navigation reuses the existing server route lifecycle
- Static / revalidate freshness and local image/font pipeline
- **SEO / sitemap / robots** — framework configuration with per-page metadata and dynamic URL providers
- **Typed API client** generation (`dist/client/api.generated.ts` when frontend build + `apiClient` are enabled)
- **Vext JSCSS** (`vextjs/style`) and esbuild-powered frontend delivery — one toolchain

### DX

- **CLI** — create, dev, build, start, typegen, doctor
- **Three-tier hot reload** — route hot swap, service/model structural reload, and safe cold restart
- **React Fast Refresh** — frontend updates without restarting the backend runtime
- **Testing** — `createTestApp` from `vextjs/testing` without binding a real HTTP port
- **Executable examples** — `examples/hello-world` and `examples/crud-api` carry their own typecheck, build, runtime, and contract tests

---

## Simplified project model

```text
my-app/
├── src/
│   ├── config/          # default + env profiles + optional bootstrap
│   ├── routes/          # HTTP routes (URL authority)
│   ├── services/        # → app.services.*
│   ├── models/          # optional database models
│   ├── plugins/
│   ├── middlewares/
│   ├── frontend/        # pages, components, styles, assets
│   ├── types/           # shared / frontend / generated declarations (TS)
│   ├── preload/         # process-level early scripts
│   └── locales/
├── package.json
└── tsconfig.json
```

---

## Good fit

VextJS is a strong fit when:

- a Node API needs server-rendered product, admin, or internal pages without splitting ownership;
- one team wants routes, services, validation, auth, cache, docs, and clients to evolve together;
- API-only today may become full-stack later, or a full-stack app still needs a first-class API;
- production remains a Node service and an esbuild-based frontend toolchain is enough.

## Boundaries

VextJS uses **route-native SSR**: `src/routes/**` + `res.render()` provide SSR, normal hydration or pure-HTML `hydration: "none"`, Suspense, opt-in Streaming SSR, same-route navigation, static/revalidate freshness, and local media. It does not currently implement selective/partial hydration, an Islands component model, React Server Components, Server Functions or Actions, partial prerendering (PPR), or third-party bundler plugin ecosystems. Those models require additional execution and asset boundaries; Vext does not claim them until those contracts exist.

Read the exact lifecycle, trade-offs, and exclusions in [Frontend boundaries and roadmap](https://devcodex-labs.github.io/vextjs/frontend/boundaries-and-roadmap). Implementation guides cover [rendering modes](https://devcodex-labs.github.io/vextjs/frontend/rendering-modes), [data flow](https://devcodex-labs.github.io/vextjs/frontend/data-flow), [assets and media](https://devcodex-labs.github.io/vextjs/frontend/static-assets-and-cdn), and the [typed API client](https://devcodex-labs.github.io/vextjs/frontend/api-client-and-contracts).

---

## HTTP adapters

Pick the stack that fits your deployment; business routes stay the same.

| Adapter              | Extra packages | Notes                                                                                     |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| **native** (default) | none           | Node HTTP + `route-core`; no extra HTTP framework package                                 |
| `express`            | `express`      | Use when you need that middleware ecosystem                                               |
| `fastify`            | `fastify`      | Use when you need that plugin ecosystem                                                   |
| `koa`                | `koa`          | Use when you need that middleware style                                                   |
| `hono`               | `hono`         | Node.js adapter with an internal Web Request/Response bridge; not an Edge runtime adapter |

```js
// src/config/default.js
export default {
  adapter: "native", // or "fastify" | "hono" | "express" | "koa"
};
```

Benchmark methodology: [Adapter Matrix](https://devcodex-labs.github.io/vextjs/benchmark). It keeps one Vext application fixed and compares the supported adapters; reproduce it with `npm run test:bench` in this repo.

---

## CLI

Invoke via `npx vextjs <cmd>` (package) or, inside a project, `npx vext <cmd>` / npm scripts.

| Command              | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `vext create <name>` | Scaffold (default fullstack-react)           |
| `vext dev`           | Dev server + hot reload + typegen preflight  |
| `vext build`         | Compile server (+ frontend when enabled)     |
| `vext start`         | Run production / built output                |
| `vext typegen`       | Generate `app.services` / `app.extend` types |
| `vext doctor routes` | Static route diagnostics (experimental)      |

```bash
npx vextjs create my-app
cd my-app
npm run dev          # → vext dev
npm run build        # → vext build
npm start            # → vext start
```

Dev reload: **T1/T2** soft reload (ms), **T3** cold restart (config/plugins/env). Keys: `r` restart, `h` soft reload, `c` clear, `?` help.

---

## Configuration

```text
built-in defaults → default → {profile} → local → bootstrap providers → CLI overrides
```

Select profile with `vext start --config <name>` or `VEXT_CONFIG=<name>` (do not rely on baked `process.env.NODE_ENV` after `vext build` for profile selection).

Common fields: `port`, `host`, `adapter`, `logger`, `cors`, `bodyParser`, `rateLimit`, `openapi`, `frontend`, `cache`, `session`, `shutdown`. See the [configuration guide](https://devcodex-labs.github.io/vextjs/guide/configuration) and [configuration reference](https://devcodex-labs.github.io/vextjs/api/config) before changing production behavior.

`rateLimit` is disabled by default and installs middleware only when
`rateLimit.enabled === true`. Framework SEO is configured under
`frontend.seo`; frontend/backend runtime configuration remains under
`src/config/`.

---

## Testing

```js
import { describe, it, expect } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("API", () => {
  it("responds", async () => {
    const app = await createTestApp({ rootDir: "/path/to/project" });
    const res = await app.request.get("/");
    expect(res.status).toBe(200);
  });
});
```

---

## Documentation for people and AI assistants

| Resource                        | URL                                                                    |
| ------------------------------- | ---------------------------------------------------------------------- |
| Human docs (EN/ZH)              | https://devcodex-labs.github.io/vextjs/                                |
| Quick start                     | https://devcodex-labs.github.io/vextjs/guide/quick-start               |
| Frontend guide and typed client | https://devcodex-labs.github.io/vextjs/frontend/getting-started        |
| Runtime boundaries              | https://devcodex-labs.github.io/vextjs/frontend/boundaries-and-roadmap |
| `llms.txt`                      | https://devcodex-labs.github.io/vextjs/llms.txt                        |
| `capabilities.json`             | https://devcodex-labs.github.io/vextjs/capabilities.json               |
| `docs-manifest.json`            | https://devcodex-labs.github.io/vextjs/docs-manifest.json              |

**For AI assistants:** prefer citing `docs-manifest.json` canonical URLs; check `capabilities.json` and the boundaries page before describing frontend capabilities. Do not invent features from React version, SSR, or Suspense alone.

Chinese documentation: site locale `/zh` (this package ships one English README entry).

---

## Migration

The v1 → v2 database surface, rate-limit default, validation status, scaffold
types, SEO, and no-hydration changes are documented in
**[MIGRATION.md](./MIGRATION.md)**.

---

## Contributing

See the [contributing guide](https://github.com/devcodex-labs/vextjs/blob/main/CONTRIBUTING.md).

```bash
git clone https://github.com/devcodex-labs/vextjs.git
cd vextjs
npm ci
npm test
npm run build
```

---

## License

[Apache-2.0](./LICENSE) © DevCodex Labs · [github.com/devcodex-labs/vextjs](https://github.com/devcodex-labs/vextjs)
