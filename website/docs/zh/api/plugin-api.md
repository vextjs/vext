# 插件 API

本页详细介绍 VextJS 的插件系统 API，包括插件定义、中间件定义辅助函数和相关类型。

## 概述

插件是 VextJS 框架的**唯一扩展入口**。通过插件可以：

- 向 `app` 挂载自定义属性（`app.extend()`）
- 注册全局中间件（`app.use()`）
- 注册优雅关闭钩子（`app.onClose()`）
- 注册就绪钩子（`app.onReady()`）
- 注册运行时生命周期 hook（`app.hooks.on()`）
- 替换内置实现（`app.setValidator()` / `app.setThrow()` / `app.setRateLimiter()`）

插件文件放在 `src/plugins/` 目录下，`plugin-loader` 在启动时自动扫描加载。

---

## definePlugin

`definePlugin` 是创建插件的推荐方式，提供类型推断和 IDE 自动补全支持。

### 函数签名

```typescript
function definePlugin(plugin: VextPlugin): VextPlugin;
```

接收一个 `VextPlugin` 对象，原样返回（仅用于类型标注）。

### 基本用法

```typescript
// src/plugins/redis.ts
import { definePlugin } from "vextjs";
import Redis from "ioredis";

export default definePlugin({
  name: "redis",
  async setup(app) {
    const redis = new Redis(app.config.redis);
    app.extend("redis", redis);
    app.onClose(() => redis.quit());
  },
});
```

---

## VextPlugin

插件接口定义。

```typescript
interface VextPlugin {
  readonly name: string;
  readonly dependencies?: string[];
  setup(app: VextApp): Promise<void> | void;
  onReady?(app: VextApp): Promise<void> | void;
  onClose?(app: VextApp): Promise<void> | void;
}
```

### `name`

插件名称，全局唯一标识。

```typescript
readonly name: string;
```

用于日志输出、错误信息和依赖声明。同名插件后加载的会覆盖先加载的（可用于替换内置实现）。

```typescript
export default definePlugin({
  name: "my-plugin", // 唯一标识
  setup(app) {
    /* ... */
  },
});
```

### `dependencies`

依赖的其他插件名称列表（可选）。

```typescript
readonly dependencies?: string[];
```

`plugin-loader` 根据此字段进行**拓扑排序**，确保依赖的插件先于当前插件执行 `setup()`。存在循环依赖时 Fail Fast 报错。

```typescript
export default definePlugin({
  name: "user-cache",
  dependencies: ["redis", "database"], // 确保 redis 和 database 先初始化
  async setup(app) {
    // 此时 app.redis（redis 插件挂载）和 app.db（database 插件挂载）已就绪
    const userCache = new UserCacheService(app.redis, app.db);
    app.extend("userCache", userCache);
  },
});
```

:::warning
循环依赖会导致启动失败：

```
[vextjs] Circular dependency detected: redis → database → redis
```

:::

### `setup(app, context)`

插件初始化函数，在 `bootstrap` 的步骤②被 `plugin-loader` 调用。

```typescript
setup(
  app: VextPluginContext,
  context: VextPluginSetupContext,
): Promise<void> | void;
```

**参数**：

| 参数      | 类型                     | 说明                                                                  |
| --------- | ------------------------ | --------------------------------------------------------------------- |
| `app`     | `VextPluginContext`      | 可撤销的 setup facade；此时 `app.use()` 可用，`app.services` 尚未注入 |
| `context` | `VextPluginSetupContext` | setup 生命周期上下文，包含供可取消 I/O 使用的 `signal: AbortSignal`   |

**关键说明**：

