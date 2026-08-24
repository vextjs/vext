# OpenAPI 文档

VextJS 内置 OpenAPI 文档自动生成功能。基于路由的 `validate` 和 `docs` 配置，框架自动生成 OpenAPI 3.0 规范 JSON，并通过 Vext Docs Renderer 提供默认 `/docs` 文档页。第三方文档工具请直接消费 `/openapi.json`。

内置 renderer 与官网共用同一套 Vext 标记几何、青绿/青色 light/dark theme token、绿色/琥珀色标记辅色和 favicon。即使自定义 docs 路径，这些资产仍由 Vext 内置并保持一致，应用无需另装 OpenAPI UI 包。

## 快速开始

### 1. 启用 OpenAPI

在配置中开启 `openapi.enabled`：

```typescript
// src/config/default.ts
export default {
  port: 3000,
  openapi: {
    enabled: true,
  },
};
```

### 2. 在路由中添加文档信息

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/",
    {
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-100",
        },
      },
      docs: {
        summary: "获取用户列表",
        description: "分页获取所有用户信息",
      },
    },
    async (req, res) => {
      const { page = 1, limit = 20 } = req.valid("query");
      const users = await app.services.user.findAll({ page, limit });
      res.json(users);
    },
  );

  app.post(
    "/",
    {
      validate: {
        body: {
          name: "string:1-50!",
          email: "email!",
          age: "number:0-150?",
        },
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

### 3. 访问文档

启动项目后，访问以下地址：

| 地址                                 | 说明                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `http://localhost:3000/docs`         | Vext Docs 文档界面（HTTP API、Pages、services/utils/models/components/plugins/middlewares 文档） |
| `http://localhost:3000/openapi.json` | OpenAPI JSON 规范文件                                                                            |

默认 Vext Docs UI 会把 HTTP API、Pages、Services、Utils、Models、已发现的 Components、Plugins、Middlewares 作为顶层入口，当前选中的顶层入口可以收缩/展开自己的左侧导航树。

HTTP API 与 Pages 会：

- 根据 OpenAPI path segment 生成递归导航；
- 保留 `/api/v1/info` 这类稳定资源路径段作为分类；
- 具体接口叶子优先显示 `docs.summary`，未配置 summary 时回退到接口地址；
- 把 `{id}` 这类动态 path 参数视为参数，而不是普通业务目录。

响应状态会以横向 tab 展示，内容区不再重复展示状态标题；本地 schema `$ref` 会展开为真实字段，object schema 不再显示人工 `(root)` 行。桌面端左侧侧栏会固定在视口内并独立滚动，可根据可见导航标签自动加宽，也支持手动拖拽并持久化宽度，内置 docs 资产会带版本标记，避免浏览器缓存遮住 renderer 更新。

顶部 header 会把搜索、UI 控件、分类筛选与 Authorize 分成清晰行；Overview 工作台会展示统计和 package 启动/build/验证命令。右侧 API/code/model/plugin/middleware 条目会使用独立 item shell 分隔，长页面连续阅读时更容易区分。

Pages 由 route handler 中直接调用 `res.render()` 或 `res.renderError()` 自动识别。Services / Utils / Components 从标准 JSDoc 生成，且不会 import 或执行用户代码。Models 会列出可识别的 model 文件，没有 JSDoc 时生成最小条目，有 JSDoc 时作为增强信息；根目录 model 会直接挂在 Models 下，不再出现人工 `root` 分类，嵌套 model 按源码目录分组。

默认 UI 会静态读取支持的 model definition 形态，展示 registry key、name、collection、connection、schema fields、enums、options、indexes、methods、hooks 和 usage，同样不会 import 或执行 model 代码。Plugins 与 Middlewares 会从 `src/plugins`、`src/middlewares` 扫描 JSDoc 与可静态推断的生命周期/bootstrap、app extension、middleware 类型、路由调用方式和源码链接。

Locales / Config / Styles / Preload 静态源码文档仍是可选高级来源，可以通过 `openapi.docs.code.*` 显式开启，但不属于默认顶层文档入口。本地 loopback 访问文档页时，code docs 条目可展示 `Open source` 链接并跳转到 `vscode://file/...`；非本地访问默认隐藏该链接。

路由级 `docs.tags` 已废弃并会被忽略，同时输出 warning；operation tags 会从路由 path/source 自动推断，并收进折叠 Metadata，不再作为主要 badge 铺开。

`x-tagGroups` 仅在显式配置 `openapi.tagGroups` 时作为原始 OpenAPI vendor extension 输出；内置文档导航不依赖它。存在 OpenAPI security schemes 时，UI 会展示接口鉴权状态，并提供全局 Authorize 控件供同源 Try it out 合并使用。

B26 进一步补齐主题与密度控制、Overview 工作台、搜索快捷键、类别过滤、命中高亮、桌面右侧大纲、endpoint/link/response/usage/source path 复制按钮和导航深链。动态 path 参数仍弱化展示，但当中间动态段后面还有稳定子资源时会保留层级，例如 `/docs-nav/{id}/sdfs/sdfaf` 会保留参数节点与后续资源层级。

B27 将 Try it out 升级为轻量请求控制台。每个接口可展示 server 选择、完整 URL 预览与 Copy URL，并用 Params、Headers、Body、Samples、History、Response 标签页收纳输入、样例、历史和响应。Query/Header 没有声明字段时保持紧凑空态，仍支持 raw fallback；Header 行会从 OpenAPI `parameters[in=header]` 自动生成，包括 `validate.header`。Headers 标签页同时展示 auth 状态和最终有效 headers 预览，让 Authorize 自动注入的请求头与手动覆盖关系放在同一个位置确认。Samples 标签页包含 cURL/browser fetch/Node fetch/Axios 代码样例，固定 Response 标签页保留 pretty/raw body 模式，并同时展示实际发送的 request headers 与 response headers，方便确认请求到底携带了什么。Axios 只是示例文本，Vext 不会把 Axios 加入运行时依赖。

B31 进一步优化小屏与大接口量场景。移动端使用带同步搜索和分类筛选的抽屉导航，窄屏下生成字段表格会切换为带字段标签的卡片行，Try it out 内部控件只在打开接口控制台时创建，HTTP API 长列表会增量渲染并提供 Load more，同时保留 deep link 目标的首屏可达性。

B32 增加多版本 / 多文档面的 source-aware 能力。当生成的 OpenAPI paths 中至少存在两个版本 source group，例如 `/api/v1/**`、`/api/v2/**`、`/api/beta/**`、`/v1/**`、`/v2/**`、`/beta/**` 时，Vext Docs 会自动展示有序的 `All / API v1 / API v2 / API Beta` 这类切换器。数字版本会排在 `alpha`、`beta`、`rc` 这类命名发布通道之前。

每个 source 会分别读取过滤后的 `/_vext/docs/openapi.json?source=<id>`、`code.json?source=<id>`、`search.json?source=<id>` 数据，因此当前 source 拥有独立的 Overview 统计、导航树、搜索状态、权限过滤后的接口集合和 deep link。

非 `All` source 默认只返回 OpenAPI 条目；只有该 source 显式配置 `code.include` / `code.exclude` 时，才会纳入 Code JSDoc 条目，避免全局 Services / Utils / Models 泄漏到单版本 API 文档面。既有单 source 的 `#anchor` 链接继续兼容；多 source 链接使用 `#source=<id>&view=<view>&id=<anchor>`。

如果自动版本识别不够，项目可以通过 `openapi.docs.sources` 显式定义文档面，`source.access`，包括 `source.access.visible`，也会作用于 source 切换器和 source-aware 数据端点。每个显式 source 仍需要 `match`，因为它定义 OpenAPI 数据作用域；纯 Code JSDoc source 可以使用 `/sdk/**` 这类稳定的非 API namespace，再通过 `code.include` / `code.exclude` 纳入对应代码文档。

B32 同时增强 Try it out 的真实项目接入能力。OpenAPI `servers[].variables` 会在 server 选择器旁渲染为控件，并参与 URL 预览、Copy URL、代码样例、历史记录和 Send 请求。

项目也可以通过 `openapi.docs.tryItOut.hookScript` 与 `hookGlobal` 配置浏览器端请求 hook；`hookGlobal` 只是浏览器查找名，只有配置了 hook script 或运行时全局对象暴露 `beforeRequest` / `afterResponse` 时才显示 hook 提示。

文档页会在 fetch 前后调用这些函数，合并 hook 返回的请求 header/body/URL 变更，并在 Response 标签页展示诊断信息。hook 只运行在浏览器文档页，Vext 不会为此 import 或执行后端项目代码。

### 多文档面配置

当 Public/Admin/Internal、版本或受众边界无法仅通过路径自动推断时，可以使用 `openapi.docs.sources`：

```typescript
export default {
  openapi: {
    docs: {
      sources: [
        {
          id: "public-v1",
          label: "Public v1",
          match: ["/api/v1/**"],
          default: true,
        },
        {
          id: "admin-v1",
          label: "Admin v1",
          match: ["/admin/v1/**"],
          access: "admin",
        },
        {
          id: "internal-v1",
          label: "Internal v1",
          match: ["/internal/v1/**"],
          access: { visible: false },
        },
        {
          id: "sdk",
          label: "SDK",
          match: ["/sdk/**"],
          code: {
            include: ["services/sdk", "models/*"],
            exclude: ["*internal*"],
          },
        },
      ],
    },
  },
};
```

`source.access` 会作为 `kind: "source"` descriptor 传给 `openapi.docs.access.resolver`。`source.access.visible: false` 会在 resolver 执行前隐藏该 source。`options.docs.access` 会写入 `x-vext-docs-access`，并作为 `kind: "operation"` descriptor 的 `access` 字段传给同一个 resolver；`visible: false` 会直接隐藏该 operation，`tryItOut: false` 会禁用该 operation 的 Try it out。`source.code.include` / `source.code.exclude` 用于让非 `All` source 纳入 Code JSDoc 条目；不配置时，非 `All` source 只暴露 OpenAPI 条目。Code 过滤会同时匹配条目的 id、title 与 source file，因此 `models/*`、`services/sdk/**` 这类路径风格模式可用于常见源码范围。

### Try it out 请求 Hook

`hookScript` 指向文档页会加载的浏览器脚本。脚本需要暴露 `window[hookGlobal]`，并可实现 `beforeRequest` / `afterResponse`：

```js
// public/docs-hook.js
window.VextDocsHooks = {
  beforeRequest({ request, path, source }) {
    return {
      headers: {
        ...request.headers,
        "x-docs-source": source && source.id ? source.id : "all",
        "x-docs-signature": "demo-" + path,
      },
    };
  },
  afterResponse({ response }) {
    return {
      diagnostics: ["status: " + response.status],
    };
  },
};
```

```typescript
export default {
  openapi: {
    docs: {
      tryItOut: {
        hookScript: "/docs-hook.js",
        hookGlobal: "VextDocsHooks",
      },
    },
  },
};
```

如果需要在生成后追加组织级扩展字段，可使用 OpenAPI hook。`OpenAPIGenerator.generate()` 仍保持同步，`openapi:afterGenerate` 也必须同步返回 patch：

```typescript
// src/plugins/openapi-extra.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "openapi-extra",
  setup(app) {
    app.hooks.on("openapi:afterGenerate", ({ document }) => ({
      document: {
        ...(document as Record<string, unknown>),
        "x-service-owner": "platform",
      },
    }));
  },
});
```

## 文档配置

### 全局配置

在 `config/default.ts` 中配置 OpenAPI 全局信息：

```typescript
// src/config/default.ts
export default {
  openapi: {
    enabled: true,
    title: "My App API",
    description: "我的应用程序 RESTful API 文档",
    version: "1.0.0",

    // OpenAPI JSON 路径
    jsonPath: "/openapi.json",

    // 代理剥离前缀时，外部工具使用的公开 OpenAPI 规范地址
    // jsonPublicPath: '/admin/openapi.json',

    // Vext Docs 配置
    docs: {
      path: "/docs",
      // 代理剥离前缀时，浏览器可见的 docs 资产/数据前缀
      // assetsPublicPath: "/admin/_vext/docs",
      ui: {
        title: "My App API",
        defaultView: "overview",
        theme: "system",
        density: "comfortable",
      },
      code: {
        enabled: "auto",
        services: true,
        utils: true,
        models: true,
      },
    },

    // API 服务器列表
    servers: [
      { url: "http://localhost:3000", description: "本地开发" },
      { url: "https://api.myapp.com", description: "生产环境" },
    ],

    // 标签定义（控制全局 tag 描述，默认文档页仍按 path segment 导航）
    tags: [
      { name: "用户管理", description: "用户 CRUD 操作" },
      { name: "订单管理", description: "订单相关接口" },
      { name: "系统", description: "系统级接口" },
    ],

    // 安全方案定义
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      },
    },

    // 联系方式
    contact: {
      name: "API Support",
      email: "support@myapp.com",
      url: "https://myapp.com/support",
    },

    // 许可证
    license: {
      name: "Apache-2.0",
      url: "https://www.apache.org/licenses/LICENSE-2.0",
    },
  },
};
```

`apiKey` 安全方案可以使用 `in: "cookie"`，`validate.cookie` 也会渲染为 OpenAPI cookie 参数。浏览器 Try it out 不能直接设置受限的 `Cookie` header；如需手动 cookie 值，请使用同源浏览器 cookie 或 cURL 等 HTTP 客户端。

Code docs 会扫描 `src/services`、`src/utils`、配置后的 models 目录、`src/frontend/components`、`src/plugins` 和 `src/middlewares`，且不会 import 或执行用户代码。Services、Utils、Components 需要导出符号上存在标准 JSDoc；Models 会列出可识别的 model 文件，即使没有 JSDoc 也会生成最小条目，default export 上的 JSDoc 会作为增强信息。支持的 model definition 还会在默认 UI 中展示 schema fields、enums、options、indexes、methods、hooks 与 usage 示例。Plugins 会展示可推断的 plugin name、dependencies、lifecycle hooks、全局 middleware 注册、app extension 和 setup 使用方式；Middlewares 会展示可推断的 middleware/factory 类型和路由调用示例。`vext start` 运行构建产物时，如果项目根目录仍存在 `<project>/src`，Vext 会优先读取该源码目录以保留顶层 JSDoc 和本地源码跳转；如果部署环境没有源码树，则回退到运行时目录。

### 路由级文档配置

每个路由可以通过 `options.docs` 配置其 OpenAPI 文档信息：

```typescript
app.post('/users', {
  validate: { ... },
  docs: {
    // 接口摘要（一句话描述）
    summary: '创建用户',

    // 详细描述（支持 Markdown）
    description: '创建一个新用户。\n\n**注意：** 邮箱必须唯一。',

    // 操作标识（全局唯一，默认自动推断）
    operationId: 'createUser',

    // 是否已废弃
    deprecated: false,

    // 是否从文档中隐藏
    hidden: false,

    // 安全方案覆盖
    security: [{ bearerAuth: [] }],

    // 自定义响应定义
    responses: {
      201: {
        description: '创建成功',
        schema: { id: 'string', name: 'string', email: 'email' },
      },
      409: {
        description: '邮箱已存在',
      },
    },

    // 自定义扩展字段（x- 前缀）
    extensions: {
      'x-internal': true,
      'x-rate-limit': '10/min',
    },
  },
}, handler);
```

`x-rate-limit` 只有在 `rate-limit` 对象中间件同时提供正数 `max` 和 `window` 时才会自动生成。字符串中间件、缺失 options、只提供部分字段或字段类型不合法时，Vext 不会输出空的 `x-rate-limit`，以免 OpenAPI 消费者误读限流契约。

## docs 配置详解

### `summary` — 接口摘要

一句话描述接口功能，显示在文档 UI 的接口列表中：

```typescript
docs: {
  summary: "获取用户列表";
}
```

### `description` — 详细描述

支持 Markdown 格式的详细说明，展开接口时显示：

```typescript
docs: {
  summary: '创建用户',
  description: `
创建一个新用户账户。

**前置条件：**
- 需要管理员权限
- 邮箱地址必须唯一

**返回值：**
- 成功时返回新创建的用户对象
- 邮箱冲突时返回 409 错误
  `,
}
```

### `tags` — 已废弃接口标签

路由级 `docs.tags` 已废弃并会被忽略。Vext 现在会优先从路由 path 自动推断一个 operation tag，必要时才回退到 source file：

```
/admin/check-role-test/override → Admin
/api/v1/info                  → API v1
/api/beta/info                → API Beta
/v1/info                      → API v1
/permission/roles/{id}        → Permission
```

如果既有路由仍配置了 `docs.tags`，Vext 会忽略该值并输出废弃警告。请从路由定义中移除该字段，依赖 path/source 自动推断。

### `operationId` — 操作标识

全局唯一的操作标识符。如果不指定，框架自动推断：

```
POST /users       → operationId: 'createUsers'
GET  /users       → operationId: 'getUsers'
GET  /users/:id   → operationId: 'getUsersById'
PUT  /users/:id   → operationId: 'updateUsersById'
DELETE /users/:id → operationId: 'deleteUsersById'
```

```typescript
// 手动指定
docs: {
  operationId: "createNewUser";
}
```

`operationId` 必须在整个 OpenAPI 文档中保持唯一。Vext 在生成阶段会校验显式 `docs.operationId` 和自动推断值：重复的显式值、显式值撞上自动推断值、或不同路由自动推断出同一值都会直接报错。处理方式是为其中一条路由设置唯一的 `docs.operationId`，或调整路由 method/path 让自动推断结果不同。

### `hidden` — 隐藏路由

不希望出现在文档中的路由（如内部接口）：

```typescript
app.get(
  "/internal/metrics",
  {
    docs: { hidden: true },
  },
  handler,
);

app.get(
  "/_health",
  {
    docs: { hidden: true },
  },
  handler,
);
```

### `deprecated` — 标记废弃

标记接口为已废弃，在文档中会有删除线和废弃提示：

```typescript
app.get(
  "/v1/users",
  {
    docs: {
      summary: "获取用户列表（已废弃）",
      description: "请使用 `/v2/users` 替代",
      deprecated: true,
    },
  },
  handler,
);
```

### `security` — 安全方案

新应用推荐用 `RouteOptions.auth` 声明路由保护。OpenAPI security 会优先从 `auth` 生成，然后才回退到历史的 middleware 名称推断：

```typescript
// config/default.ts
export default {
  openapi: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
};
```

路由元数据会在不执行路由模块的前提下完成静态投影。请把认证字段保留在最终内联 options 对象中，或保留在同文件并直接传给路由调用的 `const` 中；有限静态语法会拒绝 options helper 调用。

```typescript
app.get(
  "/profile",
  {
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
    docs: { summary: "获取当前用户" },
  },
  handler,
);
```

如果需要显式指定安全方案，可使用 `auth: { security: "bearerAuth" }`。`auth: { required: false }` 且没有 roles、scopes、permissions 或 `check` 时，OpenAPI 会把该路由标记为公开；如果同时声明这些授权规则，运行时仍会要求认证，OpenAPI 也会输出认证 security。`config.openapi.guardSecurityMap` 仍兼容只声明 middleware 的历史路由，但不应再作为新 Auth 示例的主路径。

#### 区分运行时授权、OpenAPI security 与 Docs access

| 层级                       | 配置字段                                                   | 实际控制内容                                           | **不能**控制的内容                                 |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| 运行时路由授权             | `auth.required`、`roles`、`scopes`、`permissions`、`check` | 请求凭据/身份要求，以及路由的 401/403 判定             | 不会自动把运行时 scope 写成 OpenAPI OAuth scope    |
| OpenAPI operation security | `auth.security` 或手动 `docs.security` 覆盖                | 标准 OpenAPI `security` 的安全方案和 scope metadata    | 不会在运行时执行 role、permission 或自定义 `check` |
| Vext Docs access           | `docs.access` 与 `openapi.docs.access.resolver`            | Vext Docs 及其过滤文档数据中的可见性和 Try it out 过滤 | 不会保护真实 API route                             |

`auth.scopes` 是对 `req.auth.scopes` 的运行时判定，不会自动复制为 OAuth scopes。需要让 OpenAPI 消费者看到 OAuth scope 时，请显式声明，例如 `auth: { scopes: ["posts:write"], security: [{ oauth2: ["posts:write"] }] }`。`docs.access` 只用于描述或过滤文档受众；即使 operation 在 Docs 中隐藏，也必须保留路由自己的 `auth` 要求。

手动覆盖：

```typescript
// 无需认证（即使有 auth 中间件）
docs: {
  security: [];
}

// 指定特定安全方案
docs: {
  security: [{ apiKeyAuth: [] }];
}
```

### `responses` — 运行时响应契约与文档元数据

在与 `validate`、`docs` 同级的顶层 `RouteOptions.responses` 中声明 JSON
响应结构。它是运行时单一真相源：Vext 同时用它驱动线上序列化、OpenAPI、
路由 manifest 和前端生成客户端类型。`docs.responses` 只负责描述、示例、
响应头和 content type 元数据。

```typescript
app.get(
  "/users",
  {
    responses: {
      200: {
        schema: {
          id: "string",
          name: "string",
          email: "email",
          role: "admin|user",
        },
      },
      "4xx": {
        schema: { code: "integer!", message: "string!" },
      },
    },
    docs: {
      responses: {
        200: { description: "成功返回用户列表" },
        401: { description: "未认证" },
        403: { description: "权限不足" },
        500: { description: "服务器内部错误" },
      },
    },
  },
  handler,
);
```

运行时 selector 支持精确状态码（`200`）、状态族（`2xx`）和 `default`。
`response:before` 完成后，Vext 按最终状态以“精确 → 状态族 → default”顺序
选取 schema。每个 schema 在路由注册时由 `fast-json-stringify` 编译一次，
请求链不会重复编译。未声明的对象字段会递归移除；缺失 required 字段会在
提交响应字节前失败。

schema 描述传给 `res.json()` 的业务数据。启用 Vext 标准响应包裹时，框架
还会编译外层 `{ code, data, requestId }`。可以使用 schema-dsl 字段映射，
也可以使用自包含 raw JSON Schema。无法独立解析的 `$ref` 不能编译；请把
对应 `$defs` 放在同一个 schema 中。

`docs.responses.<selector>.schema` 仍作为仅文档兼容入口保留，但运行时走
`JSON.stringify`，不会投影字段，也不具备编译序列化性能路径。同一个规范化
selector 不得在两处重复声明 schema；框架会在路由注册阶段报错，而不是静默
选择其中一个。

HEAD 路由与精确 `204` 契约不会编译或发送响应体。`rawJson()`、`text()`、
redirect、file/download、stream 以及 HTML/SSR `render()` 都会有意绕过 JSON
契约序列化器。

#### 响应示例

```typescript
docs: {
  responses: {
    200: {
      description: '用户详情',
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'admin',
      },
    },
    404: {
      description: '用户不存在',
      example: {
        code: 40001,
        message: '用户不存在',
        requestId: 'xxx',
      },
    },
  },
}
```

#### 多响应示例

```typescript
docs: {
  responses: {
    200: {
      description: '用户详情',
      examples: {
        admin: {
          summary: '管理员用户',
          value: { id: '1', name: 'Admin', role: 'admin' },
        },
        regular: {
          summary: '普通用户',
          value: { id: '2', name: 'User', role: 'user' },
        },
      },
    },
  },
}
```

#### 自定义 Content-Type

```typescript
docs: {
  responses: {
    200: {
      description: 'CSV 导出文件',
      contentType: 'text/csv',
    },
  },
}
```

`contentType` 是文档元数据。运行时编译响应 schema 仅支持 JSON；非 JSON
载荷应使用 `text()`、file/download、stream 或其他匹配的响应方法。

#### 响应头

```typescript
docs: {
  responses: {
    200: {
      description: '成功',
      headers: {
        'X-Total-Count': {
          description: '总记录数',
          schema: { type: 'integer' },
        },
        'X-Page': {
          description: '当前页码',
          schema: { type: 'integer' },
        },
      },
    },
  },
}
```

## validate 与文档的自动联动

路由中的 `validate` 规则会自动映射到 OpenAPI 文档，无需重复编写：

```typescript
app.get(
  "/users",
  {
    validate: {
      query: {
        page: "number:1-",
        limit: "number:1-100",
        status: "active|inactive|banned",
        keyword: "string?",
      },
    },
    docs: { summary: "获取用户列表" },
  },
  handler,
);
```

自动生成的 OpenAPI 参数：

| 参数      | 位置  | 类型    | 约束                                   |
| --------- | ----- | ------- | -------------------------------------- |
| `page`    | query | integer | minimum: 1                             |
| `limit`   | query | integer | minimum: 1, maximum: 100               |
| `status`  | query | string  | enum: ["active", "inactive", "banned"] |
| `keyword` | query | string  | —                                      |

`validate.body` 的规则自动映射为 `requestBody`（JSON schema）：

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
  handler,
);
```

生成的 requestBody schema：

```json
{
  "type": "object",
  "required": ["name", "email"],
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 50 },
    "email": { "type": "string", "format": "email" },
    "age": { "type": "number", "minimum": 0, "maximum": 150 }
  }
}
```

字段级业务描述使用显式、无全局副作用的 builder，生成器会把它输出为 OpenAPI schema 的 `description`：

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
  },
  handler,
);
```

