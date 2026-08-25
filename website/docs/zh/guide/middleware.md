# 中间件

VextJS 的中间件采用 **洋葱模型**（Onion Model），支持请求前处理和响应后处理。框架提供 `defineMiddleware` 和 `defineMiddlewareFactory` 两种定义方式，通过约定式目录自动扫描加载。

## 洋葱模型

中间件通过 `await next()` 调用下一个中间件。`next()` 返回后可以执行后置逻辑，形成洋葱状的执行流程：

```
请求 →  [中间件A-前] → [中间件B-前] → [Handler] → [中间件B-后] → [中间件A-后]  → 响应
```

```typescript
import type { VextMiddleware } from "vextjs";

const timing: VextMiddleware = async (req, res, next) => {
  // ── 前置逻辑（请求进入时执行）──
  const start = Date.now();

  await next(); // 执行下一个中间件 / 最终 handler

  // ── 后置逻辑（响应返回时执行）──
  const ms = Date.now() - start;
  res.setHeader("X-Response-Time", `${ms}ms`);
  req.app.logger.info(
    `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`,
  );
};
```

## 中间件签名

```typescript
type VextMiddleware = (
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

| 参数   | 说明                                                     |
| ------ | -------------------------------------------------------- |
| `req`  | 框架统一的请求对象（与 Adapter 解耦）                    |
| `res`  | 框架统一的响应对象                                       |
| `next` | 调用下一个中间件；必须 `await`，否则后置逻辑无法正确执行 |

## 定义中间件

中间件文件放在 `src/middlewares/` 目录下，由 `middleware-loader` 自动扫描。文件名即中间件名称。

### 普通中间件 — `defineMiddleware`

不需要配置参数的中间件，使用 `defineMiddleware` 标记：

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "");

  if (!token) {
    req.app.throw(401, "Authorization token is required");
  }

  // 验证 token（示例）
  try {
    const payload = verifyJWT(token);
    (req as any).user = payload;
  } catch {
    req.app.throw(401, "Invalid or expired token");
  }

  await next();
});

function verifyJWT(token: string) {
  // JWT 验证逻辑...
  return { id: "1", role: "user" };
}
```

### 工厂中间件 — `defineMiddlewareFactory`

需要运行时配置参数的中间件，使用 `defineMiddlewareFactory` 标记。工厂函数接收 `options` 参数，返回一个 `VextMiddleware`：

```typescript
// src/middlewares/check-role.ts
import { defineMiddlewareFactory } from "vextjs";

interface CheckRoleOptions {
  roles: string[];
}

export default defineMiddlewareFactory<CheckRoleOptions>((options) => {
  const allowedRoles = options?.roles ?? [];

  return async (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      req.app.throw(401, "Authentication required");
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      req.app.throw(403, "Insufficient permissions");
    }

    await next();
  };
});
```

:::tip 为什么需要显式标记？
`defineMiddleware` 和 `defineMiddlewareFactory` 通过 Symbol 标记让中间件类型显式化。`middleware-loader` 通过 `isMiddleware()` / `isMiddlewareFactory()` 检测标记，零歧义地区分普通中间件和工厂中间件。

如果不标记，框架无法区分"一个函数到底是中间件本身，还是返回中间件的工厂函数"。
:::

## 注册与使用

中间件的使用分为两步：**配置白名单** → **路由引用**。

### Step 1: 在配置中声明白名单

所有路由级中间件必须先在 `config/default.ts` 的 `middlewares` 数组中声明：

```typescript
// src/config/default.ts
export default {
  port: 3000,
  middlewares: [
    // 普通中间件 — 字符串声明
    "auth",

    // 工厂中间件 — 对象声明（附带默认参数）
    { name: "check-role", options: { roles: ["user"] } },

    // 工厂中间件 — 无默认参数
    "rate-limit-api",
  ],
};
```

白名单机制的好处：

- **安全性**：防止路由随意引用未审核的中间件
- **显式依赖**：一眼看到项目使用了哪些中间件
- **参数默认值**：工厂中间件的默认参数集中管理

### Step 2: 在路由中引用

通过 `options.middlewares` 为路由指定中间件：

生产认证建议优先使用内置 `auth()` 中间件，并把最终 `RouteOptions.auth` 内联到路由，或保存为可静态投影的同文件 `const`。构建索引与 Doctor 会拒绝 route-options helper 调用。本节只演示更底层的 middleware 引用机制。

