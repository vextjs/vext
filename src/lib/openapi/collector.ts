/**
 * collector.ts — RouteMetadataCollector 路由元信息收集器
 *
 * 在 router-loader 扫描 routes/ 目录阶段，每注册一条路由时调用 addRoute()
 * 收集路由的 HTTP 方法、完整路径、options 配置、来源文件路径。
 *
 * 收集完成后，将 RouteMetadata[] 传递给 OpenAPIGenerator 生成 OpenAPI 文档。
 *
 * 生命周期：
 *   1. bootstrap 创建 collector 实例（若 openapi.enabled）
 *   2. loadRoutes() 接收 collector 作为可选参数
 *   3. router-loader 每注册一条路由时调用 collector.addRoute()
 *   4. bootstrap 调用 collector.getRoutes() 获取所有路由元信息
 *   5. OpenAPIGenerator.generate(routes) 生成 OpenAPI 文档
 *   6. dev 模式热重载时调用 collector.clear() 重新收集
 *
 * @module lib/openapi/collector
 * @see 14-openapi.md §3（RouteMetadataCollector）
 */

import type { RouteOptions } from "../../types/app.js";
import type { VextHandler } from "../../types/middleware.js";
import { detectRouteDocsKind } from "./route-docs-kind.js";
import type { RouteMetadata } from "./types.js";

/**
 * RouteMetadataCollector — 路由元信息收集器
 *
 * 由 bootstrap 在 router-loader 之前创建，传入 loadRoutes()。
 * router-loader 在注册每条路由到 adapter 时，同步调用 addRoute() 收集元信息。
 *
 * @example
 * ```typescript
 * const collector = new RouteMetadataCollector()
 *
 * // router-loader 内部
 * collector.addRoute('GET', '/users', routeOptions, 'routes/users.ts')
 * collector.addRoute('POST', '/users', routeOptions, 'routes/users.ts')
 *
 * // bootstrap 中
 * const routes = collector.getRoutes()
 * const spec = generator.generate(routes)
 * ```
 */
export class RouteMetadataCollector {
  private routes: RouteMetadata[] = [];
  private registeredRoutes: Array<
    Pick<RouteMetadata, "method" | "path" | "sourceFile">
  > = [];

  /**
   * 收集单条路由的元信息
   *
   * 由 router-loader 在注册每条路由时调用。
   * 如果路由设置了 docs.hidden = true，则跳过收集（不出现在 OpenAPI 文档中）。
   *
   * @param method     HTTP 方法（大写：GET / POST / PUT / PATCH / DELETE 等）
   * @param path       完整路由路径（含前缀，如 /api/users/:id）
   * @param options    路由 options 原始对象（含 validate / middlewares / docs）
   * @param sourceFile 路由文件来源路径（用于 tag 推断）
   * @param handler    路由 handler（用于识别 res.render()/res.renderError() 前端路由）
   */
  addRoute(
    method: string,
    path: string,
    options: RouteOptions,
    sourceFile: string,
    handler?: VextHandler,
  ): void {
    this.registeredRoutes.push({ method, path, sourceFile });

    // 跳过隐藏路由（docs.hidden = true 的路由不出现在 OpenAPI 文档中）
    if (options.docs?.hidden) return;

    this.routes.push({
      method,
      path,
      options,
      sourceFile,
      docsKind: options.frontend
        ? "frontend-route"
        : detectRouteDocsKind(handler),
    });
  }

  /**
   * 获取所有收集到的路由元信息
   *
   * 返回副本数组，防止外部修改影响内部状态。
   *
   * @returns RouteMetadata[] 路由元信息列表
   */
  getRoutes(): RouteMetadata[] {
    return [...this.routes];
  }

  /**
   * 获取所有已注册用户路由，包括 OpenAPI 隐藏路由。
   *
   * 内建端点在写入 adapter 前使用该视图做保留路径冲突检查；它不改变
   * getRoutes() 的 OpenAPI 可见性语义。
   */
  getRegisteredRoutes(): Array<
    Pick<RouteMetadata, "method" | "path" | "sourceFile">
  > {
    return this.registeredRoutes.map((route) => ({ ...route }));
  }

  /**
   * 获取收集到的路由数量
   *
   * @returns 已收集的路由条数
   */
  getCount(): number {
    return this.routes.length;
  }

  /**
   * 清空所有收集到的路由元信息
   *
   * dev 模式热重载时调用，清空后重新扫描 routes/ 收集。
   * 确保文档反映最新的路由状态。
   */
  clear(): void {
    this.routes = [];
    this.registeredRoutes = [];
  }
}
