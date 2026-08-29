import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/lib/app.js";

const CONFIG_DOCS = [
  new URL("../../website/docs/en/api/config.md", import.meta.url),
  new URL("../../website/docs/zh/api/config.md", import.meta.url),
];

const LAYERING_DOCS = [
  ...CONFIG_DOCS,
  new URL("../../website/docs/en/guide/configuration.md", import.meta.url),
  new URL("../../website/docs/zh/guide/configuration.md", import.meta.url),
  new URL("../../website/docs/en/guide/database.md", import.meta.url),
  new URL("../../website/docs/zh/guide/database.md", import.meta.url),
];

const TESTING_DOCS = [
  new URL("../../website/docs/en/guide/testing.md", import.meta.url),
  new URL("../../website/docs/zh/guide/testing.md", import.meta.url),
  new URL("../../website/docs/en/api/testing-api.md", import.meta.url),
  new URL("../../website/docs/zh/api/testing-api.md", import.meta.url),
];

const SCAFFOLD_DOCS = [
  new URL("../../website/docs/en/guide/project-structure.md", import.meta.url),
  new URL("../../website/docs/zh/guide/project-structure.md", import.meta.url),
  new URL("../../website/docs/en/guide/quick-start.md", import.meta.url),
  new URL("../../website/docs/zh/guide/quick-start.md", import.meta.url),
  new URL("../../website/docs/en/guide/cli.md", import.meta.url),
  new URL("../../website/docs/zh/guide/cli.md", import.meta.url),
];

const DEPLOYMENT_DOCS = [
  new URL("../../website/docs/en/guide/deployment.md", import.meta.url),
  new URL("../../website/docs/zh/guide/deployment.md", import.meta.url),
];

function extractDocumentedDefaultConfig(markdown: string): unknown {
  const sectionStart = markdown.indexOf("## DEFAULT_CONFIG");
  expect(sectionStart).toBeGreaterThanOrEqual(0);

  const section = markdown.slice(sectionStart);
  const fence = section.match(/```typescript\r?\n([\s\S]*?)\r?\n```/);
  expect(fence).not.toBeNull();

  const code = fence![1];
  const commentStart = code.indexOf("//");
  const objectStart = code.indexOf("{", commentStart);
  const objectEnd = code.lastIndexOf("}");
  expect(commentStart).toBeGreaterThanOrEqual(0);
  expect(objectStart).toBeGreaterThan(commentStart);
  expect(objectEnd).toBeGreaterThan(objectStart);

  return runInNewContext(`(${code.slice(objectStart, objectEnd + 1)})`);
}

describe("configuration documentation parity", () => {
  for (const documentUrl of CONFIG_DOCS) {
    it(`${documentUrl.pathname} keeps DEFAULT_CONFIG aligned with runtime`, async () => {
      const markdown = await readFile(documentUrl, "utf8");
      const documented = extractDocumentedDefaultConfig(markdown);

      expect(JSON.parse(JSON.stringify(documented))).toEqual(
        JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      );
      expect(markdown).toContain("`VEXT_PORT`");
      expect(markdown).toContain("`VEXT_HOST`");
    });
  }

  for (const documentUrl of LAYERING_DOCS) {
    it(`${documentUrl.pathname} distinguishes strict base config from override patches`, async () => {
      const markdown = await readFile(documentUrl, "utf8");

      expect(markdown).toContain("VextUserConfig");
      expect(markdown).toContain("VextConfigOverride");
      expect(markdown).toContain("MonSQLizeDatabaseConfig");
      expect(markdown).not.toContain("Partial<VextUserConfig>");
    });
  }

  for (const documentUrl of TESTING_DOCS) {
    it(`${documentUrl.pathname} documents test config as an override layer`, async () => {
      const markdown = await readFile(documentUrl, "utf8");

      expect(markdown).toContain("VextConfigOverride");
      expect(markdown).not.toContain("config?: Partial<VextConfig>");
      expect(markdown).not.toContain("`Partial<VextConfig>`");
    });
  }

  for (const documentUrl of SCAFFOLD_DOCS) {
    it(`${documentUrl.pathname} documents active zero-effect scaffold config`, async () => {
      const markdown = await readFile(documentUrl, "utf8");

      expect(markdown).toContain("local.ts");
      expect(markdown).toContain("bootstrap.ts");
      expect(markdown).toContain("VextConfigOverride");
      expect(markdown).toContain("providers: []");
      expect(markdown).not.toContain("local.example");
      expect(markdown).not.toContain("bootstrap.example");
    });
  }

  for (const documentUrl of DEPLOYMENT_DOCS) {
    it(`${documentUrl.pathname} keeps external environment injection without implying dotenv loading`, async () => {
      const markdown = await readFile(documentUrl, "utf8");

      expect(markdown).toContain("process.env");
      expect(markdown).toContain(".env*");
      expect(markdown).toMatch(/does not automatically parse|不会自动解析/);
      expect(markdown).not.toContain("# .env");
    });
  }
});
