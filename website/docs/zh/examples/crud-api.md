# CRUD API

## 可执行 2.x 权威示例

本页的发布合同是仓库中的
[`examples/crud-api`](https://github.com/devcodex-labs/vextjs/tree/main/examples/crud-api)
项目。它是 TypeScript Todo API，使用隔离 MongoDB 数据库，以及只通过 `app.db` 暴露的 raw MonSQLize 实例。

```powershell
cd examples/crud-api
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/vext_crud_example"
npm install
npm run typecheck
npm run build
npm test
npm start
```

model 声明 `collection: "todos"`，因此 service 使用精确 raw registry key：`app.db.model("todos")`。应用显式关闭全局 rate limit，并启用 OpenAPI/Vext Docs。

实际 endpoint 是 `GET /`、`GET /todos`、`POST /todos`、`GET /todos/:id`、`PATCH /todos/:id` 与 `DELETE /todos/:id`。所有必填 path `id` 都使用 `string:1-!`：缺失/非法 path 参数会在 handler 执行前返回 HTTP 400，并在 OpenAPI 中显示 `required: true`；body/query 校验失败仍为 HTTP 422。

发布验证会安装、typecheck、build、启动并实际执行 Mongo CRUD 生命周期；mock 数据库不计为通过。

## 扩展内存/Auth 教学变体

下方 walkthrough 是单独的 users + 内存存储 + auth middleware 教学变体，可用于了解更多 API，但它不是可执行 `examples/crud-api` fixture 或其 endpoint 合同。

## 项目结构

```
crud-api/
  ├── src/
  │   ├── config/
  │   │   └── default.ts
  │   ├── middlewares/
  │   │   └── auth.ts
  │   ├── routes/
  │   │   ├── index.ts
  │   │   └── users.ts
  │   ├── services/
  │   │   └── user.ts
  │   └── index.ts
  ├── test/
  │   └── users.test.ts
  ├── package.json
  └── tsconfig.json
```

## 1. 初始化项目

```bash
npx vextjs create crud-api
cd crud-api
pnpm install
```

## 2. 配置

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
    hideInternalErrors: false, // 开发环境显示错误详情
  },
  openapi: {
    enabled: true,
    title: "CRUD API 示例",
    version: "1.0.0",
    description: "一个完整的用户管理 RESTful API",
    tags: [
      { name: "基础", description: "基础接口" },
      { name: "用户", description: "用户管理接口" },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "使用 Bearer Token 认证",
      },
    },
  },
  // 路由级中间件白名单
  middlewares: [{ name: "auth" }],
};
```

:::tip
`auth()` 只负责解析凭据并填充 `req.auth`。路由通过 `RouteOptions.auth` 选择是否受保护；OpenAPI security 会优先由该路由选项生成，按 middleware 名称回退推断只保留给历史示例兼容。
:::

## 3. 认证中间件

```typescript
// src/middlewares/auth.ts
import { auth, defineMiddleware } from "vextjs";

/**
 * 简易认证中间件
 *
 * 生产环境中应使用 JWT 库（如 jose）进行令牌验证。
 * 此处为了演示简化为静态 token 校验。
 */
