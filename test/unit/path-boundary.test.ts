import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeProjectOutputDirectory,
  normalizeSafeRelativePath,
  resolvePathInside,
} from "../../src/lib/path-boundary.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("path boundary", () => {
  it("normalizes portable relative paths and rejects traversal identities", () => {
    expect(normalizeSafeRelativePath("assets/main.js", "asset")).toBe(
      "assets/main.js",
    );
    expect(normalizeSafeRelativePath("assets\\main.js", "asset")).toBe(
      "assets/main.js",
    );

    for (const value of [
      "",
      ".",
      "..",
      "../secret",
      "a/../secret",
      "/abs",
      "C:\\abs",
    ]) {
      expect(() => normalizeSafeRelativePath(value, "asset")).toThrow(
        /relative path|path segments/iu,
      );
    }
  });

  it("allows dedicated project outputs but rejects destructive project roots", async () => {
    const rootDir = await tempRoot();
    await mkdir(path.join(rootDir, "src"), { recursive: true });

    expect(
      assertSafeProjectOutputDirectory(
        rootDir,
        path.join(rootDir, "dist"),
        "output",
      ),
    ).toBe(path.join(rootDir, "dist"));
    expect(() =>
      assertSafeProjectOutputDirectory(rootDir, rootDir, "output"),
    ).toThrow("inside");
    expect(() =>
      assertSafeProjectOutputDirectory(
        rootDir,
        path.join(rootDir, "src"),
        "output",
      ),
    ).toThrow("protected project path src");
    expect(() =>
      assertSafeProjectOutputDirectory(
        rootDir,
        path.join(rootDir, "..", "outside"),
        "output",
      ),
    ).toThrow("inside");
  });

  it("rejects output and file paths that escape through a junction", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await symlink(
      outsideDir,
      path.join(rootDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertSafeProjectOutputDirectory(
        rootDir,
        path.join(rootDir, "linked", "output"),
        "output",
      ),
    ).toThrow("symbolic links");
    expect(() =>
      resolvePathInside(rootDir, "linked/secret.txt", "asset", {
        realpath: true,
      }),
    ).toThrow("symbolic links");
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vext-path-boundary-"));
  tempDirs.push(dir);
  return dir;
}
