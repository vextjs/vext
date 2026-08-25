# Database (MonSQLize)

VextJS has a built-in [MonSQLize](https://github.com/devcodex-labs/monSQLize) database plug-in, providing out-of-the-box MongoDB database support. Just add the `database` field in the configuration file, and the framework will automatically complete connection management, model loading and resource cleanup.

## Quick Start

### 1. Add database configuration

VextJS pins `monsqlize@3.3.0` as a direct runtime dependency, so a Vext
application does not need to install a second copy. Add `config.database` to
activate the built-in lifecycle.

```typescript
// src/config/default.ts
export default {
  port: 3000,

  database: {
    config: {
      uri: "mongodb://localhost:27017/myapp",
    },
  },
};
```

### 2. Use in service

```typescript
// src/services/user.ts
export class UserService {
  constructor(private app: any) {}

  async findById(userId: string) {
    return this.app.db.collection("users").findOne({ _id: userId });
  }

  async create(data: { name: string; email: string }) {
    return this.app.db.collection("users").insertOne(data);
  }
}
```

It's that simple! The framework automatically connects to the database when it starts and disconnects when it shuts down.

## Working principle

### Conditional loading

The MonSQLize plugin uses a **conditional loading** strategy: it is enabled only when `config.database` exists. Without database configuration, Vext skips plugin setup and does not install its database runtime or hooks.

```
bootstrap()
  → Check whether config.database exists
  → Yes → Create MonSQLize instance → Connect → Load Model → Mount app.db
  → No → Skip plugin setup
```

### Loading time

MonSQLize is loaded before user plugins, ensuring that `app.db` can be used safely in `setup()` of user plugins:

```
createApp(config)
  → Built-in MonSQLize plugin setup() ← here
  → User plugin plugin-loader ← app.db is available
  → middleware-loader
  → service-loader
  → router-loader
```

### Fail Fast

When the database connection fails, the plug-in will directly throw an error and terminate the startup - it will not let the application run in a state where the database is unavailable:

```
[monsqlize] connected successfully ← normal
[monsqlize] plugin ready

[monsqlize] Error: connect ECONNREFUSED 127.0.0.1:27017 ← Connection failed, startup terminated
```

## Configuration details

### Basic connection

```typescript
// src/config/default.ts
export default {
  database: {
    // Connection type (default 'url')
    type: "url",

    //Connection configuration
    config: {
      uri: "mongodb://localhost:27017/myapp",
    },
  },
};
```

### Replica set connection

```typescript
export default {
  database: {
    type: "replica",

    config: {
      hosts: ["mongo1:27017", "mongo2:27017", "mongo3:27017"],
      database: "myapp",
      replicaSet: "rs0",
      username: "admin",
      password: "secret",
      authSource: "admin",
    },
  },
};
```

### SRV connection (MongoDB Atlas)

```typescript
export default {
  database: {
    type: "srv",

    config: {
      host: "cluster0.abc123.mongodb.net",
      database: "myapp",
      username: "admin",
      password: "secret",
    },
  },
};
```

### Complete configuration items

| Configuration item    | Type                          | Default value            | Description                                                                                                                     |
| --------------------- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `type`                | `'url' \| 'replica' \| 'srv'` | `'url'`                  | connection type                                                                                                                 |
| `config`              | `object`                      | —                        | Connection parameters (url/hosts/host, etc.)                                                                                    |
| `maxTimeMS`           | `number`                      | `2000`                   | Global query timeout (milliseconds)                                                                                             |
| `findLimit`           | `number`                      | `10`                     | `find` returns the number of items by default                                                                                   |
| `findPageMaxLimit`    | `number`                      | `500`                    | Maximum paging limit                                                                                                            |
| `slowQueryMs`         | `number`                      | `500`                    | Slow query threshold (milliseconds)                                                                                             |
| `autoConvertObjectId` | `boolean \| object`           | —                        | Automatic ObjectId conversion                                                                                                   |
| `namespace`           | `{ scope: string }`           | `{ scope: 'database' }`  | cache namespace                                                                                                                 |
| `cursorSecret`        | `string`                      | —                        | Deep paged cursor encryption key                                                                                                |
| `useMemoryServer`     | `boolean`                     | `false`                  | Use in-memory database (for testing)                                                                                            |
| `logger`              | `'app' \| false`              | `'app'`                  | Log bridging (`'app'` uses app.logger)                                                                                          |
| `cache`               | `object`                      | —                        | Cache configuration (see below)                                                                                                 |
| `models`              | `object`                      | —                        | Model loading configuration (see below)                                                                                         |
| `databaseName`        | `string`                      | URI automatic extraction | Default database name (cross-database routing fallback value, extracted from the path segment of `config.uri` if not filled in) |
| `pools`               | `array`                       | —                        | Multiple connection pool configuration                                                                                          |
| `poolStrategy`        | `string`                      | `'auto'`                 | Connection pool selection strategy                                                                                              |
| `slowQueryLog`        | `object`                      | —                        | Slow query persistence configuration                                                                                            |
| `monsqlizeOptions`    | `VextMonSQLizeOptions`        | —                        | Controlled advanced MonSQLize options; connection and Vext lifecycle keys remain protected                                      |

### Controlled advanced MonSQLize options

Use `database.monsqlizeOptions` when an application needs an upstream
constructor capability that does not replace a Vext-owned connection or
lifecycle setting:

```typescript
import type { VextConfig } from "vextjs";

export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },
    monsqlizeOptions: {
      findMaxLimit: 2_000,
      findMaxSkip: 20_000,
      transaction: { enableRetry: true, maxRetries: 2 },
      autoIndex: { enabled: true, emitEvents: true },
      cacheAutoInvalidate: true,
      writePathPolicy: { default: "model-only" },
    },
  },
} satisfies VextConfig;
```

The public `VextMonSQLizeOptions` type is picked directly from the pinned
`monsqlize@3.3.0` `MonSQLizeOptions`. The runtime uses the same allowlist:

- `schemaDsl`
- `poolFallback`, `maxPoolsCount`
- `sync`, `transaction`
- `findMaxLimit`, `findMaxSkip`
- `requireCursorSecret`, `cursorSecretWarning`, `cursorTypes`,
  `cursorValueNormalizer`
- `log`, `countQueue`, `autoIndex`, `cacheAutoInvalidate`, `writePathPolicy`

Vext rejects unknown keys and these Vext-owned keys before the MonSQLize
constructor runs: `type`, `databaseName`, `database`, `config`, `cache`,
`logger`, `pools`, `poolStrategy`, `maxTimeMS`, `findLimit`,
`findPageMaxLimit`, `slowQueryMs`, `slowQueryLog`, `autoConvertObjectId`,
`namespace`, `cursorSecret`, and `models`. Configure those through their
first-class `database.*` fields so connection normalization, logging, model
loading, and shutdown remain deterministic.

### Cache configuration

MonSQLize supports two levels of cache: L1 memory LRU + L2 Redis (optional).

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },

    cache: {
      // L1 memory cache (enabled by default)
      memory: {
        enabled: true,
        maxSize: 1000, // Maximum number of cached items
        ttl: 300, //Default TTL (seconds)
      },

      // L2 Redis cache (optional)
      redis: {
        enabled: true,
        uri: "redis://localhost:6379",
        prefix: "myapp:cache:",
        ttl: 600,
      },
    },
  },
};
```

Use `uri` as the Redis cache connection field. `url` is kept only as a compatibility alias for older configs; new projects should use `uri`.

### Multiple environment configuration

Use VextJS's three-tier configuration merging mechanism to configure different databases for different environments:

```typescript
// src/config/default.ts — basic configuration
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },
    findLimit: 10,
    slowQueryMs: 500,
  },
};
```

```typescript
// src/config/production.ts — production environment coverage
export default {
  database: {
    type: "srv",
    config: {
      host: process.env.MONGODB_HOST,
      database: process.env.MONGODB_DATABASE,
      username: process.env.MONGODB_USER,
      password: process.env.MONGODB_PASSWORD,
    },
    slowQueryMs: 200, // The slow query threshold in the production environment is lower
  },
};
```

```typescript
// src/config/test.ts — The test environment uses an in-memory database
export default {
  database: {
    useMemoryServer: true, // use mongodb-memory-server-core
  },
};
```

## app.db — raw MonSQLize instance

After initialization, `app.db` is the exact raw `MonSQLize` instance created by
the built-in plugin. Vext does not put it behind a facade or Proxy. It only
decorates that same object with a read-only `client` getter and narrow
soft-delete result compatibility, so upstream instance methods such as
`withTransaction()`, `on()`, `sync()`, `pool()`, and `scopedModel()` remain
available from the single `app.db` entry point.

### collection(name)

Get the collection operation object, this is the most commonly used API:

```typescript
// Get the users collection
const usersCol = app.db.collection("users");

