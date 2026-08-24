import path from "node:path";
import { rmSync, existsSync } from "node:fs";
import { detectProject } from "./utils/detect-project.js";
import { BuildCompiler } from "../lib/build/build-compiler.js";
import { loadConfig } from "../lib/config-loader.js";
import {
  buildFrontendClient,
  type BuildFrontendClientResult,
} from "../frontend/tooling/client-build-compiler.js";
import { deployFrontendAssets } from "../frontend/deploy/index.js";
import type { VextFrontendUserConfig } from "../frontend/contract/types.js";
import {
  printConfigProfileWarning,
  resolveConfigProfile,
} from "../lib/config-profile.js";
import { readRequiredOptionValue } from "./utils/command-args.js";
import { markUniqueOption } from "./utils/option-occurrence.js";

/**
 * vext build — 生产编译命令（Phase 2A）
 *
 * 将用户项目的 TypeScript 源码通过 esbuild 编译为 JavaScript，
 * 输出到 dist/ 目录。编译完成后，`vext start` 检测到 dist/ 存在时
 * 直接用 `node` 运行，不再依赖 tsx 运行时。
 *
 * 命令行参数：
 *   --outdir <path>    输出目录（默认 'dist'）
 *   --clean            编译前清理输出目录（默认 false）
 *   --no-sourcemap     不生成 source map（默认生成）
 *   --minify           代码压缩（默认 true；保留兼容选项）
 *   --no-minify        不压缩代码
 *   --typecheck        工具产物刷新后执行 TypeScript 类型检查（默认 false）
 *   -h, --help         显示帮助信息
 *
 * 用法示例：
 *   vext build                    基本编译
 *   vext build --clean            清理旧产物后编译
 *   vext build --outdir build     指定输出目录
 *   vext build --no-sourcemap     不生成 source map
 *   vext build --no-minify        保留未压缩的可读输出
 *   vext build --typecheck        生成类型/manifest 后执行类型检查
 *   vext build --clean --typecheck            完整生产构建
 *
 * 环境变量：
 *   VEXT_BUILD_OUTDIR      覆盖输出目录（优先级低于 CLI 参数）
 *   VEXT_BUILD_SOURCEMAP   设为 'false' 禁用 source map
 *   VEXT_BUILD_MINIFY      设为 'false' 禁用代码压缩
 *
 * @module cli/build
 * @see 09a-build.md §3（CLI 入口实现）
 * @see IMPLEMENTATION-PLAN.md 任务 2.5
 */

// ── 类型定义 ────────────────────────────────────────────────

interface BuildCommandOptions {
  /** 输出目录（相对于项目根目录） */
  outdir: string;

  /** 编译前清理输出目录 */
  clean: boolean;

  /** 生成 source map */
  sourcemap: boolean;

  /** 代码压缩 */
  minify: boolean;

  /** 工具产物刷新后执行 TypeScript 类型检查 */
  typecheck: boolean;

  /** 前端构建完成后上传静态资源 */
  uploadAssets: boolean;

  /** 只输出前端上传计划，不执行真实上传 */
  deployDryRun: boolean;

  /** 配置 profile 名称 */
  configProfile?: string;
}

// ── 主函数 ──────────────────────────────────────────────────

/**
 * buildCommand — vext build CLI 命令入口
 *
 * 解析命令行参数，检测项目结构，执行编译，输出报告。
 *
 * 流程：
 *   1. 解析命令行参数（CLI 参数 > 环境变量 > 默认值）
 *   2. detectProject() 检测项目结构
 *   3. JavaScript 项目 → 提示无需编译并退出
 *   4. --clean → 清理旧产物
 *   5. 刷新 typegen 与 route manifest（供类型检查/工具链消费）
 *   6. --typecheck → 执行 tsc --noEmit
 *   7. BuildCompiler.build() 执行编译
 *   8. 输出编译报告（文件数、耗时、输出目录）
 *
 * @param args 命令行参数（如 ['--clean', '--minify']）
 */
