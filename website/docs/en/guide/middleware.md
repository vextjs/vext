# middleware

VextJS's middleware uses the Onion Model to support pre-request processing and post-response processing. The framework provides two definition methods: `defineMiddleware` and `defineMiddlewareFactory`, which are automatically scanned and loaded through the agreed directory.

## Onion model

Middleware calls the next middleware via `await next()`. After `next()` returns, post-logic can be executed to form an onion-shaped execution process:

```
Request → [Middleware A-before] → [Middleware B-before] → [Handler] → [Middleware B-after] → [Middleware A-after] → Response
```

```typescript
import type { VextMiddleware } from "vextjs";

const timing: VextMiddleware = async (req, res, next) => {
  //── Pre-logic (executed when the request enters)──
  const start = Date.now();

  await next(); // Execute the next middleware / final handler

  //── Post logic (executed when the response returns)──
  const ms = Date.now() - start;
  res.setHeader("X-Response-Time", `${ms}ms`);
  req.app.logger.info(
    `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`,
  );
};
```

## Middleware signature

```typescript
type VextMiddleware = (
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

| Parameters | Description                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------- |
| `req`      | Framework-unified request object (decoupled from Adapter)                                     |
| `res`      | Framework-unified response object                                                             |
| `next`     | Call the next middleware; must `await`, otherwise the post logic cannot be executed correctly |

## Define middleware

Middleware files are placed in the `src/middlewares/` directory and automatically scanned by `middleware-loader`. The file name is the middleware name.

### Common middleware — `defineMiddleware`

For middleware that does not require configuration parameters, use the `defineMiddleware` tag:

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "");

  if (!token) {
    req.app.throw(401, "Authorization token is required");
  }

  //Verify token (example)
  try {
    const payload = verifyJWT(token);
    (req as any).user = payload;
  } catch {
    req.app.throw(401, "Invalid or expired token");
  }

  await next();
});

function verifyJWT(token: string) {
  // JWT validation logic...
  return { id: "1", role: "user" };
}
```

### Factory middleware — `defineMiddlewareFactory`

Middleware that requires runtime configuration parameters is marked with `defineMiddlewareFactory`. The factory function receives the `options` parameter and returns a `VextMiddleware`:

```typescript
// src/middlewares/check-role.ts
import { defineMiddlewareFactory } from "vextjs";

interface CheckRoleOptions {
  roles: string[];
}

export default defineMiddlewareFactory<CheckRoleOptions>((options) => {
  const allowedRoles = options?.roles ?? [];

  return async (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      req.app.throw(401, "Authentication required");
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      req.app.throw(403, "Insufficient permissions");
    }

    await next();
  };
});
```

:::tip Why do I need to explicitly mark it?
`defineMiddleware` and `defineMiddlewareFactory` make middleware types explicit through Symbol tags. `middleware-loader` detects tags via `isMiddleware()` / `isMiddlewareFactory()`, distinguishing normal middleware from factory middleware with zero ambiguity.

Without marking, the framework cannot distinguish "whether a function is the middleware itself or a factory function that returns the middleware."
:::

## Registration and use

The use of middleware is divided into two steps: **Configuration whitelist** → **Route reference**.

### Step 1: Declare the whitelist in the configuration

All route-level middleware must first be declared in the `middlewares` array of `config/default.ts`:

```typescript
// src/config/default.ts
export default {
  port: 3000,
  middlewares: [
    // Ordinary middleware - string declaration
    "auth",

    // Factory middleware — object declaration (with default parameters)
    { name: "check-role", options: { roles: ["user"] } },

    // Factory middleware - no default parameters
    "rate-limit-api",
  ],
};
```

Benefits of the whitelist mechanism:

- **Security**: Prevent routes from arbitrarily referencing unaudited middleware
- **Explicit Dependencies**: See at a glance which middleware is used by the project
- **Parameter default value**: Centralized management of default parameters of factory middleware

### Step 2: Reference in routing

Specify middleware for routes via `options.middlewares`:

For production authentication, prefer the built-in `auth()` middleware and declare the final `RouteOptions.auth` inline or in a statically projectable same-file `const`. Route-options helper calls are rejected by build indexing and Doctor. This section only demonstrates the lower-level middleware reference mechanism.

