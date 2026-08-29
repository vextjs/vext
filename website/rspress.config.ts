import * as path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";
import docsVersions from "./version-channels.json";

const DEFAULT_DOCS_BASE = "/vextjs/";
const DEFAULT_DOCS_SITE_URL = "https://devcodex-labs.github.io/vextjs";

function normalizeDocsBase(value?: string) {
  const raw = value?.trim() || DEFAULT_DOCS_BASE;
  if (raw === "/") {
    return "/";
  }

  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/g, "");
}

const docsBase = normalizeDocsBase(process.env.VEXT_DOCS_BASE);
const docsSiteUrl = trimTrailingSlash(
  process.env.VEXT_DOCS_SITE_URL || DEFAULT_DOCS_SITE_URL,
);
const docsHomeUrl = `${docsSiteUrl}/`;
const docsOgImage = `${docsSiteUrl}/og-card.svg`;

type SidebarGroup = {
  text: string;
  items: Array<{
    text: string;
    link: string;
  }>;
};

type NavItemSource =
  | {
      en: string;
      zh: string;
      link: string;
      activeMatch?: string;
    }
  | {
      en: string;
      zh: string;
      items: Array<{
        en: string;
        zh: string;
        link: string;
      }>;
    };

const localizeLink = (link: string, language: "en" | "zh") => {
  if (language === "en" || /^https?:\/\//.test(link)) {
    return link;
  }

  return link === "/" ? "/zh/" : `/zh${link}`;
};

const localizeActiveMatch = (
  activeMatch: string | undefined,
  language: "en" | "zh",
) => {
  if (!activeMatch || language === "en") {
    return activeMatch;
  }

  if (activeMatch.startsWith("^/")) {
    return activeMatch.replace("^/", "^/zh/");
  }

  if (activeMatch.startsWith("/")) {
    return `/zh${activeMatch}`;
  }

  return activeMatch;
};

const navSource: NavItemSource[] = [
  {
    en: "Guide",
    zh: "指南",
    link: "/guide/introduction",
    activeMatch: "^/guide/(introduction|quick-start|project-structure)",
  },
  {
    en: "Frontend",
    zh: "前端",
    link: "/frontend/overview",
    activeMatch: "^/(frontend|guide/frontend)",
  },
  {
    en: "Runtime",
    zh: "运行时",
    link: "/guide/routing",
    activeMatch:
      "^/guide/(routing|services|middleware|plugins|hooks|request-context|configuration|adapters)",
  },
  {
    en: "Data",
    zh: "数据",
    link: "/guide/validation",
    activeMatch:
      "^/guide/(validation|cookies-session|cache|database|fetch|openapi)",
  },
  {
    en: "Tooling & Operations",
    zh: "工具与运维",
    link: "/guide/deployment",
    activeMatch:
      "^/guide/(build|deployment|testing|cli|hot-reload|preload|cluster|i18n|logger|error-handling)",
  },
  {
    en: "API Reference",
    zh: "API 参考",
    link: "/api/config",
    activeMatch: "^/api/",
  },
  {
    en: "Resources",
    zh: "资源",
    items: [
      {
        en: "Examples",
        zh: "示例",
        link: "/examples/hello-world",
      },
      {
        en: "Benchmark",
        zh: "基准测试",
        link: "/benchmark.html",
      },
      {
        en: "Contributing",
        zh: "贡献指南",
        link: "https://github.com/devcodex-labs/vextjs/blob/main/CONTRIBUTING.md",
      },
      {
        en: "Support & Services",
        zh: "支持与服务",
        link: "/resources/support-and-services",
      },
      {
        en: "Docs Data & AI",
        zh: "文档数据与 AI",
        link: "/resources/documentation-data-and-ai",
      },
    ],
  },
  {
    en:
      docsVersions.channel === "next"
        ? `v${docsVersions.next} (Next)`
        : `v${docsVersions.stable}`,
    zh:
      docsVersions.channel === "next"
        ? `v${docsVersions.next}（预览）`
        : `v${docsVersions.stable}`,
    items: [
      {
        en: "Changelog",
        zh: "更新日志",
        link: "https://github.com/devcodex-labs/vextjs/blob/main/CHANGELOG.md",
      },
    ],
  },
];