export async function buildCommand(args: string[] = []): Promise<void> {
  // ── 解析命令行参数 ────────────────────────────────────────
  const options = parseBuildArgs(args);
  const resolvedConfigProfile = resolveCliConfigProfile(options);
  printConfigProfileWarning(resolvedConfigProfile);

  // ── 检测项目结构 ──────────────────────────────────────────
  const rootDir = path.resolve(process.cwd());
  const project = detectProject(rootDir);

  const outDir = path.resolve(project.rootDir, options.outdir);

  // ── 打印编译信息 ──────────────────────────────────────────
  console.log(
    project.language === "ts"
      ? "[vextjs] build - TypeScript -> JavaScript"
      : "[vextjs] build - JavaScript project",
  );
  console.log(`[vextjs] src:  ${project.srcDir}`);
  console.log(`[vextjs] out:  ${outDir}`);

  if (options.minify) {
    console.log("[vextjs] minify: enabled");
  }
  if (!options.sourcemap) {
    console.log("[vextjs] sourcemap: disabled");
  }

  // ── 清理旧产物（--clean） ─────────────────────────────────
  if (options.clean && existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
    console.log(`[vextjs] cleaned: ${outDir}`);
  }

  if (project.language !== "ts") {
    const config = await loadConfig(path.join(project.srcDir, "config"), {
      rootDir: project.rootDir,
      command: "build",
      isBuilt: false,
      mode: "production",
      configProfile: resolvedConfigProfile.profile,
    });
    if (!isFrontendEnabled(config.frontend)) {
      console.log(
        "[vextjs] JavaScript project detected - no build step needed.",
      );
      console.log('[vextjs] Use "vext start" directly.');
      return;
    }
    await refreshRouteManifest(project.rootDir);
    await buildFrontendForCommand(project.rootDir, config.frontend, options);
    return;
  }

  // ── 工具产物刷新 ────────────────────────────────────────
  const { runTypegen } = await import("../tooling/typegen/index.js");
  const typegenResult = await runTypegen({
    rootDir: project.rootDir,
    generateServices: true,
    generateAppExtensions: true,
    writeManifest: true,
  });
  if (!typegenResult.ok) {
    console.error("[vextjs] typegen reported blocking issues - build aborted");
    for (const diagnostic of typegenResult.diagnostics) {
      const logger = diagnostic.level === "error" ? console.error : console.log;
      logger(`[vextjs] typegen ${diagnostic.level}: ${diagnostic.message}`);
    }
    process.exit(1);
  }

  await refreshRouteManifest(project.rootDir);

  // ── 类型检查（--typecheck，可选） ─────────────────────────
  if (options.typecheck) {
    console.log("[vextjs] running type check...");

    const { runLocalTsc } = await import("./utils/local-tsc.js");
    const typecheckResult = await runLocalTsc(project.rootDir, {
      pretty: false,
      stdio: "inherit",
    });
    if (typecheckResult.exitCode === 0) {
      console.log("[vextjs] type check passed ✓");
    } else {
      if (typecheckResult.output) {
        console.error(typecheckResult.output);
      }
      console.error("[vextjs] type check failed - build aborted");
      process.exit(1);
    }
  }

  // ── 编译 ──────────────────────────────────────────────────
  const compiler = new BuildCompiler({
    rootDir: project.rootDir,
    srcDir: project.srcDir,
    outDir,
    sourcemap: options.sourcemap,
    minify: options.minify,
  });

  try {
    const result = await compiler.build();

    if (!result.success) {
      console.error(
        `[vextjs] build failed with ${result.errors.length} error(s)`,
      );
      for (const err of result.errors) {
        const loc = err.location;
        if (loc) {
          console.error(`  ${loc.file}:${loc.line} - ${err.text}`);
        } else {
          console.error(`  ${err.text}`);
        }
      }
      process.exit(1);
    }

    // ── 输出警告信息 ──────────────────────────────────────
    if (result.warnings.length > 0) {
      console.log(`[vextjs] ⚠️  ${result.warnings.length} warning(s):`);
      for (const w of result.warnings) {
        const loc = w.location;
        if (loc) {
          console.log(`  ${loc.file}:${loc.line} - ${w.text}`);
        } else {
          console.log(`  ${w.text}`);
        }
      }
    }

    // ── 输出编译报告 ────────────────────────────────────────
    console.log("");
    console.log("[vextjs] ✅ build complete");
    console.log(`[vextjs]    files:   ${result.fileCount}`);
    console.log(`[vextjs]    time:    ${result.elapsed}ms`);
    console.log(`[vextjs]    output:  ${result.outDir}/`);
    const config = await loadConfig(path.join(outDir, "config"), {
      rootDir: project.rootDir,
      command: "build",
      isBuilt: true,
      mode: "production",
      configProfile: resolvedConfigProfile.profile,
    });
    await buildFrontendForCommand(project.rootDir, config.frontend, options);
    console.log("");
    console.log("[vextjs] To start compiled output:");
    console.log("[vextjs]   vext start");
    console.log(
      `[vextjs]   vext start --config ${resolvedConfigProfile.profile}`,
    );
  } catch (err) {
    console.error("[vextjs] build failed:");
    console.error(err);
    process.exit(1);
  }
}

