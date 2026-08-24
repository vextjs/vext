# Parameter verification

VextJS integrates [schema-dsl](https://github.com/devcodex-labs/schema-dsl) to provide **declarative parameter verification**. Use concise DSL strings to describe verification rules in the route `options.validate`. The framework automatically completes verification, type conversion, and generates OpenAPI documents synchronously.

## Basic usage

In the three-part definition of the route, the validation rules are declared through the `validate` field:

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.post(
    "/users",
    {
      validate: {
        body: {
          name: "string:1-50!", // Required string, length 1-50
          email: "email!", // required, email format
          age: "number?", // optional number
          role: "admin|user", // enumeration value
        },
      },
      docs: { summary: "Create user" },
    },
    async (req, res) => {
      // req.body has passed verification + type conversion
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );
});
```

After validation, obtain the converted data through `req.valid(location)`. An invalid `param` returns HTTP `400`; an invalid `query`, `header`, `cookie`, or `body` returns HTTP `422`, without manual handler code.

## Check location

`validate` supports five locations, corresponding to different data sources requested:

| Location | Data Source   | Description                              |
| -------- | ------------- | ---------------------------------------- |
| `param`  | `req.params`  | Path dynamic parameters (such as `/:id`) |
| `query`  | `req.query`   | URL query parameters (such as `?page=1`) |
| `header` | `req.headers` | Request headers                          |
| `cookie` | `req.cookies` | Parsed Cookie values                     |
| `body`   | `req.body`    | Request body (JSON/URL-encoded)          |

The verification is executed in the order of `param` → `query` → `header` → `cookie` → `body`. If the verification fails at any position, an error will be returned immediately.

```typescript
app.put(
  "/users/:id",
  {
    validate: {
      param: {
        id: "string!",
      },
      query: {
        fields: "string?", // Optional, specify the return field
      },
      header: {
        "x-api-version": "string?",
      },
      cookie: {
        sid: "string?",
      },
      body: {
        name: "string:1-50?",
        email: "email?",
      },
    },
  },
  async (req, res) => {
    const { id } = req.valid("param");
    const cookies = req.valid("cookie");
    const body = req.valid("body");
    const user = await app.services.user.update(id, body);
    res.json(user);
  },
);
```

::::tip note
The singular `param` is used in `validate` (corresponding to the concept of path parameters), but the underlying data source is `req.params` (plural). The mapping has been done correctly inside the framework, you don’t need to worry about it.

If a dynamic path uses `:id` or `*path` without `validate.param`, OpenAPI still emits a `required: true` string path parameter for that segment so the path template remains valid. Declare `validate.param` when you need stricter type, length, or format constraints.
::::

## Detailed explanation of DSL syntax

schema-dsl uses concise string expressions to describe data types and constraints.

### Basic types

| DSL expression | Meaning       | Example values          |
| -------------- | ------------- | ----------------------- |
| `'string'`     | string        | `"hello"`               |
| `'number'`     | Number        | `42`, `3.14`            |
| `'boolean'`    | Boolean value | `true`, `false`         |
| `'email'`      | Email format  | `"user@example.com"`    |
| `'url'`        | URL format    | `"https://example.com"` |
| `'date'`       | Date string   | `"2026-01-15"`          |

### Required and optional

Add a `!` or `?` tag at the end of the type expression:

| Suffix    | Meaning            | Example                                |
| --------- | ------------------ | -------------------------------------- |
| `!`       | required           | `'string!'' — required string          |
| `?`       | Optional           | `'string?'' — Optional string          |
| no suffix | optional (default) | `'string'` — equivalent to `'string?'` |

```typescript
validate: {
  body: {
    name: 'string!', // required
    nickname: 'string?', // optional
    bio: 'string', // optional (equivalent to 'string?')
  },
}
```

### Scope constraints

Use the `:min-max` syntax to specify a range:

#### String length

```typescript
"string:1-50"; // length 1 to 50
"string:1-50!"; // Required, length 1 to 50
"string:5-"; // Minimum length 5, no upper limit
"string:-100"; // Maximum length 100
```

#### Number range

```typescript
"number:1-100"; // Value range 1 to 100
"number:0-"; // minimum value 0 (non-negative number)
"number:1-"; // Minimum value 1 (positive integer/positive number)
"number:-999"; // Maximum value 999
"number:18-120!"; // required, range 18 to 120
```

### Enumeration value

Use `|` to separate enumeration options:

```typescript
"admin|user|guest"; // Enumeration: admin / user / guest
"draft|published|archived"; // Enumeration: draft / published / archived
"male|female|other"; // Enumeration: male / female / other
```

Enumeration values are always of type string. Maps as `enum` in OpenAPI documentation.

### Combination example

```typescript
validate: {
  body: {
    //Basic type + required/optional
    username: 'string:3-30!', // Required string, length 3-30
    password: 'string:8-128!', // Required string, length 8-128
    email: 'email!', // required email
    website: 'url?', // optional URL
    age: 'number:0-150?', // optional number, range 0-150
    score: 'number:0-100', // optional number, range 0-100
    active: 'boolean!', // required Boolean value
    role: 'admin|editor|viewer', // enumeration
    birthday: 'date?', // optional date
  },
}
```

## Type conversion

schema-dsl automatically performs type conversion during validation, which is especially useful for `query` and `param` data (their original values are always strings):

| declared type | original value | converted |
| ------------- | -------------- | --------- |
| `'number'`    | `"42"`         | `42`      |
| `'number'`    | `"3.14"`       | `3.14`    |
| `'boolean'`   | `"true"`       | `true`    |
| `'boolean'`   | `"false"`      | `false`   |
| `'boolean'`   | `"1"`          | `true`    |
| `'boolean'`   | `"0"`          | `false`   |

```typescript
app.get(
  "/search",
  {
    validate: {
      query: {
        page: "number:1-", // ?page=3 → number 3 (not the string "3")
        limit: "number:1-100", // ?limit=20 → number 20
        active: "boolean", // ?active=true → boolean true
      },
    },
  },
  async (req, res) => {
    const { page, limit, active } = req.valid("query");
    // page: number, limit: number, active: boolean — automatically converted
    res.json({ page, limit, active });
  },
);
```

## Get the verified data

### `req.valid(location)`

Use `req.valid()` to get the data after checksum type conversion. It can only be called after the corresponding location is configured in `validate`.

```typescript
app.post(
  "/orders",
  {
    validate: {
      body: {
        productId: "string!",
        quantity: "number:1-99!",
      },
      query: {
        coupon: "string?",
      },
    },
  },
  async (req, res) => {
    const body = req.valid("body"); // { productId: string, quantity: number }
    const query = req.valid("query"); // { coupon?: string }

    const order = await app.services.order.create(body, query.coupon);
    res.json(order, 201);
  },
);
```

### Boundary behavior

::::warning Notes

`req.valid(location)` has the following boundary behavior to be aware of:

1. **Called when `validate` is not configured**

   If the route is not configured with a `validate` field, calling `req.valid("body")` will return `undefined`. The framework won't throw an error, but you won't be able to get the data after the checksum typecast.

2. **location is not declared in `validate`**

   If only `body` is declared in `validate`, but `req.valid("query")` is called, `undefined` will also be returned. Only locations explicitly declared in `validate` will have verified data.

3. **Handler will not be reached when verification fails**

   Before the handler runs, an invalid path `param` returns HTTP `400`, while an invalid `query`, `header`, `cookie`, or `body` returns HTTP `422`. Data read through `req.valid()` inside the handler has therefore passed validation.

```typescript
//Boundary case example
app.get(
  "/items",
  {
    validate: {
      query: { page: "number:1-" },
      // body is not declared
    },
  },
  async (req, res) => {
    const query = req.valid("query"); // { page: number }, verified
    const body = req.valid("body"); // undefined, not declared in validate
    const param = req.valid("param"); // undefined, not declared in validate
    res.json({ query });
  },
);

