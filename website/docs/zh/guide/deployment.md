# 部署与生产环境

本指南介绍如何将 VextJS 应用部署到生产环境，涵盖构建、Docker 容器化、Nginx 反向代理、PM2 进程管理、日志收集和健康检查等实践。

## 文档站发布

VextJS 文档站从当前仓库发布到 GitHub Pages：

- URL：`https://devcodex-labs.github.io/vextjs/`
- Base path：`/vextjs/`
- Workflow：`.github/workflows/docs.yml`

该 workflow 不再发布到外部组织主页仓库。DevCodex Labs 组织主页由 `devcodex-labs/devcodex-labs.github.io` 独立维护。

## 构建生产产物

### vext build

使用 `vext build` 刷新 generated / manifest 工具产物，并将 TypeScript 源码编译为生产级 JavaScript：

```bash
vext build
```

编译产物输出到 `dist/` 目录，保持与 `src/` 相同的目录结构：

```

如果部署流水线需要类型校验，可使用 `vext build --typecheck`。该命令会先刷新 `.vext/types/`、`src/types/generated/index.d.ts` 与 `.vext/manifest/`，再执行 `tsc --noEmit` 和生产编译。
src/                          dist/
├── index.ts            →     ├── index.js        + index.js.map
├── config/                   ├── config/
│   ├── default.ts      →     │   ├── default.js
│   └── production.ts   →     │   └── production.js
├── routes/                   ├── routes/
│   └── users.ts        →     │   └── users.js
├── services/                 ├── services/
│   └── user.ts         →     │   └── user.js
├── plugins/                  ├── plugins/
│   └── redis.ts        →     │   └── redis.js
└── middlewares/              └── middlewares/
    └── auth.ts         →         └── auth.js
```

### 编译选项

| 选项         | 默认值                 | 说明                                           |
| ------------ | ---------------------- | ---------------------------------------------- |
| Source Map   | 开启（外部 `.js.map`） | 错误堆栈映射回 TypeScript 行号                 |
| Minify       | 默认开启               | 压缩后端产物；仅在本地诊断时使用 `--no-minify` |
| Target       | `node20`               | 与 `engines.node >= 20.19.0` 对齐              |
| Format       | CJS                    | CommonJS 输出，Node.js 稳定运行                |
| Tree Shaking | 开启                   | 移除未使用的导出                               |
| Keep Names   | 开启                   | 保留函数/类名称（错误堆栈可读性）              |

本表描述后端编译器。前端产物采用独立的生产默认值：浏览器压缩开启、浏览器 source map 关闭，SSR renderer 压缩关闭，除非显式配置。

### 编译排除

生产编译自动排除以下文件：

- `*.d.ts` — 类型声明
- `*.test.*` / `*.spec.*` — 测试文件
- `__tests__/` — 测试目录
- `config/development.*` — 开发环境配置
- `config/local.*` — 本地覆盖配置
- `config/test.*` — 测试环境配置

### 编译底层

