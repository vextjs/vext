# 配置项

本页详细列出 VextJS 的所有配置字段、类型、默认值及使用说明。

## 配置加载机制

VextJS 使用**多层配置合并**策略，按优先级从低到高：

```
DEFAULT_CONFIG（框架内置默认值）
  ↓ 深度合并
src/config/default.ts（项目默认配置）
  ↓ 深度合并
src/config/{profile}.ts（配置 profile，如 production.ts 或 sg-sit.ts）
  ↓ 深度合并
src/config/local.ts（本地覆盖，可选）
  ↓ provider patch
src/config/bootstrap.ts（启动期远程配置，可选）
  ↓ CLI override
vext start/dev --port --host ...
```

合并后的配置通过 `deepFreeze()` 深冻结，运行时不可修改。

### 配置文件清单

| 文件                        | 用途                       | 是否必须 |
| --------------------------- | -------------------------- | :------: |
| `src/config/default.ts`     | 所有 profile 的基础配置    |    ✅    |
| `src/config/development.ts` | 开发默认 profile 覆盖      |   可选   |
| `src/config/production.ts`  | 生产默认 profile 覆盖      |   可选   |
| `src/config/test.ts`        | 测试默认 profile 覆盖      |   可选   |
| `src/config/sg-sit.ts`      | 自定义 profile 覆盖        |   可选   |
| `src/config/local.ts`       | 本地覆盖（通常不提交 Git） |   可选   |
| `src/config/bootstrap.ts`   | 启动期 provider 注册入口   |   可选   |

### `src/config/bootstrap.ts`

当数据库、密钥或配置中心 patch 需要在配置冻结前完成注入时，可新增：

```typescript
import { defineBootstrapConfig } from "vextjs";

export default defineBootstrapConfig({
  providers: [
    {
      name: "remote-config",
      timeoutMs: 10_000,
      async load({ configProfile, signal, baseConfig }) {
        const response = await fetch(
          `https://config.example.com/${configProfile}.json`,
          { signal },
        );
        const remote = await response.json();
        return {
          database: remote.database,
          logger: {
            lifecycleLevel: baseConfig.logger?.lifecycleLevel ?? "concise",
          },
        };
      },
    },
  ],
});
```

约束：

- provider 必须返回 plain object patch 或 `null`
- patch 只支持 JSON-like 结构
- `timeoutMs` 是硬期限：到期会中止 provider 的 `signal`，迟到 continuation 返回的 patch 会被丢弃，不会再合并
- `required` 未声明时：`production` 默认 fail-fast，`development / test` 默认 warning 后继续
- Cluster 模式下，同一启动周期会复用同一份 provider patch，避免 Master / Worker 看到不同结果

### 配置文件示例

```typescript
// src/config/default.ts
export default {
  port: 3000,
  adapter: "native",
  cors: {
    enabled: true,
    origins: ["http://localhost:3000"],
  },
  logger: {
    level: "debug",
  },
};
```

```typescript
// src/config/production.ts
export default {
  port: 8080,
  cors: {
    origins: ["https://api.example.com"],
  },
  logger: {
    level: "warn",
  },
  response: {
    hideInternalErrors: true,
  },
};
```

---

## 完整配置参考

### `VextConfig`

| 字段              | 类型                                                    | 默认值               | 说明                                                             |
| ----------------- | ------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| `port`            | `number`                                                | `3000`               | HTTP 监听端口                                                    |
| `host`            | `string`                                                | `'0.0.0.0'`          | HTTP 监听地址                                                    |
| `adapter`         | `string \| Function \| VextAdapter`                     | `'native'`           | 底层适配器                                                       |
| `trustProxy`      | `boolean`                                               | `false`              | 是否信任代理                                                     |
| `middlewares`     | `VextMiddlewareConfig[]`                                | `[]`                 | 路由级中间件白名单                                               |
| `cors`            | [`VextCorsConfig`](#vextcorsconfig)                     | 见下方               | CORS 配置                                                        |
| `rateLimit`       | [`VextRateLimitConfig`](#vextratelimitconfig)           | 见下方               | 速率限制配置                                                     |
| `requestId`       | [`VextRequestIdConfig`](#vextrequestidconfig)           | 见下方               | 请求 ID 配置                                                     |
| `logger`          | [`VextLoggerConfig`](#vextloggerconfig)                 | 见下方               | 日志配置                                                         |
| `shutdown`        | [`VextShutdownConfig`](#vextshutdownconfig)             | 见下方               | 优雅关闭配置                                                     |
| `server`          | [`VextServerConfig`](#vextserverconfig)                 | `{}`                 | Node.js HTTP server 配置                                         |
| `response`        | [`VextResponseConfig`](#vextresponseconfig)             | 见下方               | 响应配置                                                         |
| `session`         | `VextSessionConfig`                                     | 见下方               | Session 自动注册、store 与 cookie 配置                           |
| `csrf`            | `VextCsrfConfig`                                        | 见下方               | CSRF 中间件配置                                                  |
| `securityHeaders` | `VextSecurityHeadersConfig`                             | `{ enabled: false }` | 浏览器安全响应头配置                                             |
| `bodyParser`      | [`VextBodyParserConfig`](#vextbodyparserconfig)         | 见下方               | Body 解析配置                                                    |
| `multipart`       | [`VextMultipartConfig`](#vextmultipartconfig)           | `undefined`          | 文件上传配置                                                     |
| `accessLog`       | [`VextAccessLogConfig`](#vextaccesslogconfig)           | 见下方               | 访问日志配置                                                     |
| `openapi`         | [`VextOpenAPIConfig`](#vextopenapiconfig)               | 见下方               | OpenAPI 文档配置                                                 |
| `requestContext`  | [`VextRequestContextConfig`](#vextrequestcontextconfig) | 见下方               | 请求上下文配置                                                   |
| `fetch`           | [`VextFetchConfig`](#vextfetchconfig)                   | 见下方               | 内置 HTTP 客户端与代理配置                                       |
| `database`        | `MonSQLizeDatabaseConfig`                               | `undefined`          | 内置 MonSQLize 插件的类型增强；见[数据库指南](../guide/database) |
| `frontend`        | `boolean \| VextFrontendConfig`                         | `{ enabled: false }` | 内置前端构建与静态服务配置                                       |
| `cluster`         | [`Partial<VextClusterConfig>`](#vextclusterconfig)      | `undefined`          | Cluster 多进程配置                                               |
| `cache`           | [`VextCacheConfig`](#vextcacheconfig)                   | 见下方               | 路由级响应缓存配置                                               |
| `dev`             | [`VextDevConfig`](#vextdevconfig)                       | 见下方               | 仅开发模式使用的工具配置                                         |

`host` 支持 `"0.0.0.0"`、`"::"`、具体 IPv4、具体 IPv6 和主机名。配置为 `"::"` 时，ready 日志会同时展示 IPv4 local URL 与 bracketed IPv6 local/network URL（例如 `http://[::1]:3000`）；具体 IPv6 host 也会以方括号 URL 格式输出。

---

### `adapter`

底层 HTTP 适配器，支持三种传参方式：

```typescript
// 方式一：字符串标识（内置 adapter）
export default {
  adapter: "native", // 'native' | 'hono' | 'fastify' | 'express' | 'koa'
};

// 方式二：工厂函数（传入自定义选项）
import { fastifyAdapter } from "vextjs/adapters/fastify";

export default {
  adapter: fastifyAdapter({ bodyLimit: 5 * 1024 * 1024 }),
};

// 方式三：自定义 adapter 实例（实现 VextAdapter 接口）
export default {
  adapter: myCustomAdapter,
};
```

### `trustProxy`

当设置为 `true` 时：

- `req.ip` 从 `X-Forwarded-For` 请求头读取第一个 IP
- `req.protocol` 从 `X-Forwarded-Proto` 请求头读取

部署在 Nginx / 云负载均衡器之后时需开启此选项。

### `middlewares`

路由级中间件白名单声明。只有在此处声明的中间件才能在路由 `options.middlewares` 中引用。

```typescript
export default {
  middlewares: [
    { name: "auth" },
    { name: "framework-auth" },
    { name: "admin", options: { role: "admin" } },
    { name: "client-cache", options: { maxAge: 60 } },
  ],
};
```

:::tip
全局中间件（如 CORS、body-parser）由框架自动注册，无需在此声明。此处只声明**路由级可选中间件**。
:::

Vext 内置 `auth()` helper 仍然以路由级中间件文件注册，路由再通过 `RouteOptions.auth` 选择是否保护：

```typescript
// src/middlewares/framework-auth.ts
import { auth, defineMiddleware } from "vextjs";

export default defineMiddleware(
  auth({
    async verify(token) {
      return token === "demo-token" ? { userId: "1" } : false;
    },
  }),
);
```

---

## VextCorsConfig

跨域资源共享配置。

| 字段          | 类型       | 默认值                                                         | 说明                        |
| ------------- | ---------- | -------------------------------------------------------------- | --------------------------- |
| `enabled`     | `boolean`  | `true`                                                         | 是否启用 CORS               |
| `origins`     | `string[]` | `['*']`                                                        | 允许的来源域名              |
| `methods`     | `string[]` | `['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']` | 允许的 HTTP 方法            |
| `headers`     | `string[]` | `['Content-Type', 'Authorization', 'X-Request-Id']`            | 允许的请求头                |
| `credentials` | `boolean`  | `false`                                                        | 是否允许携带凭证            |
| `maxAge`      | `number`   | `undefined`                                                    | CORS 预检结果缓存时间（秒） |

```typescript
export default {
  cors: {
    enabled: true,
    origins: ["https://app.example.com", "https://admin.example.com"],
    credentials: true,
    maxAge: 86400,
  },
};
```

:::warning
`origins: ['*']` 与 `credentials: true` 不能同时使用。需要携带凭证时必须指定具体域名。
:::

---

## VextRateLimitConfig

全局速率限制配置，基于 `flex-rate-limit` 实现。

| 字段      | 类型                 | 默认值                | 说明                 |
| --------- | -------------------- | --------------------- | -------------------- |
| `enabled` | `boolean`            | `false`               | 是否启用全局速率限制 |
| `max`     | `number`             | `100`                 | 时间窗口内最大请求数 |
| `window`  | `number`             | `60`                  | 时间窗口（秒）       |
| `message` | `string`             | `'Too Many Requests'` | 超限错误消息         |
| `keyBy`   | `string \| Function` | `'ip'`                | 请求来源标识         |

