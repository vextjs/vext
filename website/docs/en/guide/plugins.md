# plugin

The plug-in system of VextJS is the **only extension entrance** to the framework. Through plug-ins, you can inject custom capabilities into the `app` object, register global middleware, replace built-in implementations, and manage resource life cycles.

## Basic concepts

Plug-ins are placed in the `src/plugins/` directory and are automatically scanned and loaded by `plugin-loader`. Each plugin is defined through `definePlugin()`, including a name, dependency declaration and `setup()` initialization function.

```typescript
// src/plugins/redis.ts
import { definePlugin } from "vextjs";
import Redis from "ioredis";

export default definePlugin({
  name: "redis",

  async setup(app) {
    const redis = new Redis(app.config.redis?.url ?? "redis://localhost:6379");

    // Mount custom capabilities to the app
    app.extend("redis", redis);

    //Register graceful shutdown hook
    app.onClose(async () => {
      app.logger.info("Closing Redis connection...");
      await redis.quit();
    });

    app.logger.info("Redis plugin initialized");
  },
});
```

## Plug-in interface

```typescript
interface VextPlugin {
  /** Plug-in name (unique identifier) */
  readonly name: string;

  /** List of other dependent plug-in names */
  readonly dependencies?: string[];

  /** Plug-in initialization function */
  setup(app: VextApp): Promise<void> | void;

  /** Readiness hook executed after HTTP starts listening (optional) */
  onReady?(app: VextApp): Promise<void> | void;

  /** Cleanup hooks executed during graceful shutdown (optional, in LIFO order) */
  onClose?(app: VextApp): Promise<void> | void;
}
```

### `name` — unique identifier

The plugin name is used for log output, error messages, and dependency declarations. Plug-ins with the same name loaded later will overwrite the ones loaded first and can be used to replace the built-in implementation.

### `dependencies` — dependency declaration

Declare other plugins that the current plugin depends on. `plugin-loader` performs **topological sorting** based on dependencies to ensure that dependent plugins execute `setup()` before the current plugin. Fail Fast reports an error when there are circular dependencies.

```typescript
export default definePlugin({
  name: "user-cache",
  dependencies: ["redis"], // Make sure the redis plug-in is initialized first

  async setup(app) {
    // At this time app.redis (injected by the redis plug-in) is available
    const redis = (app as any).redis;
    // ...
  },
});
```

### `setup()` — initialization function

The core logic of the plug-in. Called by `plugin-loader` in the `bootstrap` stage, it supports asynchronous operations (such as connecting to the database). Its second argument is `{ signal: AbortSignal }`; pass `signal` to cancellable I/O. Each `setup()` has a hard timeout (default 30 seconds). On failure or timeout, the signal is aborted, framework mutations made through the setup facade are rolled back, and that facade is revoked so a late continuation cannot mutate application state.

```typescript
async setup(app, { signal }) {
  const response = await fetch(app.config.remotePluginUrl, { signal });
  app.extend("remotePluginData", await response.json());
}
```

### `onReady()` / `onClose()` — life cycle hook

Plug-ins can also declare `onReady(app)` and `onClose(app)` directly. `plugin-loader` will register them into the application life cycle after `setup()` is completed:

- `onReady(app)`: Executed after HTTP starts listening, suitable for warming up cache, checking external dependencies, and printing startup information.
- `onClose(app)`: Executed during graceful shutdown. All shutdown hooks clean up resources in last-registration-first-execution (LIFO) order.

## Plug-in capabilities

### `app.extend()` — Mount custom properties

Inject custom properties or methods into the `app` object. Only plugins can use this API.

```typescript
export default definePlugin({
  name: "mailer",

  async setup(app) {
    const mailer = {
      async send(to: string, subject: string, body: string) {
        //Send email logic...
        app.logger.info({ to, subject }, "Email sent");
      },
    };

    app.extend("mailer", mailer);
  },
});
```

When using:

```typescript
// In a route or service
await (app as any).mailer.send("user@example.com", "Welcome", "Hello!");
```

:::tip type tip
If you want to automatically generate plugin extension declarations, export `appExtensions = defineAppExtensions<{ ... }>()` in the plugin file and run:

```bash
vext typegen
```

Currently, lightweight scanners prioritize inline object generics:

```typescript
import { defineAppExtensions, definePlugin } from "vextjs";

export const appExtensions = defineAppExtensions<{
  mailer: {
    send(to: string, subject: string, body: string): Promise<void>;
  };
}>();

export default definePlugin({
  name: "mailer",
  setup(app) {
    app.extend("mailer", {
      async send(to: string, subject: string, body: string) {
        app.logger.info({ to, subject }, "Email sent");
      },
    });
  },
});
```

The command will also best-effort scan `app.extend("...")` calls in the `setup` / `onReady` / `onClose` life cycle of `definePlugin()`, and write the results into `.vext/types/app-extensions.generated.d.ts`, and then access the TypeScript project through `src/types/generated/index.d.ts`. Complex types, imported type alias or dynamic expansion are not suitable for relying on automatic scanning. It is recommended to use handwritten `declare module`:

```typescript
// src/types/extensions.d.ts
declare module "vextjs" {
  interface VextApp {
    mailer: {
      send(to: string, subject: string, body: string): Promise<void>;
    };
  }
}
```

When extended `app.mailer.send()` will get IDE auto-completion without the need for `as any` assertion.
:::

### `app.use()` — Register global middleware

Register global middleware in the plug-in and it will take effect on all routes. These middleware are executed after the built-in global middleware and before the route-level middleware.

```typescript
import { definePlugin, securityHeaders } from "vextjs";

export default definePlugin({
  name: "security-headers",

  setup(app) {
    app.use(securityHeaders({ preset: "strict" }));
  },
});
```

For application-wide browser security headers, prefer `config.securityHeaders` so errors, 404 responses, testing helpers, and dev soft reload use the same behavior. The plugin form is useful for scoped or migration-only stacks.

:::warning note
`app.use()` can only be called in `setup()`. Calling after route registration is complete will throw an error.
:::

### `app.hooks.on()` — Register runtime lifecycle hooks

Plugins can also observe the framework life cycle through `app.hooks.on(name, handler)`. It is suitable for cross-cutting logic such as request auditing, outbound call monitoring, service call tracking, response header patch, OpenAPI document patch, etc.

```typescript
export default definePlugin({
  name: "runtime-observer",

  setup(app) {
    app.hooks.on("handler:error", ({ route, error, requestId }) => {
      app.logger.error({ route: route.path, err: error, requestId });
    });

    app.hooks.on("response:before", ({ headers }) => ({
      headers: { ...headers, "x-runtime": "vext" },
    }));
  },
});
```

`app.hooks` is a framework reserved property and cannot be overridden with `app.extend("hooks", ...)`. The plugin `setup()` itself will also trigger `plugin:beforeSetup/afterSetup/error`, but a plugin cannot observe its own `beforeSetup`, it can only be observed by previously loaded plugins.

### `app.onClose()` — Graceful closing hook

Register graceful shutdown hook. When a `SIGTERM` / `SIGINT` signal is received, the framework executes all shutdown hooks in reverse order (LIFO) of registration.

Suitable for: closing database connections, refreshing log buffers, canceling scheduled tasks, etc.

```typescript
export default definePlugin({
  name: "database",

  async setup(app) {
    const db = await createDatabaseConnection(app.config.database);
    app.extend("db", db);

    app.onClose(async () => {
      app.logger.info("Closing database connection...");
      await db.disconnect();
    });
  },
});
```

### `app.onReady()` — Ready hook

Register ready hook. Triggered after all plug-ins are loaded and HTTP starts listening. Suitable for: warming up cache, checking external dependencies, printing startup information.

```typescript
export default definePlugin({
  name: "warmup",

  setup(app) {
    app.onReady(async () => {
      // HTTP has started listening and can perform preheating operations
      app.logger.info("Warming up caches...");
      await app.services.product.warmupCache();
      app.logger.info("Cache warmup complete");
    });
  },
});
```

### `app.setValidator()` — Replacement validation engine

Replace the framework's built-in parameter validation engine. schema-dsl is used by default and can be replaced by third-party verification libraries such as Zod and Yup.