// Query
const user = await usersCol.findOne({ email: "test@example.com" });
const users = await usersCol.find({ role: "admin" });

// insert
const result = await usersCol.insertOne({
  name: "Zhang San",
  email: "zhangsan@example.com",
});

// update
await usersCol.updateOne({ _id: userId }, { $set: { name: "Li Si" } });

// delete
await usersCol.deleteOne({ _id: userId });

// aggregation
const stats = await usersCol.aggregate([
  { $group: { _id: "$role", count: { $sum: 1 } } },
]);

// count
const total = await usersCol.countDocuments({ role: "admin" });
```

### model(name)

Get the registered Model operation object (you need to define the Model first, see the Model chapter below):

```typescript
// src/models/user.ts exports { collection: "users", ... }, so the root key is
// exactly "users". The lookup does not singularize or PascalCase it.
const User = app.db.model("users");

// Model provides more advanced API (paging, caching, verification, etc.)
const result = await User.findPage({ role: "admin" }, { page: 1, limit: 20 });
```

### use(dbName)

Switch to the specified database (default connection pool), suitable for single connection and multiple database scenarios:

```typescript
//Access the invoices collection of the billing database
const billing = app.db.use("billing");
const invoice = await billing.collection("invoices").findOne({ _id: id });

// Can also be called directly in a chain
const invoice = await app.db
  .use("billing")
  .collection("invoices")
  .findOne({ _id: id });

