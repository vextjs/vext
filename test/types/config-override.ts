import type {
  VextConfigOverride,
  VextConfigOverrideAtomicPathRegistry,
  VextMonSQLizeOptions,
  VextUserConfig,
} from "vextjs";

type SchemaDslConfig = Exclude<
  NonNullable<VextMonSQLizeOptions["schemaDsl"]>,
  false
>;
type SchemaDslRuntime = NonNullable<SchemaDslConfig["runtime"]>;

declare const schemaDslRuntime: SchemaDslRuntime;

declare module "vextjs" {
  interface VextConfig {
    myPlugin?: {
      endpoint: {
        url: string;
        retry: {
          attempts: number;
          backoff: { minMs: number; maxMs: number };
        };
      };
      client: {
        name: string;
        request(path: string): Promise<unknown>;
      };
      unregisteredClient: {
        name: string;
        request(path: string): Promise<unknown>;
      };
    };
  }

  interface VextConfigOverrideAtomicPathRegistry {
    "myPlugin.client": true;
  }
}

const strictBase = {
  database: {
    config: { uri: "mongodb://127.0.0.1:27017/app" },
    findLimit: 20,
    models: { dir: "models" },
  },
} satisfies VextUserConfig;

const databaseOverride = {
  database: {
    findLimit: 50,
    models: { validation: "strict" },
  },
} satisfies VextConfigOverride;

const databaseConnectionOverride = {
  database: {
    config: { uri: "mongodb://127.0.0.1:27017/override" },
  },
} satisfies VextConfigOverride;

const schemaDslOverride = {
  database: {
    monsqlizeOptions: {
      schemaDsl: { enabled: false },
    },
  },
} satisfies VextConfigOverride;

const nestedOverride = {
  logger: { level: "warn" },
  openapi: { contact: { email: "framework@example.com" } },
  myPlugin: {
    endpoint: { retry: { backoff: { maxMs: 2_000 } } },
    // Plain augmented objects are recursive patches until their path is registered.
    unregisteredClient: { name: "partial" },
  },
} satisfies VextConfigOverride;

const atomicPath: keyof VextConfigOverrideAtomicPathRegistry =
  "myPlugin.client";

const incompleteBase = {
  // @ts-expect-error A base database section must include its required config object.
  database: { findLimit: 50 },
} satisfies VextUserConfig;

const incompleteAdapter = {
  // @ts-expect-error Adapter capabilities are replaced atomically.
  adapter: { name: "partial" },
} satisfies VextConfigOverride;

const incompleteStore = {
  session: {
    // @ts-expect-error Session stores are replaced atomically.
    store: { get: () => null },
  },
} satisfies VextConfigOverride;

const incompleteFrontendAdapter = {
  frontend: {
    // @ts-expect-error Frontend adapters retain their complete contract.
    adapter: { name: "partial" },
  },
} satisfies VextConfigOverride;

const incompleteUploadAdapter = {
  frontend: {
    deploy: {
      upload: {
        // @ts-expect-error Upload adapters retain their complete contract.
        adapter: { name: "partial" },
      },
    },
  },
} satisfies VextConfigOverride;

const incompleteCacheHub = {
  cache: {
    // @ts-expect-error Redis cache-hub branches require their mode discriminator.
    cacheHub: { url: "redis://127.0.0.1:6379" },
  },
} satisfies VextConfigOverride;

const completeRedisCacheHub = {
  cache: {
    cacheHub: {
      mode: "redis",
      url: "redis://127.0.0.1:6379",
    },
  },
} satisfies VextConfigOverride;

const completeSchemaDslRuntime = {
  database: {
    monsqlizeOptions: {
      schemaDsl: { runtime: schemaDslRuntime },
    },
  },
} satisfies VextConfigOverride;

const incompleteSchemaDslRuntime = {
  database: {
    monsqlizeOptions: {
      schemaDsl: {
        // @ts-expect-error schemaDsl.runtime capabilities are replaced atomically.
        runtime: { validate: () => ({}) },
      },
    },
  },
} satisfies VextConfigOverride;

const incompleteCallback = {
  requestId: {
    // @ts-expect-error Callback values are replaced atomically.
    generate: {},
  },
} satisfies VextConfigOverride;

const partialArrayElement = {
  openapi: {
    // @ts-expect-error Arrays are replaced as complete arrays, not arrays of patches.
    servers: [{}],
  },
} satisfies VextConfigOverride;

const wrongLeaf = {
  logger: {
    // @ts-expect-error Recursive patches preserve scalar leaf types.
    level: "chatty",
  },
} satisfies VextConfigOverride;

const incompleteAugmentedCapability = {
  myPlugin: {
    // @ts-expect-error Augmented atomic paths retain the plugin's full client contract.
    client: { name: "partial" },
  },
} satisfies VextConfigOverride;

void strictBase;
void databaseOverride;
void databaseConnectionOverride;
void schemaDslOverride;
void nestedOverride;
void atomicPath;
void incompleteBase;
void incompleteAdapter;
void incompleteStore;
void incompleteFrontendAdapter;
void incompleteUploadAdapter;
void incompleteCacheHub;
void completeRedisCacheHub;
void completeSchemaDslRuntime;
void incompleteSchemaDslRuntime;
void incompleteCallback;
void partialArrayElement;
void wrongLeaf;
void incompleteAugmentedCapability;
