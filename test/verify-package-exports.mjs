import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  assertNoBundledRuntimeDependencies,
  runtimeDependencyNames,
} from "../scripts/validation/verify-package-composition.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...parts) =>
  pathToFileURL(path.join(root, "dist", ...parts)).href;
const packageJson = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);

const cjsEntrypoints = [
  "vextjs",
  "vextjs/testing",
  "vextjs/frontend",
  "vextjs/style",
  "vextjs/adapters/hono",
  "vextjs/adapters/fastify",
  "vextjs/adapters/express",
  "vextjs/adapters/koa",
  "vextjs/adapters/native",
];
const esmEntrypoints = [
  dist("index.js"),
  dist("testing", "index.js"),
  dist("frontend", "index.js"),
  dist("frontend", "style", "index.js"),
  dist("adapters", "hono", "index.js"),
  dist("adapters", "fastify", "index.js"),
  dist("adapters", "express", "index.js"),
  dist("adapters", "koa", "index.js"),
  dist("adapters", "native", "index.js"),
];
const namedExports = {
  vextjs: [
    "auth",
    "createAuthContextMiddleware",
    "createAuthMiddleware",
    "createCacheSessionStore",
    "createCsrfMiddleware",
    "createSecurityHeadersMiddleware",
    "csrf",
    "securityHeaders",
  ],
  "vextjs/frontend": [
    "Form",
    "Image",
    "Link",
    "VextApiError",
    "createVextApiClient",
    "defineFont",
    "defineFrontendAdapter",
    "defineImageLoader",
    "isVextApiError",
    "navigate",
    "prefetch",
    "revalidate",
    "useFetcher",
    "useNavigation",
    "useRouteData",
  ],
  "vextjs/style": [
    "createVar",
    "globalStyle",
    "recipe",
    "setVar",
    "style",
    "vars",
  ],
  "vextjs/adapters/hono": ["createHonoAdapter", "honoAdapter"],
  "vextjs/adapters/fastify": ["createFastifyAdapter", "fastifyAdapter"],
  "vextjs/adapters/express": ["createExpressAdapter", "expressAdapter"],
  "vextjs/adapters/koa": ["createKoaAdapter", "koaAdapter"],
  "vextjs/adapters/native": ["createNativeAdapter", "nativeAdapter"],
};
const esmNamedExports = new Map([
  [dist("index.js"), namedExports.vextjs],
  [dist("frontend", "index.js"), namedExports["vextjs/frontend"]],
  [dist("frontend", "style", "index.js"), namedExports["vextjs/style"]],
  [dist("adapters", "hono", "index.js"), namedExports["vextjs/adapters/hono"]],
  [
    dist("adapters", "fastify", "index.js"),
    namedExports["vextjs/adapters/fastify"],
  ],
  [
    dist("adapters", "express", "index.js"),
    namedExports["vextjs/adapters/express"],
  ],
  [dist("adapters", "koa", "index.js"), namedExports["vextjs/adapters/koa"]],
  [
    dist("adapters", "native", "index.js"),
    namedExports["vextjs/adapters/native"],
  ],
]);
const cjsOutputFiles = [
  path.join(root, "dist", "index.cjs"),
  path.join(root, "dist", "testing", "index.cjs"),
  path.join(root, "dist", "frontend", "index.cjs"),
  path.join(root, "dist", "frontend", "style", "index.cjs"),
  path.join(root, "dist", "adapters", "hono", "index.cjs"),
  path.join(root, "dist", "adapters", "fastify", "index.cjs"),
  path.join(root, "dist", "adapters", "express", "index.cjs"),
  path.join(root, "dist", "adapters", "koa", "index.cjs"),
  path.join(root, "dist", "adapters", "native", "index.cjs"),
];
const forbiddenBundledRuntimeModules = [
  "response-cache-kit",
  "cache-hub",
  "pino",
  "pino-pretty",
];

