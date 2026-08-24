# CRUD API

## Executable 2.x Reference

The release contract for this page is the checked-in
[`examples/crud-api`](https://github.com/devcodex-labs/vextjs/tree/main/examples/crud-api)
project. It is a TypeScript Todo API backed by an isolated MongoDB database and
the raw MonSQLize instance exposed only as `app.db`.

```powershell
cd examples/crud-api
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/vext_crud_example"
npm install
npm run typecheck
npm run build
npm test
npm start
```

The model declares `collection: "todos"`, so the service uses the exact raw
registry key `app.db.model("todos")`. The application explicitly keeps global
rate limiting off and enables OpenAPI/Vext Docs.

Its real endpoints are `GET /`, `GET /todos`, `POST /todos`,
`GET /todos/:id`, `PATCH /todos/:id`, and `DELETE /todos/:id`. Every required
path `id` uses `string:1-!`: missing/invalid path parameters return HTTP 400
before the handler runs and appear as `required: true` in OpenAPI. Body and
query validation failures remain HTTP 422.

Release validation installs, typechecks, builds, starts, and exercises the
actual Mongo-backed CRUD lifecycle; a mock database is not accepted.

## Extended In-memory/Auth Tutorial

The walkthrough below is a separate teaching variant with users, in-memory
storage, and an auth middleware. It is useful for illustrating more APIs, but
it is not the executable `examples/crud-api` fixture or its endpoint contract.

## Project structure

```
crud-api/
  ├── src/
  │ ├── config/
  │ │ └── default.ts
  │ ├── middlewares/
  │ │ └── auth.ts
  │ ├── routes/
  │ │ ├── index.ts
  │ │ └── users.ts
  │ ├── services/
  │ │ └── user.ts
  │ └── index.ts
  ├── test/
  │ └── users.test.ts
  ├── package.json
  └── tsconfig.json
```

## 1. Initialize project

```bash
npx vextjs create crud-api
cd crud-api
pnpm install
```

## 2. Configuration

```typescript
// src/config/default.ts
export default {
  port: 3000,
  adapter: "native",
  logger: {
    level: "debug",
    pretty: true,
  },
  cors: {
    enabled: true,
    origins: ["*"],
  },
  rateLimit: {
    enabled: true,
    max: 100,
    window: 60,
  },
  response: {
    wrap: true,
    hideInternalErrors: false, // The development environment displays error details
  },
  openapi: {
    enabled: true,
    title: "CRUD API Example",
    version: "1.0.0",
    description: "A complete user management RESTful API",
    tags: [
      { name: "Basic", description: "Basic interface" },
      { name: "User", description: "User management interface" },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Use Bearer Token authentication",
      },
    },
  },
  // Routing-level middleware whitelist
  middlewares: [{ name: "auth" }],
};
```

:::tip
`auth()` only parses the credential and fills `req.auth`. Routes opt into protection with `RouteOptions.auth`; OpenAPI security is generated from that route option first, with legacy middleware-name inference kept only for older examples.
:::

## 3. Authentication middleware

```typescript
// src/middlewares/auth.ts
import { auth, defineMiddleware } from "vextjs";

/**
 * Simple authentication middleware
 *
 * A JWT library (such as jose) should be used for token validation in production environments.
 * This is simplified to static token verification for demonstration purposes.
 */
export default defineMiddleware(
  auth({
    provider: "crud-demo",
    verify(token) {
      if (!token || token === "undefined") return false;

      // Simple example: token format is "user-{id}-{role}"
      // Production code should verify a real JWT with jose/jsonwebtoken.
      const parts = token.split("-");
      if (parts.length < 3 || parts[0] !== "user") return false;

      const [, userId, role] = parts;
      return {
        subject: `user:${userId}`,
        userId,
        roles: [role],
        provider: "crud-demo",
        claims: { role },
      };
    },
  }),
);
```

### Statically projectable protected routes

Route options are consumed by build indexing, Doctor, and OpenAPI generation without executing route modules. Keep the final authentication shape in the inline options object, or in a same-file `const` passed directly to one route call. A helper call around the options object is rejected by the finite static grammar, so the protected routes below inline `middlewares` and `auth` explicitly.

## 4. Service layer

```typescript
// src/services/user.ts
import type { VextApp, VextLogger } from "vextjs";

/**
 * User data interface
 */
interface User {
  id: string;
  name: string;
  email: string;
  age?: number;
  role: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * User service
 *
 * Demonstrate CRUD operations using in-memory storage.
 * Should be replaced with real database operations in production environments.
 */
export default class UserService {
  private logger: VextLogger;
  private users: Map<string, User> = new Map();
  private nextId = 1;

  constructor(private app: VextApp) {
    this.logger = app.logger.child({ service: "UserService" });

    //Initialize some test data
    this.seed();
  }

  /**
   * Fill in initial test data
   */
  private seed(): void {
    const seedUsers = [
      { name: "Alice", email: "alice@example.com", age: 28, role: "admin" },
      { name: "Bob", email: "bob@example.com", age: 32, role: "user" },
      { name: "Charlie", email: "charlie@example.com", role: "user" },
    ];
    for (const u of seedUsers) {
      const id = String(this.nextId++);
      const now = new Date().toISOString();
      this.users.set(id, { id, ...u, createdAt: now, updatedAt: now });
    }

    this.logger.info(
      { count: this.users.size },
      "Initial data has been loaded",
    );
  }

  /**
   * Query user list by page
   */
  async findAll(options: {
    page: number;
    limit: number;
    keyword?: string;
  }): Promise<{
    items: User[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    this.logger.debug(options, "Query user list");

    let allUsers = Array.from(this.users.values());

    // Keyword search (fuzzy matching by name or email)
    if (options.keyword) {
      const kw = options.keyword.toLowerCase();
      allUsers = allUsers.filter(
        (u) =>
          u.name.toLowerCase().includes(kw) ||
          u.email.toLowerCase().includes(kw),
      );
    }

    const total = allUsers.length;
    const totalPages = Math.ceil(total / options.limit);
    const start = (options.page - 1) * options.limit;
    const items = allUsers.slice(start, start + options.limit);

    return {
      items,
      total,
      page: options.page,
      limit: options.limit,
      totalPages,
    };
  }

  /**
   * Query users based on ID
   */
  async findById(id: string): Promise<User | null> {
    this.logger.debug({ userId: id }, "Query user");
    return this.users.get(id) ?? null;
  }

  /**
   * Create user
   */
  async create(data: {
    name: string;
    email: string;
    age?: number;
    role?: string;
  }): Promise<User> {
    this.logger.info({ email: data.email }, "Create user");

    // Check email uniqueness
    for (const user of this.users.values()) {
      if (user.email === data.email) {
        this.app.throw(409, "Email has been registered", 10001);
      }
    }

    const id = String(this.nextId++);
    const now = new Date().toISOString();

    const user: User = {
      ID,
      name: data.name,
      email: data.email,
      age: data.age,
      role: data.role ?? "user",
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(id, user);
    this.logger.info(
      { userId: id, email: data.email },
      "User created successfully",
    );

    return user;
  }

  /**
   * Update user
   */
  async update(
    id: string,
    data: { name?: string; email?: string; age?: number },
  ): Promise<User> {
    this.logger.info({ userId: id }, "Update user");

    const user = this.users.get(id);
    if (!user) {
      this.app.throw(404, "User does not exist");
    }

    // If updating mailbox, check for uniqueness
    if (data.email && data.email !== user.email) {
      for (const u of this.users.values()) {
        if (u.email === data.email) {
          this.app.throw(
            409,
            "The mailbox is already used by another user",
            10002,
          );
        }
      }
    }

    const updated: User = {
      ...user,
      ...data,
      updatedAt: new Date().toISOString(),
    };

    this.users.set(id, updated);
    this.logger.info({ userId: id }, "User updated successfully");

    return updated;
  }

  /**
   * Delete user
   */
  async delete(id: string): Promise<void> {
    this.logger.info({ userId: id }, "Delete user");

    if (!this.users.has(id)) {
      this.app.throw(404, "User does not exist");
    }

    this.users.delete(id);
    this.logger.info({ userId: id }, "User deleted successfully");
  }

  /**
   * Count the number of users
   */
  async count(): Promise<number> {
    return this.users.size;
  }
}
```

:::tip
VextJS's service layer is automatically loaded through a conventional directory. Place the class or object in the `src/services/` directory, and the framework will be automatically instantiated and injected into `app.services`. The file name is the service name: `user.ts` → `app.services.user`.

The constructor of the service receives the `app: VextApp` parameter and can access `app.logger`, `app.config`, `app.throw` and other framework capabilities.
:::

## 5. Routing

### Root route (health check)

```typescript
// src/routes/index.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET / → health check
  app.get(
    "/",
    {
      docs: {
        summary: "Health Check",
      },
    },
    async (_req, res) => {
      const userCount = await app.services.user.count();
      res.json({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        users: userCount,
        timestamp: new Date().toISOString(),
      });
    },
  );
});
```

### User routing (full CRUD)

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  // GET /users/list — Query user list by page (public)
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  app.get(
    "/list",
    {
      validate: {
        query: {
          page: "number:1-", // Page number, minimum value 1
          limit: "number:1-100", //Number of items per page, 1-100
          keyword: "string?", // Search keyword (optional)
        },
      },
      docs: {
        summary: "User list",
        description:
          "Query the user list in pages, supporting fuzzy search by name or email.",
        responses: {
          200: {
            description: "Query successful",
            example: {
              items: [
                {
                  id: "1",
                  name: "Alice",
                  email: "alice@example.com",
                  role: "admin",
                },
              ],
              total: 3,
              page: 1,
              limit: 10,
              totalPages: 1,
            },
          },
        },
      },
    },
    async (req, res) => {
      const { page, limit, keyword } = req.valid("query");
      const result = await app.services.user.findAll({ page, limit, keyword });
      res.json(result);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  // GET /users/:id — Query users by ID (public)
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  app.get(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
      },
      docs: {
        summary: "Get user details",
        responses: {
          200: { description: "Query successful" },
          404: { description: "User does not exist" },
        },
      },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);

      if (!user) {
        app.throw(404, "User does not exist");
      }

      res.json(user);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  // POST /users — Create users (authentication required)
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  app.post(
    "/",
    {
      validate: {
        body: {
          name: "string:1-50", // required, length 1-50
          email: "email", // required, email format
          age: "number:0-200?", // optional, 0-200
          role: "enum:admin,user?", // optional, enumeration value
        },
      },
      docs: {
        summary: "Create user",
        description:
          "Create a new user. Bearer Token authentication is required.",
        responses: {
          201: {
            description: "Created successfully",
            example: {
              id: "4",
              name: "Diana",
              email: "diana@example.com",
              role: "user",
              createdAt: "2026-03-05T00:00:00.000Z",
              updatedAt: "2026-03-05T00:00:00.000Z",
            },
          },
          422: { description: "Parameter verification failed" },
          401: { description: "Not authenticated" },
          409: { description: "Email has been registered" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const body = req.valid("body");

      app.logger.info(
        { operator: req.auth.userId, email: body.email },
        "Operator creates user",
      );

      const user = await app.services.user.create(body);
      res.json(user, 201);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  // PUT /users/:id — update user (authentication required)
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  app.put(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
        body: {
          name: "string:1-50?", // optional
          email: "email?", // optional
          age: "number:0-200?", // optional
        },
      },
      docs: {
        summary: "Update user",
        description:
          "Update the specified user's information. Bearer Token authentication is required. Just pass in the fields that need to be updated.",
        responses: {
          200: { description: "Update successful" },
          422: { description: "Parameter verification failed" },
          401: { description: "Not authenticated" },
          404: { description: "User does not exist" },
          409: { description: "The mailbox is already used by another user" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const body = req.valid("body");

      app.logger.info(
        { operator: req.auth.userId, targetUser: id },
        "Operator update user",
      );

      const user = await app.services.user.update(id, body);
      res.json(user);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  // DELETE /users/:id — delete user (authentication required)
  // ━━━━━━━━━━━━━━━━━━━━ ━━━━━━━━━━━━━━━━━━━━━
  app.delete(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
      },
      docs: {
        summary: "Delete user",
        description:
          "Delete the specified user. Bearer Token authentication is required. This operation is irreversible.",
        responses: {
          204: { description: "Delete successfully (no response body)" },
          401: { description: "Not authenticated" },
          404: { description: "User does not exist" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const { id } = req.valid("param");

      app.logger.info(
        { operator: req.auth.userId, targetUser: id },
        "Operator delete user",
      );

      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## 6. Entry file

```typescript
// src/index.ts
import { bootstrap } from "vextjs";

bootstrap().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
```

## 7. Test

```typescript
// test/users.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";
import type { TestApp } from "vextjs";

describe("User CRUD", () => {
  let testApp: TestApp;
  const AUTH_TOKEN = "user-1-admin"; // Impersonate administrator token

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp?.close();
  });

  // ── Query ─────────────────────────────────────

  describe("GET /users/list", () => {
    it("Should return a paginated user list", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.total).toBeGreaterThan(0);
      expect(res.body.data.page).toBe(1);
    });

    it("Support keyword search", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 1, limit: 10, keyword: "alice" });

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].name).toBe("Alice");
    });

    it("Paging parameter verification failed and 422 should be returned", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 0, limit: 10 }); // The minimum value of page is 1

      expect(res.status).toBe(422);
    });
  });describe("GET /users/:id", () => {
    it("User details should be returned if present", async () => {
      const res = await testApp.request.get("/users/1");

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: "1",
        name: "Alice",
        email: "alice@example.com",
      });
    });

    it("Should return 404 when it does not exist", async () => {
      const res = await testApp.request.get("/users/999");

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("The user does not exist");
    });
  });

  //── Create ─────────────────────────────────────

  describe("POST /users", () => {
    it("User should be created successfully after authentication", async () => {
      const res = await testApp.request
        .post("/users")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          name: "Diana",
          email: "diana@example.com",
          age: 25,
        });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toMatchObject({
        name: "Diana",
        email: "diana@example.com",
        age: 25,
        role: "user",
      });
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
    });

    it("Unauthenticated should return 401", async () => {
      const res = await testApp.request
        .post("/users")
        .send({ name: "Test", email: "test@example.com" });

      expect(res.status).toBe(401);
    });

    it("Duplicate mailbox should return 409", async () => {
      const res = await testApp.request
        .post("/users")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          name: "Alice Copy",
          email: "alice@example.com", // already exists
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(10001);
    });

    it("If name is empty, 422 should be returned", async () => {
      const res = await testApp.request
        .post("/users")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          name: "",
          email: "new@example.com",
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it("email format is invalid and returns 422", async () => {
      const res = await testApp.request
        .post("/users")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          name: "Valid Name",
          email: "not-an-email",
        });

      expect(res.status).toBe(422);
    });
  });

  //── Update ────────────────────────────────────

  describe("PUT /users/:id", () => {
    it("User should be updated successfully after authentication", async () => {
      const res = await testApp.request
        .put("/users/1")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ name: "Alice Updated" });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Alice Updated");
      expect(res.body.data.email).toBe("alice@example.com"); // Unmodified fields remain unchanged
    });

    it("Updating non-existing users should return 404", async () => {
      const res = await testApp.request
        .put("/users/999")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ name: "Ghost" });

      expect(res.status).toBe(404);
    });

    it("Mailbox conflict should return 409", async () => {
      const res = await testApp.request
        .put("/users/1")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ email: "bob@example.com" }); // Bob’s email

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(10002);
    });
  });

  //──Delete ─────────────────────────────────────describe("DELETE /users/:id", () => {
    it("The user should be deleted successfully after authentication", async () => {
      const res = await testApp.request
        .delete("/users/2")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(204);

      // Confirm deletion
      const getRes = await testApp.request.get("/users/2");
      expect(getRes.status).toBe(404);
    });

    it("Deleting non-existent users should return 404", async () => {
      const res = await testApp.request
        .delete("/users/999")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it("Unauthenticated should return 401", async () => {
      const res = await testApp.request.delete("/users/1");

      expect(res.status).toBe(401);
    });
  });

  // ── Health Checkup ────────────────────────────────

  describe("GET /", () => {
    it("Service status should be returned", async () => {
      const res = await testApp.request.get("/");

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: "ok",
        users: expect.any(Number),
      });
    });
  });
});
```

## 8. Run

### Development mode

```bash
pnpm dev
```

After startup you can:

- Visit `http://localhost:3000/` to view the health check
- Visit `http://localhost:3000/docs` to view the automatically generated Vext Docs API documentation
- Use `curl` to test each interface

### Run the test

```bash
pnpm test
```

## 9. Interface testing

```bash
#HealthCheck
curl http://localhost:3000/
# → {"code":0,"data":{"status":"ok","users":3,...},"requestId":"..."}

# Query user list
curl "http://localhost:3000/users/list?page=1&limit=10"
# → {"code":0,"data":{"items":[...],"total":3,"page":1,"limit":10,"totalPages":1},"requestId":"..."}

#Search for users
curl "http://localhost:3000/users/list?page=1&limit=10&keyword=alice"
# → {"code":0,"data":{"items":[{"id":"1","name":"Alice",...}],...},"requestId":"..."}

# Query a single user
curl http://localhost:3000/users/1
# → {"code":0,"data":{"id":"1","name":"Alice","email":"alice@example.com",...},"requestId":"..."}

#Create user (authentication required)
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"Diana","email":"diana@example.com","age":25}'
# → 201 {"code":0,"data":{"id":"4","name":"Diana",...},"requestId":"..."}

#Update user (authentication required)
curl -X PUT http://localhost:3000/users/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"Alice Updated"}'
# → {"code":0,"data":{"id":"1","name":"Alice Updated",...},"requestId":"..."}

# Delete user (authentication required)
curl -X DELETE http://localhost:3000/users/2 \
  -H "Authorization: Bearer user-1-admin"
# → 204 No Content

# Unauthenticated access to protected interface
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com"}'
# → 401 {"code":-1,"message":"Authentication token not provided","requestId":"..."}

# Parameter verification failed
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"","email":"invalid"}'
# → 422 {"code":422,"message":"Validation failed","errors":[...],"requestId":"..."}
```

## 10. Summary of key concepts

### Request-response process

```
client request
  → requestId middleware (generate/transparently transmit request ID)
  → CORS middleware (handling cross-domain)
  → body-parser middleware (parse the request body)
  → access-log middleware (logging start time)
  → rate-limit middleware (rate limit check)
  → response-wrapper middleware (open export packaging)
  → auth middleware (validate token, inject req.auth) ← protected routes only
  → validate middleware (parameter verification) ← When validate is configured
  → handler (business logic)
  → export package ({ code: 0, data, requestId })
  → response returns
```

### Error handling process

```
app.throw(404, 'User does not exist') in handler
  → throw HttpError
  → error-handler middleware capture
  → Convert to standard error response
  → {"code":-1,"message":"User does not exist","requestId":"..."}
  → HTTP 404
```

### Design patterns

| Mode                         | Description                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| **Three-stage routing**      | `app.method(path, options, handler)` — Declarative configuration                             |
| **Service layer separation** | Business logic is encapsulated in `src/services/`, routing is only arranged                  |
| **Middleware whitelist**     | Route-level middleware must be declared in `config.middlewares`                              |
| **Auth guard**               | `auth()` fills `req.auth`; `RouteOptions.auth` protects routes and drives OpenAPI security   |
| **Declarative validation**   | `validate` uses schema-dsl DSL syntax, automatic type conversion                             |
| **Unified error handling**   | `app.throw()` throws an error, and the framework automatically converts to a standard format |
| **Export packaging**         | All successful responses are automatically packaged as `{ code: 0, data, requestId }`        |
| **OpenAPI Auto-Generation**  | Automatically generate API documentation from `validate` and `docs` configurations           |

## Next step

- 📖 [permission-core Auth](/examples/permission-core-auth) — Connect a fine-grained authorization core to Vext Auth
- 📖 [Testing](/guide/testing) — Learn more about advanced usage of VextJS testing tools
- 📖 [OpenAPI Documentation](/guide/openapi) — Learn more about OpenAPI’s auto-generated configuration options
