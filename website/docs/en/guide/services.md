# Service layer

VextJS adopts a **layered architecture** and concentrates business logic on the service layer (Service Layer). Service files are placed in the `src/services/` directory, automatically scanned, instantiated and injected into `app.services` by the framework, and accessed through `app.services.xxx` in the routing handler.

## Design concept

```
Routing layer (routes) ← Parameter extraction + response return (thin layer)
   ↓
Services layer (services) ← Business logic (core)
   ↓
Data layer (models) ← Data access (provided through plugins)
```

- **Route handler** is only responsible for extracting parameters from the request, calling the service, and returning the response
- **Service layer** carries all business logic and is not aware of the HTTP protocol (does not access `req` / `res`)
- **Data layer** provided by plugins (such as database ORM), accessed through the `app` object

This layering enables:

-Business logic can be reused between different routes

- The service layer can be unit tested independently (not relying on HTTP)
- Switching the underlying Adapter does not affect the business code

## Basic writing method

### Service class

Each service file exports a **class**, and the constructor receives the `app` parameter:

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
    //Business logic...
    return {
      items: [],
      total: 0,
      page,
      limit,
    };
  }

  async findById(id: string) {
    //Business logic...
    const user = { id, name: "Alice", email: "alice@example.com" };
    return user;
  }

  async create(data: { name: string; email: string }) {
    this.app.logger.info({ data }, "Creating user");
    //Business logic...
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

### used in routing

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/", async (_req, res) => {
    // Access the injected service instance through app.services
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

## File naming and mapping

`service-loader` automatically mounts the service instance to the corresponding property of `app.services` according to the file path.

### Mapping rules

| File path                       | Access method                   | Description            |
| ------------------------------- | ------------------------------- | ---------------------- |
| `services/user.ts`              | `app.services.user`             | Flat naming            |
| `services/order.ts`             | `app.services.order`            | Flat naming            |
| `services/user-profile.ts`      | `app.services.userProfile`      | kebab-case → camelCase |
| `services/payment/stripe.ts`    | `app.services.payment.stripe`   | Nested namespaces      |
| `services/payment/alipay.ts`    | `app.services.payment.alipay`   | Nested namespaces      |
| `services/admin/user-manage.ts` | `app.services.admin.userManage` | Nesting + CamelCase    |

**Conversion Rules:**

1. The file path is relative to the `services/` directory, with the extension removed.
2. The file name is automatically converted from `kebab-case` to `camelCase`
3. Subdirectories are mapped to nested objects

### Nested service example

```
src/services/
├── user.ts → app.services.user
├── order.ts → app.services.order
└── payment/
    ├── stripe.ts → app.services.payment.stripe
    └── wechat-pay.ts → app.services.payment.wechatPay
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
    // Stripe API calls...
    return { paymentId: "pi_xxx", status: "pending" };
  }

  async refund(paymentId: string) {
    this.app.logger.info({ paymentId }, "Refunding Stripe payment");
    return { refundId: "re_xxx", status: "refunded" };
  }
}
```

```typescript
// Use nested services in routes
app.post("/pay", async (req, res) => {
  const result = await app.services.payment.stripe.createPayment(100, "usd");
  res.json(result);
});
```

## Service Hooks

Vext installs lightweight wrappers for instance methods loaded into `app.services`. When the service hook is not registered, the call will go directly to the original method; after registering the hook, you can observe the before and after calls and errors:

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

`service:beforeCall`, `service:afterCall` and `service:error` are all synchronous hooks. Do not return Promise in these handlers; if asynchronous reporting is required, it is recommended to put it in a queue or use log transmission that does not block the main call.

## Inter-service calls

Services can call each other. It is recommended to access on-demand (delayed access) in the \*\*method through `this.app.services` instead of directly referencing it in the constructor:

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
    // Call other services - deferred access through this.app.services
    const user = await this.app.services.user.findById(userId);
    if (!user) {
      this.app.throw(404, "user.not_found");
    }

    // Calculate price
    const total = await this.calculateTotal(items);

    // Call payment service
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
    //Business logic...
    return items.reduce((sum, item) => sum + item.quantity * 10, 0);
  }
}
```

::::warning avoid circular dependencies
`service-loader` has built-in circular dependency detection. If `ServiceA` and `ServiceB` depend on each other, the framework will report an error at startup.

**✅ DON'T DO** — Delay access in a method:

```typescript
export default class OrderService {
  constructor(private app: VextApp) {}

