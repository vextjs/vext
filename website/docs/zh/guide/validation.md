# 参数校验

VextJS 集成 [schema-dsl](https://github.com/devcodex-labs/schema-dsl)，提供**声明式参数校验**。在路由 `options.validate` 中用简洁的 DSL 字符串描述校验规则，框架自动完成校验、类型转换，并同步生成 OpenAPI 文档。

## 基本用法

在路由的三段式定义中，通过 `validate` 字段声明校验规则：

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.post(
    "/users",
    {
      validate: {
        body: {
          name: "string:1-50!", // 必填字符串，长度 1-50
          email: "email!", // 必填，邮箱格式
          age: "number?", // 可选数字
          role: "admin|user", // 枚举值
        },
      },
      docs: { summary: "创建用户" },
    },
    async (req, res) => {
      // req.body 已通过校验 + 类型转换
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );
});
```

校验通过后，通过 `req.valid(location)` 获取类型转换后的数据。`param`（路径参数）非法时自动返回 HTTP `400`；`query`、`header`、`cookie` 或 `body` 非法时自动返回 HTTP `422`，无需 handler 手动处理。

## 校验位置

`validate` 支持五个位置，对应请求的不同数据来源：

| 位置     | 数据来源      | 说明                         |
| -------- | ------------- | ---------------------------- |
| `param`  | `req.params`  | 路径动态参数（如 `/:id`）    |
| `query`  | `req.query`   | URL 查询参数（如 `?page=1`） |
| `header` | `req.headers` | 请求头                       |
| `cookie` | `req.cookies` | 已解析的 Cookie 值           |
| `body`   | `req.body`    | 请求体（JSON / URL-encoded） |

校验按 `param` → `query` → `header` → `cookie` → `body` 的顺序执行，任一位置校验失败会立即返回错误。

```typescript
app.put(
  "/users/:id",
  {
    validate: {
      param: {
        id: "string!",
      },
      query: {
        fields: "string?", // 可选，指定返回字段
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

::::tip 注意
`validate` 中使用单数 `param`（与路径参数概念对应），但底层数据源是 `req.params`（复数）。框架内部已做正确映射，你无需关心。

如果动态路径使用了 `:id` 或 `*path`，但没有声明 `validate.param`，OpenAPI 仍会为该路径段生成 `required: true` 的 string path parameter，保证路径模板合法。需要更精确的类型、长度或格式约束时，请显式声明 `validate.param`。
::::

## DSL 语法详解

schema-dsl 使用简洁的字符串表达式描述数据类型和约束。

### 基本类型

| DSL 表达式  | 含义       | 示例值                  |
| ----------- | ---------- | ----------------------- |
| `'string'`  | 字符串     | `"hello"`               |
| `'number'`  | 数字       | `42`、`3.14`            |
| `'boolean'` | 布尔值     | `true`、`false`         |
| `'email'`   | 邮箱格式   | `"user@example.com"`    |
| `'url'`     | URL 格式   | `"https://example.com"` |
| `'date'`    | 日期字符串 | `"2026-01-15"`          |

### 必填与可选

在类型表达式末尾添加 `!` 或 `?` 标记：

| 后缀   | 含义             | 示例                            |
| ------ | ---------------- | ------------------------------- |
| `!`    | 必填（required） | `'string!'` — 必填字符串        |
| `?`    | 可选（optional） | `'string?'` — 可选字符串        |
| 无后缀 | 可选（默认）     | `'string'` — 等同于 `'string?'` |

```typescript
validate: {
  body: {
    name: 'string!',     // 必填
    nickname: 'string?', // 可选
    bio: 'string',       // 可选（等同于 'string?'）
  },
}
```

### 范围约束

使用 `:min-max` 语法指定范围：

#### 字符串长度

```typescript
"string:1-50"; // 长度 1 到 50
"string:1-50!"; // 必填，长度 1 到 50
"string:5-"; // 最小长度 5，无上限
"string:-100"; // 最大长度 100
```

#### 数字范围

```typescript
"number:1-100"; // 值范围 1 到 100
"number:0-"; // 最小值 0（非负数）
"number:1-"; // 最小值 1（正整数/正数）
"number:-999"; // 最大值 999
"number:18-120!"; // 必填，范围 18 到 120
```

### 枚举值

使用 `|` 分隔枚举选项：

```typescript
"admin|user|guest"; // 枚举：admin / user / guest
"draft|published|archived"; // 枚举：draft / published / archived
"male|female|other"; // 枚举：male / female / other
```

枚举值始终为字符串类型。在 OpenAPI 文档中映射为 `enum`。

### 组合示例

```typescript
validate: {
  body: {
    // 基本类型 + 必填/可选
    username: 'string:3-30!',      // 必填字符串，长度 3-30
    password: 'string:8-128!',     // 必填字符串，长度 8-128
    email: 'email!',               // 必填邮箱
    website: 'url?',               // 可选 URL
    age: 'number:0-150?',          // 可选数字，范围 0-150
    score: 'number:0-100',         // 可选数字，范围 0-100
    active: 'boolean!',            // 必填布尔值
    role: 'admin|editor|viewer',   // 枚举
    birthday: 'date?',             // 可选日期
  },
}
```

## 类型转换

schema-dsl 在校验时自动执行类型转换，尤其对 `query` 和 `param` 数据非常有用（它们原始值始终是字符串）：

| 声明类型    | 原始值    | 转换后  |
| ----------- | --------- | ------- |
| `'number'`  | `"42"`    | `42`    |
| `'number'`  | `"3.14"`  | `3.14`  |
| `'boolean'` | `"true"`  | `true`  |
| `'boolean'` | `"false"` | `false` |
| `'boolean'` | `"1"`     | `true`  |
| `'boolean'` | `"0"`     | `false` |

```typescript
app.get(
  "/search",
  {
    validate: {
      query: {
        page: "number:1-", // ?page=3 → number 3（非字符串 "3"）
        limit: "number:1-100", // ?limit=20 → number 20
        active: "boolean", // ?active=true → boolean true
      },
    },
  },
  async (req, res) => {
    const { page, limit, active } = req.valid("query");
    // page: number, limit: number, active: boolean — 已自动转换
    res.json({ page, limit, active });
  },
);
```

## 获取校验后数据

### `req.valid(location)`

使用 `req.valid()` 获取经过校验和类型转换后的数据。必须在 `validate` 中配置了对应位置后才能调用。

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

### 边界行为

::::warning 注意事项

`req.valid(location)` 有以下边界行为需要了解：

1. **未配置 `validate` 时调用**

   如果路由未配置 `validate` 字段，调用 `req.valid("body")` 将返回 `undefined`。框架不会抛出错误，但你将无法获取经过校验和类型转换的数据。

2. **location 未在 `validate` 中声明**

   如果 `validate` 中只声明了 `body`，但调用了 `req.valid("query")`，同样返回 `undefined`。只有在 `validate` 中明确声明过的位置才会有校验后的数据。

3. **校验失败时不会到达 handler**

   handler 执行前，非法路径 `param` 返回 HTTP `400`，非法 `query`、`header`、`cookie` 或 `body` 返回 HTTP `422`；因此 handler 内通过 `req.valid()` 读取的数据已经通过校验。

```typescript
// 边界情况示例
app.get(
  "/items",
  {
    validate: {
      query: { page: "number:1-" },
      // 未声明 body
    },
  },
  async (req, res) => {
    const query = req.valid("query"); // { page: number }，已校验
    const body = req.valid("body"); // undefined，未在 validate 中声明
    const param = req.valid("param"); // undefined，未在 validate 中声明
    res.json({ query });
  },
);

// 未配置 validate 的路由
app.get("/health", async (req, res) => {
  const body = req.valid("body"); // undefined，路由未配置 validate
  res.json({ status: "ok" });
});
```

**最佳实践**：始终确保 `req.valid(location)` 的 `location` 与 `validate` 中声明的位置一致。
::::

### 路由 Schema 自动类型推导

handler 会从同一个 `validate` 对象获得上下文类型，无需再把契约重复写成 TypeScript 接口：

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

自动推导覆盖 DSL 字符串、必填/可选标记、嵌套对象和单元素数组 Schema。
`schemaAdapter.compileField()` 返回的链式 builder 会诚实地推导为 `unknown`，因为其后续动态修改无法从静态类型恢复。
对于动态或外部提供的 Schema，仍可用 `req.valid<ExternalBody>("body")` 作为显式覆盖；它会覆盖自动推导，因此应用必须自行保证该类型与运行时契约一致。

## 校验错误响应

所有校验失败使用同一结构化错误形状：路径 `param` 非法时 HTTP/code 为 `400`，`query`、`header`、`cookie` 或 `body` 非法时 HTTP/code 为 `422`。下面是一个 `422` 示例：

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

- `code`：HTTP 状态码 422（Unprocessable Entity）
- `message`：固定为 `"Validation failed"`
- `errors`：字段级错误数组，包含 `field`（字段名）和 `message`（错误描述）
- `requestId`：当前请求的唯一标识

校验错误由框架全局错误处理器统一处理，你不需要在路由中手动 try-catch。

## 与 OpenAPI 文档的联动

`validate` 中的 DSL 规则会自动映射到 OpenAPI 文档的 `parameters` 和 `requestBody` 定义。无需额外配置，校验规则即是文档规则：

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
    docs: { summary: "获取用户列表" },
  },
  handler,
);
```

上面的路由会在 OpenAPI 文档中自动生成：

- `page` — query parameter, type: integer, minimum: 1
- `limit` — query parameter, type: integer, minimum: 1, maximum: 100
- `status` — query parameter, type: string, enum: ["active", "inactive", "banned"]

访问 `/docs` 即可在 Vext Docs 中查看自动生成的参数文档。

如果希望 OpenAPI 文档展示字段的业务含义，请使用显式、无全局副作用的 builder。Vext 不再安装全局 String `.description()` 方法：

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
        targetLanguages: [
          {
            code: schemaAdapter
              .compileField("string:1-64!")
              .description("目标语言代码"),
          },
        ],
        format: schemaAdapter
          .compileField("enum:plain_text,preserve_line_breaks")
          .description("输出格式"),
      },
    },
    docs: { summary: "执行文本翻译" },
  },
  handler,
);
```

生成的 OpenAPI schema 会保留这些 description，同时继续保留 `required`、`enum`、`minLength`、`maxLength` 等约束。没有手写 description 的字段仍会使用框架生成的兜底描述。

`?` 只表示字段可缺省，不会生成 `nullable: true`。需要显式允许 `null` 时，
使用 `types:string|null` 或 raw `{ type: ["string", "null"] }`。

## 高级用法

### 多位置组合校验

同一路由可以同时校验多个位置：

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

### 与路由级中间件配合

校验中间件在路由级中间件之后、handler 之前执行。这意味着：

```
请求 → [全局中间件] → [路由级中间件: auth, check-role] → [validate 校验] → [handler]
```

认证检查先于参数校验执行，未认证的请求不会触发校验逻辑：

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

### 路由覆盖限流规则

除了参数校验，`options` 还支持路由级配置覆盖（`override`），可以为特定路由调整限流、超时等设置：

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
      rateLimit: { max: 5, window: 60 }, // 每分钟最多 5 次（window 单位：秒）
    },
  },
  handler,
);

