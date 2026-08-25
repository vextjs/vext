# Application example

This page details the complete API of the VextJS application instance `VextApp`, including built-in modules, extension methods, life cycle hooks and startup functions.

## Overview

`VextApp` is the core object of the entire VextJS application, created through `createApp(config)`. It mounts built-in capabilities such as configuration, services, logging, and error throwing, and supports plug-in extensions through methods such as `extend()` / `use()`.

In most scenarios, you don't need to call `createApp()` directly - `bootstrap()` will call it automatically internally. You access `app` via:

- **Route handler**: Closure parameter of `defineRoutes((app) => { ... })`
- **Middleware**: `req.app`
- **Plug-in setup**: Parameters of `setup(app)`
- **Services**: access each other through `app.services`

---

## Life cycle

`VextApp` goes through the following stages from creation to destruction:

```
createApp(config)
  → resolveAdapter() // Resolve the underlying HTTP adapter
  → plugin-loader // Load the plugin and execute setup() (app.use() is available)
  → middleware-loader // Load middleware definition
  → service-loader // Load services (app.services injection)
  → mount app.fetch // Mount built-in HTTP client (requestId propagation + structured log)
  → router-loader // Load routing files and register routes
  → lockUse() // disable app.use()
  → Register built-in middleware // requestId / cors / bodyParser / rateLimit / responseWrapper / accessLog / errorHandler
  → adapter.listen() // HTTP starts listening
  → onReady hook // ready callback execution
  → Running...
  → SIGTERM / SIGINT // Signal received
  → shutdown() // graceful shutdown
    → Stop accepting new requests
    → Wait for in-flight request to complete
    → onClose hook (LIFO)
    → process.exit(0)
```

---

## bootstrap

`bootstrap()` is the standard startup function of the framework, arranging a complete startup process.

```typescript
import { bootstrap } from "vextjs";

bootstrap();
```

### Function signature

```typescript
function bootstrap(rootDir?: string): Promise<BootstrapResult>;

interface BootstrapResult {
  app: VextApp;
  serverHandle: VextServerHandle;
  internals: AppInternals;
}
```

### Parameters

| Parameters | Type     | Default value   | Description            |
| ---------- | -------- | --------------- | ---------------------- |
| `rootDir`  | `string` | `process.cwd()` | Project root directory |

### Start the process

`bootstrap()` internally performs the following steps (in order):

| Steps | Action                       | Instructions                                                                  |
| ----- | ---------------------------- | ----------------------------------------------------------------------------- |
| ①     | `loadConfig()`               | Three-layer configuration merging (default → env → local)                     |
| ②     | `createApp(config)`          | Create app instance                                                           |
| ③     | `resolveAdapter()`           | Resolve and instantiate the underlying adapter                                |
| ④     | `loadPlugins()`              | Scan `src/plugins/` and execute according to topological sorting `setup()`    |
| ⑤     | `loadMiddlewares()`          | Scan `src/middlewares/` and register middleware definitions                   |
| ⑥     | `loadServices()`             | Scan `src/services/` and inject into `app.services`                           |
| ⑥+    | Mount `app.fetch`            | Encapsulate Node.js fetch, automatically propagate requestId + structured log |
| ⑦     | `loadRoutes()`               | Scan `src/routes/` and register routes to adapter                             |
| ⑧     | `lockUse()`                  | Lock `app.use()` and prohibit subsequent registration of global middleware    |
| ⑨     | Register built-in middleware | requestId → cors → bodyParser → rateLimit → responseWrapper → accessLog       |
| ⑩     | Registration error handling  | errorHandler + 404 Keep the secret                                            |
| ⑪     | `adapter.listen()`           | HTTP starts listening                                                         |
| ⑫     | `setupShutdown()`            | Register signal processing (SIGTERM / SIGINT)                                 |
| ⑬     | `runReady()`                 | Execute all `onReady` hooks                                                   |

### Typical entry file

```typescript
// src/index.ts
import { bootstrap } from "vextjs";

bootstrap().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
```

### Return value

```typescript
const { app, serverHandle } = await bootstrap();
// app: VextApp instance
// serverHandle: HTTP server handle (used to obtain the listening address, etc.)
console.log(
  `The server is running at http://${app.config.host}:${app.config.port}`,
);
```

---

## createApp

`createApp()` is the underlying factory function that creates `VextApp` instances and a collection of framework internal methods.

```typescript
import { createApp, DEFAULT_CONFIG } from "vextjs";

