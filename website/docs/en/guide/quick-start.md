# Quick start

:::warning Version channel
This site follows `main` and currently previews `v2.0.0` (`next`). The latest published npm release is `v1.0.2` (`stable`), so the install commands and dependency example below intentionally use the stable version until 2.0.0 is published.
:::

## Method 1: Use scaffolding (recommended)

VextJS provides the `vext create` command to create a runnable project. The default template proves the one-route model immediately: `/` renders React through `res.render()`, `/api/hello` returns JSON, and both use the generated example service. Choose API-only when no page runtime is needed.

```bash
# Create TypeScript full-stack project (default Native Adapter)
npx vextjs create my-app

# Create and specify Adapter
npx vextjs create my-app --adapter hono

# Create JavaScript full-stack project
npx vextjs create my-app --js

# Create API-only project
npx vextjs create my-api --template api --frontend none

# Skip npm install
npx vextjs create my-app --skip-install
```

After creation is complete:

```bash
cd my-app
npm run dev
```

Visit `http://localhost:3000` for the server-rendered starter and `http://localhost:3000/docs` for live API documentation. The backend API routes are available at `/api/hello` and `/api/health`.

## Method 2: Manual creation

### 1. Initialize project

```bash
mkdir my-app && cd my-app
npm init -y
npm install vextjs
```

### 2. Configure `package.json`

```json
{
  "name": "my-app",
  "type": "module",
  "scripts": {
    "start": "vext start",
    "dev": "vext dev",
    "build": "vext build"
  },
  "dependencies": {
    "vextjs": "^1.0.2"
  }
}
```

:::tip
VextJS requires `"type": "module"`, and the project uses the ESM module format.
:::

### 3. Create directory structure

```bash
mkdir -p src/config src/routes src/services src/middlewares src/plugins src/locales src/preload src/types/generated src/frontend/pages/error src/frontend/components src/frontend/styles src/frontend/assets src/frontend/locales public
```

### 4. Write configuration

```typescript
// src/config/default.ts
export default {
  port: 3000,
  host: "0.0.0.0",
  logger: {
    level: "info",
  },
  openapi: {
    enabled: true,
  },
  frontend: {
    enabled: true,
    framework: "react",
    publicDir: "public",
    publicPath: "/",
    i18n: {
      enabled: true,
      defaultLocale: "en-US",
    },
  },
};
```

If you need to use other Adapters (such as Hono), first install the corresponding package and then configure:

```bash
npm install hono
```

```typescript
// src/config/default.ts
import { honoAdapter } from "vextjs/adapters/hono";

export default {
  adapter: honoAdapter(),
  port: 3000,
};
```

### 4.1 Optional: Add `src/config/bootstrap.ts`

If some configuration must be read from the remote end during startup and needs to be merged before `config` is frozen, you can add `src/config/bootstrap.ts`:

```typescript
import { defineBootstrapConfig } from "vextjs";

export default defineBootstrapConfig({
  providers: [
    {
      name: "remote-config",
      async load({ env, signal }) {
        const response = await fetch(`https://config.example.com/${env}.json`, {
          signal,
        });
        return await response.json();
      },
    },
  ],
});
```

Suitable for: database, Nacos startup configuration, key patch.

Not suitable for: `preload` scenarios such as APM / OpenTelemetry that need to be executed earlier.

### 5. Write routing

```typescript
// src/routes/index.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/hello
  app.get(
    "/api/hello",
    {
      docs: { summary: "Hello API" },
    },
    async (_req, res) => {
      res.json({ message: "Hello VextJS!" });
    },
  );

  // GET /api/health
  app.get(
    "/api/health",
    {
      docs: { summary: "Health Check" },
    },
    async (_req, res) => {
      res.json({
        status: "ok",
        uptime: process.uptime(),
      });
    },
  );
});
```

### 6. Write services (optional)

```typescript
// src/services/example.ts
export default class ExampleService {
  async getGreeting(name: string) {
    return { message: `Hello, ${name}!` };
  }
}
```

Use services in routes:

```typescript
// src/routes/greet.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/greet/:name",
    {
      validate: {
        param: { name: "string!" },
      },
      docs: { summary: "Greeting Interface" },
    },
    async (req, res) => {
      const { name } = req.valid("param");
      const result = await app.services.example.getGreeting(name);
      res.json(result);
    },
  );
});
```

### 7. Start

```bash
# Development mode (hot reload)
npm run dev

