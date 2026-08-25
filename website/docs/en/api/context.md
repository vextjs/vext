# Request and response

This page details the complete API of VextJS's request object `VextRequest` and response object `VextResponse`.

## VextRequest

`VextRequest` is the unified request object interface of the framework. Each Adapter is responsible for converting the original request of the underlying framework into this interface, ensuring that the business code does not need to be changed when switching Adapters.

### Public member list

| Properties    | Type                                    | Description                                                                                                                                                                 |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`      | `string`                                | HTTP method (uppercase, such as `'GET'`, `'POST'`)                                                                                                                          |
| `url`         | `string`                                | Full request URL                                                                                                                                                            |
| `path`        | `string`                                | Path part (excluding query string)                                                                                                                                          |
| `route`       | `string`                                | The route template matched by the current request (such as `/users/:id`); the static route is the same as `path`; it is an empty string when no route is matched (404) `''` |
| `params`      | `Record<string, string>`                | Path dynamic parameters                                                                                                                                                     |
| `query`       | `Record<string, string>`                | URL query parameters (parsed)                                                                                                                                               |
| `body`        | `unknown`                               | Request body (populated by body-parser middleware)                                                                                                                          |
| `headers`     | `Record<string, string \| undefined>`   | Request headers (all lowercase keys)                                                                                                                                        |
| `app`         | `VextApp`                               | The application instance to which the current request belongs                                                                                                               |
| `signal`      | `AbortSignal`                           | Aborts when the client connection closes or the route deadline expires; pass it to cancellable downstream work                                                              |
| `requestId`   | `string`                                | Request unique identifier                                                                                                                                                   |
| `ip`          | `string`                                | Client IP                                                                                                                                                                   |
| `protocol`    | `'http' \| 'https'`                     | Request protocol                                                                                                                                                            |
| `cookies`     | `VextCookieJar`                         | Parsed request cookies                                                                                                                                                      |
| `cookie()`    | `(name: string) => string \| undefined` | Read one request cookie                                                                                                                                                     |
| `csrfToken()` | `() => string`                          | Return the current CSRF token; requires the CSRF middleware                                                                                                                 |
| `auth`        | `VextAuthContext`                       | Authentication context; anonymous until populated by auth middleware                                                                                                        |
| `session`     | `VextSession \| undefined`              | Session state when session middleware is enabled                                                                                                                            |
| `t`           | `Function \| undefined`                 | i18n translation function (plug-in injection)                                                                                                                               |
| `files`       | `ParsedFile[] \| undefined`             | File upload list (populated by built-in multipart parsing or a custom upload plugin)                                                                                        |

---

### `method`

HTTP request method, always an uppercase string.

```typescript
app.get("/info", async (req, res) => {
  console.log(req.method); // 'GET'
});
```

---

### `url`

The complete request URL, including path and query string.

```typescript
// Request: GET /users?page=1&limit=10
console.log(req.url); // '/users?page=1&limit=10'
```

---

### `path`

The path portion of the URL, excluding the query string.

```typescript
// Request: GET /users?page=1
console.log(req.path); // '/users'
```

---

### `route`

The route registration template matched by the current request is automatically injected by each Adapter after the route is matched. The difference from `path` is that `path` is the actual request path (high cardinality), and `route` is the routing template (low cardinality).

This is a key property in solving the **high cardinality problem** of metrics systems like Prometheus - metrics should be aggregated by routing templates, not actual paths.

```typescript
// Route registration: app.get('/users/:id', ...)
// Request: GET /users/abc-123

console.log(req.path); // '/users/abc-123' (actual path, high base)
console.log(req.route); // '/users/:id' (route template, low cardinality)✅

// Use req.route as http.route tag in OpenTelemetry / Prometheus
```

| Scenario                                           | `req.path`      | `req.route`         |
| -------------------------------------------------- | --------------- | ------------------- |
| Parameter route `/users/:id`, request `/users/123` | `/users/123`    | `/users/:id`        |
| Static route `/health`, request `/health`          | `/health`       | `/health`           |
| Route not matched (404)                            | `/unknown/path` | `''` (empty string) |

---

### `params`

Path dynamic parameters. Automatically parsed by the route matching engine.

```typescript
// Route: /users/:id/posts/:postId
// Request: GET /users/42/posts/7