```typescript
import { definePlugin } from "vextjs";
import type { VextValidator } from "vextjs";
import { z } from "zod";

export default definePlugin({
  name: "zod-validator",

  setup(app) {
    const originalValidator = app.getValidator();

    const zodValidator: VextValidator = {
      compile(schema) {
        const toVextResult = (result: ReturnType<z.ZodType["safeParse"]>) =>
          result.success
            ? { valid: true, data: result.data }
            : {
                valid: false,
                errors: result.error.issues.map((issue) => ({
                  field: issue.path.join("."),
                  message: issue.message,
                })),
              };

        // If the entire location schema is Zod schema, execute safeParse directly
        if (schema instanceof z.ZodType) {
          return (data) => toVextResult(schema.safeParse(data));
        }

        // If the fields of the schema object are Zod schema, combine them into z.object
        const zodShape: Record<string, z.ZodType> = {};
        for (const [key, value] of Object.entries(schema)) {
          if (value instanceof z.ZodType) {
            zodShape[key] = value;
          }
        }

        if (Object.keys(zodShape).length > 0) {
          const zodSchema = z.object(zodShape);
          return (data) => toVextResult(zodSchema.safeParse(data));
        }

        // Non-Zod schema falls back to the default schema-dsl validator
        return originalValidator.compile(schema);
      },
    };

    app.setValidator(zodValidator);
  },
});
```

### `app.setThrow()` — wraps error throws

Wraps or replaces the implementation of `app.throw()`. Receives the original implementation and returns the new implementation.

```typescript
export default definePlugin({
  name: "error-tracker",

  setup(app) {
    app.setThrow((originalThrow) => {
      return (status, message, paramsOrCode, code) => {
        // Log errors before throwing
        app.logger.warn({ status, message }, "HTTP error thrown");
        // Call the original implementation
        originalThrow(status, message, paramsOrCode, code);
      };
    });
  },
});
```

### `app.setRateLimiter()` — Replacement of current limiting implementation

Replaces built-in current restrictor. By default, `flex-rate-limit` is used, which can be replaced by Redis distributed current limit, etc.

```typescript
export default definePlugin({
  name: "redis-rate-limit",
  dependencies: ["redis"],

  setup(app) {
    app.setRateLimiter({
      async check(key: string) {
        // Distributed current limiting based on Redis
        const count = await (app as any).redis.incr(`ratelimit:${key}`);
        if (count === 1) {
          await (app as any).redis.expire(`ratelimit:${key}`, 60);
        }
        return {
          allowed: count <= app.config.rateLimit.max,
          remaining: Math.max(0, app.config.rateLimit.max - count),
          resetAt: Date.now() + 60000,
        };
      },
    });
  },
});
```

### `app.setRequestIdGenerator()` — Custom request ID

Override the request ID generation algorithm. By default `crypto.randomUUID()` is used.

```typescript
export default definePlugin({
  name: "custom-request-id",

  setup(app) {
    let counter = 0;

    app.setRequestIdGenerator(() => {
      // Use custom format: timestamp + counter
      return `${Date.now()}-${++counter}`;
    });
  },
});
```

## Plug-in loading process

### Startup timing

In the `bootstrap` startup process, plugins are executed in the following stages:

```
1. config → load and merge configuration
2. locales → load i18n language pack
3. plugins → ⭐ topological sort + execute setup() (here)
4. middlewares → Scan middleware definition
5. services → instantiated services
6. routes → Register routes
7. HTTP monitoring → onReady hook triggered
```

This means:

- ✅ `app.config` can be accessed in `setup()` (already loaded)
- ✅ `app.logger` can be accessed in `setup()` (already initialized)
- ✅ `app.extend()` / `app.use()` / `app.onClose()` / `app.onReady()` can be called in `setup()`
- ❌ `app.services` cannot be accessed in `setup()` (the service has not been loaded yet)
- ❌ `setup()` **cannot** assume that the route is registered

To perform an operation after all modules have been loaded, use `app.onReady()`.

### Topological sorting

`plugin-loader` performs topological sorting based on `dependencies` declarations:

```typescript
// plugins/database.ts — no dependencies, executed first
definePlugin({ name: 'database', setup: ... });

// plugins/query-cache.ts — depends on database
definePlugin({ name: 'query-cache', dependencies: ['database'], setup: ... });

// plugins/session.ts — depends on query-cache and database
definePlugin({ name: 'session', dependencies: ['query-cache', 'database'], setup: ... });
```

