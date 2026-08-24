import { constants, type PathLike } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const raceAtRobots = async (
    operation: () => Promise<unknown>,
    target: PathLike,
  ) => {
    if (String(target).endsWith("robots.txt")) {
      await actual.writeFile(target, "concurrent-owner", "utf-8");
      const error = Object.assign(new Error("simulated EEXIST race"), {
        code: "EEXIST",
      });
      throw error;
    }
    return operation();
  };

  return {
    ...actual,
    copyFile: vi.fn((source: PathLike, target: PathLike) =>
      raceAtRobots(
        () => actual.copyFile(source, target, constants.COPYFILE_EXCL),
        target,
      ),
    ),
    rename: vi.fn((source: PathLike, target: PathLike) =>
      raceAtRobots(() => actual.rename(source, target), target),
    ),
  };
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fsPromises.rm(dir, { recursive: true, force: true })),
  );
});

describe("SEO artifact writer ownership", () => {
  it("rolls back only files committed by this writer during an EEXIST race", async () => {
    const { resolveFrontendConfig } =
      await import("../../src/frontend/tooling/config-resolver.js");
    const { writeFrontendSeoArtifacts } =
      await import("../../src/frontend/tooling/seo-artifact-writer.js");
    const rootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "vext-seo-race-"),
    );
    tempDirs.push(rootDir);
    const config = resolveFrontendConfig(
      {
        enabled: true,
        seo: {
          publicOrigin: "https://www.example.test",
          sitemap: {},
          robots: {},
        },
      },
      { rootDir, mode: "production" },
    );

    await expect(
      writeFrontendSeoArtifacts({ rootDir, config, staticArtifacts: [] }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      fsPromises.readFile(path.join(config.outDir, "robots.txt"), "utf-8"),
    ).resolves.toBe("concurrent-owner");
    await expect(
      fsPromises.readFile(path.join(config.outDir, "sitemap.xml"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
