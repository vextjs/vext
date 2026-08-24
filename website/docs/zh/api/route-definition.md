# 路由定义

本页详细介绍 VextJS 的路由定义 API，包括 `defineRoutes`、路由选项、参数校验、中间件引用和文档配置。

## defineRoutes

`defineRoutes` 是创建路由文件的核心函数。它接收一个工厂回调，在回调中通过 `app` 对象注册路由。

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/hello", async (req, res) => {
    res.json({ message: "Hello World" });
  });
});
```

### 函数签名

```typescript
function defineRoutes(factory: RouteFactory): RouteDefinition;

type RouteFactory = (app: VextApp) => void;
```

### 工作原理

1. `defineRoutes(factory)` 被调用时，内部创建一个 **collector**（路由收集器）
2. `factory(collector)` 被执行，用户代码中的 `app.get/post/...` 实际调用 collector 的方法
3. 每条路由被推入内部的 `routes` 数组
4. 返回 `RouteDefinition` 对象
5. `router-loader` 扫描 `src/routes/` 目录，对每个文件的 `default export` 调用 `register()` 注册到底层适配器

:::tip
在 factory 回调中，`app` 不仅有 HTTP 方法（`get/post/put/...`），还可以访问 `app.services`、`app.config`、`app.throw`、`app.logger` 等完整能力。这些属性由 `router-loader` 在执行 factory 前注入。
:::

---

## 路由注册语法

VextJS 支持**三段式**和**两段式**两种路由注册语法。

### 三段式（推荐）

```typescript
app.method(path, options, handler);
```

带有 `options` 配置的完整语法，支持参数校验、中间件引用、文档配置等：

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
        summary: "创建用户",
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

### 两段式

```typescript
app.method(path, handler);
```

无 `options` 的简化语法，适用于不需要校验、中间件或文档配置的简单路由：

```typescript
export default defineRoutes((app) => {
  app.get("/health", async (_req, res) => {
    res.json({ status: "ok" });
  });
});
```

### 支持的 HTTP 方法

| 方法                     | 说明         |
| ------------------------ | ------------ |
| `app.get(path, ...)`     | GET 请求     |
| `app.post(path, ...)`    | POST 请求    |
| `app.put(path, ...)`     | PUT 请求     |
| `app.patch(path, ...)`   | PATCH 请求   |
| `app.delete(path, ...)`  | DELETE 请求  |
| `app.head(path, ...)`    | HEAD 请求    |
| `app.options(path, ...)` | OPTIONS 请求 |

---

## 路由路径

### 静态路径

```typescript
app.get("/users", handler);
app.get("/users/profile", handler);
```

### 动态参数

使用 `:paramName` 定义动态路径参数，通过 `req.params` 或 `req.valid('param')` 访问：

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

如果动态路径只通过 `req.params` 读取而没有声明 `validate.param`，OpenAPI 会自动为 `:paramName` 或 `*paramName` 补一个 `required: true` 的 string path parameter，避免生成非法路径模板。需要约束格式时仍建议声明 `validate.param`。

### 通配符

```typescript
app.get("/files/*", async (req, res) => {
  // req.params['*'] 包含通配符匹配的部分
  res.json({ path: req.params["*"] });
});
```

### 文件路由映射

路由文件的目录路径自动映射为 URL 前缀：

| 文件路径                   | URL 前缀      | 示例                                   |
| -------------------------- | ------------- | -------------------------------------- |
| `src/routes/users.ts`      | `/users`      | `app.get('/list')` → `GET /users/list` |
| `src/routes/api/orders.ts` | `/api/orders` | `app.post('/')` → `POST /api/orders`   |
| `src/routes/index.ts`      | `/`           | `app.get('/health')` → `GET /health`   |

:::tip
路由文件中注册的 `path` 是**相对子路径**，框架自动拼接文件路径前缀。例如 `src/routes/users.ts` 中的 `app.get('/:id')` 最终注册为 `GET /users/:id`。
:::

---

## RouteOptions

路由三段式语法的第二个参数，声明式配置对象。

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
    /** @deprecated 请使用顶层 timeout。 */
    timeout?: number;
    maxBodySize?: string | number;
    cors?: VextCorsConfig;
  };
}
```

