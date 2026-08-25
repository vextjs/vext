import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import crypto from "node:crypto";
import { createRouter } from "route-core";
import type { PreparedMethod } from "route-core";
import { createVextRequest, type ParsedUrl } from "./request.js";
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
import { resolveRouteBodyParserConfig } from "../../lib/middlewares/body-parser.js";
import {
  applyServerConfig,
  createNodeServerOptions,
} from "../../lib/server-config.js";

/**
 * Native Adapter 选项
 *
 * 用户通过 nativeAdapter(options) 工厂函数传入，
 * 控制 Native Adapter 的初始化行为。
 *
 * 所有选项均可选，默认值已为 vext 场景优化。
 *
 * Native Adapter 不依赖任何第三方 HTTP 框架（无 Fastify / Express / Koa / Hono），
 * 直接使用 Node.js 原生 http.createServer + route-core（轻量路由核心）。
 * 这是 vext 的最高性能适配器选项。
 */
export interface NativeAdapterOptions {
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

  /**
   * 最大参数长度（默认 500）
   * 路由参数（如 :id）的最大字符数
   */
  maxParamLength?: number;
}

// ── 路由处理器存储类型 ──────────────────────────────────────────
//
// route-core 只保存 numeric storeId；Native adapter 自己维护 store 表。
// 我们将预组装的完整中间件链存储在 store 中，避免每请求重新组装。
//

interface RouteStore {
  /** 预组装的完整中间件链（全局 + 路由级，首次请求时构建并缓存） */
  chain: VextMiddleware[] | null;
  /** 路由级中间件链（registerRoute 传入的 chain） */
  routeChain: VextMiddleware[];
  /**
   * 路由模板字符串（如 `/users/:id`）
   *
   * route-core 在命中时返回 routePath；store 中保留注册时模板用于调试与兜底。
   */
  routePath: string;
  /** 预解析的路由级 bodyParser 配置；注册时计算，避免热路径每请求解析 */
  routeBodyParser?: VextBodyParserConfig;
  /** 原始路由 options，供全局中间件读取 route-level override */
  routeOptions: RouteOptions;
  /** Normalized HTTP method used by the registration-time serializer cache. */
  routeMethod: string;
}

/**
 * 中间件链执行器（洋葱模型）
 *
 * 按顺序执行中间件链中的每个中间件，
 * 每个中间件通过 await next() 调用下一个中间件。
 * next() 返回后可执行 after-middleware 逻辑（洋葱模型回溯）。
 *
 * 逻辑与 Fastify / Express / Koa / Hono Adapter 的 executeChain 完全一致，
 * 确保所有 Adapter 的中间件执行语义相同。
 *
 * 性能优化：
 *   - 使用参数化递归 dispatch(i) 替代每请求闭包链创建
 *   - len 提前缓存避免每次 dispatch 访问 chain.length
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

  // ── F2 快速路径：仅 1 个中间件时跳过递归调度 ──────────
  //
  // 直接注册且没有全局或路由级中间件的 route 会形成单元素 handler 链。
  // 标准路径每请求创建 4+ 个 Promise（executeChain / dispatch(0) / middleware / dispatch(1)）。
  // 快速路径仅创建 1 个 Promise（middleware 本身），减少 ~75% 的 Promise/微任务开销。
  //
  // 语义等价性：单元素链中 next() 应为 noop（dispatch(1) → i >= len → return）。
  // 这里用预创建的静态 noop 替代，避免每请求创建新的 next 闭包。
  //
  if (len === 1) {
    await chain[0]!(req, res, _noop);
    return;
  }

  // ── F2 快速路径：2 个中间件时展开递归 ─────────────────
  //
  // 生产环境常见：1 个全局中间件 + 1 个 handler。
  // 展开后减少 2 个 Promise（dispatch(0) + dispatch(2)），仅保留 2 个 await。
  //
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

  // ── 标准洋葱模型递归（3+ 中间件）─────────────────────
  async function dispatch(i: number): Promise<void> {
    if (i >= len) return;
    const middleware = chain[i]!;
    await middleware(req, res, () => dispatch(i + 1));
  }

  await dispatch(0);
}

/** 静态 noop next 函数（F2 快速路径复用，避免每请求创建新闭包） */
const _noop = async (): Promise<void> => {};

