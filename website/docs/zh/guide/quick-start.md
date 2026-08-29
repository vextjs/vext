# 快速开始

:::warning 版本通道
本站跟随 `main`，当前预览 `v2.0.0`（`next`）。npm 已发布的最新稳定版仍是 `v1.0.2`（`stable`），因此在 2.0.0 正式发布前，下面的安装命令和依赖示例会有意使用稳定版。
:::

## 方式一：使用脚手架（推荐）

VextJS 提供 `vext create` 命令创建可运行项目。默认模板会直接证明一套路由模型：`/` 通过 `res.render()` 渲染 React，`/api/hello` 返回 JSON，两者都调用生成的 example service；不需要页面运行时则选择 API-only。

```bash
# 创建 TypeScript 全栈项目（默认 Native Adapter）
npx vextjs create my-app

# 创建并指定 Adapter
npx vextjs create my-app --adapter hono

# 创建 JavaScript 全栈项目
npx vextjs create my-app --js

# 创建 API-only 项目
npx vextjs create my-api --template api --frontend none

# 跳过 npm install
npx vextjs create my-app --skip-install
```

创建完成后：

```bash
cd my-app
npm run dev
```

访问 `http://localhost:3000` 查看服务端渲染 starter，访问 `http://localhost:3000/docs` 查看实时 API 文档。后端 API 路由位于 `/api/hello` 与 `/api/health`。

## 方式二：手动创建

### 1. 初始化项目

```bash
mkdir my-app && cd my-app
npm init -y
npm install vextjs
```

### 2. 配置 `package.json`

```json
{
  "name": "my-app",
  "type": "module",
  "scripts": {
    "start": "vext start",
    "dev": "vext dev",
    "build": "vext build"
  },
  "dependencies": {
    "vextjs": "^1.0.2"
  }
}
```

:::tip
VextJS 要求 `"type": "module"`，项目使用 ESM 模块格式。
:::

### 3. 创建目录结构

```bash
mkdir -p src/config src/routes src/services src/middlewares src/plugins src/locales src/preload src/types/generated src/frontend/pages/error src/frontend/components src/frontend/styles src/frontend/assets src/frontend/locales public
```

### 4. 编写配置

```typescript
// src/config/default.ts
export default {
  port: 3000,
  host: "0.0.0.0",
  logger: {
    level: "info",
  },
  openapi: {
    enabled: true,
  },
  frontend: {
    enabled: true,
    framework: "react",
    publicDir: "public",
    publicPath: "/",
    i18n: {
      enabled: true,
      defaultLocale: "en-US",
    },
  },
};
```

如需使用其他 Adapter（如 Hono），先安装对应包再配置：

```bash
npm install hono
```

```typescript
// src/config/default.ts
import { honoAdapter } from "vextjs/adapters/hono";

export default {
  adapter: honoAdapter(),
  port: 3000,
};
```

### 4.1 可选：添加 `src/config/bootstrap.ts`

如果某些配置必须在启动期从远端读取，并且要在 `config` 冻结前参与合并，可以新增 `src/config/bootstrap.ts`：

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

适合：数据库、Nacos 启动期配置、密钥 patch。

不适合：APM / OpenTelemetry 这类需要更早执行的 `preload` 场景。

### 5. 编写路由

```typescript
// src/routes/index.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // GET /api/hello
  app.get(
    "/api/hello",
    {
      docs: { summary: "Hello API" },
    },
    async (_req, res) => {
      res.json({ message: "Hello VextJS!" });
    },
  );

  // GET /api/health
  app.get(
    "/api/health",
    {
      docs: { summary: "健康检查" },
    },
    async (_req, res) => {
      res.json({
        status: "ok",
        uptime: process.uptime(),
      });
    },
  );
});
```

### 6. 编写服务（可选）

```typescript
// src/services/example.ts
export default class ExampleService {
  async getGreeting(name: string) {
    return { message: `Hello, ${name}!` };
  }
}
```

在路由中使用服务：

```typescript
// src/routes/greet.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/greet/:name",
    {
      validate: {
        param: { name: "string!" },
      },
      docs: { summary: "问候接口" },
    },
    async (req, res) => {
      const { name } = req.valid("param");
      const result = await app.services.example.getGreeting(name);
      res.json(result);
    },
  );
});
```

