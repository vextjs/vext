/**
 * generator.ts — OpenAPIGenerator（OpenAPI 3.0 文档生成器）
 *
 * 接收 RouteMetadata[] 路由元信息列表，生成完整的 OpenAPI 3.0.3 文档。
 *
 * 核心职责：
 *   1. 遍历路由元信息，为每条路由构建 Operation 对象
 *   2. 将 validate.param / query / header / cookie → parameters
 *   3. 将 validate.body → requestBody
 *   4. 将 RouteOptions.responses + docs.responses → OpenAPI responses
 *   5. 从 middlewares 推断 security（auth → bearerAuth）
 *   6. 从 middlewares 推断 x-rate-limit 扩展
 *   7. 自动推断 tags（从文件路径）和 operationId（从方法+路径）
 *   8. 注册通用 ErrorResponse / SuccessResponse components/schemas
 *
 * 路径格式转换：
 *   vext:    /users/:id     → OpenAPI: /users/{id}
 *   vext:    /files/*path   → OpenAPI: /files/{path}
 *
 * @module lib/openapi/generator
 * @see 14-openapi.md §5（OpenAPIGenerator — 文档生成器）
 */

import type {
  RouteMetadata,
  OpenAPIConfig,
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIResponse,
  JsonSchema,
  SecurityScheme,
} from "./types.js";
import { SchemaConverter } from "./schema-converter.js";
import { inferOperationId } from "./operation-id.js";
import { authRequirementToOpenApiSecurity } from "../auth.js";
import {
  collectRouteResponseContracts,
  resolveRouteResponseJsonSchema,
  toOpenApiResponseSelector,
} from "../response-serializer.js";

const DOCS_TAGS_WARNING_SAMPLE_LIMIT = 3;

export const DEPRECATED_ROUTE_DOCS_TAGS_WARNING =
  "[openapi] route docs.tags is deprecated and ignored. Tags are inferred automatically from route path/source.";

type OperationIdSource = "explicit" | "inferred";

interface SeenOperationId {
  method: string;
  path: string;
  sourceFile: string;
  source: OperationIdSource;
}

export interface DeprecatedRouteDocsTagsUsage {
  method: string;
  path: string;
  sourceFile: string;
  tags: string[];
}

export function collectDeprecatedRouteDocsTagsUsage(
  routes: RouteMetadata[],
): DeprecatedRouteDocsTagsUsage[] {
  return routes
    .filter(
      (route) =>
        Array.isArray(route.options.docs?.tags) &&
        route.options.docs.tags.length > 0,
    )
    .map((route) => ({
      method: route.method,
      path: route.path,
      sourceFile: route.sourceFile,
      tags: [...route.options.docs!.tags!],
    }));
}

export function createDeprecatedRouteDocsTagsWarning(
  routes: RouteMetadata[],
): string | undefined {
  const usages = collectDeprecatedRouteDocsTagsUsage(routes);
  if (usages.length === 0) return undefined;

  const samples = usages
    .slice(0, DOCS_TAGS_WARNING_SAMPLE_LIMIT)
    .map((usage) => `${usage.method.toUpperCase()} ${usage.path}`)
    .join(", ");
  const remaining = usages.length - DOCS_TAGS_WARNING_SAMPLE_LIMIT;
  const suffix = remaining > 0 ? `, +${remaining} more` : "";

  return `${DEPRECATED_ROUTE_DOCS_TAGS_WARNING} Found ${usages.length} route(s): ${samples}${suffix}.`;
}

/**
 * OpenAPIGenerator — OpenAPI 3.0 文档生成器
 *
 * 无状态生成器（converter 内部也无状态），可安全多次调用 generate()。
 *
 * @example
 * ```typescript
 * const generator = new OpenAPIGenerator({
 *   title: 'My API',
 *   version: '1.0.0',
 *   servers: [{ url: 'http://localhost:3000', description: 'Development' }],
 * })
 *
 * const routes = collector.getRoutes()
 * const doc = generator.generate(routes)
 * const json = generator.generateJSON(routes)
 * ```
 */
