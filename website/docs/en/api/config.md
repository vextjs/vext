# Configuration items

This page details all configuration fields, types, default values and usage instructions of VextJS.

## Configuration loading mechanism

VextJS uses a **multi-layer configuration merging** strategy, in order of priority from low to high:

```
DEFAULT_CONFIG (framework built-in default value)
  ↓ Deep merge
src/config/default.ts (project default configuration)
  ↓ Deep merge
src/config/{profile}.ts (config profile, such as production.ts or sg-sit.ts)
  ↓ Deep merge
src/config/local.ts (local override, optional)
  ↓ provider patch
src/config/bootstrap.ts (remote configuration during startup, optional)
  ↓ CLI override
vext start/dev --port --host ...
```

The merged configuration is deep-frozen through `deepFreeze()` and cannot be modified at runtime.

### Configuration file list

| File                        | Purpose                                | Is it necessary |
| --------------------------- | -------------------------------------- | :-------------: |
| `src/config/default.ts`     | Basic configuration for all profiles   |       ✅        |
| `src/config/development.ts` | Default development profile overrides  |    Optional     |
| `src/config/production.ts`  | Default production profile overrides   |    Optional     |
| `src/config/test.ts`        | Default test profile overrides         |    Optional     |
| `src/config/sg-sit.ts`      | Custom profile overrides               |    Optional     |
| `src/config/local.ts`       | Local override (usually no Git commit) |    Optional     |
| `src/config/bootstrap.ts`   | Startup provider registration entrance |    Optional     |

### `src/config/bootstrap.ts`

When the database, key or configuration center patch needs to be injected before the configuration is frozen, you can add:

```typescript
import { defineBootstrapConfig } from "vextjs";

export default defineBootstrapConfig({
  providers: [
    {
      name: "remote-config",
      timeoutMs: 10_000,
      async load({ configProfile, signal, baseConfig }) {
        const response = await fetch(
          `https://config.example.com/${configProfile}.json`,
          { signal },
        );
        const remote = await response.json();
        return {
          database: remote.database,
          logger: {
            lifecycleLevel: baseConfig.logger?.lifecycleLevel ?? "concise",
          },
        };
      },
    },
  ],
});
```

Constraints:

- provider must return plain object patch or `null`
- patch only supports JSON-like structure
- `timeoutMs` is a hard deadline: expiry aborts the provider `signal`, and a patch returned by a late continuation is discarded rather than merged
- When `required` is not declared: `production` defaults to fail-fast, `development/test` defaults to continue after warning
- In Cluster mode, the same provider patch will be reused in the same startup cycle to prevent Master / Worker from seeing different results.

### Configuration file example

```typescript
// src/config/default.ts
export default {
  port: 3000,
  adapter: "native",
  cors: {
    enabled: true,
    origins: ["http://localhost:3000"],
  },
  logger: {
    level: "debug",
  },
};
```

```typescript
// src/config/production.ts
export default {
  port: 8080,
  cors: {
    origins: ["https://api.example.com"],
  },
  logger: {
    level: "warn",
  },
  response: {
    hideInternalErrors: true,
  },
};
```

---

## Complete configuration reference

### `VextConfig`

| Field             | Type                                                    | Default Value        | Description                                                                  |
| ----------------- | ------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `port`            | `number`                                                | `3000`               | HTTP listening port                                                          |
| `host`            | `string`                                                | `'0.0.0.0'`          | HTTP listening address                                                       |
| `adapter`         | `string \| Function \| VextAdapter`                     | `'native'`           | Low-level adapter                                                            |
| `trustProxy`      | `boolean`                                               | `false`              | Whether to trust the proxy                                                   |
| `middlewares`     | `VextMiddlewareConfig[]`                                | `[]`                 | Route-level middleware whitelist                                             |
| `cors`            | [`VextCorsConfig`](#vextcorsconfig)                     | See below            | CORS configuration                                                           |
| `rateLimit`       | [`VextRateLimitConfig`](#vextratelimitconfig)           | See below            | Rate limit configuration                                                     |
| `requestId`       | [`VextRequestIdConfig`](#vextrequestidconfig)           | See below            | Request ID configuration                                                     |
| `logger`          | [`VextLoggerConfig`](#vextloggerconfig)                 | See below            | Log configuration                                                            |
| `shutdown`        | [`VextShutdownConfig`](#vextshutdownconfig)             | See below            | Graceful shutdown configuration                                              |
| `server`          | [`VextServerConfig`](#vextserverconfig)                 | `{}`                 | Node.js HTTP server configuration                                            |
| `response`        | [`VextResponseConfig`](#vextresponseconfig)             | See below            | Response configuration                                                       |
| `session`         | `VextSessionConfig`                                     | See below            | Session auto-registration, store, and cookie configuration                   |
| `csrf`            | `VextCsrfConfig`                                        | See below            | CSRF middleware configuration                                                |
| `securityHeaders` | `VextSecurityHeadersConfig`                             | `{ enabled: false }` | Browser security response headers                                            |
| `bodyParser`      | [`VextBodyParserConfig`](#vextbodyparserconfig)         | See below            | Body parsing configuration                                                   |
| `multipart`       | [`VextMultipartConfig`](#vextmultipartconfig)           | `undefined`          | File upload configuration                                                    |
| `accessLog`       | [`VextAccessLogConfig`](#vextaccesslogconfig)           | See below            | Access log configuration                                                     |
| `openapi`         | [`VextOpenAPIConfig`](#vextopenapiconfig)               | See below            | OpenAPI documentation configuration                                          |
| `requestContext`  | [`VextRequestContextConfig`](#vextrequestcontextconfig) | See below            | Request context configuration                                                |
| `fetch`           | [`VextFetchConfig`](#vextfetchconfig)                   | See below            | Built-in HTTP client and proxy configuration                                 |
| `database`        | `MonSQLizeDatabaseConfig`                               | `undefined`          | Built-in MonSQLize plugin extension; see [Database guide](../guide/database) |
| `frontend`        | `boolean \| VextFrontendConfig`                         | `{ enabled: false }` | Built-in frontend build and static serving configuration                     |
| `cluster`         | [`Partial<VextClusterConfig>`](#vextclusterconfig)      | `undefined`          | Cluster multi-process configuration                                          |
| `cache`           | [`VextCacheConfig`](#vextcacheconfig)                   | See below            | Route-level response cache configuration                                     |
| `dev`             | [`VextDevConfig`](#vextdevconfig)                       | See below            | Development-only tooling configuration                                       |

`host` accepts `"0.0.0.0"`, `"::"`, an explicit IPv4 address, an explicit IPv6 address, or a hostname. With `"::"`, the ready log prints IPv4 local URLs plus bracketed IPv6 local/network URLs such as `http://[::1]:3000`; explicit IPv6 hosts are printed with brackets too.

---

### `adapter`

The underlying HTTP adapter supports three parameter passing methods:

```typescript
// Method 1: String identification (built-in adapter)
export default {
  adapter: "native", // 'native' | 'hono' | 'fastify' | 'express' | 'koa'
};

// Method 2: Factory function (pass in custom options)
import { fastifyAdapter } from "vextjs/adapters/fastify";

export default {
  adapter: fastifyAdapter({ bodyLimit: 5 * 1024 * 1024 }),
};

//Method 3: Custom adapter instance (implementing VextAdapter interface)
export default {
  adapter: myCustomAdapter,
};
```

### `trustProxy`

When set to `true`:

- `req.ip` reads the first IP from the `X-Forwarded-For` request header
- `req.protocol` is read from the `X-Forwarded-Proto` request header

This option needs to be enabled when deployed behind Nginx/cloud load balancer.

### `middlewares`

Route-level middleware whitelist declaration. Only middleware declared here can be referenced in routes `options.middlewares`.

```typescript
export default {
  middlewares: [
    { name: "auth" },
    { name: "framework-auth" },
    { name: "admin", options: { role: "admin" } },
    { name: "client-cache", options: { maxAge: 60 } },
  ],
};
```

:::tip
Global middleware (such as CORS, body-parser) is automatically registered by the framework and does not need to be declared here. Only **routing-level optional middleware** is declared here.
:::

The first-party `auth()` helper is still registered as a route-level middleware file, then routes opt into protection with `RouteOptions.auth`:

```typescript
// src/middlewares/framework-auth.ts
import { auth, defineMiddleware } from "vextjs";

export default defineMiddleware(
  auth({
    async verify(token) {
      return token === "demo-token" ? { userId: "1" } : false;
    },
  }),
);
```

---

## VextCorsConfig

Cross-domain resource sharing configuration.

| Field         | Type       | Default Value                                                  | Description                                |
| ------------- | ---------- | -------------------------------------------------------------- | ------------------------------------------ |
| `enabled`     | `boolean`  | `true`                                                         | Whether to enable CORS                     |
| `origins`     | `string[]` | `['*']`                                                        | Allowed origin domain names                |
| `methods`     | `string[]` | `['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']` | Allowed HTTP methods                       |
| `headers`     | `string[]` | `['Content-Type', 'Authorization', 'X-Request-Id']`            | Allowed request headers                    |
| `credentials` | `boolean`  | `false`                                                        | Whether to allow carrying credentials      |
| `maxAge`      | `number`   | `undefined`                                                    | CORS preflight result cache time (seconds) |

```typescript
export default {
  cors: {
    enabled: true,
    origins: ["https://app.example.com", "https://admin.example.com"],
    credentials: true,
    maxAge: 86400,
  },
};
```

:::warning
`origins: ['*']` and `credentials: true` cannot be used at the same time. When you need to carry credentials, you must specify a specific domain name.
:::

---

## VextRateLimitConfig

Global rate limit configuration, implemented based on `flex-rate-limit`.

