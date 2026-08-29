# 介绍

## VextJS 是什么？

VextJS 是一个面向 API、服务端渲染 React 页面或两者并存场景的 AI-first Node.js 全栈框架。`src/routes/**` 始终拥有 URL，服务、校验、安全、缓存、OpenAPI 与类型客户端共用同一套请求契约。你可以从默认全栈脚手架起步，也可以保持 API-only，而不必引入第二套路由模型。

AI-first 描述的是面向 AI 辅助开发的工程界面：明确的约定、脚手架、类型契约、OpenAPI 与机器可读文档为编程助手提供有依据的输入。它不代表 VextJS 内置 LLM、Agent、RAG 系统或推理 runtime。

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/hello",
    {
      docs: { summary: "问候接口" },
    },
    async (_req, res) => {
      res.json({ message: "Hello VextJS!" });
    },
  );
});
```

同一个路由文件也可以调用 `res.render()`，让 SSR 页面复用相同服务与请求生命周期。完整路径见[前端快速开始](/zh/frontend/getting-started)，有意排除的能力见[前端边界与路线图](/zh/frontend/boundaries-and-roadmap)。

## 核心特性

### 🔌 Adapter 架构

VextJS 的底层 HTTP 处理层是可替换的。内置 5 种 Adapter：

| Adapter            | 底层框架                           | 特点                             | 适用场景             |
| ------------------ | ---------------------------------- | -------------------------------- | -------------------- |
| **Native**（默认） | `http.createServer` + `route-core` | 零第三方 HTTP 框架依赖，默认路径 | 新项目、希望减少依赖 |
| **Hono**           | Hono + Vext 的 `node:http` 桥接    | Node.js 上的 Web Standards API   | Node.js 应用         |
| **Fastify**        | Fastify                            | 插件生态、序列化能力             | 需要 Fastify 能力    |
| **Express**        | Express                            | 成熟的中间件生态                 | 迁移项目             |
| **Koa**            | Koa                                | 轻量中间件模型                   | 团队已有 Koa 经验    |

使用 VextJS `req` / `res` 编写的路由 handler 通常无需随 Adapter 改写；底层框架专属的中间件或插件仍需单独核对集成边界。框架选择本身只需修改一个配置字段：

```typescript
// src/config/default.ts
import { nativeAdapter } from "vextjs/adapters/native";
// import { honoAdapter } from 'vextjs/adapters/hono';
// import { fastifyAdapter } from 'vextjs/adapters/fastify';

