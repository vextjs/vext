import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import crypto from "node:crypto";
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
  resolveAdapterBodyLimitBytes,
  resolveRouteBodyParserConfig,
} from "../../lib/middlewares/body-parser.js";
import {
  applyServerConfig,
  createNodeServerOptions,
  hasServerConfig,
} from "../../lib/server-config.js";

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Fastify Adapter 选项
 *
 * 用户通过 fastifyAdapter(options) 工厂函数传入，
 * 控制 Fastify 实例的初始化行为。
 *
 * 所有选项均可选，默认值已为 vext 场景优化：
 *   - logger: false（vext 有自己的 logger）
 *   - pluginTimeout: 10000ms
 *   - bodyLimit: 1MB
 *   - ignoreTrailingSlash: true
 *   - caseSensitive: false
 */
export interface FastifyAdapterOptions {
  /** Fastify 内置日志（默认 false，vext 有自己的 logger） */
  logger?: boolean;

  /**
   * Fastify 插件超时（毫秒，默认 10000）
   * Fastify 内部 register 的超时，与 vext plugin-loader 超时独立
   */
  pluginTimeout?: number;

  /**
   * 请求体大小限制（字节，默认 1MB）
   * 对应 Fastify 的 bodyLimit
   */
  bodyLimit?: number;

  /**
   * 忽略尾部斜杠（默认 true）
   * /users 和 /users/ 视为相同路由
   */
  ignoreTrailingSlash?: boolean;

  /**
   * 大小写敏感（默认 false）
   * /Users 和 /users 视为相同路由
   */
  caseSensitive?: boolean;
}

/**
 * 中间件链执行器（洋葱模型）
 *
 * 按顺序执行中间件链中的每个中间件，
 * 每个中间件通过 await next() 调用下一个中间件。
 * next() 返回后可执行 after-middleware 逻辑（洋葱模型回溯）。
 *
 * 逻辑与 Hono Adapter 的 executeChain 完全一致，
 * 确保两个 Adapter 的中间件执行语义相同。
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
 * createFastifyAdapter — 创建基于 Fastify 的 VextAdapter 实例
 *
 * 将 Fastify 作为底层 HTTP 框架，实现 VextAdapter 接口。
 * 这是 VextAdapter 的第二个实现（第一个是 Hono Adapter），
 * 用于验证 Adapter 抽象层的完备性。
 *
 * 架构说明：
 *   - Fastify 用于路由匹配（find-my-way radix tree），不使用 Fastify 自带的中间件/Hook 机制
 *   - 中间件链执行由 vext 自己的 executeChain 实现（洋葱模型）
 *   - 请求 / 响应对象在 Fastify route handler 内转换为 VextRequest / VextResponse
 *   - 全局中间件通过 registerMiddleware() 收集，在每个路由执行时拼接到链头
 *
 * 与 Hono Adapter 的核心差异：
 *   - 请求/响应模型：Fastify 直接操作 Node.js 原生对象（IncomingMessage/ServerResponse），
 *     而 Hono 操作 Web API（Request/Response）
 *   - Body 解析：Fastify 默认自动解析 JSON，需要通过 removeAllContentTypeParsers
 *     禁用以避免与 vext body-parser 冲突
 *   - JSON 序列化：使用 reply.send(JSON.stringify(...)) 手动序列化，
 *     绕过 Fastify 的 fast-json-stringify 自动序列化，保证跨 Adapter 行为一致
 *   - buildHandler：Fastify 提供 fastify.routing(req, res)，
 *     是标准的 Node.js (IncomingMessage, ServerResponse) handler
 *
 * HTTP 服务器：
 *   - Fastify 内置 Node.js http.createServer
 *   - listen() 调用 fastify.listen() 启动服务器
 *   - close() 调用 fastify.close() 优雅关闭
 *   - buildHandler() 返回 fastify.routing 作为 Node.js handler，
 *     用于 dev 模式热重载的 HotSwappableHandler 原子替换
 *
 * @param options Fastify 适配器配置选项
 * @param app     VextApp 实例（用于传递给 createVextRequest 的 app 引用）
 * @returns VextAdapter 实例
 *
 * @see 08a-fastify-adapter.md §3（Adapter 核心实现）
 * @see adapters/hono/adapter.ts（Hono Adapter 对应实现）
 * @see IMPLEMENTATION-PLAN.md 任务 3.4
 */
