import Koa from "koa";
import Router from "@koa/router";
import type { Context as KoaContext } from "koa";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
 * Koa Adapter 选项
 *
 * 用户通过 koaAdapter(options) 工厂函数传入，
 * 控制 Koa 实例的初始化行为。
 *
 * 所有选项均可选，默认值已为 vext 场景优化。
 */
export interface KoaAdapterOptions {
  /**
   * 请求体大小限制（字符串格式，如 '1mb'）
   * 仅在预收集 rawBody 时用作参考上限。
   * 实际的 body 大小限制由 vext body-parser 中间件控制。
   *
   * @default '1mb'
   */
  bodyLimit?: string;
}

// ── Koa 路由器说明 ──────────────────────────────────────────
//
// Koa core 不内置路由功能。vext Koa adapter 使用 Koa 生态路由器
// @koa/router 承载 method/path 匹配，adapter 仍负责 VextRequest /
// VextResponse 桥接、body parser、route options 与中间件链执行。

/**
 * 路由条目
 */
interface RouteEntry {
  method: string;
  pattern: string;
  chain: VextMiddleware[];
  fullChain: VextMiddleware[] | null;
  routeOptions: RouteOptions;
}

/**
 * 中间件链执行器（洋葱模型）
 *
 * 按顺序执行中间件链中的每个中间件，
 * 每个中间件通过 await next() 调用下一个中间件。
 * next() 返回后可执行 after-middleware 逻辑（洋葱模型回溯）。
 *
 * 逻辑与 Hono / Fastify / Express Adapter 的 executeChain 完全一致，
 * 确保所有 Adapter 的中间件执行语义相同。
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
 * 从 Node.js 请求流中收集原始请求体为 Buffer
 *
 * Koa 不内置 body 解析（与 Express v4.16+ 不同），
 * 通常需要 koa-bodyparser 中间件。但 vext 有自己的 body-parser 中间件，
 * 所以 adapter 层手动收集原始 body，交给 vext 中间件链处理。
 *
 * 对于 GET/HEAD 等无 body 的方法，跳过收集返回空 Buffer。
 *
 * @param ctx Koa Context（内部使用 ctx.req 即 Node.js IncomingMessage）
 * @returns 原始请求体 Buffer
 */
