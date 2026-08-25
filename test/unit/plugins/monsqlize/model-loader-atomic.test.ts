import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "monsqlize";
import { loadModels } from "../../../../src/lib/plugins/monsqlize/model-loader.js";

function createApp() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

async function writeModel(
  root: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const file = join(root, "models", relativePath);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, source, "utf8");
}

describe("MonSQLize model loader atomic discovery", () => {
  let root: string;

  beforeEach(async () => {
    Model._clear();
    root = await mkdtemp(join(tmpdir(), "vextjs-model-loader-"));
  });

  afterEach(async () => {
    Model._clear();
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to strict mode and leaves no earlier model after a later import failure", async () => {
    await writeModel(
      root,
      "a-good.mjs",
      "export default { name: 'users', schema: { id: String } };",
    );
    await writeModel(root, "z-bad.mjs", "export default { broken: ;");

    await expect(
      loadModels({} as any, undefined, createApp(), root),
    ).rejects.toThrow("failed to import");
    expect(Model.list()).toEqual([]);
  });

  it.each([
    ["invalid default", "invalid.mjs", "export default 42;", "invalid export"],
    [
      "excessive depth",
      "a/b/c/deep.mjs",
      "export default { schema: {} };",
      "exceeds maximum",
    ],
  ])(
    "fails fast for %s without mutating the registry",
    async (_name, file, source, message) => {
      await writeModel(root, file, source);

      await expect(
        loadModels({} as any, undefined, createApp(), root),
      ).rejects.toThrow(message);
      expect(Model.list()).toEqual([]);
    },
  );

  it("only skips invalid files when lenient mode is explicit", async () => {
    const app = createApp();
    await writeModel(
      root,
      "a-good.mjs",
      "export default { name: 'users', schema: { id: String } };",
    );
    await writeModel(root, "z-invalid.mjs", "export default 42;");

    const handle = await loadModels(
      {} as any,
      { validation: "lenient" },
      app,
      root,
    );

    expect(Model.list()).toEqual(["users"]);
    expect(app.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid export"),
    );
    handle.release();
    expect(Model.list()).toEqual([]);
  });

  it("rejects a cross-file alias collision before registering either file", async () => {
    await writeModel(
      root,
      "a-user.mjs",
      "export default { name: 'users', schema: {} };",
    );
    await writeModel(
      root,
      "b-order.mjs",
      "export default { name: 'orders', key: 'users', schema: {} };",
    );

    await expect(
      loadModels({} as any, undefined, createApp(), root),
    ).rejects.toThrow("conflicts with local:a-user.mjs");
    expect(Model.list()).toEqual([]);
  });

  it("rejects an invalid alias before registering its valid primary", async () => {
    await writeModel(
      root,
      "user.mjs",
      "export default { name: 'users', key: 42, schema: {} };",
    );

    await expect(
      loadModels({} as any, undefined, createApp(), root),
    ).rejects.toThrow("model key must be a non-empty string");
    expect(Model.list()).toEqual([]);
  });
});
