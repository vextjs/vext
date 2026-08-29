# CLI 命令

:::warning 版本通道
本站跟随 `main`，当前预览 `v2.0.0`（`next`）。在 2.0.0 正式发布前，下面的 CLI 输出使用 npm 已发布的最新稳定版 `v1.0.2`（`stable`）。
:::

VextJS 提供了 `vext` 命令行工具，覆盖项目创建、开发、构建、部署的完整生命周期。

## 安装

`vext` CLI 随 `vextjs` 包一起安装，无需额外安装：

```bash
npm install vextjs
```

安装后可以通过以下方式调用：

```bash
# 通过 npx
npx vext <command>

# 通过 package.json scripts（推荐）
npm run dev    # → vext dev
npm start      # → vext start
npm run build  # → vext build
```

## 命令概览

| 命令                 | 说明                                              | 常用场景           |
| -------------------- | ------------------------------------------------- | ------------------ |
| `vext create <name>` | 创建新项目                                        | 项目初始化         |
| `vext dev`           | 开发模式启动                                      | 日常开发           |
| `vext build`         | 构建项目                                          | 部署前构建         |
| `vext deploy assets` | 上传前端静态资源                                  | 前端 CDN/静态发布  |
| `vext typegen`       | 生成声明 + service 依赖诊断（experimental）       | TS/JS 项目工程辅助 |
| `vext doctor routes` | 静态路由诊断 + inspect / manifest（experimental） | OpenAPI / 路由治理 |
| `vext start`         | 生产模式启动                                      | 生产部署           |
| `vext stop`          | 停止服务                                          | Cluster 模式管理   |
| `vext reload`        | 滚动重启                                          | 零停机更新         |
| `vext status`        | 查看运行状态                                      | Cluster 状态监控   |

## `vext create` — 创建项目

交互式创建新的 VextJS 项目，自动生成项目骨架和配置文件。默认模板是 `fullstack-react`；API-only 脚手架仍可通过 `--template api --frontend none` 创建。全栈 starter 默认展示可直接修改的服务端渲染 Vext launchpad，并在首页同时提供官方 Vext Guide 与本地 API 文档入口 `/docs`。其默认配置会启用 OpenAPI，因此该本地入口在 `vext dev` 与生产 `vext start` 后均可访问；API-only 项目仍保持显式启用。

### 用法

```bash
npx vextjs create <project-name> [options]
```

### 选项

| 选项                | 说明                                                    | 默认值            |
| ------------------- | ------------------------------------------------------- | ----------------- |
| `--template <name>` | 项目模板（`fullstack-react` / `api`）                   | `fullstack-react` |
| `--frontend <name>` | 前端目标（`react` / `none`）                            | `react`           |
| `--adapter <name>`  | 指定 Adapter（native / hono / fastify / express / koa） | `native`          |
| `--js`              | 创建 JavaScript 项目（而非 TypeScript）                 | `false`           |
| `--skip-install`    | 跳过 `npm install`                                      | `false`           |
| `--force`           | 目标目录存在且非空时强制覆盖                            | `false`           |
| `-h, --help`        | 显示帮助                                                | —                 |

### 示例

```bash
# 创建 TypeScript 全栈项目（默认 Native Adapter）
npx vextjs create my-app

# 指定 Adapter
npx vextjs create my-app --adapter hono
npx vextjs create my-app --adapter fastify

# 创建 JavaScript 全栈项目
npx vextjs create my-app --js

# 创建 API-only 项目
npx vextjs create my-api --template api --frontend none

# 跳过依赖安装
npx vextjs create my-app --skip-install
```

命令只接受一个项目名；多余的位置参数会在创建目标目录前直接失败。自动安装依赖失败时，`create` 以非零状态退出但保留已生成文件，可执行 `cd <project-name>` 后重新运行 `npm install`。生成的 TypeScript 全栈项目会为内置的 `@frontend`、`@pages`、`@components`、`@styles` 和 `@assets` 提供兼容 NodeNext 的路径映射。

### 生成的目录结构