Execution order: `database` → `query-cache` → `session`

If there is a circular dependency (A → B → A), the framework will report a Fail Fast error at startup.

### Timeout protection

Each `setup()` is protected by a hard timeout (default 30 seconds). If initialization times out, the framework aborts `context.signal`, rolls back setup-time framework mutations, revokes the setup facade, and throws an explicit error. A plugin still owns external resources it created before cancellation, so it must honor the signal and close partially created clients in its own `catch`/`finally` path.

## Practical example

### Database plug-in

```typescript
// src/plugins/database.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "database",

  async setup(app) {
    //Read database connection information from configuration
    const dbConfig = app.config.database ?? {
      host: "localhost",
      port: 5432,
      database: "myapp",
    };

    // Create database connection (example)
    const pool = await createPool(dbConfig);

    //Inject into app
    app.extend("db", {
      query: (sql: string, params?: unknown[]) => pool.query(sql, params),
      transaction: (fn: Function) => pool.transaction(fn),
    });

    //Close gracefully
    app.onClose(async () => {
      app.logger.info("Closing database pool...");
      await pool.end();
    });

    //readiness check
    app.onReady(async () => {
      try {
        await pool.query("SELECT 1");
        app.logger.info("Database connection verified");
      } catch (err) {
        app.logger.error({ err }, "Database health check failed");
      }
    });

    app.logger.info("Database plugin initialized");
  },
});
async function createPool(config: any) {
  //In actual implementation, pg, mysql2 and other drivers are used
  return {
    query: async (sql: string, params?: unknown[]) => ({ rows: [] }),
    transaction: async (fn: Function) => fn(),
    end: async () => {},
  };
}
```

### Sentry error monitoring plug-in

```typescript
// src/plugins/sentry.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "sentry",

  setup(app) {
    const dsn = app.config.sentry?.dsn;
    if (!dsn) {
      app.logger.warn("Sentry DSN not configured, skipping initialization");
      return;
    }

    //Initialize Sentry
    // Sentry.init({ dsn });

    //Register global error catching middleware
    app.use(async (req, res, next) => {
      try {
        await next();
      } catch (err) {
        //Report to Sentry
        // Sentry.captureException(err, { extra: { requestId: req.requestId } });
        app.logger.error(
          { err, requestId: req.requestId },
          "Error captured by Sentry",
        );

        // Rethrow and let the framework's error-handler handle the response
        throw err;
      }
    });

    app.logger.info("Sentry plugin initialized");
  },
});
```

### Scheduled task plug-in

```typescript
// src/plugins/scheduler.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "scheduler",

  setup(app) {
    const timers: NodeJS.Timeout[] = [];

    app.extend("scheduler", {
      every(ms: number, name: string, fn: () => Promise<void>) {
        const timer = setInterval(async () => {
          try {
            await fn();
          } catch (err) {
            app.logger.error({ err, task: name }, "Scheduled task failed");
          }
        }, ms);
        timers.push(timer);
        app.logger.info({ name, intervalMs: ms }, "Scheduled task registered");
      },
    });

    //Clear all timers on graceful shutdown
    app.onClose(() => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      app.logger.info(`Cleared ${timers.length} scheduled task(s)`);
    });

    //Register the scheduled task when ready
    app.onReady(async () => {
      (app as any).scheduler.every(
        60_000,
        "cleanup-expired-sessions",
        async () => {
          // await app.services.session.cleanupExpired();
          app.logger.debug("Expired sessions cleaned up");
        },
      );
    });
  },
});
```

## Built-in plug-ins

VextJS has the following built-in plugins:

| Plug-in name  | Description                        | Conditional loading                                        |
| ------------- | ---------------------------------- | ---------------------------------------------------------- |
| **monsqlize** | MonSQLize database ORM integration | Automatically load when `monsqlize` dependency is detected |

The built-in plugin uses `shouldLoadMonSQLize()` to decide whether to load. It needs no manual registration, and Vext skips loading it when the required dependency or database configuration is absent.

## File upload

VextJS has built-in `multipart/form-data` parsing, based on Node.js 20+ native `Request.formData()` API, with zero external dependencies. Just turn it on in configuration.

### Enable built-in parsing

