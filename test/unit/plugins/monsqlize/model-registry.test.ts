import { describe, expect, it, vi } from "vitest";
import {
  registerModelPlan,
  validateModelRegistration,
} from "../../../../src/lib/plugins/monsqlize/model-registry.js";
import type {
  ModelRegistryClass,
  PlannedModelRegistration,
} from "../../../../src/lib/plugins/monsqlize/model-registry.js";

function createRegistry(failOnKey?: string): {
  definitions: Map<string, unknown>;
  ModelClass: ModelRegistryClass;
  define: ReturnType<typeof vi.fn>;
  redefine: ReturnType<typeof vi.fn>;
  undefine: ReturnType<typeof vi.fn>;
} {
  const definitions = new Map<string, unknown>();
  const define = vi.fn((key: string, definition: unknown) => {
    if (key === failOnKey) throw new Error(`commit failed for ${key}`);
    if (definitions.has(key)) throw new Error(`already defined: ${key}`);
    definitions.set(key, definition);
  });
  const redefine = vi.fn((key: string, definition: unknown) => {
    if (key === failOnKey) throw new Error(`commit failed for ${key}`);
    definitions.set(key, definition);
  });
  const undefine = vi.fn((key: string) => definitions.delete(key));
  return {
    definitions,
    define,
    redefine,
    undefine,
    ModelClass: {
      define,
      redefine,
      undefine,
      has: (key) => definitions.has(key),
      get: (key) =>
        definitions.has(key) ? { definition: definitions.get(key) } : undefined,
    },
  };
}

function registration(
  key: string,
  source: string,
  definition: Record<string, unknown> = { schema: {} },
): PlannedModelRegistration {
  return { key, source, definition };
}

function app() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

