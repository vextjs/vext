# 数据库 (MonSQLize)

VextJS 内置了 [MonSQLize](https://github.com/devcodex-labs/monSQLize) 数据库插件，提供开箱即用的 MongoDB 数据库支持。只需在配置文件中添加 `database` 字段，框架会自动完成连接管理、Model 加载和资源清理。

## 快速开始

### 1. 添加数据库配置

VextJS 已将 `monsqlize@3.3.0` 固定为直接运行时依赖，Vext 应用不需要再安装
第二份。添加 `config.database` 即可启用内置生命周期。

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

### 2. 在服务中使用

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

就这么简单！框架会在启动时自动连接数据库，在关闭时自动断开连接。

## 工作原理

### 条件加载

MonSQLize 插件采用**条件加载**策略：仅当 `config.database` 存在时才会启用。没有数据库配置时，Vext 会跳过插件 setup，不安装数据库运行时与相关 hook。

```
bootstrap()
  → 检测 config.database 是否存在
  → 是 → 创建 MonSQLize 实例 → 连接 → 加载 Model → 挂载 app.db
  → 否 → 跳过插件 setup
```

### 加载时机

MonSQLize 在**用户插件之前**加载，确保用户插件的 `setup()` 中可以安全使用 `app.db`：

```
createApp(config)
  → 内置 MonSQLize 插件 setup()    ← 在这里
  → 用户插件 plugin-loader          ← app.db 已可用
  → middleware-loader
  → service-loader
  → router-loader
```

### 失败即终止 (Fail Fast)

数据库连接失败时，插件会直接抛出错误并终止启动——不会让应用在数据库不可用的状态下运行：

```
[monsqlize] connected successfully     ← 正常
[monsqlize] plugin ready

[monsqlize] Error: connect ECONNREFUSED 127.0.0.1:27017  ← 连接失败，启动终止
```

## 配置详解

### 基础连接

```typescript
// src/config/default.ts
export default {
  database: {
    // 连接类型（默认 'url'）
    type: "url",

    // 连接配置
    config: {
      uri: "mongodb://localhost:27017/myapp",
    },
  },
};
```

### 副本集连接

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

### SRV 连接（MongoDB Atlas）

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

### 完整配置项

| 配置项                | 类型                          | 默认值                  | 说明                                                               |
| --------------------- | ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `type`                | `'url' \| 'replica' \| 'srv'` | `'url'`                 | 连接类型                                                           |
| `config`              | `object`                      | —                       | 连接参数（url / hosts / host 等）                                  |
| `maxTimeMS`           | `number`                      | `2000`                  | 全局查询超时（毫秒）                                               |
| `findLimit`           | `number`                      | `10`                    | `find` 默认返回条数                                                |
| `findPageMaxLimit`    | `number`                      | `500`                   | 分页最大 limit                                                     |
| `slowQueryMs`         | `number`                      | `500`                   | 慢查询阈值（毫秒）                                                 |
| `autoConvertObjectId` | `boolean \| object`           | —                       | 自动 ObjectId 转换                                                 |
| `namespace`           | `{ scope: string }`           | `{ scope: 'database' }` | 缓存命名空间                                                       |
| `cursorSecret`        | `string`                      | —                       | 深分页游标加密密钥                                                 |
| `useMemoryServer`     | `boolean`                     | `false`                 | 使用内存数据库（测试用）                                           |
| `logger`              | `'app' \| false`              | `'app'`                 | 日志桥接（`'app'` 使用 app.logger）                                |
| `cache`               | `object`                      | —                       | 缓存配置（见下方）                                                 |
| `models`              | `object`                      | —                       | Model 加载配置（见下方）                                           |
| `databaseName`        | `string`                      | URI 自动提取            | 默认数据库名（跨库路由回退值，不填时从 `config.uri` 的路径段提取） |
| `pools`               | `array`                       | —                       | 多连接池配置                                                       |
| `poolStrategy`        | `string`                      | `'auto'`                | 连接池选择策略                                                     |
| `slowQueryLog`        | `object`                      | —                       | 慢查询持久化配置                                                   |
| `monsqlizeOptions`    | `VextMonSQLizeOptions`        | —                       | 受控的 MonSQLize 高级配置；连接与 Vext 生命周期相关字段仍受保护    |

### 受控的 MonSQLize 高级配置

应用需要上游构造能力、但不希望替换 Vext 所有的连接或生命周期配置时，使用
`database.monsqlizeOptions`：

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

公开类型 `VextMonSQLizeOptions` 直接从固定的 `monsqlize@3.3.0`
`MonSQLizeOptions` 中取型；运行时使用同一 allowlist：

- `schemaDsl`
- `poolFallback`、`maxPoolsCount`
- `sync`、`transaction`
- `findMaxLimit`、`findMaxSkip`
- `requireCursorSecret`、`cursorSecretWarning`、`cursorTypes`、
  `cursorValueNormalizer`
- `log`、`countQueue`、`autoIndex`、`cacheAutoInvalidate`、`writePathPolicy`

Vext 会在调用 MonSQLize 构造函数前拒绝未知字段，以及这些由 Vext 管理的字段：
`type`、`databaseName`、`database`、`config`、`cache`、`logger`、
`pools`、`poolStrategy`、`maxTimeMS`、`findLimit`、
`findPageMaxLimit`、`slowQueryMs`、`slowQueryLog`、
`autoConvertObjectId`、`namespace`、`cursorSecret`、`models`。请继续通过
一等 `database.*` 字段配置它们，以保持连接归一化、日志、Model 加载与关闭流程
可预测。

### 缓存配置

MonSQLize 支持两级缓存：L1 内存 LRU + L2 Redis（可选）。

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },

    cache: {
      // L1 内存缓存（默认开启）
      memory: {
        enabled: true,
        maxSize: 1000, // 最大缓存条数
        ttl: 300, // 默认 TTL（秒）
      },

      // L2 Redis 缓存（可选）
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

Redis 缓存连接字段以 `uri` 为准；`url` 仅作为旧配置兼容别名保留，新项目建议统一使用 `uri`。

### 多环境配置

利用 VextJS 的三层配置合并机制，为不同环境配置不同的数据库：

```typescript
// src/config/default.ts — 基础配置
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },
    findLimit: 10,
    slowQueryMs: 500,
  },
};
```

```typescript
// src/config/production.ts — 生产环境覆盖
export default {
  database: {
    type: "srv",
    config: {
      host: process.env.MONGODB_HOST,
      database: process.env.MONGODB_DATABASE,
      username: process.env.MONGODB_USER,
      password: process.env.MONGODB_PASSWORD,
    },
    slowQueryMs: 200, // 生产环境慢查询阈值更低
  },
};
```

```typescript
// src/config/test.ts — 测试环境使用内存数据库
export default {
  database: {
    useMemoryServer: true, // 使用 mongodb-memory-server-core
  },
};
```

## app.db — 原始 MonSQLize 实例

插件初始化成功后，`app.db` 就是内置插件创建的同一个原始 `MonSQLize` 实例，
Vext 不再增加 facade 或 Proxy。框架只在该对象上窄幅补充只读 `client` getter 和
软删除返回值兼容，因此 `withTransaction()`、`on()`、`sync()`、`pool()`、
`scopedModel()` 等上游实例能力都从唯一入口 `app.db` 访问。

### collection(name)

获取集合操作对象，这是最常用的 API：

```typescript
// 获取 users 集合
const usersCol = app.db.collection("users");

// 查询
const user = await usersCol.findOne({ email: "test@example.com" });
const users = await usersCol.find({ role: "admin" });

// 插入
const result = await usersCol.insertOne({
  name: "张三",
  email: "zhangsan@example.com",
});

// 更新
await usersCol.updateOne({ _id: userId }, { $set: { name: "李四" } });

// 删除
await usersCol.deleteOne({ _id: userId });

// 聚合
const stats = await usersCol.aggregate([
  { $group: { _id: "$role", count: { $sum: 1 } } },
]);

// 计数
const total = await usersCol.countDocuments({ role: "admin" });
```

### model(name)

获取已注册的 Model 操作对象（需先定义 Model，见下方 Model 章节）：

```typescript
// src/models/user.ts 导出 { collection: "users", ... } 时，根目录注册键
// 就是精确的 "users"，不会自动单数化或转为 PascalCase。
const User = app.db.model("users");

// Model 提供更高级的 API（分页、缓存、校验等）
const result = await User.findPage({ role: "admin" }, { page: 1, limit: 20 });
```

### use(dbName)

切换到指定数据库（默认连接池），适合单连接多库的场景：

```typescript
// 访问 billing 数据库的 invoices 集合
const billing = app.db.use("billing");
const invoice = await billing.collection("invoices").findOne({ _id: id });

// 也可直接链式调用
const invoice = await app.db
  .use("billing")
  .collection("invoices")
  .findOne({ _id: id });

// use() 只切换数据库 scope，不会改写注册键。
// models/billing/invoice.ts 这类 depth-1 文件注册为 BillingInvoice。
const Invoice = app.db.use("billing").model("BillingInvoice");
```

### pool(poolName)

切换到指定连接池，返回包含 `collection` / `model` / `use` 的访问器：

```typescript
// 访问 cn 池的 orders 集合
const order = await app.db.pool("cn").collection("orders").findOne({ _id: id });

// 连接池中的 Model 查询仍使用精确注册键。
const Invoice = app.db.pool("billing").model("BillingInvoice");
// 只有 Model 显式声明 key: "Invoice" 时，短键才有效。
const InvoiceAlias = app.db.pool("billing").model("Invoice");

// cn 池 + billing 库（collection）
const invoice = await app.db
  .pool("cn")
  .use("billing")
  .collection("invoices")
  .findOne({});

// cn 池 + billing 库 + 精确的 Model 注册键
const InvoiceCn = app.db.pool("cn").use("billing").model("BillingInvoice");

// 深度-2 模型目录（models/cn/billing/order.ts）：注册键 = CnBillingOrder
// scope accessor 不会自动添加前缀，也不会回落到另一个键。
const Order1 = app.db.model("CnBillingOrder"); // 完整 key
const Order2 = app.db.pool("cn").use("billing").model("CnBillingOrder");
// 两者用不同的显式 scope 解析同一个已注册 Model。
```

> ⚠️ `pool()` 会立即校验连接池是否存在，通过后才返回 accessor。未配置连接池管理器时抛出 `NO_POOL_MANAGER`；找不到指定池名时抛出 `POOL_NOT_FOUND`（`err.available` 含可用池列表）。model / collection / use 仅在校验通过后可用。

> ℹ️ **`pool().use(dbName)` 中的 `dbName` 会覆盖 Model 定义中 `connection.database` 的值**。例如，Model 定义了 `connection.database: "billing"`，通过 `pool("cn").use("archive")` 访问时，实际查询将使用 `archive` 数据库而非 `billing`。
> 如需按精确 key 并显式覆盖数据库/连接池，请使用 `app.db.scopedModel(key, { pool, database })`。

### client

获取原始 MongoDB Client 实例（用于事务等高级场景）：

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

## app.db 上的完整 MonSQLize API

`app.db` 就是原始 `MonSQLize` 实例，不是 Vext 缩减包装；v2 不再提供独立的
`app.monsqlize` 入口。

```typescript
const monsqlize = app.db;
if (!monsqlize) throw new Error("Database is not configured");

// 实例级完整能力都保留在 app.db。
await monsqlize.withTransaction(async (transaction) => {
  // ...
});
monsqlize.on("slow-query", (info) => {
  app.logger.warn({ ...info }, "Slow query detected");
});

// app.db 返回上游 Collection / Model 实例。
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
collection、Model、事务、连接池、同步、事件、诊断和管理 API 都使用唯一入口
`app.db`。Vector Search 需要兼容的 MongoDB 部署和预先创建的索引。关系保护删除
只覆盖已注册、已声明的关系；把结果视为完整证据前应检查 coverage。
:::

Vext 根包只导出 `VextMonSQLizeOptions` 等 Vext 自有集成类型，不镜像全部上游
symbol。需要 MonSQLize 专属类或类型时，请直接从 `monsqlize` 导入。

### 手动注册的类型化 descriptor（3.3.0）

MonSQLize 3.3.0 可以从对象字面量 schema 推导 Model 文档类型。应用代码需要导入
这一包级 API 时，应把 `monsqlize@3.3.0` 声明为应用的直接依赖，而不是依赖包管理器
碰巧提升传递依赖。请先一次性注册 descriptor，再通过原始实例获取 Model：

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
  return User?.findOne({ email }); // email: string；age?: number
}
```

这是显式的上游注册路径。不要把 descriptor 作为 `src/models/*` 文件的默认导出：
Vext 自动 Model 加载器仍接收 definition object，并按下文规则推导注册键。由于
`app.db` 是原始实例，手动代码既可以把精确字符串键传给 `app.db.model()`，也可以
传入上游类型化 descriptor。

## Model 定义

Model 是对集合操作的封装，提供字段校验、钩子、虚拟字段等高级能力。

### 创建 Model 文件

> MonSQLize Model 层集成了 **schema-dsl**，schema 字段支持 DSL 简洁语法。

#### 推荐写法：schema-dsl 简洁语法 + options.timestamps

```typescript
// src/models/user.ts
export default {
  collection: "users",

  // schema-dsl 简洁语法
  schema: {
    name: "string:1-50!", // 必填字符串，1~50 字符
    email: "email!", // 必填，邮箱格式
    role: "admin|editor|viewer", // 枚举值
    avatar: "string", // 可选字符串
  },

  // 索引
  indexes: [
    { key: { email: 1 }, options: { unique: true } },
    { key: { role: 1, createdAt: -1 } },
  ],

  // 使用 options.timestamps 自动管理 createdAt/updatedAt
  options: {
    timestamps: true,
  },
};
```

#### 对象格式（复杂场景）

当字段需要 `default` 函数、嵌套 schema 等高级能力时，可使用对象格式：

```typescript
// src/models/user.ts
export default {
  collection: "users",

  // 字段定义（对象格式）
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

  // 索引
  indexes: [
    { key: { email: 1 }, options: { unique: true } },
    { key: { role: 1, createdAt: -1 } },
  ],

  // 钩子（仅用于非 timestamps 的自定义逻辑）
  hooks: {
    beforeInsert(context: { data?: any }) {
      // 自定义逻辑示例
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

### Model options（模型选项）

| 选项         | 类型                | 默认值      | 说明                          |
| ------------ | ------------------- | ----------- | ----------------------------- |
| `timestamps` | `boolean \| object` | `undefined` | 自动管理 createdAt/updatedAt  |
| `softDelete` | `boolean \| object` | `undefined` | 软删除支持                    |
| `version`    | `boolean \| object` | `undefined` | 乐观锁版本号                  |
| `validate`   | `boolean`           | `true`      | 插入/更新时的 schema 校验开关 |

对象式 `hooks` 与 monSQLize 保持一致，接收 `context` 参数；常见写入文档可从 `context.data` 读取。需要访问 Model 实例时，也可以使用 `(model) => ({ ... })` 的 factory 形式。

#### timestamps 配置

```typescript
// 简单模式：自动添加 createdAt + updatedAt
options: { timestamps: true }

// 自定义字段名
options: { timestamps: { createdAt: 'created_time', updatedAt: 'updated_time' } }

// 只启用 createdAt（日志类集合）
options: { timestamps: { createdAt: true, updatedAt: false } }
```

### `key` 别名（跨连接池快捷访问）

当 Model 集合名包含前缀（如 `BillingInvoice`）时，可以定义 `key` 别名，通过短名快捷访问：

```typescript
// src/models/billing-invoice.ts
export default {
  collection: "BillingInvoice", // MongoDB 实际集合名
  key: "Invoice", // 短名别名（可选）

  schema: {
    amount: "number!",
    currency: "CNY|USD|EUR",
    status: "draft|pending|paid",
  },

  // 绑定到指定连接池 + 数据库（让 app.db.model() 路由正确）
  connection: {
    pool: "billing",
    database: "billing",
  },
};
```

注册后，两个 key 均可使用：

```typescript
app.db.model("BillingInvoice"); // 按集合名（全路径）
app.db.model("Invoice"); // 按别名（短名）

// scope 切换不会改写任一精确键
app.db.pool("billing").model("BillingInvoice");
app.db.pool("billing").model("Invoice");
```

> **注意**：如果别名与已注册的其他 Model 冲突，别名注册会被跳过（不覆盖现有注册），仅集合名有效。

Model 文件放在 `src/models/` 目录下，插件会自动扫描并注册：

```
src/
├── models/
│   ├── user.ts         → Model 名称: 'User'
│   ├── order.ts        → Model 名称: 'Order'
│   ├── product-item.ts → Model 名称: 'ProductItem'
│   └── index.ts        → Model 名称: 'Index'（除非 collection/name 覆盖）
```

文件名推断 Model 名称的规则：

- `user.ts` → `'User'`（首字母大写）
- `order-item.ts` → `'OrderItem'`（kebab-case → PascalCase）
- `user_role.ts` → `'UserRole'`（snake_case → PascalCase）
- `.test.ts` / `.spec.ts` / `.d.ts` → 跳过
- `_` 开头的文件 → 跳过
- `index.ts` 是普通 Model 文件；位于根目录时推导为 `'Index'`

### 目录路由（自动绑定连接池 / 数据库）

将 Model 文件放入 `models/` 的子目录，可以让 vext 自动推断所属连接池和数据库，无需在每个文件中手动填写 `connection` 字段。

**目录深度规则：**

| 目录结构                         | 注册键名                                    | 自动注入                                            |
| -------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| `models/order.ts`                | `Order`（或 `def.collection` / `def.name`） | 无（行为不变）                                      |
| `models/billing/invoice.ts`      | `BillingInvoice`                            | `connection: { database: 'billing' }`               |
| `models/main/billing/invoice.ts` | `MainBillingInvoice`                        | `connection: { pool: 'main', database: 'billing' }` |
| `models/a/b/c/invoice.ts`        | ❌ 跳过（超出最大深度 2，输出警告）         | —                                                   |

> 💡 目录深度超过 2 层时，vext 会输出警告日志并跳过该文件。如需更复杂的路由，请在 Model 文件中显式设置 `connection` 字段。

**示例：按业务领域拆分 Model**

```
src/models/
├── order.ts              → 注册为 'Order'（默认数据库）
├── billing/
│   ├── invoice.ts        → 注册为 'BillingInvoice'，database: 'billing'
│   └── payment.ts        → 注册为 'BillingPayment'，database: 'billing'
└── main/
    └── billing/
        └── invoice.ts    → 注册为 'MainBillingInvoice'，pool: 'main', database: 'billing'
```

```typescript
// src/models/billing/invoice.ts
// 无需手动写 connection — 由目录路径自动推断
export default {
  schema: {
    amount: "number!",
    currency: "CNY|USD|EUR",
    status: "draft|pending|paid",
  },
} satisfies VextModelDefinition;

// 效果等同于显式配置：
// export default {
//   name: "invoice",
//   connection: { database: "billing" },
//   schema: { ... },
// };
```

**注入优先级：** 若 Model 文件已显式设置 `connection` 或 `name`/`collection`，则优先使用显式值，目录路由不会覆盖。

### Model 加载配置

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },

    models: {
      // Model 定义文件目录（相对于 src/，默认 'models'）
      dir: "models",

      // 是否自动注册（默认 true）
      autoRegister: true,

      // 发现策略：strict（默认）或 lenient
      validation: "strict",

      // 外部共享 Model 包（微服务场景）
      sharedPackage: "@myproject/shared-models",
    },
  },
};
```

`validation: "strict"` 会在修改全局 Model registry 前完成发现、导入、解析与校验。任何无效定义、冲突或提交失败都会终止启动，并回滚整份注册计划。显式使用 `"lenient"` 时只会警告并跳过发现阶段的无效输入；registry 冲突和提交失败仍然 fail closed。注册项归当前应用所有，应用关闭时只释放自己的 Model，不会清空其它应用的注册项。

### 共享 Model 包（微服务场景）

在微服务架构中，多个服务可能共享同一套 Model 定义。通过 `sharedPackage` 从 npm 包加载：

```typescript
// 加载顺序：先 shared 包 → 再本地 models/
// 本地 Model 可以覆盖 shared 包中同名的 Model
models: {
  sharedPackage: '@myproject/shared-models',
  dir: 'models',  // 本地 Model（可覆盖 shared）
}
```

共享包必须 default export Model 定义对象，例如 `{ User: { schema: ... } }`。回调式 `registerModels()` 包会被拒绝，因为 Vext 无法预检、归属所有权或回滚不透明回调注册的 key。

## 在服务中使用

### 基础 CRUD 服务

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
      this.app.throw(404, "用户不存在");
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
    // 检查邮箱唯一性
    const existing = await this.app.db.collection("users").findOne({
      email: data.email,
    });
    if (existing) {
      this.app.throw(409, "邮箱已注册", "EMAIL_EXISTS");
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
      this.app.throw(404, "用户不存在");
    }

    return this.findById(id);
  }

  async delete(id: string) {
    const result = await this.app.db.collection("users").deleteOne({ _id: id });

    if (result.deletedCount === 0) {
      this.app.throw(404, "用户不存在");
    }

    this.logger.info({ id }, "User deleted");
  }
}
```

### 在路由中配合使用

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
      docs: { summary: "获取用户列表" },
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
      docs: { summary: "获取用户详情" },
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
      docs: { summary: "创建用户" },
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
      docs: { summary: "更新用户" },
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
      docs: { summary: "删除用户" },
    },
    async (req, res) => {
      const { id } = req.valid("param");
      await app.services.user.delete(id);
      res.json({ success: true });
    },
  );
});
```