// use() changes the database scope; it does not rewrite the registry key.
// A depth-1 file such as models/billing/invoice.ts is registered as BillingInvoice.
const Invoice = app.db.use("billing").model("BillingInvoice");
```

### pool(poolName)

Switch to the specified connection pool and return accessors containing `collection` / `model` / `use`:

```typescript
//Access the orders collection of cn pool
const order = await app.db.pool("cn").collection("orders").findOne({ _id: id });

// Direct Model access in a pool still uses the exact registered key.
const Invoice = app.db.pool("billing").model("BillingInvoice");
// A short key works only when the Model explicitly declares key: "Invoice".
const InvoiceAlias = app.db.pool("billing").model("Invoice");

// cn pool + billing library (collection)
const invoice = await app.db
  .pool("cn")
  .use("billing")
  .collection("invoices")
  .findOne({});

// cn pool + billing database + exact Model registry key
const InvoiceCn = app.db.pool("cn").use("billing").model("BillingInvoice");

// Depth-2 model directory (models/cn/billing/order.ts): Registration key = CnBillingOrder
// Scope accessors do not add prefixes or fall back to another key.
const Order1 = app.db.model("CnBillingOrder"); // Complete key
const Order2 = app.db.pool("cn").use("billing").model("CnBillingOrder");
// Order1 and Order2 resolve the same registered Model in different explicit scopes.
```

> ⚠️ `pool()` will immediately check whether the connection pool exists before returning an accessor. If no pool manager is configured, it throws `NO_POOL_MANAGER`. If the named pool cannot be found, it throws `POOL_NOT_FOUND` (`err.available` contains the list of available pools). Model / collection / use are only reachable after this check succeeds.

> ℹ️ **The `dbName` in `pool().use(dbName)` will overwrite the value of `connection.database` in the Model definition**. For example, Model defines `connection.database: "billing"`, and when accessed through `pool("cn").use("archive")`, the actual query will use the `archive` database instead of `billing`.
> To resolve an exact key while overriding the database/connection pool explicitly, use `app.db.scopedModel(key, { pool, database })`.

### client

Get the original MongoDB Client instance (for advanced scenarios such as transactions):

```typescript
const session = app.db.client.startSession();
try {
  await session.withTransaction(async () => {
    await app.db
      .collection("accounts")
      .updateOne({ _id: fromId }, { $inc: { balance: -amount } }, { session });
    await app.db
      .collection("accounts")
      .updateOne({ _id: toId }, { $inc: { balance: amount } }, { session });
  });
} finally {
  await session.endSession();
}
```

## Full MonSQLize API on app.db

`app.db` is the raw `MonSQLize` instance, not a reduced Vext wrapper. There is
no separate `app.monsqlize` entry point in v2.

```typescript
const monsqlize = app.db;
if (!monsqlize) throw new Error("Database is not configured");

