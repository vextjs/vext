# Response caching

VextJS provides declarative route-level response caching, configured through the `cache` field of the route options. When the cache is hit, parameter verification and handler execution are skipped, and the cached JSON response is returned directly.

## Basic usage

### Numeric abbreviation

The simplest configuration, specifying the cache validity period in milliseconds:

```typescript
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  // cache for 60 seconds
  app.get("/products", { cache: 60_000 }, async (req, res) => {
    const products = await db.getProducts();
    res.json(products);
  });
});
```

### Complete configuration

```typescript
app.get(
  "/products",
  {
    cache: {
      ttl: 120_000, // cache for 120 seconds
      vary: ["accept-language"], // Different languages are cached separately
      tags: ["products"], // Tags (for batch invalidation)
      condition: (req) => !req.query.refresh, // condition cache
      cacheControl: true, //Set the Cache-Control header (default true)
    },
  },
  async (req, res) => {
    res.json(await db.getProducts());
  },
);
```

### Explicitly disable

```typescript
app.get("/realtime", { cache: false }, async (req, res) => {
  res.json({ timestamp: Date.now() });
});
```

## Configuration options

### RouteOptions.cache

| Field                     | Type                        | Default Value           | Description                                                                                               |
| ------------------------- | --------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `ttl`                     | `number`                    | —                       | Cache validity period, in milliseconds, must be > 0                                                       |
| `key`                     | `string \| (req) => string` | Automatically generated | Custom cache key; `partitionKey` and `vary` will still participate in the final underlying key            |
| `condition`               | `(req) => boolean`          | —                       | The caching logic is only used when `true` is returned                                                    |
| `vary`                    | `string[] \| "*"`           | `[]`                    | Request headers that participate in caching key; `"*"` means that all request headers are involved        |
| `partitionKey`            | `string \| (req) => string` | —                       | User, tenant or other business partition, used for isolation zone authentication or multi-tenant response |
| `allowAuthorizationCache` | `boolean`                   | `false`                 | Whether to still allow caching of requests with `Authorization` when there is no `partitionKey`           |
| `allowCookieCache`        | `boolean`                   | `false`                 | Whether to allow requests with a `Cookie` header to participate in cache                                  |
| `cacheControl`            | `boolean`                   | `true`                  | Whether to set the `Cache-Control` response header                                                        |
| `tags`                    | `string[]`                  | `[]`                    | Cache tag, used for `app.cache.invalidate(tag)` batch invalidation                                        |

### Global configuration (config.cache)

`config.cache` controls the response caching runtime for the entire application. Whether a route is cached is still determined by each route's `RouteOptions.cache`.

```typescript
// src/config/default.ts
export default {
  cache: {
    enabled: true, // Whether to enable route-level response caching (default true)
    defaultTtl: 60_000, //The default value when the route does not specify ttl, in milliseconds
    maxEntries: 1000, // Memory quick configuration: maximum number of cache entries
    maxMemory: 50 * 1024 * 1024, // Memory quick configuration: maximum memory usage bytes
    cleanupInterval: 30_000, // Memory quick configuration: periodic cleaning interval, 0 means only lazy cleaning
  },
};
```

The response cache runtime is handled by `response-cache-kit`, and the underlying cache is managed by `cache-hub`. Vext does not open custom Store for response cache; if you need to adjust the underlying runtime, please configure `cache.cacheHub`. Session Store is separate: use `createCacheSessionStore(cacheLike)` with its own prefix instead of reusing `app.cache` or `config.cache.cacheHub`.

#### config.cache field

| Field             | Type      | Default Value | Description                                                                                                                                                            |
| ----------------- | --------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`        | Whether to enable route-level response caching. When set to `false`, the cache middleware will not be installed and the Redis/MultiLevel connection will not be opened |
| `defaultTtl`      | `number`  | `60000`       | The default TTL when the route does not specify `ttl`, in milliseconds                                                                                                 |
| `maxEntries`      | `number`  | `1000`        | Memory mode quick configuration, effective when `cacheHub` is not configured or is Memory                                                                              |
| `maxMemory`       | `number`  | —             | Memory mode quick configuration, maximum memory usage bytes                                                                                                            |
| `cleanupInterval` | `number`  | `0`           | Memory mode quick configuration, periodic cleaning interval; `0` means lazy cleaning only during access                                                                |
| `cacheHub`        | `object`  | Memory        | Underlying runtime configuration: Memory, Redis, MultiLevel, lease, distributed                                                                                        |

#### Memory cacheHub

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

| Field             | Type       | Default Value | Description                                    |
| ----------------- | ---------- | ------------- | ---------------------------------------------- |
| `mode`            | `"memory"` | `"memory"`    | Use in-process Memory cache                    |
| `maxEntries`      | `number`   | `1000`        | Maximum number of entries                      |
| `maxMemory`       | `number`   | —             | Maximum memory usage bytes                     |
| `cleanupInterval` | `number`   | `0`           | Periodic cleanup interval, in milliseconds     |
| `enableStats`     | `boolean`  | `true`        | Whether to record statistical information      |
| `enabled`         | `boolean`  | `true`        | Whether the underlying Memory Store is enabled |

#### Redis cacheHub

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

Redis mode is suitable for multiple instances to share response cache. When enabling Redis/MultiLevel in a business project, `ioredis` needs to be installed:

```bash
npm install ioredis
```

| Field           | Type                | Default Value            | Description                                            |
| --------------- | ------------------- | ------------------------ | ------------------------------------------------------ |
| `mode`          | `"redis"`           | Required                 | Use Redis to store response snapshots                  |
| `url`           | `string`            | `redis://localhost:6379` | Redis URL                                              |
| `client`        | `object`            | —                        | Existing Redis-like client, advanced usage             |
| `metaKeyPrefix` | `string`            | cache-hub default value  | tag metadata key prefix                                |
| `scanCount`     | `number`            | cache-hub default value  | SCAN batch size                                        |
| `deleteCommand` | `"del" \| "unlink"` | `del`                    | Delete command; large value recommended `unlink`       |
| `lease`         | `boolean \| object` | `false`                  | Cross-process coordination with key back to the source |
| `distributed`   | `boolean \| object` | `false`                  | Distributed pattern/tag failure broadcast              |

