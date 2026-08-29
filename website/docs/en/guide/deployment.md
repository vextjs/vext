# Deployment and production environment

This guide explains how to deploy a VextJS application into production, covering practices such as building, Docker containerization, Nginx reverse proxy, PM2 process management, log collection, and health checks.

## Publish the documentation site

The VextJS documentation site is published from this repository to GitHub Pages:

- URL: `https://devcodex-labs.github.io/vextjs/`
- Base path: `/vextjs/`
- Workflow: `.github/workflows/docs.yml`

The workflow no longer publishes to an external organization homepage repository. The DevCodex Labs organization site is maintained separately in `devcodex-labs/devcodex-labs.github.io`.

## Build production product

### vext build

Use `vext build` to refresh the generated / manifest tool artifact and compile the TypeScript source code into production-grade JavaScript:

```bash
vext build
```

The compiled product is output to the `dist/` directory, maintaining the same directory structure as `src/`:

```

If the deployment pipeline requires type checking, use `vext build --typecheck`. This command will first refresh `.vext/types/`, `src/types/generated/index.d.ts` and `.vext/manifest/` before executing `tsc --noEmit` and production compilation.
src/dist/
├── index.ts → ├── index.js + index.js.map
├── config/ ├── config/
│ ├── default.ts → │ ├── default.js
│ └── production.ts → │ └── production.js
├── routes/ ├── routes/
│ └── users.ts → │ └── users.js
├── services/ ├── services/
│ └── user.ts → │ └── user.js
├── plugins/ ├── plugins/
│ └── redis.ts → │ └── redis.js
└── middlewares/ └── middlewares/
    └── auth.ts → └── auth.js
```

### Compile options

| Options      | Default                 | Description                                                           |
| ------------ | ----------------------- | --------------------------------------------------------------------- |
| Source Map   | On (external `.js.map`) | Error stack mapped back to TypeScript line numbers                    |
| Minify       | On by default           | Minifies backend output; use `--no-minify` only for local diagnostics |
| Target       | `node20`                | Align with `engines.node >= 20.19.0`                                  |
| Format       | CJS                     | CommonJS output, Node.js runs stably                                  |
| Tree Shaking | Enable                  | Remove unused exports                                                 |
| Keep Names   | On                      | Keep function/class names (error stack readability)                   |

This table is about the backend compiler. Frontend output follows its own
production defaults: browser minification is on, browser source maps are off,
and SSR-renderer minification is off unless explicitly configured.

### Compile Exclusion

Production compilation automatically excludes the following files:

- `*.d.ts` — type declaration
- `*.test.*` / `*.spec.*` — test files
- `__tests__/` — test directory
- `config/development.*` — development environment configuration
- `config/local.*` — local override configuration
- `config/test.*` — test environment configuration

### Compile the bottom layer

