# 测试工具

本页详细介绍 VextJS 的测试工具 API，包括 `createTestApp`、`TestApp`、`TestRequest`、`TestRequestBuilder` 和 `TestResponse`。

## 概述

VextJS 提供零配置的测试工具，通过 `vextjs/testing` 子路径导入：

```typescript
import { createTestApp } from "vextjs/testing";
```

**核心设计**：

- **零网络 I/O**：`TestRequest` 内部不启动 HTTP 服务器，直接通过 `adapter.buildHandler()` 构造 `(req, res)` handler，用内存中的 Mock 对象模拟请求。比 `supertest` 更快，CI 中可并行运行无端口冲突。
- **零配置**：默认禁用限流并使用静默日志。`TestRequest` 不会打开 HTTP listener；`port: 0` 只是隔离测试的配置默认值。
- **链式 API**：类似 `supertest` 风格的链式请求构造器，支持 `await` 直接获取响应。
- **安全退出**：`config._testMode = true` 阻止 `shutdown()` 调用 `process.exit(0)`。

---

## createTestApp

`createTestApp` 是测试用 App 工厂函数，创建一个完整的测试应用实例。

### 函数签名

```typescript
async function createTestApp(options?: CreateTestAppOptions): Promise<TestApp>;
```

### 基本用法

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("用户接口", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("GET /users/list 应返回用户列表", async () => {
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

### 返回值

返回 `Promise<TestApp>`，包含 `app`、`request` 和 `close` 三个成员。

---

## CreateTestAppOptions

`createTestApp` 的配置选项。所有字段均为可选。

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

### 字段说明

| 字段           | 类型                         | 默认值          | 说明                                          |
| -------------- | ---------------------------- | --------------- | --------------------------------------------- |
| `config`       | `VextConfigOverride`         | `{}`            | 合并到框架默认值与测试默认值之上的后层 patch  |
| `plugins`      | `boolean`                    | `false`         | 是否加载 `src/plugins/`（测试环境默认不加载） |
| `setupPlugins` | `Function`                   | `undefined`     | 手动注册插件（替代自动扫描）                  |
| `services`     | `boolean`                    | `true`          | 是否加载 `src/services/`                      |
| `mockServices` | `Partial<VextServices>`      | `undefined`     | 手动注入 mock services                        |
| `routes`       | `boolean`                    | `true`          | 是否加载 `src/routes/`                        |
| `middlewares`  | `boolean`                    | `true`          | 是否加载 `src/middlewares/`                   |
| `rootDir`      | `string`                     | `process.cwd()` | 项目根目录（用于定位 `src/` 子目录）          |
| `devOverlay`   | `(error: unknown) => string` | `undefined`     | 请求接受 `text/html` 时的可选 HTML 错误渲染器 |

---

### `config`

按 profile/local 配置相同的路径感知深度合并语义 patch 框架默认值与测试默认值。
这些默认值中已经存在的嵌套 plain object 可以局部提供；adapter、store、callback
与数组等原子值仍保持完整。`createTestApp()` 不加载项目的
`src/config/default.ts`，其内置默认值也不包含 `database`；若新增该可选 section，
必须提供完整 database 配置，不能只写半截 patch。

```typescript
testApp = await createTestApp({
  config: {
    adapter: "fastify", // 测试特定 adapter
    response: { wrap: false }, // 禁用出口包装
    cors: { enabled: false }, // 禁用 CORS
  },
});
```

**测试默认配置**（自动应用，无需手动设置）：

```typescript
{
  port: 0,                // 隔离测试配置；TestRequest 不监听端口
  host: '127.0.0.1',
  logger: { level: 'silent' },  // 日志静默
  rateLimit: {
    enabled: false,        // 禁用限流
    max: 100,
    window: 60,
    message: 'Too Many Requests',
    keyBy: 'ip',
  },
  accessLog: { enabled: false }, // 关闭请求日志噪声
  session: { enabled: false },   // 与应用运行时保持相同的显式启用默认值
  shutdown: { timeout: 1 },  // 快速关闭（1 秒）
  _testMode: true,            // 阻止 process.exit()
}
```

配置合并优先级从低到高为：`DEFAULT_CONFIG` → `测试默认值` → `config 参数`。显式设置 `rateLimit.enabled`、`accessLog.enabled` 或 `session.enabled` 为 `true` 时，会注册与生产、开发环境相同的内置运行时。

`TestRequest` 直接调用已构建的 handler，因此其请求不会绑定或连接到这个端口。

---

### `plugins`

控制是否自动扫描 `src/plugins/` 目录加载插件。

```typescript
// 默认不加载插件（单元测试通常不需要真实插件）
testApp = await createTestApp(); // plugins: false

// 集成测试可能需要加载插件
testApp = await createTestApp({ plugins: true });
```

---

### `setupPlugins`

手动注册插件，替代自动扫描。适用于需要精确控制测试依赖的场景。

```typescript
testApp = await createTestApp({
  setupPlugins: async (app) => {
    // 只注册测试需要的插件
    app.extend("testCache", new MockCache());
    app.extend("db", new MockDatabase());
  },
});
```

:::tip
`setupPlugins` 用于替代自动扫描：当传入 `setupPlugins` 时，测试工具只执行该函数，不再读取 `plugins: true` 触发的文件系统扫描。若需要真实插件，请使用 `plugins: true`；若需要精确控制测试依赖，请只使用 `setupPlugins`。
:::

---

### `services`

控制是否自动加载 `src/services/` 目录的服务。

```typescript
// 加载真实服务（默认，集成测试推荐）
testApp = await createTestApp(); // services: true

// 不加载服务（单元测试推荐：使用 mockServices 替代）
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

#### TypeScript 服务文件加载机制

当 `services: true` 时，`service-loader` 扫描 `src/services/` 目录并自动加载 `.ts` 源文件。由于 Node.js 原生 ESM 存在两个限制，框架内部使用 **esbuild** 自动处理：

| 限制                              | 说明                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `ERR_UNKNOWN_FILE_EXTENSION: .ts` | Node.js 原生 ESM 不支持直接 `import()` `.ts` 文件                                          |
| `.js → .ts` 重映射缺失            | TypeScript ESM 约定在 import 中写 `.js` 扩展名，Node.js/Vite resolver 均不自动回退到 `.ts` |

`service-loader` 对每个 `.ts` 服务文件执行以下流程：

1. 调用 `esbuild.build({ bundle: true, packages: 'external' })` 将 `.ts` 及其本地相对依赖打包为 `.mjs`
2. 将编译产物写到源文件同目录的临时文件（命名含 `.__vext_compiled__`，不会被重复扫描）
3. `import()` 临时 `.mjs` 文件，完成后自动清理

:::tip 单元测试推荐：优先使用 mockServices
`services: false` + `mockServices` 方案无需 esbuild 编译，速度更快且隔离性更好，是**单元测试**的推荐方式。`services: true` 适用于需要真实服务行为的**集成测试**。
:::

---

### `mockServices`

手动注入 mock 服务，覆盖 `service-loader` 扫描结果。

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

**合并逻辑**：

| `services` | `mockServices` | 行为                                             |
| :--------: | :------------: | ------------------------------------------------ |
|   `true`   |      有值      | 先加载真实服务，再用 `mockServices` 覆盖同名服务 |
|   `true`   |      无值      | 仅使用真实服务                                   |
|  `false`   |      有值      | 仅使用 `mockServices`                            |
|  `false`   |      无值      | `app.services` 为空对象 `{}`                     |

---

### `routes`

控制是否自动加载 `src/routes/` 目录的路由文件。

```typescript
// 加载真实路由（默认，集成测试）
testApp = await createTestApp(); // routes: true

// 不加载路由（单元测试服务层时不需要路由）
testApp = await createTestApp({ routes: false });
```

---

### `middlewares`

控制是否自动加载 `src/middlewares/` 目录的用户中间件。

```typescript
// 加载用户中间件（默认）
testApp = await createTestApp(); // middlewares: true

// 跳过用户中间件加载（测试不涉及路由级中间件时）
testApp = await createTestApp({ middlewares: false });
```

:::tip
无论 `middlewares` 设置如何，**内置中间件**（requestId / cors / bodyParser / responseWrapper / errorHandler）始终会注册。此选项只控制 `src/middlewares/` 目录下的用户自定义中间件。
:::

---

### `rootDir`

项目根目录，用于定位 `src/routes`、`src/services`、`src/plugins` 等目录。

```typescript
import { join } from "node:path";

testApp = await createTestApp({
  rootDir: join(__dirname, "../../"), // 自定义项目根目录
});
```

---

## TestApp

`createTestApp` 返回的测试应用实例。

```typescript
interface TestApp {
  app: VextApp;
  request: TestRequest;
  close(): Promise<void>;
}
```

### `app`

底层 `VextApp` 实例，可用于直接访问应用能力：

```typescript
const testApp = await createTestApp();

// 访问配置
console.log(testApp.app.config.port);

// 访问服务
const user = await testApp.app.services.user.findById("1");

// 访问日志
testApp.app.logger.info("测试中");
```

### `request`

HTTP 请求模拟器，类似 `supertest` 风格的 API。详见 [TestRequest](#testrequest)。

### `close()`

关闭测试应用，触发 `onClose` 钩子、清理资源。

```typescript
close(): Promise<void>;
```

:::warning
**务必在 `afterEach` 或 `afterAll` 中调用 `close()`**，否则会导致资源泄漏（数据库连接、定时器等）和测试进程无法退出。
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

HTTP 请求模拟器，提供类似 `supertest` 风格的链式 API。

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

### 支持的 HTTP 方法

| 方法                    | 说明              |
| ----------------------- | ----------------- |
| `request.get(path)`     | 发送 GET 请求     |
| `request.post(path)`    | 发送 POST 请求    |
| `request.put(path)`     | 发送 PUT 请求     |
| `request.patch(path)`   | 发送 PATCH 请求   |
| `request.delete(path)`  | 发送 DELETE 请求  |
| `request.options(path)` | 发送 OPTIONS 请求 |
| `request.head(path)`    | 发送 HEAD 请求    |

每个方法返回 `TestRequestBuilder`，支持链式配置后通过 `await` 执行请求。

:::note HEAD 响应
`request.head(path)` 遵守 HTTP HEAD 语义。响应状态码和响应头会保留，但即使路由处理器写入响应体，`TestResponse.text` 和 `TestResponse.body` 也为空。需要断言响应体时，请使用对应的 `GET` 路由。
:::

### 基本用法

```typescript
// GET 请求
const res = await testApp.request.get("/users/list");

// POST 请求
const res = await testApp.request.post("/users").send({
  name: "Alice",
  email: "alice@example.com",
});

// PUT 请求
const res = await testApp.request.put("/users/1").send({
  name: "Alice Updated",
});

// DELETE 请求
const res = await testApp.request.delete("/users/1");

// OPTIONS 请求（CORS 预检）
const res = await testApp.request.options("/users");
```

---

## TestRequestBuilder

链式请求构造器，支持设置请求头、查询参数、请求体等，最终通过 `await` 或 `.then()` 执行请求。

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
`TestRequestBuilder` 实现了 `PromiseLike` 接口，因此可以直接使用 `await` 执行请求，无需调用额外的 `.execute()` 方法。
:::

---

### `set(key, value)`

设置单个请求头。

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

设置多个请求头（对象形式）。

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
`set()` 和 `headers()` 可以混合使用，后设置的值会覆盖先设置的同名请求头。
:::

---

### `query(params)`

设置 URL 查询参数。

```typescript
query(params: Record<string, string | number | boolean>): this;
```

参数值会自动转换为字符串并 URL 编码。

```typescript
const res = await testApp.request
  .get("/users/list")
  .query({ page: 1, limit: 10, active: true });
// 等价于 GET /users/list?page=1&limit=10&active=true

expect(res.status).toBe(200);
expect(res.body.data).toHaveLength(10);
```

多次调用 `query()` 会合并参数：

```typescript
const res = await testApp.request
  .get("/search")
  .query({ keyword: "hello" })
  .query({ page: 1 });
// 等价于 GET /search?keyword=hello&page=1
```

---

### `send(body)`

设置请求体。自动序列化为 JSON 并设置 `Content-Type: application/json`。

```typescript
send(body: unknown): this;
```

```typescript
// JSON 对象
const res = await testApp.request
  .post("/users")
  .send({ name: "Alice", email: "alice@example.com" });

expect(res.status).toBe(201);
expect(res.body.data.name).toBe("Alice");
```

```typescript
// 嵌套对象
const res = await testApp.request.post("/orders").send({
  items: [
    { productId: "p1", quantity: 2 },
    { productId: "p2", quantity: 1 },
  ],
  shippingAddress: {
    city: "北京",
    street: "朝阳区xxx路",
  },
});
```

```typescript
// 字符串（直接发送，不做 JSON 序列化）
const res = await testApp.request
  .post("/webhook")
  .type("text/plain")
  .send("raw text body");
```

---

### `type(contentType)`

设置 `Content-Type` 请求头。

```typescript
type(contentType: string): this;
```

```typescript
// 发送 form-urlencoded
const res = await testApp.request
  .post("/login")
  .type("application/x-www-form-urlencoded")
  .send("username=alice&password=secret");

// 发送 XML
const res = await testApp.request
  .post("/xml-endpoint")
  .type("application/xml")
  .send("<user><name>Alice</name></user>");
```

:::tip
`send()` 会自动设置 `Content-Type: application/json`（如果尚未设置）。如果需要其他类型，在 `send()` 之前调用 `type()` 进行覆盖。
:::

---

### 链式组合

所有方法支持链式调用，最终通过 `await` 执行请求：

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

模拟 HTTP 响应对象，包含状态码、响应头和解析后的响应体。

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

HTTP 状态码。

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

响应头对象，所有 key 为小写。

```typescript
headers: Record<string, string | string[]>;
```

```typescript
const res = await testApp.request.get("/users/list");

// 检查 Content-Type
expect(res.header("content-type")).toContain("application/json");

// 检查自定义响应头
expect(res.headers["x-request-id"]).toBeDefined();

// 检查 CORS 头
expect(res.headers["access-control-allow-origin"]).toBeDefined();
```

`Set-Cookie` 会保留为数组。断言 cookie 时优先使用 `res.cookies` 或 `res.headerValues("set-cookie")`：

```typescript
expect(res.cookies).toHaveLength(2);
expect(res.headerValues("set-cookie")).toEqual(res.cookies);
expect(res.header("content-type")).toContain("application/json");
```

---

### `body`

自动解析的 JSON 响应体。如果响应的 `Content-Type` 为 `application/json`，`body` 为解析后的 JavaScript 对象/数组；否则为 `undefined`。

```typescript
body: any;
```

```typescript
const res = await testApp.request.get("/users/list");

// 出口包装格式
expect(res.body).toEqual({
  code: 0,
  data: expect.any(Array),
  requestId: expect.any(String),
});

// 直接访问业务数据
expect(res.body.data).toHaveLength(2);
expect(res.body.data[0].name).toBe("Alice");
```

**错误响应**：

```typescript
const res = await testApp.request.get("/users/nonexistent-id");

expect(res.body).toEqual({
  code: -1,
  message: "用户不存在",
  requestId: expect.any(String),
});
```

**带业务错误码**：

```typescript
const res = await testApp.request.post("/users").send({
  email: "existing@example.com",
});

expect(res.body.code).toBe(10001);
expect(res.body.message).toBe("邮箱已注册");
```

---

### `text`

原始响应文本。对于 JSON 响应，`text` 是 JSON 字符串；对于文本响应，`text` 是原始文本内容。

```typescript
text: string;
```

```typescript
// JSON 响应的原始文本
const res = await testApp.request.get("/users/list");
console.log(res.text);
// '{"code":0,"data":[...],"requestId":"..."}'

// 文本响应
const res2 = await testApp.request.get("/health");
expect(res2.text).toBe("OK");
```

---

## 使用模式

### 集成测试

加载真实的路由、服务、中间件，验证完整的请求-响应流程：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";
import type { TestApp } from "vextjs";

describe("用户 CRUD", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp({
      plugins: true, // 加载真实插件（如数据库）
    });
  });

  afterEach(async () => {
    await testApp.close();
  });

  it("创建用户", async () => {
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

  it("查询用户列表", async () => {
    const res = await testApp.request
      .get("/users/list")
      .query({ page: 1, limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("用户不存在应返回 404", async () => {
    const res = await testApp.request.get("/users/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("用户不存在");
  });

  it("参数校验失败应返回 422", async () => {
    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer test-admin-token")
      .send({
        name: "", // 不满足 string:1-50
        email: "invalid-email", // 不满足 email 格式
      });

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
```

---

### 单元测试（Mock Services）

不加载真实服务，使用 mock 替代，专注测试路由逻辑：

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("用户路由（mock 服务）", () => {
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

  it("GET /users/list 调用 findAll", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });

    const res = await testApp.request
      .get("/users/list")
      .query({ page: "1", limit: "10" });

    expect(res.status).toBe(200);
    expect(mockUserService.findAll).toHaveBeenCalledOnce();
  });

  it("GET /users/:id 存在时返回用户", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });

    const res = await testApp.request.get("/users/1");

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Alice");
    expect(mockUserService.findById).toHaveBeenCalledWith("1");
  });

  it("GET /users/:id 不存在时返回 404", async () => {
    testApp = await createTestApp({
      mockServices: { user: mockUserService },
    });

    const res = await testApp.request.get("/users/999");

    expect(res.status).toBe(404);
  });
});
```

---

### 测试中间件

验证认证、权限等中间件的行为：

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("认证中间件", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("无 token 应返回 401", async () => {
    testApp = await createTestApp();

    const res = await testApp.request.post("/users").send({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("认证");
  });

  it("无效 token 应返回 401", async () => {
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

  it("有效 token 应正常通过", async () => {
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

### 测试不同 Adapter

验证 Adapter 切换后行为一致：

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

const adapters = ["native", "hono", "fastify", "express", "koa"] as const;

describe.each(adapters)("Adapter: %s", (adapter) => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("GET /health 应返回 200", async () => {
    testApp = await createTestApp({
      config: { adapter },
    });

    const res = await testApp.request.get("/health");
    expect(res.status).toBe(200);
  });

  it("POST JSON 应正确解析 body", async () => {
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

### 测试自定义插件

使用 `setupPlugins` 注册测试专用插件：

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("Redis 缓存插件", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("缓存命中时直接返回", async () => {
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

    // 假设路由 handler 会读取 app.userCache，应返回缓存数据
    const res = await testApp.request.get("/users/1");
    expect(res.status).toBe(200);
  });
});
```

