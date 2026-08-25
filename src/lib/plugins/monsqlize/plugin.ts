/**
 * MonSQLize 内置插件核心实现
 *
 * 负责整个 MonSQLize 生命周期编排：
 *   1. 读取并校验 database 配置
 *   2. 构建 MonSQLize 构造函数配置（buildMonSQLizeConfig）
 *   3. 动态 import monsqlize 包，创建实例
 *   4. 注册 onClose 钩子并建立失败路径清理
 *   5. 连接数据库（Fail Fast）
 *   6. 加载 Model 定义（本地 + shared 包）
 *   7. 将原始 MonSQLize 实例作为唯一入口挂载到 app.db
 *
 * 设计原则：
 *   - onClose 与 setup 失败路径都清理资源（确保启动异常时不遗留临时实例）
 *   - Fail Fast：配置缺失或连接失败直接抛出，终止启动
 *   - 动态 import monsqlize（避免未安装时框架启动失败）
 *   - 日志桥接：将 MonSQLize 日志桥接到 app.logger
 *
 * @module lib/plugins/monsqlize/plugin
 * @see 13-monsqlize-plugin.md §2.3（插件核心实现）
 */

import type { VextPluginContext } from "../../../types/plugin.js";
import {
  MONSQLIZE_ALLOWED_OPTION_KEYS,
  MONSQLIZE_PROTECTED_OPTION_KEYS,
} from "./types.js";
import type { MonSQLizeDatabaseConfig } from "./types.js";
import { createConnection } from "./connection.js";
import { loadModels } from "./model-loader.js";
import type { ModelRegistrationHandle } from "./model-registry.js";
import { loadMonSQLizeClass } from "./module.js";
import type { StartupProfiler } from "../../startup-profiler.js";

export interface SetupMonSQLizeOptions {
  startupProfiler?: StartupProfiler;
}

/**
 * setupMonSQLize — 插件 setup 入口
 *
 * 由内置插件的 setup() 调用，完成 MonSQLize 的完整初始化流程。
 *
 * @param app     插件上下文（config.database 已可用）
 * @param srcDir  src/ 目录的绝对路径（用于定位 models/ 目录）
 * @throws 配置缺失或连接失败时抛出错误（Fail Fast）
 */