### 前端 freshness

`RouteOptions.frontend` 把页面 freshness 保留在既有路由声明中：

```ts
frontend: {
  mode: "dynamic" | "static" | "revalidate",
  revalidate?: number, // 秒；revalidate mode 必填
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

`staticParams` 只允许用于 `"static"`。`revalidate` 只允许用于
`"revalidate"`，且是正数秒级间隔。`clientOnly` 保留 route
document/data/assets，同时有意跳过服务端 page body；它不是 PPR，也不是第二套路由。

`hydration: "none"` 与 `clientOnly` 的方向相反：它要求并保留 SSR page body，但移除 Vext/React browser runtime、hydration data 与路由 JS preload。它不能与 `clientOnly` 或关闭 SSR 组合。`seo` 是静态、JSON-safe 的路由元数据，会在单次 render SEO 前合并。

构建索引涉及的路径与路由元数据使用有限静态语法，避免构建索引与运行时产生分歧。索引接受字面量、同文件 `const` 绑定、TypeScript 的 `as const` / 简单 `as Type` / `satisfies` 包装，以及第一参数可静态投影的 helper 调用。索引不会执行 helper 函数体，因此只在 helper 内新增的元数据不会被投影；注释、字符串、模板文本与正则表达式也不会参与结构匹配。

每个 `app.get(...)` / `app.post(...)` 注册都必须是 `defineRoutes` 回调内的直接顶层语句。条件式或嵌套注册会阻断静态投影，因为构建索引无法保证运行时控制流是否执行该注册。

索引不会执行导入值、计算表达式或带插值的模板字符串。路由 path、任一 `validate` 位置或 response schema 无法静态投影时，build/doctor/typegen 会携带文件、HTTP method 与 route 上下文失败，而不是静默漏掉路由或生成空合同。依赖请求数据的元数据应放在 `res.render(..., { seo })`。详见 [SEO、Sitemap 与 Robots](/zh/frontend/seo-sitemap)。

### 完整示例

```typescript
import type { RouteOptions } from "vextjs";

function requireAuth(options: RouteOptions): RouteOptions {
  return {
    ...options,
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  };
}

app.put(
  "/users/:id",
  requireAuth({
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
    docs: {
      summary: "更新用户",
      responses: {
        200: { description: "更新成功" },
        404: { description: "用户不存在" },
      },
    },
    override: {
      rateLimit: { max: 10, window: 60 },
      maxBodySize: "5mb",
    },
  }),
  handler,
);
```

---

## validate

声明式参数校验基于 `schema-dsl` DSL 语法，并在 handler 执行前完成。`param`（路径参数）非法时返回 HTTP `400`；`query`、`header`、`cookie` 或 `body` 非法时返回 HTTP `422`。

字段类型为 `VextSchemaField`，支持 schema-dsl 字符串、字段级 DslBuilder、嵌套对象和对象数组。字段级 DslBuilder 常用于给 OpenAPI 文档补充业务描述：

```typescript
import { schemaAdapter } from "vextjs";

