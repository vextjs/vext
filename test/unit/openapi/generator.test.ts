import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  OpenAPIGenerator,
  collectDeprecatedRouteDocsTagsUsage,
  createDeprecatedRouteDocsTagsWarning,
} from "../../../src/lib/openapi/generator.js";
import { RouteMetadataCollector } from "../../../src/lib/openapi/collector.js";
import { schemaAdapter } from "../../../src/lib/schema-adapter.js";
import type {
  RouteMetadata,
  OpenAPIDocument,
  OpenAPIConfig,
} from "../../../src/lib/openapi/types.js";
import type { RouteOptions } from "../../../src/types/app.js";

// ── 测试辅助 ────────────────────────────────────────────────

/**
 * 创建测试用的 RouteMetadata
 */
function createRoute(
  method: string,
  path: string,
  options: RouteOptions = {},
  sourceFile = "routes/test.ts",
): RouteMetadata {
  return { method, path, options, sourceFile };
}

/**
 * 创建带默认配置的 OpenAPIGenerator
 */
function createGenerator(config: OpenAPIConfig = {}): OpenAPIGenerator {
  return new OpenAPIGenerator(config);
}

/**
 * 生成文档的快捷方法
 */
function generate(
  routes: RouteMetadata[],
  config: OpenAPIConfig = {},
): OpenAPIDocument {
  return createGenerator(config).generate(routes);
}

function readRepoFile(filePath: string): string {
  return readFileSync(resolve(filePath), "utf8");
}

function expectPathTemplateParametersAreDeclared(doc: OpenAPIDocument): void {
  const failures: string[] = [];

  for (const [path, methods] of Object.entries(doc.paths)) {
    const templateParamNames = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1],
    );
    if (templateParamNames.length === 0) {
      continue;
    }

    for (const [method, operation] of Object.entries(methods)) {
      const pathParameters = new Map(
        (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => [parameter.name, parameter]),
      );

      for (const name of templateParamNames) {
        const parameter = pathParameters.get(name);
        if (!parameter) {
          failures.push(`${method.toUpperCase()} ${path} missing ${name}`);
        } else if (parameter.required !== true) {
          failures.push(
            `${method.toUpperCase()} ${path} parameter ${name} is not required`,
          );
        }
      }
    }
  }

  expect(failures).toEqual([]);
}

// ═════════════════════════════════════════════════════════════
// RouteMetadataCollector 单元测试
// ═════════════════════════════════════════════════════════════