生成的 requestBody schema 中会包含：

```json
{
  "type": "object",
  "required": ["content"],
  "properties": {
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20000,
      "description": "待翻译文本，长度 1-20000 个字符"
    },
    "format": {
      "type": "string",
      "enum": ["plain_text", "preserve_line_breaks"],
      "description": "输出格式"
    }
  }
}
```

### 文件上传路由（multipart/form-data）

使用 `RouteOptions.multipart.files` 声明文件上传路由，生成器自动输出 `multipart/form-data` requestBody。

```typescript
app.post(
  "/upload/avatar",
  {
    middlewares: ["upload"],
    multipart: {
      files: {
        avatar: {
          description: "头像图片（JPEG/PNG，最大 5MB）",
          required: true,
        },
      },
    },
    docs: {
      summary: "上传头像",
    },
  },
  handler,
);
```

生成的 OpenAPI 片段：

```json
{
  "requestBody": {
    "required": true,
    "content": {
      "multipart/form-data": {
        "schema": {
          "type": "object",
          "required": ["avatar"],
          "properties": {
            "avatar": {
              "type": "string",
              "format": "binary",
              "description": "头像图片（JPEG/PNG，最大 5MB）"
            }
          }
        }
      }
    }
  }
}
```

`required: true` 同时是运行时契约和 OpenAPI 提示。请求缺少 required 上传字段时，Vext 会返回 `400` 并包含缺失字段名。optional 和未声明的文件字段允许上传，除非违反 `maxFiles`、`maxFileSize` 或 `allowedMimeTypes`。

