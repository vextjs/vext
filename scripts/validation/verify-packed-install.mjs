#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const workspace = path.resolve(
  process.env.VEXT_PREFLIGHT_WORKSPACE ??
    path.join(root, "test", `.tmp-release-preflight-${runId}`),
);
const artifacts = path.join(workspace, "artifacts");
const consumer = path.join(workspace, "consumer");
const npmCache = path.resolve(
  process.env.VEXT_PREFLIGHT_NPM_CACHE ?? path.join(workspace, "npm-cache"),
);
const prepackedVextTarball = process.env.VEXT_PREFLIGHT_VEXT_TARBALL
  ? path.resolve(process.env.VEXT_PREFLIGHT_VEXT_TARBALL)
  : undefined;
const acceptedConsumer = process.env.VEXT_PREFLIGHT_ACCEPTED_CONSUMER
  ? path.resolve(process.env.VEXT_PREFLIGHT_ACCEPTED_CONSUMER)
  : undefined;
const offline = /^(?:1|true)$/i.test(
  process.env.VEXT_PREFLIGHT_OFFLINE ?? "false",
);
const installTimeoutMs = readPositiveInteger(
  process.env.VEXT_PACK_INSTALL_TIMEOUT_MS,
  15 * 60 * 1_000,
  "VEXT_PACK_INSTALL_TIMEOUT_MS",
);
const fetchTimeoutMs = readPositiveInteger(
  process.env.VEXT_PACK_INSTALL_FETCH_TIMEOUT_MS,
  120_000,
  "VEXT_PACK_INSTALL_FETCH_TIMEOUT_MS",
);

mkdirSync(artifacts, { recursive: true });
mkdirSync(consumer, { recursive: true });
mkdirSync(npmCache, { recursive: true });

function readPositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds`);
  }
  return Number(value);
}

function terminateProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The child may have exited between timeout scheduling and termination.
  }
}

function npm(args, options = {}) {
  const capture = options.capture ?? false;
  const timeoutMs = options.timeoutMs;

  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: options.cwd ?? root,
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timeoutHandle;

    const finish = (error, output = "") => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) reject(error);
      else resolve(output);
    };

    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(
          new Error(
            `npm ${args[0]} exceeded ${timeoutMs}ms and its process tree was terminated. ` +
              `Evidence workspace retained at: ${workspace}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `npm ${args[0]} failed with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
          ),
        );
        return;
      }
      finish(null, stdout);
    });

    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
        setTimeout(() => {
          finish(
            new Error(
              `npm ${args[0]} exceeded ${timeoutMs}ms and its process tree was terminated. ` +
                `Evidence workspace retained at: ${workspace}`,
            ),
          );
        }, 2_000).unref();
      }, timeoutMs);
    }
  });
}

async function pack(target) {
  const output = await npm(
    [
      "pack",
      target,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      artifacts,
    ],
    { capture: true },
  );
  const manifest = JSON.parse(output)[0];
  if (!manifest?.filename)
    throw new Error(`npm pack did not return a filename for ${target}`);
  console.log(`${manifest.name}@${manifest.version}: ${manifest.filename}`);
  return path.join(artifacts, manifest.filename);
}

function resolveFileSpec(base, spec, label) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    throw new Error(`${label} must use a file: artifact spec`);
  }
  return path.resolve(base, spec.slice("file:".length));
}

function assertSamePath(actual, expected, label) {
  const normalizeForComparison = (value) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const normalizedActual = normalizeForComparison(actual);
  const normalizedExpected = normalizeForComparison(expected);
  if (normalizedActual !== normalizedExpected) {
    throw new Error(`${label} ${actual} does not match ${expected}`);
  }
}

async function runRuntimeSmokes(consumerRoot) {
  const esmSmoke = [
    "if (Object.getOwnPropertyDescriptor(String.prototype, 'description')) throw new Error('pre-import String pollution');",
    "const vext = await import('vextjs');",
    "await import('monsqlize');",
    "await import('schema-dsl');",
    "if (Object.getOwnPropertyDescriptor(String.prototype, 'description')) throw new Error('post-import String pollution');",
    "const schema = vext.schemaAdapter.compile({ name: 'string!', nickname: 'string?' });",
    "if (!schema.required?.includes('name') || schema.required?.includes('nickname')) throw new Error('required projection mismatch');",
    "console.log('ESM packed smoke passed');",
  ].join(" ");

  const cjsSmoke = [
    "if (Object.getOwnPropertyDescriptor(String.prototype, 'description')) throw new Error('pre-import String pollution');",
    "const vext = require('vextjs');",
    "if (Object.getOwnPropertyDescriptor(String.prototype, 'description')) throw new Error('post-import String pollution');",
    "if (typeof vext.schemaAdapter?.compile !== 'function') throw new Error('schemaAdapter export missing');",
    "console.log('CJS packed smoke passed');",
  ].join(" ");

  for (const args of [
    ["--input-type=module", "-e", esmSmoke],
    ["-e", cjsSmoke],
  ]) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: consumerRoot,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `node packed smoke failed with code ${code ?? "unknown"}`,
            ),
          );
      });
    });
  }
}

async function runPackedTypeContract(consumerRoot) {
  const rootFixturePath = path.join(consumerRoot, "type-contract.mts");
  const rootTsconfigPath = path.join(consumerRoot, "tsconfig.json");
  const rootCjsFixturePath = path.join(consumerRoot, "type-contract.cts");
  const rootCjsTsconfigPath = path.join(consumerRoot, "cjs-tsconfig.json");
  const testingFixturePath = path.join(
    consumerRoot,
    "testing-type-contract.ts",
  );
  const testingTsconfigPath = path.join(consumerRoot, "testing-tsconfig.json");

  writeFileSync(
    rootFixturePath,
    `import type {
  VextConfigOverride,
  VextConfigOverrideAtomicPathRegistry,
} from "vextjs";