export class OpenAPIGenerator {
  private converter = new SchemaConverter();
  private config: OpenAPIConfig;
  private responseWrap: boolean;

  constructor(
    config: OpenAPIConfig = {},
    runtime: { responseWrap?: boolean } = {},
  ) {
    this.config = config;
    this.responseWrap = runtime.responseWrap !== false;
  }

  /**
   * 生成完整的 OpenAPI 3.0 文档
   *
   * @param routes RouteMetadata[] 路由元信息列表（由 collector.getRoutes() 提供）
   * @returns OpenAPIDocument 完整的 OpenAPI 3.0 文档对象
   */
  generate(routes: RouteMetadata[]): OpenAPIDocument {
    const doc: OpenAPIDocument = {
      openapi: "3.0.3",
      info: {
        title: this.config.title ?? "VextJS API",
        description:
          this.config.description ?? "Auto-generated API documentation",
        version: this.config.version ?? "1.0.0",
        ...(this.config.contact ? { contact: this.config.contact } : {}),
        ...(this.config.license ? { license: this.config.license } : {}),
      },
      servers: this.config.servers ?? [
        { url: "/", description: "Current server" },
      ],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: this.buildSecuritySchemes(),
      },
      tags: this.config.tags ?? this.inferTags(routes),
    };

    // ── 遍历路由，生成 paths ────────────────────────────────
    const seenOperationIds = new Map<string, SeenOperationId>();
    for (const route of routes) {
      const openApiPath = this.convertPath(route.path);
      const method = route.method.toLowerCase();
      const operation = this.buildOperation(route);

      this.assertUniqueOperationId(
        operation.operationId,
        route,
        seenOperationIds,
      );

      if (!doc.paths[openApiPath]) {
        doc.paths[openApiPath] = {};
      }

      doc.paths[openApiPath][method] = operation;
    }