:::tip 和 validate.body 的关系
`multipart.files` 和 `validate.body` 互斥。同时配置时，`multipart.files` 优先。
:::

## 按环境控制

建议在开发环境启用文档，生产环境关闭：

```typescript
// src/config/default.ts
export default {
  openapi: {
    enabled: true,
    title: "My App API",
    docs: {
      path: "/docs",
      ui: {
        title: "My App API",
      },
    },
  },
};
```

```typescript
// src/config/production.ts
export default {
  openapi: {
    enabled: false, // 生产环境关闭文档
  },
};
```

如果生产环境需要保留 API 文档（只读参考）：

```typescript
// src/config/production.ts
export default {
  openapi: {
    enabled: true,
    docs: {
      path: "/docs",
      access: {
        mode: "visibility-only",
      },
    },
  },
};
```

`visibility-only` 会保持公开 `/openapi.json` 完整，但 Vext Docs 页面、文档 OpenAPI 数据、config source 数据、code docs、search 数据和菜单会收到按可见性过滤后的数据。若隐藏的 operations 或 code docs 也必须从 canonical docs data 中移除，应使用 `enforce`。

## 自定义文档路径

通过 `docs.path` 和 `jsonPath` 修改两个端点的注册路径。`docsPath` 仍作为兼容字段保留，但新项目推荐使用 `docs.path`：