```
my-app/
├── public/
│   ├── favicon.svg           # 使用同一 V 几何的高对比 favicon 变体
│   └── vext-mark.svg         # starter AppShell 使用的透明 V 标记
├── src/
│   ├── config/
│   │   ├── default.ts        # 共享配置（port: 3000）
│   │   ├── development.ts    # 开发环境 profile
│   │   ├── production.ts     # 生产环境 profile
│   │   ├── local.ts          # 空本地覆盖；被 Git 忽略
│   │   └── bootstrap.ts      # 可跟踪的启动入口，默认 providers: []
│   ├── frontend/
│   │   ├── components/AppShell.tsx # 公共 React shell
│   │   ├── locales/en-US.ts  # starter 文案
│   │   ├── pages/            # React 页面、layout、document 和错误页
│   │   └── styles/index.css  # Vext launchpad 样式
│   ├── preload/              # 可选 preload 源；添加首个真实文件时再创建
│   ├── routes/index.ts       # URL handler 和服务端数据
│   ├── services/example.ts   # 示例服务
│   └── types/
│       ├── generated/.gitkeep # Vext/typegen 管理的输出根（TypeScript 项目）
│       ├── shared/
│       │   └── greeting.d.ts # 应用维护、供服务端和 UI 共用的数据契约
│       └── frontend/
│           └── home.d.ts     # 应用维护的页面/渲染契约
├── package.json
├── tsconfig.json
└── .gitignore
```

#### 类型目录边界

上面的树对应默认的 **TypeScript 全栈** starter。`src/types/**` 中的三层目录有不同的所有权：

