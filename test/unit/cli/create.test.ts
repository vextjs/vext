import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { execSync } from "node:child_process";
import * as ts from "typescript";

// ── Mock 模块 ──────────────────────────────────────────────
//
// mock 掉文件系统操作、child_process、readline，
// 避免真实文件系统 I/O 和 npm install。
//

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      cb("y");
    }),
    close: vi.fn(),
  })),
}));

import { createCommand } from "../../../src/cli/create.js";

// ── 类型化 mock ────────────────────────────────────────────

const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = fs.mkdirSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = fs.writeFileSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = fs.readdirSync as ReturnType<typeof vi.fn>;
const mockRmSync = fs.rmSync as ReturnType<typeof vi.fn>;
const mockExecSync = execSync as ReturnType<typeof vi.fn>;

// ── 全局 Spy ───────────────────────────────────────────────

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processExitSpy: any;
let originalExitCode: number | undefined;

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * 收集所有 writeFileSync 调用，返回 { 相对路径: 内容 } 映射
 */
function getWrittenFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const call of mockWriteFileSync.mock.calls) {
    const fullPath = call[0] as string;
    const content = call[1] as string;
    // 提取项目目录后的相对路径
    const parts = fullPath.replace(/\\/g, "/").split("/");
    // 找到项目名称后的路径部分
    const idx = parts.findIndex(
      (p: string) =>
        p === "test-app" ||
        p === "my-app" ||
        p === "hello_world" ||
        p === "my-project",
    );
    if (idx >= 0) {
      const relPath = parts.slice(idx + 1).join("/");
      files[relPath] = content;
    }
  }
  return files;
}

/**
 * 收集所有 mkdirSync 调用的目录路径
 */
function getCreatedDirs(): string[] {
  return mockMkdirSync.mock.calls.map((call: unknown[]) => {
    const dirPath = (call[0] as string).replace(/\\/g, "/");
    return dirPath;
  });
}

/**
 * 默认 mock：目标目录不存在
 */
function setupFreshProject(): void {
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
}

// ── 测试生命周期 ────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  processExitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: string | number | null | undefined) => {
      // 不抛异常，仅记录调用（create 命令中 process.exit 后有 return 兜底）
      return undefined as never;
    });
  setupFreshProject();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  processExitSpy.mockRestore();
});

// ══════════════════════════════════════════════════════════════
// 测试套件
// ══════════════════════════════════════════════════════════════