// The route of validate is not configured
app.get("/health", async (req, res) => {
  const body = req.valid("body"); // undefined, the route is not configured validate
  res.json({ status: "ok" });
});
```

**Best Practice**: Always ensure that the `location` of `req.valid(location)` is consistent with the location declared in `validate`.
::::

### Automatic route-schema inference

The handler is contextually typed from the same `validate` object used at
runtime. You do not need to duplicate that contract as a TypeScript interface:

```typescript
app.post(
  "/users",
  {
    validate: {
      body: {
        name: "string:1-50!",
        email: "email!",
        age: "number:0-150?",
      },
    },
  },
  async (req, res) => {
    const data = req.valid("body");
    // data.name  — string
    // data.email — string
    // data.age   — number | undefined
    res.json(await app.services.user.create(data));
  },
);
```

Inference covers DSL strings, required/optional markers, nested objects, and
single-item array schemas. A chainable `schemaAdapter.compileField()` builder
is intentionally inferred as `unknown`, because later builder mutations are
not visible in its static type. The explicit form
`req.valid<ExternalBody>("body")` remains available as an escape hatch for
dynamic or externally supplied schemas; it overrides inference and therefore
must match the runtime contract maintained by the application.

## Verification error response

Validation failures use one structured error shape. Invalid path `param` data returns HTTP/code `400`; invalid `query`, `header`, `cookie`, or `body` data returns HTTP/code `422`. The following is a `422` example:

```json
{
  "code": 422,
  "message": "Validation failed",
  "errors": [
    {
      "field": "email",
      "message": "must be a valid email address"
    },
    {
      "field": "name",
      "message": "length must be between 1 and 50"
    }
  ],
  "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

- `code`: HTTP status code 422 (Unprocessable Entity)
- `message`: fixed to `"Validation failed"`
- `errors`: field-level error array, including `field` (field name) and `message` (error description)
- `requestId`: the unique identifier of the current request

Validation errors are handled uniformly by the framework's global error handler, and you do not need to manually try-catch in routing.

## Linkage with OpenAPI documentation

DSL rules in `validate` are automatically mapped to the `parameters` and `requestBody` definitions of the OpenAPI document. No additional configuration is required, the verification rules are the document rules:

```typescript
app.get(
  "/users",
  {
    validate: {
      query: {
        page: "number:1-",
        limit: "number:1-100",
        status: "active|inactive|banned",
      },
    },
    docs: { summary: "Get user list" },
  },
  handler,
);
```

The above route will be automatically generated in the OpenAPI documentation:

- `page` — query parameter, type: integer, minimum: 1
- `limit` — query parameter, type: integer, minimum: 1, maximum: 100
- `status` — query parameter, type: string, enum: ["active", "inactive", "banned"]

Visit `/docs` to view the automatically generated parameter documentation in Vext Docs.

If you want the OpenAPI document to display the business meaning of a field, use the explicit side-effect-free builder. Vext does not install a global String `.description()` method:

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
        targetLanguages: [
          {
            code: schemaAdapter
              .compileField("string:1-64!")
              .description("target language code"),
          },
        ],
        format: schemaAdapter
          .compileField("enum:plain_text,preserve_line_breaks")
          .description("output format"),
      },
    },
    docs: { summary: "Perform text translation" },
  },
  handler,
);
```

The generated OpenAPI schema will retain these descriptions, while continuing to retain constraints such as `required`, `enum`, `minLength`, `maxLength`, etc. Fields without a handwritten description will still use the abstract description generated by the framework.

The `?` suffix means optional only and does not generate `nullable: true`. Use
`types:string|null` or raw `{ type: ["string", "null"] }` when null is an
explicitly supported value.

## Advanced usage

### Multi-position combination verification

The same route can verify multiple locations at the same time:

```typescript
app.put(
  "/users/:id/avatar",
  {
    validate: {
      param: { id: "string!" },
      header: { "content-type": "string!" },
      query: { size: "number:32-512?" },
      body: { url: "url!", alt: "string:0-200?" },
    },
  },
  async (req, res) => {
    const { id } = req.valid("param");
    const { url, alt } = req.valid("body");
    const { size } = req.valid("query");

    await app.services.user.updateAvatar(id, { url, alt, size });
    res.json({ success: true });
  },
);
```

### Cooperate with routing-level middleware

The verification middleware is executed after the routing-level middleware and before the handler. This means:

```
Request → [global middleware] → [routing-level middleware: auth, check-role] → [validate verification] → [handler]
```

Authentication check is performed before parameter verification, and unauthenticated requests will not trigger the verification logic:

```typescript
app.post(
  "/admin/users",
  {
    middlewares: [
      "auth",
      { name: "check-role", options: { roles: ["admin"] } },
    ],
    validate: {
      body: {
        name: "string:1-50!",
        email: "email!",
        role: "admin|editor|viewer!",
      },
    },
  },
  handler,
);
```

### Route override current limiting rules

In addition to parameter verification, `options` also supports route-level configuration override (`override`), which can adjust current limiting, timeout and other settings for specific routes:

```typescript
app.post(
  "/login",
  {
    validate: {
      body: {
        email: "email!",
        password: "string:8-128!",
      },
    },
    override: {
      rateLimit: { max: 5, window: 60 }, // Maximum 5 times per minute (window unit: seconds)
    },
  },
  handler,
);

