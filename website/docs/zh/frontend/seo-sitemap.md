# SEO、Sitemap 与 Robots

Vext 把 SEO 作为全栈应用的框架能力提供。它会把应用默认值、路由元数据和单次渲染元数据合并进服务端输出的 document，并可在构建期生成或在运行时提供 `sitemap.xml` 与 `robots.txt`。

该能力是显式启用的；不配置 `frontend.seo` 时，既有渲染与构建产物不变。

## 基础配置

```ts
import type { VextUserConfig } from "vextjs";

const config: VextUserConfig = {
  frontend: {
    enabled: true,
    seo: {
      publicOrigin: process.env.PUBLIC_ORIGIN ?? "https://www.example.com",
      titleTemplate: "%s | Example",
      defaults: {
        description: "Example 全栈应用",
        robots: ["index", "follow"],
        openGraph: {
          siteName: "Example",
          type: "website",
        },
        twitter: { card: "summary_large_image" },
      },
      sitemap: {},
      robots: {},
    },
  },
};

export default config;
```

`publicOrigin` 表示部署 origin，不是把全站固定成同一个页面 URL。Vext 会把它与当前请求 pathname 组合，因此 `/posts/hello` 和 `/posts/release-notes` 会生成不同 canonical，即使它们共用一个 `publicOrigin`。

预览、测试和生产使用不同域名时，可由各环境设置 `PUBLIC_ORIGIN`。它必须是绝对 HTTP(S) URL，不能包含用户信息、query 或 hash。

## 页面级元数据

静态且 JSON-safe 的元数据放在既有路由声明上。有限静态语法以内联对象为最简单形式，也接受同文件 `const` 绑定与 TypeScript 静态包装。route options helper 调用会被拒绝，因为索引不会执行 helper 函数体，无法确认最终元数据。请内联最终对象，或直接传入保存最终对象的同文件 `const`。索引也不会执行导入值、计算表达式或带插值的模板字符串：

```ts
app.get(
  "/about",
  {
    frontend: {
      seo: {
        title: "关于我们",
        canonical: "/about",
        openGraph: { type: "profile" },
      },
    },
  },
  async (_req, res) => res.render("about"),
);
```

依赖业务数据的元数据放在 `res.render()` 第三个参数中：

```ts
app.get(
  "/posts/:slug",
  { frontend: { seo: { openGraph: { type: "article" } } } },
  async (req, res) => {
    const post = await app.services.posts.find(req.params.slug);

    res.render(
      "posts/detail",
      { post },
      {
        seo: {
          title: post.title,
          description: post.summary,
          canonical: `/posts/${post.slug}`,
          openGraph: { images: [post.image] },
          jsonLd: post.articleJsonLd,
        },
      },
    );
  },
);
```

合并顺序是 `frontend.seo.defaults` → `RouteOptions.frontend.seo` → `res.render(..., { seo })`。canonical、alternate 和相对 Open Graph URL 需要已声明的 origin。canonical 与 sitemap 使用绝对 pathname；query 和 hash 会被拒绝，避免误生成重复 URL。

支持 title、description、robots 指令、canonical、Open Graph、Twitter card、多语言 alternate 和 JSON-LD。既有 `res.render(..., { head })` 继续兼容；显式 legacy head 字段在结构化 SEO 之后合并。

## 构建期 Sitemap

`sitemap: {}` 默认使用 build 模式。成功生成的静态页面会自动进入 sitemap，entries provider 可补充构建期已知的动态路径：

```ts
seo: {
  publicOrigin: "https://www.example.com",
  sitemap: {
    mode: "build",
    includeStatic: true,
    entries: async ({ signal }) => {
      const response = await fetch("https://cms.example.com/seo/posts", {
        signal,
      });
      const posts = (await response.json()) as Array<{
        slug: string;
        updatedAt: string;
      }>;
      return posts.map((post) => ({
        pathname: `/posts/${post.slug}`,
        lastmod: post.updatedAt,
        changefreq: "weekly" as const,
        priority: 0.7,
      }));
    },
  },
  robots: {},
}
```

build 模式必须配置 `publicOrigin`。产物会写入前端构建 closure，并以正确的 XML/TXT MIME 进入 deploy manifest。设置 `frontend.seo.index: false` 或 robots 包含 `noindex` 的静态路由不会进入 sitemap。URL 数量超过 `maxUrlsPerFile` 时会生成 sitemap index 与编号分片；默认上限为 50,000。

完整 sitemap 集合还有独立预算：`maxUrls` 默认 100,000，`maxBytes` 默认 50 MiB 渲染后 UTF-8 输出，运行时 `timeoutMs` 默认 5,000 ms。任一预算超限时生成会立即停止并 fail closed；运行时期限会中止 provider signal。

provider 只接收 `{ mode, origin, originKey, signal }`；Vext 不会向配置回调注入 `app`、services 或 `app.db`。动态条目应来自构建期安全模块或外部内容源，并正确响应 abort signal。

## 运行时 Sitemap 与动态域名

条目或公开域名需要按请求选择时使用 runtime 模式：

```ts
seo: {
  publicOrigin: "https://www.example.com",
  origins: {
    cn: "https://www.example.cn",
    docs: "https://docs.example.com",
  },
  sitemap: {
    mode: "runtime",
    entries: async ({ originKey, signal }) => {
      const response = await fetch(
        `https://cms.example.com/seo/paths?site=${originKey ?? "default"}`,
        { signal },
      );
      const paths = (await response.json()) as string[];
      return paths.map((pathname) => ({
        pathname,
        ...(originKey ? { originKey } : {}),
      }));
    },
  },
  robots: { mode: "runtime" },
}
```

运行时请求的 `Host` 必须精确匹配 `publicOrigin` 或 `origins` 中的一项。未知 host 返回 404，不会生成受攻击者 Host 控制的 canonical 或 sitemap URL。路由或单次 render 可通过 `seo.originKey` 选择有限命名 origin；未声明 key 会 fail closed。

配置的 origin 会按 trailing dot 与默认端口等规则规范化后比较 host，同时保留 `publicOrigin` 中的 pathname base，并用于 canonical、sitemap index、分片和 robots URL。运行时 SEO endpoint 同时支持 `GET` 与 `HEAD`；`HEAD` 返回相同 status 与 headers，但不输出实体 body。

runtime sitemap 与 robots 响应使用 `Cache-Control: no-store`。只有在明确 host 和刷新策略后，才应在反向代理增加缓存。

## Robots

```ts
robots: {
  mode: "build",
  groups: [
    { userAgent: "*", allow: "/", disallow: ["/admin", "/preview"] },
    { userAgent: "ExampleBot", crawlDelay: 2 },
  ],
}
```

robots 路径固定为 `/robots.txt`。启用 sitemap 时，生成的 robots 文件也会写入 sitemap URL。runtime SEO endpoint 若与用户已有 `GET` 或 `HEAD` 路由冲突，应用会在启动时失败并给出冲突说明。

## 无浏览器 Hydration 的 SEO

SEO 在 document policy 之前应用，因此 `frontend.hydration: "none"` 路由仍保留 SSR HTML、CSS、canonical、Open Graph、JSON-LD 与用户写在 document 中的 script，同时省略 Vext/React 浏览器 runtime。精确边界见 [Hydration](/zh/frontend/hydration)。

这是页面级 server-only 渲染，不等于 Selective 或 Partial Hydration、Islands 架构、React Server Components 或 Partial Prerendering（PPR）。
