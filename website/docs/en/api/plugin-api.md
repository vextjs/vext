# Plugin API

This page details the plug-in system API of VextJS, including plug-in definitions, middleware definition helper functions and related types.

## Overview

Plugins are the **only extension entry** to the VextJS framework. Through plug-ins you can:

- Mount custom properties to `app` (`app.extend()`)
- Register global middleware (`app.use()`)
- Register graceful close hook (`app.onClose()`)
- Register readiness hook (`app.onReady()`)
- Register runtime lifecycle hook (`app.hooks.on()`)
- Replace built-in implementation (`app.setValidator()` / `app.setThrow()` / `app.setRateLimiter()`)

Plug-in files are placed in the `src/plugins/` directory, and `plugin-loader` automatically scans and loads them at startup.

---

## definePlugin

`definePlugin` is the recommended way to create plugins and provides type inference and IDE auto-completion support.

### Function signature

```typescript
function definePlugin(plugin: VextPlugin): VextPlugin;
```

Receives a `VextPlugin` object and returns it unchanged (for type annotation only).

### Basic usage

```typescript
// src/plugins/redis.ts
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

---

## VextPlugin

Plug-in interface definition.

```typescript
interface VextPlugin {
  readonly name: string;
  readonly dependencies?: string[];
  setup(app: VextApp): Promise<void> | void;
  onReady?(app: VextApp): Promise<void> | void;
  onClose?(app: VextApp): Promise<void> | void;
}
```

### `name`

Plug-in name, globally unique identifier.

```typescript
readonly name: string;
```

Used for log output, error messages and dependency declarations. Plug-ins with the same name loaded later will overwrite the ones loaded first (can be used to replace the built-in implementation).

```typescript
export default definePlugin({
  name: "my-plugin", // unique identifier
  setup(app) {
    /* ... */
  },
});
```

### `dependencies`

List of other plugin names that it depends on (optional).

```typescript
readonly dependencies?: string[];
```

`plugin-loader` performs **topological sort** based on this field to ensure that dependent plugins execute `setup()` before the current plugin. Fail Fast reports an error when there are circular dependencies.

```typescript
export default definePlugin({
  name: "user-cache",
  dependencies: ["redis", "database"], // Make sure redis and database are initialized first
  async setup(app) {
    // At this time app.redis (redis plug-in mounting) and app.db (database plug-in mounting) are ready
    const userCache = new UserCacheService(app.redis, app.db);
    app.extend("userCache", userCache);
  },
});
```

:::warning
Circular dependencies can cause startup failure:

```
[vextjs] Circular dependency detected: redis → database → redis
```

:::

### `setup(app, context)`

The plug-in initialization function is called by `plugin-loader` in step ② of `bootstrap`.

```typescript
setup(
  app: VextPluginContext,
  context: VextPluginSetupContext,
): Promise<void> | void;
```

**Parameters**:

| Parameters | Type                     | Description                                                                                   |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `app`      | `VextPluginContext`      | Revocable setup facade; `app.use()` is available and `app.services` has not been injected yet |
| `context`  | `VextPluginSetupContext` | Setup lifecycle context containing `signal: AbortSignal` for cancellable I/O                  |

**Key Notes**:

- Can be a synchronous or asynchronous function
- `plugin-loader` sets a **hard timeout** (default 30 seconds) for each `setup()`; timeout aborts `context.signal`, rolls back setup-time framework mutations, and revokes the setup facade before throwing
- A late asynchronous continuation cannot commit framework state; plugins must still cancel and close external resources they created
- Execution order is determined by `dependencies` topological sorting
- `app.services` has not been injected when `setup()` is executed (`service-loader` is executed after `plugin-loader`), and the service cannot be accessed
- If the plugin object declares `onReady(app)` / `onClose(app)`, `plugin-loader` will automatically register these two life cycle hooks after `setup()` is successful.
- `app.hooks.on()` can be used to register runtime hooks such as request/validation/response/fetch/service/plugin/OpenAPI. For details, see [Application instance hooks](/api/app#apphooks)

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    // ✅ Can access app.config
    const pool = await createPool(app.config.database);

    // ✅ Custom properties can be mounted
    app.extend("db", pool);

    // ✅ Global middleware can be registered
    app.use(myMiddleware);

    // ✅ Life cycle hooks can be registered
    app.onReady(async () => {
      await pool.query("SELECT 1");
      app.logger.info("Database connection verification successful");
    });

    app.onClose(async () => {
      await pool.end();
      app.logger.info("Database connection pool has been closed");
    });

    // ❌ Cannot access app.services (not yet injected at this time)
    // app.services.user → undefined
  },
});
```