app.get("/users/:id/posts/:postId", async (req, res) => {
  console.log(req.params.id); // '42'
  console.log(req.params.postId); // '7'
});
```

:::tip
The value of `params` is always of type string. If a numeric type is required, use `validate` + `req.valid('param')` to obtain the value after automatic type conversion.
:::

---

### `query`

URL query parameters, parsed into key-value pairs.

```typescript
// Request: GET /search?keyword=hello&page=2
app.get("/search", async (req, res) => {
  console.log(req.query.keyword); // 'hello'
  console.log(req.query.page); // '2' (string)
});
```

:::tip
The value of `query` is always of type string. After using `validate` to configure `query` verification, the value after automatic type conversion (such as string `'2'` → number `2`) can be obtained through `req.valid('query')`.
:::

---

### `body`

The request body data is parsed and filled by the built-in `body-parser` middleware.

- Before `body-parser` middleware is executed, `body` is `undefined`
- Supports `application/json` and `application/x-www-form-urlencoded` formats
- You can limit the request body size through `config.bodyParser.maxBodySize`

```typescript
app.post("/users", async (req, res) => {
  console.log(req.body); // { name: 'Alice', email: 'alice@example.com' }
});
```

---

### `headers`

Request header object, all keys are **lowercase**.

```typescript
app.get("/info", async (req, res) => {
  const auth = req.headers.authorization; // 'Bearer eyJ...'
  const ct = req.headers["content-type"]; // 'application/json'
  const custom = req.headers["x-custom"]; // Custom request headers
});
```

---

### `app`

The `VextApp` application instance to which the current request belongs.

Route handlers usually access `app` directly through the closure of `defineRoutes`. But **routing-level middleware** does not have closures, and the framework capabilities must be accessed through `req.app`:

```typescript
//Access through req.app in middleware
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, _res, next) => {
  req.app.logger.info("Middleware is executing");

  if (!req.headers.authorization) {
    req.app.throw(401, "Authentication token not provided");
  }

  await next();
});
```

Capabilities accessible via `req.app`:

| Properties/Methods | Description               |
| ------------------ | ------------------------- |
| `req.app.logger`   | Structured log            |
| `req.app.throw()`  | Throw HTTP error          |
| `req.app.config`   | Runtime configuration     |
| `req.app.services` | Injected service instance |
| `req.app.fetch`    | Built-in HTTP client      |

---

### `signal`

An `AbortSignal` bound to the request lifecycle. It is aborted when the client connection closes. When the route timeout middleware is active, its deadline signal is combined with the connection signal, so downstream work observes either cancellation source.

Pass the signal to APIs that support cancellation and still stop mutating application or response state after it is aborted:

```typescript
app.get("/report", async (req, res) => {
  const upstream = await fetch("https://example.com/report", {
    signal: req.signal,
  });
  res.json(await upstream.json());
});
```

---

### `requestId`

Request unique identifier for log correlation and distributed link tracing.

Generate rules:

1. Prioritize transparent transmission from the request header `x-request-id` (configurable) (applicable to scenarios where the gateway/proxy has generated an ID)
2. When the request header does not exist, the framework automatically generates UUID v4
3. You can customize the generation algorithm through `config.requestId.generate` or `app.setRequestIdGenerator()`

```typescript
app.get("/info", async (req, res) => {
  console.log(req.requestId); // '550e8400-e29b-41d4-a716-446655440000'

  // The log automatically carries requestId (through AsyncLocalStorage)
  req.app.logger.info("Processing request");
  // → { requestId: '550e8400-...', msg: 'Processing request' }
});
```

---

### `ip`

Client IP address.

| `config.trustProxy` | Behavior                                                    |
| ------------------- | ----------------------------------------------------------- |
| `false` (default)   | Read from the underlying socket's `remoteAddress`           |
| `true`              | Read the first IP from the `X-Forwarded-For` request header |

```typescript
app.get("/info", async (req, res) => {
  console.log(req.ip); // '192.168.1.100'
});
```

:::warning
When deployed behind a reverse proxy (Nginx/Cloud Load Balancer), `trustProxy: true` must be set, otherwise `req.ip` is always the IP of the proxy server.
:::

---

### `protocol`

Request agreement.

| `config.trustProxy` | Behavior                                     |
| ------------------- | -------------------------------------------- |
| `false` (default)   | Always return `'http''                       |
| `true`              | Read from `X-Forwarded-Proto` request header |

