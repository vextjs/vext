import { describe, expect, it, vi } from "vitest";
import { createCsrfMiddleware, csrf } from "../../../src/lib/csrf.js";
import { serializeCookie } from "../../../src/lib/cookies.js";
import { HttpError } from "../../../src/types/errors.js";
import type { VextConfig, RouteOptions } from "../../../src/types/app.js";
import type { VextCookieJar } from "../../../src/types/cookies.js";
import type { VextRequest } from "../../../src/types/request.js";
import type { VextResponse } from "../../../src/types/response.js";

function createReq(
  options: {
    method?: string;
    headers?: Record<string, string | undefined>;
    body?: unknown;
    cookies?: VextCookieJar;
    session?: Record<string, unknown>;
    csrf?: VextConfig["csrf"];
    routeOptions?: RouteOptions;
  } = {},
): VextRequest {
  const cookies = options.cookies ?? {};
  const headers = options.headers ?? {};
  return {
    requestId: "req-1",
    method: options.method ?? "GET",
    url: "/",
    path: "/",
    route: "/",
    query: {},
    params: {},
    headers,
    cookies,
    cookie(name: string) {
      return cookies[name];
    },
    csrfToken() {
      throw new Error("csrf middleware not attached");
    },
    body: options.body,
    app: { config: { csrf: options.csrf } } as any,
    ip: "127.0.0.1",
    protocol: "http",
    valid: vi.fn(),
    onClose: vi.fn(),
    session: options.session as any,
    _routeOptions: options.routeOptions,
    _getRawBody: vi.fn(),
    _getRawBodyBuffer: vi.fn(),
  } as VextRequest;
}

function createRes(): VextResponse & {
  setCookies: string[];
  headers: Record<string, string | string[]>;
} {
  const res: any = {
    setCookies: [],
    headers: {},
    statusCode: 200,
    json: vi.fn(),
    rawJson: vi.fn(),
    text: vi.fn(),
    render: vi.fn(),
    renderError: vi.fn(),
    stream: vi.fn(),
    download: vi.fn(),
    redirect: vi.fn(),
    status: vi.fn(() => res),
    setHeader: vi.fn((name: string, value: string | string[]) => {
      res.headers[name] = value;
      return res;
    }),
    cookie: vi.fn((name: string, value: string, options) => {
      res.setCookies.push(serializeCookie(name, value, options));
      return res;
    }),
    clearCookie: vi.fn(() => res),
    _enableWrap: vi.fn(),
  };
  return res;
}

function expectHttpError(error: unknown, code: string, status = 403): void {
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  expect((error as HttpError).code).toBe(code);
}

function extractCookieValue(cookie: string, name: string): string {
  const match = new RegExp(`^${name}=([^;]+)`).exec(cookie);
  if (!match) throw new Error(`missing ${name} in ${cookie}`);
  return match[1]!;
}