### `onReady(app)` / `onClose(app)`

The plug-in life cycle hook is an optional field, which is equivalent to manually calling `app.onReady()` / `app.onClose()` in `setup()`, but the semantics are clearer.

```typescript
export default definePlugin({
  name: "warmup",
  setup(app) {
    app.extend("warmupState", new Map());
  },
  async onReady(app) {
    app.logger.info("warmup plugin is ready");
  },
  async onClose(app) {
    app.logger.info("warmup plugin closed");
  },
});
```

- `onReady(app)`: Executed after HTTP starts listening, suitable for warming up cache and checking external dependencies.
- `onClose(app)`: executed during graceful shutdown; multiple shutdown hooks are executed in LIFO order.

---

## Plug-in loading mechanism

### Automatic scanning

`plugin-loader` automatically scans all `.ts` / `.js` files in the `src/plugins/` directory, and the `default export` of each file should be a `VextPlugin` object.

```
src/plugins/
  ├── database.ts → definePlugin({ name: 'database', ... })
  ├── redis.ts → definePlugin({ name: 'redis', ... })
  └── auth.ts → definePlugin({ name: 'auth', ... })
```

### Topological sorting

Automatically calculate the execution order based on the `dependencies` field:

```typescript
// database.ts — no dependencies, executed first
definePlugin({ name: 'database', setup(app) { ... } })

// redis.ts — no dependencies, parallel to database
definePlugin({ name: 'redis', setup(app) { ... } })

// auth.ts — depends on database and redis
definePlugin({
  name: 'auth',
  dependencies: ['database', 'redis'],
  setup(app) { ... },
})
```

Execution order: `database` → `redis` → `auth`

### Timeout protection

Each `setup()` has a 30 second timeout limit (default). If the plugin initialization takes longer than this limit (such as a database connection timeout), `plugin-loader` will throw an error and abort startup.

### Built-in plug-ins

VextJS has a built-in `monsqlize` plug-in (database abstraction layer), which is created through `createMonSQLizePlugin()`:

```typescript
import { createMonSQLizePlugin } from "vextjs";
```

---

## defineMiddleware

Helper function for creating configuration-less middleware. Ensure middleware type safety through Symbol tags.

### Function signature

```typescript
function defineMiddleware(middleware: VextMiddleware): TaggedMiddleware;
```

