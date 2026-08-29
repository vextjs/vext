#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { classifyReleaseVersion } from "./release-channel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const finalMode = process.argv.includes("--final");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];
const packageMajor = /^([1-9]\d*)\./u.exec(String(pkg.version))?.[1];
let releaseMetadata;

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function isExactStableVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

try {
  releaseMetadata = classifyReleaseVersion(pkg.version);
} catch (error) {
  failures.push(
    `package version cannot resolve a release channel: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

const schemaVersion = pkg.dependencies?.["schema-dsl"];
const monsqlizeVersion = pkg.dependencies?.monsqlize;
const files = new Set(pkg.files ?? []);
let externalArtifactSha256;

assert(
  pkg.version === "0.3.26" ||
    (packageMajor !== undefined && releaseMetadata !== undefined),
  "source must remain 0.3.26 or use a valid v1+ semantic version",
);
assert(
  typeof schemaVersion === "string" &&
    /^3\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(schemaVersion),
  "schema-dsl must be an exact v3 version",
);
assert(
  typeof monsqlizeVersion === "string" &&
    /^3\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(monsqlizeVersion),
  "monsqlize must be an exact v3+ version",
);
assert(files.has("MIGRATION.md"), "package files must include MIGRATION.md");
assert(existsSync(path.join(root, "MIGRATION.md")), "MIGRATION.md is missing");
assert(
  readFileSync(path.join(root, "changelogs/unreleased.md"), "utf8").includes(
    "schema-dsl v3",
  ),
  "unreleased changelog must describe schema-dsl v3 adaptation",
);
assert(
  pkg.exports?.["."]?.import &&
    pkg.exports?.["."]?.require &&
    pkg.exports?.["."]?.types,
  "root ESM/CJS/types exports are incomplete",
);
assert(pkg.bin?.vext, "vext CLI bin is missing");

if (finalMode) {
  assert(
    packageMajor !== undefined && releaseMetadata !== undefined,
    "final publish requires a valid v1+ stable or prerelease package version",
  );
  assert(
    isExactStableVersion(schemaVersion),
    "final publish requires an exact stable schema-dsl version",
  );
  assert(
    isExactStableVersion(monsqlizeVersion),
    "final publish requires an exact stable monsqlize version",
  );

  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8",
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  const isGithubTag =
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_REF_TYPE === "tag";
  if (isGithubTag) {
    assert(
      process.env.GITHUB_REF_NAME === `v${pkg.version}`,
      `GitHub tag ${process.env.GITHUB_REF_NAME ?? "unknown"} must equal v${pkg.version}`,
    );
    assert(
      process.env.VEXT_RELEASE_CHANNEL === releaseMetadata?.releaseChannel,
      `workflow release channel ${process.env.VEXT_RELEASE_CHANNEL ?? "missing"} must equal ${releaseMetadata?.releaseChannel ?? "invalid"}`,
    );
    assert(
      process.env.VEXT_NPM_DIST_TAG === releaseMetadata?.npmDistTag,
      `workflow npm dist-tag ${process.env.VEXT_NPM_DIST_TAG ?? "missing"} must equal ${releaseMetadata?.npmDistTag ?? "invalid"}`,
    );
    assert(
      process.env.VEXT_GITHUB_PRERELEASE ===
        String(releaseMetadata?.githubPrerelease),
      `workflow GitHub prerelease ${process.env.VEXT_GITHUB_PRERELEASE ?? "missing"} must equal ${String(releaseMetadata?.githubPrerelease)}`,
    );
  } else {
    assert(
      branch.status === 0 && branch.stdout.trim() === "main",
      "local final publish requires branch main",
    );
  }
  assert(
    status.status === 0 && status.stdout.trim() === "",
    "final publish requires a clean worktree",
  );
  assert(
    existsSync(path.join(root, "changelogs", `v${pkg.version}.md`)),
    `final changelog changelogs/v${pkg.version}.md is missing`,
  );

  const externalEvidenceFile = packageMajor
    ? `v${packageMajor}-external-validation.json`
    : "version-scoped-external-validation.json";
  const externalEvidencePath = path.join(root, "release", externalEvidenceFile);
  assert(
    existsSync(externalEvidencePath),
    `release/${externalEvidenceFile} is missing`,
  );
  if (existsSync(externalEvidencePath)) {
    const evidence = JSON.parse(readFileSync(externalEvidencePath, "utf8"));
    externalArtifactSha256 = String(
      evidence.artifactSha256 ?? "",
    ).toLowerCase();
    assert(
      evidence.accepted === true,
      "external consumer evidence must be accepted",
    );
    assert(
      evidence.artifactVersion === pkg.version,
      "external consumer artifactVersion must match package.json",
    );
    assert(
      /^[a-f0-9]{64}$/.test(externalArtifactSha256),
      "external consumer artifactSha256 must be a SHA256 digest",
    );
    assert(
      typeof evidence.consumerRepo === "string" &&
        evidence.consumerRepo.length > 0,
      "external consumer repo identity is missing",
    );
    assert(
      /^[a-f0-9]{40}$/i.test(evidence.consumerCommit ?? ""),
      "external consumer commit must be a full commit SHA",
    );
    assert(
      typeof evidence.runId === "string" && evidence.runId.length > 0,
      "external consumer runId is missing",
    );
  }
}

if (failures.length > 0) {
  console.error(
    `${finalMode ? "Final" : "Source"} release preflight metadata check failed:`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function run(label, command, args, cwd = root, env = {}) {
  console.log(`\n[release:preflight] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = "npm";
const checks = [
  ...(finalMode
    ? [
        [
          "release version channel",
          process.execPath,
          ["scripts/check-version-sync.mjs", "--release"],
        ],
        [
          "release main ancestry",
          process.execPath,
          ["scripts/verify-release-ancestry.mjs"],
        ],
      ]
    : []),
  ["changed-file formatting", npm, ["run", "format:check"]],
  ["lint", npm, ["run", "lint"]],
  ["typecheck", npm, ["run", "typecheck"]],
  ["public type contract tests", npm, ["run", "test:types"]],
  ["ESM/CJS build", npm, ["run", "build"]],
  ["compiled response serializer", npm, ["run", "verify:response-serializer"]],
  ["unit tests", npm, ["run", "test:unit"]],
  ["integration tests", npm, ["run", "test:int"]],
  ["E2E tests", npm, ["run", "test:e2e"]],
  ["coverage", npm, ["run", "test:cov"]],
  ["package composition", npm, ["run", "verify:package-composition"]],
  ["schema-dsl v3 boundary", npm, ["run", "verify:schema-v3"]],
  ["exports and adapter startup", npm, ["run", "test:audit"]],
  ["CLI smoke", process.execPath, ["dist/cli/index.js", "--help"]],
  ["documentation source contract", npm, ["run", "verify:docs-contract"]],
  [
    "production dependency audit",
    npm,
    ["audit", "--omit=dev", "--audit-level=high"],
  ],
];

for (const [label, command, args] of checks) run(label, command, args);

const websiteModules = path.join(root, "website", "node_modules");
if (!existsSync(websiteModules)) {
  run(
    "website dependency install",
    npm,
    ["ci", "--ignore-scripts"],
    path.join(root, "website"),
  );
}
run(
  "website production dependency audit",
  npm,
  ["audit", "--omit=dev", "--audit-level=high"],
  path.join(root, "website"),
);
run("website build", npm, ["run", "build"], path.join(root, "website"));
run("rendered documentation contract", npm, [
  "run",
  "verify:docs-contract",
  "--",
  "--rendered",
]);
run("pack dry-run", npm, ["pack", "--dry-run", "--json", "--ignore-scripts"]);
run(
  "isolated packed install",
  npm,
  ["run", "verify:pack-install"],
  root,
  externalArtifactSha256
    ? { VEXT_EXPECTED_ARTIFACT_SHA256: externalArtifactSha256 }
    : {},
);

console.log(
  `\n${finalMode ? "Final" : "Source"} release preflight passed without publishing.`,
);