- 可以是同步或异步函数
- `plugin-loader` 为每个 `setup()` 设置**硬超时**（默认 30 秒）；超时会中止 `context.signal`、回滚 setup 阶段的框架 mutation、撤销 setup facade，然后抛出错误
- 迟到的异步 continuation 无法提交框架状态；插件仍须取消并关闭自己创建的外部资源
- 执行顺序由 `dependencies` 拓扑排序决定
- `setup()` 执行时 `app.services` 尚未注入（`service-loader` 在 `plugin-loader` 之后执行），不能访问服务
- 如果插件对象声明了 `onReady(app)` / `onClose(app)`，`plugin-loader` 会在 `setup()` 成功后自动注册这两个生命周期钩子
- `app.hooks.on()` 可用于注册 request/validation/response/fetch/service/plugin/OpenAPI 等运行时 hook，详见 [应用实例 hooks](/api/app#apphooks)

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    // ✅ 可以访问 app.config
    const pool = await createPool(app.config.database);

    // ✅ 可以挂载自定义属性
    app.extend("db", pool);

    // ✅ 可以注册全局中间件
    app.use(myMiddleware);

    // ✅ 可以注册生命周期钩子
    app.onReady(async () => {
      await pool.query("SELECT 1");
      app.logger.info("数据库连接验证成功");
    });

    app.onClose(async () => {
      await pool.end();
      app.logger.info("数据库连接池已关闭");
    });

    // ❌ 不能访问 app.services（此时尚未注入）
    // app.services.user → undefined
  },
});
```

### `onReady(app)` / `onClose(app)`

插件生命周期钩子为可选字段，等价于在 `setup()` 中手动调用 `app.onReady()` / `app.onClose()`，但语义更明确。

```typescript
export default definePlugin({
  name: "warmup",
  setup(app) {
    app.extend("warmupState", new Map());
  },
  async onReady(app) {
    app.logger.info("warmup plugin is ready");
  },
  async onClose(app) {
    app.logger.info("warmup plugin closed");
  },
});
```

- `onReady(app)`：HTTP 开始监听后执行，适合预热缓存、检查外部依赖。
- `onClose(app)`：优雅关闭时执行；多个关闭钩子按 LIFO 顺序执行。

---

## 插件加载机制

### 自动扫描

`plugin-loader` 自动扫描 `src/plugins/` 目录下的所有 `.ts` / `.js` 文件，每个文件的 `default export` 应为 `VextPlugin` 对象。

```
src/plugins/
  ├── database.ts     → definePlugin({ name: 'database', ... })
  ├── redis.ts        → definePlugin({ name: 'redis', ... })
  └── auth.ts         → definePlugin({ name: 'auth', ... })
```

### 拓扑排序

根据 `dependencies` 字段自动计算执行顺序：

```typescript
// database.ts — 无依赖，最先执行
definePlugin({ name: 'database', setup(app) { ... } })

// redis.ts — 无依赖，与 database 并列
definePlugin({ name: 'redis', setup(app) { ... } })

// auth.ts — 依赖 database 和 redis
definePlugin({
  name: 'auth',
  dependencies: ['database', 'redis'],
  setup(app) { ... },
})
```

执行顺序：`database` → `redis` → `auth`

### 超时保护

每个 `setup()` 有 30 秒超时限制（默认值）。如果插件初始化时间超过此限制（如数据库连接超时），`plugin-loader` 将抛出错误并中止启动。

### 内置插件

VextJS 内置了 `monsqlize` 插件（数据库抽象层），通过 `createMonSQLizePlugin()` 创建：

```typescript
import { createMonSQLizePlugin } from "vextjs";
```

---

## defineMiddleware

创建无配置中间件的辅助函数。通过 Symbol 标记确保中间件类型安全。

### 函数签名

```typescript
function defineMiddleware(middleware: VextMiddleware): TaggedMiddleware;
```

### 基本用法

```typescript
// src/middlewares/auth.ts
import { defineMiddleware } from "vextjs";