export async function setupMonSQLize(
  app: VextPluginContext,
  srcDir: string,
  options: SetupMonSQLizeOptions = {},
): Promise<void> {
  let config = (app.config as { database?: MonSQLizeDatabaseConfig }).database;

  // ── 配置校验 ──────────────────────────────────────────────
  if (!config) {
    throw new Error(
      '[monsqlize] Missing "database" configuration.\n' +
        "  Add database config to src/config/default.ts:\n" +
        "  export default {\n" +
        "    database: {\n" +
        '      config: { uri: "mongodb://localhost:27017/mydb" }\n' +
        "    }\n" +
        "  }",
    );
  }

  if (!config.config) {
    throw new Error(
      '[monsqlize] Missing "database.config" — at minimum provide { uri: "..." }.',
    );
  }

  // ── 0. useMemoryServer 预处理（仅测试场景）────────────────
  // vext 在插件层统一使用 mongodb-memory-server-core 启动临时实例，
  // 避免把 useMemoryServer 透传给上游 monSQLize 后触发 wrapper/fallback。
  const memoryServersToStop: Array<{ stop: () => Promise<void> }> = [];
  let memoryServersStopped = false;

  const stopMemoryServers = async (): Promise<void> => {
    if (memoryServersStopped) {
      return;
    }
    memoryServersStopped = true;

    for (const ms of memoryServersToStop.splice(0)) {
      try {
        await ms.stop();
      } catch (err) {
        app.logger.warn("[monsqlize] failed to stop memory server", {
          error: (err as Error).message,
        });
      }
    }
  };

  if (config.useMemoryServer === true) {
    try {
      await timeMonSQLize(
        options,
        "worker.builtinPlugin.monsqlize.memory.root",
        async () => {
          const { MongoMemoryServer } =
            await import("mongodb-memory-server-core");
          const memoryServerOptions = (
            config as MonSQLizeDatabaseConfig & {
              memoryServerOptions?: Record<string, unknown>;
            }
          ).memoryServerOptions;
          const server = await MongoMemoryServer.create(memoryServerOptions);
          const uri = server.getUri();
          const rootConfig: Record<string, unknown> = {
            ...config!.config,
            uri,
          };
          delete rootConfig.url;

          const clonedConfig: MonSQLizeDatabaseConfig & {
            memoryServerOptions?: Record<string, unknown>;
          } = { ...config!, config: rootConfig };
          delete clonedConfig.useMemoryServer;
          delete clonedConfig.memoryServerOptions;
          config = clonedConfig;

          memoryServersToStop.push({
            stop: async () => {
              await server.stop();
            },
          });
          app.logger.info(
            "[monsqlize] root connection using in-memory MongoDB",
            {
              uri,
            },
          );
        },
        { connection: "root" },
      );
    } catch (err) {
      await stopMemoryServers();
      throw new Error(
        `[monsqlize] Failed to start MongoMemoryServer for root connection: ${(err as Error).message}\n` +
          "  Make sure mongodb-memory-server-core is installed: npm install -D mongodb-memory-server-core",
      );
    }
  }

  // monSQLize 的 PoolConfig 校验器要求 pool 必须有真实 mongodb:// uri，
  // 不接受 useMemoryServer 标志。此处在 vext 层为标记了 useMemoryServer
  // 的 pool 条目预先启动 MongoMemoryServer，并把生成的 URI 写回 config.uri，
  // 同时在 onClose 中停止这些 memory server。
  if (config.pools && config.pools.length > 0) {
    // 深拷贝 pools（vext 配置可能被冻结，无法原地写入）
    const clonedPools: Array<any> = config.pools.map((p: any) => ({
      ...p,
      config: { ...(p.config || {}) },
    }));
    for (const pool of clonedPools) {
      const innerCfg = pool.config;
      const hasUri =
        typeof innerCfg.uri === "string" || typeof innerCfg.url === "string";
      if (innerCfg.useMemoryServer === true && !hasUri) {
        try {
          await timeMonSQLize(
            options,
            `worker.builtinPlugin.monsqlize.memory.pool.${toEventNamePart(pool.name)}`,
            async () => {
              const { MongoMemoryServer } =
                await import("mongodb-memory-server-core");
              const server = await MongoMemoryServer.create(
                innerCfg.memoryServerOptions,
              );
              const uri = server.getUri();
              innerCfg.uri = uri;
              delete innerCfg.useMemoryServer;
              delete innerCfg.memoryServerOptions;
              memoryServersToStop.push({
                stop: async () => {
                  await server.stop();
                },
              });
              app.logger.info(
                `[monsqlize] pool '${pool.name}' using in-memory MongoDB`,
                { uri },
              );
            },
            { pool: pool.name },
          );
        } catch (err) {
          await stopMemoryServers();
          throw new Error(
            `[monsqlize] Failed to start MongoMemoryServer for pool '${pool.name}': ${(err as Error).message}\n` +
              "  Make sure mongodb-memory-server-core is installed: npm install -D mongodb-memory-server-core",
          );
        }
      }
    }
    config = { ...config, pools: clonedPools };
  }

  // ── 1. 构建 MonSQLize 配置 ────────────────────────────────
  let monsqlizeConfig: Record<string, unknown>;
  try {
    monsqlizeConfig = await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.config",
      () => buildMonSQLizeConfig(config!, app),
    );
  } catch (err) {
    await stopMemoryServers();
    throw err;
  }

  // ── 2. 动态 import + 创建 MonSQLize 实例 ──────────────────
  let MonSQLizeClass: any;
  try {
    MonSQLizeClass = await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.import",
      () => loadMonSQLizeClass(),
    );
  } catch (err) {
    await stopMemoryServers();
    throw new Error(
      "[monsqlize] Failed to import 'monsqlize' package.\n" +
        `  ${(err as Error).message}\n` +
        "  Make sure monsqlize is installed: npm install monsqlize",
    );
  }

  let monsqlize: any;
  try {
    monsqlize = await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.instance",
      () => new MonSQLizeClass(monsqlizeConfig),
    );
  } catch (err) {
    await stopMemoryServers();
    throw err;
  }

  let modelRegistration: ModelRegistrationHandle | undefined;

  // ── 3. 先注册 onClose，再执行 I/O（安全模式）──────────────
  //
  // 即使 connect() 失败，onClose 也能正确清理半初始化的资源。
  // monsqlize.close() 内部会检查连接状态，未连接时是 no-op。
  //
  app.onClose(async () => {
    try {
      modelRegistration?.release();
      if (modelRegistration && modelRegistration.keys.length === 0) {
        app.logger.info("[monsqlize] app-owned models released");
      }
    } catch (err) {
      app.logger.error("[monsqlize] error releasing app-owned models", {
        error: (err as Error).message,
      });
    }
    try {
      await monsqlize.close();
      app.logger.info("[monsqlize] connection closed");
    } catch (err) {
      app.logger.error("[monsqlize] error closing connection", {
        error: (err as Error).message,
      });
    }
    await stopMemoryServers();
  });

  // ── 4. 连接数据库（Fail Fast）─────────────────────────────
  try {
    const database = await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.connect",
      () => createConnection(monsqlize, app),
    );
    app.logger.info("[monsqlize] connected successfully");

    // ── 5. 加载 Model 定义 ────────────────────────────────────
    modelRegistration = await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.models",
      () => loadModels(monsqlize, config!.models, app, srcDir),
    );

    // ── 6. 挂载到 app ─────────────────────────────────────────
    await timeMonSQLize(
      options,
      "worker.builtinPlugin.monsqlize.extend",
      () => {
        app.extend("db", database);
      },
    );
  } catch (err) {
    await stopMemoryServers();
    try {
      modelRegistration?.release();
    } catch (releaseErr) {
      app.logger.warn(
        "[monsqlize] failed to release models after setup error",
        {
          error: (releaseErr as Error).message,
        },
      );
    }
    try {
      await monsqlize.close();
    } catch (closeErr) {
      app.logger.warn("[monsqlize] failed to close after setup error", {
        error: (closeErr as Error).message,
      });
    }
    throw err;
  }

  app.logger.info("[monsqlize] plugin ready");
}

