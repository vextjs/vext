# 服务层

VextJS 采用 **分层架构**，将业务逻辑集中在服务层（Service Layer）。服务文件放在 `src/services/` 目录下，由框架自动扫描、实例化并注入到 `app.services`，路由 handler 中通过 `app.services.xxx` 访问。

## 设计理念

```
路由层 (routes)    ← 参数提取 + 响应返回（薄层）
   ↓
服务层 (services)  ← 业务逻辑（核心）
   ↓
数据层 (models)    ← 数据访问（通过插件提供）
```

- **路由 handler** 只负责从请求中提取参数、调用 service、返回响应
- **服务层** 承载所有业务逻辑，不感知 HTTP 协议（不访问 `req` / `res`）
- **数据层** 由插件提供（如数据库 ORM），通过 `app` 对象访问

这种分层使得：

- 业务逻辑可以在不同路由间复用
- 服务层可以独立进行单元测试（不依赖 HTTP）
- 切换底层 Adapter 不影响业务代码

## 基本写法

### 服务类

每个服务文件导出一个 **class**，构造函数接收 `app` 参数：

```typescript
// src/services/user.ts
import type { VextApp } from "vextjs";

export default class UserService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async findAll(options?: { page?: number; limit?: number }) {
    const { page = 1, limit = 20 } = options ?? {};
    // 业务逻辑...
    return {
      items: [],
      total: 0,
      page,
      limit,
    };
  }

  async findById(id: string) {
    // 业务逻辑...
    const user = { id, name: "Alice", email: "alice@example.com" };
    return user;
  }

  async create(data: { name: string; email: string }) {
    this.app.logger.info({ data }, "Creating user");
    // 业务逻辑...
    return { id: crypto.randomUUID(), ...data };
  }

  async update(id: string, data: Partial<{ name: string; email: string }>) {
    this.app.logger.info({ id, data }, "Updating user");
    return { id, ...data };
  }

  async delete(id: string) {
    this.app.logger.info({ id }, "Deleting user");
  }
}
```

### 在路由中使用

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/", async (_req, res) => {
    // 通过 app.services 访问已注入的服务实例
    const users = await app.services.user.findAll();
    res.json(users);
  });

  app.get(
    "/:id",
    {
      validate: { param: { id: "string!" } },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      if (!user) app.throw(404, "user.not_found");
      res.json(user);
    },
  );

  app.post(
    "/",
    {
      validate: {
        body: { name: "string:1-50!", email: "email!" },
      },
      middlewares: ["auth"],
      auth: { required: true, security: "bearerAuth" },
    },
    async (req, res) => {
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );
});
```

## 文件命名与映射

`service-loader` 按文件路径自动将服务实例挂载到 `app.services` 的对应属性上。

### 映射规则

| 文件路径                        | 访问方式                        | 说明                   |
| ------------------------------- | ------------------------------- | ---------------------- |
| `services/user.ts`              | `app.services.user`             | 扁平命名               |
| `services/order.ts`             | `app.services.order`            | 扁平命名               |
| `services/user-profile.ts`      | `app.services.userProfile`      | kebab-case → camelCase |
| `services/payment/stripe.ts`    | `app.services.payment.stripe`   | 嵌套命名空间           |
| `services/payment/alipay.ts`    | `app.services.payment.alipay`   | 嵌套命名空间           |
| `services/admin/user-manage.ts` | `app.services.admin.userManage` | 嵌套 + 驼峰转换        |

**转换规则：**

1. 文件路径相对于 `services/` 目录，去除扩展名
2. 文件名自动从 `kebab-case` 转换为 `camelCase`
3. 子目录映射为嵌套对象

### 嵌套服务示例

```
src/services/
├── user.ts                    → app.services.user
├── order.ts                   → app.services.order
└── payment/
    ├── stripe.ts              → app.services.payment.stripe
    └── wechat-pay.ts          → app.services.payment.wechatPay
```

```typescript
// src/services/payment/stripe.ts
import type { VextApp } from "vextjs";