const { app, internals } = createApp(config);
```

### Function signature

```typescript
function createApp(config: VextConfig): {
  app: VextApp;
  internals: AppInternals;
};
```

### Return value

| Field       | Type           | Description                                         |
| ----------- | -------------- | --------------------------------------------------- |
| `app`       | `VextApp`      | User-visible application instance                   |
| `internals` | `AppInternals` | Framework internal methods (only used by bootstrap) |

:::tip
Normally there is no need to call `createApp()` directly. `bootstrap()` and `createTestApp()` have encapsulated the complete initialization process internally. Only use this function if you need to completely customize the startup process.
:::

---

## VextApp interface

### Built-in modules

#### `app.logger`

Structured log instance, implemented based on Vext’s built-in logger kernel.

```typescript
logger: VextLogger;
```

Automatically carry `requestId` (through AsyncLocalStorage), support `trace()`, runtime `getLevel()` / `setLevel()` and `.child()` to create child logger.

```typescript
//Basic usage
app.logger.info("Server started successfully");
app.logger.error({ userId: "123" }, "User query failed");
app.logger.debug("Debug information");
app.logger.trace("Detailed troubleshooting information");

//Adjust subsequent log thresholds at runtime
app.logger.getLevel(); // "info"
app.logger.setLevel("debug");

// Structured log (object + message)
app.logger.info(
  { event: "user_created", userId: "abc" },
  "User created successfully",
);

// Child logger (carries additional context)
const serviceLogger = app.logger.child({ service: "UserService" });
serviceLogger.info("Query user list");
// → { service: 'UserService', requestId: '...', msg: 'Query user list' }
```

**Log level method**:

| Method              | Level | Description                                    |
| ------------------- | ----- | ---------------------------------------------- |
| `logger.fatal(...)` | fatal | Fatal error, the application is about to crash |
| `logger.error(...)` | error | runtime error                                  |
| `logger.warn(...)`  | warn  | Warning message                                |
| `logger.info(...)`  | info  | General information (default level)            |
| `logger.debug(...)` | debug | debug information                              |
| `logger.trace(...)` | trace | The most granular troubleshooting information  |

Each method supports two signatures:

```typescript
// pure message
logger.info(msg: string, ...args: unknown[]): void;