:::tip Authentication and authorization
Use `auth()` to resolve identity into `req.auth`, then use [`RouteOptions.auth`](../api/route-definition#auth) to protect a route and keep its OpenAPI security declaration aligned. Keep application-specific permission resources in the route file's final options constants. For a complete `permission-core` integration, see the [permission-core Auth example](../examples/permission-core-auth).
:::

```typescript
// src/routes/admin.ts
import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  // String reference - use default parameters from configuration
  app.get(
    "/profile",
    {
      middlewares: ["audit-log"],
    },
    async (req, res) => {
      res.json({ ok: true });
    },
  );

  // Object reference — override default parameters
  app.delete(
    "/users/:id",
    {
      middlewares: [
        "auth",
        { name: "check-role", options: { roles: ["superadmin"] } },
      ],
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

### Parameter priority

When the factory middleware specifies parameters in both configuration and routing, the routing-level parameters override the configuration-level default parameters:

```
Configure default parameters (config/default.ts) → Route coverage parameters (options.middlewares)
{ roles: ['user'] } → { roles: ['superadmin'] }
```

## Middleware execution sequence

### Global middleware

VextJS has multiple built-in global middlewares that are automatically executed before all routes. Execution order:

```
Request entry
  ↓
1. requestId — generate/transmit the unique identifier of the request
2. cors — CORS cross-domain processing
3. bodyParser — request body parsing (JSON/URL-encoded)
4. rateLimit — global rate limit (only when config.rateLimit.enabled === true)
5. responseWrapper — Turn on response packaging ({ code, data, requestId })
6. accessLog — access logging
  ↓
7. [Route-level middleware] — According to options.middlewares declaration order
  ↓
8. [validateMiddleware] — Parameter verification (if validate is configured)
  ↓
9. [handler] — route processing function
  ↓
errorHandler — global error handling (catch exceptions thrown at any stage)
```

Built-in global middleware is controlled through configuration. Rate limiting is
opt-in: when `rateLimit` is omitted, or when `rateLimit.enabled` is not exactly
`true`, Vext does not install the middleware and therefore emits no rate-limit
headers or HTTP 429 responses.

```typescript
// src/config/default.ts
export default {
  rateLimit: {
    enabled: true,
    max: 100,
    window: 60,
  },
};
```

After global rate limiting is enabled, a route can set
`override: { rateLimit: false }` to skip it, or provide a route-level object to
override `max`, `window`, or `keyBy`. Calling `app.setRateLimiter()` replaces
the limiter implementation but does not opt the application into rate
limiting. The exported `createRateLimitMiddleware()` factory also remains
available for explicit manual composition.

### Routing-level middleware

Route-level middleware is executed in the order of declaration in the `options.middlewares` array:

```typescript
app.post(
  "/sensitive-action",
  {
    middlewares: ["auth", "check-role", "audit-log"],
    // ↑ 1st ↑ 2nd ↑ 3rd
  },
  handler,
);
```

## Global middleware (plug-in registration)

Plug-ins can register global middleware through `app.use()`, which will take effect on all routes. These middlewares are executed after the built-in global middleware and before the route-level middleware:

```typescript
// src/plugins/request-timing.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "request-timing",
  setup(app) {
    app.use(async (req, res, next) => {
      const startedAt = Date.now();
      await next();
      res.setHeader("Server-Timing", `app;dur=${Date.now() - startedAt}`);
    });
  },
});
```

For browser security response headers, prefer the built-in `config.securityHeaders` path. It covers normal responses, errors, 404, testing helpers, and dev soft reload consistently:

```typescript
export default {
  securityHeaders: {
    enabled: true,
    preset: "basic",
  },
};
```

:::warning note
`app.use()` can only be called in a plugin's `setup()`. Calling after route registration is complete will throw an error.
:::

## Common middleware examples

### Authentication middleware

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const header = req.headers["authorization"];

  if (!header?.startsWith("Bearer ")) {
    req.app.throw(401, "Missing or invalid Authorization header");
  }

  const token = header.slice(7);

  try {
    //Verify JWT token
    const payload = await verifyToken(token);
    (req as any).user = payload;
  } catch (err) {
    req.app.throw(401, "Token expired or invalid");
  }

  await next();
});

async function verifyToken(token: string) {
  // In actual implementation, libraries such as jsonwebtoken or jose are used
  return { id: "1", email: "user@example.com", role: "user" };
}
```

### Role checking middleware

```typescript
// src/middlewares/check-role.ts
import { defineMiddlewareFactory } from "vextjs";

interface RoleOptions {
  roles: string[];
}

export default defineMiddlewareFactory<RoleOptions>((options) => {
  return async (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      req.app.throw(401, "Not authenticated");
    }

    const allowed = options?.roles ?? [];
    if (allowed.length > 0 && !allowed.includes(user.role)) {
      req.app.logger.warn(
        { userId: user.id, role: user.role, required: allowed },
        "Access denied: insufficient role",
      );
      req.app.throw(403, "Access denied");
    }

    await next();
  };
});
```