### Basic usage

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, _res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    req.app.throw(401, "Authentication token not provided");
  }

  try {
    const decoded = await verifyJWT(token);
    req.user = decoded;
  } catch {
    req.app.throw(401, "The authentication token is invalid or expired");
  }

  await next();
});
```

### VextMiddleware type

```typescript
type VextMiddleware = (
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

Three parameters:

| Parameters | Type                  | Description                        |
| ---------- | --------------------- | ---------------------------------- |
| `req`      | `VextRequest`         | Request object                     |
| `res`      | `VextResponse`        | response object                    |
| `next`     | `() => Promise<void>` | Call the next middleware / handler |

### Onion model

The middleware implements the onion model through `await next()`, which can be processed before and after the handler is executed:

```typescript
export default defineMiddleware(async (req, res, next) => {
  //── before handler (request entry stage)──
  const start = Date.now();
  console.log(`→ ${req.method} ${req.path}`);

  await next(); // Execute handler and subsequent middleware

  //── after handler (response return stage)──
  const duration = Date.now() - start;
  console.log(`← ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
});
```

Execution process:

```
Request → middleware A(before) → middleware B(before) → handler → middleware B(after) → middleware A(after) → response
```

### Short circuit response

Not calling `next()` can short-circuit the request and the handler will not be executed:

```typescript
export default defineMiddleware(async (req, res, next) => {
  // IP blacklist check
  if (blockedIPs.has(req.ip)) {
    res.status(403).json({ message: "Access Denied" });
    return; //Do not call next()
  }

  await next();
});
```

### Error handling

Errors thrown in middleware will be uniformly captured by the framework `error-handler`:

```typescript
export default defineMiddleware(async (req, _res, next) => {
  if (!req.headers.authorization) {
    // Use app.throw to throw standard HTTP errors
    req.app.throw(401, "Authentication token not provided");
    // Equivalent to throw new HttpError(401, 'No authentication token provided')
  }

  await next();
});
```

If the middleware encounters an "HTTP error that I want to actively return to the caller", it is recommended to use `req.app.throw(...)`. If it is an unexpected runtime failure, you can also directly `throw new Error("...")`, and the framework will convert it to 500; if you need to return field-level verification details, you should throw `VextValidationError`.

---

## defineMiddlewareFactory

Create a **middleware factory with configuration**. Receive configuration parameters and return the middleware function.

### Function signature

```typescript
function defineMiddlewareFactory<T = unknown>(
  factory: (options: T) => VextMiddleware,
): TaggedMiddlewareFactory;
```

### Basic usage

```typescript
// src/middlewares/role.ts
import { defineMiddlewareFactory } from "vextjs";

interface RoleOptions {
  required: string | string[];
}

export default defineMiddlewareFactory<RoleOptions>((options) => {
  const requiredRoles = Array.isArray(options.required)
    ? options.required
    : [options.required];

  return async (req, _res, next) => {
    if (!req.user) {
      req.app.throw(401, "Not authenticated");
    }

    if (!requiredRoles.includes(req.user.role)) {
      req.app.throw(403, "Insufficient permissions", {
        required: requiredRoles.join(", "),
        current: req.user.role,
      });
    }

    await next();
  };
});
```

### Configuration transfer

The configuration of the middleware factory is passed through the `config.middlewares` whitelist:

```typescript
// src/config/default.ts
export default {
  middlewares: [
    { name: "auth" }, // No configuration middleware
    { name: "role", options: { required: "admin" } }, // Factory middleware + configuration
    { name: "client-cache", options: { maxAge: 300 } }, // Factory middleware + configuration
  ],
};
```

The default configuration can be overridden when referenced in routing:

```typescript
app.get(
  "/admin/users",
  {
    middlewares: [
      "auth",
      { name: "role", options: { required: ["admin", "superadmin"] } },
    ],
  },
  handler,
);
```

### More examples

**Client cache header middleware**:

```typescript
// src/middlewares/client-cache.ts
import { defineMiddlewareFactory } from "vextjs";

interface ClientCacheOptions {
  maxAge: number; // Cache-Control max-age, in seconds
}

export default defineMiddlewareFactory<ClientCacheOptions>((options) => {
  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", `public, max-age=${options.maxAge}`);
  };
});
```

:::tip
Route-level response caching does not require custom middleware. Please use the `cache` field of route options directly; its TTL configuration unit is milliseconds. `app.cache` is the response cache control surface and is only used by `invalidate()`, `delete()`, `clear()` and `stats()`.
:::

**Speed limiting middleware**:

```typescript
// src/middlewares/throttle.ts
import { defineMiddlewareFactory } from "vextjs";

interface ThrottleOptions {
  max: number;
  window: number; // seconds
}