#### MultiLevel cacheHub

```typescript
export default {
  cache: {
    defaultTtl: 60_000,
    cacheHub: {
      mode: "multi-level",
      memory: {
        maxEntries: 1000,
        cleanupInterval: 30_000,
      },
      redis: {
        url: "redis://localhost:6379",
      },
      writePolicy: "both",
      backfillOnRemoteHit: true,
      remoteTimeout: 50,
      lease: true,
    },
  },
};
```

MultiLevel uses the memory of this process as L1 and Redis as L2. It is suitable for services that want to reduce the reading pressure of Redis but still need to share the cache across processes.

| Field                      | Type                                   | Default Value           | Description                                                       |
| -------------------------- | -------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `mode`                     | `"multi-level"`                        | Required                | Enable L1 Memory + L2 Redis                                       |
| `memory`                   | `object`                               | `{}`                    | L1 Memory configuration                                           |
| `redis`                    | `object`                               | `{}`                    | L2 Redis configuration                                            |
| `writePolicy`              | `"both" \| "local-first-async-remote"` | `both`                  | Write policy                                                      |
| `backfillOnRemoteHit`      | `boolean`                              | cache-hub default value | Whether to backfill L1 after L2 hits                              |
| `remoteTimeout`            | `number`                               | cache-hub default value | L2 operation timeout in milliseconds                              |
| `remoteInvalidationErrors` | `"ignore" \| "throw"`                  | cache-hub default value | L2 invalidation error handling                                    |
| `lease`                    | `boolean \| object`                    | `false`                 | Use the Redis layer for cross-process back-to-source coordination |
| `distributed`              | `boolean \| object`                    | `false`                 | Distributed failure broadcast                                     |

#### lease and distributed

`lease` is used to reduce multi-process cache breakdown: after the same key expires, one process obtains the lease and executes the handler, and other processes wait briefly for the cache to be written. By default, the system continues to return to the source after waiting timeout, with priority given to ensuring availability.

```typescript
lease: {
  ttl: 500,
  waitForOwner: 1_000,
  pollInterval: 10,
  onTimeout: "fetch", // or "throw"
}
```

`distributed` is used to broadcast invalidation actions such as `app.cache.invalidate(tag)` and `app.cache.clear()` to other instances:

```typescript
distributed: {
  redisUrl: "redis://localhost:6379",
  channel: "vext:response-cache",
  instanceId: "api-1",
}
```

## Caching behavior

By default only GET / HEAD requests are processed, and successful responses sent via `res.json()` are captured. `res.text()`, streaming responses, downloads and redirects do not write to the response cache.

### Response header

| header          | value               | description                                           |
| --------------- | ------------------- | ----------------------------------------------------- |
| `X-Cache`       | `HIT`               | cache hit                                             |
| `X-Cache`       | `MISS`              | Cache miss (first request or expiration)              |
| `Cache-Control` | `public, max-age=N` | N=TTL seconds when MISS, N=remaining seconds when HIT |

### Cache Key algorithm

The default key is a versioned JSON tuple containing the request method, path, sorted query tuples and normalized `vary` header tuples. Tuple boundaries prevent delimiter collisions; `partitionKey` remains an additional isolation dimension in the underlying cache key.

```
GET /products → ["v2","GET","/products",[],[]]
GET /products?limit=10&page=2 → ["v2","GET","/products",[["limit","10"],["page","2"]],[]]
GET /products (Accept-Language: zh-CN) → ["v2","GET","/products",[],[["accept-language",["zh-CN"]]]]
```

- Query parameters are automatically sorted (`?b=2&a=1` ≡ `?a=1&b=2`)
- Requests with `Authorization` are not cached by default unless `partitionKey` is configured or `allowAuthorizationCache: true` is explicitly set
- Requests with `Cookie` are not cached by default unless `allowCookieCache: true` is explicitly set
- When you need to differentiate cache by user or tenant, use `partitionKey` first
- When using a custom `key`, `partitionKey` and `vary` will still be appended to the underlying key