## 在插件中使用

自定义插件可以通过 `dependencies` 确保在 MonSQLize 初始化之后执行：

```typescript
// src/plugins/seed-data.ts
import { definePlugin } from "vextjs";

export default definePlugin({
  name: "seed-data",

  async setup(app) {
    // 插件加载时 MonSQLize 已初始化，app.db 可用
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

## 测试中使用

### 使用内存数据库

在测试环境中使用 `mongodb-memory-server-core` 运行内存数据库，无需外部 MongoDB 实例：

```bash
npm install -D mongodb-memory-server-core
```

Vext 使用 core 包以避免 `mongodb-memory-server` wrapper 在 `npm install` 阶段触发 binary 下载。测试首次启动时仍可能下载 MongoDB binary；建议在 CI 中设置 `MONGOMS_DOWNLOAD_DIR=.cache/mongodb-binaries` 与 `MONGOMS_PREFER_GLOBAL_PATH=false`，并缓存该目录；缓存命中后可用 `MONGOMS_RUNTIME_DOWNLOAD=false` 验证不会再次下载。

```typescript
// src/config/test.ts
export default {
  database: {
    useMemoryServer: true,
  },
};
```

### 测试示例

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
      body: { name: "张三", email: "zhangsan@test.com" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("张三");
  });

  it("should reject duplicate email", async () => {
    await app.inject({
      method: "POST",
      url: "/users",
      body: { name: "张三", email: "dup@test.com" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/users",
      body: { name: "李四", email: "dup@test.com" },
    });

    expect(res.statusCode).toBe(409);
  });
});
```