| Field     | Type                 | Default Value         | Description                                       |
| --------- | -------------------- | --------------------- | ------------------------------------------------- |
| `enabled` | `boolean`            | `false`               | Whether to enable global rate limiting            |
| `max`     | `number`             | `100`                 | Maximum number of requests within the time window |
| `window`  | `number`             | `60`                  | Time window (seconds)                             |
| `message` | `string`             | `'Too Many Requests'` | Overrun error message                             |
| `keyBy`   | `string \| Function` | `'ip'`                | Request source identifier                         |

```typescript
export default {
  rateLimit: {
    enabled: true,
    max: 200,
    window: 120,
    //Limit flow by user ID (requires auth middleware to parse the user first)
    keyBy: (req) => req.user?.id ?? req.ip,
  },
};
```

### `keyBy` option

| value             | description                                |
| ----------------- | ------------------------------------------ |
| `'ip'`            | Limit flow by client IP (default)          |
| `'user'`          | Press `req.user?.id` to limit current      |
| `(req) => string` | Custom function, returns unique identifier |

:::tip
After global rate limiting is explicitly enabled, a route can override it via `options.override.rateLimit`, or set it to `false` to disable rate limiting.
:::

---

## VextRequestIdConfig

Request ID tracing configuration for log correlation and distributed link tracing.

| Field            | Type           | Default Value         | Description                                                          |
| ---------------- | -------------- | --------------------- | -------------------------------------------------------------------- |
| `enabled`        | `boolean`      | `true`                | Whether to enable request ID                                         |
| `header`         | `string`       | `'x-request-id'`      | From which request header to read (gateway transparent transmission) |
| `responseHeader` | `string`       | `'x-request-id'`      | The name to write the response header                                |
| `generate`       | `() => string` | `crypto.randomUUID()` | Custom ID generation function                                        |

### requestId vs traceId

`requestId` is the unique identifier of the request built into vext, and `traceId` usually refers to the tracing ID generated by the APM link tracking system (such as OpenTelemetry / Jaeger). Both have different usage scenarios:

**Mode 1: requestId acts as traceId (simple scenario)**

Change the request header name of `requestId` to `x-trace-id` to unify it with the link tracking header, which is suitable for systems that do not rely on external APM:

```typescript
import { nanoid } from "nanoid";

export default {
  requestId: {
    header: "x-trace-id", // Read from x-trace-id (gateway injection)
    responseHeader: "x-trace-id", // Write back the response header
    generate: () => nanoid(), // Can be replaced by a shorter ID generator
  },
};
```

**Mode 2: requestId + APM traceId coexist (enterprise-level scenario)**

Keep `requestId` (log association), and transparently transmit APM's `traceparent` header through `config.fetch.propagateHeaders`, suitable for connecting to OpenTelemetry / Jaeger and other systems:

```typescript
export default {
  // requestId retains the default configuration (for log correlation)
  requestId: {
    header: "x-request-id",
    responseHeader: "x-request-id",
  },
  // APM tracking headers are automatically transparently transmitted to downstream services through propagateHeaders
  fetch: {
    propagateHeaders: ["traceparent", "tracestate"],
  },
};
```

:::tip Select suggestions

