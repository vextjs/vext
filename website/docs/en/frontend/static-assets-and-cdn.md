# Static Assets and CDN

Vext has two static asset locations with different behavior.

## Asset Locations

| Location                 | Behavior                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| `src/frontend/assets/**` | Imported by TSX/CSS and processed through the frontend asset graph. |
| `public/**`              | Copied as public files and addressed by URL.                        |

Use imported assets when a component owns the image, font, or media file. Use `public/**` for files that need fixed URLs such as `favicon.svg`, `robots.txt`, or externally referenced files.

## Imported Assets

```tsx
import logoUrl from "@assets/logo.png";

export function Logo() {
  return <img src={logoUrl} alt="Logo" />;
}
```

Production builds use content-hashed output so browsers and CDNs can cache aggressively. Content-hashed bundle assets are served with long-lived immutable cache headers.

The frontend static mount sends `ETag` and `Last-Modified` validators. Conditional `If-None-Match` and `If-Modified-Since` requests can return `304` without an entity body.

Static request paths are canonicalized before filesystem access. Absolute or encoded traversal paths are rejected, and a symbolic link that resolves outside the configured static root is never served.

## Public Files

```text
public/favicon.svg -> /favicon.svg
public/docs/openapi.json -> /docs/openapi.json
```

Public files are included in the deploy manifest so release tooling can upload them with the rest of the frontend assets.

Public files keep stable URLs, so the runtime serves them with revalidation headers by default:

```http
Cache-Control: no-cache, max-age=0, must-revalidate
```

Use imported assets for files that should receive immutable long-cache headers after content hashing. Source maps and non-hashed files are also served with revalidation headers.

## CDN URL

Set `frontend.deploy.assetBaseUrl` when production assets are served from a CDN:

```ts
frontend: {
  deploy: {
    assetBaseUrl: "https://cdn.example.com/my-app/",
  },
}
```

This changes generated asset URLs. Upload is controlled separately by `frontend.deploy.upload`, `vext build --upload-assets`, or `vext deploy assets`.

## Incremental Upload

`deploy-manifest.json` plus sha256 state lets Vext skip unchanged images, fonts, JS, CSS, and public files. This is the default path for enterprise releases where large media files should not be re-uploaded every build.

The deploy manifest is treated as untrusted input. Every asset path must be normalized, relative, unique, and contained by the frontend output in both lexical and realpath terms. Absolute/traversal entries, escaping symbolic links, duplicate upload keys, or size/sha256 drift stop planning and upload before any asset is transferred.

## Local Media Pipeline

`config.frontend.media` compiles only local raster files found under
`src/frontend/assets/**`. It writes content-addressed image variants and a
media manifest into the normal frontend output, so those files participate in
SRI and incremental deploy closure.

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

All limits are positive and build-time enforced. `media.maxBytes` bounds the
complete generated closure. Vext refuses an unreadable source, oversized
decoded input, too many variants, or a media closure that exceeds the
configured byte budget.

### Images

Use `Image` with the local source path relative to `src/frontend`; it reads
the document media manifest and emits width/height, responsive `srcSet`,
`sizes`, format sources, and a placeholder. `priority` produces an eager,
high-priority image and the corresponding document preload.

```tsx
import { Image } from "vextjs/frontend";

export function Hero() {
  return (
    <Image
      src="assets/hero.png"
      alt="Product overview"
      width={960}
      height={540}
      sizes="(max-width: 768px) 100vw, 960px"
      priority
    />
  );
}
```

Vext never fetches or proxies a remote image. A remote `src` requires an
explicit `defineImageLoader({ allowlist, load })`; the loader owns the remote
URL and must return an absolute HTTP(S) URL.

### Fonts

Declare a local font descriptor in a frontend source file. `defineFont`
requires a local `src`, a family, and a license identifier or application
license reference. The compiler emits a local WOFF2 subset and deterministic
`@font-face` CSS; equivalent descriptors are deduplicated.

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

Remote font URLs are rejected. The local media worker has no CDN SDK, remote
font downloader, or bundler plugin layer.