```typescript
export default {
  rateLimit: {
    enabled: true,
    max: 200,
    window: 120,
    // 按用户 ID 限流（需要 auth 中间件先解析用户）
    keyBy: (req) => req.user?.id ?? req.ip,
  },
};
```

### `keyBy` 选项

| 值                | 说明                     |
| ----------------- | ------------------------ |
| `'ip'`            | 按客户端 IP 限流（默认） |
| `'user'`          | 按 `req.user?.id` 限流   |
| `(req) => string` | 自定义函数，返回唯一标识 |

:::tip
全局限流显式启用后，路由级可通过 `options.override.rateLimit` 覆盖配置，或设为 `false` 禁用限流。
:::

---

## VextRequestIdConfig

请求 ID 追踪配置，用于日志关联和分布式链路追踪。

| 字段             | 类型           | 默认值                | 说明                         |
| ---------------- | -------------- | --------------------- | ---------------------------- |
| `enabled`        | `boolean`      | `true`                | 是否启用请求 ID              |
| `header`         | `string`       | `'x-request-id'`      | 从哪个请求头读取（网关透传） |
| `responseHeader` | `string`       | `'x-request-id'`      | 写入响应头的名称             |
| `generate`       | `() => string` | `crypto.randomUUID()` | 自定义 ID 生成函数           |

### requestId vs traceId

`requestId` 是 vext 内置的请求唯一标识，`traceId` 通常指 APM 链路追踪系统（如 OpenTelemetry / Jaeger）生成的追踪 ID。两者有不同的使用场景：

**模式一：requestId 充当 traceId（简单场景）**

将 `requestId` 的请求头名改为 `x-trace-id`，使其与链路追踪头统一，适合不依赖外部 APM 的系统：

```typescript
import { nanoid } from "nanoid";

export default {
  requestId: {
    header: "x-trace-id", // 从 x-trace-id 读取（网关注入）
    responseHeader: "x-trace-id", // 写回响应头
    generate: () => nanoid(), // 可替换为更短的 ID 生成器
  },
};
```

**模式二：requestId + APM traceId 并存（企业级场景）**

保留 `requestId`（日志关联），同时通过 `config.fetch.propagateHeaders` 透传 APM 的 `traceparent` 头，适合接入 OpenTelemetry / Jaeger 等系统：

```typescript
export default {
  // requestId 保留默认配置（用于日志关联）
  requestId: {
    header: "x-request-id",
    responseHeader: "x-request-id",
  },
  // APM 追踪头通过 propagateHeaders 自动透传到下游服务
  fetch: {
    propagateHeaders: ["traceparent", "tracestate"],
  },
};
```

:::tip 选择建议

