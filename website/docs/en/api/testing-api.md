# Test tools

This page details VextJS's testing tool API, including `createTestApp`, `TestApp`, `TestRequest`, `TestRequestBuilder` and `TestResponse`.

## Overview

VextJS provides zero-configuration testing tools, imported through the `vextjs/testing` subpath:

```typescript
import { createTestApp } from "vextjs/testing";
```

**Core Design**:

- **Zero network I/O**: `TestRequest` does not start the HTTP server internally, directly constructs the `(req, res)` handler through `adapter.buildHandler()`, and uses the Mock object in memory to simulate the request. Faster than `supertest`, can be run in parallel in CI without port conflicts.
- **Zero Configuration**: Rate limiting is disabled and logging is silent by default. `TestRequest` does not open an HTTP listener; `port: 0` is only an isolated test configuration default.
- **Chained API**: A chained request constructor similar to `supertest` style, supporting `await` to directly obtain the response.
- **Safe Exit**: `config._testMode = true` prevents `shutdown()` from calling `process.exit(0)`.

---

## createTestApp

`createTestApp` is a test App factory function that creates a complete test application instance.

### Function signature

```typescript
async function createTestApp(options?: CreateTestAppOptions): Promise<TestApp>;
```

### Basic usage

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("User Interface", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("GET /users/list should return a list of users", async () => {
    testApp = await createTestApp();

    const res = await testApp.request
      .get("/users/list")
      .query({ page: "1", limit: "10" });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
```

### Return value

Returns `Promise<TestApp>`, containing three members: `app`, `request` and `close`.

---

## CreateTestAppOptions

Configuration options for `createTestApp`. All fields are optional.

```typescript
interface CreateTestAppOptions {
  config?: VextConfigOverride;
  plugins?: boolean;
  setupPlugins?: (app: VextApp) => Promise<void> | void;
  services?: boolean;
  mockServices?: Partial<VextServices>;
  routes?: boolean;
  middlewares?: boolean;
  rootDir?: string;
  devOverlay?: (error: unknown) => string;
}
```

### Field description

| Field          | Type                         | Default Value   | Description                                                                    |
| -------------- | ---------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `config`       | `VextConfigOverride`         | `{}`            | Later-layer patch merged over framework and test defaults                      |
| `plugins`      | `boolean`                    | `false`         | Whether to load `src/plugins/` (not loaded by default in the test environment) |
| `setupPlugins` | `Function`                   | `undefined`     | Manually register plugins (replacing automatic scanning)                       |
| `services`     | `boolean`                    | `true`          | Whether to load `src/services/`                                                |
| `mockServices` | `Partial<VextServices>`      | `undefined`     | Manually inject mock services                                                  |
| `routes`       | `boolean`                    | `true`          | Whether to load `src/routes/`                                                  |
| `middlewares`  | `boolean`                    | `true`          | Whether to load `src/middlewares/`                                             |
| `rootDir`      | `string`                     | `process.cwd()` | Project root directory (used to locate the `src/` subdirectory)                |
| `devOverlay`   | `(error: unknown) => string` | `undefined`     | Optional HTML error renderer when the request accepts `text/html`              |

---

### `config`

Patch framework and test defaults using the same path-aware deep-merge semantics
as profile/local configuration. Nested plain objects already present in those
defaults may be partial; atomic adapters, stores, callbacks, and arrays remain
complete values. `createTestApp()` does not load the project's
`src/config/default.ts`, and its built-in defaults do not include `database`, so
adding that optional section requires a complete database configuration rather
than a partial patch.

```typescript
testApp = await createTestApp({
  config: {
    adapter: "fastify", // test specific adapter
    response: { wrap: false }, // Disable export wrapping
    cors: { enabled: false }, // Disable CORS
  },
});
```

**Testing the default configuration** (automatically applied, no manual settings required):

```typescript
{
  port: 0, // Isolated test configuration; TestRequest does not listen
  host: '127.0.0.1',
  logger: { level: 'silent' }, // Log silently
  rateLimit: {
    enabled: false, // disable current limiting
    max: 100,
    window: 60,
    message: 'Too Many Requests',
    keyBy: 'ip',
  },
  accessLog: { enabled: false }, // Disable request log noise
  session: { enabled: false }, // Same opt-in default as the app runtime
  shutdown: { timeout: 1 }, // Quick shutdown (1 second)
  _testMode: true, // prevent process.exit()
}
```

Merge priority from lowest to highest is `DEFAULT_CONFIG` → `test defaults` → `config parameters`. Explicitly setting `rateLimit.enabled`, `accessLog.enabled`, or `session.enabled` to `true` registers the same built-in runtime used by production and development.

`TestRequest` invokes the built handler directly, so its requests never bind or connect to this port.

---

### `plugins`

Controls whether to automatically scan the `src/plugins/` directory to load plugins.

```typescript
//Plug-ins are not loaded by default (unit tests usually do not require real plug-ins)
testApp = await createTestApp(); // plugins: false// Integration testing may require loading plugins
testApp = await createTestApp({ plugins: true });
```

---

### `setupPlugins`

Manually register plug-ins instead of automatic scanning. Suitable for scenarios where precise control of test dependencies is required.

```typescript
testApp = await createTestApp({
  setupPlugins: async (app) => {
    //Only register the plug-ins required for testing
    app.extend("testCache", new MockCache());
    app.extend("db", new MockDatabase());
  },
});
```

:::tip
`setupPlugins` is used to replace automatic scanning: when `setupPlugins` is passed in, the test tool only executes this function and no longer reads the file system scan triggered by `plugins: true`. If you need real plug-ins, please use `plugins: true`; if you need precise control of test dependencies, please only use `setupPlugins`.
:::

---

### `services`

Controls whether to automatically load services in the `src/services/` directory.

```typescript
//Load the real service (default, recommended for integration testing)
testApp = await createTestApp(); // services: true

// Do not load the service (unit testing recommendation: use mockServices instead)
testApp = await createTestApp({
  services: false,
  mockServices: {
    user: {
      findAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue({ id: "1", name: "Test User" }),
    },
  },
});
```

#### TypeScript service file loading mechanism

When `services: true`, `service-loader` scans the `src/services/` directory and automatically loads `.ts` source files. Due to two limitations of Node.js native ESM, the framework uses **esbuild** to automatically handle them:

| Limitations                       | Description                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ERR_UNKNOWN_FILE_EXTENSION: .ts` | Node.js native ESM does not support direct `import()` `.ts` files                                                                    |
| `.js → .ts` remapping missing     | TypeScript ESM convention is to write `.js` extension in import, and Node.js/Vite resolver will not automatically fall back to `.ts` |

`service-loader` performs the following process for each `.ts` service file:

1. Call `esbuild.build({ bundle: true, packages: 'external' })` to package `.ts` and its local relative dependencies into `.mjs`
2. Write the compiled product to a temporary file in the same directory as the source file (the name contains `.__vext_compiled__` and will not be scanned repeatedly)
3. `import()` temporary `.mjs` file, automatically cleaned after completion

:::tip Recommendation for unit testing: use mockServices first
The `services: false` + `mockServices` solution does not require esbuild compilation, is faster and has better isolation, and is the recommended method for **unit testing**. `services: true` is suitable for **integration tests** that require real service behavior.
:::

---

### `mockServices`

Manually inject the mock service and overwrite the `service-loader` scan results.

```typescript
const mockUserService = {
  findAll: vi.fn().mockResolvedValue([
    { id: "1", name: "Alice" },
    { id: "2", name: "Bob" },
  ]),
  findById: vi.fn().mockResolvedValue({ id: "1", name: "Alice" }),
  create: vi.fn().mockImplementation(async (data) => ({
    id: "3",
    ...data,
  })),
  update: vi.fn().mockResolvedValue({ id: "1", name: "Updated" }),
  delete: vi.fn().mockResolvedValue(undefined),
};

testApp = await createTestApp({
  mockServices: {
    user: mockUserService,
  },
});
```

**Merge Logic**:

| `services` | `mockServices` | behavior                                                                                         |
| :--------: | :------------: | ------------------------------------------------------------------------------------------------ |
|   `true`   |     Valid      | Load the real service first, then use `mockServices` to overwrite the service with the same name |
|   `true`   |    No value    | Only use real services                                                                           |
|  `false`   |   has value    | only use `mockServices`                                                                          |
|  `false`   |    No value    | `app.services` is an empty object `{}`                                                           |

---

### `routes`

Controls whether to automatically load routing files in the `src/routes/` directory.

```typescript
//Load the real route (default, integration test)
testApp = await createTestApp(); // routes: true

// Do not load routes (routing is not required when unit testing the service layer)
testApp = await createTestApp({ routes: false });
```

---

### `middlewares`

Controls whether to automatically load user middleware in the `src/middlewares/` directory.

```typescript
//Load user middleware (default)
testApp = await createTestApp(); // middlewares: true

// Skip user middleware loading (when testing does not involve routing-level middleware)
testApp = await createTestApp({ middlewares: false });
```

:::tip
The built-in middlewares (requestId/cors/bodyParser/responseWrapper/errorHandler) are always registered regardless of the `middlewares` setting. This option only controls user-defined middleware in the `src/middlewares/` directory.
:::

---

### `rootDir`

The project root directory is used to locate `src/routes`, `src/services`, `src/plugins` and other directories.

```typescript
import { join } from "node:path";

testApp = await createTestApp({
  rootDir: join(__dirname, "../../"), // Customize the project root directory
});
```

---

## TestApp

The test application instance returned by `createTestApp`.

```typescript
interface TestApp {
  app: VextApp;
  request: TestRequest;
  close(): Promise<void>;
}
```

### `app`

The underlying `VextApp` instance, which can be used to directly access application capabilities:

```typescript
const testApp = await createTestApp();

//Access configuration
console.log(testApp.app.config.port);

//Access service
const user = await testApp.app.services.user.findById("1");

//Access log
testApp.app.logger.info("under testing");
```

### `request`

HTTP request simulator, similar to `supertest` style API. See [TestRequest](#testrequest) for details.

### `close()`

Close the test application, trigger the `onClose` hook, and clean up resources.

```typescript
close(): Promise<void>;
```

:::warning
**Be sure to call `close()`** in `afterEach` or `afterAll`, otherwise it will cause resource leaks (database connections, timers, etc.) and the test process cannot exit.
:::

```typescript
import { afterEach } from "vitest";

let testApp;

afterEach(async () => {
  await testApp?.close();
});
```

---

## TestRequest

HTTP request simulator, providing a chained API similar to `supertest` style.

```typescript
interface TestRequest {
  get(path: string): TestRequestBuilder;
  post(path: string): TestRequestBuilder;
  put(path: string): TestRequestBuilder;
  patch(path: string): TestRequestBuilder;
  delete(path: string): TestRequestBuilder;
  options(path: string): TestRequestBuilder;
  head(path: string): TestRequestBuilder;
}
```

### Supported HTTP methods

| Method                  | Description          |
| ----------------------- | -------------------- |
| `request.get(path)`     | Send GET request     |
| `request.post(path)`    | Send POST request    |
| `request.put(path)`     | Send PUT request     |
| `request.patch(path)`   | Send PATCH request   |
| `request.delete(path)`  | Send DELETE request  |
| `request.options(path)` | Send OPTIONS request |
| `request.head(path)`    | Send HEAD request    |

Each method returns `TestRequestBuilder`, which supports chain configuration and execution of requests through `await`.

:::note HEAD responses
`request.head(path)` follows HTTP HEAD semantics. The response status and headers are preserved, but `TestResponse.text` and `TestResponse.body` are empty even when the route handler writes a body. Use the matching `GET` route when you need to assert the response body.
:::

### Basic usage

```typescript
// GET request
const res = await testApp.request.get("/users/list");

// POST request
const res = await testApp.request.post("/users").send({
  name: "Alice",
  email: "alice@example.com",
});

// PUT request
const res = await testApp.request.put("/users/1").send({
  name: "Alice Updated",
});

// DELETE request
const res = await testApp.request.delete("/users/1");

// OPTIONS request (CORS preflight)
const res = await testApp.request.options("/users");
```

---

## TestRequestBuilder

The chained request constructor supports setting request headers, query parameters, request bodies, etc., and finally executes the request through `await` or `.then()`.

```typescript
interface TestRequestBuilder extends PromiseLike<TestResponse> {
  set(key: string, value: string): this;
  headers(headers: Record<string, string>): this;
  query(params: Record<string, string | number | boolean>): this;
  send(body: unknown): this;
  type(contentType: string): this;
}
```

:::tip
`TestRequestBuilder` implements the `PromiseLike` interface, so you can directly use `await` to execute the request without calling an additional `.execute()` method.
:::

---

### `set(key, value)`

Set a single request header.

```typescript
set(key: string, value: string): this;
```

```typescript
const res = await testApp.request
  .get("/profile")
  .set("Authorization", "Bearer eyJ...")
  .set("Accept-Language", "zh-CN");

expect(res.status).toBe(200);
```

---

### `headers(headers)`

Set multiple request headers (in object form).

```typescript
headers(headers: Record<string, string>): this;
```

```typescript
const res = await testApp.request.get("/profile").headers({
  Authorization: "Bearer eyJ...",
  "Accept-Language": "zh-CN",
  "X-Custom-Header": "custom-value",
});
```

:::tip
`set()` and `headers()` can be used together, and the value set later will overwrite the request header with the same name set first.
:::

---

### `query(params)`

Set URL query parameters.

```typescript
query(params: Record<string, string | number | boolean>): this;
```

Parameter values are automatically converted to strings and URL encoded.

```typescript
const res = await testApp.request
  .get("/users/list")
  .query({ page: 1, limit: 10, active: true });
// Equivalent to GET /users/list?page=1&limit=10&active=true

expect(res.status).toBe(200);
expect(res.body.data).toHaveLength(10);
```

Calling `query()` multiple times merges parameters:

```typescript
const res = await testApp.request
  .get("/search")
  .query({ keyword: "hello" })
  .query({ page: 1 });
// Equivalent to GET /search?keyword=hello&page=1
```

---

### `send(body)`

Set the request body. Automatically serialize to JSON and set `Content-Type: application/json`.

```typescript
send(body: unknown): this;
```

```typescript
// JSON object
const res = await testApp.request
  .post("/users")
  .send({ name: "Alice", email: "alice@example.com" });

expect(res.status).toBe(201);
expect(res.body.data.name).toBe("Alice");
```

```typescript
// Nested objects
const res = await testApp.request.post("/orders").send({
  items: [
    { productId: "p1", quantity: 2 },
    { productId: "p2", quantity: 1 },
  ],
  shippingAddress: {
    city: "Beijing",
    street: "xxx Road, Chaoyang District",
  },
});
```

```typescript
// String (send directly without JSON serialization)
const res = await testApp.request
  .post("/webhook")
  .type("text/plain")
  .send("raw text body");
```

---

### `type(contentType)`

Set the `Content-Type` request header.

```typescript
type(contentType: string): this;
```

```typescript
// send form-urlencoded
const res = await testApp.request
  .post("/login")
  .type("application/x-www-form-urlencoded")
  .send("username=alice&password=secret");

//Send XML
const res = await testApp.request
  .post("/xml-endpoint")
  .type("application/xml")
  .send("<user><name>Alice</name></user>");
```

:::tip
`send()` automatically sets `Content-Type: application/json` if it is not already set. If another type is required, call `type()` before `send()` to override it.
:::

---

### Chain combination

All methods support chained calls, and the request is ultimately executed through `await`:

```typescript
const res = await testApp.request
  .post("/users")
  .set("Authorization", "Bearer eyJ...")
  .set("X-Request-Id", "test-req-001")
  .query({ notify: "true" })
  .type("application/json")
  .send({
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

expect(res.status).toBe(201);
expect(res.body.code).toBe(0);
expect(res.body.data.name).toBe("Alice");
expect(res.headers["x-request-id"]).toBe("test-req-001");
```

---

## TestResponse

Simulates an HTTP response object, including status code, response headers and parsed response body.

```typescript
interface TestResponse {
  status: number;
  headers: Record<string, string | string[]>;
  cookies: string[];
  header(name: string): string | undefined;
  headerValues(name: string): string[];
  body: any;
  text: string;
}
```

### `status`

HTTP status code.

```typescript
status: number;
```

```typescript
const res = await testApp.request.get("/users/list");
expect(res.status).toBe(200);

const res2 = await testApp.request.get("/users/nonexistent");
expect(res2.status).toBe(404);

const res3 = await testApp.request
  .post("/users")
  .send({ name: "Alice", email: "alice@example.com" });
expect(res3.status).toBe(201);
```

---

### `headers`

Response header object, all keys are lowercase.

```typescript
headers: Record<string, string | string[]>;
```

```typescript
const res = await testApp.request.get("/users/list");

// Check Content-Type
expect(res.header("content-type")).toContain("application/json");

// Check custom response headers
expect(res.headers["x-request-id"]).toBeDefined();

// Check CORS headers
expect(res.headers["access-control-allow-origin"]).toBeDefined();
```

`Set-Cookie` is preserved as an array. Prefer `res.cookies` or `res.headerValues("set-cookie")` when asserting cookies:

```typescript
expect(res.cookies).toHaveLength(2);
expect(res.headerValues("set-cookie")).toEqual(res.cookies);
expect(res.header("content-type")).toContain("application/json");
```

---

### `body`

Automatically parsed JSON response body. If the response's `Content-Type` is `application/json`, `body` is the parsed JavaScript object/array; otherwise it is `undefined`.

```typescript
body: any;
```

```typescript
const res = await testApp.request.get("/users/list");

//Export packaging format
expect(res.body).toEqual({
  code: 0,
  data: expect.any(Array),
  requestId: expect.any(String),
});

// Directly access business data
expect(res.body.data).toHaveLength(2);
expect(res.body.data[0].name).toBe("Alice");
```

**Error response**:

```typescript
const res = await testApp.request.get("/users/nonexistent-id");

expect(res.body).toEqual({
  code: -1,
  message: "User does not exist",
  requestId: expect.any(String),
});
```

**With business error code**:

```typescript
const res = await testApp.request.post("/users").send({
  email: "existing@example.com",
});

expect(res.body.code).toBe(10001);
expect(res.body.message).toBe("Email has been registered");
```

---

### `text`

Raw response text. For a JSON response, `text` is the JSON string; for a text response, `text` is the raw text content.

```typescript
text: string;
```

```typescript
// Raw text of JSON response
const res = await testApp.request.get("/users/list");
console.log(res.text);
// '{"code":0,"data":[...],"requestId":"..."}'

// text response
const res2 = await testApp.request.get("/health");
expect(res2.text).toBe("OK");
```

---

## Usage mode

### Integration testing

Load the real routes, services, and middleware, and verify the complete request-response process:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";
import type { TestApp } from "vextjs";

describe("User CRUD", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp({
      plugins: true, // Load real plugins (such as database)
    });
  });

  afterEach(async () => {
    await testApp.close();
  });

  it("Create user", async () => {
    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer test-admin-token")
      .send({
        name: "Alice",
        email: "alice@example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toMatchObject({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(res.body.data.id).toBeDefined();
  });

  it("Query user list", async () => {
    const res = await testApp.request
      .get("/users/list")
      .query({ page: 1, limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("404 should be returned if the user does not exist", async () => {
    const res = await testApp.request.get("/users/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("The user does not exist");
  });

  it("Failed parameter verification should return 422", async () => {
    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer test-admin-token")
      .send({
        name: "", // does not satisfy string:1-50
        email: "invalid-email", // does not meet the email format
      });

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
```

---

### Unit Test (Mock Services)

Do not load real services, use mock instead, focus on testing routing logic:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("User routing (mock service)", () => {
  let testApp;

  const mockUserService = {
    findAll: vi.fn().mockResolvedValue([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]),
    findById: vi.fn().mockImplementation(async (id) => {
      if (id === "1") return { id: "1", name: "Alice" };
      return null;
    }),
    create: vi.fn().mockImplementation(async (data) => ({
      id: "3",
      ...data,
      createdAt: new Date().toISOString(),
    })),
  };

  afterEach(async () => {
    await testApp?.close();
    vi.clearAllMocks();
  });

  it("GET /users/list call findAll", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });
    const res = await testApp.request
      .get("/users/list")
      .query({ page: "1", limit: "10" });

    expect(res.status).toBe(200);
    expect(mockUserService.findAll).toHaveBeenCalledOnce();
  });

  it("GET /users/:id returns the user if it exists", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });

    const res = await testApp.request.get("/users/1");

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Alice");
    expect(mockUserService.findById).toHaveBeenCalledWith("1");
  });

  it("GET /users/:id returns 404 when it does not exist", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });

    const res = await testApp.request.get("/users/999");

    expect(res.status).toBe(404);
  });
});
```

---

### Test middleware

Verify the behavior of middleware such as authentication and permissions:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("Authentication Middleware", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("No token should return 401", async () => {
    testApp = await createTestApp();

    const res = await testApp.request.post("/users").send({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("authentication");
  });

  it("Invalid token should return 401", async () => {
    testApp = await createTestApp();

    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer invalid-token")
      .send({
        name: "Alice",
        email: "alice@example.com",
      });

    expect(res.status).toBe(401);
  });

  it("valid token should pass normally", async () => {
    testApp = await createTestApp();

    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer valid-admin-token")
      .send({
        name: "Alice",
        email: "alice@example.com",
      });

    expect(res.status).not.toBe(401);
  });
});
```

---

### Test different Adapters

Verify that the behavior is consistent after the Adapter is switched:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

const adapters = ["native", "hono", "fastify", "express", "koa"] as const;

describe.each(adapters)("Adapter: %s", (adapter) => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("GET /health should return 200", async () => {
    testApp = await createTestApp({
      config: { adapter },
    });

    const res = await testApp.request.get("/health");
    expect(res.status).toBe(200);
  });

  it("POST JSON should parse body correctly", async () => {
    testApp = await createTestApp({
      config: { adapter },
    });

    const res = await testApp.request.post("/echo").send({ message: "hello" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("hello");
  });
});
```

---

### Test custom plug-ins

Use `setupPlugins` to register test-specific plugins:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("Redis cache plug-in", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("Return directly when cache hits", async () => {
    const mockCache = new Map();
    mockCache.set("user:1", JSON.stringify({ id: "1", name: "Cached Alice" }));

    testApp = await createTestApp({
      setupPlugins: async (app) => {
        app.extend("userCache", {
          get: async (key) => mockCache.get(key) ?? null,
          set: async (key, value, ttl) => mockCache.set(key, value),
          del: async (key) => mockCache.delete(key),
        });
      },
    });

    // Assuming that the route handler will read app.userCache, cached data should be returned
    const res = await testApp.request.get("/users/1");
    expect(res.status).toBe(200);
  });
});
```

---

### Test error handling

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("Error handling", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("404 routing should return standard format", async () => {
    testApp = await createTestApp();

    const res = await testApp.request.get("/nonexistent-path");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: expect.any(Number),
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("Validation failure should return an error list", async () => {
    testApp = await createTestApp();

    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer valid-token")
      .send({}); // Required fields are missing

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);

    for (const error of res.body.errors) {
      expect(error).toHaveProperty("field");
      expect(error).toHaveProperty("message");
    }
  });

  it("500 error hide details in production mode", async () => {
    testApp = await createTestApp({
      config: {
        response: { hideInternalErrors: true },
      },
      mockServices: {
        user: {
          findAll: vi
            .fn()
            .mockRejectedValue(new Error("Database connection failed")),
        },
      },
    });

    const res = await testApp.request.get("/users/list");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal Server Error");
    // Internal error messages should not be exposed
    expect(res.body.message).not.toContain("Database connection failed");
  });
});
```

---

### Test export packaging

```typescript
describe("Export Packaging", () => {
  it("wrap: true when the response contains code/data/requestId", async () => {
    const testApp = await createTestApp({
      config: { response: { wrap: true } },
    });

    const res = await testApp.request.get("/health");

    expect(res.body).toHaveProperty("code", 0);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("requestId");

    await testApp.close();
  });

  it("wrap: false when the response is original data", async () => {
    const testApp = await createTestApp({
      config: { response: { wrap: false } },
    });

    const res = await testApp.request.get("/health");

    // Raw data, no code/data packaging
    expect(res.body).not.toHaveProperty("code");
    expect(res.body).toHaveProperty("status", "ok");

    await testApp.close();
  });
});
```

---

## Best Practices

### 1. Always call close()

```typescript
afterEach(async () => {
  await testApp?.close();
});
```

Prevent resource leaks from causing the test process to hang. Use the `?.` optional chain to prevent `testApp` from reporting an error when it is not initialized.

### 2. Create TestApp independently for each test

```typescript
// ✅ Recommendation: each test independent app
it("test 1", async () => {
  testApp = await createTestApp();
  // ...
});

it("test 2", async () => {
  testApp = await createTestApp();
  // ...
});

// ❌ Avoid: Sharing apps (tests may affect each other)
// beforeAll(async () => {
// testApp = await createTestApp();
// });
```

### 3. Mock external dependencies

```typescript
testApp = await createTestApp({
  services: false,
  mockServices: {
    user: mockUserService,
    email: mockEmailService,
  },
});
```

In unit testing, dependencies such as databases and external APIs are mocked, and only the code under test itself is tested.

### 4. Use vi.fn() to verify the call

```typescript
const mockService = {
  create: vi.fn().mockResolvedValue({ id: "1" }),
};

testApp = await createTestApp({ mockServices: { user: mockService } });

await testApp.request.post("/users").send({ name: "Alice" });

expect(mockService.create).toHaveBeenCalledWith(
  expect.objectContaining({ name: "Alice" }),
);
```

### 5. Test description is in Chinese

```typescript
describe('User Management Interface', () => {
  it('Successful user creation should return 201', async () => { ... });
  it('Duplicate mailbox should return 409', async () => { ... });
  it('Unauthenticated should return 401', async () => { ... });
});
```

---

## Type import

```typescript
// runtime value
import { createTestApp } from "vextjs/testing";

// Type (imported from main entrance)
import type {
  CreateTestAppOptions,
  TestApp,
  TestRequest,
  TestRequestBuilder,
  TestResponse,
} from "vextjs";
```

:::tip
Test tools are imported through the `vextjs/testing` subpath (runtime value), and types can be imported from the `vextjs` main entry. This is designed to prevent test dependencies (such as mock-related code) from polluting the packaging volume of the production code.
:::