// object + message
logger.info(obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
```

**`getLevel()` / `setLevel(level)`**:

```typescript
getLevel(): "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
setLevel(level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent"): void;
```

`setLevel()` only affects subsequent logs; created child loggers share the current runtime level with the parent logger. The default logger does not provide a writable `app.logger.level` property.

**`child(bindings)`**:

```typescript
child(bindings: Record<string, unknown>): VextLogger;
```

Create a child logger with additional context fields. All logs output through child loggers will automatically have the fields in `bindings` appended.

```typescript
//Create a dedicated logger in the service
class UserService {
  private logger: VextLogger;

  constructor(app: VextApp) {
    this.logger = app.logger.child({ service: "UserService" });
  }

  async findById(id: string) {
    this.logger.info({ userId: id }, "Query user");
    // → { service: 'UserService', userId: '123', requestId: '...', msg: 'Query user' }
  }
}
```

---

#### `app.throw(status, message, paramsOrCode?, codeOrDetails?)`

When an HTTP error is thrown, the framework uniformly converts it to a standard error response. Three calling forms are supported.

:::info When to use `app.throw()`
`app.throw()` is suitable for scenarios where "I want to actively return a clear HTTP error to the caller", such as `401`, `404`, `409` or a response with a business error code.

If an unexpected runtime exception occurs, you can also directly throw new Error("...")`, and the framework will also catch it, but this type of error will enter an unknown exception path and eventually turn into `500 Internal Server Error`. If field-level validation details need to be returned, `VextValidationError` should be thrown.
:::

**Function signature**:

```typescript
// Shortcut (i18n key, status read from i18n configuration, default 400)
throw(messageKey: string): never;
throw(messageKey: string, params: Record<string, unknown>): never;// Complete object entry
throw(options: {
  status: number;
  message: string;
  params?: Record<string, unknown>;
  code?: number | string;
  details?: unknown;
}): never;

// Standard call (explicitly specify HTTP status code)
throw(
  status: number,
  message: string,
  paramsOrCode?: Record<string, unknown> | number | string,
  codeOrDetails?: number | string | Record<string, unknown> | unknown[],
): never;
```

---

##### Shortcut (recommended for i18n scenarios)

When the first parameter is a **string**, it is regarded as an i18n key shortcut call. The HTTP status code is read from the `statusCode` field configured in the i18n language package. If not configured, the default is `400`:

```typescript
// The shortest way - status is read from i18n configuration, default is 400
app.throw("balance.insufficient");

//With i18n interpolation parameters
app.throw("balance.insufficient", { balance: 50, required: 100 });

// i18n configuration specifies statusCode: 404 → automatically uses 404
app.throw("user.not_found");
```

**Status parsing rules for shortcuts**:

| Priority | Source                                | Description                                              |
| :------: | ------------------------------------- | -------------------------------------------------------- |
|    1     | `statusCode` in i18n language package | If `user.not_found` is configured with `statusCode: 404` |
|    2     | Default value `400`                   | Base value when `statusCode` is not configured           |

**Business error code of shortcut**: If the i18n language package is configured with an independent `code` for the key (different from the key itself), it will be automatically appended to the response.

---

##### Standard call

When the first parameter is a number, as an HTTP status code, the behavior is exactly the same as before:

```typescript
// simple error
app.throw(404, "User does not exist");

//With business error code (number)
app.throw(400, "Email has been registered", 10001);

//With business error code (string)
app.throw(401, "Missing authentication token", "UNAUTHORIZED");

//With i18n parameter
app.throw(400, "balance.insufficient", { balance: 50 });

// Bring i18n parameters and business code at the same time
app.throw(400, "balance.insufficient", { balance: 50 }, 20001);

// When the fourth parameter is an object or array, it is output as details
app.throw(
  502,
  "payment.failed",
  { orderId },
  {
    provider: "stripe",
    providerCode: "card_declined",
  },
);

// When code + details are required at the same time, use the object entry
app.throw({
  status: 502,
  message: "payment.failed",
  code: "PAYMENT_FAILED",
  details: { provider: "stripe", providerCode: "card_declined" },
});
```

**Standard calling parameters**:

| Parameters      | Type                                                       | Description                                                                                                   |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `status`        | `number`                                                   | HTTP status code (400/401/403/404/409/500…)                                                                   |
| `message`       | `string`                                                   | Error description (also looked up as i18n key)                                                                |
| `paramsOrCode`  | `Record<string, unknown> \| number \| string`              | i18n interpolation parameter object or business error code                                                    |
| `codeOrDetails` | `number \| string \| Record<string, unknown> \| unknown[]` | When the fourth parameter is number/string, it is the business code; when it is object/array, it is `details` |

`details` is suitable for storing business details returned by third-party interfaces, such as upstream error codes, original messages, trace ids or fields that can be displayed to the caller. The framework will do JSON-safe cleaning before responding: circular references will become `"[Circular]"`, `Date` will output ISO strings, `Error` will only output `name/message`, and functions and `undefined` will not appear in the response. Unknown plain `Error` details are not automatically exposed and must be passed in explicitly via `HttpError` or `app.throw`.

---

##### i18n linkage

`message` (or `messageKey` for shortcuts) also serves as the i18n key for language pack lookup. The framework obtains the `locale` of the current request through AsyncLocalStorage and automatically translates the error message:

```typescript
// standard call
app.throw(404, "user.not_found");

// Shortcut (same effect, provided statusCode: 404 is in i18n configuration)
app.throw("user.not_found");

// Chinese environment → { code: 404, message: 'User does not exist' }
// English environment → { code: 404, message: 'User not found' }
```

When there is no i18n language pack, it degrades to the original message and is passed directly.

**Error response format**:

```json
{
  "code": 10001,
  "message": "Email has been registered",
  "details": {
    "provider": "stripe",
    "providerCode": "card_declined"
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

:::tip
The return type of `app.throw()` is `never`, which means it interrupts the current function execution. No need to add a `return` statement after the call. The TypeScript type system correctly identifies subsequent code as unreachable.
:::

---

#### `app.config`

Final merged runtime configuration (read-only).

```typescript
config: Readonly<VextConfig>;
```

The `default → env → local → bootstrap provider patch → CLI override` configuration chain is loaded by `loadConfig()` and deep frozen.

```typescript
app.get("/info", async (_req, res) => {
  res.json({
    port: app.config.port,
    adapter: typeof app.config.adapter,
    corsEnabled: app.config.cors.enabled,
  });
});
```

:::warning
`app.config` is frozen at runtime and any attempt to modify it will throw an error (strict mode) or fail silently. For dynamic configuration, use `app.extend()` to mount mutable state.
:::

---

#### `app.services`

All service instances injected by `service-loader`.

```typescript
services: VextServices;
```

Access via `app.services.<name>`. `service-loader` is executed before `router-loader`, so it is safe to access `app.services` in the handler.

```typescript
// src/services/user.ts
export default class UserService {
  constructor(private app: VextApp) {}

  async findById(id: string) {
    // ...
  }
}

// src/routes/users.ts
export default defineRoutes((app) => {
  app.get("/:id", async (req, res) => {
    const user = await app.services.user.findById(req.params.id);
    res.json(user);
  });
});
```

**Type extension**:

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextServices {
    user: import("../src/services/user").default;
    order: import("../src/services/order").default;
  }
}
```

---

#### `app.hooks`

Framework lifecycle hook manager for registering runtime observations, lightweight patches, and cross-module integration logic.

```typescript
hooks: VextHooks;

type Off = () => void;

app.hooks.on(name, handler): Off;
app.hooks.has(name): boolean;
```

`app.hooks.on()` returns the logout function. `app.hooks` is a reserved property and cannot be overridden by `app.extend("hooks", ...)`.

```typescript
const off = app.hooks.on("validation:success", ({ req, route }) => {
  app.logger.info(
    { requestId: req.requestId, route: route.path },
    "validated request",
  );
});

app.hooks.on("response:before", ({ headers }) => ({
  headers: { ...headers, "x-powered-by": "vext" },
}));

off();
```

**Execution Strategy**:

| Hook Type                                                                                                                                                                                    | Strategy                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `request:start`, `validation:success`, `handler:before`, `fetch:before`, `proxy:before`, `plugin:beforeSetup`, `server:beforeListen`                                                         | Errors thrown by the handler will propagate upward and can prevent subsequent processes |
| `response:before`, `error:beforeResponse`, `service:beforeCall`, `service:afterCall`, `service:error`, `openapi:*`                                                                           | Synchronous life cycle, return of Promise is not allowed                                |
| `handler:after`, `handler:error`, `response:after`, `error:afterResponse`, `fetch:after/error`, `proxy:after/error`, `cache:*`, `plugin:afterSetup/error`, `routes:ready`, `app:ready/close` | safe emit, hook errors will be recorded but will not change the main process            |

**Available hooks**:

| Name                                                      | Trigger Point                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `request:start`                                           | After requestId is generated, it enters the global middleware chain; 404 will also be triggered, `matched=false`  |
| `route:matched`                                           | After the adapter matches the route and before executing the checksum handler                                     |
| `route:notFound`                                          | No route matching, 404 response before sending                                                                    |
| `validation:success`                                      | Route `validate` all passed, before `next()`                                                                      |
| `validation:error`                                        | Route `validate` fails and throws `VextValidationError` before                                                    |
| `handler:before`                                          | Before the business handler is called                                                                             |
| `handler:after`                                           | After the business handler returns successfully                                                                   |
| `handler:error`                                           | After the business handler throws an error and before entering global error handling                              |
| `response:before`                                         | Runs before `json/rawJson/text/html/render/stream/download/redirect`; synchronously patches `data/status/headers` |
| `response:after`                                          | After the response is sent                                                                                        |
| `error:beforeResponse`                                    | `error-handler` can synchronize patch `body/status` before writing JSON error response                            |
| `error:afterResponse`                                     | After the error response is sent                                                                                  |
| `fetch:before`                                            | `app.fetch` can be modified before leaving the website `Headers`                                                  |
| `fetch:after`                                             | `app.fetch` returns `Response` after                                                                              |
| `fetch:error`                                             | `app.fetch` finally fails                                                                                         |
| `proxy:before`                                            | `app.fetch.proxy` After parsing the upstream request and before sending it                                        |
| `proxy:after`                                             | `app.fetch.proxy` after receiving the upstream response and before transparent transmission                       |
| `proxy:error`                                             | `app.fetch.proxy` on local error, timeout or upstream network failure                                             |
| `service:loaded`                                          | After service is loaded and mounted during cold start                                                             |
| `service:reloaded`                                        | dev soft reload after re-instantiating service                                                                    |
| `service:beforeCall`                                      | Before the service method is called                                                                               |
| `service:afterCall`                                       | After the service method returns successfully                                                                     |
| `service:error`                                           | After the service method throws an error or rejects                                                               |
| `cache:hit`, `cache:miss`, `cache:write`, `cache:error`   | Route-level response cache read and write life cycle                                                              |
| `plugin:beforeSetup`, `plugin:afterSetup`, `plugin:error` | Plugin `setup()` before and after and failure; plugins cannot observe their own `beforeSetup`                     |
| `routes:ready`                                            | After route scanning and registration are completed                                                               |
| `openapi:beforeGenerate`, `openapi:afterGenerate`         | Before and after OpenAPI document generation; `afterGenerate` can replace document synchronously                  |
| `server:beforeListen`                                     | Before HTTP server starts listening                                                                               |
| `app:ready`                                               | `onReady` before and after execution                                                                              |
| `app:close`                                               | `onClose`/shutdown before and after execution                                                                     |

:::tip
If you only want to record "requests that pass parameter verification", use `validation:success`. In this way, requests that fail verification will not enter this hook, which is more direct than manually excluding `VextValidationError` in ordinary global middleware.
:::

---

#### `app.cache`

Route-level response cache management API. Initialized in the `createApp` stage, it provides operations such as label invalidation, specified key deletion, clearing, and statistics.

```typescript
cache: {
  invalidate(tag: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): { entries: number; hits: number; misses: number; hitRate: number };
};
```

| Method            | Description                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `invalidate(tag)` | Batch invalidate all associated cache entries by tag                                    |
| `delete(key)`     | Delete the cache of the specified key                                                   |
| `clear()`         | Clear all entries in the current vext response cache namespace                          |
| `stats()`         | Return cache statistics (number of entries, number of hits, number of misses, hit rate) |

```typescript
//Invalid related cache after product update
app.post("/products", {}, async (req, res) => {
  await db.createProduct(req.body);
  await app.cache.invalidate("products");
  res.json({ created: true }, 201);
});

//View cache statistics
app.get("/admin/cache-stats", {}, async (req, res) => {
  res.json(app.cache.stats());
});
```

`app.cache` is Vext's control surface wrapper for `response-cache-kit`; business code does not need to directly operate the underlying Store. In Redis/MultiLevel mode, `clear()` will not clear the entire Redis library, but will only clear the current vext response cache namespace. When shutdown is applied, Vext will close the response cache runtime resource after the user's `onClose` hook is executed. See the [Response Caching Guide](/guide/cache) for details.

---

#### `app.db`

The single database entry point. When `config.database` is present, Vext mounts
the exact raw `MonSQLize` instance here; without database configuration the
property remains unavailable.

```typescript
db?: VextDatabase; // MonSQLize plus Vext's read-only client getter
```

`app.db` is not a facade or Proxy, so the complete upstream instance API is
available: `collection()`, `model()`, `use()`, `pool()`, `scopedModel()`,
`withTransaction()`, `sync()`, events, diagnostics, and management methods.
Vext v2 does not expose a second `app.monsqlize` property.

```typescript
const users = app.db?.collection("users");
const User = app.db?.model("users");
const Invoice = app.db?.use("billing").model("BillingInvoice");
const session = app.db?.client.startSession();
```

Model registry keys are exact. `use()` and `pool()` select a database or pool
scope but never prepend scope names or fall back to a transformed key. A short
name is valid only when the Model explicitly registered that `key` alias. Vext
owns connection cleanup during graceful shutdown; application code should not
close `app.db` in a second `onClose` hook. See the [Database Guide](/guide/database).

---

#### `app.adapter`

The underlying adapter instance (mounted after being resolved by `resolveAdapter()`).

```typescript
adapter: VextAdapter;
```

:::warning
This is a framework internal property and user code usually does not need to manipulate the adapter directly. The framework registers middleware, routing, error handling, etc. through adapter.
:::

---

### HTTP method

The HTTP methods on `VextApp` (`get/post/put/patch/delete/head/options`) are **placeholder methods** and cannot be called directly. The actual route registration is done through `defineRoutes`.

```typescript
// ❌ Calling it directly on the app will throw an error
app.get("/hello", handler);
// Error: [vextjs] app.get() cannot be called directly on the app instance.
// Use defineRoutes(app => { app.get(...) }) in route files.

// ✅ Register via defineRoutes
export default defineRoutes((app) => {
  app.get("/hello", handler); // OK — app here is collector
});
```

Supports **three-paragraph** and **two-paragraph** two syntaxes:

```typescript
// Three-part formula: (path, options, handler)
app.get(
  "/users",
  {
    validate: { query: { page: "number:1-" } },
  },
  handler,
);

//Two paragraphs: (path, handler)
app.get("/health", handler);
```

Supported methods: `get` / `post` / `put` / `patch` / `delete` / `head` / `options`

---

### Framework extension API

#### `app.extend(key, value)`

Mount custom properties to the app (**Plug-in only**).

```typescript
extend<K extends string, V>(key: K, value: V): void;
```

```typescript
//Mount in plugin
import { definePlugin } from "vextjs";
import Redis from "ioredis";

export default definePlugin({
  name: "redis",
  async setup(app) {
    const redis = new Redis(app.config.redis);
    app.extend("redis", redis);
    app.onClose(() => redis.quit());
  },
});
```

Use with `declare module` to get type hints:

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextApp {
    redis: import("ioredis").Redis;
  }
}

//There are type hints when using
app.redis.get("key"); // ✅ IDE knows it is a Redis instance
```

---

#### `app.use(middleware)`

Register global HTTP middleware (**plugin-specific**).

```typescript
use(middleware: VextMiddleware): void;
```

Effective for all routes, executed before route-level middlewares. It can only be called in plug-in `setup()`. The call will throw an error after the route registration is completed.

```typescript
import { definePlugin, securityHeaders } from "vextjs";

export default definePlugin({
  name: "security",
  setup(app) {
    app.use(securityHeaders({ preset: "strict" }));
  },
});
```

For app-wide browser security headers, prefer `config.securityHeaders` because it also covers errors, 404 responses, testing helpers, and dev soft reload. Manual `app.use(securityHeaders())` is a scoped plugin entry.

:::warning
`app.use()` will be locked after route registration (`router-loader`) is completed. Calls after this will throw an error:

```
[vextjs] app.use() is locked after route registration.
Global middleware must be registered in plugin setup().
```

:::

---

#### `app.setValidator(validator)`

Replace the global validation engine (**Plug-in only**).

```typescript
setValidator(validator: VextValidator): void;
```

By default, `schema-dsl` is used, which can be replaced by third-party verification libraries such as Zod and Yup.

```typescript
import { definePlugin } from "vextjs";
import { z } from "zod";

export default definePlugin({
  name: "zod-validator",
  setup(app) {
    const originalValidator = app.getValidator();

    app.setValidator({
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

        if (schema instanceof z.ZodType) {
          return (data) => toVextResult(schema.safeParse(data));
        }

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

        return originalValidator.compile(schema);
      },
    });
  },
});
```

---

#### `app.getValidator()`

Get the current global verification engine instance.

```typescript
getValidator(): VextValidator;
```

The default validator is implemented based on schema-dsl. Plug-ins can replace it with Zod, Yup, etc. implementations through `app.setValidator()`, so `getValidator()` is not equivalent to a fixed schema-dsl, but always returns the currently valid validator.

```typescript
const validator = app.getValidator();
const validate = validator.compile({ name: "string:1-50" });
const result = validate({ name: "Alice" });
// { valid: true, data: { name: 'Alice' } }
```

It can also be reused when handling non-HTTP input in the service:

```typescript
import { VextValidationError, type VextApp, type VextValidator } from "vextjs";