- 内部系统、简单追踪 → 模式一（改 header 名为 `x-trace-id`）
- 接入 OpenTelemetry / Jaeger / Datadog → 模式二（保留 requestId，配置 propagateHeaders）
- 详见 [请求上下文 → 与分布式追踪的关系](/guide/request-context#与分布式追踪traceid的关系)
  :::

也可通过插件动态替换生成器：

```typescript
app.setRequestIdGenerator(() => myCustomId());
```

---

## VextFetchConfig

内置 HTTP 客户端与请求代理配置。

| 字段               | 类型                                    | 默认值  | 说明                                      |
| ------------------ | --------------------------------------- | ------- | ----------------------------------------- |
| `timeout`          | `number`                                | `10000` | `app.fetch` 与 `app.fetch.proxy` 默认超时 |
| `retry`            | `number`                                | `0`     | 默认重试次数，表示额外尝试次数            |
| `retryDelay`       | `number \| (attempt: number) => number` | `1000`  | 默认重试间隔，支持函数形式                |
| `propagateHeaders` | `string[]`                              | `[]`    | 普通 `app.fetch` 自动透传的请求头白名单   |
| `proxy`            | `VextFetchProxyTargetConfig[]`          | `[]`    | `app.fetch.proxy.<name>()` 的上游目标列表 |

`timeout` 必须是大于 0 且不超过 `2147483647` 毫秒的有限数字；`retryDelay` 必须是 0 或正数且不超过 `2147483647` 毫秒，函数形式的返回值也会在运行时校验。

```typescript
export default {
  fetch: {
    timeout: 10_000,
    retry: 1,
    retryDelay: 500,
    propagateHeaders: ["traceparent", "x-tenant-id"],
    proxy: [
      {
        name: "userService",
        baseURL: "http://user-service:3001/api",
        forwardHeaders: ["x-tenant-id"],
        headers: { "x-source": "gateway" },
        timeout: 5000,
        retry: 1,
      },
    ],
  },
};
```

### VextFetchProxyTargetConfig

| 字段                        | 类型                                    | 必填 | 说明                                                             |
| --------------------------- | --------------------------------------- | :--: | ---------------------------------------------------------------- |
| `name`                      | `string`                                |  ✅  | 目标名称，对应 `app.fetch.proxy.<name>()`；不能使用保留名 `then` |
| `baseURL`                   | `string`                                |  ✅  | 上游基础 URL                                                     |
| `headers`                   | `Record<string, string>`                |  ❌  | 目标级固定请求头                                                 |
| `forwardHeaders`            | `string[]`                              |  ❌  | 从当前 `req.headers` 透传的请求头白名单                          |
| `defaultInjectHeaders`      | `Record<string, string> \| Function`    |  ❌  | 目标级动态注入 headers                                           |
| `allowAuthorizationForward` | `boolean`                               |  ❌  | 是否允许透传原始 Authorization                                   |
| `timeout`                   | `number`                                |  ❌  | 目标级超时                                                       |
| `retry`                     | `number`                                |  ❌  | 目标级重试次数                                                   |
| `retryDelay`                | `number \| (attempt: number) => number` |  ❌  | 目标级重试间隔                                                   |

代理请求头优先级：`target.headers < forwardHeaders < target.defaultInjectHeaders < options.headers < options.injectHeaders`。`Authorization` 默认不透传，必须同时配置白名单和 `allowAuthorizationForward: true`。

代理 retry 优先级：`options.retry > target.retry > config.fetch.retry > 0`。仅 GET / HEAD / OPTIONS / PUT / DELETE 会在上游 5xx 或网络错误时自动重试；POST / PATCH 默认不重试，超时不重试并返回本地 504。

---

## VextLoggerConfig

结构化日志配置，基于 Vext 内置 logger kernel 实现。

| 字段               | 类型                                                                       | 默认值                     | 说明                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `level`            | `'fatal' \| 'error' \| 'warn' \| 'info' \| 'debug' \| 'trace' \| 'silent'` | `'info'`                   | 日志级别                                                                                                                                                                                                                                                                             |
| `lifecycleLevel`   | `'concise' \| 'verbose'`                                                   | `'concise'`                | 框架生命周期日志详细程度，控制启动、loader、hot reload、cluster 等系统日志输出                                                                                                                                                                                                       |
| `pretty`           | `boolean`                                                                  | 开发环境 `true`            | 是否使用内置 pretty formatter 输出可读格式                                                                                                                                                                                                                                           |
| `prettyColor`      | `'auto' \| 'always' \| 'never'`                                            | `'auto'`                   | pretty 模式 level label 的 ANSI 颜色策略；生产 JSON 永不包含 ANSI                                                                                                                                                                                                                    |
| `prettyIgnore`     | `string`                                                                   | `'pid,hostname,requestId'` | pretty 模式下忽略的字段（逗号分隔）。默认隐藏 `requestId` 避免 mixin 注入的字段被展开为多行噪音，生产环境 JSON 输出不受影响                                                                                                                                                          |
| `prettySingleLine` | `boolean`                                                                  | `true`                     | pretty 模式下是否将额外字段以 JSON 内联形式压缩到消息同一行。设为 `false` 使用多行展开格式。仅影响 pretty 模式，生产环境 JSON 输出不受影响                                                                                                                                           |
| `redactKeys`       | `string[]`                                                                 | `[]`                       | 按任意层级 exact key 脱敏结构化日志字段。顶层 `level` 为日志协议字段，不会被改写                                                                                                                                                                                                     |
| `redactPaths`      | `string[]`                                                                 | `[]`                       | 按 dot notation exact path 脱敏结构化日志字段，支持数组数字下标；不支持 wildcard、bracket notation、remove 或 function censor                                                                                                                                                        |
| `redactValue`      | `string`                                                                   | `'[Redacted]'`             | 脱敏替换值                                                                                                                                                                                                                                                                           |
| `mixin`            | `() => Record<string, unknown>`                                            | `undefined`                | 自定义日志 mixin 函数，返回值会与框架内置字段合并注入每条日志。`requestId` 是框架保护字段，不可被用户 mixin 覆盖；`trace_id` / `span_id` 等其他字段按用户 mixin 优先。典型用途：注入 OpenTelemetry `trace_id` / `span_id`，实现日志与链路追踪关联。未配置时不会执行用户 mixin 调用。 |

```typescript
export default {
  logger: {
    level: "debug",
    pretty: true, // 开发环境美化输出
    // prettySingleLine: true,                   // 默认值，额外字段压缩到消息同一行
    // prettySingleLine: false,                  // 恢复多行展开格式
    // prettyIgnore: 'pid,hostname,requestId',   // 默认值，隐藏 requestId
    // prettyIgnore: 'pid,hostname',             // 如需在 pretty 模式下显示 requestId
    // redactKeys: ['password', 'token'],
    // redactPaths: ['user.email', 'headers.authorization'],
    // redactValue: '[Redacted]',
  },
};
```

**日志级别优先级**（从高到低）：

```
fatal > error > warn > info > debug > trace
```

设置某个级别后，只输出该级别及更高级别的日志。设为 `'silent'` 完全静默。

默认 logger 还支持运行时 `app.logger.getLevel()` / `app.logger.setLevel(level)` 调整后续日志阈值；配置对象本身仍会在启动后冻结，不应通过修改 `app.config.logger.level` 动态变更。

---

## VextShutdownConfig

优雅关闭配置。

| 字段           | 类型                                       | 默认值      | 说明                                   |
| -------------- | ------------------------------------------ | ----------- | -------------------------------------- |
| `timeout`      | `number`                                   | `10`        | 关闭超时（秒）                         |
| `onFatalError` | `(error, origin) => void \| Promise<void>` | `undefined` | 捕获未处理异常后、进程退出前调用的回调 |

收到 `SIGTERM` / `SIGINT` 信号后，框架会：

1. 停止接受新请求
2. 等待飞行中请求完成（不超过 `timeout` 秒）
3. 按 LIFO 顺序执行所有 `onClose` 钩子
4. 退出进程

```typescript
export default {
  shutdown: {
    timeout: 30, // 容器环境建议 30 秒
  },
};
```

---

## VextServerConfig

入站 Node.js HTTP server 层配置。适用于内置 Native / Hono / Fastify / Express / Koa adapter，也适用于 `vext dev` 创建的开发 server。未设置字段保持当前 Node.js 默认值。

| 字段                          | 类型     | 默认值         | 说明                                            |
| ----------------------------- | -------- | -------------- | ----------------------------------------------- |
| `requestTimeout`              | `number` | Node.js 默认值 | 接收完整请求的最大时间（毫秒），`0` 表示禁用    |
| `headersTimeout`              | `number` | Node.js 默认值 | 接收完整 HTTP headers 的最大时间（毫秒）        |
| `keepAliveTimeout`            | `number` | Node.js 默认值 | 响应完成后 keep-alive 空闲等待时间（毫秒）      |
| `socketTimeout`               | `number` | Node.js 默认值 | socket inactivity timeout（毫秒），`0` 表示禁用 |
| `maxHeaderSize`               | `number` | Node.js 默认值 | 最大请求头大小（bytes）                         |
| `maxRequestsPerSocket`        | `number` | Node.js 默认值 | 单 socket 最大请求数，`0` 表示不限              |
| `connectionsCheckingInterval` | `number` | Node.js 默认值 | 未完成请求超时检查间隔（毫秒）                  |

```typescript
export default {
  server: {
    requestTimeout: 120_000,
    headersTimeout: 60_000,
    keepAliveTimeout: 5_000,
    socketTimeout: 0,
    maxHeaderSize: 16 * 1024,
    maxRequestsPerSocket: 0,
    connectionsCheckingInterval: 30_000,
  },
};
```

`config.server` 只控制入站服务请求。出站 `app.fetch` / `app.fetch.proxy` 的超时由 `config.fetch.timeout`、代理目标 `timeout` 或调用时 options 控制。

---

## VextResponseConfig

响应格式配置。

| 字段                 | 类型                  | 默认值 | 说明                                                 |
| -------------------- | --------------------- | ------ | ---------------------------------------------------- |
| `hideInternalErrors` | `boolean`             | `true` | 是否隐藏 500 错误详情                                |
| `wrap`               | `boolean`             | `true` | 是否启用出口包装                                     |
| `logErrors`          | `VextLogErrorsConfig` | 见下方 | unknown/5xx 默认记录；4xx 需显式设置 `http4xx: true` |

### 出口包装

启用 `wrap: true` 时，`res.json(data)` 自动包装：

```json
{
  "code": 0,
  "data": { "id": 1, "name": "Alice" },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

错误响应格式：

```json
{
  "code": 10001,
  "message": "用户不存在",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

禁用 `wrap: false` 时，`res.json(data)` 直接发送原始 `data`。

### 隐藏内部错误

`hideInternalErrors` 只影响“未知异常”这条 500 错误路径，例如路由、service、middleware 中直接 `throw new Error("...")` 的场景。它不会改变 `app.throw(...)` 或 `VextValidationError` 这类结构化错误的状态码与响应格式。

`hideInternalErrors: true` 时，500 错误不暴露 stack trace：

```json
// hideInternalErrors: true
{ "code": 500, "message": "Internal Server Error" }

// hideInternalErrors: false（仅开发环境使用）
{ "code": 500, "message": "Internal Server Error", "stack": "..." }
```

---

## VextBodyParserConfig

请求体解析配置。

| 字段          | 类型               | 默认值  | 说明               |
| ------------- | ------------------ | ------- | ------------------ |
| `enabled`     | `boolean`          | `true`  | 是否启用 body 解析 |
| `maxBodySize` | `string \| number` | `'1mb'` | 最大请求体大小     |

```typescript
export default {
  bodyParser: {
    maxBodySize: "5mb", // 支持 'kb', 'mb', 'gb' 单位
  },
};
```

禁用后 `req.body` 始终为 `undefined`，适用于纯 GET 服务或自定义 body 解析场景。

`maxBodySize` 支持的格式：

| 格式   | 示例                         | 说明               |
| ------ | ---------------------------- | ------------------ |
| 字符串 | `'1mb'`, `'512kb'`, `'10mb'` | 支持 kb/mb/gb 单位 |
| 数字   | `1048576`                    | 直接指定字节数     |

---

## VextMultipartConfig

Multipart / 文件上传全局配置。

| 字段               | 类型       | 默认值      | 说明                                                                                   |
| ------------------ | ---------- | ----------- | -------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`  | `false`     | 是否启用内置 multipart 解析。设为 `true` 后 body-parser 自动填充 `req.files`，无需插件 |
| `maxFileSize`      | `number`   | `10485760`  | 单个文件最大大小（字节，默认 10MB）                                                    |
| `maxFiles`         | `number`   | `10`        | 单次请求最多文件数                                                                     |
| `allowedMimeTypes` | `string[]` | `undefined` | 允许的 MIME 类型白名单（不设置则不限制）                                               |

```typescript
export default {
  multipart: {
    enabled: true, // 开启内置解析
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "application/pdf",
    ],
  },
};
```

:::tip Fastify 联动
`multipart.maxFileSize` 只限制单个文件大小；总请求体读取上限由 `bodyParser.maxBodySize` 控制。使用 Fastify 时，如额外传入 `fastifyAdapter({ bodyLimit })`，实际读取边界会取 adapter `bodyLimit` 与 body-parser 总体上限中的较小值。
:::

### 存储与清理

内置 multipart 解析是纯内存路径。Vext 读取请求体后，将每个上传文件暴露为 `req.files[*].buffer`；它**不会**创建框架管理的临时文件或临时目录。因此没有可配置的 `tmpDir`、磁盘保留 TTL 或定时清理任务。请求和业务代码不再持有 Buffer 引用后，由正常的 Node.js GC 回收；Vext 不会删除应用自行保存的文件。

请有意识地设置 `bodyParser.maxBodySize`、`multipart.maxFileSize`、`multipart.maxFiles` 与 `multipart.allowedMimeTypes`。大文件、流式对象存储或任何需要持久化文件生命周期的场景，应在该路由关闭/避免内置解析，并使用由插件自身负责存储和清理策略的流式上传方案。

---

## VextAccessLogConfig

访问日志配置，基于洋葱模型 after-middleware 实现。

| 字段               | 类型       | 默认值   | 说明                                       |
| ------------------ | ---------- | -------- | ------------------------------------------ |
| `enabled`          | `boolean`  | `true`   | 是否启用访问日志                           |
| `level`            | `string`   | `'info'` | 基础日志级别，仅支持 `'info'` 或 `'debug'` |
| `skipPaths`        | `string[]` | `[]`     | 精确匹配跳过的路径列表                     |
| `skipPathPrefixes` | `string[]` | `[]`     | 前缀匹配跳过的路径列表                     |
| `slowThreshold`    | `number`   | `0`      | 慢请求阈值，`0` 表示不启用                 |
| `warnOn4xx`        | `boolean`  | `false`  | 是否将 4xx 响应提升为 `warn`               |
| `logResponseSize`  | `boolean`  | `false`  | 是否在消息末尾追加响应体大小               |

```typescript
export default {
  accessLog: {
    enabled: true,
    level: "info",
    skipPaths: ["/health", "/readiness", "/metrics"],
    skipPathPrefixes: ["/internal"],
    slowThreshold: 1000,
    warnOn4xx: false,
    logResponseSize: false,
  },
};
```

访问日志输出示例：

```
POST /api/users 201 12ms | 192.168.1.1
```

消息字段包括 HTTP 方法、路径、状态码、响应时间（ms）和客户端 IP；`requestId` 由 logger 的 AsyncLocalStorage mixin 自动注入到 JSON 记录字段。

---

## VextOpenAPIConfig

OpenAPI 文档自动生成配置。

| 字段                            | 类型                                      | 默认值               | 说明                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `boolean`                                 | dev 启用，prod 关闭  | 是否启用                                                                                                                                                                |
| `title`                         | `string`                                  | `undefined`          | 文档标题                                                                                                                                                                |
| `version`                       | `string`                                  | `undefined`          | 文档版本号                                                                                                                                                              |
| `description`                   | `string`                                  | `undefined`          | 文档描述                                                                                                                                                                |
| `docs.path`                     | `string`                                  | `'/docs'`            | Vext Docs 文档路径                                                                                                                                                      |
| `docs.assetsPath`               | `string`                                  | `'/_vext/docs'`      | Vext Docs 内置资产与数据端点前缀，包含 app.js / style.css / favicon.svg 和 source-aware JSON 数据                                                                       |
| `docs.assetsPublicPath`         | `string`                                  | 同 `docs.assetsPath` | 浏览器可见的 docs 资产/数据前缀，用于反向代理剥离公开前缀的场景；HTML 中的 app.js / style.css / favicon.svg 使用该公开前缀                                              |
| `docs.renderer`                 | `'vext'`                                  | `'vext'`             | 内置 Vext Docs renderer；不再支持第三方 renderer object，外部工具请直接消费 `/openapi.json`                                                                             |
| `docs.ui.theme`                 | `'system' \| 'light' \| 'dark'`           | `'system'`           | 内置 Vext Docs 颜色主题；访问者也可在 UI 中本地覆盖                                                                                                                     |
| `docs.ui.density`               | `'comfortable' \| 'compact'`              | `'comfortable'`      | 内置 Vext Docs 间距密度；访问者也可在 UI 中本地覆盖                                                                                                                     |
| `docs.code.enabled`             | `boolean \| 'auto'`                       | `'auto'`             | 是否从 services / utils / models / components / plugins / middlewares 及显式开启的可选静态来源生成代码文档                                                              |
| `docs.code.scan`                | `'lazy' \| 'background'`                  | `'lazy'`             | Code Docs 扫描生命周期；`lazy` 每次请求 docs data 时扫描，`background` 在文档注册时预热一次进程内快照并复用                                                             |
| `docs.code.components`          | `boolean \| object`                       | `true`               | Components JSDoc 文档源；默认扫描 `src/frontend/components/**`，仅发现条目时在 UI 中展示                                                                                |
| `docs.code.plugins`             | `boolean \| object`                       | `true`               | Plugins JSDoc/runtime 文档源；默认扫描 `src/plugins/**`，仅发现条目时在 UI 中展示                                                                                       |
| `docs.code.middlewares`         | `boolean \| object`                       | `true`               | Middlewares JSDoc/runtime 文档源；默认扫描 `src/middlewares/**`，仅发现条目时在 UI 中展示                                                                               |
| `docs.code.locales`             | `boolean \| object`                       | `false`              | 可选 Locales 文档源；开启后扫描 `src/locales/**` 和 `src/frontend/locales/**`；配置 `dir` 时只扫描该自定义 locale 根目录                                                |
| `docs.code.config`              | `boolean \| object`                       | `false`              | 可选 Config 文档源；开启后扫描 `src/config/**`                                                                                                                          |
| `docs.code.styles`              | `boolean \| object`                       | `false`              | 可选 Styles 文档源；开启后扫描 `src/frontend/styles/**`                                                                                                                 |
| `docs.code.preload`             | `boolean \| object`                       | `false`              | 可选 Preload 文档源；开启后扫描规范的 `src/preload/**`；项目根 `preload/**` 仅为带 warning 的兼容回退                                                                   |
| `docs.access.mode`              | `'off' \| 'visibility-only' \| 'enforce'` | `'off'`              | 文档 UI 数据、菜单和 operation 权限模式                                                                                                                                 |
| `docs.access.openapiJson`       | `'filtered' \| 'public'`                  | `'filtered'`         | canonical `/openapi.json` 是否跟随 docs 权限过滤，或保持公开                                                                                                            |
| `docs.sources`                  | `Array`                                   | `[]`                 | 可选的多 API / 多版本文档面配置。每个 source 都需要 `match`；非 `All` code docs 需要显式 `code.include` / `code.exclude`                                                |
| `docs.tryItOut.hookScript`      | `string`                                  | `undefined`          | Try it out 请求/响应 hook 的可选浏览器脚本路径                                                                                                                          |
| `docs.tryItOut.hookGlobal`      | `string`                                  | `'VextDocsHooks'`    | Try it out `beforeRequest` / `afterResponse` hook 的浏览器全局变量名                                                                                                    |
| `docs.tryItOut.defaultServer`   | `string`                                  | `undefined`          | Try it out 初始 server，支持 `"first"`、`"same-origin"`、`"custom"` 或精确 OpenAPI server URL                                                                           |
| `docs.tryItOut.sameOrigin`      | `boolean \| 'auto'`                       | `'auto'`             | 是否显示 Same origin server 选项；`auto` 仅在没有配置 OpenAPI servers 时显示                                                                                            |
| `docs.tryItOut.customServer`    | `boolean`                                 | `true`               | 是否允许访问者在浏览器中临时填写 Try it out base URL                                                                                                                    |
| `docs.tryItOut.customServerUrl` | `string`                                  | `undefined`          | Custom server 输入框的可选默认值                                                                                                                                        |
| `docsPath`                      | `string`                                  | `'/docs'`            | 兼容字段；新项目推荐使用 `docs.path`                                                                                                                                    |
| `jsonPath`                      | `string`                                  | `'/openapi.json'`    | OpenAPI JSON 路径                                                                                                                                                       |
| `jsonPublicPath`                | `string`                                  | 同 `jsonPath`        | 外部工具和链接使用的公开 OpenAPI 规范地址。内置 source-aware docs 数据使用 `docs.assetsPublicPath` / `docs.assetsPath`，[详见指南](/guide/openapi#反向代理路径前缀场景) |
| `contact`                       | `object`                                  | `undefined`          | 联系信息                                                                                                                                                                |
| `license`                       | `object`                                  | `undefined`          | 许可证信息                                                                                                                                                              |
| `servers`                       | `array`                                   | `undefined`          | 服务器地址列表                                                                                                                                                          |
| `tags`                          | `array`                                   | `undefined`          | 全局标签定义                                                                                                                                                            |
| `tagGroups`                     | `Array<{ name: string; tags: string[] }>` | `undefined`          | 显式输出 OpenAPI `x-tagGroups` vendor extension；内置 Vext Docs 默认导航不依赖它                                                                                        |
| `guardSecurityMap`              | `Record<string, string>`                  | `undefined`          | Guard → Security Scheme 映射                                                                                                                                            |
| `securitySchemes`               | `object`                                  | `undefined`          | 安全方案定义                                                                                                                                                            |
| `scalar`                        | `object`                                  | `undefined`          | 已废弃兼容字段；仅显式配置时触发 warning，不影响内置 Vext Docs 页面                                                                                                     |
| ~~`tryItOutEnabled`~~           | `boolean`                                 | `true`               | ~~已废弃~~ 保留兼容，不影响 Vext Docs 默认实现                                                                                                                          |
| ~~`docExpansion`~~              | `'none' \| 'list' \| 'full'`              | `'list'`             | ~~已废弃~~ 保留兼容，不影响 Vext Docs 默认实现                                                                                                                          |

`docs.access.cacheKey` 不是当前版本支持的配置字段。Vext 会拒绝该字段，避免让用户误以为文档访问链路已经提供 response cache 或 access result cache。

固定本地或部署 API 目标时，`servers[].url` 建议直接写带端口的完整 base URL，例如 `http://127.0.0.1:3000`。只有环境名、区域、租户或 API 版本这类真正会变化的 URL 片段，才建议使用 `servers[].variables`。`docs.tryItOut.defaultServer` 用于控制 Try it out 初始选中的 server，`docs.tryItOut.customServer` 用于允许用户在浏览器里临时输入其他目标地址，不需要修改项目配置。

`tagGroups` 只有在显式配置时才会透传为 `x-tagGroups`。默认 Vext Docs renderer 使用 OpenAPI path segment 构建递归导航；`tagGroups` 主要用于下游 OpenAPI 工具明确消费该 vendor extension 的场景。

默认 Vext Docs renderer 会从 code docs 数据生成 Services / Utils / Models / Components / Plugins / Middlewares。Model 条目可展示静态 schema fields、enums、options、indexes、methods、hooks 和 usage；Plugins 与 Middlewares 可展示可推断的 lifecycle/bootstrap、app extension、middleware 类型、route usage 和源码链接；Locales / Config / Styles / Preload 属于可选高级静态来源，可在 `docs.code` 下显式开启，但不进入默认顶层文档入口；本地 loopback 文档页还可为 code docs 条目展示 `Open source` 链接，不需要新增单独配置项。

```typescript
export default {
  openapi: {
    enabled: true,
    title: "My API",
    version: "1.0.0",
    description: "我的 API 文档",
    docs: {
      path: "/docs",
      renderer: "vext",
      code: {
        enabled: "auto",
      },
    },
    servers: [
      { url: "http://localhost:3000", description: "开发环境" },
      { url: "https://api.example.com", description: "生产环境" },
    ],
    tags: [
      { name: "用户", description: "用户管理接口" },
      { name: "订单", description: "订单管理接口" },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    guardSecurityMap: {
      auth: "bearerAuth",
    },
  },
};
```

### `guardSecurityMap` 历史回退

用于把只声明 middleware 的历史路由映射到 OpenAPI Security Scheme。新的 Auth 示例应把最终 `RouteOptions.auth` 内联到路由，或保存为同文件 `const`，让运行时保护、静态投影和 OpenAPI security 共用同一个真相源。有限静态语法不支持 route-options helper 调用：

```typescript
// 仅用于历史兼容：没有 RouteOptions.auth 的 middleware 名称推断
app.get("/profile", { middlewares: ["auth"] }, handler);
// ↑ OpenAPI 自动推断该路由需要 bearerAuth 认证
```

### `securitySchemes`

支持的安全方案类型：

| `type`          | 说明           | 必填字段                                      |
| --------------- | -------------- | --------------------------------------------- |
| `http`          | HTTP 认证      | `scheme`（`bearer` / `basic`）                |
| `apiKey`        | API Key        | `name`, `in`（`header` / `query` / `cookie`） |
| `oauth2`        | OAuth 2.0      | —                                             |
| `openIdConnect` | OpenID Connect | —                                             |

对于 `in: "cookie"` 的 `apiKey` 安全方案和 `validate.cookie` 参数，内置文档可以展示字段，但浏览器 Try it out 不能直接设置受限的 `Cookie` header。如需手动 cookie 值，请使用同源浏览器 cookie 或 HTTP 客户端。

---

## VextRequestContextConfig

AsyncLocalStorage 请求上下文配置。

| 字段      | 类型      | 默认值 | 说明               |
| --------- | --------- | ------ | ------------------ |
| `enabled` | `boolean` | `true` | 是否启用请求上下文 |

```typescript
export default {
  requestContext: {
    enabled: false, // 仅在不依赖下列请求级能力时关闭
  },
};
```

:::warning
禁用后以下功能失效：

- Logger 自动注入 `requestId`
- `app.throw()` 自动解析请求级 `locale`
- `app.fetch()` 自动传播 `requestId`
  :::

---

## VextFrontendConfig

内置前端构建与静态服务配置。

| 字段                                                   | 类型                                 | 默认值                                                       | 说明                                                                                    |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `enabled`                                              | `boolean`                            | `false`                                                      | 是否启用前端集成                                                                        |
| `framework`                                            | `string`                             | `'react'`                                                    | 前端框架标签                                                                            |
| `adapter`                                              | `VextFrontendAdapter`                | 无                                                           | 兼容前端 adapter 的高级集成边界；不会启用 plugin ecosystem                              |
| `root`                                                 | `string`                             | `'src/frontend'`                                             | 前端源码目录                                                                            |
| `pages`                                                | `object`                             | 内置 page 约定                                               | page、document 与 error-page 的发现配置                                                 |
| `pages.dir`                                            | `string`                             | `'pages'`                                                    | 页面目录，相对 `root` 解析                                                              |
| `pages.extensions`                                     | `string[]`                           | `['.tsx', '.jsx', '.ts', '.js']`                             | 页面、layout、错误页和 locale 模块扫描扩展名                                            |
| `pages.document`                                       | `string`                             | `'pages/_document.html'`                                     | document 模板路径，相对 `root` 解析                                                     |
| `pages.errorDir`                                       | `string`                             | `'pages/error'`                                              | 错误页面目录，相对 `root` 解析                                                          |
| `componentsDir`                                        | `string`                             | `'components'`                                               | 公共组件目录，相对 `root` 解析                                                          |
| `styles`                                               | `object`                             | 内置 style 约定                                              | 全局 CSS 入口与可选 Vext JSCSS 配置                                                     |
| `styles.entry`                                         | `string`                             | `'styles/index.css'`                                         | 全局 CSS 入口，相对 `root` 解析                                                         |
| `styles.jscss`                                         | `boolean \| object`                  | `{ enabled: true }`                                          | Vext JSCSS 构建期 CSS 抽取与动态 CSS variables                                          |
| `styles.jscss.enabled`                                 | `boolean`                            | `true`                                                       | 是否启用 Vext JSCSS 抽取                                                                |
| `styles.jscss.files`                                   | `string[]`                           | `['**/*.style.ts', '**/*.style.js', '**/*.css.ts']`          | JSCSS 源文件扫描 glob                                                                   |
| `styles.jscss.runtimeAdapter`                          | `'css-variables' \| 'none' \| false` | `'css-variables'`                                            | 通过 CSS custom properties 输出动态变量，或回退为静态 fallback 值                       |
| `styles.jscss.dynamicVars`                             | `boolean`                            | `true`                                                       | 是否输出 JSCSS custom property 声明与 `var(...)` 引用                                   |
| `styles.jscss.recipes`                                 | `boolean`                            | `true`                                                       | recipe variants 是否生成额外 class 与 CSS rules                                         |
| `assetsDir`                                            | `string`                             | `'assets'`                                                   | 前端打包资产目录，相对 `root` 解析                                                      |
| `media`                                                | `object`                             | 本地默认值                                                   | 直接编译本地图片和字体；生成文件仍进入普通 deploy/SRI closure                           |
| `media.maxBytes`                                       | `number`                             | `20971520`                                                   | 完整本地图片和字体 closure 的最大字节数                                                 |
| `media.images`                                         | `object`                             | 本地图片默认值                                               | 响应式本地图片 variants                                                                 |
| `media.images.widths`                                  | `number[]`                           | `[320, 640, 960, 1280, 1600]`                                | 本地图片的正整数响应式宽度候选                                                          |
| `media.images.formats`                                 | `('original' \| 'webp' \| 'avif')[]` | `['original', 'webp', 'avif']`                               | 本地输出 codec；`original` 保留源 codec                                                 |
| `media.images.quality`                                 | `number`                             | `75`                                                         | 1 到 100 的整数图片质量                                                                 |
| `media.images.maxInputPixels`                          | `number`                             | `40000000`                                                   | 解码后本地图片像素的构建期上限                                                          |
| `media.images.maxVariants`                             | `number`                             | `24`                                                         | 单个本地图片 variants 的构建期上限                                                      |
| `media.fonts`                                          | `object`                             | 本地字体默认值                                               | 本地 WOFF2 subset 限制                                                                  |
| `media.fonts.maxBytes`                                 | `number`                             | `5242880`                                                    | 单个生成的本地 WOFF2 subset 最大字节数                                                  |
| `entry`                                                | `string`                             | `'.vext/generated/frontend/browser-entry.tsx'`               | 自动生成的浏览器入口；通常不需要手写                                                    |
| `indexHtml`                                            | `string`                             | `'src/frontend/pages/_document.html'`                        | HTML document 模板                                                                      |
| `outDir`                                               | `string`                             | 开发期 `.vext/client`，生产期 `dist/client`                  | 前端输出目录                                                                            |
| `publicDir`                                            | `string`                             | `'public'`                                                   | 会复制到前端输出目录的静态资源                                                          |
| `publicPath`                                           | `string`                             | `'/'`                                                        | 公开资源路径前缀                                                                        |
| `alias`                                                | `object`                             | 内置 `@frontend/@pages/@components/@styles/@assets`          | 前端安全 alias，不默认指向整个 `src`                                                    |
| `spaFallback`                                          | `boolean \| object`                  | `{ scopes: [] }`                                             | 只对显式声明的 client-router 子应用范围服务 fallback                                    |
| `spaFallback.enabled`                                  | `boolean`                            | `true`                                                       | 是否允许 scoped fallback 仲裁；无 scope 时不会接管路径                                  |
| `spaFallback.exclude`                                  | `string[]`                           | `['/api/**', '/openapi.json', '/docs/**', '/_vext/docs/**']` | fallback 全局排除路径                                                                   |
| `spaFallback.scopes`                                   | `object[]`                           | `[]`                                                         | 明确声明的 client-router 子应用范围                                                     |
| `spaFallback.scopes[]`                                 | `object[]`                           | `[]`                                                         | 明确声明的 client-router 子应用范围                                                     |
| `spaFallback.scopes[].basePath`                        | `string`                             | 必填                                                         | client shell 负责的 URL 前缀                                                            |
| `spaFallback.scopes[].page`                            | `string`                             | 必填                                                         | client shell 对应的 page id                                                             |
| `spaFallback.scopes[].ssr`                             | `boolean`                            | `false`                                                      | client shell 首次是否 SSR 渲染                                                          |
| `spaFallback.scopes[].exclude`                         | `string[]`                           | `[]`                                                         | 该 scope 内 fallback 不得接管的路径                                                     |
| `spaFallback.scopes[].status`                          | `number`                             | `200`                                                        | fallback 命中的 HTTP status                                                             |
| `apiClient`                                            | `boolean \| object`                  | `true`                                                       | 生成 client contract 产物                                                               |
| `apiClient.enabled`                                    | `boolean`                            | `true`                                                       | 是否输出 `client-contract.json` 与 `api.generated.ts`                                   |
| `seo`                                                  | `VextFrontendSeoConfig`              | 未配置                                                       | 框架级 SEO 元数据与可选 sitemap/robots；省略时保持旧输出                                |
| `seo.enabled`                                          | `boolean`                            | 配置对象存在时为 `true`                                      | 启用结构化 SEO 与已配置产物                                                             |
| `seo.publicOrigin`                                     | `string`                             | 无                                                           | 与每页 pathname 组合的绝对 HTTP(S) 部署 origin                                          |
| `seo.origins`                                          | `Record<string, string>`             | `{}`                                                         | 运行时多域名选择使用的有限命名 origin                                                   |
| `seo.titleTemplate`                                    | `string`                             | 无                                                           | 必须包含 `%s` 占位符的标题模板                                                          |
| `seo.defaults`                                         | `VextSeoMetadata`                    | `{}`                                                         | 应用级 title、description、robots、canonical、Open Graph、Twitter、alternate 与 JSON-LD |
| `seo.sitemap`                                          | `false \| VextFrontendSitemapConfig` | `false`                                                      | 启用构建期或运行时 sitemap                                                              |
| `seo.sitemap.mode`                                     | `'build' \| 'runtime'`               | `'build'`                                                    | 构建时写入产物或由 runtime endpoint 提供                                                |
| `seo.sitemap.path`                                     | `string`                             | `'/sitemap.xml'`                                             | 根绝对 sitemap pathname                                                                 |
| `seo.sitemap.includeStatic`                            | `boolean`                            | `true`                                                       | 纳入成功静态页面产物，页面 SEO 显式排除时除外                                           |
| `seo.sitemap.entries`                                  | `VextSitemapEntriesProvider`         | 无                                                           | 从 `{ mode, origin, originKey, signal }` 补充并校验条目                                 |
| `seo.sitemap.maxUrlsPerFile`                           | `number`                             | `50000`                                                      | 超出后生成 sitemap index 与编号分片                                                     |
| `seo.sitemap.maxUrls`                                  | `number`                             | `100000`                                                     | 整组 sitemap 可接受的最大 URL 数；超限时生成失败并保持关闭                              |
| `seo.sitemap.maxBytes`                                 | `number`                             | `52428800`                                                   | 所有 sitemap 文档渲染后的 UTF-8 总字节上限                                              |
| `seo.sitemap.timeoutMs`                                | `number`                             | `5000`                                                       | 运行时 provider、读取与渲染期限；超时会中止 provider 信号                               |
| `seo.robots`                                           | `false \| VextFrontendRobotsConfig`  | `false`                                                      | 启用构建期或运行时 robots                                                               |
| `seo.robots.mode`                                      | `'build' \| 'runtime'`               | `'build'`                                                    | 构建时写入产物或由 runtime endpoint 提供                                                |
| `seo.robots.path`                                      | `'/robots.txt'`                      | `'/robots.txt'`                                              | 固定 robots pathname                                                                    |
| `seo.robots.groups`                                    | `VextRobotsGroup[]`                  | `[{ userAgent: '*', allow: '/' }]`                           | user-agent 的 allow/disallow/crawl-delay 分组                                           |
| `render`                                               | `object`                             | `{ ssr: true, streaming: 'buffered' }`                       | SSR、layout、fallback 与 streaming 控制                                                 |
| `render.ssr`                                           | `boolean`                            | `true`                                                       | 是否启用 SSR 渲染                                                                       |
| `render.fallback`                                      | `'client' \| 'error'`                | `'client'`                                                   | SSR 失败时回退客户端壳还是错误响应                                                      |
| `render.streaming`                                     | `'buffered' \| 'auto'`               | `'buffered'`                                                 | 保留 `renderToString` 兼容路径，或流式发送 shell 与 Suspense boundaries                 |
| `render.timeoutMs`                                     | `number`                             | `3000`                                                       | 中止未完成的 streaming SSR；buffered 同步渲染返回后再检查                               |
| `render.layout`                                        | `boolean`                            | `true`                                                       | 是否启用嵌套 layout chain                                                               |
| `errorPages`                                           | `object`                             | 内置 error-page 约定                                         | 默认错误页与按状态码映射的错误页                                                        |
| `errorPages.default`                                   | `string`                             | `'error/default'`                                            | 默认错误页 page id                                                                      |
| `errorPages.status`                                    | `object`                             | `{ 404: 'error/404', 500: 'error/500' }`                     | 状态码到错误页 page id 的映射                                                           |
| `i18n`                                                 | `object`                             | `{ enabled: false }`                                         | 前端页面文案层、SSR messages 与 `{vext.lang}`                                           |
| `i18n.enabled`                                         | `boolean`                            | `false`                                                      | 是否启用前端 locale 发现与 message artifacts                                            |
| `i18n.source`                                          | `string`                             | `'locales'`                                                  | 前端文案目录，相对 `root` 解析                                                          |
| `i18n.defaultLocale`                                   | `'inherit' \| string`                | `'inherit'`                                                  | 默认 locale；`inherit` 表示跟随请求级 locale                                            |
| `i18n.detect`                                          | `string[]`                           | `['accept-language']`                                        | SSR locale 探测来源                                                                     |
| `i18n.inject`                                          | `'used' \| 'all'`                    | `'used'`                                                     | 注入已使用 messages 还是全部 messages                                                   |
| `i18n.clientSwitch`                                    | `'reload'`                           | `'reload'`                                                   | 客户端切换 locale 的首期策略                                                            |
| `i18n.clientLoad`                                      | `'current' \| 'all'`                 | `'current'`                                                  | 浏览器端只加载当前 SSR locale，或加载全部 locale                                        |
| `i18n.htmlLang`                                        | `boolean`                            | `true`                                                       | 是否写入 `{vext.lang}` / `<html lang>`                                                  |
| `i18n.vary`                                            | `boolean`                            | `true`                                                       | 是否按 locale 影响响应 vary/cache                                                       |
| `dev`                                                  | `object`                             | 内置 dev 默认值                                              | 浏览器开发事件、refresh 与 overlay 控制                                                 |
| `dev.hot`                                              | `boolean`                            | `true`                                                       | 开发期前端热更新通道                                                                    |
| `dev.fastRefresh`                                      | `boolean`                            | `true`                                                       | React Fast Refresh                                                                      |
| `dev.transport`                                        | `'sse'`                              | `'sse'`                                                      | Vext dev event bus 传输方式                                                             |
| `dev.overlay`                                          | `boolean`                            | `true`                                                       | 是否显示前端 dev browser rebuild 错误与 render refresh 提示 UI                          |
| `dev.debounceMs`                                       | `number`                             | `50`                                                         | 文件变更事件防抖时间                                                                    |
| `dev.renderRefresh`                                    | `'prompt' \| 'auto' \| 'off'`        | `'prompt'`                                                   | route/service 等 render 相关后端变更后的浏览器动作                                      |
| `build`                                                | `object`                             | 内置生产/开发编译默认值                                      | 浏览器构建默认值；SSR renderer 保持独立的 `build.server` Node 配置                      |
| `build.target`                                         | `string \| string[]`                 | `'es2022'`                                                   | 浏览器构建目标                                                                          |
| `build.minify`                                         | `boolean`                            | 生产期 `true`                                                | 压缩前端产物                                                                            |
| `build.sourcemap`                                      | `boolean`                            | 开发期 `true`                                                | 生成前端 source map                                                                     |
| `build.client`                                         | `object`                             | 继承共享 build 默认值                                        | 浏览器 bundle 输出、hash 命名、splitting 与 external                                    |
| `build.client.assetsDir`                               | `string`                             | `"assets"`                                                   | `frontend.outDir` 下的浏览器 bundle 资源子目录                                          |
| `build.client.target`                                  | `string \| string[]`                 | 继承 `build.target`（`'es2022'`）                            | 浏览器专用 esbuild target                                                               |
| `build.client.minify`                                  | `boolean`                            | 继承生产期 `true`                                            | 浏览器专用压缩覆盖                                                                      |
| `build.client.sourcemap`                               | `boolean`                            | 继承开发期 `true`                                            | 浏览器专用 source-map 覆盖                                                              |
| `build.client.splitting`                               | `boolean`                            | `true`                                                       | 浏览器代码拆分                                                                          |
| `build.client.entryNames`                              | `string`                             | `'[name]-[hash]'`                                            | `assetsDir` 下浏览器 entry 文件名模式                                                   |
| `build.client.chunkNames`                              | `string`                             | `'[name]-[hash]'`                                            | `assetsDir` 下浏览器 chunk 文件名模式                                                   |
| `build.client.assetNames`                              | `string`                             | `'[name]-[hash]'`                                            | `assetsDir` 下 import 型浏览器资源文件名模式                                            |
| `build.client.external`                                | `string[]`                           | `[]`                                                         | 浏览器 bundle 外置模块列表                                                              |
| `build.client.externalRuntime`                         | `object`                             | `{}`                                                         | 外置模块 import map URL 映射；React external 缺映射会构建失败                           |
| `build.client.externalRuntime.<specifier>.url`         | `string`                             | 必填                                                         | 某个命名 browser external 的绝对 URL                                                    |
| `build.client.externalRuntime.<specifier>.integrity`   | `string`                             | 无                                                           | 该 external runtime 可选的 SRI 值                                                       |
| `build.client.externalRuntime.<specifier>.crossOrigin` | `'anonymous' \| 'use-credentials'`   | 无                                                           | 该 external runtime 可选的 `crossorigin` 值                                             |
| `build.server`                                         | `object`                             | `server/renderer.cjs`                                        | SSR renderer bundle 输出                                                                |
| `build.server.outFile`                                 | `string`                             | `server/renderer.cjs`                                        | `frontend.outDir` 下的 SSR renderer 文件                                                |
| `build.server.target`                                  | `string \| string[]`                 | `'node20'`                                                   | SSR-renderer esbuild target                                                             |
| `build.server.minify`                                  | `boolean`                            | `false`                                                      | SSR-renderer 压缩；独立于浏览器压缩                                                     |
| `build.server.sourcemap`                               | `boolean`                            | 继承开发期 `true`                                            | SSR-renderer source-map 设置                                                            |
| `build.server.external`                                | `string[]`                           | `[]`                                                         | 保留在 renderer bundle 外部的 Node 模块                                                 |
| `build.vendorChunks`                                   | `boolean \| object`                  | `{ enabled: true }`                                          | Vext-managed vendor entry 与共享 chunk 管理                                             |
| `build.vendorChunks.enabled`                           | `boolean`                            | `true`                                                       | 是否输出 Vext-managed vendor entry                                                      |
| `build.vendorChunks.packages`                          | `string[]`                           | React runtime packages                                       | 会放入共享 vendor entry 的 package                                                      |
| `build.vendorChunks.entryName`                         | `string`                             | `'vext-vendor'`                                              | 共享 vendor entry 的逻辑名称                                                            |
| `build.budgets`                                        | `object`                             | 全部 `0`                                                     | 前端资源大小预算；`0` 表示不限制                                                        |
| `build.budgets.maxAssetBytes`                          | `number`                             | `0`                                                          | 单个资源 raw byte 上限                                                                  |
| `build.budgets.maxInitialJsBytes`                      | `number`                             | `0`                                                          | 最大完整页面首载 JS closure 的 raw-byte 上限                                            |
| `build.budgets.maxInitialJsGzipBytes`                  | `number`                             | `0`                                                          | 最大完整页面首载 JS 闭包 gzip 预算                                                      |
| `build.budgets.maxInitialJsBrotliBytes`                | `number`                             | `0`                                                          | 最大完整页面首载 JS 闭包 brotli 预算                                                    |
| `build.budgets.maxRouteInitialJsBrotliBytes`           | `number`                             | `0`                                                          | 单 route 首屏 JS brotli 预算                                                            |
| `build.budgets.maxAppOwnedInitialJsBrotliBytes`        | `number`                             | `0`                                                          | 排除 external runtime 后的应用自有首屏 JS brotli 预算                                   |
| `build.budgets.maxTotalBytes`                          | `number`                             | `0`                                                          | 全部可发布前端资源的总字节上限                                                          |
| `build.budgets.warnOnly`                               | `boolean`                            | `false`                                                      | 仅报告预算违规而不让构建失败                                                            |
| `build.assets`                                         | `object`                             | `{ inlineLimit: 0 }`                                         | import 型资源输出控制                                                                   |
| `build.assets.inlineLimit`                             | `number`                             | `0`                                                          | import 型资源内联阈值；默认输出 hash 文件                                               |
| `build.css`                                            | `object`                             | `{ modules: true }`                                          | CSS module 编译控制                                                                     |
| `build.css.modules`                                    | `boolean`                            | `true`                                                       | 是否支持 CSS Modules 约定                                                               |
| `build.diagnostics`                                    | `object`                             | 全部诊断开启                                                 | 构建报告与浏览器泄漏诊断控制                                                            |
| `build.diagnostics.metafile`                           | `boolean`                            | `true`                                                       | 是否保留内部 esbuild metafile 诊断，供 size report / leak scan 使用                     |
| `build.diagnostics.sizeReport`                         | `boolean`                            | `true`                                                       | 是否生成体积报告                                                                        |
| `build.diagnostics.performanceReport`                  | `boolean`                            | `true`                                                       | 是否在构建报告中保留路由级 initial JS 指标                                              |
| `build.diagnostics.leakScan`                           | `boolean`                            | `true`                                                       | 阻断浏览器 bundle 误引入服务端模块                                                      |
| `deploy`                                               | `object`                             | 内置本地交付默认值                                           | 浏览器静态资源 URL、SRI、crossorigin 与可选的增量上传配置                               |
| `deploy.assetBaseUrl`                                  | `string`                             | 无                                                           | CDN 静态资源绝对前缀                                                                    |
| `deploy.crossOrigin`                                   | `'anonymous' \| 'use-credentials'`   | 无                                                           | 注入 script/link 时的 crossorigin 值                                                    |
| `deploy.integrity`                                     | `boolean`                            | `false`                                                      | 是否把构建期 SRI 注入 JS/CSS 标签                                                       |
| `deploy.upload`                                        | `boolean \| object`                  | `{ enabled: false, exclude: ["**/*.map"] }`                  | 静态资源上传配置；`vext deploy assets` 按 sha256 增量上传                               |
| `deploy.upload.enabled`                                | `boolean`                            | `false`                                                      | 为 `vext build --upload-assets` 和 `vext deploy assets` 开启上传                        |
| `deploy.upload.adapter`                                | `string \| object`                   | `'filesystem'`                                               | 内置 `filesystem`/`mock` adapter 名称或显式 custom adapter                              |
| `deploy.upload.targetDir`                              | `string`                             | 开启时为 `.vext/deploy/frontend-assets`                      | 内置 filesystem staging adapter 的本地目标目录                                          |
| `deploy.upload.publicBaseUrl`                          | `string`                             | 无                                                           | upload plan 报告的显式公开 URL；filesystem 会回退到 `deploy.assetBaseUrl`               |
| `deploy.upload.prefix`                                 | `string`                             | `''`                                                         | 加到每个 upload key 前的前缀                                                            |
| `deploy.upload.stateFile`                              | `string`                             | `.vext/deploy/frontend-assets-state.json`                    | 增量上传状态；应放在 `frontend.outDir` 外                                               |
| `deploy.upload.dryRun`                                 | `boolean`                            | `false`                                                      | 只规划上传、不写入资源                                                                  |
| `deploy.upload.concurrency`                            | `number`                             | `4`                                                          | 最大并行上传数                                                                          |
| `deploy.upload.include`                                | `string[]`                           | `['**/*']`                                                   | 允许上传的 deploy-manifest 路径                                                         |
| `deploy.upload.exclude`                                | `string[]`                           | `['**/*.map']`                                               | 排除上传的 deploy-manifest 路径                                                         |

```typescript
export default {
  frontend: {
    enabled: true,
    framework: "react",
    publicDir: "public",
    publicPath: "/",
    spaFallback: {
      scopes: [
        {
          basePath: "/admin/app",
          page: "admin/app/shell",
          exclude: ["/admin/api/**"],
        },
      ],
    },
  },
};
```

### 适配器扩展契约

`frontend.adapter` 是显式、进程内的类型化扩展点，不是自动插件发现机制。`VextFrontendAdapter` 提供 `name`、`framework` 以及可选的 `resolveBuildOptions(config)`；该 resolver 接收已解析的前端配置，并可同步或异步返回编译器选项。它不会引入另一套 bundler，也不会启用 RSC、Server Functions 或 PPR。

`frontend.seo` 的完整用法见 [SEO、Sitemap 与 Robots](/zh/frontend/seo-sitemap)。`publicOrigin` 是部署 origin，不是固定页面 URL；当前 pathname 或页面显式 canonical 提供每页部分。runtime 产物只接受精确声明的 Host，provider 也不会隐式收到 `app` 或 `app.db`。

如果交付目标不是内置的本地 staging adapter，请向 `deploy.upload.adapter` 传入 `VextFrontendDeployUploadAdapter` 对象。它提供 `name` 和 `upload(input)`；其 `VextFrontendDeployUploadAdapterInput` 包含 `asset`、`sourcePath`、`uploadKey` 与 `dryRun`，而 `VextFrontendDeployUploadAdapterResult` 必须返回 `uploaded`，并可返回 `url` 与 `etag`。

```ts
export default {
  frontend: {
    deploy: {
      upload: {
        enabled: true,
        adapter: {
          name: "company-cdn",
          async upload({ asset, sourcePath, uploadKey, dryRun }) {
            if (dryRun) return { uploaded: false };
            // 用所选云厂商 SDK 将 sourcePath 上传到 uploadKey。
            return {
              uploaded: true,
              url: `https://cdn.example.com/${uploadKey}`,
            };
          },
        },
      },
    },
  },
};
```

`filesystem` 与 `mock` 是仅有的内置 upload adapter 名称。云厂商适配器必须显式写在应用配置中，因此运行时不会暗中安装或发现云服务/bundler 插件。

默认 `spaFallback.scopes` 为空，因此未知 HTML 路径不会被自动吞成 SPA 页面。需要混合 SSR + client-router 子应用时，在 `scopes[]` 中声明具体 `basePath`。`spaFallback: true` 仅作为兼容 shorthand，不推荐在企业级混合项目中使用。

---

## VextClusterConfig

Cluster 多进程配置。完整接口定义见 `src/types/app.ts` `VextClusterConfig`。

### 基础字段

| 字段               | 类型                           | 默认值        | 说明                                                                                                             |
| ------------------ | ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`                      | `false`       | 是否启用 Cluster 模式（也可通过 `VEXT_CLUSTER=1` 开启）                                                          |
| `workers`          | `'auto' \| 'auto-1' \| number` | `'auto'`      | Worker 数量（`'auto'` = 检测到的可用 CPU 数；`'auto-1'` = 可用 CPU 数 - 1；number = 固定数量，clamp 到 [1, 64]） |
| `autoRestart`      | `boolean`                      | `true`        | Worker 崩溃后自动重启                                                                                            |
| `maxRestarts`      | `number`                       | `5`           | 快速重启检测窗口内允许的最大重启次数                                                                             |
| `restartWindow`    | `number`                       | `60000`       | 快速重启检测窗口（毫秒）                                                                                         |
| `restartBaseDelay` | `number`                       | `1000`        | 重启间隔退避基数（毫秒）                                                                                         |
| `restartMaxDelay`  | `number`                       | `30000`       | 重启间隔上限（毫秒）                                                                                             |
| `memoryThreshold`  | `number`                       | `1073741824`  | Worker heap 阈值（bytes），超出后触发诊断并退出 Worker                                                           |
| `pidFile`          | `string`                       | `'.vext.pid'` | PID 文件路径（供 `vext stop` / `vext reload` 定位进程）                                                          |
| `titlePrefix`      | `string`                       | `'vext'`      | Worker 进程标题前缀                                                                                              |
| `sticky`           | `'none' \| 'ip'`               | `'none'`      | 粘性会话模式（`'ip'` 基于客户端 IP 分配固定 Worker，适用于 WebSocket / SSE）                                     |

