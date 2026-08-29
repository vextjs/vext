# test

VextJS has a complete built-in testing tool, imported through the `vextjs/testing` subpath. Routers, middleware, and services can be tested end-to-end without starting a real HTTP server.

Both ESM `import` and CommonJS `require()` are supported. The root entry and public subpaths share runtime identity: for example, an error created through `vextjs/testing` remains `instanceof require("vextjs").HttpError`, and logger lifecycle metadata is visible across those entrypoints.

## Quick Start

```typescript
import { describe, it, expect } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("GET /health", () => {
  it("should return ok", async () => {
    const app = await createTestApp();

    const res = await app.request.get("/health");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: "ok" });
  });
});
```

VextJS recommends using [Vitest](https://vitest.dev/) as the testing framework, but the testing tool itself does not depend on any specific testing framework. You can also use it with Jest, Node.js built-in test runner, etc.

## `createTestApp()`

`createTestApp()` is the core API for testing. It creates a complete application instance and simulates the request processing process, but does not start HTTP listening.

### Basic usage

```typescript
import { createTestApp } from "vextjs/testing";

// Use default configuration (automatically load src/routes, src/services, etc.)
const app = await createTestApp();

//Send test request
const res = await app.request.get("/users");
expect(res.status).toBe(200);
```

### Configuration options

```typescript
interface CreateTestAppOptions {
  /** Later-layer patch merged over framework and test defaults */
  config?: VextConfigOverride;

  /** Whether to load plug-ins in the src/plugins/ directory (default false) */
  plugins?: boolean;

  /** Custom plug-in setup function (replacing file system scanning) */
  setupPlugins?: (app: VextApp) => Promise<void> | void;

  /** Whether to load services in the src/services/ directory (default true) */
  services?: boolean;

  /** Simulation service object (replacing automatic scanning service) */
  mockServices?: Partial<VextServices>;

  /** Whether to load routes in the src/routes/ directory (default true) */
  routes?: boolean;

  /** Whether to load middleware in the src/middlewares/ directory (default true) */
  middlewares?: boolean;

  /** Project root directory (default process.cwd()) */
  rootDir?: string;
}
```

`CreateTestAppOptions.config` is an override layer, not a standalone base
configuration. `VextConfigOverride` lets a test patch nested fields already
present in the framework/test defaults. Atomic adapters, stores, callbacks, and
arrays still have to be supplied as complete values.

`createTestApp()` does not load the project's `src/config/default.ts`. The
built-in test defaults do not define `database`, so a test that adds that
optional section must provide a complete database configuration, including its
required connection `config`; a half database has no earlier test layer to
complete it.

### Common configuration scenarios

#### Custom port and log level

```typescript
const app = await createTestApp({
  config: {
    port: 0,
    logger: { level: "silent" }, // Silent log during testing
  },
});
```

#### Skip plugin loading

```typescript
const app = await createTestApp({
  plugins: false, //Default value: Do not load plugins under src/plugins/
});
```

#### Simulation service

```typescript
const app = await createTestApp({
  services: false, // Do not load the real service
  mockServices: {
    user: {
      findAll: async () => [{ id: "1", name: "Alice" }],
      findById: async (id: string) => ({ id, name: "Alice" }),
      create: async (data: any) => ({ id: "99", ...data }),
    },
  },
});
```

#### Custom plugin

```typescript
const app = await createTestApp({
  setupPlugins: async (app) => {
    //Inject mock objects for testing
    app.extend("testCache", new Map());
    app.extend("mailer", {
      send: async () => ({ messageId: "test-123" }),
    });
  },
});
```

## Send test request

The object returned by `createTestApp()` contains the `request` attribute and supports all HTTP methods:

```typescript
const app = await createTestApp();

//GET
const res1 = await app.request.get("/users");

// POST
const res2 = await app.request.post("/users");

// PUT
const res3 = await app.request.put("/users/1");

// PATCH
const res4 = await app.request.patch("/users/1");

//DELETE
const res5 = await app.request.delete("/users/1");

// OPTIONS
const res6 = await app.request.options("/users");

//HEAD
const res7 = await app.request.head("/users");
```

### Chained build requests

Each HTTP method returns a `TestRequestBuilder`, which supports chain calls to configure the request:

```typescript
const res = await app.request
  .post("/users")
  .set("Authorization", "Bearer test-token") // Set a single header
  .headers({
    // Set headers in batches
    "X-Custom": "value",
    "Accept-Language": "zh-CN",
  })
  .query({ page: "1", limit: "10" }) // Set query parameters
  .type("application/json") //Set Content-Type
  .send({ name: "Alice", email: "alice@example.com" }); // Set the request body
```

#### `.set(name, value)` — Set a single request header

```typescript
app.request
  .get("/profile")
  .set("Authorization", "Bearer my-token")
  .set("Accept-Language", "en-US");
```

#### `.headers(obj)` — Set request headers in batches

```typescript
app.request.get("/data").headers({
  Authorization: "Bearer token",
  "X-Request-Id": "test-req-001",
});
```

#### `.query(obj)` — Set URL query parameters

```typescript
app.request.get("/search").query({ keyword: "vext", page: "1", limit: "20" });
// Actual request URL: /search?keyword=vext&page=1&limit=20
```

#### `.send(body)` — Set the request body

```typescript
//Send JSON (default Content-Type: application/json)
app.request.post("/users").send({ name: "Alice", email: "alice@example.com" });

// send string
app.request.post("/raw").type("text/plain").send("Hello World");
```

#### `.type(contentType)` — Set Content-Type

```typescript
app.request
  .post("/upload")
  .type("application/x-www-form-urlencoded")
  .send("name=Alice&email=alice@example.com");
```

### `TestResponse` response object

A `TestResponse` object is returned after the request is completed:

```typescript
interface TestResponse {
  /** HTTP status code */
  status: number;

  /** Response headers (lowercase key, Set-Cookie may be string[]) */
  headers: Record<string, string | string[]>;

  /** Set-Cookie response headers */
  cookies: string[];

  /** Read the first value of a response header */
  header(name: string): string | undefined;

  /** Read all values of a response header */
  headerValues(name: string): string[];

  /** Parsed response body (JSON is automatically parsed into an object) */
  body: any;

  /** Original response body text */
  text: string;
}
```

```typescript
const res = await app.request.get("/users");

// Assert status code
expect(res.status).toBe(200);

// Assert response body (JSON automatically parsed)
expect(res.body).toEqual({
  code: 0,
  data: [{ id: "1", name: "Alice" }],
  requestId: expect.any(String),
});

// Assert response header
expect(res.header("content-type")).toContain("application/json");
expect(res.headers["x-request-id"]).toBeDefined();
expect(res.headerValues("set-cookie")).toEqual(res.cookies);

// Assert the original text
expect(res.text).toContain('"code":0');
```

## Test mode features

The application created by `createTestApp()` is in test mode (`_testMode: true`), which has the following differences from production mode:

| Features         | Test Mode           | Production Mode             |
| ---------------- | ------------------- | --------------------------- |
| HTTP Listening   | ❌ Not Starting     | ✅ Listening Port           |
| `process.exit()` | ❌ Not called       | ✅ Called on shutdown       |
| Log level        | Default `silent`    | Determined by configuration |
| Rate limiting    | Disabled by default | Determined by configuration |
| Shutdown timeout | Default 1 second    | Determined by configuration |

## Practical example

### Test CRUD routing

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createTestApp, type TestApp } from "vextjs/testing";

