/**
 * route-cache 响应缓存中间件单元测试
 *
 * 测试覆盖：
 *   - normalizeCacheOptions：false / number / object / ttl<=0 / undefined
 *   - defaultCacheKey：静态路径 / 动态参数 / query 排序 / vary headers / 空 query
 *   - 响应缓存中间件：HIT 返回缓存 / MISS 走 handler / condition 跳过 / 空 key 跳过
 *   - X-Cache 响应头：HIT / MISS
 *   - Cache-Control 响应头
 *   - 204 不缓存
 *   - 非 2xx 不缓存
 *
 * @see 15-route-cache.md §10.2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeCacheOptions,
  defaultCacheKey,
  buildRouteCacheMiddleware,
} from "../../src/lib/middlewares/route-cache.js";
import { applySecurityHeaders } from "../../src/lib/security-headers.js";
import { createResponseCache } from "response-cache-kit";
import type { VextRequest } from "../../src/types/request.js";
import type { VextResponse } from "../../src/types/response.js";

// ── 测试辅助 ────────────────────────────────────────────────

/**
 * 创建 mock VextRequest
 */
function createMockReq(overrides: Partial<VextRequest> = {}): VextRequest {
  return {
    method: "GET",
    path: "/products",
    url: "/products",
    query: {},
    body: undefined,
    params: {},
    headers: {},
    cookies: {},
    cookie(name: string) {
      return (this.cookies as Record<string, string>)[name];
    },
    requestId: "test-req-id",
    ip: "127.0.0.1",
    protocol: "http",
    app: {} as any,
    valid: vi.fn(),
    ...overrides,
  } as VextRequest;
}

/**
 * 创建 mock VextResponse（追踪 json/setHeader 调用）
 */
function createMockRes(): VextResponse & {
  _jsonCalls: Array<{ data: unknown; status?: number }>;
  _htmlCalls: Array<{
    html: string;
    status: number;
    headers: Record<string, string>;
    kind: "html" | "render";
  }>;
  _renderCalls: Array<{
    payload: unknown;
    status: number;
    headers: Record<string, string>;
  }>;
  _headerCalls: Array<{ name: string; value: string | string[] }>;
  _statusVal: number;
} {
  const res: any = {
    _jsonCalls: [],
    _htmlCalls: [],
    _renderCalls: [],
    _headerCalls: [],
    _headers: {},
    _statusVal: 200,
    _onSend: undefined,
    json(data: unknown, status?: number) {
      // Mirror adapter order: _onBeforeSend (session) then _onSend (route-cache).
      const finalStatus = status ?? res._statusVal;
      const headers = { ...res._headers };
      res._onBeforeSend?.("json", data, finalStatus, headers);
      if (res._onSend) {
        res._onSend(data, finalStatus, headers);
      }
      Object.assign(res._headers, headers);
      res._jsonCalls.push({ data, status: finalStatus });
    },
    rawJson(data: unknown, status?: number) {
      res._jsonCalls.push({ data, status });
    },
    text(_content: string, _status?: number) {},
    _sendHtml(
      html: string,
      status: number,
      headers: Record<string, string>,
      kind: "html" | "render",
    ) {
      res._statusVal = status;
      Object.assign(res._headers, headers);
      res._htmlCalls.push({ html, status, headers, kind });
    },
    _renderCached(
      payload: unknown,
      status: number,
      headers: Record<string, string>,
    ) {
      res._statusVal = status;
      Object.assign(res._headers, headers);
      res._renderCalls.push({ payload, status, headers });
    },
    stream(_readable: any, _contentType?: string) {},
    download(_readable: any, _filename: string, _contentType?: string) {},
    redirect(_url: string, _status?: number) {},
    status(code: number) {
      res._statusVal = code;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      res._headers[name] = value;
      res._headerCalls.push({ name, value });
      return res;
    },
    cookie(name: string, value: string) {
      const current = res._headers["Set-Cookie"];
      res._headers["Set-Cookie"] = Array.isArray(current)
        ? [...current, `${name}=${value}`]
        : current
          ? [current, `${name}=${value}`]
          : `${name}=${value}`;
      return res;
    },
    clearCookie(name: string) {
      return res.cookie(name, "");
    },
    get statusCode() {
      return res._statusVal;
    },
    _enableWrap() {},
  };
  return res;
}