const createNav = (language: "en" | "zh") =>
  navSource.map((item) => {
    if ("items" in item) {
      return {
        text: item[language],
        items: item.items.map((child) => ({
          text: child[language],
          link: localizeLink(child.link, language),
        })),
      };
    }

    return {
      text: item[language],
      link: localizeLink(item.link, language),
      activeMatch: localizeActiveMatch(item.activeMatch, language),
    };
  });

const englishNav = createNav("en");
const chineseNav = createNav("zh");

const englishSidebar: SidebarGroup[] = [
  {
    text: "Start",
    items: [
      { text: "Introduction", link: "/guide/introduction" },
      { text: "Quick Start", link: "/guide/quick-start" },
      { text: "Project Structure", link: "/guide/project-structure" },
    ],
  },
  {
    text: "Runtime",
    items: [
      { text: "Routing", link: "/guide/routing" },
      { text: "Services", link: "/guide/services" },
      { text: "Middleware", link: "/guide/middleware" },
      { text: "Plugins", link: "/guide/plugins" },
      { text: "Runtime Hooks", link: "/guide/hooks" },
      { text: "Request Context", link: "/guide/request-context" },
      { text: "Configuration", link: "/guide/configuration" },
      { text: "Adapter Architecture", link: "/guide/adapters" },
    ],
  },
  {
    text: "Data and APIs",
    items: [
      { text: "Validation", link: "/guide/validation" },
      { text: "Cookies & Sessions", link: "/guide/cookies-session" },
      { text: "Response Cache", link: "/guide/cache" },
      { text: "Database", link: "/guide/database" },
      { text: "HTTP Client", link: "/guide/fetch" },
      { text: "OpenAPI", link: "/guide/openapi" },
    ],
  },
  {
    text: "Tooling & Operations",
    items: [
      { text: "Build", link: "/guide/build" },
      { text: "Deployment", link: "/guide/deployment" },
      { text: "Testing", link: "/guide/testing" },
      { text: "CLI Commands", link: "/guide/cli" },
      { text: "Hot Reload", link: "/guide/hot-reload" },
      { text: "Preload", link: "/guide/preload" },
      { text: "Cluster", link: "/guide/cluster" },
      { text: "Internationalization (i18n)", link: "/guide/i18n" },
      { text: "Logger", link: "/guide/logger" },
      { text: "Error Handling", link: "/guide/error-handling" },
    ],
  },
  {
    text: "API Reference",
    items: [
      { text: "Config", link: "/api/config" },
      { text: "Route Definition", link: "/api/route-definition" },
      { text: "Request and Response", link: "/api/context" },
      { text: "App", link: "/api/app" },
      { text: "Fetch API", link: "/api/fetch" },
      { text: "Plugin API", link: "/api/plugin-api" },
      { text: "Testing API", link: "/api/testing-api" },
      { text: "Access Log", link: "/api/access-log" },
    ],
  },
  {
    text: "Examples",
    items: [
      { text: "Hello World", link: "/examples/hello-world" },
      { text: "CRUD API", link: "/examples/crud-api" },
    ],
  },
  {
    text: "Ecosystem Integrations",
    items: [
      { text: "permission-core Auth", link: "/examples/permission-core-auth" },
      { text: "Nacos", link: "/examples/nacos-integration" },
      { text: "OpenTelemetry", link: "/examples/opentelemetry" },
    ],
  },
  { text: "Benchmarking", link: "/benchmark" },
];