  async createOrder() {
    // ✅ The user service has been initialized when the method is called.
    const user = await this.app.services.user.findById("123");
  }
}
```

**❌ Wrong Practice** — Direct reference in the constructor:

```typescript
export default class OrderService {
  private userService: UserService;

  constructor(app: VextApp) {
    // ❌ When the constructor is executed, the user service may not have been initialized yet.
    this.userService = app.services.user;
  }
}
```

::::

## Use the capabilities provided by the plug-in

Capabilities injected by plugins via `app.extend()` are accessed in the service via `this.app`:

```typescript
// Assume that the redis plug-in has been injected via app.extend('redis', redis)
// src/services/user.ts
import type { VextApp } from "vextjs";

export default class UserService {
  private app: VextApp;

  constructor(app: VextApp) {
    this.app = app;
  }

  async findById(id: string) {
    //Check cache first
    const cached = await (this.app as any).redis.get(`user:${id}`);
    if (cached) return cached;

    // Cache miss, check database
    const user = await this.queryDatabase(id);

    // write to cache
    if (user) {
      await (this.app as any).redis.set(`user:${id}`, JSON.stringify(user));
    }

    return user;
  }

  private async queryDatabase(id: string) {
    // Database query logic...
    return { id, name: "Alice" };
  }
}
```

::::tip type tip
Use `declare module` to extend the `VextApp` interface to get full type hints:

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

After extending `this.app.redis`, you can get IDE auto-completion.
::::

## Use `app.throw()` to throw an error

HTTP errors can be thrown in the service layer through `this.app.throw()`. The framework will automatically capture and convert into a unified error response, eliminating the need for manual try-catch at the routing layer:

- When you need to actively return `404`, `409`, `401` and other clear HTTP semantics, use `this.app.throw(...)`
- When field-level validation details need to be returned, `VextValidationError` is thrown
- When an unexpected exception occurs, you can directly `throw new Error("...")`, and the framework will uniformly convert it to 500

```typescript
export default class UserService {
  constructor(private app: VextApp) {}

  async findById(id: string) {
    const user = await this.queryDatabase(id);
    if (!user) {
      // Throw it directly in the service, and the framework will handle it uniformly
      this.app.throw(404, "user.not_found");
    }
    return user;
  }

  async create(data: { name: string; email: string }) {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      this.app.throw(409, "Email has been registered", 10001);
    }
    //Create logic...
    return { id: crypto.randomUUID(), ...data };
  }

  private async queryDatabase(id: string) {
    return null; // simulation
  }

  private async findByEmail(email: string) {
    return null; // simulation
  }
}
```

If `throw new Error("...")` is directly inside the service, the framework will also catch it; this path represents an unknown runtime exception, rather than an actively designed HTTP error response. By default, the client will receive a safe `500 Internal Server Error`. In the development environment, the `stack` can be additionally exposed through `response.hideInternalErrors = false` to facilitate troubleshooting.

## Validate non-HTTP input in the service

Route entry parameters are first declared through `RouteOptions.validate`, and `req.valid()` is used in the handler to read the verified data. For non-HTTP inputs processed directly by the service, such as scheduled tasks, message queues, external callbacks or other service calls, you can reuse the current global validation engine through `this.app.getValidator()`.

`getValidator()` returns the validator based on schema-dsl by default; if the plug-in is replaced by Zod, Yup, etc. through `app.setValidator()`, the replaced validator will be obtained in the service.

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
    //Create logic...
    return { id: crypto.randomUUID(), ...data };
  }
}
```

::::tip

Do not directly `import "schema-dsl"` in service. Directly referencing schema-dsl will bypass the global replacement capability of `app.setValidator()`, causing service verification and route verification to use different engines.

::::

## Use `app.logger` to record logs

The service layer recommends logging structured logs through `this.app.logger`. Logs automatically carry requestId (propagated through AsyncLocalStorage context):

