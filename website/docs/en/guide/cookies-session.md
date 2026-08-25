# Cookies and Sessions

Vext provides first-party cookie parsing, response cookie helpers, and a configuration-driven Session runtime. The feature is zero-dependency and works across Native, Hono, Fastify, Express, and Koa adapters.

## Cookies

Every request exposes parsed cookies:

```typescript
app.get("/preferences", {}, async (req, res) => {
  const theme = req.cookie("theme") ?? "system";
  res.json({ theme, all: req.cookies });
});
```

Set cookies through `res.cookie()` and clear them through `res.clearCookie()`:

```typescript
res.cookie("theme", "dark", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
});

res.clearCookie("theme", { path: "/" });
```

Multiple `res.cookie()` calls are emitted as multiple `Set-Cookie` headers. Vext does not join them with commas.

`req.cookies` is readonly and uses first-wins semantics for duplicate cookie names. `res.cookie()` also supports `priority`, `partitioned`, and a custom `encode` function for advanced cases.

## Cookie Validation

`validate.cookie` validates parsed cookie values and emits OpenAPI `in: cookie` parameters:

```typescript
app.get(
  "/me",
  {
    validate: {
      cookie: {
        sid: "string!",
      },
    },
  },
  async (req, res) => {
    const { sid } = req.valid("cookie");
    res.json({ sid });
  },
);
```

Validation order is `param -> query -> header -> cookie -> body`.

Built-in OpenAPI docs can display `validate.cookie` as cookie parameters. Browser Try it out cannot set the forbidden `Cookie` header directly; use cookies already present for the same origin, a browser login flow, or an HTTP client such as cURL for manual cookie values.

## Sessions

Enable Session through configuration. Vext auto-registers it in production,
development, tests, and soft reloads:

```typescript
// src/config/default.ts
export default {
  session: {
    enabled: true,
  },
};
```

Use `req.session` in route handlers:

```typescript
app.post("/login", {}, async (req, res) => {
  req.session!.userId = "u_123";
  res.json({ ok: true });
});

app.post("/logout", {}, async (req, res) => {
  await req.session!.destroy();
  res.json({ ok: true });
});
```

The session object supports:

| Method         | Description                                     |
| -------------- | ----------------------------------------------- |
| `save()`       | Persist immediately and send the session cookie |
| `regenerate()` | Replace the session id and delete the old id    |
| `destroy()`    | Delete store data and clear the cookie          |

Session metadata such as `id`, `isNew`, `save`, `regenerate`, and `destroy` is non-enumerable and is not persisted into the store.

With `autoCommit: true`, Vext awaits an asynchronous store `set` or `delete` at the response send barrier. If persistence rejects, the original success response and its new session cookie are not sent. Explicit `save()`/`regenerate()`/`destroy()` and auto-commit share one in-flight commit, preventing duplicate writes and cookies. A dirty session cannot be auto-committed after streaming starts; call `await req.session.save()` before `res.stream()`.

## Configuration

`config.session.enabled: true` enables the global Session runtime and the
remaining fields configure it:

```typescript
export default {
  session: {
    enabled: true,
    name: "vext.sid",
    ttl: 86400,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: "auto",
    },
  },
};
```

`secure: "auto"` sends `Secure` only for HTTPS requests. The default memory store removes expired entries on access and through bounded opportunistic sweeps, without a process-retaining timer. It is suitable for development, tests, and single-process deployments. For shared production stores, pass a cache-like backend through the official adapter:

```typescript
import { createCacheSessionStore } from "vextjs";
import { createRedisCacheAdapter } from "cache-hub/redis";

const sessionCache = createRedisCacheAdapter("redis://localhost:6379");

export default {
  session: {
    enabled: true,
    store: createCacheSessionStore(sessionCache, {
      prefix: "my-app:sess:",
      close: () => sessionCache.close?.(),
    }),
  },
};
```

`createCacheSessionStore()` accepts a structural cache with `get`, `set`, and `del`. It converts `VextSessionStore` TTL seconds to cache milliseconds, stores JSON strings by default, and implements rolling `touch()` as a cache `get` plus `set`. Install `cache-hub` and the selected backend client, such as `ioredis`, in the consuming app.

`config.cache.cacheHub` and `app.cache` are only for route response cache. They are not a Session Store shortcut and should use a different namespace from sessions. If you provide `close`, Vext calls it exactly once during app shutdown. Advanced users can still implement `VextSessionStore` directly for custom persistence contracts.

Use route options `session: false` to skip Session on a public route. When the
global runtime is disabled, `session: true` or `{ session: { enabled: true,
rolling: true } }` enables it for one route. The explicit `session()` middleware
remains available for scoped/manual registration; do not combine it with
`config.session.enabled: true`.

## CSRF Protection

CSRF protection is available through `csrf()` and `config.csrf`. In `mode: "auto"` Vext uses the configured Session runtime when `req.session` is available; otherwise it can use a signed double-submit cookie when `config.csrf.secret` is configured.

```typescript
export default {
  session: { enabled: true },
  csrf: {
    enabled: true,
  },
};

app.get("/csrf-token", {}, async (req, res) => {
  res.json({ token: req.csrfToken() });
});
```

Unsafe methods default to `POST`, `PUT`, `PATCH`, and `DELETE`. Submit the token through `x-csrf-token`, `x-xsrf-token`, or body field `_csrf`. Use route options `{ csrf: false }` for public endpoints that must accept unsafe methods without a CSRF token.

Global auto-registration is available with `config.csrf.enabled: true`. It runs after body parsing and plugin global middleware so session data is available before CSRF validation. For scoped protection, register `csrf()` manually inside a plugin and call it only for selected paths.

## Cache Safety

Route cache is conservative around cookies:

- requests with a `Cookie` header bypass cache by default
- responses with `Set-Cookie` are never written to cache
- set `allowCookieCache: true` only for routes whose cookie input is known to be safe

```typescript
app.get(
  "/public-ab-test",
  {
    cache: {
      ttl: 60_000,
      allowCookieCache: true,
      vary: ["cookie"],
    },
  },
  handler,
);
```