app.get(
  "/public/health",
  {
    override: {
      rateLimit: false, // 健康检查不限流
    },
  },
  handler,
);
```

## 在服务层复用校验引擎

路由入口参数优先使用 `RouteOptions.validate` + `req.valid()`。如果 service 还需要校验非 HTTP 输入，例如定时任务、消息队列、外部回调或内部 DTO，可以通过 `this.app.getValidator()` 获取当前全局校验引擎。

`getValidator()` 返回的是当前 validator：默认由 schema-dsl 实现；如果插件通过 `app.setValidator()` 替换为 Zod、Yup 等实现，service 中拿到的也是替换后的 validator。

这里推荐直接抛出 `VextValidationError`，这样框架会返回结构化的 `422` 响应和 `errors` 数组。不要把这类校验失败写成普通 `throw new Error("...")`，否则它会被当作未知异常并进入 500 路径。

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
    // 继续执行业务逻辑...
    return data;
  }
}
```

::::tip

不要在业务 service 中直接 `import "schema-dsl"`。直接依赖 schema-dsl 会绕过 `app.setValidator()` 的全局替换能力，也会让路由校验和 service 校验使用不同引擎。

::::

## 替换校验引擎

VextJS 默认使用 schema-dsl 作为校验引擎。如果你更喜欢 Zod、Yup 等第三方校验库，可以通过插件替换内置校验引擎。