// Full instance APIs stay available from app.db.
await monsqlize.withTransaction(async (transaction) => {
  // ...
});
monsqlize.on("slow-query", (info) => {
  app.logger.warn({ ...info }, "Slow query detected");
});

// app.db returns upstream Collection / Model instances.
const hits = await app.db?.collection("products").vectorSearch({
  index: "product_embedding",
  path: "embedding",
  queryVector: embedding,
  numCandidates: 100,
  limit: 10,
});

const Product = app.db?.model("Product");
const usage = await Product?.checkRelationUsage({ _id: productId });
await Product?.deleteOneWithRelations({ _id: productId });
```

:::tip
Use the single `app.db` entry point for collections, Models, transactions,
pools, sync, events, diagnostics, and management APIs. Vector Search requires a
compatible MongoDB deployment and a pre-created index. Relation-protected
deletion only covers registered, declared relations; inspect the returned
coverage before treating it as complete.
:::

Vext's root package exports Vext-owned integration types such as
`VextMonSQLizeOptions`; it does not mirror every upstream symbol. Import
MonSQLize-specific classes and types from `monsqlize` when you need them.

### Typed descriptors for manual registration (3.3.0)

MonSQLize 3.3.0 can infer a Model document type from an object-literal schema.
If application code imports this package-level API, declare `monsqlize@3.3.0`
as an explicit application dependency instead of relying on dependency
hoisting. Register the descriptor once before resolving it from the raw
instance:

```typescript
import { defineModel, Model } from "monsqlize";
import type { VextApp } from "vextjs";

const UserDescriptor = defineModel("users", {
  schema: {
    email: "email!",
    age: "number?",
  },
});

Model.define(UserDescriptor);

