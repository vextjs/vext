import { Hono, type Context } from "hono";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { createRouter } from "route-core";
import type { PreparedMethod } from "route-core";
import { createVextRequest as createHonoRequest } from "./request.js";
import {
  createVextResponse as createHonoResponse,
  createResponseBox,
  type HonoNodeResponseEnvironment,
} from "./response.js";
import {
  createVextRequest as createNodeRequest,
  type ParsedUrl,
} from "../native/request.js";
import { createVextResponse as createNodeResponse } from "../native/response.js";
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
import { requestContext } from "../../lib/request-context.js";
import { createAuthContextSnapshot } from "../../lib/auth.js";
import { markHandlerDone } from "../../lib/handler-completion.js";
import { createStreamFailureBody } from "../../lib/response-hooks.js";
import type { RouteOptions, VextBodyParserConfig } from "../../types/app.js";
import { resolveRouteBodyParserConfig } from "../../lib/middlewares/body-parser.js";
import {
  applyServerConfig,
  createNodeServerOptions,
} from "../../lib/server-config.js";

/**
 * 中间件链执行器（洋葱模型）
 *
 * 按顺序执行中间件链中的每个中间件，
 * 每个中间件通过 await next() 调用下一个中间件。
 * next() 返回后可执行 after-middleware 逻辑（洋葱模型回溯）。
 *
 * P0-3 修复：next 为 async 函数，类型与 VextMiddleware 的
 * next: () => Promise<void> 对齐。用户中间件应 await next()
 * 以支持洋葱模型的 after-middleware 逻辑。
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

interface HeadRouteStore {
  chain: VextMiddleware[] | null;
  routeChain: VextMiddleware[];
  routeOptions: RouteOptions;
  routeBodyParser?: VextBodyParserConfig;
  routePath: string;
}

function writeWebResponseHeaders(
  nodeRes: ServerResponse,
  webHeaders: Headers,
): void {
  const headersWithSetCookie = webHeaders as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookieValues =
    typeof headersWithSetCookie.getSetCookie === "function"
      ? headersWithSetCookie.getSetCookie()
      : [];

  webHeaders.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      if (setCookieValues.length === 0) {
        setCookieValues.push(value);
      }
      return;
    }
    nodeRes.setHeader(key, value);
  });

  if (setCookieValues.length > 0) {
    nodeRes.setHeader("Set-Cookie", setCookieValues);
  }
}

function finishWebResponseFailure(
  nodeRes: ServerResponse,
  error: unknown,
  hideInternalErrors: boolean,
): void {
  if (nodeRes.writableEnded || nodeRes.destroyed) return;
  if (nodeRes.headersSent) {
    // The source error is already observed here. Passing it into destroy()
    // can re-emit the same failure through the assigned socket.
    nodeRes.destroy();
    return;
  }

  const body = createStreamFailureBody(error, { hideInternalErrors });
  nodeRes.statusCode = 500;
  nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
  nodeRes.setHeader("Content-Length", Buffer.byteLength(body));
  nodeRes.end(body);
}

function cancelWebResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    const cancellation = reader.cancel(reason);
    void cancellation.catch(() => {
      // Downstream shutdown owns the outcome; cancellation is best-effort.
    });
  } catch {
    // A synchronously failed cancellation must not obscure target settlement.
  }
}

function waitForNodeResponseDrain(nodeRes: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      nodeRes.off("drain", onDrain);
      nodeRes.off("close", onClose);
      nodeRes.off("error", onError);
    };
    const complete = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onDrain = () => complete(resolve);
    const onClose = () =>
      complete(() => reject(new Error("downstream response closed")));
    const onError = (error: Error) => complete(() => reject(error));

    nodeRes.once("drain", onDrain);
    nodeRes.once("close", onClose);
    nodeRes.once("error", onError);
    if (nodeRes.destroyed || nodeRes.writableEnded) queueMicrotask(onClose);
  });
}

async function writeWebResponse(
  nodeRes: ServerResponse,
  webResponse: Response,
  hideInternalErrors: boolean,
): Promise<void> {
  nodeRes.statusCode = webResponse.status;
  writeWebResponseHeaders(nodeRes, webResponse.headers);

  if (!webResponse.body) {
    nodeRes.end();
    return;
  }

  const reader = webResponse.body.getReader();
  let downstreamClosed = nodeRes.destroyed || nodeRes.writableEnded;
  const onTargetClose = () => {
    downstreamClosed = true;
    cancelWebResponseReader(reader);
  };
  const onTargetError = (error: Error) => {
    downstreamClosed = true;
    cancelWebResponseReader(reader, error);
  };
  nodeRes.once("close", onTargetClose);
  nodeRes.once("error", onTargetError);
  try {
    while (true) {
      if (downstreamClosed || nodeRes.destroyed || nodeRes.writableEnded) break;
      const { done, value } = await reader.read();
      if (
        done ||
        downstreamClosed ||
        nodeRes.destroyed ||
        nodeRes.writableEnded
      ) {
        break;
      }
      if (!nodeRes.write(value)) {
        await waitForNodeResponseDrain(nodeRes);
      }
    }
  } catch (error) {
    if (!downstreamClosed && !nodeRes.destroyed && !nodeRes.writableEnded) {
      finishWebResponseFailure(nodeRes, error, hideInternalErrors);
    }
    return;
  } finally {
    nodeRes.off("close", onTargetClose);
    nodeRes.off("error", onTargetError);
    try {
      reader.releaseLock();
    } catch {
      // A downstream cancellation can settle concurrently with lock release.
    }
  }

  if (!downstreamClosed && !nodeRes.writableEnded && !nodeRes.destroyed) {
    nodeRes.end();
  }
}

/**
 * createHonoAdapter — 创建基于 Hono 的 VextAdapter 实例
 *
 * 将 Hono 作为底层 HTTP 路由引擎，实现 VextAdapter 接口。
 * 所有路由 / 中间件 / 错误处理都通过 Hono 的路由匹配 + vext 的中间件链执行。
 *
 * 架构说明：
 *   - Hono 仅用于路由匹配（trie router），不使用 Hono 自带的中间件机制
 *   - 中间件链执行由 vext 自己的 executeChain 实现（洋葱模型）
 *   - 请求 / 响应对象在 Hono route handler 内转换为 VextRequest / VextResponse
 *   - 全局中间件通过 registerMiddleware() 收集，在每个路由执行时拼接到链头
 *
 * HTTP 服务器：
 *   - 使用 Node.js 原生 http.createServer
 *   - 将 Node.js IncomingMessage 转为 Web Request 交给 Hono 处理
 *   - 将 Hono 返回的 Web Response 写回 Node.js ServerResponse
 *   - buildHandler() 返回 Node.js (req, res) handler，用于 dev 模式热重载替换
 *
 * Response 捕获机制（ResponseBox）：
 *   Hono 的 route handler 必须返回 Response 对象。但 vext 的 executeChain 是 void 的，
 *   VextResponse 的发送方法（json/text/...）内部调用 c.json()/c.text() 等 Hono API，
 *   这些 API 返回 Response 对象。通过 ResponseBox 容器捕获这些 Response，
 *   route handler 最后从 box.value 取出 Response 返回给 Hono。
 *
 * @param app VextApp 实例（用于传递给 createVextRequest 的 app 引用）
 * @returns VextAdapter 实例
 */