export default {
  adapter: nativeAdapter(),
  port: 3000,
};
```

### ⚡ 性能与取舍

Vext 提供可复现的 Native/Fastify 主对照和五个 adapter 的辅助矩阵。当前结果显示 Raw Native 与 Raw Fastify 会随场景和 handler 形态互有领先；Vext 的差距还包含路由、请求/响应对象和生命周期成本，因此不能压缩成一个框架总排名。

请在[性能基准](/benchmark)查看唯一的当前数据、测试口径、adapter 选择建议和复现命令。生产选型仍应加入你的认证、日志、中间件、I/O 与部署环境重新压测。

### 🛡️ 声明式参数校验

集成 [schema-dsl](https://github.com/devcodex-labs/schema-dsl)，在路由 `options` 中声明校验规则，自动验证 + 自动生成 OpenAPI 文档：

```typescript
app.post(
  "/users",
  {
    validate: {
      body: {
        name: "string!", // 必填字符串
        email: "email!", // 必填邮箱格式
        age: "number?", // 可选数字
        role: "admin|user", // 枚举
      },
    },
    docs: { summary: "创建用户" },
  },
  async (req, res) => {
    // 通过 req.valid() 读取已校验、类型化的数据；req.body 保留原始输入。
    const body = req.valid("body");
    const user = await app.services.user.create(body);
    res.json(user);
  },
);
```

### 🧩 插件系统

通过 `definePlugin()` 扩展框架能力，支持完整生命周期钩子：

```typescript
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "user-cache-plugin",

  async setup(app) {
    // 在 app 上注册能力
    const cache = new Map();
    app.extend("userCache", {
      get: (key: string) => cache.get(key),
      set: (key: string, value: unknown, ttl?: number) => {
        cache.set(key, value);
        if (ttl) setTimeout(() => cache.delete(key), ttl);
      },
    });
  },

  async onReady(app) {
    app.logger.info("Cache plugin ready");
  },

  async onClose(app) {
    // 清理资源
  },
});
```

### 🧱 模块系统与装饰器策略

VextJS 使用 ESM + 约定式目录作为模块系统：`src/config/`、`src/plugins/`、`src/middlewares/`、`src/services/`、`src/routes/` 会在启动时自动扫描，并按照配置 → 插件 → 中间件定义 → 服务 → 路由的顺序加载。

VextJS 当前不提供 `@Controller` / `@Get` / `@Inject` / `@Service` 等装饰器 API，也不依赖 `reflect-metadata`。路由使用 `defineRoutes()`，插件使用 `definePlugin()`，服务通过 `new ServiceClass(app)` 构造函数注入 `app`。如果你从 NestJS 等装饰器框架迁移，请把控制器装饰器迁移为 `src/routes/*.ts` 文件路由，把构造器依赖注入迁移为 `app.services` 延迟访问。

### 🔥 开发体验

- **`vext dev`** — 文件监听 + 智能热重载（Soft Reload Tier 1/2 + Cold Restart Tier 3）
- **`vext build`** — esbuild 极速构建，TypeScript 零配置
- **`vext create`** — 交互式脚手架，支持 5 种 Adapter 选择
- **OpenAPI / Vext Docs** — 基于路由 `docs` + `validate` 自动生成，访问 `/docs` 查看 API 与标准 JSDoc 文档，外部工具可直接消费 `/openapi.json`

### 🏢 企业级特性

- **Cluster 多进程** — `ClusterMaster` + Worker 心跳 + Rolling Restart + 优雅关闭
- **国际化 (i18n)** — 语言包自动加载，错误消息多语言
- **内置限流** — 基于 `flex-rate-limit`，支持 IP / 用户维度
- **请求追踪** — AsyncLocalStorage 贯穿 route → service，自动注入 requestId
- **MonSQLize 插件** — 内置连接与模型生命周期，仅在存在 `config.database` 时加载

## 设计理念

### 1. 约定优于配置

遵循固定的项目结构约定（`src/routes/`、`src/services/`、`src/config/`），框架自动扫描加载，无需手动注册。

### 2. 分层架构

```
路由层 (routes)    ← 参数提取 + 响应返回
   ↓
服务层 (services)  ← 业务逻辑（纯数据，不感知 HTTP）
   ↓
数据层 (models)    ← 数据访问（通过插件提供）
```

- 路由 handler 只负责参数提取和响应返回
- 业务逻辑集中在 service 层，通过 `app.services.xxx` 访问
- service 不感知 HTTP 协议，便于复用和测试

### 3. 底层可替换

通过 Adapter 架构，框架核心与底层 HTTP 处理完全解耦。所有业务代码（路由、中间件、服务、插件）操作的是 VextJS 封装的 `req` / `res` 对象，而非底层框架的原生对象。

## 与其他框架对比

| 特性         | VextJS               | Fastify        | Express     | NestJS             |
| ------------ | -------------------- | -------------- | ----------- | ------------------ |
| 底层可替换   | ✅ 5 种 Adapter      | ❌             | ❌          | ✅ Express/Fastify |
| 约定式路由   | ✅ 文件级自动扫描    | ❌ 手动注册    | ❌ 手动注册 | ✅ 装饰器          |
| 参数校验     | ✅ 声明式 schema-dsl | ✅ JSON Schema | 需中间件    | ✅ class-validator |
| OpenAPI 生成 | ✅ 自动              | 需插件         | 需中间件    | ✅ 装饰器          |
| 热重载       | ✅ Soft + Cold       | ❌             | ❌          | ❌                 |
| Cluster 管理 | ✅ 内置              | ❌             | ❌          | ❌                 |
| 体量         | 轻量                 | 轻量           | 轻量        | 重量               |

## 环境要求

- **Node.js** >= 20.19.0
- **TypeScript** 5.x（推荐，也支持纯 JavaScript）

## 下一步

准备好了吗？前往[快速开始](/zh/guide/quick-start)创建你的第一个 VextJS 项目。