/**
 * createNativeAdapter — 创建基于 http.createServer + route-core 的 VextAdapter 实例
 *
 * 将 Node.js 原生 HTTP 服务器作为底层，配合 route-core 路由核心，
 * 实现 VextAdapter 接口。这是 vext 的第五个 adapter 实现，
 * 也是唯一不依赖第三方 HTTP 框架的实现。
 *
 * 架构说明：
 *   - 路由匹配：route-core（只负责 method/path 匹配与 params 提取）
 *   - HTTP 层：Node.js 原生 http.createServer，不经过第三方 HTTP 框架层
 *   - 中间件链执行：vext 自己的 executeChain（洋葱模型）
 *   - 请求/响应对象：直接从 IncomingMessage / ServerResponse 构造 VextRequest / VextResponse
 *   - 全局中间件：通过 registerMiddleware() 收集，在每个路由执行时拼接到链头
 *
 * 与其他 Adapter 的核心差异：
 *   - 无第三方框架依赖（Fastify / Express / Koa / Hono 均被跳过）
 *   - 请求对象直接从 IncomingMessage 构造，无中间包装层
 *   - 响应对象直接操作 ServerResponse，无框架 reply / ctx 层
 *   - Body 读取：直接从 IncomingMessage 数据流读取 Buffer → string
 *   - JSON 序列化：直接 serverResponse.end(JSON.stringify(...))
 *   - 路由匹配：route-core prepared lookup 直接在 http handler 中调用
 *
 * 性能预期：
 *   相比 Fastify Adapter，Native Adapter 省去了：
 *   1. Fastify 框架初始化开销（plugin 系统、hook 系统）
 *   2. Fastify 的 request/reply 对象构造
 *   3. Fastify 的 content-type parser 管道
 *   4. Fastify 的 serialization 管道
 *   5. Fastify 的 lifecycle hooks 调用
 *   预估 RPS 提升 +44-73%（相对 vext-Fastify）
 *
 * HTTP 服务器：
 *   - listen() 创建 http.createServer 并开始监听
 *   - close() 关闭服务器
 *   - buildHandler() 返回 (req, res) => void 处理函数，
 *     用于 dev 模式热重载的 HotSwappableHandler 原子替换
 *
 * @param options Native 适配器配置选项
 * @param app     VextApp 实例（用于传递给 createVextRequest 的 app 引用）
 * @returns VextAdapter 实例
 *
 * @see adapters/fastify/adapter.ts（Fastify Adapter 对应实现）
 * @see adapters/express/adapter.ts（Express Adapter 对应实现）
 * @see adapters/koa/adapter.ts（Koa Adapter 对应实现）
 * @see adapters/hono/adapter.ts（Hono Adapter 对应实现）
 */
