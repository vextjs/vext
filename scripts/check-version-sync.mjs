#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyReleaseVersion } from "./release-channel.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");

function addCheck(checks, ok, description, detail) {
  checks.push({ ok, description, ...(detail ? { detail } : {}) });
}

function classifyOrUndefined(value) {
  try {
    return classifyReleaseVersion(value);
  } catch {
    return undefined;
  }
}

export function validateVersionContract(input) {
  const checks = [];
  const { packageVersion, lockVersion, lockRootVersion, channels, files } =
    input;
  const stable = channels?.stable;
  const next = channels?.next;
  const channel = channels?.channel;
  const packageRelease = classifyOrUndefined(packageVersion);
  const stableRelease = classifyOrUndefined(stable);
  const nextRelease = classifyOrUndefined(next);

  addCheck(
    checks,
    packageRelease !== undefined,
    "package.json exposes a valid semantic version",
    packageVersion,
  );
  addCheck(
    checks,
    lockVersion === packageVersion && lockRootVersion === packageVersion,
    "package-lock.json matches package.json",
    `top=${lockVersion ?? "missing"}, root=${lockRootVersion ?? "missing"}`,
  );
  addCheck(
    checks,
    stableRelease?.releaseChannel === "stable",
    "website stable channel is a valid stable semantic version",
    String(stable ?? "missing"),
  );
  addCheck(
    checks,
    nextRelease !== undefined,
    "website next channel is a valid semantic version",
    String(next ?? "missing"),
  );
  addCheck(
    checks,
    next === packageVersion,
    "website next channel matches the source candidate",
    `next=${next ?? "missing"}, package=${packageVersion}`,
  );

  const expectedChannel = input.release
    ? packageRelease?.releaseChannel
    : stable === next
      ? "stable"
      : "next";
  addCheck(
    checks,
    expectedChannel !== undefined && channel === expectedChannel,
    "website channel label matches stable/next state",
    `channel=${channel ?? "missing"}, expected=${expectedChannel ?? "invalid package version"}`,
  );

  if (input.release && packageRelease?.releaseChannel === "stable") {
    addCheck(
      checks,
      stable === packageVersion,
      "release requires the public stable version to match package.json",
      `stable=${stable ?? "missing"}, package=${packageVersion}`,
    );
    addCheck(
      checks,
      channel === "stable",
      "release requires website channel=stable",
      `channel=${channel ?? "missing"}`,
    );
  } else if (input.release && packageRelease?.releaseChannel === "next") {
    addCheck(
      checks,
      channel === "next",
      "prerelease requires website channel=next",
      `channel=${channel ?? "missing"}`,
    );
  }

  const rspress = files?.rspress;
  addCheck(
    checks,
    typeof rspress === "string" &&
      rspress.includes('from "./version-channels.json"') &&
      rspress.includes("docsVersions.next") &&
      rspress.includes("docsVersions.stable") &&
      rspress.includes("docsVersions.channel"),
    "Rspress navigation consumes the version channel declaration",
  );

  for (const locale of ["en", "zh"]) {
    const cli = files?.cli?.[locale];
    addCheck(
      checks,
      typeof cli === "string" &&
        cli.includes(`vextjs v${stable}`) &&
        cli.includes(`v${next}`),
      `${locale} CLI page identifies stable output and the next docs version`,
    );

    const quickStart = files?.quickStart?.[locale];
    addCheck(
      checks,
      typeof quickStart === "string" &&
        quickStart.includes(`"vextjs": "^${stable}"`) &&
        quickStart.includes(`v${stable}`) &&
        quickStart.includes(`v${next}`),
      `${locale} Quick Start uses stable while identifying the next docs version`,
    );
  }

  const readme = files?.readme;
  addCheck(
    checks,
    typeof readme === "string" &&
      !/"vextjs"\s*:\s*"\^\d+\.\d+\.\d+"/u.test(readme),
    "README keeps a version-agnostic package entry",
  );

  return {
    checks,
    errors: checks.filter((check) => !check.ok),
  };
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function readText(projectRoot, relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

export function readVersionContract(
  projectRoot = defaultProjectRoot,
  release = false,
) {
  const packageJson = readJson(projectRoot, "package.json");
  const packageLock = readJson(projectRoot, "package-lock.json");
  return {
    packageVersion: packageJson.version,
    lockVersion: packageLock.version,
    lockRootVersion: packageLock.packages?.[""]?.version,
    channels: readJson(projectRoot, "website/version-channels.json"),
    release,
    files: {
      rspress: readText(projectRoot, "website/rspress.config.ts"),
      readme: readText(projectRoot, "README.md"),
      cli: Object.fromEntries(
        ["en", "zh"].map((locale) => [
          locale,
          readText(projectRoot, `website/docs/${locale}/guide/cli.md`),
        ]),
      ),
      quickStart: Object.fromEntries(
        ["en", "zh"].map((locale) => [
          locale,
          readText(projectRoot, `website/docs/${locale}/guide/quick-start.md`),
        ]),
      ),
    },
  };
}

export function runVersionCheck(args = process.argv.slice(2)) {
  const unknown = args.filter((arg) => arg !== "--release");
  if (unknown.length > 0) {
    console.error(`ERROR: unknown argument(s): ${unknown.join(", ")}`);
    return 1;
  }

  const input = readVersionContract(
    defaultProjectRoot,
    args.includes("--release"),
  );
  const result = validateVersionContract(input);
  console.log(
    `Version contract mode: ${input.release ? "release" : "development"}`,
  );
  console.log(`Source candidate: v${input.packageVersion}`);
  console.log(`Published stable: v${input.channels.stable}`);
  console.log(`Docs next:       v${input.channels.next}`);
  console.log(
    `Release channel: ${classifyOrUndefined(input.packageVersion)?.releaseChannel ?? "invalid"}`,
  );
  console.log("──────────────────────────────────────────");
  for (const check of result.checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"} ${check.description}`);
    if (!check.ok && check.detail) console.log(`     ${check.detail}`);
  }
  console.log("──────────────────────────────────────────");

  if (result.errors.length > 0) {
    console.error(`ERROR: ${result.errors.length} version contract error(s).`);
    return 1;
  }

  console.log(
    `OK: version channels are consistent (stable v${input.channels.stable}, next v${input.channels.next}).`,
  );
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) process.exitCode = runVersionCheck();