function getMockHeader(
  res: { _headers: Record<string, string | string[]> },
  name: string,
): string | string[] | undefined {
  const wanted = name.toLowerCase();
  const found = Object.entries(res._headers).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return found?.[1];
}

// ── normalizeCacheOptions 测试 ────────────────────────────

describe("normalizeCacheOptions", () => {
  it("undefined → null", () => {
    expect(normalizeCacheOptions(undefined)).toBeNull();
  });

  it("false → null", () => {
    expect(normalizeCacheOptions(false)).toBeNull();
  });

  it("0 → null", () => {
    expect(normalizeCacheOptions(0)).toBeNull();
  });

  it("负数 → null", () => {
    expect(normalizeCacheOptions(-5)).toBeNull();
  });

  it("正数 → { ttl: number }", () => {
    const result = normalizeCacheOptions(60);
    expect(result).toEqual({ ttl: 60 });
  });

  it("对象形式正常返回", () => {
    const opts = { ttl: 300, vary: ["accept-language"] as string[] };
    const result = normalizeCacheOptions(opts);
    expect(result).toEqual(opts);
  });

  it("对象形式 ttl <= 0 → null", () => {
    expect(normalizeCacheOptions({ ttl: 0 })).toBeNull();
    expect(normalizeCacheOptions({ ttl: -1 })).toBeNull();
  });

  it("对象形式 ttl 未设置时使用 globalDefaultTtl", () => {
    const result = normalizeCacheOptions({ ttl: 0 as any, vary: [] }, 120);
    // ttl=0 → will use globalDefaultTtl if ttl is falsy
    expect(result).toEqual({ ttl: 120, vary: [] });
  });
});

