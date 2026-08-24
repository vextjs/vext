import type { VextAdapter } from "./adapter.js";
import type { VextApp, RouteRecord, RouteOptions } from "./app.js";
import type { VextMiddleware, VextHandler } from "./middleware.js";

/**
 * RouteDefinition — 路由定义对象（内部数据结构）
 *
 * 由 defineRoutes() 返回，包含收集到的所有路由记录。
 * router-loader 扫描 src/routes/ 后，对每个文件的 default export
 * 调用 routeDef.register(adapter, prefix, ...) 注册到底层适配器。
 *
 * 执行流程：
 *   1. defineRoutes(factory) 被调用
 *   2. 内部创建 HTTP 方法 collector
 *   3. router-loader 传入真实 app 调用 factory(app)
 *   4. 临时 HTTP 方法 collector 将每条 app.get/post/... 调用推入 routes 数组
 *   5. 返回 RouteDefinition { routes, register }
 *   6. router-loader 后续调用 register() 注册到 adapter
 */
export interface RouteDefinition {
  /** 收集到的路由记录列表 */
  readonly routes: RouteRecord[];

  /**
   * 来源文件路径（由 router-loader 注入，用于错误信息和日志）
   *
   * defineRoutes 返回时为空字符串，
   * router-loader 在加载模块后设置此字段。
   */
  sourceFile: string;

  /**
   * 将收集到的路由注册到底层适配器
   *
   * router-loader 对每个路由文件调用此方法，完成：
   *   1. 拼接完整路径：fullPath = prefix + route.path
   *   2. 解析 middlewares → VextMiddleware[]
   *   3. 构建 validate 中间件（若有 options.validate）
   *   4. 组装执行链：[...routeMiddlewares, validateMiddleware?, handlerAsMiddleware]
   *   5. adapter.registerRoute(method, fullPath, chain)
   *
   * @param adapter           底层适配器实例
   * @param prefix            文件路径推导出的路由前缀（如 /api/users）
   * @param middlewareDefs    已加载的中间件定义映射（name → VextMiddleware）
   * @param globalMiddlewares 全局中间件列表（插件通过 app.use() 注册的）
   */
  register(
    adapter: VextAdapter,
    prefix: string,
    middlewareDefs: Map<string, VextMiddleware>,
    globalMiddlewares: VextMiddleware[],
  ): void;
}

/**
 * 路由收集器接口（内部使用）
 *
 * defineRoutes 内部创建的 collector 实现此接口。
 * executeRouteFactory 会在执行 factory 期间临时把真实 app 的
 * app.get/post/... 指向此 collector，将路由定义收集到数组中。
 */
export interface RouteCollector {
  get(path: string, options: RouteOptions, handler: VextHandler): void;
  get(path: string, handler: VextHandler): void;

  post(path: string, options: RouteOptions, handler: VextHandler): void;
  post(path: string, handler: VextHandler): void;

  put(path: string, options: RouteOptions, handler: VextHandler): void;
  put(path: string, handler: VextHandler): void;

  patch(path: string, options: RouteOptions, handler: VextHandler): void;
  patch(path: string, handler: VextHandler): void;

  delete(path: string, options: RouteOptions, handler: VextHandler): void;
  delete(path: string, handler: VextHandler): void;

  head(path: string, options: RouteOptions, handler: VextHandler): void;
  head(path: string, handler: VextHandler): void;

  options(path: string, options: RouteOptions, handler: VextHandler): void;
  options(path: string, handler: VextHandler): void;
}

/**
 * defineRoutes 工厂回调函数类型
 *
 * 接收真实的 VextApp 对象，在其上注册路由。
 * 执行期间 HTTP 方法会临时指向 RouteCollector，其他 app 能力保持真实身份。
 * factory 必须同步完成路由注册；async function 或 Promise 返回值会被拒绝。
 */
export type RouteFactory = (app: VextApp) => void;