for (const entry of cjsEntrypoints) {
  const mod = require(entry);
  if (!mod || typeof mod !== "object")
    throw new Error(`CJS export did not load: ${entry}`);
  assert.strictEqual(
    require(entry),
    mod,
    `CJS repeat identity changed: ${entry}`,
  );
  for (const name of namedExports[entry] ?? []) {
    if (!(name in mod)) throw new Error(`CJS export missing ${name}: ${entry}`);
  }
}

const cjsRoot = require("vextjs");
const cjsTesting = require("vextjs/testing");
const cjsTestApp = await cjsTesting.createTestApp({
  services: false,
  routes: false,
  middlewares: false,
  plugins: false,
});
try {
  let thrown;
  try {
    cjsTestApp.app.throw(418, "teapot");
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown instanceof cjsRoot.HttpError,
    "CJS root must recognize HttpError created through vextjs/testing",
  );
  assert.ok(
    cjsRoot.getLoggerLifecycle(cjsTestApp.app.logger),
    "CJS root must read logger lifecycle created through vextjs/testing",
  );
} finally {
  await cjsTestApp.close();
}

const packageTargets = Object.values(packageJson.exports).flatMap(
  (conditions) => Object.values(conditions),
);
assert.equal(
  packageTargets.length,
  27,
  "package exports must expose 27 targets",
);
for (const target of packageTargets) {
  assert.ok(
    existsSync(path.join(root, target.replace(/^\.\//, ""))),
    `package export target is missing: ${target}`,
  );
}
assert.ok(
  existsSync(path.join(root, packageJson.bin.vext)),
  `CLI target is missing: ${packageJson.bin.vext}`,
);

const runtimePackages = runtimeDependencyNames(packageJson);
for (const dependency of [
  ...Object.keys(packageJson.dependencies),
  ...Object.keys(packageJson.peerDependencies),
  "mongodb-memory-server-core",
]) {
  assert.ok(
    runtimePackages.includes(dependency),
    `external is missing: ${dependency}`,
  );
}
assert.doesNotThrow(() =>
  assertNoBundledRuntimeDependencies(
    { inputs: { "src/index.ts": {}, "node_modules/vitest/index.js": {} } },
    runtimePackages,
    "synthetic safe bundle",
  ),
);
assert.throws(
  () =>
    assertNoBundledRuntimeDependencies(
      {
        inputs: {
          "src/index.ts": {},
          "node_modules/react/index.js": {},
          "node_modules/.pnpm/react-dom@19.2.7/node_modules/react-dom/index.js":
            {},
        },
      },
      runtimePackages,
      "synthetic invalid bundle",
    ),
  /react, react-dom|react-dom, react/,
);

const docsDeclaration = path.join(
  root,
  "dist/lib/docs/renderers/vext-assets.d.ts",
);
const docsDeclarationText = readFileSync(docsDeclaration, "utf8");
assert.ok(
  statSync(docsDeclaration).size < 1024,
  "Docs declaration exceeds 1 KiB",
);
assert.match(docsDeclarationText, /VEXT_DOCS_STYLE_CSS: string/);
assert.match(docsDeclarationText, /VEXT_DOCS_APP_JS: string/);
assert.doesNotMatch(
  docsDeclarationText,
  /color-scheme|document\.getElementById/,
);
for (const entry of esmEntrypoints) {
  const mod = await import(entry);
  if (!mod || typeof mod !== "object")
    throw new Error(`ESM export did not load: ${entry}`);
  for (const name of esmNamedExports.get(entry) ?? []) {
    if (!(name in mod)) throw new Error(`ESM export missing ${name}: ${entry}`);
  }
}
for (const file of cjsOutputFiles) {
  const content = readFileSync(file, "utf8");
  for (const moduleName of forbiddenBundledRuntimeModules) {
    if (content.includes(`node_modules/${moduleName}`)) {
      throw new Error(
        `CJS bundle unexpectedly inlined ${moduleName}: ${path.relative(root, file)}`,
      );
    }
  }
}
console.log("package exports verified");
