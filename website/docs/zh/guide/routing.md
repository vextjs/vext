# 路由

VextJS 采用 **约定式文件路由** + **三段式路由定义**，将文件路径自动映射为 URL 前缀，在文件内部通过 `defineRoutes()` 声明具体路由。

## 基本概念

### 文件路由映射

`src/routes/` 目录下的每个文件自动映射为一个 URL 前缀：

| 文件路径                   | URL 前缀          |
| -------------------------- | ----------------- |
| `routes/index.ts`          | `/`               |
| `routes/users.ts`          | `/users`          |
| `routes/users/index.ts`    | `/users`          |
| `routes/users/[id].ts`     | `/users/:id`      |
| `routes/admin/settings.ts` | `/admin/settings` |
| `routes/api/v1/index.ts`   | `/api/v1`         |

### 三段式定义

VextJS 路由使用 **三段式** `(path, options, handler)` 或 **两段式** `(path, handler)` 定义：

```typescript
// 三段式：path + options + handler
app.get(
  "/list",
  {
    validate: { query: { page: "number:1-", limit: "number:1-100" } },
    middlewares: ["audit-log"],
    docs: { summary: "用户列表" },
  },
  async (req, res) => {
    const { page, limit } = req.valid("query");
    res.json(await app.services.user.findAll({ page, limit }));
  },
);

// 两段式：path + handler（无 options）
app.get("/health", async (_req, res) => {
  res.json({ status: "ok" });
});
```

三段式中第二个参数 `options` 是一个声明式配置对象，包含：

| 字段          | 说明                                          |
| ------------- | --------------------------------------------- |
| `validate`    | 参数校验规则（query / body / param / header） |
| `middlewares` | 路由级中间件引用                              |
| `auth`        | 路由保护契约，通常由本地 helper 统一封装      |
| `session`     | 路由级 Session 启用、关闭或行为覆盖           |
| `csrf`        | 路由级 CSRF 跳过                              |
| `docs`        | OpenAPI 文档配置                              |
| `override`    | 路由级运行时覆盖（限流、超时、CORS）          |

## 路由文件写法

