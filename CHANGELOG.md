# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 📂 **Detailed changelogs**: See the [`changelogs/`](./changelogs/) directory for full release notes per version.
> This file serves as a version overview index for quick browsing of release history.

---

## [Unreleased]

### 2.0.0 candidate

#### Added

- Framework-level `frontend.seo` metadata, canonical, robots, and build/runtime
  sitemap contracts, including per-page values, provider entries, and explicit
  named deployment origins.
- Route-level `hydration: "none"` for SSR pages that must emit HTML without a
  client entry, serialized page payload, or React runtime.
- Executable Hello World and MongoDB CRUD examples with install, typecheck,
  build, runtime, validation, and OpenAPI assertions.
- Explicit TypeScript scaffold boundaries under `src/types/shared`,
  `src/types/frontend`, and Vext-managed `src/types/generated`; JavaScript
  starters do not receive a public TypeScript source tree.

#### Changed

- `app.db` is now the single raw MonSQLize instance surface, preserving the
  upstream API and adding only a read-only Mongo client getter plus narrow
  soft-delete result compatibility.
- Model lookup uses exact registered keys; database/pool scopes no longer
  synthesize or fall back through prefixed keys.
- Global rate limiting now defaults to off and is installed only when
  `rateLimit.enabled === true`; direct factory and route override contracts are
  preserved.
- Path-parameter validation failures now return HTTP 400; body, query, header,
  and cookie validation failures remain HTTP 422.
- OpenAPI Docs now shares Vext brand geometry, favicon, teal/cyan light/dark
  tokens, and green/amber mark accents with the frontend.
- Build-indexed route modules now bind a named `defineRoutes` import from
  `vextjs` to a finite set of default-export forms. Import aliases, inline
  synchronous factories, and same-file top-level route-definition bindings are accepted;
  re-exports, imported factories, callback identifiers, property callees, and
  unused phantom `defineRoutes` calls are rejected or ignored as appropriate.
- Build-indexed route metadata now follows a finite static grammar: literals,
  same-file `const` bindings, TypeScript static wrappers, and canonical
  `schemaAdapter.compileField(<static string>)` builders are accepted. Route
  options helper calls, opaque schema objects, dynamic paths or schemas,
  conditional registration, and nested registration fail with route context;
  request-dependent SEO remains supported through `res.render(..., { seo })`.
- Fastify handlers now retain reply ownership until a delayed SSR stream sends,
  preventing React streaming responses from being finalized as an empty body.
- New TypeScript scaffolds declare `@types/node` and run
  `vext build --typecheck` from the generated build script. TypeScript
  create/dev/typegen owns `src/types/generated`; JavaScript flows keep tooling
  declarations under `.vext/types` and do not create that public shim.

#### Fixed

- `defineRoutes()` now enforces a synchronous factory at the type and runtime
  boundaries. Native async factories fail before execution, and custom
  thenables fail transactionally without leaving partially registered routes or
  clearing the route helper methods.
- SEO artifact output containment now treats POSIX and Windows separators,
  drive paths, UNC paths, and traversal segments consistently on every host.
- Ordinary `main` CI now distinguishes the unpublished 2.0.0 docs preview from
  npm stable 1.0.2; tag releases retain an exact-version gate, and automatic
  Pages deployment waits for the successful CI commit.
- Pull requests execute the coverage job required by the aggregate `ci-ok`
  gate, and final preflight reads external-consumer evidence for the current
  package major instead of reusing v1 evidence.
- Changed-file formatting pins the tracked `.gitignore` as its ignore source,
  so an ignored local `.prettierignore` cannot hide failures that a clean CI
  checkout would detect.
- SEO input is deeply normalized across defaults and routes; request-host
  origin ambiguity, robots control characters, bare-wildcard endpoint
  conflicts, and concurrent artifact-writer ownership now fail safely.
- OpenAPI error responses and build-time request contracts now reuse the
  runtime's canonical validation shapes, including path `400` versus other
  request-validation `422` behavior.
- TypeScript service loading now waits for its best-effort temporary-module
  cleanup before returning, avoiding Windows directory-removal races under
  concurrent test or application teardown.

#### Removed

- Removed the duplicate `app.monsqlize` property; use the raw `app.db` entry
  point for collections, Models, transactions, pools, events, and diagnostics.

This entry documents the local 2.0.0 package candidate and does not claim that
the package has been published.

## Version History

