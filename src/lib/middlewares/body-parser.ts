import type { VextMiddleware } from "../../types/middleware.js";
import type {
  VextBodyParserConfig,
  VextMultipartConfig,
  MultipartRouteConfig,
} from "../../types/app.js";
import { defineEnumerableOwn } from "../own-property.js";
import type { VextRequest, ParsedFile } from "../../types/request.js";

/**
 * parseBytes — 将人类可读的体积字符串转为字节数
 *
 * 支持格式：'512b' | '1kb' | '10mb' | '1gb' 或直接传数字（字节）。
 * 大小写不敏感。
 *
 * @param value 体积字符串或字节数
 * @returns 字节数
 * @throws 格式不合法时抛出 Error
 */
export function parseBytes(value: string | number): number {
  if (typeof value === "number") {
    return value;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
  if (!match) {
    throw new Error(
      `[vextjs] Invalid body size format: "${value}". ` +
        `Expected format: '1mb', '512kb', '1gb', or a number (bytes).`,
    );
  }

  const num = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();

  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  return Math.floor(num * multipliers[unit]!);
}

export class PayloadTooLargeError extends Error {
  readonly status = 413;

  constructor(readonly maxBytes: number) {
    super("Payload Too Large");
    this.name = "PayloadTooLargeError";
  }
}

export function createPayloadTooLargeError(
  maxBytes: number,
): PayloadTooLargeError {
  return new PayloadTooLargeError(maxBytes);
}

export function isPayloadTooLargeError(
  err: unknown,
): err is PayloadTooLargeError {
  return (
    err instanceof PayloadTooLargeError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { status?: unknown }).status === 413 &&
      (err as { message?: unknown }).message === "Payload Too Large")
  );
}

export function assertBodySize(size: number, maxBytes?: number): void {
  if (maxBytes !== undefined && size > maxBytes) {
    throw createPayloadTooLargeError(maxBytes);
  }
}

export function resolveBodyParserMaxBytes(
  globalConfig: VextBodyParserConfig,
  routeConfig?: VextBodyParserConfig,
): number {
  return parseBytes(
    routeConfig?.maxBodySize ?? globalConfig.maxBodySize ?? "1mb",
  );
}

export function resolveRouteBodyParserConfig(routeOptions?: {
  bodyParser?: VextBodyParserConfig;
  override?: { maxBodySize?: string | number };
}): VextBodyParserConfig | undefined {
  if (routeOptions?.bodyParser) return routeOptions.bodyParser;
  if (routeOptions?.override?.maxBodySize !== undefined) {
    return { maxBodySize: routeOptions.override.maxBodySize };
  }
  return undefined;
}

export function resolveRouteMultipartConfig(routeOptions?: {
  multipart?: MultipartRouteConfig;
}): MultipartRouteConfig | undefined {
  return routeOptions?.multipart;
}

export function resolveAdapterBodyLimitBytes(args: {
  globalBodyParser?: VextBodyParserConfig;
  routeBodyParser?: VextBodyParserConfig;
  multipart?: VextMultipartConfig;
  adapterBodyLimit?: string | number;
}): number {
  const bodyParserLimit = parseBytes(
    args.routeBodyParser?.maxBodySize ??
      args.globalBodyParser?.maxBodySize ??
      "1mb",
  );
  const adapterLimit =
    args.adapterBodyLimit !== undefined
      ? parseBytes(args.adapterBodyLimit)
      : undefined;

  // multipart.maxFileSize is a per-file validation limit. It must not widen the
  // request-body read boundary, otherwise a small route-level maxBodySize would
  // only fail after the adapter has already accepted a larger body.
  return adapterLimit === undefined
    ? bodyParserLimit
    : Math.min(bodyParserLimit, adapterLimit);
}

/**
 * parseMultipart — 内置 multipart/form-data 解析器
 *
 * 使用 Node.js 20+ Web API（Request.formData()）解析，零外部依赖。
 *
 * 统一路径（所有 5 个 adapter）：
 *   1. 通过 req._getRawBodyBuffer() 一次性读取原始 Buffer（有缓存，多次调用安全）
 *   2. 用该 Buffer 构造一个新的 Web API Request 并调用 formData()
 *
 * 不使用 Hono 特殊路径（c.req.raw.formData()）原因：
 *   Web API Request.formData() 会消费 ReadableStream body，之后 arrayBuffer()
 *   等方法在同一 Request 上无法再次读取，导致 _getRawBodyBuffer() 缓存未命中、
 *   二次调用返回空 Buffer（破坏 busboy 等插件的流读取）。
 *   统一走 _getRawBodyBuffer() 保证 _rawBufferCache 始终有效。
 */