describe("buildRouteCacheMiddleware response-cache-kit delegation", () => {
  function createMiddleware(options = { ttl: 60_000 }) {
    const cache = createResponseCache({
      namespace: "test-vext",
      ttl: 60_000,
      cacheHub: { enableStats: true },
    });
    const middleware = buildRouteCacheMiddleware(options, () => cache);
    if (!middleware) throw new Error("middleware not created");
    return { cache, middleware };
  }

  it("MISS 调用 handler 并写入 response-cache-kit，下一次 HIT 跳过 handler", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    const next = vi.fn(async () => {
      firstRes.json({ value: "origin" }, 200);
    });
    const hitNext = vi.fn();

    await middleware(req, firstRes, next);
    await middleware(req, secondRes, hitNext);

    expect(next).toHaveBeenCalledTimes(1);
    expect(hitNext).not.toHaveBeenCalled();
    expect(firstRes._headerCalls).toContainEqual({
      name: "X-Cache",
      value: "MISS",
    });
    expect(secondRes._headerCalls).toContainEqual({
      name: "X-Cache",
      value: "HIT",
    });
    expect(secondRes._headers["x-cache"]).toBeUndefined();
    expect(secondRes._headers["X-Cache"]).toBe("HIT");
    expect(secondRes._jsonCalls[0]).toEqual({
      data: { value: "origin" },
      status: 200,
    });
  });

  it("MISS 写入的 Security Headers 会在下一次 HIT 响应中保留", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq({ path: "/products/security-headers" });
    const firstRes = createMockRes();
    const hitRes = createMockRes();
    const next = vi.fn(async () => {
      applySecurityHeaders(req, firstRes, {
        enabled: true,
        preset: "basic",
      });
      firstRes.json({ value: "origin" }, 200);
    });
    const hitNext = vi.fn();

    await middleware(req, firstRes, next);
    await middleware(req, hitRes, hitNext);

    expect(next).toHaveBeenCalledTimes(1);
    expect(hitNext).not.toHaveBeenCalled();
    expect(getMockHeader(firstRes, "X-Content-Type-Options")).toBe("nosniff");
    expect(getMockHeader(hitRes, "X-Content-Type-Options")).toBe("nosniff");
    expect(getMockHeader(hitRes, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(getMockHeader(hitRes, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(getMockHeader(hitRes, "X-Cache")).toBe("HIT");
  });

  it("默认跳过带 Cookie 的请求缓存", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq({ headers: { cookie: "sid=1" } });
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    await middleware(req, firstRes, async () => {
      firstRes.json({ value: ++count }, 200);
    });
    await middleware(req, secondRes, async () => {
      secondRes.json({ value: ++count }, 200);
    });

    expect(count).toBe(2);
    expect(secondRes._jsonCalls[0]).toEqual({
      data: { value: 2 },
      status: 200,
    });
    expect(firstRes._headers["Cache-Control"]).toBe("no-store");
    expect(secondRes._headers["Cache-Control"]).toBe("no-store");
  });

  it("Cookie 请求缓存绕过对 header 大小写不敏感", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq({ headers: { Cookie: "sid=1" } as any });
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    await middleware(req, firstRes, async () => {
      firstRes.json({ value: ++count }, 200);
    });
    await middleware(req, secondRes, async () => {
      secondRes.json({ value: ++count }, 200);
    });

    expect(count).toBe(2);
    expect(firstRes._headers["Cache-Control"]).toBe("no-store");
    expect(secondRes._headers["Cache-Control"]).toBe("no-store");
  });

  it("allowCookieCache=true 时允许显式缓存 Cookie 请求", async () => {
    const { middleware } = createMiddleware({
      ttl: 60_000,
      allowCookieCache: true,
    });
    const req = createMockReq({ headers: { cookie: "sid=1" } });
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    await middleware(req, firstRes, async () => {
      firstRes.json({ value: ++count }, 200);
    });
    await middleware(req, secondRes, async () => {
      secondRes.json({ value: ++count }, 200);
    });

    expect(count).toBe(1);
    expect(secondRes._jsonCalls[0]).toEqual({
      data: { value: 1 },
      status: 200,
    });
  });

  it("Set-Cookie 响应不写入缓存", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    await middleware(req, firstRes, async () => {
      firstRes.setHeader("Set-Cookie", `sid=${++count}`);
      firstRes.json({ value: count }, 200);
    });
    await middleware(req, secondRes, async () => {
      secondRes.setHeader("Set-Cookie", `sid=${++count}`);
      secondRes.json({ value: count }, 200);
    });

    expect(count).toBe(2);
    expect(secondRes._jsonCalls[0]).toEqual({
      data: { value: 2 },
      status: 200,
    });
    expect(firstRes._headers["Cache-Control"]).toBe("no-store");
    expect(secondRes._headers["Cache-Control"]).toBe("no-store");
  });

  it("Session 在 _onBeforeSend 注入的 Set-Cookie 也不写入缓存", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    const attachSessionCookie = (res: VextResponse) => {
      res._onBeforeSend = (_kind, _data, _status, headers) => {
        const cookie = `vext.sid=s${++count}`;
        const current = headers["Set-Cookie"];
        headers["Set-Cookie"] = Array.isArray(current)
          ? [...current, cookie]
          : current
            ? [String(current), cookie]
            : cookie;
      };
    };

    await middleware(req, firstRes, async () => {
      attachSessionCookie(firstRes);
      firstRes.json({ value: 1 }, 200);
    });
    await middleware(req, secondRes, async () => {
      attachSessionCookie(secondRes);
      secondRes.json({ value: 2 }, 200);
    });

    expect(count).toBe(2);
    expect(secondRes._jsonCalls[0]).toEqual({
      data: { value: 2 },
      status: 200,
    });
    expect(firstRes._headers["Cache-Control"]).toBe("no-store");
    expect(secondRes._headers["Cache-Control"]).toBe("no-store");
    expect(String(firstRes._headers["Set-Cookie"])).toContain("vext.sid=");
  });

  it("Session 持久化未决时不写入缓存", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    const firstRes = createMockRes();
    const secondRes = createMockRes();
    let count = 0;

    await middleware(req, firstRes, async () => {
      firstRes._onBeforeSend = () => {
        firstRes._sessionCommitPending = true;
      };
      firstRes.json({ value: ++count }, 200);
    });
    await middleware(req, secondRes, async () => {
      secondRes._onBeforeSend = () => {
        secondRes._sessionCommitPending = true;
      };
      secondRes.json({ value: ++count }, 200);
    });

    expect(count).toBe(2);
    expect(firstRes._headers["Cache-Control"]).toBe("no-store");
    expect(secondRes._headers["Cache-Control"]).toBe("no-store");
  });

  it("使用毫秒 TTL，并把 Cache-Control max-age 转成秒", async () => {
    vi.useFakeTimers();
    try {
      const { middleware } = createMiddleware({ ttl: 2_000 });
      const req = createMockReq();
      const firstRes = createMockRes();
      const secondRes = createMockRes();
      const thirdRes = createMockRes();
      let count = 0;
      const next = vi.fn(async () => {
        count++;
        firstRes.json({ count }, 200);
      });
      const secondNext = vi.fn();
      const thirdNext = vi.fn(async () => {
        count++;
        thirdRes.json({ count }, 200);
      });

      await middleware(req, firstRes, next);
      await middleware(req, secondRes, secondNext);
      vi.advanceTimersByTime(2_001);
      await middleware(req, thirdRes, thirdNext);

      expect(secondNext).not.toHaveBeenCalled();
      expect(thirdNext).toHaveBeenCalledTimes(1);
      expect(firstRes._headerCalls).toContainEqual({
        name: "Cache-Control",
        value: "public, max-age=2",
      });
      expect(secondRes._headerCalls).toContainEqual({
        name: "Cache-Control",
        value: "public, max-age=2",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tags 可通过 app.cache.invalidate 对应的 response-cache-kit tag 失效", async () => {
    const cache = createResponseCache({ namespace: "test-tags" });
    const middleware = buildRouteCacheMiddleware(
      { ttl: 60_000, tags: ["products"] },
      () => cache,
    )!;
    const req = createMockReq();
    let count = 0;

    const missRes = createMockRes();
    await middleware(req, missRes, async () => {
      count++;
      missRes.json({ count }, 200);
    });

    await cache.invalidateTag("products");

    const nextRes = createMockRes();
    const next = vi.fn(async () => {
      count++;
      nextRes.json({ count }, 200);
    });
    await middleware(req, nextRes, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(nextRes._jsonCalls[0]?.data).toEqual({ count: 2 });
  });

  it("vary='*' 时所有请求头参与缓存隔离", async () => {
    const { middleware } = createMiddleware({ ttl: 60_000, vary: "*" });
    let count = 0;
    const reqZh = createMockReq({
      headers: { "accept-language": "zh-CN" },
    });
    const reqEn = createMockReq({
      headers: { "accept-language": "en-US" },
    });
    const zhRes = createMockRes();
    const enRes = createMockRes();

    await middleware(reqZh, zhRes, async () => {
      count++;
      zhRes.json({ count, lang: "zh" }, 200);
    });
    await middleware(reqEn, enRes, async () => {
      count++;
      enRes.json({ count, lang: "en" }, 200);
    });

    expect(count).toBe(2);
    expect(enRes._headerCalls).toContainEqual({
      name: "X-Cache",
      value: "MISS",
    });
  });

  it("Authorization 请求默认绕过缓存，配置 partitionKey 后按分区缓存", async () => {
    const bypass = createMiddleware({ ttl: 60_000 });
    const authReq = createMockReq({
      headers: { authorization: "Bearer a" },
    });
    let bypassCount = 0;
    for (const value of [1, 2]) {
      const res = createMockRes();
      await bypass.middleware(authReq, res, async () => {
        bypassCount++;
        res.json({ value }, 200);
      });
    }
    expect(bypassCount).toBe(2);

    const partitioned = createMiddleware({
      ttl: 60_000,
      partitionKey: (req) => req.headers.authorization,
    });
    const firstRes = createMockRes();
    const hitRes = createMockRes();
    const next = vi.fn(async () => {
      firstRes.json({ value: "private" }, 200);
    });
    const hitNext = vi.fn();

    await partitioned.middleware(authReq, firstRes, next);
    await partitioned.middleware(authReq, hitRes, hitNext);

    expect(next).toHaveBeenCalledTimes(1);
    expect(hitNext).not.toHaveBeenCalled();
    expect(hitRes._headerCalls).toContainEqual({
      name: "X-Cache",
      value: "HIT",
    });
  });

  it("Set-Cookie / no-store / private 响应不缓存", async () => {
    const cases = [
      ["Set-Cookie", "sid=1"],
      ["Cache-Control", "no-store"],
      ["Cache-Control", "private"],
    ] as const;

    for (const [name, value] of cases) {
      const { middleware } = createMiddleware();
      const req = createMockReq({ path: `/policy-${name}-${value}` });
      let count = 0;

      for (let i = 0; i < 2; i++) {
        const res = createMockRes();
        await middleware(req, res, async () => {
          count++;
          res.setHeader(name, value);
          res.json({ count }, 200);
        });
      }

      expect(count).toBe(2);
    }
  });

  it("静态 key 支持 partitionKey 与 vary 继续参与隔离", async () => {
    const { middleware } = createMiddleware({
      ttl: 60_000,
      key: "products:list",
      vary: ["accept-language"],
      partitionKey: (req) => req.headers["x-tenant-id"],
    });
    let count = 0;

    const tenantAReq = createMockReq({
      headers: { "x-tenant-id": "tenant-a", "accept-language": "zh-CN" },
    });
    const tenantBReq = createMockReq({
      headers: { "x-tenant-id": "tenant-b", "accept-language": "zh-CN" },
    });
    const tenantAEnReq = createMockReq({
      headers: { "x-tenant-id": "tenant-a", "accept-language": "en-US" },
    });

    for (const req of [tenantAReq, tenantBReq, tenantAEnReq]) {
      const res = createMockRes();
      await middleware(req, res, async () => {
        count++;
        res.json({ count }, 200);
      });
    }

    const hitRes = createMockRes();
    const hitNext = vi.fn();
    await middleware(tenantAReq, hitRes, hitNext);

    expect(count).toBe(3);
    expect(hitNext).not.toHaveBeenCalled();
    expect(hitRes._jsonCalls[0]?.data).toEqual({ count: 1 });
  });

  it("未被 _onSend 捕获的非 JSON 响应不写入缓存，也不补发空 JSON", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    let count = 0;

    for (let i = 0; i < 2; i++) {
      const res = createMockRes();
      await middleware(req, res, async () => {
        count++;
      });
      expect(res._jsonCalls).toHaveLength(0);
    }

    expect(count).toBe(2);
  });

  it("res.render() 的 payload 复用路由缓存，HIT 时通过 _renderCached 重渲染", async () => {
    const { middleware } = createMiddleware({ ttl: 2_000 });
    const req = createMockReq({ path: "/dashboard" });
    const firstRes = createMockRes();
    const hitRes = createMockRes();
    let renderCalls = 0;

    await middleware(req, firstRes, async () => {
      renderCalls++;
      const headers = { "Content-Type": "text/html; charset=utf-8" };
      firstRes._onSend?.(
        {
          __vextResponseKind: "render",
          payload: {
            page: "dashboard",
            props: { renderCalls },
            options: {},
            buildId: "test-build",
            mode: "production",
          },
        },
        200,
        headers,
      );
      firstRes._sendHtml?.(
        `<!doctype html><html><body>dashboard-${renderCalls}</body></html>`,
        200,
        headers,
        "render",
      );
    });

    const hitNext = vi.fn();
    await middleware(req, hitRes, hitNext);

    expect(renderCalls).toBe(1);
    expect(hitNext).not.toHaveBeenCalled();
    expect(hitRes._headerCalls).toContainEqual({
      name: "X-Cache",
      value: "HIT",
    });
    expect(hitRes._jsonCalls).toHaveLength(0);
    expect(hitRes._htmlCalls).toHaveLength(0);
    expect(hitRes._renderCalls[0]).toMatchObject({
      status: 200,
    });
    expect((hitRes._renderCalls[0]?.payload as any).payload.page).toBe(
      "dashboard",
    );
    expect((hitRes._renderCalls[0]?.payload as any).payload.props).toEqual({
      renderCalls: 1,
    });
    expect(
      hitRes._renderCalls[0]?.headers["Content-Type"] ??
        hitRes._renderCalls[0]?.headers["content-type"],
    ).toBe("text/html; charset=utf-8");
    expect(
      hitRes._renderCalls[0]?.headers["Cache-Control"] ??
        hitRes._renderCalls[0]?.headers["cache-control"],
    ).toBe("public, max-age=2");
  });

  it("协商后的 page-envelope render payload 在 HIT 时仍由当前 response bridge 回放", async () => {
    const { middleware } = createMiddleware({ ttl: 2_000 });
    const req = createMockReq({ path: "/dashboard" });
    const firstRes = createMockRes();
    const hitRes = createMockRes();
    const cachedPayload = {
      __vextResponseKind: "render",
      payload: {
        page: "dashboard",
        props: { value: "envelope" },
        options: {},
        buildId: "test-build",
        mode: "production",
      },
    };

    await middleware(req, firstRes, async () => {
      firstRes._onSend?.(cachedPayload, 200, {
        "Content-Type": "application/vnd.vext.page+json;v=1; charset=utf-8",
      });
      firstRes.rawJson(cachedPayload, 200);
    });

    const hitNext = vi.fn();
    await middleware(req, hitRes, hitNext);

    expect(hitNext).not.toHaveBeenCalled();
    expect(hitRes._jsonCalls).toHaveLength(0);
    expect(hitRes._renderCalls).toHaveLength(1);
    expect(hitRes._renderCalls[0]?.payload).toEqual(cachedPayload);
  });

  it("并发 MISS 使用 single-flight，只调用一次 handler", async () => {
    const { middleware } = createMiddleware();
    const req = createMockReq();
    let originCalls = 0;

    const tasks = Array.from({ length: 100 }, async () => {
      const res = createMockRes();
      await middleware(req, res, async () => {
        originCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.json({ originCalls }, 200);
      });
      return res;
    });

    const responses = await Promise.all(tasks);
    const hits = responses.filter((res) =>
      res._headerCalls.some(
        (header) => header.name === "X-Cache" && header.value === "HIT",
      ),
    );

    expect(originCalls).toBe(1);
    expect(hits.length).toBe(99);
    expect(responses.every((res) => res._jsonCalls.length === 1)).toBe(true);
  });
});

// ── defaultCacheKey 测试 ──────────────────────────────────

describe("defaultCacheKey", () => {
  it("静态路径", () => {
    const req = createMockReq({ method: "GET", path: "/products" });
    expect(defaultCacheKey(req, [])).toBe("GET:/products");
  });

  it("动态参数路径（已解析）", () => {
    const req = createMockReq({
      method: "GET",
      path: "/products/42",
      params: { id: "42" },
    });
    expect(defaultCacheKey(req, [])).toBe("GET:/products/42");
  });

  it("query 参数排序", () => {
    const req = createMockReq({
      query: { b: "2", a: "1" },
    });
    expect(defaultCacheKey(req, [])).toBe("GET:/products?a=1&b=2");
  });

  it("空 query 无问号", () => {
    const req = createMockReq({ query: {} });
    expect(defaultCacheKey(req, [])).toBe("GET:/products");
  });

  it("vary headers", () => {
    const req = createMockReq({
      headers: { "accept-language": "zh-CN" },
    });
    expect(defaultCacheKey(req, ["accept-language"])).toBe(
      "GET:/products|accept-language=zh-CN",
    );
  });

  it("vary header 不存在时值为空", () => {
    const req = createMockReq({ headers: {} });
    expect(defaultCacheKey(req, ["accept-encoding"])).toBe(
      "GET:/products|accept-encoding=",
    );
  });

  it("query + vary 组合", () => {
    const req = createMockReq({
      method: "GET",
      path: "/api/items",
      query: { page: "1" },
      headers: { "accept-language": "en" },
    });
    expect(defaultCacheKey(req, ["accept-language"])).toBe(
      "GET:/api/items?page=1|accept-language=en",
    );
  });

  it("POST 方法", () => {
    const req = createMockReq({ method: "POST", path: "/data" });
    expect(defaultCacheKey(req, [])).toBe("POST:/data");
  });
});

// ── normalizeCacheOptions 补充测试 ────────────────────────

describe("normalizeCacheOptions 补充", () => {
  it("对象形式 ttl 未设置且无 globalDefaultTtl → null", () => {
    // ttl=0, falsy → no global → null
    expect(normalizeCacheOptions({ ttl: 0 })).toBeNull();
  });

  it("对象形式 ttl 为正数 + globalDefaultTtl → 使用对象自身 ttl", () => {
    const result = normalizeCacheOptions({ ttl: 30 }, 120);
    expect(result).toEqual({ ttl: 30 });
  });

  it("小数 TTL 应正常处理", () => {
    const result = normalizeCacheOptions(0.5);
    expect(result).toEqual({ ttl: 0.5 });
  });

  it("极大 TTL 值应正常处理", () => {
    const result = normalizeCacheOptions(86400);
    expect(result).toEqual({ ttl: 86400 });
  });

  it("对象形式带所有可选字段应保留", () => {
    const opts = {
      ttl: 60,
      vary: ["accept-language"],
      tags: ["products"],
      cacheControl: false,
      store: "redis",
      swr: 10,
    };
    const result = normalizeCacheOptions(opts as any);
    expect(result).toEqual(opts);
  });
});