## 慢查询监控

MonSQLize 内置慢查询检测。查询耗时超过 `slowQueryMs` 阈值时自动打印警告日志：

```typescript
export default {
  database: {
    config: { uri: "mongodb://localhost:27017/myapp" },
    slowQueryMs: 200, // 超过 200ms 的查询会产生警告

    // 可选：持久化慢查询记录到专用集合
    slowQueryLog: {
      enabled: true,
      collection: "_slow_queries",
    },
  },
};
```

日志输出示例：

```
[14:23:05.123] WARN [monsqlize] Slow query: users.find({role:"admin"}) 523ms
```

## Model 热重载（开发模式）

在 `vext dev` 开发模式下，修改 `src/models/` 目录下的 Model 定义文件会自动触发 **Tier 2 软重载**，框架将重新加载变更的 Model 定义，无需手动重启服务器。

### 工作原理

```
修改 src/models/item.ts
  ↓
esbuild 重新编译 → dist/models/item.js
  ↓
model-reloader 检测到 invalidated 文件
  ↓
构建并校验完整替换计划
  ↓
使用 rollback journal 原子替换本应用所有的定义
  ↓
新请求使用新 Model 定义
```

### 重载行为说明

| 场景                   | 行为                                                   |
| ---------------------- | ------------------------------------------------------ |
| 修改 schema 字段类型   | 下次写入使用新 schema 校验规则                         |
| 修改 hooks             | 新的 hooks 立即对后续操作生效                          |
| 修改 indexes           | 索引变更需要冷重启才能同步到 MongoDB                   |
| 重载失败（如语法错误） | 自动回滚到旧定义，服务继续运行                         |
| 并发请求               | 重载期间正在处理的请求使用旧定义完成，新请求使用新定义 |

