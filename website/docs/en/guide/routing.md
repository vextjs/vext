# routing

VextJS uses **conventional file routing** + **three-stage routing definition** to automatically map file paths to URL prefixes, and declare specific routes inside the file through `defineRoutes()`.

## Basic concepts

### File routing mapping

Each file in the `src/routes/` directory is automatically mapped to a URL prefix:

| File path                  | URL prefix        |
| -------------------------- | ----------------- |
| `routes/index.ts`          | `/`               |
| `routes/users.ts`          | `/users`          |
| `routes/users/index.ts`    | `/users`          |
| `routes/users/[id].ts`     | `/users/:id`      |
| `routes/admin/settings.ts` | `/admin/settings` |
| `routes/api/v1/index.ts`   | `/api/v1`         |

### Three-stage definition

VextJS routing is defined using **three-part** `(path, options, handler)` or **two-part** `(path, handler)`:

```typescript
// Three-stage formula: path + options + handler
app.get(
  "/list",
  {
    validate: { query: { page: "number:1-", limit: "number:1-100" } },
    middlewares: ["audit-log"],
    docs: { summary: "User List" },
  },
  async (req, res) => {
    const { page, limit } = req.valid("query");
    res.json(await app.services.user.findAll({ page, limit }));
  },
);

//Two paragraphs: path + handler (no options)
app.get("/health", async (_req, res) => {
  res.json({ status: "ok" });
});
```

The second parameter `options` in the three-part expression is a declarative configuration object, including:

| Field         | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `validate`    | Parameter validation rules (query / body / param / header)    |
| `middlewares` | Route-level middleware reference                              |
| `auth`        | Route protection contract, usually wrapped by a local helper  |
| `session`     | Route-level Session opt-in, opt-out, or behavior override     |
| `csrf`        | Route-level CSRF opt-out                                      |
| `docs`        | OpenAPI documentation configuration                           |
| `override`    | Route-level runtime override (`rateLimit`, `timeout`, `cors`) |

## How to write routing files

Each route file uses `defineRoutes()` to export route definitions:

```typescript
// src/routes/users.ts
import { defineRoutes, type RouteOptions } from "vextjs";

function requireAuth(options: RouteOptions): RouteOptions {
  return {
    ...options,
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  };
}

export default defineRoutes((app) => {
  //GET /users
  app.get(
    "/",
    {
      docs: { summary: "Get user list" },
    },
    async (req, res) => {
      const users = await app.services.user.findAll();
      res.json(users);
    },
  );

  // GET /users/:id
  app.get(
    "/:id",
    {
      validate: { param: { id: "string!" } },
      docs: { summary: "Get user details" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      if (!user) app.throw(404, "user.not_found");
      res.json(user);
    },
  );

  // POST /users
  app.post(
    "/",
    requireAuth({
      validate: {
        body: {
          name: "string:1-50!",
          email: "email!",
          age: "number?",
        },
      },
      docs: { summary: "Create User" },
    }),
    async (req, res) => {
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );

  // PUT /users/:id
  app.put(
    "/:id",
    requireAuth({
      validate: {
        param: { id: "string!" },
        body: { name: "string:1-50?", email: "email?" },
      },
      docs: { summary: "Update user" },
    }),
    async (req, res) => {
      const { id } = req.valid("param");
      const data = req.valid("body");
      const user = await app.services.user.update(id, data);
      res.json(user);
    },
  );

  // DELETE /users/:id
  app.delete(
    "/:id",
    requireAuth({
      validate: { param: { id: "string!" } },
      docs: { summary: "Delete user" },
    }),
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## HTTP method

The `app` object in the `defineRoutes()` callback supports these HTTP methods:

| Method          | Usage                  | Common scenarios                                               |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| `app.get()`     | Query resources        | List queries and detail retrieval                              |
| `app.post()`    | Create resources       | Form submission and resource creation                          |
| `app.put()`     | Full update            | Resource replacement                                           |
| `app.patch()`   | Partial update         | Field-level updates                                            |
| `app.delete()`  | Delete resources       | Resource deletion                                              |
| `app.head()`    | Get header information | Resource existence checks                                      |
| `app.options()` | Preflight request      | CORS preflight, usually handled automatically by the framework |

## Dynamic routing parameters

### File-level dynamic parameters

Use `[paramName]` as the file name or directory name to automatically convert it to a routing dynamic parameter:

```
src/routes/users/[id].ts → /users/:id
src/routes/posts/[slug].ts → /posts/:slug
src/routes/[category]/[id].ts → /:category/:id
```

```typescript
// src/routes/users/[id].ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /users/:id — file-level parameter :id is included in the prefix
  app.get(
    "/",
    {
      validate: { param: { id: "string!" } },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      res.json(user);
    },
  );

  // GET /users/:id/orders — file-level parameters + subpath
  app.get(
    "/orders",
    {
      validate: { param: { id: "string!" } },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const orders = await app.services.order.findByUserId(id);
      res.json(orders);
    },
  );
});
```

### Dynamic parameters within the route

The `:paramName` syntax can also be used in routing paths inside files:

```typescript
// src/routes/users.ts
export default defineRoutes((app) => {
  // GET /users/:id/posts/:postId
  app.get(
    "/:id/posts/:postId",
    {
      validate: {
        param: { id: "string!", postId: "string!" },
      },
    },
    async (req, res) => {
      const { id, postId } = req.valid("param");
      // ...
      res.json({ userId: id, postId });
    },
  );
});
```

## Request object (req)

The first parameter `req` of the routing handler is the unified `VextRequest` object of the framework, which is decoupled from the underlying Adapter:

### Common attributes

```typescript
app.post("/example", async (req, res) => {
  req.method; // 'POST'
  req.url; // '/example?foo=bar'
  req.path; // '/example'
  req.query; // { foo: 'bar' }
  req.body; // Request body (parsed by body-parser middleware)
  req.params; // path parameters { id: '123' }
  req.headers; // Request headers (lowercase key)
  req.cookies; // Parsed cookies (readonly, first-wins)
  req.cookie("theme"); // Read one cookie value
  req.session; // Available when global or route-level Session is enabled
  req.requestId; //Request unique identifier (automatically generated or transparently transmitted from X-Request-Id)
  req.ip; // Client IP
  req.protocol; // 'http' | 'https'
  req.app; // VextApp instance (can access services, logger, throw, etc.)
});
```

### `req.valid()` — Get the verified data

When the route is configured with the `validate` option, use `req.valid()` to obtain the data after verification and type conversion:

```typescript
app.get(
  "/search",
  {
    validate: {
      query: {
        keyword: "string!",
        page: "number:1-", // Automatically convert query string to number
        limit: "number:1-100",
      },
    },
  },
  async (req, res) => {
    const { keyword, page, limit } = req.valid("query");
    // keyword: string, page: number, limit: number — type converted
    const results = await app.services.search.query(keyword, page, limit);
    res.json(results);
  },
);
```

`req.valid()` supports five positions:

| Parameters | Data source   | Description             |
| ---------- | ------------- | ----------------------- |
| `'query'`  | `req.query`   | URL query parameters    |
| `'body'`   | `req.body`    | Request body            |
| `'param'`  | `req.params`  | Path dynamic parameters |
| `'header'` | `req.headers` | Request headers         |
| `'cookie'` | `req.cookies` | Parsed Cookie values    |

:::tip Automatic type inference
When the route declares `validate`, the handler receives the inferred type from
that same schema:

```typescript
const { id } = req.valid("param");
// The type of id is string
```

:::

### `req.onClose()` — Connection close hook

Callback when the registration request is closed (triggered when the client disconnects), commonly used in SSE/long connection scenarios:

```typescript
req.onClose(() => {
  // Clean up resources
});
```

## Response object (res)

The second parameter `res` of the route handler is the framework-unified `VextResponse` object:

### `res.json()` — JSON response

```typescript
//Default 200
res.json({ name: "Alice" });
// → { "code": 0, "data": { "name": "Alice" }, "requestId": "xxx" }