export default defineMiddlewareFactory<ThrottleOptions>((options) => {
  const store = new Map<string, { count: number; resetAt: number }>();

  return async (req, _res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = store.get(key);

    if (entry && now < entry.resetAt) {
      if (entry.count >= options.max) {
        req.app.throw(429, "The request is too frequent");
      }
      entry.count++;
    } else {
      store.set(key, {
        count: 1,
        resetAt: now + options.window * 1000,
      });
    }

    await next();
  };
});
```

---

## isMiddleware / isMiddlewareFactory

Type checking helper function, used to determine whether a value is a middleware created by `defineMiddleware` / `defineMiddlewareFactory`.

### Function signature

```typescript
function isMiddleware(value: unknown): value is TaggedMiddleware;
function isMiddlewareFactory(value: unknown): value is TaggedMiddlewareFactory;
```

### Usage

```typescript
import { isMiddleware, isMiddlewareFactory } from "vextjs";

const middlewareModule = await import("./middlewares/auth.ts");
const exported = middlewareModule.default;

if (isMiddleware(exported)) {
  // No configuration middleware, use it directly
  adapter.registerMiddleware(exported);
} else if (isMiddlewareFactory(exported)) {
  //Factory middleware, you need to pass in options and get the middleware instance after calling
  const middleware = exported(options);
  adapter.registerMiddleware(middleware);
}
```

:::tip
These two functions are usually used by the `middleware-loader` inside the framework, and user code rarely needs to call them directly.
:::

---

## VextErrorMiddleware

Error middleware type (used internally by the framework).

```typescript
type VextErrorMiddleware = (
  error: Error,
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

Different from ordinary middleware, error middleware receives one more `error` parameter. The framework's built-in `error-handler` uses this type. Users usually do not need to create error middleware directly, `error-handler` already provides complete error handling logic.

---

## TaggedMiddleware / TaggedMiddlewareFactory

The middleware type marked by Symbol is used by `middleware-loader` to distinguish between ordinary functions and framework middleware.

```typescript
interface TaggedMiddleware extends VextMiddleware {
  [MIDDLEWARE_SYMBOL]: true;
}

interface TaggedMiddlewareFactory {
  (options: unknown): VextMiddleware;
  [MIDDLEWARE_FACTORY_SYMBOL]: true;
}
```

### Symbol constant

```typescript
import { MIDDLEWARE_SYMBOL, MIDDLEWARE_FACTORY_SYMBOL } from "vextjs";
```

These Symbols are automatically attached by `defineMiddleware` / `defineMiddlewareFactory` and do not need to be set manually by user code.

---

## Middleware file organization

### Directory structure

```
src/middlewares/
  ├── auth.ts → defineMiddleware(...) // Authentication middleware
  ├── role.ts → defineMiddlewareFactory(...) // Role verification (with configuration)
  ├── client-cache.ts → defineMiddlewareFactory(...) // Client cache header middleware (with configuration)
  └── request-logger.ts → defineMiddleware(...) // Request log
```

### Middleware registration process

1. `middleware-loader` scans the `src/middlewares/` directory
2. Match based on file name and `config.middlewares` whitelist
3. Use `isMiddleware()` / `isMiddlewareFactory()` to distinguish types
4. Factory middleware calls `factory(options)` to obtain the middleware instance
5. Register to the middleware definition mapping (`Map<string, VextMiddleware>`)
6. Reference by name when registering the route

### Configure whitelist

Only middleware declared in `config.middlewares` can be referenced in routes `options.middlewares`:

```typescript
// src/config/default.ts
export default {
  middlewares: [
    { name: "auth" },
    { name: "role", options: { required: "user" } },
  ],
};
```

Middleware not declared in the whitelist will throw a startup error when referenced in a route.

---

## Built-in middleware

VextJS provides the following built-in middleware, which is automatically registered by `bootstrap` and does not require manual configuration:

| Middleware       | Function                       | Description                        |
| ---------------- | ------------------------------ | ---------------------------------- |
| Request ID       | `createRequestIdMiddleware()`  | Request ID generation/transmission |
| CORS             | `createCorsMiddleware()`       | Cross-domain resource sharing      |
| Body Parser      | `createBodyParserMiddleware()` | Request body parsing               |
| Rate Limit       | `createRateLimitMiddleware()`  | Rate Limit                         |
| Response Wrapper | `responseWrapper`              | Export packaging                   |
| Access Log       | `createAccessLogMiddleware()`  | Access Log                         |
| Error Handler    | `createErrorHandler()`         | Error Handling                     |

These middlewares can configure their behavior through `config` (see [Configuration Items](/api/config)), but cannot be registered repeatedly through `app.use()`.

### Execution order

Execution order of built-in middleware (from outside to inside):

```
Request entry
  → requestId ← Generate/transmit requestId
  → cors ← CORS preflight
  → bodyParser ← Parse the request body
  → rateLimit ← Rate limit check
  → responseWrapper ← Open export packaging
  → accessLog ← Record request start time
  → [Global middleware] ← The plug-in is registered through app.use()
  → [Routing middleware] ← referenced by routing options.middlewares
  → [validate] ← Parameter verification
  → handler ← routing processing function
  ← accessLog ← Record time consumption and status code
  ← responseWrapper ← Wrap response
  ← errorHandler ← Capture unhandled errors
response return
```

---

## Best practices for plug-in development

### 1. Naming convention

- plugin `name` uses kebab-case: `'my-plugin'`
- The file name is consistent with the plug-in name: `src/plugins/my-plugin.ts`

### 2. Type declaration

Use `declare module` to provide type hints for extended properties:

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextApp {
    redis: import("ioredis").Redis;
    db: import("./db").DatabasePool;
  }

  interface VextRequest {
    user?: {
      id: string;
      role: string;
    };
  }

  interface VextConfig {
    redis?: {
      host: string;
      port: number;
    };
    database?: {
      connectionString: string;
    };
  }
}
```

### 3. Resource cleanup

Always clean up resources created by plugins in `onClose`:

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    const pool = await createPool(app.config.database);
    app.extend("db", pool);

    // ✅ Be sure to register to close the hook
    app.onClose(async () => {
      await pool.end();
      app.logger.info("Database connection pool has been closed");
    });
  },
});
```

