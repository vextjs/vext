import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredSessionRuntime,
  createMemorySessionStore,
  session,
} from "../../../src/lib/session.js";
import { createCacheSessionStore } from "../../../src/lib/session-store-adapters.js";
import {
  serializeClearCookie,
  serializeCookie,
} from "../../../src/lib/cookies.js";
import type { VextRequest } from "../../../src/types/request.js";
import type { VextResponse } from "../../../src/types/response.js";
import type { VextCookieJar } from "../../../src/types/cookies.js";

function createReq(cookies: VextCookieJar = {}): VextRequest {
  return {
    requestId: "req-1",
    method: "GET",
    url: "/",
    path: "/",
    route: "/",
    query: {},
    params: {},
    headers: cookies["vext.sid"]
      ? { cookie: `vext.sid=${cookies["vext.sid"]}` }
      : {},
    cookies,
    cookie(name: string) {
      return cookies[name];
    },
    body: undefined,
    app: {
      config: {},
      onClose: vi.fn(),
      logger: { error: vi.fn() },
    } as any,
    ip: "127.0.0.1",
    protocol: "http",
    valid: vi.fn(),
    onClose: vi.fn(),
    _getRawBody: vi.fn(),
    _getRawBodyBuffer: vi.fn(),
  };
}

function createRes(): VextResponse & { setCookies: string[] } {
  const res: any = {
    setCookies: [],
    statusCode: 200,
    json: vi.fn(),
    rawJson: vi.fn(),
    text: vi.fn(),
    render: vi.fn(),
    renderError: vi.fn(),
    stream: vi.fn(),
    download: vi.fn(),
    redirect: vi.fn(),
    _isSent: vi.fn(() => false),
    _discardPendingSend: vi.fn(() => true),
    status: vi.fn(() => res),
    setHeader: vi.fn(() => res),
    cookie: vi.fn((name: string, value: string, options) => {
      res.setCookies.push(serializeCookie(name, value, options));
      return res;
    }),
    clearCookie: vi.fn((name: string, options) => {
      res.setCookies.push(serializeClearCookie(name, options));
      return res;
    }),
    _enableWrap: vi.fn(),
  };
  return res;
}

function extractSessionId(cookie: string): string {
  const match = /^vext\.sid=([^;]+)/.exec(cookie);
  if (!match) throw new Error(`missing session id in ${cookie}`);
  return match[1]!;
}