`vext build` uses [esbuild](https://esbuild.github.io/) for the backend compilation stage. Build time depends on project size, plugin transforms, source-map settings, filesystem performance, and hardware; measure your own CI or release build when setting deployment budgets.

`process.env.NODE_ENV = "production"` will be automatically injected during compilation, so the environment branch in the user source code after build will be statically folded according to production semantics; the runtime config profile is selected independently with `--config` or `VEXT_CONFIG`.

## Deliver the frontend in production

When `frontend.enabled` is true, `vext build` also writes the browser and SSR
closure to `dist/client/`: `index.html`, hashed assets, `render-manifest.json`,
`deploy-manifest.json`, and the default `server/renderer.cjs`. The backend
output remains source-layout based under `dist/`; do not deploy a fictional
top-level `dist/server/` directory.

### Same-origin deployment

The default needs no extra frontend configuration:

```bash
vext build
vext start
```

`vext start` validates the frontend closure before listening. It then serves
the client assets and uses the render manifest for SSR. This is the lowest-risk
starting point for one Node service.

### CDN deployment and upload

Use a CDN only when it will own immutable browser assets. Set an absolute
`frontend.deploy.assetBaseUrl`, keep HTML/SSR on the Node service, then review
the upload plan before executing it:

```bash
vext build
vext deploy assets --dry-run
vext deploy assets
vext start
```

`deploy-manifest.json` contains uploadable JS, CSS, imported media, and
`public/**` files with sha256/SRI metadata. It deliberately excludes SSR HTML
and source maps. Keep `frontend.deploy.upload.stateFile` outside the output
directory so an ordinary build cannot erase incremental-upload state.

Only `filesystem` and `mock` adapters are built in. `filesystem` creates a
local staging tree; an actual provider needs an explicit custom adapter. Vext
does not silently add a cloud SDK or a bundler-plugin ecosystem. See
[Build and Deploy](../frontend/build-and-deploy) for the full sequence and
[Frontend Configuration](../frontend/configuration) for every field.

## Start production service

### Start directly

```bash
# Use vext start (recommended)
vext start

# You can also load a custom config profile (src/config/sg-sit.ts needs to exist)
vext start --config sg-sit

# Enable Source Map support (error stack shows TypeScript line numbers)
NODE_OPTIONS=--enable-source-maps vext start
```

When deploying a TypeScript project, `vext start` will require the existence of a valid `dist/` build product:

- **A valid build product exists** → directly use `node` to run the compiled code (does not depend on tsx)
- **Does not exist or is incomplete** → Fails directly and prompts to execute `vext build` first

Please use `vext dev` to start source code during the development period. Production `vext start` will not fall back to the TypeScript runtime.

### Environment variables

| Variable      | Description                                      | Recommended value        |
| ------------- | ------------------------------------------------ | ------------------------ |
| `NODE_ENV`    | Runtime mode; `vext start` sets it to production | Usually not set manually |
| `VEXT_CONFIG` | Config profile; lower priority than `--config`   | `production`             |
| `PORT`        | Listening port                                   | `3000`                   |
| `HOST`        | Listening address                                | `0.0.0.0`                |

## Docker deployment

### Dockerfile

```dockerfile
#──Phase 1: Build───────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR/app

# Copy dependency files first (using Docker cache layer)
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies, required for compilation)
RUN npm ci

# Copy source code
COPY src/ src/
COPY tsconfig.json ./

# compile
RUN npx vext build

# ── Stage 2: Run ──────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR/app

# Only install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled product
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src

# Run as non-root user
RUN addgroup --system --gid 1001 vext && \
    adduser --system --uid 1001 vext
USER vext

# Environment variables
ENV NODE_OPTIONS=--enable-source-maps
ENV PORT=3000

EXPOSE 3000

#HealthCheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# start
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

### Build and run

```bash
# Build image
docker build -t myapp:latest .

# Run container
docker run -d \
  --name myapp \
  -p 3000:3000 \
  -e MONGODB_URL=mongodb://host.docker.internal:27017/myapp \
  myapp:latest

# View log
docker logs -f myapp
```

## Nginx reverse proxy

### Basic configuration

```nginx
# /etc/nginx/conf.d/myapp.conf

upstream vext_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name api.example.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    # SSL Certificate
    ssl_certificate /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    # SSL security configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Request body size limit
    client_max_body_size 10M;

    # Proxy to VextJS
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

        # Timeout setting
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # cache
        proxy_cache_bypass $http_upgrade;
    }

    # Health check endpoint (no logging)
    location = /health {
        proxy_pass http://vext_backend;
        access_log off;
    }

    # Static files (if any)
    location /static/ {
        alias /var/www/myapp/static/;
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}
```

### Multi-instance load balancing

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

## PM2 process management

### Installation

```bash
npm install -g pm2
```

### ecosystem configuration file

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "myapp",
      script: "node_modules/vextjs/dist/cli/index.js",
      args: "start",
      node_args: "--enable-source-maps",

      // Multiple instances (or use VextJS built-in Cluster mode)
      instances: 1,

      // environment variables
      env: {
        PORT: 3000,
      },

      // log
      error_file: "/var/log/myapp/error.log",
      out_file: "/var/log/myapp/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,

      // Automatically restart
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,

      //Memory limit (restart if exceeded)
      max_memory_restart: "500M",

      //Close gracefully
      kill_timeout: 10000,
      listen_timeout: 10000,
      shutdown_with_message: true,

      // Monitor
      exp_backoff_restart_delay: 100,
    },
  ],
};
```

### PM2 common commands

```bash
# start
pm2 start ecosystem.config.cjs

# Check status
pm2 status

# View log
pm2 logs myapp

# Restart
pm2 restart myapp

# Graceful reloading
pm2 reload myapp

# stop
pm2 stop myapp

# Monitoring panel
pm2monit

#Set auto-start at boot
pm2 startup
pm2 save
```

:::tip VextJS Cluster vs PM2 Cluster
VextJS has built-in Cluster multi-process mode (`vext start --cluster`), providing advanced functions such as Rolling Restart and heartbeat monitoring. If you use the built-in Cluster, just set `instances` of PM2 to `1` and let VextJS manage the worker process by itself.

See [Cluster multi-process](/guide/cluster) for details.
:::

## Log collection

### JSON log format

VextJS outputs JSON logs by default in the production runtime mode used by `vext start`, which is suitable for parsing by the log collection system. Pretty level colors only work in pretty text mode, and the produced JSON output will not contain ANSI:

```json
{
  "level": 30,
  "time": "2026-03-05T14:23:05.123Z",
  "requestId": "abc-123",
  "msg": "→ GET /api/users 200 45ms"
}
```

### Configure log level

```typescript
// src/config/production.ts
export default {
  logger: {
    level: "info", // Recommended info for production environment (does not output debug)
    pretty: false, // disable pretty in production environment (default behavior)
    prettyColor: "never", // Optional: Explicitly disable pretty ANSI
  },
};
```

### Log collection plan

#### Solution 1: File + Filebeat → ELK

```bash
# PM2 output log to file
pm2 start ecosystem.config.cjs

# Filebeat collects log files → Elasticsearch → Kibana
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

#### Option 2: Docker log → Loki

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

#### Option 3: stdout → Cloud native

In platforms such as Kubernetes / AWS ECS / Cloud Run, output directly to stdout, which is automatically collected by the platform:

```bash
# No additional configuration is required, JSON logs are output directly to stdout
vext start
```

## Health Check

### Implement health check endpoint

```typescript
// src/routes/health.ts
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get(
    "/health",
    {
      override: { rateLimit: false },
      docs: { summary: "Health Check" },
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

      // Database connection check
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

  // Readiness check (Kubernetes readinessProbe)
  app.get(
    "/ready",
    {
      override: { rateLimit: false },
    },
    async (req, res) => {
      // Check if all key dependencies are ready
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

### Kubernetes probe configuration

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

## Abnormal crash notification (onFatalError)

VextJS has a built-in process-level exception catching mechanism. When an `uncaughtException` or `unhandledRejection` occurs, the framework will:

1. Record `fatal` level logs
2. Call the user-configured `onFatalError` callback (if any)
3. Perform graceful shutdown (onClose hooks clean up resources)
4. `process.exit(1)` Exit the process

### Configure onFatalError

Add the `onFatalError` callback in the `shutdown` configuration to access alarm notifications:

```typescript
// src/config/production.ts
export default {
  shutdown: {
    timeout: 10,
    onFatalError: async (error, origin) => {
      // origin: 'uncaughtException' | 'unhandledRejection'

      // Example: Send DingTalk Webhook
      await fetch("https://oapi.dingtalk.com/robot/send?access_token=xxx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            title: "⚠️ Service exception",
            text: [
              "## ⚠️ The service crashed abnormally",
              `- **service**: my-service`,
              `- **Source**: ${origin}`,
              `- **Error**: ${error.message}`,
              `- **Time**: ${new Date().toISOString()}`,
              `- **Stack**:\n\`\`\`\n${error.stack}\n\`\`\``,
            ].join("\n"),
          },
        }),
      });
    },
  },
};
```

### Enterprise WeChat Webhook Example

```typescript
onFatalError: async (error, origin) => {
  await fetch('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        content: [
          `## <font color="warning">Service crashed abnormally</font>`,
          `> Service: my-service`,
          `> Source: ${origin}`,
          `> Error: ${error.message}`,
          `> Time: ${new Date().toISOString()}`,
        ].join('\n'),
      },
    }),
  });
},
```

### Slack Webhook Example

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

### Generic HTTP Webhook Example

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

### Notes

| Project                  | Description                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Timeout Protection**   | The `onFatalError` callback has a 10-second timeout, and the process will be forced to exit after the timeout                              |
| **Error Isolation**      | Exceptions thrown inside the callback will be caught and recorded, and will not prevent the process from exiting                           |
| **Unrecoverable**        | After `uncaughtException`, the process is in an uncertain state, the callback should be as light as possible (just send a notification)    |
| **Test Mode**            | Do not register fatal error handlers under `_testMode` to avoid interfering with testing                                                   |
| **Cooperating with PM2** | PM2 itself also has restart notification capabilities (plug-ins such as `pm2-slack`), which can be used in conjunction with `onFatalError` |

:::tip Why can’t it be implemented using middleware?
`uncaughtException` and `unhandledRejection` occur outside the HTTP middleware execution chain (such as exceptions in scheduled tasks and event listeners), and middleware cannot catch such errors. Therefore, `process` level event listeners must be registered in the framework bootstrap layer.
:::

## Security hardening

### Production environment list

| #   | Check items               | Description                                                                                                                                |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **HTTPS**                 | Terminates TLS via Nginx/CDN, does not handle SSL at the Node.js layer                                                                     |
| 2   | **CORS**                  | Configure `config.cors` to limit allowed source domain names                                                                               |
| 3   | **Rate Limit**            | Configure `config.rateLimit` to set stricter rate limits for sensitive interfaces such as login                                            |
| 4   | **Security Headers**      | Configure `config.securityHeaders` for low-impact defaults and opt-in strict/custom browser response headers                               |
| 5   | **Environment variables** | Sensitive information (database password, API Key) is passed in through environment variables and is not written to the configuration file |
| 6   | **config/local.ts**       | Make sure `.gitignore` contains `config/local.*`                                                                                           |
| 7   | **Log**                   | Do not output sensitive data (password, token, etc.) to the log                                                                            |
| 8   | **Dependency Audit**      | Regular `npm audit` to fix known vulnerabilities in a timely manner                                                                        |
| 9   | **Non-root**              | Running as a non-root user in a Docker container                                                                                           |
| 10  | **Graceful shutdown**     | Ensure `SIGTERM` signal is handled correctly (VextJS built-in support)                                                                     |

### Environment variable management

VextJS does not automatically parse `.env` files and does not bundle an implicit
dotenv loader. Values read through `process.env` must be injected by the OS,
shell, process manager, container platform, CI/CD system, secret manager, or a
loader that your application explicitly owns. The scaffold still ignores
`.env*` files to reduce accidental commits when external tools create them; that
Git protection does not mean Vext loads those files.

```bash
# Shell or CI-owned injection for one process
PORT=3000 MONGODB_URL=mongodb://localhost:27017/myapp npm start