```typescript
export default {
  openapi: {
    enabled: true,
    docs: {
      path: "/api-docs", // 文档: http://localhost:3000/api-docs
    },
    jsonPath: "/api/spec.json", // JSON: http://localhost:3000/api/spec.json
  },
};
```

### 反向代理路径前缀场景

当应用部署在反向代理后，需要根据代理是否**剥离前缀**分两种情况处理。

#### 情况一：代理剥离前缀（`proxy_pass` 末尾带 `/`）

```nginx
# Nginx：/admin/* → vext（剥离 /admin 前缀）
location /admin/ {
    proxy_pass http://127.0.0.1:3000/;
}
```

此时 vext 收到的请求路径已去掉 `/admin`，路由注册无需修改。内置 docs 页面会从 `/_vext/docs/*.json` 读取 source-aware 数据，所以这些浏览器可见的资产和数据地址也需要带上公开的 `/admin` 前缀。`jsonPublicPath` 仍可作为外部工具和元数据使用的 OpenAPI 公开规范地址，但它不是内置 source-aware docs UI 的主要数据端点。

需要通过 `docs.assetsPublicPath` 配置浏览器可见的 docs 资产/数据前缀，同时保留 `docs.assetsPath` 作为 vext 内部注册路径：

```typescript
// config/production.ts
export default {
  openapi: {
    enabled: true,
    // vext 内部路由保持默认
    jsonPath: "/openapi.json",
    // 外部工具和链接使用的公开 OpenAPI 规范地址
    jsonPublicPath: "/admin/openapi.json",
    docs: {
      path: "/docs",
      // 代理剥离 /admin 后 vext 实际收到的内部路径
      assetsPath: "/_vext/docs",
      // 浏览器看到的公开路径
      assetsPublicPath: "/admin/_vext/docs",
    },
  },
};
```