declare module "vextjs" {
  interface VextConfig {
    packedPlugin?: {
      retry: { attempts: number; backoff: { minMs: number; maxMs: number } };
      client: { name: string; request(path: string): Promise<unknown> };
    };
  }

  interface VextConfigOverrideAtomicPathRegistry {
    "packedPlugin.client": true;
  }
}

const rootOverride = {
  database: { findLimit: 40, models: { dir: "models" } },
  packedPlugin: { retry: { backoff: { maxMs: 2_000 } } },
} satisfies VextConfigOverride;

const incompleteCacheHub = {
  cache: {
    // @ts-expect-error A Redis branch must retain its mode discriminator.
    cacheHub: { url: "redis://127.0.0.1:6379" },
  },
} satisfies VextConfigOverride;

const incompletePluginClient = {
  packedPlugin: {
    // @ts-expect-error Augmented capability paths remain atomic.
    client: { name: "partial" },
  },
} satisfies VextConfigOverride;

void rootOverride;
void incompleteCacheHub;
void incompletePluginClient;
void (null as unknown as VextConfigOverrideAtomicPathRegistry);
`,
  );
  writeFileSync(
    rootCjsFixturePath,
    `import type {
  VextConfigOverride,
  VextConfigOverrideAtomicPathRegistry,
} from "vextjs";

declare module "vextjs" {
  interface VextConfig {
    packedCjsPlugin?: {
      retry: { attempts: number; backoff: { minMs: number; maxMs: number } };
      client: { name: string; request(path: string): Promise<unknown> };
    };
  }

  interface VextConfigOverrideAtomicPathRegistry {
    "packedCjsPlugin.client": true;
  }
}

const rootCjsOverride = {
  logger: { level: "warn" },
  packedCjsPlugin: { retry: { backoff: { maxMs: 2_000 } } },
} satisfies VextConfigOverride;

const incompleteCjsPluginClient = {
  packedCjsPlugin: {
    // @ts-expect-error CJS declarations preserve augmented atomic capabilities.
    client: { name: "partial" },
  },
} satisfies VextConfigOverride;

void rootCjsOverride;
void incompleteCjsPluginClient;
void (null as unknown as VextConfigOverrideAtomicPathRegistry);
`,
  );
  writeFileSync(
    testingFixturePath,
    `import {
  createTestApp,
  type CreateTestAppOptions,
} from "vextjs/testing";

const testingOverride = {
  config: {
    logger: { level: "silent" },
    response: { hideInternalErrors: true },
  },
  services: false,
} satisfies CreateTestAppOptions;

const incompleteTestingStore = {
  config: {
    session: {
      // @ts-expect-error Testing config uses the same atomic store contract.
      store: { get: () => null },
    },
  },
} satisfies CreateTestAppOptions;

void testingOverride;
void incompleteTestingStore;
void createTestApp;
`,
  );

  const compilerOptions = {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  writeFileSync(
    rootTsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions,
        files: ["type-contract.mts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    rootCjsTsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions,
        files: ["type-contract.cts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    testingTsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions,
        files: ["testing-type-contract.ts"],
      },
      null,
      2,
    )}\n`,
  );

  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const compile = (label, projectPath) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [compiler, "--project", projectPath],
        {
          cwd: consumerRoot,
          stdio: "inherit",
          windowsHide: true,
        },
      );
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `${label} packed TypeScript contract failed with code ${code ?? "unknown"}`,
            ),
          );
      });
    });

  await compile("root ESM", rootTsconfigPath);
  console.log("Root ESM packed TypeScript contract passed.");
  await compile("root CJS", rootCjsTsconfigPath);
  console.log("Root CJS packed TypeScript contract passed.");
  await compile("testing", testingTsconfigPath);
  console.log("Testing packed TypeScript contract passed.");
}

