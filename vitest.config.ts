import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试文件 glob
    include: ["test/**/*.test.{ts,js}"],

    // 超时（单个测试）
    // 30s: adapter type probes, frontend esbuild fixtures, and dist-linked
    // deferred-header cases can exceed 10s under preflight/full-suite load.
    testTimeout: 30_000,

    // 并行执行（Service 单元测试可并行，集成测试按需串行）
    pool: "forks",

    // 提升 MaxListeners 限制（在每个 worker 进程启动时执行）
    // 原因：cold-restarter / build-compiler 等测试在同一 worker 进程中
    // fork 多个子进程，每个都注册 process 事件监听器（uncaughtException / SIGTERM / SIGINT / exit），
    // 并行执行时累计超过默认限制 10，产生 MaxListenersExceededWarning。
    // setupFiles 在每个测试文件执行前运行，设置 process.setMaxListeners(20) 消除误报警告。
    setupFiles: ["./test/setup.ts"],

    // 环境
    env: {
      NODE_ENV: "test",
    },

    // 覆盖率配置
    coverage: {
      // 使用 V8 原生覆盖率（无需额外依赖，Node.js 内置）
      provider: "v8",

      // 输出格式
      reporter: ["text", "lcov", "json-summary"],

      // 输出目录
      reportsDirectory: "coverage",

      // 只统计 src/ 下的源码覆盖率
      include: ["src/**/*.ts"],

      // 排除项
      exclude: [
        // 测试文件本身
        "**/*.test.ts",
        "**/*.spec.ts",

        // 类型定义文件（纯类型无运行时代码）
        "src/types/**",

        // CLI 入口（包含 process.exit 等副作用，不适合覆盖率统计）
        "src/cli/index.ts",

        // 测试工具（属于测试基础设施，非生产代码）
        "src/testing/**",
      ],

      // 不在未覆盖的文件上标红（避免干扰）
      all: true,

      // Node 22 发布候选基线的整数下界。阈值只允许显式上调；
      // autoUpdate 必须关闭，避免测试运行自行改写质量门禁。
      thresholds: {
        lines: 79,
        statements: 78,
        functions: 81,
        branches: 70,
        autoUpdate: false,
      },
    },
  },
});