```typescript
// src/config/default.ts
export default {
  multipart: {
    enabled: true, // Enable built-in parsing
    maxFileSize: 10 * 1024 * 1024, // The upper limit of a single file is 10MB (default)
    maxFiles: 10, // Maximum number of files at a time (default)
    // allowedMimeTypes: ['image/jpeg', 'image/png'], // Optional: MIME whitelist
  },
};
```

When enabled, all `multipart/form-data` request bodies will be automatically parsed by body-parser, and the results will be filled in `req.files` (type `ParsedFile[]`). Zero impact on performance when not enabled.

### Used in routing

```typescript
// src/routes/upload.ts
export default defineRoutes((app) => {
  app.post(
    "/upload",
    {
      multipart: {
        enabled: true,
        files: {
          avatar: "User avatar",
          resume: { description: "Resume file", required: true },
        },
      },
    },
    async (req, res) => {
      const avatarFile = req.files?.find((f) => f.fieldname === "avatar");
      if (!avatarFile) {
        res.json({ code: 400, message: "File not uploaded" }, 400);
        return;
      } // Verify file type
      if (!avatarFile.mimetype.startsWith("image/")) {
        res.json(
          { code: 400, message: "Only image formats are supported" },
          400,
        );
        return;
      }

      // Save the file (avatarFile.buffer ensures binary integrity)
      const filename = `${Date.now()}-${avatarFile.filename}`;
      await fs.writeFile(`./uploads/${filename}`, avatarFile.buffer);

      res.json({ filename, size: avatarFile.size });
    },
  );
});
```

Use `multipart.enabled: true` for route-level opt-in when global parsing is disabled. When global parsing is enabled, a route can set `multipart.enabled: false` to skip built-in parsing. The `files` map also feeds OpenAPI `multipart/form-data` generation and required-file runtime checks.

### ParsedFile structure

| Field       | Type     | Description                                           |
| ----------- | -------- | ----------------------------------------------------- |
| `fieldname` | `string` | Form field name (`avatar` of `<input name="avatar">`) |
| `filename`  | `string` | Client original file name                             |
| `mimetype`  | `string` | MIME type (such as `image/jpeg`)                      |
| `buffer`    | `Buffer` | Complete binary content of file                       |
| `size`      | `number` | File size (bytes)                                     |

:::tip Fastify users
`multipart.maxFileSize` only limits the size of a single file; the total request body read limit is controlled by `bodyParser.maxBodySize`. When using Fastify, if adapter `bodyLimit` is additionally configured, the actual read boundary will be the smaller of the overall upper limit of adapter `bodyLimit` and body-parser.
:::

### Custom parsing (advanced)