app.post(
  "/translate",
  {
    validate: {
      body: {
        content: schemaAdapter
          .compileField("string:1-20000!")
          .description("待翻译文本，长度 1-20000 个字符"),
        format: schemaAdapter
          .compileField("enum:plain_text,preserve_line_breaks")
          .description("输出格式"),
      },
    },
  },
  handler,
);
```

这些 description 会进入 OpenAPI schema，同时保留必填、枚举和长度等约束。

### 校验位置

| 位置     | 数据源        | 说明                      |
| -------- | ------------- | ------------------------- |
| `param`  | `req.params`  | 路径动态参数（如 `/:id`） |
| `query`  | `req.query`   | URL 查询参数              |
| `header` | `req.headers` | 请求头                    |
| `cookie` | `req.cookies` | 已解析的 Cookie 值        |
| `body`   | `req.body`    | 请求体                    |

**校验执行顺序**：`param` → `query` → `header` → `cookie` → `body`

### 基本用法

```typescript
app.get(
  "/users",
  {
    validate: {
      query: {
        page: "number:1-", // 大于等于 1 的数字
        limit: "number:1-100", // 1 到 100 之间的数字
        keyword: "string?", // 可选字符串
      },
    },
  },
  async (req, res) => {
    const { page, limit, keyword } = req.valid("query");
    // page: number, limit: number, keyword: string | undefined
  },
);
```

### DSL 语法速查

| DSL              | 说明                | 示例                             |
| ---------------- | ------------------- | -------------------------------- |
| `'string'`       | 必填字符串          | `name: 'string'`                 |
| `'string:1-50'`  | 长度 1-50 的字符串  | `name: 'string:1-50'`            |
| `'string?'`      | 可选字符串          | `nickname: 'string?'`            |
| `'number'`       | 必填数字            | `age: 'number'`                  |
| `'number:0-'`    | 大于等于 0 的数字   | `page: 'number:0-'`              |
| `'number:1-100'` | 1 到 100 之间的数字 | `limit: 'number:1-100'`          |
| `'boolean'`      | 必填布尔值          | `active: 'boolean'`              |
| `'email'`        | 邮箱格式            | `email: 'email'`                 |
| `'url'`          | URL 格式            | `website: 'url'`                 |
| `'date'`         | 日期格式            | `birthday: 'date'`               |
| `'uuid'`         | UUID 格式           | `id: 'uuid'`                     |
| `'enum:a,b,c'`   | 枚举值              | `status: 'enum:active,inactive'` |
| `'array'`        | 数组                | `tags: 'array'`                  |
| `'object'`       | 对象                | `metadata: 'object'`             |

:::tip
`schema-dsl` 会自动做**类型转换**。例如查询参数 `?page=2` 中的 `'2'`（字符串）会被自动转换为 `2`（数字），前提是 schema 声明为 `'number'` 类型。
:::

### 获取校验后数据

使用 `req.valid(location)` 获取校验并类型转换后的数据：

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

handler 会直接从路由 Schema 推导类型，无需再声明一份重复接口：

```typescript
const body = req.valid("body");
// body.name  → IDE 知道是 string
// body.email → IDE 知道是 string
```

显式泛型仅保留为动态或外部 Schema 的逃生口；它会覆盖自动推导结果。

### 校验失败响应

`query`、`header`、`cookie` 或 `body` 校验失败时返回 HTTP `422`，结构如下。`validate.param` 失败使用相同错误结构，但 HTTP status 与 `code` 为 `400`，因为 URL 路径本身无效：

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

路由级中间件引用。引用的中间件必须先在 `config.middlewares` 白名单中声明。

### 字符串引用

```typescript
app.get(
  "/profile",
  {
    middlewares: ["audit-log"],
  },
  handler,
);
```

### 对象引用（带配置覆盖）

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

### VextMiddlewareRef 类型

```typescript
type VextMiddlewareRef = string | { name: string; options?: unknown };
```

### 执行顺序

路由级中间件在**全局中间件之后**、**handler 之前**执行：

```
请求 → [全局中间件链] → [路由级中间件] → [validate 中间件] → handler → 响应
```

### 配置白名单

路由中引用的中间件必须在配置文件中声明：

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
    req.app.throw(401, "未提供认证令牌");
  }
  // 验证 token...
  req.user = decoded;
  await next();
});
```

:::warning
引用未在白名单中声明的中间件会在启动时抛出错误：

```
[vextjs] Route GET "/profile" references middleware "auth" which is not
registered in config.middlewares whitelist.
```