app.get(
  "/public/health",
  {
    override: {
      rateLimit: false, // Health check does not limit the flow
    },
  },
  handler,
);
```

## Reuse the verification engine in the service layer

For route entry parameters, `RouteOptions.validate` + `req.valid()` is preferred. If the service also needs to verify non-HTTP input, such as scheduled tasks, message queues, external callbacks, or internal DTOs, you can obtain the current global validation engine through `this.app.getValidator()`.

`getValidator()` returns the current validator: implemented by schema-dsl by default; if the plug-in is replaced by Zod, Yup, etc. through `app.setValidator()`, the service will also get the replaced validator.It is recommended to throw `VextValidationError` directly, so that the framework will return a structured `422` response and an `errors` array. Don't write this type of validation failure as a normal `throw new Error("...")`, otherwise it will be treated as an unknown exception and enter the 500 path.

```typescript
import { VextValidationError, type VextApp, type VextValidator } from "vextjs";

const createUserSchema = {
  name: "string:1-50!",
  email: "email!",
};

export default class UserService {
  private validateCreateUser: ReturnType<VextValidator["compile"]>;

  constructor(private app: VextApp) {
    const validator = app.getValidator();
    this.validateCreateUser = validator.compile(createUserSchema);
  }

  async create(input: unknown) {
    const result = this.validateCreateUser(input);

    if (!result.valid) {
      throw new VextValidationError(result.errors ?? []);
    }

    const data = result.data as { name: string; email: string };
    // Continue executing business logic...
    return data;
  }
}
```

::::tip

Do not directly `import "schema-dsl"` in business services. Directly relying on schema-dsl will bypass the global replacement capability of `app.setValidator()`, and will also cause route verification and service verification to use different engines.

::::

## Replace verification engine

VextJS uses schema-dsl as the validation engine by default. If you prefer third-party verification libraries such as Zod and Yup, you can replace the built-in verification engine through plug-ins.

### Using Zod Example

```typescript
// src/plugins/zod-validator.ts
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

        // Use Zod verification when the entire location schema is Zod schema
        if (schema instanceof z.ZodType) {
          return (data) => toVextResult(schema.safeParse(data));
        }

        // The current RouteOptions.validate type also supports field-level Zod schema
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

        // Otherwise fall back to default schema-dsl behavior
        return originalValidator.compile(schema);
      },
    };

    app.setValidator(zodValidator);
    app.logger.info("Zod validator plugin activated");
  },
});
```

After replacement, `validate` in routes can be passed in field-level Zod schema objects instead of DSL strings.

## Common patterns

### Pagination query

```typescript
app.get(
  "/posts",
  {
    validate: {
      query: {
        page: "number:1-",
        limit: "number:1-100",
        sort: "createdAt|updatedAt|title",
        order: "asc|desc",
      },
    },
  },
  async (req, res) => {
    const {
      page = 1,
      limit = 20,
      sort = "createdAt",
      order = "desc",
    } = req.valid("query");
    const posts = await app.services.post.findAll({ page, limit, sort, order });
    res.json(posts);
  },
);
```

### Search filter

```typescript
app.get(
  "/products",
  {
    validate: {
      query: {
        keyword: "string?",
        category: "string?",
        minPrice: "number:0-?",
        maxPrice: "number:0-?",
        inStock: "boolean?",
      },
    },
  },
  async (req, res) => {
    const filters = req.valid("query");
    const products = await app.services.product.search(filters);
    res.json(products);
  },
);
```

### User registration

```typescript
app.post(
  "/auth/register",
  {
    validate: {
      body: {
        username: "string:3-30!",
        email: "email!",
        password: "string:8-128!",
        confirmPassword: "string:8-128!",
      },
    },
    override: {
      rateLimit: { max: 3, window: 60 }, // Unit: seconds
    },
  },
  async (req, res) => {
    const data = req.valid("body");

    if (data.password !== data.confirmPassword) {
      app.throw(400, "Two passwords are inconsistent");
    }

    const user = await app.services.auth.register(data);
    res.json(user, 201);
  },
);
```

### File path parameters

```typescript
// src/routes/files/[id].ts
app.get(
  "/",
  {
    validate: {
      param: { id: "string!" },
      query: { download: "boolean?" },
    },
  },
  async (req, res) => {
    const { id } = req.valid("param");
    const { download } = req.valid("query");

    const file = await app.services.file.findById(id);
    if (!file) app.throw(404, "file.not_found");

    if (download) {
      res.download(file.stream, file.name, file.contentType);
    } else {
      res.json(file.metadata);
    }
  },
);
```

## Best Practices

### 1. Always use `req.valid()` instead of `req.body`

Routes configured with `validate` should use `req.valid('body')` instead of directly accessing `req.body`:

```typescript
// ✅ Correct — use verified data
const data = req.valid("body");