async function refreshRouteManifest(rootDir: string): Promise<void> {
  const { runDoctor } = await import("../tooling/doctor/index.js");
  const doctorResult = await runDoctor({
    rootDir,
    target: "routes",
    writeManifest: true,
    refresh: true,
  });
  if (!doctorResult.ok) {
    console.error("[vextjs] route diagnostics failed - build aborted");
    process.exit(1);
  }
}

async function buildFrontendForCommand(
  rootDir: string,
  frontend: VextFrontendUserConfig | undefined,
  options: BuildCommandOptions,
): Promise<BuildFrontendClientResult | undefined> {
  const result = await buildFrontendClient({
    rootDir,
    config: withCliFrontendOutDir(frontend, options.outdir),
    mode: "production",
  });
  if (result.skipped) {
    if (options.uploadAssets) {
      console.log("[vextjs] frontend upload skipped: frontend is disabled");
    }
    return undefined;
  }

  console.log(
    `[vextjs] frontend built: ${path.relative(rootDir, result.config.outDir)}`,
  );
  if (typeof result.routeCount === "number") {
    console.log(`[vextjs] frontend route contracts: ${result.routeCount}`);
  }
  for (const warning of result.warnings) {
    console.warn(`[vextjs] frontend warning: ${warning}`);
  }
  if (options.uploadAssets) {
    if (!result.deployManifestPath) {
      throw new Error("[vextjs] frontend deploy manifest was not generated.");
    }
    const deployResult = await deployFrontendAssets({
      config: result.config,
      manifestPath: result.deployManifestPath,
      dryRun: options.deployDryRun,
    });
    console.log(
      `[vextjs] frontend assets ${deployResult.dryRun ? "planned" : "uploaded"}: ` +
        `${deployResult.uploaded} uploaded, ${deployResult.skipped} skipped, ` +
        `${deployResult.bytesUploaded} bytes`,
    );
  }
  return result;
}

function isFrontendEnabled(
  frontend: VextFrontendUserConfig | undefined,
): boolean {
  return (
    frontend === true ||
    (typeof frontend === "object" && frontend.enabled === true)
  );
}

function withCliFrontendOutDir(
  frontend: VextFrontendUserConfig | undefined,
  outdir: string,
): VextFrontendUserConfig | undefined {
  if (outdir === "dist" || frontend === undefined || frontend === false) {
    return frontend;
  }
  const clientOutDir = path.join(outdir, "client");
  if (frontend === true) {
    return { enabled: true, outDir: clientOutDir };
  }
  if (!frontend.outDir) {
    return { ...frontend, outDir: clientOutDir };
  }
  return frontend;
}

// ── 参数解析 ────────────────────────────────────────────────