请求链路：

```
浏览器 GET /admin/docs
  → Nginx 剥离 /admin → vext GET /docs → 返回 Vext Docs HTML
  → 浏览器 fetch /admin/_vext/docs/config.json
  → Nginx 剥离 /admin → vext GET /_vext/docs/config.json ✅
  → 浏览器 fetch /admin/_vext/docs/openapi.json?source=all
  → Nginx 剥离 /admin → vext GET /_vext/docs/openapi.json?source=all ✅
```

#### 情况二：代理透传前缀（`proxy_pass` 末尾不带 `/`）

```nginx
# Nginx：/admin/* → vext（保留 /admin 前缀透传）
location /admin/ {
    proxy_pass http://127.0.0.1:3000;
}
```

此时 vext 收到的请求路径仍带 `/admin`，需要同步配置端点路径。浏览器公开路径与 vext 内部路径一致，所以无需配置 `assetsPublicPath` 或 `jsonPublicPath`：

```typescript
// config/production.ts
export default {
  openapi: {
    enabled: true,
    jsonPath: "/admin/openapi.json",
    docs: {
      path: "/admin/docs",
      assetsPath: "/admin/_vext/docs",
    },
  },
};
```

#### 两种情况对比

|                         | 代理剥离前缀                                    | 代理透传前缀                          |
| ----------------------- | ----------------------------------------------- | ------------------------------------- |
| Nginx `proxy_pass`      | `http://127.0.0.1:3000/`（末尾有 `/`）          | `http://127.0.0.1:3000`（末尾无 `/`） |
| `jsonPath`              | `/openapi.json`（默认）                         | `/admin/openapi.json`                 |
| `docs.path`             | `/docs`（默认）                                 | `/admin/docs`                         |
| `docs.assetsPath`       | `/_vext/docs`（默认）                           | `/admin/_vext/docs`                   |
| `docs.assetsPublicPath` | `/admin/_vext/docs`（**必须配置**）             | 无需配置                              |
| `jsonPublicPath`        | `/admin/openapi.json`（推荐用于公开 spec 链接） | 无需配置                              |

### `servers` — 文档交互地址