describe("RouteMetadataCollector", () => {
  let collector: RouteMetadataCollector;

  beforeEach(() => {
    collector = new RouteMetadataCollector();
  });

  // ── 基础收集 ──────────────────────────────────────────────

  describe("基础收集", () => {
    it("初始状态为空", () => {
      expect(collector.getRoutes()).toEqual([]);
      expect(collector.getCount()).toBe(0);
    });

    it("收集单条路由", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      expect(collector.getCount()).toBe(1);

      const routes = collector.getRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe("GET");
      expect(routes[0].path).toBe("/users");
      expect(routes[0].sourceFile).toBe("routes/users.ts");
      expect(routes[0].docsKind).toBe("backend-api");
    });

    it("根据 handler 中的 res.render 调用识别前端路由", () => {
      collector.addRoute(
        "GET",
        "/frontend/render",
        {},
        "routes/frontend.ts",
        async (_req: any, res: any) => {
          await res.render("Home");
        },
      );

      const routes = collector.getRoutes();
      expect(routes[0].docsKind).toBe("frontend-route");
    });

    it("忽略注释和字符串中的 render 字样", () => {
      collector.addRoute(
        "GET",
        "/users",
        {},
        "routes/users.ts",
        (_req: any, res: any) => {
          const message = "res.render() is not called";
          // res.render("Home")
          res.json({ message });
        },
      );

      const routes = collector.getRoutes();
      expect(routes[0].docsKind).toBe("backend-api");
    });

    it("收集多条路由", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      collector.addRoute("POST", "/users", {}, "routes/users.ts");
      collector.addRoute("GET", "/posts", {}, "routes/posts.ts");

      expect(collector.getCount()).toBe(3);
      expect(collector.getRoutes()).toHaveLength(3);
    });

    it("保留路由 options 原始对象", () => {
      const options: RouteOptions = {
        validate: { body: { name: "string!" } },
        middlewares: ["auth"],
        docs: { summary: "获取用户列表" },
      };

      collector.addRoute("GET", "/users", options, "routes/users.ts");
      const route = collector.getRoutes()[0];
      expect(route.options).toBe(options);
    });

    it("保留路由的 HTTP 方法大写", () => {
      collector.addRoute("POST", "/users", {}, "routes/users.ts");
      expect(collector.getRoutes()[0].method).toBe("POST");
    });
  });

  // ── 隐藏路由过滤 ──────────────────────────────────────────

  describe("隐藏路由过滤", () => {
    it("docs.hidden = true 的路由不被收集", () => {
      collector.addRoute(
        "GET",
        "/internal/health",
        { docs: { hidden: true } },
        "routes/internal.ts",
      );
      expect(collector.getCount()).toBe(0);
      expect(collector.getRoutes()).toEqual([]);
    });

    it("docs.hidden = false 的路由正常收集", () => {
      collector.addRoute(
        "GET",
        "/users",
        { docs: { hidden: false } },
        "routes/users.ts",
      );
      expect(collector.getCount()).toBe(1);
    });

    it("无 docs 的路由正常收集", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      expect(collector.getCount()).toBe(1);
    });

    it("docs 存在但无 hidden 字段的路由正常收集", () => {
      collector.addRoute(
        "GET",
        "/users",
        { docs: { summary: "test" } },
        "routes/users.ts",
      );
      expect(collector.getCount()).toBe(1);
    });

    it("混合隐藏和可见路由", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      collector.addRoute(
        "GET",
        "/health",
        { docs: { hidden: true } },
        "routes/health.ts",
      );
      collector.addRoute("POST", "/users", {}, "routes/users.ts");
      collector.addRoute(
        "GET",
        "/metrics",
        { docs: { hidden: true } },
        "routes/metrics.ts",
      );

      expect(collector.getCount()).toBe(2);
      expect(collector.getRoutes().map((r) => r.path)).toEqual([
        "/users",
        "/users",
      ]);
    });
  });

  // ── getRoutes 返回副本 ────────────────────────────────────

  describe("getRoutes 返回副本", () => {
    it("修改返回数组不影响内部状态", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");

      const routes = collector.getRoutes();
      routes.push(createRoute("DELETE", "/test"));

      expect(collector.getCount()).toBe(1);
      expect(collector.getRoutes()).toHaveLength(1);
    });

    it("多次调用 getRoutes 返回不同的数组引用", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");

      const r1 = collector.getRoutes();
      const r2 = collector.getRoutes();
      expect(r1).not.toBe(r2);
      expect(r1).toEqual(r2);
    });
  });

  // ── clear 重置 ────────────────────────────────────────────

  describe("clear 重置", () => {
    it("清空后路由数为 0", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      collector.addRoute("POST", "/users", {}, "routes/users.ts");
      expect(collector.getCount()).toBe(2);

      collector.clear();
      expect(collector.getCount()).toBe(0);
      expect(collector.getRoutes()).toEqual([]);
    });

    it("清空后可以重新收集", () => {
      collector.addRoute("GET", "/users", {}, "routes/users.ts");
      collector.clear();

      collector.addRoute("POST", "/posts", {}, "routes/posts.ts");
      expect(collector.getCount()).toBe(1);
      expect(collector.getRoutes()[0].path).toBe("/posts");
    });

    it("多次 clear 不报错", () => {
      collector.clear();
      collector.clear();
      expect(collector.getCount()).toBe(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// OpenAPIGenerator 单元测试
// ═════════════════════════════════════════════════════════════

describe("OpenAPIGenerator", () => {
  // ── 文档基本结构 ──────────────────────────────────────────

  describe("文档基本结构", () => {
    it("生成空路由的文档", () => {
      const doc = generate([]);
      expect(doc.openapi).toBe("3.0.3");
      expect(doc.info.title).toBe("VextJS API");
      expect(doc.info.version).toBe("1.0.0");
      expect(doc.info.description).toBe("Auto-generated API documentation");
      expect(doc.paths).toEqual({});
    });

    it("使用自定义配置", () => {
      const doc = generate([], {
        title: "My API",
        description: "Custom API docs",
        version: "2.0.0",
      });
      expect(doc.info.title).toBe("My API");
      expect(doc.info.description).toBe("Custom API docs");
      expect(doc.info.version).toBe("2.0.0");
    });

    it("包含 contact 信息", () => {
      const doc = generate([], {
        contact: {
          name: "API Support",
          email: "support@example.com",
          url: "https://example.com",
        },
      });
      expect(doc.info.contact).toEqual({
        name: "API Support",
        email: "support@example.com",
        url: "https://example.com",
      });
    });

    it("包含 license 信息", () => {
      const doc = generate([], {
        license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      });
      expect(doc.info.license).toEqual({
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      });
    });

    it("包含 servers 信息", () => {
      const doc = generate([], {
        servers: [
          { url: "http://localhost:3000", description: "Development" },
          { url: "https://api.example.com", description: "Production" },
        ],
      });
      expect(doc.servers).toHaveLength(2);
      expect(doc.servers![0].url).toBe("http://localhost:3000");
      expect(doc.servers![1].description).toBe("Production");
    });

    it("默认 servers 为 [{ url: '/', description: 'Current server' }]", () => {
      const doc = generate([]);
      expect(doc.servers).toEqual([
        { url: "/", description: "Current server" },
      ]);
    });

    it("始终包含 ErrorResponse 和 SuccessResponse schema", () => {
      const doc = generate([]);
      expect(doc.components!.schemas!.ErrorResponse).toBeDefined();
      expect(doc.components!.schemas!.SuccessResponse).toBeDefined();

      // ErrorResponse 结构
      const err = doc.components!.schemas!.ErrorResponse;
      expect(err.type).toBe("object");
      expect(err.properties!.code.oneOf).toEqual([
        { type: "integer" },
        { type: "string" },
      ]);
      expect(err.properties!.message.type).toBe("string");
      expect(err.properties!.requestId.type).toBe("string");
      expect(err.properties!.details.oneOf).toEqual([
        { type: "object", additionalProperties: true },
        { type: "array", items: {} },
      ]);
      expect(err.properties!.errors).toMatchObject({
        type: "array",
        items: {
          type: "object",
          required: ["field", "message"],
        },
      });
      expect(err.required).toEqual(["code", "message", "requestId"]);

      // SuccessResponse 结构
      const success = doc.components!.schemas!.SuccessResponse;
      expect(success.type).toBe("object");
      expect(success.properties!.code.example).toBe(0);
      expect(success.required).toEqual(["code", "data", "requestId"]);
    });
  });

  // ── securitySchemes ───────────────────────────────────────

  describe("securitySchemes", () => {
    it("默认提供 bearerAuth 方案", () => {
      const doc = generate([]);
      const schemes = doc.components!.securitySchemes!;
      expect(schemes.bearerAuth).toBeDefined();
      expect(schemes.bearerAuth.type).toBe("http");
      expect(schemes.bearerAuth.scheme).toBe("bearer");
      expect(schemes.bearerAuth.bearerFormat).toBe("JWT");
    });

    it("使用自定义 securitySchemes 覆盖默认", () => {
      const doc = generate([], {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
          },
        },
      });
      const schemes = doc.components!.securitySchemes!;
      expect(schemes.bearerAuth).toBeUndefined();
      expect(schemes.apiKey).toBeDefined();
      expect(schemes.apiKey.type).toBe("apiKey");
    });
  });

  // ── tags 推断 ─────────────────────────────────────────────

  describe("tags 推断", () => {
    it("从路由 path 推断 tags", () => {
      const doc = generate([
        createRoute("GET", "/users", {}, "routes/users.ts"),
        createRoute("GET", "/posts", {}, "routes/posts.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "Posts" }, { name: "Users" }]);
    });

    it("忽略已废弃的 docs.tags 并使用自动推断 tags", () => {
      const doc = generate([
        createRoute(
          "GET",
          "/users",
          { docs: { tags: ["用户管理"] } },
          "routes/users.ts",
        ),
      ]);
      expect(doc.tags).toEqual([{ name: "Users" }]);
    });

    it("混合已废弃 docs.tags 和自动推断 tags（去重排序）", () => {
      const doc = generate([
        createRoute(
          "GET",
          "/users",
          { docs: { tags: ["Users"] } },
          "routes/users.ts",
        ),
        createRoute("GET", "/posts", {}, "routes/posts.ts"),
        createRoute(
          "POST",
          "/users",
          { docs: { tags: ["Users"] } },
          "routes/users.ts",
        ),
      ]);
      const tagNames = doc.tags!.map((t) => t.name);
      expect(tagNames).toContain("Users");
      expect(tagNames).toContain("Posts");
      // 已排序
      expect(tagNames).toEqual([...tagNames].sort());
    });

    it("使用自定义 tags 覆盖推断", () => {
      const doc = generate(
        [createRoute("GET", "/users", {}, "routes/users.ts")],
        {
          tags: [
            { name: "Users", description: "User management" },
            { name: "Posts", description: "Post management" },
          ],
        },
      );
      expect(doc.tags).toHaveLength(2);
      expect(doc.tags![0]).toEqual({
        name: "Users",
        description: "User management",
      });
    });

    it("根级健康检查 → tag 'General'", () => {
      const doc = generate([
        createRoute("GET", "/health", {}, "routes/index.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "General" }]);
    });

    it("/admin/roles → tag 'Admin'", () => {
      const doc = generate([
        createRoute("GET", "/admin/roles", {}, "routes/admin/roles.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "Admin" }]);
    });

    it("Windows 来源路径分隔符不影响 path 优先推断", () => {
      const doc = generate([
        createRoute("GET", "/admin/roles", {}, "routes\\admin\\roles.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "Admin" }]);
    });

    it("API 版本路径 /api/v2/users → 'API v2'", () => {
      const doc = generate([
        createRoute("GET", "/api/v2/users", {}, "routes/api/v2/users.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "API v2" }]);
    });

    it("命名版本和根版本路径与 source 推断保持一致", () => {
      const doc = generate([
        createRoute("GET", "/api/beta/info", {}, "routes/api/beta/info.ts"),
        createRoute("GET", "/api/rc1/info", {}, "routes/api/rc1/info.ts"),
        createRoute("GET", "/v1/info", {}, "routes/v1/info.ts"),
      ]);

      expect(doc.tags).toEqual([
        { name: "API Beta" },
        { name: "API RC1" },
        { name: "API v1" },
      ]);
      expect(doc.paths["/api/beta/info"]!.get!.tags).toEqual(["API Beta"]);
      expect(doc.paths["/api/rc1/info"]!.get!.tags).toEqual(["API RC1"]);
      expect(doc.paths["/v1/info"]!.get!.tags).toEqual(["API v1"]);
    });

    it("/users → tag 'Users'", () => {
      const doc = generate([
        createRoute("GET", "/users", {}, "routes/users/index.ts"),
      ]);
      expect(doc.tags).toEqual([{ name: "Users" }]);
    });

    it("聚合生成 docs.tags 弃用 warning", () => {
      const routes = [
        createRoute("GET", "/admin/stats", { docs: { tags: ["Admin"] } }),
        createRoute("GET", "/api/v1/info", { docs: { tags: ["API v1"] } }),
        createRoute("GET", "/users", {}),
      ];

      expect(collectDeprecatedRouteDocsTagsUsage(routes)).toHaveLength(2);
      expect(createDeprecatedRouteDocsTagsWarning(routes)).toContain(
        "route docs.tags is deprecated and ignored",
      );
    });
  });

  // ── paths 生成 ────────────────────────────────────────────

  describe("paths 生成", () => {
    it("简单路由生成 path 条目", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"]).toBeDefined();
      expect(doc.paths["/users"].get).toBeDefined();
    });

    it("同路径不同方法合并到同一 path 对象", () => {
      const doc = generate([
        createRoute("GET", "/users"),
        createRoute("POST", "/users"),
      ]);
      expect(doc.paths["/users"].get).toBeDefined();
      expect(doc.paths["/users"].post).toBeDefined();
    });

    it("不同路径分开", () => {
      const doc = generate([
        createRoute("GET", "/users"),
        createRoute("GET", "/posts"),
      ]);
      expect(Object.keys(doc.paths)).toHaveLength(2);
      expect(doc.paths["/users"]).toBeDefined();
      expect(doc.paths["/posts"]).toBeDefined();
    });

    it("HTTP 方法转为小写", () => {
      const doc = generate([createRoute("DELETE", "/users/:id")]);
      expect(doc.paths["/users/{id}"].delete).toBeDefined();
    });
  });

  // ── 路径转换（:param → {param}）───────────────────────────

  describe("路径转换", () => {
    it(":id → {id}", () => {
      const doc = generate([createRoute("GET", "/users/:id")]);
      expect(doc.paths["/users/{id}"]).toBeDefined();
    });

    it("多个动态参数", () => {
      const doc = generate([
        createRoute("GET", "/users/:userId/posts/:postId"),
      ]);
      expect(doc.paths["/users/{userId}/posts/{postId}"]).toBeDefined();
    });

    it("通配符 *path → {path}", () => {
      const doc = generate([createRoute("GET", "/files/*path")]);
      expect(doc.paths["/files/{path}"]).toBeDefined();
    });

    it("混合动态参数和通配符", () => {
      const doc = generate([createRoute("GET", "/api/:version/files/*path")]);
      expect(doc.paths["/api/{version}/files/{path}"]).toBeDefined();
    });

    it("无动态参数保持不变", () => {
      const doc = generate([createRoute("GET", "/users/list")]);
      expect(doc.paths["/users/list"]).toBeDefined();
    });
  });

  // ── Operation 基本字段 ────────────────────────────────────

  describe("Operation 基本字段", () => {
    it("默认 summary = 'METHOD /path'", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.summary).toBe("GET /users");
    });

    it("使用 docs.summary 覆盖", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: { summary: "获取用户列表" },
        }),
      ]);
      expect(doc.paths["/users"].get!.summary).toBe("获取用户列表");
    });

    it("自动推断 operationId", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.operationId).toBe("getUsers");
    });

    it("使用 docs.operationId 覆盖", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: { operationId: "listAllUsers" },
        }),
      ]);
      expect(doc.paths["/users"].get!.operationId).toBe("listAllUsers");
    });

    it("拒绝重复的显式 docs.operationId", () => {
      expect(() =>
        generate([
          createRoute(
            "GET",
            "/users",
            { docs: { operationId: "listUsers" } },
            "routes/users/list.ts",
          ),
          createRoute(
            "GET",
            "/accounts",
            { docs: { operationId: "listUsers" } },
            "routes/accounts/list.ts",
          ),
        ]),
      ).toThrowError(
        /Duplicate OpenAPI operationId "listUsers".*GET \/accounts.*explicit docs\.operationId.*GET \/users.*explicit docs\.operationId/s,
      );
    });

    it("拒绝显式 operationId 与自动推断 operationId 冲突", () => {
      expect(() =>
        generate([
          createRoute("GET", "/users", {}, "routes/users.ts"),
          createRoute(
            "POST",
            "/accounts",
            { docs: { operationId: "getUsers" } },
            "routes/accounts.ts",
          ),
        ]),
      ).toThrowError(
        /Duplicate OpenAPI operationId "getUsers".*POST \/accounts.*explicit docs\.operationId.*GET \/users.*inferred from method\/path/s,
      );
    });

    it("拒绝自动推断出的重复 operationId", () => {
      expect(() =>
        generate([
          createRoute("GET", "/users/:id", {}, "routes/users/[id].ts"),
          createRoute("GET", "/users/byId", {}, "routes/users/byId.ts"),
        ]),
      ).toThrowError(
        /Duplicate OpenAPI operationId "getUsersById".*GET \/users\/byId.*inferred from method\/path.*GET \/users\/:id.*inferred from method\/path/s,
      );
    });

    it("允许方法和路径变体生成稳定且唯一的 operationId", () => {
      const doc = generate([
        createRoute("GET", "/users"),
        createRoute("POST", "/users"),
        createRoute("GET", "/users/:id"),
        createRoute("GET", "/accounts", {
          docs: { operationId: "listAccounts" },
        }),
      ]);

      const operationIds = [
        doc.paths["/users"].get!.operationId,
        doc.paths["/users"].post!.operationId,
        doc.paths["/users/{id}"].get!.operationId,
        doc.paths["/accounts"].get!.operationId,
      ];

      expect(operationIds).toEqual([
        "getUsers",
        "createUsers",
        "getUsersById",
        "listAccounts",
      ]);
      expect(new Set(operationIds).size).toBe(operationIds.length);
    });

    it("文档说明 operationId 全局唯一和冲突处理", () => {
      const zhGuide = readRepoFile("website/docs/zh/guide/openapi.md");
      const enGuide = readRepoFile("website/docs/en/guide/openapi.md");
      const zhApi = readRepoFile("website/docs/zh/api/route-definition.md");
      const enApi = readRepoFile("website/docs/en/api/route-definition.md");

      expect(zhGuide).toContain(
        "Vext 在生成阶段会校验显式 `docs.operationId` 和自动推断值",
      );
      expect(zhGuide).toContain("重复的显式值");
      expect(enGuide).toContain(
        "`operationId` must remain unique across the whole OpenAPI document",
      );
      expect(enGuide).toContain("all fail generation");
      expect(zhApi).toContain("冲突时生成报错");
      expect(enApi).toContain("generation fails on conflicts");
    });

    it("默认 deprecated = false", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.deprecated).toBe(false);
    });

    it("docs.deprecated = true", () => {
      const doc = generate([
        createRoute("GET", "/users", { docs: { deprecated: true } }),
      ]);
      expect(doc.paths["/users"].get!.deprecated).toBe(true);
    });

    it("docs.description 映射到 operation.description", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: { description: "返回所有用户的分页列表" },
        }),
      ]);
      expect(doc.paths["/users"].get!.description).toBe(
        "返回所有用户的分页列表",
      );
    });

    it("无 docs.description 时 operation.description 不存在", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.description).toBeUndefined();
    });

    it("从路由 path 推断 tags", () => {
      const doc = generate([
        createRoute("GET", "/users", {}, "routes/users.ts"),
      ]);
      expect(doc.paths["/users"].get!.tags).toEqual(["Users"]);
    });

    it("docs.tags 已废弃并不会覆盖自动推断 tags", () => {
      const doc = generate([
        createRoute(
          "GET",
          "/users",
          { docs: { tags: ["用户管理", "Admin"] } },
          "routes/users.ts",
        ),
      ]);
      expect(doc.paths["/users"].get!.tags).toEqual(["Users"]);
    });
  });

  // ── parameters（路径参数 + 查询参数）──────────────────────

  describe("parameters — 路径参数", () => {
    it("validate.param 中的字段映射为 path 参数（in: 'path', required: true）", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          validate: { param: { id: "objectId!" } },
        }),
      ]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.parameters).toBeDefined();
      expect(op.parameters).toHaveLength(1);
      expect(op.parameters![0]).toMatchObject({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
      });
    });

    it("string:1-! keeps strict type/runtime/OpenAPI path contracts aligned", () => {
      const doc = generate([
        createRoute("GET", "/posts/:slug", {
          validate: { param: { slug: "string:1-!" } },
        }),
      ]);

      const op = doc.paths["/posts/{slug}"].get!;
      expect(op.parameters![0]).toMatchObject({
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      });
      expect(op.responses["400"]).toMatchObject({
        description: "Path parameter validation error",
        content: {
          "application/json": {
            example: { code: 400, message: "Validation failed" },
          },
        },
      });
      expect(op.responses["422"]).toBeUndefined();
    });

    it("多个路径参数", () => {
      const doc = generate([
        createRoute("GET", "/users/:userId/posts/:postId", {
          validate: {
            param: { userId: "objectId!", postId: "objectId!" },
          },
        }),
      ]);

      const op = doc.paths["/users/{userId}/posts/{postId}"].get!;
      expect(op.parameters).toHaveLength(2);
      expect(op.parameters![0].name).toBe("userId");
      expect(op.parameters![1].name).toBe("postId");
      expect(op.parameters![0].in).toBe("path");
      expect(op.parameters![1].in).toBe("path");
    });

    it("路径参数始终 required: true（忽略 DSL ! 标记）", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          validate: { param: { id: "string" } }, // 无 ! 标记
        }),
      ]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.parameters![0].required).toBe(true);
    });

    it("非字符串类型的路径参数降级为 string", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          validate: {
            param: { id: 42 as unknown as string },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.parameters![0].schema.type).toBe("string");
    });

    it("未声明 validate.param 时为动态路径自动补 string path 参数", () => {
      const doc = generate([createRoute("GET", "/users/:id")]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.parameters).toEqual([
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ]);
    });

    it("未声明 validate.param 时为通配符路径自动补 string path 参数", () => {
      const doc = generate([createRoute("GET", "/files/*path")]);

      const op = doc.paths["/files/{path}"].get!;
      expect(op.parameters).toEqual([
        {
          name: "path",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ]);
    });

    it("多个动态路径参数缺少 validate.param 时按路径顺序补全", () => {
      const doc = generate([
        createRoute("GET", "/users/:userId/posts/:postId"),
      ]);

      const op = doc.paths["/users/{userId}/posts/{postId}"].get!;
      expect(op.parameters).toEqual([
        {
          name: "userId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "postId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ]);
    });

    it("validate.param 部分声明时只补缺失的路径参数", () => {
      const doc = generate([
        createRoute("GET", "/users/:userId/posts/:postId", {
          validate: { param: { userId: "objectId!" } },
        }),
      ]);

      const op = doc.paths["/users/{userId}/posts/{postId}"].get!;
      expect(op.parameters).toHaveLength(2);
      expect(op.parameters![0]).toMatchObject({
        name: "userId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
      });
      expect(op.parameters![1]).toEqual({
        name: "postId",
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    });

    it("生成的 path template 都声明对应 required path parameter", () => {
      const doc = generate([
        createRoute("GET", "/users/:id"),
        createRoute("GET", "/files/*path"),
        createRoute("GET", "/orgs/:orgId/users/:userId", {
          validate: { param: { orgId: "string:1-" } },
        }),
      ]);

      expectPathTemplateParametersAreDeclared(doc);
    });

    it("文档说明未声明 validate.param 时的 OpenAPI path parameter 默认策略", () => {
      const zhValidation = readRepoFile("website/docs/zh/guide/validation.md");
      const enValidation = readRepoFile("website/docs/en/guide/validation.md");
      const zhRoute = readRepoFile("website/docs/zh/api/route-definition.md");
      const enRoute = readRepoFile("website/docs/en/api/route-definition.md");

      expect(zhValidation).toContain(
        "OpenAPI 仍会为该路径段生成 `required: true` 的 string path parameter",
      );
      expect(enValidation).toContain(
        "OpenAPI still emits a `required: true` string path parameter",
      );
      expect(zhRoute).toContain("避免生成非法路径模板");
      expect(enRoute).toContain("so the generated path template is valid");
    });
  });

  describe("parameters — 查询参数", () => {
    it("validate.query 中的字段映射为 query 参数", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          validate: {
            query: {
              page: "number:1-",
              limit: "number:1-100",
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].get!;
      expect(op.parameters).toHaveLength(2);

      const page = op.parameters!.find((p) => p.name === "page")!;
      expect(page.in).toBe("query");
      expect(page.required).toBe(false);
      expect(page.schema).toMatchObject({ type: "number", minimum: 1 });

      const limit = op.parameters!.find((p) => p.name === "limit")!;
      expect(limit.in).toBe("query");
      expect(limit.schema).toMatchObject({
        type: "number",
        minimum: 1,
        maximum: 100,
      });
    });

    it("查询参数 ! 标记映射为 required: true", () => {
      const doc = generate([
        createRoute("GET", "/search", {
          validate: { query: { q: "string:1-100!" } },
        }),
      ]);

      const op = doc.paths["/search"].get!;
      expect(op.parameters![0].required).toBe(true);
    });

    it("查询参数无 ! 标记 → required: false", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          validate: { query: { search: "string?" } },
        }),
      ]);

      const op = doc.paths["/users"].get!;
      expect(op.parameters![0].required).toBe(false);
    });

    it("非字符串 query 值被跳过", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          validate: {
            query: {
              page: "number:1-",
              complex: { nested: true } as unknown as string,
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].get!;
      expect(op.parameters).toHaveLength(1);
      expect(op.parameters![0].name).toBe("page");
    });

    it("路径参数和查询参数合并", () => {
      const doc = generate([
        createRoute("GET", "/users/:id/posts", {
          validate: {
            param: { id: "objectId!" },
            query: { page: "number:1-" },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}/posts"].get!;
      expect(op.parameters).toHaveLength(2);

      const pathParam = op.parameters!.find((p) => p.in === "path")!;
      expect(pathParam.name).toBe("id");

      const queryParam = op.parameters!.find((p) => p.in === "query")!;
      expect(queryParam.name).toBe("page");
    });
  });

  describe("parameters — 请求头参数", () => {
    it("validate.header 中的字段映射为 header 参数", () => {
      const doc = generate([
        createRoute("GET", "/admin/check-role-test/default", {
          validate: {
            header: {
              "x-admin-role": "string!",
              "x-trace-id": "string?",
            },
          },
        }),
      ]);

      const op = doc.paths["/admin/check-role-test/default"].get!;
      expect(op.parameters).toHaveLength(2);

      const role = op.parameters!.find((p) => p.name === "x-admin-role")!;
      expect(role).toMatchObject({
        in: "header",
        required: true,
        schema: { type: "string" },
      });

      const traceId = op.parameters!.find((p) => p.name === "x-trace-id")!;
      expect(traceId.in).toBe("header");
      expect(traceId.required).toBe(false);
    });

    it("路径、查询和请求头参数合并", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          validate: {
            param: { id: "objectId!" },
            query: { expand: "string?" },
            header: { "x-tenant-id": "string!" },
            cookie: { sid: "string?" },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.parameters).toHaveLength(4);
      expect(op.parameters!.map((p) => p.in)).toEqual([
        "path",
        "query",
        "header",
        "cookie",
      ]);
    });
  });

  describe("parameters — Cookie 参数", () => {
    it("validate.cookie 中的字段映射为 cookie 参数", () => {
      const doc = generate([
        createRoute("GET", "/session/profile", {
          validate: {
            cookie: {
              sid: "string!",
              theme: "string?",
            },
          },
        }),
      ]);

      const op = doc.paths["/session/profile"].get!;
      expect(op.parameters).toHaveLength(2);

      const sid = op.parameters!.find((p) => p.name === "sid")!;
      expect(sid).toMatchObject({
        in: "cookie",
        required: true,
        schema: { type: "string" },
      });

      const theme = op.parameters!.find((p) => p.name === "theme")!;
      expect(theme.in).toBe("cookie");
      expect(theme.required).toBe(false);
    });
  });

  describe("parameters — 空参数清理", () => {
    it("无 validate 时不包含 parameters 字段", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.parameters).toBeUndefined();
    });

    it("validate 存在但无 params/query/header 时不包含 parameters 字段", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          validate: { body: { name: "string!" } },
        }),
      ]);
      // GET 请求不生成 requestBody，也无 params/query/header → parameters 被清理
      expect(doc.paths["/users"].get!.parameters).toBeUndefined();
    });
  });

  // ── requestBody ───────────────────────────────────────────

  describe("requestBody", () => {
    it("POST 请求 validate.body → requestBody", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          validate: {
            body: {
              name: "string:1-50!",
              email: "email!",
              password: "string:8-128!",
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].post!;
      expect(op.requestBody).toBeDefined();
      expect(op.requestBody!.required).toBe(true);

      const schema = op.requestBody!.content["application/json"].schema;
      expect(schema.type).toBe("object");
      expect(schema.properties!.name.type).toBe("string");
      expect(schema.properties!.name.minLength).toBe(1);
      expect(schema.properties!.name.maxLength).toBe(50);
      expect(schema.properties!.email.format).toBe("email");
      expect(schema.properties!.password.minLength).toBe(8);
      expect(schema.required).toEqual(["name", "email", "password"]);
    });

    it("multipart.files required fields are emitted for runtime-enforced upload fields", () => {
      const doc = generate([
        createRoute("POST", "/upload/avatar", {
          multipart: {
            files: {
              avatar: {
                description: "Avatar image",
                required: true,
              },
              thumbnail: "Optional thumbnail",
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/upload/avatar"].post!.requestBody!.content[
          "multipart/form-data"
        ].schema;

      expect(doc.paths["/upload/avatar"].post!.requestBody!.required).toBe(
        true,
      );
      expect(schema.required).toEqual(["avatar"]);
      expect(schema.properties!.avatar).toMatchObject({
        type: "string",
        format: "binary",
        description: "Avatar image",
      });
      expect(schema.properties!.thumbnail).toMatchObject({
        type: "string",
        format: "binary",
        description: "Optional thumbnail",
      });
    });

    it("validate.body 支持 DslBuilder 字段业务 description", () => {
      const doc = generate([
        createRoute("POST", "/translate", {
          validate: {
            body: {
              content: schemaAdapter
                .compileField("string:1-20000!")
                .description("待翻译文本，长度 1-20000 个字符"),
              targetLanguages: [
                {
                  code: schemaAdapter
                    .compileField("string:1-64!")
                    .description("目标语言代码"),
                },
              ],
              format: schemaAdapter
                .compileField("enum:plain_text,preserve_line_breaks")
                .description("输出格式"),
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/translate"].post!.requestBody!.content["application/json"]
          .schema;
      const props = schema.properties!;

      expect(props.content.description).toBe("待翻译文本，长度 1-20000 个字符");
      expect(props.format.description).toBe("输出格式");
      expect(props.targetLanguages.items!.properties!.code.description).toBe(
        "目标语言代码",
      );
      expect(schema.required).toEqual(["content"]);
      expect(props.content._baseSchema).toBeUndefined();
      expect(props.format._description).toBeUndefined();
    });

    it("PUT 请求 validate.body → requestBody", () => {
      const doc = generate([
        createRoute("PUT", "/users/:id", {
          validate: {
            body: { name: "string:1-50!" },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}"].put!;
      expect(op.requestBody).toBeDefined();
    });

    it("PATCH 请求 validate.body → requestBody", () => {
      const doc = generate([
        createRoute("PATCH", "/users/:id", {
          validate: {
            body: { name: "string:1-50" },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}"].patch!;
      expect(op.requestBody).toBeDefined();
    });

    it("GET 请求不生成 requestBody（即使有 validate.body）", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          validate: { body: { name: "string!" } },
        }),
      ]);

      expect(doc.paths["/users"].get!.requestBody).toBeUndefined();
    });

    it("DELETE 请求不生成 requestBody", () => {
      const doc = generate([
        createRoute("DELETE", "/users/:id", {
          validate: { body: { reason: "string" } },
        }),
      ]);

      expect(doc.paths["/users/{id}"].delete!.requestBody).toBeUndefined();
    });

    it("HEAD 请求不生成 requestBody", () => {
      const doc = generate([
        createRoute("HEAD", "/users", {
          validate: { body: { name: "string!" } },
        }),
      ]);

      expect(doc.paths["/users"].head!.requestBody).toBeUndefined();
    });

    it("无 validate.body 时不生成 requestBody", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          validate: { query: { page: "number:1-" } },
        }),
      ]);

      expect(doc.paths["/users"].post!.requestBody).toBeUndefined();
    });

    it("嵌套对象的 requestBody", () => {
      const doc = generate([
        createRoute("POST", "/orders", {
          validate: {
            body: {
              customer: {
                name: "string:1-50!",
                email: "email!",
              },
              items: [{ sku: "string!", qty: "integer:1-!" }],
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/orders"].post!.requestBody!.content["application/json"]
          .schema;
      expect(schema.properties!.customer.type).toBe("object");
      expect(schema.properties!.items.type).toBe("array");
      expect(schema.properties!.items.items!.properties!.sku.type).toBe(
        "string",
      );
    });
  });

  // ── responses ─────────────────────────────────────────────

  describe("responses", () => {
    it("默认 200 响应（无 docs.responses 时）", () => {
      const doc = generate([createRoute("GET", "/users")]);
      const op = doc.paths["/users"].get!;

      expect(op.responses["200"]).toBeDefined();
      expect(op.responses["200"].description).toBe("OK");
      expect(
        op.responses["200"].content!["application/json"].schema!.$ref,
      ).toBe("#/components/schemas/SuccessResponse");
    });

    it("projects runtime response schemas with docs metadata and family selectors", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          responses: {
            "2XX": {
              schema: {
                id: "integer!",
                profile: { name: "string!" },
              },
            },
            204: { schema: { ignored: "string!" } },
          },
          docs: {
            responses: {
              "2xx": {
                description: "Successful user response",
                example: { id: 1, profile: { name: "Ada" } },
              },
              204: { description: "No content" },
            },
          },
        }),
      ]);

      const responses = doc.paths["/users"].get!.responses;
      const family = responses["2XX"];
      expect(family.description).toBe("Successful user response");
      expect(family.content!["application/json"].schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          data: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "integer" },
              profile: {
                type: "object",
                additionalProperties: false,
              },
            },
          },
        },
      });
      expect(family.content!["application/json"].example).toEqual({
        code: 0,
        data: { id: 1, profile: { name: "Ada" } },
        requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });
      expect(responses["204"]).toEqual({ description: "No content" });
    });

    it("rejects duplicate runtime and docs schema truth during projection", () => {
      expect(() =>
        generate([
          createRoute("GET", "/users", {
            responses: { 200: { schema: { id: "integer!" } } },
            docs: {
              responses: {
                200: { schema: { id: "integer!" } },
              },
            },
          }),
        ]),
      ).toThrow(/both RouteOptions\.responses and docs\.responses/i);
    });

    it("projects runtime schemas without an envelope when response wrapping is disabled", () => {
      const generator = new OpenAPIGenerator({}, { responseWrap: false });
      const doc = generator.generate([
        createRoute("GET", "/users", {
          responses: { 200: { schema: { id: "integer!" } } },
          docs: {
            responses: {
              200: { example: { id: 1 } },
            },
          },
        }),
      ]);

      const content =
        doc.paths["/users"].get!.responses["200"].content!["application/json"];
      expect(content.schema).toMatchObject({
        type: "object",
        properties: { id: { type: "integer" } },
        additionalProperties: false,
      });
      expect(content.example).toEqual({ id: 1 });
    });

    it("声明 docs.responses 时不添加默认 200", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: { description: "用户列表" },
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].get!;
      expect(op.responses["200"].description).toBe("用户列表");
      // 不应有默认的 SuccessResponse 引用
    });

    it("成功响应 schema 自动包装为 { code, data, requestId }", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: {
                description: "用户列表",
                schema: {
                  id: "objectId!",
                  name: "string!",
                },
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users"].get!.responses["200"].content!["application/json"]
          .schema!;

      // 包装结构
      expect(schema.type).toBe("object");
      expect(schema.properties!.code).toEqual({
        type: "integer",
        example: 0,
      });
      expect(schema.properties!.data.type).toBe("object");
      expect(schema.properties!.data.properties!.id.pattern).toBe(
        "^[0-9a-fA-F]{24}$",
      );
      expect(schema.properties!.requestId.type).toBe("string");
      expect(schema.required).toEqual(["code", "data", "requestId"]);
    });

    it("201 响应也自动包装", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          docs: {
            responses: {
              201: {
                description: "创建成功",
                schema: { id: "objectId!", name: "string!" },
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users"].post!.responses["201"].content!["application/json"]
          .schema!;
      expect(schema.properties!.code).toBeDefined();
      expect(schema.properties!.data).toBeDefined();
      expect(schema.properties!.requestId).toBeDefined();
    });

    it("204 No Content → 空 schema（无响应体）", () => {
      const doc = generate([
        createRoute("DELETE", "/users/:id", {
          docs: {
            responses: {
              204: {
                description: "删除成功",
                schema: {},
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users/{id}"].delete!.responses["204"].content![
          "application/json"
        ].schema!;
      expect(schema).toEqual({});
    });

    it("4xx 错误响应不包装（直接使用原始 schema）", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          docs: {
            responses: {
              404: {
                description: "用户不存在",
                schema: {
                  code: "integer",
                  message: "string",
                  requestId: "string",
                },
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users/{id}"].get!.responses["404"].content![
          "application/json"
        ].schema!;

      // 不包装 — 直接是原始 schema
      expect(schema.type).toBe("object");
      expect(schema.properties!.code.type).toBe("integer");
      expect(schema.properties!.message.type).toBe("string");
      // 不应有 data 字段
      expect(schema.properties!.data).toBeUndefined();
    });

    it("5xx 错误响应也不包装", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              500: {
                description: "服务器错误",
                schema: {
                  code: "integer",
                  message: "string",
                  requestId: "string",
                },
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users"].get!.responses["500"].content!["application/json"]
          .schema!;
      // 不包装
      expect(schema.properties!.data).toBeUndefined();
    });

    it("无 schema 的响应（纯描述）", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          docs: {
            responses: {
              401: { description: "未认证" },
              403: { description: "无权限" },
            },
          },
        }),
      ]);

      const op = doc.paths["/users/{id}"].get!;
      expect(op.responses["401"].description).toBe("未认证");
      expect(op.responses["401"].content).toBeUndefined();
      expect(op.responses["403"].description).toBe("无权限");
      expect(op.responses["403"].content).toBeUndefined();
    });

    it("响应 schema 为字符串引用 → $ref", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: {
                description: "用户列表",
                schema: "#/components/schemas/UserList",
              },
            },
          },
        }),
      ]);

      const schema =
        doc.paths["/users"].get!.responses["200"].content!["application/json"]
          .schema!;

      // 200 是成功响应，但 $ref 也应该被包装
      expect(schema.properties!.data.$ref).toBe(
        "#/components/schemas/UserList",
      );
    });

    it("多个状态码的响应", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          docs: {
            responses: {
              201: {
                description: "创建成功",
                schema: { id: "objectId!", name: "string!" },
              },
              409: {
                description: "邮箱已存在",
                schema: {
                  code: "integer",
                  message: "string",
                  requestId: "string",
                },
              },
              422: {
                description: "校验失败",
                schema: {
                  code: "integer",
                  message: "string",
                  errors: "array",
                  requestId: "string",
                },
              },
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].post!;
      // 201/409/422 是用户声明的，500 是框架默认添加的
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(["201", "409", "422"]),
      );
    });

    it("validate 路由自动追加 422 校验失败响应", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          validate: { body: { name: "string!" } },
        }),
      ]);

      const op = doc.paths["/users"].post!;
      expect(op.responses["422"]).toMatchObject({
        description: "Validation error",
        content: {
          "application/json": {
            example: {
              code: 422,
              message: "Validation failed",
            },
          },
        },
      });
      expect(op.responses["400"]).toBeUndefined();
    });

    it("响应示例自动包装（2xx）", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: {
                description: "用户列表",
                schema: { id: "objectId!", name: "string!" },
                example: { id: "abc123", name: "Test" },
              },
            },
          },
        }),
      ]);

      const example =
        doc.paths["/users"].get!.responses["200"].content!["application/json"]
          .example;

      expect(example).toEqual({
        code: 0,
        data: { id: "abc123", name: "Test" },
        requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });
    });

    it("错误响应示例不包装", () => {
      const doc = generate([
        createRoute("GET", "/users/:id", {
          docs: {
            responses: {
              404: {
                description: "未找到",
                schema: {
                  code: "integer",
                  message: "string",
                  requestId: "string",
                },
                example: {
                  code: 404,
                  message: "User not found",
                  requestId: "xxx",
                },
              },
            },
          },
        }),
      ]);

      const example =
        doc.paths["/users/{id}"].get!.responses["404"].content![
          "application/json"
        ].example;

      // 不包装
      expect(example).toEqual({
        code: 404,
        message: "User not found",
        requestId: "xxx",
      });
    });

    it("多个响应示例 (examples)", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: {
                description: "用户列表",
                schema: { id: "objectId!", name: "string!" },
                examples: {
                  singleUser: {
                    summary: "单个用户",
                    value: { id: "abc", name: "Alice" },
                  },
                  multipleUsers: {
                    summary: "多个用户",
                    description: "包含多个用户的列表",
                    value: [
                      { id: "abc", name: "Alice" },
                      { id: "def", name: "Bob" },
                    ],
                  },
                },
              },
            },
          },
        }),
      ]);

      const examples =
        doc.paths["/users"].get!.responses["200"].content!["application/json"]
          .examples!;

      expect(examples.singleUser).toBeDefined();
      expect(examples.singleUser.summary).toBe("单个用户");
      // 200 响应的示例值被包装
      expect(examples.singleUser.value).toEqual({
        code: 0,
        data: { id: "abc", name: "Alice" },
        requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      });

      expect(examples.multipleUsers.description).toBe("包含多个用户的列表");
    });

    it("响应头 (headers)", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            responses: {
              200: {
                description: "用户列表",
                headers: {
                  "X-Total-Count": {
                    description: "总数",
                    schema: { type: "integer" },
                  },
                },
              },
            },
          },
        }),
      ]);

      const response = doc.paths["/users"].get!.responses["200"];
      expect(response.headers).toBeDefined();
      expect(response.headers!["X-Total-Count"].description).toBe("总数");
    });

    it("自定义 contentType", () => {
      const doc = generate([
        createRoute("GET", "/report", {
          docs: {
            responses: {
              200: {
                description: "报告",
                schema: { data: "string" },
                contentType: "text/csv",
              },
            },
          },
        }),
      ]);

      const response = doc.paths["/report"].get!.responses["200"];
      expect(response.content!["text/csv"]).toBeDefined();
      expect(response.content!["application/json"]).toBeUndefined();
    });
  });

  // ── security 推断 ─────────────────────────────────────────

  describe("security 推断", () => {
    it("middlewares 中含 'auth' → security: [{ bearerAuth: [] }]", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["auth"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ bearerAuth: [] }]);
    });

    it("RouteOptions.auth = true → security: [{ bearerAuth: [] }]", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          auth: true,
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ bearerAuth: [] }]);
    });

    it("RouteOptions.auth.required = false 且无授权规则 → 显式 public security", () => {
      const doc = generate([
        createRoute("GET", "/optional", {
          auth: { required: false },
          middlewares: ["auth"],
        }),
      ]);

      expect(doc.paths["/optional"].get!.security).toEqual([]);
    });

    it("RouteOptions.auth.required = false 但存在授权规则 → security: [{ bearerAuth: [] }]", () => {
      const doc = generate([
        createRoute("GET", "/by-role", {
          auth: { required: false, roles: ["admin"] },
        }),
        createRoute("GET", "/by-scope", {
          auth: { required: false, scopes: ["posts:write"] },
        }),
        createRoute("GET", "/by-permission", {
          auth: { required: false, permissions: ["posts:update"] },
        }),
        createRoute("GET", "/by-check", {
          auth: { required: false, check: () => true },
        }),
      ]);

      expect(doc.paths["/by-role"].get!.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.paths["/by-scope"].get!.security).toEqual([
        { bearerAuth: [] },
      ]);
      expect(doc.paths["/by-permission"].get!.security).toEqual([
        { bearerAuth: [] },
      ]);
      expect(doc.paths["/by-check"].get!.security).toEqual([
        { bearerAuth: [] },
      ]);
    });

    it("RouteOptions.auth.security supports string, string[] and object array", () => {
      const doc = generate([
        createRoute("GET", "/bearer", {
          auth: { security: "bearerAuth" },
        }),
        createRoute("GET", "/either", {
          auth: { security: ["bearerAuth", "apiKeyAuth"] },
        }),
        createRoute("GET", "/oauth", {
          auth: { security: [{ oauth2: ["posts:write"] }] },
        }),
      ]);

      expect(doc.paths["/bearer"].get!.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.paths["/either"].get!.security).toEqual([
        { bearerAuth: [] },
        { apiKeyAuth: [] },
      ]);
      expect(doc.paths["/oauth"].get!.security).toEqual([
        { oauth2: ["posts:write"] },
      ]);
    });

    it("RouteOptions.auth 优先于 legacy middlewares 推断", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          auth: { security: "sessionAuth" },
          middlewares: ["auth"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ sessionAuth: [] }]);
    });

    it("docs.security 覆盖 required=false 的 auth 推断", () => {
      const doc = generate([
        createRoute("GET", "/optional-api-key", {
          auth: { required: false },
          docs: { security: [{ apiKeyAuth: [] }] },
        }),
        createRoute("GET", "/protected-public-docs", {
          auth: { roles: ["admin"] },
          docs: { security: [] },
        }),
      ]);

      expect(doc.paths["/optional-api-key"].get!.security).toEqual([
        { apiKeyAuth: [] },
      ]);
      expect(doc.paths["/protected-public-docs"].get!.security).toEqual([]);
    });

    it("RouteOptions.auth = false 阻止 legacy middlewares 推断", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          auth: false,
          middlewares: ["auth"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toBeUndefined();
    });

    it("middlewares 中含 'api-key' → security: [{ apiKeyAuth: [] }]", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["api-key"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ apiKeyAuth: [] }]);
    });

    it("middlewares 中同时含 auth 和 api-key", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["auth", "api-key"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([
        { bearerAuth: [] },
        { apiKeyAuth: [] },
      ]);
    });

    it("middlewares 中含非安全中间件 → 不推断 security", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["cache", "rate-limit"],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toBeUndefined();
    });

    it("无 middlewares → 无 security", () => {
      const doc = generate([createRoute("GET", "/users")]);
      expect(doc.paths["/users"].get!.security).toBeUndefined();
    });

    it("空 middlewares 数组 → 无 security", () => {
      const doc = generate([createRoute("GET", "/users", { middlewares: [] })]);
      expect(doc.paths["/users"].get!.security).toBeUndefined();
    });

    it("docs.security 覆盖自动推断", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["auth"],
          docs: {
            security: [{ customAuth: [] }],
          },
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ customAuth: [] }]);
    });

    it("docs.security = [] → 显式无需认证", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: ["auth"],
          docs: { security: [] },
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([]);
    });

    it("文档说明 auth.required=false 的 OpenAPI security 契约", () => {
      const zhGuide = readRepoFile("website/docs/zh/guide/openapi.md");
      const enGuide = readRepoFile("website/docs/en/guide/openapi.md");
      const zhApi = readRepoFile("website/docs/zh/api/route-definition.md");
      const enApi = readRepoFile("website/docs/en/api/route-definition.md");

      expect(zhGuide).toContain(
        "`auth: { required: false }` 且没有 roles、scopes、permissions 或 `check` 时",
      );
      expect(enGuide).toContain(
        "`auth: { required: false }` without roles, scopes, permissions, or `check`",
      );
      expect(zhApi).toContain("OpenAPI 会把该路由标记为公开");
      expect(enApi).toContain("OpenAPI marks the route as public");
    });

    it("对象格式 middlewares（{ name, options }）推断 security", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          middlewares: [
            { name: "auth", options: { role: "admin" } },
          ] as unknown as string[],
        }),
      ]);

      expect(doc.paths["/users"].get!.security).toEqual([{ bearerAuth: [] }]);
    });

    it("自定义 guardSecurityMap", () => {
      const doc = generate(
        [
          createRoute("GET", "/users", {
            middlewares: ["jwt-auth"],
          }),
        ],
        {
          guardSecurityMap: {
            "jwt-auth": "jwtBearer",
          },
        },
      );

      expect(doc.paths["/users"].get!.security).toEqual([{ jwtBearer: [] }]);
    });
  });

  // ── 自定义扩展字段 (x-*) ──────────────────────────────────

  describe("自定义扩展字段 (x-*)", () => {
    it("docs.extensions 映射为 x-* 字段", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            extensions: {
              "x-custom": "value",
              internal: true,
            },
          },
        }),
      ]);

      const op = doc.paths["/users"].get! as Record<string, unknown>;
      expect(op["x-custom"]).toBe("value");
      expect(op["x-internal"]).toBe(true); // 自动添加 x- 前缀
    });

    it("已有 x- 前缀不重复添加", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: {
            extensions: { "x-rate-limit-special": 100 },
          },
        }),
      ]);

      const op = doc.paths["/users"].get! as Record<string, unknown>;
      expect(op["x-rate-limit-special"]).toBe(100);
      expect(op["x-x-rate-limit-special"]).toBeUndefined();
    });

    it("无 docs.extensions 时只保留文档分类扩展字段", () => {
      const doc = generate([createRoute("GET", "/users")]);
      const op = doc.paths["/users"].get! as Record<string, unknown>;
      const xKeys = Object.keys(op).filter((k) => k.startsWith("x-"));
      expect(xKeys).toEqual(["x-vext-docs-kind"]);
      expect(op["x-vext-docs-kind"]).toBe("backend-api");
    });

    it("输出 route metadata 中的文档分类扩展字段", () => {
      const doc = generate([
        {
          ...createRoute("GET", "/frontend/render"),
          docsKind: "frontend-route",
        },
      ]);

      const op = doc.paths["/frontend/render"].get! as Record<string, unknown>;
      expect(op["x-vext-docs-kind"]).toBe("frontend-route");
    });

    it("docs.access 映射为 Vext Docs 权限扩展字段", () => {
      const doc = generate([
        createRoute("GET", "/admin", {
          docs: { access: "admin" },
        }),
        createRoute("GET", "/internal", {
          docs: {
            access: {
              visible: false,
              tryItOut: false,
              group: "internal",
            },
          },
        }),
      ]);

      expect(
        (doc.paths["/admin"].get! as Record<string, unknown>)[
          "x-vext-docs-access"
        ],
      ).toBe("admin");
      expect(
        (doc.paths["/internal"].get! as Record<string, unknown>)[
          "x-vext-docs-access"
        ],
      ).toEqual({
        visible: false,
        tryItOut: false,
        group: "internal",
      });
    });

    it("docs.access 覆盖同名自定义扩展以保持权限 metadata 稳定", () => {
      const doc = generate([
        createRoute("GET", "/admin", {
          docs: {
            access: "admin",
            extensions: { "x-vext-docs-access": "custom" },
          },
        }),
      ]);

      expect(
        (doc.paths["/admin"].get! as Record<string, unknown>)[
          "x-vext-docs-access"
        ],
      ).toBe("admin");
    });

    it("文档说明 route docs.access 会进入 docs access descriptor", () => {
      const zhGuide = readRepoFile("website/docs/zh/guide/openapi.md");
      const enGuide = readRepoFile("website/docs/en/guide/openapi.md");
      const zhApi = readRepoFile("website/docs/zh/api/route-definition.md");
      const enApi = readRepoFile("website/docs/en/api/route-definition.md");

      expect(zhGuide).toContain(
        "`options.docs.access` 会写入 `x-vext-docs-access`",
      );
      expect(enGuide).toContain(
        "`options.docs.access` is emitted as `x-vext-docs-access`",
      );
      expect(zhApi).toContain("`access`");
      expect(zhApi).toContain("传给 `openapi.docs.access.resolver`");
      expect(enApi).toContain("passed to `openapi.docs.access.resolver`");
      expect(zhGuide).toContain(
        "区分运行时授权、OpenAPI security 与 Docs access",
      );
      expect(enGuide).toContain(
        "Keep runtime authorization, OpenAPI security, and Docs access separate",
      );
      expect(zhApi).toContain("不会保护 route；API 访问控制仍应使用 `auth`");
      expect(enApi).toContain(
        "It does not protect the route; use `auth` for API access control",
      );
    });
  });

  // ── x-rate-limit 推断 ─────────────────────────────────────

  describe("x-rate-limit 推断", () => {
    it("rate-limit 对象中间件 → x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          middlewares: [
            {
              name: "rate-limit",
              options: { max: 10, window: 60000 },
            },
          ] as unknown as string[],
        }),
      ]);

      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toEqual({
        max: 10,
        window: 60000,
      });
    });

    it("rate-limit 字符串中间件（无 options）→ 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          middlewares: ["rate-limit"],
        }),
      ]);

      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toBeUndefined();
    });

    it("rate-limit 对象中间件缺少 options → 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          middlewares: [{ name: "rate-limit" }] as unknown as string[],
        }),
      ]);

      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toBeUndefined();
    });

    it("rate-limit options 缺少 max 或 window → 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/max-only", {
          middlewares: [
            { name: "rate-limit", options: { max: 10 } },
          ] as unknown as string[],
        }),
        createRoute("POST", "/window-only", {
          middlewares: [
            { name: "rate-limit", options: { window: 60000 } },
          ] as unknown as string[],
        }),
      ]);

      expect(
        (doc.paths["/max-only"].post! as Record<string, unknown>)[
          "x-rate-limit"
        ],
      ).toBeUndefined();
      expect(
        (doc.paths["/window-only"].post! as Record<string, unknown>)[
          "x-rate-limit"
        ],
      ).toBeUndefined();
    });

    it("rate-limit options 非正数或非数字 → 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/string-values", {
          middlewares: [
            { name: "rate-limit", options: { max: "10", window: 60000 } },
          ] as unknown as string[],
        }),
        createRoute("POST", "/zero-values", {
          middlewares: [
            { name: "rate-limit", options: { max: 0, window: 60000 } },
          ] as unknown as string[],
        }),
      ]);

      expect(
        (doc.paths["/string-values"].post! as Record<string, unknown>)[
          "x-rate-limit"
        ],
      ).toBeUndefined();
      expect(
        (doc.paths["/zero-values"].post! as Record<string, unknown>)[
          "x-rate-limit"
        ],
      ).toBeUndefined();
    });

    it("名称相似但非官方 rate-limit 中间件 → 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          middlewares: [
            { name: "rate-limit-api", options: { max: 10, window: 60000 } },
          ] as unknown as string[],
        }),
      ]);

      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toBeUndefined();
    });

    it("文档说明自动 x-rate-limit 只来自完整 rate-limit options", () => {
      const zhGuide = readRepoFile("website/docs/zh/guide/openapi.md");
      const enGuide = readRepoFile("website/docs/en/guide/openapi.md");

      expect(zhGuide).toContain(
        "`x-rate-limit` 只有在 `rate-limit` 对象中间件同时提供正数 `max` 和 `window` 时才会自动生成",
      );
      expect(enGuide).toContain(
        "`x-rate-limit` is generated automatically only when the `rate-limit` object middleware provides positive numeric `max` and `window` options",
      );
    });

    it("无 rate-limit 中间件 → 不添加 x-rate-limit", () => {
      const doc = generate([
        createRoute("POST", "/users", {
          middlewares: ["auth"],
        }),
      ]);

      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toBeUndefined();
    });

    it("无 middlewares → 不添加 x-rate-limit", () => {
      const doc = generate([createRoute("POST", "/users")]);
      const op = doc.paths["/users"].post! as Record<string, unknown>;
      expect(op["x-rate-limit"]).toBeUndefined();
    });
  });

  // ── generateJSON ──────────────────────────────────────────

  describe("generateJSON", () => {
    it("返回格式化的 JSON 字符串", () => {
      const generator = createGenerator();
      const json = generator.generateJSON([]);
      expect(typeof json).toBe("string");

      const parsed = JSON.parse(json);
      expect(parsed.openapi).toBe("3.0.3");
    });

    it("JSON 字符串可反序列化为等价的文档对象", () => {
      const routes = [
        createRoute("GET", "/users", {
          validate: { query: { page: "number:1-" } },
          docs: { summary: "获取用户列表" },
        }),
      ];

      const generator = createGenerator();
      const doc = generator.generate(routes);
      const json = generator.generateJSON(routes);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(doc);
    });

    it("生成的 JSON 缩进为 2 空格", () => {
      const generator = createGenerator();
      const json = generator.generateJSON([]);

      // 检查缩进
      const lines = json.split("\n");
      // 第二行应以 2 空格开头
      expect(lines[1]).toMatch(/^\s{2}/);
      // 不应以 4 空格开头（排除 tab 或 4 空格缩进）
      expect(lines[1]).not.toMatch(/^\s{4}/);
    });
  });

  // ── 完整场景 ──────────────────────────────────────────────

  describe("完整场景", () => {
    it("用户 CRUD API 完整文档", () => {
      const routes: RouteMetadata[] = [
        // GET /users — 用户列表
        createRoute(
          "GET",
          "/users",
          {
            validate: {
              query: {
                page: "number:1-",
                limit: "number:1-100",
                search: "string:1-100?",
                role: "enum:admin,user,guest?",
              },
            },
            middlewares: ["auth"],
            docs: {
              summary: "获取用户列表",
              description: "返回分页的用户列表",
              tags: ["用户管理"],
              responses: {
                200: {
                  description: "成功",
                  schema: {
                    list: [
                      {
                        id: "objectId!",
                        name: "string!",
                        email: "email!",
                        role: "enum:admin,user",
                      },
                    ],
                    total: "integer",
                    page: "integer",
                    limit: "integer",
                  },
                },
                401: { description: "未认证" },
                403: { description: "无权限" },
              },
            },
          },
          "routes/users.ts",
        ),

        // POST /users — 创建用户
        createRoute(
          "POST",
          "/users",
          {
            validate: {
              body: {
                name: "string:1-50!",
                email: "email!",
                password: "string:8-128!",
                role: "enum:admin,user?",
              },
            },
            middlewares: [
              "auth",
              {
                name: "rate-limit",
                options: { max: 10, window: 60000 },
              },
            ] as unknown as string[],
            docs: {
              summary: "创建用户",
              tags: ["用户管理"],
              responses: {
                201: {
                  description: "创建成功",
                  schema: {
                    id: "objectId!",
                    name: "string!",
                    email: "email!",
                    role: "enum:admin,user",
                    createdAt: "date",
                  },
                },
                409: {
                  description: "邮箱已存在",
                  schema: {
                    code: "integer",
                    message: "string",
                    requestId: "string",
                  },
                },
              },
            },
          },
          "routes/users.ts",
        ),

        // DELETE /users/:id — 删除用户
        createRoute(
          "DELETE",
          "/users/:id",
          {
            validate: { param: { id: "objectId!" } },
            middlewares: ["auth"],
            docs: {
              summary: "删除用户",
              tags: ["用户管理"],
              responses: {
                204: { description: "删除成功" },
                404: { description: "用户不存在" },
              },
            },
          },
          "routes/users.ts",
        ),
      ];

      const doc = generate(routes, {
        title: "User Service API",
        version: "2.0.0",
        servers: [{ url: "http://localhost:3000", description: "Development" }],
      });

      // ── 文档级别 ──────────────────────────────────────────
      expect(doc.openapi).toBe("3.0.3");
      expect(doc.info.title).toBe("User Service API");
      expect(doc.info.version).toBe("2.0.0");

      // ── paths 存在 ────────────────────────────────────────
      expect(doc.paths["/users"]).toBeDefined();
      expect(doc.paths["/users/{id}"]).toBeDefined();

      // ── GET /users ────────────────────────────────────────
      const getUsers = doc.paths["/users"].get!;
      expect(getUsers.summary).toBe("获取用户列表");
      expect(getUsers.operationId).toBe("getUsers");
      expect(getUsers.tags).toEqual(["Users"]);
      expect(getUsers.parameters).toHaveLength(4);
      expect(getUsers.security).toEqual([{ bearerAuth: [] }]);
      expect(getUsers.responses["200"]).toBeDefined();
      expect(getUsers.responses["401"]).toBeDefined();
      expect(getUsers.responses["403"]).toBeDefined();

      // ── POST /users ───────────────────────────────────────
      const postUsers = doc.paths["/users"].post!;
      expect(postUsers.summary).toBe("创建用户");
      expect(postUsers.requestBody).toBeDefined();
      expect(postUsers.requestBody!.content["application/json"]).toBeDefined();
      expect(postUsers.security).toEqual([{ bearerAuth: [] }]);
      expect((postUsers as Record<string, unknown>)["x-rate-limit"]).toEqual({
        max: 10,
        window: 60000,
      });

      // ── DELETE /users/{id} ────────────────────────────────
      const deleteUser = doc.paths["/users/{id}"].delete!;
      expect(deleteUser.summary).toBe("删除用户");
      expect(deleteUser.parameters).toHaveLength(1);
      expect(deleteUser.parameters![0].name).toBe("id");
      expect(deleteUser.parameters![0].in).toBe("path");
      expect(deleteUser.security).toEqual([{ bearerAuth: [] }]);

      // ── components ────────────────────────────────────────
      expect(doc.components!.schemas!.ErrorResponse).toBeDefined();
      expect(doc.components!.schemas!.SuccessResponse).toBeDefined();
      expect(doc.components!.securitySchemes!.bearerAuth).toBeDefined();
    });

    it("隐藏路由不出现在文档中", () => {
      // 使用 collector + generator 端到端
      const collector = new RouteMetadataCollector();

      collector.addRoute(
        "GET",
        "/users",
        { docs: { summary: "用户列表" } },
        "routes/users.ts",
      );
      collector.addRoute(
        "GET",
        "/health",
        { docs: { hidden: true } },
        "routes/health.ts",
      );
      collector.addRoute(
        "GET",
        "/metrics",
        { docs: { hidden: true } },
        "routes/metrics.ts",
      );

      const doc = generate(collector.getRoutes());

      expect(Object.keys(doc.paths)).toEqual(["/users"]);
    });

    it("dev 模式热重载模拟（clear → 重新收集 → 重新生成）", () => {
      const collector = new RouteMetadataCollector();
      const generator = createGenerator();

      // 第一次收集
      collector.addRoute(
        "GET",
        "/users",
        { docs: { summary: "V1" } },
        "routes/users.ts",
      );
      const doc1 = generator.generate(collector.getRoutes());
      expect(doc1.paths["/users"].get!.summary).toBe("V1");

      // 热重载：clear → 重新收集
      collector.clear();
      collector.addRoute(
        "GET",
        "/users",
        { docs: { summary: "V2 — 更新后" } },
        "routes/users.ts",
      );
      collector.addRoute(
        "POST",
        "/users",
        { docs: { summary: "创建用户" } },
        "routes/users.ts",
      );

      const doc2 = generator.generate(collector.getRoutes());
      expect(doc2.paths["/users"].get!.summary).toBe("V2 — 更新后");
      expect(doc2.paths["/users"].post!.summary).toBe("创建用户");
    });

    it("无 validate 和 docs 的极简路由", () => {
      const doc = generate([
        createRoute("GET", "/health", {}, "routes/health.ts"),
      ]);

      const op = doc.paths["/health"].get!;
      expect(op.summary).toBe("GET /health");
      expect(op.operationId).toBe("getHealth");
      expect(op.tags).toEqual(["General"]);
      expect(op.deprecated).toBe(false);
      expect(op.parameters).toBeUndefined();
      expect(op.requestBody).toBeUndefined();
      expect(op.responses["200"]).toBeDefined();
      expect(op.security).toBeUndefined();
    });

    it("同一路径、不同方法生成不同的 operation", () => {
      const doc = generate([
        createRoute("GET", "/users", {
          docs: { summary: "获取列表" },
        }),
        createRoute("POST", "/users", {
          validate: { body: { name: "string!" } },
          docs: { summary: "创建用户" },
        }),
        createRoute("DELETE", "/users/:id", {
          validate: { param: { id: "objectId!" } },
          docs: { summary: "删除用户" },
        }),
      ]);

      expect(doc.paths["/users"].get!.summary).toBe("获取列表");
      expect(doc.paths["/users"].post!.summary).toBe("创建用户");
      expect(doc.paths["/users/{id}"].delete!.summary).toBe("删除用户");

      // operationId 各不相同
      const ids = [
        doc.paths["/users"].get!.operationId,
        doc.paths["/users"].post!.operationId,
        doc.paths["/users/{id}"].delete!.operationId,
      ];
      expect(new Set(ids).size).toBe(3);
    });

    it("大量路由不报错", () => {
      const routes: RouteMetadata[] = [];
      for (let i = 0; i < 100; i++) {
        routes.push(
          createRoute("GET", `/resource${i}`, {}, `routes/resource${i}.ts`),
        );
      }

      const doc = generate(routes);
      expect(Object.keys(doc.paths)).toHaveLength(100);
    });
  });

  // ── 多次生成一致性 ────────────────────────────────────────

  describe("多次生成一致性", () => {
    it("相同输入 → 相同输出", () => {
      const routes = [
        createRoute("GET", "/users", {
          validate: { query: { page: "number:1-" } },
          middlewares: ["auth"],
          docs: { summary: "获取用户" },
        }),
      ];

      const generator = createGenerator();
      const doc1 = generator.generate(routes);
      const doc2 = generator.generate(routes);

      expect(doc1).toEqual(doc2);
    });

    it("不同 generator 实例、相同配置 → 相同输出", () => {
      const config: OpenAPIConfig = {
        title: "Test",
        version: "1.0.0",
      };

      const routes = [createRoute("GET", "/users")];

      const doc1 = createGenerator(config).generate(routes);
      const doc2 = createGenerator(config).generate(routes);

      expect(doc1).toEqual(doc2);
    });
  });

  // ── Collector + Generator 集成 ────────────────────────────

  describe("Collector + Generator 集成", () => {
    it("从 collector 收集到 generator 生成的完整流程", () => {
      const collector = new RouteMetadataCollector();

      collector.addRoute(
        "GET",
        "/users",
        {
          validate: { query: { page: "number:1-" } },
          middlewares: ["auth"],
          docs: {
            summary: "获取用户列表",
            tags: ["Users"],
          },
        },
        "routes/users.ts",
      );

      collector.addRoute(
        "POST",
        "/users",
        {
          validate: {
            body: { name: "string:1-50!", email: "email!" },
          },
          middlewares: ["auth"],
          docs: { summary: "创建用户", tags: ["Users"] },
        },
        "routes/users.ts",
      );

      collector.addRoute(
        "GET",
        "/health",
        { docs: { hidden: true } },
        "routes/health.ts",
      );

      const generator = createGenerator({
        title: "My API",
        version: "1.0.0",
      });

      const doc = generator.generate(collector.getRoutes());

      // 基本信息
      expect(doc.info.title).toBe("My API");

      // 路由（health 被隐藏）
      expect(Object.keys(doc.paths)).toEqual(["/users"]);
      expect(doc.paths["/users"].get).toBeDefined();
      expect(doc.paths["/users"].post).toBeDefined();

      // GET /users 有查询参数
      expect(doc.paths["/users"].get!.parameters).toHaveLength(1);
      expect(doc.paths["/users"].get!.security).toEqual([{ bearerAuth: [] }]);

      // POST /users 有 requestBody
      expect(doc.paths["/users"].post!.requestBody).toBeDefined();
      expect(doc.paths["/users"].post!.security).toEqual([{ bearerAuth: [] }]);
    });

    it("collector.getCount 与生成的 paths 条目一致", () => {
      const collector = new RouteMetadataCollector();

      collector.addRoute("GET", "/a", {}, "routes/a.ts");
      collector.addRoute("GET", "/b", {}, "routes/b.ts");
      collector.addRoute("POST", "/a", {}, "routes/a.ts");

      expect(collector.getCount()).toBe(3);

      const doc = generate(collector.getRoutes());

      // 3 个路由，但 /a 有 GET + POST，所以只有 2 个 path 条目
      expect(Object.keys(doc.paths)).toHaveLength(2);

      // 总 operation 数 = 3
      let operationCount = 0;
      for (const methods of Object.values(doc.paths)) {
        operationCount += Object.keys(methods).length;
      }
      expect(operationCount).toBe(3);
    });
  });

  describe("x-tagGroups 标签分组", () => {
    describe("默认行为", () => {
      it("未配置 tagGroups 时不再自动推断 x-tagGroups", () => {
        const doc = generate([
          createRoute(
            "GET",
            "/api/v1/users",
            { docs: { tags: ["users"] } },
            "routes/api/v1/users.ts",
          ),
          createRoute(
            "GET",
            "/admin/dashboard",
            { docs: { tags: ["admin-dashboard"] } },
            "routes/admin/dashboard.ts",
          ),
        ]);

        expect(doc.tags?.map((tag) => tag.name)).toEqual(["API v1", "Admin"]);
        expect(doc["x-tagGroups"]).toBeUndefined();
      });

      it("自定义 config.tags 不会触发默认 x-tagGroups", () => {
        const generator = createGenerator({
          tags: [
            { name: "users", description: "User management" },
            { name: "admin", description: "Administration" },
          ],
        });

        const doc = generator.generate([
          createRoute(
            "GET",
            "/api/users",
            { docs: { tags: ["users"] } },
            "routes/api/users.ts",
          ),
          createRoute(
            "GET",
            "/admin/panel",
            { docs: { tags: ["admin"] } },
            "routes/admin/panel.ts",
          ),
        ]);

        expect(doc.tags).toEqual([
          { name: "users", description: "User management" },
          { name: "admin", description: "Administration" },
        ]);
        expect(doc["x-tagGroups"]).toBeUndefined();
      });

      it("generateJSON 默认不包含 x-tagGroups", () => {
        const generator = createGenerator();
        const routes = [
          createRoute(
            "GET",
            "/api/users",
            { docs: { tags: ["users"] } },
            "routes/api/users.ts",
          ),
          createRoute(
            "GET",
            "/admin/panel",
            { docs: { tags: ["admin"] } },
            "routes/admin/panel.ts",
          ),
        ];

        const parsed = JSON.parse(generator.generateJSON(routes));

        expect(parsed.tags.map((tag: { name: string }) => tag.name)).toEqual([
          "API",
          "Admin",
        ]);
        expect(parsed["x-tagGroups"]).toBeUndefined();
      });
    });

    describe("用户配置输出", () => {
      it("config.tagGroups 显式输出 x-tagGroups", () => {
        const customGroups = [
          { name: "User Management", tags: ["users", "user-profile"] },
          { name: "Administration", tags: ["admin-dashboard", "admin-users"] },
        ];

        const generator = createGenerator({ tagGroups: customGroups });
        const doc = generator.generate([
          createRoute(
            "GET",
            "/api/users",
            { docs: { tags: ["users"] } },
            "routes/api/users.ts",
          ),
          createRoute(
            "GET",
            "/admin/dashboard",
            { docs: { tags: ["admin-dashboard"] } },
            "routes/admin/dashboard.ts",
          ),
        ]);

        expect(doc["x-tagGroups"]).toBeDefined();
        expect(doc["x-tagGroups"]).toEqual(customGroups);
      });

      it("config API 文档公开 tagGroups vendor extension 契约", () => {
        const zhConfig = readRepoFile("website/docs/zh/api/config.md");
        const enConfig = readRepoFile("website/docs/en/api/config.md");

        expect(zhConfig).toContain("| `tagGroups`");
        expect(zhConfig).toContain(
          "显式输出 OpenAPI `x-tagGroups` vendor extension",
        );
        expect(enConfig).toContain("| `tagGroups`");
        expect(enConfig).toContain(
          "Explicit OpenAPI `x-tagGroups` vendor extension output",
        );
      });

      it("config.tagGroups 空数组 → 不生成 x-tagGroups（显式禁用）", () => {
        const generator = createGenerator({ tagGroups: [] });
        const doc = generator.generate([
          createRoute("GET", "/api/users", {}, "routes/api/users.ts"),
          createRoute("GET", "/admin/panel", {}, "routes/admin/panel.ts"),
        ]);

        expect(doc["x-tagGroups"]).toBeUndefined();
      });

      it("config.tagGroups 仅使用显式配置（即使目录结构存在）", () => {
        const customGroups = [
          { name: "Public API", tags: ["users", "orders"] },
          { name: "Internal", tags: ["admin"] },
        ];

        const generator = createGenerator({ tagGroups: customGroups });
        const doc = generator.generate([
          createRoute(
            "GET",
            "/api/users",
            { docs: { tags: ["users"] } },
            "routes/api/users.ts",
          ),
          createRoute(
            "GET",
            "/api/orders",
            { docs: { tags: ["orders"] } },
            "routes/api/orders.ts",
          ),
          createRoute(
            "GET",
            "/admin/panel",
            { docs: { tags: ["admin"] } },
            "routes/admin/panel.ts",
          ),
        ]);

        // 使用用户配置的分组名，不会根据目录结构生成 "Api" / "Admin"
        expect(doc["x-tagGroups"]).toEqual(customGroups);
        const groupNames = doc["x-tagGroups"]!.map((g) => g.name);
        expect(groupNames).toContain("Public API");
        expect(groupNames).toContain("Internal");
        expect(groupNames).not.toContain("Api");
        expect(groupNames).not.toContain("Admin");
      });

      it("显式 x-tagGroups 与自定义 config.tags 共存", () => {
        const generator = createGenerator({
          tags: [
            { name: "users", description: "User management" },
            { name: "orders", description: "Order processing" },
            { name: "admin", description: "Administration" },
          ],
          tagGroups: [
            { name: "Public API", tags: ["users", "orders"] },
            { name: "Internal", tags: ["admin"] },
          ],
        });

        const doc = generator.generate([
          createRoute(
            "GET",
            "/api/users",
            { docs: { tags: ["users"] } },
            "routes/api/users.ts",
          ),
          createRoute(
            "GET",
            "/api/orders",
            { docs: { tags: ["orders"] } },
            "routes/api/orders.ts",
          ),
          createRoute(
            "GET",
            "/admin/panel",
            { docs: { tags: ["admin"] } },
            "routes/admin/panel.ts",
          ),
        ]);

        // 使用 config.tags 定义的 tag 列表
        expect(doc.tags).toHaveLength(3);
        expect(doc.tags![0].description).toBe("User management");

        expect(doc["x-tagGroups"]).toEqual([
          { name: "Public API", tags: ["users", "orders"] },
          { name: "Internal", tags: ["admin"] },
        ]);
      });

      it("collector clear + regenerate 后不会产生隐式 x-tagGroups", () => {
        const collector = new RouteMetadataCollector();
        const generator = createGenerator();

        // 第一次：两个目录
        collector.addRoute(
          "GET",
          "/api/users",
          { docs: { tags: ["users"] } },
          "routes/api/users.ts",
        );
        collector.addRoute(
          "GET",
          "/admin/panel",
          { docs: { tags: ["admin"] } },
          "routes/admin/panel.ts",
        );

        const doc1 = generator.generate(collector.getRoutes());
        expect(doc1["x-tagGroups"]).toBeUndefined();

        // 清空 + 第二次：目录结构变化也不隐式生成 x-tagGroups
        collector.clear();
        collector.addRoute(
          "GET",
          "/api/users",
          { docs: { tags: ["users"] } },
          "routes/api/users.ts",
        );
        collector.addRoute(
          "GET",
          "/api/orders",
          { docs: { tags: ["orders"] } },
          "routes/api/orders.ts",
        );

        const doc2 = generator.generate(collector.getRoutes());
        expect(doc2["x-tagGroups"]).toBeUndefined();
      });
    });
  });
});
