import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyReleaseVersion } from "../../scripts/release-channel.mjs";
import { verifyReleaseAncestry } from "../../scripts/verify-release-ancestry.mjs";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function jobBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + name.length + 3;
  const rest = workflow.slice(contentStart);
  const next = rest.search(/^  [a-z0-9][a-z0-9-]*:\s*$/mu);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, contentStart + next);
}

describe("release control contract", () => {
  it("maps stable and prerelease SemVer to one channel tuple", () => {
    expect(classifyReleaseVersion("2.0.0")).toEqual({
      version: "2.0.0",
      releaseChannel: "stable",
      npmDistTag: "latest",
      githubPrerelease: false,
    });
    expect(classifyReleaseVersion("2.1.0-rc.1+build.7")).toEqual({
      version: "2.1.0-rc.1+build.7",
      releaseChannel: "next",
      npmDistTag: "next",
      githubPrerelease: true,
    });
    expect(() => classifyReleaseVersion("2.1.0-01")).toThrow(
      "numeric prerelease has a leading zero",
    );
    expect(() => classifyReleaseVersion("v2.0.0")).toThrow(
      "invalid semantic version",
    );
  });

  it("fails ancestry when the candidate is not contained in origin/main", () => {
    const passStatuses = [0, 0, 0];
    const pass = verifyReleaseAncestry({
      candidate: "candidate",
      upstream: "origin/main",
      runGit: () => ({ status: passStatuses.shift() }),
    });
    expect(pass.ok).toBe(true);

    const failStatuses = [0, 0, 1];
    const fail = verifyReleaseAncestry({
      candidate: "candidate",
      upstream: "origin/main",
      runGit: () => ({ status: failStatuses.shift() }),
    });
    expect(fail).toMatchObject({
      ok: false,
      message: "candidate is not an ancestor of origin/main",
    });
  });

  it("uses the resolved channel and full-history ancestry before publishing", () => {
    const release = read(".github/workflows/release.yml");
    const publish = jobBlock(release, "publish");
    const ancestryIndex = publish.indexOf("npm run verify:release-ancestry");
    const publishIndex = publish.indexOf("npm publish");

    expect(publish).toContain("fetch-depth: 0");
    expect(publish).toContain("scripts/release-channel.mjs");
    expect(publish).toContain("main:refs/remotes/origin/main");
    expect(ancestryIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(ancestryIndex);
    expect(publish).toContain(
      '--tag "${{ steps.release-channel.outputs.npm_dist_tag }}"',
    );
    expect(publish).toContain(
      "steps.release-channel.outputs.github_prerelease == 'true'",
    );
    expect(publish).not.toContain('== *"-"*');

    const preflight = read("scripts/release-preflight.mjs");
    expect(preflight).toContain("import { classifyReleaseVersion }");
    expect(preflight).toContain("scripts/verify-release-ancestry.mjs");
    expect(preflight).toContain("scripts/check-version-sync.mjs");
  });

  it("runs one thresholded coverage script in CI and preflight", () => {
    const ci = read(".github/workflows/ci.yml");
    const coverage = jobBlock(ci, "coverage");
    const preflight = read("scripts/release-preflight.mjs");
    const config = read("vitest.config.ts");

    expect(coverage).toContain("npm run test:cov");
    expect(coverage).not.toContain("npx vitest run --coverage");
    expect(preflight).toContain('["coverage", npm, ["run", "test:cov"]]');
    expect(config).toMatch(/lines:\s*79/u);
    expect(config).toMatch(/statements:\s*78/u);
    expect(config).toMatch(/functions:\s*81/u);
    expect(config).toMatch(/branches:\s*70/u);
    expect(config).toMatch(/autoUpdate:\s*false/u);
  });

  it("documents built-in rate limiting instead of a permanent throttle Map", () => {
    const en = read("website/docs/en/api/plugin-api.md");
    const zh = read("website/docs/zh/api/plugin-api.md");

    for (const document of [en, zh]) {
      expect(document).not.toContain("const store = new Map");
      expect(document).toContain("rateLimit:");
      expect(document).toContain("app.setRateLimiter()");
    }
    expect(en).toContain("process-local");
    expect(en).toContain("shared backend");
    expect(zh).toContain("单进程");
    expect(zh).toContain("共享后端");
  });
});