export default class UserService {
  private validateCreateUser: ReturnType<VextValidator["compile"]>;

  constructor(private app: VextApp) {
    this.validateCreateUser = app.getValidator().compile({
      name: "string:1-50!",
      email: "email!",
    });
  }

  async createFromMessage(input: unknown) {
    const result = this.validateCreateUser(input);
    if (!result.valid) {
      throw new VextValidationError(result.errors ?? []);
    }
    return result.data;
  }
}
```

---

#### `app.setThrow(wrapper)`

Wraps or replaces the implementation of `app.throw` (**Plugin-specific**).

```typescript
setThrow(wrapper: (original: VextApp['throw']) => VextApp['throw']): void;
```

Receives the original `throw` implementation and returns the new implementation. Can be used to intercept errors, add logs, modify error formats, etc.

```typescript
import { definePlugin } from "vextjs";
export default definePlugin({
  name: "error-tracking",
  setup(app) {
    app.setThrow((originalThrow) => {
      return (status, message, paramsOrCode, code) => {
        //Report errors to the monitoring platform
        if (status >= 500) {
          errorTracker.captureError(new Error(message), { status });
        }
        // Call the original implementation
        return originalThrow(status, message, paramsOrCode, code);
      };
    });
  },
});
```

---

#### `app.setLogger(wrapper)`

Wraps or replaces the implementation of `app.logger` (**Plugin-specific**).

```typescript
setLogger(wrapper: (original: VextRuntimeLogger) => VextLoggerLike): void;
```

Receive the complete runtime logger and return a complete or partial new logger. Missing methods fall back to the original logger, including `trace`, `getLevel`, `setLevel` and `child`. Common uses: Forward framework logs to external systems (OTel Logs, Sentry, etc.) simultaneously.

```typescript
import { definePlugin } from "vextjs";
import type { VextLogger } from "vextjs";