export default defineMiddleware(async (req, _res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    req.app.throw(401, "未提供认证令牌");
  }

  try {
    const decoded = await verifyJWT(token);
    req.user = decoded;
  } catch {
    req.app.throw(401, "认证令牌无效或已过期");
  }

  await next();
});
```

### VextMiddleware 类型

```typescript
type VextMiddleware = (
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

三个参数：

| 参数   | 类型                  | 说明                       |
| ------ | --------------------- | -------------------------- |
| `req`  | `VextRequest`         | 请求对象                   |
| `res`  | `VextResponse`        | 响应对象                   |
| `next` | `() => Promise<void>` | 调用下一个中间件 / handler |

### 洋葱模型

中间件通过 `await next()` 实现洋葱模型，可以在 handler 执行前后分别处理：

```typescript
export default defineMiddleware(async (req, res, next) => {
  // ── before handler（请求进入阶段）──
  const start = Date.now();
  console.log(`→ ${req.method} ${req.path}`);

  await next(); // 执行 handler 及后续中间件

  // ── after handler（响应返回阶段）──
  const duration = Date.now() - start;
  console.log(`← ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
});
```

执行流程：

```
请求 → 中间件A(before) → 中间件B(before) → handler → 中间件B(after) → 中间件A(after) → 响应
```

### 短路响应

不调用 `next()` 可以短路请求，handler 不会执行：

```typescript
export default defineMiddleware(async (req, res, next) => {
  // IP 黑名单检查
  if (blockedIPs.has(req.ip)) {
    res.status(403).json({ message: "访问被拒绝" });
    return; // 不调用 next()
  }

  await next();
});
```

### 错误处理

中间件中抛出的错误会被框架 `error-handler` 统一捕获：

```typescript
export default defineMiddleware(async (req, _res, next) => {
  if (!req.headers.authorization) {
    // 使用 app.throw 抛出标准 HTTP 错误
    req.app.throw(401, "未提供认证令牌");
    // 等价于 throw new HttpError(401, '未提供认证令牌')
  }

  await next();
});
```

如果中间件遇到的是“我要主动返回给调用方的 HTTP 错误”，推荐使用 `req.app.throw(...)`。如果是未预期的运行时失败，也可以直接 `throw new Error("...")`，框架会将其转成 500；若需要返回字段级校验详情，则应抛出 `VextValidationError`。

---

## defineMiddlewareFactory

创建**带配置的中间件工厂**。接收配置参数，返回中间件函数。

### 函数签名

```typescript
function defineMiddlewareFactory<T = unknown>(
  factory: (options: T) => VextMiddleware,
): TaggedMiddlewareFactory;
```

### 基本用法

```typescript
// src/middlewares/role.ts
import { defineMiddlewareFactory } from "vextjs";

interface RoleOptions {
  required: string | string[];
}

export default defineMiddlewareFactory<RoleOptions>((options) => {
  const requiredRoles = Array.isArray(options.required)
    ? options.required
    : [options.required];

  return async (req, _res, next) => {
    if (!req.user) {
      req.app.throw(401, "未认证");
    }

    if (!requiredRoles.includes(req.user.role)) {
      req.app.throw(403, "权限不足", {
        required: requiredRoles.join(", "),
        current: req.user.role,
      });
    }

    await next();
  };
});
```

### 配置传递

中间件工厂的配置通过 `config.middlewares` 白名单传递：

```typescript
// src/config/default.ts
export default {
  middlewares: [
    { name: "auth" }, // 无配置中间件
    { name: "role", options: { required: "admin" } }, // 工厂中间件 + 配置
    { name: "client-cache", options: { maxAge: 300 } }, // 工厂中间件 + 配置
  ],
};
```

路由中引用时可以覆盖默认配置：

```typescript
app.get(
  "/admin/users",
  {
    middlewares: [
      "auth",
      { name: "role", options: { required: ["admin", "superadmin"] } },
    ],
  },
  handler,
);
```

### 更多示例

**客户端缓存头中间件**：

```typescript
// src/middlewares/client-cache.ts
import { defineMiddlewareFactory } from "vextjs";

interface ClientCacheOptions {
  maxAge: number; // Cache-Control max-age，单位秒
}

export default defineMiddlewareFactory<ClientCacheOptions>((options) => {
  return async (req, res, next) => {
    await next();
    res.setHeader("Cache-Control", `public, max-age=${options.maxAge}`);
  };
});
```

:::tip
路由级响应缓存不需要自定义中间件。请直接使用 route options 的 `cache` 字段；其 TTL 配置单位是毫秒。`app.cache` 是响应缓存控制面，只用于 `invalidate()`、`delete()`、`clear()` 和 `stats()`。
:::

**限速中间件**：

```typescript
// src/middlewares/throttle.ts
import { defineMiddlewareFactory } from "vextjs";

