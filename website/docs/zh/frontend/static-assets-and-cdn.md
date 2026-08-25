# 静态资源与 CDN

Vext 有两个静态资源位置，它们行为不同。

## 资源位置

| 位置                     | 行为                                      |
| ------------------------ | ----------------------------------------- |
| `src/frontend/assets/**` | 被 TSX/CSS import，进入前端 asset graph。 |
| `public/**`              | 按 public 文件复制，并通过 URL 访问。     |

组件拥有的图片、字体、媒体文件建议放在 import 型 assets 中。固定 URL 文件，如 `favicon.svg`、`robots.txt` 或外部引用文件，放在 `public/**`。

## Import 型资源

```tsx
import logoUrl from "@assets/logo.png";

export function Logo() {
  return <img src={logoUrl} alt="Logo" />;
}
```

生产构建会输出内容哈希文件，方便浏览器和 CDN 长缓存。带内容哈希的 bundle 资源会使用长期 immutable 缓存响应头。

前端 static mount 会发送 `ETag` 和 `Last-Modified` validator。条件请求 `If-None-Match` 与 `If-Modified-Since` 可返回无实体 body 的 `304`。

Static request path 会在访问文件系统前完成 canonicalization。绝对路径、编码后的 traversal path 会被拒绝，解析后逃出已配置 static root 的符号链接也绝不会被服务。

## Public 文件

```text
public/favicon.svg -> /favicon.svg
public/docs/openapi.json -> /docs/openapi.json
```

Public 文件会进入 deploy manifest，可以和其它前端资源一起上传。

Public 文件保持稳定 URL，因此运行时默认使用重新验证缓存响应头：

```http
Cache-Control: no-cache, max-age=0, must-revalidate
```

需要 immutable 长缓存的文件请通过 import 型 assets 进入内容哈希输出。Source map 与未带内容哈希的文件同样使用重新验证缓存响应头。

## CDN URL

生产资源由 CDN 服务时设置 `frontend.deploy.assetBaseUrl`：

```ts
frontend: {
  deploy: {
    assetBaseUrl: "https://cdn.example.com/my-app/",
  },
}
```

这会改变生成的资源 URL。上传仍由 `frontend.deploy.upload`、`vext build --upload-assets` 或 `vext deploy assets` 控制。

## 增量上传

`deploy-manifest.json` 加 sha256 state 让 Vext 跳过未变化的图片、字体、JS、CSS 和 public 文件。这是企业发布中避免大文件重复上传的默认路径。

Deploy manifest 被视为不可信输入。每个 asset path 都必须规范化、保持相对且唯一，并在 lexical 与 realpath 两层都被前端输出目录包含。绝对/traversal 条目、逃逸的符号链接、重复 upload key 或 size/sha256 漂移，都会在传输任何资源前终止 plan 与 upload。

## 本地媒体流水线

`config.frontend.media` 只编译 `src/frontend/assets/**` 下的本地栅格图片。它会把内容寻址的图片 variants 与 media manifest 写入普通前端输出，因此这些文件会进入 SRI 和增量 deploy closure。

```ts
export default {
  frontend: {
    media: {
      maxBytes: 20 * 1024 * 1024,
      images: {
        widths: [320, 640, 960, 1280, 1600],
        formats: ["original", "webp", "avif"],
        quality: 75,
        maxInputPixels: 40_000_000,
        maxVariants: 24,
      },
      fonts: {
        maxBytes: 5 * 1024 * 1024,
      },
    },
  },
};
```

所有限制都必须为正数，并在构建期执行。`media.maxBytes` 限定完整生成 closure 的总字节数。不可读的输入、过大的解码像素、过多 variants 或超过总字节预算的 media closure 都会使构建失败。

### 图片

对相对 `src/frontend` 的本地源路径使用 `Image`。组件读取 document 中的 media manifest，输出 width/height、响应式 `srcSet`、`sizes`、多格式 source 与 placeholder。设置 `priority` 会输出 eager/high-priority 图片和对应的 document preload。

```tsx
import { Image } from "vextjs/frontend";

export function Hero() {
  return (
    <Image
      src="assets/hero.png"
      alt="产品概览"
      width={960}
      height={540}
      sizes="(max-width: 768px) 100vw, 960px"
      priority
    />
  );
}
```

Vext 从不抓取或代理远程图片。远程 `src` 必须显式提供 `defineImageLoader({ allowlist, load })`；loader 自己负责远程 URL，并且必须返回绝对 HTTP(S) URL。

### 字体

在 frontend 源文件中声明本地字体 descriptor。`defineFont` 要求本地 `src`、font family 和许可证标识或应用自有许可证引用。编译器会输出本地 WOFF2 subset 与确定性的 `@font-face` CSS；等价 descriptor 会被去重。

```ts
import { defineFont } from "vextjs/frontend";

export const brandFont = defineFont({
  src: "./assets/BrandSans.ttf",
  family: "Brand Sans",
  weight: 400,
  display: "swap",
  preload: true,
  fallback: "system-ui",
  license: "OFL-1.1",
});
```

远程 font URL 会被拒绝。本地 media worker 不包含 CDN SDK、远程字体下载器或 bundler plugin 层。