//Specify status code
res.json(user, 201);

// 204 No Content (the message body is automatically not sent)
res.status(204).json(null);
```

:::info response wrapper
When the `response-wrapper` middleware is enabled (enabled by default), `res.json()` will automatically wrap the response into a unified format:

```json
{
  "code": 0,
  "data": { "...": "Your business data" },
  "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Error responses are returned uniformly by the global error handler:

```json
{
  "code": 404,
  "message": "User does not exist",
  "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

:::

### `res.text()` — plain text response

```typescript
res.text("Hello World");
res.text("Not Found", 404);
```

### `res.stream()` — streaming response

```typescript
import { createReadStream } from "node:fs";

app.get("/download/report", async (_req, res) => {
  const stream = createReadStream("/path/to/report.csv");
  res.stream(stream, "text/csv");
});
```

### `res.download()` — File download

```typescript
app.get("/export", async (_req, res) => {
  const stream = createReadStream("/path/to/data.xlsx");
  res.download(
    stream,
    "report.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});
```

`download()` automatically writes a safe `Content-Disposition`: ASCII filenames use `filename` directly, while non-ASCII or unsafe filenames get a fallback plus a UTF-8 `filename*`.

### `res.redirect()` — Redirect

```typescript
res.redirect("/new-location"); // 302 temporary redirect
res.redirect("/new-location", 301); // 301 permanent redirect
```

### Chain call

`res.status()` and `res.setHeader()` support chained calls:

```typescript
res.status(201).setHeader("X-Custom-Header", "value").json(data);
```

### `res.statusCode` — Read status code

In the after-middleware stage of the onion model, the final response status code can be read:

```typescript
const timing: VextMiddleware = async (req, res, next) => {
  const start = Date.now();
  await next();
  console.log(
    `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
  );
};
```

## Parameter verification

VextJS integrates [schema-dsl](https://github.com/devcodex-labs/schema-dsl), declares validation rules in the route `options.validate`, and the framework automatically performs validation and generates OpenAPI documents.

### DSL syntax quick check

| DSL expression         | Meaning                                  |
| ---------------------- | ---------------------------------------- |
| `'string!'`            | Required string                          |
| `'string?'`            | Optional string                          |
| `'string:1-50'`        | String, length 1-50                      |
| `'string:1-50!'`       | Required string, length 1-50             |
| `'number!'`            | Required number                          |
| `'number:1-'`          | Number, minimum value 1 (no upper limit) |
| `'number:1-100'`       | Number, range 1-100                      |
| `'email!'`             | Required, email format                   |
| `'url?'`               | Optional, URL format                     |
| `'boolean!'`           | Required Boolean value                   |
| `'admin\|user\|guest'` | Enumeration value                        |
| `'date!'`              | Required date string                     |

### Verify location

```typescript
app.post(
  "/users/:id/settings",
  {
    validate: {
      param: {
        id: "string!",
      },
      query: {
        format: "json|xml",
      },
      header: {
        "x-api-key": "string!",
      },
      body: {
        nickname: "string:1-30!",
        avatar: "url?",
        notifications: "boolean!",
      },
    },
  },
  handler,
);
```

Validation runs in this order: `param` → `query` → `header` → `body`. An invalid path `param` returns HTTP `400`; failure at another location returns HTTP `422` immediately.

### Verification error response

When verification fails, the framework automatically returns a structured error message:

```json
{
  "code": 422,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "must be a valid email address" },
    { "field": "name", "message": "length must be between 1 and 50" }
  ],
  "requestId": "xxx"
}
```

## Routing level middleware

Specify middleware for routes via `options.middlewares`. Middleware must first be registered in the `middlewares` whitelist of `config/default.ts`:

```typescript
// src/config/default.ts
export default {
  middlewares: [
    "audit-log",
    { name: "rate-limit", options: { window: 60_000, max: 120 } },
  ],
};
```

```typescript
// src/routes/admin.ts
export default defineRoutes((app) => {
  // string reference
  app.get(
    "/dashboard",
    {
      middlewares: ["audit-log"],
    },
    handler,
  );

  // Object reference (overrides default parameters)
  app.delete(
    "/users/:id",
    {
      middlewares: [
        "audit-log",
        { name: "rate-limit", options: { window: 60_000, max: 10 } },
      ],
    },
    handler,
  );
});
```

Middleware is executed in the order of declaration, running before handlers.

## OpenAPI document configuration

OpenAPI documentation information for configuring routing via `options.docs`:

```typescript
app.post(
  "/users",
  {
    validate: {
      body: { name: "string:1-50!", email: "email!" },
    },
    responses: {
      201: {
        schema: { id: "string", name: "string", email: "email" },
      },
    },
    docs: {
      summary: "Create user",
      description: "Create a new user, the email address must be unique.",
      operationId: "createUser",
      deprecated: false,
      responses: {
        201: {
          description: "Created successfully",
        },
        409: {
          description: "Email already exists",
        },
      },
    },
  },
  handler,
);
```

Top-level `responses` is the runtime contract used for compiled JSON
serialization, OpenAPI, and generated client types. Keep descriptions and
examples in `docs.responses`; do not repeat the schema there for the same
status selector.

### Hidden route

For routes that you do not want to appear in the OpenAPI documentation, set `docs.hidden: true`:

```typescript
app.get(
  "/internal/metrics",
  {
    docs: { hidden: true },
  },
  handler,
);
```

## Access the `app` object

The callback parameter `app` of `defineRoutes()` provides the full capabilities of the framework:

```typescript
export default defineRoutes((app) => {
  app.get("/example", async (req, res) => {
    //Access service
    const data = await app.services.user.findAll();

    // use logger
    app.logger.info({ userId: req.params.id }, "Fetching user");

    // throw HTTP error
    if (!data) app.throw(404, "not_found");

    //Read configuration
    const port = app.config.port;

    res.json(data);
  });
});
```

:::tip req.app and closure app
There are two ways to access `app` in the routing handler:

- **Closure `app`**: `app` parameter in `defineRoutes((app) => ...)`
- **`req.app`**: The real runtime `app` reference on the request object

For stable references such as `config`, `services`, `logger`, and `throw`, the two usually behave the same, and the closure `app` is also written more concisely.

But please note: `defineRoutes()` will internally copy the properties of the root `app` to the collector first, and then pass this collector to the routing factory; if a field will be `app.extend()` **replaced with a new object reference** during runtime (such as `app.remoteConfig` in the Nacos scenario), the old reference captured in the closure `app` will not be automatically refreshed, and should be read instead. `req.app`, or read through `this.app` in service.

In short:

- **static/stable fields** → closure `app` can continue to be used
- **Dynamic field replacement during runtime** → Prioritize using `req.app`
  :::

## Error handling

### `app.throw()` — throw HTTP error

When using `app.throw()` in a route or service to throw an error, the framework will handle it uniformly and return a structured response:

```typescript
//Basic usage
app.throw(404, "User does not exist");
// → { "code": 404, "message": "User does not exist", "requestId": "..." }

// Use i18n key (with locales/ language pack)
app.throw(404, "user.not_found");
// → Automatically translate the message into the current request language

//With business error code
app.throw(400, "Email has been registered", 10001);
// → { "code": 10001, "message": "Email has been registered", "requestId": "..." }

//With interpolation parameters
app.throw(400, "balance.insufficient", { balance: 50 });
// → { "code": 20001, "message": "Insufficient balance, current balance is 50", "requestId": "..." }

// With interpolation parameters + business error code
app.throw(400, "balance.insufficient", { balance: 50 }, 20001);
```

`app.throw()` will terminate the current request processing flow (function signature returns `never`), no need to add `return` after it.

If an unexpected exception is thrown here, you can also directly:

```typescript
throw new Error("Database connection lost");
```

The framework will catch it as well, but this path represents an "unknown runtime error" and will ultimately return a `500 Internal Server Error`. In the development environment, when `response.hideInternalErrors = false`, the JSON 500 response will be accompanied by `stack`; if your goal is to actively return a clear `4xx/5xx` HTTP result, you should still use `app.throw(...)` first.

## Route loading priority

When there are potentially conflicting routes, `router-loader` handles them according to the following rules:

1. **Static routing takes precedence over dynamic routing**: `/users/list` takes precedence over `/users/:id`
2. **Sort files in alphabetical order**: Ensure the loading order is deterministic
3. **Duplicate definitions of the same prefix are not allowed**: `routes/users.ts` and `routes/users/index.ts` cannot exist at the same time (the framework will report an error)

## Exclusion rules

The following files will not be loaded as routes:

- Supported route file extensions are `.ts`, `.js`, `.mjs`, and `.cjs`
- Test files: `*.test.ts`, `*.spec.ts`
- Type declaration files: `*.d.ts`
- Files or directories starting with `_` or `.`
- `node_modules` directory
- Generated temporary files containing `.__vext_compiled__`

These files are skipped, not treated as startup errors. Runtime route loading, route diagnostics, and manifest generation share this policy.

You can use the `_` prefix to create tool modules for route sharing:

```
src/routes/
├── _utils.ts # will not be loaded as a route
├── _types.ts # Shared type definition
├── users.ts
└── orders.ts
```

## Complete example

```typescript
// src/routes/posts.ts
import { defineRoutes, type RouteOptions } from "vextjs";

function requireAuth(options: RouteOptions): RouteOptions {
  return {
    ...options,
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  };
}

export default defineRoutes((app) => {
  // GET /posts — paginated list
  app.get(
    "/",
    {
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-50",
          status: "draft|published|archived",
        },
      },
      docs: {
        summary: "Get article list",
      },
    },
    async (req, res) => {
      const { page = 1, limit = 20, status } = req.valid("query");
      const posts = await app.services.post.findAll({ page, limit, status });
      res.json(posts);
    },
  );

  // GET /posts/:id — Get details
  app.get(
    "/:id",
    {
      validate: { param: { id: "string!" } },
      docs: { summary: "Get article details" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const post = await app.services.post.findById(id);
      if (!post) app.throw(404, "post.not_found");
      res.json(post);
    },
  );

  // POST /posts — create posts (authentication required)
  app.post(
    "/",
    requireAuth({
      validate: {
        body: {
          title: "string:1-200!",
          content: "string:1-50000!",
          tags: "string?",
        },
      },
      docs: {
        summary: "Create article",
        responses: {
          201: { description: "Created successfully" },
          401: { description: "Not authenticated" },
        },
      },
    }),
    async (req, res) => {
      const data = req.valid("body");
      const post = await app.services.post.create({
        ...data,
        authorId: req.auth.userId,
      });
      res.json(post, 201);
    },
  );

  // PATCH /posts/:id — update post
  app.patch(
    "/:id",
    requireAuth({
      validate: {
        param: { id: "string!" },
        body: {
          title: "string:1-200?",
          content: "string:1-50000?",
          status: "draft|published|archived",
        },
      },
      docs: { summary: "Update article" },
    }),
    async (req, res) => {
      const { id } = req.valid("param");
      const data = req.valid("body");
      const post = await app.services.post.update(id, data);
      res.json(post);
    },
  );

  // DELETE /posts/:id — delete post
  app.delete(
    "/:id",
    requireAuth({
      validate: { param: { id: "string!" } },
      docs: { summary: "Delete article" },
    }),
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.post.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## Next step

- Understand how the [service layer](/guide/services) organizes business logic
- Learn the onion model of [middleware](/guide/middleware)
- Explore the advanced usage of [Parameter Validation](/guide/validation)
- View [OpenAPI Documentation](/guide/openapi) automatically generated