- Internal system, simple tracing → Mode 1 (rename header to `x-trace-id`)
- Access OpenTelemetry / Jaeger / Datadog → Mode 2 (retain requestId, configure propagateHeaders)
- For details, see [Request context → Relationship with distributed tracing](/guide/request-context#Relationship with distributed tracing traceId)
  :::

Generators can also be replaced dynamically via plugins:

```typescript
app.setRequestIdGenerator(() => myCustomId());
```

---

## VextFetchConfig

Built-in HTTP client and request proxy configuration.

| Field              | Type                                    | Default Value | Description                                                                        |
| ------------------ | --------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `timeout`          | `number`                                | `10000`       | `app.fetch` and `app.fetch.proxy` default timeouts                                 |
| `retry`            | `number`                                | `0`           | The default number of retries, indicating the number of additional attempts        |
| `retryDelay`       | `number \| (attempt: number) => number` | `1000`        | Default retry interval, supports function form                                     |
| `propagateHeaders` | `string[]`                              | `[]`          | Common `app.fetch` request header whitelist for automatic transparent transmission |
| `proxy`            | `VextFetchProxyTargetConfig[]`          | `[]`          | List of upstream targets for `app.fetch.proxy.<name>()`                            |

`timeout` must be a finite positive number no greater than `2147483647` milliseconds. `retryDelay` must be a finite non-negative number no greater than `2147483647` milliseconds, and function return values are validated at runtime.

```typescript
export default {
  fetch: {
    timeout: 10_000,
    retry: 1,
    retryDelay: 500,
    propagateHeaders: ["traceparent", "x-tenant-id"],
    proxy: [
      {
        name: "userService",
        baseURL: "http://user-service:3001/api",
        forwardHeaders: ["x-tenant-id"],
        headers: { "x-source": "gateway" },
        timeout: 5000,
        retry: 1,
      },
    ],
  },
};
```

### VextFetchProxyTargetConfig

| Field                       | Type                                    | Required | Description                                                                                   |
| --------------------------- | --------------------------------------- | :------: | --------------------------------------------------------------------------------------------- |
| `name`                      | `string`                                |    ✅    | Target name, corresponding to `app.fetch.proxy.<name>()`; reserved name `then` cannot be used |
| `baseURL`                   | `string`                                |    ✅    | Upstream base URL                                                                             |
| `headers`                   | `Record<string, string>`                |    ❌    | Target-level fixed request headers                                                            |
| `forwardHeaders`            | `string[]`                              |    ❌    | Whitelist of request headers transparently transmitted from the current `req.headers`         |
| `defaultInjectHeaders`      | `Record<string, string> \| Function`    |    ❌    | Target-level dynamic injection headers                                                        |
| `allowAuthorizationForward` | `boolean`                               |    ❌    | Whether to allow transparent transmission of the original Authorization                       |
| `timeout`                   | `number`                                |    ❌    | Target-level timeout                                                                          |
| `retry`                     | `number`                                |    ❌    | Number of target-level retries                                                                |
| `retryDelay`                | `number \| (attempt: number) => number` |    ❌    | Target-level retry interval                                                                   |

Proxy request header priority: `target.headers < forwardHeaders < target.defaultInjectHeaders < options.headers < options.injectHeaders`. `Authorization` does not transmit transparently by default, and both whitelist and `allowAuthorizationForward: true` must be configured.Agent retry priority: `options.retry > target.retry > config.fetch.retry > 0`. Only GET / HEAD / OPTIONS / PUT / DELETE will automatically retry when upstream 5xx or network error occurs; POST / PATCH does not retry by default, does not retry when timeout and returns local 504.

---

## VextLoggerConfig

Structured log configuration, implemented by Vext's built-in logger kernel.

| Field              | Type                                                                       | Default Value                  | Description                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `level`            | `'fatal' \| 'error' \| 'warn' \| 'info' \| 'debug' \| 'trace' \| 'silent'` | `'info'`                       | Log level                                                                                                                                                                                                                                                                                              |
| `lifecycleLevel`   | `'concise' \| 'verbose'`                                                   | `'concise'`                    | Framework lifecycle log detail level for startup, loaders, hot reload, cluster, and other system logs                                                                                                                                                                                                  |
| `pretty`           | `boolean`                                                                  | Development environment `true` | Whether to use the built-in pretty formatter                                                                                                                                                                                                                                                           |
| `prettyColor`      | `'auto' \| 'always' \| 'never'`                                            | `'auto'`                       | ANSI color policy for level labels in pretty mode; production JSON never contains ANSI                                                                                                                                                                                                                 |
| `prettyIgnore`     | `string`                                                                   | `'pid,hostname,requestId'`     | Comma-separated fields to omit in pretty mode. Hiding `requestId` prevents mixin-injected fields from expanding into multiline noise; production JSON output is unaffected                                                                                                                             |
| `prettySingleLine` | `boolean`                                                                  | `true`                         | Whether to render extra fields as inline JSON on the message line. Set to `false` for multiline expansion. Only affects pretty mode                                                                                                                                                                    |
| `redactKeys`       | `string[]`                                                                 | `[]`                           | Redact structured log fields by exact key at any level. The top-level `level` protocol field is never overwritten                                                                                                                                                                                      |
| `redactPaths`      | `string[]`                                                                 | `[]`                           | Redact structured log fields by exact dot-notation path. Array indexes are supported; wildcards, bracket notation, removal, and function censors are not                                                                                                                                               |
| `redactValue`      | `string`                                                                   | `'[Redacted]'`                 | Replacement value for redacted fields                                                                                                                                                                                                                                                                  |
| `mixin`            | `() => Record<string, unknown>`                                            | `undefined`                    | Custom structured log mixin. Returned fields are merged with framework fields; `requestId` cannot be overridden, while user `trace_id` / `span_id` fields take precedence. Use this to read an active OpenTelemetry span from the Context API. The function is not called when no mixin is configured. |

```typescript
export default {
  logger: {
    level: "debug",
    pretty: true, // Development environment beautification output
    // prettySingleLine: true, // Default value, extra fields are compressed to the same line of the message
    // prettySingleLine: false, // Restore multi-line expansion format
    // prettyIgnore: 'pid,hostname,requestId', //Default value, hide requestId
    // prettyIgnore: 'pid,hostname', // To display requestId in pretty mode
    // redactKeys: ['password', 'token'],
    // redactPaths: ['user.email', 'headers.authorization'],
    // redactValue: '[Redacted]',
  },
};
```

**Log level priority** (from high to low):

```
fatal > error > warn > info > debug > trace
```

After setting a certain level, only logs of this level and higher will be output. Set to `'silent'` to be completely silent.

The default logger also supports runtime `app.logger.getLevel()` / `app.logger.setLevel(level)` to adjust subsequent log thresholds; the configuration object itself will still be frozen after startup and should not be dynamically changed by modifying `app.config.logger.level`.

---

## VextShutdownConfig

Graceful shutdown of configuration.

| Field          | Type                                       | Default Value | Description                                                       |
| -------------- | ------------------------------------------ | ------------- | ----------------------------------------------------------------- |
| `timeout`      | `number`                                   | `10`          | Absolute deadline for the full shutdown pipeline, in seconds      |
| `onFatalError` | `(error, origin) => void \| Promise<void>` | `undefined`   | Callback before exit for `uncaughtException`/`unhandledRejection` |

After receiving the `SIGTERM` / `SIGINT` signal, the framework will:

1. Establish one absolute `timeout` deadline when shutdown starts
2. Stop accepting new requests and wait for in-flight requests to complete
3. Run `onClose` in LIFO order, then close the response cache, lifecycle hooks, and logger
4. After the deadline, invoke cleanup that has not started without waiting further, then exit

```typescript
export default {
  shutdown: {
    timeout: 30, // Container environment recommends 30 seconds
  },
};
```

---

## VextServerConfig

Inbound Node.js HTTP server layer configuration. Applicable to built-in Native / Hono / Fastify / Express / Koa adapter, also applicable to development server created by `vext dev`. Unset fields retain the current Node.js default value.

| Field                         | Type     | Default Value         | Description                                                                    |
| ----------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------ |
| `requestTimeout`              | `number` | Node.js default value | Maximum time in milliseconds to receive a complete request, `0` means disabled |
| `headersTimeout`              | `number` | Node.js default value | Maximum time to receive complete HTTP headers (milliseconds)                   |
| `keepAliveTimeout`            | `number` | Node.js default value | Keep-alive idle wait time after response completes (milliseconds)              |
| `socketTimeout`               | `number` | Node.js default value | socket inactivity timeout (milliseconds), `0` means disabled                   |
| `maxHeaderSize`               | `number` | Node.js default value | Maximum request header size (bytes)                                            |
| `maxRequestsPerSocket`        | `number` | Node.js default value | The maximum number of requests for a single socket, `0` means unlimited        |
| `connectionsCheckingInterval` | `number` | Node.js default value | Outstanding request timeout check interval (milliseconds)                      |

```typescript
export default {
  server: {
    requestTimeout: 120_000,
    headersTimeout: 60_000,
    keepAliveTimeout: 5_000,
    socketTimeout: 0,
    maxHeaderSize: 16 * 1024,
    maxRequestsPerSocket: 0,
    connectionsCheckingInterval: 30_000,
  },
};
```

`config.server` only controls inbound service requests. The timeout for outbound `app.fetch` / `app.fetch.proxy` is controlled by `config.fetch.timeout`, the proxy target `timeout`, or options when calling.

---

## VextResponseConfig

Response format configuration.

| Field                | Type                  | Default Value | Description                                                                        |
| -------------------- | --------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `hideInternalErrors` | `boolean`             | `true`        | Whether to hide 500 error details                                                  |
| `wrap`               | `boolean`             | `true`        | Whether to enable export packaging                                                 |
| `logErrors`          | `VextLogErrorsConfig` | See below     | Error logging policy: unknown/5xx default on; 4xx logging requires `http4xx: true` |

### Export packaging

When `wrap: true` is enabled, `res.json(data)` is automatically wrapped:

```json
{
  "code": 0,
  "data": { "id": 1, "name": "Alice" },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Error response format:

```json
{
  "code": 10001,
  "message": "User does not exist",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

When `wrap: false` is disabled, `res.json(data)` sends raw `data` directly.

### Hide internal errors

`hideInternalErrors` only affects the "unknown exception" 500 error path, such as the scenario where `throw new Error("...")` is directly used in routing, service, and middleware. It does not change the status code and response format of structured errors such as `app.throw(...)` or `VextValidationError`.

When `hideInternalErrors: true` is used, 500 errors are not exposed stack trace:

```json
//hideInternalErrors: true
{ "code": 500, "message": "Internal Server Error" }

// hideInternalErrors: false (for development environment only)
{ "code": 500, "message": "Internal Server Error", "stack": "..." }
```

---

## VextBodyParserConfig

Request body parsing configuration.

| Field         | Type               | Default Value | Description                    |
| ------------- | ------------------ | ------------- | ------------------------------ |
| `enabled`     | `boolean`          | `true`        | Whether to enable body parsing |
| `maxBodySize` | `string \| number` | `'1mb'`       | Maximum request body size      |

```typescript
export default {
  bodyParser: {
    maxBodySize: "5mb", // Supports 'kb', 'mb', 'gb' units
  },
};
```

After disabled, `req.body` is always `undefined`, which is suitable for pure GET service or custom body parsing scenarios.

`maxBodySize` supported formats:

| Format | Example                      | Description                          |
| ------ | ---------------------------- | ------------------------------------ |
| String | `'1mb'`, `'512kb'`, `'10mb'` | Support kb/mb/gb unit                |
| Number | `1048576`                    | Directly specify the number of bytes |

---

## VextMultipartConfig

Multipart/File upload global configuration.

| Field              | Type       | Default Value | Description                                                                                                                               |
| ------------------ | ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`  | `false`       | Whether to enable built-in multipart parsing. After setting to `true`, body-parser will automatically fill in `req.files` without plug-in |
| `maxFileSize`      | `number`   | `10485760`    | Maximum size of a single file (bytes, default 10MB)                                                                                       |
| `maxFiles`         | `number`   | `10`          | Maximum number of files in a single request                                                                                               |
| `allowedMimeTypes` | `string[]` | `undefined`   | Whitelist of allowed MIME types (if not set, there will be no restriction)                                                                |

```typescript
export default {
  multipart: {
    enabled: true, // Enable built-in parsing
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "application/pdf",
    ],
  },
};
```

:::tip Fastify linkage
`multipart.maxFileSize` only limits the size of a single file; the total request body read limit is controlled by `bodyParser.maxBodySize`. When using Fastify, if `fastifyAdapter({ bodyLimit })` is additionally passed in, the actual read boundary will be the smaller value of the adapter `bodyLimit` and the overall upper limit of body-parser.
:::

### Storage and cleanup

Built-in multipart parsing is memory-only. Vext reads the request body and exposes each upload as `req.files[*].buffer`; it does **not** create a framework-managed temporary file or temporary directory. Consequently, there is no `tmpDir`, on-disk retention TTL, or periodic cleanup job to configure. When the request and application code no longer retain a buffer, normal Node.js garbage collection reclaims it; Vext never deletes files that your application stores itself.

Set `bodyParser.maxBodySize`, `multipart.maxFileSize`, `multipart.maxFiles`, and `multipart.allowedMimeTypes` deliberately. For large uploads, streaming object storage, or any durable file lifecycle, disable/avoid the built-in parser for that route and use a streaming upload plugin that owns its storage and cleanup policy.

---

## VextAccessLogConfig

Access log configuration, implemented as onion-style after-middleware.

| Field              | Type       | Default Value | Description                                                        |
| ------------------ | ---------- | ------------- | ------------------------------------------------------------------ |
| `enabled`          | `boolean`  | `true`        | Whether to enable access logs                                      |
| `level`            | `string`   | `'info'`      | Basic log level, only supports `'info'` or `'debug'`               |
| `skipPaths`        | `string[]` | `[]`          | Exact match skipped path list                                      |
| `skipPathPrefixes` | `string[]` | `[]`          | List of paths skipped by prefix matching                           |
| `slowThreshold`    | `number`   | `0`           | Slow request threshold, `0` means not enabled                      |
| `warnOn4xx`        | `boolean`  | `false`       | Whether to promote 4xx responses to `warn`                         |
| `logResponseSize`  | `boolean`  | `false`       | Whether to append the response body size at the end of the message |

```typescript
export default {
  accessLog: {
    enabled: true,
    level: "info",
    skipPaths: ["/health", "/readiness", "/metrics"],
    skipPathPrefixes: ["/internal"],
    slowThreshold: 1000,
    warnOn4xx: false,
    logResponseSize: false,
  },
};
```

Access log output example:

```
POST /api/users 201 12ms | 192.168.1.1
```

Message fields include HTTP method, path, status code, response time (ms) and client IP; `requestId` is automatically injected into the JSON record field by logger's AsyncLocalStorage mixin.

---

## VextOpenAPIConfig

OpenAPI documentation generation configuration.

| Field                           | Type                                      | Default Value              | Description                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `boolean`                                 | dev enabled, prod disabled | Whether to enable OpenAPI generation                                                                                                                                                                          |
| `title`                         | `string`                                  | `undefined`                | Document title                                                                                                                                                                                                |
| `version`                       | `string`                                  | `undefined`                | Document version                                                                                                                                                                                              |
| `description`                   | `string`                                  | `undefined`                | Document description                                                                                                                                                                                          |
| `docs.path`                     | `string`                                  | `'/docs'`                  | Vext Docs path                                                                                                                                                                                                |
| `docs.assetsPath`               | `string`                                  | `'/_vext/docs'`            | Vext Docs built-in asset and data endpoint prefix, including app.js / style.css / favicon.svg and source-aware JSON data                                                                                      |
| `docs.assetsPublicPath`         | `string`                                  | Same as `docs.assetsPath`  | Browser-facing docs asset/data prefix for prefix-stripping reverse proxies; HTML uses this public prefix for app.js / style.css / favicon.svg                                                                 |
| `docs.renderer`                 | `'vext'`                                  | `'vext'`                   | Built-in Vext Docs renderer. Third-party renderer objects are no longer supported; external tools should consume `/openapi.json`                                                                              |
| `docs.ui.theme`                 | `'system' \| 'light' \| 'dark'`           | `'system'`                 | Built-in Vext Docs color theme. Visitors can override it locally in the UI                                                                                                                                    |
| `docs.ui.density`               | `'comfortable' \| 'compact'`              | `'comfortable'`            | Built-in Vext Docs spacing density. Visitors can override it locally in the UI                                                                                                                                |
| `docs.code.enabled`             | `boolean \| 'auto'`                       | `'auto'`                   | Whether to generate code docs from services / utils / models / components / plugins / middlewares and explicitly enabled optional static sources                                                              |
| `docs.code.scan`                | `'lazy' \| 'background'`                  | `'lazy'`                   | Code docs scan lifecycle. `lazy` scans on each docs data request; `background` warms one in-process snapshot at docs registration and reuses it for later requests                                            |
| `docs.code.components`          | `boolean \| object`                       | `true`                     | Component JSDoc source. Defaults to `src/frontend/components/**`; only discovered entries appear in the UI                                                                                                    |
| `docs.code.plugins`             | `boolean \| object`                       | `true`                     | Plugin JSDoc/runtime source. Defaults to `src/plugins/**`; only discovered entries appear in the UI                                                                                                           |
| `docs.code.middlewares`         | `boolean \| object`                       | `true`                     | Middleware JSDoc/runtime source. Defaults to `src/middlewares/**`; only discovered entries appear in the UI                                                                                                   |
| `docs.code.locales`             | `boolean \| object`                       | `false`                    | Optional locale source. When enabled, scans `src/locales/**` and `src/frontend/locales/**`; set `dir` to scan one custom locale root                                                                          |
| `docs.code.config`              | `boolean \| object`                       | `false`                    | Optional runtime config source. When enabled, scans `src/config/**`                                                                                                                                           |
| `docs.code.styles`              | `boolean \| object`                       | `false`                    | Optional frontend style source. When enabled, scans `src/frontend/styles/**`                                                                                                                                  |
| `docs.code.preload`             | `boolean \| object`                       | `false`                    | Optional project preload source. When enabled, scans canonical `src/preload/**`; project-root `preload/**` is a warned compatibility fallback                                                                 |
| `docs.access.mode`              | `'off' \| 'visibility-only' \| 'enforce'` | `'off'`                    | Docs UI data, menu and operation access mode                                                                                                                                                                  |
| `docs.access.openapiJson`       | `'filtered' \| 'public'`                  | `'filtered'`               | Whether canonical `/openapi.json` is filtered by docs access rules or remains public                                                                                                                          |
| `docs.sources`                  | `Array`                                   | `[]`                       | Optional source surfaces for multi API / multi version docs. Every source requires `match`; non-`All` code docs need explicit `code.include` / `code.exclude`                                                 |
| `docs.tryItOut.hookScript`      | `string`                                  | `undefined`                | Optional browser script loaded for Try it out request / response hooks                                                                                                                                        |
| `docs.tryItOut.hookGlobal`      | `string`                                  | `'VextDocsHooks'`          | Browser global lookup name for Try it out `beforeRequest` / `afterResponse` hooks                                                                                                                             |
| `docs.tryItOut.defaultServer`   | `string`                                  | `undefined`                | Initial Try it out server: `"first"`, `"same-origin"`, `"custom"`, or an exact OpenAPI server URL                                                                                                             |
| `docs.tryItOut.sameOrigin`      | `boolean \| 'auto'`                       | `'auto'`                   | Whether to show the Same origin Try it out server option. `auto` shows it only when no OpenAPI servers are configured                                                                                         |
| `docs.tryItOut.customServer`    | `boolean`                                 | `true`                     | Whether visitors can temporarily enter a custom Try it out base URL in the browser                                                                                                                            |
| `docs.tryItOut.customServerUrl` | `string`                                  | `undefined`                | Optional default value for the Custom server input                                                                                                                                                            |
| `docsPath`                      | `string`                                  | `'/docs'`                  | Compatibility field; prefer `docs.path` in new projects                                                                                                                                                       |
| `jsonPath`                      | `string`                                  | `'/openapi.json'`          | OpenAPI JSON path                                                                                                                                                                                             |
| `jsonPublicPath`                | `string`                                  | Same as `jsonPath`         | Public canonical spec path for links and external tools. Built-in source-aware docs data uses `docs.assetsPublicPath` / `docs.assetsPath`; [see the guide](/guide/openapi#reverse-proxy-path-prefix-scenario) |
| `contact`                       | `object`                                  | `undefined`                | Contact information                                                                                                                                                                                           |
| `license`                       | `object`                                  | `undefined`                | License information                                                                                                                                                                                           |
| `servers`                       | `array`                                   | `undefined`                | Server address list                                                                                                                                                                                           |
| `tags`                          | `array`                                   | `undefined`                | Global tag definition                                                                                                                                                                                         |
| `tagGroups`                     | `Array<{ name: string; tags: string[] }>` | `undefined`                | Explicit OpenAPI `x-tagGroups` vendor extension output; the built-in Vext Docs default navigation does not depend on it                                                                                       |
| `guardSecurityMap`              | `Record<string, string>`                  | `undefined`                | Guard to Security Scheme mapping                                                                                                                                                                              |
| `securitySchemes`               | `object`                                  | `undefined`                | Security scheme definition                                                                                                                                                                                    |
| `scalar`                        | `object`                                  | `undefined`                | Deprecated compatibility field. It only triggers a warning when explicitly configured and does not affect the built-in Vext Docs page                                                                         |
| ~~`tryItOutEnabled`~~           | `boolean`                                 | `true`                     | ~~Deprecated~~ Compatibility only; it does not affect the default Vext Docs implementation                                                                                                                    |
| ~~`docExpansion`~~              | `'none' \| 'list' \| 'full'`              | `'list'`                   | ~~Deprecated~~ Compatibility only; it does not affect the default Vext Docs implementation                                                                                                                    |

`docs.access.cacheKey` is not a supported configuration field in this release. Vext rejects it to avoid implying response or access-result caching that the docs access pipeline does not currently provide.

For fixed local or deployed API targets, set `servers[].url` to the complete base URL including its port, for example `http://127.0.0.1:3000`. Use `servers[].variables` only for genuinely variable URL segments such as environment, region, tenant, or API version. `docs.tryItOut.defaultServer` controls the initial Try it out selection, while `docs.tryItOut.customServer` lets users temporarily enter another browser-side target without changing project config.

`tagGroups` is passed through as `x-tagGroups` only when explicitly configured. The default Vext Docs renderer builds recursive navigation from OpenAPI path segments; `tagGroups` is mainly for downstream OpenAPI tools that explicitly consume this vendor extension.

The default Vext Docs renderer derives Services / Utils / Models / Components / Plugins / Middlewares from code docs data. Model entries can show static schema fields, enums, options, indexes, methods, hooks, and usage. Plugins and middlewares can show inferred lifecycle/bootstrap, app extensions, middleware type, route usage, and source links. Locales, Config, Styles, and Preload are optional advanced static sources that can be enabled explicitly under `docs.code`; they are not shown in the default top-level documentation surface. Local loopback pages can also show `Open source` links for code docs entries without adding a separate configuration field.

```typescript
export default {
  openapi: {
    enabled: true,
    title: "My API",
    version: "1.0.0",
    description: "My API Documentation",
    docs: {
      path: "/docs",
      renderer: "vext",
      code: {
        enabled: "auto",
      },
    },
    servers: [
      { url: "http://localhost:3000", description: "Development environment" },
      { url: "https://api.example.com", description: "Production environment" },
    ],
    tags: [
      { name: "User", description: "User management interface" },
      { name: "Order", description: "Order Management Interface" },
    ],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    guardSecurityMap: {
      auth: "bearerAuth",
    },
  },
};
```

### `guardSecurityMap` legacy fallback

Automatically map routing middleware names to OpenAPI Security Scheme for legacy middleware-only routes. New Auth examples should declare the final `RouteOptions.auth` inline or in a same-file `const` so runtime protection, static projection, and OpenAPI security share the same source. Route-options helper calls are not supported by the finite static grammar:

```typescript
// Legacy only: middleware-name inference without RouteOptions.auth
app.get("/profile", { middlewares: ["auth"] }, handler);
// ↑ OpenAPI automatically infers that this route requires bearerAuth authentication
```

### `securitySchemes`

Supported security scheme types:

| `type`          | Description         | Required fields                              |
| --------------- | ------------------- | -------------------------------------------- |
| `http`          | HTTP authentication | `scheme` (`bearer` / `basic`)                |
| `apiKey`        | API Key             | `name`, `in` (`header` / `query` / `cookie`) |
| `oauth2`        | OAuth 2.0           | —                                            |
| `openIdConnect` | OpenID Connect      | —                                            |

For `apiKey` schemes with `in: "cookie"` and for `validate.cookie` parameters, built-in docs can display the fields but browser Try it out cannot set the forbidden `Cookie` header directly. Use same-origin browser cookies or an HTTP client for manual cookie values.

---

## VextRequestContextConfig

AsyncLocalStorage request context configuration.

| Field     | Type      | Default Value | Description                           |
| --------- | --------- | ------------- | ------------------------------------- |
| `enabled` | `boolean` | `true`        | Whether to enable the request context |

```typescript
export default {
  requestContext: {
    enabled: false, // Disable only when the request-scoped features below are not needed
  },
};
```

:::warning
After disabling, the following functions will be disabled:

- Logger automatically injects `requestId`
- `app.throw()` automatically parses request-level `locale`
- `app.fetch()` automatically propagates `requestId`
  :::

---

## VextFrontendConfig

Built-in frontend build and static serving configuration.

| Field                                                  | Type                                 | Default Value                                                | Description                                                                                            |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `enabled`                                              | `boolean`                            | `false`                                                      | Whether to enable frontend integration                                                                 |
| `framework`                                            | `string`                             | `'react'`                                                    | Frontend framework label                                                                               |
| `adapter`                                              | `VextFrontendAdapter`                | None                                                         | Advanced integration seam for a compatible frontend adapter; it does not activate a plugin ecosystem   |
| `root`                                                 | `string`                             | `'src/frontend'`                                             | Frontend source directory                                                                              |
| `pages`                                                | `object`                             | Built-in page conventions                                    | Page, document, and error-page discovery settings                                                      |
| `pages.dir`                                            | `string`                             | `'pages'`                                                    | Page directory resolved from `root`                                                                    |
| `pages.extensions`                                     | `string[]`                           | `['.tsx', '.jsx', '.ts', '.js']`                             | Extensions scanned for pages, layouts, error pages, and locale modules                                 |
| `pages.document`                                       | `string`                             | `'pages/_document.html'`                                     | Document template path resolved from `root`                                                            |
| `pages.errorDir`                                       | `string`                             | `'pages/error'`                                              | Error page directory resolved from `root`                                                              |
| `componentsDir`                                        | `string`                             | `'components'`                                               | Shared component directory resolved from `root`                                                        |
| `styles`                                               | `object`                             | Built-in style conventions                                   | Global CSS entry and optional Vext JSCSS configuration                                                 |
| `styles.entry`                                         | `string`                             | `'styles/index.css'`                                         | Global CSS entry resolved from `root`                                                                  |
| `styles.jscss`                                         | `boolean \| object`                  | `{ enabled: true }`                                          | Vext JSCSS build-time CSS extraction and dynamic CSS variables                                         |
| `styles.jscss.enabled`                                 | `boolean`                            | `true`                                                       | Whether Vext JSCSS extraction is enabled                                                               |
| `styles.jscss.files`                                   | `string[]`                           | `['**/*.style.ts', '**/*.style.js', '**/*.css.ts']`          | JSCSS source file glob patterns                                                                        |
| `styles.jscss.runtimeAdapter`                          | `'css-variables' \| 'none' \| false` | `'css-variables'`                                            | Emits dynamic variables through CSS custom properties, or falls back to static fallback values         |
| `styles.jscss.dynamicVars`                             | `boolean`                            | `true`                                                       | Whether to emit JSCSS custom property declarations and `var(...)` references                           |
| `styles.jscss.recipes`                                 | `boolean`                            | `true`                                                       | Whether recipe variants emit additional classes and CSS rules                                          |
| `assetsDir`                                            | `string`                             | `'assets'`                                                   | Bundled frontend asset directory resolved from `root`                                                  |
| `media`                                                | `object`                             | Local defaults                                               | Direct local image and font compilation; generated files remain in the normal deploy/SRI closure       |
| `media.maxBytes`                                       | `number`                             | `20971520`                                                   | Maximum bytes for the complete generated local image and font closure                                  |
| `media.images`                                         | `object`                             | Local image defaults                                         | Responsive local-image variants                                                                        |
| `media.images.widths`                                  | `number[]`                           | `[320, 640, 960, 1280, 1600]`                                | Positive responsive width candidates for local images                                                  |
| `media.images.formats`                                 | `('original' \| 'webp' \| 'avif')[]` | `['original', 'webp', 'avif']`                               | Local output codecs; `original` keeps the source codec                                                 |
| `media.images.quality`                                 | `number`                             | `75`                                                         | Integer image quality from 1 through 100                                                               |
| `media.images.maxInputPixels`                          | `number`                             | `40000000`                                                   | Build-time upper bound for decoded local-image pixels                                                  |
| `media.images.maxVariants`                             | `number`                             | `24`                                                         | Build-time upper bound for variants from one local image                                               |
| `media.fonts`                                          | `object`                             | Local font defaults                                          | Local WOFF2 subset limits                                                                              |
| `media.fonts.maxBytes`                                 | `number`                             | `5242880`                                                    | Maximum bytes for one generated local WOFF2 subset                                                     |
| `entry`                                                | `string`                             | `'.vext/generated/frontend/browser-entry.tsx'`               | Generated browser entry; usually not written by hand                                                   |
| `indexHtml`                                            | `string`                             | `'src/frontend/pages/_document.html'`                        | HTML document template                                                                                 |
| `outDir`                                               | `string`                             | `.vext/client` in dev, `dist/client` in production           | Frontend output directory                                                                              |
| `publicDir`                                            | `string`                             | `'public'`                                                   | Static assets copied into the frontend output                                                          |
| `publicPath`                                           | `string`                             | `'/'`                                                        | Public asset path prefix                                                                               |
| `alias`                                                | `object`                             | Built-in `@frontend/@pages/@components/@styles/@assets`      | Frontend-safe aliases; no default alias points at all of `src`                                         |
| `spaFallback`                                          | `boolean \| object`                  | `{ scopes: [] }`                                             | Serve fallback only for explicitly declared client-router sub-app scopes                               |
| `spaFallback.enabled`                                  | `boolean`                            | `true`                                                       | Enables scoped fallback arbitration; with no scopes, no path is captured                               |
| `spaFallback.exclude`                                  | `string[]`                           | `['/api/**', '/openapi.json', '/docs/**', '/_vext/docs/**']` | Global fallback exclusion paths                                                                        |
| `spaFallback.scopes`                                   | `object[]`                           | `[]`                                                         | Explicit client-router sub-app scopes                                                                  |
| `spaFallback.scopes[]`                                 | `object[]`                           | `[]`                                                         | Explicit client-router sub-app scopes                                                                  |
| `spaFallback.scopes[].basePath`                        | `string`                             | Required                                                     | URL prefix owned by the client shell                                                                   |
| `spaFallback.scopes[].page`                            | `string`                             | Required                                                     | Page id for the client shell                                                                           |
| `spaFallback.scopes[].ssr`                             | `boolean`                            | `false`                                                      | Whether the client shell is first rendered by SSR                                                      |
| `spaFallback.scopes[].exclude`                         | `string[]`                           | `[]`                                                         | Scope-specific paths that fallback must not capture                                                    |
| `spaFallback.scopes[].status`                          | `number`                             | `200`                                                        | HTTP status for a matched fallback                                                                     |
| `apiClient`                                            | `boolean \| object`                  | `true`                                                       | Generate client contract artifacts                                                                     |
| `apiClient.enabled`                                    | `boolean`                            | `true`                                                       | Whether to emit `client-contract.json` and `api.generated.ts`                                          |
| `seo`                                                  | `VextFrontendSeoConfig`              | Not configured                                               | Framework SEO metadata and optional sitemap/robots; omission preserves legacy output                   |
| `seo.enabled`                                          | `boolean`                            | `true` when configured                                       | Enables structured SEO and configured artifacts                                                        |
| `seo.publicOrigin`                                     | `string`                             | None                                                         | Absolute HTTP(S) deployment origin combined with each page pathname                                    |
| `seo.origins`                                          | `Record<string, string>`             | `{}`                                                         | Finite named origins for multi-domain runtime selection                                                |
| `seo.titleTemplate`                                    | `string`                             | None                                                         | Title template containing the `%s` placeholder                                                         |
| `seo.defaults`                                         | `VextSeoMetadata`                    | `{}`                                                         | Application-level title, description, robots, canonical, Open Graph, Twitter, alternates, and JSON-LD  |
| `seo.sitemap`                                          | `false \| VextFrontendSitemapConfig` | `false`                                                      | Enables build-time or runtime sitemap output                                                           |
| `seo.sitemap.mode`                                     | `'build' \| 'runtime'`               | `'build'`                                                    | Writes the artifact during build or serves it from a runtime endpoint                                  |
| `seo.sitemap.path`                                     | `string`                             | `'/sitemap.xml'`                                             | Root-absolute sitemap pathname                                                                         |
| `seo.sitemap.includeStatic`                            | `boolean`                            | `true`                                                       | Includes successful static page artifacts unless page SEO excludes them                                |
| `seo.sitemap.entries`                                  | `VextSitemapEntriesProvider`         | None                                                         | Adds validated entries from `{ mode, origin, originKey, signal }`                                      |
| `seo.sitemap.maxUrlsPerFile`                           | `number`                             | `50000`                                                      | URL limit before emitting a sitemap index and numbered chunks                                          |
| `seo.sitemap.maxUrls`                                  | `number`                             | `100000`                                                     | Maximum URLs accepted across the complete sitemap set; generation fails closed above the limit         |
| `seo.sitemap.maxBytes`                                 | `number`                             | `52428800`                                                   | Maximum UTF-8 bytes across all rendered sitemap documents                                              |
| `seo.sitemap.timeoutMs`                                | `number`                             | `5000`                                                       | Deadline for runtime provider, read, and render work; expiry aborts the provider signal                |
| `seo.robots`                                           | `false \| VextFrontendRobotsConfig`  | `false`                                                      | Enables build-time or runtime robots output                                                            |
| `seo.robots.mode`                                      | `'build' \| 'runtime'`               | `'build'`                                                    | Writes the artifact during build or serves it from a runtime endpoint                                  |
| `seo.robots.path`                                      | `'/robots.txt'`                      | `'/robots.txt'`                                              | Fixed robots pathname                                                                                  |
| `seo.robots.groups`                                    | `VextRobotsGroup[]`                  | `[{ userAgent: '*', allow: '/' }]`                           | User-agent allow/disallow/crawl-delay groups                                                           |
| `render`                                               | `object`                             | `{ ssr: true, streaming: 'buffered' }`                       | SSR, layout, fallback, and streaming controls                                                          |
| `render.ssr`                                           | `boolean`                            | `true`                                                       | Enable SSR rendering                                                                                   |
| `render.fallback`                                      | `'client' \| 'error'`                | `'client'`                                                   | Whether SSR failures fall back to a client shell or an error response                                  |
| `render.streaming`                                     | `'buffered' \| 'auto'`               | `'buffered'`                                                 | Keep `renderToString` compatibility or stream the shell and Suspense boundaries                        |
| `render.timeoutMs`                                     | `number`                             | `3000`                                                       | Abort unfinished streaming SSR; checked after synchronous buffered rendering                           |
| `render.layout`                                        | `boolean`                            | `true`                                                       | Whether to enable the nested layout chain                                                              |
| `errorPages`                                           | `object`                             | Built-in error-page conventions                              | Default and status-specific error-page mappings                                                        |
| `errorPages.default`                                   | `string`                             | `'error/default'`                                            | Default error page id                                                                                  |
| `errorPages.status`                                    | `object`                             | `{ 404: 'error/404', 500: 'error/500' }`                     | Status code to error page id mapping                                                                   |
| `i18n`                                                 | `object`                             | `{ enabled: false }`                                         | Frontend page message layer, SSR messages, and `{vext.lang}`                                           |
| `i18n.enabled`                                         | `boolean`                            | `false`                                                      | Whether frontend locale discovery and message artifacts are enabled                                    |
| `i18n.source`                                          | `string`                             | `'locales'`                                                  | Frontend message directory resolved from `root`                                                        |
| `i18n.defaultLocale`                                   | `'inherit' \| string`                | `'inherit'`                                                  | Default locale; `inherit` follows the request-level locale                                             |
| `i18n.detect`                                          | `string[]`                           | `['accept-language']`                                        | SSR locale detection sources                                                                           |
| `i18n.inject`                                          | `'used' \| 'all'`                    | `'used'`                                                     | Whether to inject used messages or all messages                                                        |
| `i18n.clientSwitch`                                    | `'reload'`                           | `'reload'`                                                   | Initial client locale switch strategy                                                                  |
| `i18n.clientLoad`                                      | `'current' \| 'all'`                 | `'current'`                                                  | Whether the browser loads only the current SSR locale or all locales                                   |
| `i18n.htmlLang`                                        | `boolean`                            | `true`                                                       | Whether to write `{vext.lang}` / `<html lang>`                                                         |
| `i18n.vary`                                            | `boolean`                            | `true`                                                       | Whether locale affects response vary/cache behavior                                                    |
| `dev`                                                  | `object`                             | Built-in dev defaults                                        | Browser development event, refresh, and overlay controls                                               |
| `dev.hot`                                              | `boolean`                            | `true`                                                       | Development frontend hot update channel                                                                |
| `dev.fastRefresh`                                      | `boolean`                            | `true`                                                       | React Fast Refresh                                                                                     |
| `dev.transport`                                        | `'sse'`                              | `'sse'`                                                      | Transport for the Vext dev event bus                                                                   |
| `dev.overlay`                                          | `boolean`                            | `true`                                                       | Whether to show frontend dev browser overlays for rebuild errors and render refresh prompts            |
| `dev.debounceMs`                                       | `number`                             | `50`                                                         | File change event debounce interval                                                                    |
| `dev.renderRefresh`                                    | `'prompt' \| 'auto' \| 'off'`        | `'prompt'`                                                   | Browser behavior after render-related route/service backend changes                                    |
| `build`                                                | `object`                             | Built-in production/development compiler defaults            | Browser build defaults; the SSR renderer has independent `build.server` Node settings                  |
| `build.target`                                         | `string \| string[]`                 | `'es2022'`                                                   | Browser build target                                                                                   |
| `build.minify`                                         | `boolean`                            | Production `true`                                            | Minify frontend output                                                                                 |
| `build.sourcemap`                                      | `boolean`                            | Development `true`                                           | Generate frontend source maps                                                                          |
| `build.client`                                         | `object`                             | Inherits shared build defaults                               | Browser bundle output, hash names, splitting, and external entries                                     |
| `build.client.assetsDir`                               | `string`                             | `"assets"`                                                   | Browser bundle asset subdirectory under `frontend.outDir`                                              |
| `build.client.target`                                  | `string \| string[]`                 | Inherits `build.target` (`'es2022'`)                         | Browser-specific esbuild target                                                                        |
| `build.client.minify`                                  | `boolean`                            | Inherits production `true`                                   | Browser-specific minification override                                                                 |
| `build.client.sourcemap`                               | `boolean`                            | Inherits development `true`                                  | Browser-specific source-map override                                                                   |
| `build.client.splitting`                               | `boolean`                            | `true`                                                       | Browser code splitting                                                                                 |
| `build.client.entryNames`                              | `string`                             | `'[name]-[hash]'`                                            | Browser entry filename pattern under `assetsDir`                                                       |
| `build.client.chunkNames`                              | `string`                             | `'[name]-[hash]'`                                            | Browser chunk filename pattern under `assetsDir`                                                       |
| `build.client.assetNames`                              | `string`                             | `'[name]-[hash]'`                                            | Imported browser asset filename pattern under `assetsDir`                                              |
| `build.client.external`                                | `string[]`                           | `[]`                                                         | Modules externalized from the browser bundle                                                           |
| `build.client.externalRuntime`                         | `object`                             | `{}`                                                         | Import map URL mapping for externalized browser modules; React externals fail without mappings         |
| `build.client.externalRuntime.<specifier>.url`         | `string`                             | Required                                                     | Absolute URL for a named browser external                                                              |
| `build.client.externalRuntime.<specifier>.integrity`   | `string`                             | None                                                         | Optional SRI value for that external runtime                                                           |
| `build.client.externalRuntime.<specifier>.crossOrigin` | `'anonymous' \| 'use-credentials'`   | None                                                         | Optional `crossorigin` value for that external runtime                                                 |
| `build.server`                                         | `object`                             | `server/renderer.cjs`                                        | SSR renderer bundle output                                                                             |
| `build.server.outFile`                                 | `string`                             | `server/renderer.cjs`                                        | SSR renderer file under `frontend.outDir`                                                              |
| `build.server.target`                                  | `string \| string[]`                 | `'node20'`                                                   | SSR-renderer esbuild target                                                                            |
| `build.server.minify`                                  | `boolean`                            | `false`                                                      | SSR-renderer minification; independent of browser minification                                         |
| `build.server.sourcemap`                               | `boolean`                            | Inherits development `true`                                  | SSR-renderer source-map setting                                                                        |
| `build.server.external`                                | `string[]`                           | `[]`                                                         | Node modules kept external to the renderer bundle                                                      |
| `build.vendorChunks`                                   | `boolean \| object`                  | `{ enabled: true }`                                          | Vext-managed vendor entry and shared chunk handling                                                    |
| `build.vendorChunks.enabled`                           | `boolean`                            | `true`                                                       | Whether the Vext-managed vendor entry is emitted                                                       |
| `build.vendorChunks.packages`                          | `string[]`                           | React runtime packages                                       | Packages considered for the shared vendor entry                                                        |
| `build.vendorChunks.entryName`                         | `string`                             | `'vext-vendor'`                                              | Logical shared vendor entry name                                                                       |
| `build.budgets`                                        | `object`                             | All `0`                                                      | Frontend asset budgets; `0` disables a budget                                                          |
| `build.budgets.maxAssetBytes`                          | `number`                             | `0`                                                          | Per-asset raw byte ceiling                                                                             |
| `build.budgets.maxInitialJsBytes`                      | `number`                             | `0`                                                          | Largest complete page first-load JS closure raw-byte ceiling                                           |
| `build.budgets.maxInitialJsGzipBytes`                  | `number`                             | `0`                                                          | Largest complete page first-load JS closure gzip budget                                                |
| `build.budgets.maxInitialJsBrotliBytes`                | `number`                             | `0`                                                          | Largest complete page first-load JS closure brotli budget                                              |
| `build.budgets.maxRouteInitialJsBrotliBytes`           | `number`                             | `0`                                                          | Per-route initial JS brotli budget                                                                     |
| `build.budgets.maxAppOwnedInitialJsBrotliBytes`        | `number`                             | `0`                                                          | App-owned initial JS brotli budget excluding external runtime assets                                   |
| `build.budgets.maxTotalBytes`                          | `number`                             | `0`                                                          | Total deployable frontend asset byte ceiling                                                           |
| `build.budgets.warnOnly`                               | `boolean`                            | `false`                                                      | Report budget violations without failing the build                                                     |
| `build.assets`                                         | `object`                             | `{ inlineLimit: 0 }`                                         | Imported-asset emission controls                                                                       |
| `build.assets.inlineLimit`                             | `number`                             | `0`                                                          | Imported asset inline limit; default emits hashed files                                                |
| `build.css`                                            | `object`                             | `{ modules: true }`                                          | CSS module compilation controls                                                                        |
| `build.css.modules`                                    | `boolean`                            | `true`                                                       | Whether to support the CSS Modules convention                                                          |
| `build.diagnostics`                                    | `object`                             | All diagnostics enabled                                      | Build report and browser-leak diagnostic controls                                                      |
| `build.diagnostics.metafile`                           | `boolean`                            | `true`                                                       | Whether to keep internal esbuild metafile diagnostics for size report / leak scan                      |
| `build.diagnostics.sizeReport`                         | `boolean`                            | `true`                                                       | Whether to emit a size report                                                                          |
| `build.diagnostics.performanceReport`                  | `boolean`                            | `true`                                                       | Whether to keep route-level initial JS metrics in build reports                                        |
| `build.diagnostics.leakScan`                           | `boolean`                            | `true`                                                       | Blocks browser bundles from importing server-only modules                                              |
| `deploy`                                               | `object`                             | Built-in local delivery defaults                             | Browser asset URL, SRI, crossorigin, and optional incremental upload configuration                     |
| `deploy.assetBaseUrl`                                  | `string`                             | None                                                         | Absolute CDN prefix for static frontend assets                                                         |
| `deploy.crossOrigin`                                   | `'anonymous' \| 'use-credentials'`   | None                                                         | `crossorigin` value injected into script/link tags                                                     |
| `deploy.integrity`                                     | `boolean`                            | `false`                                                      | Inject build-time SRI into generated JS/CSS tags                                                       |
| `deploy.upload`                                        | `boolean \| object`                  | `{ enabled: false, exclude: ["**/*.map"] }`                  | Static asset upload config; `vext deploy assets` uploads incrementally by sha256                       |
| `deploy.upload.enabled`                                | `boolean`                            | `false`                                                      | Enables upload for `vext build --upload-assets` and `vext deploy assets`                               |
| `deploy.upload.adapter`                                | `string \| object`                   | `'filesystem'`                                               | Built-in `filesystem`/`mock` adapter name or explicit custom adapter                                   |
| `deploy.upload.targetDir`                              | `string`                             | `.vext/deploy/frontend-assets` when enabled                  | Local destination for the built-in filesystem staging adapter                                          |
| `deploy.upload.publicBaseUrl`                          | `string`                             | None                                                         | Explicit public URL reported by the upload plan; filesystem upload falls back to `deploy.assetBaseUrl` |
| `deploy.upload.prefix`                                 | `string`                             | `''`                                                         | Prefix prepended to every upload key                                                                   |
| `deploy.upload.stateFile`                              | `string`                             | `.vext/deploy/frontend-assets-state.json`                    | Incremental upload state; keep it outside `frontend.outDir`                                            |
| `deploy.upload.dryRun`                                 | `boolean`                            | `false`                                                      | Plan upload without writing assets                                                                     |
| `deploy.upload.concurrency`                            | `number`                             | `4`                                                          | Maximum parallel upload operations                                                                     |
| `deploy.upload.include`                                | `string[]`                           | `['**/*']`                                                   | Deploy-manifest paths eligible for upload                                                              |
| `deploy.upload.exclude`                                | `string[]`                           | `['**/*.map']`                                               | Deploy-manifest paths omitted from upload                                                              |

```typescript
export default {
  frontend: {
    enabled: true,
    framework: "react",
    publicDir: "public",
    publicPath: "/",
    spaFallback: {
      scopes: [
        {
          basePath: "/admin/app",
          page: "admin/app/shell",
          exclude: ["/admin/api/**"],
        },
      ],
    },
  },
};
```

### Adapter extension contracts

`frontend.adapter` is an explicit, in-process typed seam; it is not automatic plugin discovery. A `VextFrontendAdapter` provides `name`, `framework`, and an optional `resolveBuildOptions(config)`. The resolver receives the resolved frontend configuration and may return synchronous or asynchronous compiler options. It does not add another bundler, nor does it enable RSC, Server Functions, or PPR.

`frontend.seo` is documented end-to-end in [SEO, Sitemap, and Robots](/frontend/seo-sitemap). `publicOrigin` is a deployment origin, not a fixed page URL: the current pathname or an explicit page canonical supplies the per-page portion. Runtime artifacts accept only exact declared hosts; providers do not receive `app` or `app.db` implicitly.

For a delivery target other than the built-in local staging adapters, pass a `VextFrontendDeployUploadAdapter` object to `deploy.upload.adapter`. It provides `name` and `upload(input)`. Its `VextFrontendDeployUploadAdapterInput` contains `asset`, `sourcePath`, `uploadKey`, and `dryRun`; its `VextFrontendDeployUploadAdapterResult` must return `uploaded` and may return `url` and `etag`.

```ts
export default {
  frontend: {
    deploy: {
      upload: {
        enabled: true,
        adapter: {
          name: "company-cdn",
          async upload({ asset, sourcePath, uploadKey, dryRun }) {
            if (dryRun) return { uploaded: false };
            // Upload sourcePath under uploadKey with the provider SDK of your choice.
            return {
              uploaded: true,
              url: `https://cdn.example.com/${uploadKey}`,
            };
          },
        },
      },
    },
  },
};
```

`filesystem` and `mock` are the only built-in upload adapter names. A provider-specific adapter stays explicit in application configuration, so the runtime does not silently install or discover cloud/bundler plugins.

By default `spaFallback.scopes` is empty, so unknown HTML paths are not swallowed into the SPA. For mixed SSR + client-router sub-apps, declare each `basePath` in `scopes[]`. `spaFallback: true` is kept only as a compatibility shorthand and is not recommended for enterprise mixed projects.

---

## VextClusterConfig

Cluster multi-process configuration. For the complete interface definition, see `src/types/app.ts` `VextClusterConfig`.

### Basic fields

| Field              | Type                           | Default Value | Description                                                                                                                                  |
| ------------------ | ------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`                      | `false`       | Whether to enable Cluster mode (can also be enabled by `VEXT_CLUSTER=1`)                                                                     |
| `workers`          | `'auto' \| 'auto-1' \| number` | `'auto'`      | Number of Workers (`'auto'` = detected available CPU count; `'auto-1'` = available CPU count - 1; number = fixed number, clamped to [1, 64]) |
| `autoRestart`      | `boolean`                      | `true`        | Worker automatically restarts after crash                                                                                                    |
| `maxRestarts`      | `number`                       | `5`           | The maximum number of restarts allowed within the fast restart detection window                                                              |
| `restartWindow`    | `number`                       | `60000`       | Fast restart detection window (milliseconds)                                                                                                 |
| `restartBaseDelay` | `number`                       | `1000`        | Restart interval backoff base (milliseconds)                                                                                                 |
| `restartMaxDelay`  | `number`                       | `30000`       | Upper limit of restart interval (milliseconds)                                                                                               |
| `memoryThreshold`  | `number`                       | `1073741824`  | Worker heap threshold in bytes; exceeding it triggers diagnostics and worker exit                                                            |
| `pidFile`          | `string`                       | `'.vext.pid'` | PID file path (for `vext stop` / `vext reload` to locate the process)                                                                        |
| `titlePrefix`      | `string`                       | `'vext'`      | Worker process title prefix                                                                                                                  |
| `sticky`           | `'none' \| 'ip'`               | `'none'`      | Sticky session mode (`'ip'` allocates fixed Worker based on client IP, suitable for WebSocket/SSE)                                           |

