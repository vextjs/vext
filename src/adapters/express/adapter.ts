import express from "express";
import type {
  Express,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import crypto from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createVextRequest } from "./request.js";
import { createVextResponse } from "./response.js";
import { requestContext } from "../../lib/request-context.js";
import { createAuthContextSnapshot } from "../../lib/auth.js";
import { markHandlerDone } from "../../lib/handler-completion.js";
import type {
  VextAdapter,
  VextAdapterListenOptions,
  VextServerHandle,
} from "../../types/adapter.js";
import type { VextApp } from "../../types/app.js";
import type {
  VextMiddleware,
  VextErrorMiddleware,
} from "../../types/middleware.js";
import type { VextRequest } from "../../types/request.js";
import type { VextResponse } from "../../types/response.js";
import type { RouteOptions, VextBodyParserConfig } from "../../types/app.js";
import {
  createPayloadTooLargeError,
  isPayloadTooLargeError,
  resolveAdapterBodyLimitBytes,
  resolveRouteBodyParserConfig,
} from "../../lib/middlewares/body-parser.js";
import {
  applyServerConfig,
  createNodeServerOptions,
} from "../../lib/server-config.js";

/**
 * Express Adapter 选项
 *
 * 用户通过 expressAdapter(options) 工厂函数传入，
 * 控制 Express 实例的初始化行为。
 *
 * 所有选项均可选，默认值已为 vext 场景优化。
 */
export interface ExpressAdapterOptions {
  /**
   * 请求体大小限制（字符串格式，如 '1mb'）
   * 仅在预收集 rawBody 时用作参考上限。
   * 实际的 body 大小限制由 vext body-parser 中间件控制。
   *
   * @default '1mb'
   */
  bodyLimit?: string;
}

/**
 * 中间件链执行器（洋葱模型）
 *
 * 按顺序执行中间件链中的每个中间件，
 * 每个中间件通过 await next() 调用下一个中间件。
 * next() 返回后可执行 after-middleware 逻辑（洋葱模型回溯）。
 *
 * 逻辑与 Hono / Fastify / Koa Adapter 的 executeChain 完全一致，
 * 确保所有 Adapter 的中间件执行语义相同。
 *
 * 🆕 性能优化：使用递归调度函数替代每请求创建闭包。
 * dispatch 函数通过参数传递 index，避免在闭包中捕获可变变量，
 * V8 对固定参数签名的函数有更好的内联优化。
 *
 * @param chain 中间件执行链（已组装完毕，含全局 + 路由级 + validate + handler）
 * @param req   VextRequest 实例
 * @param res   VextResponse 实例
 */
async function executeChain(
  chain: VextMiddleware[],
  req: VextRequest,
  res: VextResponse,
): Promise<void> {
  const len = chain.length;

  if (len === 1) {
    await chain[0]!(req, res, _noop);
    return;
  }

  if (len === 2) {
    await chain[0]!(req, res, async () => {
      await chain[1]!(req, res, _noop);
    });
    return;
  }

  if (len === 3) {
    await chain[0]!(req, res, async () => {
      await chain[1]!(req, res, async () => {
        await chain[2]!(req, res, _noop);
      });
    });
    return;
  }

  if (len === 4) {
    await chain[0]!(req, res, async () => {
      await chain[1]!(req, res, async () => {
        await chain[2]!(req, res, async () => {
          await chain[3]!(req, res, _noop);
        });
      });
    });
    return;
  }

  async function dispatch(i: number): Promise<void> {
    if (i >= len) return;
    const middleware = chain[i]!;
    await middleware(req, res, () => dispatch(i + 1));
  }

  await dispatch(0);
}

const _noop = async (): Promise<void> => {};

/**
 * 从 Express 请求流中收集原始请求体为 Buffer
 *
 * Express 默认使用内置的 body-parser 中间件解析请求体，
 * 但 vext 有自己的 body-parser 中间件（在中间件链中执行）。
 * 为避免冲突，adapter 不注册任何 Express body-parser，
 * 而是在路由 handler 执行前手动收集原始 body。
 *
 * 对于 GET/HEAD 等无 body 的方法，跳过收集返回空 Buffer。
 *
 * @param req Express Request（Node.js IncomingMessage）
 * @returns 原始请求体 Buffer
 */
