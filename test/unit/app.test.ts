import { describe, expect, it, vi } from "vitest";
import { createApp, DEFAULT_CONFIG } from "../../src/lib/app.js";
import { createRequestIdMiddleware } from "../../src/lib/middlewares/request-id.js";

describe("createApp", () => {
  it("keeps the 2.0 global rate limit default disabled", () => {
    expect(DEFAULT_CONFIG.rateLimit.enabled).toBe(false);
  });

  it("validates the runtime config boundary", () => {
    expect(() => createApp(null as never)).toThrow(
      "[vextjs] createApp() config must be an object.",
    );
    expect(() =>
      createApp({ ...DEFAULT_CONFIG, logger: null as never }),
    ).toThrow("[vextjs] createApp() config.logger must be an object.");
    expect(() =>
      createApp({ ...DEFAULT_CONFIG, middlewares: {} as never }),
    ).toThrow("[vextjs] createApp() config.middlewares must be an array.");
    expect(() => createApp({} as never)).toThrow(
      "[vextjs] createApp() config.port is required.",
    );
  });

  it("allows plugins to add new app extension properties", () => {
    const { app } = createApp(DEFAULT_CONFIG);

    app.extend("mailer", { send: () => undefined });
    app.extend("中文能力", { enabled: true });

    expect((app as unknown as { mailer: unknown }).mailer).toBeDefined();
    expect(
      (app as unknown as Record<"中文能力", { enabled: boolean }>).中文能力
        .enabled,
    ).toBe(true);
  });

  it("prevents app extensions from overriding built-in properties", () => {
    const { app } = createApp(DEFAULT_CONFIG);

    expect(() => app.extend("cache", {})).toThrow(
      '[vextjs] app.extend("cache") cannot override an existing app property.',
    );
  });

  it("rejects unsafe extension keys", () => {
    const { app } = createApp(DEFAULT_CONFIG);

    expect(() => app.extend("", true)).toThrow(
      "[vextjs] app.extend() key must be a non-empty string.",
    );
    expect(() => app.extend("bad-key", true)).toThrow(
      '[vextjs] app.extend("bad-key") key must be a valid JavaScript identifier.',
    );
    expect(() => app.extend("constructor", true)).toThrow(
      '[vextjs] app.extend("constructor") uses a reserved app extension key.',
    );
    expect(() => app.extend("__defineGetter__", true)).toThrow(
      '[vextjs] app.extend("__defineGetter__") uses a reserved app extension key.',
    );
  });

  it("normalizes partial logger wrappers installed through setLogger", () => {
    const { app } = createApp(DEFAULT_CONFIG);
    const info = vi.fn();

    app.setLogger(() => ({ info }));

    expect(typeof app.logger.trace).toBe("function");
    expect(typeof app.logger.getLevel).toBe("function");
    expect(typeof app.logger.setLevel).toBe("function");
    expect(typeof app.logger.child).toBe("function");

    app.logger.info("wrapped info");
    expect(info).toHaveBeenCalledWith("wrapped info");

    app.logger.setLevel("trace");
    expect(app.logger.getLevel()).toBe("trace");
    const child = app.logger.child({ service: "child" });
    expect(child.getLevel()).toBe("trace");
    child.info("child info");
    expect(info).toHaveBeenCalledWith("child info");
  });

  it("keeps child bindings when setLogger wrappers forward to original", () => {
    const { app } = createApp({
      ...DEFAULT_CONFIG,
      logger: { level: "info", pretty: false },
    });
    const lines: string[] = [];

    app.setLogger((original) => ({
      info(...args: unknown[]) {
        // Capture by invoking original into a temporary path: record via spy args
        lines.push(JSON.stringify(args));
        original.info(...args);
      },
    }));

    const child = app.logger.child({ service: "orders", component: "worker" });
    child.info({ orderId: 7 }, "processing");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("processing");
    // Nested child must still resolve through the child core (bindings intact).
    const nested = child.child({ request: "r1" });
    nested.info("nested");
    expect(lines).toHaveLength(2);
  });

  it("validates replacement APIs and preserves previous implementations", () => {
    const { app, internals } = createApp(DEFAULT_CONFIG);
    const originalValidator = app.getValidator();
    const originalThrow = app.throw;
    const originalLogger = app.logger;

    expect(() => app.setValidator({} as never)).toThrow(
      "[vextjs] app.setValidator() validator.compile must be a function.",
    );
    expect(app.getValidator()).toBe(originalValidator);

    expect(() => app.setThrow(() => "not-a-function" as never)).toThrow(
      "[vextjs] app.setThrow() wrapper result must be a function.",
    );
    expect(app.throw).toBe(originalThrow);

    expect(() => app.setLogger(() => null as never)).toThrow(
      "[vextjs] app.setLogger() wrapper result must be an object.",
    );
    expect(app.logger).toBe(originalLogger);
    expect(() => app.setLogger(() => ({ info: 1 as never }))).toThrow(
      "[vextjs] app.setLogger() wrapper result.info must be a function when provided.",
    );
    expect(app.logger).toBe(originalLogger);

    expect(() => app.setRateLimiter({} as never)).toThrow(
      "[vextjs] app.setRateLimiter() limiter.check must be a function.",
    );
    expect(internals.getRateLimiter()).toBeNull();

    expect(() => app.setRequestIdGenerator("bad" as never)).toThrow(
      "[vextjs] app.setRequestIdGenerator() generator must be a function.",
    );
    expect(internals.getRequestIdGenerator()).toBeNull();
  });

  it("keeps rate limiter override state out of user extension keys", () => {
    const { app, internals } = createApp(DEFAULT_CONFIG);

    app.extend("_rateLimiterOverridden", "consumer-value");
    app.setRateLimiter({
      async check() {
        return {
          allowed: true,
          remaining: 1,
          resetAt: Math.ceil(Date.now() / 1000) + 60,
        };
      },
    });

    expect(internals.getRateLimiter()).not.toBeNull();
    expect((app as Record<string, unknown>)._rateLimiterOverridden).toBe(
      "consumer-value",
    );
  });

  it("allows app.use only during plugin setup and returns middleware snapshots", () => {
    const { app, internals } = createApp(DEFAULT_CONFIG);
    const middleware = vi.fn(async (_req, _res, next) => next());
    const other = vi.fn(async (_req, _res, next) => next());

    expect(() => app.use(middleware)).toThrow(
      "[vextjs] app.use() can only be called during plugin setup().",
    );

    internals.enterPluginSetup();
    try {
      expect(() => app.use("bad" as never)).toThrow(
        "[vextjs] app.use() middleware must be a function.",
      );
      app.use(middleware);
      const snapshot = internals.getGlobalMiddlewares();
      snapshot.push(other);
      expect(internals.getGlobalMiddlewares()).toEqual([middleware]);

      internals.lockUse();
      expect(() => app.use(other)).toThrow(
        "[vextjs] app.use() is locked after route registration.",
      );
    } finally {
      internals.exitPluginSetup();
    }
  });

  it("isolates onReady failures and rejects late registration", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      _testMode: true,
    });
    const order: string[] = [];
    const error = vi.fn();
    app.setLogger(() => ({ error }));

    app.onReady(() => {
      order.push("first");
      throw new Error("ready failed");
    });
    app.onReady(() => {
      order.push("second");
    });

    await internals.runReady();

    expect(order).toEqual(["first", "second"]);
    expect(error).toHaveBeenCalledWith(
      { error: "ready failed" },
      "[vextjs] onReady hook failed",
    );
    expect(() => app.onReady(() => undefined)).toThrow(
      "[vextjs] app.onReady() cannot be registered after readiness has started.",
    );
  });

  it("coalesces concurrent runReady calls on one shared promise", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      _testMode: true,
    });
    let release!: () => void;
    const hook = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    app.onReady(hook);

    const first = internals.runReady();
    const second = internals.runReady();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(hook).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("emits ready and close hooks with stable runtime mode metadata", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      _testMode: true,
    });
    const ready: Array<{ mode?: string; source?: string; phase: string }> = [];
    const close: Array<{ mode?: string; source?: string; phase: string }> = [];

    app.hooks.on("app:ready", (payload) => ready.push(payload));
    app.hooks.on("app:close", (payload) => close.push(payload));

    await internals.runReady();
    await internals.shutdown(undefined, { skipExit: true });

    expect(ready).toEqual([
      expect.objectContaining({
        phase: "before",
        mode: "test",
        source: "test-app",
      }),
      expect.objectContaining({
        phase: "after",
        mode: "test",
        source: "test-app",
      }),
    ]);
    expect(close).toEqual([
      expect.objectContaining({
        phase: "before",
        mode: "test",
        source: "test-app",
      }),
      expect.objectContaining({
        phase: "after",
        mode: "test",
        source: "test-app",
      }),
    ]);
  });

  it("allows dev bootstrap to disclose development lifecycle mode", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      _runtimeMode: "development",
    });
    const ready: Array<{ mode?: string; source?: string }> = [];
    app.hooks.on("app:ready", (payload) => ready.push(payload));

    await internals.runReady();
    await internals.shutdown(undefined, { skipExit: true });

    expect(ready.map((payload) => payload.mode)).toEqual([
      "development",
      "development",
    ]);
    expect(ready.map((payload) => payload.source)).toEqual([
      "dev-worker",
      "dev-worker",
    ]);
  });

  it("coalesces shutdown, rejects late onClose registration, and reports server close failure after cleanup", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      _testMode: true,
    });
    const error = vi.fn();
    const closeHook = vi.fn();
    let lateRegistrationError: unknown;
    app.setLogger(() => ({ error }));
    app.onClose(() => {
      try {
        app.onClose(() => undefined);
      } catch (err) {
        lateRegistrationError = err;
      }
      closeHook();
    });

    const serverHandle = {
      port: 0,
      host: "127.0.0.1",
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    };

    const first = internals.shutdown(serverHandle, { skipExit: true });
    const second = internals.shutdown(serverHandle, { skipExit: true });

    expect(second).toBe(first);
    await expect(first).rejects.toThrow("close failed");
    await expect(second).rejects.toThrow("close failed");
    await expect(
      internals.shutdown(serverHandle, { skipExit: true }),
    ).resolves.toBeUndefined();

    expect(serverHandle.close).toHaveBeenCalledTimes(1);
    expect(closeHook).toHaveBeenCalledTimes(1);
    expect(lateRegistrationError).toBeInstanceOf(Error);
    expect(() => app.onClose(() => undefined)).toThrow(
      "[vextjs] app.onClose() cannot be registered after shutdown has started.",
    );
    expect(error).toHaveBeenCalledWith(
      { error: "close failed" },
      "[vextjs] server close failed during shutdown",
    );
  });

  it("applies one absolute shutdown deadline and still invokes remaining cleanup", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      shutdown: { timeout: 0.01 },
      _testMode: true,
    });
    const warn = vi.fn();
    const order: string[] = [];
    let releaseBefore!: () => void;
    const beforeBarrier = new Promise<void>((resolve) => {
      releaseBefore = resolve;
    });
    app.setLogger(() => ({ warn }));
    app.hooks.on("app:close", async ({ phase }) => {
      order.push(`hook:${phase}`);
      if (phase === "before") await beforeBarrier;
    });
    app.onClose(() => {
      order.push("close:first");
    });
    app.onClose(() => {
      order.push("close:second");
    });
    const cacheClose = vi.fn(() => {
      order.push("cache");
    });
    (app.cache._getResponseCache() as { close?: () => void }).close =
      cacheClose;
    const serverHandle = {
      port: 0,
      host: "127.0.0.1",
      close: vi.fn(() => {
        order.push("server");
        return Promise.resolve();
      }),
    };

    const shutdown = internals.shutdown(serverHandle, { skipExit: true });
    const outcome = await Promise.race([
      shutdown.then(() => "shutdown" as const),
      new Promise<"watchdog">((resolve) =>
        setTimeout(() => resolve("watchdog"), 100),
      ),
    ]);
    releaseBefore();
    await shutdown;

    expect(outcome).toBe("shutdown");
    expect(serverHandle.close).toHaveBeenCalledOnce();
    expect(cacheClose).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "hook:before",
      "server",
      "close:second",
      "close:first",
      "cache",
      "hook:after",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "app:close before" }),
      expect.stringContaining("shutdown deadline exceeded"),
    );
    await expect(
      internals.shutdown(serverHandle, { skipExit: true }),
    ).resolves.toBeUndefined();
    expect(serverHandle.close).toHaveBeenCalledOnce();
  });

  it("observes a timed-out onClose rejection while later cleanup still runs", async () => {
    const { app, internals } = createApp({
      ...DEFAULT_CONFIG,
      shutdown: { timeout: 0.01 },
      _testMode: true,
    });
    const error = vi.fn();
    const order: string[] = [];
    let releaseBlocking!: () => void;
    let rejectBlocking!: (error: Error) => void;
    const blocking = new Promise<void>((resolve, reject) => {
      releaseBlocking = resolve;
      rejectBlocking = reject;
    });
    app.setLogger(() => ({ error }));
    app.onClose(() => {
      order.push("remaining");
    });
    app.onClose(() => {
      order.push("blocking");
      return blocking;
    });
    const cacheClose = vi.fn(() => {
      order.push("cache");
    });
    (app.cache._getResponseCache() as { close?: () => void }).close =
      cacheClose;

    const shutdown = internals.shutdown(undefined, { skipExit: true });
    const outcome = await Promise.race([
      shutdown.then(() => "shutdown" as const),
      new Promise<"watchdog">((resolve) =>
        setTimeout(() => resolve("watchdog"), 100),
      ),
    ]);
    if (outcome === "watchdog") {
      releaseBlocking();
      await shutdown;
    } else {
      rejectBlocking(new Error("late cleanup failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(outcome).toBe("shutdown");
    expect(order).toEqual(["blocking", "remaining", "cache"]);
    expect(cacheClose).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "late cleanup failure",
        stage: "onClose hook 1",
      }),
      "[vextjs] onClose hook failed after shutdown deadline",
    );
  });

  it("validates request ids from headers and custom generators", async () => {
    const next = vi.fn();
    const setHeader = vi.fn();
    const fromHeaderReq = {
      headers: { "x-request-id": ["header-id", "second"] },
    };
    const headerMiddleware = createRequestIdMiddleware({}, () => null);

    await headerMiddleware(
      fromHeaderReq as never,
      { setHeader } as never,
      next,
    );

    expect(fromHeaderReq).toMatchObject({ requestId: "header-id" });
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "header-id");
    expect(next).toHaveBeenCalledTimes(1);

    const invalidMiddleware = createRequestIdMiddleware(
      {},
      () => () => "bad\n",
    );
    await expect(
      invalidMiddleware({ headers: {} } as never, { setHeader } as never, next),
    ).rejects.toThrow(
      "[vextjs] requestId must not contain control characters.",
    );
  });
});