`vext build` 的后端编译阶段基于 [esbuild](https://esbuild.github.io/) 实现。实际耗时取决于项目规模、插件转换、source map 配置、文件系统与硬件；制定部署预算时请测量自己的 CI 或发布构建。

编译时会自动注入 `process.env.NODE_ENV = "production"`，因此 build 后用户源码中的环境分支会按 production 语义静态折叠；但运行时实际加载哪个配置 profile，仍由启动时的 `--config` 或 `VEXT_CONFIG` 决定。

## 生产交付前端

当 `frontend.enabled` 为 true 时，`vext build` 还会将浏览器与 SSR closure 写入 `dist/client/`：`index.html`、带 hash 的资源、`render-manifest.json`、`deploy-manifest.json` 和默认的 `server/renderer.cjs`。后端产物仍在 `dist/` 下保持源码目录映射；不要部署一个并不存在的固定顶层 `dist/server/` 目录。

### 同源部署

默认不需要额外前端配置：

```bash
vext build
vext start
```

`vext start` 会在 listen 前校验前端 closure，随后服务 client assets，并用 render manifest 执行 SSR。这是单个 Node 服务最低风险的起点。

### CDN 部署与上传

只有确定由 CDN 承担 immutable browser assets 时才使用 CDN。设置绝对 `frontend.deploy.assetBaseUrl`，让 HTML/SSR 继续由 Node 服务提供，然后在真实上传前审阅 upload plan：

```bash
vext build
vext deploy assets --dry-run
vext deploy assets
vext start
```

`deploy-manifest.json` 包含可上传的 JS、CSS、import 型媒体与 `public/**` 文件，并带有 sha256/SRI metadata。它刻意排除 SSR HTML 与 source map。`frontend.deploy.upload.stateFile` 必须放在输出目录之外，避免普通 build 清理增量上传状态。

内置 adapter 只有 `filesystem` 与 `mock`。`filesystem` 用于生成本地 staging tree；真实云厂商需要显式 custom adapter。Vext 不会悄悄引入 cloud SDK 或 bundler-plugin ecosystem。完整步骤见[构建与发布](../frontend/build-and-deploy)，全部字段见[前端配置](../frontend/configuration)。

## 启动生产服务

### 直接启动

```bash
# 使用 vext start（推荐）
vext start

# 也可以加载自定义配置 profile（需存在 src/config/sg-sit.ts）
vext start --config sg-sit

# 启用 Source Map 支持（错误堆栈显示 TypeScript 行号）
NODE_OPTIONS=--enable-source-maps vext start
```

TypeScript 项目部署时，`vext start` 会要求存在有效的 `dist/` 构建产物：

- **存在有效构建产物** → 直接用 `node` 运行编译后的代码（不依赖 tsx）
- **不存在或不完整** → 直接失败并提示先执行 `vext build`

开发期源码启动请使用 `vext dev`，生产 `vext start` 不会回退到 TypeScript 运行时。

### 环境变量

| 变量          | 说明                                           | 推荐值           |
| ------------- | ---------------------------------------------- | ---------------- |
| `NODE_ENV`    | runtime mode；`vext start` 会设置为 production | 通常无需手动设置 |
| `VEXT_CONFIG` | 配置 profile；低于 `--config` 优先级           | `production`     |
| `PORT`        | 监听端口                                       | `3000`           |
| `HOST`        | 监听地址                                       | `0.0.0.0`        |

## Docker 部署

### Dockerfile

```dockerfile
# ── 阶段 1: 构建 ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制依赖文件（利用 Docker 缓存层）
COPY package.json package-lock.json ./

# 安装全部依赖（包括 devDependencies，编译需要）
RUN npm ci

# 复制源码
COPY src/ src/
COPY tsconfig.json ./

# 编译
RUN npx vext build

# ── 阶段 2: 运行 ──────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# 仅安装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制编译产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src

# 非 root 用户运行
RUN addgroup --system --gid 1001 vext && \
    adduser --system --uid 1001 vext
USER vext

# 环境变量
ENV NODE_OPTIONS=--enable-source-maps
ENV PORT=3000

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# 启动
CMD ["npm", "start"]
```

### .dockerignore

```
node_modules
dist
.vext
.git
*.md
test
website
.ai-memory
reports
```

### Docker Compose

```yaml
# docker-compose.yml
version: "3.8"

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - MONGODB_URL=mongodb://mongo:27017/myapp
    depends_on:
      mongo:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: echo 'db.runCommand("ping").ok' | mongosh --quiet
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  mongo-data:
```

### 构建和运行

```bash
# 构建镜像
docker build -t myapp:latest .

# 运行容器
docker run -d \
  --name myapp \
  -p 3000:3000 \
  -e MONGODB_URL=mongodb://host.docker.internal:27017/myapp \
  myapp:latest

# 查看日志
docker logs -f myapp
```

## Nginx 反向代理

### 基础配置

```nginx
# /etc/nginx/conf.d/myapp.conf

upstream vext_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name api.example.com;

    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    # SSL 证书
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 请求体大小限制
    client_max_body_size 10M;

    # 代理到 VextJS
    location / {
        proxy_pass http://vext_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID $request_id;

        # 超时设置
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # 缓存
        proxy_cache_bypass $http_upgrade;
    }

    # 健康检查端点（不记录日志）
    location = /health {
        proxy_pass http://vext_backend;
        access_log off;
    }

    # 静态文件（如果有）
    location /static/ {
        alias /var/www/myapp/static/;
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

### 多实例负载均衡

```nginx
upstream vext_backend {
    least_conn;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
    server 127.0.0.1:3004;
    keepalive 64;
}
```

## PM2 进程管理

### 安装

```bash
npm install -g pm2
```

### ecosystem 配置文件

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "myapp",
      script: "node_modules/vextjs/dist/cli/index.js",
      args: "start",
      node_args: "--enable-source-maps",

      // 多实例（或使用 VextJS 内置 Cluster 模式）
      instances: 1,

      // 环境变量
      env: {
        PORT: 3000,
      },

      // 日志
      error_file: "/var/log/myapp/error.log",
      out_file: "/var/log/myapp/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,

      // 自动重启
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,

      // 内存限制（超出则重启）
      max_memory_restart: "500M",

      // 优雅关闭
      kill_timeout: 10000,
      listen_timeout: 10000,
      shutdown_with_message: true,

      // 监控
      exp_backoff_restart_delay: 100,
    },
  ],
};
```

### PM2 常用命令

```bash
# 启动
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs myapp

# 重启
pm2 restart myapp

# 优雅重载
pm2 reload myapp

# 停止
pm2 stop myapp

# 监控面板
pm2 monit

# 设置开机自启
pm2 startup
pm2 save
```

:::tip VextJS Cluster vs PM2 Cluster
VextJS 内置了 Cluster 多进程模式（`vext start --cluster`），提供 Rolling Restart、心跳监控等高级功能。如果使用内置 Cluster，PM2 的 `instances` 设为 `1` 即可，让 VextJS 自己管理 worker 进程。

详见 [Cluster 多进程](/guide/cluster)。
:::

## 日志收集

### JSON 日志格式

VextJS 在 `vext start` 的 production runtime mode 下默认输出 JSON 格式日志，适合被日志收集系统解析。pretty level 颜色只作用于 pretty 文本模式，生产 JSON 输出不会包含 ANSI：

```json
{
  "level": 30,
  "time": "2026-03-05T14:23:05.123Z",
  "requestId": "abc-123",
  "msg": "→ GET /api/users 200 45ms"
}
```

### 配置日志级别

```typescript
// src/config/production.ts
export default {
  logger: {
    level: "info", // 生产环境建议 info（不输出 debug）
    pretty: false, // 生产环境禁用 pretty（默认行为）
    prettyColor: "never", // 可选：显式禁止 pretty ANSI
  },
};
```

### 日志收集方案

#### 方案一：文件 + Filebeat → ELK

```bash
# PM2 输出日志到文件
pm2 start ecosystem.config.cjs

# Filebeat 采集日志文件 → Elasticsearch → Kibana
```

```yaml
# filebeat.yml
filebeat.inputs:
  - type: log
    paths:
      - /var/log/myapp/*.log
    json.keys_under_root: true
    json.overwrite_keys: true

output.elasticsearch:
  hosts: ["http://elasticsearch:9200"]
  index: "myapp-%{+yyyy.MM.dd}"
```

#### 方案二：Docker 日志 → Loki

```yaml
# docker-compose.yml
services:
  app:
    build: .
    logging:
      driver: loki
      options:
        loki-url: "http://loki:3100/loki/api/v1/push"
        loki-batch-size: "400"
```

#### 方案三：stdout → Cloud 原生

在 Kubernetes / AWS ECS / Cloud Run 等平台中，直接输出到 stdout，由平台自动收集：

```bash
# 不需要额外配置，JSON 日志直接输出到 stdout
vext start
```

## 健康检查

### 实现健康检查端点

```typescript
// src/routes/health.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/health",
    {
      override: { rateLimit: false },
      docs: { summary: "健康检查" },
    },
    async (req, res) => {
      const checks: Record<string, unknown> = {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
          heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
        },
      };

      // 数据库连接检查
      if (app.db) {
        try {
          await app.db.client.db().admin().ping();
          checks.database = "connected";
        } catch {
          checks.database = "disconnected";
          checks.status = "degraded";
        }
      }

      const statusCode = checks.status === "ok" ? 200 : 503;
      res.json(checks, statusCode);
    },
  );

  // 就绪检查（Kubernetes readinessProbe）
  app.get(
    "/ready",
    {
      override: { rateLimit: false },
    },
    async (req, res) => {
      // 检查所有关键依赖是否就绪
      const ready = app.db !== undefined;

      if (ready) {
        res.json({ status: "ready" });
      } else {
        res.json({ status: "not_ready" }, 503);
      }
    },
  );
});
```

### Kubernetes 探针配置

```yaml
# k8s deployment.yaml
spec:
  containers:
    - name: myapp
      image: myapp:latest
      ports:
        - containerPort: 3000
      livenessProbe:
        httpGet:
          path: /health
          port: 3000
        initialDelaySeconds: 10
        periodSeconds: 30
        timeoutSeconds: 5
      readinessProbe:
        httpGet:
          path: /ready
          port: 3000
        initialDelaySeconds: 5
        periodSeconds: 10
        timeoutSeconds: 3
      resources:
        requests:
          memory: "128Mi"
          cpu: "250m"
        limits:
          memory: "512Mi"
          cpu: "1000m"
```

## 异常崩溃通知（onFatalError）

VextJS 内置了进程级异常捕获机制，当发生 `uncaughtException` 或 `unhandledRejection` 时，框架会：

1. 记录 `fatal` 级别日志
2. 调用用户配置的 `onFatalError` 回调（如有）
3. 执行优雅关闭（onClose hooks 清理资源）
4. `process.exit(1)` 退出进程

### 配置 onFatalError

在 `shutdown` 配置中添加 `onFatalError` 回调，接入告警通知：

```typescript
// src/config/production.ts
export default {
  shutdown: {
    timeout: 10,
    onFatalError: async (error, origin) => {
      // origin: 'uncaughtException' | 'unhandledRejection'

      // 示例：发送钉钉 Webhook
      await fetch("https://oapi.dingtalk.com/robot/send?access_token=xxx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            title: "⚠️ 服务异常",
            text: [
              "## ⚠️ 服务异常崩溃",
              `- **服务**: my-service`,
              `- **来源**: ${origin}`,
              `- **错误**: ${error.message}`,
              `- **时间**: ${new Date().toISOString()}`,
              `- **堆栈**:\n\`\`\`\n${error.stack}\n\`\`\``,
            ].join("\n"),
          },
        }),
      });
    },
  },
};
```

### 企业微信 Webhook 示例

```typescript
onFatalError: async (error, origin) => {
  await fetch('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        content: [
          `## <font color="warning">服务异常崩溃</font>`,
          `> 服务: my-service`,
          `> 来源: ${origin}`,
          `> 错误: ${error.message}`,
          `> 时间: ${new Date().toISOString()}`,
        ].join('\n'),
      },
    }),
  });
},
```

### Slack Webhook 示例

```typescript
onFatalError: async (error, origin) => {
  await fetch('https://hooks.slack.com/services/T00/B00/xxx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 *Service Crash* (${origin})\nError: ${error.message}\nTime: ${new Date().toISOString()}`,
    }),
  });
},
```

### 通用 HTTP Webhook 示例

```typescript
onFatalError: async (error, origin) => {
  await fetch(process.env.ALERT_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: 'my-service',
      runtimeMode: process.env.NODE_ENV,
      configProfile: process.env.VEXT_CONFIG,
      origin,
      error: error.message,
      stack: error.stack,
      hostname: require('os').hostname(),
      pid: process.pid,
      time: new Date().toISOString(),
    }),
  });
},
```

### 注意事项

| 项目         | 说明                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| **超时保护** | `onFatalError` 回调有 10 秒超时，超时后强制退出进程                          |
| **错误隔离** | 回调内部抛出的异常会被捕获并记录，不会阻止进程退出                           |
| **不可恢复** | `uncaughtException` 后进程处于不确定状态，回调应尽量轻量（发通知即可）       |
| **测试模式** | `_testMode` 下不注册致命错误处理器，避免干扰测试                             |
| **配合 PM2** | PM2 自身也有重启通知能力（`pm2-slack` 等插件），可与 `onFatalError` 配合使用 |

:::tip 为什么不能用中间件实现？
`uncaughtException` 和 `unhandledRejection` 发生在 HTTP 中间件执行链之外（例如定时任务、事件监听器中的异常），中间件无法捕获这类错误。因此必须在框架 bootstrap 层注册 `process` 级事件监听器。
:::

## 安全加固

### 生产环境清单

| #   | 检查项               | 说明                                                                                       |
| --- | -------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **HTTPS**            | 通过 Nginx/CDN 终结 TLS，不在 Node.js 层处理 SSL                                           |
| 2   | **CORS**             | 配置 `config.cors` 限制允许的来源域名                                                      |
| 3   | **限流**             | 配置 `config.rateLimit`，对登录等敏感接口设更严格限流                                      |
| 4   | **Security Headers** | 配置 `config.securityHeaders`，启用低破坏默认头，并按需选择 strict/custom 浏览器安全响应头 |
| 5   | **环境变量**         | 敏感信息（数据库密码、API Key）通过环境变量传入，不写入配置文件                            |
| 6   | **config/local.ts**  | 确保 `.gitignore` 中包含 `config/local.*`                                                  |
| 7   | **日志**             | 不输出敏感数据（密码、token 等）到日志                                                     |
| 8   | **依赖审计**         | 定期 `npm audit`，及时修复已知漏洞                                                         |
| 9   | **非 root**          | Docker 容器中使用非 root 用户运行                                                          |
| 10  | **优雅关闭**         | 确保 `SIGTERM` 信号被正确处理（VextJS 内置支持）                                           |

### 环境变量管理

VextJS 不会自动解析 `.env` 文件，也不内置隐式 dotenv loader。代码通过
`process.env` 读取的值，必须由操作系统、shell、进程管理器、容器平台、CI/CD、
密钥管理服务或应用显式拥有的 loader 注入。脚手架仍会忽略 `.env*` 文件，以降低
外部工具创建这些文件后被误提交的风险；这项 Git 防护不表示 Vext 会加载它们。

```bash
# 由 shell 或 CI 为单个进程注入
PORT=3000 MONGODB_URL=mongodb://localhost:27017/myapp npm start

