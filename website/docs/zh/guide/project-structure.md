# 项目结构

VextJS 遵循 **约定优于配置** 的设计理念，通过固定的目录结构实现自动扫描、加载和注册，无需手动配置路由映射或服务注入。

## 标准目录结构

此树状图描述 Vext 会识别的约定，并不表示每个可选目录都会被生成。`vext create` 只生成有初始运行内容的文件，不再用占位 README 文件保留空目录。

```bash
my-app/
├── public/                    # 会复制到前端构建产物的静态资源
│   ├── favicon.svg             # 使用同一 V 几何的高对比 favicon 变体
│   └── vext-mark.svg           # AppShell 使用的透明 V 标记
│
├── src/
│   ├── frontend/              # 前端源码（默认全栈模板）
│   │   ├── pages/             # 页面、layout、错误页和 document 模板
│   │   │   ├── index.tsx
│   │   │   ├── layout.tsx
│   │   │   ├── _document.html
│   │   │   └── error/
│   │   │       └── default.tsx
│   │   ├── components/        # 公共组件
│   │   ├── styles/            # CSS / JSCSS / tokens
│   │   │   └── index.css
│   │   ├── assets/            # 通过 TSX/CSS import 进入打包图的资产
│   │   └── locales/           # 前端页面文案
│   │       ├── zh-CN.ts
│   │       └── en-US.ts
│   │
│   ├── config/                # 配置文件（必须）
│   │   ├── default.ts         # 默认配置（必须存在）
│   │   ├── bootstrap.ts       # 可跟踪的启动期入口；默认 providers: []
│   │   ├── development.ts     # 开发环境覆盖（可选）
│   │   ├── production.ts      # 生产环境覆盖（可选）
│   │   └── local.ts           # 生成的空本地覆盖；被 Git 忽略
│   │
│   ├── preload/               # 可选项目级 preload 源；需要时再创建
│   │   └── 01-otel.ts         # 进程启动前执行
│   │
│   ├── routes/                # 路由定义（约定式，自动扫描）
│   │   ├── index.ts           # → /
│   │   ├── users.ts           # → /users
│   │   ├── users/
│   │   │   ├── index.ts       # → /users（与 users.ts 二选一）
│   │   │   └── [id].ts        # → /users/:id（动态参数）
│   │   └── admin/
│   │       ├── index.ts       # → /admin
│   │       └── settings.ts    # → /admin/settings
│   │
│   ├── services/              # 服务层（约定式，自动扫描 + 注入）
│   │   ├── user.ts            # → app.services.user
│   │   ├── order.ts           # → app.services.order
│   │   └── payment/
│   │       └── stripe.ts      # → app.services.payment.stripe
│   │
│   ├── constants/             # 共享运行时值；有真实消费者时再创建
│   │   └── services/
│   │       └── order-status.ts # service 消费者共享的运行时常量
│   │
│   ├── utils/                 # 无状态公共函数；普通 import，不自动扫描
│   │   └── format-date.ts
│   │
│   ├── middlewares/            # 中间件定义（约定式，自动扫描）
│   │   ├── auth.ts            # → 通过 name 'auth' 引用
│   │   └── check-role.ts      # → 通过 name 'check-role' 引用
│   │
│   ├── plugins/               # 插件（约定式，自动扫描）
│   │   ├── redis.ts           # 自定义插件
│   │   └── sentry.ts          # 自定义插件
│   │
│   ├── locales/               # 国际化语言包（可选）
│   │   ├── zh-CN.ts           # 中文语言包
│   │   └── en-US.ts           # 英文语言包
│   │
│   └── types/                 # 应用自有的类型边界（TS 项目）
│       ├── shared/
│       │   └── greeting.d.ts  # 前后端安全共享契约示例
│       ├── frontend/
│       │   └── home.d.ts      # 仅前端声明示例
│       ├── server/
│       │   └── services/
│       │       └── order.ts   # 后端消费者共享的 type-only 契约
│       └── generated/         # 仅由 vext typegen 管理
│           └── index.d.ts     # typegen 后生成；脚手架初始为 .gitkeep
│
├── .vext/
│   ├── client/                # 开发期前端构建产物
│   ├── types/                 # hidden generated declarations
│   └── manifest/              # tooling manifests
│
├── dist/                      # 构建产物（vext build 生成）
│   └── client/                # frontend.enabled 为 true 时的生产前端资源
├── package.json
└── tsconfig.json              # TypeScript 配置
```