```typescript
app.get("/info", async (req, res) => {
  console.log(req.protocol); // 'https'
});
```

---

### `valid(location)`

Get the data after `validate` verification and type conversion.

```typescript
type VextValidationLocation = "query" | "body" | "param" | "header" | "cookie";

interface VextRequest<
  TValidated extends Record<VextValidationLocation, unknown>,
> {
  valid<
    TOverride = never,
    TLocation extends VextValidationLocation = VextValidationLocation,
  >(
    location: TLocation,
  ): [TOverride] extends [never] ? TValidated[TLocation] : TOverride;
}
```

`TValidated` is generated from the `validate` object on the current route.
The public API also keeps an explicit generic override for dynamic or external
schemas, but ordinary route code should rely on the inferred contract.

**Parameters**:

| Parameters | Type                                                   | Description                |
| ---------- | ------------------------------------------------------ | -------------------------- |
| `location` | `'query' \| 'body' \| 'param' \| 'header' \| 'cookie'` | Verification data location |

**`location` and data source mapping**:

| location   | data source   | description             |
| ---------- | ------------- | ----------------------- |
| `'query'`  | `req.query`   | URL query parameters    |
| `'body'`   | `req.body`    | Request body            |
| `'param'`  | `req.params`  | Path dynamic parameters |
| `'header'` | `req.headers` | Request headers         |
| `'cookie'` | `req.cookies` | Parsed Cookie values    |

:::tip
Note that `location` uses the **singular** `'param'` (consistent with the key configured in `validate`), but the underlying data source is the **plural** `req.params`. The framework maps them correctly.
:::

**Basic Usage**:

```typescript
app.get(
  "/users",
  {
    validate: {
      query: { page: "number:1-!", limit: "number:1-100!" },
    },
  },
  async (req, res) => {
    const { page, limit } = req.valid("query");
    // page: number (automatically converted from string '1' to number 1)
    // limit: number
  },
);
```

**Automatic inference**:

```typescript
const query = req.valid("query");
// query.page  → number
// query.limit → number
```

If a route does not declare the requested location, its inferred result is
`undefined`. Chainable field builders are inferred as `unknown`; use a runtime
type guard or an explicit override only when the application owns that dynamic
contract.

**Multiple location verification**:

```typescript
app.put(
  "/users/:id",
  {
    validate: {
      param: { id: "string:1-" },
      body: { name: "string:1-50", email: "email" },
      query: { notify: "boolean?" },
    },
  },
  async (req, res) => {
    const { id } = req.valid("param");
    const body = req.valid("body");
    const { notify } = req.valid("query");
  },
);
```

:::warning
The corresponding location must be configured in `options.validate` before `req.valid()` can be called. Calling `req.valid()` in an unconfigured location returns `undefined`.
:::

---

### `onClose(handler)`

Register request shutdown hook, triggered when the client disconnects.

```typescript
function onClose(handler: () => void): void;
```

Mainly used in long-term connection scenarios such as SSE / WebSocket, and cleans up resources when the client disconnects:

```typescript
app.get("/sse", async (req, res) => {
  const stream = createSSEStream();

  req.onClose(() => {
    stream.close();
    console.log("Client disconnected");
  });

  res.stream(stream, "text/event-stream");
});
```

:::tip
The framework will automatically clear the hooks array after the hooks are executed. There is no need to manually remove it, and there will be no memory leaks caused by closure references.
:::

---

### `t(key, params?)`

i18n translation function, injected by i18n plugin. `undefined` when i18n is not enabled.

```typescript
function t(key: string, params?: Record<string, unknown>): string;
```

**Usage**:

```typescript
app.get("/greeting", async (req, res) => {
  if (req.t) {
    const message = req.t("welcome", { name: "Alice" });
    // → 'Welcome, Alice' (Chinese) or 'Welcome, Alice' (English)
    res.json({ message });
  }
});
```

---

### `files`

File upload list, initially `undefined`. Vext populates it when built-in multipart parsing is enabled globally through `config.multipart.enabled` or for one route through `multipart.enabled: true`. A route may set `multipart.enabled: false` to opt out even when global parsing is enabled. Built-in parsing keeps the request body and each `buffer` in memory; it does not create framework-managed temporary files, a temp directory, TTL, or periodic cleanup job. Custom upload plugins can also populate this field when they need streaming writes, durable storage, or third-party parsers.

```typescript
interface ParsedFile {
  fieldname: string; // form field name
  filename: string; // Upload file name
  mimetype: string; // MIME type, such as 'image/png'
  buffer: Buffer; //Original content of the file
  size: number; //The number of bytes in the file
}
```

```typescript
app.post(
  "/upload",
  {
    multipart: {
      enabled: true,
      maxFileSize: 10 * 1024 * 1024,
      files: {
        file: { description: "Document file", required: true },
      },
    },
  },
  async (req, res) => {
    const file = req.files?.find((item) => item.fieldname === "file");
    res.json({ filename: file?.filename, size: file?.size });
  },
);
```

`multipart.files` also drives OpenAPI `multipart/form-data` requestBody generation and required-file runtime checks. Uploads still obey `maxFiles`, `maxFileSize`, and `allowedMimeTypes`.

---

### `_getRawBodyBuffer()`

> ℹ️ This is an internal method of the framework, mainly used by plug-in developers.

```typescript
_getRawBodyBuffer(): Promise<Buffer>
```

Returns a `Buffer` of the original request body. Each adapter is guaranteed to consume the data stream only once, and the results are cached internally. Built-in multipart parsing uses this internally; plugin authors can use it to implement a custom upload parser:

```typescript
// Plug-in example (use busboy to parse multipart/form-data)
import { createBusboy } from "busboy";
import type { ParsedFile } from "vextjs";

export default definePlugin(async (app) => {
  app.use(async (req, _res, next) => {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.startsWith("multipart/form-data")) {
      await next();
      return;
    }

    const rawBuffer = await req._getRawBodyBuffer();
    const files: ParsedFile[] = await parseMultipart(rawBuffer, ct);
    req.files = files;
    await next();
  });
});
```

---

### Extended fields

Middleware and plugins can mount custom fields on `req`. Type hints are available through the `declare module` extension interface:

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextRequest {
    user?: {
      id: string;
      role: "admin" | "user";
    };
  }
}
```

```typescript
// Set in middleware
export default defineMiddleware(async (req, _res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  req.user = await verifyToken(token);
  await next();
});