function collectRawBody(ctx: KoaContext, maxBytes?: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const method = (ctx.method ?? "GET").toUpperCase();
    // GET 和 HEAD 请求不应有 body
    if (method === "GET" || method === "HEAD") {
      resolve(Buffer.alloc(0));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    ctx.req.on("data", (chunk: Buffer) => {
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
    ctx.req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    ctx.req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * 将 vext 路径语法中用于捕获剩余路径的 `*name` 转为 @koa/router
 * 使用的 path-to-regexp 语法。
 */
function toKoaRoutePath(path: string): string {
  return path;
}

function getKoaParams(ctx: KoaContext): Record<string, string> {
  return ((ctx as KoaContext & { params?: Record<string, string> }).params ??
    {}) as Record<string, string>;
}

/**
 * createKoaAdapter — 创建基于 Koa 的 VextAdapter 实例
 *
 * 将 Koa 作为底层 HTTP 框架，实现 VextAdapter 接口。
 * 这是 VextAdapter 的第四个实现（Hono → Fastify → Express → Koa），
 * 用于验证 Adapter 抽象层的完备性和通用性。
 *
 * 架构说明：
 *   - Koa 不内置路由功能，adapter 使用 @koa/router 承载宿主生态路由
 *   - 不使用 Koa 自带的中间件机制（ctx.body / ctx.status 赋值模式）
 *   - 中间件链执行由 vext 自己的 executeChain 实现（洋葱模型）
 *   - 请求 / 响应对象在 Koa middleware 内转换为 VextRequest / VextResponse
 *   - 全局中间件通过 registerMiddleware() 收集，在每个路由执行时拼接到链头
 *   - 所有响应通过 ctx.res（Node.js 原生 ServerResponse）直接操作，
 *     绕过 Koa 的 ctx.body / ctx.status 赋值模式
 *
 * 与其他 Adapter 的核心差异：
 *   - Koa 不内置路由（Express 有 app.get/post/...，Fastify 有 fastify.get/post/...），
 *     通过 @koa/router 提供 Koa 生态路由能力
 *   - Koa 的响应模型是赋值式（ctx.body = ..., ctx.status = ...），
 *     而非 Express/Fastify 的命令式（res.send/reply.send）。
 *     为保持跨 Adapter 一致性，vext 使用 ctx.res（Node.js 原生 ServerResponse）
 *     的 .statusCode / .setHeader / .end() API 直接操作
 *   - Body 解析：不注册任何 Koa body-parser，通过手动收集 ctx.req stream 为 Buffer，
 *     传给 createVextRequest 的 rawBody 参数，由 vext body-parser 中间件统一处理
 *   - buildHandler：Koa app.callback() 返回 (req, res) => void 函数，
 *     可直接作为 Node.js requestListener
 *
 * HTTP 服务器：
 *   - Koa 不内置 HTTP server 创建（与 Fastify 不同），
 *     adapter 使用 Node.js 原生 http.createServer(app.callback())
 *   - listen() 创建 http.createServer 并调用 server.listen()
 *   - close() 调用 server.close()
 *   - buildHandler() 返回 Koa app.callback() 作为 Node.js handler，
 *     用于 dev 模式热重载的 HotSwappableHandler 原子替换
 *
 * @param options Koa 适配器配置选项
 * @param vextApp VextApp 实例（用于传递给 createVextRequest 的 app 引用）
 * @returns VextAdapter 实例
 *
 * @see adapters/hono/adapter.ts（Hono Adapter 对应实现）
 * @see adapters/fastify/adapter.ts（Fastify Adapter 对应实现）
 * @see adapters/express/adapter.ts（Express Adapter 对应实现）
 */
export function createKoaAdapter(
  options: KoaAdapterOptions,
  vextApp: VextApp,
): VextAdapter {
  // ── 创建 Koa 实例 ─────────────────────────────────────────
  //
  // 关键配置：
  //   - proxy: false — vext 有自己的 trustProxy 逻辑，不使用 Koa 的 proxy 设置
  //   - 不注册任何 Koa body-parser 中间件
  //
  const koaApp = new Koa();
  const router = new Router();

  // 禁用 Koa 的 proxy 模式（vext 有独立的 trustProxy 逻辑）
  koaApp.proxy = false;

  // ── 🆕 5.7: 缓存 ALS 开关（避免热路径重复读取 config）────
  const alsEnabled = vextApp.config.requestContext?.enabled !== false;

  // ── 全局状态 ──────────────────────────────────────────────

  /** 全局中间件列表（通过 registerMiddleware 收集，在每个路由执行时拼接到链头） */
  const globalMiddlewares: VextMiddleware[] = [];

  /** 错误处理函数（通过 registerErrorHandler 注册） */
  let errorHandler: VextErrorMiddleware | null = null;

  /** 404 处理函数（通过 registerNotFound 注册） */
  let notFoundHandler: VextMiddleware | null = null;

  /** 是否已挂载 Koa 主中间件（只挂载一次） */
  let _middlewareRegistered = false;

  async function handleMatchedRoute(
    ctx: KoaContext,
    entry: RouteEntry,
  ): Promise<void> {
    try {
      const routeBodyParser = resolveRouteBodyParserConfig(entry.routeOptions);
      const maxBodyBytes = resolveAdapterBodyLimitBytes({
        globalBodyParser: vextApp.config.bodyParser,
        routeBodyParser,
        multipart: vextApp.config.multipart,
        adapterBodyLimit: options.bodyLimit,
      });

      let rawBody: Buffer;
      try {
        rawBody = await collectRawBody(ctx, maxBodyBytes);
      } catch (error) {
        if (isPayloadTooLargeError(error)) {
          ctx.status = 413;
          ctx.body = {
            error: "Payload Too Large",
            message: `Request body exceeds maximum size of ${maxBodyBytes} bytes`,
          };
          return;
        }
        throw error;
      }

      const req = createVextRequest(ctx, vextApp, getKoaParams(ctx), rawBody);
      (req as { _routeOptions?: RouteOptions })._routeOptions =
        entry.routeOptions;
      if (routeBodyParser) {
        (req as { _routeBodyParser?: VextBodyParserConfig })._routeBodyParser =
          routeBodyParser;
      }
      req.route = entry.pattern;
      const res = createVextResponse(
        ctx,
        () => req.requestId,
        req,
        entry.routeOptions,
        entry.method,
      );
      res._hooks = vextApp.hooks;
      res._hideInternalErrors =
        vextApp.config.response?.hideInternalErrors ?? true;

      const runChain = async () => {
        try {
          let fullChain = entry.fullChain;
          if (!fullChain) {
            fullChain = globalMiddlewares.concat(entry.chain);
            entry.fullChain = fullChain;
          }
          await executeChain(fullChain, req, res);
        } catch (err) {
          if (errorHandler) {
            try {
              errorHandler(err, req, res);
            } catch (handlerError) {
              try {
                res.rawJson(
                  { code: 500, message: "Internal Server Error" },
                  500,
                );
              } catch {
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
      markHandlerDone(ctx.res, completion);
      await completion;

      ctx.respond = false;
    } catch (err) {
      if (errorHandler) {
        try {
          const req = createVextRequest(ctx, vextApp, {});

          if (!req.requestId) {
            const headerName =
              vextApp.config.requestId?.header ?? "x-request-id";
            req.requestId =
              (req.headers[headerName] as string) || crypto.randomUUID();
          }

          const res = createVextResponse(ctx, () => req.requestId, req);
          res._hooks = vextApp.hooks;
          res._hideInternalErrors =
            vextApp.config.response?.hideInternalErrors ?? true;
          errorHandler(err, req, res);
          res._flush?.();
          ctx.respond = false;
        } catch {
          sendDefaultError(ctx);
        }
      } else {
        sendDefaultError(ctx);
      }
    }
  }

  async function handleNotFound(ctx: KoaContext): Promise<void> {
    if (notFoundHandler) {
      const rawBody = await collectRawBody(ctx);
      const req = createVextRequest(ctx, vextApp, {}, rawBody);

      if (!req.requestId) {
        const headerName = vextApp.config.requestId?.header ?? "x-request-id";
        req.requestId =
          (req.headers[headerName] as string) || crypto.randomUUID();
      }

      const res = createVextResponse(ctx, () => req.requestId, req);
      res._hooks = vextApp.hooks;
      res._hideInternalErrors =
        vextApp.config.response?.hideInternalErrors ?? true;

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
      markHandlerDone(ctx.res, completion);
      await completion;

      ctx.respond = false;
    } else {
      ctx.res.statusCode = 404;
      ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
      ctx.res.end(JSON.stringify({ code: 404, message: "Not Found" }));
      ctx.respond = false;
    }
  }

  function sendDefaultError(ctx: KoaContext): void {
    if (!ctx.res.headersSent) {
      ctx.res.statusCode = 500;
      ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
      ctx.res.end(
        JSON.stringify({
          code: 500,
          message: "Internal Server Error",
        }),
      );
    }
    ctx.respond = false;
  }

  /**
   * 将路由匹配 + 中间件链执行 + 404 + 错误处理注册为 Koa 中间件
   *
   * Koa 的中间件模型是单一入口：所有请求都经过 app.use() 注册的中间件链。
   * 路由匹配不是 Koa 内置功能，需要在中间件中手动实现。
   *
   * 此方法在 listen() / buildHandler() 时调用，确保所有路由已注册完毕后
   * 再挂载主中间件。
   */
  function registerKoaMiddleware(): void {
    if (_middlewareRegistered) return;
    _middlewareRegistered = true;

    // 不挂载 router.allowedMethods()，保持 vext 现有 wrong-method => 404 语义。
    koaApp.use(router.routes());
    koaApp.use(handleNotFound);
  }

  // ── 注册 Koa 全局错误处理 ────────────────────────────────
  //
  // Koa 通过 app.on('error') 处理未捕获的错误。
  // 这是最后一道防线，正常情况下不应到达此处
  // （vext 的 executeChain 内部已 try-catch 并调用 errorHandler）。
  //
  koaApp.on("error", () => {
    // 静默处理：Koa 默认会将未捕获的错误打印到 stderr，
    // 但 vext 的错误处理已在中间件链中完成，
    // 这里只是防止 Koa 的默认错误日志输出（重复且不受控）
  });

  return {
    name: "koa",

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
    // 为每条路由注册到 @koa/router。
    //
    registerRoute(
      method: string,
      path: string,
      chain: VextMiddleware[],
      routeOptions: RouteOptions = {},
    ): void {
      const upperMethod = method.toUpperCase();
      const entry: RouteEntry = {
        method: upperMethod,
        pattern: path,
        chain,
        fullChain: null,
        routeOptions,
      };
      const routePath = toKoaRoutePath(path);
      const routeHandler = async (ctx: KoaContext) => {
        await handleMatchedRoute(ctx, entry);
      };

      if (upperMethod === "ANY" || upperMethod === "ALL") {
        router.all(routePath, routeHandler);
        return;
      }

      const methodName = upperMethod.toLowerCase();
      const register = (router as unknown as Record<string, unknown>)[
        methodName
      ];

      if (typeof register === "function") {
        register.call(router, routePath, routeHandler);
        return;
      }

      router.register(routePath, [upperMethod], routeHandler);
    },

    // ── registerErrorHandler ────────────────────────────────
    //
    // 注册全局错误处理函数。
    //
    // 仅保存 handler 引用，实际的错误处理在 Koa 主中间件中执行
    // （通过 executeChain 的 try-catch 调用 errorHandler）。
    //
    registerErrorHandler(handler: VextErrorMiddleware): void {
      errorHandler = handler;
    },

    // ── registerNotFound ────────────────────────────────────
    //
    // 注册 404 兜底处理函数。
    //
    // 当路由表中没有匹配的路由时，Koa 主中间件会调用此 handler。
    //
    registerNotFound(handler: VextMiddleware): void {
      notFoundHandler = handler;
    },

    // ── listen ──────────────────────────────────────────────
    //
    // 启动 HTTP 服务器。
    //
    // 流程：
    //   1. 挂载 Koa 主中间件（路由匹配 + 执行 + 404 + 错误处理）
    //   2. 创建 Node.js HTTP server（Koa 不内置 server 创建）
    //   3. 调用 server.listen() 开始监听端口
    //   4. 返回 VextServerHandle（含 close / port / host）
    //
    async listen(
      port: number,
      host: string = "0.0.0.0",
      options?: VextAdapterListenOptions,
    ): Promise<VextServerHandle> {
      // 挂载 Koa 主中间件（确保所有路由已注册完毕）
      registerKoaMiddleware();

      const handler = koaApp.callback();
      const server = createServer(
        createNodeServerOptions(options?.server),
        handler,
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
    // Koa app.callback() 返回 (req, res) => void 函数，
    // 可以直接作为 Node.js http.createServer 的 requestListener。
    //
    // 用途：dev 模式下 Hot Reload 每次创建 fresh adapter 后调用
    // buildHandler() 获取新 handler，由 HotSwappableHandler 原子替换。
    //
    // 约定：调用 buildHandler() 前必须确保：
    //   1. 所有 registerRoute / registerMiddleware / registerErrorHandler / registerNotFound 已完成
    //   2. Koa 主中间件已挂载
    //
    buildHandler(): (req: IncomingMessage, res: ServerResponse) => void {
      // 挂载 Koa 主中间件（确保所有路由已注册完毕）
      registerKoaMiddleware();

      // Koa app.callback() 返回标准的 Node.js requestListener
      const handler = koaApp.callback();

      return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
        handler(nodeReq, nodeRes);
      };
    },
  };
}