export default defineMiddleware(
  auth({
    provider: "crud-demo",
    verify(token) {
      if (!token || token === "undefined") return false;

      // 简单示例：token 格式为 "user-{id}-{role}"
      // 生产代码应使用 jose/jsonwebtoken 校验真实 JWT。
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

### 可静态投影的受保护路由

构建索引、Doctor 与 OpenAPI 生成会在不执行路由模块的前提下读取 route options。请把最终认证形状写在内联 options 对象中，或写在同文件并直接传给单个路由调用的 `const` 中。有限静态语法会拒绝包裹 options 的 helper 调用，所以下面的受保护路由会显式内联 `middlewares` 与 `auth`。

## 4. 服务层

```typescript
// src/services/user.ts
import type { VextApp, VextLogger } from "vextjs";

/**
 * 用户数据接口
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
 * 用户服务
 *
 * 使用内存存储演示 CRUD 操作。
 * 生产环境中应替换为真实数据库操作。
 */
export default class UserService {
  private logger: VextLogger;
  private users: Map<string, User> = new Map();
  private nextId = 1;

  constructor(private app: VextApp) {
    this.logger = app.logger.child({ service: "UserService" });

    // 初始化一些测试数据
    this.seed();
  }

  /**
   * 填充初始测试数据
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

    this.logger.info({ count: this.users.size }, "初始数据已加载");
  }

  /**
   * 分页查询用户列表
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
    this.logger.debug(options, "查询用户列表");

    let allUsers = Array.from(this.users.values());

    // 关键词搜索（按 name 或 email 模糊匹配）
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
   * 根据 ID 查询用户
   */
  async findById(id: string): Promise<User | null> {
    this.logger.debug({ userId: id }, "查询用户");
    return this.users.get(id) ?? null;
  }

  /**
   * 创建用户
   */
  async create(data: {
    name: string;
    email: string;
    age?: number;
    role?: string;
  }): Promise<User> {
    this.logger.info({ email: data.email }, "创建用户");

    // 检查邮箱唯一性
    for (const user of this.users.values()) {
      if (user.email === data.email) {
        this.app.throw(409, "邮箱已注册", 10001);
      }
    }

    const id = String(this.nextId++);
    const now = new Date().toISOString();

    const user: User = {
      id,
      name: data.name,
      email: data.email,
      age: data.age,
      role: data.role ?? "user",
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(id, user);
    this.logger.info({ userId: id, email: data.email }, "用户创建成功");

    return user;
  }

  /**
   * 更新用户
   */
  async update(
    id: string,
    data: { name?: string; email?: string; age?: number },
  ): Promise<User> {
    this.logger.info({ userId: id }, "更新用户");

    const user = this.users.get(id);
    if (!user) {
      this.app.throw(404, "用户不存在");
    }

    // 如果更新邮箱，检查唯一性
    if (data.email && data.email !== user.email) {
      for (const u of this.users.values()) {
        if (u.email === data.email) {
          this.app.throw(409, "邮箱已被其他用户使用", 10002);
        }
      }
    }

    const updated: User = {
      ...user,
      ...data,
      updatedAt: new Date().toISOString(),
    };

    this.users.set(id, updated);
    this.logger.info({ userId: id }, "用户更新成功");

    return updated;
  }

  /**
   * 删除用户
   */
  async delete(id: string): Promise<void> {
    this.logger.info({ userId: id }, "删除用户");

    if (!this.users.has(id)) {
      this.app.throw(404, "用户不存在");
    }

    this.users.delete(id);
    this.logger.info({ userId: id }, "用户删除成功");
  }

  /**
   * 统计用户数量
   */
  async count(): Promise<number> {
    return this.users.size;
  }
}
```

:::tip
VextJS 的服务层通过约定式目录自动加载。将 class 或对象放在 `src/services/` 目录下，框架会自动实例化并注入到 `app.services` 中。文件名即服务名：`user.ts` → `app.services.user`。

服务的 constructor 接收 `app: VextApp` 参数，可以访问 `app.logger`、`app.config`、`app.throw` 等框架能力。
:::

## 5. 路由

### 根路由（健康检查）

```typescript
// src/routes/index.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET / → 健康检查
  app.get(
    "/",
    {
      docs: {
        summary: "健康检查",
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

### 用户路由（完整 CRUD）

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /users/list — 分页查询用户列表（公开）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get(
    "/list",
    {
      validate: {
        query: {
          page: "number:1-", // 页码，最小值 1
          limit: "number:1-100", // 每页条数，1-100
          keyword: "string?", // 搜索关键词（可选）
        },
      },
      docs: {
        summary: "用户列表",
        description: "分页查询用户列表，支持按姓名或邮箱模糊搜索。",
        responses: {
          200: {
            description: "查询成功",
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /users/:id — 根据 ID 查询用户（公开）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.get(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
      },
      docs: {
        summary: "获取用户详情",
        responses: {
          200: { description: "查询成功" },
          404: { description: "用户不存在" },
        },
      },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);

      if (!user) {
        app.throw(404, "用户不存在");
      }

      res.json(user);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /users — 创建用户（需认证）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.post(
    "/",
    {
      validate: {
        body: {
          name: "string:1-50", // 必填，长度 1-50
          email: "email", // 必填，邮箱格式
          age: "number:0-200?", // 可选，0-200
          role: "enum:admin,user?", // 可选，枚举值
        },
      },
      docs: {
        summary: "创建用户",
        description: "创建一个新用户。需要 Bearer Token 认证。",
        responses: {
          201: {
            description: "创建成功",
            example: {
              id: "4",
              name: "Diana",
              email: "diana@example.com",
              role: "user",
              createdAt: "2026-03-05T00:00:00.000Z",
              updatedAt: "2026-03-05T00:00:00.000Z",
            },
          },
          422: { description: "参数校验失败" },
          401: { description: "未认证" },
          409: { description: "邮箱已注册" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const body = req.valid("body");

      app.logger.info(
        { operator: req.auth.userId, email: body.email },
        "操作员创建用户",
      );

      const user = await app.services.user.create(body);
      res.json(user, 201);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PUT /users/:id — 更新用户（需认证）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.put(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
        body: {
          name: "string:1-50?", // 可选
          email: "email?", // 可选
          age: "number:0-200?", // 可选
        },
      },
      docs: {
        summary: "更新用户",
        description:
          "更新指定用户的信息。需要 Bearer Token 认证。只需传入需要更新的字段。",
        responses: {
          200: { description: "更新成功" },
          422: { description: "参数校验失败" },
          401: { description: "未认证" },
          404: { description: "用户不存在" },
          409: { description: "邮箱已被其他用户使用" },
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
        "操作员更新用户",
      );

      const user = await app.services.user.update(id, body);
      res.json(user);
    },
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DELETE /users/:id — 删除用户（需认证）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  app.delete(
    "/:id",
    {
      validate: {
        param: { id: "string:1-" },
      },
      docs: {
        summary: "删除用户",
        description: "删除指定用户。需要 Bearer Token 认证。此操作不可逆。",
        responses: {
          204: { description: "删除成功（无响应体）" },
          401: { description: "未认证" },
          404: { description: "用户不存在" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const { id } = req.valid("param");

      app.logger.info(
        { operator: req.auth.userId, targetUser: id },
        "操作员删除用户",
      );

      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## 6. 入口文件

```typescript
// src/index.ts
import { bootstrap } from "vextjs";

bootstrap().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
```

## 7. 测试

```typescript
// test/users.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";
import type { TestApp } from "vextjs";

describe("用户 CRUD", () => {
  let testApp: TestApp;
  const AUTH_TOKEN = "user-1-admin"; // 模拟管理员 token

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp?.close();
  });

  // ── 查询 ──────────────────────────────────────

  describe("GET /users/list", () => {
    it("应返回分页用户列表", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.total).toBeGreaterThan(0);
      expect(res.body.data.page).toBe(1);
    });

    it("支持关键词搜索", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 1, limit: 10, keyword: "alice" });

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].name).toBe("Alice");
    });

    it("分页参数校验失败应返回 422", async () => {
      const res = await testApp.request
        .get("/users/list")
        .query({ page: 0, limit: 10 }); // page 最小值为 1

      expect(res.status).toBe(422);
    });
  });

  describe("GET /users/:id", () => {
    it("存在时应返回用户详情", async () => {
      const res = await testApp.request.get("/users/1");

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: "1",
        name: "Alice",
        email: "alice@example.com",
      });
    });

    it("不存在时应返回 404", async () => {
      const res = await testApp.request.get("/users/999");

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("用户不存在");
    });
  });

  // ── 创建 ──────────────────────────────────────

  describe("POST /users", () => {
    it("认证后应成功创建用户", async () => {
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

    it("未认证应返回 401", async () => {
      const res = await testApp.request
        .post("/users")
        .send({ name: "Test", email: "test@example.com" });

      expect(res.status).toBe(401);
    });

    it("邮箱重复应返回 409", async () => {
      const res = await testApp.request
        .post("/users")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({
          name: "Alice Copy",
          email: "alice@example.com", // 已存在
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(10001);
    });

    it("name 为空应返回 422", async () => {
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

    it("email 格式无效应返回 422", async () => {
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

  // ── 更新 ──────────────────────────────────────

  describe("PUT /users/:id", () => {
    it("认证后应成功更新用户", async () => {
      const res = await testApp.request
        .put("/users/1")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ name: "Alice Updated" });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Alice Updated");
      expect(res.body.data.email).toBe("alice@example.com"); // 未修改的字段保持不变
    });

    it("更新不存在的用户应返回 404", async () => {
      const res = await testApp.request
        .put("/users/999")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ name: "Ghost" });

      expect(res.status).toBe(404);
    });

    it("邮箱冲突应返回 409", async () => {
      const res = await testApp.request
        .put("/users/1")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`)
        .send({ email: "bob@example.com" }); // Bob 的邮箱

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(10002);
    });
  });

  // ── 删除 ──────────────────────────────────────

  describe("DELETE /users/:id", () => {
    it("认证后应成功删除用户", async () => {
      const res = await testApp.request
        .delete("/users/2")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(204);

      // 确认已删除
      const getRes = await testApp.request.get("/users/2");
      expect(getRes.status).toBe(404);
    });

    it("删除不存在的用户应返回 404", async () => {
      const res = await testApp.request
        .delete("/users/999")
        .set("Authorization", `Bearer ${AUTH_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it("未认证应返回 401", async () => {
      const res = await testApp.request.delete("/users/1");

      expect(res.status).toBe(401);
    });
  });

  // ── 健康检查 ──────────────────────────────────

  describe("GET /", () => {
    it("应返回服务状态", async () => {
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

## 8. 运行

### 开发模式

```bash
pnpm dev
```

启动后可以：

- 访问 `http://localhost:3000/` 查看健康检查
- 访问 `http://localhost:3000/docs` 查看自动生成的 Vext Docs API 文档
- 使用 `curl` 测试各个接口

### 运行测试

```bash
pnpm test
```

## 9. 接口测试

```bash
# 健康检查
curl http://localhost:3000/
# → {"code":0,"data":{"status":"ok","users":3,...},"requestId":"..."}

# 查询用户列表
curl "http://localhost:3000/users/list?page=1&limit=10"
# → {"code":0,"data":{"items":[...],"total":3,"page":1,"limit":10,"totalPages":1},"requestId":"..."}

# 搜索用户
curl "http://localhost:3000/users/list?page=1&limit=10&keyword=alice"
# → {"code":0,"data":{"items":[{"id":"1","name":"Alice",...}],...},"requestId":"..."}

# 查询单个用户
curl http://localhost:3000/users/1
# → {"code":0,"data":{"id":"1","name":"Alice","email":"alice@example.com",...},"requestId":"..."}

# 创建用户（需认证）
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"Diana","email":"diana@example.com","age":25}'
# → 201 {"code":0,"data":{"id":"4","name":"Diana",...},"requestId":"..."}

# 更新用户（需认证）
curl -X PUT http://localhost:3000/users/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"Alice Updated"}'
# → {"code":0,"data":{"id":"1","name":"Alice Updated",...},"requestId":"..."}

# 删除用户（需认证）
curl -X DELETE http://localhost:3000/users/2 \
  -H "Authorization: Bearer user-1-admin"
# → 204 No Content

# 未认证访问受保护接口
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com"}'
# → 401 {"code":-1,"message":"未提供认证令牌","requestId":"..."}

# 参数校验失败
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user-1-admin" \
  -d '{"name":"","email":"invalid"}'
# → 422 {"code":422,"message":"Validation failed","errors":[...],"requestId":"..."}
```

## 10. 关键概念总结

### 请求-响应流程

```
客户端请求
  → requestId 中间件（生成/透传请求 ID）
  → CORS 中间件（处理跨域）
  → body-parser 中间件（解析请求体）
  → access-log 中间件（记录开始时间）
  → rate-limit 中间件（速率限制检查）
  → response-wrapper 中间件（开启出口包装）
  → auth 中间件（验证 token，注入 req.auth）  ← 仅受保护路由
  → validate 中间件（参数校验）              ← 有 validate 配置时
  → handler（业务逻辑）
  → 出口包装（{ code: 0, data, requestId }）
  → 响应返回
```

### 错误处理流程

```
handler 中 app.throw(404, '用户不存在')
  → 抛出 HttpError
  → error-handler 中间件捕获
  → 转换为标准错误响应
  → {"code":-1,"message":"用户不存在","requestId":"..."}
  → HTTP 404
```

### 设计模式

| 模式                 | 说明                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| **三段式路由**       | `app.method(path, options, handler)` — 声明式配置                             |
| **服务层分离**       | 业务逻辑封装在 `src/services/` 中，路由只做编排                               |
| **中间件白名单**     | 路由级中间件必须在 `config.middlewares` 中声明                                |
| **Auth 保护**        | `auth()` 填充 `req.auth`，`RouteOptions.auth` 保护路由并驱动 OpenAPI security |
| **声明式校验**       | `validate` 使用 schema-dsl DSL 语法，自动类型转换                             |
| **统一错误处理**     | `app.throw()` 抛出错误，框架自动转为标准格式                                  |
| **出口包装**         | 所有成功响应自动包装为 `{ code: 0, data, requestId }`                         |
| **OpenAPI 自动生成** | 从 `validate` 和 `docs` 配置自动生成 API 文档                                 |

## 下一步

- 📖 [permission-core Auth 接入](/zh/examples/permission-core-auth) — 将细粒度授权内核接入 Vext Auth
- 📖 [测试](/guide/testing) — 深入了解 VextJS 测试工具的高级用法
- 📖 [OpenAPI 文档](/guide/openapi) — 深入了解 OpenAPI 自动生成的配置选项