// used in handler
app.get("/profile", { middlewares: ["load-user"] }, async (req, res) => {
  res.json(req.user); // IDE knows the type is { id: string; role: 'admin' | 'user' }
});
```

---

## VextResponse

`VextResponse` is the unified response object interface of the framework. Provides JSON response, text response, streaming response, redirection and other capabilities.

### List of methods

| Method                                       | Return Value | Description                                    |
| -------------------------------------------- | ------------ | ---------------------------------------------- |
| `json(data, status?)`                        | `void`       | Returns a JSON response (wrapped for export)   |
| `render(page, props?, options?)`             | `void`       | Render a built-in frontend page                |
| `renderError(error?, page?, options?)`       | `void`       | Render the configured frontend error page      |
| `text(content, status?)`                     | `void`       | Return plain text response                     |
| `stream(readable, contentType?)`             | `void`       | Streaming response                             |
| `download(readable, filename, contentType?)` | `void`       | File download                                  |
| `redirect(url, status?)`                     | `void`       | Redirect                                       |
| `status(code)`                               | `this`       | Set status code (chain call)                   |
| `setHeader(name, value)`                     | `this`       | Set response header (chain call)               |
| `cookie(name, value, options?)`              | `this`       | Append a `Set-Cookie` response header          |
| `clearCookie(name, options?)`                | `this`       | Expire a response cookie                       |
| `statusCode`                                 | `number`     | Current status code (read-only)                |
| `headersSent`                                | `boolean`    | Whether response headers were sent (read-only) |
| `sse()`                                      | `unknown`    | Optional SSE plugin extension                  |
| `upgrade()`                                  | `unknown`    | Optional WebSocket/upgrade plugin extension    |

`render()` and `renderError()` are bound by the built-in frontend renderer. `sse()` and `upgrade()` are optional extension points and are available only when the corresponding plugin installs them. Cookie methods append separate `Set-Cookie` headers and preserve multiple cookies.

---

### `json(data, status?)`

Returns a JSON response. This is the most common response method.

```typescript
function json(data: unknown, status?: number): void;
```

**Parameters**:

| Parameters | Type      | Default value | Description                 |
| ---------- | --------- | ------------- | --------------------------- |
| `data`     | `unknown` | —             | Business data               |
| `status`   | `number`  | `200`         | HTTP status code (optional) |

**Export Packaging**:

When `config.response.wrap` is `true` (default), `res.json(data)` is automatically wrapped:

```typescript
res.json({ id: 1, name: "Alice" });
// Actual response:
// {
// "code": 0,
// "data": { "id": 1, "name": "Alice" },
// "requestId": "550e8400-e29b-41d4-a716-446655440000"
// }
```

When `config.response.wrap` is `false`, send raw data directly:

```typescript
res.json({ id: 1, name: "Alice" });
// Actual response:
// { "id": 1, "name": "Alice" }
```

**Specify status code**:

```typescript
// 201 Created
res.json(newUser, 201);