:::

---

## auth

`RouteOptions.auth` 是路由保护契约，和身份解析分离：

- `auth()` 中间件读取请求凭据并填充 `req.auth`。
- `auth: true` 要求请求已经认证。
- 对象形式可以要求 roles、scopes、permissions 或自定义 `check`。
- `auth: { required: false }` 表示身份可选；没有 roles、scopes、permissions 或 `check` 时，OpenAPI 会把该路由标记为公开。
- `auth: false` 表示路由显式公开，并禁用从 `middlewares` 回退推断 OpenAPI security 的旧逻辑。

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
// src/auth/route-guards.ts
import type { RouteOptions } from "vextjs";

export function requirePostUpdate(options: RouteOptions): RouteOptions {
  return {
    ...options,
    middlewares: ["auth"],
    auth: {
      roles: ["admin"],
      scopes: ["posts:write"],
      permissions: [
        { action: "post:update", resource: (req) => req.params.id },
      ],
      mode: "all",
      security: "bearerAuth",
    },
  };
}
```

```typescript
app.post(
  "/posts/:id",
  requirePostUpdate({
    docs: { summary: "更新文章" },
  }),
  handler,
);
```

只有一次性路由或底层 API reference 示例才建议直接写原始 `auth` 对象。真实应用里应把 middleware 名称、安全方案、角色、scope 和权限资源集中在本地 helper 中。

### 运行时 auth、OpenAPI security 与 Docs access

三者相关但彼此独立：

- `auth.roles`、`auth.scopes`、`auth.permissions` 与 `auth.check` 是运行时路由保护，决定当前请求能否进入 handler。
- `auth.security` 是 OpenAPI metadata，用于选择文档中的安全方案；对象数组可声明 OAuth scope，例如 `[{ oauth2: ["posts:write"] }]`，但它不会授予或执行该 scope。
- `docs.security` 只覆盖生成出的 OpenAPI security metadata，不会取消运行时的 `auth` 要求。
- `docs.access` 是传给 `openapi.docs.access.resolver` 的 Vext Docs 可见性/Try it out metadata，不会保护 route；API 访问控制仍应使用 `auth`。

运行时 scope 与 OAuth scope 可以使用相同字符串，但仍是两份独立声明；两者都需要时请分别显式配置。

Guard 失败会使用稳定错误码：

| 错误码                | HTTP 状态 | 含义                                                  |
| --------------------- | --------- | ----------------------------------------------------- |
| `AUTH_REQUIRED`       | `401`     | 当前请求没有已认证身份                                |
| `AUTH_INVALID`        | `401`     | 请求携带了凭据，但凭据无效                            |
| `AUTH_FORBIDDEN`      | `403`     | 已认证身份未通过 role、scope、permission 或自定义检查 |
| `AUTH_CONFIG_ERROR`   | `500`     | auth 中间件或 permission provider 配置错误            |
| `AUTH_PROVIDER_ERROR` | `500`     | auth provider 或自定义检查异常抛错                    |

`requestContext.getStore()?.auth` 只保存安全身份快照，不包含原始凭据和 `claims`。需要读取 provider claims 时，请在路由内使用完整的 `req.auth`。

---

## cache

路由级响应缓存配置。响应缓存发生在服务端，会缓存接口响应内容；它不是自定义中间件，也不是浏览器 `Cache-Control` 响应头。

```typescript
import { route } from "vext";

