import { isDeepStrictEqual } from "node:util";
import type { VextPluginContext } from "../../../types/plugin.js";

export interface ModelRegistryClass {
  define(name: string, definition: unknown): void;
  redefine(name: string, definition: unknown): void;
  undefine(name: string): boolean;
  has(name: string): boolean;
  get(name: string): { definition: unknown } | undefined;
}

export interface PlannedModelRegistration {
  key: string;
  definition: Record<string, unknown>;
  source: string;
}

interface RegistrySnapshot {
  exists: boolean;
  definition: unknown;
}

interface OwnedRegistryEntry {
  baseline: RegistrySnapshot;
  definition: unknown;
  owners: Map<symbol, string>;
}

interface RegistryJournalEntry {
  key: string;
  registry: RegistrySnapshot;
  ownership: OwnedRegistryEntry | undefined;
}

export interface ModelRegistrationHandle {
  readonly keys: readonly string[];
  replaceSources(
    sources: ReadonlySet<string>,
    registrations: readonly PlannedModelRegistration[],
  ): void;
  release(): void;
}

const registryOwnership = new WeakMap<
  object,
  Map<string, OwnedRegistryEntry>
>();
const appRegistrations = new WeakMap<object, ModelRegistrationHandleImpl>();

function getOwnershipMap(
  ModelClass: ModelRegistryClass,
): Map<string, OwnedRegistryEntry> {
  const registryObject = ModelClass as unknown as object;
  let ownership = registryOwnership.get(registryObject);
  if (!ownership) {
    ownership = new Map();
    registryOwnership.set(registryObject, ownership);
  }
  return ownership;
}

function snapshotRegistry(
  ModelClass: ModelRegistryClass,
  key: string,
): RegistrySnapshot {
  if (!ModelClass.has(key)) {
    return { exists: false, definition: undefined };
  }
  return { exists: true, definition: ModelClass.get(key)?.definition };
}