export default definePlugin({
  name: "otel-logger-bridge",
  setup(app) {
    app.setLogger((original) => ({
      info(...args: unknown[]) {
        otelBridge.emit("info", extractMsg(args));
        (original.info as (...a: unknown[]) => void)(...args);
      },
      warn(...args: unknown[]) {
        otelBridge.emit("warn", extractMsg(args));
        (original.warn as (...a: unknown[]) => void)(...args);
      },
      error(...args: unknown[]) {
        otelBridge.emit("error", extractMsg(args));
        (original.error as (...a: unknown[]) => void)(...args);
      },
      debug(...args: unknown[]) {
        (original.debug as (...a: unknown[]) => void)(...args);
      },
      fatal(...args: unknown[]) {
        otelBridge.emit("fatal", extractMsg(args));
        (original.fatal as (...a: unknown[]) => void)(...args);
      },
      child: (bindings) => original.child(bindings),
    }));
  },
});
```

:::tip
The `@devcodex/opentelemetry` plug-in has this mode built-in. After turning on `logs.bridgeAppLogger: true` (default), `app.setLogger()` is automatically called without manual implementation.
:::

---

#### `app.setRateLimiter(limiter)`

Replaces global rate limiting implementation (**plugin-specific**).

```typescript
setRateLimiter(limiter: VextRateLimiter): void;
```

By default `flex-rate-limit` is used. Can be replaced with a Redis implementation to support distributed throttling.

```typescript
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "redis-rate-limit",
  async setup(app) {
    const redis = app.redis; // Assume that the redis plug-in has been loaded first

    app.setRateLimiter({
      async check(key) {
        const current = await redis.incr(`rl:${key}`);
        if (current === 1) {
          await redis.expire(`rl:${key}`, app.config.rateLimit.window);
        }
        const max = app.config.rateLimit.max;
        return {
          allowed: current <= max,
          remaining: Math.max(0, max - current),
          resetAt: Date.now() + app.config.rateLimit.window * 1000,
        };
      },
    });
  },
});
```

**VextRateLimiter interface**:

```typescript
interface VextRateLimiter {
  check(key: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }>;
}
```

---

#### `app.setRequestIdGenerator(generate)`

Override requestId generation algorithm (**Plugin-specific**).

```typescript
setRequestIdGenerator(generate: () => string): void;
```

By default `crypto.randomUUID()` is used. Common replacements: APM traceId, Snowflake ID, etc.

```typescript
import { definePlugin } from "vextjs";
import { nanoid } from "nanoid";