`servers` 是写入 OpenAPI 规范文档本身的元数据字段，**与端点注册路径无关**。它用于告诉文档 UI 或第三方工具发起交互请求时使用哪个基础地址。

**默认行为**（不配置时）：

```json
{ "url": "/", "description": "Current server" }
```

相对路径 `/` 会自动跟随当前页面的域名，**绝大多数情况下默认值已够用**。

**需要显式配置的场景**：

- 文档页面和 API 不在同一个域（跨域）
- 希望在文档 UI 或第三方工具中提供多环境切换能力

```typescript
export default {
  openapi: {
    enabled: true,
    servers: [
      { url: "https://sit-api.example.com/admin", description: "SIT 环境" },
      { url: "https://api.example.com/admin", description: "生产环境" },
    ],
  },
};
```

配置后，支持 `servers` 的文档 UI 或工具可以让用户手动切换目标环境。

Vext Docs 会把这些 `servers[]` 条目作为 Try it out 的 Server 列表，并默认选择第一条有效 server。固定本地或部署端点建议直接配置带端口的完整 URL，例如 `http://127.0.0.1:3000`；`servers[].variables` 更适合环境名、区域、租户或 API 版本等真正需要切换的片段，存在时才会渲染为可编辑控件，并参与 URL 预览、Copy URL、代码示例和 Send 请求。`Same origin` 选项默认只在没有配置 OpenAPI servers 时自动出现；可以通过 `openapi.docs.tryItOut.sameOrigin` 设置为 `true` 或 `false` 强制显示或隐藏。`openapi.docs.tryItOut.defaultServer` 支持 `"first"`、`"same-origin"`、`"custom"` 或精确 server URL，用于指定初始选中项。`openapi.docs.tryItOut.customServer` 默认开启，用户可以在浏览器里临时填写其他环境地址，不需要改项目配置。

## 导入外部 OpenAPI

Vext 默认文档页聚焦当前应用生成的 OpenAPI 文档。如果需要把多个外部 OpenAPI 文档聚合到同一个 UI，请在 Vext 外部使用文档平台或独立 UI，并让它们直接读取各服务的 `/openapi.json`。Vext 不暴露第三方 docs renderer hook，也不会安装文档 UI 包。

## 与第三方工具集成

### 导出 OpenAPI 规范

访问 `http://localhost:3000/openapi.json` 获取完整的 OpenAPI 3.0 JSON 文件，可用于：

- **Postman** — 导入 API 集合
- **Insomnia** — 导入 API 工作区
- **代码生成** — 使用 `openapi-generator` 生成客户端 SDK
- **API 网关** — 导入到 Kong、AWS API Gateway 等
- **文档平台** — 导入到 Stoplight、ReadMe 等

### 示例：生成 TypeScript 客户端

```bash
npx openapi-generator-cli generate \
  -i http://localhost:3000/openapi.json \
  -g typescript-fetch \
  -o ./generated/api-client
```

## 文档最佳实践

### 1. 始终提供 `summary`

`summary` 是接口在文档列表中最重要的标识，应简洁明了：

```typescript
// ✅ 好的 summary
docs: {
  summary: "获取用户列表";
}
docs: {
  summary: "创建订单";
}
docs: {
  summary: "上传用户头像";
}

// ❌ 不好的 summary
docs: {
  summary: "这个接口用于获取系统中所有用户的列表数据";
} // 太长
docs: {
  summary: "GET users";
} // 没有价值
```

### 2. 使用一致的标签

统一使用中文或英文标签，并在全局 `tags` 中预定义顺序和描述：

```typescript
// ✅ 在 config 中统一定义
openapi: {
  tags: [
    { name: '认证', description: '登录、注册、Token 管理' },
    { name: '用户', description: '用户 CRUD' },
    { name: '订单', description: '订单管理' },
    { name: '系统', description: '健康检查、配置信息' },
  ],
}
```

### 3. 为错误响应添加文档

常见的错误码应在 `responses` 中说明：

```typescript
docs: {
  summary: '创建用户',
  responses: {
    201: { description: '创建成功' },
    400: { description: '请求参数错误' },
    401: { description: '未认证' },
    409: { description: '邮箱已存在' },
    422: { description: '参数校验失败' },
  },
}
```

### 4. 隐藏内部接口

框架内部或运维使用的接口应标记为 `hidden`：

```typescript
// 健康检查、指标、调试接口等
app.get("/health", { docs: { hidden: true } }, handler);
app.get("/metrics", { docs: { hidden: true } }, handler);
app.get("/debug/config", { docs: { hidden: true } }, handler);
```

### 5. 善用 `deprecated`

API 版本迭代时，使用 `deprecated` 而非直接删除旧接口：

```typescript
// v1 接口标记废弃
app.get(
  "/v1/users",
  {
    docs: {
      summary: "获取用户列表 (v1)",
      deprecated: true,
      description: "此接口已废弃，请使用 `GET /v2/users`",
    },
  },
  handler,
);

// v2 新接口
app.get(
  "/v2/users",
  {
    docs: {
      summary: "获取用户列表",
    },
  },
  handler,
);
```

## 多级目录示例

VextJS 的文件路由支持多层嵌套目录，每一级目录自动映射为 URL 路径段。默认 Vext Docs 页面会使用这些 OpenAPI path segment 生成递归 API 导航，保留稳定资源路径段作为分类，并在该目录下展示具体接口叶子。接口叶子优先使用 `docs.summary`，没有 summary 时回退到接口地址；`{id}` 这类动态 path 参数会按参数处理，不作为普通业务目录强化展示。operation tags 会从路由 path/source 自动推断，并作为轻量元数据 badge 展示；显式 `x-tagGroups` 只作为 vendor extension 元数据保留。

### 目录结构

```bash
src/routes/
├── index.ts                          # → /
├── api/
│   └── v1/
│       ├── index.ts                  # → /api/v1
│       ├── users.ts                  # → /api/v1/users
│       ├── users/
│       │   └── [id]/
│       │       └── orders.ts         # → /api/v1/users/:id/orders
│       └── admin/
│           ├── dashboard.ts          # → /api/v1/admin/dashboard
│           └── users.ts              # → /api/v1/admin/users
└── webhooks/
    └── stripe.ts                     # → /webhooks/stripe
```

### 路径映射对照

