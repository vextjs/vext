#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflow = readFileSync(
  path.join(root, ".github", "workflows", "ci.yml"),
  "utf8",
);

function fail(message) {
  console.error(`CI contract verification failed: ${message}`);
  process.exit(1);
}

function jobBlock(jobName) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) fail(`missing job ${jobName}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z0-9][a-z0-9-]*:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function requireTokens(label, content, tokens) {
  for (const token of tokens) {
    if (!content.includes(token)) fail(`${label} is missing ${token}`);
  }
}

requireTokens("lint-typecheck", jobBlock("lint-typecheck"), [
  "fetch-depth: 0",
  "npm run lint",
  "npm run format:check",
  "FORMAT_CHECK_BASE:",
  "github.event.pull_request.base.sha || github.event.before",
  "npm run typecheck",
  "npm run build",
]);

requireTokens("docs-build", jobBlock("docs-build"), [
  "verify-documentation-contract.mjs",
  "npm run build",
  "verify-documentation-contract.mjs --rendered",
]);

requireTokens("package-contracts", jobBlock("package-contracts"), [
  "npm run verify:exports",
  "npm run verify:package-composition",
  "npm run verify:adapters",
]);

requireTokens("windows-node22", jobBlock("windows-node22"), [
  "runs-on: windows-latest",
  "node-version: 22",
  "test/unit/path-boundary.test.ts",
  "test/unit/cli/build-command.test.ts",
  "test/unit/frontend-deploy-validation.test.ts",
  "npm run verify:exports",
]);

requireTokens("CI aggregate", jobBlock("ci-ok"), [
  "name: CI ✅",
  "package-contracts,",
  "windows-node22,",
  "needs.package-contracts.result",
  "needs.windows-node22.result",
]);

console.log("CI workflow contract verified.");