# Production mode
npm run build
npm start
```

Frontend pages live under `src/frontend/pages/**`. Vext generates the browser entry, page registry, layout registry, and HTML injection code automatically. For a manual project, create at least `src/frontend/pages/index.tsx`, `src/frontend/pages/_document.html`, and `src/frontend/styles/index.css`, or start from the default `vext create` template.

The default full-stack template opens with an SSR Vext runtime launchpad that makes the route → service → SSR → browser-runtime path visible. Its header exposes both the Vext Guide and the generated app's local API documentation at `/docs`; the secondary action opens the Vext Guide. It enables `openapi.enabled: true` by default, so the local documentation entry works in development and production. It deliberately includes only real starter code: it does not create a root README or placeholder README files. Generated user source is English-first across TypeScript, JavaScript, full-stack, and API-only modes; explicit locale resources are the only language-content exception. Its AppShell uses the transparent `public/vext-mark.svg`; `public/favicon.svg` is the contrast-safe favicon variant built from the same V geometry. Add optional convention directories only when you add their source files.

## Project structure

After scaffolding or manual creation, your project structure should look like this:

```
my-app/
├── public/
│ ├── favicon.svg # Contrast-safe V mark favicon variant
│ └── vext-mark.svg # Transparent V mark used by AppShell
├── src/
│ ├── config/
│ │ ├── default.ts # Shared configuration (port: 3000)
│ │ ├── development.ts # Development profile
│ │ ├── production.ts # Production profile
│ │ ├── local.ts # Empty local override; ignored by Git
│ │ └── bootstrap.ts # Tracked startup entry with providers: []
│ ├── frontend/
│ │ ├── components/AppShell.tsx # Shared React shell
│ │ ├── locales/en-US.ts # Starter messages
│ │ ├── pages/ # React pages, layout, document, and error page
│ │ └── styles/index.css # Vext launchpad styles
│ ├── routes/index.ts # URL handler and server data
│ ├── services/example.ts # Service layer
│ └── types/generated/.gitkeep # Typegen output root (TS project)
├── package.json
├── tsconfig.json
└── .gitignore
```

:::info Convention
VextJS will automatically scan `src/routes/`, `src/services/`, `src/config/`, `src/middlewares/`, `src/plugins/`, `src/locales/`, `src/preload/`, `src/frontend/`, and `public/` without manual registration. The initial scaffold creates only the directories with starter content; the optional convention directories are scanned whenever you create them. Project-root `preload/` remains a warned migration fallback only. Route file names are mapped to URL prefixes:

| File path                      | URL prefix        |
| ------------------------------ | ----------------- |
| `src/routes/index.ts`          | `/`               |
| `src/routes/users.ts`          | `/users`          |
| `src/routes/admin/index.ts`    | `/admin`          |
| `src/routes/admin/settings.ts` | `/admin/settings` |

:::

The scaffold directly creates zero-effect `src/config/local.ts` and `src/config/bootstrap.ts`. `local.ts` starts as an empty `VextConfigOverride` and is excluded by `.gitignore`, so a fresh clone may omit it without affecting build or startup. `bootstrap.ts` starts with `providers: []`, is tracked normally, and can later register startup providers before the final CLI override. See [Project structure](/guide/project-structure) for service type, runtime constant, and shared utility ownership rules.

## Access OpenAPI documentation

The default `fullstack-react` configuration already enables `openapi.enabled: true`. In an API-only project, or if you have turned it off, enable it before starting the project:

- **Vext Docs Documentation**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/openapi.json`

## CLI command overview

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `vext dev`           | Development mode, file monitoring + hot reloading |
| `vext start`         | Start production mode                             |
| `vext build`         | Build project (TypeScript → JavaScript)           |
| `vext create <name>` | Create a new project                              |
| `vext stop`          | Stop the Cluster process                          |
| `vext reload`        | Rolling restart Worker                            |
| `vext status`        | View Cluster running status                       |

## Development mode hot reload

`vext dev` provides a three-layer hot reload strategy and automatically selects the optimal method:

| Level                                | Trigger Condition            | Behavior                                              | Speed                |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------- | -------------------- |
| **Tier 1** — Hot routing replacement | Routing file changes         | Atomic replacement request handler, zero interruption | ⚡ Millisecond level |
| **Tier 2** — Service reload          | Service/i18n file changes    | Rebuild affected service instances                    | ⚡ Milliseconds      |
| **Tier 3** — Cold Reboot             | Configuration/Plugin Changes | Complete Reboot Process                               | 🔄 Seconds           |

## Next step

- Understand [Project Structure](/guide/project-structure) conventions
- Configure the [Frontend guide](/frontend/overview)
- Learn the three-part definition of [routing](/guide/routing)
- Explore [middleware](/guide/middleware) and [plugins](/guide/plugins)
- View the [Configuration](/guide/configuration) options
