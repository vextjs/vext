# Route definition

This page details the route definition API of VextJS, including `defineRoutes`, routing options, parameter validation, middleware references and document configuration.

## defineRoutes

`defineRoutes` is the core function for creating route files. It receives a factory callback in which the route is registered via the `app` object.

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/hello", async (req, res) => {
    res.json({ message: "Hello World" });
  });
});
```

### Function signature

```typescript
function defineRoutes(factory: RouteFactory): RouteDefinition;

type RouteFactory = (app: VextApp) => void;
```

The route `factory` must be synchronous: do not mark it `async` and do not
return a `Promise`. Individual route handlers may still be `async`. This keeps
runtime registration, build indexing, Doctor, and type generation on the same
statically projectable route set.

### Working principle

1. When `defineRoutes(factory)` is called, a **collector** (route collector) is created internally
2. `factory(collector)` is executed, and `app.get/post/...` in the user code actually calls the collector method.
3. Each route is pushed into the internal `routes` array
4. Return the `RouteDefinition` object
5. `router-loader` scans the `src/routes/` directory and calls `register()` on the `default export` of each file to register with the underlying adapter

:::tip
In the factory callback, `app` not only has HTTP methods (`get/post/put/...`), but also can access complete capabilities such as `app.services`, `app.config`, `app.throw`, `app.logger`, etc. These properties are injected by `router-loader` before executing the factory.
:::

---

## Route registration syntax

VextJS supports two route registration syntaxes: **three-stage** and **two-stage**.

### Three-stage (recommended)

```typescript
app.method(path, options, handler);
```

Complete syntax with `options` configuration, supporting parameter verification, middleware reference, document configuration, etc.:

```typescript
export default defineRoutes((app) => {
  app.post(
    "/users",
    {
      validate: {
        body: { name: "string:1-50", email: "email" },
      },
      middlewares: ["audit-log"],
      docs: {
        summary: "Create user",
      },
    },
    async (req, res) => {
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );
});
```

### Two-stage

```typescript
app.method(path, handler);
```

Simplified syntax without `options`, suitable for simple routes that do not require validation, middleware or document configuration:

```typescript
export default defineRoutes((app) => {
  app.get("/health", async (_req, res) => {
    res.json({ status: "ok" });
  });
});
```

### Supported HTTP methods

| Method                   | Description     |
| ------------------------ | --------------- |
| `app.get(path, ...)`     | GET request     |
| `app.post(path, ...)`    | POST request    |
| `app.put(path, ...)`     | PUT request     |
| `app.patch(path, ...)`   | PATCH request   |
| `app.delete(path, ...)`  | DELETE request  |
| `app.head(path, ...)`    | HEAD request    |
| `app.options(path, ...)` | OPTIONS request |

---

## Routing path

### Static path

```typescript
app.get("/users", handler);
app.get("/users/profile", handler);
```

### Dynamic parameters

Use `:paramName` to define dynamic path parameters, accessed through `req.params` or `req.valid('param')`:

```typescript
app.get(
  "/users/:id",
  {
    validate: {
      param: { id: "string:1-" },
    },
  },
  async (req, res) => {
    const { id } = req.valid("param");
    const user = await app.services.user.findById(id);
    res.json(user);
  },
);
```

If a dynamic path reads from `req.params` without declaring `validate.param`, OpenAPI automatically adds a `required: true` string path parameter for `:paramName` or `*paramName` so the generated path template is valid. Declare `validate.param` when you need format constraints.

### Wildcard

```typescript
app.get("/files/*", async (req, res) => {
  // req.params['*'] contains the wildcard matching part
  res.json({ path: req.params["*"] });
});
```

### File routing mapping

The directory path of the routing file is automatically mapped to the URL prefix:

| File path                  | URL prefix    | Example                                |
| -------------------------- | ------------- | -------------------------------------- |
| `src/routes/users.ts`      | `/users`      | `app.get('/list')` → `GET /users/list` |
| `src/routes/api/orders.ts` | `/api/orders` | `app.post('/')` → `POST /api/orders`   |
| `src/routes/index.ts`      | `/`           | `app.get('/health')` → `GET /health`   |

:::tip
The `path` registered in the routing file is a **relative subpath**, and the framework automatically splices the file path prefix. For example, `app.get('/:id')` in `src/routes/users.ts` is ultimately registered as `GET /users/:id`.
:::

---

## RouteOptions

The second parameter of the routing three-part syntax is the declarative configuration object.

```typescript
interface RouteOptions {
  validate?: {
    query?: Record<string, VextSchemaField>;
    body?: Record<string, VextSchemaField>;
    param?: Record<string, VextSchemaField>;
    header?: Record<string, VextSchemaField>;
    cookie?: Record<string, VextSchemaField>;
  };
  responses?: Record<
    string | number,
    { schema: Record<string, unknown> | string }
  >;
  cache?: false | number | RouteCacheOptions;
  frontend?: VextRouteFrontendOptions;
  middlewares?: VextMiddlewareRef[];
  docs?: RouteDocsConfig;
  auth?: false | true | VextAuthRequirement;
  csrf?: false;
  securityHeaders?: false;
  session?:
    | boolean
    | {
        enabled?: boolean;
        rolling?: boolean;
        autoCommit?: boolean;
      };
  timeout?: number | false;
  multipart?: {
    files?: Record<
      string,
      string | { description?: string; required?: boolean }
    >;
  };
  override?: {
    rateLimit?: { max?: number; window?: number; keyBy?: string } | false;
    /** @deprecated Use top-level timeout. */
    timeout?: number;
    maxBodySize?: string | number;
    cors?: VextCorsConfig;
  };
}
```

### Frontend freshness

`RouteOptions.frontend` keeps page freshness on the existing route declaration:

```ts
frontend: {
  mode: "dynamic" | "static" | "revalidate",
  revalidate?: number, // seconds; required by revalidate mode
  staticParams?: Array<Record<string, string | number | boolean>>,
  clientOnly?: boolean,
  hydration?: "full" | "none",
  seo?: {
    title?: string,
    description?: string,
    canonical?: string,
    originKey?: string,
    index?: boolean,
  },
  tags?: string[],
  page?: string,
  staticBudget?: {
    maxParams?: number;
    maxDurationMs?: number;
    maxBytes?: number;
  },
}
```

`staticParams` is valid only for `"static"`. `revalidate` is valid only for
`"revalidate"` and is a positive interval in seconds. `clientOnly` keeps the
route document/data/assets while intentionally skipping the server page body;
it is not PPR or a second page route.

`hydration: "none"` does the opposite of `clientOnly`: it requires and keeps
the SSR page body but removes the Vext/React browser runtime, hydration data,
and route JS preload. It cannot be combined with `clientOnly` or disabled SSR.
`seo` is static, JSON-safe route metadata and is merged before per-render SEO.
Build-indexed paths and route metadata use a finite static grammar so the build
index and runtime cannot diverge. The index accepts literals, same-file `const`
bindings, and TypeScript `as const` / simple `as Type` / `satisfies` wrappers.
A route-options helper call is rejected because the index does not execute the
helper body and cannot know whether it adds, removes, or replaces contract
fields. Inline the helper's final object or store that final object in a
same-file `const`. Comments, strings, template text, and regular expressions
are ignored during structural matching.

Each `app.get(...)` / `app.post(...)` registration must be a direct top-level
statement in the `defineRoutes` callback. Conditional or nested registration
fails the static projection because the build index cannot guarantee whether
runtime control flow executes it.

Imported values, computed expressions, and template literals with
interpolation are not executed. If a route path, `validate` location, or
response schema cannot be projected, build/doctor/typegen fails with file,
HTTP method, and route context instead of silently omitting the route or
emitting an empty contract. Use `res.render(..., { seo })` for
request-dependent metadata. See
[SEO, Sitemap, and Robots](/frontend/seo-sitemap).

### Complete example

```typescript
app.put(
  "/users/:id",
  {
    validate: {
      param: { id: "string:1-" },
      body: {
        name: "string:1-50",
        email: "email",
        age: "number:0-200?",
      },
    },
    responses: {
      200: { schema: { id: "string!", name: "string!", email: "email!" } },
      404: { schema: { code: "integer!", message: "string!" } },
    },
    cache: false,
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
    docs: {
      summary: "Update user",
      responses: {
        200: { description: "Update successful" },
        404: { description: "User does not exist" },
      },
    },
    override: {
      rateLimit: { max: 10, window: 60 },
      maxBodySize: "5mb",
    },
  },
  handler,
);
```

---

## validate

Declarative parameter validation, based on `schema-dsl` DSL syntax. The
framework validates before the handler runs. An invalid `param` (path
parameter) returns HTTP `400`; invalid `query`, `header`, `cookie`, or `body`
data returns HTTP `422`.

The field type is `VextSchemaField`, which supports schema-dsl strings, field-level DslBuilders, nested objects, and object arrays. Field-level DslBuilder is often used to add business descriptions to OpenAPI documents:

```typescript
import { schemaAdapter } from "vextjs";

app.post(
  "/translate",
  {
    validate: {
      body: {
        content: schemaAdapter
          .compileField("string:1-20000!")
          .description("Text to be translated, length 1-20000 characters"),
        format: schemaAdapter
          .compileField("enum:plain_text,preserve_line_breaks")
          .description("output format"),
      },
    },
  },
  handler,
);
```

The static projector recognizes only `schemaAdapter` imported by name from
`vextjs` (an alias is allowed), `compileField(<static string>)`, and at most one
`.description(<static string>)`. The complete builder may be stored in an
unambiguous same-file `const`. Imported builders, dynamic arguments, other call
chains, and opaque Zod/Yup objects fail the build instead of producing a partial
request contract.

These descriptions will enter the OpenAPI schema while retaining constraints such as required, enumeration, and length.

### Verify location

| Location | Data Source   | Description                              |
| -------- | ------------- | ---------------------------------------- |
| `param`  | `req.params`  | Path dynamic parameters (such as `/:id`) |
| `query`  | `req.query`   | URL query parameters                     |
| `header` | `req.headers` | Request headers                          |
| `cookie` | `req.cookies` | Parsed cookie values                     |
| `body`   | `req.body`    | Request body                             |

**Verify execution order**: `param` → `query` → `header` → `cookie` → `body`

### Basic usage

```typescript
app.get(
  "/users",
  {
    validate: {
      query: {
        page: "number:1-", // A number greater than or equal to 1
        limit: "number:1-100", // Number between 1 and 100
        keyword: "string?", // optional string
      },
    },
  },
  async (req, res) => {
    const { page, limit, keyword } = req.valid("query");
    // page: number, limit: number, keyword: string | undefined
  },
);
```

### DSL syntax quick check

| DSL              | Description                         | Examples                         |
| ---------------- | ----------------------------------- | -------------------------------- |
| `'string'`       | Required string                     | `name: 'string'`                 |
| `'string:1-50'`  | A string of length 1-50             | `name: 'string:1-50'`            |
| `'string?'`      | Optional string                     | `nickname: 'string?'`            |
| `'number'`       | Required number                     | `age: 'number'`                  |
| `'number:0-'`    | A number greater than or equal to 0 | `page: 'number:0-'`              |
| `'number:1-100'` | A number between 1 and 100          | `limit: 'number:1-100'`          |
| `'boolean'`      | Required Boolean value              | `active: 'boolean'`              |
| `'email'`        | Email format                        | `email: 'email'`                 |
| `'url'`          | URL format                          | `website: 'url'`                 |
| `'date'`         | Date format                         | `birthday: 'date'`               |
| `'uuid'`         | UUID format                         | `id: 'uuid'`                     |
| `'enum:a,b,c'`   | Enumeration value                   | `status: 'enum:active,inactive'` |
| `'array'`        | array                               | `tags: 'array'`                  |
| `'object'`       | Object                              | `metadata: 'object'`             |

:::tip
`schema-dsl` will automatically do **type conversion**. For example, `'2'` (string) in the query parameter `?page=2` will be automatically converted to `2` (number), provided that the schema is declared as `'number'` type.
:::

### Get the verified data

Use `req.valid(location)` to obtain the verified and type-converted data:

```typescript
app.post(
  "/users",
  {
    validate: {
      body: { name: "string:1-50!", email: "email!" },
      query: { notify: "boolean?" },
    },
  },
  async (req, res) => {
    const body = req.valid("body"); // { name: string, email: string }
    const query = req.valid("query"); // { notify?: boolean }
    // ...
  },
);
```

The handler type is inferred from the route schema without a duplicate
interface:

```typescript
const body = req.valid("body");
// body.name → IDE knows it is string
// body.email → IDE knows it is string
```

An explicit generic remains available only as an escape hatch for dynamic or
external schemas and overrides the inferred contract.

### Verification failure response

For `query`, `header`, `cookie`, or `body`, validation failure returns HTTP
`422` with a structured response such as the following. A `validate.param`
failure uses the same error shape with HTTP/code `400` because the URL path is
invalid.

```json
{
  "code": 422,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "must be a valid email address" },
    { "field": "name", "message": "length must be between 1 and 50" }
  ],
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## middlewares