describe("vext create", () => {
  // ────────────────────────────────────────────────────────
  // 1. 参数解析
  // ────────────────────────────────────────────────────────

  describe("参数解析", () => {
    it("无参数时输出错误并退出", async () => {
      await createCommand([]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Project name is required"),
      );
    });

    it("--help 输出帮助信息", async () => {
      await createCommand(["--help"]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("vext create <project-name>"),
      );
      // 不应退出（graceful return）
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("-h 输出帮助信息", async () => {
      await createCommand(["-h"]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("vext create <project-name>"),
      );
    });

    it("--help 在项目名之前也能生效", async () => {
      await createCommand(["--help", "my-app"]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("vext create <project-name>"),
      );
      // 不应创建文件
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("无效项目名称（包含特殊字符）退出", async () => {
      await createCommand(["@invalid/name"]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid project name"),
      );
    });

    it("无效项目名称（以点号开头）退出", async () => {
      await createCommand([".hidden"]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid project name"),
      );
    });

    it("无效项目名称（以连字符开头）退出", async () => {
      await createCommand(["-start-dash"]);
      // parseArgs 会把它当作选项而报错
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("合法项目名：字母数字下划线连字符点号", async () => {
      await createCommand(["my_project.v2"]);
      // 不应因名称验证而退出
      const exitCalls = processExitSpy.mock.calls;
      const nameErrors = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes("Invalid project name"),
      );
      expect(nameErrors).toHaveLength(0);
    });

    it("合法项目名：以数字开头", async () => {
      await createCommand(["123app"]);
      const nameErrors = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes("Invalid project name"),
      );
      expect(nameErrors).toHaveLength(0);
    });

    it("合法项目名：以下划线开头", async () => {
      await createCommand(["_private"]);
      const nameErrors = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes("Invalid project name"),
      );
      expect(nameErrors).toHaveLength(0);
    });

    it("无效 adapter 退出", async () => {
      await createCommand(["test-app", "--adapter", "django"]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid adapter"),
      );
    });

    it("无效 template 退出", async () => {
      await createCommand(["test-app", "--template", "graphql"]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid template"),
      );
    });

    it("未知选项退出", async () => {
      await createCommand(["test-app", "--unknown-flag"]);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // 2. 目录结构生成（TypeScript 默认模式）
  // ────────────────────────────────────────────────────────

  describe("目录结构生成（TypeScript）", () => {
    it("只创建带初始内容的目录", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const dirs = getCreatedDirs();
      const dirsSuffix = dirs.map((d: string) => {
        const parts = d.split("/");
        const idx = parts.indexOf("test-app");
        return idx >= 0 ? parts.slice(idx + 1).join("/") : d;
      });

      expect(dirsSuffix).toEqual(
        expect.arrayContaining([
          "src/routes",
          "src/services",
          "src/config",
          "src/frontend/pages",
          "src/frontend/pages/error",
          "src/frontend/components",
          "src/frontend/styles",
          "src/frontend/locales",
          "public",
          "src/types/generated",
          "src/types/shared",
          "src/types/frontend",
        ]),
      );
      expect(dirsSuffix).not.toEqual(
        expect.arrayContaining([
          "src/middlewares",
          "src/plugins",
          "src/locales",
          "src/preload",
          "preload",
          "src/frontend/assets",
        ]),
      );
    });

    it("生成所有必要文件", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      const fileNames = Object.keys(files);

      expect(fileNames).toEqual(
        expect.arrayContaining([
          "package.json",
          ".gitignore",
          "tsconfig.json",
          "src/config/default.ts",
          "src/config/development.ts",
          "src/config/production.ts",
          "src/config/local.example.ts",
          "src/config/bootstrap.example.ts",
          "src/routes/index.ts",
          "src/services/example.ts",
          "src/frontend/pages/index.tsx",
          "src/frontend/pages/layout.tsx",
          "src/frontend/pages/error/default.tsx",
          "src/frontend/pages/_document.html",
          "src/frontend/components/AppShell.tsx",
          "src/frontend/locales/en-US.ts",
          "src/frontend/styles/index.css",
          "public/vext-mark.svg",
          "public/favicon.svg",
          "src/types/generated/.gitkeep",
          "src/types/shared/greeting.d.ts",
          "src/types/frontend/home.d.ts",
        ]),
      );
    });

    it("不生成样板 README 占位文件", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();

      expect(
        Object.keys(files).some((file) => file.endsWith("README.md")),
      ).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────
  // 3. 目录结构生成（JavaScript 模式）
  // ────────────────────────────────────────────────────────

  describe("目录结构生成（JavaScript）", () => {
    it("JS 模式不生成 tsconfig.json 和 types/", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const fileNames = Object.keys(files);

      expect(fileNames).not.toContain("tsconfig.json");
      expect(fileNames).not.toContain("src/types/services.d.ts");
      expect(fileNames).not.toContain("src/types/generated/.gitkeep");
    });

    it("JS 模式不创建 src/types 目录", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const dirs = getCreatedDirs();
      const hasTypesDir = dirs.some((d: string) => d.includes("src/types"));
      expect(hasTypesDir).toBe(false);
    });

    it("JS 模式生成 .js 扩展名的文件", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const fileNames = Object.keys(files);

      expect(fileNames).toEqual(
        expect.arrayContaining([
          "src/config/default.js",
          "src/config/development.js",
          "src/config/production.js",
          "src/config/local.example.js",
          "src/config/bootstrap.example.js",
          "src/routes/index.js",
          "src/services/example.js",
        ]),
      );

      // 不应有 .ts 源文件
      const tsFiles = fileNames.filter(
        (f: string) =>
          f.endsWith(".ts") && !f.endsWith(".d.ts") && f.startsWith("src/"),
      );
      expect(tsFiles).toHaveLength(0);
    });

    it("JS 模式 package.json 无 typescript devDependency", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.devDependencies?.typescript).toBeUndefined();
    });

    it("JS 模式 package.json 无 build script", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.scripts.build).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────
  // 4. 模板文件内容验证
  // ────────────────────────────────────────────────────────

  describe("模板文件内容", () => {
    describe("package.json", () => {
      it("包含正确的项目名称", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.name).toBe("test-app");
      });

      it("版本号为 0.1.0", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.version).toBe("0.1.0");
      });

      it("private 为 true", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.private).toBe(true);
      });

      it("type 为 module", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.type).toBe("module");
      });

      it("包含 dev 和 start scripts", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.scripts.dev).toBe("vext dev");
        expect(pkg.scripts.start).toBe("vext start");
      });

      it("TS 模式包含 build script", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.scripts.build).toBe("vext build --typecheck");
      });

      it("dependencies 包含 vextjs", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.dependencies.vextjs).toBeDefined();
      });

      it("默认将 vextjs 写成框架版本的 caret 范围（公共 npm 安装）", async () => {
        const previous = process.env.VEXT_PACKAGE;
        delete process.env.VEXT_PACKAGE;
        try {
          await createCommand(["test-app", "--skip-install"]);

          const files = getWrittenFiles();
          const pkg = JSON.parse(files["package.json"]);
          const { createRequire } = await import("node:module");
          const require = createRequire(import.meta.url);
          const framework = require("../../../package.json") as {
            version: string;
          };

          expect(pkg.dependencies.vextjs).toBe(`^${framework.version}`);
        } finally {
          if (previous === undefined) delete process.env.VEXT_PACKAGE;
          else process.env.VEXT_PACKAGE = previous;
        }
      });

      it("fullstack 将 React 开发运行时钉到与 vextjs 一致的精确版本", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const framework = require("../../../package.json") as {
          dependencies: Record<string, string>;
        };

        // Exact pins — floating carets nest a second react under node_modules/vextjs
        // when the registry has a newer patch than vextjs's exact dependency.
        expect(pkg.dependencies.react).toBe(framework.dependencies.react);
        expect(pkg.dependencies["react-dom"]).toBe(
          framework.dependencies["react-dom"],
        );
        expect(pkg.devDependencies["react-refresh"]).toBe(
          framework.dependencies["react-refresh"],
        );
        expect(pkg.dependencies.react).not.toMatch(/^[\^~]/);
        expect(pkg.dependencies["react-dom"]).not.toMatch(/^[\^~]/);
        expect(pkg.devDependencies["react-refresh"]).not.toMatch(/^[\^~]/);
      });

      it("api 模板不声明 react/react-dom", async () => {
        await createCommand([
          "test-app",
          "--template",
          "api",
          "--skip-install",
        ]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.dependencies.react).toBeUndefined();
        expect(pkg.dependencies["react-dom"]).toBeUndefined();
        expect(pkg.devDependencies?.["react-refresh"]).toBeUndefined();
      });

      it("VEXT_PACKAGE 覆盖生成的 vextjs 依赖（file: 候选包）", async () => {
        const previous = process.env.VEXT_PACKAGE;
        process.env.VEXT_PACKAGE =
          "file:E:/Worker/vext-test/candidate/vextjs-0.3.26.tgz";
        try {
          await createCommand(["test-app", "--skip-install"]);

          const files = getWrittenFiles();
          const pkg = JSON.parse(files["package.json"]);

          expect(pkg.dependencies.vextjs).toBe(
            "file:E:/Worker/vext-test/candidate/vextjs-0.3.26.tgz",
          );
        } finally {
          if (previous === undefined) delete process.env.VEXT_PACKAGE;
          else process.env.VEXT_PACKAGE = previous;
        }
      });

      it("VEXT_PACKAGE 相对路径规范化为 file: 绝对路径", async () => {
        const previous = process.env.VEXT_PACKAGE;
        process.env.VEXT_PACKAGE = "../vext";
        try {
          await createCommand(["test-app", "--skip-install"]);

          const files = getWrittenFiles();
          const pkg = JSON.parse(files["package.json"]);
          const path = await import("node:path");
          const expected = `file:${path
            .resolve("../vext")
            .replaceAll("\\", "/")}`;

          expect(pkg.dependencies.vextjs).toBe(expected);
        } finally {
          if (previous === undefined) delete process.env.VEXT_PACKAGE;
          else process.env.VEXT_PACKAGE = previous;
        }
      });

      it("TS 模式 devDependencies 包含 typescript", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);

        expect(pkg.devDependencies.typescript).toBeDefined();
      });
    });

    describe("tsconfig.json", () => {
      it("TS 模式生成有效的 tsconfig", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);

        expect(tsconfig.compilerOptions).toBeDefined();
        expect(tsconfig.compilerOptions.target).toBe("ES2022");
        expect(tsconfig.compilerOptions.module).toBe("NodeNext");
        expect(tsconfig.compilerOptions.moduleResolution).toBe("NodeNext");
        expect(tsconfig.compilerOptions.strict).toBe(true);
        expect(tsconfig.compilerOptions.outDir).toBe("./dist");
        expect(tsconfig.compilerOptions.rootDir).toBe("./src");
      });

      it("tsconfig include 覆盖 src", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);

        expect(tsconfig.include).toContain("src/**/*.ts");
        expect(tsconfig.include).toContain("src/**/*.tsx");
        expect(tsconfig.include).toContain("src/**/*.d.ts");
      });

      it("tsconfig exclude 排除 node_modules 和 dist", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);

        expect(tsconfig.exclude).toContain("node_modules");
        expect(tsconfig.exclude).toContain("dist");
      });

      it("fullstack TS 模板生成与运行时一致的前端 alias", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);

        expect(tsconfig.compilerOptions.baseUrl).toBe(".");
        expect(tsconfig.compilerOptions.paths).toEqual({
          "@frontend/*": [
            "src/frontend/*",
            "src/frontend/*.js",
            "src/frontend/*/index.js",
          ],
          "@pages/*": [
            "src/frontend/pages/*",
            "src/frontend/pages/*.js",
            "src/frontend/pages/*/index.js",
          ],
          "@components/*": [
            "src/frontend/components/*",
            "src/frontend/components/*.js",
            "src/frontend/components/*/index.js",
          ],
          "@styles/*": [
            "src/frontend/styles/*",
            "src/frontend/styles/*.js",
            "src/frontend/styles/*/index.js",
          ],
          "@assets/*": [
            "src/frontend/assets/*",
            "src/frontend/assets/*.js",
            "src/frontend/assets/*/index.js",
          ],
        });
      });

      it("TypeScript 模板显式安装 Node 运行时类型", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const pkg = JSON.parse(files["package.json"]);
        expect(pkg.devDependencies["@types/node"]).toBe("^20.19.0");
      });

      it("fullstack alias 可按 NodeNext ESM 规则解析 TSX 源文件", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);
        const projectRoot = "E:/generated-vext-app";
        const generatedPaths = new Set(
          Object.keys(files).map((file) => `${projectRoot}/${file}`),
        );
        const result = ts.resolveModuleName(
          "@components/AppShell",
          `${projectRoot}/src/frontend/pages/layout.tsx`,
          {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            baseUrl: projectRoot,
            paths: tsconfig.compilerOptions.paths,
          },
          {
            fileExists: (file) =>
              generatedPaths.has(file.replaceAll("\\", "/")),
            readFile: () => "",
            directoryExists: () => true,
            getCurrentDirectory: () => projectRoot,
            getDirectories: () => [],
          },
          undefined,
          undefined,
          ts.ModuleKind.ESNext,
        );

        expect(
          result.resolvedModule?.resolvedFileName.replaceAll("\\", "/"),
        ).toBe(`${projectRoot}/src/frontend/components/AppShell.tsx`);
      });

      it("API-only TS 模板不生成前端 alias", async () => {
        await createCommand([
          "test-app",
          "--template",
          "api",
          "--frontend",
          "none",
          "--skip-install",
        ]);

        const files = getWrittenFiles();
        const tsconfig = JSON.parse(files["tsconfig.json"]);

        expect(tsconfig.compilerOptions.paths).toBeUndefined();
      });
    });

    describe(".gitignore", () => {
      it("包含 node_modules", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files[".gitignore"]).toContain("node_modules/");
      });

      it("包含 dist", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files[".gitignore"]).toContain("dist/");
      });

      it("包含 .vext", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files[".gitignore"]).toContain(".vext/");
      });

      it("包含 .env", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files[".gitignore"]).toContain(".env");
      });

      it("包含 local config", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files[".gitignore"]).toContain("src/config/local.");
      });
    });

    describe("scaffold hygiene", () => {
      it("does not generate a root README in TypeScript or JavaScript projects", async () => {
        await createCommand(["test-app", "--skip-install"]);
        expect(Object.keys(getWrittenFiles())).not.toContain("README.md");

        vi.clearAllMocks();
        setupFreshProject();
        await createCommand(["test-app", "--js", "--skip-install"]);
        expect(Object.keys(getWrittenFiles())).not.toContain("README.md");
      });

      it("keeps generated non-locale source English-first in every template and language mode", async () => {
        const scenarios = [
          ["--skip-install"],
          ["--js", "--skip-install"],
          ["--template", "api", "--frontend", "none", "--skip-install"],
          ["--js", "--template", "api", "--frontend", "none", "--skip-install"],
        ];

        for (const args of scenarios) {
          vi.clearAllMocks();
          setupFreshProject();
          await createCommand(["test-app", ...args]);

          const nonLocaleSource = Object.entries(getWrittenFiles()).filter(
            ([file]) => file.startsWith("src/") && !file.includes("/locales/"),
          );
          const filesWithHanText = nonLocaleSource
            .filter(([, content]) => /\p{Script=Han}/u.test(content))
            .map(([file]) => file);

          expect(filesWithHanText, `scenario: ${args.join(" ")}`).toEqual([]);
        }
      });
    });

    describe("src/config/default", () => {
      it("TS 模式导入 VextUserConfig 类型", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toContain(
          "import type { VextUserConfig } from 'vextjs'",
        );
      });

      it("包含端口配置", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toContain("port: 3000");
      });

      it("使用指定的 adapter", async () => {
        await createCommand([
          "test-app",
          "--adapter",
          "native",
          "--skip-install",
        ]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toContain("adapter: 'native'");
      });

      it("默认 adapter 为 native", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toContain("adapter: 'native'");
      });

      it("默认显式关闭 rateLimit", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toMatch(
          /rateLimit:\s*\{\s*enabled: false,/,
        );

        vi.clearAllMocks();
        setupFreshProject();
        await createCommand(["test-app", "--js", "--skip-install"]);
        expect(getWrittenFiles()["src/config/default.js"]).toMatch(
          /rateLimit:\s*\{\s*enabled: false,/,
        );
      });

      it("默认 fullstack 配置不写死 frontend outDir", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.ts"]).toMatch(
          /openapi:\s*\{\s*enabled: true,/,
        );
        expect(files["src/config/default.ts"]).toContain("frontend:");
        expect(files["src/config/default.ts"]).not.toContain("src/client");
        expect(files["src/config/default.ts"]).not.toContain("entry:");
        expect(files["src/config/default.ts"]).not.toContain("indexHtml:");
        expect(files["src/config/default.ts"]).toContain("streaming: 'auto'");
        expect(files["src/config/default.ts"]).toContain("i18n:");
        expect(files["src/config/default.ts"]).toContain(
          "defaultLocale: 'en-US'",
        );
        expect(files["src/config/default.ts"]).not.toContain(
          "outDir: 'dist/client'",
        );
      });

      it("JS 模式使用 JSDoc 类型注释", async () => {
        await createCommand(["test-app", "--js", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/config/default.js"]).toContain("@type");
        expect(files["src/config/default.js"]).toContain("VextUserConfig");
      });
    });

    describe("src/config/development", () => {
      it("配置 logger debug + pretty", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const content = files["src/config/development.ts"];

        expect(content).toContain("level: 'debug'");
        expect(content).toContain("pretty: true");
      });
    });

    describe("src/config/production", () => {
      it("配置 logger info + 非 pretty", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const content = files["src/config/production.ts"];

        expect(content).toContain("level: 'info'");
        expect(content).toContain("pretty: false");
      });
    });

    describe("src/routes/index", () => {
      it("使用 defineRoutes", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/routes/index.ts"]).toContain(
          "import { defineRoutes } from 'vextjs'",
        );
        expect(files["src/routes/index.ts"]).toContain("defineRoutes((app)");
      });

      it("默认 fullstack 模板包含 API 路由 GET /api/hello", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/routes/index.ts"]).toContain("app.get('/api/hello'");
      });

      it("默认 fullstack 模板包含健康检查路由 GET /api/health", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/routes/index.ts"]).toContain("app.get('/api/health'");
      });

      it("默认 fullstack 模板首页通过 res.render 渲染页面", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/routes/index.ts"]).toContain("app.get('/'");
        expect(files["src/routes/index.ts"]).toContain("res.render(");
        expect(files["src/routes/index.ts"]).toContain("'index'");
        expect(files["src/routes/index.ts"]).toContain(
          "Vext Runtime Launchpad",
        );
      });

      it("调用 example service", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/routes/index.ts"]).toContain(
          "app.services.example.greeting",
        );
      });
    });

    describe("src/frontend", () => {
      it("生成自动入口所需的 document、layout、页面和默认错误页", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/frontend/pages/_document.html"]).toContain(
          "{vext.root}",
        );
        expect(files["src/frontend/pages/_document.html"]).toContain(
          "{vext.data}",
        );
        expect(files["src/frontend/pages/_document.html"]).toContain(
          "{vext.entry}",
        );
        expect(files["src/frontend/pages/_document.html"]).toContain(
          'href="/favicon.svg"',
        );
        expect(files["src/frontend/pages/_document.html"]).not.toContain(
          "%VEXT",
        );
        expect(files["src/frontend/pages/layout.tsx"]).toContain(
          "@components/AppShell",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain("useVextI18n");
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "const home = i18n.home ??",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "runtime-facts",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "runtime-trace",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "capability-grid",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "starter-commands",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "getting-started",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          'href="https://devcodex-labs.github.io/vextjs/"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          "useVextI18n",
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          "const shell = i18n.shell ??",
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'src="/vext-mark.svg"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'href="/docs"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'href="https://devcodex-labs.github.io/vextjs/"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'className="nav-docs"',
        );
        expect(files["src/frontend/locales/en-US.ts"]).toContain(
          "docs: 'Documentation'",
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'className="nav-start"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).toContain(
          'className="nav-health"',
        );
        expect(files["src/frontend/components/AppShell.tsx"]).not.toContain(
          'aria-hidden="true">V<',
        );
        expect(files["public/vext-mark.svg"]).not.toBe(
          files["public/favicon.svg"],
        );
        expect(files["public/vext-mark.svg"]).toContain('viewBox="0 0 72 72"');
        expect(files["public/vext-mark.svg"]).not.toContain("<rect");
        expect(files["public/favicon.svg"]).toContain("<rect");
        expect(files["public/vext-mark.svg"]).toContain('stroke="#12D6C6"');
        expect(files["public/vext-mark.svg"]).toContain('stroke="#5EE987"');
        expect(files["src/frontend/styles/index.css"]).toContain(
          "prefers-reduced-motion",
        );
        expect(files["src/frontend/styles/index.css"]).toContain("--vext-cyan");
        expect(files["src/frontend/styles/index.css"]).toContain(
          "--vext-green",
        );
        expect(files["src/frontend/styles/index.css"]).toContain(
          ":focus-visible",
        );
        expect(files["src/frontend/styles/index.css"]).toContain(
          "vext-grid-drift",
        );
        expect(files["src/frontend/styles/index.css"]).toContain(
          "vext-hero-glow",
        );
        expect(files["src/frontend/styles/index.css"]).toContain(
          "padding: clamp(44px, 5vw, 72px)",
        );
        expect(files["src/frontend/pages/error/default.tsx"]).toContain(
          "DefaultErrorPage",
        );
      });

      it("生成与文档站一致的透明 V 标记及高对比 favicon", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        const docsMark = actualFs
          .readFileSync("website/docs/public/logo.svg", "utf8")
          .replace(/\r\n/g, "\n")
          .trim();
        const files = getWrittenFiles();

        expect(
          files["public/vext-mark.svg"].replace(/\r\n/g, "\n").trim(),
        ).toBe(docsMark);
        expect(
          files["public/favicon.svg"].replace(/\r\n/g, "\n").trim(),
        ).not.toBe(docsMark);
        expect(files["public/favicon.svg"]).toContain("<rect");
        const faviconGeometry = files["public/favicon.svg"]
          .replace(/\s*<rect[^>]*\/>\r?\n/, "\n")
          .replace(/\r\n/g, "\n")
          .trim();
        expect(faviconGeometry).toBe(
          files["public/vext-mark.svg"].replace(/\r\n/g, "\n").trim(),
        );
      });

      it("JavaScript fullstack 模板也生成同源几何的品牌资产", async () => {
        await createCommand(["test-app", "--js", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/frontend/components/AppShell.jsx"]).toContain(
          'src="/vext-mark.svg"',
        );
        expect(files["src/frontend/components/AppShell.jsx"]).toContain(
          'href="/docs"',
        );
        expect(files["src/frontend/components/AppShell.jsx"]).toContain(
          'className="nav-docs"',
        );
        expect(files["src/config/default.js"]).toMatch(
          /openapi:\s*\{\s*enabled: true,/,
        );
        expect(files["src/frontend/pages/index.jsx"]).toContain(
          'href="https://devcodex-labs.github.io/vextjs/"',
        );
        expect(files["src/frontend/pages/index.jsx"]).toContain(
          "runtime-trace",
        );
        expect(files["src/frontend/pages/index.jsx"]).toContain(
          "starter-commands",
        );
        expect(files["public/vext-mark.svg"]).not.toBe(
          files["public/favicon.svg"],
        );
      });

      it("默认 fullstack 模板不再生成旧 src/client SPA 入口", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        const content = Object.values(files).join("\n");
        expect(
          Object.keys(files).some((file) => file.startsWith("src/client/")),
        ).toBe(false);
        expect(content).not.toContain("createVextApiClient");
        expect(content).not.toContain("%VEXT_ENTRY%");
      });
    });

    describe("src/services/example", () => {
      it("导出 ExampleService 类", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/services/example.ts"]).toContain(
          "export default class ExampleService",
        );
      });

      it("包含 greeting 方法", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/services/example.ts"]).toContain("async greeting(");
      });

      it("TS 模式导入 VextApp 类型", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/services/example.ts"]).toContain(
          "import type { VextApp } from 'vextjs'",
        );
      });

      it("JS 模式没有类型导入", async () => {
        await createCommand(["test-app", "--js", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/services/example.js"]).not.toContain("import type");
      });

      it("包含 constructor 接收 app", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/services/example.ts"]).toContain("constructor(app");
      });
    });

    describe("generated type workflow", () => {
      it("TS 模式不预生成静态 src/types/services.d.ts", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/types/services.d.ts"]).toBeUndefined();
      });

      it("TS 模式创建 generated type 输出目录占位", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/types/generated/.gitkeep"]).toBe("");
      });

      it("fullstack TS 按 shared/frontend/generated 边界生成类型", async () => {
        await createCommand(["test-app", "--skip-install"]);

        const files = getWrittenFiles();
        expect(files["src/types/shared/greeting.d.ts"]).toContain(
          "export interface GreetingDto",
        );
        expect(files["src/types/frontend/home.d.ts"]).toContain(
          "import type { GreetingDto } from '../shared/greeting.js'",
        );
        expect(files["src/types/frontend/home.d.ts"]).toContain(
          "export interface HomePageProps",
        );
        expect(files["src/types/frontend/home.d.ts"]).toContain(
          "extends Record<string, unknown>",
        );
        expect(files["src/services/example.ts"]).toContain(
          "import type { GreetingDto } from '../types/shared/greeting.js'",
        );
        expect(files["src/services/example.ts"]).toContain(
          "Promise<GreetingDto>",
        );
        expect(files["src/routes/index.ts"]).toContain(
          "import type { HomePageProps } from '../types/frontend/home.js'",
        );
        expect(files["src/routes/index.ts"]).toContain(
          "const page: HomePageProps",
        );
        expect(files["src/frontend/pages/index.tsx"]).toContain(
          "import type { HomePageProps } from '../../types/frontend/home.js'",
        );
        expect(files["src/frontend/pages/index.tsx"]).not.toContain(
          "type HomePageProps =",
        );
        expect(files["src/types/server/.gitkeep"]).toBeUndefined();
      });

      it("API TS 只保留 generated 输出目录，不生成前端或样例共享类型", async () => {
        await createCommand([
          "test-app",
          "--template",
          "api",
          "--frontend",
          "none",
          "--skip-install",
        ]);

        const files = getWrittenFiles();
        expect(files["src/types/generated/.gitkeep"]).toBe("");
        expect(files["src/types/shared/greeting.d.ts"]).toBeUndefined();
        expect(files["src/types/frontend/home.d.ts"]).toBeUndefined();
        expect(files["src/services/example.ts"]).not.toContain(
          "types/shared/greeting",
        );
        expect(files["src/services/example.ts"]).toContain(
          "Promise<{ message: string }>",
        );
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // 5. Adapter 选项
  // ────────────────────────────────────────────────────────

  describe("adapter 选项", () => {
    it("默认 adapter 为 native", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.hono).toBeUndefined();
      expect(pkg.dependencies["@hono/node-server"]).toBeUndefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'native'");
    });

    it("--adapter fastify 添加 fastify 依赖", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "fastify",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.fastify).toBeDefined();
      expect(pkg.dependencies.hono).toBeUndefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'fastify'");
    });

    it("--adapter hono 只添加运行时实际使用的 hono 依赖", async () => {
      await createCommand(["test-app", "--adapter", "hono", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.hono).toBe("^4.0.0");
      expect(pkg.dependencies["@hono/node-server"]).toBeUndefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'hono'");
    });

    it("--adapter express 添加 express 依赖和 @types/express", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "express",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.express).toBeDefined();
      expect(pkg.devDependencies["@types/express"]).toBeDefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'express'");
    });

    it("--adapter express --js 不添加 @types/express", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "express",
        "--js",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.express).toBeDefined();
      expect(pkg.devDependencies?.["@types/express"]).toBeUndefined();
    });

    it("--adapter koa 添加 koa、@koa/router 依赖和 @types/koa", async () => {
      await createCommand(["test-app", "--adapter", "koa", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies["@koa/router"]).toBe("^15.6.0");
      expect(pkg.dependencies.koa).toBeDefined();
      expect(pkg.devDependencies["@types/koa"]).toBeDefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'koa'");
    });

    it("--adapter koa --js 不添加 @types/koa", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "koa",
        "--js",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      expect(pkg.dependencies.koa).toBeDefined();
      expect(pkg.dependencies["@koa/router"]).toBeDefined();
      expect(pkg.devDependencies?.["@types/koa"]).toBeUndefined();
    });

    it("--adapter native 无额外依赖", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "native",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      // native adapter 不需要任何额外框架依赖
      expect(pkg.dependencies.hono).toBeUndefined();
      expect(pkg.dependencies.fastify).toBeUndefined();
      expect(pkg.dependencies.express).toBeUndefined();
      expect(pkg.dependencies.koa).toBeUndefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'native'");
    });

    for (const adapter of ["hono", "fastify", "express", "koa", "native"]) {
      it(`--adapter ${adapter} 是合法的 adapter`, async () => {
        await createCommand([
          "test-app",
          "--adapter",
          adapter,
          "--skip-install",
        ]);

        const adapterErrors = consoleErrorSpy.mock.calls.filter(
          (call: unknown[]) => (call[0] as string).includes("Invalid adapter"),
        );
        expect(adapterErrors).toHaveLength(0);
      });
    }
  });

  // ────────────────────────────────────────────────────────
  // 6. npm install
  // ────────────────────────────────────────────────────────

  describe("npm install", () => {
    it("默认执行 npm install", async () => {
      await createCommand(["test-app"]);

      expect(mockExecSync).toHaveBeenCalledWith(
        "npm install",
        expect.objectContaining({
          stdio: "inherit",
        }),
      );
    });

    it("--skip-install 跳过 npm install", async () => {
      await createCommand(["test-app", "--skip-install"]);

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("npm install 失败保留项目并返回非零状态", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("npm ERR!");
      });

      await createCommand(["test-app"]);

      const files = getWrittenFiles();
      expect(files["package.json"]).toBeDefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install failed"),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install"),
      );
      expect(process.exitCode).toBe(1);
      expect(processExitSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Project "test-app" created successfully'),
      );
    });
  });

  // ────────────────────────────────────────────────────────
  // 7. 目录存在处理
  // ────────────────────────────────────────────────────────

  describe("目录存在处理", () => {
    it("空目录直接使用（不询问）", async () => {
      mockExistsSync.mockImplementation((p: string) => {
        const normalized = (p as string).replace(/\\/g, "/");
        if (normalized.endsWith("test-app")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue([]);

      await createCommand(["test-app", "--skip-install"]);

      // 应正常创建文件
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("非空目录 + --force 直接覆盖", async () => {
      mockExistsSync.mockImplementation((p: string) => {
        const normalized = (p as string).replace(/\\/g, "/");
        if (normalized.endsWith("test-app")) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(["package.json", "src"]);

      await createCommand(["test-app", "--force", "--skip-install"]);

      // 应删除旧目录
      expect(mockRmSync).toHaveBeenCalled();
      // 应创建新文件
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────
  // 8. 成功提示
  // ────────────────────────────────────────────────────────

  describe("成功提示", () => {
    it("输出项目创建成功信息", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("created successfully");
    });

    it("输出 cd 命令提示", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("cd test-app");
    });

    it("输出 npm run dev 命令提示", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("npm run dev");
    });

    it("--skip-install 时提示 npm install", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("npm install");
    });

    it("TS 模式提示 npm run build", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("npm run build");
    });

    it("JS API 模式不提示 npm run build", async () => {
      await createCommand([
        "test-app",
        "--js",
        "--template",
        "api",
        "--skip-install",
      ]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).not.toContain("npm run build");
    });

    it("输出创建信息包含语言类型", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("TypeScript");
    });

    it("JS 模式输出 JavaScript", async () => {
      await createCommand(["test-app", "--js", "--skip-install"]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("JavaScript");
    });

    it("输出创建信息包含 adapter 名称", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "fastify",
        "--skip-install",
      ]);

      const logOutput = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n");
      expect(logOutput).toContain("fastify");
    });
  });

  // ────────────────────────────────────────────────────────
  // 9. 文件数量统计
  // ────────────────────────────────────────────────────────

  describe("文件数量", () => {
    it("TS 模式生成正确的文件数量", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      // 模板文件：package.json + .gitignore + tsconfig.json +
      //           5 config files + routes/index.ts + services/example.ts +
      //           generated/.gitkeep + 2 authored type files +
      //           9 fullstack frontend/public files = 22
      expect(Object.keys(files).length).toBe(22);
    });

    it("JS 模式生成正确的文件数量", async () => {
      await createCommand(["test-app", "--js", "--skip-install"]);

      const files = getWrittenFiles();
      // 模板文件：package.json + .gitignore +
      //           5 config files + routes/index.js + services/example.js +
      //           9 fullstack frontend/public files = 18
      // 不含：tsconfig.json
      expect(Object.keys(files).length).toBe(18);
    });
  });

  // ────────────────────────────────────────────────────────
  // 10. package.json dependencies 排序
  // ────────────────────────────────────────────────────────

  describe("package.json dependencies 排序", () => {
    it("dependencies 按字母排序", async () => {
      await createCommand(["test-app", "--adapter", "hono", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);
      const keys = Object.keys(pkg.dependencies);

      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });

    it("devDependencies 按字母排序", async () => {
      await createCommand([
        "test-app",
        "--adapter",
        "express",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      if (pkg.devDependencies) {
        const keys = Object.keys(pkg.devDependencies);
        const sorted = [...keys].sort();
        expect(keys).toEqual(sorted);
      }
    });
  });

  // ────────────────────────────────────────────────────────
  // 11. 边界场景
  // ────────────────────────────────────────────────────────

  describe("边界场景", () => {
    it("多个 positional 参数会被拒绝且不创建项目", async () => {
      await createCommand(["my-app", "extra-arg", "--skip-install"]);

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unexpected positional arguments"),
      );
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(getWrittenFiles()).toEqual({});
    });

    it("项目名中的特殊合法字符（下划线、点号、连字符）", async () => {
      await createCommand(["hello_world", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);
      expect(pkg.name).toBe("hello_world");
    });

    it("文件内容结尾有换行符（package.json）", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      expect(files["package.json"].endsWith("\n")).toBe(true);
    });

    it("文件内容结尾有换行符（tsconfig.json）", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      expect(files["tsconfig.json"].endsWith("\n")).toBe(true);
    });

    it("package.json 是合法的 JSON", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      expect(() => JSON.parse(files["package.json"])).not.toThrow();
    });

    it("tsconfig.json 是合法的 JSON", async () => {
      await createCommand(["test-app", "--skip-install"]);

      const files = getWrittenFiles();
      expect(() => JSON.parse(files["tsconfig.json"])).not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // 12. 组合场景
  // ────────────────────────────────────────────────────────

  describe("组合场景", () => {
    it("--js --adapter native --skip-install 完整流程", async () => {
      await createCommand([
        "my-project",
        "--js",
        "--adapter",
        "native",
        "--skip-install",
      ]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      // 项目名正确
      expect(pkg.name).toBe("my-project");

      // JS 模式
      expect(files["tsconfig.json"]).toBeUndefined();
      expect(files["src/types/generated/.gitkeep"]).toBeUndefined();
      expect(
        Object.keys(files).some((f: string) => f === "src/routes/index.js"),
      ).toBe(true);
      expect(files["src/config/local.example.js"]).toBeDefined();

      // native adapter
      expect(pkg.dependencies.hono).toBeUndefined();
      expect(pkg.dependencies.fastify).toBeUndefined();
      expect(files["src/config/default.js"]).toContain("adapter: 'native'");

      // 不执行 npm install
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("--adapter koa --skip-install TS 模式", async () => {
      await createCommand(["my-project", "--adapter", "koa", "--skip-install"]);

      const files = getWrittenFiles();
      const pkg = JSON.parse(files["package.json"]);

      // TS 模式
      expect(files["tsconfig.json"]).toBeDefined();
      expect(files["src/types/services.d.ts"]).toBeUndefined();

      // Koa adapter
      expect(pkg.dependencies.koa).toBeDefined();
      expect(pkg.dependencies["@koa/router"]).toBe("^15.6.0");
      expect(pkg.devDependencies["@types/koa"]).toBeDefined();
      expect(files["src/config/default.ts"]).toContain("adapter: 'koa'");
    });
  });
});
