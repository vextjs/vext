import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  defineRoutes,
  executeRouteFactory,
} from "../../src/lib/define-routes.js";
import type { VextApp } from "../../src/types/app.js";
import type { RouteFactory } from "../../src/types/route.js";

function createMinimalApp(): VextApp {
  return {
    config: {},
    services: {},
    logger: {},
    adapter: {},
    throw: () => {
      throw new Error("app.throw");
    },
  } as unknown as VextApp;
}

describe("defineRoutes runtime boundary", () => {
  if (false) {
    // @ts-expect-error Route factories must be synchronous.
    defineRoutes(async (_app) => undefined);
  }

  it("rejects a non-function factory at the public boundary", () => {
    expect(() => defineRoutes(null as never)).toThrow(
      "[vextjs] defineRoutes(factory) expects a function.",
    );
  });

  it("rejects native async factories before executing their body", () => {
    let executed = false;
    const factory = (async () => {
      executed = true;
    }) as unknown as RouteFactory;

    expect(() => defineRoutes(factory)).toThrow(
      "defineRoutes(factory) requires a synchronous factory",
    );
    expect(executed).toBe(false);
  });

  it("rejects generator factories before executing their body", () => {
    let executed = false;
    const factory = function* () {
      executed = true;
    } as unknown as RouteFactory;

    expect(() => defineRoutes(factory)).toThrow(
      "defineRoutes(factory) requires a synchronous factory",
    );
    expect(executed).toBe(false);
  });

  it("rejects thenable results transactionally and restores HTTP methods", () => {
    const app = createMinimalApp();
    const originalGet = () => {
      throw new Error("placeholder get");
    };
    (app as unknown as Record<string, unknown>).get = originalGet;

    const factory = ((routeApp: VextApp) => {
      routeApp.get("/partial", async () => undefined);
      return Promise.resolve();
    }) as unknown as RouteFactory;
    const routeDef = defineRoutes(factory);

    expect(() => executeRouteFactory(routeDef, app)).toThrow(
      "defineRoutes(factory) requires a synchronous factory",
    );
    expect(routeDef.routes).toEqual([]);
    expect((app as unknown as Record<string, unknown>).get).toBe(originalGet);
  });

  it("closes the isolated registrar before fire-and-forget continuations run", async () => {
    const app = createMinimalApp();
    let runtimeGetCalls = 0;
    (app as unknown as Record<string, unknown>).get = () => {
      runtimeGetCalls += 1;
    };
    let capturedApp: VextApp | undefined;
    let release!: () => void;
    let lateError: unknown;
    const continuation = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      try {
        capturedApp!.get("/late", async () => undefined);
      } catch (error) {
        lateError = error;
      }
    });
    const routeDef = defineRoutes((routeApp) => {
      routeApp.get("/early", ((capturedApp = routeApp), async () => undefined));
      void continuation;
    });

    executeRouteFactory(routeDef, app);
    release();
    await continuation;

    expect(routeDef.routes.map((route) => route.path)).toEqual(["/early"]);
    expect(runtimeGetCalls).toBe(0);
    expect(lateError).toBeInstanceOf(Error);
    expect((lateError as Error).message).toContain("registrar is closed");
  });

  it("rejects non-undefined synchronous factory results transactionally", () => {
    const routeDef = defineRoutes(((_app) => {
      return "unexpected";
    }) as unknown as RouteFactory);

    expect(() => executeRouteFactory(routeDef, createMinimalApp())).toThrow(
      "must return undefined",
    );
    expect(routeDef.routes).toEqual([]);
  });

  it("rejects invalid collector path, options, and handler inputs with Vext errors", () => {
    const cases = [
      {
        routeDef: defineRoutes((app) => {
          (app as any).get(42, async () => undefined);
        }),
        message: "GET route path must be a string",
      },
      {
        routeDef: defineRoutes((app) => {
          (app as any).post("/users", null, async () => undefined);
        }),
        message: 'POST "/users": route options must be a plain object',
      },
      {
        routeDef: defineRoutes((app) => {
          (app as any).put("/users", {}, "not-a-handler");
        }),
        message: 'PUT "/users": handler must be a function',
      },
    ];

    for (const item of cases) {
      expect(() =>
        executeRouteFactory(item.routeDef, createMinimalApp()),
      ).toThrow(item.message);
    }
  });

  it.each([
    [
      "bracket access",
      (app: VextApp) => {
        (app as any)["get"]("/bracket", async () => undefined);
      },
    ],
    [
      "method extraction",
      (app: VextApp) => {
        const get = app.get.bind(app);
        get("/extracted", async () => undefined);
      },
    ],
    [
      "destructuring",
      (app: VextApp) => {
        const { get } = app;
        get("/destructured", async () => undefined);
      },
    ],
    [
      "helper registration",
      (app: VextApp) => {
        registerRouteThroughHelper(app);
      },
    ],
  ])("rejects non-canonical runtime registration: %s", (_label, factory) => {
    expect(() => defineRoutes(factory)).toThrow(/direct top-level statement/u);
  });

  it("accepts the top-level comma sequence emitted by minified CJS builds", () => {
    const factory = runInNewContext(`
      (app) => {
        app.get("/compiled-a", async () => undefined),
        app.post("/compiled-b", async () => undefined)
      }
    `) as RouteFactory;
    const routeDef = defineRoutes(factory);

    executeRouteFactory(routeDef, createMinimalApp());

    expect(routeDef.routes.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/compiled-a"],
      ["POST", "/compiled-b"],
    ]);
  });

  it("accepts a compiler-lowered non-registrar prefix before direct routes", () => {
    const factory = runInNewContext(`
      (app) => {
        false && app.setRateLimiter({ check: async () => ({ allowed: true }) }),
        app.get("/compiled-after-config", async () => undefined)
      }
    `) as RouteFactory;
    const routeDef = defineRoutes(factory);

    executeRouteFactory(routeDef, createMinimalApp());

    expect(routeDef.routes.map((route) => route.path)).toEqual([
      "/compiled-after-config",
    ]);
  });

  it("still rejects a compiler-lowered conditional route registration", () => {
    const factory = runInNewContext(`
      (app) => {
        true && app.get("/compiled-conditional", async () => undefined)
      }
    `) as RouteFactory;

    expect(() => defineRoutes(factory)).toThrow(/direct top-level statement/u);
  });

  it("allows non-registrar app capabilities without weakening route grammar", () => {
    const app = createMinimalApp();
    let limiterConfigured = false;
    app.setRateLimiter = () => {
      limiterConfigured = true;
    };
    const enableLimiter = true;
    const routeDef = defineRoutes((routeApp) => {
      if (enableLimiter) {
        routeApp.setRateLimiter({
          async check() {
            return { allowed: true, remaining: 1, resetAt: 1 };
          },
        });
      }
      routeApp.get("/configured", async () => undefined);
    });

    executeRouteFactory(routeDef, app);

    expect(limiterConfigured).toBe(true);
    expect(routeDef.routes.map((route) => route.path)).toEqual(["/configured"]);
  });

  it("keeps route factory internals out of the enumerable public shape", () => {
    const routeDef = defineRoutes((app) => {
      app.get("/health", async () => undefined);
    });

    expect(Object.keys(routeDef)).toEqual(["routes", "sourceFile", "register"]);
    expect(Object.prototype.hasOwnProperty.call(routeDef, "_factory")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(routeDef, "_collector")).toBe(
      false,
    );
    expect(
      Object.getOwnPropertyDescriptor(routeDef, "_factory"),
    ).toBeUndefined();

    executeRouteFactory(routeDef, createMinimalApp());
    executeRouteFactory(routeDef, createMinimalApp());

    expect(routeDef.routes).toHaveLength(1);
    expect(routeDef.routes[0]).toMatchObject({
      method: "GET",
      path: "/health",
    });
  });

  it("executes route factories through an isolated facade without replacing real HTTP methods", async () => {
    const app = createMinimalApp();
    const originalGet = () => {
      throw new Error("placeholder get");
    };
    (app as unknown as Record<string, unknown>).get = originalGet;
    app.services = { identity: "runtime-service" } as never;

    let factoryApp: VextApp | null = null;
    const routeDef = defineRoutes((routeApp) => {
      expect((app as unknown as Record<string, unknown>).get).toBe(originalGet);
      routeApp.get(
        "/identity",
        ((factoryApp = routeApp),
        async (req, res) => {
          res.json({
            sameApp: req.app === routeApp,
            service: routeApp.services.identity,
          });
        }),
      );
    });

    executeRouteFactory(routeDef, app);

    expect(factoryApp).not.toBe(app);
    expect((app as unknown as Record<string, unknown>).get).toBe(originalGet);
    expect(routeDef.routes).toHaveLength(1);

    const route = routeDef.routes[0];
    expect(route).toBeDefined();

    let body: unknown = null;
    await route!.handler(
      { app } as never,
      {
        json(value: unknown) {
          body = value;
        },
      } as never,
    );

    expect(body).toEqual({
      sameApp: false,
      service: "runtime-service",
    });
  });
});

function registerRouteThroughHelper(app: VextApp): void {
  app.get("/helper", async () => undefined);
}