Route-level middleware reference. The referenced middleware must first be declared in the `config.middlewares` whitelist.

### String reference

```typescript
app.get(
  "/profile",
  {
    middlewares: ["audit-log"],
  },
  handler,
);
```

### Object reference (with configuration override)

```typescript
app.get(
  "/admin/users",
  {
    middlewares: [
      "audit-log",
      { name: "rate-limit", options: { window: 60_000, max: 30 } },
    ],
  },
  handler,
);
```

### VextMiddlewareRef type

```typescript
type VextMiddlewareRef = string | { name: string; options?: unknown };
```

### Execution order

Routing-level middleware is executed after global middleware and before handler:

```
request → [global middleware chain] → [routing-level middleware] → [validate middleware] → handler → response
```

### Configure whitelist

Middleware referenced in routes must be declared in the configuration file:

```typescript
// src/config/default.ts
export default {
  middlewares: [
    { name: "auth" },
    { name: "role", options: { required: "user" } },
    { name: "client-cache", options: { maxAge: 300 } },
  ],
};
```

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, _res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    req.app.throw(401, "Authentication token not provided");
  }
  //Verify token...
  req.user = decoded;
  await next();
});
```

:::warning
References to middleware not declared in the whitelist will throw an error on startup:

```
[vextjs] Route GET "/profile" references middleware "auth" which is not
registered in config.middlewares whitelist.
```

:::

---

## auth

`RouteOptions.auth` is the route guard contract. It is separate from identity parsing:

- `auth()` middleware reads the request credential and fills `req.auth`.
- `auth: true` requires an authenticated request.
- Object form can require roles, scopes, permissions, or a custom `check`.
- `auth: { required: false }` makes identity optional; without roles, scopes, permissions, or `check`, OpenAPI marks the route as public.
- `auth: false` marks the route as explicitly public and disables legacy OpenAPI security inference from `middlewares`.

```typescript
// src/middlewares/auth.ts
import { auth, defineMiddleware } from "vextjs";