export async function findUser(app: VextApp, email: string) {
  const User = app.db?.model(UserDescriptor);
  return User?.findOne({ email }); // email: string; age?: number
}
```

This is an explicit upstream registration path. Do not export the descriptor
as the default value of a `src/models/*` file: Vext's automatic Model loader
continues to accept definition objects and derives the registry key using the
rules below. Because `app.db` is the raw instance, manual code may pass either
an exact string key or an upstream typed descriptor to `app.db.model()`.

## Model definition

Model is an encapsulation of collection operations and provides advanced capabilities such as field verification, hooks, and virtual fields.

### Create Model file

> The MonSQLize Model layer integrates **schema-dsl**, and the schema field supports DSL concise syntax.

#### Recommended writing method: schema-dsl concise syntax + options.timestamps

```typescript
// src/models/user.ts
export default {
  collection: "users",

  // schema-dsl concise syntax
  schema: {
    name: "string:1-50!", // Required string, 1~50 characters
    email: "email!", // required, email format
    role: "admin|editor|viewer", // enumeration value
    avatar: "string", // optional string
  },

  // index
  indexes: [
    { key: { email: 1 }, options: { unique: true } },
    { key: { role: 1, createdAt: -1 } },
  ],

  // Use options.timestamps to automatically manage createdAt/updatedAt
  options: {
    timestamps: true,
  },
};
```

#### Object format (complex scenes)

When a field requires advanced capabilities such as `default` function, nested schema, etc., the object format can be used:

```typescript
// src/models/user.ts
export default {
  collection: "users",

  //Field definition (object format)
  schema: {
    name: { type: "string", required: true },
    email: { type: "string", required: true, unique: true },
    role: {
      type: "string",
      enum: ["admin", "editor", "viewer"],
      default: "viewer",
    },
    avatar: { type: "string" },
  },

  // index
  indexes: [
    { key: { email: 1 }, options: { unique: true } },
    { key: { role: 1, createdAt: -1 } },
  ],

  // Hook (only for custom logic other than timestamps)
  hooks: {
    beforeInsert(context: { data?: any }) {
      // Custom logic example
      const doc = context.data;
      if (!doc?.name) return;
      doc.slug = doc.name.toLowerCase().replace(/\s+/g, "-");
    },
  },

  options: {
    timestamps: true,
  },
};
```

### Model options

| Options      | Type                | Default     | Description                                   |
| ------------ | ------------------- | ----------- | --------------------------------------------- |
| `timestamps` | `boolean \| object` | `undefined` | Automatic management createdAt/updatedAt      |
| `softDelete` | `boolean \| object` | `undefined` | Soft delete support                           |
| `version`    | `boolean \| object` | `undefined` | Optimistic locking version number             |
| `validate`   | `boolean`           | `true`      | Schema validation switch during insert/update |

Object-style `hooks` follow monSQLize and receive a `context` argument; write payloads are commonly available from `context.data`. Use the `(model) => ({ ... })` factory form when the hook needs access to the Model instance.

#### timestamps configuration

```typescript
// Simple mode: automatically add createdAt + updatedAt
options: { timestamps: true }

//Custom field name
options: { timestamps: { createdAt: 'created_time', updatedAt: 'updated_time' } }

// Only enable createdAt (log class collection)
options: { timestamps: { createdAt: true, updatedAt: false } }
```

### `key` alias (quick access across connection pools)

When the Model collection name contains a prefix (such as `BillingInvoice`), you can define a `key` alias and access it quickly through the short name:

```typescript
// src/models/billing-invoice.ts
export default {
  collection: "BillingInvoice", // MongoDB actual collection name
  key: "Invoice", // short name alias (optional)

  schema: {
    amount: "number!",
    currency: "CNY|USD|EUR",
    status: "draft|pending|paid",
  },

  // Bind to the specified connection pool + database (make app.db.model() routing correct)
  connection: {
    pool: "billing",
    database: "billing",
  },
};
```

After registration, both keys can be used:

```typescript
app.db.model("BillingInvoice"); // By collection name (full path)
app.db.model("Invoice"); // By alias (short name)

// Scope changes do not transform either exact key.
app.db.pool("billing").model("BillingInvoice");
app.db.pool("billing").model("Invoice");
```

> **Note**: If the alias conflicts with other registered Models, the alias registration will be skipped (existing registration will not be overwritten), and only the collection name is valid.

Model files are placed in the `src/models/` directory, and the plug-in will automatically scan and register:

```
src/
├── models/
│ ├── user.ts → Model name: 'User'
│ ├── order.ts → Model name: 'Order'
│ ├── product-item.ts → Model Name: 'ProductItem'
│ └── index.ts → Model name: 'Index' unless collection/name overrides it
```

Rules for inferring Model names from file names:

- `user.ts` → `'User'` (first letter is capitalized)
- `order-item.ts` → `'OrderItem'` (kebab-case → PascalCase)
- `user_role.ts` → `'UserRole'' (snake_case → PascalCase)
- `.test.ts` / `.spec.ts` / `.d.ts` → skip
- files prefixed with `_` → skip
- `index.ts` is a normal Model file; at root it infers `'Index'`

### Directory routing (automatically binds connection pool/database)

Placing the Model file in a subdirectory of `models/` allows vext to automatically infer the connection pool and database it belongs to, without having to manually fill in the `connection` field in each file.

**Directory depth rules:**

| Directory structure              | Registration key name                          | Automatic injection                                 |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `models/order.ts`                | `Order` (or `def.collection` / `def.name`)     | None (no change in behavior)                        |
| `models/billing/invoice.ts`      | `BillingInvoice`                               | `connection: { database: 'billing' }`               |
| `models/main/billing/invoice.ts` | `MainBillingInvoice`                           | `connection: { pool: 'main', database: 'billing' }` |
| `models/a/b/c/invoice.ts`        | ❌ skip (max depth 2 exceeded, output warning) | —                                                   |

> 💡 When the directory depth exceeds 2 levels, vext will output a warning log and skip the file. For more complex routing, explicitly set the `connection` field in the Model file.

**Example: Split Model by Business Area**

```
src/models/
├── order.ts → Register as 'Order' (default database)
├── billing/
│ ├── invoice.ts → registered as 'BillingInvoice', database: 'billing'
│ └── payment.ts → Registered as 'BillingPayment', database: 'billing'
└── main/
    └── billing/
        └── invoice.ts → Registered as 'MainBillingInvoice', pool: 'main', database: 'billing'
```

```typescript
// src/models/billing/invoice.ts
// No need to manually write connection - automatically inferred from directory path
export default {
  schema: {
    amount: "number!",
    currency: "CNY|USD|EUR",
    status: "draft|pending|paid",
  },
} satisfies VextModelDefinition;

// The effect is equivalent to explicit configuration:
// export default {
// name: "invoice",
// connection: { database: "billing" },
// schema: { ... },
// };
```

**Injection priority:** If the Model file has explicitly set `connection` or `name`/`collection`, the explicit value will be used first and directory routing will not override it.

### Model loading configuration

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },

    models: {
      // Model definition file directory (relative to src/, default 'models')
      dir: "models",

      // Whether to automatically register (default true)
      autoRegister: true,

      // Discovery policy: strict (default) or lenient
      validation: "strict",

      // External shared Model package (microservice scenario)
      sharedPackage: "@myproject/shared-models",
    },
  },
};
```

`validation: "strict"` completes discovery, imports, resolution, and validation before mutating the global Model registry. Any invalid definition, collision, or commit failure aborts startup and rolls back the whole registration plan. Explicit `"lenient"` mode warns and skips invalid discovery inputs only; registry collisions and commit failures still fail closed. Registrations are owned by the application and released on close without clearing another application's Models.

### Shared Model package (microservice scenario)

In a microservice architecture, multiple services may share the same set of Model definitions. Loading from npm package via `sharedPackage`:

```typescript
//Loading order: shared package first → then local models/
// Local Model can overwrite the Model with the same name in the shared package
models: {
  sharedPackage: '@myproject/shared-models',
  dir: 'models', // Local Model (can override shared)
}
```

The shared package must default-export a model-definition object such as `{ User: { schema: ... } }`. Callback-style `registerModels()` packages are rejected because Vext cannot preflight, attribute ownership, or roll back keys registered through an opaque callback.

## Used in services

### Basic CRUD service

```typescript
// src/services/user.ts
export class UserService {
  private logger;

  constructor(private app: any) {
    this.logger = app.logger.child({ service: "UserService" });
  }

  async findById(id: string) {
    this.logger.debug({ id }, "Finding user by ID");
    const user = await this.app.db.collection("users").findOne({ _id: id });

    if (!user) {
      this.app.throw(404, "User does not exist");
    }

    return user;
  }

  async findAll(
    options: { page?: number; limit?: number; role?: string } = {},
  ) {
    const { page = 1, limit = 20, role } = options;
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.app.db.collection("users").find(filter, { skip, limit }),
      this.app.db.collection("users").countDocuments(filter),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async create(data: { name: string; email: string; role?: string }) {
    // Check email uniqueness
    const existing = await this.app.db.collection("users").findOne({
      email: data.email,
    });
    if (existing) {
      this.app.throw(409, "Email has been registered", "EMAIL_EXISTS");
    }

    const doc = {
      ...data,
      role: data.role ?? "viewer",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.app.db.collection("users").insertOne(doc);
    this.logger.info(
      { id: result.insertedId, email: data.email },
      "User created",
    );

    return { id: result.insertedId, ...doc };
  }

  async update(
    id: string,
    data: Partial<{ name: string; email: string; role: string }>,
  ) {
    const result = await this.app.db
      .collection("users")
      .updateOne({ _id: id }, { $set: { ...data, updatedAt: new Date() } });

    if (result.matchedCount === 0) {
      this.app.throw(404, "User does not exist");
    }

    return this.findById(id);
  }

  async delete(id: string) {
    const result = await this.app.db.collection("users").deleteOne({ _id: id });

    if (result.deletedCount === 0) {
      this.app.throw(404, "User does not exist");
    }

    this.logger.info({ id }, "User deleted");
  }
}
```

### Used in conjunction with routing

```typescript
// src/routes/users.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/users",
    {
      validate: {
        query: {
          page: "number:1-",
          limit: "number:1-100",
          role: "admin|editor|viewer",
        },
      },
      docs: { summary: "Get user list" },
    },
    async (req, res) => {
      const { page, limit, role } = req.valid("query");
      const result = await app.services.user.findAll({ page, limit, role });
      res.json(result);
    },
  );

  app.get(
    "/users/:id",
    {
      validate: { param: { id: "string!" } },
      docs: { summary: "Get user details" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const user = await app.services.user.findById(id);
      res.json(user);
    },
  );

  app.post(
    "/users",
    {
      validate: {
        body: {
          name: "string:1-50!",
          email: "email!",
          role: "admin|editor|viewer",
        },
      },
      docs: { summary: "Create User" },
    },
    async (req, res) => {
      const data = req.valid("body");
      const user = await app.services.user.create(data);
      res.json(user, 201);
    },
  );

  app.put(
    "/users/:id",
    {
      validate: {
        param: { id: "string!" },
        body: {
          name: "string:1-50?",
          email: "email?",
          role: "admin|editor|viewer",
        },
      },
      docs: { summary: "Update Users" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      const data = req.valid("body");
      const user = await app.services.user.update(id, data);
      res.json(user);
    },
  );
  app.delete(
    "/users/:id",
    {
      validate: { param: { id: "string!" } },
      docs: { summary: "Delete User" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.json({ success: true });
    },
  );
});
```

## Used in plugins

Custom plugins can be executed after MonSQLize is initialized via `dependencies`:

```typescript
// src/plugins/seed-data.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "seed-data",

  async setup(app) {
    // MonSQLize has been initialized when the plug-in is loaded, and app.db is available
    if (!app.db) {
      app.logger.debug("[seed-data] No database configured, skipping");
      return;
    }

    const count = await app.db.collection("users").countDocuments({});
    if (count === 0) {
      app.logger.info("[seed-data] Seeding initial admin user...");
      await app.db.collection("users").insertOne({
        name: "Admin",
        email: "admin@example.com",
        role: "admin",
        createdAt: new Date(),
      });
      app.logger.info("[seed-data] Admin user seeded");
    }
  },
});
```

## Used in testing

### Use in-memory database

Use mongodb-memory-server-core to run an in-memory database in a test environment without an external MongoDB instance:

```bash
npm install -D mongodb-memory-server-core
```

Vext uses the core package to avoid the `mongodb-memory-server` wrapper triggering binary downloads during the `npm install` phase. The MongoDB binary may still be downloaded when the test is started for the first time; it is recommended to set `MONGOMS_DOWNLOAD_DIR=.cache/mongodb-binaries` and `MONGOMS_PREFER_GLOBAL_PATH=false` in CI, and cache the directory; after the cache hit, `MONGOMS_RUNTIME_DOWNLOAD=false` can be used to verify that it will not be downloaded again.

```typescript
// src/config/test.ts
export default {
  database: {
    useMemoryServer: true,
  },
};
```

### Test example

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "vextjs/testing";

describe("UserService", () => {
  let app;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should create a user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users",
      body: { name: "Zhang San", email: "zhangsan@test.com" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("Zhang San");
  });

  it("should reject duplicate email", async () => {
    await app.inject({
      method: "POST",
      url: "/users",
      body: { name: "Zhang San", email: "dup@test.com" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/users",
      body: { name: "Li Si", email: "dup@test.com" },
    });

    expect(res.statusCode).toBe(409);
  });
});
```

## Slow query monitoring

MonSQLize has built-in slow query detection. Automatically print a warning log when the query takes more than the `slowQueryMs` threshold:

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },
    slowQueryMs: 200, // Queries exceeding 200ms will generate a warning

    // Optional: persist slow query records to a dedicated collection
    slowQueryLog: {
      enabled: true,
      collection: "_slow_queries",
    },
  },
};
```

Example of log output:

```
[14:23:05.123] WARN [monsqlize] Slow query: users.find({role:"admin"}) 523ms
```

## Model hot reload (development mode)

In the `vext dev` development mode, modifying the Model definition file in the `src/models/` directory will automatically trigger **Tier 2 soft reload**, and the framework will reload the changed Model definition without the need to manually restart the server.

### Working principle

```
Modify src/models/item.ts
  ↓
esbuild recompile → dist/models/item.js
  ↓
model-reloader detected invalidated files
  ↓
Build and validate the complete replacement plan
  ↓
Atomically replace owned definitions with a rollback journal
  ↓
New requests use new Model definition
```

### Overloading behavior description

| Scene                                 | Behavior                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Modify schema field type              | Use new schema validation rules for next write                                                                                         |
| Modify hooks                          | New hooks will take effect immediately for subsequent operations                                                                       |
| Modify indexes                        | Index changes require a cold restart to be synchronized to MongoDB                                                                     |
| Reload failure (such as syntax error) | Automatically roll back to the old definition and the service continues to run                                                         |
| Concurrent Requests                   | Requests being processed during reload are completed using the old definition, and new requests are completed using the new definition |

### Log output example

After saving `src/models/item.ts`, the terminal will output:

```
[vext dev] 1 file(s) changed:
  🟢 src/models/item.ts (modify)
[vext dev] source change detected → soft reload [T1:code]...
[hot-reload] model "items" reloaded
[hot-reload] [OK] 48ms [T1:code] (compile:3ms cache:2ms i18n:0ms mw:5ms svc:8ms model:3ms route:25ms swap:2ms) [12 modules evicted] #3
```

Note the `model:3ms` timing segment in the log, which indicates the time it takes to reload the Model.

:::tip Rollback guarantee
If there is a problem with the new Model definition (for example, the schema definition throws an exception), the framework will automatically re-register the old definition to ensure that the service is not interrupted. After fixing the code and saving it, the reload will trigger again.
:::

:::info framework internal mechanism
`Model.redefine()` / `Model.undefine()` is a native Model API provided by monSQLize, which is automatically called by the vext framework during the hot reload process, and users do not need to call it manually.
:::

## Graceful shutdown

The MonSQLize plugin registers the database connection closing hook in `app.onClose()`. When an application receives a `SIGTERM` / `SIGINT` signal:

1. Stop accepting new requests
2. Wait for the in-flight request to complete
3. Execute `onClose` hook (LIFO order)
4. MonSQLize closes the database connection
5. Process exits

No need to manually manage connection closures.

## Next step

- Understand the three-tier merging mechanism and environment coverage in [Configuration](/guide/configuration)
- See [plugins](/guide/plugins) how to extend the framework through `definePlugin()`
- Learn how to use `createTestApp()` for integration testing in [Testing](/guide/testing)
- Explore [app.fetch built-in HTTP client](/guide/fetch) to call other services in microservices

## Migration Guide (v0.2.x → v0.3.0)

### B1: `app.db.db()` has been removed

Old usage (v0.2.x, runtime bug - monSQLize does not provide `db()` method):

```typescript
// ❌ v0.2.x — Will actually report an error when running
const logsDb = app.db.db("logs");
```

New usage (v0.3.0):

```typescript
// ✅ v0.3.0 — Switch database (default connection pool)
const logsDb = app.db.use("logs");

// If you need to switch the connection pool at the same time
const logsDb = app.db.pool("cn").use("logs");
```

### B2: `app.db.use()` becomes single parameter

Old usage (if you want to extend it by yourself and pass in two parameters):

```typescript
// ❌ v0.2.x non-standard usage
app.db.use("cn", "billing");
```

New usage:

```typescript
// ✅ v0.3.0 — Switch connection pool first, then switch database
app.db.pool("cn").use("billing");
```
