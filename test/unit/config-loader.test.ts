/**
 * config-loader 单元测试
 *
 * 测试覆盖：
 *   - deepMerge：深度合并、标量覆盖、嵌套对象合并、数组覆盖、跳过 middlewares key
 *   - patchMiddlewares：按 name patch 合并、未匹配追加、字符串/对象混合
 *   - deepFreeze：递归冻结、跳过非纯对象（Date/RegExp/Map/Set）
 *   - validateConfig：Fail Fast 校验（port/adapter/middlewares/rateLimit/logger/shutdown 等）
 *   - loadConfig：default 缺失报错、三层合并、deepFreeze 只读
 *   - VEXT_PORT / VEXT_HOST 环境变量覆盖（BUG-013 防回归）
 *
 * @see 10-testing.md §3（Service 单元测试模式）
 * @see IMPLEMENTATION-PLAN.md 任务 1.20
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _deepMerge,
  _deepFreeze,
  _patchMiddlewares,
  _validateConfig,
} from "../../src/lib/config-loader.js";
import { loadConfig } from "../../src/lib/config-loader.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── deepMerge ───────────────────────────────────────────────

describe("deepMerge", () => {
  it("returns a new object (does not mutate target)", () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3 };
    const result = _deepMerge(target, source);

    expect(result).not.toBe(target);
    expect(target.b).toBe(2); // 原对象未被修改
    expect(result.b).toBe(3);
  });

  it("overwrites scalar values", () => {
    const result = _deepMerge({ port: 3000, host: "0.0.0.0" }, { port: 8080 });
    expect(result.port).toBe(8080);
    expect(result.host).toBe("0.0.0.0"); // 未覆盖的保留
  });

  it("deeply merges nested objects", () => {
    const result = _deepMerge(
      { cors: { enabled: true, origins: ["*"], methods: ["GET"] } } as Record<
        string,
        unknown
      >,
      { cors: { origins: ["http://example.com"] } } as Record<string, unknown>,
    );

    const cors = result.cors as Record<string, unknown>;
    expect(cors.enabled).toBe(true); // 未覆盖的子字段保留
    expect(cors.origins).toEqual(["http://example.com"]); // 数组直接覆盖
  });

  it("overwrites arrays (not concat)", () => {
    const result = _deepMerge(
      { items: [1, 2, 3] } as Record<string, unknown>,
      { items: [4, 5] } as Record<string, unknown>,
    );
    expect(result.items).toEqual([4, 5]);
  });

  it("skips middlewares key (handled by patchMiddlewares)", () => {
    const result = _deepMerge(
      { middlewares: [{ name: "auth" }], port: 3000 } as Record<
        string,
        unknown
      >,
      { middlewares: [{ name: "cors" }], port: 8080 } as Record<
        string,
        unknown
      >,
    );
    // middlewares 应该保留 target 的值（被跳过）
    expect(result.middlewares).toEqual([{ name: "auth" }]);
    expect(result.port).toBe(8080); // 其他字段正常合并
  });

  it("handles null source values (overwrites with null)", () => {
    const result = _deepMerge(
      { cors: { enabled: true } } as Record<string, unknown>,
      { cors: null } as unknown as Record<string, unknown>,
    );
    expect(result.cors).toBeNull();
  });

  it("handles undefined source values (skips)", () => {
    const result = _deepMerge(
      { port: 3000 } as Record<string, unknown>,
      { port: undefined } as Record<string, unknown>,
    );
    // undefined 值在 Object.keys 遍历中会被包含，但值为 undefined
    // deepMerge 的行为：source[key] 为 undefined 时走 else 分支（直接覆盖）
    expect(result.port).toBeUndefined();
  });

  it("deeply merges multiple levels", () => {
    const result = _deepMerge(
      { a: { b: { c: 1, d: 2 }, e: 3 } } as Record<string, unknown>,
      { a: { b: { c: 10 } } } as Record<string, unknown>,
    );
    const a = result.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    expect(b.c).toBe(10);
    expect(b.d).toBe(2); // 未覆盖
    expect(a.e).toBe(3); // 未覆盖
  });

  it("clones nested values introduced by both inputs", () => {
    const target = { stable: { list: [{ value: 1 }] } };
    const source = { added: { list: [{ value: 2 }] } };
    const result = _deepMerge(
      target as unknown as Record<string, unknown>,
      source as unknown as Record<string, unknown>,
    ) as typeof target & typeof source;

    expect(result.stable).not.toBe(target.stable);
    expect(result.stable.list).not.toBe(target.stable.list);
    expect(result.added).not.toBe(source.added);
    expect(result.added.list).not.toBe(source.added.list);

    _deepFreeze(result);
    expect(Object.isFrozen(target.stable)).toBe(false);
    expect(Object.isFrozen(source.added)).toBe(false);
  });

  it("preserves bounded cycles without sharing source references", () => {
    const source: Record<string, unknown> = {};
    source.self = source;

    const result = _deepMerge({}, { cyclic: source }) as {
      cyclic: Record<string, unknown>;
    };

    expect(result.cyclic).not.toBe(source);
    expect(result.cyclic.self).toBe(result.cyclic);
  });

  it("drops prototype pollution keys while cloning and merging config values", () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).pollutedCtor;

    const target = JSON.parse(
      '{"safe":{"keep":true},"constructor":{"existing":true}}',
    ) as Record<string, unknown>;
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"pollutedCtor":true}},"safe":{"prototype":{"nested":true},"next":true}}',
    ) as Record<string, unknown>;

    const result = _deepMerge(target, source);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).pollutedCtor).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(result.safe).toEqual({ keep: true, next: true });
  });
});

// ── patchMiddlewares ────────────────────────────────────────

describe("patchMiddlewares", () => {
  it("returns base when override is empty", () => {
    const base = [{ name: "auth", options: { role: "admin" } }];
    const result = _patchMiddlewares(base, []);
    expect(result).toEqual(base);
    expect(result).not.toBe(base); // 新数组
  });

  it("clones nested middleware options", () => {
    const override = [{ name: "auth", options: { policy: { role: "admin" } } }];
    const result = _patchMiddlewares([], override);

    expect(result[0]).not.toBe(override[0]);
    expect((result[0] as { options: unknown }).options).not.toBe(
      override[0]!.options,
    );
  });

  it("rejects duplicate names within one configuration layer", () => {
    expect(() =>
      _patchMiddlewares([], ["auth", { name: "auth", enabled: false }]),
    ).toThrow('duplicate name "auth"');
  });

  it("appends new middleware not found in base", () => {
    const result = _patchMiddlewares([{ name: "auth" }], [{ name: "cors" }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "auth" });
    expect(result[1]).toEqual({ name: "cors" });
  });

  it("patches existing middleware by name (shallow merge)", () => {
    const result = _patchMiddlewares(
      [{ name: "auth", options: { role: "user" }, enabled: true }],
      [{ name: "auth", options: { role: "admin" } }],
    );
    expect(result).toHaveLength(1);
    // shallow merge: options 被覆盖（不是深度合并）
    expect(result[0]).toEqual({
      name: "auth",
      options: { role: "admin" },
      enabled: true,
    });
  });

  it("replaces options wholesale instead of deep-merging nested keys", () => {
    const result = _patchMiddlewares(
      [
        {
          name: "a",
          options: { nested: { base: true }, value: "base" },
          enabled: true,
        },
      ],
      [{ name: "a", options: { value: "profile" } }],
    );
    expect(result[0]).toEqual({
      name: "a",
      options: { value: "profile" },
      enabled: true,
    });
  });

  it("allows empty options objects to clear prior options", () => {
    const result = _patchMiddlewares(
      [{ name: "a", enabled: true, options: { nested: { one: 1 } } }],
      [{ name: "a", enabled: false, options: {} }],
    );
    expect(result[0]).toEqual({
      name: "a",
      enabled: false,
      options: {},
    });
  });

  it("handles string declarations in base", () => {
    const result = _patchMiddlewares(
      ["auth"],
      [{ name: "auth", options: { role: "admin" } }],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "auth",
      options: { role: "admin" },
    });
  });

  it("handles string declarations in override", () => {
    const result = _patchMiddlewares(
      [{ name: "auth", options: { role: "admin" } }],
      ["auth"],
    );
    expect(result).toHaveLength(1);
    // string override → { name: "auth" } 浅合并到 base
    expect(result[0]).toEqual({ name: "auth", options: { role: "admin" } });
  });

  it("preserves order of base, appends new items at end", () => {
    const result = _patchMiddlewares(
      ["auth", "rate-limit", "cors"],
      [{ name: "rate-limit", enabled: false }, { name: "logger" }],
    );
    expect(result).toHaveLength(4);
    expect(
      result.map((d: any) => (typeof d === "string" ? d : d.name)),
    ).toEqual(["auth", "rate-limit", "cors", "logger"]);
  });

  it("does not mutate base array", () => {
    const base = [{ name: "auth", options: { x: 1 } }];
    const baseCopy = JSON.parse(JSON.stringify(base));
    _patchMiddlewares(base, [{ name: "auth", options: { x: 2 } }]);
    expect(base).toEqual(baseCopy); // 原始数组未被修改
  });
});

// ── deepFreeze ──────────────────────────────────────────────

describe("deepFreeze", () => {
  it("freezes top-level properties", () => {
    const obj = { port: 3000, host: "0.0.0.0" };
    const frozen = _deepFreeze(obj);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as any).port = 8080;
    }).toThrow();
  });

  it("recursively freezes nested objects", () => {
    const obj = {
      cors: { enabled: true, origins: ["*"] },
      logger: { level: "info" },
    };
    const frozen = _deepFreeze(obj);

    expect(Object.isFrozen(frozen.cors)).toBe(true);
    expect(Object.isFrozen(frozen.logger)).toBe(true);
    expect(() => {
      (frozen.cors as any).enabled = false;
    }).toThrow();
  });

  it("freezes arrays", () => {
    const obj = { items: [1, 2, 3] };
    const frozen = _deepFreeze(obj);

    expect(Object.isFrozen(frozen.items)).toBe(true);
    expect(() => {
      (frozen.items as any).push(4);
    }).toThrow();
  });

  it("skips Date objects (does not freeze)", () => {
    const date = new Date("2026-01-01");
    const obj = { createdAt: date };
    const frozen = _deepFreeze(obj);

    // Date 不应被冻结（冻结 Date 会破坏 setTime 等方法）
    expect(Object.isFrozen(frozen.createdAt)).toBe(false);
  });

  it("skips RegExp objects", () => {
    const obj = { pattern: /test/i };
    const frozen = _deepFreeze(obj);
    expect(Object.isFrozen(frozen.pattern)).toBe(false);
  });

  it("skips Map and Set objects", () => {
    const obj = {
      map: new Map([["key", "value"]]),
      set: new Set([1, 2, 3]),
    };
    const frozen = _deepFreeze(obj);
    expect(Object.isFrozen(frozen.map)).toBe(false);
    expect(Object.isFrozen(frozen.set)).toBe(false);
  });

  it("skips class instances so runtime clients keep mutable internals", () => {
    class FakeRedisClient {
      connected = true;
    }

    const obj = { cache: { client: new FakeRedisClient() } };
    const frozen = _deepFreeze(obj);

    expect(Object.isFrozen(frozen.cache)).toBe(true);
    expect(Object.isFrozen(frozen.cache.client)).toBe(false);
    frozen.cache.client.connected = false;
    expect(frozen.cache.client.connected).toBe(false);
  });

  it("handles null and primitives gracefully", () => {
    expect(_deepFreeze(null)).toBeNull();
    expect(_deepFreeze(42)).toBe(42);
    expect(_deepFreeze("hello")).toBe("hello");
    expect(_deepFreeze(undefined)).toBeUndefined();
  });

  it("skips already frozen objects (no error on re-freeze)", () => {
    const obj = Object.freeze({ a: 1 });
    expect(() => _deepFreeze(obj)).not.toThrow();
  });
});

// ── validateConfig ──────────────────────────────────────────

describe("validateConfig", () => {
  // 有效配置不应抛出
  it("accepts valid minimal config", () => {
    expect(() =>
      _validateConfig({
        port: 3000,
        adapter: "hono",
        middlewares: [],
        logger: { level: "info" },
      }),
    ).not.toThrow();
  });

  it("accepts config without optional fields", () => {
    expect(() => _validateConfig({})).not.toThrow();
  });

  // ── port ────────────────────────────────────────────────

  describe("port validation", () => {
    it("rejects port = 0", () => {
      expect(() => _validateConfig({ port: 0 })).toThrow("config.port");
    });

    it("rejects port > 65535", () => {
      expect(() => _validateConfig({ port: 70000 })).toThrow("config.port");
    });

    it("rejects negative port", () => {
      expect(() => _validateConfig({ port: -1 })).toThrow("config.port");
    });

    it("rejects non-number port", () => {
      expect(() => _validateConfig({ port: "3000" })).toThrow("config.port");
    });

    it("accepts valid port", () => {
      expect(() => _validateConfig({ port: 8080 })).not.toThrow();
    });

    it("rejects non-finite and fractional ports", () => {
      expect(() => _validateConfig({ port: Number.NaN })).toThrow(
        "config.port",
      );
      expect(() => _validateConfig({ port: Number.POSITIVE_INFINITY })).toThrow(
        "config.port",
      );
      expect(() => _validateConfig({ port: 3000.5 })).toThrow("config.port");
    });

    it("validates host and trustProxy scalar types", () => {
      expect(() => _validateConfig({ host: 127 })).toThrow("config.host");
      expect(() => _validateConfig({ trustProxy: "yes" })).toThrow(
        "config.trustProxy",
      );
    });
  });

  // ── adapter ─────────────────────────────────────────────

  describe("adapter validation", () => {
    it("accepts known adapter string", () => {
      expect(() => _validateConfig({ adapter: "hono" })).not.toThrow();
      expect(() => _validateConfig({ adapter: "fastify" })).not.toThrow();
      expect(() => _validateConfig({ adapter: "express" })).not.toThrow();
      expect(() => _validateConfig({ adapter: "koa" })).not.toThrow();
    });

    it("rejects unknown adapter string", () => {
      expect(() => _validateConfig({ adapter: "unknown-adapter" })).toThrow(
        "not a built-in adapter",
      );
    });

    it("accepts factory function", () => {
      expect(() =>
        _validateConfig({ adapter: function myAdapter() {} }),
      ).not.toThrow();
    });

    it("accepts an adapter object and gives custom-adapter guidance for unknown strings", () => {
      expect(() =>
        _validateConfig({ adapter: { name: "custom" } }),
      ).not.toThrow();
      expect(() => _validateConfig({ adapter: "custom" })).toThrow(
        "pass an adapter object or factory function",
      );
    });

    it("rejects incomplete adapter objects and non-union values", () => {
      expect(() => _validateConfig({ adapter: {} })).toThrow(
        "incomplete: missing non-empty",
      );
      expect(() => _validateConfig({ adapter: { name: "" } })).toThrow(
        "incomplete: missing non-empty",
      );
      expect(() => _validateConfig({ adapter: 123 })).toThrow("config.adapter");
      expect(() => _validateConfig({ adapter: null })).toThrow(
        "config.adapter",
      );
      expect(() => _validateConfig({ adapter: [] })).toThrow("config.adapter");
    });
  });

  // ── middlewares ──────────────────────────────────────────

  describe("middlewares validation", () => {
    it("accepts array of strings", () => {
      expect(() =>
        _validateConfig({ middlewares: ["auth", "cors"] }),
      ).not.toThrow();
    });

    it("accepts array of objects with name", () => {
      expect(() =>
        _validateConfig({
          middlewares: [{ name: "auth", options: { role: "admin" } }],
        }),
      ).not.toThrow();
    });

    it("rejects non-array middlewares", () => {
      expect(() => _validateConfig({ middlewares: "auth" })).toThrow(
        "config.middlewares must be an array",
      );
    });

    it("rejects invalid middleware item (number)", () => {
      expect(() => _validateConfig({ middlewares: [123] })).toThrow(
        "config.middlewares[0]",
      );
    });

    it("rejects object without name", () => {
      expect(() => _validateConfig({ middlewares: [{ options: {} }] })).toThrow(
        "config.middlewares[0]",
      );
    });

    it("rejects empty names, invalid options/enabled, and duplicate names", () => {
      expect(() => _validateConfig({ middlewares: [""] })).toThrow(
        "non-empty string",
      );
      expect(() =>
        _validateConfig({ middlewares: [{ name: "auth", options: [] }] }),
      ).toThrow(".options must be an object");
      expect(() =>
        _validateConfig({ middlewares: [{ name: "auth", enabled: "no" }] }),
      ).toThrow(".enabled must be a boolean");
      expect(() => _validateConfig({ middlewares: ["auth", "auth"] })).toThrow(
        'duplicate name "auth"',
      );
    });
  });

  describe("HTTP middleware configuration validation", () => {
    it("validates CORS and requestId objects and fields", () => {
      expect(() => _validateConfig({ cors: true })).toThrow(
        "config.cors must be an object",
      );
      expect(() => _validateConfig({ cors: { enabled: "yes" } })).toThrow(
        "config.cors.enabled must be a boolean",
      );
      expect(() => _validateConfig({ cors: { origins: "*" } })).toThrow(
        "config.cors.origins must be an array of strings",
      );
      expect(() =>
        _validateConfig({ cors: { origins: ["*"], credentials: true } }),
      ).toThrow("cannot combine credentials: true with wildcard origin");
      expect(() => _validateConfig({ cors: { credentials: true } })).toThrow(
        "cannot combine credentials: true with wildcard origin",
      );
      expect(() => _validateConfig({ requestId: false })).toThrow(
        "config.requestId must be an object",
      );
      expect(() => _validateConfig({ requestId: { enabled: "yes" } })).toThrow(
        "config.requestId.enabled must be a boolean",
      );
      expect(() => _validateConfig({ requestId: { header: "" } })).toThrow(
        "config.requestId.header must be a non-empty string",
      );
    });

    it("validates body parser and multipart object fields", () => {
      expect(() => _validateConfig({ bodyParser: true })).toThrow(
        "config.bodyParser must be an object",
      );
      expect(() => _validateConfig({ bodyParser: { enabled: "yes" } })).toThrow(
        "config.bodyParser.enabled must be a boolean",
      );
      expect(() => _validateConfig({ multipart: true })).toThrow(
        "config.multipart must be an object",
      );
      expect(() => _validateConfig({ multipart: { enabled: "yes" } })).toThrow(
        "config.multipart.enabled must be a boolean",
      );
    });
  });

  // ── rateLimit ───────────────────────────────────────────

  describe("rateLimit validation", () => {
    it("accepts valid rateLimit", () => {
      expect(() =>
        _validateConfig({ rateLimit: { max: 100, window: 60 } }),
      ).not.toThrow();
    });

    it("rejects non-object rateLimit", () => {
      expect(() => _validateConfig({ rateLimit: "fast" })).toThrow(
        "config.rateLimit must be an object",
      );
    });

    it("rejects max < 1", () => {
      expect(() => _validateConfig({ rateLimit: { max: 0 } })).toThrow(
        "config.rateLimit.max",
      );
    });

    it("rejects negative window", () => {
      expect(() => _validateConfig({ rateLimit: { window: -1 } })).toThrow(
        "config.rateLimit.window",
      );
    });
  });

  // ── logger ──────────────────────────────────────────────

  describe("logger validation", () => {
    it("accepts valid logger config", () => {
      expect(() =>
        _validateConfig({
          logger: { level: "debug", pretty: true, prettyColor: "auto" },
        }),
      ).not.toThrow();
    });

    it("accepts all valid logger prettyColor modes", () => {
      for (const prettyColor of ["auto", "always", "never"]) {
        expect(() =>
          _validateConfig({ logger: { prettyColor } }),
        ).not.toThrow();
      }
    });

    it("accepts logger redaction config", () => {
      expect(() =>
        _validateConfig({
          logger: {
            redactKeys: ["password"],
            redactPaths: ["user.token", "users.0.secret"],
            redactValue: "***",
          },
        }),
      ).not.toThrow();
    });

    it("rejects invalid log level", () => {
      expect(() => _validateConfig({ logger: { level: "verbose" } })).toThrow(
        "config.logger.level",
      );
    });

    it("accepts all valid log levels", () => {
      for (const level of [
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "silent",
      ]) {
        expect(() => _validateConfig({ logger: { level } })).not.toThrow();
      }
    });

    it("rejects non-boolean pretty", () => {
      expect(() => _validateConfig({ logger: { pretty: "yes" } })).toThrow(
        "config.logger.pretty must be a boolean",
      );
    });

    it("rejects invalid prettyColor", () => {
      expect(() =>
        _validateConfig({ logger: { prettyColor: "rainbow" } }),
      ).toThrow("config.logger.prettyColor");
      expect(() => _validateConfig({ logger: { prettyColor: true } })).toThrow(
        "config.logger.prettyColor",
      );
    });

    it("rejects invalid logger redaction config", () => {
      expect(() =>
        _validateConfig({ logger: { redactKeys: ["password", 1] } }),
      ).toThrow("config.logger.redactKeys");
      expect(() =>
        _validateConfig({ logger: { redactPaths: "user.token" } }),
      ).toThrow("config.logger.redactPaths");
      expect(() => _validateConfig({ logger: { redactValue: false } })).toThrow(
        "config.logger.redactValue",
      );
    });
  });

  // ── shutdown ────────────────────────────────────────────

  describe("shutdown validation", () => {
    it("accepts valid shutdown config", () => {
      expect(() =>
        _validateConfig({ shutdown: { timeout: 30 } }),
      ).not.toThrow();
    });

    it("accepts timeout = 0", () => {
      expect(() => _validateConfig({ shutdown: { timeout: 0 } })).not.toThrow();
    });

    it("rejects negative timeout", () => {
      expect(() => _validateConfig({ shutdown: { timeout: -5 } })).toThrow(
        "config.shutdown.timeout",
      );
    });

    it("rejects NaN and Infinity timeout values", () => {
      expect(() =>
        _validateConfig({ shutdown: { timeout: Number.NaN } }),
      ).toThrow("finite non-negative");
      expect(() =>
        _validateConfig({ shutdown: { timeout: Number.POSITIVE_INFINITY } }),
      ).toThrow("finite non-negative");
    });
  });

  // ── server ──────────────────────────────────────────────

  describe("server validation", () => {
    it("accepts valid server config", () => {
      expect(() =>
        _validateConfig({
          server: {
            requestTimeout: 120_000,
            headersTimeout: 60_000,
            keepAliveTimeout: 5_000,
            socketTimeout: 0,
            maxHeaderSize: 16 * 1024,
            maxRequestsPerSocket: 0,
            connectionsCheckingInterval: 30_000,
          },
        }),
      ).not.toThrow();
    });

    it("accepts timeout fields set to 0", () => {
      expect(() =>
        _validateConfig({
          server: {
            requestTimeout: 0,
            headersTimeout: 0,
            keepAliveTimeout: 0,
            socketTimeout: 0,
          },
        }),
      ).not.toThrow();
    });

    it("rejects non-object server config", () => {
      expect(() => _validateConfig({ server: [] })).toThrow(
        "config.server must be an object",
      );
    });

    it("rejects negative timeout fields", () => {
      expect(() => _validateConfig({ server: { requestTimeout: -1 } })).toThrow(
        "config.server.requestTimeout",
      );
    });

    it("rejects non-finite timeout fields", () => {
      expect(() =>
        _validateConfig({
          server: { headersTimeout: Number.POSITIVE_INFINITY },
        }),
      ).toThrow("config.server.headersTimeout");
    });

    it("rejects invalid integer fields", () => {
      expect(() => _validateConfig({ server: { maxHeaderSize: 0 } })).toThrow(
        "config.server.maxHeaderSize",
      );
      expect(() =>
        _validateConfig({ server: { maxRequestsPerSocket: -1 } }),
      ).toThrow("config.server.maxRequestsPerSocket");
      expect(() =>
        _validateConfig({ server: { connectionsCheckingInterval: 0 } }),
      ).toThrow("config.server.connectionsCheckingInterval");
    });
  });

  // ── cluster ─────────────────────────────────────────────

  describe("cluster validation", () => {
    it("accepts valid cluster config", () => {
      expect(() =>
        _validateConfig({ cluster: { workers: 4, enabled: true } }),
      ).not.toThrow();
    });

    it('accepts workers = "auto"', () => {
      expect(() =>
        _validateConfig({ cluster: { workers: "auto" } }),
      ).not.toThrow();
    });

    it('accepts workers = "auto-1"', () => {
      expect(() =>
        _validateConfig({ cluster: { workers: "auto-1" } }),
      ).not.toThrow();
    });

    it("rejects workers = 0", () => {
      expect(() => _validateConfig({ cluster: { workers: 0 } })).toThrow(
        "config.cluster.workers",
      );
    });

    it("rejects invalid worker string", () => {
      expect(() => _validateConfig({ cluster: { workers: "half" } })).toThrow(
        "config.cluster.workers",
      );
    });

    it("rejects non-boolean enabled", () => {
      expect(() => _validateConfig({ cluster: { enabled: "yes" } })).toThrow(
        "config.cluster.enabled must be a boolean",
      );
    });
  });

  // ── openapi ─────────────────────────────────────────────

  describe("openapi validation", () => {
    it("accepts valid openapi config", () => {
      expect(() =>
        _validateConfig({
          openapi: {
            enabled: true,
            tagGroups: [{ name: "Public API", tags: ["Users", "Orders"] }],
          },
        }),
      ).not.toThrow();
    });

    it("accepts valid docs config", () => {
      expect(() =>
        _validateConfig({
          openapi: {
            enabled: true,
            docsPath: "/docs",
            jsonPath: "/openapi.json",
            jsonPublicPath: "/admin/openapi.json",
            docs: {
              path: "/admin/docs",
              assetsPath: "/_vext/docs",
              assetsPublicPath: "/admin/_vext/docs",
              renderer: "vext",
              ui: {
                title: "Admin API",
                tryItOut: false,
                defaultView: "code",
                theme: "dark",
                density: "compact",
              },
              code: {
                enabled: "auto",
                scan: "lazy",
                services: {
                  dir: "services",
                  include: ["**/*.ts"],
                  exclude: ["**/*.test.ts"],
                },
                utils: true,
                models: false,
                components: {
                  dir: "frontend/components",
                  include: ["**/*.tsx"],
                },
                locales: {
                  dir: "locales",
                },
                config: {
                  dir: "config",
                },
                preload: {
                  dir: "preload",
                },
                styles: {
                  dir: "frontend/styles",
                },
              },
              access: {
                mode: "enforce",
                openapiJson: "filtered",
                resolver: () => true,
              },
              tryItOut: {
                hookScript: "/docs-hook.js",
                hookGlobal: "VextDocsHooks",
                defaultServer: "first",
                sameOrigin: "auto",
                customServer: true,
                customServerUrl: "http://127.0.0.1:3001",
              },
              sources: [
                {
                  id: "public-v1",
                  label: "Public v1",
                  match: ["/api/v1/**"],
                  access: {
                    roles: ["developer"],
                    permissions: ["docs:read"],
                    visible: true,
                    tryItOut: false,
                    group: "public",
                  },
                  code: {
                    include: ["services/public/**"],
                    exclude: ["**/*.internal.ts"],
                  },
                },
              ],
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects non-boolean enabled", () => {
      expect(() => _validateConfig({ openapi: { enabled: "true" } })).toThrow(
        "config.openapi.enabled must be a boolean",
      );
    });

    it("rejects invalid docs path", () => {
      expect(() =>
        _validateConfig({ openapi: { docs: { path: "docs" } } }),
      ).toThrow("config.openapi.docs.path");
      expect(() =>
        _validateConfig({
          openapi: { docs: { assetsPublicPath: "admin/_vext/docs" } },
        }),
      ).toThrow("config.openapi.docs.assetsPublicPath");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: {
              path: "/docs",
              assetsPublicPath: "/docs",
            },
          },
        }),
      ).toThrow("config.openapi.docs.assetsPublicPath");
    });

    it("rejects invalid docs renderer", () => {
      expect(() =>
        _validateConfig({ openapi: { docs: { renderer: "scalar" } } }),
      ).toThrow("config.openapi.docs.renderer");
    });

    it("rejects external docs renderer objects", () => {
      expect(() =>
        _validateConfig({
          openapi: {
            docs: {
              renderer: {
                name: "custom",
                render: () => "<html></html>",
              },
            },
          },
        }),
      ).toThrow('only supports "vext"');
    });

    it("rejects invalid docs ui theme or density", () => {
      expect(() =>
        _validateConfig({ openapi: { docs: { ui: { theme: "sepia" } } } }),
      ).toThrow("config.openapi.docs.ui.theme");
      expect(() =>
        _validateConfig({ openapi: { docs: { ui: { density: "tiny" } } } }),
      ).toThrow("config.openapi.docs.ui.density");
    });

    it("rejects invalid docs access mode", () => {
      expect(() =>
        _validateConfig({
          openapi: { docs: { access: { mode: "hidden-only" } } },
        }),
      ).toThrow("config.openapi.docs.access.mode");
    });

    it("rejects unsupported docs access cacheKey", () => {
      expect(() =>
        _validateConfig({
          openapi: { docs: { access: { cacheKey: "admin" } } },
        }),
      ).toThrow("config.openapi.docs.access.cacheKey is not supported");
    });

    it("documents unsupported docs access cacheKey in config guides", () => {
      for (const file of [
        "website/docs/en/api/config.md",
        "website/docs/zh/api/config.md",
        "website/docs/en/guide/configuration.md",
        "website/docs/zh/guide/configuration.md",
      ]) {
        const content = fs.readFileSync(file, "utf8");
        expect(content).toContain("docs.access.cacheKey");
        expect(content).toMatch(
          /not (?:a )?supported|不是当前版本支持|不支持/u,
        );
      }
    });

    it("rejects invalid docs try it out server mode", () => {
      expect(() =>
        _validateConfig({
          openapi: { docs: { tryItOut: { sameOrigin: "yes" } } },
        }),
      ).toThrow(
        'config.openapi.docs.tryItOut.sameOrigin must be a boolean or "auto"',
      );
    });

    it("rejects invalid docs source access fields", () => {
      expect(() =>
        _validateConfig({
          openapi: {
            docs: {
              sources: [
                {
                  id: "admin",
                  match: "/admin/**",
                  access: { visible: "false" },
                },
              ],
            },
          },
        }),
      ).toThrow("config.openapi.docs.sources[0].access.visible");

      expect(() =>
        _validateConfig({
          openapi: {
            docs: {
              sources: [
                {
                  id: "admin",
                  match: "/admin/**",
                  access: { roles: ["admin", 1] },
                },
              ],
            },
          },
        }),
      ).toThrow("config.openapi.docs.sources[0].access.roles");
    });

    it("rejects docs source dir outside project root", () => {
      expect(() =>
        _validateConfig({
          openapi: { docs: { code: { services: { dir: "../services" } } } },
        }),
      ).toThrow("config.openapi.docs.code.services.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { components: { dir: "../components" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.components.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { plugins: { dir: "../plugins" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.plugins.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { middlewares: { dir: "../middlewares" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.middlewares.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { locales: { dir: "../locales" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.locales.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { config: { dir: "../config" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.config.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { preload: { dir: "../preload" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.preload.dir");
      expect(() =>
        _validateConfig({
          openapi: {
            docs: { code: { styles: { dir: "../styles" } } },
          },
        }),
      ).toThrow("config.openapi.docs.code.styles.dir");
    });
  });

  // ── locale ──────────────────────────────────────────────

  describe("locale validation", () => {
    it("accepts valid locale config", () => {
      expect(() =>
        _validateConfig({
          locale: { default: "zh-CN", supported: ["zh-CN", "en-US"] },
        }),
      ).not.toThrow();
    });

    it("rejects non-string default", () => {
      expect(() => _validateConfig({ locale: { default: 123 } })).toThrow(
        "config.locale.default must be a string",
      );
    });

    it("rejects non-array supported", () => {
      expect(() => _validateConfig({ locale: { supported: "zh-CN" } })).toThrow(
        "config.locale.supported must be an array",
      );
    });

    it("rejects non-string items in supported", () => {
      expect(() => _validateConfig({ locale: { supported: [123] } })).toThrow(
        "config.locale.supported[] items must be strings",
      );
    });
  });

  // ── requestContext ──────────────────────────────────────

  describe("requestContext validation", () => {
    it("accepts valid requestContext config (enabled: true)", () => {
      expect(() =>
        _validateConfig({ requestContext: { enabled: true } }),
      ).not.toThrow();
    });

    it("accepts valid requestContext config (enabled: false)", () => {
      expect(() =>
        _validateConfig({ requestContext: { enabled: false } }),
      ).not.toThrow();
    });

    it("accepts requestContext without enabled field", () => {
      expect(() => _validateConfig({ requestContext: {} })).not.toThrow();
    });

    it("rejects non-object requestContext", () => {
      expect(() => _validateConfig({ requestContext: "true" })).toThrow(
        "config.requestContext must be an object",
      );
    });

    it("rejects non-boolean enabled", () => {
      expect(() =>
        _validateConfig({ requestContext: { enabled: "true" } }),
      ).toThrow("config.requestContext.enabled must be a boolean");
    });

    it("rejects null requestContext", () => {
      expect(() => _validateConfig({ requestContext: null })).toThrow(
        "config.requestContext must be an object",
      );
    });
  });

  // ── session ─────────────────────────────────────────────

  describe("session validation", () => {
    it("accepts valid session config", () => {
      const store = {
        get: () => null,
        set: () => undefined,
        delete: () => undefined,
        touch: () => undefined,
        clearExpired: () => undefined,
        close: () => undefined,
      };

      expect(() =>
        _validateConfig({
          session: {
            enabled: true,
            name: "vext.sid",
            ttl: 3600,
            rolling: true,
            autoCommit: true,
            idLength: 32,
            store,
            cookie: {
              httpOnly: true,
              secure: "auto",
              sameSite: "lax",
              path: "/",
              maxAge: 3600,
              priority: "high",
              partitioned: true,
              encode: encodeURIComponent,
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects invalid session scalar fields", () => {
      expect(() => _validateConfig({ session: "on" })).toThrow(
        "config.session must be an object",
      );
      expect(() => _validateConfig({ session: { ttl: 0 } })).toThrow(
        "config.session.ttl",
      );
      expect(() => _validateConfig({ session: { idLength: 8 } })).toThrow(
        "config.session.idLength",
      );
      expect(() => _validateConfig({ session: { rolling: "true" } })).toThrow(
        "config.session.rolling must be a boolean",
      );
    });

    it("rejects invalid session cookie options", () => {
      expect(() =>
        _validateConfig({ session: { cookie: { secure: "always" } } }),
      ).toThrow('config.session.cookie.secure must be a boolean or "auto"');
      expect(() =>
        _validateConfig({ session: { cookie: { sameSite: "loose" } } }),
      ).toThrow("config.session.cookie.sameSite");
      expect(() =>
        _validateConfig({ session: { cookie: { encode: "uri" } } }),
      ).toThrow("config.session.cookie.encode must be a function");
    });

    it("rejects invalid session store contract", () => {
      expect(() =>
        _validateConfig({ session: { store: { get: () => null } } }),
      ).toThrow("config.session.store.set must be a function");
      expect(() =>
        _validateConfig({
          session: {
            store: {
              get: () => null,
              set: () => undefined,
              delete: () => undefined,
              close: true,
            },
          },
        }),
      ).toThrow("config.session.store.close must be a function");
    });
  });

  // ── csrf ──────────────────────────────────────────────

  describe("csrf validation", () => {
    it("accepts valid csrf config", () => {
      expect(() =>
        _validateConfig({
          csrf: {
            enabled: true,
            mode: "signed-cookie",
            secret: "csrf-secret",
            methods: ["POST", "PUT", "PATCH", "DELETE"],
            headerNames: ["x-csrf-token", "x-xsrf-token"],
            bodyField: "_csrf",
            fetchMetadata: true,
            cookie: {
              name: "XSRF-TOKEN",
              httpOnly: false,
              secure: "auto",
              sameSite: "lax",
              path: "/",
            },
            origin: {
              trustedOrigins: ["https://example.com"],
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects invalid csrf scalar fields", () => {
      expect(() => _validateConfig({ csrf: "on" })).toThrow(
        "config.csrf must be an object",
      );
      expect(() => _validateConfig({ csrf: { enabled: "true" } })).toThrow(
        "config.csrf.enabled must be a boolean",
      );
      expect(() => _validateConfig({ csrf: { mode: "cookie" } })).toThrow(
        'config.csrf.mode must be "auto", "session", or "signed-cookie"',
      );
      expect(() => _validateConfig({ csrf: { bodyField: 123 } })).toThrow(
        "config.csrf.bodyField must be a string or false",
      );
    });

    it("requires secret for signed-cookie mode", () => {
      expect(() =>
        _validateConfig({ csrf: { mode: "signed-cookie" } }),
      ).toThrow("config.csrf.secret must be a non-empty string");
      expect(() =>
        _validateConfig({ csrf: { mode: "signed-cookie", secret: "" } }),
      ).toThrow("config.csrf.secret must be a non-empty string");
    });

    it("rejects invalid csrf arrays and nested options", () => {
      expect(() => _validateConfig({ csrf: { methods: "POST" } })).toThrow(
        "config.csrf.methods must be an array of strings",
      );
      expect(() =>
        _validateConfig({ csrf: { headerNames: ["x-csrf-token", 1] } }),
      ).toThrow("config.csrf.headerNames[] items must be strings");
      expect(() =>
        _validateConfig({ csrf: { cookie: { secure: "always" } } }),
      ).toThrow('config.csrf.cookie.secure must be a boolean or "auto"');
      expect(() =>
        _validateConfig({ csrf: { origin: { trustedOrigins: [1] } } }),
      ).toThrow("config.csrf.origin.trustedOrigins[] items must be strings");
    });
  });

  // ── securityHeaders ───────────────────────────────────

  describe("securityHeaders validation", () => {
    it("accepts valid securityHeaders config", () => {
      expect(() =>
        _validateConfig({
          securityHeaders: {
            enabled: true,
            preset: "strict",
            contentTypeOptions: "nosniff",
            referrerPolicy: "strict-origin-when-cross-origin",
            frameOptions: "SAMEORIGIN",
            hsts: {
              enabled: true,
              maxAge: 15_552_000,
              includeSubDomains: true,
              preload: true,
              force: true,
            },
            contentSecurityPolicy: {
              reportOnly: true,
              directives: {
                "default-src": ["'self'"],
                "upgrade-insecure-requests": true,
                "object-src": false,
              },
            },
            permissionsPolicy: {
              geolocation: false,
              camera: [],
              fullscreen: ["self"],
            },
            crossOriginOpenerPolicy: "same-origin",
            crossOriginEmbedderPolicy: "credentialless",
            crossOriginResourcePolicy: "same-site",
            headers: {
              "X-App-Security": "vext",
            },
            skipPaths: ["/healthz", "/public/*"],
          },
        }),
      ).not.toThrow();
    });

    it("rejects invalid securityHeaders scalar and enum fields", () => {
      expect(() => _validateConfig({ securityHeaders: true })).toThrow(
        "config.securityHeaders must be an object",
      );
      expect(() =>
        _validateConfig({ securityHeaders: { enabled: "true" } }),
      ).toThrow("config.securityHeaders.enabled must be a boolean");
      expect(() =>
        _validateConfig({ securityHeaders: { preset: "helmet" } }),
      ).toThrow(
        'config.securityHeaders.preset must be "basic" or "strict" or "custom"',
      );
      expect(() =>
        _validateConfig({
          securityHeaders: { crossOriginEmbedderPolicy: "same-origin" },
        }),
      ).toThrow(
        'config.securityHeaders.crossOriginEmbedderPolicy must be "require-corp" or "credentialless" or "unsafe-none"',
      );
    });

    it("rejects invalid securityHeaders nested options", () => {
      expect(() =>
        _validateConfig({ securityHeaders: { hsts: { maxAge: -1 } } }),
      ).toThrow("config.securityHeaders.hsts.maxAge must be a non-negative");
      expect(() =>
        _validateConfig({
          securityHeaders: {
            contentSecurityPolicy: {
              directives: { "default-src": [1] },
            },
          },
        }),
      ).toThrow(
        "config.securityHeaders.contentSecurityPolicy.directives.default-src must be a string, string array, boolean true, or false",
      );
      expect(() =>
        _validateConfig({
          securityHeaders: {
            permissionsPolicy: {
              geolocation: "self",
            },
          },
        }),
      ).toThrow(
        "config.securityHeaders.permissionsPolicy.geolocation must be a boolean or an array of strings",
      );
    });

    it("rejects header injection and invalid skipPaths", () => {
      expect(() =>
        _validateConfig({
          securityHeaders: {
            headers: {
              "X-App-Security": "ok\r\nX-Injected: yes",
            },
          },
        }),
      ).toThrow(
        "config.securityHeaders.headers.X-App-Security must not contain control characters",
      );
      expect(() =>
        _validateConfig({
          securityHeaders: {
            headers: {
              "Bad Header": "value",
            },
          },
        }),
      ).toThrow(
        "config.securityHeaders.headers.Bad Header must be a non-empty HTTP header token",
      );
      expect(() =>
        _validateConfig({
          securityHeaders: {
            skipPaths: ["/public/*/nested"],
          },
        }),
      ).toThrow(
        'config.securityHeaders.skipPaths[0] may only use "*" as the final character',
      );
    });
  });

  // ── frontend ───────────────────────────────────────────

  describe("frontend validation", () => {
    it("accepts B1 frontend integration config", () => {
      expect(() =>
        _validateConfig({
          frontend: {
            enabled: true,
            root: "src/frontend",
            pages: {
              dir: "pages",
              extensions: [".tsx", ".jsx"],
              document: "pages/_document.html",
              errorDir: "pages/error",
            },
            componentsDir: "components",
            styles: {
              entry: "styles/index.css",
              jscss: { enabled: true, runtimeAdapter: "css-variables" },
            },
            assetsDir: "assets",
            alias: {
              "@components": "components",
            },
            build: {
              client: {
                target: ["es2022"],
                splitting: true,
                external: ["react"],
                externalRuntime: {
                  react: "https://cdn.example.com/react.mjs",
                },
              },
              server: {
                outFile: "dist/client/server/renderer.cjs",
                external: ["react", "react-dom"],
              },
              vendorChunks: {
                enabled: true,
                packages: ["react", "react-dom/client"],
                entryName: "vendor",
              },
              budgets: {
                maxAssetBytes: 200_000,
                maxInitialJsBytes: 500_000,
                maxInitialJsGzipBytes: 180_000,
                maxInitialJsBrotliBytes: 150_000,
                maxRouteInitialJsBrotliBytes: 120_000,
                maxAppOwnedInitialJsBrotliBytes: 100_000,
                maxTotalBytes: 1_000_000,
                warnOnly: false,
              },
              assets: { inlineLimit: 0 },
              css: { modules: true },
              diagnostics: {
                metafile: true,
                sizeReport: true,
                performanceReport: true,
                leakScan: true,
              },
            },
            deploy: {
              assetBaseUrl: "https://cdn.example.com/app/",
              crossOrigin: "anonymous",
              integrity: false,
              upload: {
                enabled: true,
                adapter: "filesystem",
                targetDir: ".deploy/cdn",
                publicBaseUrl: "https://cdn.example.com/app/",
                prefix: "v1",
                stateFile: ".vext/deploy/frontend-state.json",
                dryRun: false,
                concurrency: 4,
                include: ["**/*"],
                exclude: ["**/*.map"],
              },
            },
            render: {
              ssr: true,
              streaming: "buffered",
              fallback: "client",
              timeoutMs: 3000,
              layout: true,
            },
            errorPages: {
              default: "error/default",
              status: { 404: "error/404" },
            },
            i18n: {
              enabled: true,
              source: "locales",
              defaultLocale: "inherit",
              detect: ["accept-language"],
              inject: "used",
              clientLoad: "current",
              clientSwitch: "reload",
              htmlLang: true,
              vary: true,
            },
            dev: {
              hot: true,
              fastRefresh: true,
              transport: "sse",
              overlay: true,
              debounceMs: 50,
              renderRefresh: "prompt",
            },
            spaFallback: {
              scopes: [
                {
                  basePath: "/admin/app",
                  page: "admin/app/shell",
                  exclude: ["/admin/api/**"],
                  status: 200,
                },
              ],
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects unsupported frontend build target fields", () => {
      expect(() =>
        _validateConfig({
          frontend: {
            build: {
              client: { outFile: "dist/client/app.js" },
            },
          },
        }),
      ).toThrow("config.frontend.build.client.outFile is not supported");

      expect(() =>
        _validateConfig({
          frontend: {
            build: {
              client: { manifest: false },
            },
          },
        }),
      ).toThrow("config.frontend.build.client.manifest is not supported");

      expect(() =>
        _validateConfig({
          frontend: {
            build: {
              server: { manifest: false },
            },
          },
        }),
      ).toThrow("config.frontend.build.server.manifest is not supported");

      expect(() =>
        _validateConfig({
          frontend: {
            build: {
              server: { outDir: "dist/client/server" },
            },
          },
        }),
      ).toThrow("config.frontend.build.server.outDir is not supported");
    });

    it("rejects invalid scoped SPA fallback page with a field-level message", () => {
      expect(() =>
        _validateConfig({
          frontend: {
            spaFallback: {
              scopes: [{ basePath: "/admin/app" }],
            },
          },
        }),
      ).toThrow("config.frontend.spaFallback.scopes[0].page");
    });

    it("rejects invalid i18n clientLoad values", () => {
      expect(() =>
        _validateConfig({
          frontend: {
            i18n: { clientLoad: "lazy" },
          },
        }),
      ).toThrow('config.frontend.i18n.clientLoad must be "current" or "all"');
    });

    it("rejects invalid compressed budget values", () => {
      expect(() =>
        _validateConfig({
          frontend: {
            build: {
              budgets: {
                maxRouteInitialJsBrotliBytes: -1,
              },
            },
          },
        }),
      ).toThrow("config.frontend.build.budgets.maxRouteInitialJsBrotliBytes");
    });
  });

  // ── fetch ───────────────────────────────────────────────

  describe("fetch validation", () => {
    const maxTimerDelay = 2_147_483_647;

    it("accepts fetch proxy target config", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            timeout: 10_000,
            retry: 1,
            retryDelay: (attempt: number) => attempt * 10,
            propagateHeaders: ["x-trace-id"],
            proxy: [
              {
                name: "userService",
                baseURL: "https://users.example.com/api",
                headers: { "x-target": "users" },
                forwardHeaders: ["x-tenant-id"],
                defaultInjectHeaders: { "x-default": "value" },
                allowAuthorizationForward: false,
                timeout: 2_000,
                retry: 0,
                retryDelay: 100,
              },
            ],
          },
        }),
      ).not.toThrow();
    });

    it("accepts fetch timer fractional and boundary values", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            timeout: maxTimerDelay,
            retryDelay: 0.5,
            proxy: [
              {
                name: "userService",
                baseURL: "https://users.example.com/api",
                timeout: maxTimerDelay,
                retryDelay: maxTimerDelay,
              },
            ],
          },
        }),
      ).not.toThrow();
    });

    it("rejects fetch timer values that native timers would overflow or coerce", () => {
      expect(() => _validateConfig({ fetch: { timeout: 0 } })).toThrow(
        "config.fetch.timeout",
      );
      expect(() =>
        _validateConfig({ fetch: { timeout: Number.POSITIVE_INFINITY } }),
      ).toThrow("config.fetch.timeout");
      expect(() =>
        _validateConfig({ fetch: { timeout: maxTimerDelay + 1 } }),
      ).toThrow("config.fetch.timeout");
      expect(() =>
        _validateConfig({ fetch: { retryDelay: Number.NaN } }),
      ).toThrow("config.fetch.retryDelay");
      expect(() =>
        _validateConfig({ fetch: { retryDelay: maxTimerDelay + 1 } }),
      ).toThrow("config.fetch.retryDelay");
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [
              {
                name: "userService",
                baseURL: "https://users.example.com/api",
                timeout: maxTimerDelay + 1,
              },
            ],
          },
        }),
      ).toThrow("config.fetch.proxy[0].timeout");
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [
              {
                name: "userService",
                baseURL: "https://users.example.com/api",
                retryDelay: Number.POSITIVE_INFINITY,
              },
            ],
          },
        }),
      ).toThrow("config.fetch.proxy[0].retryDelay");
    });

    it("rejects non-array fetch.proxy", () => {
      expect(() =>
        _validateConfig({ fetch: { proxy: { name: "userService" } } }),
      ).toThrow("config.fetch.proxy must be an array");
    });

    it("rejects duplicated fetch.proxy target names", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [
              { name: "userService", baseURL: "https://a.example.com" },
              { name: "userService", baseURL: "https://b.example.com" },
            ],
          },
        }),
      ).toThrow('config.fetch.proxy[1].name "userService" is duplicated');
    });

    it("rejects reserved fetch.proxy target names", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [{ name: "then", baseURL: "https://then.example.com" }],
          },
        }),
      ).toThrow('config.fetch.proxy[0].name "then" is reserved');
    });

    it("rejects invalid fetch.proxy baseURL", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [{ name: "userService", baseURL: "/relative" }],
          },
        }),
      ).toThrow("config.fetch.proxy[0].baseURL must be a valid URL");
    });

    it("rejects invalid fetch.proxy retry", () => {
      expect(() =>
        _validateConfig({
          fetch: {
            proxy: [
              {
                name: "userService",
                baseURL: "https://users.example.com",
                retry: -1,
              },
            ],
          },
        }),
      ).toThrow("config.fetch.proxy[0].retry must be a non-negative integer");
    });
  });

  // ── cache ───────────────────────────────────────────────

  describe("cache validation", () => {
    it("accepts Memory cacheHub config", () => {
      expect(() =>
        _validateConfig({
          cache: {
            defaultTtl: 60_000,
            maxEntries: 1000,
            maxMemory: 1024,
            cleanupInterval: 0,
            cacheHub: {
              mode: "memory",
              enableStats: true,
              enabled: true,
              cleanupInterval: 30_000,
            },
          },
        }),
      ).not.toThrow();
    });

    it("accepts Redis cacheHub config with lease and distributed invalidation", () => {
      expect(() =>
        _validateConfig({
          cache: {
            cacheHub: {
              mode: "redis",
              url: "redis://localhost:6379",
              scanCount: 200,
              deleteCommand: "unlink",
              lease: {
                ttl: 500,
                waitForOwner: 1_000,
                pollInterval: 10,
                onTimeout: "fetch",
              },
              distributed: {
                channel: "vext:response-cache",
                instanceId: "worker-1",
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it("accepts MultiLevel cacheHub config", () => {
      expect(() =>
        _validateConfig({
          cache: {
            cacheHub: {
              mode: "multi-level",
              memory: { maxEntries: 500 },
              redis: { url: "redis://localhost:6379" },
              writePolicy: "both",
              backfillOnRemoteHit: true,
              remoteTimeout: 50,
              remoteInvalidationErrors: "ignore",
              lease: true,
              distributed: true,
            },
          },
        }),
      ).not.toThrow();
    });

    it("rejects invalid cacheHub mode", () => {
      expect(() =>
        _validateConfig({ cache: { cacheHub: { mode: "custom-store" } } }),
      ).toThrow(
        'config.cache.cacheHub.mode must be "memory", "redis", or "multi-level"',
      );
    });

    it("rejects invalid Redis deleteCommand", () => {
      expect(() =>
        _validateConfig({
          cache: {
            cacheHub: {
              mode: "redis",
              deleteCommand: "flushdb",
            },
          },
        }),
      ).toThrow(
        'config.cache.cacheHub.deleteCommand must be "del" or "unlink"',
      );
    });

    it("rejects null Redis client references", () => {
      expect(() =>
        _validateConfig({
          cache: {
            cacheHub: {
              mode: "redis",
              client: null,
            },
          },
        }),
      ).toThrow("config.cache.cacheHub.client must be an object");
    });

    it("rejects invalid lease timeout mode", () => {
      expect(() =>
        _validateConfig({
          cache: {
            cacheHub: {
              mode: "redis",
              lease: { onTimeout: "wait" },
            },
          },
        }),
      ).toThrow(
        'config.cache.cacheHub.lease.onTimeout must be "fetch" or "throw"',
      );
    });
  });
});

// ── VEXT_PORT / VEXT_HOST 环境变量覆盖（BUG-013 防回归）───────

describe("loadConfig — VEXT_PORT / VEXT_HOST 环境变量覆盖", () => {
  let tmpDir: string;
  let savedPort: string | undefined;
  let savedHost: string | undefined;
  let savedLifecycleLevel: string | undefined;
  let savedConfigProfile: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    // 创建临时 config 目录，写入最小 default.ts
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vext-config-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "default.js"),
      `module.exports = { port: 3000, host: "0.0.0.0" };\n`,
    );
    // 保存环境变量
    savedPort = process.env.VEXT_PORT;
    savedHost = process.env.VEXT_HOST;
    savedLifecycleLevel = process.env.VEXT_LIFECYCLE_LEVEL;
    savedConfigProfile = process.env.VEXT_CONFIG;
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    delete process.env.VEXT_CONFIG;
  });

  afterEach(() => {
    // 恢复环境变量
    if (savedPort !== undefined) {
      process.env.VEXT_PORT = savedPort;
    } else {
      delete process.env.VEXT_PORT;
    }
    if (savedHost !== undefined) {
      process.env.VEXT_HOST = savedHost;
    } else {
      delete process.env.VEXT_HOST;
    }
    if (savedLifecycleLevel !== undefined) {
      process.env.VEXT_LIFECYCLE_LEVEL = savedLifecycleLevel;
    } else {
      delete process.env.VEXT_LIFECYCLE_LEVEL;
    }
    if (savedConfigProfile !== undefined) {
      process.env.VEXT_CONFIG = savedConfigProfile;
    } else {
      delete process.env.VEXT_CONFIG;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("VEXT_PORT 应覆盖 config.port", async () => {
    process.env.VEXT_PORT = "8080";
    delete process.env.VEXT_HOST;

    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(8080);
  });

  it("VEXT_HOST 应覆盖 config.host", async () => {
    delete process.env.VEXT_PORT;
    process.env.VEXT_HOST = "127.0.0.1";

    const config = await loadConfig(tmpDir);
    expect(config.host).toBe("127.0.0.1");
  });

  it("VEXT_PORT 和 VEXT_HOST 可同时覆盖", async () => {
    process.env.VEXT_PORT = "9090";
    process.env.VEXT_HOST = "localhost";

    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(9090);
    expect(config.host).toBe("localhost");
  });

  it("无 VEXT_PORT 时应使用 config 文件中的 port", async () => {
    delete process.env.VEXT_PORT;
    delete process.env.VEXT_HOST;

    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(3000);
    expect(config.host).toBe("0.0.0.0");
  });

  it("VEXT_PORT 非法值应被忽略（保留 config 值）", async () => {
    process.env.VEXT_PORT = "not-a-number";
    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(3000);
  });

  it("VEXT_PORT 数字前缀后含非法字符时应整体拒绝覆盖", async () => {
    process.env.VEXT_PORT = "3000x";
    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(3000);
  });

  it("VEXT_PORT=0 应被忽略（port < 1）", async () => {
    process.env.VEXT_PORT = "0";
    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(3000);
  });

  it("VEXT_PORT=70000 应被忽略（port > 65535）", async () => {
    process.env.VEXT_PORT = "70000";
    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(3000);
  });

  it("VEXT_PORT 应具有最高优先级（高于 config 文件）", async () => {
    // 写一个指定 port 的 config
    fs.writeFileSync(
      path.join(tmpDir, "default.js"),
      `module.exports = { port: 4000 };\n`,
    );
    process.env.VEXT_PORT = "5000";

    const config = await loadConfig(tmpDir);
    expect(config.port).toBe(5000);
  });

  it("返回的 config 应是冻结的（deepFreeze）", async () => {
    process.env.VEXT_PORT = "8080";
    const config = await loadConfig(tmpDir);

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as Record<string, unknown>).port = 9999;
    }).toThrow();
  });

  it("配置文件中的原型链危险键不会污染全局或配置对象原型", async () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).pollutedCtor;

    fs.writeFileSync(
      path.join(tmpDir, "default.js"),
      `const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"pollutedCtor":true}},"port":3000}');\nmodule.exports = value;\n`,
    );

    const config = await loadConfig(tmpDir);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).pollutedCtor).toBeUndefined();
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.hasOwn(config, "__proto__")).toBe(false);
    expect(Object.hasOwn(config, "constructor")).toBe(false);
  });

  it("VEXT_LIFECYCLE_LEVEL 应覆盖 logger.lifecycleLevel", async () => {
    delete process.env.VEXT_PORT;
    delete process.env.VEXT_HOST;
    process.env.VEXT_LIFECYCLE_LEVEL = "verbose";

    const config = await loadConfig(tmpDir);
    expect(config.logger?.lifecycleLevel).toBe("verbose");
  });
});