## 各目录详解

### `src/config/` — 配置目录

框架启动时，`config-loader` 按以下顺序加载配置文件并深度合并：

```
框架内置默认值 → default.ts → {profile}.ts → local.ts → bootstrap provider patch → CLI override
```

| 文件             | 用途                                                         | 是否必须 |
| ---------------- | ------------------------------------------------------------ | -------- |
| `default.ts`     | 所有 profile 的基础配置                                      | ✅ 必须  |
| `bootstrap.ts`   | 可跟踪的启动期 provider 入口；脚手架默认生成 `providers: []` | 可选     |
| `development.ts` | 开发默认 profile 覆盖                                        | 可选     |
| `production.ts`  | 生产默认 profile 覆盖                                        | 可选     |
| `test.ts`        | 测试默认 profile 覆盖                                        | 可选     |
| `sg-sit.ts`      | 自定义 profile 覆盖                                          | 可选     |
| `local.ts`       | 创建时生成的空本地覆盖；脚手架 `.gitignore` 默认排除该文件   | 可选     |

配置 profile 可通过 `vext start --config <name>` 或 `VEXT_CONFIG=<name>` 选择。例如 `vext start --config sg-sit` 时加载 `sg-sit.ts`。

:::info 脚手架约定
`vext create` 会直接生成零副作用的 `local.ts` 与 `bootstrap.ts`：前者是空 `VextConfigOverride`，后者是 `providers: []`。脚手架 `.gitignore` 会排除 `local.ts`，因此 fresh clone 中可以没有它，build/start 也不得依赖它存在；`bootstrap.ts` 正常跟踪。
:::

```typescript
// src/config/default.ts
export default {
  port: 3000,
  host: "0.0.0.0",
  logger: { level: "info" },
  openapi: { enabled: true },
};
```

```typescript
// src/config/production.ts — 仅覆盖需要变更的字段
export default {
  logger: { level: "warn" },
  openapi: { enabled: false },
};
```

:::tip 合并策略
配置采用深度合并（deep merge），你只需在环境文件中声明需要覆盖的字段。`middlewares` 数组使用智能 patch 策略（按 `name` 匹配并覆盖），而非简单的数组替换。`bootstrap.ts` 返回的 provider patch 会在 `local.ts` 之后、CLI override 之前参与同一套 merge / validate / freeze 流程。
:::

#### `bootstrap.ts` 做什么？

当配置必须在应用启动前从远端拉取时，可新增 `src/config/bootstrap.ts`：