export default definePlugin({
  name: "nanoid-request-id",
  setup(app) {
    app.setRequestIdGenerator(() => nanoid(21));
  },
});
```

It can also be set statically through the configuration file:

```typescript
// src/config/default.ts
import { nanoid } from "nanoid";

export default {
  requestId: {
    generate: () => nanoid(),
  },
};
```

---

### Life cycle hook

#### `app.onReady(handler)`

Register a readiness hook to be executed after HTTP listening starts.

```typescript
onReady(handler: () => Promise<void> | void): void;
```

Suitable for: preheating cache, checking external dependencies, printing startup information, etc.

```typescript
app.onReady(async () => {
  await warmupCache();
  app.logger.info("Cache warm-up completed");
});

app.onReady(() => {
  app.logger.info(
    `The server is running at http://${app.config.host}:${app.config.port}`,
  );
});
```

**Execution Rules**:

- All `onReady` hooks are executed **sequentially** in the order in which they were registered (not in parallel)
- Automatically clear the hooks array and release the closure reference after execution is completed
- Errors thrown in the hook will be captured and logged and will not affect service operation.

---

#### `app.onClose(handler)`

Register graceful shutdown hooks and execute them in **LIFO** order when the SIGTERM/SIGINT signal is triggered.

```typescript
onClose(handler: () => Promise<void> | void): void;
```

Applicable to: closing application-owned connections, refreshing log buffers, canceling scheduled tasks, etc. Vext's built-in database plugin closes `app.db` automatically.

```typescript
//Cancel the scheduled task
app.onClose(() => {
  clearInterval(healthCheckTimer);
});