每个路由文件使用 `defineRoutes()` 导出路由定义：

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /users
  app.get(
    "/",
    {
      docs: { summary: "获取用户列表" },
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
      docs: { summary: "获取用户详情" },
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
    {
      validate: {
        body: {
          name: "string:1-50!",
          email: "email!",
          age: "number?",
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "创建用户" },
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
        param: { id: "string!" },
        body: { name: "string:1-50?", email: "email?" },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "更新用户" },
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
      validate: { param: { id: "string!" } },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "删除用户" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## HTTP 方法

`defineRoutes()` 回调中的 `app` 对象支持以下 HTTP 方法：

| 方法            | 用法       | 常见场景                        |
| --------------- | ---------- | ------------------------------- |
| `app.get()`     | 查询资源   | 列表查询、详情获取              |
| `app.post()`    | 创建资源   | 表单提交、资源创建              |
| `app.put()`     | 全量更新   | 资源替换                        |
| `app.patch()`   | 部分更新   | 字段级更新                      |
| `app.delete()`  | 删除资源   | 资源删除                        |
| `app.head()`    | 获取头信息 | 资源存在性检查                  |
| `app.options()` | 预检请求   | CORS 预检（通常由框架自动处理） |

## 动态路由参数

### 文件级动态参数

使用 `[paramName]` 作为文件名或目录名，自动转换为路由动态参数：

```
src/routes/users/[id].ts         → /users/:id
src/routes/posts/[slug].ts       → /posts/:slug
src/routes/[category]/[id].ts    → /:category/:id
```

```typescript
// src/routes/users/[id].ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /users/:id — 文件级参数 :id 已包含在前缀中
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

  // GET /users/:id/orders — 文件级参数 + 子路径
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

### 路由内动态参数

在文件内部的路由路径中也可以使用 `:paramName` 语法：

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

## 请求对象 (req)

路由 handler 的第一个参数 `req` 是框架统一的 `VextRequest` 对象，与底层 Adapter 解耦：

### 常用属性

```typescript
app.post("/example", async (req, res) => {
  req.method; // 'POST'
  req.url; // '/example?foo=bar'
  req.path; // '/example'
  req.query; // { foo: 'bar' }
  req.body; // 请求体（由 body-parser 中间件解析）
  req.params; // 路径参数 { id: '123' }
  req.headers; // 请求头（小写 key）
  req.cookies; // 已解析 cookies（只读，重复 key first-wins）
  req.cookie("theme"); // 读取单个 cookie 值
  req.session; // 全局或路由级 Session 启用后可用
  req.requestId; // 请求唯一标识（自动生成或从 X-Request-Id 透传）
  req.ip; // 客户端 IP
  req.protocol; // 'http' | 'https'
  req.app; // VextApp 实例（可访问 services、logger、throw 等）
});
```

### `req.valid()` — 获取校验后数据

当路由配置了 `validate` 选项时，使用 `req.valid()` 获取经过校验和类型转换后的数据：

```typescript
app.get(
  "/search",
  {
    validate: {
      query: {
        keyword: "string!",
        page: "number:1-", // 自动将 query string 转为 number
        limit: "number:1-100",
      },
    },
  },
  async (req, res) => {
    const { keyword, page, limit } = req.valid("query");
    // keyword: string, page: number, limit: number — 已类型转换
    const results = await app.services.search.query(keyword, page, limit);
    res.json(results);
  },
);
```

`req.valid()` 支持五个位置：

| 参数       | 数据来源      | 说明             |
| ---------- | ------------- | ---------------- |
| `'query'`  | `req.query`   | URL 查询参数     |
| `'body'`   | `req.body`    | 请求体           |
| `'param'`  | `req.params`  | 路径动态参数     |
| `'header'` | `req.headers` | 请求头           |
| `'cookie'` | `req.cookies` | 已解析 Cookie 值 |

:::tip 自动类型推导
路由声明 `validate` 后，handler 会直接从同一个 Schema 获得推导类型：

```typescript
const { id } = req.valid("param");
// id 的类型为 string
```

:::

### `req.onClose()` — 连接关闭钩子

注册请求关闭时的回调（客户端断开连接时触发），常用于 SSE / 长连接场景：

```typescript
req.onClose(() => {
  // 清理资源
});
```

## 响应对象 (res)

路由 handler 的第二个参数 `res` 是框架统一的 `VextResponse` 对象：

### `res.json()` — JSON 响应

```typescript
// 默认 200
res.json({ name: "Alice" });
// → { "code": 0, "data": { "name": "Alice" }, "requestId": "xxx" }

// 指定状态码
res.json(user, 201);

// 204 No Content（自动不发送消息体）
res.status(204).json(null);
```

:::info 响应包装
当 `response-wrapper` 中间件启用时（默认启用），`res.json()` 会自动将响应包装为统一格式：

```json
{
  "code": 0,
  "data": { "...": "你的业务数据" },
  "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

错误响应由全局错误处理器统一返回：

```json
{
  "code": 404,
  "message": "用户不存在",
  "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

:::

### `res.text()` — 纯文本响应

```typescript
res.text("Hello World");
res.text("Not Found", 404);
```

### `res.stream()` — 流式响应

```typescript
import { createReadStream } from "node:fs";

app.get("/download/report", async (_req, res) => {
  const stream = createReadStream("/path/to/report.csv");
  res.stream(stream, "text/csv");
});
```

### `res.download()` — 文件下载

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

`download()` 会自动设置安全的 `Content-Disposition`：ASCII 文件名直接写入 `filename`，非 ASCII 或危险字符文件名会生成 fallback 并写入 UTF-8 `filename*`。

### `res.redirect()` — 重定向

```typescript
res.redirect("/new-location"); // 302 临时重定向
res.redirect("/new-location", 301); // 301 永久重定向
```

### 链式调用

`res.status()` 和 `res.setHeader()` 支持链式调用：

```typescript
res.status(201).setHeader("X-Custom-Header", "value").json(data);
```

### `res.statusCode` — 读取状态码

在洋葱模型的 after-middleware 阶段，可以读取最终响应状态码：

```typescript
const timing: VextMiddleware = async (req, res, next) => {
  const start = Date.now();
  await next();
  console.log(
    `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
  );
};
```

## 参数校验

VextJS 集成 [schema-dsl](https://github.com/devcodex-labs/schema-dsl)，在路由 `options.validate` 中声明校验规则，框架自动执行校验并生成 OpenAPI 文档。

### DSL 语法速查

| DSL 表达式             | 含义                     |
| ---------------------- | ------------------------ |
| `'string!'`            | 必填字符串               |
| `'string?'`            | 可选字符串               |
| `'string:1-50'`        | 字符串，长度 1-50        |
| `'string:1-50!'`       | 必填字符串，长度 1-50    |
| `'number!'`            | 必填数字                 |
| `'number:1-'`          | 数字，最小值 1（无上限） |
| `'number:1-100'`       | 数字，范围 1-100         |
| `'email!'`             | 必填，邮箱格式           |
| `'url?'`               | 可选，URL 格式           |
| `'boolean!'`           | 必填布尔值               |
| `'admin\|user\|guest'` | 枚举值                   |
| `'date!'`              | 必填日期字符串           |

### 校验位置

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

校验顺序为 `param` → `query` → `header` → `body`。路径 `param` 非法时立即返回 HTTP `400`，其他位置失败时立即返回 HTTP `422`。

### 校验错误响应

校验失败时框架自动返回结构化的错误信息：

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

## 路由级中间件

通过 `options.middlewares` 为路由指定中间件。中间件必须先在 `config/default.ts` 的 `middlewares` 白名单中注册：

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
  // 字符串引用
  app.get(
    "/dashboard",
    {
      middlewares: ["audit-log"],
    },
    handler,
  );

  // 对象引用（覆盖默认参数）
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

中间件按声明顺序执行，在 handler 之前运行。

## OpenAPI 文档配置

通过 `options.docs` 配置路由的 OpenAPI 文档信息：

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
      summary: "创建用户",
      description: "创建一个新用户，邮箱必须唯一。",
      operationId: "createUser",
      deprecated: false,
      responses: {
        201: {
          description: "创建成功",
        },
        409: {
          description: "邮箱已存在",
        },
      },
    },
  },
  handler,
);
```

顶层 `responses` 是编译 JSON 序列化、OpenAPI 与生成客户端类型共用的运行时
契约。描述和示例保留在 `docs.responses`；同一状态 selector 不要在其中重复
声明 schema。

### 隐藏路由

不希望出现在 OpenAPI 文档中的路由，设置 `docs.hidden: true`：

```typescript
app.get(
  "/internal/metrics",
  {
    docs: { hidden: true },
  },
  handler,
);
```

## 访问 `app` 对象

`defineRoutes()` 的回调参数 `app` 提供了框架的完整能力：

```typescript
export default defineRoutes((app) => {
  app.get("/example", async (req, res) => {
    // 访问 service
    const data = await app.services.user.findAll();

    // 使用 logger
    app.logger.info({ userId: req.params.id }, "Fetching user");

    // 抛出 HTTP 错误
    if (!data) app.throw(404, "not_found");

    // 读取配置
    const port = app.config.port;

    res.json(data);
  });
});
```

:::tip req.app 与闭包 app
路由 handler 中可以通过两种方式访问 `app`：

- **闭包 `app`**：`defineRoutes((app) => ...)` 中的 `app` 参数
- **`req.app`**：请求对象上的真实运行期 `app` 引用

对于 `config`、`services`、`logger`、`throw` 这类稳定引用，两者通常表现一致，闭包 `app` 写法也更简洁。

但要注意：`defineRoutes()` 内部会先把根 `app` 的属性拷贝到 collector，再把这个 collector 传给路由工厂；如果某个字段会在运行期被 `app.extend()` **替换为新对象引用**（例如 Nacos 场景中的 `app.remoteConfig`），闭包 `app` 里捕获的旧引用不会自动刷新，此时应改为读取 `req.app`，或在 service 中通过 `this.app` 读取。

简言之：

- **静态/稳定字段** → 闭包 `app` 可继续使用
- **运行期动态替换字段** → 优先使用 `req.app`
  :::

## 错误处理

### `app.throw()` — 抛出 HTTP 错误

在路由或服务中使用 `app.throw()` 抛出错误，框架会统一处理并返回结构化响应：

```typescript
// 基本用法
app.throw(404, "用户不存在");
// → { "code": 404, "message": "用户不存在", "requestId": "..." }

// 使用 i18n key（配合 locales/ 语言包）
app.throw(404, "user.not_found");
// → 自动翻译为当前请求语言的消息

// 带业务错误码
app.throw(400, "邮箱已注册", 10001);
// → { "code": 10001, "message": "邮箱已注册", "requestId": "..." }

// 带插值参数
app.throw(400, "balance.insufficient", { balance: 50 });
// → { "code": 20001, "message": "余额不足，当前余额 50", "requestId": "..." }

// 带插值参数 + 业务错误码
app.throw(400, "balance.insufficient", { balance: 50 }, 20001);
```

`app.throw()` 会终止当前请求处理流程（函数签名返回 `never`），无需在其后添加 `return`。

如果这里抛出的是未预期异常，也可以直接：

```typescript
throw new Error("Database connection lost");
```

框架同样会捕获它，但这条路径表示“未知运行时错误”，最终会返回 `500 Internal Server Error`。开发环境下，当 `response.hideInternalErrors = false` 时，JSON 500 响应会附带 `stack`；若你的目标是主动返回一个明确的 `4xx/5xx` HTTP 结果，仍应优先使用 `app.throw(...)`。

## 路由加载优先级

当存在可能冲突的路由时，`router-loader` 按以下规则处理：

1. **静态路由优先于动态路由**：`/users/list` 优先于 `/users/:id`
2. **文件按字母序排序**：确保加载顺序确定性
3. **同一前缀不允许重复定义**：`routes/users.ts` 和 `routes/users/index.ts` 不能同时存在（框架会报错）

## 排除规则

以下文件不会被当作路由加载：

- 支持的路由文件扩展名为 `.ts`、`.js`、`.mjs`、`.cjs`
- 测试文件：`*.test.ts`、`*.spec.ts`
- 类型声明文件：`*.d.ts`
- 以 `_` 或 `.` 开头的文件或目录
- `node_modules` 目录
- 包含 `.__vext_compiled__` 的生成临时文件

这些文件会被跳过，不会作为启动错误处理。运行时路由加载、路由诊断和 manifest 生成共用同一套排除策略。

可以利用 `_` 前缀创建路由共享的工具模块：

```
src/routes/
├── _utils.ts          # 不会被当作路由加载
├── _types.ts          # 共享类型定义
├── users.ts
└── orders.ts
```

## 完整示例

```typescript
// src/routes/posts.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /posts — 分页列表
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
        summary: "获取文章列表",
      },
    },
    async (req, res) => {
      const { page = 1, limit = 20, status } = req.valid("query");
      const posts = await app.services.post.findAll({ page, limit, status });
      res.json(posts);
    },
  );

  // GET /posts/:id — 获取详情
  app.get(
    "/:id",
    {
      validate: { param: { id: "string!" } },
      docs: { summary: "获取文章详情" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const post = await app.services.post.findById(id);
      if (!post) app.throw(404, "post.not_found");
      res.json(post);
    },
  );

  // POST /posts — 创建文章（需要认证）
  app.post(
    "/",
    {
      validate: {
        body: {
          title: "string:1-200!",
          content: "string:1-50000!",
          tags: "string?",
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: {
        summary: "创建文章",
        responses: {
          201: { description: "创建成功" },
          401: { description: "未认证" },
        },
      },
    },
    async (req, res) => {
      const data = req.valid("body");
      const post = await app.services.post.create({
        ...data,
        authorId: req.auth.userId,
      });
      res.json(post, 201);
    },
  );

  // PATCH /posts/:id — 更新文章
  app.patch(
    "/:id",
    {
      validate: {
        param: { id: "string!" },
        body: {
          title: "string:1-200?",
          content: "string:1-50000?",
          status: "draft|published|archived",
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "更新文章" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const data = req.valid("body");
      const post = await app.services.post.update(id, data);
      res.json(post);
    },
  );

  // DELETE /posts/:id — 删除文章
  app.delete(
    "/:id",
    {
      validate: { param: { id: "string!" } },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
      docs: { summary: "删除文章" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.post.delete(id);
      res.status(204).json(null);
    },
  );
});
```

## 下一步

- 了解 [服务层](/guide/services) 如何组织业务逻辑
- 学习 [中间件](/guide/middleware) 的洋葱模型
- 探索 [参数校验](/guide/validation) 的高级用法
- 查看 [OpenAPI 文档](/guide/openapi) 自动生成