route({
  method: "GET",
  path: "/posts",
  cache: {
    ttl: 30_000, // 毫秒
    methods: ["GET"],
    headers: ["accept-language"],
    partitionKey: (req) => req.user?.tenantId ?? "public",
  },
  handler: async () => {
    return await listPosts();
  },
});
```

常用写法：

| 配置                           | 说明                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `cache: false`                 | 禁用该路由响应缓存                                                                  |
| `cache: 30000`                 | 启用响应缓存，TTL 为 30000 毫秒                                                     |
| `cache: { ttl: 30000 }`        | 使用完整配置对象                                                                    |
| `headers: ["accept-language"]` | 指定参与缓存 key 的请求头；不建议把所有请求头都纳入 key                             |
| `partitionKey`                 | 生成用户、租户或区域隔离维度，避免不同访问者共享同一缓存响应                        |
| `allowCookieCache`             | 允许带 `Cookie` 请求头的请求参与缓存；只有 cookie 输入已纳入安全缓存 key 时才应开启 |

详见 [响应缓存指南](/guide/cache)。

---

## docs

OpenAPI 文档配置，控制路由在自动生成的 API 文档中的展示方式。

### RouteDocsConfig

```typescript
interface RouteDocsConfig {
  summary?: string;
  description?: string;
  /** @deprecated 已忽略；operation tags 会自动推断 */
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

### 字段说明

| 字段          | 类型               | 默认值                       | 说明                                                                                                                       |
| ------------- | ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `summary`     | `string`           | —                            | 接口一句话摘要                                                                                                             |
| `description` | `string`           | —                            | 接口详细描述（支持 Markdown）                                                                                              |
| `tags`        | `string[]`         | 已忽略                       | 已废弃。operation tags 会从路由 path/source 自动推断                                                                       |
| `operationId` | `string`           | 自动推断                     | 操作标识（全局唯一；冲突时生成报错）                                                                                       |
| `hidden`      | `boolean`          | `false`                      | 是否从文档中隐藏                                                                                                           |
| `access`      | `object \| string` | —                            | 文档访问 metadata，会传给 `openapi.docs.access.resolver`；`visible: false` 会直接隐藏，`tryItOut: false` 会禁用 Try it out |
| `deprecated`  | `boolean`          | `false`                      | 是否标记为已废弃                                                                                                           |
| `security`    | `array`            | 从 `auth` / middlewares 推断 | 安全方案覆盖                                                                                                               |
| `extensions`  | `object`           | —                            | 自定义 `x-*` 扩展字段                                                                                                      |
| `responses`   | `object`           | —                            | 响应定义                                                                                                                   |

`docs.access` 会写入 OpenAPI operation 的 `x-vext-docs-access` vendor extension，并在 Vext Docs 过滤阶段作为 `kind: "operation"` descriptor 的 `access` 字段传给 `openapi.docs.access.resolver`。字符串值通常用于角色、租户或分组标识；对象值可以携带 `roles`、`permissions`、`group`、`visible` 和 `tryItOut` metadata。这只是文档访问 metadata：隐藏 operation 或关闭 Try it out 不会为 route 增加认证或授权。

### 完整示例

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
      summary: "创建用户",
      description: "创建一个新用户账号，并记录操作审计日志。",
      operationId: "createUser",
      responses: {
        201: {
          description: "用户创建成功",
          example: {
            id: "usr_abc123",
            name: "Alice",
            email: "alice@example.com",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
        422: { description: "请求参数校验失败" },
        409: { description: "邮箱已注册" },
      },
    },
  },
  handler,
);
```

### operationId 自动推断

未指定 `operationId` 时，框架根据 HTTP 方法和路径自动生成：

| 方法 + 路径         | 推断的 operationId |
| ------------------- | ------------------ |
| `GET /users`        | `getUsers`         |
| `POST /users`       | `createUsers`      |
| `GET /users/:id`    | `getUsersById`     |
| `PUT /users/:id`    | `updateUsersById`  |
| `DELETE /users/:id` | `deleteUsersById`  |

显式 `docs.operationId` 和自动推断出的 `operationId` 共用同一个全局唯一约束。若重复，OpenAPI 生成会直接报错；请为冲突路由设置唯一的 `docs.operationId`，或调整路由 method/path 让自动推断结果不同。

### 隐藏路由

```typescript
app.get(
  "/internal/debug",
  {
    docs: { hidden: true },
  },
  handler,
);
```

### 标记废弃

```typescript
app.get(
  "/v1/users",
  {
    docs: {
      deprecated: true,
      description: "已废弃，请使用 /v2/users",
    },
  },
  handler,
);
```

### 安全方案覆盖

默认情况下，安全方案按以下顺序推断：

1. 显式设置的 `docs.security`，包括 `[]`。
2. `RouteOptions.auth` 为 `true` 或对象时；`auth: { required: false }` 且没有 roles/scopes/permissions/check 时会输出公开 security。
3. 旧的 `middlewares` 推断，通过 `config.openapi.guardSecurityMap` 映射。

`auth:false` 会禁用该路由的旧 `middlewares` 回退推断。`auth: { required: false }` 如果同时声明 roles、scopes、permissions 或 `check`，运行时仍会要求认证，OpenAPI 也会输出认证 security。

也可以手动覆盖：

```typescript
// 显式声明需要 bearerAuth
app.get(
  "/secure",
  {
    docs: {
      security: [{ bearerAuth: [] }],
    },
  },
  handler,
);