### `healthCheck` — 心跳检测

| 字段                   | 类型      | 默认值  | 说明                                        |
| ---------------------- | --------- | ------- | ------------------------------------------- |
| `healthCheck.enabled`  | `boolean` | `true`  | 是否启用 Worker 心跳检测                    |
| `healthCheck.interval` | `number`  | `15000` | Master 发送心跳探测的间隔（毫秒）           |
| `healthCheck.timeout`  | `number`  | `30000` | Worker 心跳超时阈值（毫秒），超时则强制重启 |

### `reload` — 零停机滚动重启

`cluster.reload` 只配置 `vext reload` / `SIGHUP` 触发滚动重启时的时间参数。省略 `cluster.reload` 不会禁用滚动重启，框架会使用默认值。

| 字段                     | 类型     | 默认值  | 说明                                   |
| ------------------------ | -------- | ------- | -------------------------------------- |
| `reload.workerDelay`     | `number` | `2000`  | 替换下一个 Worker 前的等待时间（毫秒） |
| `reload.readyTimeout`    | `number` | `30000` | 新 Worker 就绪超时（毫秒）             |
| `reload.shutdownTimeout` | `number` | `10000` | 旧 Worker 关闭超时（毫秒）             |

```typescript
export default {
  cluster: {
    enabled: true,
    workers: "auto", // 使用 availableParallelism / cgroup v1 / os.cpus 检测可用 CPU
    autoRestart: true,
    maxRestarts: 5,
    healthCheck: {
      enabled: true,
      interval: 15000,
      timeout: 30000,
    },
    reload: {
      workerDelay: 2000,
      readyTimeout: 30000,
      shutdownTimeout: 10000,
    },
  },
};
```

