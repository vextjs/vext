# 测试

VextJS 内置了完整的测试工具，通过 `vextjs/testing` 子路径导入。无需启动真实 HTTP 服务器，即可对路由、中间件、服务进行端到端测试。

ESM `import` 与 CommonJS `require()` 均受支持。根入口和公开子路径共享运行时身份：例如通过 `vextjs/testing` 创建的错误仍满足 `instanceof require("vextjs").HttpError`，logger 生命周期元数据也可跨这些入口读取。

## 快速开始

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

VextJS 推荐使用 [Vitest](https://vitest.dev/) 作为测试框架，但测试工具本身不依赖任何特定测试框架，你也可以搭配 Jest、Node.js 内置 test runner 等使用。

## `createTestApp()`

`createTestApp()` 是测试的核心 API。它创建一个完整的应用实例，模拟请求处理流程，但不启动 HTTP 监听。

### 基本用法

```typescript
import { createTestApp } from "vextjs/testing";

// 使用默认配置（自动加载 src/routes、src/services 等）
const app = await createTestApp();

// 发送测试请求
const res = await app.request.get("/users");
expect(res.status).toBe(200);
```

### 配置选项

```typescript
interface CreateTestAppOptions {
  /** 深度合并到框架默认值与测试默认值之上的后层 patch */
  config?: VextConfigOverride;

  /** 是否加载 src/plugins/ 目录中的插件（默认 false） */
  plugins?: boolean;

  /** 自定义插件 setup 函数（替代文件系统扫描） */
  setupPlugins?: (app: VextApp) => Promise<void> | void;

  /** 是否加载 src/services/ 目录中的服务（默认 true） */
  services?: boolean;

  /** 模拟服务对象（替代自动扫描的服务） */
  mockServices?: Partial<VextServices>;

  /** 是否加载 src/routes/ 目录中的路由（默认 true） */
  routes?: boolean;

  /** 是否加载 src/middlewares/ 目录中的中间件（默认 true） */
  middlewares?: boolean;

  /** 项目根目录（默认 process.cwd()） */
  rootDir?: string;
}
```

`CreateTestAppOptions.config` 是覆盖层，不是独立的基础配置。`VextConfigOverride`
允许测试局部 patch 框架/测试默认值中已经存在的嵌套字段；adapter、store、callback
与数组等原子值仍必须完整提供。

`createTestApp()` 不会加载项目的 `src/config/default.ts`，内置测试默认值也没有
`database`。因此测试若新增这个可选 section，必须提供包含必填连接 `config` 的
完整 database 配置；不能指望不存在的前层补齐半截 database。

### 常见配置场景

#### 自定义端口和日志级别

```typescript
const app = await createTestApp({
  config: {
    port: 0,
    logger: { level: "silent" }, // 测试时静默日志
  },
});
```

#### 跳过插件加载

```typescript
const app = await createTestApp({
  plugins: false, // 默认值：不加载 src/plugins/ 下的插件
});
```

#### 模拟服务

```typescript
const app = await createTestApp({
  services: false, // 不加载真实的 service
  mockServices: {
    user: {
      findAll: async () => [{ id: "1", name: "Alice" }],
      findById: async (id: string) => ({ id, name: "Alice" }),
      create: async (data: any) => ({ id: "99", ...data }),
    },
  },
});
```

#### 自定义插件

```typescript
const app = await createTestApp({
  setupPlugins: async (app) => {
    // 注入测试用的模拟对象
    app.extend("testCache", new Map());
    app.extend("mailer", {
      send: async () => ({ messageId: "test-123" }),
    });
  },
});
```

## 发送测试请求

`createTestApp()` 返回的对象包含 `request` 属性，支持所有 HTTP 方法：

```typescript
const app = await createTestApp();

// GET
const res1 = await app.request.get("/users");

// POST
const res2 = await app.request.post("/users");

// PUT
const res3 = await app.request.put("/users/1");

// PATCH
const res4 = await app.request.patch("/users/1");

// DELETE
const res5 = await app.request.delete("/users/1");

// OPTIONS
const res6 = await app.request.options("/users");

// HEAD
const res7 = await app.request.head("/users");
```

### 链式构建请求

每个 HTTP 方法返回一个 `TestRequestBuilder`，支持链式调用来配置请求：

```typescript
const res = await app.request
  .post("/users")
  .set("Authorization", "Bearer test-token") // 设置单个 header
  .headers({
    // 批量设置 headers
    "X-Custom": "value",
    "Accept-Language": "zh-CN",
  })
  .query({ page: "1", limit: "10" }) // 设置 query 参数
  .type("application/json") // 设置 Content-Type
  .send({ name: "Alice", email: "alice@example.com" }); // 设置请求体
```

#### `.set(name, value)` — 设置单个请求头

```typescript
app.request
  .get("/profile")
  .set("Authorization", "Bearer my-token")
  .set("Accept-Language", "en-US");
```

#### `.headers(obj)` — 批量设置请求头

```typescript
app.request.get("/data").headers({
  Authorization: "Bearer token",
  "X-Request-Id": "test-req-001",
});
```

#### `.query(obj)` — 设置 URL 查询参数

```typescript
app.request.get("/search").query({ keyword: "vext", page: "1", limit: "20" });
// 实际请求 URL: /search?keyword=vext&page=1&limit=20
```

#### `.send(body)` — 设置请求体

```typescript
// 发送 JSON（默认 Content-Type: application/json）
app.request.post("/users").send({ name: "Alice", email: "alice@example.com" });

// 发送字符串
app.request.post("/raw").type("text/plain").send("Hello World");
```

#### `.type(contentType)` — 设置 Content-Type

```typescript
app.request
  .post("/upload")
  .type("application/x-www-form-urlencoded")
  .send("name=Alice&email=alice@example.com");
```

### `TestResponse` 响应对象

请求完成后返回 `TestResponse` 对象：

```typescript
interface TestResponse {
  /** HTTP 状态码 */
  status: number;

  /** 响应头（小写 key，Set-Cookie 可能是 string[]） */
  headers: Record<string, string | string[]>;

  /** Set-Cookie 响应头 */
  cookies: string[];

  /** 读取响应头的第一个值 */
  header(name: string): string | undefined;

  /** 读取响应头的所有值 */
  headerValues(name: string): string[];

  /** 解析后的响应体（JSON 自动解析为对象） */
  body: any;

  /** 原始响应体文本 */
  text: string;
}
```

```typescript
const res = await app.request.get("/users");

// 断言状态码
expect(res.status).toBe(200);

// 断言响应体（JSON 自动解析）
expect(res.body).toEqual({
  code: 0,
  data: [{ id: "1", name: "Alice" }],
  requestId: expect.any(String),
});

// 断言响应头
expect(res.header("content-type")).toContain("application/json");
expect(res.headers["x-request-id"]).toBeDefined();
expect(res.headerValues("set-cookie")).toEqual(res.cookies);

// 断言原始文本
expect(res.text).toContain('"code":0');
```

## 测试模式特性

`createTestApp()` 创建的应用处于测试模式（`_testMode: true`），与生产模式有以下区别：

| 特性             | 测试模式      | 生产模式      |
| ---------------- | ------------- | ------------- |
| HTTP 监听        | ❌ 不启动     | ✅ 监听端口   |
| `process.exit()` | ❌ 不调用     | ✅ 关闭时调用 |
| 日志级别         | 默认 `silent` | 由配置决定    |
| 限流             | 默认禁用      | 由配置决定    |
| 关闭超时         | 默认 1 秒     | 由配置决定    |

## 实战示例

### 测试 CRUD 路由

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

### 测试中间件

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

### 使用模拟服务测试

当你只想测试路由逻辑而不想依赖真实的数据库时，使用 `mockServices`：

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

### 测试服务层（单元测试）

服务层可以独立于 HTTP 进行单元测试。直接实例化 service，传入模拟的 `app` 对象：

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

### 测试错误响应

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

### 测试自定义请求头

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

## 项目配置

### TypeScript 服务文件与 ESM 加载

当 `services: true`（默认）时，`createTestApp()` 会扫描 `src/services/` 并加载 `.ts` 源文件。`service-loader` 内部自动用 **esbuild** 将每个 `.ts` 文件 bundle 编译后加载，完整解决两个原生问题：

| 问题                              | 原因                                                                                  | 解决方式                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `ERR_UNKNOWN_FILE_EXTENSION: .ts` | Node.js 原生 ESM 不支持 `.ts` 扩展名                                                  | esbuild 编译为 `.mjs` 后再 `import()`                 |
| `.js → .ts` 重映射缺失            | TypeScript ESM 约定在 `import` 中写 `.js`，Node.js/Vite resolver 均不自动回退到 `.ts` | esbuild `bundle: true` 在编译阶段完整解析所有本地依赖 |

**不受此限制影响的场景**：

- `vext start`（从 `dist/services/*.js` 加载已编译文件）
- `vext dev`（从 `.vext/dev/services/*.js` 加载 esbuild 编译产物）
- 集成测试使用 `mockServices`（绕过 service-loader 扫描）

:::tip 单元测试推荐 mockServices
如果测试只关注路由逻辑，使用 `mockServices` + `services: false` 速度更快且完全隔离，无需加载真实 `.ts` 服务文件：

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

### Vitest 配置

推荐的 `vitest.config.ts` 配置：

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

### 测试目录结构

推荐的测试目录组织方式：

```
test/
├── unit/                    # 单元测试
│   ├── services/
│   │   ├── user.test.ts
│   │   └── order.test.ts
│   ├── middlewares/
│   │   └── auth.test.ts
│   └── lib/
│       └── config-loader.test.ts
│
├── integration/             # 集成测试
│   ├── routes/
│   │   ├── users.test.ts
│   │   └── orders.test.ts
│   └── plugins/
│       └── redis.test.ts
│
└── e2e/                     # 端到端测试
    └── api.test.ts
```

### package.json 脚本

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

## 最佳实践

### 1. 测试时静默日志

避免测试输出被日志信息淹没：

```typescript
const app = await createTestApp({
  config: {
    logger: { level: "silent" },
  },
});
```

### 2. 使用 `beforeAll` 复用应用实例

`createTestApp()` 有一定的初始化开销。在同一个 `describe` 块中复用应用实例：

```typescript
describe("Users API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  it("test 1", async () => {
    /* 复用 app */
  });
  it("test 2", async () => {
    /* 复用 app */
  });
});
```

### 3. 隔离测试副作用

如果测试会修改数据状态，使用模拟服务避免测试间的副作用：

```typescript
const app = await createTestApp({
  services: false,
  mockServices: {
    user: createFreshMockUserService(), // 每组测试使用新的 mock
  },
});
```

### 4. 测试边界情况

不要只测试正常路径，也要覆盖错误情况：

```typescript
// ✅ 测试正常 + 异常
it("should create user", async () => {
  /* 正常创建 */
});
it("should reject invalid email", async () => {
  /* 校验失败 */
});
it("should reject duplicate email", async () => {
  /* 业务错误 */
});
it("should reject without auth", async () => {
  /* 未认证 */
});
it("should reject with wrong role", async () => {
  /* 无权限 */
});
```

### 5. 断言响应结构

使用 `toMatchObject` 或 `toEqual` 断言完整的响应结构，而非只检查单个字段：

```typescript
// ✅ 断言完整结构
expect(res.body).toMatchObject({
  code: 0,
  data: {
    id: expect.any(String),
    name: "Alice",
    email: "alice@example.com",
  },
  requestId: expect.any(String),
});

// ❌ 只检查单个字段（容易遗漏问题）
expect(res.body.data.name).toBe("Alice");
```

### 6. 单元测试优先使用 mockServices

**单元测试**（测试路由逻辑、中间件、错误处理）应使用 `mockServices` 替代真实服务，原因：

- ✅ 速度更快（无 esbuild 编译开销，无数据库连接）
- ✅ 完全隔离（不依赖服务实现细节，测试更稳定）
- ✅ 可精确控制返回值和错误场景

```typescript
// ✅ 单元测试：mock 服务，专注路由逻辑
const app = await createTestApp({
  services: false,
  mockServices: {
    user: {
      findAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findById: vi.fn().mockResolvedValue(null), // 模拟"不存在"场景
      create: vi.fn().mockRejectedValue(
        // 模拟"邮箱重复"场景
        Object.assign(new Error("email_taken"), { status: 409 }),
      ),
    },
  },
});

// ✅ 集成测试：加载真实服务，测试完整业务流程
const app = await createTestApp({
  services: true, // 默认，service-loader 自动处理 .ts 编译
});
```

| 测试类型 |   `services`   | `mockServices` | 适用场景                       |
| -------- | :------------: | :------------: | ------------------------------ |
| 单元测试 |    `false`     |      有值      | 路由逻辑、中间件、错误响应格式 |
| 集成测试 | `true`（默认） |    可选覆盖    | 完整业务流程、服务间依赖       |

## 下一步

- 了解 [路由](/guide/routing) 如何定义可测试的 API
- 学习 [服务层](/guide/services) 的单元测试模式
- 查看 [CLI 命令](/guide/cli) 了解 `dev` / `build` / `start` 等运行命令
- 探索 [中间件](/guide/middleware) 的测试技巧
