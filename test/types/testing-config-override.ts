import { createTestApp, type CreateTestAppOptions } from "vextjs/testing";

const options = {
  config: {
    logger: { level: "silent" },
    response: { hideInternalErrors: true },
  },
  services: false,
  routes: false,
} satisfies CreateTestAppOptions;

const incompleteAdapter = {
  config: {
    // @ts-expect-error createTestApp uses the same atomic adapter patch contract.
    adapter: { name: "partial" },
  },
} satisfies CreateTestAppOptions;

const incompleteStore = {
  config: {
    session: {
      // @ts-expect-error createTestApp rejects partial session stores.
      store: { get: () => null },
    },
  },
} satisfies CreateTestAppOptions;

const wrongLeaf = {
  config: {
    logger: {
      // @ts-expect-error createTestApp preserves scalar leaf types.
      level: "chatty",
    },
  },
} satisfies CreateTestAppOptions;

const partialArrayElement = {
  config: {
    openapi: {
      // @ts-expect-error createTestApp does not accept partial array elements.
      servers: [{}],
    },
  },
} satisfies CreateTestAppOptions;

async function compileTestingEntry(): Promise<void> {
  const testApp = await createTestApp(options);
  await testApp.close();
}

void incompleteAdapter;
void incompleteStore;
void wrongLeaf;
void partialArrayElement;
void compileTestingEntry;
