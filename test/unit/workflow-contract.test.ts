import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return readFileSync(
    path.join(process.cwd(), ".github", "workflows", name),
    "utf8",
  );
}

describe("main CI and deployment workflow contract", () => {
  it("runs push CI on main while retaining pull requests to main", () => {
    const ci = workflow("ci.yml");
    expect(ci).toMatch(/push:\s*\n\s+branches: \[main\]/u);
    expect(ci).toMatch(/pull_request:\s*\n\s+branches: \[main\]/u);
    expect(ci).not.toContain('branches: ["*"]');
    expect(ci).toContain("bash scripts/check-version-sync.sh");
  });

  it("requires the coverage job on pull requests as well as main pushes", () => {
    const ci = workflow("ci.yml");
    const coverageJob = ci.match(
      /^  coverage:\s*$([\s\S]*?)(?=^  [a-z][a-z-]+:\s*$)/mu,
    )?.[1];

    expect(coverageJob).toBeDefined();
    expect(coverageJob).not.toMatch(/if:\s*github\.event_name == 'push'/u);
    expect(ci).toMatch(/needs:[\s\S]*coverage,[\s\S]*docs-build,/u);
    expect(ci).toContain("${{ needs.coverage.result }}");
  });

  it("keeps exact public-version validation in the tag release", () => {
    expect(workflow("release.yml")).toContain(
      "bash scripts/check-version-sync.sh --release",
    );
  });

  it("deploys only the exact successful main push CI commit", () => {
    const docs = workflow("docs.yml");
    expect(docs).toContain("workflow_run:");
    expect(docs).toContain("workflows: [CI]");
    expect(docs).toContain("types: [completed]");
    expect(docs).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(docs).toContain("github.event.workflow_run.event == 'push'");
    expect(docs).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(docs).toContain("github.event.workflow_run.head_sha || github.sha");
    expect(docs).toContain("ref: ${{ env.DEPLOY_SHA }}");
    expect(docs).not.toMatch(/^\s{2}push:/mu);
  });
});