const englishFrontendSidebar: SidebarGroup[] = [
  {
    text: "Start",
    items: [
      { text: "Overview", link: "/frontend/overview" },
      { text: "Getting Started", link: "/frontend/getting-started" },
      { text: "Project Structure", link: "/frontend/project-structure" },
    ],
  },
  {
    text: "Core Concepts",
    items: [
      { text: "Routing and Pages", link: "/frontend/routing-and-pages" },
      { text: "Rendering Modes", link: "/frontend/rendering-modes" },
      { text: "Data Flow", link: "/frontend/data-flow" },
      {
        text: "Layouts and Components",
        link: "/frontend/layouts-and-components",
      },
      { text: "Styles and Assets", link: "/frontend/styles-and-assets" },
      { text: "Vext JSCSS", link: "/frontend/jscss" },
    ],
  },
  {
    text: "Rendering Modes",
    items: [
      { text: "SSR", link: "/frontend/ssr" },
      { text: "Hydration", link: "/frontend/hydration" },
      { text: "SEO, Sitemap, and Robots", link: "/frontend/seo-sitemap" },
      {
        text: "CSR and SPA Fallback",
        link: "/frontend/csr-and-spa-fallback",
      },
      {
        text: "Render Data and Cache",
        link: "/frontend/render-data-and-cache",
      },
    ],
  },
  {
    text: "Development",
    items: [
      { text: "Dev Workflow", link: "/frontend/dev-workflow" },
      { text: "Fast Refresh", link: "/frontend/fast-refresh" },
      { text: "Render Refresh", link: "/frontend/render-refresh" },
      {
        text: "Diagnostics and Leak Scan",
        link: "/frontend/diagnostics-and-leak-scan",
      },
    ],
  },
  {
    text: "Production",
    items: [
      { text: "Build and Deploy", link: "/frontend/build-and-deploy" },
      { text: "Code Splitting", link: "/frontend/code-splitting" },
      {
        text: "Static Assets and CDN",
        link: "/frontend/static-assets-and-cdn",
      },
      { text: "Performance Budgets", link: "/frontend/performance-budgets" },
      { text: "Hydration Validation", link: "/frontend/hydration-validation" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Configuration", link: "/frontend/configuration" },
      {
        text: "API Client and Contracts",
        link: "/frontend/api-client-and-contracts",
      },
      { text: "Errors and Document", link: "/frontend/errors-and-document" },
      { text: "I18n", link: "/frontend/i18n" },
      { text: "Troubleshooting", link: "/frontend/troubleshooting" },
      {
        text: "Boundaries and Roadmap",
        link: "/frontend/boundaries-and-roadmap",
      },
    ],
  },
];

const chineseSidebar: SidebarGroup[] = [
  {
    text: "开始",
    items: [
      { text: "介绍", link: "/zh/guide/introduction" },
      { text: "快速开始", link: "/zh/guide/quick-start" },
      { text: "项目结构", link: "/zh/guide/project-structure" },
    ],
  },
  {
    text: "运行时",
    items: [
      { text: "路由", link: "/zh/guide/routing" },
      { text: "服务层", link: "/zh/guide/services" },
      { text: "中间件", link: "/zh/guide/middleware" },
      { text: "插件", link: "/zh/guide/plugins" },
      { text: "运行时 Hooks", link: "/zh/guide/hooks" },
      { text: "请求上下文", link: "/zh/guide/request-context" },
      { text: "配置", link: "/zh/guide/configuration" },
      { text: "Adapter 架构", link: "/zh/guide/adapters" },
    ],
  },
  {
    text: "数据与接口",
    items: [
      { text: "参数校验", link: "/zh/guide/validation" },
      { text: "Cookies 与 Sessions", link: "/zh/guide/cookies-session" },
      { text: "响应缓存", link: "/zh/guide/cache" },
      { text: "数据库 (MonSQLize)", link: "/zh/guide/database" },
      { text: "内置 HTTP 客户端", link: "/zh/guide/fetch" },
      { text: "OpenAPI 文档", link: "/zh/guide/openapi" },
    ],
  },
  {
    text: "工具与运维",
    items: [
      { text: "构建", link: "/zh/guide/build" },
      { text: "部署与生产环境", link: "/zh/guide/deployment" },
      { text: "测试", link: "/zh/guide/testing" },
      { text: "CLI 命令", link: "/zh/guide/cli" },
      { text: "热重载", link: "/zh/guide/hot-reload" },
      { text: "预加载 (Preload)", link: "/zh/guide/preload" },
      { text: "Cluster 多进程", link: "/zh/guide/cluster" },
      { text: "国际化 (i18n)", link: "/zh/guide/i18n" },
      { text: "日志", link: "/zh/guide/logger" },
      { text: "错误处理", link: "/zh/guide/error-handling" },
    ],
  },
  {
    text: "API 参考",
    items: [
      { text: "配置项", link: "/zh/api/config" },
      { text: "路由定义", link: "/zh/api/route-definition" },
      { text: "请求与响应", link: "/zh/api/context" },
      { text: "应用实例", link: "/zh/api/app" },
      { text: "Fetch API", link: "/zh/api/fetch" },
      { text: "插件 API", link: "/zh/api/plugin-api" },
      { text: "测试工具", link: "/zh/api/testing-api" },
      { text: "Access Log 中间件", link: "/zh/api/access-log" },
    ],
  },
  {
    text: "示例",
    items: [
      { text: "Hello World", link: "/zh/examples/hello-world" },
      { text: "CRUD API", link: "/zh/examples/crud-api" },
    ],
  },
  {
    text: "生态集成",
    items: [
      {
        text: "permission-core Auth 接入",
        link: "/zh/examples/permission-core-auth",
      },
      { text: "Nacos 接入", link: "/zh/examples/nacos-integration" },
      { text: "OpenTelemetry 可观测性", link: "/zh/examples/opentelemetry" },
    ],
  },
  { text: "基准测试", link: "/zh/benchmark" },
];

const chineseFrontendSidebar: SidebarGroup[] = [
  {
    text: "开始",
    items: [
      { text: "总览", link: "/zh/frontend/overview" },
      { text: "快速开始", link: "/zh/frontend/getting-started" },
      { text: "项目结构", link: "/zh/frontend/project-structure" },
    ],
  },
  {
    text: "核心概念",
    items: [
      { text: "路由与页面", link: "/zh/frontend/routing-and-pages" },
      { text: "渲染模式", link: "/zh/frontend/rendering-modes" },
      { text: "数据流", link: "/zh/frontend/data-flow" },
      { text: "Layout 与组件", link: "/zh/frontend/layouts-and-components" },
      { text: "样式与资源", link: "/zh/frontend/styles-and-assets" },
      { text: "Vext JSCSS", link: "/zh/frontend/jscss" },
    ],
  },
  {
    text: "渲染模式",
    items: [
      { text: "SSR", link: "/zh/frontend/ssr" },
      { text: "Hydration", link: "/zh/frontend/hydration" },
      { text: "SEO、Sitemap 与 Robots", link: "/zh/frontend/seo-sitemap" },
      {
        text: "CSR 与 SPA Fallback",
        link: "/zh/frontend/csr-and-spa-fallback",
      },
      {
        text: "Render Data 与缓存",
        link: "/zh/frontend/render-data-and-cache",
      },
    ],
  },
  {
    text: "开发体验",
    items: [
      { text: "开发工作流", link: "/zh/frontend/dev-workflow" },
      { text: "Fast Refresh", link: "/zh/frontend/fast-refresh" },
      { text: "Render Refresh", link: "/zh/frontend/render-refresh" },
      {
        text: "诊断与 Leak Scan",
        link: "/zh/frontend/diagnostics-and-leak-scan",
      },
    ],
  },
  {
    text: "生产交付",
    items: [
      { text: "构建与发布", link: "/zh/frontend/build-and-deploy" },
      { text: "代码拆分", link: "/zh/frontend/code-splitting" },
      {
        text: "静态资源与 CDN",
        link: "/zh/frontend/static-assets-and-cdn",
      },
      { text: "性能预算", link: "/zh/frontend/performance-budgets" },
      { text: "Hydration 验证", link: "/zh/frontend/hydration-validation" },
    ],
  },
  {
    text: "参考",
    items: [
      { text: "配置", link: "/zh/frontend/configuration" },
      {
        text: "API Client 与契约",
        link: "/zh/frontend/api-client-and-contracts",
      },
      { text: "错误页与 Document", link: "/zh/frontend/errors-and-document" },
      { text: "多语言", link: "/zh/frontend/i18n" },
      { text: "排错", link: "/zh/frontend/troubleshooting" },
      {
        text: "边界与路线图",
        link: "/zh/frontend/boundaries-and-roadmap",
      },
    ],
  },
];

export default defineConfig({
  root: path.join(__dirname, "docs"),
  base: docsBase,
  lang: "en",
  title: "VextJS",
  logo: "/logo.svg",
  logoText: "VextJS",
  icon: "/favicon.svg",
  description:
    "AI-first full-stack Node.js framework with typed contracts, OpenAPI, machine-readable docs, React SSR, and production runtime features.",
  locales: [
    {
      lang: "en",
      label: "English",
      title: "VextJS",
      description:
        "AI-first full-stack Node.js framework with typed contracts, OpenAPI, machine-readable docs, React SSR, and production runtime features.",
    },
    {
      lang: "zh",
      label: "简体中文",
      title: "VextJS",
      description:
        "VextJS 是 AI-first Node.js 全栈框架，通过约定、类型契约、OpenAPI 与机器可读文档支持 AI 辅助开发。",
    },
  ],
  outDir: "dist",
  head: [
    [
      "meta",
      {
        name: "google-site-verification",
        content: "eYbt9ZyPTFQHdpEJ8Iujlb9ndhmAcMlstxZd6106840",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "VextJS" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "AI-first full-stack Node.js framework with typed contracts, OpenAPI, machine-readable docs, React SSR, and production runtime features.",
      },
    ],
    ["meta", { property: "og:url", content: docsHomeUrl }],
    ["meta", { property: "og:image", content: docsOgImage }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  plugins: [
    pluginSitemap({
      siteUrl: docsSiteUrl,
    }),
  ],
  search: {
    codeBlocks: true,
  },
  languageParity: {
    enabled: true,
  },
  themeConfig: {
    darkMode: false,
    nav: englishNav,
    locales: [
      {
        lang: "en",
        label: "English",
        title: "VextJS",
        description:
          "AI-first full-stack Node.js framework with typed contracts, OpenAPI, machine-readable docs, React SSR, and production runtime features.",
        nav: englishNav,
        sidebar: {
          "/frontend/": englishFrontendSidebar,
          "/": englishSidebar,
        },
        footer: {
          message: "Released under the Apache-2.0 License.",
        },
      },
      {
        lang: "zh",
        label: "简体中文",
        title: "VextJS",
        description:
          "VextJS 是 AI-first Node.js 全栈框架，通过约定、类型契约、OpenAPI 与机器可读文档支持 AI 辅助开发。",
        nav: chineseNav,
        sidebar: {
          "/zh/frontend/": chineseFrontendSidebar,
          "/zh/": chineseSidebar,
        },
        footer: {
          message: "基于 Apache-2.0 License 发布。",
        },
      },
    ],
    sidebar: {
      "/frontend/": englishFrontendSidebar,
      "/zh/frontend/": chineseFrontendSidebar,
      "/": englishSidebar,
      "/zh/": chineseSidebar,
    },
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/devcodex-labs/vextjs",
      },
    ],
    footer: {
      message: "Released under the Apache-2.0 License.",
    },
    lastUpdated: true,
  },
});