// 声明无需认证（即使有全局安全要求）
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

### 运行时响应 Schema

```typescript
interface RuntimeResponseConfig {
  schema: Record<string, unknown> | string;
}

type RuntimeResponses = Record<string | number, RuntimeResponseConfig>;
```

该映射声明在顶层 `RouteOptions.responses`。selector 支持精确状态（`201`）、
状态族（`2xx`）与 `default`；`response:before` 完成后按最终状态以“精确 →
状态族 → default”选择。Vext 在路由注册时编译每个 JSON schema，并在后续请求
中复用。同一份闭合 schema 会投影到 OpenAPI、路由 manifest、静态 build 索引
和生成客户端类型。

schema 描述传给 `res.json()` 的业务数据，不需要手写重复的响应包裹。未声明
字段会递归移除，缺失 required 值会在提交字节前失败。HEAD、精确 204、raw
JSON、text、redirect、file/download、stream 与 render/SSR 响应会绕过该序列化器。
生命周期和 raw JSON Schema 细节见
[OpenAPI 响应契约](/zh/guide/openapi#responses--运行时响应契约与文档元数据)。

### 响应文档元数据

```typescript
interface ResponseConfig {
  description?: string;
  /** 仅文档兼容入口；优先使用 RouteOptions.responses。 */
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

描述、示例、响应头与 content type 保留在 `docs.responses`。如果同一规范化
selector 已在顶层 `responses` 中声明，不得在这里重复 `schema`；双重声明会
让路由注册失败。

**多示例响应**：

```typescript
docs: {
  responses: {
    200: {
      description: '查询成功',
      examples: {
        admin: {
          summary: '管理员用户',
          value: { id: '1', name: 'Admin', role: 'admin' },
        },
        normal: {
          summary: '普通用户',
          value: { id: '2', name: 'User', role: 'user' },
        },
      },
    },
  },
}
```

**自定义响应头**：

```typescript
docs: {
  responses: {
    200: {
      description: '成功',
      headers: {
        'X-RateLimit-Remaining': {
          description: '剩余请求次数',
          schema: { type: 'integer' },
        },
      },
    },
  },
}
```

---

## multipart

路由级文件上传配置。`multipart.files` 会自动输出 OpenAPI `multipart/form-data` requestBody，无需手动编写 `docs.requestBody`。全局 `config.multipart.enabled` 关闭时，可通过 `multipart.enabled: true` 让单个路由启用内置解析；全局开启时，也可通过 `multipart.enabled: false` 让单个路由跳过内置解析。内置解析是纯内存路径：不会创建框架管理的临时文件，因此没有 tmp 目录、文件 TTL 或定时清理配置。大文件或持久化存储应由流式上传插件接管。

```typescript
app.post(
  "/upload/avatar",
  {
    multipart: {
      enabled: true,
      files: {
        avatar: { description: "头像图片（JPEG/PNG）", required: true },
        thumbnail: "可选缩略图",
      },
    },
    docs: { summary: "上传头像" },
  },
  async (req, res) => {
    const file = req.files?.find((f) => f.fieldname === "avatar");
    res.json({ filename: file?.filename, size: file?.size });
  },
);
```

| 子字段                | 类型                               | 说明                                                                      |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `enabled`             | `boolean`                          | 路由级解析开关。`true` 单路由启用；`false` 单路由跳过；省略则跟随全局配置 |
| `maxFileSize`         | `number`                           | 此路由单文件字节上限，覆盖全局 `multipart.maxFileSize`                    |
| `maxFiles`            | `number`                           | 此路由最多文件数，覆盖全局 `multipart.maxFiles`                           |
| `allowedMimeTypes`    | `string[]`                         | 此路由 MIME 白名单，覆盖全局 `multipart.allowedMimeTypes`                 |
| `files`               | `Record<string, string \| object>` | 文件字段映射；字符串值为说明，对象可配置更多                              |
| `files[].description` | `string`                           | 字段说明（用于 OpenAPI 文档）                                             |
| `files[].required`    | `boolean`                          | 运行时是否要求至少上传一个同名文件（默认 `false`）                        |

缺少 required 文件字段时，Vext 返回 `400`，响应中包含缺失字段名。optional 字段和未声明上传字段仍允许上传；它们继续受 `maxFiles`、`maxFileSize` 和 `allowedMimeTypes` 限制。

:::warning 注意
`multipart.files` 与 `validate.body` 互斥，同时配置时 `multipart.files` 优先生效于 OpenAPI 文档生成。
:::

---

## session

控制单个路由的 Session。`false` 跳过已全局启用的 Session；`true` 在全局关闭时单路由启用。对象形式还可覆盖 `rolling` 与 `autoCommit`；Store、cookie name 和 session id 长度仍保持应用级配置。

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

路由级配置覆盖，覆盖 `src/config/default.ts` 中的全局配置。

```typescript
app.post(
  "/upload",
  {
    timeout: 30000, // 超时 30 秒
    override: {
      maxBodySize: "50mb", // 覆盖全局 body 大小限制
      rateLimit: { max: 5, window: 60 }, // 收紧限流
    },
  },
  handler,
);

app.get(
  "/public/data",
  {
    override: {
      rateLimit: false, // 完全禁用限流
      cors: {
        origins: ["*"],
        credentials: false,
      },
    },
  },
  handler,
);
```

| 字段          | 类型               | 说明                                 |
| ------------- | ------------------ | ------------------------------------ |
| `rateLimit`   | `object \| false`  | 路由级限流配置，`false` 禁用         |
| `timeout`     | `number`           | 兼容保留字段；优先使用顶层 `timeout` |
| `maxBodySize` | `string \| number` | 最大请求体大小                       |
| `cors`        | `VextCorsConfig`   | 路由级 CORS 配置                     |

路由可以设置顶层 `{ timeout: number }`，用正整数毫秒值启用请求期限，超时返回 HTTP 504。顶层 `{ timeout: false }` 表示显式不启用路由超时中间件，并优先于兼容保留的 `override.timeout`。

当可嵌入页面、第三方回调或完全自定义响应头栈需要跳过全局 Security Headers 预设时，路由也可以设置顶层 `{ securityHeaders: false }`。

---

## RouteDefinition

`defineRoutes()` 返回的路由定义对象（内部数据结构，通常不需要直接操作）。
factory 与 collector 内部状态不属于公共对象形状，应只通过 `defineRoutes()` 与 router-loader 生命周期驱动。

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

| 字段         | 类型            | 说明                                  |
| ------------ | --------------- | ------------------------------------- |
| `routes`     | `RouteRecord[]` | 收集到的路由记录列表                  |
| `sourceFile` | `string`        | 来源文件路径（由 router-loader 注入） |
| `register()` | `Function`      | 将路由注册到底层适配器                |

### RouteRecord

单条路由的内部数据结构：

```typescript
interface RouteRecord {
  method: string; // HTTP 方法（大写）
  path: string; // 相对子路径
  options: RouteOptions; // 路由配置
  handler: VextHandler; // 路由处理函数
}
```

---

## VextHandler

路由处理函数的类型定义：

```typescript
type VextHandler = (
  req: VextRequest,
  res: VextResponse,
) => Promise<void> | void;
```

Handler 是中间件链的最后一环，不调用 `next()`。

### 基本示例

```typescript
const handler: VextHandler = async (req, res) => {
  const users = await app.services.user.findAll();
  res.json(users);
};
```

### 访问 App 能力

在 `defineRoutes` 的 factory 回调中，通过闭包访问 `app`：

```typescript
export default defineRoutes((app) => {
  app.get("/users/:id", async (req, res) => {
    const { id } = req.params;
    const user = await app.services.user.findById(id);

    if (!user) {
      app.throw(404, "用户不存在");
    }

    app.logger.info({ userId: id }, "查询用户成功");
    res.json(user);
  });
});
```

这里如果要主动返回 `404`、`401`、`409` 等明确的 HTTP 错误，应优先使用 `app.throw(...)`。普通 `throw new Error("...")` 也会被框架捕获，但它表示未知运行时异常，最终会进入 500 错误路径；字段级校验失败则应使用 `VextValidationError`。

---

## 多路由注册

一个路由文件中可以注册多条路由：

```typescript
// src/routes/users.ts
import { defineRoutes, type RouteOptions } from "vextjs";

function requireAuth(options: RouteOptions): RouteOptions {
  return {
    ...options,
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  };
}

export default defineRoutes((app) => {
  // GET /users/list
  app.get(
    "/list",
    {
      validate: {
        query: { page: "number:1-", limit: "number:1-100" },
      },
      docs: { summary: "用户列表" },
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
      docs: { summary: "获取用户详情" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      if (!user) app.throw(404, "用户不存在");
      res.json(user);
    },
  );

  // POST /users
  app.post(
    "/",
    requireAuth({
      validate: {
        body: { name: "string:1-50", email: "email" },
      },
      docs: { summary: "创建用户" },
    }),
    async (req, res) => {
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );

  // PUT /users/:id
  app.put(
    "/:id",
    requireAuth({
      validate: {
        param: { id: "string:1-" },
        body: { name: "string:1-50?", email: "email?" },
      },
      docs: { summary: "更新用户" },
    }),
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
    requireAuth({
      validate: {
        param: { id: "string:1-" },
      },
      docs: { summary: "删除用户" },
    }),
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

---

## 注意事项

### 不要直接在 app 上调用 HTTP 方法

`defineRoutes` 返回的 `app` 是一个收集器，不是真正的应用实例。直接在应用实例上调用 HTTP 方法会抛出错误：

```typescript
// ❌ 错误用法
import { createApp } from "vextjs";
const { app } = createApp(config);
app.get("/hello", handler); // 抛出错误！

// ✅ 正确用法
import { defineRoutes } from "vextjs";
export default defineRoutes((app) => {
  app.get("/hello", handler); // OK
});
```

### 路由文件必须 default export

```typescript
// ✅ 正确
export default defineRoutes((app) => { ... });

// ❌ 错误 — router-loader 无法识别
export const routes = defineRoutes((app) => { ... });
```

### 路由路径规范化

框架自动处理以下路径边界情况：

| 前缀         | 子路径    | 最终路径      |
| ------------ | --------- | ------------- |
| `/users`     | `/list`   | `/users/list` |
| `/users`     | `/`       | `/users`      |
| `/users`     | `/:id`    | `/users/:id`  |
| `/`          | `/`       | `/`           |
| `/`          | `/health` | `/health`     |
| `/api/users` | _（空）_  | `/api/users`  |