### 日志输出示例

保存 `src/models/item.ts` 后，终端会输出：

```
[vext dev] 1 file(s) changed:
  🟢 src/models/item.ts (modify)
[vext dev] source change detected → soft reload [T1:code]...
[hot-reload] model "items" reloaded
[hot-reload] [OK] 48ms [T1:code] (compile:3ms cache:2ms i18n:0ms mw:5ms svc:8ms model:3ms route:25ms swap:2ms) [12 modules evicted] #3
```

注意日志中的 `model:3ms` 计时段，表示 Model 重载耗时。

:::tip 回滚保障
若新 Model 定义存在问题（如 schema 定义抛出异常），框架会自动将旧定义重新注册，确保服务不中断。修复代码后保存，重载会再次触发。
:::

:::info 框架内部机制
`Model.redefine()` / `Model.undefine()` 是 monSQLize 提供的原生 Model API，由 vext 框架在热重载流程中自动调用，用户无需手动调用。
:::

## 优雅关闭

MonSQLize 插件在 `app.onClose()` 中注册了数据库连接关闭钩子。当应用收到 `SIGTERM` / `SIGINT` 信号时：

1. 停止接受新请求
2. 等待飞行中的请求完成
3. 执行 `onClose` 钩子（LIFO 顺序）
4. MonSQLize 关闭数据库连接
5. 进程退出