describe("session middleware", () => {
  it("persists modified session data and restores it on the next request", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60 });
    const firstReq = createReq();
    const firstRes = createRes();

    await middleware(firstReq, firstRes, async () => {
      firstReq.session!.userId = "u1";
    });

    const sid = extractSessionId(firstRes.setCookies[0]!);
    expect(await store.get(sid)).toEqual({ userId: "u1" });

    const secondReq = createReq({ "vext.sid": sid });
    const secondRes = createRes();
    await middleware(secondReq, secondRes, async () => {
      expect(secondReq.session!.userId).toBe("u1");
    });
    expect(secondRes.setCookies).toEqual([]);
  });

  it("detects nested mutations without recursively proxying session values", async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({ profile: { displayName: "before" } })),
      set,
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq({ "vext.sid": "existing" });

    await middleware(req, createRes(), async () => {
      const profile = req.session!.profile as { displayName: string };
      profile.displayName = "after";
    });

    expect(set).toHaveBeenCalledWith(
      "existing",
      { profile: { displayName: "after" } },
      60,
    );
  });

  it("does not mutate a custom store snapshot before the session is committed", async () => {
    const stored = { profile: { displayName: "before" } };
    const set = vi.fn();
    const store = {
      get: vi.fn(() => stored),
      set,
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq({ "vext.sid": "existing" });

    await middleware(req, createRes(), async () => {
      const profile = req.session!.profile as { displayName: string };
      profile.displayName = "after";
      expect(stored.profile.displayName).toBe("before");
    });

    expect(set).toHaveBeenCalledWith(
      "existing",
      { profile: { displayName: "after" } },
      60,
    );
  });

  it("detects nested mutations before an immediate response send", async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({ cart: { quantity: 1 } })),
      set,
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq({ "vext.sid": "existing" });
    const res = createRes();
    res.json = vi.fn((data: unknown, status = 200) => {
      res._onBeforeSend?.("json", data, status, {});
    });

    await middleware(req, res, async () => {
      const cart = req.session!.cart as { quantity: number };
      cart.quantity = 2;
      res.json({ ok: true });
    });

    expect(set).toHaveBeenCalledWith("existing", { cart: { quantity: 2 } }, 60);
  });

  it("refreshes its snapshot after save and persists later nested changes", async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({ preferences: { theme: "light" } })),
      set,
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq({ "vext.sid": "existing" });

    await middleware(req, createRes(), async () => {
      const preferences = req.session!.preferences as { theme: string };
      preferences.theme = "dark";
      await req.session!.save();
      preferences.theme = "contrast";
    });

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(
      1,
      "existing",
      { preferences: { theme: "dark" } },
      60,
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      "existing",
      { preferences: { theme: "contrast" } },
      60,
    );
  });

  it("conservatively persists sessions whose snapshot cannot be cloned", async () => {
    const handler = () => "not structured-cloneable";
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({ handler })),
      set,
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq({ "vext.sid": "existing" });

    await middleware(req, createRes(), async () => {});

    expect(set).toHaveBeenCalledWith("existing", { handler }, 60);
  });

  it("persists sessions through the cache session store adapter", async () => {
    const entries = new Map<string, { value: unknown; ttlMs?: number }>();
    const cache = {
      get: vi.fn(async (key: string) => entries.get(key)?.value),
      set: vi.fn(async (key: string, value: unknown, ttlMs?: number) => {
        entries.set(key, { value, ttlMs });
      }),
      del: vi.fn(async (key: string) => {
        entries.delete(key);
      }),
    };
    const store = createCacheSessionStore(cache, { prefix: "test:sess:" });
    const middleware = session({ store, ttl: 30, rolling: true });
    const firstReq = createReq();
    const firstRes = createRes();

    await middleware(firstReq, firstRes, async () => {
      firstReq.session!.userId = "u1";
    });

    const sid = extractSessionId(firstRes.setCookies[0]!);
    expect(entries.get(`test:sess:${sid}`)).toEqual({
      value: '{"userId":"u1"}',
      ttlMs: 30000,
    });

    const secondReq = createReq({ "vext.sid": sid });
    const secondRes = createRes();
    await middleware(secondReq, secondRes, async () => {
      expect(secondReq.session!.userId).toBe("u1");
    });

    expect(cache.set).toHaveBeenLastCalledWith(
      `test:sess:${sid}`,
      '{"userId":"u1"}',
      30000,
    );
  });

  it("auto-commits before immediate response sends", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60 });
    const req = createReq();
    const res = createRes();
    const sentHeaders: Record<string, string | string[]> = {};

    res.json = vi.fn((data: unknown, status = 200) => {
      res._onBeforeSend?.("json", data, status, sentHeaders);
    });

    await middleware(req, res, async () => {
      req.session!.userId = "u1";
      res.json({ ok: true });
    });

    const sid = extractSessionId(res.setCookies[0]!);
    const setCookie = sentHeaders["Set-Cookie"];
    const values = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(await store.get(sid)).toEqual({ userId: "u1" });
    expect(values.some((value) => value.startsWith(`vext.sid=${sid};`))).toBe(
      true,
    );
  });

  it("withholds the session cookie until async persistence succeeds", async () => {
    let resolvePersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    const store = {
      get: vi.fn(() => null),
      set: vi.fn(() => {
        markPersistenceStarted();
        return persistence;
      }),
      delete: vi.fn(),
    };
    const middleware = session({ store, ttl: 60 });
    const req = createReq();
    const res = createRes();
    const sentHeaders: Record<string, string | string[]> = {};
    res.json = vi.fn((data: unknown, status = 200) => {
      res._onBeforeSend?.("json", data, status, sentHeaders);
    });

    const running = middleware(req, res, async () => {
      req.session!.userId = "u1";
      res.json({ ok: true });
    });
    await persistenceStarted;

    expect(sentHeaders["Set-Cookie"]).toBeUndefined();
    expect(res.setCookies).toHaveLength(0);
    expect(res._sessionCommitPending).toBe(true);

    resolvePersistence();
    await running;
    expect(sentHeaders["Set-Cookie"]).toBeDefined();
    expect(res.setCookies).toHaveLength(1);
    expect(res._sessionCommitPending).toBe(false);
  });

  it("requires explicit session persistence before streaming", async () => {
    const store = {
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const req = createReq();
    const res = createRes();

    await expect(
      session({ store })(req, res, async () => {
        req.session!.userId = "u1";
        res._onBeforeSend?.("stream", undefined, 200, {});
      }),
    ).rejects.toThrow("must await req.session.save() before stream");
    expect(store.set).not.toHaveBeenCalled();
    expect(res.setCookies).toHaveLength(0);
  });

  it("regenerates and destroys sessions", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60 });
    const req = createReq();
    const res = createRes();

    await middleware(req, res, async () => {
      const oldId = req.session!.id;
      req.session!.role = "admin";
      await req.session!.regenerate();
      expect(req.session!.id).not.toBe(oldId);
    });

    const sid = extractSessionId(res.setCookies[0]!);
    expect(await store.get(sid)).toEqual({ role: "admin" });

    const destroyReq = createReq({ "vext.sid": sid });
    const destroyRes = createRes();
    await middleware(destroyReq, destroyRes, async () => {
      await destroyReq.session!.destroy();
    });

    expect(await store.get(sid)).toBeNull();
    expect(destroyRes.setCookies[0]).toContain("Max-Age=0");
  });

  it("does not persist reserved session keys", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60 });
    const req = createReq();
    const res = createRes();

    await middleware(req, res, async () => {
      expect(Object.keys(req.session!)).toEqual([]);
      expect(Reflect.set(req.session as any, "id", "override")).toBe(false);
      req.session!.userId = "u1";
    });

    const sid = extractSessionId(res.setCookies[0]!);
    expect(await store.get(sid)).toEqual({ userId: "u1" });
  });

  it("uses secure:auto based on request protocol", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60 });
    const httpReq = createReq();
    const httpRes = createRes();
    const httpsReq = createReq();
    const httpsRes = createRes();
    httpsReq.protocol = "https";

    await middleware(httpReq, httpRes, async () => {
      httpReq.session!.userId = "u1";
    });
    await middleware(httpsReq, httpsRes, async () => {
      httpsReq.session!.userId = "u2";
    });

    expect(httpRes.setCookies[0]).not.toContain("Secure");
    expect(httpsRes.setCookies[0]).toContain("Secure");
  });

  it("does not duplicate Set-Cookie after explicit save and rolling autoCommit", async () => {
    const store = createMemorySessionStore();
    const middleware = session({ store, ttl: 60, rolling: true });
    const req = createReq();
    const res = createRes();

    res.json = vi.fn((data: unknown, status = 200) => {
      res._onBeforeSend?.("json", data, status, {});
    });

    await middleware(req, res, async () => {
      req.session!.userId = "u1";
      await req.session!.save();
      res.json({ ok: true });
    });

    expect(res.setCookies).toHaveLength(1);
  });

  it("expires memory store entries lazily without timers", () => {
    vi.useFakeTimers();
    try {
      const store = createMemorySessionStore();
      store.set("sid", { ok: true }, 1);
      expect(store.size()).toBe(1);

      vi.advanceTimersByTime(1001);

      expect(store.get("sid")).toBeNull();
      expect(store.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("memory store get/set isolate nested snapshots and reject invalid TTL", () => {
    const store = createMemorySessionStore();
    expect(store.get("missing")).toBeNull();

    const nested = { user: { id: "u1" }, roles: ["admin"] };
    store.set("sid", nested, 60);
    nested.user.id = "mutated-input";
    nested.roles.push("x");

    const first = store.get("sid");
    expect(first).toEqual({ user: { id: "u1" }, roles: ["admin"] });
    first!.user.id = "mutated-read";
    first!.roles.push("y");

    expect(store.get("sid")).toEqual({ user: { id: "u1" }, roles: ["admin"] });

    store.delete("sid");
    store.delete("sid");
    expect(store.get("sid")).toBeNull();

    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.set("bad", { ok: true }, ttl)).toThrow(
        /ttlSeconds must be a positive finite number/,
      );
    }
  });

  it("memory store touch keeps data and size clears expired entries", () => {
    vi.useFakeTimers();
    try {
      const store = createMemorySessionStore();
      store.set("keep", { n: 1 }, 10);
      store.set("drop", { n: 2 }, 1);
      store.touch("missing", 5);
      store.touch("keep", 20);

      vi.advanceTimersByTime(1001);
      expect(store.get("drop")).toBeNull();
      expect(store.get("keep")).toEqual({ n: 1 });
      expect(store.size()).toBe(1);

      store.clearExpired?.();
      expect(store.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opportunistically sweeps expired entries in bounded batches", () => {
    vi.useFakeTimers();
    try {
      const store = createMemorySessionStore();
      store.set("expired", { n: 0 }, 1);
      vi.advanceTimersByTime(1001);
      const sweep = vi.spyOn(store, "clearExpired");

      for (let index = 0; index < 63; index += 1) {
        store.set(`live-${index}`, { index }, 60);
      }

      expect(sweep).toHaveBeenCalledWith(32);
      expect(store.size()).toBe(63);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto runtime follows global and route-level enablement", async () => {
    const store = createMemorySessionStore();
    const runtime = createConfiguredSessionRuntime({ enabled: false, store });

    const disabledReq = createReq();
    disabledReq.app.config.session = { enabled: false, store };
    await runtime.middleware(disabledReq, createRes(), vi.fn());
    expect(disabledReq.session).toBeUndefined();

    const enabledReq = createReq();
    enabledReq.app.config.session = { enabled: false, store };
    (enabledReq as any)._routeOptions = { session: true };
    await runtime.middleware(enabledReq, createRes(), async () => {
      enabledReq.session!.userId = "route-user";
    });
    expect(enabledReq.session).toBeDefined();

    const skippedReq = createReq();
    skippedReq.app.config.session = { enabled: true, store };
    (skippedReq as any)._routeOptions = { session: false };
    const globallyEnabled = createConfiguredSessionRuntime({
      enabled: true,
      store,
    });
    await globallyEnabled.middleware(skippedReq, createRes(), vi.fn());
    expect(skippedReq.session).toBeUndefined();
  });

  it("keeps manual session() enabled when app config disables auto runtime", async () => {
    const req = createReq();
    req.app.config.session = { enabled: false };

    await session()(req, createRes(), async () => {
      req.session!.userId = "manual";
    });

    expect(req.session!.userId).toBe("manual");
  });

  it("prevents automatic and manual middleware from attaching twice", async () => {
    const autoStore = createMemorySessionStore();
    const manualStore = {
      get: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const runtime = createConfiguredSessionRuntime({
      enabled: true,
      store: autoStore,
    });
    const manual = session({ store: manualStore });
    const req = createReq();
    req.app.config.session = { enabled: true, store: autoStore };

    await runtime.middleware(req, createRes(), () =>
      manual(req, createRes(), async () => {
        req.session!.userId = "u1";
      }),
    );

    expect(manualStore.get).not.toHaveBeenCalled();
    expect(manualStore.set).not.toHaveBeenCalled();
  });

  it("closes an app-owned store exactly once", async () => {
    const close = vi.fn();
    const runtime = createConfiguredSessionRuntime({
      store: {
        get: vi.fn(() => null),
        set: vi.fn(),
        delete: vi.fn(),
        close,
      },
    });

    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("commits dirty session data before rethrowing route errors", async () => {
    const store = createMemorySessionStore();
    const req = createReq();
    const res = createRes();

    await expect(
      session({ store })(req, res, async () => {
        req.session!.userId = "u1";
        throw new Error("route failed");
      }),
    ).rejects.toThrow("route failed");

    const sid = extractSessionId(res.setCookies[0]!);
    expect(await store.get(sid)).toEqual({ userId: "u1" });
  });

  it("discards a staged success response when session persistence fails", async () => {
    const req = createReq();
    const res = createRes();
    const store = {
      get: vi.fn(() => null),
      set: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
      delete: vi.fn(),
    };
    const sentHeaders: Record<string, string | string[]> = {};
    res.json = vi.fn((data: unknown, status = 200) => {
      res._onBeforeSend?.("json", data, status, sentHeaders);
    });

    await expect(
      session({ store })(req, res, async () => {
        req.session!.userId = "u1";
        res.json({ ok: true });
      }),
    ).rejects.toThrow("store unavailable");

    expect(res._discardPendingSend).toHaveBeenCalledOnce();
    expect(sentHeaders["Set-Cookie"]).toBeUndefined();
    expect(res.setCookies).toHaveLength(0);
  });
});