export function createNativeAdapter(
  options: NativeAdapterOptions,
  app: VextApp,
): VextAdapter {
  // ── 创建 route-core 路由器 ────────────────────────────────
  //
  // route-core 只负责路由注册与匹配，handler / middleware / request lifecycle
  // 均继续由 Native adapter 自己持有，避免把框架生命周期交给路由核心。
  //
  // 关键配置：
  //   - ignoreTrailingSlash: true — /users 和 /users/ 等价
  //   - caseSensitive: false — /Users 和 /users 等价
  //   - maxParamLength: 500 — 路由参数最大长度
  //
  const router = createRouter({
    ignoreTrailingSlash: options.ignoreTrailingSlash ?? true,
    caseSensitive: options.caseSensitive ?? false,
    maxParamLength: options.maxParamLength ?? 500,
  });
  const routeStores: RouteStore[] = [];
  const staticRouteStores = new Map<string, Map<string, RouteStore>>();
  const preparedMethods = new Map<string, PreparedMethod>();

  // ── 🆕 5.7: 缓存 ALS 开关（避免热路径重复读取 config）────
  const alsEnabled = app.config.requestContext?.enabled !== false;

  // ── 全局状态 ──────────────────────────────────────────────

  /** 全局中间件列表（通过 registerMiddleware 收集，在每个路由执行时拼接到链头） */
  const globalMiddlewares: VextMiddleware[] = [];

  /** 错误处理函数（通过 registerErrorHandler 注册） */
  let errorHandler: VextErrorMiddleware | null = null;

  /** 404 兜底处理函数（通过 registerNotFound 注册） */
  let notFoundHandler: VextMiddleware | null = null;

  /**
   * 执行已匹配路由的中间件链。
   *
   * P4 优化：从 onRouteMatch 的每请求 async 闭包中提取为 adapter 级函数。
   * 当 requestContext.enabled === false 时，热路径可直接调用本函数，
   * 避免每请求创建 runChain 闭包。
   */
  async function runMatchedChain(
    chain: VextMiddleware[],
    req: VextRequest,
    res: VextResponse,
    nodeRes: ServerResponse,
  ): Promise<void> {
    try {
      await executeChain(chain, req, res);
    } catch (err) {
      if (errorHandler) {
        // errorHandler 自身抛异常的边界保护
        try {
          errorHandler(err, req, res);
        } catch (_handlerError) {
          sendFallbackError(nodeRes);
        }
      } else {
        sendFallbackError(nodeRes);
      }
    } finally {
      // Flush deferred body so post-next setHeader/cookie still apply.
      res._flush?.();
    }
  }

  /**
   * 处理请求的核心函数
   *
   * 由 listen() 和 buildHandler() 共用。
   * 接收原始 Node.js IncomingMessage / ServerResponse，
   * 执行路由匹配 → 中间件链 → 错误处理 → 404 兜底的完整流程。
   *
   * 设计说明：
   *   - 使用 route-core prepared lookup，命中时通过 storeId 找回 RouteStore。
   *   - 如果路由未匹配或参数解码失败，执行 notFoundHandler。
   *   - 如果中间件链执行抛出异常，执行 errorHandler。
   *   - 如果 errorHandler 自身也抛出异常，发送最低限度的 500 JSON 响应。
   */
  /**
   * 处理匹配到路由的请求
   *
   * P3 优化：作为 route-core lookupPrepared() 的 handler 回调直接调用，
   * 避免 find() 返回中间对象 { storeId, params, routePath } 的每请求分配。
   *
   * @param nodeReq   原始 IncomingMessage（由 lookup 传入）
   * @param nodeRes   原始 ServerResponse（由 lookup 传入）
   * @param params    路由参数（由 route-core 解析后传入）
   * @param routePath 命中的路由模板
   * @param store     路由关联的 store 数据（含预组装的中间件链）
   * @param parsedUrl 由 handleRequest 一次性解析的 URL 信息
   */
  function onRouteMatch(
    nodeReq: IncomingMessage,
    nodeRes: ServerResponse,
    params: Record<string, string> | null,
    routePath: string,
    store: RouteStore,
    parsedUrl: ParsedUrl,
  ): void {
    const routeParams = params ?? {};

    // ── 构造 VextRequest / VextResponse ──────────────────
    // P2 优化：传递预解析的 URL 信息，createVextRequest 不再重复 indexOf('?')
    const req = createVextRequest(nodeReq, app, routeParams, parsedUrl);
    (req as { _routeOptions?: RouteOptions })._routeOptions =
      store.routeOptions;
    const routeBodyParser = store.routeBodyParser;
    if (routeBodyParser) {
      (req as { _routeBodyParser?: VextBodyParserConfig })._routeBodyParser =
        routeBodyParser;
    }
    // F-01：注入路由模板（如 /users/:id），解决 Prometheus 高基数问题
    req.route = routePath || store.routePath;
    const res = createVextResponse(
      nodeRes,
      req,
      req,
      store.routeOptions,
      store.routeMethod,
    );
    res._hooks = app.hooks;
    res._hideInternalErrors = app.config.response?.hideInternalErrors ?? true;

    // ── 预组装中间件链（首次请求时构建，后续复用）──────────
    //
    // 与 Fastify / Express / Koa Adapter 的 prebuiltChain 逻辑一致：
    // 注册路由时 globalMiddlewares 尚未完成收集（bootstrap 步骤⑥在步骤⑤之后），
    // 因此在首次请求时组装并缓存，后续请求直接复用。
    //
    if (store.chain === null) {
      store.chain = globalMiddlewares.concat(store.routeChain);
    }
    const chain = store.chain;

    // ── 在 AsyncLocalStorage 请求上下文中执行整个中间件链 ──
    //
    // 确保 app.throw 等内部方法能通过 requestContext.getStore() 访问请求级数据。
    //
    // 🆕 5.7: 当 requestContext.enabled === false 时跳过 ALS 包裹，
    // 直接执行中间件链；实际性能影响取决于 Node.js 版本与业务负载。
    //
    const completion = Promise.resolve().then(() =>
      alsEnabled
        ? requestContext.run(
            {
              requestId: "",
              locale: undefined,
              auth: createAuthContextSnapshot(req.auth),
            },
            () => runMatchedChain(chain, req, res, nodeRes),
          )
        : runMatchedChain(chain, req, res, nodeRes),
    );
    markHandlerDone(nodeRes, completion);
    void completion;
  }

  /**
   * 处理请求的核心入口函数
   *
   * 由 listen() 和 buildHandler() 共用。
   * 接收原始 Node.js IncomingMessage / ServerResponse。
   *
   * P2 优化：预解析 URL（indexOf('?') 仅执行一次）。
   * P3 优化：使用 route-core prepared lookup，命中时直接回调 adapter handler。
   */
  function handleRequest(
    nodeReq: IncomingMessage,
    nodeRes: ServerResponse,
  ): void {
    // ── P2 优化：预解析 URL（一次性 indexOf('?')）──────────
    const url = nodeReq.url ?? "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const queryString = qIdx === -1 ? "" : url.slice(qIdx + 1);

    const parsedUrl = { rawUrl: url, path: pathname, queryString };
    const preparedPathname = router.preparePathname(pathname);
    if (!preparedPathname) {
      handleNotFound(nodeReq, nodeRes, parsedUrl);
      return;
    }

    const routeMethod = normalizeRouteMethod(nodeReq.method ?? "GET");
    const matchPathname =
      typeof preparedPathname === "string"
        ? preparedPathname
        : preparedPathname.matchPathname;
    const staticStore = lookupStaticRoute(routeMethod, matchPathname);
    if (staticStore) {
      onRouteMatch(
        nodeReq,
        nodeRes,
        null,
        staticStore.routePath,
        staticStore,
        parsedUrl,
      );
      return;
    }

    const methodHandle = getPreparedMethod(routeMethod);
    const matched = methodHandle.lookup(
      preparedPathname,
      (storeId, params, routePath) => {
        const store = routeStores[storeId];
        if (!store) {
          return;
        }
        onRouteMatch(nodeReq, nodeRes, params, routePath, store, parsedUrl);
      },
    );

    if (!matched) {
      handleNotFound(nodeReq, nodeRes, parsedUrl);
    }
  }

  function normalizeRouteMethod(method: string): string {
    const normalized = method.toUpperCase();
    return normalized === "ALL" ? "ANY" : normalized;
  }

  function staticRouteKey(path: string): string {
    let key =
      (options.ignoreTrailingSlash ?? true) && path.length > 1
        ? path.replace(/\/+$/u, "") || "/"
        : path;
    if ((options.caseSensitive ?? false) !== true) {
      key = key.toLowerCase();
    }
    return key;
  }

  function lookupStaticRoute(method: string, path: string): RouteStore | null {
    return staticRouteStores.get(method)?.get(staticRouteKey(path)) ?? null;
  }

  function isStaticRoutePath(path: string): boolean {
    return (
      path.startsWith("/") &&
      !path.includes(":") &&
      !path.includes("*") &&
      !path.includes("(") &&
      !path.includes(")") &&
      !path.includes("?")
    );
  }

  function addStaticRoute(
    method: string,
    path: string,
    store: RouteStore,
  ): void {
    const key = staticRouteKey(path);
    let byPath = staticRouteStores.get(method);
    if (!byPath) {
      byPath = new Map();
      staticRouteStores.set(method, byPath);
    }
    if (byPath.has(key)) {
      throw new Error("Static route conflict");
    }
    byPath.set(key, store);
  }

  function getPreparedMethod(method: string): PreparedMethod {
    const normalized = normalizeRouteMethod(method);
    let methodHandle = preparedMethods.get(normalized);
    if (!methodHandle) {
      methodHandle = router.prepareMethod(normalized);
      preparedMethods.set(normalized, methodHandle);
    }
    return methodHandle;
  }

  /**
   * 处理 404 未匹配请求
   *
   * 当没有任何路由匹配时执行 notFoundHandler。
   * notFound 不经过中间件链，requestId 中间件不会执行。
   * 需要内联生成 requestId，确保 404 响应也有有效的 requestId。
   */
  function handleNotFound(
    nodeReq: IncomingMessage,
    nodeRes: ServerResponse,
    parsedUrl?: ParsedUrl,
  ): void {
    if (!notFoundHandler) {
      // 无 notFound handler（理论上 bootstrap 一定会注册），发送默认 404
      nodeRes.statusCode = 404;
      nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
      const body = JSON.stringify({ code: 404, message: "Not Found" });
      nodeRes.setHeader("Content-Length", Buffer.byteLength(body));
      nodeRes.end(body);
      return;
    }

    // P2 优化：优先使用 handleRequest 中已预解析的 URL 信息
    const requestUrl = parsedUrl ?? parseUrl(nodeReq.url ?? "/");

    const req = createVextRequest(nodeReq, app, {}, requestUrl);
    const res = createVextResponse(nodeRes, req, req);
    res._hooks = app.hooks;
    res._hideInternalErrors = app.config.response?.hideInternalErrors ?? true;

    // 内联生成并写出 requestId（notFound 不走中间件链，HEAD 404 也需要响应头）
    if (!req.requestId) {
      const requestIdConfig = app.config.requestId;
      const headerName = (
        requestIdConfig?.header ?? "x-request-id"
      ).toLowerCase();
      const fromHeader = req.headers[headerName];
      req.requestId =
        (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ||
        crypto.randomUUID();
      res.setHeader(
        requestIdConfig?.responseHeader ?? "x-request-id",
        req.requestId,
      );
    }

    // 🆕 5.7: ALS 可配置跳过
    const runNotFound = async () => {
      const noop = async (): Promise<void> => {};
      try {
        await notFoundHandler!(req, res, noop);
      } catch {
        sendFallbackError(nodeRes);
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
    markHandlerDone(nodeRes, completion);
    void completion;
  }

  function parseUrl(url: string): ParsedUrl {
    const qIdx = url.indexOf("?");
    return {
      rawUrl: url,
      path: qIdx === -1 ? url : url.slice(0, qIdx),
      queryString: qIdx === -1 ? "" : url.slice(qIdx + 1),
    };
  }

  /**
   * 发送最低限度的 500 错误响应
   *
   * 当 errorHandler 自身也抛出异常时，发送最后兜底的 JSON 错误响应。
   * 直接操作 ServerResponse，不经过任何 vext 抽象。
   */
  function sendFallbackError(nodeRes: ServerResponse): void {
    if (!nodeRes.headersSent) {
      try {
        nodeRes.statusCode = 500;
        nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
        const body = JSON.stringify({
          code: 500,
          message: "Internal Server Error",
        });
        nodeRes.setHeader("Content-Length", Buffer.byteLength(body));
        nodeRes.end(body);
      } catch {
        // 完全放弃（连接可能已断开）
      }
    }
  }

  return {
    name: "native",

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
    // 为每条路由注册到 route-core 路由器。
    //
    // 流程：
    //   1. 将 vext 路径注册进 route-core，并得到 numeric storeId
    //   2. 将路由级中间件链存储在 Native adapter 的 routeStores 中
    //   3. 预组装中间件链在首次请求时完成（延迟到 globalMiddlewares 收集完毕后）
    //
    // route-core 的 storeId 模型：
    //   router.add(method, path, storeId) 只保存数字 ID；
    //   lookup 命中后由 adapter 通过 routeStores[storeId] 找回 route metadata。
    //
    registerRoute(
      method: string,
      path: string,
      chain: VextMiddleware[],
      routeOptions: RouteOptions = {},
    ): void {
      const routeMethod = normalizeRouteMethod(method);
      const routePath = path;
      const routeBodyParser = resolveRouteBodyParserConfig(routeOptions);

      // 创建 store 对象，存储路由级中间件链
      // chain 在首次请求时与 globalMiddlewares 合并并缓存
      const store: RouteStore = {
        chain: null, // 延迟组装
        routeChain: chain,
        routePath, // F-01：路由模板，供 onRouteMatch 赋值到 req.route
        routeBodyParser,
        routeOptions,
        routeMethod,
      };
      const storeId = routeStores.length;
      routeStores.push(store);

      try {
        if (routeMethod !== "ANY" && isStaticRoutePath(routePath)) {
          addStaticRoute(routeMethod, routePath, store);
        } else {
          router.add(routeMethod, routePath, storeId);
        }
      } catch (err) {
        routeStores.pop();
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[vextjs] Failed to register route: ${routeMethod} ${routePath}\n` +
            `         ${message}`,
        );
      }
    },

    // ── registerErrorHandler ────────────────────────────────
    //
    // 注册全局错误处理函数。
    //
    // 中间件链执行过程中抛出的所有错误都由此函数处理。
    // 与 Fastify Adapter 不同，Native Adapter 没有框架层面的错误处理，
    // 完全由 handleRequest 内的 try-catch 捕获并转发到 errorHandler。
    //
    registerErrorHandler(handler: VextErrorMiddleware): void {
      errorHandler = handler;
    },

    // ── registerNotFound ────────────────────────────────────
    //
    // 注册 404 兜底处理函数。
    //
    // 当 route-core lookup 未命中时，由 handleRequest 调用此处理函数。
    //
    registerNotFound(handler: VextMiddleware): void {
      notFoundHandler = handler;
    },

    // ── listen ──────────────────────────────────────────────
    //
    // 启动 HTTP 服务器。
    //
    // 流程：
    //   1. 创建 Node.js http.createServer（传入 handleRequest 作为 requestListener）
    //   2. 调用 server.listen() 开始监听端口
    //   3. 返回 VextServerHandle（含 close / port / host）
    //
    // 与 Fastify Adapter 的差异：
    //   - Fastify: 调用 fastify.listen() → 内部创建 http.createServer
    //   - Native: 直接调用 http.createServer()，无框架中间层
    //
    async listen(
      port: number,
      host: string = "0.0.0.0",
      options?: VextAdapterListenOptions,
    ): Promise<VextServerHandle> {
      const server: Server = createServer(
        createNodeServerOptions(options?.server),
        handleRequest,
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
    // 返回的 handler 接受原始 Node.js req/res，内部完成：
    //   - 路由匹配（route-core prepared lookup）
    //   - 请求/响应对象转换（IncomingMessage → VextRequest / ServerResponse → VextResponse）
    //   - 中间件链执行（executeChain）
    //   - 错误处理 + 404 兜底
    //
    // 用途：dev 模式下 Hot Reload 每次创建 fresh adapter 后调用
    // buildHandler() 获取新 handler，由 HotSwappableHandler 原子替换。
    //
    // 与 Fastify Adapter 的差异：
    //   - Fastify: 返回 fastify.routing（需要先 fastify.ready()）
    //   - Native: 直接返回 handleRequest 函数，无需 ready 阶段
    //
    buildHandler(): (req: IncomingMessage, res: ServerResponse) => void {
      return handleRequest;
    },
  };
}