也可通过环境变量启用（无需修改配置文件）：

```bash
VEXT_CLUSTER=1 vext start
```

---

## VextCacheConfig

路由级响应缓存全局配置。

| 字段              | 类型      | 默认值  | 说明                                                                                      |
| ----------------- | --------- | ------- | ----------------------------------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`  | 是否启用路由级响应缓存。设为 `false` 后不安装缓存中间件，也不会打开 Redis/MultiLevel 连接 |
| `defaultTtl`      | `number`  | `60000` | 路由未指定 TTL 时的默认值，单位毫秒                                                       |
| `maxEntries`      | `number`  | `1000`  | Memory 模式快捷配置：最大缓存条目数                                                       |
| `maxMemory`       | `number`  | —       | Memory 模式快捷配置：最大内存占用 bytes                                                   |
| `cleanupInterval` | `number`  | `0`     | Memory 模式快捷配置：周期清理间隔，`0` 表示只做惰性清理                                   |
| `cacheHub`        | `object`  | Memory  | 底层响应缓存运行时配置                                                                    |

```typescript
export default {
  cache: {
    enabled: true,
    defaultTtl: 120_000,
    maxEntries: 2000,
  },
};
```

Memory 完整配置：

```typescript
export default {
  cache: {
    defaultTtl: 60_000,
    cacheHub: {
      mode: "memory",
      maxEntries: 1000,
      maxMemory: 50 * 1024 * 1024,
      cleanupInterval: 30_000,
      enableStats: true,
    },
  },
};
```

Redis 配置：

```typescript
export default {
  cache: {
    defaultTtl: 2_000,
    cacheHub: {
      mode: "redis",
      url: "redis://localhost:6379",
      deleteCommand: "unlink",
      lease: {
        waitForOwner: 1_000,
        onTimeout: "fetch",
      },
      distributed: {
        channel: "vext:response-cache",
      },
    },
  },
};
```

MultiLevel 配置：

```typescript
export default {
  cache: {
    defaultTtl: 60_000,
    cacheHub: {
      mode: "multi-level",
      memory: { maxEntries: 1000 },
      redis: { url: "redis://localhost:6379" },
      writePolicy: "both",
      backfillOnRemoteHit: true,
      remoteTimeout: 50,
      lease: true,
    },
  },
};
```

`cacheHub` 只接受 `response-cache-kit/cache-hub` 配置，不接受自定义 Store。路由级响应缓存通过 `RouteOptions.cache` 配置。公开配置单位使用毫秒；响应头中的 `Cache-Control: max-age` 会按 HTTP 标准输出秒。详见 [响应缓存指南](/guide/cache)。

---

## VextDevConfig

仅开发模式使用的配置。`vext dev` 会读取这些字段，生产模式会忽略。

| 字段           | 类型                                            | 默认值 | 说明                 |
| -------------- | ----------------------------------------------- | ------ | -------------------- |
| `errorOverlay` | [`VextDevOverlayConfig`](#vextdevoverlayconfig) | 见下方 | 浏览器错误覆盖层配置 |

### VextDevOverlayConfig

| 字段        | 类型                | 默认值   | 说明                     |
| ----------- | ------------------- | -------- | ------------------------ |
| `enabled`   | `boolean`           | `true`   | 是否启用浏览器错误覆盖层 |
| `theme`     | `'dark' \| 'light'` | `'dark'` | 错误覆盖层主题           |
| `maxFrames` | `number`            | `25`     | 覆盖层最多显示的堆栈帧数 |

```typescript
export default {
  dev: {
    errorOverlay: {
      enabled: true,
      theme: "light",
      maxFrames: 10,
    },
  },
};
```

---

## DEFAULT_CONFIG

框架内置默认配置的完整值：

```typescript
import { DEFAULT_CONFIG } from 'vextjs';