### 使用 Zod 示例

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

        // 当整个 location schema 是 Zod schema 时使用 Zod 校验
        if (schema instanceof z.ZodType) {
          return (data) => toVextResult(schema.safeParse(data));
        }

        // 当前 RouteOptions.validate 类型也支持字段级 Zod schema
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

        // 否则退回默认 schema-dsl 行为
        return originalValidator.compile(schema);
      },
    };

    app.setValidator(zodValidator);
    app.logger.info("Zod validator plugin activated");
  },
});
```

替换后，路由中的 `validate` 可以传入字段级 Zod schema 对象而非 DSL 字符串。

## 常见模式

### 分页查询

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

### 搜索过滤

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

### 用户注册

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
      rateLimit: { max: 3, window: 60 }, // 单位：秒
    },
  },
  async (req, res) => {
    const data = req.valid("body");

    if (data.password !== data.confirmPassword) {
      app.throw(400, "两次密码不一致");
    }

    const user = await app.services.auth.register(data);
    res.json(user, 201);
  },
);
```

### 文件路径参数

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

## 最佳实践

### 1. 始终使用 `req.valid()` 而非 `req.body`

配置了 `validate` 的路由，应使用 `req.valid('body')` 而非直接访问 `req.body`：

```typescript
// ✅ 正确 — 使用校验后的数据
const data = req.valid("body");

// ❌ 避免 — 跳过了类型转换
const data = req.body;
```