### `healthCheck` — heartbeat detection

| Field                  | Type      | Default Value | Description                                                                     |
| ---------------------- | --------- | ------------- | ------------------------------------------------------------------------------- |
| `healthCheck.enabled`  | `boolean` | `true`        | Whether to enable Worker heartbeat detection                                    |
| `healthCheck.interval` | `number`  | `15000`       | The interval at which the Master sends heartbeat detections (milliseconds)      |
| `healthCheck.timeout`  | `number`  | `30000`       | Worker heartbeat timeout threshold (milliseconds), forced restart after timeout |

### `reload` — Zero-downtime rolling restart

`cluster.reload` only configures timing for rolling restarts triggered by `vext reload` / `SIGHUP`. Omitting `cluster.reload` does not disable rolling restart; Vext uses the defaults.

| Field                    | Type     | Default Value | Description                                                  |
| ------------------------ | -------- | ------------- | ------------------------------------------------------------ |
| `reload.workerDelay`     | `number` | `2000`        | Time to wait before replacing the next Worker (milliseconds) |
| `reload.readyTimeout`    | `number` | `30000`       | New Worker readiness timeout (milliseconds)                  |
| `reload.shutdownTimeout` | `number` | `10000`       | Old Worker shutdown timeout (milliseconds)                   |