// Redis connection closed
app.onClose(async () => {
  await app.redis.quit();
});
```

**Execution Rules**:

- Executed in **LIFO** (last in, first out) order - hooks registered later are executed first
- Each hook has an independent try/catch, and the failure of a single hook does not affect other hooks
- Automatically clear the hooks array and release resource references after execution is completed

**LIFO sequential design reasons**:

Resources should be destroyed in the reverse order of creation. For example: connect to the database first, and then create a cache based on the database. When closing, you should first close the cache and then close the database.

```typescript
//Registration order
app.onClose(closeDatabase); // first registration
app.onClose(closeCache); // Second registration

// Execution order (LIFO)
// 1. closeCache() ← The ones registered later are executed first.
// 2. closeDatabase() ← Register first and then execute
```

---

## AppInternals

The set of internal methods returned by `createApp()` is only used by `bootstrap` and should not be called directly by user code.

```typescript
interface AppInternals {
  lockUse(): void;
  runReady(): Promise<void>;
  getGlobalMiddlewares(): VextMiddleware[];
  getRateLimiter(): VextRateLimiter | null;
  getRequestIdGenerator(): (() => string) | null;
  shutdown(
    serverHandle?: VextServerHandle,
    options?: { skipExit?: boolean },
  ): Promise<void>;
}
```

| Method                    | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `lockUse()`               | Lock `app.use()`, called after routing registration is completed |
| `runReady()`              | Execute all `onReady` hooks                                      |
| `getGlobalMiddlewares()`  | Get the global middleware list                                   |
| `getRateLimiter()`        | Get a custom rate limiter                                        |
| `getRequestIdGenerator()` | Get custom requestId generator                                   |
| `shutdown()`              | Trigger graceful shutdown process                                |

### shutdown process

```typescript
async shutdown(
  serverHandle?: VextServerHandle,
  options?: { skipExit?: boolean },
): Promise<void>;
```

1. **Anti-duplication**: The internal `_shuttingDown` flag prevents SIGTERM + SIGINT from being triggered repeatedly
2. **Step 1**: Establish one absolute `config.shutdown.timeout` deadline when shutdown starts
3. **Step 2**: Stop accepting new requests and wait for in-flight requests to complete
4. **Step 3**: Run `onClose` in LIFO order, then close the response cache, lifecycle hooks, and logger
5. **Step 4**: After the deadline, still invoke cleanup that has not started but do not wait indefinitely; finally exit the process (skip `process.exit()` with `_testMode` or `skipExit`)

---

## DEFAULT_CONFIG

The framework has built-in default configuration constants that can be used for reference or quick start:

```typescript
import { DEFAULT_CONFIG } from "vextjs";
```

See [Configuration API — DEFAULT_CONFIG](/api/config) for complete details.

---

## setupShutdown

Independent signal processing registration function, automatically called internally by `bootstrap`.

```typescript
import { setupShutdown } from "vextjs";