| 位置                     | 所有者      | 用途                                                                                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/types/generated/**` | Vext 工具链 | `vext typegen` 刷新的声明输出；不要手动修改生成文件。                                                                     |
| `src/types/shared/**`    | 应用代码    | 服务端与 UI 共用、可序列化的数据契约，例如 `GreetingDto`。                                                                |
| `src/types/frontend/**`  | 应用代码    | 由渲染页面的 route 与 `src/frontend/**` 共同使用的页面/渲染契约，例如 `HomePageProps`；不要把服务端私有实现细节放进这里。 |

在 TypeScript 项目中，`vext typegen` 只会写入 `src/types/generated/**`，不会覆盖应用维护的 `shared/**` 或 `frontend/**` 文件。JavaScript 的 create/dev/typegen 流程不会创建这棵公开 TypeScript 目录；工具声明只保留在 `.vext/types`。

| 脚手架模式                                              | 初始 `src/types/**` 结构                     |
| ------------------------------------------------------- | -------------------------------------------- |
| TypeScript 全栈（默认）                                 | `generated/**`、`shared/**` 与 `frontend/**` |
| TypeScript API-only（`--template api --frontend none`） | 仅 `generated/**`                            |
| JavaScript 脚手架                                       | 创建时不生成 `src/types` 目录                |

脚手架不会预留 `src/types/server/**`。只被单个 route 或 service 使用的类型应放在服务端 owner 附近；形成真实的后端 service 共享边界后，再创建 `src/types/server/services/**`。运行时 enum/constant 应就近放置或进入 `src/constants/services/**`，不能放进 `src/types/**`；详见[项目结构](/zh/guide/project-structure)。

脚手架不会生成根目录或目录级的占位 `README.md` 文件。TypeScript、JavaScript 的全栈与 API-only 模板所生成的用户源码均以英文为默认语言；只有显式 locale 目录下的语言资源不受该约束。`src/middlewares/`、`src/plugins/`、`src/locales/` 与规范的 `src/preload/` 等约定目录仍受支持；添加真实源码时会按需创建。历史项目根 `preload/` 不会由脚手架生成。

默认全栈 starter 的 `public/vext-mark.svg` 是透明导航标记，`public/favicon.svg` 是高对比 favicon 变体；两者使用同一 V 几何。前者由 AppShell 使用，两者都会随 `public/` 静态资源一起复制。

创建完成后：

```bash
cd my-app
npm run dev
```

访问 `http://localhost:3000`，你应该能看到 React 客户端。API 路由位于 `/api/hello` 与 `/api/health`。

`vext create` 会直接生成空 `VextConfigOverride` 的 `src/config/local.ts`，以及 `providers: []` 的 `src/config/bootstrap.ts`。默认内容不包含 logger、provider、外部连接或其他业务副作用。`local.ts` 被 `.gitignore` 排除，clone 后可以不存在；`bootstrap.ts` 正常跟踪，后续可通过 `defineBootstrapConfig()` 注册 provider。

## `vext dev` — 开发模式

以开发模式启动项目，支持文件监听和智能热重载。

### 用法

```bash
vext dev [options]
```

`vext dev` 不支持位置参数。`--root`、`--port`、`--host`、`--config`、`--poll-interval`、`--debounce`、`--startup-profile-json`、`--port-conflict` 等取值参数必须跟随非 option 值；数字参数必须是完整整数，`3000x`、`50x` 这类数字前缀会失败。

### 选项

| 选项                         | 说明                                        | 默认值         |
| ---------------------------- | ------------------------------------------- | -------------- |
| `--root <path>`              | 指定项目根目录                              | 当前目录       |
| `--config <name>`            | 选择 development 配置 profile               | `development`  |
| `--port <number>`            | 指定端口                                    | 配置文件中的值 |
| `--host <address>`           | 指定监听地址                                | 配置文件中的值 |
| `--debounce <ms>`            | 防抖间隔（毫秒，0 = 不开启）                | `0`            |
| `--poll`                     | 强制轮询模式（Docker / NFS 环境）           | `false`        |
| `--poll-interval <ms>`       | 轮询间隔（毫秒，仅 `--poll` 时有效）        | `1000`         |
| `--no-hot`                   | 禁用 Soft Reload，所有变更走 Cold Restart   | —              |
| `--strict-preflight`         | 让 TypeScript 语义诊断重新阻塞启动 / 重载   | —              |
| `--port-conflict <strategy>` | 端口冲突策略（`error/prompt/kill/next`）    | `error`        |
| `--verbose-lifecycle`        | 输出详细生命周期日志与完整 watcher 变更列表 | —              |
| `--startup-profile`          | 输出启动阶段摘要与详细耗时                  | —              |
| `--startup-profile-json <p>` | 将启动阶段耗时写入 JSON 文件                | —              |
| `--clear`                    | 每次重载后清空控制台                        | —              |
| `-h, --help`                 | 显示帮助                                    | —              |

#### 端口冲突策略

- `error`：直接失败（默认）
- `prompt`：在 TTY 环境下询问父进程如何处理
- `kill`：尝试终止占用端口的进程
- `next`：自动选择下一个可用端口

```bash
vext dev --port-conflict prompt
vext start --port-conflict next
```

#### 启动日志分层

默认 `vext dev` 只打印监听地址与总启动耗时，随后在 cold restart / hot reload 时打印必要结果。`vext dev --startup-profile` 才会输出人类可读的启动摘要与详细事件；摘要按 `main/preflight`、`main/preload`、`pre-worker-bootstrap`、`compile`、`config`、`i18n`、`database`、`plugins`、`middleware`、`services`、`routes`、`openapi`、`listen`、`onReady` 等阶段归类；超过阈值的未命名空窗会以 `gap.*` 形式进入 profile JSON。

`--startup-profile-json <path>` 只写 JSON 文件，不会自动打印摘要或 details；如需两者同时输出，可组合 `--startup-profile --startup-profile-json <path>`。

如需生命周期排障细节，可开启：

```bash
vext dev --verbose-lifecycle
VEXT_VERBOSE_LIFECYCLE=1 vext start
```

### 示例

```bash
# 使用配置文件中的默认设置
vext dev

# 指定端口
vext dev --port 8080

# 指定地址和端口
vext dev --host 127.0.0.1 --port 8080

# 开启 50ms 防抖（快速连续保存时合并为一次重载）
vext dev --debounce 50

# Docker / NFS 环境使用轮询模式
vext dev --poll --poll-interval 2000

# 禁用 Soft Reload（所有变更均走 Cold Restart）
vext dev --no-hot

# 输出启动阶段摘要与详细耗时
vext dev --startup-profile

# 仅写 JSON，不打印 summary/details
vext dev --startup-profile-json .vext/inspect/startup-profile.json
```

### 热重载策略

`vext dev` 提供三层热重载策略，自动选择最优方式：

| 层级                    | 触发条件                                   | 行为                       | 速度      |
| ----------------------- | ------------------------------------------ | -------------------------- | --------- |
| **Tier 1** — 路由热替换 | `src/routes/` 文件变更                     | 原子替换请求处理器，零中断 | ⚡ 毫秒级 |
| **Tier 2** — 服务重载   | `src/services/` 或 `src/locales/` 文件变更 | 重建受影响的服务实例       | ⚡ 毫秒级 |
| **Tier 3** — 冷重启     | `src/config/` 或 `src/plugins/` 文件变更   | 完整重启进程               | 🔄 秒级   |

详见 [热重载](/guide/hot-reload) 章节。

`src/frontend/**` 下的前端文件和 `public/**` 下的静态资源变更会触发前端重建消息。React 页面、layout、公共组件默认走 Fast Refresh；除非同时混入后端变更，否则不需要后端 cold restart。

### package.json 脚本

```json
{
  "scripts": {
    "dev": "vext dev"
  }
}
```

## `vext build` — 构建项目

将 TypeScript 源码编译为 JavaScript，生成生产可用的 `dist/` 目录；构建前会刷新 typegen 与 route manifest 这类工具产物。启用前端时，`vext build` 还会把浏览器客户端打包到 `dist/client/`。

### 用法

```bash
vext build [options]
```

### 选项

| 选项               | 说明                                            | 默认值       |
| ------------------ | ----------------------------------------------- | ------------ |
| `--outdir <path>`  | 输出目录                                        | `dist`       |
| `--config <name>`  | 加载 `src/config/<name>` 作为构建期配置         | `production` |
| `--clean`          | 编译前清理输出目录                              | `false`      |
| `--sourcemap`      | 生成 source map                                 | `true`       |
| `--no-sourcemap`   | 禁用 source map                                 | —            |
| `--minify`         | 压缩输出代码（默认开启；保留兼容选项）          | `true`       |
| `--no-minify`      | 关闭输出压缩                                    | —            |
| `--typecheck`      | 刷新 generated / manifest 后执行 `tsc --noEmit` | `false`      |
| `--upload-assets`  | 前端构建完成后执行静态资源上传                  | `false`      |
| `--deploy-dry-run` | 只输出前端上传计划，不写入目标                  | `false`      |
| `-h, --help`       | 显示帮助                                        | —            |

对已有项目而言，CLI flag 仍是 opt-in。新 TypeScript starter 生成的 `package.json` 会把 build script 设为 `vext build --typecheck`，因此 `npm run build` 默认包含语义类型检查；JavaScript starter 使用不调用 TypeScript 的 `vext build`。

生产 CLI 构建默认压缩后端输出。需要可读的本地输出时使用 `--no-minify`；若由环境控制该退出开关，可设置 `VEXT_BUILD_MINIFY=false`。前端生产压缩仍遵循 `frontend.build.minify`。

### 示例

```bash
# 构建项目
vext build

# 刷新 generated / manifest 后执行类型检查，再构建
vext build --typecheck

# 清理旧 dist 后构建
vext build --clean

# 指定输出目录
vext build --outdir build

# 保留可读输出，便于本地检查
vext build --no-minify

# 构建后上传前端静态资源
vext build --upload-assets

# 只看前端静态资源上传计划
vext build --upload-assets --deploy-dry-run

# 构建后启动
vext build && vext start
```

### 构建行为

- 先刷新 `.vext/types/*.generated.d.ts`、`.vext/manifest/services.json` 与 `.vext/manifest/routes.json`；TypeScript 项目还会刷新 `src/types/generated/index.d.ts`
- `--typecheck` 开启时，在 generated 产物刷新后只执行项目本地的 `tsc --noEmit`；缺少本地 TypeScript 时给出可操作错误，不回退到网络解析
- 使用 esbuild 进行服务端编译与前端打包
- 不支持位置参数；`--outdir`、`--config` 等取值参数必须提供非 option 值
- 输出目录默认为 `dist/`
- 保持源码目录结构
- 默认生成 `.js` 和 `.js.map` 文件；不会在 `dist/` 中生成声明文件
- 重复构建会自动移除已删除或重命名服务端源码留下的后端 stale 产物；`--clean` 表示先清空整个输出目录
- 解析后的输出若是项目根、源码根或其父目录，破坏性清理会 fail closed；前端输出、资源目录、命名模式与 server outfile 也必须留在声明的构建边界内
- 启用前端时，会生成 `dist/client/index.html`、`manifest.json`、`deploy-manifest.json`、`size-report.json`、静态资源与 client contract 产物
- 使用 `--upload-assets` 时，会读取 `dist/client/deploy-manifest.json`，按 sha256 和 `frontend.deploy.upload.stateFile` 增量上传静态资源

### package.json 脚本

```json
{
  "scripts": {
    "build": "vext build",
    "prepublishOnly": "vext build"
  }
}
```

:::tip 开发 vs 构建

- **`vext dev`**：直接从 `src/` 加载 `.ts` 文件，通过 esbuild 即时编译，支持热重载
- **`vext build`**：将 `src/` 编译到 `dist/`，生产模式从 `dist/` 加载
  :::

## `vext deploy assets` — 上传前端静态资源

读取 `dist/client/deploy-manifest.json`，把前端构建产物中的 JS、CSS、图片、字体和 `public/**` 资源上传到配置的目标。首期内置 `filesystem` 与 `mock` adapter；普通云厂商上传可通过后续自定义 adapter 承接。

### 用法

```bash
vext deploy assets [options]
```

`vext deploy assets` 不支持位置参数。`--manifest`、`--adapter`、`--target-dir`、`--prefix`、`--state-file` 等取值参数必须跟随非 option 值，例如 `--manifest dist/client/deploy-manifest.json`；`--manifest --dry-run` 会作为缺值错误失败。

### 选项

| 选项                  | 说明                                    | 默认值                             |
| --------------------- | --------------------------------------- | ---------------------------------- |
| `--outdir <path>`     | 构建输出目录                            | `dist`                             |
| `--config <name>`     | 加载指定的前端部署配置                  | `production`                       |
| `--manifest <path>`   | 指定 deploy manifest 路径               | `dist/client/deploy-manifest.json` |
| `--adapter <name>`    | 上传 adapter，例如 `filesystem`、`mock` | 配置值                             |
| `--target-dir <path>` | `filesystem` adapter 写入目录           | 配置值                             |
| `--prefix <path>`     | 上传 key 前缀                           | 配置值                             |
| `--state-file <path>` | 增量上传状态文件                        | 配置值                             |
| `--dry-run`           | 只输出上传计划，不写入目标              | `false`                            |
| `-h, --help`          | 显示帮助                                | —                                  |

### 示例

```bash
# 使用配置中的 upload 目标
vext deploy assets

# 只看计划
vext deploy assets --dry-run

# 本次覆盖上传目录和 key 前缀
vext deploy assets --target-dir .deploy/cdn --prefix my-app/v1
```

第二次执行时，Vext 会读取 `frontend.deploy.upload.stateFile`，对比每个 `uploadKey` 的 sha256；内容未变化的资源会跳过，不会重复上传图片、字体或稳定 public 文件。默认 deploy manifest 不包含 `index.html` 和 source map：HTML 仍由 Vext 服务端渲染，source map 不随 CDN 静态资源发布。

## `vext typegen` — 生成声明并执行 service 依赖诊断（experimental）

为 `app.services` 与插件里的 `app.extend()` / `defineAppExtensions<{ ... }>()` 提供 generated 声明，同时执行 tooling-only 的 service 依赖检查。

### 用法

```bash
vext typegen [options]
```

`vext typegen` 不接受位置参数。未知参数会立即失败，并输出可操作的诊断信息。`--root` / `-C` 这类取值选项必须跟随非 option 值；`--root --json` 会被拒绝，不会把 `--json` 当成路径。

### 选项

| 选项               | 说明                                   | 默认值   |
| ------------------ | -------------------------------------- | -------- |
| `--services`       | 仅生成 `services.generated.d.ts`       | `false`  |
| `--app-extensions` | 仅生成 `app-extensions.generated.d.ts` | `false`  |
| `--check`          | 只校验 generated 结果，不写文件        | `false`  |
| `--json`           | 输出机器可读 JSON                      | `false`  |
| `--write-manifest` | 写入 `.vext/manifest/services.json`    | `false`  |
| `--root <path>`    | 指定项目根目录                         | 当前目录 |
| `-C <path>`        | `--root` 别名                          | —        |
| `--verbose`        | 预留给后续详细日志                     | `false`  |
| `-h, --help`       | 显示帮助                               | —        |

### 产物

```text
.vext/types/services.generated.d.ts
.vext/types/app-extensions.generated.d.ts
src/types/generated/index.d.ts # 仅 TypeScript 项目；Vext 管理
.vext/manifest/services.json
```

对 TypeScript 项目，`src/types/generated/**` 是 `vext typegen` 在 `src/types/**` 内唯一会写入的位置。JavaScript 项目仍保留隐藏的 `.vext/types` 产物，但不会收到公开 `.d.ts` shim。全栈 starter 的 `shared/**` 与 `frontend/**` 是应用维护的契约目录；它们的职责与各模板的生成条件见[生成的目录结构](#生成的目录结构)。

### 示例

```bash
vext typegen
vext typegen --check
vext typegen --write-manifest
vext typegen --services --root ./examples/hello-world
```

### 适用边界

- `typegen` 整体仍属于 **tooling-only** 能力，不会进入 `vext start` 的 runtime 主路径；
- `vext dev` 会在 preflight 中自动执行基础 `typegen`，`vext build` 也会在可选 typecheck 与编译前刷新 generated 声明和 manifest；
- TypeScript 语义诊断默认在 ready / reload 后异步输出；如果希望像旧行为一样阻塞启动或重载，可使用 `--strict-preflight` 或 `VEXT_DEV_STRICT_PREFLIGHT=1`；
- TS 项目优先输出高质量类型，JS 项目允许退化到 `import(...).default` / `unknown`，但命令本身仍可用；
- `--write-manifest` 会把 service 索引、`app.extend()` / `defineAppExtensions<{ ... }>()` 聚合结果与服务依赖图摘要写入 `.vext/manifest/services.json`；
- 更多 generated 声明示例可结合 [服务](./services) 与 [插件](./plugins) 文档查看。

## `vext doctor routes` — 静态路由诊断（experimental）

扫描 `src/routes/` 中的静态路由元数据，输出重复路由、缺失 `docs.summary`、自动推断 `operationId` 等诊断，并可将结果落盘到 inspect / manifest 产物中。

### 用法

```bash
vext doctor <target> [options]
```

`--root` / `-C` 这类取值选项必须跟随非 option 值；`--root --json` 会被拒绝，不会把 `--json` 当成路径。

### Targets

| Target   | 说明                                         |
| -------- | -------------------------------------------- |
| `routes` | 扫描静态路由元数据与 OpenAPI 相关字段        |
| `all`    | 当前仍是 `routes` 的别名，用于保留后续扩展位 |

### 选项

| 选项               | 说明                                | 默认值   |
| ------------------ | ----------------------------------- | -------- |
| `--json`           | 输出机器可读 JSON                   | `false`  |
| `--write-inspect`  | 写入 `.vext/inspect/routes.json`    | `false`  |
| `--write-manifest` | 写入 `.vext/manifest/routes.json`   | `false`  |
| `--refresh`        | 跳过缓存 manifest，重新扫描路由诊断 | `false`  |
| `--root <path>`    | 指定项目根目录                      | 当前目录 |
| `-C <path>`        | `--root` 别名                       | —        |
| `-h, --help`       | 显示帮助                            | —        |

### 产物定位

| 产物                         | 定位                                         | 适用对象                         |
| ---------------------------- | -------------------------------------------- | -------------------------------- |
| `.vext/inspect/routes.json`  | inspect / 诊断中间层，包含诊断明细与调试字段 | `doctor`、debug、深度分析        |
| `.vext/manifest/routes.json` | 稳定消费层，字段收敛为 routes-only manifest  | 编辑器、CI、可视化、后续 codemod |

### 示例

```bash
vext doctor routes
vext doctor routes --write-inspect
vext doctor routes --write-inspect --write-manifest --json
```

### 当前边界

- Route manifest 会携带 fingerprint 与源码文件清单。Doctor 默认只复用与当前 route source 匹配的 manifest，stale manifest 会重新构建；`--manifest-only` 是显式 snapshot 读取，不能与 `--refresh` 或 `--write-manifest` 组合。
- 当前 route manifest 与 services manifest 仍分层维护，不合并为单一总 manifest；
- `docs.operationId` 缺失时，doctor 会按 runtime 行为给出 `auto-operation-id` 信息提示，而不是误报 warning；
- 路由侧仍由 `doctor routes --write-manifest` 负责；service 侧则由 `typegen --write-manifest` 负责。

## `vext start` — 生产模式启动

以生产模式启动项目。TypeScript 项目从 `dist/` 目录加载编译后的代码，需要先执行 `vext build`；如果缺少有效构建产物，命令会直接失败并提示使用 `vext build` 或开发期改用 `vext dev`。

### 用法

```bash
vext start [options]
```

`vext start` 不支持位置参数。`--port`、`--host`、`--config`、`--port-conflict`、`--startup-profile-json` 等取值参数必须跟随非 option 值。

### 选项

| 选项                         | 说明                                     | 默认值         |
| ---------------------------- | ---------------------------------------- | -------------- |
| `--port <number>`            | 指定端口                                 | 配置文件中的值 |
| `--host <address>`           | 指定监听地址                             | 配置文件中的值 |
| `--config <name>`            | 加载 `src/config/<name>`                 | `production`   |
| `--port-conflict <strategy>` | 端口冲突策略（`error/prompt/kill/next`） | `error`        |
| `--startup-profile`          | 输出生产启动阶段摘要与详细耗时           | —              |
| `--startup-profile-json <p>` | 将生产启动阶段耗时写入 JSON 文件         | —              |
| `--verbose-lifecycle`        | 输出详细生命周期日志                     | —              |
| `-h, --help`                 | 显示帮助                                 | —              |

### 示例

```bash
# 先构建，再启动
vext build
vext start

# 指定端口
vext start --port 8080

# 端口冲突时自动切到下一个可用端口
vext start --port-conflict next

# 排查生产 cold-start 阶段耗时
vext start --startup-profile
vext start --startup-profile-json .vext/inspect/start-profile.json

# 加载 production profile 并覆盖端口
vext start --port 8080

# 加载自定义配置 profile（需存在 src/config/sg-sit.ts）
vext start --config sg-sit
```

### 默认命令

当不传任何命令时，`vext` 默认执行 `start`：

```bash
# 以下两种方式等效
vext
vext start
```

### Cluster 模式

如果配置中启用了 `cluster`，`vext start` 会自动进入 Cluster 模式，由 Master 进程管理多个 Worker 进程：

```typescript
// src/config/production.ts
export default {
  cluster: {
    enabled: true,
    workers: "auto", // 自动检测 CPU 核数
  },
};
```

或通过环境变量启用：

```bash
VEXT_CLUSTER=1 vext start
```

### 预加载（Preload）自动注入

`vext start` 和 `vext dev` 会自动解析两类 preload 来源：

1. 已安装依赖包中声明的 `vext.preload`
2. 应用项目中的规范目录 `src/preload/`

在子进程启动前，这些脚本会统一通过 `--import` 注入。例如 `@devcodex/opentelemetry` 可利用包级 `vext.preload` 在应用代码加载前自动初始化 OpenTelemetry SDK；应用项目本身也可以直接在 `src/preload/` 中放置脚本做启动前环境桥接。

首期项目级 preload 规则：

- 规范目录固定为 `src/preload/`
- 非递归扫描
- 项目级 preload 先执行，包级 preload 后执行
- `.mjs` / `.js` 直接注入
- `.ts` / `.mts` 会在启动前编译到 `.vext/preload/*.mjs` 再注入
- `vext dev` 下若 `src/preload/` 里的文件发生变化，会触发 cold restart
- 项目根 `preload/` 是仅用于迁移的临时兼容回退；使用时会输出迁移 warning。不要在两个目录同时放置支持的 preload 文件，Vext 会 fail-fast，避免脚本重复执行

详见 [预加载 (Preload)](/guide/preload)。

### 启动期配置 Provider

如果项目存在 `src/config/bootstrap.ts`，`vext start` / `vext dev` 会在配置 validate / freeze 前执行其中声明的 `bootstrap config provider`，并将 provider 返回的 patch 合并到最终配置中。优先级为：`default < config profile < local < provider < CLI`。

Cluster 模式下，Master 会把本轮 provider patch 传递给 Worker 复用，避免同一启动周期内 Master / Worker 看到不同远程配置。

### package.json 脚本

```json
{
  "scripts": {
    "build": "vext build",
    "start": "vext start",
    "start:sg-sit": "vext start --config sg-sit",
    "start:us-uat": "vext start --config us-uat",
    "deploy:assets:sg-sit": "vext deploy assets --config sg-sit --dry-run"
  }
}
```

:::tip 配置 profile 选择
`vext start`、`vext build` 和 `vext deploy assets` 默认读取 `production` profile，`vext dev` 默认读取 `development` profile。需要切换到自定义 profile 时：

- CLI 参数：`vext start --config sg-sit`
- 环境变量：`VEXT_CONFIG=sg-sit vext start`

profile 名匹配 `src/config/{profile}.ts`（build 后对应 `dist/config/{profile}.js`）。
每条命令最多传入一次 `--config`。`start`、`dev`、`build` 与 `deploy assets` 遇到重复参数时会直接失败，不会静默采用最后一个值。
:::

## `vext stop` — 停止服务

停止正在运行的 Cluster 模式服务。通过读取 PID 文件发送停止信号。

### 用法

```bash
vext stop [options]
```

`vext stop` 不支持位置参数。`--pid-file` 必须跟随非 option 路径值。

### 选项

| 选项                | 说明         | 默认值      |
| ------------------- | ------------ | ----------- |
| `--pid-file <path>` | PID 文件路径 | `.vext.pid` |
| `-h, --help`        | 显示帮助     | —           |

### 示例

```bash
# 优雅停止
vext stop

# 指定 PID 文件
vext stop --pid-file /var/run/myapp.pid
```

:::info
`vext stop` 仅在 Cluster 模式下可用。单进程模式下直接使用 `Ctrl+C` 或发送 `SIGTERM` 信号即可优雅关闭。
:::

## `vext reload` — 滚动重启

触发 Cluster 模式的零停机滚动重启（Rolling Restart）。逐个重启 Worker 进程，确保服务始终可用。

### 用法

```bash
vext reload [options]
```

`vext reload` 不支持位置参数。`--pid-file` 必须跟随非 option 路径值。

### 选项

| 选项                | 说明         | 默认值      |
| ------------------- | ------------ | ----------- |
| `--pid-file <path>` | PID 文件路径 | `.vext.pid` |
| `-h, --help`        | 显示帮助     | —           |

### 示例

```bash
# 部署新版本后滚动重启
vext build
vext reload
```

### 滚动重启流程

```
1. 向 Master 进程发送 SIGUSR2 信号
2. Master 逐个重启 Worker：
   a. 启动新 Worker
   b. 等待新 Worker ready
   c. 优雅关闭旧 Worker
   d. 重复，直到所有 Worker 更新完成
3. 整个过程中始终有 Worker 处理请求，零停机
```

:::tip 适用场景
代码更新后执行 `vext build` + `vext reload`，无需停机即可完成版本更新。适合需要高可用性的生产环境。
:::

## `vext status` — 查看运行状态

查看 Cluster 模式下的服务运行状态，包括 Master 进程和各 Worker 进程的信息。

### 用法

```bash
vext status [options]
```

`vext status` 不支持位置参数。`--pid-file`、`--port`、`--host` 等取值参数必须跟随非 option 值。

### 选项

| 选项                | 说明         | 默认值      |
| ------------------- | ------------ | ----------- |
| `--pid-file <path>` | PID 文件路径 | `.vext.pid` |
| `--port <number>`   | 健康探测端口 | `3000`      |
| `--host <address>`  | 健康探测主机 | `127.0.0.1` |
| `-h, --help`        | 显示帮助     | —           |

### 示例

```bash
vext status
vext status --port 8080
```

### 输出示例

```
VextJS Cluster Status

Master PID: 12345
Workers: 4/4 running
Uptime: 2d 5h 32m

  PID     State    CPU    Memory    Requests
  12346   online   2.1%   48 MB     125,432
  12347   online   1.8%   52 MB     124,891
  12348   online   2.3%   47 MB     126,003
  12349   online   1.9%   50 MB     125,720
```

## 全局选项

所有命令都支持以下全局选项：

| 选项            | 说明         |
| --------------- | ------------ |
| `-h, --help`    | 显示帮助信息 |
| `-v, --version` | 显示版本号   |

```bash
# 查看版本
vext --version
# 输出: vextjs v1.0.2

# 查看帮助
vext --help
```

## 推荐的 package.json 脚本

```json
{
  "name": "my-app",
  "type": "module",
  "scripts": {
    "dev": "vext dev",
    "build": "vext build",
    "start": "vext start",
    "stop": "vext stop",
    "reload": "vext reload",
    "status": "vext status",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:cov": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  }
}
```

## 常见问题

### `vext start` 报错 "dist/ not found"

需要先执行 `vext build` 编译 TypeScript 代码。`vext start` 从 `dist/` 加载编译后的 JavaScript 文件。

如果启用了前端，`vext start` 还要求存在 `dist/client/index.html`。

### 开发时应该用 `vext dev` 还是 `vext start`？

日常开发使用 `vext dev`，它直接加载 `src/` 下的 TypeScript 文件，支持热重载，无需手动编译。`vext start` 用于生产环境。

### 如何指定 Node.js 版本？

VextJS 要求 Node.js >= 20.19.0。推荐在项目根目录创建 `.node-version` 或 `.nvmrc` 文件指定版本：

```bash
echo "22" > .node-version
```

### `vext stop` / `vext reload` / `vext status` 不工作？

这三个命令仅在 Cluster 模式下可用。确保配置中启用了 `cluster.enabled: true` 或使用了 `VEXT_CLUSTER=1` 环境变量，且服务通过 `vext start` 启动。

## 下一步

- 了解 [热重载](/guide/hot-reload) 的三层策略细节
- 配置 [前端指南](/zh/frontend/overview)
- 学习 [Cluster 多进程](/guide/cluster) 的完整配置
- 查看 [配置](/guide/configuration) 中端口、日志等选项
- 探索 [项目结构](/guide/project-structure) 的约定