:::tip 认证与授权
使用 `auth()` 将身份解析到 `req.auth`，再通过 [`RouteOptions.auth`](../api/route-definition#auth) 保护路由，并让 OpenAPI security 声明保持一致。业务特定的权限资源应写在路由文件的最终 options 常量中。完整的 `permission-core` 集成见 [permission-core Auth 示例](../examples/permission-core-auth)。
:::

```typescript
// src/routes/admin.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // 字符串引用 — 使用配置中的默认参数
  app.get(
    "/profile",
    {
      middlewares: ["audit-log"],
    },
    async (req, res) => {
      res.json({ ok: true });
    },
  );

  // 对象引用 — 覆盖默认参数
  app.delete(
    "/users/:id",
    {
      middlewares: [
        "auth",
        { name: "check-role", options: { roles: ["superadmin"] } },
      ],
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.status(204).json(null);
    },
  );
});
```

### 参数优先级

当工厂中间件同时在配置和路由中指定了参数时，**路由级参数覆盖配置级默认参数**：

```
配置默认参数 (config/default.ts)  →  路由覆盖参数 (options.middlewares)
{ roles: ['user'] }              →  { roles: ['superadmin'] }
```

## 中间件执行顺序

### 全局中间件

VextJS 内置了多个全局中间件，在所有路由之前自动执行。执行顺序：

```
请求进入
  ↓
1. requestId      — 生成/透传请求唯一标识
2. cors           — CORS 跨域处理
3. bodyParser     — 请求体解析（JSON / URL-encoded）
4. rateLimit      — 全局速率限制（仅 config.rateLimit.enabled === true 时）
5. responseWrapper — 开启响应包装（{ code, data, requestId }）
6. accessLog      — 访问日志记录
  ↓
7. [路由级中间件]   — 按 options.middlewares 声明顺序
  ↓
8. [validateMiddleware] — 参数校验（如果配置了 validate）
  ↓
9. [handler]       — 路由处理函数
  ↓
errorHandler      — 全局错误处理（捕获任何阶段抛出的异常）
```

内置全局中间件通过配置控制。限流采用显式启用：省略 `rateLimit`，或
`rateLimit.enabled` 不严格等于 `true` 时，Vext 不安装限流中间件，因此不会产生
限流响应头或 HTTP 429。

```typescript
// src/config/default.ts
export default {
  rateLimit: {
    enabled: true,
    max: 100,
    window: 60,
  },
};
```

全局限流启用后，路由可通过 `override: { rateLimit: false }` 跳过，也可传入
路由级对象覆盖 `max`、`window` 或 `keyBy`。`app.setRateLimiter()` 只替换 limiter
实现，不会隐式开启应用限流；导出的 `createRateLimitMiddleware()` 工厂也仍可用于
显式手动组合。

### 路由级中间件

路由级中间件按 `options.middlewares` 数组中的声明顺序执行：

```typescript
app.post(
  "/sensitive-action",
  {
    middlewares: ["auth", "check-role", "audit-log"],
    //            ↑ 1st    ↑ 2nd        ↑ 3rd
  },
  handler,
);
```

## 全局中间件（插件注册）

插件可以通过 `app.use()` 注册全局中间件，对所有路由生效。这些中间件在内置全局中间件之后、路由级中间件之前执行：

```typescript
// src/plugins/request-timing.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "request-timing",
  setup(app) {
    app.use(async (req, res, next) => {
      const startedAt = Date.now();
      await next();
      res.setHeader("Server-Timing", `app;dur=${Date.now() - startedAt}`);
    });
  },
});
```

浏览器安全响应头请优先使用内置 `config.securityHeaders`。它会一致覆盖普通响应、错误响应、404、测试辅助和 dev soft reload：

```typescript
export default {
  securityHeaders: {
    enabled: true,
    preset: "basic",
  },
};
```

:::warning 注意
`app.use()` 只能在插件的 `setup()` 中调用。路由注册完成后再调用将抛出错误。
:::

## 常见中间件示例

### 认证中间件

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const header = req.headers["authorization"];

  if (!header?.startsWith("Bearer ")) {
    req.app.throw(401, "Missing or invalid Authorization header");
  }

  const token = header.slice(7);

  try {
    // 验证 JWT token
    const payload = await verifyToken(token);
    (req as any).user = payload;
  } catch (err) {
    req.app.throw(401, "Token expired or invalid");
  }

  await next();
});

async function verifyToken(token: string) {
  // 实际实现中使用 jsonwebtoken 或 jose 等库
  return { id: "1", email: "user@example.com", role: "user" };
}
```

### 角色检查中间件

```typescript
// src/middlewares/check-role.ts
import { defineMiddlewareFactory } from "vextjs";

interface RoleOptions {
  roles: string[];
}