```typescript
export default class PaymentService {
  constructor(private app: VextApp) {}

  async processPayment(orderId: string, amount: number) {
    this.app.logger.info({ orderId, amount }, "Processing payment");
    try {
      // Call external payment API...
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

## Loading order and life cycle

### Loading time

In the `bootstrap` startup process, `service-loader` is executed in the following stages:

```
1. config → load configuration
2. locales → load language pack
3. plugins → execute plugin setup()
4. middlewares → scanning middleware
5. services → ⭐ Instantiate services (here)
6. routes → Register routes (app.services can be safely accessed in handler)
```

This means:

- ✅ `app.config` is accessible in the service constructor (loaded)
- ✅ `app.logger` can be accessed in the service constructor (already initialized)
- ✅ The ability to inject plugins can be accessed in the service constructor (the plugin has been setup)
- ⚠️ Pay attention to the order when accessing `app.services` in the service constructor (see the circular dependency chapter)
- ✅ All `app.services` can be safely accessed in the routing handler (all injections have been completed)

### Instantiation process

1. **Scanning** — Recursively scan all `.ts` / `.js` files in the `src/services/` directory
2. **Sort** — Sort alphabetically by file path (to ensure deterministic loading order)
3. **Instantiation** — Create instances of `new ServiceClass(app)` one by one
4. **Mount** — Mount the instance to the corresponding property of `app.services`
5. **Detection** — Perform circular dependency detection (optional, enabled by default)

### Exclusion rules

The following files will be automatically skipped:

- Test files: `*.test.ts`, `*.spec.ts`
- Files/directories starting with `_` or `.`
- `node_modules` directory

You can use the `_` prefix to create service-shared tool modules:

```
src/services/
├── _base.ts # Base class, will not be loaded as a service
├── _types.ts # Shared types
├── user.ts
└── order.ts
```

## Service layer best practices

### 1. Keep the service layer HTTP-agnostic

The service layer should not directly operate on `req` / `res` objects. If you need to request contextual information (such as the current user), pass it in as a parameter:

```typescript
// ✅ Correct — parameters passed in
async createOrder(userId: string, items: OrderItem[]) {
  // ...
}

// ❌ Error — directly manipulate the request object
async createOrder(req: VextRequest, res: VextResponse) {
  // service should not be HTTP aware
}
```

### 2. Single responsibility

Each service corresponds to a business area. Avoid putting logic from different domains in the same service:

```
services/
├── user.ts # User management
├── order.ts # Order management
├── notification.ts # Notification service
└── payment/
    ├── stripe.ts # Stripe payment
    └── wechat-pay.ts # WeChat payment
```

### 3. Use base classes to share common logic

For services with common behavior, you can create a base class (prefixed with `_` to prevent it from being loaded as a service):

```typescript
// src/services/_base.ts (will not be automatically loaded)
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
    return []; // Database query
  }

  private async countUsers() {
    return 0; // Count query
  }
}
```

### 4. TypeScript type declaration

Add a type declaration for `app.services` to get full IDE support:

It is recommended to use the generation command provided by the framework first:

```bash
vext typegen
```

This command will automatically generate the `VextServices` extension declaration in `.vext/types/services.generated.d.ts`, access the TypeScript project through `src/types/generated/index.d.ts`, and perform a round of tooling layer service dependency checking.

Starting from `0.3.7`, `vext dev` will also automatically perform the basic version of this step in preflight to ensure that the generated declaration in the development state is synchronized with the current `services` / `plugins` definition; if you need `--check`, `--write-manifest` or independent CI control, you should still run `vext typegen` explicitly.

If you also want to provide the service index, `app.extend()` aggregation results and dependency graph summary to the editor, CI or other tool chain for consumption, you can additionally execute:

```bash
vext typegen --write-manifest
```

The corresponding product will be written: `.vext/manifest/services.json`.If you need to handwrite or add a few advanced declarations, you can still keep the custom `.d.ts` file; the generated file and the handwritten file are isolated and will not overwrite each other.

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

Once added, calls like `app.services.user.findById()` will get full method signature hints and type checking.

## Next step

- Learn how [middleware](/guide/middleware) intercepts and handles requests
- Learn [plugins](/guide/plugins) how to extend framework capabilities
- See [Testing](/guide/testing) how to unit test the service layer
