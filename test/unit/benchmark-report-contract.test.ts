import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function readTextTree(relativeRoot: string): Array<[string, string]> {
  const root = path.join(process.cwd(), relativeRoot);
  const pending = [root];
  const files: Array<[string, string]> = [];

  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!/\.(?:ts|md|mdx)$/.test(entry.name)) continue;
      files.push([
        path.relative(process.cwd(), absolutePath),
        readFileSync(absolutePath, "utf8"),
      ]);
    }
  }

  return files;
}

function runBenchmarkCli(relativePath: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), relativePath), ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      // Keep the subprocess guard below Vitest's 30s test timeout while
      // allowing Windows process startup under full-suite CPU contention.
      timeout: 25_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("benchmark report semantics", () => {
  it("keeps Core diagnostics out of public adapter-selection pages", () => {
    const runner = read("test/benchmark/run-native-fairness.mjs");
    const en = read("website/docs/en/benchmark.md");
    const zh = read("website/docs/zh/benchmark.md");

    expect(runner).toContain(': "N/A";');
    expect(runner).toContain("这表示不适用，不是漏测或零成本");
    expect(runner).toContain("suiteVersion: 2");
    expect(runner).toContain("median.samples = samples.map");
    expect(en).not.toContain("Core shows");
    expect(zh).not.toContain("Core 有 `N/A`");
    expect(en).toContain("They should not rank user-facing adapter choices.");
    expect(zh).toContain("因此不应用作用户选型排名。");
  });

  it("describes the actual Normal global middleware telemetry", () => {
    const config = read(
      "test/benchmark/servers/vext-app/src/config/default.mjs",
    );

    expect(config).toContain("唯一保留的全局生命周期节点是 requestHook");
    expect(config).not.toContain("authContext 和 requestHook");
  });

  it("keeps both localized benchmark pages on the current formal delivery path", () => {
    const en = read("website/docs/en/benchmark.md");
    const zh = read("website/docs/zh/benchmark.md");
    const generator = read("test/benchmark/generate-website-results.mjs");
    const siteConfig = read("website/rspress.config.ts");

    for (const page of [en, zh]) {
      expect(page).toContain("--process-priority 0");
      expect(page).toContain("--rounds 7");
      expect(page).toContain("--max-cv 20");
      expect(page).toContain("programmatic API");
      expect(page).not.toContain("--process-priority -14");
    }
    expect(en).toContain("<!-- benchmark-details:start -->");
    expect(zh).toContain("<!-- benchmark-details:start -->");
    expect(en).toContain("## Full formal sample");
    expect(zh).toContain("## 完整正式样本");
    expect(en).toContain("Every measured sample");
    expect(zh).toContain("每一个测量样本");
    expect(en).not.toContain("/benchmark/results.html");
    expect(zh).not.toContain("/zh/benchmark/results.html");
    expect(
      existsSync(
        path.join(process.cwd(), "website/docs/en/benchmark/results.md"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(process.cwd(), "website/docs/zh/benchmark/results.md"),
      ),
    ).toBe(false);
    const enLegacyRedirect = readFileSync(
      path.join(process.cwd(), "website/docs/public/benchmark/results.html"),
      "utf8",
    );
    const zhLegacyRedirect = readFileSync(
      path.join(process.cwd(), "website/docs/public/zh/benchmark/results.html"),
      "utf8",
    );
    expect(enLegacyRedirect).toContain("../benchmark.html#full-formal-sample");
    expect(zhLegacyRedirect).toContain(
      "../benchmark.html#%E5%AE%8C%E6%95%B4%E6%AD%A3%E5%BC%8F%E6%A0%B7%E6%9C%AC",
    );
    expect(siteConfig).toContain('link: "/benchmark.html"');
    expect(en).not.toContain(
      "github.com/devcodex-labs/vextjs/blob/main/test/benchmark/RESULTS.md",
    );
    expect(zh).not.toContain(
      "github.com/devcodex-labs/vextjs/blob/main/test/benchmark/RESULTS.md",
    );
    expect(generator).toContain(
      "Website benchmark results require a clean-source formal artifact",
    );
    expect(generator).toContain("Every measured sample");
    expect(generator).toContain("每一个测量样本");
    expect(generator).toContain("npm run generate:benchmark-docs");
    expect(generator).toContain('routeKey: "GET /users/:id"');
    expect(generator).toContain("return scenario.routeKey;");
    expect(generator).not.toContain("benchmark/results.md");
    expect(generator).not.toContain("--en-output");
    expect(generator).not.toContain("--zh-output");
  });

  it("keeps the public benchmark pages user-facing and single-source", () => {
    const en = read("website/docs/en/benchmark.md");
    const zh = read("website/docs/zh/benchmark.md");

    expect(en).toContain("## At a glance");
    expect(en).toContain("### Test your application");
    expect(zh).toContain("## 先看结论");
    expect(zh).toContain("### 测试真实应用");

    const forbidden = [
      "2026-01-15",
      "98,421",
      "Historical environment",
      "历史数据环境",
      "Cluster mode baseline",
      "Cluster 模式基准",
      "Memory benchmark",
      "内存基准",
      "Startup time",
      "启动时间",
      "dirty worktree",
      "candidate diff",
      "候选差异",
      "private harness",
      "私有 harness",
      "current warehouse",
      "comparative caliber",
    ];

    for (const page of [en, zh]) {
      for (const phrase of forbidden) {
        expect(page).not.toContain(phrase);
      }
    }
  });

  it("keeps benchmark entry points free of stale snapshots and absolute rankings", () => {
    const enHome = read("website/docs/en/index.mdx");
    const zhHome = read("website/docs/zh/index.mdx");
    const relatedPages = [
      enHome,
      zhHome,
      read("website/docs/en/guide/introduction.md"),
      read("website/docs/zh/guide/introduction.md"),
      read("website/docs/en/guide/adapters.md"),
      read("website/docs/zh/guide/adapters.md"),
      read("website/docs/en/guide/configuration.md"),
      read("website/docs/zh/guide/configuration.md"),
      read("website/docs/en/examples/hello-world.md"),
      read("website/docs/zh/examples/hello-world.md"),
      read("website/docs/en/api/config.md"),
      read("website/docs/zh/api/config.md"),
      read("website/docs/en/api/access-log.md"),
      read("website/docs/zh/api/access-log.md"),
      read("website/docs/en/guide/hot-reload.md"),
      read("website/docs/zh/guide/hot-reload.md"),
      read("website/docs/en/guide/deployment.md"),
      read("website/docs/zh/guide/deployment.md"),
      read("website/docs/en/guide/logger.md"),
      read("website/docs/zh/guide/logger.md"),
      read("website/docs/en/guide/database.md"),
      read("website/docs/zh/guide/database.md"),
      read("website/docs/en/guide/plugins.md"),
      read("website/docs/zh/guide/plugins.md"),
      read("website/docs/en/examples/opentelemetry.md"),
      read("website/docs/zh/examples/opentelemetry.md"),
    ];

    expect(enHome).toContain(
      "Understand current results, methodology, and adapter tradeoffs",
    );
    expect(zhHome).toContain("理解当前性能、测试口径与 Adapter 取舍");

    for (const page of relatedPages) {
      for (const stale of [
        "2026-03-23",
        "44,932",
        "45,619",
        "36,819",
        "29,203",
      ]) {
        expect(page).not.toContain(stale);
      }
      for (const absoluteClaim of [
        "性能最高",
        "性能最优",
        "最高性能",
        "highest performance",
        "optimal performance",
        "maximum performance",
        "ultimate performance",
        "业务代码零改动",
        "业务代码无需任何改动",
        "No changes are required to the business code",
        "3-8% RPS",
        "3–8% RPS",
        "zero overhead",
        "零开销",
        "零 overhead",
        "1-10ms",
        "1-10 ms",
        "5-50ms",
        "5-50 ms",
        "1-3s",
        "1-3 s",
        "under 1 second",
        "1 秒以内",
      ]) {
        expect(page).not.toContain(absoluteClaim);
      }
    }
  });

  it("keeps source and public docs free of unsupported fixed performance promises", () => {
    const corpus = [...readTextTree("src"), ...readTextTree("website/docs")];
    const forbiddenPatterns = [
      /3[-–]8%\s*RPS/i,
      /zero[^\r\n]{0,20}overhead/i,
      /零[^\r\n]{0,20}开销/,
      /零\s*overhead/i,
      /1[-–]10\s*ms/i,
      /5[-–]50\s*ms/i,
      /1[-–]3\s*s(?:\b|$)/i,
      /under 1 second/i,
      /1\s*秒以内/,
    ];

    for (const pattern of forbiddenPatterns) {
      const offenders = corpus
        .filter(([, content]) => pattern.test(content))
        .map(([file]) => file);
      expect({ pattern: pattern.source, offenders }).toEqual({
        pattern: pattern.source,
        offenders: [],
      });
    }
  });

  it("keeps custom homepage text from becoming nested Markdown paragraphs", () => {
    const bareMarkdownBlockChild =
      /<(?:p|h[1-6]|span|a|strong|em|code)\b[^>]*>\r?\n[ \t]*[^ \t<{]/;

    for (const page of [
      read("website/docs/en/index.mdx"),
      read("website/docs/zh/index.mdx"),
    ]) {
      expect(page).not.toMatch(bareMarkdownBlockChild);
    }
  });

  it("interleaves targets by round and rejects unstable formal samples", () => {
    const runner = read("test/benchmark/run-native-fairness.mjs");
    const matrixRunner = read("test/benchmark/run-benchmark.mjs");
    const adapterRunner = read("test/benchmark/run-adapter-matrix.mjs");

    expect(runner).toContain('targetScheduling: "round-interleaved-rotating"');
    expect(runner).toContain("rotateTargets(");
    expect(runner).toContain("Benchmark CV gate failed");
    expect(runner).toContain("complete: unstable.length === 0");
    expect(runner).toContain(
      "--from-results-json requires at least one JSON artifact",
    );
    expect(runner).toContain("Incomplete Native fairness matrix");
    expect(runner).toContain(
      "Benchmark artifact dependency versions do not match the current lockfile",
    );
    expect(runner).toContain(
      "Benchmark artifact source provenance does not match the current worktree",
    );
    expect(runner).toContain("processPriority: getProcessPriority()");
    expect(runner).toContain('"NATIVE-FAIRNESS.md"');
    expect(runner).toContain('"native-fairness-latest.json"');
    expect(runner).toContain('suite: "vext-native-fairness-diagnostics"');
    expect(matrixRunner).toContain(
      'targetScheduling: "round-interleaved-alternating"',
    );
    expect(matrixRunner).toContain("const rawFirst =");
    expect(matrixRunner).toContain("Benchmark CV gate failed");
    expect(matrixRunner).toContain("no citable report was generated");
    expect(matrixRunner).toContain("processPriority: getProcessPriority()");
    expect(matrixRunner).toContain("applyChildProcessPriority(");
    expect(matrixRunner).toContain(
      "Benchmark artifact source provenance does not match the current worktree",
    );
    expect(adapterRunner).toContain(
      'targetScheduling: "round-interleaved-rotating"',
    );
    expect(adapterRunner).toContain("assertSameContract(");
    expect(adapterRunner).toContain("assertNormalTelemetry(");
    expect(adapterRunner).toContain("Benchmark CV gate failed");
    expect(adapterRunner).toContain("complete: unstable.length === 0");
    expect(adapterRunner).toContain("Incomplete Vext adapter matrix");
    expect(adapterRunner).toContain("--formal");
    expect(adapterRunner).toContain("assertFormalSource(provenance)");
    expect(adapterRunner).toContain("honoNodeServer");
    expect(adapterRunner).toContain("recordedAt");
  });

  it("keeps generated benchmark artifacts out of candidate provenance", () => {
    const runner = read("test/benchmark/run-native-fairness.mjs");
    const matrixRunner = read("test/benchmark/run-benchmark.mjs");
    const adapterRunner = read("test/benchmark/run-adapter-matrix.mjs");
    const benchmarkReadme = read("test/benchmark/README.md");
    const gitignore = read(".gitignore");

    expect(runner).toContain("generatedArtifactPathspecs");
    expect(runner).toContain(
      "candidateSourceState([options.output, options.resultsJson])",
    );
    expect(matrixRunner).toContain("generatedArtifactPathspecs");
    expect(matrixRunner).toContain(
      "getSourceProvenance([opts.output, opts.resultsJson])",
    );
    expect(matrixRunner).toContain("Unknown benchmark framework");
    expect(matrixRunner).toContain("Unable to read benchmark git provenance");
    expect(matrixRunner).not.toContain("⚠️ 报告保存失败");
    expect(runner).toContain("Unable to read benchmark git status");
    expect(adapterRunner).toContain("GENERATED_REPORT_PATHSPEC");
    expect(adapterRunner).toContain(
      "candidateSourceState([options.output, options.resultsJson])",
    );
    expect(adapterRunner).toContain(
      "Formal benchmark requires a clean source worktree",
    );
    expect(gitignore).toContain("/test/benchmark/.artifacts/");
    expect(benchmarkReadme).toContain("test/benchmark/.artifacts/");
    expect(benchmarkReadme).toContain("NATIVE-FAIRNESS.md");
    expect(benchmarkReadme).not.toContain("./artifacts/");
  });

  it.each([
    [
      "test/benchmark/run-native-fairness.mjs",
      ["--rounds", "0"],
      "Invalid --rounds",
    ],
    [
      "test/benchmark/run-native-fairness.mjs",
      ["--duration", "1junk"],
      "Invalid --duration",
    ],
    ["test/benchmark/run-benchmark.mjs", ["--rounds", "0"], "Invalid --rounds"],
    [
      "test/benchmark/run-benchmark.mjs",
      ["--connections", "50x"],
      "Invalid --connections",
    ],
    [
      "test/benchmark/run-adapter-matrix.mjs",
      ["--rounds", "0"],
      "Invalid --rounds",
    ],
  ])(
    "rejects malformed numeric CLI input before benchmarking (%s %j)",
    (runner, args, expected) => {
      const result = runBenchmarkCli(runner, args);

      expect(result.status).toBe(1);
      expect(result.output).toContain(expected);
    },
  );
});