describe("MonSQLize app-owned model registry", () => {
  it("rolls back every earlier key when a later commit fails", () => {
    const { ModelClass, definitions, undefine } = createRegistry("orders");

    expect(() =>
      registerModelPlan(ModelClass, app(), [
        registration("users", "local:user.js"),
        registration("orders", "local:order.js"),
      ]),
    ).toThrow("commit failed for orders");

    expect(definitions.size).toBe(0);
    expect(undefine).toHaveBeenCalledWith("users");
  });

  it("preflights the entire plan before the first registry mutation", () => {
    const { ModelClass, define } = createRegistry();

    expect(() =>
      registerModelPlan(ModelClass, app(), [
        registration("users", "local:user.js"),
        registration("bad alias", "local:user.js"),
      ]),
    ).toThrow("forbidden character");
    expect(define).not.toHaveBeenCalled();
  });

  it("reference-counts equivalent definitions across two apps", () => {
    const { ModelClass, definitions, define, undefine } = createRegistry();
    const definition = { schema: { id: String } };
    const first = registerModelPlan(ModelClass, app(), [
      registration("users", "shared:models:User", definition),
    ]);
    const second = registerModelPlan(ModelClass, app(), [
      registration("users", "shared:models:User", definition),
    ]);

    expect(define).toHaveBeenCalledTimes(1);
    first.release();
    expect(definitions.has("users")).toBe(true);
    expect(undefine).not.toHaveBeenCalled();

    second.release();
    expect(definitions.has("users")).toBe(false);
    expect(undefine).toHaveBeenCalledTimes(1);
  });

  it("rejects a divergent definition owned by another app", () => {
    const { ModelClass, definitions, define } = createRegistry();
    const first = registerModelPlan(ModelClass, app(), [
      registration("users", "local:user.js", { schema: { version: 1 } }),
    ]);

    expect(() =>
      registerModelPlan(ModelClass, app(), [
        registration("users", "local:user.js", { schema: { version: 2 } }),
      ]),
    ).toThrow("owned by another app with a different definition");
    expect(define).toHaveBeenCalledTimes(1);
    expect(definitions.get("users")).toEqual({ schema: { version: 1 } });
    first.release();
  });

  it("compares built-in values by deep value but unknown classes by identity", () => {
    class CustomSchemaOption {
      constructor(readonly version: number) {}
    }

    const equivalentRegistry = createRegistry();
    const first = registerModelPlan(equivalentRegistry.ModelClass, app(), [
      registration("users", "shared:first", {
        schema: {
          createdAt: new Date("2026-08-25T00:00:00.000Z"),
          flags: new Set(["active"]),
          bytes: new Uint8Array([1, 2, 3]),
        },
      }),
    ]);
    const second = registerModelPlan(equivalentRegistry.ModelClass, app(), [
      registration("users", "shared:second", {
        schema: {
          createdAt: new Date("2026-08-25T00:00:00.000Z"),
          flags: new Set(["active"]),
          bytes: new Uint8Array([1, 2, 3]),
        },
      }),
    ]);
    second.release();
    first.release();

    const differentBuiltinRegistry = createRegistry();
    const builtinOwner = registerModelPlan(
      differentBuiltinRegistry.ModelClass,
      app(),
      [
        registration("events", "shared:first", {
          schema: { createdAt: new Date("2026-08-25T00:00:00.000Z") },
        }),
      ],
    );
    expect(() =>
      registerModelPlan(differentBuiltinRegistry.ModelClass, app(), [
        registration("events", "shared:second", {
          schema: { createdAt: new Date("2026-08-26T00:00:00.000Z") },
        }),
      ]),
    ).toThrow("different definition");
    builtinOwner.release();

    const customRegistry = createRegistry();
    const customOwner = registerModelPlan(customRegistry.ModelClass, app(), [
      registration("custom", "shared:first", {
        schema: { option: new CustomSchemaOption(1) },
      }),
    ]);
    expect(() =>
      registerModelPlan(customRegistry.ModelClass, app(), [
        registration("custom", "shared:second", {
          schema: { option: new CustomSchemaOption(1) },
        }),
      ]),
    ).toThrow("different definition");
    customOwner.release();
  });

  it("ignores _internalHooks while preserving shared-reference topology", () => {
    const equivalentRegistry = createRegistry();
    const firstShared: Record<string, unknown> = { version: 1 };
    const secondShared: Record<string, unknown> = { version: 1 };
    const first = registerModelPlan(equivalentRegistry.ModelClass, app(), [
      registration("users", "shared:first", {
        schema: {
          primary: firstShared,
          alias: firstShared,
          _internalHooks: [() => "first"],
        },
      }),
    ]);
    const second = registerModelPlan(equivalentRegistry.ModelClass, app(), [
      registration("users", "shared:second", {
        schema: {
          primary: secondShared,
          alias: secondShared,
          _internalHooks: [() => "second"],
        },
      }),
    ]);
    second.release();
    first.release();

    const divergentRegistry = createRegistry();
    const shared: Record<string, unknown> = { version: 1 };
    const owner = registerModelPlan(divergentRegistry.ModelClass, app(), [
      registration("users", "shared:first", {
        schema: { primary: shared, alias: shared },
      }),
    ]);
    expect(() =>
      registerModelPlan(divergentRegistry.ModelClass, app(), [
        registration("users", "shared:second", {
          schema: {
            primary: { version: 1 },
            alias: { version: 1 },
          },
        }),
      ]),
    ).toThrow("different definition");
    owner.release();
  });

  it("compares cyclic plain graphs with bidirectional node mapping", () => {
    const registry = createRegistry();
    const firstCycle: Record<string, unknown> = { version: 1 };
    firstCycle.self = firstCycle;
    const secondCycle: Record<string, unknown> = { version: 1 };
    secondCycle.self = secondCycle;

    const first = registerModelPlan(registry.ModelClass, app(), [
      registration("cycles", "shared:first", { schema: firstCycle }),
    ]);
    const second = registerModelPlan(registry.ModelClass, app(), [
      registration("cycles", "shared:second", { schema: secondCycle }),
    ]);

    second.release();
    first.release();
  });

  it("atomically replaces an owned source and keeps close ownership current", () => {
    const { ModelClass, definitions, redefine } = createRegistry();
    const owner = app();
    const handle = registerModelPlan(ModelClass, owner, [
      registration("users", "local:user.js", { schema: { version: 1 } }),
    ]);

    handle.replaceSources(new Set(["local:user.js"]), [
      registration("users", "local:user.js", {
        schema: { version: 2 },
      }),
    ]);

    expect(redefine).toHaveBeenCalledWith("users", {
      schema: { version: 2 },
    });
    expect(definitions.get("users")).toEqual({ schema: { version: 2 } });
    handle.release();
    expect(definitions.has("users")).toBe(false);
  });

  it("refuses to overwrite an externally changed key during close", () => {
    const { ModelClass, definitions } = createRegistry();
    const handle = registerModelPlan(ModelClass, app(), [
      registration("users", "local:user.js", { schema: { version: 1 } }),
    ]);
    definitions.set("users", { schema: { external: true } });

    expect(() => handle.release()).toThrow("changed outside its owning app");
    expect(definitions.get("users")).toEqual({ schema: { external: true } });
  });

  it("validates primary and alias-compatible key syntax before MonSQLize", () => {
    expect(() =>
      validateModelRegistration(registration("invalid.alias", "local:user.js")),
    ).toThrow("forbidden character");
    expect(() =>
      validateModelRegistration(
        registration("users", "local:user.js", { schema: null }),
      ),
    ).toThrow("must include a schema");
  });
});