```typescript
export default {
  cluster: {
    enabled: true,
    workers: "auto", // Detect available CPUs via availableParallelism / cgroup v1 / os.cpus
    autoRestart: true,
    maxRestarts: 5,
    healthCheck: {
      enabled: true,
      interval: 15000,
      timeout: 30000,
    },
    reload: {
      workerDelay: 2000,
      readyTimeout: 30000,
      shutdownTimeout: 10000,
    },
  },
};
```

It can also be enabled through environment variables (no need to modify the configuration file):

```bash
VEXT_CLUSTER=1 vext start
```

---

## VextCacheConfig

Route-level response cache global configuration.

| Field             | Type      | Default Value | Description                                                                                                                                   |
| ----------------- | --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`        | Whether to enable route-level response caching. When `false`, the middleware is not installed and Redis/MultiLevel connections are not opened |
| `defaultTtl`      | `number`  | `60000`       | Default TTL when a route does not specify one, in milliseconds                                                                                |
| `maxEntries`      | `number`  | `1000`        | Memory-mode shortcut: maximum number of cache entries                                                                                         |
| `maxMemory`       | `number`  | —             | Memory-mode shortcut: maximum memory usage in bytes                                                                                           |
| `cleanupInterval` | `number`  | `0`           | Memory-mode shortcut: periodic cleanup interval; `0` means lazy cleanup only                                                                  |
| `cacheHub`        | `object`  | Memory        | Underlying response-cache runtime configuration                                                                                               |

```typescript
export default {
  cache: {
    enabled: true,
    defaultTtl: 120_000,
    maxEntries: 2000,
  },
};
```

Memory complete configuration:

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

Redis configuration:

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

MultiLevel configuration:

```typescript
export default {
  cache: {
    defaultTtl: 60_000,
    cacheHub: {
      mode: "multi-level",
      memory: { maxEntries: 1000 },
      redis: { url: "redis://localhost:6379" },
      writePolicy: "both",
      backfillOnRemoteHit: true,
      remoteTimeout: 50,
      lease: true,
    },
  },
};
```

`cacheHub` only accepts `response-cache-kit/cache-hub` configuration and does not accept custom Store. Route-level response caching is configured via `RouteOptions.cache`. The public configuration unit is in milliseconds; the `Cache-Control: max-age` in the response header will output seconds according to the HTTP standard. See the [Response Caching Guide](/guide/cache) for details.

---

## VextDevConfig

Development-only configuration. These fields are read by `vext dev` and ignored in production.

| Field          | Type                                            | Default Value | Description                         |
| -------------- | ----------------------------------------------- | ------------- | ----------------------------------- |
| `errorOverlay` | [`VextDevOverlayConfig`](#vextdevoverlayconfig) | See below     | Browser error overlay configuration |

### VextDevOverlayConfig

| Field       | Type                | Default Value | Description                               |
| ----------- | ------------------- | ------------- | ----------------------------------------- |
| `enabled`   | `boolean`           | `true`        | Enable the browser error overlay          |
| `theme`     | `'dark' \| 'light'` | `'dark'`      | Error overlay theme                       |
| `maxFrames` | `number`            | `25`          | Maximum stack frames shown in the overlay |

```typescript
export default {
  dev: {
    errorOverlay: {
      enabled: true,
      theme: "light",
      maxFrames: 10,
    },
  },
};
```

---

## DEFAULT_CONFIG

The full value of the framework’s built-in default configuration:

```typescript
import { DEFAULT_CONFIG } from 'vextjs';

