#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const prettierExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const all = args.has("--all") || process.env.FORMAT_CHECK_ALL === "1";
// Pin the ignore source to a tracked file so an ignored local
// .prettierignore cannot make local validation weaker than a clean CI clone.
const prettierArgs = [
  write ? "--write" : "--check",
  "--ignore-path",
  ".gitignore",
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extname(file) {
  const idx = file.lastIndexOf(".");
  return idx === -1 ? "" : file.slice(idx).toLowerCase();
}

function unique(files) {
  return [...new Set(files)].filter((file) => {
    if (file.startsWith("test/.tmp-")) return false;
    if (!existsSync(file)) return false;
    return prettierExtensions.has(extname(file));
  });
}

function committedFiles() {
  const explicitBase = process.env.FORMAT_CHECK_BASE?.trim();
  const isCommitSha = /^[a-f0-9]{40}$/iu.test(explicitBase ?? "");
  const isZeroSha = /^0{40}$/u.test(explicitBase ?? "");
  if (isCommitSha && !isZeroSha) {
    try {
      return unique(
        git([
          "diff",
          "--name-only",
          "--diff-filter=ACMR",
          `${explicitBase}...HEAD`,
          "--",
        ]),
      );
    } catch (error) {
      if (process.env.CI === "true") {
        throw new Error(
          `Unable to resolve FORMAT_CHECK_BASE ${explicitBase} in CI`,
          { cause: error },
        );
      }
    }
  }

  try {
    const revision = git(["rev-list", "--parents", "-n", "1", "HEAD"])[0];
    const [, firstParent, secondParent] = revision?.split(/\s+/u) ?? [];
    if (firstParent && secondParent) {
      return unique(
        git([
          "diff",
          "--name-only",
          "--diff-filter=ACMR",
          firstParent,
          "HEAD",
          "--",
        ]),
      );
    }
    return unique(
      git([
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "--diff-filter=ACMR",
        "-r",
        "HEAD",
        "--",
      ]),
    );
  } catch (error) {
    if (process.env.CI === "true") {
      throw new Error("Unable to determine committed files in CI", {
        cause: error,
      });
    }
    return [];
  }
}

function changedFiles() {
  const dirty = unique([
    ...git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (dirty.length > 0) return dirty;
  return committedFiles();
}

const files = all ? ["."] : changedFiles();
if (!all && files.length === 0) {
  console.log("No changed Prettier-supported files to check.");
  process.exit(0);
}

console.log(
  all
    ? "Running full-repository Prettier check."
    : `Running changed-files Prettier ${write ? "write" : "check"} (${files.length} file(s)).`,
);

const command = "npx";
const result = spawnSync(command, ["prettier", ...prettierArgs, ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
