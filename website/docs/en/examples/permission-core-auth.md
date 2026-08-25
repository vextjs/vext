# permission-core Auth

This example shows how to connect [permission-core](https://devcodex-labs.github.io/permission-core/) to VextJS Auth. Vext keeps authentication and route guards separate:

- `auth()` parses the Bearer token and fills `req.auth`.
- `permission-core` owns authorization decisions such as `invoke + GET:/api/posts`.
- Each route keeps its final `RouteOptions.auth` inline or in a same-file `const`, so build indexing, runtime guards, and OpenAPI read the same contract.

## 1. Install

```bash
npm install permission-core
```

For a demo or test project, `MemoryAdapter` is enough. For production, follow permission-core's production guide and use a persistent storage adapter with the `cache-hub + monsqlize` stack recommended by permission-core.

## 2. Create the permission plugin

```typescript
// src/plugins/permission.ts
import { defineAppExtensions, definePlugin } from "vextjs";
import { MemoryAdapter, PermissionCore } from "permission-core";

export const appExtensions = defineAppExtensions<{
  permission: PermissionCore;
}>();

export default definePlugin({
  name: "permission",

  async setup(app) {
    const core = new PermissionCore({ storage: new MemoryAdapter() });
    await core.init();

    await core.roles.create("admin", { label: "Admin" });
    await core.roles.create("editor", { label: "Editor" });
    await core.roles.create("viewer", { label: "Viewer" });

    await core.roles.allow("admin", "invoke", "GET:/api/posts");
    await core.roles.allow("admin", "invoke", "POST:/api/posts");
    await core.roles.allow("admin", "invoke", "DELETE:/api/posts");
    await core.roles.allow("editor", "invoke", "GET:/api/posts");
    await core.roles.allow("editor", "invoke", "POST:/api/posts");
    await core.roles.deny("editor", "invoke", "DELETE:/api/posts");
    await core.roles.allow("viewer", "invoke", "GET:/api/posts");

    await core.users.setUserRoles("u-admin", ["admin"]);
    await core.users.setUserRoles("u-editor", ["editor"]);
    await core.users.setUserRoles("u-viewer", ["viewer"]);

    app.extend("permission", core);
  },

  async onClose(app) {
    await app.permission.close();
  },
});
```

## 3. Bridge `auth()` to permission-core

```typescript
// src/middlewares/permission-core-auth.ts
import { auth, defineMiddleware } from "vextjs";
import type { VextRequest } from "vextjs";
import type { PermissionCore } from "permission-core";

const tokenUsers: Record<string, { userId: string; roles: string[] }> = {
  "pc-admin-token": { userId: "u-admin", roles: ["admin"] },
  "pc-editor-token": { userId: "u-editor", roles: ["editor"] },
  "pc-viewer-token": { userId: "u-viewer", roles: ["viewer"] },
};

function getPermissionCore(req: VextRequest) {
  const core = (req.app as typeof req.app & { permission?: PermissionCore })
    .permission;
  if (!core) {
    throw new Error("permission-core plugin is not available");
  }
  return core;
}

export default defineMiddleware(
  auth({
    provider: "permission-core",
    verify(token, req) {
      const user = token ? tokenUsers[token] : undefined;
      if (!user) return false;

      const core = getPermissionCore(req);

      return {
        subject: `user:${user.userId}`,
        userId: user.userId,
        roles: user.roles,
        scopes: ["permission:invoke"],
        provider: "permission-core",
        can(action, resource) {
          if (!resource) return false;
          return core.can(user.userId, action, resource);
        },
        async assert(action, resource) {
          if (!resource) {
            throw new Error("permission-core resource is required");
          }
          await core.assert(user.userId, action, resource);
        },
      };
    },
  }),
);
```

Register the middleware name in `src/config/default.ts`:

```typescript
export default {
  middlewares: [{ name: "permission-core-auth" }],
  openapi: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
  },
};
```

## 4. Declare statically projectable route guards

The route index does not execute imported or local helper functions. Keep each final guard shape in the route file as a same-file `const`; this makes the complete middleware, permission, security, and docs contract visible before runtime:

```typescript
// src/routes/posts.ts
import { defineRoutes } from "vextjs";
import type { RouteOptions } from "vextjs";

const listPostsOptions = {
  middlewares: ["permission-core-auth"],
  auth: {
    permissions: [{ action: "invoke", resource: "GET:/api/posts" }],
    security: "bearerAuth",
  },
  docs: { summary: "List posts", tags: ["Posts"] },
} satisfies RouteOptions;

const createPostOptions = {
  middlewares: ["permission-core-auth"],
  auth: {
    permissions: [{ action: "invoke", resource: "POST:/api/posts" }],
    security: "bearerAuth",
  },
  docs: { summary: "Create post", tags: ["Posts"] },
} satisfies RouteOptions;
```

Keep related route constants together in their route module. Shared runtime behavior remains centralized in the `permission-core-auth` middleware and permission provider; the route contract itself stays statically visible.

## 5. Protect routes with the final option constants

```typescript
export default defineRoutes((app) => {
  app.get("/posts", listPostsOptions, async (req, res) => {
    res.json({ ok: true, userId: req.auth.userId });
  });

  app.post("/posts", createPostOptions, async (req, res) => {
    res.json({ ok: true, userId: req.auth.userId }, 201);
  });
});
```

`RouteOptions.auth` remains the guard contract. Route-options helper calls are rejected by the finite static grammar; use an inline final object or a same-file final `const`. The older `openapi.guardSecurityMap` fallback still exists only for legacy middleware-only routes.

## 6. Direct `assert()` in handlers

Use `req.auth.assert()` only when a route has additional runtime decisions that are easier to express inside the handler:

```typescript
import { permissionCoreAuth } from "../auth/permission-policies";

app.delete(
  "/posts/:id",
  permissionCoreAuth({ summary: "Delete post", tags: ["Posts"] }),
  async (req, res) => {
    const assertPermission = req.auth.assert;
    if (!assertPermission) {
      req.app.throw(
        500,
        "Permission provider is not configured",
        "AUTH_CONFIG_ERROR",
      );
      return;
    }

    try {
      await assertPermission("invoke", "DELETE:/api/posts");
    } catch {
      req.app.throw(403, "Forbidden", "AUTH_FORBIDDEN");
      return;
    }

    await app.services.posts.delete(req.params.id);
    res.status(204).json(null);
  },
);
```

If permission-core denies the operation, Vext returns `AUTH_FORBIDDEN` through the Auth guard path.

## 7. Verify

Verify this integration in your application's test suite after registering the middleware and routes. At minimum, assert:

- authentication fills the expected identity and a safe request context
- permission-core `can()` allows an authorized operation and denies an unauthorized one
- missing, malformed, and unknown credentials return the documented errors
- `req.auth.assert()` returns `AUTH_FORBIDDEN` for a denied operation and the OpenAPI document declares `bearerAuth`