export function createFastifyAdapter(
  options: FastifyAdapterOptions,
  app: VextApp,
): VextAdapter {
  // ── 创建 Fastify 实例 ────────────────────────────────────
  //
  // 关键配置：
  //   - logger: false — vext 有自己的 logger，不使用 Fastify 的内置日志
  //   - pluginTimeout — Fastify 内部 register 的超时
  //   - bodyLimit — 请求体大小上限（Fastify 层面的保护，vext body-parser 有独立的检查）
  //   - ignoreTrailingSlash: true — /users 和 /users/ 等价
  //   - caseSensitive: false — /Users 和 /users 等价
  //
  const defaultBodyLimit = resolveAdapterBodyLimitBytes({
    globalBodyParser: app.config.bodyParser,
    multipart: app.config.multipart,
    adapterBodyLimit: options.bodyLimit,
  });
  const serverConfig = app.config.server;
  const serverFactory = hasServerConfig(serverConfig)
    ? (handler: NodeRequestHandler): Server => {
        const server = createServer(
          createNodeServerOptions(serverConfig),
          handler,
        );
        applyServerConfig(server, serverConfig);
        return server;
      }
    : undefined;

  const fastify: FastifyInstance = Fastify({
    logger: options.logger ?? false,
    pluginTimeout: options.pluginTimeout ?? 10000,
    bodyLimit: defaultBodyLimit,
    exposeHeadRoutes: true,
    ...(serverFactory ? { serverFactory } : {}),
    // Fastify v5 要求路由器选项通过 routerOptions 传递（FSTDEP022）
    // 直接传 ignoreTrailingSlash / caseSensitive 在 v5 仍可用但会触发 deprecation warning，
    // v6 将彻底移除顶层支持。
    routerOptions: {
      ignoreTrailingSlash: options.ignoreTrailingSlash ?? true,
      caseSensitive: options.caseSensitive ?? false,
    },
  });

  // ── 🆕 5.7: 缓存 ALS 开关（避免热路径重复读取 config）────
  const alsEnabled = app.config.requestContext?.enabled !== false;

  // ── 全局状态 ──────────────────────────────────────────────

  /** 全局中间件列表（通过 registerMiddleware 收集，在每个路由执行时拼接到链头） */
  const globalMiddlewares: VextMiddleware[] = [];

  /** 错误处理函数（通过 registerErrorHandler 注册） */
  let errorHandler: VextErrorMiddleware | null = null;

  /** 是否已完成 fastify.ready()（buildHandler 需要此保证） */
  let _ready = false;

  // ── 禁用 Fastify 内置 body 解析 ──────────────────────────
  //
  // Fastify 默认注册 application/json 和 text/plain 的 content-type parser，
  // 会在路由 handler 执行前自动解析请求体。但 vext 有自己的 body-parser 中间件
  // （在中间件链中执行），两者会冲突。
  //
  // 解决方案：移除所有内置解析器，注册通用解析器，
  // 将原始 body 以 Buffer 形式传递给 vext 中间件处理。
  //
  // body-parser 中间件通过 (req as any)._getRawBody() 读取此 Buffer 并转为 string 解析。
  //
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: null, body: Buffer) => void,
    ) => {
      done(null, body);
    },
  );

  return {
    name: "fastify",

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
    // 为每条路由注册 Fastify handler。
    //
    // 流程：
    //   1. 将 HTTP 方法转为小写（Fastify API 使用小写方法名）
    //   2. 将路由路径参数格式转换（vext 和 Fastify v5 都使用 :param 格式，无需转换）
    //   3. 在 handler 中创建 VextRequest / VextResponse
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

      // Fastify 使用小写方法名（get / post / put / patch / delete / head / options）
      const fastifyMethod = method.toLowerCase() as
        | "get"
        | "post"
        | "put"
        | "patch"
        | "delete"
        | "head"
        | "options";

      const wildcardName = getNamedWildcardParam(path);
      const fastifyPath = toFastifyRoutePath(path);
      const routeBodyParser = resolveRouteBodyParserConfig(routeOptions);
      const routeBodyLimit = resolveAdapterBodyLimitBytes({
        globalBodyParser: app.config.bodyParser,
        routeBodyParser,
        multipart: app.config.multipart,
        adapterBodyLimit: options.bodyLimit,
      });

      fastify[fastifyMethod](
        fastifyPath,
        { bodyLimit: routeBodyLimit },
        async (request: FastifyRequest, reply: FastifyReply) => {
          const req = createVextRequest(request, app);
          if (wildcardName) {
            const params = req.params as Record<string, string | undefined>;
            const wildcardValue = params["*"];
            if (wildcardValue !== undefined) {
              params[wildcardName] = wildcardValue;
            }
          }
          (req as { _routeOptions?: RouteOptions })._routeOptions =
            routeOptions;
          if (routeBodyParser) {
            (
              req as { _routeBodyParser?: VextBodyParserConfig }
            )._routeBodyParser = routeBodyParser;
          }
          req.route = path;

          // 延迟绑定 requestId：传入 getter 确保 json() 实际调用时才取值
          // 此时 requestId 必然已由 requestIdMiddleware 设置到 req.requestId
          const res = createVextResponse(
            reply,
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
                // 导致异常传播到 Fastify 的错误处理，产生非 JSON 的响应
                try {
                  errorHandler(err, req, res);
                } catch (handlerError) {
                  try {
                    res.rawJson(
                      { code: 500, message: "Internal Server Error" },
                      500,
                    );
                  } catch {
                    // 完全放弃，让 Fastify 的兜底处理
                    throw handlerError;
                  }
                }
              } else {
                throw err;
              }
            } finally {
              // Flush deferred body so post-next setHeader/cookie still apply.
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
          markHandlerDone(reply.raw, completion);
          await completion;
          // Fastify async handlers must return/await the reply when send() may
          // happen after the handler chain resolves (for example React SSR
          // calls res.stream() from onShellReady on a later turn).
          return reply;
        },
      );
    },

    // ── registerErrorHandler ────────────────────────────────
    //
    // 注册全局错误处理函数。
    //
    // 同时注册到 Fastify 的 setErrorHandler，
    // 捕获 Fastify 内部抛出的错误（如路由匹配中间的异常等）。
    // 这确保了即使在 Fastify 内部流程中发生错误，也能返回统一的 JSON 格式。
    //
    registerErrorHandler(handler: VextErrorMiddleware): void {
      errorHandler = handler;

      fastify.setErrorHandler(
        async (error: Error, request: FastifyRequest, reply: FastifyReply) => {
          const req = createVextRequest(request, app);

          // notFound / errorHandler 不走中间件链，requestId 中间件不会执行。
          // 内联生成 requestId，确保错误响应也有有效的 requestId
          if (!req.requestId) {
            const headerName = app.config.requestId?.header ?? "x-request-id";
            req.requestId =
              (req.headers[headerName] as string) || crypto.randomUUID();
          }

          const res = createVextResponse(reply, () => req.requestId, req);
          res._hooks = app.hooks;
          res._hideInternalErrors =
            app.config.response?.hideInternalErrors ?? true;

          const statusCode = (error as { statusCode?: unknown }).statusCode;
          if (statusCode === 413) {
            res.rawJson(
              {
                code: 413,
                message: "Payload Too Large",
                requestId: req.requestId,
              },
              413,
            );
            res._flush?.();
            return;
          }

          try {
            handler(error, req, res);
          } catch (_handlerError) {
            try {
              res.rawJson({ code: 500, message: "Internal Server Error" }, 500);
            } catch {
              reply.status(500).send("Internal Server Error");
              return;
            }
          }
          res._flush?.();
        },
      );
    },

    // ── registerNotFound ────────────────────────────────────
    //
    // 注册 404 兜底处理函数。
    //
    // 当没有任何路由匹配时执行此处理函数。
    // 使用 Fastify 的 setNotFoundHandler，在 Fastify 路由匹配失败时触发。
    //
    // 注意：notFound 不经过中间件链，requestId 中间件不会执行。
    // 需要内联生成 requestId，确保 404 响应也有有效的 requestId。
    //
    registerNotFound(handler: VextMiddleware): void {
      fastify.setNotFoundHandler(
        async (request: FastifyRequest, reply: FastifyReply) => {
          const req = createVextRequest(request, app);

          // 内联生成 requestId（notFound 不走中间件链）
          if (!req.requestId) {
            const headerName = app.config.requestId?.header ?? "x-request-id";
            req.requestId =
              (req.headers[headerName] as string) || crypto.randomUUID();
          }

          const res = createVextResponse(reply, () => req.requestId, req);
          res._hooks = app.hooks;
          res._hideInternalErrors =
            app.config.response?.hideInternalErrors ?? true;

          // 🆕 5.7: ALS 可配置跳过
          const runNotFound = async () => {
            const noop = async (): Promise<void> => {};
            try {
              await handler(req, res, noop);
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
          markHandlerDone(reply.raw, completion);
          await completion;
          return reply;
        },
      );
    },

    // ── listen ──────────────────────────────────────────────
    //
    // 启动 HTTP 服务器。
    //
    // 流程：
    //   1. 调用 fastify.ready() 确保所有路由和插件注册完成
    //   2. 调用 fastify.listen() 开始监听端口
    //   3. 返回 VextServerHandle（含 close / port / host）
    //
    // Fastify 内置了 Node.js http.createServer，无需手动创建。
    //
    async listen(
      port: number,
      host: string = "0.0.0.0",
      options?: VextAdapterListenOptions,
    ): Promise<VextServerHandle> {
      // 确保所有路由和插件注册完成
      await fastify.ready();
      _ready = true;
      applyServerConfig(fastify.server, options?.server);

      // Fastify listen 返回监听地址字符串（如 http://0.0.0.0:3000）
      await fastify.listen({ port, host });

      // 从 Fastify server 获取实际端口（当传入 port=0 时获取系统分配的端口）
      const addr = fastify.server.address();
      const actualPort =
        typeof addr === "object" && addr !== null ? addr.port : port;
      const actualHost =
        typeof addr === "object" && addr !== null
          ? (addr.address ?? host)
          : host;

      return {
        port: actualPort,
        host: actualHost,

        async close(): Promise<void> {
          await fastify.close();
        },
      };
    },

    // ── buildHandler ────────────────────────────────────────
    //
    // 构建完整的请求处理函数（不启动 server）。
    //
    // 在所有路由 / 中间件注册完成后调用。
    // 返回的 handler 接受原始 Node.js req/res。
    //
    // 用途：dev 模式下 Hot Reload 每次创建 fresh adapter 后调用
    // buildHandler() 获取新 handler，由 HotSwappableHandler 原子替换。
    //
    // Fastify 提供 fastify.routing(req, res) 方法，
    // 它是 Fastify 内部的标准 Node.js 请求处理函数，
    // 执行路由匹配 + handler 调用 + 错误处理 + 404 兜底。
    //
    // 约定：调用 buildHandler() 前必须确保：
    //   1. 所有 registerRoute / registerMiddleware / registerErrorHandler / registerNotFound 已完成
    //   2. fastify.ready() 已调用（通过 listen() 或手动调用）
    //
    // 对于 dev 模式热重载场景，框架应在调用 buildHandler() 前确保 ready() 已完成。
    // 如果 ready() 尚未调用，这里会同步返回 routing 函数，
    // 但实际请求处理可能会失败。为安全起见，如果 _ready 为 false，
    // 返回一个包装函数，在首次请求时异步调用 ready()。
    //
    buildHandler(): (req: IncomingMessage, res: ServerResponse) => void {
      if (_ready) {
        // 已 ready，直接返回 Fastify 的路由处理函数
        return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
          fastify.routing(nodeReq, nodeRes);
        };
      }

      // 尚未 ready（通常不应发生，但防御性处理）
      // 返回包装函数，首次调用时触发 ready
      let readyPromise: Promise<void> | null = null;

      return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
        if (!readyPromise) {
          readyPromise = Promise.resolve(fastify.ready()).then(() => {
            _ready = true;
          });
        }

        if (_ready) {
          fastify.routing(nodeReq, nodeRes);
        } else {
          readyPromise!
            .then(() => {
              fastify.routing(nodeReq, nodeRes);
            })
            .catch(() => {
              if (!nodeRes.headersSent) {
                nodeRes.statusCode = 500;
                nodeRes.setHeader("Content-Type", "application/json");
                nodeRes.end(
                  JSON.stringify({
                    code: 500,
                    message: "Internal Server Error: adapter not ready",
                  }),
                );
              }
            });
        }
      };
    },
  };
}

function getNamedWildcardParam(path: string): string | null {
  return /\/\*([A-Za-z_]\w*)$/u.exec(path)?.[1] ?? null;
}

function toFastifyRoutePath(path: string): string {
  return path.replace(/\/\*[A-Za-z_]\w*$/u, "/*");
}