| Version      | Date       | Type            | Key Theme                                                                                                                                                                                               |
| ------------ | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Unreleased] | —          | —               | —                                                                                                                                                                                                       |
| [2.0.0]      | —          | Major candidate | Framework SEO/sitemaps, pure-HTML SSR routes, branded OpenAPI Docs, executable examples, raw `app.db`, explicit type boundaries, and opt-in rate limiting [view](./changelogs/v2.0.0.md)                |
| [1.0.2]      | 2026-08-17 | Patch           | Runtime contract fixes, OpenAPI/upload lifecycle documentation, adapter-matrix benchmark documentation, dependency and release hardening [view](./changelogs/v1.0.2.md)                                 |
| [1.0.1]      | 2026-08-10 | Patch           | Docs/release validation: English product README, locale-specific AI indexes, `npx vextjs create` cold-start, identity/contract/compare URL fixes [view](./changelogs/v1.0.1.md)                         |
| [1.0.0]      | 2026-08-10 | Major           | 首个稳定 v1：schema-dsl v3 / monsqlize 3.1 固定 GA 依赖、完整 route-native 前端运行时、SSR starter、文档与发布安全门禁；包含 Hono Node 流式响应桥生命周期修复 [查看](./changelogs/v1.0.0.md)            |
| [0.3.8]      | 2026-05-31 | Patch           | 发布前收口：补齐 adapter/body-limit/cluster 验证闭环，移除 npm 包 sourcemap 产物，并同步 vext-test 外部消费者验证 [查看](./changelogs/v0.3.8.md)                                                        |
| [0.3.7]      | 2026-05-21 | Patch           | `vext dev` 补齐 preflight 诊断与 typegen 自动生成：阻断 TS 错误热重载、补全 reload 堆栈，并移除脚手架静态 services 类型声明 [查看](./changelogs/v0.3.7.md)                                              |
| [0.3.6]      | 2026-05-16 | Patch           | 项目级 `preload/` 目录正式落地：补齐 TS preload、`build` / built 模式联动、`fs.watch` 动态监听与消费者验收闭环 [查看](./changelogs/v0.3.6.md)                                                           |
| [0.3.5]      | 2026-05-15 | Patch           | README 与 OpenTelemetry 文档对齐当前 preload / exporter / capture 模型，并完成一轮发版前全链路验证 [查看](./changelogs/v0.3.5.md)                                                                       |
| [0.3.4]      | 2026-05-13 | Patch           | 插件类型边界收口：新增 `VextPluginContext`，修复 linked workspace 下的重复类型冲突，并补齐 typegen/文档/验证链路 [查看](./changelogs/v0.3.4.md)                                                         |
| [0.3.3]      | 2026-05-06 | Patch           | ts-morph 开发辅助能力二期收口：新增 `services.manifest.json`，并完成 `typegen + doctor routes + inspect/manifest` 双轨稳定消费层 [查看](./changelogs/v0.3.3.md)                                         |
| [0.3.2]      | 2026-04-28 | Patch           | 启动体验与远程配置优化：新增 bootstrap config provider、端口冲突策略、生命周期日志分层，并补齐 lint、测试与文档验证 [查看](./changelogs/v0.3.2.md)                                                      |
| [0.3.1]      | 2026-04-27 | Patch           | Plugin Loader ESM-only 兼容修复：支持 import-only 根包与 `pkg/subpath`，修复 `vextjs-nacos` 在 dev CJS 插件中的加载失败 [查看](./changelogs/v0.3.1.md)                                                  |
| [0.3.0]      | 2026-04-26 | Minor           | MonSQLize 链式访问 API：`app.db.pool(name)` / `app.db.use(db)` + Depth-2 目录路由 + 双键回落策略 + VextModelDefinition `key` 别名双注册 + **⚠️ Breaking: `db()` 已移除** [查看](./changelogs/v0.3.0.md) |
| [0.2.11]     | 2026-04-24 | Minor           | 内置 multipart/form-data 解析（zero-dep，Node.js `Request.formData()`）+ `req.files` + `_getRawBodyBuffer()` 正式类型 + OpenAPI multipart 生成 [查看](./changelogs/v0.2.11.md)                          |
| [0.2.10]     | 2026-04-21 | Patch           | dev 模式堆栈路径修复：移除 `sourceRoot` 配置，sourcemap 路径不再缺失项目目录段 [查看](./changelogs/v0.2.10.md)                                                                                          |
| [0.2.9]      | 2026-04-13 | Patch           | MonSQLize 依赖升级至 `^1.2.1`（msq.model() 实例缓存 + 索引去重）[查看](./changelogs/v0.2.9.md)                                                                                                          |
| [0.2.8]      | 2026-04-13 | Patch           | dev 模式子目录 i18n 未加载修复（dev-bootstrap Mode B 回退缺失）[查看](./changelogs/v0.2.8.md)                                                                                                           |
| [0.2.7]      | 2026-04-13 | Patch           | monsqlize 依赖升级至 `^1.2.0`，确保 `findPage` projection 在 vext 应用中正确生效 [查看](./changelogs/v0.2.7.md)                                                                                         |
| [0.2.6]      | 2026-04-13 | Patch           | GitHub Actions CI/CD + OpenTelemetry 文档全面重写 + setLogger API 文档 + 社区模板 [查看](./changelogs/v0.2.6.md)                                                                                        |
| [0.2.5]      | 2026-04-13 | Patch           | error-handler 日志注入 + dev-bootstrap 中间件条件注册对齐 + Dev Error Overlay + logErrors 配置文档 [查看](./changelogs/v0.2.5.md)                                                                       |
| [0.2.4]      | 2026-04-02 | Patch           | vext.preload 自动注入：CLI start/dev/cluster 自动透传插件 --import 参数，零配置启动 [查看](./changelogs/v0.2.4.md)                                                                                      |
| [0.2.3]      | 2026-03-31 | Patch           | 原生 OpenTelemetry 支持：req.route / logger.mixin / ALS trace fields（208 项 E2E 验证）[查看](./changelogs/v0.2.3.md)                                                                                   |
| [0.2.2]      | 2026-03-25 | Patch           | Scalar JS 本地资产自动安装与本地服务（OPENAPI-013）+ exports 双策略解析修复（BUG-FIX-001）                                                                                                              |
| [0.2.1]      | 2026-03-21 | Patch           | OpenAPI tagGroups 自动推断 + 多级目录路由支持 + Model softDelete/versioning                                                                                                                             |
| [0.2.0]      | 2026-03-20 | Minor           | MonSQLize 内置插件 + 路由级响应缓存 + Model CRUD API + 204 项 E2E 验证                                                                                                                                  |
| [0.1.9]      | 2026-03-19 | Patch           | Article Model + softDelete + versioning + 多轮审查修复                                                                                                                                                  |
| [0.1.8]      | 2026-03-19 | Patch           | 脚手架版本硬编码修复 (BUG-030) + 发版流程漏洞堵塞                                                                                                                                                       |
| [0.1.7]      | 2026-03-17 | Minor           | Model Hot Reload (DEV-001) + Route Cache Fix (BUG-029)                                                                                                                                                  |
| [0.1.6]      | 2026-03-12 | Patch           | MonSQLize 集成修复 (BUG-023~027)                                                                                                                                                                        |
| [0.1.5]      | 2026-03-09 | Minor           | Scalar API Reference + OpenAPI pipeline + multi-level routing docs + schema-dsl delegation + 12 bug fixes                                                                                               |
| [0.1.4]      | 2026-03-06 | Patch           | CLI entry fix + CJS bundle re-entry guard + detectAndStart catch fix + BuildCompiler dist/package.json + dependency pinning                                                                             |
| [0.1.3]      | 2026-03-05 | Patch           | BUG-004/005/003 critical bug fixes                                                                                                                                                                      |
| [0.1.2]      | 2026-03-05 | Patch           | BUG-001 dev mode fix + dual-package + type enhancements                                                                                                                                                 |
| [0.1.1]      | 2026-03-05 | Minor           | CLI scaffolding + security fixes + documentation site                                                                                                                                                   |
| [0.1.0]      | 2026-03-04 | Pre-release     | Initial release (Phase 0~3, 1,926 tests)                                                                                                                                                                |

