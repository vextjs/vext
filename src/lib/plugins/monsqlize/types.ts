/**
 * MonSQLize 内置插件类型定义
 *
 * 定义 VextDatabase（原始 MonSQLize 实例）和 MonSQLizeDatabaseConfig（数据库配置）。
 * 通过 declare module 'vextjs' 扩展 VextApp 和 VextConfig 接口，
 * 使用户在 app.db / app.config.database 上获得完整类型提示。
 *
 * @module lib/plugins/monsqlize/types
 * @see 13-monsqlize-plugin.md §2.1（类型扩展）
 */

import type {
  ModelDefinition,
  MongoConnectionState,
  MonSQLize,
  MonSQLizeOptions,
} from "monsqlize";

/**
 * Upstream MonSQLize options that Vext can safely forward without giving up
 * ownership of connection, cache, logging, pool, model, or shutdown lifecycle.
 *
 * @internal Shared by the public type and runtime validator to prevent drift.
 */
export const MONSQLIZE_ALLOWED_OPTION_KEYS = [
  "schemaDsl",
  "poolFallback",
  "maxPoolsCount",
  "sync",
  "transaction",
  "findMaxLimit",
  "findMaxSkip",
  "requireCursorSecret",
  "cursorSecretWarning",
  "cursorTypes",
  "cursorValueNormalizer",
  "log",
  "countQueue",
  "autoIndex",
  "cacheAutoInvalidate",
  "writePathPolicy",
] as const satisfies readonly (keyof MonSQLizeOptions)[];

/** @internal MonSQLize constructor keys whose lifecycle remains Vext-owned. */
export const MONSQLIZE_PROTECTED_OPTION_KEYS = [
  "type",
  "databaseName",
  "database",
  "config",
  "cache",
  "logger",
  "pools",
  "poolStrategy",
  "maxTimeMS",
  "findLimit",
  "findPageMaxLimit",
  "slowQueryMs",
  "slowQueryLog",
  "autoConvertObjectId",
  "namespace",
  "cursorSecret",
  "models",
] as const satisfies readonly (keyof MonSQLizeOptions)[];

type VextMonSQLizeAllowedOptionKey =
  (typeof MONSQLIZE_ALLOWED_OPTION_KEYS)[number];
type VextMonSQLizeProtectedOptionKey =
  (typeof MONSQLIZE_PROTECTED_OPTION_KEYS)[number];
type AssertNoUnclassifiedMonSQLizeOption<T extends never> = [T] extends [never]
  ? true
  : never;
type MonSQLizeOptionClassificationIsExhaustive =
  AssertNoUnclassifiedMonSQLizeOption<
    Exclude<
      keyof MonSQLizeOptions,
      VextMonSQLizeAllowedOptionKey | VextMonSQLizeProtectedOptionKey
    >
  >;

/**
 * Advanced MonSQLize constructor options accepted by Vext.
 *
 * Option value shapes are picked directly from `monsqlize@3.3.0`; Vext keeps
 * a deliberate, exhaustively checked key allowlist around them. Vext-owned
 * constructor keys are explicit `never` properties and are also rejected at
 * runtime when JavaScript or a type escape hatch is used.
 */
export type VextMonSQLizeOptions = Pick<
  MonSQLizeOptions,
  MonSQLizeOptionClassificationIsExhaustive extends true
    ? VextMonSQLizeAllowedOptionKey
    : never
> &
  Partial<Record<VextMonSQLizeProtectedOptionKey, never>>;

// ── 扩展 VextApp / VextConfig ───────────────────────────────
declare module "../../../types/app.js" {
  interface VextApp {
    /** 已连接的原始 MonSQLize 实例；数据库能力统一从此入口访问。 */
    db?: VextDatabase;
  }

  interface VextConfig {
    /** MonSQLize 数据库配置 */
    database?: MonSQLizeDatabaseConfig;
  }
}

// ── 数据库入口 ──────────────────────────────────────────────

/** app.db 的公开类型：完整保留 MonSQLize 能力，并增加只读 MongoClient。 */
export type VextDatabase = MonSQLize & {
  readonly client: MongoConnectionState["client"];
};

/** @deprecated Use VextDatabase. */
export type MonSQLizeConnection = VextDatabase;

// ── 配置类型 ────────────────────────────────────────────────