### 4. Error handling

Errors in `setup()` can cause startup to fail. Ensure that critical resources are initialized with error handling:

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    try {
      const pool = await createPool(app.config.database);
      app.extend("db", pool);
    } catch (err) {
      app.logger.fatal({ error: err }, "Database connection failed");
      throw err; // Rethrow to prevent startup
    }
  },
});
```

### 5. Optional dependencies

If a plugin depends on an extended property of another plugin, but the dependency is optional:

```typescript
export default definePlugin({
  name: "user-cache",
  // Do not declare dependencies, check manually
  setup(app) {
    if (app.redis) {
      // Redis is available, enable caching
      app.extend("userCache", new CachedUserService(app.redis));
    } else {
      // Redis is unavailable, downgrade to no-cache mode
      app.logger.warn("Redis is not configured and user caching is disabled");
      app.extend("userCache", new UserService());
    }
  },
});
```

---

## Type import

```typescript
import {
  definePlugin,
  defineMiddleware,
  defineMiddlewareFactory,
  isMiddleware,
  isMiddlewareFactory,
  MIDDLEWARE_SYMBOL,
  MIDDLEWARE_FACTORY_SYMBOL,
} from "vextjs";

import type {
  VextPlugin,
  VextMiddleware,
  VextErrorMiddleware,
  VextHandler,
  VextDefinedMiddleware,
  VextMiddlewareFactory,
  VextMiddlewareExport,
  TaggedMiddleware,
  TaggedMiddlewareFactory,
} from "vextjs";
```