interface ThrottleOptions {
  max: number;
  window: number; // 秒
}

export default defineMiddlewareFactory<ThrottleOptions>((options) => {
  const store = new Map<string, { count: number; resetAt: number }>();

  return async (req, _res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = store.get(key);

    if (entry && now < entry.resetAt) {
      if (entry.count >= options.max) {
        req.app.throw(429, "请求过于频繁");
      }
      entry.count++;
    } else {
      store.set(key, {
        count: 1,
        resetAt: now + options.window * 1000,
      });
    }

    await next();
  };
});
```

---

## isMiddleware / isMiddlewareFactory

类型检查辅助函数，用于判断一个值是否为 `defineMiddleware` / `defineMiddlewareFactory` 创建的中间件。

### 函数签名

```typescript
function isMiddleware(value: unknown): value is TaggedMiddleware;
function isMiddlewareFactory(value: unknown): value is TaggedMiddlewareFactory;
```

### 用法

```typescript
import { isMiddleware, isMiddlewareFactory } from "vextjs";

const middlewareModule = await import("./middlewares/auth.ts");
const exported = middlewareModule.default;

if (isMiddleware(exported)) {
  // 无配置中间件，直接使用
  adapter.registerMiddleware(exported);
} else if (isMiddlewareFactory(exported)) {
  // 工厂中间件，需要传入 options 调用后获得中间件实例
  const middleware = exported(options);
  adapter.registerMiddleware(middleware);
}
```

:::tip
这两个函数通常由框架内部的 `middleware-loader` 使用，用户代码很少需要直接调用。
:::

---

## VextErrorMiddleware

错误中间件类型（框架内部使用）。

```typescript
type VextErrorMiddleware = (
  error: Error,
  req: VextRequest,
  res: VextResponse,
  next: () => Promise<void>,
) => Promise<void> | void;
```

与普通中间件不同，错误中间件多接收一个 `error` 参数。框架内置的 `error-handler` 使用此类型。用户通常不需要直接创建错误中间件，`error-handler` 已提供完善的错误处理逻辑。

---

## TaggedMiddleware / TaggedMiddlewareFactory

被 Symbol 标记的中间件类型，用于 `middleware-loader` 区分普通函数和框架中间件。

```typescript
interface TaggedMiddleware extends VextMiddleware {
  [MIDDLEWARE_SYMBOL]: true;
}

interface TaggedMiddlewareFactory {
  (options: unknown): VextMiddleware;
  [MIDDLEWARE_FACTORY_SYMBOL]: true;
}
```

### Symbol 常量

```typescript
import { MIDDLEWARE_SYMBOL, MIDDLEWARE_FACTORY_SYMBOL } from "vextjs";
```

这些 Symbol 由 `defineMiddleware` / `defineMiddlewareFactory` 自动附加，用户代码不需要手动设置。

---

## 中间件文件组织

### 目录结构

```
src/middlewares/
  ├── auth.ts           → defineMiddleware(...)      // 认证中间件
  ├── role.ts           → defineMiddlewareFactory(...) // 角色校验（带配置）
  ├── client-cache.ts   → defineMiddlewareFactory(...) // 客户端缓存头中间件（带配置）
  └── request-logger.ts → defineMiddleware(...)      // 请求日志