### Scenarios without caching

- `204 No Content` response
- Non-2xx status codes (3xx/4xx/5xx)
- Response contains `Set-Cookie`
- Response header contains `Cache-Control: no-store` or `private`
- The request header contains `Cache-Control: no-store` or `no-cache`
- With `Authorization` and no `partitionKey` / `allowAuthorizationCache` configured
- With `Cookie` and no `allowCookieCache` configured
- Response not sent via `res.json()`
- `cache: false` explicitly disabled
- `cache: 0` or negative value
- `condition` returns `false`
- Custom `key` returns empty string

## Runtime API

Operate the cache in the route handler through `app.cache`:

```typescript
// Invalidate batches by tag
app.post("/products", {}, async (req, res) => {
  await db.createProduct(req.body);
  await app.cache.invalidate("products"); // All caches with products tags are invalidated
  res.json({ created: true }, 201);
});

// Delete the specified default key
await app.cache.delete('["v2","GET","/products",[],[]]');

//Clear all caches
await app.cache.clear();

// View statistics
const stats = app.cache.stats();
// → { entries: 42, hits: 128, misses: 31, hitRate: 0.805 }
```

`app.cache.clear()` clears the current vext response cache namespace. In Redis/MultiLevel mode, it will not perform a full Redis database clear.

## Vary Headers

Different request header values will generate different cache entries:

```typescript
app.get(
  "/products",
  {
    cache: {
      ttl: 120_000,
      vary: ["accept-language"],
    },
  },
  handler,
);
```

```
GET /products (Accept-Language: zh-CN) → independent cache
GET /products (Accept-Language: en-US) → independent cache
```

Allow all request headers to participate in the cache key:

```typescript
app.get("/debug", { cache: { ttl: 10_000, vary: "*" } }, handler);
```

`vary: "*"` will significantly increase the number of cache entries and is generally only recommended for debugging, proxy pass-through, or interfaces that really require strong isolation.

## Conditional caching

Use the `condition` function to control whether to use caching logic:

```typescript
app.get(
  "/data",
  {
    cache: {
      ttl: 60_000,
      // Skip cache when taking refresh parameter
      condition: (req) => !req.query.refresh,
    },
  },
  handler,
);
```

```bash
curl /data # Go to cache
curl /data?refresh=1 # Skip the cache and execute the handler directly
```

## Custom Key

Fixed business key:

```typescript
app.get(
  "/products",
  {
    cache: {
      ttl: 60_000,
      key: "products:list",
      tags: ["products"],
    },
  },
  handler,
);
```

When you need to generate key according to request parameters:

```typescript
app.get(
  "/profile",
  {
    cache: {
      ttl: 300_000,
      key: (req) => `profile:${req.headers["x-user-id"] ?? "anonymous"}`,
    },
  },
  handler,
);
```

## Partition Key

`partitionKey` is the cache partition. It does not change the business response, but only isolates the underlying cache keys by user, tenant, region and other dimensions.

```typescript
app.get(
  "/tenant/products",
  {
    cache: {
      ttl: 60_000,
      key: "tenant:products",
      partitionKey: (req) => req.headers["x-tenant-id"],
      tags: ["products"],
    },
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  },
  handler,
);
```

In the above example, even if multiple tenants access the same URL, different cache partitions will be written. Requests with `Authorization` will bypass the cache by default; Vext will only allow it to enter the response cache after `partitionKey` is configured.

If you confirm that the response is not relevant to the user, you can also enable it explicitly:

```typescript
app.get(
  "/public-with-auth",
  {
    cache: {
      ttl: 60_000,
      allowAuthorizationCache: true,
    },
  },
  handler,
);
```

Most business interfaces recommend using `partitionKey` instead of directly opening `allowAuthorizationCache`.

## Concurrently send back to the source

After the same cache key expires, if 100 requests arrive at the same time, Vext will execute the handler only once through the single-flight mechanism of `response-cache-kit`, and the remaining requests will wait for the same return-to-origin result to avoid cache breakdown. The request that actually executes the handler is `MISS`; the request that waits and reuses the same result will output `HIT`.

## Safety precautions

:::warning
**Authentication routing + cache**: Requests with `Authorization` will not be written to the response cache by default. When you need to cache authentication interfaces, use `partitionKey` to explicitly isolate users or tenants.

The framework detects this scenario and issues a warning on startup. Solution:

- Use `partitionKey` to isolate by user/tenant
- Use `condition` to exclude requests that should not be cached
- Set `allowAuthorizationCache: true` only if the acknowledgment response is not relevant to the user

:::

```typescript
// Recommendation: Use partitionKey for tenant isolation
app.get(
  "/my-orders",
  {
    cache: {
      ttl: 60_000,
      partitionKey: (req) => req.headers["x-user-id"],
    },
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  },
  handler,
);

//Also: authenticated users do not go through the cache
app.get(
  "/products",
  {
    cache: {
      ttl: 60_000,
      condition: (req) => !req.headers.authorization,
    },
    middlewares: ["auth"],
    auth: { required: true, security: "bearerAuth" },
  },
  handler,
);
```