// DEFAULT_CONFIG 的完整内容：
{
  port: 3000,
  host: '0.0.0.0',
  adapter: 'native',
  trustProxy: false,
  middlewares: [],
  cors: {
    enabled: true,
    origins: ['*'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: false,
  },
  rateLimit: {
    enabled: false,
    max: 100,
    window: 60,
    message: 'Too Many Requests',
    keyBy: 'ip',
  },
  requestId: {
    enabled: true,
    header: 'x-request-id',
    responseHeader: 'x-request-id',
  },
  logger: {
    level: 'info',
  },
  shutdown: {
    timeout: 10,
  },
  server: {},
  response: {
    hideInternalErrors: true,
    wrap: true,
  },
  session: {
    enabled: false,
    name: 'vext.sid',
    ttl: 86400,
    rolling: false,
    autoCommit: true,
    idLength: 32,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: 'auto',
    },
  },
  csrf: {
    enabled: false,
    mode: 'auto',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    headerNames: ['x-csrf-token', 'x-xsrf-token'],
    bodyField: '_csrf',
    cookie: {
      name: 'vext.csrf',
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      secure: 'auto',
    },
    fetchMetadata: true,
    origin: false,
  },
  securityHeaders: {
    enabled: false,
    preset: 'basic',
  },
  bodyParser: {
    enabled: true,
    maxBodySize: '1mb',
  },
  accessLog: {
    enabled: true,
    level: 'info',
    skipPaths: [],
  },
  openapi: {
    enabled: false,
  },
  requestContext: {
    enabled: true,
  },
  frontend: {
    enabled: false,
  },
}
```

---

## VextUserConfig

用户配置的输入类型，所有字段均为可选。由 `loadConfig()` 合并默认值后生成完整的 `VextConfig`。

```typescript
import type { VextUserConfig } from "vextjs";