export default class StripeService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async createPayment(amount: number, currency: string) {
    this.app.logger.info({ amount, currency }, "Creating Stripe payment");
    // Stripe API 调用...
    return { paymentId: "pi_xxx", status: "pending" };
  }

  async refund(paymentId: string) {
    this.app.logger.info({ paymentId }, "Refunding Stripe payment");
    return { refundId: "re_xxx", status: "refunded" };
  }
}
```

```typescript
// 在路由中使用嵌套服务
app.post("/pay", async (req, res) => {
  const result = await app.services.payment.stripe.createPayment(100, "usd");
  res.json(result);
});
```

## Service Hooks

Vext 会为加载到 `app.services` 的实例方法安装轻量 wrapper。当没有注册 service hook 时，调用会直接走原方法；注册 hook 后，可观察调用前后和错误：

```typescript
// src/plugins/service-observer.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "service-observer",
  setup(app) {
    app.hooks.on("service:beforeCall", ({ service, method }) => {
      app.logger.debug({ service, method }, "service call start");
    });

    app.hooks.on("service:error", ({ service, method, error }) => {
      app.logger.error({ service, method, err: error }, "service call failed");
    });
  },
});
```

`service:beforeCall`、`service:afterCall` 和 `service:error` 都是同步 hook。不要在这些 handler 中返回 Promise；如需异步上报，建议放入队列或使用不阻塞主调用的日志传输。

## 服务间调用

服务之间可以相互调用。推荐通过 `this.app.services` 在**方法中**按需访问（延迟访问），而非在构造函数中直接引用：

```typescript
// src/services/order.ts
import type { VextApp } from "vextjs";

export default class OrderService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async createOrder(
    userId: string,
    items: Array<{ productId: string; quantity: number }>,
  ) {
    // 调用其他 service — 通过 this.app.services 延迟访问
    const user = await this.app.services.user.findById(userId);
    if (!user) {
      this.app.throw(404, "user.not_found");
    }

    // 计算价格
    const total = await this.calculateTotal(items);

    // 调用支付服务
    const payment = await this.app.services.payment.stripe.createPayment(
      total,
      "usd",
    );

    return {
      orderId: crypto.randomUUID(),
      userId,
      items,
      total,
      paymentId: payment.paymentId,
      status: "created",
    };
  }

  private async calculateTotal(
    items: Array<{ productId: string; quantity: number }>,
  ) {
    // 业务逻辑...
    return items.reduce((sum, item) => sum + item.quantity * 10, 0);
  }
}
```

::::warning 避免循环依赖
`service-loader` 内置循环依赖检测。如果 `ServiceA` 和 `ServiceB` 相互依赖，框架会在启动时报错。

**✅ 正确做法** — 在方法中延迟访问：

```typescript
export default class OrderService {
  constructor(private app: VextApp) {}

  async createOrder() {
    // ✅ 方法调用时 user service 已经初始化完成
    const user = await this.app.services.user.findById("123");
  }
}
```

**❌ 错误做法** — 在构造函数中直接引用：

```typescript
export default class OrderService {
  private userService: UserService;

  constructor(app: VextApp) {
    // ❌ 构造函数执行时 user service 可能尚未初始化
    this.userService = app.services.user;
  }
}
```

::::

## 使用插件提供的能力

插件通过 `app.extend()` 注入的能力，在服务中通过 `this.app` 访问：

```typescript
// 假设 redis 插件已通过 app.extend('redis', redis) 注入
// src/services/user.ts
import type { VextApp } from "vextjs";

export default class UserService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async findById(id: string) {
    // 先查缓存
    const cached = await (this.app as any).redis.get(`user:${id}`);
    if (cached) return cached;

    // 缓存未命中，查数据库
    const user = await this.queryDatabase(id);

    // 写入缓存
    if (user) {
      await (this.app as any).redis.set(`user:${id}`, JSON.stringify(user));
    }

    return user;
  }

  private async queryDatabase(id: string) {
    // 数据库查询逻辑...
    return { id, name: "Alice" };
  }
}
```

::::tip 类型提示
使用 `declare module` 扩展 `VextApp` 接口可获得完整的类型提示：

```typescript
// src/types/extensions.d.ts
declare module "vextjs" {
  interface VextApp {
    redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttl?: number): Promise<void>;
    };
  }
}
```

扩展后 `this.app.redis` 即可获得 IDE 自动补全。
::::

## 使用 `app.throw()` 抛出错误

服务层中可以通过 `this.app.throw()` 抛出 HTTP 错误。框架会自动捕获并转化为统一的错误响应，无需在路由层手动 try-catch：

- 需要主动返回 `404`、`409`、`401` 等明确 HTTP 语义时，使用 `this.app.throw(...)`
- 需要返回字段级校验详情时，抛出 `VextValidationError`
- 发生未预期异常时，可以直接 `throw new Error("...")`，框架会统一转成 500

```typescript
export default class UserService {
  constructor(private app: VextApp) {}