// Complete content of DEFAULT_CONFIG:
{
  port: 3000,
  host: '0.0.0.0',
  adapter: 'native',
  trustProxy: false,
  middlewares: [],
  cors: {
    enabled: true,
    origins: ['*'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    headers: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: false,
  },
  rateLimit: {
    enabled: false,
    max: 100,
    window: 60,
    message: 'Too Many Requests',
    keyBy: 'ip',
  },
  requestId: {
    enabled: true,
    header: 'x-request-id',
    responseHeader: 'x-request-id',
  },
  logger: {
    level: 'info',
  },
  shutdown: {
    timeout: 10,
  },
  server: {},
  response: {
    hideInternalErrors: true,
    wrap: true,
  },
  session: {
    enabled: false,
    name: 'vext.sid',
    ttl: 86400,
    rolling: false,
    autoCommit: true,
    idLength: 32,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: 'auto',
    },
  },
  csrf: {
    enabled: false,
    mode: 'auto',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    headerNames: ['x-csrf-token', 'x-xsrf-token'],
    bodyField: '_csrf',
    cookie: {
      name: 'vext.csrf',
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      secure: 'auto',
    },
    fetchMetadata: true,
    origin: false,
  },
  securityHeaders: {
    enabled: false,
    preset: 'basic',
  },
  bodyParser: {
    enabled: true,
    maxBodySize: '1mb',
  },
  accessLog: {
    enabled: true,
    level: 'info',
    skipPaths: [],
  },
  openapi: {
    enabled: false,
  },
  requestContext: {
    enabled: true,
  },
  frontend: {
    enabled: false,
  },
}
```

---

## VextUserConfig

User-configured input type, all fields are optional. The complete `VextConfig` is generated by `loadConfig()` merging the default values.

```typescript
import type { VextUserConfig } from "vextjs";