export default defineMiddleware(
  auth({
    provider: "app",
    async verify(token) {
      if (token !== "demo-token") return false;
      return {
        subject: "user:1",
        userId: "1",
        roles: ["admin"],
        scopes: ["posts:write"],
        can(action, resource) {
          return action === "post:update" && resource === "post-1";
        },
      };
    },
  }),
);
```

```typescript
// src/routes/posts.ts
import type { RouteOptions } from "vextjs";

const updatePostOptions = {
  middlewares: ["auth"],
  auth: {
    roles: ["admin"],
    scopes: ["posts:write"],
    permissions: [{ action: "post:update", resource: "POST:/api/posts/:id" }],
    mode: "all",
    security: "bearerAuth",
  },
  docs: { summary: "Update post" },
} satisfies RouteOptions;

app.post("/posts/:id", updatePostOptions, handler);
```

The build index accepts the final inline object or a same-file `const` such as `updatePostOptions`. It rejects route-options helper calls because it does not execute helper bodies. Keep each route's complete guard contract in one of these statically projectable forms; shared runtime authorization logic still belongs in middleware or the permission provider.

### Runtime auth, OpenAPI security, and Docs access

These are related but independent layers:

- `auth.roles`, `auth.scopes`, `auth.permissions`, and `auth.check` are runtime route guards. They decide whether the current request reaches the handler.
- `auth.security` is OpenAPI metadata. It selects the documented security scheme, and an object array can declare OAuth scopes such as `[{ oauth2: ["posts:write"] }]`; it does not grant or enforce that scope.
- `docs.security` only overrides the generated OpenAPI security metadata. It does not disable a runtime `auth` requirement.
- `docs.access` is Vext Docs visibility/Try it out metadata sent to `openapi.docs.access.resolver`. It does not protect the route; use `auth` for API access control.

It is valid for an application to use the same string in a runtime scope and an OAuth scope, but they remain separate declarations. Keep both explicit when both are required.

Guard failures use stable error codes:

| Code                  | HTTP status | Meaning                                                                 |
| --------------------- | ----------- | ----------------------------------------------------------------------- |
| `AUTH_REQUIRED`       | `401`       | No authenticated identity is present                                    |
| `AUTH_INVALID`        | `401`       | A credential was present but invalid                                    |
| `AUTH_FORBIDDEN`      | `403`       | Authenticated identity failed role, scope, permission, or custom checks |
| `AUTH_CONFIG_ERROR`   | `500`       | The auth middleware or permission provider is misconfigured             |
| `AUTH_PROVIDER_ERROR` | `500`       | The auth provider or custom check threw unexpectedly                    |

`requestContext.getStore()?.auth` stores only a safe snapshot of identity metadata. It intentionally excludes raw credentials and `claims`; use `req.auth` inside the route when provider claims are needed.

---

## cache

Route-level response cache configuration. Response caching occurs on the server side and caches interface response content; it is not custom middleware, nor is it the browser `Cache-Control` response header.

```typescript
import { route } from "vext";

