import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { createDigest } from "../contract/schema-ir.js";
import type { VextRouteFreshnessIdentity } from "../contract/types.js";
import type { VextHeaders } from "../../types/headers.js";

export interface VextFrontendFreshnessKey {
  route: string;
  path: string;
  query: Record<string, string>;
  locale: string;
  buildId: string;
  partition: string;
  policy: Pick<
    VextRouteFreshnessIdentity,
    "mode" | "revalidate" | "clientOnly" | "hydration" | "seo"
  >;
}

export interface VextFrontendFreshnessResponse {
  payload: unknown;
  status: number;
  headers: VextHeaders;
}

export interface VextFrontendFreshnessEntry {
  schemaVersion: 1;
  key: VextFrontendFreshnessKey;
  keyDigest: string;
  createdAt: string;
  expiresAt: number | null;
  tags: readonly string[];
  response: VextFrontendFreshnessResponse;
}

export interface VextFrontendFreshnessReadResult {
  state: "miss" | "fresh" | "stale";
  entry?: VextFrontendFreshnessEntry;
}

export interface VextFrontendFreshnessWriteInput {
  key: VextFrontendFreshnessKey;
  tags: readonly string[];
  ttlMs?: number;
  response: VextFrontendFreshnessResponse;
}

export interface VextFrontendFreshnessInvalidation {
  route?: string;
  path?: string;
  tag?: string;
  key?: string;
  locale?: string;
  partition?: string;
}

export interface VextFrontendFreshnessInvalidationResult {
  matched: string[];
  removed: string[];
}

interface FreshnessPointer {
  schemaVersion: 1;
  keyDigest: string;
  entryFile: string;
  updatedAt: string;
}

export interface VextFrontendFreshnessStoreOptions {
  /** Minimum age of an unreferenced entry/temp file before collection. */
  gcGraceMs?: number;
  /** Maximum entry/temp candidates inspected by one maintenance pass. */
  gcScanLimit?: number;
}

interface GarbageCollectionCandidate {
  id: string;
  filePath: string;
  entryFile?: string;
}

const DEFAULT_GC_GRACE_MS = 60_000;
const DEFAULT_GC_SCAN_LIMIT = 64;
const writeQueues = new Map<string, Promise<void>>();
const committedAtomicWriteErrors = new WeakSet<object>();

/**
 * File-backed public frontend freshness store. Entries are immutable, and the
 * only mutable file is a small metadata pointer written via fsync + rename.
 * A failed write therefore leaves the previous pointer (last-known-good)
 * readable for stale serving and restart recovery.
 */
export class VextFrontendFreshnessStore {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly gcGraceMs: number;
  private readonly gcScanLimit: number;
  private gcCursor: string | undefined;
  private maintenancePromise: Promise<void> | undefined;

  readonly rootDir: string;

  constructor(
    rootDir: string,
    options: VextFrontendFreshnessStoreOptions = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.gcGraceMs = normalizeGcGrace(options.gcGraceMs);
    this.gcScanLimit = normalizeGcScanLimit(options.gcScanLimit);
  }

  async read(
    key: VextFrontendFreshnessKey,
  ): Promise<VextFrontendFreshnessReadResult> {
    const keyDigest = createFreshnessKeyDigest(key);
    let result: VextFrontendFreshnessReadResult = { state: "miss" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pointer = await this.readPointer(keyDigest);
      if (!pointer) continue;
      const entry = await this.readEntry(pointer.entryFile);
      if (!entry || entry.keyDigest !== keyDigest) continue;
      result =
        entry.expiresAt !== null && entry.expiresAt <= Date.now()
          ? { state: "stale", entry }
          : { state: "fresh", entry };
      break;
    }
    await this.runMaintenanceSafely();
    return result;
  }

  async write(
    input: VextFrontendFreshnessWriteInput,
  ): Promise<VextFrontendFreshnessEntry> {
    const keyDigest = createFreshnessKeyDigest(input.key);
    return enqueueFreshnessWrite(`${this.rootPath}\0${keyDigest}`, async () =>
      this.writeGeneration(input, keyDigest),
    );
  }

