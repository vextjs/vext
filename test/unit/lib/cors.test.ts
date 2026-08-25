import { describe, expect, it, vi } from "vitest";
import { createCorsMiddleware } from "../../../src/lib/middlewares/cors.js";
import type { VextRequest } from "../../../src/types/request.js";
import type { VextResponse } from "../../../src/types/response.js";

function createReq(routeCors?: Record<string, unknown>): VextRequest {
  return {
    method: "GET",
    headers: { origin: "https://route.example" },
    _routeOptions: routeCors ? { override: { cors: routeCors } } : {},
  } as unknown as VextRequest;
}

function createRes(): VextResponse & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status: vi.fn(() => res),
    text: vi.fn(),
  } as unknown as VextResponse & { headers: Record<string, string> };
  return res;
}

describe("CORS route overrides", () => {
  it("rejects wildcard origins combined with credentials at runtime creation", () => {
    expect(() =>
      createCorsMiddleware({ origins: ["*"], credentials: true }),
    ).toThrow("cannot combine credentials: true with wildcard origin");
  });

  it("defensively rejects an invalid route override", async () => {
    const middleware = createCorsMiddleware({
      enabled: true,
      origins: ["https://global.example"],
      credentials: false,
    });

    await expect(
      middleware(
        createReq({ origins: ["*"], credentials: true }),
        createRes(),
        vi.fn(),
      ),
    ).rejects.toThrow("cannot combine credentials: true with wildcard origin");
  });

  it("overrides the global origin policy for one route", async () => {
    const middleware = createCorsMiddleware({
      enabled: true,
      origins: ["https://global.example"],
    });
    const req = createReq({ origins: ["https://route.example"] });
    const res = createRes();

    await middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://route.example",
    );
    expect(res.headers.vary).toBe("Origin");
  });

  it("can disable CORS for one route", async () => {
    const middleware = createCorsMiddleware({ enabled: true, origins: ["*"] });
    const req = createReq({ enabled: false });
    const res = createRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a route override to enable globally disabled CORS", async () => {
    const middleware = createCorsMiddleware({ enabled: false });
    const req = createReq({ enabled: true, origins: ["*"] });
    const res = createRes();

    await middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