setupShutdown({
  internals,
  serverHandle,
  logger: app.logger,
  testMode: app.config._testMode,
});
```

Register `SIGTERM` and `SIGINT` signal handlers and trigger `internals.shutdown()` when the signal is received.

---

## Auxiliary factory function

### definePlugin

Recommended way to create a `VextPlugin`. See [plugin API](/api/plugin-api).

```typescript
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "my-plugin",
  async setup(app) {
    // ...
  },
});
```

### defineRoutes

Core function to create routing files. See [route-definition](/api/route-definition).

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/hello", async (_req, res) => {
    res.json({ message: "Hello!" });
  });
});
```

### defineMiddleware / defineMiddlewareFactory

Create helper functions for middleware. See [plugin API](/api/plugin-api#definemiddleware).

```typescript
import { defineMiddleware, defineMiddlewareFactory } from "vextjs"; // No configuration middleware
export default defineMiddleware(async (req, res, next) => {
  // ...
  await next();
});

// Middleware factory with configuration
export default defineMiddlewareFactory((options) => {
  return async (req, res, next) => {
    //Use options...
    await next();
  };
});
```

---

## Type import

```typescript
import type {
  VextApp,
  VextConfig,
  VextUserConfig,
  VextServices,
  VextLogger,
  VextRateLimiter,
  VextValidator,
} from "vextjs";

import type { AppInternals, BootstrapResult } from "vextjs";
```

---

## Complete usage example

### Plug-in development

```typescript
// src/plugins/database.ts
import { definePlugin } from "vextjs";
import { createPool } from "./db";

export default definePlugin({
  name: "database",
  async setup(app) {
    // 1. Create a database connection pool
    const pool = await createPool(app.config.database);

    // 2. Mount to app
    app.extend("db", pool);

    // 3. Register ready hook
    app.onReady(async () => {
      const result = await pool.query("SELECT 1");
      app.logger.info("Database connection verification successful");
    });

    // 4. Register the shutdown hook
    app.onClose(async () => {
      await pool.end();
      app.logger.info("Database connection pool has been closed");
    });
  },
});
```

### Service Development

```typescript
// src/services/user.ts
import type { VextApp } from "vextjs";

export default class UserService {
  private logger;

  constructor(private app: VextApp) {
    this.logger = app.logger.child({ service: "UserService" });
  }

  async findById(id: string) {
    this.logger.info({ userId: id }, "Query user");
    const user = await this.app.db.query("SELECT * FROM users WHERE id = ?", [
      ID,
    ]);

    if (!user) {
      this.app.throw(404, "user.not_found");
    }

    return user;
  }

  async create(data: { name: string; email: string }) {
    this.logger.info({ email: data.email }, "Create user");

    const existing = await this.app.db.query(
      "SELECT id FROM users WHERE email = ?",
      [data.email],
    );
    if (existing) {
      this.app.throw(409, "Email has been registered", 10001);
    }

    return this.app.db.query("INSERT INTO users (name, email) VALUES (?, ?)", [
      data.name,
      data.email,
    ]);
  }
}
```

### Routing development

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/list",
    {
      validate: {
        query: { page: "number:1-", limit: "number:1-100" },
      },
      docs: {
        summary: "User list",
      },
    },
    async (req, res) => {
      const { page, limit } = req.valid("query");
      const users = await app.services.user.findAll({ page, limit });
      res.json(users);
    },
  );

  app.get(
    "/:id",
    {
      validate: { param: { id: "string:1-" } },
      docs: { summary: "Get user details" },
    },
    async (req, res) => {
      const user = await app.services.user.findById(req.valid("param").id);
      res.json(user);
    },
  );

  app.post(
    "/",
    {
      validate: {
        body: { name: "string:1-50", email: "email" },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "Create user" },
    },
    async (req, res) => {
      const user = await app.services.user.create(req.valid("body"));
      res.json(user, 201);
    },
  );
});
```