// You can also use chain calls
res.status(201).json(newUser);
```

**204 No Content**：

Regardless of whether the wrapper is opened or not, the `204` status code does not send the message body (conforming to RFC 9110 §15.3.5):

```typescript
res.status(204).json(null);
// Response: 204 No Content (no body)
```

**Error response** (usually handled automatically by the framework error-handler):

```json
{
  "code": 10001,
  "message": "User does not exist",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### `text(content, status?)`

Returns a plain text response, **without export wrapping**.

```typescript
function text(content: string, status?: number): void;
```

```typescript
app.get("/health", async (_req, res) => {
  res.text("OK");
});

app.get("/version", async (_req, res) => {
  res.text("v1.0.0", 200);
});
```

Automatically set `Content-Type: text/plain; charset=utf-8`.

---

### `stream(readable, contentType?)`

Streaming responses for large file transfers or real-time data streaming.

```typescript
function stream(readable: NodeJS.ReadableStream, contentType?: string): void;
```

**Parameters**:

| Parameters    | Type                    | Default value                | Description             |
| ------------- | ----------------------- | ---------------------------- | ----------------------- |
| `readable`    | `NodeJS.ReadableStream` | —                            | Node.js readable stream |
| `contentType` | `string`                | `'application/octet-stream'` | MIME type               |

```typescript
import { createReadStream } from "node:fs";

app.get("/large-file", async (_req, res) => {
  const stream = createReadStream("/path/to/large-file.csv");
  res.stream(stream, "text/csv");
});
```

**SSE (Server-Sent Events)**:

```typescript
app.get("/events", async (req, res) => {
  const stream = new ReadableStream({
    start(controller) {
      const interval = setInterval(() => {
        controller.enqueue(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
      }, 1000);

      req.onClose(() => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  res.stream(stream, "text/event-stream");
});
```

---

### `download(readable, filename, contentType?)`

In file download responses, the `Content-Disposition: attachment` header is automatically set. ASCII-safe filenames keep the plain `filename` output; filenames containing non-ASCII characters, quotes, path separators, or control characters get a safe fallback plus a UTF-8 `filename*` value.

```typescript
function download(
  readable: NodeJS.ReadableStream,
  filename: string,
  contentType?: string,
): void;
```

**Parameters**:

| Parameters    | Type                    | Default value                | Description                                                                       |
| ------------- | ----------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `readable`    | `NodeJS.ReadableStream` | —                            | File stream                                                                       |
| `filename`    | `string`                | —                            | Download file name (displayed by browser and safely encoded for response headers) |
| `contentType` | `string`                | `'application/octet-stream'` | MIME type                                                                         |

```typescript
import { createReadStream } from "node:fs";

app.get("/export", async (_req, res) => {
  const stream = createReadStream("/path/to/report.xlsx");
  res.download(
    stream,
    "report-2026.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});
```

After the browser receives the response, a file download dialog box will pop up.

---

### `redirect(url, status?)`

HTTP redirect.

```typescript
function redirect(url: string, status?: 301 | 302 | 307 | 308): void;
```

**Parameters**:

| Parameters | Type                       | Default value | Description          |
| ---------- | -------------------------- | ------------- | -------------------- |
| `url`      | `string`                   | —             | Target URL           |
| `status`   | `301 \| 302 \| 307 \| 308` | `302`         | Redirect status code |

```typescript
// Temporary redirect (302)
res.redirect("/new-page");

// Permanent redirect (301)
res.redirect("/new-permanent-page", 301);

// Temporary redirection retention method (307)
res.redirect("/api/v2/users", 307);

// Permanent redirection retention method (308)
res.redirect("/api/v2/users", 308);
```

**Redirect status code description**:

| Status code | Description                  | Whether to keep the HTTP method |
| ----------- | ---------------------------- | ------------------------------- |
| `301`       | Permanent redirect           | No (may become GET)             |
| `302`       | Temporary redirect (default) | No (may become GET)             |
| `307`       | Temporary redirection        | Yes                             |
| `308`       | Permanent redirect           | Yes                             |

---

### `status(code)`

Set HTTP status code and support chain calls.

```typescript
function status(code: number): this;
```

```typescript
//Chain call
res.status(201).json(newUser);
res.status(204).json(null);
res.status(404).json({ message: "Not found" });
```

If `status()` is not called, the default status code is `200`. It can also be set directly through the second parameter of `json(data, status)`.

---

### `setHeader(name, value)`

Set response headers to support chain calls.

```typescript
function setHeader(name: string, value: string): this;
```

```typescript
res
  .setHeader("X-Custom-Header", "custom-value")
  .setHeader("Cache-Control", "no-cache")
  .json(data);
```

**Common response headers**:

```typescript
// cache control
res.setHeader("Cache-Control", "public, max-age=3600");

//Content processing
res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');

// route-specific response metadata
res.setHeader("X-Request-Scope", "public");

// Use config.securityHeaders for standard browser security headers.

// Custom business header
res.setHeader("X-RateLimit-Remaining", "95");
```

---

### `statusCode` (read-only)

Get the current HTTP status code.

```typescript
readonly statusCode: number;
```

Mainly used for **onion model after-middleware**, reading the response status code after `await next()`:

```typescript
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const start = Date.now();

  await next(); // handler execution completed

  const duration = Date.now() - start;
  console.log(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  // GET /users → 200 (12ms)
});
```

---

## VextPublicResponse

User-visible response type that omits `rawJson()` and every underscore-prefixed internal method:

```typescript
type VextPublicResponse = Omit<
  VextResponse,
  "rawJson" | Extract<keyof VextResponse, `_${string}`>
>;
```

Route handlers currently receive `VextResponse`, which includes internal methods. Application code normally does not need those APIs; `VextPublicResponse` is intended for wrappers and extensions that expose only the stable public response surface.

---

## Internal method (not recommended for direct use)

### `rawJson(data, status?)`

Returns raw JSON, without export wrapping. For use by the framework's internal `error-handler` only.

```typescript
function rawJson(data: unknown, status?: number): void;
```

```typescript
//Use error-handler inside the framework
res.rawJson(
  {
    code: -1,
    message: "Internal Server Error",
    requestId: req.requestId,
  },
  500,
);
```

:::warning
User code should not call `rawJson()` directly. To bypass egress wrapping, set `config.response.wrap: false` and then use standard `res.json()`.
:::

### `_enableWrap()`

Turn on the export packaging sign. Only called by the built-in `response-wrapper` middleware.

```typescript
function _enableWrap(): void;
```

After the call, subsequent `json()` calls will automatically wrap the response body into the `{ code: 0, data, requestId }` format.

---

## Usage mode

### Standard CRUD response

```typescript
export default defineRoutes((app) => {
  // List query
  app.get("/list", async (req, res) => {
    const items = await app.services.item.findAll();
    res.json(items);
    // → { code: 0, data: [...], requestId: '...' }
  });

  // create
  app.post("/", async (req, res) => {
    const item = await app.services.item.create(req.valid("body"));
    res.json(item, 201);
    // → 201 { code: 0, data: { id: '...' }, requestId: '...' }
  });

  // update
  app.put("/:id", async (req, res) => {
    const item = await app.services.item.update(
      req.valid("param").id,
      req.valid("body"),
    );
    res.json(item);
  });

  // delete
  app.delete("/:id", async (req, res) => {
    await app.services.item.delete(req.valid("param").id);
    res.status(204).json(null);
    // → 204 No Content
  });
});
```

### Error handling

```typescript
export default defineRoutes((app) => {
  app.get("/:id", async (req, res) => {
    const user = await app.services.user.findById(req.params.id);

    if (!user) {
      // Automatically captured by the framework and converted to standard error response
      app.throw(404, "User does not exist");
    }

    res.json(user);
  });
});
```

Errors thrown by `app.throw()` are uniformly captured by the framework `error-handler` middleware and converted into standard error responses:

```json
{
  "code": 404,
  "message": "User does not exist",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

If you need to actively return an explicit HTTP error, use `app.throw(...)`. If there is an unexpected runtime failure, you can also directly `throw new Error("...")`, and the framework will capture it as 500; when `response.hideInternalErrors = false`, the JSON 500 response in the development environment will be additionally accompanied by `stack`.

### Custom response header + status code

```typescript
app.post("/upload", async (req, res) => {
  const result = await processUpload(req.body);
  res
    .status(201)
    .setHeader("Location", `/files/${result.id}`)
    .setHeader("X-File-Size", String(result.size))
    .json(result);
});
```

### Streaming file download

```typescript
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";

app.get("/download/:filename", async (req, res) => {
  const filepath = join("/data/files", req.params.filename);

  try {
    const stat = statSync(filepath);
    const stream = createReadStream(filepath);

    res
      .setHeader("Content-Length", String(stat.size))
      .download(stream, req.params.filename);
  } catch {
    app.throw(404, "File does not exist");
  }
});
```

### Conditional response

```typescript
app.get("/users/:id", async (req, res) => {
  const user = await app.services.user.findById(req.valid("param").id);

  if (!user) {
    app.throw(404, "User does not exist");
  }

  //Determine the response format based on the request header
  if (req.headers.accept === "text/plain") {
    res.text(`User: ${user.name} <${user.email}>`);
  } else {
    res.json(user);
  }
});
```

---

## Requests and responses in middleware

### Onion model

Middleware implements the onion model through `await next()`, which can handle requests and responses before and after the handler is executed:

```typescript
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  // ── before handler ──
  const start = Date.now();
  req.app.logger.info({ method: req.method, path: req.path }, "Request starts");

  await next(); // Execute handler (and subsequent middleware)

  // ── after handler ──
  const duration = Date.now() - start;
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

### Modify request

Middleware can modify the request object before `next()`:

```typescript
export default defineMiddleware(async (req, _res, next) => {
  // Parse JWT and inject user information
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    req.user = await verifyJWT(token);
  }
  await next();
});
```

### Short circuit response

Middleware can return the response directly without calling `next()` (short circuit):

```typescript
export default defineMiddleware(async (req, res, next) => {
  if (isBlacklisted(req.ip)) {
    res.status(403).json({ message: "Access Denied" });
    return; // If next() is not called, the handler will not be executed.
  }
  await next();
});
```

---

## Type import

```typescript
import type { VextRequest, VextResponse, VextPublicResponse } from "vextjs";
```

These types usually do not need to be imported explicitly - the types of `req` and `res` are automatically inferred by TypeScript in the callbacks of `defineRoutes` and `defineMiddleware`. Explicitly imported types are only necessary when writing stand-alone utility functions:

```typescript
import type { VextRequest } from "vextjs";

function extractUser(req: VextRequest) {
  return req.user;
}
```
