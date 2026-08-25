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