async function verifyAcceptedConsumer(vextTarball) {
  if (!existsSync(acceptedConsumer)) {
    throw new Error(
      `VEXT_PREFLIGHT_ACCEPTED_CONSUMER does not exist: ${acceptedConsumer}`,
    );
  }
  const consumerPackage = JSON.parse(
    readFileSync(path.join(acceptedConsumer, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(path.join(acceptedConsumer, "package-lock.json"), "utf8"),
  );
  const installedPackage = JSON.parse(
    readFileSync(
      path.join(acceptedConsumer, "node_modules", "vextjs", "package.json"),
      "utf8",
    ),
  );
  const lockEntry = lock.packages?.["node_modules/vextjs"];
  if (!lockEntry) throw new Error("accepted consumer lock lacks vextjs entry");

  assertSamePath(
    resolveFileSpec(
      acceptedConsumer,
      consumerPackage.dependencies?.vextjs,
      "accepted consumer vextjs dependency",
    ),
    vextTarball,
    "accepted consumer artifact",
  );
  assertSamePath(
    resolveFileSpec(
      acceptedConsumer,
      lockEntry.resolved,
      "accepted consumer lock resolution",
    ),
    vextTarball,
    "accepted consumer locked artifact",
  );
  const expectedIntegrity = `sha512-${createHash("sha512")
    .update(readFileSync(vextTarball))
    .digest("base64")}`;
  if (lockEntry.integrity !== expectedIntegrity) {
    throw new Error("accepted consumer lock integrity does not match artifact");
  }
  if (
    lockEntry.version !== pkg.version ||
    installedPackage.version !== pkg.version
  ) {
    throw new Error("accepted consumer vextjs version does not match source");
  }

  await npm(["ls", "vextjs", "monsqlize", "schema-dsl", "--all"], {
    cwd: acceptedConsumer,
  });
  if (consumerPackage.scripts?.typecheck) {
    await npm(["run", "typecheck"], { cwd: acceptedConsumer });
  }
  await runRuntimeSmokes(acceptedConsumer);
  console.log(`Accepted packed consumer verified: ${acceptedConsumer}`);
}

async function main() {
  if (prepackedVextTarball && !existsSync(prepackedVextTarball)) {
    throw new Error(
      `VEXT_PREFLIGHT_VEXT_TARBALL does not exist: ${prepackedVextTarball}`,
    );
  }
  if (acceptedConsumer && !prepackedVextTarball) {
    throw new Error(
      "VEXT_PREFLIGHT_ACCEPTED_CONSUMER requires VEXT_PREFLIGHT_VEXT_TARBALL",
    );
  }
  const vextTarball = prepackedVextTarball ?? (await pack(root));
  if (prepackedVextTarball) {
    console.log(`Reusing accepted vextjs tarball: ${vextTarball}`);
  }
  const vextSha256 = createHash("sha256")
    .update(readFileSync(vextTarball))
    .digest("hex");
  const expectedSha256 =
    process.env.VEXT_EXPECTED_ARTIFACT_SHA256?.toLowerCase();
  if (expectedSha256 && vextSha256 !== expectedSha256) {
    throw new Error(
      `Packed vextjs SHA256 ${vextSha256} does not match external validation ${expectedSha256}`,
    );
  }
  console.log(`vextjs tarball SHA256: ${vextSha256}`);

  if (acceptedConsumer) {
    await verifyAcceptedConsumer(vextTarball);
    console.log(`Packed install verified for vextjs@${pkg.version}`);
    return;
  }

  const schemaTarball = await pack(
    path.join(root, "node_modules", "schema-dsl"),
  );
  const monsqlizeTarball = await pack(
    path.join(root, "node_modules", "monsqlize"),
  );

  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "vext-packed-install-smoke", private: true, type: "module" }, null, 2)}\n`,
  );

  console.log(`Packed install cache: ${npmCache}`);
  console.log(`Packed install offline: ${offline}`);
  console.log(`Packed install timeout: ${installTimeoutMs}ms`);
  const installArgs = [
    "install",
    "--ignore-scripts",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    ...(offline ? ["--offline"] : []),
    `--cache=${npmCache}`,
    "--fetch-retries=0",
    `--fetch-timeout=${fetchTimeoutMs}`,
    schemaTarball,
    monsqlizeTarball,
    vextTarball,
  ];
  await npm(installArgs, { cwd: consumer, timeoutMs: installTimeoutMs });
  await npm(["ls", "vextjs", "monsqlize", "schema-dsl", "--all"], {
    cwd: consumer,
  });
  await runPackedTypeContract(consumer);
  await runRuntimeSmokes(consumer);

  console.log(`Packed install verified for vextjs@${pkg.version}`);
  console.log(`Evidence workspace retained at: ${workspace}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