If you need to use third-party libraries such as [busboy](https://github.com/mscdex/busboy) for more fine-grained control (such as streaming writing to disk), you can implement it through plug-ins.

Two usage modes are supported:

- **Exclusive mode**: Keep `multipart.enabled` as `false` (default), and the plugin is solely responsible for parsing
- **Coexistence mode**: When `multipart.enabled: true` is used, the global body-parser parses first, and the plug-in detects and exits early through `req.files !== undefined` to avoid double parsing.

It is recommended to add guard at the beginning of the plug-in in coexistence mode so that it can be used safely in both scenarios:

```typescript
// src/plugins/upload-custom.ts
import { definePlugin } from "vextjs";
import type { ParsedFile } from "vextjs";
import busboy from "busboy";

export default definePlugin({
  name: "upload-custom",

  setup(app) {
    app.use(async (req, _res, next) => {
      const ct = req.headers["content-type"] ?? "";
      if (!ct.startsWith("multipart/form-data")) {
        await next();
        return;
      }

      // guard: skip directly when the global body-parser has been parsed to avoid double processing
      if (req.files !== undefined) {
        await next();
        return;
      }

      const rawBuffer = await req._getRawBodyBuffer();

      req.files = await new Promise<ParsedFile[]>((resolve, reject) => {
        const bb = busboy({ headers: { "content-type": ct } });
        const collected: ParsedFile[] = [];

        bb.on("file", (fieldname, stream, info) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            const buffer = Buffer.concat(chunks);
            collected.push({
              fieldname,
              filename: info.filename,
              mimetype: info.mimeType,
              buffer,
              size: buffer.byteLength,
            });
          });
        });

        bb.on("finish", () => resolve(collected));
        bb.on("error", reject);
        bb.write(rawBuffer);
        bb.end();
      });

      await next();
    });
  },
});
```

:::tip file size limit
Control the individual file size through `app.config.multipart.maxFileSize` (bytes); control the total request body size through `app.config.bodyParser.maxBodySize`. The two have independent semantics. Fastify adapter will not use `maxFileSize` to expand the total request body reading limit.
:::

## Plug-ins vs middleware vs services

| Aspects               | Plugins                                  | Middleware                                | Services                        |
| --------------------- | ---------------------------------------- | ----------------------------------------- | ------------------------------- |
| Placement directory   | `src/plugins/`                           | `src/middlewares/`                        | `src/services/`                 |
| Definition method     | `definePlugin()`                         | `defineMiddleware()`                      | `export default class`          |
| Execution time        | At startup (one-time)                    | Each request                              | Each method call                |
| Visit `app`           | `setup(app)`                             | `req.app`                                 | `constructor(app)`              |
| Main responsibilities | Extended framework capabilities          | Request interception/processing           | Business logic                  |
| Typical use cases     | Database connection, caching, monitoring | Authentication, logging, current limiting | CRUD, calculation, external API |

**Selection Guide:**

- Need to initialize resources (such as database connections) at startup → **Plug-in**
- Need to intercept every request (like authentication check) → **Middleware**
- Need to encapsulate reusable business logic → **Service**
- Need to add new capabilities to `app` → **plugin** (`app.extend()`)
- Need to replace framework built-in behavior → **plug-in** (`app.setValidator()`, etc.)

## Best Practices

### 1. Conditional initialization

Decide whether to initialize the plug-in based on the configuration to avoid wasting resources when they are not needed:

```typescript
export default definePlugin({
  name: "redis",

  async setup(app) {
    if (!app.config.redis?.enabled) {
      app.logger.info("Redis not configured, skipping");
      return;
    }

    //Initialize...
  },
});
```

### 2. Always register shutdown hooks

If the plug-in opens an external connection (database, message queue, Redis, etc.), the `app.onClose()` hook must be registered to ensure graceful closing:

```typescript
app.extend("mq", messageQueue);
app.onClose(async () => {
  await messageQueue.close();
});
```

### 3. Explicitly declare dependencies

If a plugin depends on the injection capabilities of other plugins, be sure to declare it in `dependencies` instead of assuming load order:

```typescript
// ✅ Correct — explicit declaration
definePlugin({
  name: "session",
  dependencies: ["redis"],
  setup(app) {
    /* ... */
  },
});

// ❌ Danger — relies on filename ordering
definePlugin({
  name: "session",
  // There are no dependencies. It is assumed that redis will be loaded first because the alphabetical order is in front.
  setup(app) {
    /* ... */
  },
});
```

### 4. Use `app.onReady()` to perform post-processing operations

Operations that need to wait until all modules are loaded (such as warming up the cache) should be placed in `app.onReady()` instead of `setup()`:

```typescript
setup(app) {
  // ❌ services have not been loaded yet during setup
  // await app.services.user.warmupCache();

  // ✅ Everything is ready when onReady
  app.onReady(async () => {
    await app.services.user.warmupCache();
  });
},
```

### 5. Error tolerance

Failure to initialize non-core plugins should not block the entire application startup:

```typescript
export default definePlugin({
  name: "analytics",

  async setup(app) {
    try {
      const client = await initAnalytics(app.config.analytics);
      app.extend("analytics", client);
    } catch (err) {
      app.logger.warn(
        { err },
        "Analytics plugin init failed, continuing without analytics",
      );
      // Provide an empty implementation to prevent other code from crashing because app.analytics does not exist
      app.extend("analytics", {
        track: () => {},
        identify: () => {},
      });
    }
  },
});
```

## Next step

- Understand the [Preload](/guide/preload) mechanism to allow the plug-in package to automatically inject pre-launch scripts (such as OpenTelemetry SDK)
- Learn about the declarative DSL syntax of [Parameter Validation](/guide/validation)
- Learn how to use [middleware](/guide/middleware) with plug-ins
- View plug-in related configuration items in [Configuration](/guide/configuration)
- Explore [Testing](/guide/testing) How to write tests for plugins
