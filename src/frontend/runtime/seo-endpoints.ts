import type { VextApp } from "../../types/app.js";
import type { VextAdapter } from "../../types/adapter.js";
import type { VextRequest } from "../../types/request.js";
import type { VextResponse } from "../../types/response.js";
import type { ResolvedVextFrontendConfig } from "../contract/types.js";
import {
  collectRuntimeSitemapEntries,
  renderRobotsTxt,
  renderSitemapDocuments,
} from "../tooling/seo-artifact-writer.js";
import { selectRuntimeOrigin } from "./seo.js";

export interface RegisterFrontendSeoEndpointsOptions {
  adapter?: Pick<VextAdapter, "registerRoute">;
  existingRoutes?: ReadonlyArray<{
    method: string;
    path: string;
    sourceFile?: string;
  }>;
}

export function needsFrontendSeoRuntimeEndpoints(
  config: ResolvedVextFrontendConfig,
): boolean {
  if (!config.enabled || !config.seo.enabled) return false;
  return (
    (config.seo.sitemap !== false && config.seo.sitemap.mode === "runtime") ||
    (config.seo.robots !== false && config.seo.robots.mode === "runtime")
  );
}

/** Registers only explicitly configured runtime SEO artifacts. */
export function registerFrontendSeoEndpoints(
  app: VextApp,
  config: ResolvedVextFrontendConfig,
  options: RegisterFrontendSeoEndpointsOptions = {},
): void {
  if (!needsFrontendSeoRuntimeEndpoints(config)) return;
  assertNoFrontendSeoRouteConflicts(config, options.existingRoutes ?? []);

  const adapter = options.adapter ?? app.adapter;
  const sitemap = config.seo.sitemap;
  const robots = config.seo.robots;

  if (sitemap !== false && sitemap.mode === "runtime") {
    const sendSitemap = async (req: VextRequest, res: VextResponse) => {
      const selected = selectRuntimeOrigin(config.seo, req.headers.host);
      if (!selected) {
        res.status(404);
        res.text("Not Found");
        return;
      }
      const controller = new AbortController();
      req.onClose(() => controller.abort(new Error("request closed")));
      const entries = await collectRuntimeSitemapEntries({
        config,
        ...selected,
        signal: controller.signal,
      });
      const documents = renderSitemapDocuments(
        entries,
        selected.origin,
        sitemap.path,
        sitemap.maxUrlsPerFile,
      );
      const document = documents.find(
        (candidate) => candidate.pathname === req.path,
      );
      if (!document) {
        res.status(404);
        res.text("Not Found");
        return;
      }
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.text(document.content);
    };
    adapter.registerRoute("GET", sitemap.path, [sendSitemap]);
    adapter.registerRoute("GET", sitemapChunkRoute(sitemap.path), [
      sendSitemap,
    ]);
  }

  if (robots !== false && robots.mode === "runtime") {
    adapter.registerRoute("GET", robots.path, [
      async (req, res) => {
        const selected = selectRuntimeOrigin(config.seo, req.headers.host);
        if (!selected) {
          res.status(404);
          res.text("Not Found");
          return;
        }
        const sitemapUrl =
          sitemap !== false
            ? `${new URL(selected.origin).origin}${sitemap.path}`
            : undefined;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.text(renderRobotsTxt(robots.groups, sitemapUrl));
      },
    ]);
  }
}

export function assertNoFrontendSeoRouteConflicts(
  config: ResolvedVextFrontendConfig,
  routes: ReadonlyArray<{
    method: string;
    path: string;
    sourceFile?: string;
  }>,
): void {
  const reserved: string[] = [];
  const { sitemap, robots } = config.seo;
  if (sitemap !== false && sitemap.mode === "runtime") {
    reserved.push(sitemap.path, sitemapChunkRoute(sitemap.path));
  }
  if (robots !== false && robots.mode === "runtime") {
    reserved.push(robots.path);
  }

  const conflict = routes.find(
    (route) =>
      (route.method.toUpperCase() === "GET" ||
        route.method.toUpperCase() === "HEAD") &&
      reserved.some((reservedPath) =>
        routePatternsOverlap(route.path, reservedPath),
      ),
  );
  if (!conflict) return;

  throw new Error(
    `[vextjs] frontend SEO endpoint conflicts with user route ${conflict.method.toUpperCase()} ${conflict.path}` +
      (conflict.sourceFile ? ` from ${conflict.sourceFile}` : "") +
      ". Change the user route or config.frontend.seo output path.",
  );
}

function sitemapChunkRoute(sitemapPath: string): string {
  const dot = sitemapPath.lastIndexOf(".");
  const stem =
    dot > sitemapPath.lastIndexOf("/")
      ? sitemapPath.slice(0, dot)
      : sitemapPath;
  const extension =
    dot > sitemapPath.lastIndexOf("/") ? sitemapPath.slice(dot) : ".xml";
  return `${stem}-:chunk${extension}`;
}

function routePatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeRoutePattern(left);
  const normalizedRight = normalizeRoutePattern(right);
  return (
    compileRoutePattern(normalizedLeft).test(
      materializeRoutePattern(normalizedRight),
    ) ||
    compileRoutePattern(normalizedRight).test(
      materializeRoutePattern(normalizedLeft),
    )
  );
}

function normalizeRoutePattern(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function materializeRoutePattern(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z_$][\w$]*/gu, "1")
    .replace(/\*(?:[A-Za-z_$][\w$]*)?/gu, "1");
}

function compileRoutePattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === ":" || char === "*") {
      let end = index + 1;
      while (end < pattern.length && /[\w$]/u.test(pattern[end]!)) end++;
      if (end === index + 1) {
        source += char === "*" ? ".*" : escapeRegExp(char);
        continue;
      }
      source += char === ":" ? "[^/]+" : ".*";
      index = end - 1;
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`, "iu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