| 文件路径                             | URL 前缀                   | 说明                     |
| ------------------------------------ | -------------------------- | ------------------------ |
| `routes/index.ts`                    | `/`                        | 根路由（健康检查）       |
| `routes/api/v1/index.ts`             | `/api/v1`                  | API 版本入口             |
| `routes/api/v1/users.ts`             | `/api/v1/users`            | 用户公开接口             |
| `routes/api/v1/users/[id]/orders.ts` | `/api/v1/users/:id/orders` | 用户订单（动态参数嵌套） |
| `routes/api/v1/admin/dashboard.ts`   | `/api/v1/admin/dashboard`  | 管理后台仪表盘           |
| `routes/api/v1/admin/users.ts`       | `/api/v1/admin/users`      | 管理后台用户管理         |
| `routes/webhooks/stripe.ts`          | `/webhooks/stripe`         | Stripe 回调              |

### 全局 tags 描述

只有需要给自动推断的 operation tags 增加描述时，才需要在配置中预定义全局 tags；默认导航仍以 path segment 为准：

```typescript
// src/config/default.ts
export default {
  port: 3000,
  openapi: {
    enabled: true,
    title: "My App API",
    version: "2.0.0",
    tags: [{ name: "API v1", description: "版本 1 API 接口" }],
  },
};
```

### 各路由文件

#### `routes/api/v1/users.ts` — 用户公开接口

```typescript
// src/routes/api/v1/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/v1/users → 用户列表
  app.get(
    "/",
    {
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-50",
          role: "admin|user?",
        },
      },
      docs: {
        summary: "获取用户列表",
      },
    },
    async (req, res) => {
      const filters = req.valid("query");
      const users = await app.services.user.findAll(filters);
      res.json(users);
    },
  );

  // GET /api/v1/users/:id → 用户详情
  app.get(
    "/:id",
    {
      validate: { param: { id: "string!" } },
      docs: {
        summary: "获取用户详情",
        responses: {
          200: { description: "用户信息" },
          404: { description: "用户不存在" },
        },
      },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      if (!user) app.throw(404, "user.not_found");
      res.json(user);
    },
  );
});
```

#### `routes/api/v1/users/[id]/orders.ts` — 用户订单（多级动态参数）

```typescript
// src/routes/api/v1/users/[id]/orders.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/v1/users/:id/orders → 该用户的订单列表
  app.get(
    "/",
    {
      validate: {
        param: { id: "string!" },
        query: {
          status: "pending|paid|shipped|completed?",
          limit: "number:1-100",
        },
      },
      docs: {
        summary: "获取用户订单列表",
        description: "获取指定用户的所有订单，支持按状态筛选。",
        responses: {
          200: { description: "订单列表" },
          404: { description: "用户不存在" },
        },
      },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const filters = req.valid("query");
      const orders = await app.services.order.findByUserId(id, filters);
      res.json(orders);
    },
  );

  // GET /api/v1/users/:id/orders/:orderId → 订单详情
  app.get(
    "/:orderId",
    {
      validate: {
        param: { id: "string!", orderId: "string!" },
      },
      docs: {
        summary: "获取订单详情",
      },
    },
    async (req, res) => {
      const { id, orderId } = req.valid("param");
      const order = await app.services.order.findOne(id, orderId);
      if (!order) app.throw(404, "order.not_found");
      res.json(order);
    },
  );
});
```

#### `routes/api/v1/admin/dashboard.ts` — 管理后台

```typescript
// src/routes/api/v1/admin/dashboard.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/v1/admin/dashboard/stats → 统计数据
  app.get(
    "/stats",
    {
      middlewares: [
        "auth",
        { name: "check-role", options: { roles: ["admin"] } },
      ],
      docs: {
        summary: "获取仪表盘统计",
        responses: {
          200: {
            description: "统计数据",
            example: {
              totalUsers: 1024,
              activeToday: 256,
              totalOrders: 8192,
              revenue: 99999.99,
            },
          },
          401: { description: "未认证" },
          403: { description: "权限不足" },
        },
      },
    },
    async (_req, res) => {
      const stats = await app.services.dashboard.getStats();
      res.json(stats);
    },
  );
});
```

#### `routes/api/v1/admin/users.ts` — 管理后台用户管理

```typescript
// src/routes/api/v1/admin/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/v1/admin/users → 管理员查看所有用户
  app.get(
    "/",
    {
      middlewares: [
        "auth",
        { name: "check-role", options: { roles: ["admin"] } },
      ],
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-100",
          status: "active|banned|suspended?",
        },
      },
      docs: {
        summary: "管理员查看用户列表",
        description: "管理员专用，支持按用户状态筛选，返回完整用户信息。",
      },
    },
    async (req, res) => {
      const filters = req.valid("query");
      const users = await app.services.user.adminFindAll(filters);
      res.json(users);
    },
  );

  // PATCH /api/v1/admin/users/:id/ban → 封禁用户
  app.patch(
    "/:id/ban",
    {
      middlewares: [
        "auth",
        { name: "check-role", options: { roles: ["admin"] } },
      ],
      validate: {
        param: { id: "string!" },
        body: { reason: "string:1-500!" },
      },
      docs: {
        summary: "封禁用户",
        responses: {
          200: { description: "封禁成功" },
          404: { description: "用户不存在" },
        },
      },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const { reason } = req.valid("body");
      await app.services.user.ban(id, reason);
      res.json({ success: true });
    },
  );
});
```

#### `routes/webhooks/stripe.ts` — 第三方回调

```typescript
// src/routes/webhooks/stripe.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // POST /webhooks/stripe → Stripe 事件回调
  app.post(
    "/",
    {
      validate: {
        header: { "stripe-signature": "string!" },
      },
      docs: {
        summary: "Stripe Webhook 回调",
        description: "接收 Stripe 支付事件通知。需要验证签名。",
        responses: {
          200: { description: "处理成功" },
          400: { description: "签名验证失败" },
        },
      },
    },
    async (req, res) => {
      const signature = req.valid("header")["stripe-signature"];
      await app.services.payment.handleStripeWebhook(req.body, signature);
      res.json({ received: true });
    },
  );
});
```

### 生成的 OpenAPI 路径

以上目录结构最终自动生成以下 OpenAPI 路径。默认 Vext Docs 侧栏按路径段导航，tags 作为接口元数据保留：