无需手动管理连接关闭。

## 下一步

- 了解 [配置](/guide/configuration) 中的三层合并机制和环境覆盖
- 查看 [插件](/guide/plugins) 如何通过 `definePlugin()` 扩展框架
- 学习 [测试](/guide/testing) 中如何使用 `createTestApp()` 进行集成测试
- 探索 [app.fetch 内置 HTTP 客户端](/guide/fetch) 在微服务中调用其他服务

## 迁移指南 (v0.2.x → v0.3.0)

### B1：`app.db.db()` 已移除

旧用法（v0.2.x，存在运行时 bug — monSQLize 并未提供 `db()` 方法）：

```typescript
// ❌ v0.2.x — 实际会在运行时报错
const logsDb = app.db.db("logs");
```

新用法（v0.3.0）：

```typescript
// ✅ v0.3.0 — 切换数据库（默认连接池）
const logsDb = app.db.use("logs");

// 如需同时切换连接池
const logsDb = app.db.pool("cn").use("logs");
```

### B2：`app.db.use()` 变为单参数

旧用法（如有自行扩展传入两个参数）：

```typescript
// ❌ v0.2.x 非标准用法
app.db.use("cn", "billing");
```

新用法：

```typescript
// ✅ v0.3.0 — 先切换连接池，再切换数据库
app.db.pool("cn").use("billing");
```
