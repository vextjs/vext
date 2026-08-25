#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function classifyReleaseVersion(version) {
  if (typeof version !== "string") {
    throw new TypeError("release version must be a string");
  }
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`invalid semantic version: ${version}`);

  const prerelease = match[4];
  if (
    prerelease
      ?.split(".")
      .some(
        (identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier),
      )
  ) {
    throw new Error(
      `invalid semantic version (numeric prerelease has a leading zero): ${version}`,
    );
  }

  const isPrerelease = prerelease !== undefined;
  return {
    version,
    releaseChannel: isPrerelease ? "next" : "stable",
    npmDistTag: isPrerelease ? "next" : "latest",
    githubPrerelease: isPrerelease,
  };
}

function parseArguments(args) {
  let version;
  let githubOutput;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--version" || argument === "--github-output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--version") version = value;
      else githubOutput = value;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { version, githubOutput, json };
}

function readPackageVersion() {
  return JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
}

export function runReleaseChannel(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    const result = classifyReleaseVersion(
      options.version ?? readPackageVersion(),
    );
    if (options.githubOutput) {
      appendFileSync(
        options.githubOutput,
        [
          `version=${result.version}`,
          `release_channel=${result.releaseChannel}`,
          `npm_dist_tag=${result.npmDistTag}`,
          `github_prerelease=${String(result.githubPrerelease)}`,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`version=${result.version}`);
      console.log(`release_channel=${result.releaseChannel}`);
      console.log(`npm_dist_tag=${result.npmDistTag}`);
      console.log(`github_prerelease=${String(result.githubPrerelease)}`);
    }
    return 0;
  } catch (error) {
    console.error(
      `Release channel resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) process.exitCode = runReleaseChannel();