describe("Users API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      config: {
        logger: { level: "silent" },
      },
    });
  });

  describe("GET /users", () => {
    it("should return user list", async () => {
      const res = await app.request.get("/users");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it("should support pagination", async () => {
      const res = await app.request
        .get("/users")
        .query({ page: "2", limit: "5" });

      expect(res.status).toBe(200);
    });
  });

  describe("POST /users", () => {
    it("should create a user", async () => {
      const res = await app.request
        .post("/users")
        .set("Authorization", "Bearer test-token")
        .send({ name: "Bob", email: "bob@example.com" });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: "Bob",
        email: "bob@example.com",
      });
    });

    it("should return 422 for invalid data", async () => {
      const res = await app.request
        .post("/users")
        .set("Authorization", "Bearer test-token")
        .send({ name: "", email: "invalid" });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
    it("should return 401 without token", async () => {
      const res = await app.request
        .post("/users")
        .send({ name: "Bob", email: "bob@example.com" });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /users/:id", () => {
    it("should return user by id", async () => {
      const res = await app.request.get("/users/1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("1");
    });

    it("should return 404 for non-existent user", async () => {
      const res = await app.request.get("/users/non-existent");

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /users/:id", () => {
    it("should delete user", async () => {
      const res = await app.request
        .delete("/users/1")
        .set("Authorization", "Bearer admin-token");

      expect(res.status).toBe(204);
    });
  });
});
```

### Test middleware

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createTestApp, type TestApp } from "vextjs/testing";

describe("Auth Middleware", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      config: {
        logger: { level: "silent" },
      },
    });
  });

  it("should allow request with valid token", async () => {
    const res = await app.request
      .get("/admin/dashboard")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
  });

  it("should reject request without token", async () => {
    const res = await app.request.get("/admin/dashboard");

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Authorization");
  });

  it("should reject request with expired token", async () => {
    const res = await app.request
      .get("/admin/dashboard")
      .set("Authorization", "Bearer expired-token");

    expect(res.status).toBe(401);
  });
});
```

### Use mock service testing

Use `mockServices` when you just want to test routing logic without relying on a real database:

```typescript
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createTestApp, type TestApp } from "vextjs/testing";

describe("Users API with mock services", () => {
  const mockUserService = {
    findAll: vi.fn().mockResolvedValue({
      items: [{ id: "1", name: "Alice" }],
      total: 1,
    }),
    findById: vi.fn().mockImplementation(async (id: string) => {
      if (id === "1") return { id: "1", name: "Alice" };
      return null;
    }),
    create: vi.fn().mockImplementation(async (data: any) => ({
      id: "2",
      ...data,
    })),
  };

  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      services: false,
      mockServices: {
        user: mockUserService,
      },
      config: {
        logger: { level: "silent" },
      },
    });
  });

  it("should call findAll service method", async () => {
    const res = await app.request.get("/users");

    expect(res.status).toBe(200);
    expect(mockUserService.findAll).toHaveBeenCalled();
  });

  it("should call findById with correct id", async () => {
    await app.request.get("/users/1");

    expect(mockUserService.findById).toHaveBeenCalledWith("1");
  });

  it("should return 404 when service returns null", async () => {
    const res = await app.request.get("/users/999");

    expect(res.status).toBe(404);
    expect(mockUserService.findById).toHaveBeenCalledWith("999");
  });

  it("should pass validated body to create", async () => {
    const res = await app.request
      .post("/users")
      .set("Authorization", "Bearer test-token")
      .send({ name: "Bob", email: "bob@example.com" });
    expect(res.status).toBe(201);
    expect(mockUserService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Bob", email: "bob@example.com" }),
    );
  });
});
```

### Test service layer (unit testing)

The service layer can be unit tested independently of HTTP. Instantiate the service directly, passing in the simulated `app` object:

```typescript
import { describe, it, expect, vi } from "vitest";
import UserService from "../../src/services/user.js";

describe("UserService", () => {
  function createMockApp() {
    return {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      throw: vi.fn().mockImplementation((status, message) => {
        const err = new Error(message);
        (err as any).status = status;
        throw err;
      }),
      config: { port: 3000 },
      services: {},
    };
  }

  it("should create user", async () => {
    const app = createMockApp();
    const service = new UserService(app as any);

    const user = await service.create({
      name: "Alice",
      email: "alice@test.com",
    });

    expect(user).toMatchObject({ name: "Alice", email: "alice@test.com" });
    expect(user.id).toBeDefined();
    expect(app.logger.info).toHaveBeenCalled();
  });

  it("should find user by id", async () => {
    const app = createMockApp();
    const service = new UserService(app as any);

    const user = await service.findById("1");

    expect(user).toBeDefined();
    expect(user?.id).toBe("1");
  });
});
```

### Test error response

```typescript
describe("Error handling", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      config: { logger: { level: "silent" } },
    });
  });

  it("should return 404 for unknown routes", async () => {
    const res = await app.request.get("/this-route-does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: 404,
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("should include requestId in error responses", async () => {
    const res = await app.request.get("/non-existent");

    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.requestId).toBe("string");
  });

  it("should return 422 for validation errors", async () => {
    const res = await app.request
      .post("/users")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeInstanceOf(Array);
  });
});
```

### Test custom request headers

```typescript
describe("Request headers", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      config: { logger: { level: "silent" } },
    });
  });

  it("should forward X-Request-Id header", async () => {
    const customId = "my-custom-request-id";

    const res = await app.request.get("/health").set("X-Request-Id", customId);

    expect(res.body.requestId).toBe(customId);
  });

  it("should generate request id when not provided", async () => {
    const res = await app.request.get("/health");

    expect(res.body.requestId).toBeDefined();
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });
});
```

## Project configuration

### TypeScript service files and ESM loading

When `services: true` (the default), `createTestApp()` scans `src/services/` and loads `.ts` source files. The service loader uses esbuild internally to solve two native ESM problems:

| Problem                           | Cause                                                                                        | Solution                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ERR_UNKNOWN_FILE_EXTENSION: .ts` | Node.js native ESM does not support the `.ts` extension                                      | esbuild compiles to `.mjs` and then calls `import()`                  |
| `.js → .ts` remapping is missing  | TypeScript ESM imports use `.js`, while Node.js/Vite do not automatically fall back to `.ts` | esbuild `bundle: true` resolves local dependencies during compilation |

**Scenarios not affected by this restriction**:

- `vext start` (load compiled files from `dist/services/*.js`)
- `vext dev` (load the esbuild compiled product from `.vext/dev/services/*.js`)
- Integration tests use `mockServices` (bypass service-loader scanning)

:::tip Recommended mockServices for unit testing
If the test only focuses on routing logic, using `mockServices` + `services: false` is faster and completely isolated, without loading the real `.ts` service file:

```typescript
const app = await createTestApp({
  services: false,
  mockServices: {
    user: {
      findAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue({ id: "1", name: "Alice" }),
    },
  },
});
```

:::

### Vitest configuration

Recommended `vitest.config.ts` configuration:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/cli/**"],
    },
  },
});
```

### Test directory structure

Recommended test directory organization:

```
test/
├── unit/ # unit test
│ ├── services/
│ │ ├── user.test.ts
│ │ └── order.test.ts
│ ├── middlewares/
│ │ └── auth.test.ts
│ └── lib/
│ └── config-loader.test.ts
│
├── integration/ # Integration test
│ ├── routes/
│ │ ├── users.test.ts
│ │ └── orders.test.ts
│ └── plugins/
│ └── redis.test.ts
│
└── e2e/ # End-to-end testing
    └── api.test.ts
```

### package.json script

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run test/unit",
    "test:int": "vitest run test/integration",
    "test:e2e": "vitest run test/e2e",
    "test:cov": "vitest run --coverage"
  }
}
```

## Best Practices

### 1. Silent log during test

Avoid test output being overwhelmed by log messages:

```typescript
const app = await createTestApp({
  config: {
    logger: { level: "silent" },
  },
});
```

### 2. Use `beforeAll` to reuse application instances

`createTestApp()` has some initialization overhead. Reuse application instances within the same `describe` block:

```typescript
describe("Users API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  it("test 1", async () => {
    /* Reuse app */
  });
  it("test 2", async () => {
    /* Reuse app */
  });
});
```

### 3. Isolate test side effects

If your tests modify data state, use a mock service to avoid side effects between tests:

```typescript
const app = await createTestApp({
  services: false,
  mockServices: {
    user: createFreshMockUserService(), // Use a new mock for each set of tests
  },
});
```

### 4. Test edge cases

Don't just test normal paths, cover error cases as well:

```typescript
// ✅ Test normal + abnormal
it("should create user", async () => {
  /* Create normally */
});
it("should reject invalid email", async () => {
  /* Verification failed */
});
it("should reject duplicate email", async () => {
  /* Business error */
});
it("should reject without auth", async () => {
  /* Not authenticated */
});
it("should reject with wrong role", async () => {
  /* No permission */
});
```

### 5. Assert response structure

Use `toMatchObject` or `toEqual` to assert the complete response structure instead of just checking individual fields:

```typescript
// ✅ Assert the complete structure
expect(res.body).toMatchObject({
  code: 0,
  data: {
    id: expect.any(String),
    name: "Alice",
    email: "alice@example.com",
  },
  requestId: expect.any(String),
});

// ❌ Only check a single field (easy to miss problems)
expect(res.body.data.name).toBe("Alice");
```

### 6. Use mockServices first for unit testing

**Unit testing** (testing routing logic, middleware, error handling) should use `mockServices` instead of real services for the following reasons:

- ✅ Faster (no esbuild compilation overhead, no database connection)
- ✅ Complete isolation (not dependent on service implementation details, more stable testing)
- ✅ Precise control of return values and error scenarios

```typescript
// ✅ Unit testing: mock service, focusing on routing logic
const app = await createTestApp({
  services: false,
  mockServices: {
    user: {
      findAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue(null), // Simulate "does not exist" scenario
      create: vi.fn().mockRejectedValue(
        // Simulate "duplicate mailbox" scenario
        Object.assign(new Error("email_taken"), { status: 409 }),
      ),
    },
  },
});

// ✅ Integration testing: load real services and test the complete business process
const app = await createTestApp({
  services: true, // By default, service-loader automatically handles .ts compilation
});
```

| Test type           |    `services`    |  `mockServices`   | Applicable scenarios                                  |
| ------------------- | :--------------: | :---------------: | ----------------------------------------------------- |
| Unit testing        |     `false`      |       Valid       | Routing logic, middleware, error response format      |
| Integration testing | `true` (default) | Optional coverage | Complete business process, inter-service dependencies |

## Next step

- Learn how [routing](/guide/routing) defines a testable API
- Learn the unit testing pattern of [Service Layer](/guide/services)
- See [CLI Commands](/guide/cli) to learn about `dev` / `build` / `start` and other running commands
- Explore testing tips for [middleware](/guide/middleware)