### Request time-consuming record

```typescript
// src/middlewares/timing.ts
import { defineMiddleware } from "vextjs";
export default defineMiddleware(async (req, res, next) => {
  const start = performance.now();

  await next();

  const duration = (performance.now() - start).toFixed(2);
  res.setHeader("X-Response-Time", `${duration}ms`);

  req.app.logger.info(
    {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
    },
    "Request completed",
  );
});
```

### API Key Verification

```typescript
// src/middlewares/api-key.ts
import { defineMiddlewareFactory } from "vextjs";

interface ApiKeyOptions {
  header?: string;
  keys?: string[];
}

export default defineMiddlewareFactory<ApiKeyOptions>((options) => {
  const headerName = options?.header ?? "x-api-key";
  const validKeys = new Set(options?.keys ?? []);

  return async (req, res, next) => {
    if (validKeys.size === 0) {
      // keys are not configured, skip verification
      await next();
      return;
    }

    const apiKey = req.headers[headerName];
    if (!apiKey || !validKeys.has(apiKey)) {
      req.app.throw(401, "Invalid API key");
    }

    await next();
  };
});
```

### Cache Control

```typescript
// src/middlewares/cache-control.ts
import { defineMiddlewareFactory } from "vextjs";

interface CacheOptions {
  maxAge?: number; // seconds
  directive?: string; // 'public' | 'private' | 'no-cache' | 'no-store'
}

export default defineMiddlewareFactory<CacheOptions>((options) => {
  const maxAge = options?.maxAge ?? 0;
  const directive = options?.directive ?? "public";
  const value = maxAge > 0 ? `${directive}, max-age=${maxAge}` : "no-store";

  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", value);
  };
});
```

## Error handling middleware

Global error handling is handled by the framework’s built-in `error-handler`, which catches all exceptions thrown in the middleware chain:

- `HttpError` (thrown by `app.throw()`) → converted to structured JSON response
- `VextValidationError` (parameter validation failed) → 422 response + errors array
- Other exceptions → 500 Internal Server Error

### When to use which error throwing method?

- When explicit HTTP semantics are required, use `app.throw(...)` in preference. For example, `404`, `401`, `409`, or scenarios that require business error codes.
- When field-level validation details need to be returned, `VextValidationError` is thrown.
- When a real unexpected exception occurs, you can directly `throw new Error("...")`, and the framework will automatically catch it and convert it to `500`.

```typescript
// Structured HTTP errors
req.app.throw(404, "user.not_found");

// When the fourth parameter is an object/array, it is output as details, which is suitable for revealing third-party business details.
req.app.throw(
  502,
  "payment.failed",
  { orderId },
  {
    provider: "stripe",
    providerCode: "card_declined",
  },
);

//Field-level validation errors
throw new VextValidationError([
  { field: "email", message: "The email format is incorrect" },
]);

// Unexpected runtime error
throw new Error("Database connection lost");
```

Note that `throw new Error("...")` does not mean that the client will definitely see the complete error details. Its purpose is to let the framework catch "unknown exceptions":

- By default, clients receive a safe `500 Internal Server Error`
- JSON 500 responses come with `stack` when `response.hideInternalErrors = false`
- When the browser accesses the error page in dev mode, you may also see the built-in HTML error overlay

Therefore, if your goal is to "return an unambiguous 4xx/5xx HTTP result to the caller", you should use `app.throw(...)` instead of relying on the normal `Error`

If you only want to log the request "after the route parameter verification passes", you can use `app.hooks.on("validation:success", ...)`. This hook is triggered after all `validate` passes, and requests that fail the verification will not enter it:

```typescript
export default definePlugin({
  name: "validated-access-log",
  setup(app) {
    app.hooks.on("validation:success", ({ req, route }) => {
      app.logger.info(
        { requestId: req.requestId, route: route.path },
        "validated request",
      );
    });
  },
});
```

You don't need to manually write error handling middleware. If you need to customize error handling logic (such as reporting to Sentry), it is recommended to use `app.use()` to register a try-catch middleware in the plug-in:

```typescript
// src/plugins/sentry.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "sentry",
  setup(app) {
    app.use(async (req, res, next) => {
      try {
        await next();
      } catch (err) {
        //Report errors to Sentry
        // Sentry.captureException(err);
        app.logger.error({ err }, "Captured by Sentry plugin");
        // Rethrow and let the framework's error-handler handle the response
        throw err;
      }
    });
  },
});
```