```typescript
import { defineBootstrapConfig } from "vextjs";

export default defineBootstrapConfig({
  providers: [
    {
      name: "remote-config",
      async load({ env, signal }) {
        const response = await fetch(`https://config.example.com/${env}.json`, {
          signal,
        });
        return await response.json();
      },
    },
  ],
});
```

常见用途：

- 数据库连接信息
- Nacos / 配置中心启动期 patch
- 需要在内置插件初始化前就可见的基础设施配置

### `src/frontend/` — 前端目录

默认全栈脚手架会创建 `src/frontend/` 作为 React 页面源码目录。URL 入口仍由 `src/routes/**` 定义，route handler 通过 `res.render(page, props, options)` 渲染页面；浏览器入口和 registry 由 Vext 自动生成到 `.vext/generated/frontend/`。

| 路径                                                  | 用途                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pages/index.tsx` / `pages/index.jsx`                 | 默认页面，page id 为 `index`                                                      |
| `pages/layout.tsx` / `pages/layout.jsx`               | 目录级 layout，可嵌套复用                                                         |
| `pages/error/default.tsx` / `pages/error/default.jsx` | 默认错误页面                                                                      |
| `pages/_document.html`                                | HTML document，使用 `{vext.root}`、`{vext.data}`、`{vext.entry}`、`{vext.styles}` |
| `components/`                                         | 公共组件，可通过 `@components/...` 导入                                           |
| `styles/index.css`                                    | 全局样式入口                                                                      |
| `assets/`                                             | TSX/CSS import 的图片、字体等资源                                                 |
| `locales/`                                            | 前端页面文案，配合 `useVextI18n()` 使用                                           |

当 `config.frontend.enabled` 为 true：

- `vext dev` 将客户端构建到 `.vext/client/`
- `vext build` 将生产资源写入 `dist/client/`
- `vext start` 服务生产客户端、SSR renderer 与静态资源；未知 HTML 路径是否 fallback 取决于 `frontend.spaFallback.scopes[]`

### `src/types/` — 应用类型边界

新建 TypeScript 全栈项目时，`vext create` 会生成以下明确结构：

```text
src/types/
├── shared/
│   └── greeting.d.ts
├── frontend/
│   └── home.d.ts
└── generated/
    └── .gitkeep # 执行 vext typegen 后生成/补充 index.d.ts
```

- `src/types/shared/` 放置前后端均可安全导入的契约。
- `src/types/frontend/` 放置浏览器侧声明，不能导入 Node-only 或 server-only 模块。
- `src/types/generated/` 是框架生成区，请勿手工维护；`vext typegen` 可以更新其中声明。

TypeScript API-only 模板没有前端消费者，因此只创建
`src/types/generated/`；JavaScript 模板不创建 `src/types/`。Vext 不预建
`src/types/server/`：后端专属类型优先与 route、service、plugin 或 Model 就近放置，
等确实出现后端跨模块共享契约时，项目可自行增加 server 目录。多个后端 service
消费者共享的 type-only 契约放在 `src/types/server/services/<domain>.ts`；需要与
浏览器共享的 DTO 放在 `src/types/shared/<domain>.ts`。

TypeScript runtime enum、class、symbol、带初始化的常量及其他运行时值不能放进
`src/types/**`。只有一个 owner 时就近放置；多个 service 共享时提升到
`src/constants/services/<domain>.ts`。

该变化只影响新脚手架。现有项目不会被移动、重命名或删除，`vext typegen` 也仍然
只管理 `src/types/generated/`。前后端运行配置继续统一放在 `src/config/`，不能放进
任何 types 目录。

### `public/` — 前端静态资源

`public/` 中的文件会复制到前端输出目录。默认全栈脚手架会生成用于 AppShell 的透明 `vext-mark.svg` 和高对比 `favicon.svg`；两者使用同一 V 几何。这里适合放置这些固定 URL 资源、robots、静态图片等不需要进入 JavaScript bundle 的资源。需要由 TSX/CSS import 并带 hash 输出的图片或字体，建议放在 `src/frontend/assets/`。

### `src/routes/` — 路由目录

路由文件由 `router-loader` 自动扫描，文件路径直接映射为 URL 前缀。每个文件使用 `defineRoutes()` 导出路由定义。

#### 路径映射规则

| 文件路径                   | URL 前缀          | 说明              |
| -------------------------- | ----------------- | ----------------- |
| `routes/index.ts`          | `/`               | 根路由            |
| `routes/users.ts`          | `/users`          | 一级路由          |
| `routes/users/index.ts`    | `/users`          | 等同于 `users.ts` |
| `routes/users/[id].ts`     | `/users/:id`      | 动态参数          |
| `routes/admin/settings.ts` | `/admin/settings` | 嵌套路由          |

#### 动态参数

使用 `[paramName]` 语法表示动态路由参数，加载时自动转换为 `:paramName`：

```
routes/users/[id].ts        → /users/:id
routes/posts/[slug]/comments.ts → /posts/:slug/comments
```

#### 文件内的子路由

每个文件内部可以注册多个子路由。路径会自动拼接文件级前缀：

```typescript
// src/routes/users.ts → 前缀 /users
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /users/list
  app.get("/list", async (req, res) => {
    const users = await app.services.user.findAll();
    res.json(users);
  });

  // POST /users（子路径为 / 时与前缀合并）
  app.post("/", async (req, res) => {
    const user = await app.services.user.create(req.body);
    res.json(user, 201);
  });

  // GET /users/:id
  app.get("/:id", async (req, res) => {
    const user = await app.services.user.findById(req.params.id);
    res.json(user);
  });
});
```

#### 排除规则

以下文件会被自动跳过，不作为路由加载：

- 测试文件：`*.test.ts`、`*.spec.ts`
- 以 `_` 或 `.` 开头的文件/目录
- `node_modules` 目录

### `src/services/` — 服务目录

服务文件由 `service-loader` 自动扫描，每个文件导出一个 class，构造函数接收 `app` 参数。实例化后自动挂载到 `app.services`。

#### 命名映射规则

| 文件路径                     | 访问方式                      | 说明              |
| ---------------------------- | ----------------------------- | ----------------- |
| `services/user.ts`           | `app.services.user`           | 扁平命名          |
| `services/order.ts`          | `app.services.order`          | 扁平命名          |
| `services/payment/stripe.ts` | `app.services.payment.stripe` | 嵌套命名          |
| `services/user-profile.ts`   | `app.services.userProfile`    | kebab → camelCase |

文件名自动从 `kebab-case` 转换为 `camelCase`。子目录会映射为嵌套对象。

#### Service 辅助代码的所有权

| 内容                                            | 推荐位置                                         |
| ----------------------------------------------- | ------------------------------------------------ |
| 单个 service 私有的 type/interface              | service 同文件或领域 owner 附近的 type-only 文件 |
| 多个后端 service 共享的 type-only 契约          | `src/types/server/services/<domain>.ts`          |
| 服务端与浏览器共享的 DTO                        | `src/types/shared/<domain>.ts`                   |
| 单个领域私有的运行时 enum/constant              | 该领域 owner 附近                                |
| 多个 service 或跨模块共享的运行时 enum/constant | `src/constants/services/<domain>.ts`             |

不要把辅助文件放在 `src/services/_types` 或 `src/services/_enums`。runtime、
typegen、Code Docs 与 reload 工具的消费者并不完全相同；把非 service owner 放在
扫描目录之外，边界才是显式且一致的。

#### 服务类写法

```typescript
// src/services/user.ts
import type { VextApp } from "vextjs";

export default class UserService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async findAll() {
    // 业务逻辑...
    return [];
  }

  async findById(id: string) {
    // 可以访问其他 service
    // const profile = await this.app.services.userProfile.get(id);
    return { id, name: "Alice" };
  }

  async create(data: unknown) {
    this.app.logger.info({ data }, "Creating user");
    return { id: "1", ...(data as object) };
  }
}
```

:::warning 循环依赖检测
`service-loader` 内置循环依赖检测机制。如果 `ServiceA` 在构造函数中直接访问 `app.services.b`，而 `ServiceB` 也访问 `app.services.a`，框架会在启动时检测到并报错。

推荐做法：在构造函数中只保存 `app` 引用，在方法中按需访问其他 service（延迟访问）。
:::

### `src/utils/` — 公共函数

`src/utils/` 只放无状态、可复用且边界清晰的 helper，例如格式转换、纯计算或稳定
解析。通过普通 `import` 使用；Vext 不会自动扫描、实例化 `src/utils/`，也不会把它
注入 `app`。

只有一个领域消费者时，helper 应与领域 owner 就近放置；出现真实跨领域复用后再
提升到 `src/utils/`。依赖 `VextApp`、数据库、请求上下文或可变领域状态的逻辑，应
留在 service、plugin 或 route 附近。前端会导入的 helper 必须 browser-safe，不能
从前端入口暴露 Node-only 工具。

### `src/middlewares/` — 中间件目录

中间件文件由 `middleware-loader` 自动扫描。每个文件导出一个通过 `defineMiddleware` 或 `defineMiddlewareFactory` 标记的中间件。

文件名即中间件名，在配置和路由中通过名称引用：

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) req.app.throw(401, "Unauthorized");
  // ... 验证 token
  await next();
});
```

使用时，先在配置中声明白名单，然后在路由中引用：

```typescript
// src/config/default.ts
export default {
  middlewares: [
    "auth", // 普通中间件
    { name: "check-role", options: { roles: ["admin"] } }, // 工厂中间件 + 默认参数
  ],
};
```

```typescript
// src/routes/admin.ts — 路由中引用
app.get(
  "/dashboard",
  {
    middlewares: ["auth", "check-role"],
  },
  handler,
);
```

详见 [中间件](/guide/middleware) 章节。

### `src/plugins/` — 插件目录

插件文件由 `plugin-loader` 自动扫描，按 `dependencies` 声明进行拓扑排序后依次执行 `setup()`。

```typescript
// src/plugins/redis.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "redis",
  async setup(app) {
    const redis = createRedisClient(app.config.redis);
    app.extend("redis", redis);
    app.onClose(() => redis.quit());
  },
});
```

详见 [插件](/guide/plugins) 章节。

### `src/locales/` — 国际化目录

语言包文件由 `i18n-loader` 自动扫描，文件名即语言代码。加载后注册到 schema-dsl 的 i18n 系统，与 `app.throw()` 联动。

```typescript
// src/locales/zh-CN.ts
export default {
  "user.not_found": { code: 40001, message: "用户不存在" },
  "balance.insufficient": {
    code: 20001,
    message: "余额不足，当前余额 {{balance}}",
  },
};
```

```typescript
// src/locales/en-US.ts
export default {
  "user.not_found": { code: 40001, message: "User not found" },
  "balance.insufficient": {
    code: 20001,
    message: "Insufficient balance, current: {{balance}}",
  },
};
```

详见 [国际化 (i18n)](/guide/i18n) 章节。

## 自动扫描加载顺序

框架启动时（`bootstrap`）按以下顺序加载各目录：

```
1. config/      → 加载并合并配置（loadConfig）
2. locales/     → 加载语言包（loadI18n）
3. plugins/     → 拓扑排序 + 执行 setup()（loadPlugins）
4. middlewares/ → 扫描中间件定义（loadMiddlewares）
5. services/    → 实例化并注入到 app.services（loadServices）
6. routes/      → 扫描路由 + 注册到 adapter（loadRoutes）
7. frontend     → `frontend.enabled` 为 true 时构建 / 服务客户端资源
8. 启动 HTTP 监听
```

这个顺序确保：

- 配置在所有模块之前就绪
- 插件可以扩展 `app` 对象（如注入数据库连接）
- 中间件在路由注册前就绪
- 服务在路由之前注入，路由 handler 中可以安全访问 `app.services`

## `package.json` 要求

VextJS 项目必须声明为 ESM 模块：

```json
{
  "type": "module",
  "scripts": {
    "start": "vext start",
    "dev": "vext dev",
    "build": "vext build"
  }
}
```

## `tsconfig.json` 推荐配置

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

## 构建产物 `dist/`

执行 `vext build` 后，`src/` 下的 TypeScript 文件会被编译到 `dist/` 目录，保持相同的目录结构。生产模式下（`vext start`）直接从 `dist/` 加载。

```
dist/
├── config/
│   └── default.js
├── routes/
│   └── index.js
├── services/
│   └── user.js
├── client/
│   ├── assets/
│   ├── index.html
│   ├── manifest.json
│   └── size-report.json
└── ...
```

:::tip 开发 vs 生产

- **`vext dev`**：直接从 `src/` 加载 `.ts` 文件（通过 esbuild 即时编译），支持热重载
- **`vext start`**：从 `dist/` 加载 `.js` 文件，需要先执行 `vext build`
  - 启用前端时，生产启动还要求存在 `dist/client/index.html`
    :::

## 下一步

- 学习 [路由](/guide/routing) 的三段式定义和参数校验
- 配置 [前端指南](/zh/frontend/overview)
- 了解 [服务层](/guide/services) 的设计模式
- 探索 [配置](/guide/configuration) 的完整选项