---

## Links

- [GitHub Repository](https://github.com/devcodex-labs/vextjs)
- [Issues](https://github.com/devcodex-labs/vextjs/issues)
- [Contributing Guide](./CONTRIBUTING.md)
- [Detailed Changelogs](./changelogs/)

[Unreleased]: https://github.com/devcodex-labs/vextjs/compare/v1.0.2...HEAD
[2.0.0]: https://github.com/devcodex-labs/vextjs/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/devcodex-labs/vextjs/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/devcodex-labs/vextjs/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/devcodex-labs/vextjs/compare/v0.3.8...v1.0.0
[0.3.8]: https://github.com/devcodex-labs/vextjs/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/devcodex-labs/vextjs/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/devcodex-labs/vextjs/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/devcodex-labs/vextjs/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/devcodex-labs/vextjs/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/devcodex-labs/vextjs/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/devcodex-labs/vextjs/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/devcodex-labs/vextjs/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devcodex-labs/vextjs/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/devcodex-labs/vextjs/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/devcodex-labs/vextjs/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/devcodex-labs/vextjs/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/devcodex-labs/vextjs/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/devcodex-labs/vextjs/compare/v0.2.6...v0.2.7
[0.2.5]: https://github.com/devcodex-labs/vextjs/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/devcodex-labs/vextjs/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/devcodex-labs/vextjs/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/devcodex-labs/vextjs/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/devcodex-labs/vextjs/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devcodex-labs/vextjs/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/devcodex-labs/vextjs/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/devcodex-labs/vextjs/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/devcodex-labs/vextjs/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/devcodex-labs/vextjs/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/devcodex-labs/vextjs/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/devcodex-labs/vextjs/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/devcodex-labs/vextjs/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/devcodex-labs/vextjs/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/devcodex-labs/vextjs/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/devcodex-labs/vextjs/releases/tag/v0.1.0