describe("loadConfig — config profile selection", () => {
  let tmpDir: string;
  let savedConfigProfile: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vext-profile-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "default.js"),
      `module.exports = { port: 3000, host: "default.local" };\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "development.js"),
      `module.exports = { port: 3001, host: "development.local" };\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "production.js"),
      `module.exports = { port: 3002, host: "production.local" };\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "sg-sit.js"),
      `module.exports = { port: 3100, host: "sg-sit.local" };\n`,
    );

    savedConfigProfile = process.env.VEXT_CONFIG;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VEXT_CONFIG;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedConfigProfile !== undefined) {
      process.env.VEXT_CONFIG = savedConfigProfile;
    } else {
      delete process.env.VEXT_CONFIG;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads an explicit configProfile independent of NODE_ENV", async () => {
    process.env.NODE_ENV = "production";

    const config = await loadConfig(tmpDir, {
      command: "start",
      mode: "production",
      configProfile: "sg-sit",
    });

    expect(config.port).toBe(3100);
    expect(config.host).toBe("sg-sit.local");
  });

  it("loads VEXT_CONFIG when configProfile is not passed", async () => {
    process.env.VEXT_CONFIG = "sg-sit";
    process.env.NODE_ENV = "production";

    const config = await loadConfig(tmpDir, {
      command: "start",
    });

    expect(config.port).toBe(3100);
  });

  it("does not use standard NODE_ENV values as config profile names", async () => {
    process.env.NODE_ENV = "production";

    const config = await loadConfig(tmpDir, {
      command: "dev",
    });

    expect(config.port).toBe(3001);
    expect(config.host).toBe("development.local");
  });

  it("supports legacy custom NODE_ENV as a fallback profile", async () => {
    process.env.NODE_ENV = "sg-sit";

    const config = await loadConfig(tmpDir, {
      command: "start",
    });

    expect(config.port).toBe(3100);
  });

  it("applies local config after the selected profile", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "local.js"),
      `module.exports = { host: "local.local" };\n`,
    );

    const config = await loadConfig(tmpDir, {
      command: "start",
      configProfile: "sg-sit",
    });

    expect(config.port).toBe(3100);
    expect(config.host).toBe("local.local");
  });

  it("deeply merges a complete base database with profile and local patches", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "default.js"),
      `module.exports = {
  port: 3000,
  host: "default.local",
  database: {
    config: { uri: "mongodb://127.0.0.1:27017/app" },
    findLimit: 10,
    models: { dir: "models", autoRegister: true }
  }
};\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "development.js"),
      `module.exports = {
  database: { findLimit: 25, models: { validation: "strict" } }
};\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "local.js"),
      `module.exports = { database: { models: { dir: "local-models" } } };\n`,
    );

    const config = await loadConfig(tmpDir, { command: "dev" });

    expect(config.database).toEqual({
      config: { uri: "mongodb://127.0.0.1:27017/app" },
      findLimit: 25,
      models: {
        dir: "local-models",
        autoRegister: true,
        validation: "strict",
      },
    });
  });
});

describe("loadConfig — bootstrap config provider", () => {
  let tmpRoot: string;
  let configDir: string;
  let savedNodeEnv: string | undefined;
  let savedConfigProfile: string | undefined;
  let savedPort: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vext-bootstrap-provider-"),
    );
    configDir = path.join(tmpRoot, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "default.js"),
      `module.exports = { port: 3000, host: "default.local", logger: { level: "info" } };\n`,
    );
    fs.writeFileSync(
      path.join(configDir, "local.js"),
      `module.exports = { host: "local.local" };\n`,
    );

    savedNodeEnv = process.env.NODE_ENV;
    savedConfigProfile = process.env.VEXT_CONFIG;
    savedPort = process.env.VEXT_PORT;
    savedHost = process.env.VEXT_HOST;
    process.env.NODE_ENV = "test";
    delete process.env.VEXT_CONFIG;
    delete process.env.VEXT_PORT;
    delete process.env.VEXT_HOST;
  });

  afterEach(() => {
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (savedConfigProfile !== undefined) {
      process.env.VEXT_CONFIG = savedConfigProfile;
    } else {
      delete process.env.VEXT_CONFIG;
    }
    if (savedPort !== undefined) {
      process.env.VEXT_PORT = savedPort;
    } else {
      delete process.env.VEXT_PORT;
    }
    if (savedHost !== undefined) {
      process.env.VEXT_HOST = savedHost;
    } else {
      delete process.env.VEXT_HOST;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("applies provider patch after local config and before CLI overrides", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = {
  providers: [{
    name: "test-provider",
    async load() {
      return { host: "provider.local", logger: { lifecycleLevel: "concise" } };
    }
  }]
};\n`,
    );

    process.env.VEXT_HOST = "cli.local";

    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "start",
    });

    expect(config.host).toBe("cli.local");
    expect(config.logger?.lifecycleLevel).toBe("concise");
  });

  it("passes mode and configProfile to bootstrap providers", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = {
  providers: [{
    name: "context-provider",
    load(ctx) {
      return {
        host: ctx.configProfile + "." + ctx.mode + "." + ctx.env,
        logger: { level: ctx.mode === "production" ? "warn" : "debug" }
      };
    }
  }]
};\n`,
    );

    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "start",
      mode: "production",
      configProfile: "sg-sit",
    });

    expect(config.host).toBe("sg-sit.production.production");
    expect(config.logger?.level).toBe("warn");
  });

  it("allows optional provider failure outside production", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = {
  providers: [{
    name: "unstable-provider",
    async load() {
      throw new Error("network down");
    }
  }]
};\n`,
    );

    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "dev",
    });

    expect(config.host).toBe("local.local");
  });

  it("fails fast for default-required provider in production", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = {
  providers: [{
    name: "required-provider",
    async load() {
      throw new Error("remote unavailable");
    }
  }]
};\n`,
    );

    process.env.NODE_ENV = "production";

    await expect(
      loadConfig(configDir, {
        rootDir: tmpRoot,
        command: "start",
      }),
    ).rejects.toThrow('Bootstrap config provider "required-provider" failed');
  });

  it("enforces a hard provider deadline and ignores a late result", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = {
  providers: [{
    name: "late-provider",
    required: true,
    timeoutMs: 10,
    load(ctx) {
      globalThis.__vextProviderTimeoutSignal = ctx.signal;
      return new Promise((resolve) => {
        setTimeout(() => {
          globalThis.__vextProviderLateResolved = true;
          resolve({ host: "late.example" });
        }, 60);
      });
    }
  }]
};\n`,
    );

    const meta: { providerPatch?: Record<string, unknown> } = {};
    await expect(
      loadConfig(configDir, {
        rootDir: tmpRoot,
        command: "start",
        mode: "production",
        meta,
      }),
    ).rejects.toThrow('provider "late-provider" failed: Provider timeout');

    const timeoutGlobal = globalThis as typeof globalThis & {
      __vextProviderTimeoutSignal?: AbortSignal;
      __vextProviderLateResolved?: boolean;
    };
    expect(timeoutGlobal.__vextProviderTimeoutSignal?.aborted).toBe(true);
    expect(timeoutGlobal.__vextProviderLateResolved).not.toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(timeoutGlobal.__vextProviderLateResolved).toBe(true);
    expect(meta.providerPatch).toBeUndefined();
    delete timeoutGlobal.__vextProviderTimeoutSignal;
    delete timeoutGlobal.__vextProviderLateResolved;
  });

  it("loads TypeScript config and bootstrap files with local imports", async () => {
    fs.rmSync(path.join(configDir, "default.js"));
    fs.writeFileSync(
      path.join(configDir, "shared.ts"),
      `export const port: number = 3210;\n`,
    );
    fs.writeFileSync(
      path.join(configDir, "default.ts"),
      `import { port } from "./shared.js";\nexport default { port, host: "ts.local" } satisfies Record<string, unknown>;\n`,
    );
    fs.writeFileSync(
      path.join(configDir, "bootstrap.ts"),
      `type Patch = Record<string, unknown>;\nexport default { providers: [{ name: "ts-provider", load(): Patch { return { logger: { level: "debug" } }; } }] };\n`,
    );

    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "dev",
    });

    expect(config.port).toBe(3210);
    expect(config.logger.level).toBe("debug");
    expect(
      fs
        .readdirSync(configDir)
        .some((name) => name.includes(".__vext_compiled__")),
    ).toBe(false);
  });

  it("validates every provider before reading provider fields", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = { providers: [null] };\n`,
    );
    await expect(
      loadConfig(configDir, { rootDir: tmpRoot, command: "dev" }),
    ).rejects.toThrow("providers[0] must be an object");

    const timeoutConfigDir = path.join(tmpRoot, "src", "config-timeout");
    fs.mkdirSync(timeoutConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(timeoutConfigDir, "default.ts"),
      `export default {};\n`,
    );
    fs.writeFileSync(
      path.join(timeoutConfigDir, "bootstrap.ts"),
      `export default { providers: [{ name: "bad-timeout", timeoutMs: -1, load() { return {}; } }] };\n`,
    );
    await expect(
      loadConfig(timeoutConfigDir, { rootDir: tmpRoot, command: "dev" }),
    ).rejects.toThrow("timeoutMs must be a finite non-negative number");
  });

  it("deeply merges sequential provider patches", async () => {
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = { providers: [
        { name: "one", load() { return { logger: { level: "debug", redactValue: "one" }, custom: { a: 1 }, list: [1] }; } },
        { name: "two", load() { return { logger: { lifecycleLevel: "verbose" }, custom: { b: 2 }, list: [2] }; } }
      ] };\n`,
    );

    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "dev",
    });
    expect(config.logger.level).toBe("debug");
    expect(config.logger.lifecycleLevel).toBe("verbose");
    expect((config as unknown as { custom: unknown }).custom).toEqual({
      a: 1,
      b: 2,
    });
    expect((config as unknown as { list: unknown }).list).toEqual([2]);
  });

  it("filters prototype pollution keys from bootstrap provider patches", async () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).pollutedCtor;
    fs.writeFileSync(
      path.join(configDir, "bootstrap.js"),
      `module.exports = { providers: [{
        name: "pollution-provider",
        load() {
          return JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"pollutedCtor":true}},"custom":{"safe":true,"prototype":{"nested":true}}}');
        }
      }] };\n`,
    );

    const meta: { providerPatch?: Record<string, unknown> } = {};
    const config = await loadConfig(configDir, {
      rootDir: tmpRoot,
      command: "dev",
      meta,
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).pollutedCtor).toBeUndefined();
    expect(Object.getPrototypeOf(meta.providerPatch!)).toBe(Object.prototype);
    expect(Object.hasOwn(meta.providerPatch!, "__proto__")).toBe(false);
    expect(Object.hasOwn(meta.providerPatch!, "constructor")).toBe(false);
    expect(meta.providerPatch!.custom).toEqual({ safe: true });
    expect((config as unknown as { custom: unknown }).custom).toEqual({
      safe: true,
    });
  });
});