function resolveCliConfigProfile(
  options: BuildCommandOptions,
): ReturnType<typeof resolveConfigProfile> {
  try {
    return resolveConfigProfile({
      cliProfile: options.configProfile,
      env: process.env,
      command: "build",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * parseBuildArgs — 解析 vext build 的命令行参数
 *
 * 优先级：CLI 参数 > 环境变量 > 默认值
 *
 * 手动解析（不引入第三方 CLI 库），保持零依赖。
 *
 * 支持的参数：
 *   --outdir <path>    输出目录（默认 'dist'）
 *   --config <name>    选择 build-time 配置 profile（默认 production）
 *   --clean            编译前清理（默认 false）
 *   --sourcemap        生成 source map（默认 true）
 *   --no-sourcemap     不生成 source map
 *   --minify           代码压缩（默认 true；保留兼容选项）
 *   --no-minify        不压缩代码
 *   --typecheck        工具产物刷新后执行类型检查（默认 false）
 *   -h, --help         显示帮助信息
 *
 * @param args 命令行参数数组
 * @returns 解析后的选项
 */
export function parseBuildArgs(args: string[]): BuildCommandOptions {
  // 默认值（环境变量覆盖）
  const options: BuildCommandOptions = {
    outdir: process.env.VEXT_BUILD_OUTDIR || "dist",
    clean: false,
    sourcemap: process.env.VEXT_BUILD_SOURCEMAP !== "false",
    minify: process.env.VEXT_BUILD_MINIFY !== "false",
    typecheck: false,
    uploadAssets: false,
    deployDryRun: false,
  };
  const seenOptions = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--outdir":
        {
          const parsed = readBuildOptionValue(args, i, arg, "<path>");
          options.outdir = parsed.value;
          i = parsed.nextIndex;
        }
        break;

      case "--config":
        markUniqueOption(seenOptions, "--config");
        {
          const parsed = readBuildOptionValue(args, i, arg, "<name>");
          options.configProfile = parsed.value;
          i = parsed.nextIndex;
        }
        break;

      case "--clean":
        options.clean = true;
        break;

      case "--sourcemap":
        options.sourcemap = true;
        break;

      case "--no-sourcemap":
        options.sourcemap = false;
        break;

      case "--minify":
        options.minify = true;
        break;

      case "--no-minify":
        options.minify = false;
        break;

      case "--typecheck":
        options.typecheck = true;
        break;

      case "--upload-assets":
        options.uploadAssets = true;
        break;

      case "--deploy-dry-run":
        options.deployDryRun = true;
        break;

      case "--help":
      case "-h":
        printBuildHelp();
        process.exit(0);
        break;

      default:
        if (arg?.startsWith("--")) {
          console.error(`[vextjs] Unknown option: "${arg}"\n`);
          printBuildHelp();
          process.exit(1);
        }
        console.error(`[vextjs] Unknown argument: "${arg}"\n`);
        printBuildHelp();
        process.exit(1);
        break;
    }
  }

  return options;
}

function readBuildOptionValue(
  args: string[],
  index: number,
  optionName: string,
  valueLabel: string,
) {
  try {
    return readRequiredOptionValue(args, index, optionName, valueLabel);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ── 帮助输出 ────────────────────────────────────────────────

/**
 * 打印 vext build 的帮助信息
 */
function printBuildHelp(): void {
  console.log(`
  Usage: vext build [options]

  Compile TypeScript source to JavaScript for production deployment.
  Positional arguments are not supported.
  Options that take values, such as --outdir/--config, require a non-option value.

  Options:
    --outdir <path>    Output directory (default: "dist")
    --config <name>    Load src/config/<name> for build-time config
    --clean            Clean output directory before build
    --sourcemap        Generate source maps (default: true)
    --no-sourcemap     Disable source map generation
    --minify           Minify output code (default: true)
    --no-minify        Disable output minification
    --typecheck        Run the project-local TypeScript compiler after generated artifacts refresh
    --upload-assets    Upload frontend static assets after build
    --deploy-dry-run   Print frontend upload plan without writing assets
    -h, --help         Show this help message

  Environment variables:
    VEXT_BUILD_OUTDIR      Override output directory
    VEXT_BUILD_SOURCEMAP   Set to "false" to disable source maps
    VEXT_BUILD_MINIFY      Set to "false" to disable minification

  Examples:
    $ vext build
    $ vext build --config sg-sit
    $ vext build --clean
    $ vext build --clean --typecheck
    $ vext build --upload-assets
    $ vext build --upload-assets --deploy-dry-run
    $ vext build --outdir build
    $ vext build --no-sourcemap
    $ vext build --no-minify

  After building, start with:
    $ vext start
    $ vext start --config sg-sit
`);
}