  async findById(id: string) {
    const user = await this.queryDatabase(id);
    if (!user) {
      // 直接在 service 中抛出，框架统一处理
      this.app.throw(404, "user.not_found");
    }
    return user;
  }

  async create(data: { name: string; email: string }) {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      this.app.throw(409, "邮箱已注册", 10001);
    }
    // 创建逻辑...
    return { id: crypto.randomUUID(), ...data };
  }

  private async queryDatabase(id: string) {
    return null; // 模拟
  }

  private async findByEmail(email: string) {
    return null; // 模拟
  }
}
```

如果 service 内部直接 `throw new Error("...")`，框架也会捕获它；这条路径表示未知运行时异常，而不是主动设计好的 HTTP 错误响应。默认情况下客户端会收到安全的 `500 Internal Server Error`，开发环境下可通过 `response.hideInternalErrors = false` 额外暴露 `stack` 便于排查。

## 在服务中校验非 HTTP 输入

路由入口参数优先通过 `RouteOptions.validate` 声明，并在 handler 中使用 `req.valid()` 读取校验后的数据。对于 service 直接处理的非 HTTP 输入，例如定时任务、消息队列、外部回调或其他 service 调用，可以通过 `this.app.getValidator()` 复用当前全局校验引擎。

`getValidator()` 默认返回基于 schema-dsl 的 validator；如果插件通过 `app.setValidator()` 替换为 Zod、Yup 等实现，service 中获取到的也是替换后的 validator。

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

  async createFromJob(input: unknown) {
    const result = this.validateCreateUser(input);

    if (!result.valid) {
      throw new VextValidationError(result.errors ?? []);
    }

    const data = result.data as { name: string; email: string };
    return this.create(data);
  }

  async create(data: { name: string; email: string }) {
    // 创建逻辑...
    return { id: crypto.randomUUID(), ...data };
  }
}
```

::::tip

不要在 service 中直接 `import "schema-dsl"`。直接引用 schema-dsl 会绕过 `app.setValidator()` 的全局替换能力，导致 service 校验与路由校验使用不同引擎。

::::

## 使用 `app.logger` 记录日志

服务层推荐通过 `this.app.logger` 记录结构化日志。日志自动携带 requestId（通过 AsyncLocalStorage 上下文传播）：

```typescript
export default class PaymentService {
  constructor(private app: VextApp) {}

  async processPayment(orderId: string, amount: number) {
    this.app.logger.info({ orderId, amount }, "Processing payment");

    try {
      // 调用外部支付 API...
      const result = { transactionId: "txn_xxx" };
      this.app.logger.info(
        { orderId, transactionId: result.transactionId },
        "Payment successful",
      );
      return result;
    } catch (err) {
      this.app.logger.error({ orderId, err }, "Payment failed");
      this.app.throw(500, "payment.failed");
    }
  }
}
```

## 加载顺序与生命周期

### 加载时机

在 `bootstrap` 启动流程中，`service-loader` 在以下阶段执行：

```
1. config    → 加载配置
2. locales   → 加载语言包
3. plugins   → 执行插件 setup()
4. middlewares → 扫描中间件
5. services  → ⭐ 实例化服务（此处）
6. routes    → 注册路由（handler 中可安全访问 app.services）
```

这意味着：

- ✅ 服务构造函数中可以访问 `app.config`（已加载）
- ✅ 服务构造函数中可以访问 `app.logger`（已初始化）
- ✅ 服务构造函数中可以访问插件注入的能力（插件已 setup）
- ⚠️ 服务构造函数中访问 `app.services` 需注意顺序（见循环依赖章节）
- ✅ 路由 handler 中可以安全访问所有 `app.services`（已全部注入完成）

### 实例化过程

1. **扫描** — 递归扫描 `src/services/` 目录下所有 `.ts` / `.js` 文件
2. **排序** — 按文件路径字母序排序（确保加载顺序确定性）
3. **实例化** — 逐个 `new ServiceClass(app)` 创建实例
4. **挂载** — 将实例挂载到 `app.services` 的对应属性
5. **检测** — 执行循环依赖检测（可选，默认开启）