// ❌ Avoid — type conversion skipped
const data = req.body;
```

The data returned by `req.valid()` has been type converted (such as `"42"` → `42` in query), and direct access to `req.body` / `req.query` is the original data.

### 2. Reasonable use of required tags

For `query` and `header` positions, usually use optional (`?`); for core fields in `body`, use required (`!`):

```typescript
validate: {
  query: {
    page: 'number:1-', // optional (paging has default value)
    keyword: 'string?', // optional (search keyword)
  },
  body: {
    name: 'string:1-50!', // required (must be provided when creating a resource)
    email: 'email!', // required
    bio: 'string:0-500?', // optional
  },
}
```

### 3. Verification rules are documents

Since validation rules are automatically mapped to OpenAPI documents, writing `validate` is equivalent to writing the interface document. Describe the constraints as precisely as possible:

```typescript
// ✅ Precise constraints — clear documentation and validation
validate: {
  body: {
    username: 'string:3-30!', // 3-30 characters, required
    age: 'number:0-150?', // 0-150, optional
    role: 'admin|editor|viewer!', // Explicit enumeration
  },
}

// ❌ Broad constraints — insufficient documentation information
validate: {
  body: {
    username: 'string!', // No length constraint
    age: 'number?', // no range constraints
    role: 'string!', // Enumeration should be used
  },
}
```

### 4. Use `app.throw()` for custom validation in Handler

DSL syntax cannot cover all verification scenarios (such as cross-field verification, database uniqueness checking). For these scenarios, use `app.throw()` in the handler or service to throw manually:

```typescript
app.post(
  "/users",
  {
    validate: {
      body: { email: "email!", password: "string:8-128!" },
    },
  },
  async (req, res) => {
    const data = req.valid("body");

    // Database uniqueness check - DSL cannot override
    const existing = await app.services.user.findByEmail(data.email);
    if (existing) {
      app.throw(409, "Email has been registered", 10001);
    }

    const user = await app.services.user.create(data);
    res.json(user, 201);
  },
);
```

## Next step

- Understand the global configuration related to verification in [Configuration](/guide/configuration)
- View [OpenAPI Documentation](/guide/openapi) how to link with verification rules
- Learn the complete usage of the three-stage expression in [Routing](/guide/routing)
- Explore [plugins](/guide/plugins) how to replace the validation engine