| OpenAPI 路径                          | 方法  | Tag         | 来源文件                      |
| ------------------------------------- | ----- | ----------- | ----------------------------- |
| `/api/v1/users`                       | GET   | v1/用户     | `api/v1/users.ts`             |
| `/api/v1/users/{id}`                  | GET   | v1/用户     | `api/v1/users.ts`             |
| `/api/v1/users/{id}/orders`           | GET   | v1/用户订单 | `api/v1/users/[id]/orders.ts` |
| `/api/v1/users/{id}/orders/{orderId}` | GET   | v1/用户订单 | `api/v1/users/[id]/orders.ts` |
| `/api/v1/admin/dashboard/stats`       | GET   | v1/管理后台 | `api/v1/admin/dashboard.ts`   |
| `/api/v1/admin/users`                 | GET   | v1/管理后台 | `api/v1/admin/users.ts`       |
| `/api/v1/admin/users/{id}/ban`        | PATCH | v1/管理后台 | `api/v1/admin/users.ts`       |
| `/webhooks/stripe`                    | POST  | Webhook     | `webhooks/stripe.ts`          |

:::tip 多级目录最佳实践

- **用目录层级表达 URL 结构**：`api/v1/admin/` 自动映射为 `/api/v1/admin/` 前缀，无需手动拼接
- **动态参数用 `[param]` 目录**：`users/[id]/orders.ts` 自动变为 `/users/:id/orders`，文件内的 `param` 校验会出现在 OpenAPI 文档中
- **operation tag 自动推断**：路由级 `docs.tags` 已废弃并会被忽略；Vext 从路由 path/source 自动推断 operation tags，默认文档页仍按路径段导航
- **文件名即路由**：无需 `app.group()` 或手动注册路由前缀，目录结构就是路由结构
  :::

## 标签分组（x-tagGroups）

OpenAPI 3.x 规范的 `tags` 是**一维扁平列表**，不原生支持嵌套层级。当路由数量较多时，所有 tags 在文档侧边栏中平铺并列，不便于导航。

VextJS 只有在显式配置 `openapi.tagGroups` 时才会透传 `x-tagGroups`。内置 Vext Docs renderer 的默认侧栏主导航会优先使用 OpenAPI path segment 生成递归树，因此 `x-tagGroups` 只是原始 OpenAPI vendor extension 元数据，不是 Vext Docs 的导航能力。

### 默认行为

VextJS 默认不生成 `x-tagGroups`。内置 Vext Docs renderer 会使用 OpenAPI path segment 作为递归侧栏的真相源，因此自动 tag 分组并不必要，也容易生成 `General / Admin` 这类误导性分组。

路由级 `docs.tags` 已废弃并会被忽略。如果交付链路里的其他 OpenAPI 工具需要 `x-tagGroups`，可以在配置中显式指定 `tagGroups`，并确保分组里的名称匹配自动推断出的 operation tags 或全局 `openapi.tags`：

```typescript
// src/config/app.ts
export default {
  port: 3000,
  openapi: {
    enabled: true,
    title: "My API",
    version: "1.0.0",

    // 给 OpenAPI 工具显式透传 vendor extension
    tagGroups: [
      {
        name: "Public API",
        tags: ["API v1"],
      },
      {
        name: "Integration",
        tags: ["Webhooks"],
      },
    ],

    // 可选：给自动推断的 operation tags 增加描述。
    tags: [
      { name: "API v1", description: "版本 1 API 接口" },
      { name: "Webhooks", description: "第三方回调" },
    ],
  },
};
```

:::warning
只有配置了 `tagGroups` 时，框架才会输出 `x-tagGroups`。请确保每个分组内的 tag 名称都能匹配 operation tag 或全局 `tags` 定义，避免消费该 OpenAPI 文档的工具出现未分组或不可见的标签。
:::

### 效果对比

|          默认 Vext Docs          |                   显式 x-tagGroups                   |
| :------------------------------: | :--------------------------------------------------: |
| 侧栏按 OpenAPI path segment 导航 |     OpenAPI 文档包含显式 vendor extension 元数据     |
|  `/api/v1/info` 保留为资源分类   | **Public API** ▸ API v1 / **Integration** ▸ Webhooks |
|       tags 作为接口元数据        |    仅适合下游 OpenAPI 工具明确消费 `x-tagGroups`     |

### 与热重载的兼容性

在 dev 模式下，热重载（soft reload）会自动重新生成 OpenAPI spec。如果配置了 `openapi.tagGroups`，显式 `x-tagGroups` 会随 spec 一起再次输出：

1. 路由文件变更 → 触发热重载
2. 创建新的 adapter 实例
3. 重新加载路由 + 收集路由元信息
4. 重新生成 OpenAPI spec（配置了 `tagGroups` 时包含显式 `x-tagGroups`）
5. 在新 adapter 上重新注册 `/docs` 和 `/openapi.json` 端点

无需重启 dev server，刷新文档页面即可看到更新后的分组。

## 完整示例

```typescript
// src/routes/orders.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // 获取订单列表
  app.get(
    "/",
    {
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-50",
          status: "pending|paid|shipped|completed|cancelled",
          startDate: "date?",
          endDate: "date?",
        },
      },
      docs: {
        summary: "获取订单列表",
        description: "分页获取当前用户的订单列表，支持按状态和日期范围筛选。",
        responses: {
          200: {
            description: "订单列表",
            headers: {
              "X-Total-Count": {
                description: "总订单数",
                schema: { type: "integer" },
              },
            },
          },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const filters = req.valid("query");
      const orders = await app.services.order.findAll(filters);
      res.json(orders);
    },
  );

  // 创建订单
  app.post(
    "/",
    {
      validate: {
        body: {
          productId: "string!",
          quantity: "number:1-99!",
          shippingAddress: "string:1-200!",
          couponCode: "string?",
        },
      },
      docs: {
        summary: "创建订单",
        responses: {
          201: {
            description: "订单创建成功",
            example: {
              orderId: "ord_abc123",
              status: "pending",
              total: 99.99,
            },
          },
          400: { description: "库存不足或优惠券无效" },
          401: { description: "未认证" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const data = req.valid("body");
      const order = await app.services.order.create(data);
      res.json(order, 201);
    },
  );

  // 取消订单
  app.post(
    "/:id/cancel",
    {
      validate: {
        param: { id: "string!" },
        body: { reason: "string:1-500?" },
      },
      docs: {
        summary: "取消订单",
        responses: {
          200: { description: "取消成功" },
          400: { description: "订单状态不允许取消" },
          404: { description: "订单不存在" },
        },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const { reason } = req.valid("body");
      await app.services.order.cancel(id, reason);
      res.json({ success: true });
    },
  );
});
```

## 下一步

- 了解 [参数校验](/guide/validation) 的 DSL 语法如何映射到 OpenAPI
- 学习 [配置](/guide/configuration) 中 OpenAPI 的完整选项
- 查看 [Adapter 架构](/guide/adapters) 了解不同 Adapter 下的文档行为
- 探索 [测试](/guide/testing) 如何验证 API 文档的准确性