function timeMonSQLize<T>(
  options: SetupMonSQLizeOptions,
  name: string,
  action: () => Promise<T> | T,
  detail?: Record<string, unknown>,
): Promise<T> {
  if (options.startupProfiler) {
    return options.startupProfiler.time(name, action, {
      phase: "database",
      detail,
    });
  }
  return Promise.resolve(action());
}

/**
 * 将 vext database 配置转换为 MonSQLize 构造函数配置
 *
 * 映射关系：
 *   - VextConfig.database.config        → MonSQLize({ config })
 *   - VextConfig.database.cache         → MonSQLize({ cache })
 *   - VextConfig.database.pools         → MonSQLize({ pools })
 *   - VextConfig.database.slowQueryLog  → MonSQLize({ slowQueryLog })
 *   - VextConfig.database.logger='app'  → 桥接到 app.logger
 *
 * @param config  用户的 database 配置
 * @param app     插件上下文（提供 logger 桥接）
 * @returns MonSQLize 构造函数配置对象
 */
function buildMonSQLizeConfig(
  config: MonSQLizeDatabaseConfig,
  app: VextPluginContext,
): Record<string, unknown> {
  const controlledOptions = resolveControlledMonSQLizeOptions(
    config.monsqlizeOptions,
  );

  // ── 映射 config.config（vext 用户配置 → MonSQLize 配置）────
  // N1: 同时支持 uri（主要）和 url（已废弃），做字段名映射。
  const mongoConfig: Record<string, unknown> = { ...config.config };
  if (
    "url" in mongoConfig &&
    mongoConfig.url != null &&
    !("uri" in mongoConfig)
  ) {
    mongoConfig.uri = mongoConfig.url;
    delete mongoConfig.url;
  }

  // N2: 提取 databaseName 传给 MonSQLize 实例
  // MonSQLize 从顶层 databaseName 字段读取并设置 this.databaseName，
  // 用于 _resolveModelCollection 中无 connection.database 时的默认数据库回退。
  const resolvedDatabaseName =
    config.databaseName ??
    (() => {
      const uri = (mongoConfig.uri ?? mongoConfig.url) as string | undefined;
      if (!uri) return undefined;
      try {
        const pathname = new URL(uri).pathname;
        const dbName = pathname.replace(/^\//, "").split("?")[0];
        return dbName || undefined;
      } catch {
        return undefined;
      }
    })();

  const result: Record<string, unknown> = {
    ...controlledOptions,
    // MonSQLize 的 type 字段是数据库类型（目前仅支持 "mongodb"），
    // 不同于 vext 的 database.type（连接模式：url / replica / srv）。
    // vext 的 config.type 已包含在 config.config 的结构中（url vs hosts vs host），
    // MonSQLize 内部通过 config 结构自动判断连接方式。
    type: "mongodb",
    config: mongoConfig,
    ...(resolvedDatabaseName != null && { databaseName: resolvedDatabaseName }),
    maxTimeMS: config.maxTimeMS ?? 2000,
    findLimit: config.findLimit ?? 10,
    findPageMaxLimit: config.findPageMaxLimit ?? 500,
    slowQueryMs: config.slowQueryMs ?? 500,
    autoConvertObjectId: config.autoConvertObjectId,
    namespace: config.namespace ?? { scope: "database" },
    cursorSecret: config.cursorSecret,
  };

  // ── 缓存配置 ──────────────────────────────────────────────
  if (config.cache) {
    const cacheConfig: Record<string, unknown> = {};

    if (config.cache.memory?.enabled !== false) {
      cacheConfig.memory = {
        maxSize: config.cache.memory?.maxSize ?? 1000,
        ttl: config.cache.memory?.ttl ?? 300,
      };
    }

    if (config.cache.redis?.enabled) {
      const redisUri = resolveRedisCacheUri(config.cache.redis);
      cacheConfig.redis = {
        uri: redisUri,
        prefix: config.cache.redis.prefix,
        ttl: config.cache.redis.ttl,
      };
    }

    result.cache = cacheConfig;
  }

  // ── 多连接池 ──────────────────────────────────────────────
  // monSQLize 的 PoolConfig 校验器要求扁平结构 { name, uri, options? }，
  // 而非嵌套的 { name, config: { uri } }。此处把用户在 vext 配置中写的
  // { name, config: { url|uri } } 平铺为 { name, uri, options? }。
  if (config.pools && config.pools.length > 0) {
    result.pools = config.pools.map((pool) => {
      const inner: Record<string, unknown> = { ...(pool.config || {}) };
      let uri: unknown = inner.uri;
      if (uri == null && inner.url != null) uri = inner.url;
      const flat: Record<string, unknown> = { name: pool.name, uri };
      if (pool.options !== undefined) flat.options = pool.options;
      // 透传可选字段（role/weight/tags/healthCheck 等）
      for (const k of ["role", "weight", "tags", "healthCheck"] as const) {
        if ((pool as any)[k] !== undefined) flat[k] = (pool as any)[k];
      }
      return flat;
    });
    result.poolStrategy = config.poolStrategy ?? "auto";
  }

  // ── 慢查询日志 ────────────────────────────────────────────
  if (config.slowQueryLog?.enabled) {
    result.slowQueryLog = {
      collection: config.slowQueryLog.collection ?? "_slow_queries",
    };
  }

  // ── 日志器（桥接 app.logger）──────────────────────────────
  if (config.logger !== false) {
    result.logger = {
      info: (msg: string, meta?: unknown) =>
        app.logger.info(`[monsqlize] ${msg}`, meta as Record<string, unknown>),
      warn: (msg: string, meta?: unknown) =>
        app.logger.warn(`[monsqlize] ${msg}`, meta as Record<string, unknown>),
      error: (msg: string, meta?: unknown) =>
        app.logger.error(`[monsqlize] ${msg}`, meta as Record<string, unknown>),
      debug: (msg: string, meta?: unknown) =>
        app.logger.debug(`[monsqlize] ${msg}`, meta as Record<string, unknown>),
    };
  }

  return result;
}

const MONSQLIZE_ALLOWED_OPTION_KEY_SET = new Set<string>(
  MONSQLIZE_ALLOWED_OPTION_KEYS,
);
const MONSQLIZE_PROTECTED_OPTION_KEY_SET = new Set<string>(
  MONSQLIZE_PROTECTED_OPTION_KEYS,
);

function resolveControlledMonSQLizeOptions(
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "[monsqlize] database.monsqlizeOptions must be a plain options object.",
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "[monsqlize] database.monsqlizeOptions must be a plain options object.",
    );
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (MONSQLIZE_ALLOWED_OPTION_KEY_SET.has(key)) {
      continue;
    }
    if (MONSQLIZE_PROTECTED_OPTION_KEY_SET.has(key)) {
      throw new Error(
        `[monsqlize] database.monsqlizeOptions.${key} is managed by Vext and cannot be overridden.`,
      );
    }
    throw new Error(
      `[monsqlize] Unsupported database.monsqlizeOptions key "${key}". Allowed keys: ${MONSQLIZE_ALLOWED_OPTION_KEYS.join(", ")}.`,
    );
  }

  return Object.fromEntries(
    MONSQLIZE_ALLOWED_OPTION_KEYS.filter((key) =>
      Object.hasOwn(input, key),
    ).map((key) => [key, input[key]]),
  );
}

type RedisCacheConfig = NonNullable<
  NonNullable<MonSQLizeDatabaseConfig["cache"]>["redis"]
>;

function resolveRedisCacheUri(redis: RedisCacheConfig): string {
  const value = redis.uri ?? redis.url;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      '[monsqlize] database.cache.redis.uri must be a non-empty Redis connection string when database.cache.redis.enabled is true. Use uri: "redis://..." (url is a deprecated alias).',
    );
  }
  return value.trim();
}

function toEventNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
