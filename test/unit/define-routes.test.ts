import { describe, expect, it } from "vitest";
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

  it("executes route factories with the real app identity and restores HTTP methods", async () => {
    const app = createMinimalApp();
    const originalGet = () => {
      throw new Error("placeholder get");
    };
    (app as unknown as Record<string, unknown>).get = originalGet;
    app.services = { identity: "runtime-service" } as never;

    let factoryApp: VextApp | null = null;
    const routeDef = defineRoutes((routeApp) => {
      factoryApp = routeApp;
      routeApp.get("/identity", async (req, res) => {
        res.json({
          sameApp: req.app === routeApp,
          service: routeApp.services.identity,
        });
      });
    });

    executeRouteFactory(routeDef, app);

    expect(factoryApp).toBe(app);
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
      sameApp: true,
      service: "runtime-service",
    });
  });
});