function collectRawBody(
  req: ExpressRequest,
  maxBytes?: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const method = (req.method ?? "GET").toUpperCase();
    // GET 和 HEAD 请求不应有 body
    if (method === "GET" || method === "HEAD") {
      resolve(Buffer.alloc(0));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bufferChunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        settled = true;
        reject(createPayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(bufferChunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * createExpressAdapter — 创建基于 Express 的 VextAdapter 实例
 *
 * 将 Express 作为底层 HTTP 框架，实现 VextAdapter 接口。
 * 这是 VextAdapter 的第三个实现（第一个 Hono，第二个 Fastify），
 * 用于验证 Adapter 抽象层的完备性和通用性。
 *
 * 架构说明：
 *   - Express 用于路由匹配，不使用 Express 自带的中间件机制
 *   - 中间件链执行由 vext 自己的 executeChain 实现（洋葱模型）
 *   - 请求 / 响应对象在 Express route handler 内转换为 VextRequest / VextResponse
 *   - 全局中间件通过 registerMiddleware() 收集，在每个路由执行时拼接到链头
 *
 * 与 Hono / Fastify Adapter 的核心差异：
 *   - 请求/响应模型：Express 直接操作 Node.js 原生对象（IncomingMessage/ServerResponse），
 *     增强为 Express.Request/Express.Response（添加 query / params / 便捷方法）
 *   - Body 解析：不注册任何 Express body-parser，通过手动收集 req stream 为 Buffer，
 *     传给 createVextRequest 的 rawBody 参数，由 vext body-parser 中间件统一处理
 *   - JSON 序列化：使用 expressRes.end(JSON.stringify(...)) 手动序列化，
 *     绕过 Express 的 res.json() 自动处理，保证跨 Adapter 行为一致
 *   - buildHandler：Express app 本身就是 (req, res, next) 函数，
 *     可直接作为 Node.js requestListener 使用
 *
 * HTTP 服务器：
 *   - Express 不内置 HTTP server 创建（与 Fastify 不同），
 *     adapter 使用 Node.js 原生 http.createServer(app)
 *   - listen() 创建 http.createServer 并调用 server.listen()
 *   - close() 调用 server.close()
 *   - buildHandler() 返回 Express app 作为 Node.js handler，
 *     用于 dev 模式热重载的 HotSwappableHandler 原子替换
 *
 * @param options Express 适配器配置选项
 * @param app     VextApp 实例（用于传递给 createVextRequest 的 app 引用）
 * @returns VextAdapter 实例
 *
 * @see adapters/hono/adapter.ts（Hono Adapter 对应实现）
 * @see adapters/fastify/adapter.ts（Fastify Adapter 对应实现）
 */
export function createExpressAdapter(
  options: ExpressAdapterOptions,
  app: VextApp,
): VextAdapter {
  // ── 创建 Express 实例 ────────────────────────────────────
  //
  // 关键配置：
  //   - 不使用 Express 内置 body-parser（express.json / express.urlencoded）
  //   - 不启用 Express 的 trust proxy（vext 有自己的 trustProxy 逻辑）
  //   - 禁用 x-powered-by 响应头（安全最佳实践）
  //   - 禁用 ETag（vext 框架不使用 Express 自动 ETag）
  //
  const expressApp: Express = express();

  // 安全：移除 X-Powered-By 响应头
  expressApp.disable("x-powered-by");

  // 禁用 ETag 自动生成（vext 不使用 Express ETag 机制）
  expressApp.disable("etag");

  // ── 🆕 5.7: 缓存 ALS 开关（避免热路径重复读取 config）────
  const alsEnabled = app.config.requestContext?.enabled !== false;

  // ── 全局状态 ──────────────────────────────────────────────

  /** 全局中间件列表（通过 registerMiddleware 收集，在每个路由执行时拼接到链头） */
  const globalMiddlewares: VextMiddleware[] = [];

  /** 错误处理函数（通过 registerErrorHandler 注册） */
  let errorHandler: VextErrorMiddleware | null = null;

  /** 404 处理函数（通过 registerNotFound 注册） */
  let notFoundHandler: VextMiddleware | null = null;

  /** 是否已注册兜底中间件（404 + error，只注册一次） */
  let _fallbacksRegistered = false;

  /**
   * 注册 Express 兜底中间件（404 + 错误处理）
   *
   * Express 的中间件顺序敏感：
   *   - 路由必须先于 404 兜底注册
   *   - 404 兜底必须先于错误处理中间件注册
   *
   * 此方法在 listen() / buildHandler() 调用时触发，
   * 确保所有路由已注册完毕后再挂载兜底中间件。
   */
  function registerFallbacks(): void {
    if (_fallbacksRegistered) return;
    _fallbacksRegistered = true;

    // ── 404 兜底 ───────────────────────────────────────────
    //
    // Express 中，当没有路由匹配时，请求会穿透所有 route handler，
    // 到达 use() 注册的「无路径」中间件。在此处执行 vext 的 notFoundHandler。
    //
    expressApp.use(
      async (
        expressReq: ExpressRequest,
        expressRes: ExpressResponse,
        _next: express.NextFunction,
      ) => {
        if (!notFoundHandler) {
          // 默认 404 响应
          expressRes.statusCode = 404;
          expressRes.setHeader(
            "Content-Type",
            "application/json; charset=utf-8",
          );
          expressRes.end(JSON.stringify({ code: 404, message: "Not Found" }));
          return;
        }

        const routeBodyParser = undefined;
        const maxBodyBytes = resolveAdapterBodyLimitBytes({
          globalBodyParser: app.config.bodyParser,
          routeBodyParser,
          multipart: app.config.multipart,
          adapterBodyLimit: options.bodyLimit,
        });
        let rawBody: Buffer;
        try {
          rawBody = await collectRawBody(expressReq, maxBodyBytes);
        } catch (error) {
          if (isPayloadTooLargeError(error)) {
            expressRes.status(413).json({
              error: "Payload Too Large",
              message: `Request body exceeds maximum size of ${maxBodyBytes} bytes`,
            });
            return;
          }
          throw error;
        }
        const req = createVextRequest(expressReq, app, rawBody);
        if (routeBodyParser) {
          (
            req as { _routeBodyParser?: VextBodyParserConfig }
          )._routeBodyParser = routeBodyParser;
        }

        // notFound 不经过中间件链，requestId 中间件不会执行。
        // 内联生成 requestId，确保 404 响应也有有效的 requestId
        if (!req.requestId) {
          const headerName = app.config.requestId?.header ?? "x-request-id";
          req.requestId =
            (req.headers[headerName] as string) || crypto.randomUUID();
        }

        const res = createVextResponse(expressRes, () => req.requestId, req);
        res._hooks = app.hooks;
        res._hideInternalErrors =
          app.config.response?.hideInternalErrors ?? true;

        // 🆕 5.7: ALS 可配置跳过
        const runNotFound = async () => {
          const noop = async (): Promise<void> => {};
          try {
            await notFoundHandler!(req, res, noop);
          } finally {
            res._flush?.();
          }
        };

        const completion = Promise.resolve().then(() =>
          alsEnabled
            ? requestContext.run(
                {
                  requestId: req.requestId,
                  locale: undefined,
                  auth: createAuthContextSnapshot(req.auth),
                },
                runNotFound,
              )
            : runNotFound(),
        );
        markHandlerDone(expressRes, completion);
        await completion;
      },
    );

    // ── 错误处理 ───────────────────────────────────────────
    //
    // Express 的错误处理中间件必须有 4 个参数 (err, req, res, next)。
    // 当路由 handler 中 next(err) 或抛出异常时，Express 将错误传递到此处。
    //
    // 注意：由于 vext 的 executeChain 内部已经 try-catch 并调用 errorHandler，
    // 正常情况下错误不会到达这里。这是一层额外保护，
    // 处理 executeChain 之外的极端情况（如 rawBody 收集失败）。
    //
    expressApp.use(
      (
        err: unknown,
        expressReq: ExpressRequest,
        expressRes: ExpressResponse,
        _next: express.NextFunction,
      ) => {
        if (errorHandler) {
          try {
            const req = createVextRequest(expressReq, app);

            if (!req.requestId) {
              const headerName = app.config.requestId?.header ?? "x-request-id";
              req.requestId =
                (req.headers[headerName] as string) || crypto.randomUUID();
            }

            const res = createVextResponse(
              expressRes,
              () => req.requestId,
              req,
            );
            res._hooks = app.hooks;
            res._hideInternalErrors =
              app.config.response?.hideInternalErrors ?? true;

            errorHandler(err, req, res);
            res._flush?.();
          } catch {
            // errorHandler 自身也失败了，发送最低限度的 500 响应
            if (!expressRes.headersSent) {
              expressRes.statusCode = 500;
              expressRes.setHeader(
                "Content-Type",
                "application/json; charset=utf-8",
              );
              expressRes.end(
                JSON.stringify({ code: 500, message: "Internal Server Error" }),
              );
            }
          }
        } else {
          // 没有 errorHandler，发送默认 500 响应
          if (!expressRes.headersSent) {
            expressRes.statusCode = 500;
            expressRes.setHeader(
              "Content-Type",
              "application/json; charset=utf-8",
            );
            expressRes.end(
              JSON.stringify({ code: 500, message: "Internal Server Error" }),
            );
          }
        }
      },
    );
  }

  return {
    name: "express",

    // ── registerMiddleware ───────────────────────────────────
    //
    // 收集全局中间件。bootstrap 步骤⑥中注册的内置中间件
    // （requestId / cors / body-parser / rate-limit / response-wrapper / access-log）
    // 和插件通过 app.use() 注册的中间件都通过此方法收集。
    //
    // 执行时机：在每个路由的 handler 中，全局中间件拼接在路由级中间件之前执行。
    //
    registerMiddleware(middleware: VextMiddleware): void {
      globalMiddlewares.push(middleware);
    },

    // ── registerRoute ───────────────────────────────────────
    //
    // 为每条路由注册 Express handler。
    //
    // 流程：
    //   1. 将 HTTP 方法转为小写（Express API 使用小写方法名）
    //   2. 路由路径参数格式：vext 使用 :param，Express 也使用 :param，无需转换
    //   3. 在 handler 中收集 rawBody、创建 VextRequest / VextResponse
    //   4. 在 AsyncLocalStorage 请求上下文中执行 executeChain
    //   5. 全局中间件 + 路由级中间件 + validate + handler 组成完整链
    //
    // 错误处理：
    //   - executeChain 抛出异常时，由 errorHandler 处理
    //   - errorHandler 自身也可能抛出异常（如 logger 写入失败），
    //     此时发送最低限度的 500 JSON 响应
    //
    registerRoute(
      method: string,
      path: string,
      chain: VextMiddleware[],
      routeOptions: RouteOptions = {},
    ): void {
      // 🆕 性能优化：延迟预组装中间件链
      // 注册路由时 globalMiddlewares 尚未完成收集（bootstrap 步骤⑥在步骤⑤之后），
      // 因此在首次请求时组装并缓存，后续请求直接复用。
      let prebuiltChain: VextMiddleware[] | null = null;

      // Express 使用小写方法名（get / post / put / patch / delete / head / options）
      const expressMethod = method.toLowerCase() as
        | "get"
        | "post"
        | "put"
        | "patch"
        | "delete"
        | "head"
        | "options";

      // vext 路由参数格式（:param）与 Express 格式一致，无需转换
      const expressPath = path;

      expressApp[expressMethod](
        expressPath,
        async (
          expressReq: ExpressRequest,
          expressRes: ExpressResponse,
          next: express.NextFunction,
        ) => {
          try {
            // 手动收集原始请求体（避免与 Express body-parser 冲突）
            const routeBodyParser = resolveRouteBodyParserConfig(routeOptions);
            const maxBodyBytes = resolveAdapterBodyLimitBytes({
              globalBodyParser: app.config.bodyParser,
              routeBodyParser,
              multipart: app.config.multipart,
              adapterBodyLimit: options.bodyLimit,
            });
            let rawBody: Buffer;
            try {
              rawBody = await collectRawBody(expressReq, maxBodyBytes);
            } catch (error) {
              if (isPayloadTooLargeError(error)) {
                expressRes.status(413).json({
                  error: "Payload Too Large",
                  message: `Request body exceeds maximum size of ${maxBodyBytes} bytes`,
                });
                return;
              }
              throw error;
            }
            const req = createVextRequest(expressReq, app, rawBody);
            (req as { _routeOptions?: RouteOptions })._routeOptions =
              routeOptions;
            if (routeBodyParser) {
              (
                req as { _routeBodyParser?: VextBodyParserConfig }
              )._routeBodyParser = routeBodyParser;
            }
            // F-01: 注入路由模板字符串（低基数，适合 OTEL/Prometheus 指标标签）
            // expressPath 是 registerRoute 的参数，在此 closure 中直接可访问
            req.route = expressPath;

            // 延迟绑定 requestId：传入 getter 确保 json() 实际调用时才取值
            // 此时 requestId 必然已由 requestIdMiddleware 设置到 req.requestId
            const res = createVextResponse(
              expressRes,
              () => req.requestId,
              req,
              routeOptions,
              method,
            );
            res._hooks = app.hooks;
            res._hideInternalErrors =
              app.config.response?.hideInternalErrors ?? true;

            // 在 AsyncLocalStorage 请求上下文中执行整个中间件链
            // 确保 app.throw 等内部方法能通过 requestContext.getStore() 访问请求级数据
            //
            // 🆕 5.7: 当 requestContext.enabled === false 时跳过 ALS 包裹，
            // 直接执行中间件链；实际性能影响取决于 Node.js 版本与业务负载。
            //
            const runChain = async () => {
              try {
                // 🆕 预组装中间件链（首次请求时组装，后续复用）
                if (prebuiltChain === null) {
                  prebuiltChain = globalMiddlewares.concat(chain);
                }
                await executeChain(prebuiltChain, req, res);
              } catch (err) {
                if (errorHandler) {
                  // errorHandler 自身抛异常的边界保护
                  // 防止 errorHandler 内部失败（如 logger 写入 DB transport 失败）
                  // 导致异常传播到 Express 的错误处理，产生非 JSON 的响应
                  try {
                    errorHandler(err, req, res);
                  } catch (handlerError) {
                    try {
                      res.rawJson(
                        { code: 500, message: "Internal Server Error" },
                        500,
                      );
                    } catch {
                      // 完全放弃，让 Express 的兜底处理
                      next(handlerError);
                    }
                  }
                } else {
                  next(err);
                }
              } finally {
                res._flush?.();
              }
            };

            const completion = Promise.resolve().then(() =>
              alsEnabled
                ? requestContext.run(
                    {
                      requestId: "",
                      locale: undefined,
                      auth: createAuthContextSnapshot(req.auth),
                    },
                    runChain,
                  )
                : runChain(),
            );
            markHandlerDone(expressRes, completion);
            await completion;
          } catch (err) {
            // rawBody 收集或其他初始化错误
            next(err);
          }
        },
      );
    },

    // ── registerErrorHandler ────────────────────────────────
    //
    // 注册全局错误处理函数。
    //
    // 与 Hono / Fastify 不同，Express 的错误处理中间件是通过
    // app.use((err, req, res, next) => ...) 注册的 4 参数中间件。
    //
    // 这里仅保存 handler 引用，实际的 Express 错误中间件
    // 在 registerFallbacks() 中注册（确保在所有路由之后）。
    //
    registerErrorHandler(handler: VextErrorMiddleware): void {
      errorHandler = handler;
    },

    // ── registerNotFound ────────────────────────────────────
    //
    // 注册 404 兜底处理函数。
    //
    // 当没有任何路由匹配时，Express 会将请求传递到后续的 use() 中间件。
    // 实际的 Express 404 中间件在 registerFallbacks() 中注册。
    //
    registerNotFound(handler: VextMiddleware): void {
      notFoundHandler = handler;
    },

    // ── listen ──────────────────────────────────────────────
    //
    // 启动 HTTP 服务器。
    //
    // 流程：
    //   1. 注册兜底中间件（404 + 错误处理）
    //   2. 创建 Node.js HTTP server（Express 不内置 server 创建）
    //   3. 调用 server.listen() 开始监听端口
    //   4. 返回 VextServerHandle（含 close / port / host）
    //
    async listen(
      port: number,
      host: string = "0.0.0.0",
      options?: VextAdapterListenOptions,
    ): Promise<VextServerHandle> {
      // 注册兜底中间件（确保在所有路由之后）
      registerFallbacks();

      const server = createServer(
        createNodeServerOptions(options?.server),
        expressApp,
      );
      applyServerConfig(server, options?.server);

      return new Promise<VextServerHandle>((resolve, reject) => {
        server.on("error", (err) => {
          reject(err);
        });

        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort =
            typeof addr === "object" && addr !== null ? addr.port : port;
          const actualHost =
            typeof addr === "object" && addr !== null
              ? (addr.address ?? host)
              : host;

          resolve({
            port: actualPort,
            host: actualHost,

            close(): Promise<void> {
              return new Promise<void>((resolveClose, rejectClose) => {
                server.close((err) => {
                  if (err) {
                    rejectClose(err);
                  } else {
                    resolveClose();
                  }
                });
              });
            },
          });
        });
      });
    },

    // ── buildHandler ────────────────────────────────────────
    //
    // 构建完整的请求处理函数（不启动 server）。
    //
    // Express app 本身就是一个 (req, res) => void 函数，
    // 可以直接作为 Node.js http.createServer 的 requestListener。
    //
    // 用途：dev 模式下 Hot Reload 每次创建 fresh adapter 后调用
    // buildHandler() 获取新 handler，由 HotSwappableHandler 原子替换。
    //
    // 约定：调用 buildHandler() 前必须确保：
    //   1. 所有 registerRoute / registerMiddleware / registerErrorHandler / registerNotFound 已完成
    //   2. 兜底中间件已注册
    //
    buildHandler(): (req: IncomingMessage, res: ServerResponse) => void {
      // 注册兜底中间件（确保在所有路由之后）
      registerFallbacks();

      // Express app 兼容 (req, res) => void 签名
      return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
        expressApp(nodeReq, nodeRes);
      };
    },
  };
}
