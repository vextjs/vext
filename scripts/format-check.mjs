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

function changedFiles() {
  const dirty = unique([
    ...git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (dirty.length > 0) return dirty;

  try {
    return unique(
      git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
    );
  } catch {
    return [];
  }
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