route({
  method: "GET",
  path: "/posts",
  cache: {
    ttl: 30_000, // milliseconds
    methods: ["GET"],
    headers: ["accept-language"],
    partitionKey: (req) => req.user?.tenantId ?? "public",
  },
  handler: async () => {
    return await listPosts();
  },
});
```

Commonly used writing methods:

| Configuration                  | Description                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `cache: false`                 | Disable response caching for this route                                                                                          |
| `cache: 30000`                 | Enables response caching with a TTL of 30000 milliseconds                                                                        |
| `cache: { ttl: 30000 }`        | Use full configuration object                                                                                                    |
| `headers: ["accept-language"]` | Specifies the request headers that participate in caching key; it is not recommended to include all request headers in key       |
| `partitionKey`                 | Generate user, tenant or region isolation dimensions to prevent different visitors from sharing the same cached response         |
| `allowCookieCache`             | Allow requests with a `Cookie` header to participate in cache; keep disabled unless the cookie input is part of a safe cache key |

See the [Response Caching Guide](/guide/cache) for details.

---

## docs

OpenAPI documentation configuration, controls how routes are displayed in automatically generated API documentation.

### RouteDocsConfig

```typescript
interface RouteDocsConfig {
  summary?: string;
  description?: string;
  /** @deprecated ignored; operation tags are inferred automatically */
  tags?: string[];
  operationId?: string;
  hidden?: boolean;
  access?: VextRouteDocsAccessConfig | string;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  extensions?: Record<string, unknown>;
  responses?: Record<string | number, ResponseConfig>;
}
```

### Field description

| Field         | Type               | Default Value                       | Description                                                                                                                               |
| ------------- | ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `summary`     | `string`           | —                                   | One sentence summary of the interface                                                                                                     |
| `description` | `string`           | —                                   | Detailed description of the interface (supports Markdown)                                                                                 |
| `tags`        | `string[]`         | Ignored                             | Deprecated. Operation tags are inferred automatically from the route path/source.                                                         |
| `operationId` | `string`           | Automatic inference                 | Operation ID (globally unique; generation fails on conflicts)                                                                             |
| `hidden`      | `boolean`          | `false`                             | Whether to hide from the document                                                                                                         |
| `access`      | `object \| string` | —                                   | Docs access metadata passed to `openapi.docs.access.resolver`; `visible: false` hides directly, and `tryItOut: false` disables Try it out |
| `deprecated`  | `boolean`          | `false`                             | Whether to mark it as deprecated                                                                                                          |
| `security`    | `array`            | Inference from `auth` / middlewares | Security scheme overrides                                                                                                                 |
| `extensions`  | `object`           | —                                   | Custom `x-*` extension fields                                                                                                             |
| `responses`   | `object`           | —                                   | response definition                                                                                                                       |

`docs.access` is emitted on the OpenAPI operation as the `x-vext-docs-access` vendor extension and passed to `openapi.docs.access.resolver` as the `access` field of a `kind: "operation"` descriptor during Vext Docs filtering. String values are useful for role, tenant, or group labels; object values can carry `roles`, `permissions`, `group`, `visible`, and `tryItOut` metadata. This is documentation access metadata only: hiding an operation or disabling Try it out does not add authentication or authorization to the route.

### Complete example

```typescript
app.post(
  "/users",
  {
    validate: {
      body: {
        name: "string:1-50",
        email: "email",
        role: "enum:admin,user?",
      },
    },
    middlewares: ["audit-log"],
    responses: {
      201: {
        schema: {
          id: "string",
          name: "string",
          email: "email",
          createdAt: "date",
        },
      },
    },
    docs: {
      summary: "Create user",
      description:
        "Create a new user account and record the operation in the audit log.",
      operationId: "createUser",
      responses: {
        201: {
          description: "User created successfully",
          example: {
            id: "usr_abc123",
            name: "Alice",
            email: "alice@example.com",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
        422: { description: "Request parameter verification failed" },
        409: { description: "Email has been registered" },
      },
    },
  },
  handler,
);
```

### operationId automatically inferred

When `operationId` is not specified, the framework is automatically generated based on the HTTP method and path:

| method + path       | inferred operationId |
| ------------------- | -------------------- |
| `GET /users`        | `getUsers`           |
| `POST /users`       | `createUsers`        |
| `GET /users/:id`    | `getUsersById`       |
| `PUT /users/:id`    | `updateUsersById`    |
| `DELETE /users/:id` | `deleteUsersById`    |

Explicit `docs.operationId` values and inferred `operationId` values share the same global uniqueness constraint. If a conflict exists, OpenAPI generation fails; set a unique `docs.operationId` on the conflicting route or change the route method/path so inferred values differ.

### Hidden route

```typescript
app.get(
  "/internal/debug",
  {
    docs: { hidden: true },
  },
  handler,
);
```

### Mark obsolete

```typescript
app.get(
  "/v1/users",
  {
    docs: {
      deprecated: true,
      description: "Deprecated, please use /v2/users",
    },
  },
  handler,
);
```

### Security solution coverage

By default, security schemes are inferred in this order:

1. `docs.security` if explicitly set, including `[]`.
2. `RouteOptions.auth` when it is `true` or an object; `auth: { required: false }` without roles/scopes/permissions/check emits public security.
3. Legacy `middlewares` inference through `config.openapi.guardSecurityMap`.

`auth:false` disables the legacy fallback for that route. If `auth: { required: false }` also declares roles, scopes, permissions, or `check`, runtime still requires authentication and OpenAPI emits authentication security.

Can be manually overridden:

```typescript
//Explicit declaration requires bearerAuth
app.get(
  "/secure",
  {
    docs: {
      security: [{ bearerAuth: [] }],
    },
  },
  handler,
);

// Declare no authentication required (even if there are global security requirements)
app.get(
  "/public",
  {
    docs: {
      security: [],
    },
  },
  handler,
);
```

### Runtime response schema

```typescript
interface RuntimeResponseConfig {
  schema: Record<string, unknown> | string;
}

type RuntimeResponses = Record<string | number, RuntimeResponseConfig>;
```

Declare this map as top-level `RouteOptions.responses`. Selectors support an
exact status (`201`), a family (`2xx`), or `default`; the final status after
`response:before` chooses exact → family → default. Vext compiles each JSON
schema once during route registration and reuses it across requests. The same
closed schema is projected to OpenAPI, route manifests, static build indexing,
and generated client types.

Schemas describe the business data passed to `res.json()`, not a manually
duplicated envelope. Undeclared properties are removed recursively. Missing
required values fail before bytes are committed. HEAD, exact 204, raw JSON,
text, redirect, file/download, stream, and render/SSR responses bypass this
serializer. See [OpenAPI response contracts](/guide/openapi#responses--runtime-response-contracts-and-docs-metadata)
for lifecycle and raw JSON Schema details.

### Documented response metadata

```typescript
interface ResponseConfig {
  description?: string;
  /** Documentation-only compatibility; prefer RouteOptions.responses. */
  schema?: Record<string, unknown> | string;
  contentType?: string;
  example?: unknown;
  examples?: Record<
    string,
    {
      summary?: string;
      description?: string;
      value: unknown;
    }
  >;
  headers?: Record<
    string,
    {
      description?: string;
      schema?: { type: string };
    }
  >;
}
```

Keep descriptions, examples, headers, and content type in `docs.responses`.
Do not repeat `schema` there when the same normalized selector already exists
in top-level `responses`; registration fails on this dual declaration.

**Multi-example response**:

```typescript
docs: {
  responses: {
    200: {
      description: 'Query successful',
      examples: {
        admin: {
          summary: 'Administrator user',
          value: { id: '1', name: 'Admin', role: 'admin' },
        },
        normal: {
          summary: 'Ordinary user',
          value: { id: '2', name: 'User', role: 'user' },
        },
      },
    },
  },
}
```

**Custom response header**:

```typescript
docs: {
  responses: {
    200: {
      description: 'Success',
      headers: {
        'X-RateLimit-Remaining': {
          description: 'Number of remaining requests',
          schema: { type: 'integer' },
        },
      },
    },
  },
}
```

---

## multipart

Route-level file upload configuration. `multipart.files` automatically outputs an OpenAPI `multipart/form-data` requestBody without manually writing `docs.requestBody`. Set `multipart.enabled: true` to opt one route into built-in parsing when global `config.multipart.enabled` is off; set `multipart.enabled: false` to opt one route out when global parsing is on. Built-in parsing is memory-only: it creates no framework-managed temporary files, so there is no tmp directory, file TTL, or periodic cleanup setting. Use a streaming upload plugin for large files or persistent storage.

```typescript
app.post(
  "/upload/avatar",
  {
    multipart: {
      enabled: true,
      files: {
        avatar: { description: "Avatar image (JPEG/PNG)", required: true },
        thumbnail: "optional thumbnail",
      },
    },
    docs: { summary: "Upload avatar" },
  },
  async (req, res) => {
    const file = req.files?.find((f) => f.fieldname === "avatar");
    res.json({ filename: file?.filename, size: file?.size });
  },
);
```

| Subfield              | Type                               | Description                                                                                         |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `enabled`             | `boolean`                          | Route-level parser switch. `true` opts in; `false` opts out; omitted follows global config          |
| `maxFileSize`         | `number`                           | Per-file byte limit for this route, overriding global `multipart.maxFileSize`                       |
| `maxFiles`            | `number`                           | Maximum file count for this route, overriding global `multipart.maxFiles`                           |
| `allowedMimeTypes`    | `string[]`                         | MIME allowlist for this route, overriding global `multipart.allowedMimeTypes`                       |
| `files`               | `Record<string, string \| object>` | File field mapping; the string value is the description, and the object can be configured with more |
| `files[].description` | `string`                           | Field description (for OpenAPI documentation)                                                       |
| `files[].required`    | `boolean`                          | Whether at least one file for this field is required at runtime (default `false`)                   |

When a required file field is missing, Vext returns `400` with the missing field names. Optional fields and undeclared upload fields are accepted; they are still limited by `maxFiles`, `maxFileSize`, and `allowedMimeTypes`.

:::warning note
`multipart.files` and `validate.body` are mutually exclusive. When configured at the same time, `multipart.files` takes priority in OpenAPI document generation.
:::

---

## session

Controls Session for one route. `false` opts out of a globally enabled Session runtime. `true` opts in when the global runtime is disabled. The object form also overrides `rolling` and `autoCommit`; Store identity, cookie name, and session id length remain application-level settings.

```typescript
app.get("/health", { session: false }, healthHandler);

app.post(
  "/preview",
  { session: { enabled: true, rolling: true } },
  previewHandler,
);
```

---

## override

Route-level configuration override, overrides the global configuration in `src/config/default.ts`.

```typescript
app.post(
  "/upload",
  {
    timeout: 30000, // timeout 30 seconds
    override: {
      maxBodySize: "50mb", // Override global body size limit
      rateLimit: { max: 5, window: 60 }, // Tighten the current limit
    },
  },
  handler,
);

app.get(
  "/public/data",
  {
    override: {
      rateLimit: false, // Completely disable rate limiting
      cors: {
        origins: ["*"],
        credentials: false,
      },
    },
  },
  handler,
);
```

| Field         | Type               | Description                                                     |
| ------------- | ------------------ | --------------------------------------------------------------- |
| `rateLimit`   | `object \| false`  | Route-level current limiting configuration, `false` is disabled |
| `timeout`     | `number`           | Deprecated compatibility field; prefer top-level `timeout`      |
| `maxBodySize` | `string \| number` | Maximum request body size                                       |
| `cors`        | `VextCorsConfig`   | Route-level CORS configuration                                  |

Routes can set top-level `{ timeout: number }` to enforce a positive request deadline in milliseconds and send HTTP 504 on timeout. Top-level `{ timeout: false }` explicitly disables the route timeout middleware and takes precedence over the legacy `override.timeout` field.

Routes can also set top-level `{ securityHeaders: false }` when an embeddable page, webhook callback, or fully custom response header stack must skip the global Security Headers preset.

---

## RouteDefinition

The route definition object returned by `defineRoutes()` (internal data structure, usually does not need to be manipulated directly).
Factory and collector internals are not part of the public object shape and should only be driven through `defineRoutes()` and the router loader lifecycle.

```typescript
interface RouteDefinition {
  readonly routes: RouteRecord[];
  sourceFile: string;
  register(
    adapter: VextAdapter,
    prefix: string,
    middlewareDefs: Map<string, VextMiddleware>,
    globalMiddlewares: VextMiddleware[],
  ): void;
}
```

| Field        | Type            | Description                                    |
| ------------ | --------------- | ---------------------------------------------- |
| `routes`     | `RouteRecord[]` | List of collected route records                |
| `sourceFile` | `string`        | Source file path (injected by router-loader)   |
| `register()` | `Function`      | Register the route with the underlying adapter |

### RouteRecord

Internal data structure of a single route:

```typescript
interface RouteRecord {
  method: string; // HTTP method (uppercase)
  path: string; // relative subpath
  options: RouteOptions; // Routing configuration
  handler: VextHandler; //Route processing function
}
```

---

## VextHandler

Type definition of route processing function:

```typescript
type VextHandler = (
  req: VextRequest,
  res: VextResponse,
) => Promise<void> | void;
```

Handler is the last link in the middleware chain and does not call `next()`.

### Basic example

```typescript
const handler: VextHandler = async (req, res) => {
  const users = await app.services.user.findAll();
  res.json(users);
};
```

### Access App Capabilities

In the factory callback of `defineRoutes`, access `app` through the closure:

```typescript
export default defineRoutes((app) => {
  app.get("/users/:id", async (req, res) => {
    const { id } = req.params;
    const user = await app.services.user.findById(id);

    if (!user) {
      app.throw(404, "User does not exist");
    }

    app.logger.info({ userId: id }, "Query user successfully");
    res.json(user);
  });
});
```

If you want to actively return clear HTTP errors such as `404`, `401`, `409`, etc., you should use `app.throw(...)` first. The normal `throw new Error("...")` will also be caught by the framework, but it represents an unknown runtime exception and will eventually go down the 500 error path; field-level validation failures should use `VextValidationError`.

---

## Multiple route registration

Multiple routes can be registered in a routing file:

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /users/list
  app.get(
    "/list",
    {
      validate: {
        query: { page: "number:1-", limit: "number:1-100" },
      },
      docs: { summary: "User List" },
    },
    async (req, res) => {
      const { page, limit } = req.valid("query");
      const result = await app.services.user.findAll({ page, limit });
      res.json(result);
    },
  );

  // GET /users/:id
  app.get(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
      },
      docs: { summary: "Get user details" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      if (!user) app.throw(404, "User does not exist");
      res.json(user);
    },
  );

  // POST /users
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
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );

  // PUT /users/:id
  app.put(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
        body: { name: "string:1-50?", email: "email?" },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "Update user" },
    },
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
    {
      validate: {
        param: { id: "string:1-" },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "Delete user" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

---

## Notes

### Do not call HTTP methods directly on the app

The `app` returned by `defineRoutes` is a collector, not a real application instance. Calling the HTTP method directly on the application instance throws an error:

```typescript
// ❌ Incorrect usage
import { createApp } from "vextjs";
const { app } = createApp(config);
app.get("/hello", handler); // Throw an error!

// ✅ Correct usage
import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/hello", handler); // OK
});
```

### The routing file must be default export

Build-time consumers accept a finite default-export grammar. `defineRoutes`
must be a named import from `vextjs` (an import alias is allowed), and the
factory must be an inline synchronous arrow or function expression:

```typescript
import { defineRoutes, defineRoutes as routes } from "vextjs";

// ✅ Direct default export
export default defineRoutes((app) => { ... });

// ✅ Alias plus inline function expression
export default routes(function (app) { ... });

// ✅ Same-file top-level binding
const routeDefinition = defineRoutes((app) => { ... });
export { routeDefinition as default };

// ❌ Named-only definitions are not route-file identity
export const ignored = defineRoutes((app) => { ... });
```

Re-exports, imported route definitions, property/namespace callees, callback
identifiers, and files without a supported default export fail with the route
file in the diagnostic.

### Routing path normalization

The framework automatically handles the following path edge cases:

| prefix       | subpath   | final path    |
| ------------ | --------- | ------------- |
| `/users`     | `/list`   | `/users/list` |
| `/users`     | `/`       | `/users`      |
| `/users`     | `/:id`    | `/users/:id`  |
| `/`          | `/`       | `/`           |
| `/`          | `/health` | `/health`     |
| `/api/users` | _(empty)_ | `/api/users`  |