  private async writeGeneration(
    input: VextFrontendFreshnessWriteInput,
    keyDigest: string,
  ): Promise<VextFrontendFreshnessEntry> {
    const ttlMs = normalizeFreshnessTtl(input.ttlMs);
    const previousPointer = await this.readPointer(keyDigest);
    if (previousPointer) {
      await this.refreshEntryGrace(previousPointer.entryFile);
    }
    const createdAt = new Date().toISOString();
    const entry: VextFrontendFreshnessEntry = {
      schemaVersion: 1,
      key: input.key,
      keyDigest,
      createdAt,
      expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
      tags: [...new Set(input.tags)].sort((left, right) =>
        left.localeCompare(right),
      ),
      response: input.response,
    };
    const entryFile = `${keyDigest}.${randomUUID()}.json`;
    const entryPath = path.join(this.entriesDir, entryFile);
    let entryCommitted = false;
    try {
      await writeFileAtomically(entryPath, `${JSON.stringify(entry)}\n`);
      entryCommitted = true;
      await writeFileAtomically(
        path.join(this.pointersDir, `${keyDigest}.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          keyDigest,
          entryFile,
          updatedAt: createdAt,
        } satisfies FreshnessPointer)}\n`,
      );
    } catch (error) {
      if (entryCommitted && !wasAtomicRenameCommitted(error)) {
        try {
          await rm(entryPath, { force: false });
        } catch (cleanupError) {
          if (!isMissing(cleanupError)) {
            throw new AggregateError(
              [error, cleanupError],
              "[vextjs] frontend freshness pointer commit failed and its new entry could not be removed.",
            );
          }
        }
      }
      throw error;
    }
    await this.runMaintenanceSafely();
    return entry;
  }

  async singleFlight<T>(
    key: VextFrontendFreshnessKey,
    operation: () => Promise<T>,
  ): Promise<{ value: T; leader: boolean }> {
    const keyDigest = createFreshnessKeyDigest(key);
    const current = this.inFlight.get(keyDigest) as Promise<T> | undefined;
    if (current) {
      return { value: await current, leader: false };
    }

    const promise = operation().finally(() => {
      this.inFlight.delete(keyDigest);
    });
    this.inFlight.set(keyDigest, promise);
    return { value: await promise, leader: true };
  }

  async invalidate(
    target: VextFrontendFreshnessInvalidation,
  ): Promise<VextFrontendFreshnessInvalidationResult> {
    assertInvalidationTarget(target);
    let names: string[];
    try {
      names = await readdir(this.pointersDir);
    } catch (error) {
      if (isMissing(error)) return { matched: [], removed: [] };
      throw error;
    }

    const matched: string[] = [];
    const removed: string[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const keyDigest = name.slice(0, -".json".length);
      const result = await enqueueFreshnessWrite(
        `${this.rootPath}\0${keyDigest}`,
        async () => this.invalidatePointer(keyDigest, name, target),
      );
      if (result.matched) matched.push(keyDigest);
      if (result.removed) removed.push(keyDigest);
    }
    await this.runMaintenanceSafely();
    return { matched, removed };
  }

  get rootPath(): string {
    return path.join(this.rootDir, ".vext", "freshness", "v1");
  }

  private get entriesDir(): string {
    return path.join(this.rootPath, "entries");
  }

  private get pointersDir(): string {
    return path.join(this.rootPath, "pointers");
  }

  private async readPointer(
    keyDigest: string,
  ): Promise<FreshnessPointer | null> {
    try {
      const value = JSON.parse(
        await readFile(
          path.join(this.pointersDir, `${keyDigest}.json`),
          "utf-8",
        ),
      ) as FreshnessPointer;
      if (
        value.schemaVersion !== 1 ||
        value.keyDigest !== keyDigest ||
        typeof value.entryFile !== "string" ||
        !value.entryFile.endsWith(".json") ||
        path.basename(value.entryFile) !== value.entryFile
      ) {
        return null;
      }
      return value;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async readEntry(
    entryFile: string,
  ): Promise<VextFrontendFreshnessEntry | null> {
    try {
      const value = JSON.parse(
        await readFile(path.join(this.entriesDir, entryFile), "utf-8"),
      ) as VextFrontendFreshnessEntry;
      if (value.schemaVersion !== 1 || typeof value.keyDigest !== "string") {
        return null;
      }
      return value;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async refreshEntryGrace(entryFile: string): Promise<void> {
    const now = new Date();
    try {
      await utimes(path.join(this.entriesDir, entryFile), now, now);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async invalidatePointer(
    keyDigest: string,
    pointerName: string,
    target: VextFrontendFreshnessInvalidation,
  ): Promise<{ matched: boolean; removed: boolean }> {
    const pointer = await this.readPointer(keyDigest);
    if (!pointer) return { matched: false, removed: false };
    const entry = await this.readEntry(pointer.entryFile);
    if (!entry || !matchesInvalidation(entry, target)) {
      return { matched: false, removed: false };
    }
    await this.refreshEntryGrace(pointer.entryFile);
    try {
      await rm(path.join(this.pointersDir, pointerName), { force: false });
      return { matched: true, removed: true };
    } catch (error) {
      if (isMissing(error)) return { matched: true, removed: false };
      throw error;
    }
  }

  private async runMaintenanceSafely(): Promise<void> {
    if (this.maintenancePromise) {
      await this.maintenancePromise;
      return;
    }
    const maintenance = this.collectGarbage().catch(() => undefined);
    this.maintenancePromise = maintenance;
    try {
      await maintenance;
    } catch {
      // Pointer commits and reads remain authoritative if best-effort GC fails.
    } finally {
      if (this.maintenancePromise === maintenance) {
        this.maintenancePromise = undefined;
      }
    }
  }

  private async collectGarbage(): Promise<void> {
    const candidates = await this.listGarbageCandidates();
    if (candidates.length === 0) {
      this.gcCursor = undefined;
      return;
    }

    let startIndex = 0;
    if (this.gcCursor !== undefined) {
      const nextIndex = candidates.findIndex(
        (candidate) => candidate.id > this.gcCursor!,
      );
      if (nextIndex >= 0) startIndex = nextIndex;
    }
    const selected = candidates.slice(
      startIndex,
      startIndex + this.gcScanLimit,
    );
    const cutoff = Date.now() - this.gcGraceMs;

    for (const candidate of selected) {
      this.gcCursor = candidate.id;
      let metadata;
      try {
        metadata = await stat(candidate.filePath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (metadata.mtimeMs > cutoff) continue;
      if (
        candidate.entryFile !== undefined &&
        (await this.isEntryReferenced(candidate.entryFile))
      ) {
        continue;
      }
      try {
        await rm(candidate.filePath, { force: false });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }

    if (startIndex + selected.length >= candidates.length) {
      this.gcCursor = undefined;
    }
  }

  private async isEntryReferenced(entryFile: string): Promise<boolean> {
    const separator = entryFile.indexOf(".");
    if (separator <= 0) return false;
    const pointer = await this.readPointer(entryFile.slice(0, separator));
    return pointer?.entryFile === entryFile;
  }

  private async listGarbageCandidates(): Promise<GarbageCollectionCandidate[]> {
    const candidates: GarbageCollectionCandidate[] = [];
    for (const [directory, prefix] of [
      [this.entriesDir, "entries"],
      [this.pointersDir, "pointers"],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const name of names) {
        const isEntry = prefix === "entries" && name.endsWith(".json");
        if (!isEntry && !name.endsWith(".tmp")) continue;
        candidates.push({
          id: `${prefix}/${name}`,
          filePath: path.join(directory, name),
          ...(isEntry ? { entryFile: name } : {}),
        });
      }
    }
    return candidates.sort((left, right) => left.id.localeCompare(right.id));
  }
}

const stores = new Map<string, VextFrontendFreshnessStore>();

export function getFrontendFreshnessStore(
  rootDir: string,
): VextFrontendFreshnessStore {
  const normalized = path.resolve(rootDir);
  let store = stores.get(normalized);
  if (!store) {
    store = new VextFrontendFreshnessStore(normalized);
    stores.set(normalized, store);
  }
  return store;
}

export async function invalidateFrontendFreshness(
  rootDir: string,
  target: VextFrontendFreshnessInvalidation,
): Promise<VextFrontendFreshnessInvalidationResult> {
  return getFrontendFreshnessStore(rootDir).invalidate(target);
}

export function createFreshnessKeyDigest(
  key: VextFrontendFreshnessKey,
): string {
  return createDigest(key);
}

async function enqueueFreshnessWrite<T>(
  queueKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(queueKey, tail);
  try {
    return await current;
  } finally {
    if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey);
  }
}

function normalizeFreshnessTtl(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "[vextjs] frontend freshness ttlMs must be a finite non-negative number.",
    );
  }
  return value;
}

function normalizeGcGrace(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GC_GRACE_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "[vextjs] frontend freshness gcGraceMs must be a finite positive number.",
    );
  }
  return value;
}

function normalizeGcScanLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GC_SCAN_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      "[vextjs] frontend freshness gcScanLimit must be a positive integer.",
    );
  }
  return value;
}

async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  let renamed = false;
  try {
    await rename(tempPath, filePath);
    renamed = true;
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    if (renamed) {
      if (typeof error === "object" && error !== null) {
        committedAtomicWriteErrors.add(error);
      }
    } else {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function wasAtomicRenameCommitted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    committedAtomicWriteErrors.has(error)
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Windows cannot fsync directory handles. The fully fsynced temp file and
    // atomic rename still preserve last-known-good pointer semantics there.
    if (process.platform !== "win32") throw error;
  }
}

function matchesInvalidation(
  entry: VextFrontendFreshnessEntry,
  target: VextFrontendFreshnessInvalidation,
): boolean {
  return (
    (target.route === undefined || entry.key.route === target.route) &&
    (target.path === undefined || entry.key.path === target.path) &&
    (target.key === undefined || entry.keyDigest === target.key) &&
    (target.locale === undefined || entry.key.locale === target.locale) &&
    (target.partition === undefined ||
      entry.key.partition === target.partition) &&
    (target.tag === undefined || entry.tags.includes(target.tag))
  );
}

function assertInvalidationTarget(
  target: VextFrontendFreshnessInvalidation,
): void {
  if (
    target.route === undefined &&
    target.path === undefined &&
    target.tag === undefined &&
    target.key === undefined &&
    target.locale === undefined &&
    target.partition === undefined
  ) {
    throw new Error(
      "[vextjs] frontend freshness invalidation requires route, path, tag, key, locale, or partition.",
    );
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
