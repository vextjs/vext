import { describe, expect, it } from "vitest";
import { validateVersionContract } from "../../scripts/check-version-sync.mjs";

function input(overrides: Record<string, unknown> = {}) {
  const stable = "1.0.2";
  const next = "2.0.0";
  return {
    packageVersion: next,
    lockVersion: next,
    lockRootVersion: next,
    channels: { stable, next, channel: "next" },
    release: false,
    files: {
      rspress:
        'import docsVersions from "./version-channels.json"; docsVersions.stable; docsVersions.next; docsVersions.channel;',
      readme: "npm install vextjs",
      cli: {
        en: `docs v${next}; output vextjs v${stable}`,
        zh: `docs v${next}; output vextjs v${stable}`,
      },
      quickStart: {
        en: `docs v${next}; stable v${stable}; "vextjs": "^${stable}"`,
        zh: `docs v${next}; stable v${stable}; "vextjs": "^${stable}"`,
      },
    },
    ...overrides,
  };
}

describe("version channel contract", () => {
  it("allows an unreleased source candidate without advertising it as stable", () => {
    expect(validateVersionContract(input()).errors).toEqual([]);
  });

  it("keeps the current next state fail-closed for a tag release", () => {
    const result = validateVersionContract(input({ release: true }));
    expect(result.errors.map((error) => error.description)).toEqual(
      expect.arrayContaining([
        "release requires the public stable version to match package.json",
        "release requires website channel=stable",
      ]),
    );
  });

  it("accepts an exact stable release state", () => {
    const version = "2.0.0";
    const current = input({
      channels: { stable: version, next: version, channel: "stable" },
      release: true,
    });
    current.files.cli = {
      en: `docs v${version}; output vextjs v${version}`,
      zh: `docs v${version}; output vextjs v${version}`,
    };
    current.files.quickStart = {
      en: `docs v${version}; stable v${version}; "vextjs": "^${version}"`,
      zh: `docs v${version}; stable v${version}; "vextjs": "^${version}"`,
    };
    expect(validateVersionContract(current).errors).toEqual([]);
  });

  it("accepts a prerelease only on next while preserving published stable", () => {
    const version = "2.1.0-rc.1";
    const stable = "1.0.2";
    const current = input({
      packageVersion: version,
      lockVersion: version,
      lockRootVersion: version,
      channels: { stable, next: version, channel: "next" },
      release: true,
    });
    current.files.cli = {
      en: `docs v${version}; output vextjs v${stable}`,
      zh: `docs v${version}; output vextjs v${stable}`,
    };
    current.files.quickStart = {
      en: `docs v${version}; stable v${stable}; "vextjs": "^${stable}"`,
      zh: `docs v${version}; stable v${stable}; "vextjs": "^${stable}"`,
    };

    expect(validateVersionContract(current).errors).toEqual([]);
  });

  it("rejects a prerelease labelled as the stable docs channel", () => {
    const version = "2.1.0-beta.2";
    const result = validateVersionContract(
      input({
        packageVersion: version,
        lockVersion: version,
        lockRootVersion: version,
        channels: { stable: "1.0.2", next: version, channel: "stable" },
        release: true,
      }),
    );
    expect(result.errors.map((error) => error.description)).toContain(
      "prerelease requires website channel=next",
    );
  });

  it("rejects public examples that advertise next instead of stable", () => {
    const current = input();
    current.files.quickStart.en =
      'docs v2.0.0; stable v1.0.2; "vextjs": "^2.0.0"';
    expect(
      validateVersionContract(current).errors.map((error) => error.description),
    ).toContain(
      "en Quick Start uses stable while identifying the next docs version",
    );
  });

  it("rejects a channel label that contradicts stable and next", () => {
    const result = validateVersionContract(
      input({
        channels: { stable: "1.0.2", next: "2.0.0", channel: "stable" },
      }),
    );
    expect(result.errors.map((error) => error.description)).toContain(
      "website channel label matches stable/next state",
    );
  });
});
