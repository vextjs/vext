#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function defaultRunGit(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function verifyReleaseAncestry({
  cwd = projectRoot,
  candidate = process.env.GITHUB_SHA || "HEAD",
  upstream = "origin/main",
  runGit = defaultRunGit,
} = {}) {
  for (const reference of [candidate, upstream]) {
    const resolved = runGit(
      ["rev-parse", "--verify", `${reference}^{commit}`],
      cwd,
    );
    if (resolved.status !== 0) {
      return {
        ok: false,
        candidate,
        upstream,
        message: `cannot resolve release ancestry reference ${reference}`,
      };
    }
  }

  const result = runGit(
    ["merge-base", "--is-ancestor", candidate, upstream],
    cwd,
  );
  if (result.status === 0) {
    return {
      ok: true,
      candidate,
      upstream,
      message: `${candidate} is contained in ${upstream}`,
    };
  }
  return {
    ok: false,
    candidate,
    upstream,
    message:
      result.status === 1
        ? `${candidate} is not an ancestor of ${upstream}`
        : `git merge-base failed while checking ${candidate} against ${upstream}`,
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--candidate" && argument !== "--upstream") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--candidate") options.candidate = value;
    else options.upstream = value;
    index += 1;
  }
  return options;
}

export function runReleaseAncestry(args = process.argv.slice(2)) {
  try {
    const result = verifyReleaseAncestry(parseArguments(args));
    console.log(result.message);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `Release ancestry verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) process.exitCode = runReleaseAncestry();