/**
 * Vext Model 定义对象类型
 *
 * 在 src/models/ 下的 Model 文件中 export default 此对象。
 */
export interface VextModelDefinition<
  TDocument = Record<string, unknown>,
> extends ModelDefinition<TDocument> {
  /**
   * 自定义注册别名（R5 新增）
   *
   * 为 Model 额外添加一个短名（如将 billing/invoice.ts 额外注册为 'Invoice'），
   * 路径推断名 'BillingInvoice' 同时保留，两者均可访问同一 Model（双重注册）。
   * 只影响 `app.db.model(key)` 的查找名，不影响 MongoDB 集合名。
   *
   * 建议仅在需要跨模块短名访问时使用，注意避免与其他 Model 的推断名冲突。
   */
  key?: string;
  /** @deprecated 用 key 控制注册名；用 collection 控制集合名 */
  name?: string;
  /** MongoDB 集合名（不填则使用文件名/name/key） */
  collection?: string;
  /**
   * 数据源绑定（N4 目录路由自动注入，也可手动指定）
   *
   * 子目录模型文件会根据目录层级自动推断并注入此字段：
   *   - `models/a/order.ts`     → `{ database: 'a' }`
   *   - `models/c/a/order.ts`   → `{ pool: 'c', database: 'a' }`
   *
   * 手动显式配置会覆盖自动推断值。
   */
  connection?: {
    /** 连接池名称（对应 config.database.pools[].name） */
    pool?: string;
    /** 数据库名称（对应 MonSQLize 实例的 databaseName） */
    database?: string;
  };
  /** schema-dsl 简洁语法、对象格式或 monSQLize 支持的 SchemaDSL */
  schema?: Exclude<ModelDefinition<TDocument>["schema"], undefined>;
  /** monSQLize 对象式 hooks 或 v1 hooks factory */
  hooks?: Exclude<ModelDefinition<TDocument>["hooks"], undefined>;
  /** monSQLize 模型方法定义或 v1 methods factory */
  methods?: Exclude<ModelDefinition<TDocument>["methods"], undefined>;
  /** monSQLize 模型选项，如 timestamps、softDelete、version、validate */
  options?: Exclude<ModelDefinition<TDocument>["options"], undefined>;
}

/**
 * MonSQLize 数据库配置
 *
 * 用户在 src/config/default.ts 中通过 database 字段配置。
 * 插件在 setup 阶段读取此配置创建 MonSQLize 实例。
 */
export interface MonSQLizeDatabaseConfig {
  /**
   * MongoDB 连接类型
   * @default 'url'
   */
  type?: "url" | "replica" | "srv";

  /**
   * 数据库名称（N2 新增）
   *
   * 默认从 uri/url 中自动解析（如 `mongodb://host/mydb` → `'mydb'`）。
   * 显式配置时优先使用，用于 URI 不包含数据库名的场景。
   */
  databaseName?: string;

  /**
   * 连接配置
   * - type='url' 时：{ url: string }
   * - type='replica' 时：{ hosts: string[], replicaSet: string }
   * - type='srv' 时：{ host: string }
   */
  config: {
    /**
     * MongoDB 连接 URI（主要字段，N1 新增）
     * @example 'mongodb://localhost:27017/mydb'
     */
    uri?: string;
    /**
     * MongoDB 连接 URL（已废弃，请使用 uri）
     * @deprecated 使用 uri 替代
     */
    url?: string;
    host?: string;
    hosts?: string[];
    port?: number;
    database?: string;
    replicaSet?: string;
    username?: string;
    password?: string;
    authSource?: string;
    options?: Record<string, unknown>;
    /**
     * SSH 隧道配置（v1.3.0+）
     * 配置后将通过 SSH 跳板机连接数据库，uri 中的 host:port 作为隧道目标地址
     */
    ssh?: {
      /** SSH 服务器地址 */
      host: string;
      /** SSH 端口（默认 22） */
      port?: number;
      /** SSH 用户名 */
      username: string;
      /** SSH 密码（与 privateKey 二选一） */
      password?: string;
      /** SSH 私钥内容（与 password 二选一） */
      privateKey?: string | Buffer;
      /** 私钥密码 */
      passphrase?: string;
      /** 连接超时（毫秒，默认 20000） */
      readyTimeout?: number;
      /** 心跳间隔（毫秒，默认 30000） */
      keepaliveInterval?: number;
    };
  };