    // ── 添加通用错误响应 schema ─────────────────────────────
    doc.components!.schemas!.ErrorResponse = {
      type: "object",
      properties: {
        code: {
          oneOf: [{ type: "integer" }, { type: "string" }],
          description: "HTTP status code or business error code",
        },
        message: {
          type: "string",
          description: "Error message",
        },
        requestId: {
          type: "string",
          description: "Request trace ID",
        },
        details: {
          oneOf: [
            { type: "object", additionalProperties: true },
            { type: "array", items: {} },
          ],
          description: "Optional JSON-safe business error details",
        },
        errors: {
          type: "array",
          description: "Optional request validation field errors",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              message: { type: "string" },
            },
            required: ["field", "message"],
            additionalProperties: false,
          },
        },
      },
      required: ["code", "message", "requestId"],
    };

    doc.components!.schemas!.SuccessResponse = {
      type: "object",
      properties: {
        code: {
          type: "integer",
          description: "Status code (0 = success)",
          example: 0,
        },
        data: {
          description: "Response data",
        },
        requestId: {
          type: "string",
          description: "Request trace ID",
        },
      },
      required: ["code", "data", "requestId"],
    };

    // ── 透传显式 x-tagGroups vendor extension ─────────────
    //
    // 默认 Vext Docs 使用 path segment 递归导航；tagGroups 仅在用户
    // 显式配置时作为 OpenAPI vendor extension 原样输出。
    //
    const tagGroups = this.buildTagGroups();
    if (tagGroups.length > 0) {
      doc["x-tagGroups"] = tagGroups;
    }

    return doc;
  }

  /**
   * 生成 JSON 格式的 OpenAPI 文档字符串
   *
   * @param routes RouteMetadata[] 路由元信息列表
   * @returns JSON 字符串（格式化缩进 2 空格）
   */
  generateJSON(routes: RouteMetadata[]): string {
    return JSON.stringify(this.generate(routes), null, 2);
  }

  // ── 私有方法 ──────────────────────────────────────────────

  private assertUniqueOperationId(
    operationId: string | undefined,
    route: RouteMetadata,
    seenOperationIds: Map<string, SeenOperationId>,
  ): void {
    if (operationId === undefined) {
      return;
    }

    const current = this.describeOperationIdRoute(route);
    const existing = seenOperationIds.get(operationId);
    if (existing) {
      throw new Error(
        `[vextjs] Duplicate OpenAPI operationId "${operationId}" for ` +
          `${this.formatOperationIdRoute(current)} conflicts with ` +
          `${this.formatOperationIdRoute(existing)}. ` +
          "Set a unique route options.docs.operationId or change the route method/path so inferred operationId values differ.",
      );
    }

    seenOperationIds.set(operationId, current);
  }

  private describeOperationIdRoute(route: RouteMetadata): SeenOperationId {
    return {
      method: route.method.toUpperCase(),
      path: route.path,
      sourceFile: route.sourceFile,
      source:
        route.options.docs?.operationId === undefined ? "inferred" : "explicit",
    };
  }

  private formatOperationIdRoute(route: SeenOperationId): string {
    const source =
      route.source === "explicit"
        ? "explicit docs.operationId"
        : "inferred from method/path";

    return `${route.method} ${route.path} (${source}, ${route.sourceFile})`;
  }

  /**
   * 构建单个路由的 Operation 对象
   *
   * 依次处理：
   *   1. summary / operationId / tags / deprecated / description
   *   2. 路径参数（validate.param → parameters[in=path]）
   *   3. 查询参数（validate.query → parameters[in=query]）
   *   4. 请求头（validate.header → parameters[in=header]）
   *   5. Cookie（validate.cookie → parameters[in=cookie]）
   *   6. 请求体（validate.body → requestBody，仅 POST/PUT/PATCH）
   *   7. 响应（docs.responses → responses，成功响应自动包装）
   *   8. 默认响应（未声明时添加 200 OK）
   *   9. 安全方案（从 middlewares 或 docs.security 推断）
   *   10. 自定义扩展（docs.extensions → x-* 字段）
   *   11. 文档权限 metadata（docs.access → x-vext-docs-access）
   *   12. 速率限制（从 rate-limit 中间件推断 x-rate-limit）
   *   13. 清空空参数数组
   *
   * @param route 单条路由的元信息
   * @returns OpenAPIOperation 对象
   */
  private buildOperation(route: RouteMetadata): OpenAPIOperation {
    const { options, method, path } = route;
    const docs = options.docs ?? {};

    const operation: OpenAPIOperation = {
      summary: docs.summary ?? `${method} ${path}`,
      operationId: docs.operationId ?? inferOperationId(method, path),
      tags: [this.inferTag(route)],
      deprecated: docs.deprecated ?? false,
      parameters: [],
      responses: {},
    };

    (operation as Record<string, unknown>)["x-vext-docs-kind"] =
      route.docsKind ?? "backend-api";

    // ── 描述 ────────────────────────────────────────────────
    if (docs.description) {
      operation.description = docs.description;
    }

    // ── 路径参数（params / param） ──────────────────────────
    // validate.param 是当前公开契约；validate.params 仅作为旧文档/旧用法兼容。
    const validateParams =
      (options.validate as Record<string, unknown>)?.params ??
      options.validate?.param;
    const documentedPathParams = new Set<string>();
    if (validateParams) {
      const params = validateParams as Record<string, string>;
      for (const [name, dsl] of Object.entries(params)) {
        const { schema } = this.converter.convertDSLString(
          typeof dsl === "string" ? dsl : "string",
        );
        documentedPathParams.add(name);
        operation.parameters!.push({
          name,
          in: "path",
          required: true,
          schema,
        });
      }
    }
    for (const name of this.extractPathParameterNames(path)) {
      if (documentedPathParams.has(name)) {
        continue;
      }
      operation.parameters!.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }

    // ── 查询参数（query） ───────────────────────────────────
    // validate.query 中的每个字段映射为查询参数
    // 必填标记（!）映射为 required: true
    if (options.validate?.query) {
      const query = options.validate.query as Record<string, string>;
      for (const [name, dsl] of Object.entries(query)) {
        if (typeof dsl !== "string") continue;
        const { schema, isRequired } = this.converter.convertDSLString(dsl);
        operation.parameters!.push({
          name,
          in: "query",
          required: isRequired,
          schema,
        });
      }
    }

    // ── 请求头参数（header）─────────────────────────────────
    // validate.header 与 validate.query 一样属于请求输入契约，
    // 映射到 OpenAPI parameters[in=header] 后，Docs Try it out 可自动生成 Header 行。
    if (options.validate?.header) {
      const headers = options.validate.header as Record<string, string>;
      for (const [name, dsl] of Object.entries(headers)) {
        if (typeof dsl !== "string") continue;
        const { schema, isRequired } = this.converter.convertDSLString(dsl);
        operation.parameters!.push({
          name,
          in: "header",
          required: isRequired,
          schema,
        });
      }
    }

    // ── Cookie 参数（cookie）────────────────────────────────
    // validate.cookie 与 validate.query/header 一样属于请求输入契约，
    // 映射到 OpenAPI parameters[in=cookie]。
    if (options.validate?.cookie) {
      const cookies = options.validate.cookie as Record<string, string>;
      for (const [name, dsl] of Object.entries(cookies)) {
        if (typeof dsl !== "string") continue;
        const { schema, isRequired } = this.converter.convertDSLString(dsl);
        operation.parameters!.push({
          name,
          in: "cookie",
          required: isRequired,
          schema,
        });
      }
    }

    // ── 请求体（body / multipart） ──────────────────────────
    // 仅 POST / PUT / PATCH 方法生成 requestBody。
    // multipart.files 优先于 validate.body（两者互斥）。
    if (["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      if (options.multipart?.files) {
        // multipart/form-data 文件上传
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];

        for (const [fieldname, fieldConfig] of Object.entries(
          options.multipart.files,
        )) {
          const desc =
            typeof fieldConfig === "string"
              ? fieldConfig
              : (fieldConfig.description ?? "上传的文件");
          properties[fieldname] = {
            type: "string",
            format: "binary",
            description: desc,
          };
          if (typeof fieldConfig === "object" && fieldConfig.required) {
            required.push(fieldname);
          }
        }

        operation.requestBody = {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties,
                ...(required.length > 0 ? { required } : {}),
              },
            },
          },
        };
      } else if (options.validate?.body) {
        const bodyResult = this.converter.convertValidateObject(
          options.validate.body as Record<string, unknown>,
        );
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: bodyResult.schema,
            },
          },
        };
      }
    }

    // ── 响应（responses） ───────────────────────────────────
    // RouteOptions.responses owns runtime schema; docs.responses contributes
    // description/examples/headers/contentType and remains docs-only when no
    // runtime schema exists for the selector.
    const responseContracts = collectRouteResponseContracts(options);
    for (const contract of responseContracts) {
      const code = toOpenApiResponseSelector(contract.selector);
      const config = contract.docs;
      const responseObj: OpenAPIResponse = {
        description:
          config?.description ??
          (code === "default" ? "Default response" : `${code} response`),
      };

      if (contract.runtime && config?.schema !== undefined) {
        throw new Error(
          `[vextjs] Response selector ${contract.selector} declares schema in both RouteOptions.responses and docs.responses.`,
        );
      }

      const contentType = config?.contentType ?? "application/json";
      if (
        contract.runtime &&
        contentType.toLowerCase() !== "application/json"
      ) {
        throw new Error(
          `[vextjs] Runtime response selector ${contract.selector} only supports application/json, received ${JSON.stringify(contentType)}.`,
        );
      }

      const definition = contract.runtime?.schema ?? config?.schema;
      const runtimeHasNoBody =
        contract.runtime !== undefined &&
        (method.toUpperCase() === "HEAD" || contract.selector === "204");
      if (definition !== undefined && !runtimeHasNoBody) {
        const converted = contract.runtime
          ? (resolveRouteResponseJsonSchema(
              contract.runtime.schema,
            ) as JsonSchema)
          : this.converter.convertResponseSchema(
              definition as Record<string, unknown> | string,
            );
        const wrappedSchema = contract.runtime
          ? this.responseWrap
            ? this.wrapRuntimeResponseSchema(contract.selector, converted)
            : converted
          : this.wrapResponseSchema(Number(code), converted);

        responseObj.content = {
          [contentType]: {
            schema: wrappedSchema,
          },
        };
        const contentEntry = responseObj.content[contentType]!;
        const wrapExample = (example: unknown): unknown =>
          contract.runtime
            ? this.responseWrap
              ? this.wrapRuntimeResponseExample(example)
              : example
            : this.wrapResponseExample(Number(code), example);

        if (config?.example !== undefined) {
          contentEntry.example = wrapExample(config.example);
        }
        if (config?.examples) {
          contentEntry.examples = {};
          for (const [name, example] of Object.entries(config.examples)) {
            contentEntry.examples[name] = {
              summary: example.summary,
              description: example.description,
              value: wrapExample(example.value),
            };
          }
        }
      }

      if (config?.headers) {
        responseObj.headers = config.headers as OpenAPIResponse["headers"];
      }
      operation.responses[code] = responseObj;
    }

    // ── 默认响应（未声明 docs.responses 时） ─────────────────
    if (Object.keys(operation.responses).length === 0) {
      // 尝试从 validate.body 推断响应 schema（写操作通常返回创建/更新后的对象）
      const isWriteMethod = ["POST", "PUT", "PATCH"].includes(
        method.toUpperCase(),
      );
      const hasBody =
        options.validate?.body &&
        typeof options.validate.body === "object" &&
        Object.keys(options.validate.body as Record<string, unknown>).length >
          0;

      if (isWriteMethod && hasBody) {
        const bodySchema = this.converter.convertValidateObject(
          options.validate!.body as Record<string, unknown>,
        );
        const statusCode = method.toUpperCase() === "POST" ? "201" : "200";
        const description =
          method.toUpperCase() === "POST"
            ? "Created successfully"
            : "Updated successfully";

        const wrappedSchema = this.wrapResponseSchema(
          Number(statusCode),
          bodySchema.schema,
        );

        // 生成示例值：从 schema properties 中提取 example
        const exampleData: Record<string, unknown> = {};
        if (bodySchema.schema.properties) {
          for (const [key, prop] of Object.entries(
            bodySchema.schema.properties,
          )) {
            if (prop.example !== undefined) {
              exampleData[key] = prop.example;
            } else if (prop.type === "string") {
              exampleData[key] = key;
            } else if (prop.type === "number" || prop.type === "integer") {
              exampleData[key] = 0;
            } else if (prop.type === "boolean") {
              exampleData[key] = true;
            }
          }
        }

        const wrappedExample = this.wrapResponseExample(
          Number(statusCode),
          exampleData,
        );

        operation.responses[statusCode] = {
          description,
          content: {
            "application/json": {
              schema: wrappedSchema,
              example: wrappedExample,
            },
          },
        };
      } else {
        operation.responses["200"] = {
          description: "OK",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SuccessResponse" },
            },
          },
        };
      }
    }

    // ── 通用错误响应（所有路由自动追加 4xx/5xx 引用）─────────
    if (!operation.responses["400"] && options.validate?.param) {
      operation.responses["400"] = {
        description: "Path parameter validation error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: {
              code: 400,
              message: "Validation failed",
              requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
          },
        },
      };
    }
    const hasNonParamValidation = Object.entries(options.validate ?? {}).some(
      ([location, schema]) => location !== "param" && schema != null,
    );
    if (!operation.responses["422"] && hasNonParamValidation) {
      operation.responses["422"] = {
        description: "Validation error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: {
              code: 422,
              message: "Validation failed",
              requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
          },
        },
      };
    }
    if (!operation.responses["500"]) {
      operation.responses["500"] = {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
          },
        },
      };
    }

    // ── 安全方案（docs.security → RouteOptions.auth → legacy middlewares）────
    if (docs.security !== undefined) {
      // 显式指定 security（包括空数组 = 无需认证）
      operation.security = docs.security as Array<Record<string, string[]>>;
    } else if (options.auth !== undefined && options.auth !== false) {
      operation.security = authRequirementToOpenApiSecurity(options.auth);
    } else if (
      options.auth !== false &&
      options.middlewares &&
      (options.middlewares as unknown[]).length > 0
    ) {
      // 从 middlewares 推断 security
      const inferred = this.inferSecurityFromMiddlewares(
        options.middlewares as Array<
          string | { name: string; options?: unknown }
        >,
      );
      if (inferred.length > 0) {
        operation.security = inferred;
      }
    }

    // ── 自定义扩展字段（docs.extensions → x-* ）─────────────
    if (docs.extensions) {
      for (const [key, value] of Object.entries(
        docs.extensions as Record<string, unknown>,
      )) {
        const xKey = key.startsWith("x-") ? key : `x-${key}`;
        (operation as Record<string, unknown>)[xKey] = value;
      }
    }

    if (docs.access !== undefined) {
      (operation as Record<string, unknown>)["x-vext-docs-access"] =
        docs.access;
    }

    // ── 速率限制扩展（从 rate-limit 中间件推断 x-rate-limit）──
    const rateLimitExtension = this.buildRateLimitExtension(
      options.middlewares,
    );
    if (rateLimitExtension) {
      (operation as Record<string, unknown>)["x-rate-limit"] =
        rateLimitExtension;
    }

    // ── 清空空参数数组 ──────────────────────────────────────
    if (operation.parameters!.length === 0) {
      delete operation.parameters;
    }

    return operation;
  }

  private buildRateLimitExtension(
    middlewares: unknown,
  ): { max: number; window: number } | undefined {
    if (!Array.isArray(middlewares)) {
      return undefined;
    }

    const rateLimitMw = middlewares.find(
      (mw): mw is { name: string; options?: unknown } =>
        typeof mw === "object" &&
        mw !== null &&
        !Array.isArray(mw) &&
        (mw as { name?: unknown }).name === "rate-limit",
    );
    if (
      !rateLimitMw ||
      typeof rateLimitMw.options !== "object" ||
      rateLimitMw.options === null ||
      Array.isArray(rateLimitMw.options)
    ) {
      return undefined;
    }

    const options = rateLimitMw.options as Record<string, unknown>;
    const max = options.max;
    const window = options.window;
    if (
      this.isPositiveFiniteNumber(max) &&
      this.isPositiveFiniteNumber(window)
    ) {
      return { max, window };
    }
    return undefined;
  }

  private isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  /**
   * 包装响应 schema 为 vext 标准格式
   *
   * 成功响应（2xx，非 204）:
   *   { code: 0, data: <原始 schema>, requestId: string }
   *
   * 204 No Content:
   *   空对象（无响应体）
   *
   * 错误响应（4xx/5xx）:
   *   直接使用原始 schema（通常是 ErrorResponse 格式）
   *
   * @param statusCode HTTP 状态码
   * @param dataSchema 原始数据 schema
   * @returns 包装后的 JsonSchema
   */
  private wrapResponseSchema(
    statusCode: number,
    dataSchema: JsonSchema,
  ): JsonSchema {
    if (statusCode === 204) {
      // 204 No Content — 无响应体
      return {};
    }

    if (statusCode >= 200 && statusCode < 300) {
      // 成功响应 — 包装为 { code: 0, data, requestId }
      return {
        type: "object",
        properties: {
          code: { type: "integer", example: 0 },
          data: dataSchema,
          requestId: {
            type: "string",
            example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          },
        },
        required: ["code", "data", "requestId"],
      };
    }

    // 错误响应 — 直接使用原始 schema（通常是 ErrorResponse 格式）
    return dataSchema;
  }

  /** Runtime schemas describe res.json() business data for every body status. */
  private wrapRuntimeResponseSchema(
    selector: string,
    dataSchema: JsonSchema,
  ): JsonSchema {
    if (selector === "204") return {};
    return {
      type: "object",
      properties: {
        code: { type: "integer", example: 0 },
        data: dataSchema,
        requestId: {
          type: "string",
          example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
      required: ["code", "data", "requestId"],
      additionalProperties: false,
    };
  }

  /**
   * 包装响应示例为 vext 标准格式
   *
   * 成功响应（2xx，非 204）自动包装为 { code: 0, data: ..., requestId: '...' }
   * 错误响应直接返回原始示例
   *
   * @param statusCode HTTP 状态码
   * @param example    原始示例值
   * @returns 包装后的示例值
   */
  private wrapResponseExample(statusCode: number, example: unknown): unknown {
    if (statusCode >= 200 && statusCode < 300 && statusCode !== 204) {
      return {
        code: 0,
        data: example,
        requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      };
    }
    return example;
  }

  private wrapRuntimeResponseExample(example: unknown): unknown {
    return {
      code: 0,
      data: example,
      requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    };
  }

  /**
   * 转换路由路径格式
   *
   * vext 使用 Express 风格的路径参数（:param），
   * OpenAPI 使用花括号风格（{param}）。
   *
   * vext:    /users/:id     → OpenAPI: /users/{id}
   * vext:    /files/*path   → OpenAPI: /files/{path}
   *
   * @param path vext 格式的路由路径
   * @returns OpenAPI 格式的路由路径
   */
  private convertPath(path: string): string {
    return path.replace(/:(\w+)/g, "{$1}").replace(/\*(\w+)/g, "{$1}");
  }

  private extractPathParameterNames(path: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const pattern = /[:*](\w+)/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(path)) !== null) {
      const name = match[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    return names;
  }

  /**
   * 从 middlewares 推断 security
   *
   * 检测 middleware 名称是否匹配 guardSecurityMap 中的 key。
   * middlewares 可以是 string 或 { name, options } 对象，需统一提取 name。
   *
   * 默认映射：
   *   - 'auth'    → bearerAuth
   *   - 'api-key' → apiKeyAuth
   *
   * 用户可通过 config.guardSecurityMap 自定义映射。
   *
   * @param middlewares 路由级中间件列表
   * @returns 推断出的 security 数组
   */
  private inferSecurityFromMiddlewares(
    middlewares: Array<string | { name: string; options?: unknown }>,
  ): Array<Record<string, string[]>> {
    const map = this.config.guardSecurityMap ?? {
      auth: "bearerAuth",
      "api-key": "apiKeyAuth",
    };

    return middlewares
      .map((m) => (typeof m === "string" ? m : m.name))
      .filter((name) => name in map)
      .map((name) => ({ [map[name] as string]: [] }));
  }

  /**
   * 构建 securitySchemes
   *
   * 优先使用用户配置的 securitySchemes。
   * 若未配置，提供默认的 Bearer Token 方案。
   *
   * @returns securitySchemes 对象
   */
  private buildSecuritySchemes(): Record<string, SecurityScheme> {
    if (this.config.securitySchemes) {
      return this.config.securitySchemes;
    }

    // 默认方案：Bearer Token
    return {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT Bearer Token authentication",
      },
    };
  }

  /**
   * 构建显式 x-tagGroups vendor extension
   *
   * 只有用户显式配置 openapi.tagGroups 时才输出。
   * 默认 Vext Docs renderer 已使用 OpenAPI path segment 生成递归导航；
   * 自动把业务 tags 归入文件目录分组容易生成误导性的 General 分组。
   */
  private buildTagGroups(): Array<{ name: string; tags: string[] }> {
    if (this.config.tagGroups && this.config.tagGroups.length > 0) {
      return this.config.tagGroups;
    }
    return [];
  }

  /**
   * 从路由列表推断 tags
   *
   * 收集所有路由的 tags（显式声明或从文件路径推断），
   * 去重排序后返回。
   *
   * @param routes 路由元信息列表
   * @returns tag 定义列表（按名称排序）
   */
  private inferTags(
    routes: RouteMetadata[],
  ): Array<{ name: string; description?: string }> {
    const tagSet = new Set<string>();

    for (const route of routes) {
      tagSet.add(this.inferTag(route));
    }

    return Array.from(tagSet)
      .sort()
      .map((name) => ({ name }));
  }

  private inferTag(route: RouteMetadata): string {
    return (
      this.inferTagFromPath(route.path) ??
      this.inferTagFromFile(route.sourceFile)
    );
  }

  private inferTagFromPath(path: string): string | undefined {
    const segments = path
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .filter((segment) => !this.isDynamicPathSegment(segment));

    if (segments.length === 0) {
      return "General";
    }

    const first = segments[0]!.toLowerCase();
    if (segments.length === 1 && (first === "health" || first === "ping")) {
      return "General";
    }

    if (first === "api") {
      const version = segments[1];
      if (version && this.isApiVersionTagSegment(version)) {
        return `API ${this.formatApiVersionTagSegment(version)}`;
      }
      return "API";
    }

    if (this.isApiVersionTagSegment(segments[0]!)) {
      return `API ${this.formatApiVersionTagSegment(segments[0]!)}`;
    }

    return this.humanizeTagSegment(segments[0]!);
  }

  private isApiVersionTagSegment(segment: string): boolean {
    return (
      /^v\d+[A-Za-z0-9-]*$/u.test(segment) ||
      /^(?:alpha|beta|canary|latest|next|preview|rc|stable)(?:-?\d+)?$/iu.test(
        segment,
      )
    );
  }

  private formatApiVersionTagSegment(segment: string): string {
    if (/^v\d+[A-Za-z0-9-]*$/u.test(segment)) {
      return segment;
    }
    if (/^rc(?:-?\d+)?$/iu.test(segment)) {
      return segment.toUpperCase();
    }
    return this.humanizeTagSegment(segment);
  }

  private isDynamicPathSegment(segment: string): boolean {
    return (
      segment.startsWith(":") ||
      segment.startsWith("*") ||
      /^\{.+\}$/u.test(segment) ||
      /^\[\[?\.{0,3}.+\]?\]$/u.test(segment)
    );
  }

  private humanizeTagSegment(segment: string): string {
    const acronyms: Record<string, string> = {
      api: "API",
      db: "DB",
      id: "ID",
      openapi: "OpenAPI",
      ssr: "SSR",
      ui: "UI",
    };

    return segment
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => {
        const lower = part.toLowerCase();
        return (
          acronyms[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1)
        );
      })
      .join(" ");
  }

  /**
   * 从文件路径推断 tag
   *
   * 提取 routes/ 后面的相对路径，移除扩展名：
   *   routes/users.ts      → 'users'
   *   routes/admin/roles.ts → 'admin-roles'
   *   routes/index.ts       → 'default'
   *
   * @param sourceFile 路由文件的绝对路径
   * @returns 推断的 tag 名称
   */
  private inferTagFromFile(sourceFile: string): string {
    const relative = sourceFile
      .replace(/\\/g, "/")
      .replace(/^.*routes\//, "")
      .replace(/\.(ts|js|mts|mjs|cts|cjs)$/, "");

    if (relative === "index" || relative === "") {
      return "default";
    }

    return relative.replace(/\/index$/, "").replace(/\//g, "-");
  }
}