# 由容器/平台注入
docker run -e MONGODB_URL=mongodb://mongo:27017/myapp myapp
# Kubernetes：Secret + ConfigMap
```

## 性能优化

### Node.js 参数

```bash
# 增大内存上限（默认 ~1.5GB）
NODE_OPTIONS=--max-old-space-size=4096 vext start

# 启用 Source Map（推荐）
NODE_OPTIONS=--enable-source-maps vext start

# 组合使用
NODE_OPTIONS="--enable-source-maps --max-old-space-size=4096" vext start
```

### Cluster 多进程

VextJS 内置 Cluster 模式，充分利用多核 CPU：

```bash
# 自动使用 CPU 核心数的 worker
vext start --cluster

# 指定 worker 数量
vext start --cluster --workers 4
```

详见 [Cluster 多进程](/guide/cluster)。

### 连接池优化

```typescript
// src/config/production.ts
export default {
  // HTTP fetch 连接优化
  fetch: {
    timeout: 5000, // 生产环境缩短超时
    retry: 2, // 幂等方法自动重试
  },

  // 数据库连接池
  database: {
    config: {
      url: process.env.MONGODB_URL,
      options: {
        maxPoolSize: 20,
        minPoolSize: 5,
        maxIdleTimeMS: 30000,
      },
    },
  },
};
```

## 部署流程建议

### CI/CD 流水线

```
Push to main
  → CI 检查（lint + typecheck + test）
  → vext build（编译）
  → Docker build（构建镜像）
  → Push to Registry
  → Deploy（Rolling Update）
  → Health Check（验证）