export default defineMiddlewareFactory<RoleOptions>((options) => {
  return async (req, res, next) => {
    const user = (req as any).user;

    if (!user) {
      req.app.throw(401, "Not authenticated");
    }

    const allowed = options?.roles ?? [];
    if (allowed.length > 0 && !allowed.includes(user.role)) {
      req.app.logger.warn(
        { userId: user.id, role: user.role, required: allowed },
        "Access denied: insufficient role",
      );
      req.app.throw(403, "Access denied");
    }

    await next();
  };
});
```

### 请求耗时记录

```typescript
// src/middlewares/timing.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, res, next) => {
  const start = performance.now();

  await next();

  const duration = (performance.now() - start).toFixed(2);
  res.setHeader("X-Response-Time", `${duration}ms`);

  req.app.logger.info(
    {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
    },
    "Request completed",
  );
});
```

### API Key 验证

```typescript
// src/middlewares/api-key.ts
import { defineMiddlewareFactory } from "vextjs";

interface ApiKeyOptions {
  header?: string;
  keys?: string[];
}

export default defineMiddlewareFactory<ApiKeyOptions>((options) => {
  const headerName = options?.header ?? "x-api-key";
  const validKeys = new Set(options?.keys ?? []);

  return async (req, res, next) => {
    if (validKeys.size === 0) {
      // 未配置 keys，跳过验证
      await next();
      return;
    }

    const apiKey = req.headers[headerName];
    if (!apiKey || !validKeys.has(apiKey)) {
      req.app.throw(401, "Invalid API key");
    }

    await next();
  };
});
```

### 缓存控制

```typescript
// src/middlewares/cache-control.ts
import { defineMiddlewareFactory } from "vextjs";

interface CacheOptions {
  maxAge?: number; // 秒
  directive?: string; // 'public' | 'private' | 'no-cache' | 'no-store'
}

export default defineMiddlewareFactory<CacheOptions>((options) => {
  const maxAge = options?.maxAge ?? 0;
  const directive = options?.directive ?? "public";
  const value = maxAge > 0 ? `${directive}, max-age=${maxAge}` : "no-store";

  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", value);
  };
});
```

## 错误处理中间件

全局错误处理由框架内置的 `error-handler` 负责，它会捕获中间件链中抛出的所有异常：

- `HttpError`（由 `app.throw()` 抛出）→ 转化为结构化 JSON 响应
- `VextValidationError`（参数校验失败）→ 422 响应 + errors 数组
- 其他异常 → 500 Internal Server Error

### 什么时候用哪种抛错方式

- 需要明确的 HTTP 语义时，优先使用 `app.throw(...)`。例如 `404`、`401`、`409`，或需要附带业务错误码的场景。
- 需要返回字段级校验详情时，抛出 `VextValidationError`。
- 发生真正的未预期异常时，可以直接 `throw new Error("...")`，框架会自动捕获并转成 `500`。

```typescript
// 结构化 HTTP 错误
req.app.throw(404, "user.not_found");

// 第四参数为对象/数组时作为 details 输出，适合透出三方业务详情
req.app.throw(
  502,
  "payment.failed",
  { orderId },
  {
    provider: "stripe",
    providerCode: "card_declined",
  },
);

// 字段级校验错误
throw new VextValidationError([{ field: "email", message: "邮箱格式不正确" }]);