function cloneOwnership(
  entry: OwnedRegistryEntry | undefined,
): OwnedRegistryEntry | undefined {
  if (!entry) return undefined;
  return {
    baseline: { ...entry.baseline },
    definition: entry.definition,
    owners: new Map(entry.owners),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainGraphRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainGraphArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
}

function isKnownDeepStrictValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function enumerableDefinitionKeys(value: object): PropertyKey[] {
  return Reflect.ownKeys(value).filter((key) => {
    if (key === "_internalHooks") return false;
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
  });
}

function matchingDefinitionKeys(
  left: object,
  right: object,
): PropertyKey[] | undefined {
  const leftKeys = enumerableDefinitionKeys(left);
  const rightKeys = enumerableDefinitionKeys(right);
  if (leftKeys.length !== rightKeys.length) return undefined;

  const leftStrings = leftKeys
    .filter((key): key is string => typeof key === "string")
    .sort();
  const rightStrings = rightKeys
    .filter((key): key is string => typeof key === "string")
    .sort();
  if (
    leftStrings.length !== rightStrings.length ||
    leftStrings.some((key, index) => key !== rightStrings[index])
  ) {
    return undefined;
  }

  const leftSymbols = leftKeys.filter(
    (key): key is symbol => typeof key === "symbol",
  );
  const rightSymbols = rightKeys.filter(
    (key): key is symbol => typeof key === "symbol",
  );
  if (
    leftSymbols.length !== rightSymbols.length ||
    leftSymbols.some((key) => !rightSymbols.includes(key))
  ) {
    return undefined;
  }

  return [...leftStrings, ...leftSymbols];
}

function definitionsEquivalent(
  left: unknown,
  right: unknown,
  leftToRight = new WeakMap<object, object>(),
  rightToLeft = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftObject = left as object;
  const rightObject = right as object;
  if (leftToRight.has(leftObject)) {
    return leftToRight.get(leftObject) === rightObject;
  }
  if (rightToLeft.has(rightObject)) {
    return rightToLeft.get(rightObject) === leftObject;
  }
  leftToRight.set(leftObject, rightObject);
  rightToLeft.set(rightObject, leftObject);

  const leftIsArray = isPlainGraphArray(leftObject);
  const rightIsArray = isPlainGraphArray(rightObject);
  if (leftIsArray || rightIsArray) {
    if (
      !leftIsArray ||
      !rightIsArray ||
      leftObject.length !== rightObject.length
    ) {
      return false;
    }
  } else {
    const leftIsRecord = isPlainGraphRecord(leftObject);
    const rightIsRecord = isPlainGraphRecord(rightObject);
    if (!leftIsRecord || !rightIsRecord) {
      return (
        isKnownDeepStrictValue(leftObject) &&
        isKnownDeepStrictValue(rightObject) &&
        isDeepStrictEqual(leftObject, rightObject)
      );
    }
    if (
      Object.getPrototypeOf(leftObject) !== Object.getPrototypeOf(rightObject)
    ) {
      return false;
    }
  }

  const keys = matchingDefinitionKeys(leftObject, rightObject);
  if (!keys) return false;
  const leftValues = leftObject as Record<PropertyKey, unknown>;
  const rightValues = rightObject as Record<PropertyKey, unknown>;
  for (const key of keys) {
    if (
      !definitionsEquivalent(
        leftValues[key],
        rightValues[key],
        leftToRight,
        rightToLeft,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function validateModelRegistration(
  registration: PlannedModelRegistration,
): void {
  const { key, definition, source } = registration;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`${source} — model key must be a non-empty string`);
  }
  if (/[$.\s\0]/u.test(key)) {
    throw new Error(
      `${source} — model key '${key}' contains a forbidden character ($, ., whitespace, or null)`,
    );
  }
  if (!isPlainRecord(definition)) {
    throw new Error(`${source} — model definition must be an object`);
  }
  if (definition.schema == null) {
    throw new Error(`${source} — model definition must include a schema`);
  }
  if (
    typeof definition.schema !== "function" &&
    !isPlainRecord(definition.schema)
  ) {
    throw new Error(`${source} — model schema must be a function or object`);
  }

  if (definition.connection !== undefined) {
    if (!isPlainRecord(definition.connection)) {
      throw new Error(`${source} — model connection must be an object`);
    }
    for (const field of ["pool", "database"] as const) {
      const value = definition.connection[field];
      if (
        value !== undefined &&
        (typeof value !== "string" || value.trim() === "")
      ) {
        throw new Error(
          `${source} — model connection.${field} must be a non-empty string`,
        );
      }
    }
  }

  const timestamps = isPlainRecord(definition.options)
    ? definition.options.timestamps
    : undefined;
  if (
    timestamps !== undefined &&
    timestamps !== null &&
    typeof timestamps !== "boolean" &&
    !isPlainRecord(timestamps)
  ) {
    throw new Error(
      `${source} — model options.timestamps must be boolean or object`,
    );
  }
}

function restoreRegistrySnapshot(
  ModelClass: ModelRegistryClass,
  key: string,
  snapshot: RegistrySnapshot,
): void {
  if (snapshot.exists) {
    ModelClass.redefine(key, snapshot.definition);
  } else {
    ModelClass.undefine(key);
  }
}

class ModelRegistrationHandleImpl implements ModelRegistrationHandle {
  readonly #owner = Symbol("vextjs-monsqlize-model-owner");
  readonly #registrations = new Map<string, string>();
  #released = false;

  constructor(
    private readonly ModelClass: ModelRegistryClass,
    private readonly app: VextPluginContext,
  ) {}

  get keys(): readonly string[] {
    return [...this.#registrations.keys()].sort();
  }

  replaceSources(
    sources: ReadonlySet<string>,
    registrations: readonly PlannedModelRegistration[],
  ): void {
    if (this.#released) {
      throw new Error("[monsqlize] model registration handle is closed");
    }

    const nextByKey = new Map<string, PlannedModelRegistration>();
    for (const registration of registrations) {
      validateModelRegistration(registration);
      if (nextByKey.has(registration.key)) {
        throw new Error(
          `${registration.source} — duplicate model key '${registration.key}' in registration plan`,
        );
      }
      nextByKey.set(registration.key, registration);
    }

    const oldKeys = [...this.#registrations]
      .filter(([, source]) => sources.has(source))
      .map(([key]) => key);
    const affectedKeys = new Set([...oldKeys, ...nextByKey.keys()]);
    const ownership = getOwnershipMap(this.ModelClass);

    for (const [key, registration] of nextByKey) {
      const owned = ownership.get(key);
      const alreadyOwnedByApp = owned?.owners.has(this.#owner) ?? false;
      if (owned) {
        if (
          !definitionsEquivalent(owned.definition, registration.definition) &&
          (!alreadyOwnedByApp || owned.owners.size > 1)
        ) {
          throw new Error(
            `${registration.source} — model key '${key}' is owned by another app with a different definition`,
          );
        }
      } else if (this.ModelClass.has(key) && !alreadyOwnedByApp) {
        throw new Error(
          `${registration.source} — model key '${key}' is already registered outside this app`,
        );
      }
    }

    const journal: RegistryJournalEntry[] = [...affectedKeys].map((key) => ({
      key,
      registry: snapshotRegistry(this.ModelClass, key),
      ownership: cloneOwnership(ownership.get(key)),
    }));
    const previousRegistrations = new Map(this.#registrations);

    try {
      for (const key of oldKeys) {
        if (nextByKey.has(key)) continue;
        this.#releaseKey(key, ownership);
        this.#registrations.delete(key);
      }

      for (const [key, registration] of nextByKey) {
        const owned = ownership.get(key);
        if (!owned) {
          const baseline = snapshotRegistry(this.ModelClass, key);
          this.ModelClass.define(key, registration.definition);
          ownership.set(key, {
            baseline,
            definition:
              this.ModelClass.get(key)?.definition ?? registration.definition,
            owners: new Map([[this.#owner, registration.source]]),
          });
        } else if (!owned.owners.has(this.#owner)) {
          owned.owners.set(this.#owner, registration.source);
        } else if (
          !definitionsEquivalent(owned.definition, registration.definition)
        ) {
          this.ModelClass.redefine(key, registration.definition);
          owned.definition =
            this.ModelClass.get(key)?.definition ?? registration.definition;
          owned.owners.set(this.#owner, registration.source);
        } else {
          owned.owners.set(this.#owner, registration.source);
        }
        this.#registrations.set(key, registration.source);
      }
    } catch (error) {
      const rollbackErrors: Error[] = [];
      for (const entry of journal.reverse()) {
        try {
          restoreRegistrySnapshot(this.ModelClass, entry.key, entry.registry);
          if (entry.ownership) {
            ownership.set(entry.key, entry.ownership);
          } else {
            ownership.delete(entry.key);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError as Error);
        }
      }
      this.#registrations.clear();
      for (const [key, source] of previousRegistrations) {
        this.#registrations.set(key, source);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error as Error, ...rollbackErrors],
          "[monsqlize] model registration failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  release(): void {
    if (this.#released) return;
    const sources = new Set(this.#registrations.values());
    this.replaceSources(sources, []);
    this.#released = true;
    appRegistrations.delete(this.app as unknown as object);
  }

  #releaseKey(key: string, ownership: Map<string, OwnedRegistryEntry>): void {
    const owned = ownership.get(key);
    if (!owned || !owned.owners.has(this.#owner)) return;
    owned.owners.delete(this.#owner);
    if (owned.owners.size > 0) return;

    const current = snapshotRegistry(this.ModelClass, key);
    if (
      current.exists &&
      !definitionsEquivalent(current.definition, owned.definition)
    ) {
      throw new Error(
        `[monsqlize] model key '${key}' changed outside its owning app; refusing to overwrite it during close`,
      );
    }
    restoreRegistrySnapshot(this.ModelClass, key, owned.baseline);
    ownership.delete(key);
  }
}

export function registerModelPlan(
  ModelClass: ModelRegistryClass,
  app: VextPluginContext,
  registrations: readonly PlannedModelRegistration[],
): ModelRegistrationHandle {
  const appObject = app as unknown as object;
  if (appRegistrations.has(appObject)) {
    throw new Error("[monsqlize] this app already owns a model registration");
  }
  const handle = new ModelRegistrationHandleImpl(ModelClass, app);
  handle.replaceSources(new Set(), registrations);
  appRegistrations.set(appObject, handle);
  return handle;
}

export function replaceAppModelSources(
  ModelClass: ModelRegistryClass,
  app: ModelReloaderOwner,
  sources: ReadonlySet<string>,
  registrations: readonly PlannedModelRegistration[],
): void {
  const handle = appRegistrations.get(app as unknown as object);
  if (handle) {
    handle.replaceSources(sources, registrations);
    return;
  }

  for (const registration of registrations) {
    validateModelRegistration(registration);
  }
  const keys = new Set(registrations.map(({ key }) => key));
  if (keys.size !== registrations.length) {
    throw new Error("[monsqlize] duplicate model key in reload plan");
  }
  const journal = registrations.map(({ key }) => ({
    key,
    registry: snapshotRegistry(ModelClass, key),
  }));
  try {
    for (const registration of registrations) {
      if (ModelClass.has(registration.key)) {
        ModelClass.redefine(registration.key, registration.definition);
      } else {
        ModelClass.define(registration.key, registration.definition);
      }
    }
  } catch (error) {
    const rollbackErrors: Error[] = [];
    for (const entry of journal.reverse()) {
      try {
        restoreRegistrySnapshot(ModelClass, entry.key, entry.registry);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError as Error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error as Error, ...rollbackErrors],
        "[monsqlize] model reload failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

interface ModelReloaderOwner {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}