async function parseMultipart(
  req: VextRequest,
  contentType: string,
  config: VextMultipartConfig,
  maxBodyBytes: number,
): Promise<ParsedFile[]> {
  const rawBuffer = await req._getRawBodyBuffer(maxBodyBytes);
  assertBodySize(rawBuffer.byteLength, maxBodyBytes);
  const dummyRequest = new Request("http://localhost", {
    method: "POST",
    body: rawBuffer,
    headers: { "content-type": contentType },
  });
  const formData = await dummyRequest.formData();
  return formDataToFiles(formData, config);
}

/**
 * formDataToFiles — 将 FormData 中的 File 条目转换为 ParsedFile[]
 *
 * 按顺序校验 maxFiles / maxFileSize / allowedMimeTypes，
 * 不满足时抛出带 status 的错误对象（由调用方转换为 HTTP 响应）。
 */
async function formDataToFiles(
  formData: FormData,
  config: VextMultipartConfig,
): Promise<ParsedFile[]> {
  const files: ParsedFile[] = [];
  const maxFiles = config.maxFiles ?? 10;
  const maxFileSize = config.maxFileSize ?? 10 * 1024 * 1024;

  for (const [fieldname, value] of formData.entries()) {
    if (value instanceof File) {
      if (files.length >= maxFiles) {
        throw { status: 413, message: "Too many files" };
      }

      const buffer = Buffer.from(await value.arrayBuffer());

      if (buffer.length > maxFileSize) {
        throw {
          status: 413,
          message: `File "${value.name}" exceeds maxFileSize`,
        };
      }

      const mimetype = value.type || "application/octet-stream";

      if (
        config.allowedMimeTypes &&
        !config.allowedMimeTypes.includes(mimetype)
      ) {
        throw {
          status: 415,
          message: `MIME type "${mimetype}" is not allowed`,
        };
      }

      files.push({
        fieldname,
        filename: value.name,
        mimetype,
        buffer,
        size: buffer.length,
      });
    }
  }

  return files;
}

/**
 * createBodyParserMiddleware — Body 解析中间件工厂
 *
 * 内置中间件 #3，职责：
 *   1. 解析 application/json 请求体 → req.body（对象）
 *   2. 解析 application/x-www-form-urlencoded 请求体 → req.body（对象）
 *   3. 其他 Content-Type → 跳过，req.body 保持 undefined
 *   4. 请求体大小检查 → 超过 maxBodySize 返回 413 Payload Too Large
 *
 * 配置项（config.bodyParser）：
 *   - maxBodySize: 请求体最大体积（默认 '1mb'），支持 '512b' | '1kb' | '10mb' | '1gb' 或数字
 *
 * 内存安全：
 *   body-parser 在读取请求体时逐块累计大小，
 *   一旦超过 maxBodySize 立即中止读取并返回 413，
 *   不会将超大请求体完整读入内存。
 *
 * 设计说明：
 *   - GET / HEAD / DELETE / OPTIONS 等无 body 方法直接跳过（不读取流）
 *   - Hono adapter 已将 Node.js IncomingMessage 转为 Web Request，
 *     但 body 解析由 vext body-parser 在中间件层完成（而非 adapter 层），
 *     确保用户中间件和 handler 拿到的 req.body 是已解析的对象
 *   - multipart/form-data：当 multipartConfig.enabled = true 时内置解析并填充 req.files，
 *     否则跳过（req.files 保持 undefined）
 *
 * 与 Hono adapter 的协作：
 *   Hono adapter 的 buildHandler() 将 Node.js IncomingMessage 转为 Web ReadableStream
 *   作为 Web Request 的 body。createVextRequest 通过 c.req.raw.body 可访问该流。
 *   body-parser 从 c.req.raw 获取原始请求体文本后解析为对象。
 *
 *   实际实现中，我们通过 req.headers['content-type'] 判断类型，
 *   通过 req 上附带的原始 body 文本（由 adapter 传递）进行解析。
 *   由于 Hono 已经处理了 Web Request 的 body 读取，
 *   我们在 VextRequest 上通过一个特殊的 _rawBody 字段传递原始字节。
 *
 *   实际上 Hono adapter 中 createVextRequest 保存了 Hono Context 引用，
 *   body-parser 可以通过 (req as any)._honoContext.req.text() 读取原始文本。
 *   但为了解耦，我们使用 req 上的 _getRawBody 方法（由 adapter 注入）。
 *
 *   → 简化方案：由于 VextRequest 是 adapter 内部创建的对象，
 *     body-parser 直接通过 (req as any)._rawBody() 获取 Promise<string>
 *     该方法由 createVextRequest 注入（从 Hono Context 读取）。
 *
 * @param config bodyParser 配置（从 VextConfig.bodyParser 提取）
 * @returns VextMiddleware
 */