// 未预期的运行时错误
throw new Error("Database connection lost");
```

要注意，`throw new Error("...")` 并不表示客户端一定会看到完整错误详情。它的用途是让框架捕获“未知异常”：

- 默认情况下，客户端会收到安全的 `500 Internal Server Error`
- 当 `response.hideInternalErrors = false` 时，JSON 500 响应会附带 `stack`
- 浏览器在 dev 模式访问出错页面时，还可能看到内置的 HTML error overlay

因此，若你的目标是“返回一个明确的 4xx/5xx HTTP 结果给调用方”，应使用 `app.throw(...)`，而不是依赖普通 `Error`

如果只想在“路由参数校验通过后”记录请求，可使用 `app.hooks.on("validation:success", ...)`。该 hook 在 `validate` 全部通过后触发，校验失败的请求不会进入它：

```typescript
export default definePlugin({
  name: "validated-access-log",
  setup(app) {
    app.hooks.on("validation:success", ({ req, route }) => {
      app.logger.info(
        { requestId: req.requestId, route: route.path },
        "validated request",
      );
    });
  },
});
```

你**不需要**手动编写错误处理中间件。如果需要自定义错误处理逻辑（如上报到 Sentry），推荐在插件中使用 `app.use()` 注册一个 try-catch 中间件：

```typescript
// src/plugins/sentry.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "sentry",
  setup(app) {
    app.use(async (req, res, next) => {
      try {
        await next();
      } catch (err) {
        // 上报错误到 Sentry
        // Sentry.captureException(err);
        app.logger.error({ err }, "Captured by Sentry plugin");

        // 重新抛出，让框架的 error-handler 处理响应
        throw err;
      }
    });
  },
});
```

## 中间件中的 `req.app`

路由级中间件没有 `defineRoutes` 的闭包 `app`，因此通过 `req.app` 访问框架能力：

```typescript
export default defineMiddleware(async (req, res, next) => {
  // 通过 req.app 访问各种框架能力
  req.app.logger.info("Middleware executing"); // 日志
  req.app.throw(403, "Forbidden"); // 抛出错误
  const config = req.app.config; // 读取配置
  const userSvc = req.app.services.user; // 访问服务

  await next();
});
```

## 环境级中间件配置覆盖

可以在环境配置文件中覆盖中间件的默认参数：

```typescript
// src/config/default.ts
export default {
  middlewares: ["auth", { name: "check-role", options: { roles: ["user"] } }],
};
```

```typescript
// src/config/development.ts — 开发环境关闭某些中间件
export default {
  middlewares: [
    { name: "check-role", options: { roles: [] } }, // 开发环境不检查角色
  ],
};
```

配置的 `middlewares` 数组使用智能 patch 策略：按 `name` 匹配并合并，不会简单地替换整个数组。

## 内置中间件

VextJS 内置以下全局中间件，通过配置项控制行为：

| 中间件              | 配置项              | 说明                                          |
| ------------------- | ------------------- | --------------------------------------------- |
| **requestId**       | `config.requestId`  | 生成/透传请求唯一标识                         |
| **cors**            | `config.cors`       | CORS 跨域处理                                 |
| **bodyParser**      | `config.bodyParser` | 请求体解析（JSON / URL-encoded）              |
| **rateLimit**       | `config.rateLimit`  | 显式启用的全局限流；仅 `enabled: true` 时安装 |
| **accessLog**       | `config.accessLog`  | 访问日志（method / path / status / duration） |
| **responseWrapper** | `config.response`   | 响应出口包装 `{ code, data, requestId }`      |
| **errorHandler**    | —                   | 全局错误处理（不可配置，始终启用）            |

详见 [配置](/guide/configuration) 章节了解各项配置选项。

## TypeScript 类型扩展

如果中间件在 `req` 上挂载了自定义属性（如 `req.user`），推荐通过 `declare module` 扩展类型：

```typescript
// src/types/extensions.d.ts
declare module "vextjs" {
  interface VextRequest {
    user?: {
      id: string;
      email: string;
      role: string;
    };
  }
}
```

扩展后，所有路由和中间件中访问 `req.user` 都会获得类型提示，无需 `as any` 断言。

## 最佳实践

### 1. 保持中间件职责单一

每个中间件只做一件事。认证和授权应分为两个中间件：

```typescript
// ✅ 正确 — 职责单一
middlewares: ["auth", "check-role"];

// ❌ 避免 — 一个中间件做太多事
middlewares: ["auth-and-role-check"];
```

### 2. 始终 `await next()`

如果中间件需要执行后置逻辑或让请求继续传递，必须 `await next()`：

```typescript
// ✅ 正确
export default defineMiddleware(async (req, res, next) => {
  console.log("before");
  await next(); // 等待后续中间件和 handler 完成
  console.log("after");
});

// ❌ 错误 — 忘记 await，后置逻辑会在 handler 完成前执行
export default defineMiddleware(async (req, res, next) => {
  console.log("before");
  next(); // 没有 await！
  console.log("after — 这会在 handler 之前执行");
});
```

### 3. 短路响应

某些中间件可能需要直接响应而不调用 `next()`（如认证失败）。在这种情况下直接返回即可，不需要调用 `next()`：

```typescript
export default defineMiddleware(async (req, res, next) => {
  if (!isAllowed(req)) {
    // 直接抛出错误，不调用 next() — 请求在此终止
    req.app.throw(403, "Access denied");
  }

  await next();
});
```

由于 `app.throw()` 的返回类型是 `never`，它会自动终止执行流程。

### 4. 在配置中管理，而非硬编码

避免在中间件内部硬编码配置值。使用工厂模式接收参数，在配置文件中统一管理：

```typescript
// ✅ 正确 — 参数由配置管理
export default defineMiddlewareFactory<{ maxAge: number }>((options) => {
  const maxAge = options?.maxAge ?? 3600;
  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
  };
});

// ❌ 避免 — 硬编码
export default defineMiddleware(async (req, res, next) => {
  await next();
  res.setHeader("Cache-Control", "public, max-age=3600"); // 无法按环境变更
});
```

## 下一步

- 学习 [插件](/guide/plugins) 如何通过 `app.use()` 注册全局中间件
- 了解 [参数校验](/guide/validation) 中间件的自动生成
- 查看 [配置](/guide/configuration) 中内置中间件的完整选项
- 探索 [测试](/guide/testing) 如何测试中间件逻辑