```

### 灰度发布

```bash
# 1. 构建新版本镜像
docker build -t myapp:v1.2.0 .

# 2. 部署到灰度环境
docker run -d --name myapp-canary -p 3001:3000 myapp:v1.2.0

# 3. Nginx 灰度路由（10% 流量到新版本）
upstream vext_backend {
    server 127.0.0.1:3000 weight=9;   # 旧版本
    server 127.0.0.1:3001 weight=1;   # 新版本（灰度）
}

# 4. 观察监控指标（错误率、延迟）
# 5. 确认无异常后全量切换
```

## 监控告警

### 关键监控指标

| 指标          | 正常范围    | 告警条件          |
| ------------- | ----------- | ----------------- |
| 响应时间 P99  | < 500ms     | > 1s 持续 5 分钟  |
| 错误率（5xx） | < 0.1%      | > 1% 持续 1 分钟  |
| 内存使用      | < 80% limit | > 90% 持续 5 分钟 |
| CPU 使用      | < 70%       | > 90% 持续 5 分钟 |
| 活跃连接数    | < 1000      | > 5000            |
| 数据库连接池  | 无等待      | 等待时间 > 1s     |

### Prometheus 指标端点

结合 [OpenTelemetry 接入示例](/examples/opentelemetry) 暴露 Prometheus 指标：

```typescript
app.get(
  "/metrics",
  {
    override: { rateLimit: false },
  },
  async (req, res) => {
    // OpenTelemetry Prometheus Exporter 会在此端点暴露指标
    // 详见 OpenTelemetry 接入示例
    res.json({ message: "See /examples/opentelemetry for setup" });
  },
);
```

## 下一步

- 了解 [Cluster 多进程](/guide/cluster) 充分利用多核 CPU
- 查看 [OpenTelemetry 接入](/examples/opentelemetry) 实现完整的可观测性
- 学习 [Nacos 接入](/examples/nacos-integration) 实现微服务注册发现
- 探索 [配置](/guide/configuration) 中的环境配置覆盖机制