  /**
   * Controlled escape hatch for advanced `monsqlize@3.3.0` constructor options.
   *
   * Connection, cache, logger, pool, model, and shutdown lifecycle keys remain
   * owned by the first-class Vext database configuration and are rejected.
   */
  monsqlizeOptions?: VextMonSQLizeOptions;

  /**
   * 缓存配置
   * L1 = 内存 LRU，L2 = Redis（可选）
   */
  cache?: {
    /** L1 内存缓存（默认开启） */
    memory?: {
      enabled?: boolean;
      /** 最大缓存条数（默认 1000） */
      maxSize?: number;
      /** 默认 TTL 秒数（默认 300） */
      ttl?: number;
    };
    /** L2 Redis 缓存（可选） */
    redis?: {
      enabled?: boolean;
      /** Redis 连接 URI（主要字段） */
      uri?: string;
      /** Redis 连接 URL（已废弃，请使用 uri） @deprecated 使用 uri 替代 */
      url?: string;
      /** 缓存 key 前缀 */
      prefix?: string;
      /** 默认 TTL 秒数 */
      ttl?: number;
    };
  };

  /**
   * 多连接池配置
   * 微服务场景中用于读写分离或多库访问
   *
   * 注：vext 接收两种 uri 写法（uri / url），平铺时统一映射为 monSQLize 要求的扁平 { name, uri }。
   */
  pools?: Array<{
    name: string;
    config: {
      uri?: string;
      url?: string;
      useMemoryServer?: boolean;
      memoryServerOptions?: Record<string, unknown>;
    } & Record<string, unknown>;
    options?: Record<string, unknown>;
    role?: "primary" | "secondary" | "analytics" | "custom";
    weight?: number;
    tags?: string[];
    healthCheck?: {
      enabled?: boolean;
      interval?: number;
      timeout?: number;
      retries?: number;
    };
  }>;

  /**
   * 连接池选择策略
   * @default 'auto'
   */
  poolStrategy?: "auto" | "round-robin" | "random" | "least-connections";

  /**
   * 全局查询超时（毫秒）
   * @default 2000
   */
  maxTimeMS?: number;

  /**
   * find 默认返回条数上限
   * @default 10
   */
  findLimit?: number;

  /**
   * 分页最大 limit
   * @default 500
   */
  findPageMaxLimit?: number;

  /**
   * 慢查询阈值（毫秒，-1 禁用）
   * @default 500
   */
  slowQueryMs?: number;

  /**
   * 慢查询持久化存储配置
   */
  slowQueryLog?: {
    enabled?: boolean;
    /** 存储集合名 */
    collection?: string;
  };

  /**
   * 自动 ObjectId 转换
   */
  autoConvertObjectId?:
    | boolean
    | {
        fields?: string[];
      };

  /**
   * Model 自动加载配置
   */
  models?: {
    /**
     * Model 定义文件目录（相对于 src/）
     * @default 'models'
     */
    dir?: string;

    /**
     * 外部 shared Model 包名
     * 微服务场景中使用，从 npm 包加载 Model 定义
     * @example '@project/models'
     */
    sharedPackage?: string;

    /**
     * 是否自动注册（扫描目录后自动 Model.define）
     * @default true
     */
    autoRegister?: boolean;

    /**
     * Model discovery failure policy.
     *
     * `strict` fails application startup before any Model registry mutation.
     * `lenient` explicitly opts into warning and skipping invalid imports or
     * definitions; registry collisions and commit failures still fail closed.
     *
     * @default 'strict'
     */
    validation?: "strict" | "lenient";
  };

  /**
   * 命名空间（缓存隔离用）
   * @default { scope: 'database' }
   */
  namespace?: {
    scope?: string;
  };

  /**
   * 深分页游标加密密钥
   */
  cursorSecret?: string;

  /**
   * 内存数据库（测试用）
   * 启用后使用 mongodb-memory-server-core 创建临时实例
   * @default false
   */
  useMemoryServer?: boolean;

  /**
   * 传给 mongodb-memory-server-core 的启动选项
   */
  memoryServerOptions?: Record<string, unknown>;

  /**
   * 日志器配置
   * - 'app': 使用 app.logger（默认）
   * - false: 禁用日志
   */
  logger?: "app" | false;
}