`req.valid()` 返回的数据经过了类型转换（如 query 中的 `"42"` → `42`），直接访问 `req.body` / `req.query` 则是原始数据。

### 2. 合理使用必填标记

对于 `query` 和 `header` 位置，通常使用可选（`?`）；对于 `body` 中的核心字段，使用必填（`!`）：

```typescript
validate: {
  query: {
    page: 'number:1-',       // 可选（分页有默认值）
    keyword: 'string?',      // 可选（搜索关键字）
  },
  body: {
    name: 'string:1-50!',    // 必填（创建资源必须提供）
    email: 'email!',          // 必填
    bio: 'string:0-500?',    // 可选
  },
}
```

### 3. 校验规则即文档

由于校验规则自动映射到 OpenAPI 文档，写好 `validate` 就相当于写好了接口文档。尽量精确地描述约束条件：

```typescript
// ✅ 精确约束 — 文档和校验都很清晰
validate: {
  body: {
    username: 'string:3-30!',     // 3-30 字符，必填
    age: 'number:0-150?',         // 0-150，可选
    role: 'admin|editor|viewer!', // 明确枚举
  },
}

// ❌ 宽泛约束 — 文档信息不足
validate: {
  body: {
    username: 'string!',          // 没有长度约束
    age: 'number?',               // 没有范围约束
    role: 'string!',              // 应该用枚举
  },
}
```

### 4. 为 Handler 中的自定义校验使用 `app.throw()`

DSL 语法无法覆盖所有校验场景（如跨字段校验、数据库唯一性检查）。对于这些场景，在 handler 或 service 中使用 `app.throw()` 手动抛出：

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

    // 数据库唯一性检查 — DSL 无法覆盖
    const existing = await app.services.user.findByEmail(data.email);
    if (existing) {
      app.throw(409, "邮箱已注册", 10001);
    }

    const user = await app.services.user.create(data);
    res.json(user, 201);
  },
);
```

## 下一步

- 了解 [配置](/guide/configuration) 中校验相关的全局配置
- 查看 [OpenAPI 文档](/guide/openapi) 如何与校验规则联动
- 学习 [路由](/guide/routing) 中三段式的完整用法
- 探索 [插件](/guide/plugins) 如何替换校验引擎