const config: VextUserConfig = {
  port: 8080,
  logger: { level: "debug" },
};

export default config;
```

---

### `VextSessionConfig`

`config.session.enabled: true` auto-registers Session in production,
development, testing, and soft reload. The explicit `session()` middleware is
reserved for scoped/manual registration.

| Field        | Type                       | Default      | Description                                                  |
| ------------ | -------------------------- | ------------ | ------------------------------------------------------------ |
| `enabled`    | `boolean`                  | `false`      | Auto-register Session globally                               |
| `name`       | `string`                   | `'vext.sid'` | Session cookie name                                          |
| `ttl`        | `number`                   | `86400`      | Store TTL in seconds                                         |
| `rolling`    | `boolean`                  | `false`      | Refresh the store TTL and cookie on each request             |
| `autoCommit` | `boolean`                  | `true`       | Persist dirty session data before response send              |
| `idLength`   | `number`                   | `32`         | Random byte length for the CSPRNG session id; must be 16-128 |
| `cookie`     | `VextSessionCookieOptions` | See below    | Session cookie attributes                                    |
| `store`      | `VextSessionStore`         | memory store | Custom async store for shared deployments                    |

`VextSessionCookieOptions` follows `CookieSerializeOptions` and adds `secure: boolean | "auto"`. Cookie options include `domain`, `path`, `expires`, `maxAge`, `httpOnly`, `secure`, `sameSite`, `priority`, `partitioned`, and `encode`.

`VextSessionStore` requires `get(id)`, `set(id, data, ttlSeconds)`, and `delete(id)`. Optional methods are `touch(id, ttlSeconds)`, `clearExpired()`, and `close()`. Vext calls `close()` during app shutdown for configured stores and active manual Session runtimes.

For cache-backed production sessions, prefer `createCacheSessionStore(cacheLike, options?)` from `vextjs`. It accepts a structural `VextCacheLike` with `get`, `set`, and `del`, converts session TTL seconds to cache milliseconds, stores JSON strings by default, and exposes `close()` only when `options.close` is provided. `config.cache.cacheHub` remains route response cache configuration and does not inject a Session Store.

`RouteOptions.session` accepts `false`, `true`, or `{ enabled?, rolling?, autoCommit? }`. It can disable Session for one route or enable it while the global runtime is disabled.

---

### `VextCsrfConfig`

`config.csrf` configures the built-in CSRF middleware. `enabled: true` auto-registers CSRF globally after body parsing and plugin global middleware. You can also keep it disabled and register `csrf()` manually for scoped paths.

| Field           | Type                                     | Default                                             | Description                                                           |
| --------------- | ---------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `enabled`       | `boolean`                                | `false` in app config; `true` for manual `csrf()`   | Whether global auto-registration is enabled                           |
| `mode`          | `"auto" \| "session" \| "signed-cookie"` | `"auto"`                                            | Token storage mode                                                    |
| `secret`        | `string`                                 | `undefined`                                         | Required for `signed-cookie` mode                                     |
| `methods`       | `string[]`                               | `["POST", "PUT", "PATCH", "DELETE"]`                | Unsafe methods that require CSRF validation                           |
| `headerNames`   | `string[]`                               | `["x-csrf-token", "x-xsrf-token"]`                  | Header names accepted for submitted tokens                            |
| `bodyField`     | `string \| false`                        | `"_csrf"`                                           | Request body field accepted for submitted tokens; `false` disables it |
| `cookie`        | `CookieSerializeOptions`                 | `{ name: "vext.csrf", sameSite: "lax", path: "/" }` | Signed double-submit cookie attributes                                |
| `fetchMetadata` | `boolean`                                | `true`                                              | Reject `Sec-Fetch-Site: cross-site` unsafe requests                   |
| `origin`        | `false \| { trustedOrigins?: string[] }` | `false`                                             | Optional Origin/Referer same-origin enforcement                       |

Routes can opt out with route options `{ csrf: false }`.

---

### `VextSecurityHeadersConfig`

`config.securityHeaders` enables Vext's built-in browser security response headers. It is disabled by default. `preset: "basic"` is the low-impact path for most apps; `strict` and `custom` are explicit opt-ins.

| Field                       | Type                                                                                                               | Default           | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| `enabled`                   | `boolean`                                                                                                          | `false`           | Auto-register the built-in Security Headers middleware                         |
| `preset`                    | `"basic" \| "strict" \| "custom"`                                                                                  | `"basic"`         | Header preset                                                                  |
| `contentTypeOptions`        | `"nosniff" \| false`                                                                                               | preset controlled | Controls `X-Content-Type-Options`                                              |
| `referrerPolicy`            | `string \| false`                                                                                                  | preset controlled | Controls `Referrer-Policy`                                                     |
| `frameOptions`              | `"DENY" \| "SAMEORIGIN" \| false`                                                                                  | preset controlled | Controls `X-Frame-Options`                                                     |
| `hsts`                      | `false \| { enabled?: boolean; maxAge?: number; includeSubDomains?: boolean; preload?: boolean; force?: boolean }` | `false` in basic  | Controls `Strict-Transport-Security`; sent only for HTTPS unless `force: true` |
| `contentSecurityPolicy`     | `false \| string \| object`                                                                                        | `false`           | Controls CSP or CSP report-only                                                |
| `permissionsPolicy`         | `false \| string \| Record<string, boolean \| string[]>`                                                           | `false` in basic  | Controls `Permissions-Policy`                                                  |
| `crossOriginOpenerPolicy`   | `false \| "same-origin" \| "same-origin-allow-popups" \| "unsafe-none"`                                            | `false` in basic  | Controls COOP                                                                  |
| `crossOriginEmbedderPolicy` | `false \| "require-corp" \| "credentialless" \| "unsafe-none"`                                                     | `false`           | Controls COEP; not enabled by `strict`                                         |
| `crossOriginResourcePolicy` | `false \| "same-origin" \| "same-site" \| "cross-origin"`                                                          | `false` in basic  | Controls CORP                                                                  |
| `headers`                   | `Record<string, string>`                                                                                           | `{}`              | Custom headers merged last                                                     |
| `skipPaths`                 | `string[]`                                                                                                         | `[]`              | Exact paths or trailing-`*` prefixes to skip                                   |

```typescript
export default {
  securityHeaders: {
    enabled: true,
    preset: "basic",
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        "default-src": ["'self'"],
        "upgrade-insecure-requests": true,
      },
    },
  },
};
```

`basic` sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: SAMEORIGIN`. `strict` adds HTTPS-only HSTS, a minimal `Permissions-Policy`, COOP, and CORP, but still leaves CSP and COEP explicit. `custom` sends only fields you configure. Routes can opt out with `{ securityHeaders: false }`.