const config: VextUserConfig = {
  port: 8080,
  logger: { level: "debug" },
};

export default config;
```

---

### `VextSessionConfig`

`config.session.enabled: true` 会在生产、开发、测试和软重载链路中自动注册 Session。显式 `session()` 中间件仅用于作用域化或手动注册场景。

| 字段         | 类型                       | 默认值       | 说明                                          |
| ------------ | -------------------------- | ------------ | --------------------------------------------- |
| `enabled`    | `boolean`                  | `false`      | 是否自动全局注册 Session                      |
| `name`       | `string`                   | `'vext.sid'` | session cookie 名称                           |
| `ttl`        | `number`                   | `86400`      | store TTL，单位秒                             |
| `rolling`    | `boolean`                  | `false`      | 每次请求刷新 store TTL 与 cookie              |
| `autoCommit` | `boolean`                  | `true`       | 响应发送前自动持久化 dirty session            |
| `idLength`   | `number`                   | `32`         | CSPRNG session id 的随机字节长度，范围 16-128 |
| `cookie`     | `VextSessionCookieOptions` | 见下方       | session cookie 属性                           |
| `store`      | `VextSessionStore`         | memory store | 面向共享部署的自定义异步 store                |

`VextSessionCookieOptions` 基于 `CookieSerializeOptions`，并额外支持 `secure: boolean | "auto"`。Cookie 选项包含 `domain`、`path`、`expires`、`maxAge`、`httpOnly`、`secure`、`sameSite`、`priority`、`partitioned` 与 `encode`。

`VextSessionStore` 必须实现 `get(id)`、`set(id, data, ttlSeconds)` 和 `delete(id)`。可选方法包括 `touch(id, ttlSeconds)`、`clearExpired()` 与 `close()`。配置 Store 和已启用的手动 Session 运行时会在应用关闭时调用 `close()`。

生产 cache-backed session 推荐使用 `vextjs` 根入口导出的 `createCacheSessionStore(cacheLike, options?)`。它接收具备 `get`、`set`、`del` 的结构型 `VextCacheLike`，把 session TTL 秒转换为 cache 毫秒，默认写入 JSON string，且只有传入 `options.close` 时才暴露 `close()`。`config.cache.cacheHub` 仍然只是路由响应缓存配置，不会注入 Session Store。

`RouteOptions.session` 接受 `false`、`true` 或 `{ enabled?, rolling?, autoCommit? }`，可为单个路由关闭 Session，也可在全局运行时关闭时单独启用。

---

### `VextCsrfConfig`

`config.csrf` 用于配置内置 CSRF 中间件。`enabled: true` 会在 body parsing 与插件全局中间件之后自动全局注册 CSRF；也可以保持禁用，并手动注册 `csrf()` 保护指定路径。

| 字段            | 类型                                     | 默认值                                              | 说明                                                 |
| --------------- | ---------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `enabled`       | `boolean`                                | 应用配置默认 `false`；手动 `csrf()` 默认 `true`     | 是否启用全局自动注册                                 |
| `mode`          | `"auto" \| "session" \| "signed-cookie"` | `"auto"`                                            | token 存储模式                                       |
| `secret`        | `string`                                 | `undefined`                                         | `signed-cookie` 模式必填                             |
| `methods`       | `string[]`                               | `["POST", "PUT", "PATCH", "DELETE"]`                | 需要 CSRF 校验的 unsafe methods                      |
| `headerNames`   | `string[]`                               | `["x-csrf-token", "x-xsrf-token"]`                  | 接收 token 的请求头名称                              |
| `bodyField`     | `string \| false`                        | `"_csrf"`                                           | 接收 token 的 body 字段；`false` 表示禁用 body token |
| `cookie`        | `CookieSerializeOptions`                 | `{ name: "vext.csrf", sameSite: "lax", path: "/" }` | 签名 double-submit cookie 属性                       |
| `fetchMetadata` | `boolean`                                | `true`                                              | 拒绝 `Sec-Fetch-Site: cross-site` unsafe 请求        |
| `origin`        | `false \| { trustedOrigins?: string[] }` | `false`                                             | 可选 Origin/Referer 同源校验                         |

路由可通过 route options `{ csrf: false }` 跳过 CSRF。

---

### `VextSecurityHeadersConfig`

`config.securityHeaders` 用于启用 Vext 内置浏览器安全响应头。默认关闭。`preset: "basic"` 是多数应用的低破坏主路径；`strict` 与 `custom` 都是显式 opt-in。

| 字段                        | 类型                                                                                                               | 默认值             | 说明                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `enabled`                   | `boolean`                                                                                                          | `false`            | 自动注册内置 Security Headers 中间件                                        |
| `preset`                    | `"basic" \| "strict" \| "custom"`                                                                                  | `"basic"`          | 响应头预设                                                                  |
| `contentTypeOptions`        | `"nosniff" \| false`                                                                                               | 由 preset 决定     | 控制 `X-Content-Type-Options`                                               |
| `referrerPolicy`            | `string \| false`                                                                                                  | 由 preset 决定     | 控制 `Referrer-Policy`                                                      |
| `frameOptions`              | `"DENY" \| "SAMEORIGIN" \| false`                                                                                  | 由 preset 决定     | 控制 `X-Frame-Options`                                                      |
| `hsts`                      | `false \| { enabled?: boolean; maxAge?: number; includeSubDomains?: boolean; preload?: boolean; force?: boolean }` | basic 中为 `false` | 控制 `Strict-Transport-Security`；默认仅 HTTPS 请求发送，除非 `force: true` |
| `contentSecurityPolicy`     | `false \| string \| object`                                                                                        | `false`            | 控制 CSP 或 CSP report-only                                                 |
| `permissionsPolicy`         | `false \| string \| Record<string, boolean \| string[]>`                                                           | basic 中为 `false` | 控制 `Permissions-Policy`                                                   |
| `crossOriginOpenerPolicy`   | `false \| "same-origin" \| "same-origin-allow-popups" \| "unsafe-none"`                                            | basic 中为 `false` | 控制 COOP                                                                   |
| `crossOriginEmbedderPolicy` | `false \| "require-corp" \| "credentialless" \| "unsafe-none"`                                                     | `false`            | 控制 COEP；`strict` 也不会默认开启                                          |
| `crossOriginResourcePolicy` | `false \| "same-origin" \| "same-site" \| "cross-origin"`                                                          | basic 中为 `false` | 控制 CORP                                                                   |
| `headers`                   | `Record<string, string>`                                                                                           | `{}`               | 最后合并的自定义响应头                                                      |
| `skipPaths`                 | `string[]`                                                                                                         | `[]`               | 精确路径或尾部 `*` 前缀跳过                                                 |

```typescript
export default {
  securityHeaders: {
    enabled: true,
    preset: "basic",
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        "default-src": ["'self'"],
        "upgrade-insecure-requests": true,
      },
    },
  },
};
```

`basic` 发送 `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin` 与 `X-Frame-Options: SAMEORIGIN`。`strict` 额外开启 HTTPS-only HSTS、最小 `Permissions-Policy`、COOP 和 CORP，但 CSP 与 COEP 仍需显式配置。`custom` 只发送你配置的字段。路由可通过 `{ securityHeaders: false }` 跳过。

---

## loadConfig

配置加载函数，接收配置目录路径并执行完整配置链合并。

```typescript
import { loadConfig } from "vextjs";
import { join } from "node:path";