### 排除规则

以下文件会被自动跳过：

- 测试文件：`*.test.ts`、`*.spec.ts`
- 以 `_` 或 `.` 开头的文件/目录
- `node_modules` 目录

可以利用 `_` 前缀创建服务共享的工具模块：

```
src/services/
├── _base.ts          # 基类，不会被当作服务加载
├── _types.ts         # 共享类型
├── user.ts
└── order.ts
```

## 服务层最佳实践

### 1. 保持服务层的 HTTP 无关性

服务层不应直接操作 `req` / `res` 对象。如果需要请求上下文信息（如当前用户），作为参数传入：

```typescript
// ✅ 正确 — 参数传入
async createOrder(userId: string, items: OrderItem[]) {
  // ...
}

// ❌ 错误 — 直接操作请求对象
async createOrder(req: VextRequest, res: VextResponse) {
  // service 不应感知 HTTP
}
```

### 2. 单一职责

每个服务对应一个业务领域。避免将不同领域的逻辑放在同一个服务中：

```
services/
├── user.ts           # 用户管理
├── order.ts          # 订单管理
├── notification.ts   # 通知服务
└── payment/
    ├── stripe.ts     # Stripe 支付
    └── wechat-pay.ts # 微信支付
```

### 3. 使用基类共享通用逻辑

对于有共同行为的服务，可以创建基类（以 `_` 前缀防止被当作服务加载）：

```typescript
// src/services/_base.ts（不会被自动加载）
import type { VextApp } from "vextjs";

export abstract class BaseService {
  protected app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  protected async paginate<T>(
    queryFn: (offset: number, limit: number) => Promise<T[]>,
    countFn: () => Promise<number>,
    page: number,
    limit: number,
  ) {
    const offset = (page - 1) * limit;
    const [items, total] = await Promise.all([
      queryFn(offset, limit),
      countFn(),
    ]);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
```

```typescript
// src/services/user.ts
import { BaseService } from "./_base.js";

export default class UserService extends BaseService {
  async findAll(page = 1, limit = 20) {
    return this.paginate(
      (offset, limit) => this.queryUsers(offset, limit),
      () => this.countUsers(),
      page,
      limit,
    );
  }

  private async queryUsers(offset: number, limit: number) {
    return []; // 数据库查询
  }

  private async countUsers() {
    return 0; // 计数查询
  }
}
```

### 4. TypeScript 类型声明

为 `app.services` 添加类型声明，获得完整的 IDE 支持：

推荐优先使用框架提供的生成命令：

```bash
vext typegen
```

该命令会在 `.vext/types/services.generated.d.ts` 中自动生成 `VextServices` 扩展声明，并通过 `src/types/generated/index.d.ts` 接入 TypeScript 项目，同时执行一轮 tooling 层 service 依赖检查。

从 `0.3.7` 起，`vext dev` 也会在 preflight 中自动执行这一步的基础版本，用于保证开发态的 generated 声明与当前 `services` / `plugins` 定义保持同步；如果你需要 `--check`、`--write-manifest` 或独立 CI 控制，仍应显式运行 `vext typegen`。

如果你还想把 service 索引、`app.extend()` 聚合结果与依赖图摘要提供给编辑器、CI 或其他工具链消费，可以额外执行：

```bash
vext typegen --write-manifest
```

对应产物会写入：`.vext/manifest/services.json`。

如果你需要手写或补充少量高级声明，仍可保留自定义 `.d.ts` 文件；generated 文件与手写文件是隔离的，不会互相覆盖。

```typescript
// src/types/services.d.ts
import type UserService from "../services/user.js";
import type OrderService from "../services/order.js";

declare module "vextjs" {
  interface VextServices {
    user: UserService;
    order: OrderService;
    payment: {
      stripe: import("../services/payment/stripe.js").default;
    };
  }
}
```

添加后，`app.services.user.findById()` 等调用将获得完整的方法签名提示和类型检查。

## 下一步

- 了解 [中间件](/guide/middleware) 如何拦截和处理请求
- 学习 [插件](/guide/plugins) 如何扩展框架能力
- 查看 [测试](/guide/testing) 如何对服务层进行单元测试