---

## loadConfig

Configuration loading function, receives the configuration directory path and performs the complete configuration chain merge.

```typescript
import { loadConfig } from "vextjs";
import { join } from "node:path";

const config = await loadConfig(join(process.cwd(), "src/config"), {
  rootDir: process.cwd(),
  command: "start",
  isBuilt: false,
});
// config: VextConfig (merged, frozen)
```

Usually there is no need to call it manually, `bootstrap()` will automatically call `loadConfig()` internally. The merge order is: `DEFAULT_CONFIG < default < config profile < local < bootstrap provider patch < CLI override`.

---

## Environment variable override

Some configurations support overriding through environment variables:

| Environment variables | Corresponding configuration | Description                                                 |
| --------------------- | --------------------------- | ----------------------------------------------------------- |
| `VEXT_PORT`           | `port`                      | Strict whole-value port override from CLI/runtime transport |
| `VEXT_HOST`           | `host`                      | Host override from CLI/runtime transport                    |
| `VEXT_CONFIG`         | —                           | Select the config profile to load                           |
| `NODE_ENV`            | —                           | Runtime mode; `vext start` runs as production               |
| `VEXT_CLUSTER`        | `cluster.enabled`           | Set to `1` to enable clustering                             |

```bash
VEXT_PORT=8080 VEXT_CONFIG=sg-sit vext start
```

---

## Type declaration extension

Plug-ins can add custom fields to `VextConfig` through `declare module`:

```typescript
// types/vext.d.ts
declare module "vextjs" {
  interface VextConfig {
    redis?: {
      host: string;
      port: number;
      password?: string;
    };
  }
}
```

Later use in the configuration file will get full type hints:

```typescript
// src/config/default.ts
export default {
  redis: {
    host: "localhost",
    port: 6379,
  },
};
```