const config = await loadConfig(join(process.cwd(), "src/config"), {
  rootDir: process.cwd(),
  command: "start",
  isBuilt: false,
});
// config: VextConfig（已合并、已冻结）
```

通常不需要手动调用，`bootstrap()` 内部会自动调用 `loadConfig()`。合并顺序为：`DEFAULT_CONFIG < default < config profile < local < bootstrap provider patch < CLI override`。

---

## 环境变量覆盖

部分配置支持通过环境变量覆盖：

| 环境变量       | 对应配置          | 说明                                       |
| -------------- | ----------------- | ------------------------------------------ |
| `VEXT_PORT`    | `port`            | CLI/运行时传递的严格整值端口覆盖           |
| `VEXT_HOST`    | `host`            | CLI/运行时传递的监听地址覆盖               |
| `VEXT_CONFIG`  | —                 | 选择要加载的配置 profile                   |
| `NODE_ENV`     | —                 | 运行时模式；`vext start` 固定为 production |
| `VEXT_CLUSTER` | `cluster.enabled` | 设为 `1` 启用集群                          |

```bash
VEXT_PORT=8080 VEXT_CONFIG=sg-sit vext start
```

---

## 类型声明扩展

插件可通过 `declare module` 为 `VextConfig` 添加自定义字段：

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextConfig {
    redis?: {
      host: string;
      port: number;
      password?: string;
    };
  }
}
```

之后在配置文件中使用将获得完整的类型提示：

```typescript
// src/config/default.ts
export default {
  redis: {
    host: "localhost",
    port: 6379,
  },
};
```