# Container/platform-owned injection
docker run -e MONGODB_URL=mongodb://mongo:27017/myapp myapp
# Kubernetes: Secret + ConfigMap
```

## Performance optimization

### Node.js Parameters

```bash
# Increase the memory limit (default ~1.5GB)
NODE_OPTIONS=--max-old-space-size=4096 vext start

# Enable Source Map (recommended)
NODE_OPTIONS=--enable-source-maps vext start

# Use in combination
NODE_OPTIONS="--enable-source-maps --max-old-space-size=4096" vext start
```

### Cluster multi-process

VextJS has built-in Cluster mode to make full use of multi-core CPUs:

```bash
# Automatically use workers with the number of CPU cores
vext start --cluster

# Specify the number of workers
vext start --cluster --workers 4
```

See [Cluster multi-process](/guide/cluster) for details.

### Connection pool optimization

```typescript
// src/config/production.ts
export default {
  // HTTP fetch connection optimization
  fetch: {
    timeout: 5000, // Shorten timeout for production environment
    retry: 2, // Idempotent method automatically retries
  },

  //Database connection pool
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

## Deployment process suggestions

### CI/CD pipeline

```
Push to main
  → CI check (lint + typecheck + test)
  → vext build
  → Docker build (build image)
  → Push to Registry
  → Deploy (Rolling Update)
  → Health Check (verification)
```

### Grayscale release

```bash
# 1. Build a new version of the image
docker build -t myapp:v1.2.0 .# 2. Deploy to grayscale environment
docker run -d --name myapp-canary -p 3001:3000 myapp:v1.2.0

# 3. Nginx grayscale routing (10% of traffic goes to the new version)
upstream vext_backend {
    server 127.0.0.1:3000 weight=9; # Old version
    server 127.0.0.1:3001 weight=1; # New version (grayscale)
}

# 4. Observe monitoring indicators (error rate, delay)
# 5. Confirm that there are no abnormalities and then switch to full volume.
```

## Monitor alarms

### Key monitoring indicators

| Indicators                   | Normal range | Alarm conditions    |
| ---------------------------- | ------------ | ------------------- |
| Response time P99            | < 500ms      | > 1s for 5 minutes  |
| Error rate (5xx)             | < 0.1%       | > 1% for 1 minute   |
| Memory usage                 | < 80% limit  | > 90% for 5 minutes |
| CPU usage                    | < 70%        | > 90% for 5 minutes |
| Number of active connections | < 1000       | > 5000              |
| Database connection pool     | No waiting   | Waiting time > 1s   |

### Prometheus Metrics Endpoint

Combined with [OpenTelemetry access example](/examples/opentelemetry) to expose Prometheus indicators:

```typescript
app.get(
  "/metrics",
  {
    override: { rateLimit: false },
  },
  async (req, res) => {
    // OpenTelemetry Prometheus Exporter will expose metrics at this endpoint
    // See OpenTelemetry access example for details
    res.json({ message: "See /examples/opentelemetry for setup" });
  },
);
```

## Next step

- Learn about [Cluster Multi-Processing](/guide/cluster) to take full advantage of multi-core CPUs
- See [OpenTelemetry Access](/examples/opentelemetry) for full observability
- Learn [Nacos access](/examples/nacos-integration) to implement microservice registration discovery
- Explore the environment configuration override mechanism in [Configuration](/guide/configuration)