export function createBodyParserMiddleware(
  config: VextBodyParserConfig,
  multipartConfig?: VextMultipartConfig,
): VextMiddleware {
  return async (req, res, next) => {
    // ── 无 body 方法直接跳过 ────────────────────────────
    // req.method 已由 createVextRequest 保证大写，无需 toUpperCase()
    const method = req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }

    // ── 无 Content-Type 或无 body 直接跳过 ──────────────
    const contentType = req.headers["content-type"];
    if (!contentType) {
      await next();
      return;
    }
    const routeBodyParser = (req as { _routeBodyParser?: VextBodyParserConfig })
      ._routeBodyParser;
    const routeMultipart = resolveRouteMultipartConfig(
      (req as { _routeOptions?: { multipart?: MultipartRouteConfig } })
        ._routeOptions,
    );
    const effectiveConfig = routeBodyParser
      ? { ...config, ...routeBodyParser }
      : config;

    if (effectiveConfig.enabled === false) {
      await next();
      return;
    }

    const maxBytes = resolveBodyParserMaxBytes(config, routeBodyParser);

    // ── 仅处理 JSON 和 URL-encoded ─────────────────────
    const isJson = contentType.includes("application/json");
    const isUrlEncoded = contentType.includes(
      "application/x-www-form-urlencoded",
    );

    // ── 内置 multipart 解析（enabled 时自动填充 req.files）──────
    if (contentType.startsWith("multipart/form-data")) {
      if (routeMultipart?.enabled === false) {
        await next();
        return;
      }

      if (multipartConfig?.enabled) {
        try {
          req.files = await parseMultipart(
            req,
            contentType,
            multipartConfig,
            maxBytes,
          );
        } catch (err: unknown) {
          const httpErr = err as { status?: number; message?: string };
          res.rawJson(
            {
              code: httpErr.status ?? 400,
              message: httpErr.message ?? "Bad Request: multipart parse error",
              requestId: req.requestId,
            },
            (httpErr.status ?? 400) as 400 | 413 | 415,
          );
          return;
        }
      }
      // enabled = false 时跳过（req.files 保持 undefined）
      await next();
      return;
    }

    if (!isJson && !isUrlEncoded) {
      // 其他非 multipart Content-Type → 跳过
      await next();
      return;
    }

    // ── 读取原始请求体 ──────────────────────────────────
    //
    // VextRequest 上定义了 _getRawBody() 方法，由 adapter 实现。
    // 直接调用，无需类型转换。
    //
    let rawBody: string;
    let rawBuffer: Buffer;

    try {
      rawBuffer = await req._getRawBodyBuffer(maxBytes);
      rawBody = rawBuffer.toString("utf-8");
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        res.rawJson(
          {
            code: 413,
            message: "Payload Too Large",
            requestId: req.requestId,
          },
          413,
        );
        return;
      }

      // 读取失败（客户端可能已断开）
      res.rawJson(
        { code: 400, message: "Bad Request: unable to read request body" },
        400,
      );
      return;
    }

    const bodyBytes = rawBuffer.byteLength;

    if (bodyBytes > maxBytes) {
      res.rawJson(
        {
          code: 413,
          message: "Payload Too Large",
          requestId: req.requestId,
        },
        413,
      );
      return;
    }

    // ── 空 body 直接跳过 ────────────────────────────────
    if (rawBody.length === 0) {
      req.body = isJson ? undefined : {};
      await next();
      return;
    }

    // ── 解析 ────────────────────────────────────────────
    try {
      if (isJson) {
        req.body = JSON.parse(rawBody);
      } else {
        // URL-encoded → 使用 URLSearchParams 解析为纯对象
        const params = new URLSearchParams(rawBody);
        const parsed: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          defineEnumerableOwn(parsed, key, value);
        }
        req.body = parsed;
      }
    } catch {
      // JSON 解析失败 → 400 Bad Request
      res.rawJson(
        {
          code: 400,
          message: "Bad Request: invalid JSON in request body",
          requestId: req.requestId,
        },
        400,
      );
      return;
    }

    await next();
  };
}