describe("csrf middleware", () => {
  it("exports csrf as createCsrfMiddleware alias", () => {
    expect(csrf).toBe(createCsrfMiddleware);
  });

  it("signs a stable double-submit token and marks response no-store", async () => {
    const req = createReq({
      csrf: { mode: "signed-cookie", secret: "secret" },
    });
    const res = createRes();
    const middleware = createCsrfMiddleware();

    await middleware(req, res, async () => {
      const first = req.csrfToken();
      const second = req.csrfToken();
      expect(second).toBe(first);
      expect(first).toHaveLength(43);
    });

    expect(res.setCookies).toHaveLength(1);
    expect(res.setCookies[0]).toContain("vext.csrf=");
    expect(res.setCookies[0]).toContain("SameSite=Lax");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("keeps manual csrf() enabled even when app config auto-registration is disabled", async () => {
    const req = createReq({
      csrf: { enabled: false, mode: "signed-cookie", secret: "secret" },
    });
    const res = createRes();

    await createCsrfMiddleware()(req, res, async () => {
      expect(req.csrfToken()).toHaveLength(43);
    });

    expect(res.setCookies).toHaveLength(1);
  });

  it("accepts a valid session synchronizer token", async () => {
    const session: Record<string, unknown> = {};
    const getReq = createReq({ session, csrf: { mode: "session" } });
    const getRes = createRes();
    const middleware = createCsrfMiddleware();

    await middleware(getReq, getRes, async () => {
      expect(getReq.csrfToken()).toHaveLength(43);
    });

    const postReq = createReq({
      method: "POST",
      session,
      headers: { "x-csrf-token": getReq.csrfToken() },
      csrf: { mode: "session" },
    });
    const postRes = createRes();
    const next = vi.fn();

    await middleware(postReq, postRes, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts a valid signed double-submit cookie token", async () => {
    const getReq = createReq({
      csrf: { mode: "signed-cookie", secret: "secret" },
    });
    const getRes = createRes();
    const middleware = createCsrfMiddleware();

    await middleware(getReq, getRes, async () => {
      getReq.csrfToken();
    });

    const cookieValue = extractCookieValue(getRes.setCookies[0]!, "vext.csrf");
    const token = cookieValue.split(".")[0]!;
    const postReq = createReq({
      method: "POST",
      cookies: { "vext.csrf": cookieValue },
      headers: { "x-csrf-token": token },
      csrf: { mode: "signed-cookie", secret: "secret" },
    });
    const postRes = createRes();
    const next = vi.fn();

    await middleware(postReq, postRes, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects unsafe requests with missing or invalid tokens", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
    });
    const missingReq = createReq({ method: "POST" });

    await expect(
      middleware(missingReq, createRes(), vi.fn()),
    ).rejects.toSatisfy((error: unknown) => {
      expectHttpError(error, "CSRF_TOKEN_MISSING");
      return true;
    });

    const getReq = createReq();
    const getRes = createRes();
    await middleware(getReq, getRes, async () => {
      getReq.csrfToken();
    });
    const cookieValue = extractCookieValue(getRes.setCookies[0]!, "vext.csrf");

    await expect(
      middleware(
        createReq({
          method: "POST",
          cookies: { "vext.csrf": cookieValue },
          headers: { "x-csrf-token": "tampered" },
        }),
        createRes(),
        vi.fn(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectHttpError(error, "CSRF_TOKEN_INVALID");
      return true;
    });
  });

  it("rejects cross-site unsafe requests with Fetch Metadata", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
    });

    await expect(
      middleware(
        createReq({
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
        createRes(),
        vi.fn(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectHttpError(error, "CSRF_FETCH_METADATA_REJECTED");
      return true;
    });
  });

  it("supports body token fallback and route csrf:false skip", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
    });
    const getReq = createReq();
    const getRes = createRes();
    await middleware(getReq, getRes, async () => {
      getReq.csrfToken();
    });

    const cookieValue = extractCookieValue(getRes.setCookies[0]!, "vext.csrf");
    const token = cookieValue.split(".")[0]!;
    const bodyReq = createReq({
      method: "POST",
      cookies: { "vext.csrf": cookieValue },
      body: { _csrf: token },
    });
    const bodyNext = vi.fn();
    await middleware(bodyReq, createRes(), bodyNext);
    expect(bodyNext).toHaveBeenCalledOnce();

    const skipNext = vi.fn();
    await middleware(
      createReq({ method: "POST", routeOptions: { csrf: false } }),
      createRes(),
      skipNext,
    );
    expect(skipNext).toHaveBeenCalledOnce();
  });

  it("rejects untrusted origins when origin checking is enabled", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
      origin: { trustedOrigins: ["https://trusted.example"] },
    });

    await expect(
      middleware(
        createReq({
          method: "POST",
          headers: {
            origin: "https://evil.example",
            host: "app.example",
          },
        }),
        createRes(),
        vi.fn(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectHttpError(error, "CSRF_ORIGIN_REJECTED");
      return true;
    });
  });

  it("rejects opaque, malformed, and non-origin Origin headers without falling back to Referer", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
      origin: { trustedOrigins: ["http://localhost"] },
    });

    for (const origin of [
      "null",
      "not a url",
      "https://trusted.example/path",
    ]) {
      await expect(
        middleware(
          createReq({
            method: "POST",
            headers: {
              origin,
              referer: "http://localhost/safe",
            },
          }),
          createRes(),
          vi.fn(),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expectHttpError(error, "CSRF_ORIGIN_REJECTED");
        return true;
      });
    }
  });

  it("uses Referer only when Origin is absent", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
      origin: { trustedOrigins: [] },
    });

    await expect(
      middleware(
        createReq({
          method: "POST",
          headers: {
            referer: "https://evil.example/form",
            host: "app.example",
          },
        }),
        createRes(),
        vi.fn(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectHttpError(error, "CSRF_ORIGIN_REJECTED");
      return true;
    });
  });

  it("normalizes explicitly trusted origins before comparison", async () => {
    const middleware = createCsrfMiddleware({
      mode: "signed-cookie",
      secret: "secret",
      origin: { trustedOrigins: ["https://TRUSTED.EXAMPLE:443/"] },
    });
    const getReq = createReq();
    const getRes = createRes();
    await middleware(getReq, getRes, async () => {
      getReq.csrfToken();
    });
    const cookieValue = extractCookieValue(getRes.setCookies[0]!, "vext.csrf");
    const token = cookieValue.split(".")[0]!;
    const next = vi.fn();

    await middleware(
      createReq({
        method: "POST",
        cookies: { "vext.csrf": cookieValue },
        headers: {
          origin: "https://trusted.example",
          "x-csrf-token": token,
          host: "app.example",
        },
      }),
      createRes(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });
});