export function createHonoAdapter(app: VextApp): VextAdapter {
  const hono = new Hono();
  const explicitHeadRouter = createRouter({
    ignoreTrailingSlash: true,
    caseSensitive: false,
  });
  const explicitHeadStores: HeadRouteStore[] = [];
  let explicitHeadMethod: PreparedMethod | null = null;
  const globalMiddlewares: VextMiddleware[] = [];
  let errorHandler: VextErrorMiddleware | null = null;
  /** 全局中间件是否已冻结（listen/buildHandler 后不再变更） */
  const _globalFrozen = false;

  // ── 🆕 5.7: 缓存 ALS 开关（避免热路径重复读取 config）────
  const alsEnabled = app.config.requestContext?.enabled !== false;

  return {
    name: "hono",

    registerMiddleware(middleware: VextMiddleware): void {
      globalMiddlewares.push(middleware);
    },

    registerRoute(
      method: string,
      path: string,
      chain: VextMiddleware[],
      routeOptions: RouteOptions = {},
    ): void {
      // 使用 hono.on() 以支持所有 HTTP 方法（包括 HEAD / OPTIONS）
      // hono.on() 接受方法字符串数组和路径
      const upperMethod = method.toUpperCase();
      const honoPaths = toHonoRoutePaths(path);

      // 🆕 性能优化：延迟预组装中间件链
      //
      // 注册路由时 globalMiddlewares 尚未完成收集（bootstrap 步骤⑥在步骤⑤之后），
      // 因此无法在 registerRoute 时预组装。改为在首次请求时组装并缓存。
      // 后续请求直接复用已组装的链，避免每请求 [...spread] 开销。
      //
      let prebuiltChain: VextMiddleware[] | null = null;
      if (upperMethod === "HEAD") {
        const routeBodyParser = resolveRouteBodyParserConfig(routeOptions);
        const storeId = explicitHeadStores.length;
        explicitHeadStores.push({
          chain: null,
          routeChain: chain,
          routeOptions,
          routeBodyParser,
          routePath: path,
        });
        explicitHeadRouter.add("HEAD", path, storeId);
      }

      const routeHandler = async (c: Context) => {
        const req = createHonoRequest(c, app);
        (req as { _routeOptions?: RouteOptions })._routeOptions = routeOptions;
        const routeBodyParser = resolveRouteBodyParserConfig(routeOptions);
        if (routeBodyParser) {
          (
            req as { _routeBodyParser?: VextBodyParserConfig }
          )._routeBodyParser = routeBodyParser;
        }
        // F-01: 注入路由模板字符串（低基数，适合 OTEL/Prometheus 指标标签）
        // path 是 registerRoute 的参数，在此 closure 中直接可访问
        req.route = path;
        // 创建 ResponseBox 用于捕获 VextResponse 发送方法产生的 Response
        const box = createResponseBox();
        // 延迟绑定 requestId：传入 getter 确保 json() 实际调用时才取值
        // 此时 requestId 必然已由 requestIdMiddleware 设置到 req.requestId
        const res = createHonoResponse(
          c,
          () => req.requestId,
          box,
          req,
          routeOptions,
          upperMethod,
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
              // P2-6 修复：errorHandler 自身抛异常的边界保护
              // 防止 errorHandler 内部失败（如 logger 写入 DB transport 失败）
              // 导致异常传播到 Hono 的 catch，产生非 JSON 的纯文本 500
              try {
                errorHandler(err, req, res);
              } catch (handlerError) {
                try {
                  res.rawJson(
                    { code: 500, message: "Internal Server Error" },
                    500,
                  );
                } catch {
                  // 完全放弃，让底层框架的 catch 处理
                  throw handlerError;
                }
              }
            } else {
              throw err;
            }
          } finally {
            // Flush deferred body so post-next setHeader/cookie still apply
            // before the Response is returned to Hono.
            res._flush?.();
          }

          // 从 ResponseBox 中获取 VextResponse 发送方法捕获的 Response
          // 如果 handler 没有调用任何发送方法，返回空的 200 Response 作为兜底
          return box.value ?? c.body(null);
        };

        if (alsEnabled) {
          return requestContext.run(
            {
              requestId: "",
              locale: undefined,
              auth: createAuthContextSnapshot(req.auth),
            },
            runChain,
          );
        } else {
          return runChain();
        }
      };

      for (const honoPath of honoPaths) {
        hono.on(upperMethod, honoPath, routeHandler);
      }
    },

    registerErrorHandler(handler: VextErrorMiddleware): void {
      errorHandler = handler;
    },

    registerNotFound(handler: VextMiddleware): void {
      hono.notFound(async (c) => {
        const req = createHonoRequest(c, app);
        const box = createResponseBox();

        // P2-5 修复：notFound 不经过中间件链，requestId 中间件不会执行。
        // 内联生成 requestId，确保 404 响应也有有效的 requestId
        if (!req.requestId) {
          const headerName = app.config.requestId?.header ?? "x-request-id";
          req.requestId =
            (req.headers[headerName] as string) || crypto.randomUUID();
        }

        const res = createHonoResponse(c, () => req.requestId, box, req);
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

        if (alsEnabled) {
          await requestContext.run(
            {
              requestId: req.requestId,
              locale: undefined,
              auth: createAuthContextSnapshot(req.auth),
            },
            runNotFound,
          );
        } else {
          await runNotFound();
        }

        // 从 ResponseBox 获取 notFound handler 生成的 Response
        // 如果 handler 没有发送任何响应，返回默认的 404 JSON
        return box.value ?? c.json({ code: 404, message: "Not Found" }, 404);
      });
    },

    async listen(
      port: number,
      host: string = "0.0.0.0",
      options?: VextAdapterListenOptions,
    ): Promise<VextServerHandle> {
      const requestHandler = this.buildHandler();

      return new Promise<VextServerHandle>((resolve, reject) => {
        const server = createServer(
          createNodeServerOptions(options?.server),
          requestHandler,
        );
        applyServerConfig(server, options?.server);

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

    buildHandler(): (req: IncomingMessage, res: ServerResponse) => void {
      // 将 Hono 的 fetch handler 转为 Node.js 的 (req, res) 形式
      //
      // 流程：
      //   1. 将 Node.js IncomingMessage 转为 Web Request 对象
      //   2. 调用 Hono 的 fetch() 处理请求
      //   3. 将返回的 Web Response 写入 Node.js ServerResponse
      return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
        if (tryHandleExplicitHeadRoute(nodeReq, nodeRes)) {
          return;
        }

        // 构造 Web Request URL
        const protocol = "http";
        const host =
          nodeReq.headers.host ??
          `localhost:${(nodeReq.socket.address() as any)?.port ?? 3000}`;
        const url = `${protocol}://${host}${nodeReq.url ?? "/"}`;

        // 判断请求是否有 body
        const method = (nodeReq.method ?? "GET").toUpperCase();
        const hasBody = method !== "GET" && method !== "HEAD";

        // 将 Node.js IncomingMessage 转为 Web ReadableStream（用于 POST/PUT 等有 body 的请求）
        let body: ReadableStream<Uint8Array> | null = null;
        if (hasBody) {
          body = new ReadableStream<Uint8Array>({
            start(controller) {
              nodeReq.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
              });
              nodeReq.on("end", () => {
                controller.close();
              });
              nodeReq.on("error", (err) => {
                controller.error(err);
              });
            },
          });
        }

        // 转换 Node.js 请求头为 Headers 对象
        const headers = new Headers();
        const rawHeaders = nodeReq.rawHeaders;
        for (let i = 0; i < rawHeaders.length; i += 2) {
          const key = rawHeaders[i];
          const value = rawHeaders[i + 1];
          if (key && value) {
            headers.append(key, value);
          }
        }

        // 构造 Web Request 的 init 选项
        const requestInit: RequestInit = {
          method,
          headers,
        };

        // 仅在有 body 时设置 body 和 duplex
        if (body) {
          requestInit.body = body;
          // duplex 是 Node.js 中流式请求体所需的选项
          // TypeScript 类型定义中尚未包含此属性，但运行时需要
          (requestInit as Record<string, unknown>).duplex = "half";
        }

        // 构造 Web Request
        const webRequest = new Request(url, requestInit);

        // 通过 env 传递 Node.js 原始对象，供 createVextRequest 读取 socket 信息
        const env: HonoNodeResponseEnvironment & {
          incoming: IncomingMessage;
        } = { incoming: nodeReq, outgoing: nodeRes };

        // 调用 Hono 的 fetch handler，其返回值可能是 Response 或 Promise<Response>
        const result = hono.fetch(webRequest, env);

        // 统一处理为 Promise
        const responsePromise =
          result instanceof Promise ? result : Promise.resolve(result);

        const completion = responsePromise
          .then(async (webResponse: Response) => {
            if (env.vextStreamOwned) {
              return;
            }
            await writeWebResponse(
              nodeRes,
              webResponse,
              app.config.response?.hideInternalErrors ?? true,
            );
          })
          .catch((error) => {
            // Hono 内部未捕获的异常（理论上不应到达此处，因为有 errorHandler）
            finishWebResponseFailure(
              nodeRes,
              error,
              app.config.response?.hideInternalErrors ?? true,
            );
          });
        markHandlerDone(nodeRes, completion);
        void completion;
      };
    },
  };

  function getExplicitHeadMethod(): PreparedMethod {
    if (!explicitHeadMethod) {
      explicitHeadMethod = explicitHeadRouter.prepareMethod("HEAD");
    }
    return explicitHeadMethod;
  }

  function tryHandleExplicitHeadRoute(
    nodeReq: IncomingMessage,
    nodeRes: ServerResponse,
  ): boolean {
    if ((nodeReq.method ?? "GET").toUpperCase() !== "HEAD") {
      return false;
    }
    if (explicitHeadStores.length === 0) {
      return false;
    }

    const parsedUrl = parseNodeUrl(nodeReq.url ?? "/");
    const preparedPathname = explicitHeadRouter.preparePathname(parsedUrl.path);
    if (!preparedPathname) {
      return false;
    }

    let matched = false;
    getExplicitHeadMethod().lookup(
      preparedPathname,
      (storeId, params, routePath) => {
        if (matched) return;
        const store = explicitHeadStores[storeId];
        if (!store) return;
        matched = true;
        handleExplicitHeadRoute(
          nodeReq,
          nodeRes,
          params ?? {},
          routePath || store.routePath,
          store,
          parsedUrl,
        );
      },
    );
    return matched;
  }

  function handleExplicitHeadRoute(
    nodeReq: IncomingMessage,
    nodeRes: ServerResponse,
    params: Record<string, string>,
    routePath: string,
    store: HeadRouteStore,
    parsedUrl: ParsedUrl,
  ): void {
    const req = createNodeRequest(nodeReq, app, params, parsedUrl);
    (req as { _routeOptions?: RouteOptions })._routeOptions =
      store.routeOptions;
    if (store.routeBodyParser) {
      (req as { _routeBodyParser?: VextBodyParserConfig })._routeBodyParser =
        store.routeBodyParser;
    }
    req.route = routePath || store.routePath;
    const res = createNodeResponse(
      nodeRes,
      req,
      req,
      store.routeOptions,
      "HEAD",
    );
    res._hooks = app.hooks;
    res._hideInternalErrors = app.config.response?.hideInternalErrors ?? true;

    if (store.chain === null) {
      store.chain = globalMiddlewares.concat(store.routeChain);
    }

    const runChain = async () => {
      try {
        await executeChain(store.chain!, req, res);
      } catch (err) {
        if (errorHandler) {
          try {
            errorHandler(err, req, res);
          } catch {
            res.rawJson({ code: 500, message: "Internal Server Error" }, 500);
          }
        } else {
          res.rawJson({ code: 500, message: "Internal Server Error" }, 500);
        }
      } finally {
        // Native-backed HEAD path also uses deferred flush.
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
    markHandlerDone(nodeRes, completion);
    void completion;
  }

  function parseNodeUrl(url: string): ParsedUrl {
    const qIdx = url.indexOf("?");
    return {
      rawUrl: url,
      path: qIdx === -1 ? url : url.slice(0, qIdx),
      queryString: qIdx === -1 ? "" : url.slice(qIdx + 1),
    };
  }
}

function toHonoRoutePaths(path: string): string[] {
  const honoPath = toHonoRoutePath(path);
  if (path === "/" || path.endsWith("/") || /\/\*[A-Za-z_]\w*$/u.test(path)) {
    return [honoPath];
  }
  return [honoPath, `${honoPath}/`];
}

function toHonoRoutePath(path: string): string {
  return path.replace(/\/\*([A-Za-z_]\w*)$/gu, "/:$1{.+}");
}