/**
 * createRouteMultipartMiddleware — 路由级 multipart 解析中间件工厂
 *
 * 在 router-loader 中，当路由声明 `multipart.enabled = true` 时自动注入。
 * 行为语义：
 *   - 若 body-parser（全局）已解析（`req.files !== undefined`）：
 *       用路由级配置做二次校验（覆盖全局限制）
 *   - 若未解析（全局 enabled = false）：
 *       用合并后的配置重新解析（路由级覆盖全局）
 *
 * @param routeConfig   路由级 multipart 配置
 * @param globalConfig  全局 multipart 配置（提供默认值）
 */
export function createRouteMultipartMiddleware(
  routeConfig: MultipartRouteConfig,
  globalConfig?: VextMultipartConfig,
  globalBodyParser?: VextBodyParserConfig,
): VextMiddleware {
  const mergedConfig: VextMultipartConfig = {
    enabled: true,
    maxFileSize: routeConfig.maxFileSize ?? globalConfig?.maxFileSize,
    maxFiles: routeConfig.maxFiles ?? globalConfig?.maxFiles,
    allowedMimeTypes:
      routeConfig.allowedMimeTypes ?? globalConfig?.allowedMimeTypes,
  };

  return async (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      await next();
      return;
    }

    try {
      if (req.files !== undefined) {
        // 全局 body-parser 已解析 → 用路由级配置做二次校验
        const maxFiles = mergedConfig.maxFiles ?? 10;
        const maxFileSize = mergedConfig.maxFileSize ?? 10 * 1024 * 1024;

        if (req.files.length > maxFiles) {
          throw { status: 413, message: "Too many files" };
        }

        for (const file of req.files) {
          if (file.size > maxFileSize) {
            throw {
              status: 413,
              message: `File "${file.filename}" exceeds maxFileSize`,
            };
          }
          if (
            mergedConfig.allowedMimeTypes &&
            !mergedConfig.allowedMimeTypes.includes(file.mimetype)
          ) {
            throw {
              status: 415,
              message: `MIME type "${file.mimetype}" is not allowed`,
            };
          }
        }
        assertRequiredMultipartFiles(req.files, routeConfig);
      } else {
        // 全局未解析 → 路由级解析
        const routeBodyParser = (
          req as { _routeBodyParser?: VextBodyParserConfig }
        )._routeBodyParser;
        const maxBodyBytes = resolveBodyParserMaxBytes(
          globalBodyParser ?? {},
          routeBodyParser,
        );
        req.files = await parseMultipart(
          req,
          contentType,
          mergedConfig,
          maxBodyBytes,
        );
        assertRequiredMultipartFiles(req.files, routeConfig);
      }
    } catch (err: unknown) {
      const httpErr = err as { status?: number; message?: string };
      res.rawJson(
        {
          code: httpErr.status ?? 400,
          message: httpErr.message ?? "Bad Request: multipart parse error",
          requestId: req.requestId,
        },
        (httpErr.status ?? 400) as 400 | 413 | 415,
      );
      return;
    }

    await next();
  };
}

function assertRequiredMultipartFiles(
  files: ParsedFile[],
  routeConfig: MultipartRouteConfig,
): void {
  const requiredFields = getRequiredMultipartFileFields(routeConfig);
  if (requiredFields.length === 0) return;

  const presentFields = new Set(files.map((file) => file.fieldname));
  const missing = requiredFields.filter((field) => !presentFields.has(field));
  if (missing.length === 0) return;

  throw {
    status: 400,
    message: `Missing required multipart file field(s): ${missing.join(", ")}`,
  };
}

function getRequiredMultipartFileFields(
  routeConfig: MultipartRouteConfig,
): string[] {
  return Object.entries(routeConfig.files ?? {})
    .filter(([, fieldConfig]) => {
      return typeof fieldConfig === "object" && fieldConfig.required === true;
    })
    .map(([field]) => field);
}
