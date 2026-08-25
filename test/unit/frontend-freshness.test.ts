import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouteFreshnessIdentity } from "../../src/frontend/contract/schema-ir.js";
import {
  VextFrontendFreshnessStore,
  createFreshnessKeyDigest,
} from "../../src/frontend/runtime/freshness.js";

const fsyncFault = vi.hoisted(() => ({ failPointerDirectory: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(filePath: any, flags: any, mode?: any) {
      const handle = await actual.open(filePath, flags, mode);
      const normalized = String(filePath).replaceAll("\\", "/");
      const isFreshnessDirectory =
        flags === "r" &&
        (normalized.endsWith("/entries") || normalized.endsWith("/pointers"));
      if (!isFreshnessDirectory) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              if (
                fsyncFault.failPointerDirectory &&
                normalized.endsWith("/pointers")
              ) {
                throw Object.assign(
                  new Error("pointer directory fsync failed"),
                  {
                    code: "EIO",
                  },
                );
              }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  fsyncFault.failPointerDirectory = false;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RouteOptions.frontend freshness identity", () => {
  it("keeps unconfigured routes byte-for-byte compatible with legacy dynamic identity", () => {
    expect(createRouteFreshnessIdentity()).toEqual({
      mode: "dynamic",
      source: "legacy-default",
    });
  });

  it("normalizes static parameters, tags, and bounded budgets from the existing route option", () => {
    expect(
      createRouteFreshnessIdentity({
        frontend: {
          mode: "static",
          staticParams: [{ slug: "hello", page: 2, preview: false }],
          tags: ["news", "news", "home"],
          page: "posts/detail",
          clientOnly: true,
          staticBudget: { maxParams: 4, maxBytes: 8_192 },
        },
      }),
    ).toEqual({
      mode: "static",
      source: "route-options",
      staticParams: [{ page: "2", preview: "false", slug: "hello" }],
      tags: ["home", "news"],
      page: "posts/detail",
      clientOnly: true,
      staticBudget: { maxParams: 4, maxBytes: 8_192 },
    });
  });

  it("rejects contradictory static/revalidate declarations before server startup", () => {
    expect(() =>
      createRouteFreshnessIdentity({
        frontend: { mode: "static", revalidate: 5 },
      }),
    ).toThrow("revalidate is only valid");
    expect(() =>
      createRouteFreshnessIdentity({
        frontend: { mode: "revalidate", revalidate: 1, staticParams: [{}] },
      }),
    ).toThrow("staticParams is only valid");
  });

  it("includes no-hydration and normalized SEO in route identity without changing the legacy default", () => {
    expect(
      createRouteFreshnessIdentity({
        frontend: {
          hydration: "none",
          seo: {
            title: "  Article  ",
            canonical: "/posts/hello",
            originKey: "docs",
            robots: ["index", "follow"],
          },
        },
      }),
    ).toEqual({
      mode: "dynamic",
      source: "route-options",
      hydration: "none",
      seo: {
        title: "Article",
        robots: ["index", "follow"],
        canonical: "/posts/hello",
        originKey: "docs",
      },
    });

    expect(() =>
      createRouteFreshnessIdentity({
        frontend: { hydration: "none", clientOnly: true },
      }),
    ).toThrow("cannot be combined with clientOnly");
    expect(() =>
      createRouteFreshnessIdentity({
        frontend: { seo: { canonical: "https://example.com/post" } },
      }),
    ).toThrow("absolute pathname");
  });
});

describe("VextFrontendFreshnessStore", () => {
  it("persists fresh and stale last-known-good entries across store instances", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir);
    const key = createKey("build-a");
    await store.write({
      key,
      tags: ["news"],
      response: response("first"),
    });

    await expect(store.read(key)).resolves.toMatchObject({
      state: "fresh",
      entry: { response: { payload: "first" } },
    });
    await expect(
      new VextFrontendFreshnessStore(rootDir).read(key),
    ).resolves.toMatchObject({
      state: "fresh",
      entry: { keyDigest: createFreshnessKeyDigest(key) },
    });

    await store.write({
      key,
      tags: ["news"],
      ttlMs: 0,
      response: response("replacement"),
    });
    await expect(store.read(key)).resolves.toMatchObject({
      state: "stale",
      entry: { response: { payload: "replacement" } },
    });
  });

  it("rejects non-finite or negative freshness TTL values", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir);
    const key = createKey("build-invalid-ttl");

    for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(
        store.write({
          key,
          tags: ["ttl"],
          ttlMs,
          response: response("invalid"),
        }),
      ).rejects.toThrow("ttlMs must be a finite non-negative number");
    }
    expect(await entryFiles(store)).toEqual([]);
  });

  it("deduplicates concurrent producers and reports observable invalidation results", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir);
    const key = createKey("build-b");
    let executions = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.singleFlight(key, async () => {
          executions += 1;
          await Promise.resolve();
          return store.write({
            key,
            tags: ["posts"],
            response: response("single-flight"),
          });
        }),
      ),
    );

    expect(executions).toBe(1);
    expect(results.filter((result) => result.leader)).toHaveLength(1);
    const invalidation = await store.invalidate({ tag: "posts" });
    expect(invalidation).toEqual({
      matched: [createFreshnessKeyDigest(key)],
      removed: [createFreshnessKeyDigest(key)],
    });
    await expect(store.read(key)).resolves.toEqual({ state: "miss" });
  });

  it("requires a scoped invalidation selector", async () => {
    const store = new VextFrontendFreshnessStore(await tempRoot());
    await expect(store.invalidate({})).rejects.toThrow(
      "invalidation requires route, path, tag, key, locale, or partition",
    );
  });

  it("serializes same-key writes and converges old generations with bounded GC", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 1_000,
      gcScanLimit: 2,
    });
    const key = createKey("build-serialized");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.write({
          key,
          tags: ["serialized"],
          response: response(`generation-${index}`),
        }),
      ),
    );
    const currentPointer = await readPointerFile(store, key);
    const old = new Date(Date.now() - 120_000);
    for (const name of await entryFiles(store)) {
      if (name !== currentPointer.entryFile) {
        await utimes(path.join(store.rootPath, "entries", name), old, old);
      }
    }
    for (let index = 0; index < 8; index += 1) {
      await store.read(key);
    }

    await expect(store.read(key)).resolves.toMatchObject({ state: "fresh" });
    expect(await entryFiles(store)).toHaveLength(1);
  });

  it("serializes same-key writes across store instances in one process", async () => {
    const rootDir = await tempRoot();
    const first = new VextFrontendFreshnessStore(rootDir);
    const second = new VextFrontendFreshnessStore(rootDir);
    const key = createKey("build-multi-store");

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).write({
          key,
          tags: ["multi-store"],
          response: response(`generation-${index}`),
        }),
      ),
    );

    await expect(first.read(key)).resolves.toMatchObject({ state: "fresh" });
    await expect(second.read(key)).resolves.toMatchObject({ state: "fresh" });
  });

  it("retries the pointer once when a reader races a writer generation swap", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 60_000,
    });
    const key = createKey("build-reader-race");
    await store.write({
      key,
      tags: ["race"],
      response: response("old"),
    });
    const oldPointer = await readPointerFile(store, key);

    const mutableStore = store as unknown as {
      readPointer(keyDigest: string): Promise<unknown>;
    };
    const originalReadPointer = mutableStore.readPointer.bind(store);
    let pointerReads = 0;
    let markPointerCaptured!: () => void;
    let releaseReader!: () => void;
    const pointerCaptured = new Promise<void>((resolve) => {
      markPointerCaptured = resolve;
    });
    const readerBarrier = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    mutableStore.readPointer = async (keyDigest) => {
      const pointer = await originalReadPointer(keyDigest);
      pointerReads += 1;
      if (pointerReads === 1) {
        markPointerCaptured();
        await readerBarrier;
      }
      return pointer;
    };

    const pendingRead = store.read(key);
    await pointerCaptured;
    await store.write({
      key,
      tags: ["race"],
      response: response("replacement"),
    });
    await rm(path.join(store.rootPath, "entries", oldPointer.entryFile));
    releaseReader();

    await expect(pendingRead).resolves.toMatchObject({
      state: "fresh",
      entry: { response: { payload: "replacement" } },
    });
    expect(pointerReads).toBeGreaterThanOrEqual(3);
  });

  it("removes a newly written entry when pointer commit fails", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir);
    const key = createKey("build-pointer-failure");
    const digest = createFreshnessKeyDigest(key);
    await mkdir(path.join(store.rootPath, "pointers", `${digest}.json`), {
      recursive: true,
    });

    await expect(
      store.write({
        key,
        tags: ["failure"],
        response: response("uncommitted"),
      }),
    ).rejects.toBeDefined();

    expect(await entryFiles(store)).toEqual([]);
  });

  it("keeps the committed pointer target readable when directory fsync fails", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!;
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });
    try {
      const rootDir = await tempRoot();
      const store = new VextFrontendFreshnessStore(rootDir);
      const key = createKey("build-pointer-fsync-failure");
      await store.write({
        key,
        tags: ["fsync"],
        response: response("old"),
      });

      fsyncFault.failPointerDirectory = true;
      await expect(
        store.write({
          key,
          tags: ["fsync"],
          response: response("replacement"),
        }),
      ).rejects.toThrow("pointer directory fsync failed");
      fsyncFault.failPointerDirectory = false;

      await expect(store.read(key)).resolves.toMatchObject({
        state: "fresh",
        entry: { keyDigest: createFreshnessKeyDigest(key) },
      });
    } finally {
      fsyncFault.failPointerDirectory = false;
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("keeps invalidated entries for a grace window then reclaims them", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 60_000,
      gcScanLimit: 8,
    });
    const key = createKey("build-invalidate-grace");
    await store.write({
      key,
      tags: ["invalidate"],
      response: response("old"),
    });
    const pointer = await readPointerFile(store, key);
    const entryPath = path.join(store.rootPath, "entries", pointer.entryFile);
    const old = new Date(Date.now() - 120_000);
    await utimes(entryPath, old, old);

    await expect(store.invalidate({ tag: "invalidate" })).resolves.toEqual({
      matched: [createFreshnessKeyDigest(key)],
      removed: [createFreshnessKeyDigest(key)],
    });
    expect(await entryFiles(store)).toEqual([pointer.entryFile]);

    await utimes(entryPath, old, old);
    await store.read(key);
    expect(await entryFiles(store)).toEqual([]);
  });

  it("resumes bounded mark-and-sweep across restart and removes abandoned temp files", async () => {
    const rootDir = await tempRoot();
    const key = createKey("build-restart-gc");
    const writer = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 60_000,
    });
    for (let index = 0; index < 6; index += 1) {
      await writer.write({
        key,
        tags: ["restart"],
        response: response(`generation-${index}`),
      });
    }
    const entriesDir = path.join(writer.rootPath, "entries");
    const pointersDir = path.join(writer.rootPath, "pointers");
    const abandonedEntryTemp = path.join(entriesDir, "abandoned-entry.tmp");
    const abandonedPointerTemp = path.join(
      pointersDir,
      "abandoned-pointer.tmp",
    );
    await writeFile(abandonedEntryTemp, "partial");
    await writeFile(abandonedPointerTemp, "partial");
    const old = new Date(Date.now() - 120_000);
    for (const name of await readdir(entriesDir)) {
      await utimes(path.join(entriesDir, name), old, old);
    }
    await utimes(abandonedPointerTemp, old, old);

    const restarted = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 1_000,
      gcScanLimit: 2,
    });
    for (let index = 0; index < 12; index += 1) {
      await restarted.read(key);
    }

    expect(await entryFiles(restarted)).toHaveLength(1);
    expect(await readdir(pointersDir)).not.toContain("abandoned-pointer.tmp");
  });

  it("bounds pointer marking work to the configured GC candidate batch", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 60_000,
      gcScanLimit: 2,
    });
    for (let index = 0; index < 10; index += 1) {
      await store.write({
        key: createKey(`build-bounded-mark-${index}`),
        tags: ["bounded-mark"],
        response: response(`entry-${index}`),
      });
    }

    const mutableStore = store as unknown as {
      readPointer(keyDigest: string): Promise<unknown>;
    };
    const originalReadPointer = mutableStore.readPointer.bind(store);
    let pointerReads = 0;
    mutableStore.readPointer = async (keyDigest) => {
      pointerReads += 1;
      return originalReadPointer(keyDigest);
    };

    await store.read(createKey("missing-bounded-mark"));

    // Two miss retries plus at most gcScanLimit candidate reference checks.
    expect(pointerReads).toBeLessThanOrEqual(4);
  });

  it("keeps concurrent callers isolated from best-effort GC failures", async () => {
    const rootDir = await tempRoot();
    const store = new VextFrontendFreshnessStore(rootDir, {
      gcGraceMs: 1,
      gcScanLimit: 8,
    });
    const key = createKey("build-gc-failure");
    const badCandidate = path.join(
      store.rootPath,
      "entries",
      "unremovable.json",
    );
    await mkdir(badCandidate, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(badCandidate, old, old);

    await expect(
      Promise.all([
        store.write({
          key,
          tags: ["gc-failure"],
          response: response("still-committed"),
        }),
        store.read(createKey("missing")),
      ]),
    ).resolves.toBeDefined();
    await expect(store.read(key)).resolves.toMatchObject({
      state: "fresh",
      entry: { response: { payload: "still-committed" } },
    });
  });

  it("rejects GC options that disable the grace window or scan bound", async () => {
    const rootDir = await tempRoot();
    expect(
      () => new VextFrontendFreshnessStore(rootDir, { gcGraceMs: 0 }),
    ).toThrow("gcGraceMs must be a finite positive number");
    expect(
      () => new VextFrontendFreshnessStore(rootDir, { gcScanLimit: 0 }),
    ).toThrow("gcScanLimit must be a positive integer");
  });
});

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vext-freshness-"));
  tempDirs.push(directory);
  return directory;
}

function createKey(buildId: string) {
  return {
    route: "/posts/:slug",
    path: "/posts/hello",
    query: {},
    locale: "zh-CN",
    buildId,
    partition: "public",
    policy: { mode: "revalidate" as const, revalidate: 30 },
  };
}

function response(payload: string) {
  return { payload, status: 200, headers: { "Content-Type": "text/html" } };
}

async function entryFiles(
  store: VextFrontendFreshnessStore,
): Promise<string[]> {
  try {
    return (await readdir(path.join(store.rootPath, "entries")))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

async function readPointerFile(
  store: VextFrontendFreshnessStore,
  key: ReturnType<typeof createKey>,
): Promise<{ entryFile: string }> {
  const digest = createFreshnessKeyDigest(key);
  return JSON.parse(
    await readFile(
      path.join(store.rootPath, "pointers", `${digest}.json`),
      "utf-8",
    ),
  ) as { entryFile: string };
}
