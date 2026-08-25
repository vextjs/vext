# permission-core Auth 接入

本示例展示如何把 [permission-core](https://devcodex-labs.github.io/permission-core/) 接入 VextJS Auth。Vext 的认证与路由保护是分层的：

- `auth()` 负责解析 Bearer token，并填充 `req.auth`。
- `permission-core` 负责 `invoke + GET:/api/posts` 这类授权判断。
- 每条路由把最终 `RouteOptions.auth` 内联或保存为同文件 `const`，让构建索引、运行时保护与 OpenAPI 读取同一份合同。

## 1. 安装

```bash
npm install permission-core
```

演示或测试项目可以使用 `MemoryAdapter`。生产环境请按 permission-core 生产部署文档选择持久化 storage adapter，并接入 permission-core 推荐的 `cache-hub + monsqlize` 栈。

## 2. 创建 permission 插件

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

    await core.roles.create("admin", { label: "管理员" });
    await core.roles.create("editor", { label: "编辑者" });
    await core.roles.create("viewer", { label: "只读用户" });

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

## 3. 用 `auth()` 连接 permission-core

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

在 `src/config/default.ts` 注册中间件名：

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

## 4. 声明可静态投影的路由保护

路由索引不会执行导入或本地 helper 函数。请把每个最终保护形状保留在路由文件的同文件 `const` 中，让 middleware、permission、security 与 docs 合同都能在运行前完整读取：

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
  docs: { summary: "文章列表", tags: ["Posts"] },
} satisfies RouteOptions;

const createPostOptions = {
  middlewares: ["permission-core-auth"],
  auth: {
    permissions: [{ action: "invoke", resource: "POST:/api/posts" }],
    security: "bearerAuth",
  },
  docs: { summary: "创建文章", tags: ["Posts"] },
} satisfies RouteOptions;
```

同一资源族的路由常量可以集中放在对应 route 模块中。可复用的运行时行为仍由 `permission-core-auth` middleware 与 permission provider 统一承担；路由合同本身保持静态可见。

## 5. 用最终 options 常量保护路由

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

`RouteOptions.auth` 仍然是路由保护契约。有限静态语法会拒绝 route-options helper 调用；请使用最终内联对象或同文件最终 `const`。旧的 `openapi.guardSecurityMap` 只继续兼容 middleware-only 历史路由。

## 6. 在 handler 内直接 `assert()`

只有当某条路由需要在 handler 内做额外动态判断时，才使用 `req.auth.assert()`：

```typescript
import { permissionCoreAuth } from "../auth/permission-policies";

app.delete(
  "/posts/:id",
  permissionCoreAuth({ summary: "删除文章", tags: ["Posts"] }),
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

如果 permission-core 拒绝该操作，Vext 会沿 Auth guard 路径返回 `AUTH_FORBIDDEN`。

## 7. 验证

注册 middleware 和 routes 后，请在应用自己的测试套件中验证这一接入。至少应断言：

- 认证会填充预期的 identity 和安全的 request context
- permission-core `can()` 会放行已授权操作并拒绝未授权操作
- 缺失、malformed、unknown credential 会返回文档说明的错误
- 被拒绝的操作中 `req.auth.assert()` 返回 `AUTH_FORBIDDEN`，且 OpenAPI document 声明 `bearerAuth`