---

### 测试错误处理

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("错误处理", () => {
  let testApp;

  afterEach(async () => {
    await testApp?.close();
  });

  it("404 路由应返回标准格式", async () => {
    testApp = await createTestApp();

    const res = await testApp.request.get("/nonexistent-path");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: expect.any(Number),
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("校验失败应返回错误列表", async () => {
    testApp = await createTestApp();

    const res = await testApp.request
      .post("/users")
      .set("Authorization", "Bearer valid-token")
      .send({}); // 缺少必填字段

    expect(res.status).toBe(422);
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);

    for (const error of res.body.errors) {
      expect(error).toHaveProperty("field");
      expect(error).toHaveProperty("message");
    }
  });

  it("500 错误在生产模式隐藏详情", async () => {
    testApp = await createTestApp({
      config: {
        response: { hideInternalErrors: true },
      },
      mockServices: {
        user: {
          findAll: vi.fn().mockRejectedValue(new Error("数据库连接失败")),
        },
      },
    });

    const res = await testApp.request.get("/users/list");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal Server Error");
    // 不应暴露内部错误信息
    expect(res.body.message).not.toContain("数据库连接失败");
  });
});
```

---

### 测试出口包装

```typescript
describe("出口包装", () => {
  it("wrap: true 时响应包含 code/data/requestId", async () => {
    const testApp = await createTestApp({
      config: { response: { wrap: true } },
    });

    const res = await testApp.request.get("/health");

    expect(res.body).toHaveProperty("code", 0);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("requestId");

    await testApp.close();
  });

  it("wrap: false 时响应为原始数据", async () => {
    const testApp = await createTestApp({
      config: { response: { wrap: false } },
    });

    const res = await testApp.request.get("/health");

    // 原始数据，无 code/data 包装
    expect(res.body).not.toHaveProperty("code");
    expect(res.body).toHaveProperty("status", "ok");

    await testApp.close();
  });
});
```

---

## 最佳实践

### 1. 始终调用 close()

```typescript
afterEach(async () => {
  await testApp?.close();
});
```

防止资源泄漏导致测试进程挂起。使用 `?.` 可选链防止 `testApp` 未初始化时报错。

### 2. 每个测试独立创建 TestApp

```typescript
// ✅ 推荐：每个测试独立 app
it("test 1", async () => {
  testApp = await createTestApp();
  // ...
});

it("test 2", async () => {
  testApp = await createTestApp();
  // ...
});

// ❌ 避免：共享 app（测试间可能互相影响）
// beforeAll(async () => {
//   testApp = await createTestApp();
// });
```

### 3. Mock 外部依赖

```typescript
testApp = await createTestApp({
  services: false,
  mockServices: {
    user: mockUserService,
    email: mockEmailService,
  },
});
```

单元测试中 mock 掉数据库、外部 API 等依赖，只测试被测代码本身。

### 4. 使用 vi.fn() 验证调用

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

### 5. 测试描述用中文

```typescript
describe('用户管理接口', () => {
  it('创建用户成功应返回 201', async () => { ... });
  it('邮箱重复应返回 409', async () => { ... });
  it('未认证应返回 401', async () => { ... });
});
```

---

## 类型导入

```typescript
// 运行时值
import { createTestApp } from "vextjs/testing";

// 类型（从主入口导入）
import type {
  CreateTestAppOptions,
  TestApp,
  TestRequest,
  TestRequestBuilder,
  TestResponse,
} from "vextjs";
```

:::tip
测试工具通过 `vextjs/testing` 子路径导入（运行时值），类型可从 `vextjs` 主入口导入。这样设计是为了避免测试依赖（如 mock 相关代码）污染生产代码的打包体积。
:::