### 7. 启动

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build
npm start
```

前端页面放在 `src/frontend/pages/**`。浏览器入口、页面 registry、layout registry 和 HTML 注入代码由 Vext 自动生成；手动项目至少需要创建 `src/frontend/pages/index.tsx`、`src/frontend/pages/_document.html` 与 `src/frontend/styles/index.css`，也可以直接从默认 `vext create` 模板开始。

默认全栈模板会展示 SSR Vext runtime launchpad，并明确呈现「路由 → 服务 → SSR → 浏览器运行时」链路；顶部导航同时提供官方 Vext Guide 和生成项目的本地 API 文档 `/docs`，次要行动按钮打开 Vext Guide。模板默认启用 `openapi.enabled: true`，因此本地文档入口在开发与生产模式都可用。模板只包含真实 starter 源码：不会生成根目录 README 或占位 README 文件。TypeScript、JavaScript 的全栈与 API-only 模板所生成的用户源码均以英文为默认语言，显式 locale 资源是唯一语言内容例外。AppShell 使用透明的 `public/vext-mark.svg`，`public/favicon.svg` 是采用相同 V 几何的高对比 favicon 变体。只有在添加对应源码时，才创建可选约定目录。

## 项目结构

脚手架或手动创建后，你的项目结构应该如下：

```
my-app/
├── public/
│   ├── favicon.svg           # 使用同一 V 几何的高对比 favicon 变体
│   └── vext-mark.svg         # AppShell 使用的透明 V 标记
├── src/
│   ├── config/
│   │   ├── default.ts        # 共享配置（port: 3000）
│   │   ├── development.ts    # 开发环境 profile
│   │   ├── production.ts     # 生产环境 profile
│   │   ├── local.ts          # 空本地覆盖；被 Git 忽略
│   │   └── bootstrap.ts      # 可跟踪的启动入口，默认 providers: []
│   ├── frontend/
│   │   ├── components/AppShell.tsx # 公共 React shell
│   │   ├── locales/en-US.ts  # starter 文案
│   │   ├── pages/            # React 页面、layout、document 和错误页
│   │   └── styles/index.css  # Vext launchpad 样式
│   ├── routes/index.ts       # URL handler 和服务端数据
│   ├── services/example.ts   # 服务层
│   └── types/generated/.gitkeep # TypeScript 项目的 typegen 输出根
├── package.json
├── tsconfig.json
└── .gitignore
```

:::info 约定
VextJS 会自动扫描 `src/routes/`、`src/services/`、`src/config/`、`src/middlewares/`、`src/plugins/`、`src/locales/`、`src/preload/`、`src/frontend/` 与 `public/`，无需手动注册。初始脚手架只创建已有 starter 内容的目录；可选约定目录会在你创建后被自动扫描。项目根 `preload/` 仅作为带 warning 的迁移回退保留。路由文件名会映射为 URL 前缀：

| 文件路径                       | URL 前缀          |
| ------------------------------ | ----------------- |
| `src/routes/index.ts`          | `/`               |
| `src/routes/users.ts`          | `/users`          |
| `src/routes/admin/index.ts`    | `/admin`          |
| `src/routes/admin/settings.ts` | `/admin/settings` |

:::

脚手架会直接创建零副作用的 `src/config/local.ts` 与 `src/config/bootstrap.ts`。`local.ts` 初始为空 `VextConfigOverride`，并被 `.gitignore` 排除，因此 fresh clone 中没有它也不影响 build/start；`bootstrap.ts` 初始为 `providers: []`，正常跟踪，后续可在 CLI override 前注册启动期 provider。service 类型、运行时常量与公共函数的所有权规则见[项目结构](/zh/guide/project-structure)。

## 访问 OpenAPI 文档

默认 `fullstack-react` 配置已经启用 `openapi.enabled: true`。对于 API-only 项目，或你主动关闭它之后，请先启用该配置再启动项目：

- **Vext Docs 文档**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/openapi.json`

## CLI 命令速览

| 命令                 | 说明                                |
| -------------------- | ----------------------------------- |
| `vext dev`           | 开发模式，文件监听 + 热重载         |
| `vext start`         | 生产模式启动                        |
| `vext build`         | 构建项目（TypeScript → JavaScript） |
| `vext create <name>` | 创建新项目                          |
| `vext stop`          | 停止 Cluster 进程                   |
| `vext reload`        | 滚动重启 Worker                     |
| `vext status`        | 查看 Cluster 运行状态               |

## 开发模式热重载

`vext dev` 提供三层热重载策略，自动选择最优方式：

| 层级                    | 触发条件             | 行为                       | 速度      |
| ----------------------- | -------------------- | -------------------------- | --------- |
| **Tier 1** — 路由热替换 | 路由文件变更         | 原子替换请求处理器，零中断 | ⚡ 毫秒级 |
| **Tier 2** — 服务重载   | 服务 / i18n 文件变更 | 重建受影响的服务实例       | ⚡ 毫秒级 |
| **Tier 3** — 冷重启     | 配置 / 插件变更      | 完整重启进程               | 🔄 秒级   |

## 下一步

- 了解 [项目结构](/guide/project-structure) 约定
- 配置 [前端指南](/zh/frontend/overview)
- 学习 [路由](/guide/routing) 的三段式定义
- 探索 [中间件](/guide/middleware) 和 [插件](/guide/plugins)
- 查看 [配置](/guide/configuration) 选项