## `req.app` in middleware

Route-level middleware does not have the closure `app` of `defineRoutes`, so the framework capabilities are accessed through `req.app`:

```typescript
export default defineMiddleware(async (req, res, next) => {
  //Access various framework capabilities through req.app
  req.app.logger.info("Middleware executing"); // Log
  req.app.throw(403, "Forbidden"); // throw error
  const config = req.app.config; // Read configuration
  const userSvc = req.app.services.user; // Access services

  await next();
});
```

## Environment-level middleware configuration override

The default parameters of the middleware can be overridden in the environment configuration file:

```typescript
// src/config/default.ts
export default {
  middlewares: ["auth", { name: "check-role", options: { roles: ["user"] } }],
};
```

```typescript
// src/config/development.ts — Turn off some middleware in the development environment
export default {
  middlewares: [
    { name: "check-role", options: { roles: [] } }, // The development environment does not check roles
  ],
};
```

The configured `middlewares` array uses a smart patch strategy: matching and merging by `name`, the entire array is not simply replaced.

## Built-in middleware

VextJS has the following built-in global middleware, which controls behavior through configuration items:

| Middleware          | Configuration items | Description                                                   |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| **requestId**       | `config.requestId`  | Generate/transparently transmit request unique identifier     |
| **cors**            | `config.cors`       | CORS cross-domain processing                                  |
| **bodyParser**      | `config.bodyParser` | Request body parsing (JSON/URL-encoded)                       |
| **rateLimit**       | `config.rateLimit`  | Opt-in global rate limit; installed only with `enabled: true` |
| **accessLog**       | `config.accessLog`  | Access log (method/path/status/duration)                      |
| **responseWrapper** | `config.response`   | Response export wrapper `{ code, data, requestId }`           |
| **errorHandler**    | —                   | Global error handling (not configurable, always enabled)      |

See the [Configuration](/guide/configuration) chapter for details on various configuration options.

## TypeScript type extensions

If the middleware mounts custom attributes on `req` (such as `req.user`), it is recommended to extend the type through `declare module`:

```typescript
// src/types/extensions.d.ts
declare module "vextjs" {
  interface VextRequest {
    user?: {
      id: string;
      email: string;
      role: string;
    };
  }
}
```

After the extension, accessing `req.user` in all routes and middleware will get type hints, without the need for `as any` assertion.

## Best Practices

### 1. Keep middleware with a single responsibility

Each middleware only does one thing. Authentication and authorization should be separated into two middlewares:

```typescript
// ✅ Correct — Single responsibility
middlewares: ["auth", "check-role"];

// ❌ Avoid — One middleware does too much
middlewares: ["auth-and-role-check"];
```

### 2. Always `await next()`

If the middleware needs to perform post-logic or allow the request to continue passing, it must `await next()`:

```typescript
// ✅ Correct
export default defineMiddleware(async (req, res, next) => {
  console.log("before");
  await next(); // Wait for subsequent middleware and handler to complete
  console.log("after");
});

// ❌ Error - forget await, the post logic will be executed before the handler completes
export default defineMiddleware(async (req, res, next) => {
  console.log("before");
  next(); // No await!
  console.log("after — this will be executed before the handler");
});
```

### 3. Short circuit response

Some middleware may need to respond directly without calling `next()` (such as authentication failure). In this case, just return directly without calling `next()`:

```typescript
export default defineMiddleware(async (req, res, next) => {
  if (!isAllowed(req)) {
    // Throw an error directly without calling next() - the request terminates here
    req.app.throw(403, "Access denied");
  }

  await next();
});
```

Since the return type of `app.throw()` is `never`, it will automatically terminate the execution flow.

### 4. Manage in configuration instead of hard coding

Avoid hardcoding configuration values inside middleware. Use factory mode to receive parameters and manage them uniformly in the configuration file:

```typescript
// ✅ Correct — parameters are managed by configuration
export default defineMiddlewareFactory<{ maxAge: number }>((options) => {
  const maxAge = options?.maxAge ?? 3600;
  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
  };
});

// ❌ Avoid — hard coding
export default defineMiddleware(async (req, res, next) => {
  await next();
  res.setHeader("Cache-Control", "public, max-age=3600"); // Cannot be changed according to the environment
});
```

## Next step- Learn [plugins](/guide/plugins) how to register global middleware through `app.use()`

- Understand the automatic generation of [Parameter Validation](/guide/validation) middleware
- See the complete options for built-in middleware in [Configuration](/guide/configuration)
- Explore [Testing](/guide/testing) how to test middleware logic