```

### 中间件注册流程

1. `middleware-loader` 扫描 `src/middlewares/` 目录
2. 根据文件名和 `config.middlewares` 白名单匹配
3. 使用 `isMiddleware()` / `isMiddlewareFactory()` 区分类型
4. 工厂中间件调用 `factory(options)` 获取中间件实例
5. 注册到中间件定义映射（`Map<string, VextMiddleware>`）
6. 路由注册时通过名称引用

### 配置白名单

只有在 `config.middlewares` 中声明的中间件才能在路由 `options.middlewares` 中引用：

```typescript
// src/config/default.ts
export default {
  middlewares: [
    { name: "auth" },
    { name: "role", options: { required: "user" } },
  ],
};
```

未在白名单中声明的中间件在路由中引用会抛出启动错误。

---

## 内置中间件

VextJS 提供以下内置中间件，由 `bootstrap` 自动注册，无需手动配置：

| 中间件           | 函数                           | 说明              |
| ---------------- | ------------------------------ | ----------------- |
| Request ID       | `createRequestIdMiddleware()`  | 请求 ID 生成/透传 |
| CORS             | `createCorsMiddleware()`       | 跨域资源共享      |
| Body Parser      | `createBodyParserMiddleware()` | 请求体解析        |
| Rate Limit       | `createRateLimitMiddleware()`  | 速率限制          |
| Response Wrapper | `responseWrapper`              | 出口包装          |
| Access Log       | `createAccessLogMiddleware()`  | 访问日志          |
| Error Handler    | `createErrorHandler()`         | 错误处理          |

这些中间件可以通过 `config` 配置其行为（参见 [配置项](/api/config)），但不能通过 `app.use()` 重复注册。

### 执行顺序

内置中间件的执行顺序（从外到内）：

```
请求进入
  → requestId      ← 生成/透传 requestId
  → cors           ← CORS 预检
  → bodyParser     ← 解析请求体
  → rateLimit      ← 速率限制检查
  → responseWrapper ← 开启出口包装
  → accessLog      ← 记录请求开始时间
  → [全局中间件]    ← 插件通过 app.use() 注册的
  → [路由中间件]    ← 路由 options.middlewares 引用的
  → [validate]     ← 参数校验
  → handler        ← 路由处理函数
  ← accessLog      ← 记录耗时和状态码
  ← responseWrapper ← 包装响应
  ← errorHandler   ← 捕获未处理错误
响应返回
```

---

## 插件开发最佳实践

### 1. 命名规范

- 插件 `name` 使用 kebab-case：`'my-plugin'`
- 文件名与插件名一致：`src/plugins/my-plugin.ts`

### 2. 类型声明

使用 `declare module` 为扩展的属性提供类型提示：

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextApp {
    redis: import("ioredis").Redis;
    db: import("./db").DatabasePool;
  }

  interface VextRequest {
    user?: {
      id: string;
      role: string;
    };
  }

  interface VextConfig {
    redis?: {
      host: string;
      port: number;
    };
    database?: {
      connectionString: string;
    };
  }
}
```

### 3. 资源清理

始终在 `onClose` 中清理插件创建的资源：

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    const pool = await createPool(app.config.database);
    app.extend("db", pool);

    // ✅ 务必注册关闭钩子
    app.onClose(async () => {
      await pool.end();
      app.logger.info("数据库连接池已关闭");
    });
  },
});
```

### 4. 错误处理

`setup()` 中的错误会导致启动失败。确保关键资源的初始化有错误处理：

```typescript
export default definePlugin({
  name: "database",
  async setup(app) {
    try {
      const pool = await createPool(app.config.database);
      app.extend("db", pool);
    } catch (err) {
      app.logger.fatal({ error: err }, "数据库连接失败");
      throw err; // 重新抛出，阻止启动
    }
  },
});
```

### 5. 可选依赖

如果插件依赖其他插件的扩展属性，但该依赖是可选的：

```typescript
export default definePlugin({
  name: "user-cache",
  // 不声明 dependencies，手动检查
  setup(app) {
    if (app.redis) {
      // Redis 可用，启用缓存
      app.extend("userCache", new CachedUserService(app.redis));
    } else {
      // Redis 不可用，降级为无缓存模式
      app.logger.warn("Redis 未配置，用户缓存已禁用");
      app.extend("userCache", new UserService());
    }
  },
});
```

---

## 类型导入

```typescript
import {
  definePlugin,
  defineMiddleware,
  defineMiddlewareFactory,
  isMiddleware,
  isMiddlewareFactory,
  MIDDLEWARE_SYMBOL,
  MIDDLEWARE_FACTORY_SYMBOL,
} from "vextjs";

import type {
  VextPlugin,
  VextMiddleware,
  VextErrorMiddleware,
  VextHandler,
  VextDefinedMiddleware,
  VextMiddlewareFactory,
  VextMiddlewareExport,
  TaggedMiddleware,
  TaggedMiddlewareFactory,
} from "vextjs";
```
