import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createVextResponse as createNativeResponse } from "../../../src/adapters/native/response.js";
import { createVextResponse as createExpressResponse } from "../../../src/adapters/express/response.js";
import { createVextResponse as createFastifyResponse } from "../../../src/adapters/fastify/response.js";
import { createVextResponse as createKoaResponse } from "../../../src/adapters/koa/response.js";
import {
  createResponseBox,
  createVextResponse as createHonoResponse,
} from "../../../src/adapters/hono/response.js";
import { createHookManager } from "../../../src/lib/hooks.js";
import { waitForResponseSend } from "../../../src/lib/response-hooks.js";
import type { VextResponse } from "../../../src/types/response.js";

interface ResponseHarness {
  res: VextResponse;
  headers: Record<string, unknown>;
  status(): number;
  settleStream(readable: NodeJS.ReadableStream): void;
}

function nodeResponseHarness(
  create: (host: any, requestId: any) => VextResponse,
): ResponseHarness {
  const headers: Record<string, unknown> = {};
  const host = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
    },
    removeHeader: vi.fn(),
    end: vi.fn(),
  });
  return {
    res: create(host, () => "req-1"),
    headers,
    status: () => host.statusCode,
    settleStream: () => {
      host.emit("finish");
    },
  };
}

function fastifyResponseHarness(): ResponseHarness {
  const headers: Record<string, unknown> = {};
  let statusCode = 200;
  const raw = new EventEmitter();
  const reply = {
    raw,
    status(code: number) {
      statusCode = code;
      return reply;
    },
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    send: vi.fn(),
  };
  return {
    res: createFastifyResponse(reply as any, () => "req-1"),
    headers,
    status: () => statusCode,
    settleStream: () => {
      raw.emit("finish");
    },
  };
}

function koaResponseHarness(): ResponseHarness {
  const harness = nodeResponseHarness((host) =>
    createKoaResponse({ res: host } as any, () => "req-1"),
  );
  return harness;
}

function honoResponseHarness(): ResponseHarness {
  const headers: Record<string, unknown> = {};
  let statusCode = 200;
  const context = {
    status(code: number) {
      statusCode = code;
    },
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
    },
    body: vi.fn(() => new Response(null, { status: statusCode })),
  };
  return {
    res: createHonoResponse(context as any, () => "req-1", createResponseBox()),
    headers,
    status: () => statusCode,
    settleStream: (readable: NodeJS.ReadableStream) => {
      (readable as unknown as EventEmitter).emit("end");
    },
  };
}

function createReadable() {
  return Object.assign(new EventEmitter(), {
    pipe: vi.fn(),
  }) as unknown as NodeJS.ReadableStream;
}

const adapters: Array<[string, () => ResponseHarness]> = [
  ["native", () => nodeResponseHarness(createNativeResponse as any)],
  ["express", () => nodeResponseHarness(createExpressResponse as any)],
  ["fastify", fastifyResponseHarness],
  ["koa", koaResponseHarness],
  ["hono", honoResponseHarness],
];

describe.each(adapters)(
  "%s response exit lifecycle",
  (_name, createHarness) => {
    it.each(["redirect", "download"] as const)(
      "runs the internal hook for %s responses",
      (kind) => {
        const { res, headers, status } = createHarness();
        const seen: string[] = [];
        res._onBeforeSend = (responseKind, _data, _status, responseHeaders) => {
          seen.push(responseKind);
          responseHeaders["Set-Cookie"] = "sid=1";
        };

        if (kind === "redirect") {
          res.redirect("/next", 307);
          // Terminal redirects are deferred until adapter `_flush`.
          res._flush?.();
          expect(status()).toBe(307);
          expect(headers.location).toBe("/next");
        } else {
          const readable = {
            pipe: vi.fn(),
          } as unknown as NodeJS.ReadableStream;
          res.download(readable, "report.txt", "text/plain");
          expect(headers["content-type"]).toBe("text/plain");
          expect(headers["content-disposition"]).toBe(
            'attachment; filename="report.txt"',
          );
        }

        expect(seen).toEqual([kind]);
        expect(headers["set-cookie"]).toBe("sid=1");
      },
    );

    it("emits response:after only after stream settlement", async () => {
      const { res, settleStream } = createHarness();
      const hooks = createHookManager();
      const after = vi.fn();
      hooks.on("response:after", after);
      res._hooks = hooks;
      const readable = createReadable();

      res.stream(readable, "text/plain");

      await Promise.resolve();
      expect(after).not.toHaveBeenCalled();

      settleStream(readable);
      await waitForResponseSend(res);

      expect(after).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "stream",
          status: 200,
          requestId: "req-1",
        }),
      );
    });

    it("uses a deterministic safe Content-Disposition for unsafe download filenames", () => {
      const { res, headers } = createHarness();
      const readable = {
        pipe: vi.fn(),
      } as unknown as NodeJS.ReadableStream;

      res.download(readable, 'report-张三"\r\n.csv', "text/csv");

      expect(headers["content-disposition"]).toBe(
        "attachment; filename=\"report-_____.csv\"; filename*=UTF-8''report-%E5%BC%A0%E4%B8%89%22__.csv",
      );
      expect(String(headers["content-disposition"])).not.toMatch(/[\r\n]/);
    });

    it("exposes headersSent and writes deterministic JSON length", () => {
      const { res, headers } = createHarness();
      const body = JSON.stringify({ ok: true });

      expect(res.headersSent).toBe(false);
      expect(res._isSent()).toBe(false);

      res.json({ ok: true });
      // `_sent` flips immediately; host write happens on `_flush`.
      expect(res.headersSent).toBe(true);
      expect(res._isSent()).toBe(true);

      res._flush?.();
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(String(headers["content-length"])).toBe(
        String(Buffer.byteLength(body)),
      );
    });

    it("keeps the response reusable when JSON serialization fails", () => {
      const { res, headers } = createHarness();

      expect(() => res.json({ value: 1n })).toThrow();
      expect(res.headersSent).toBe(false);
      expect(res._isSent()).toBe(false);

      res.rawJson({ ok: true });
      expect(res.headersSent).toBe(true);

      res._flush?.();
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("can discard a buffered success before the host flushes", () => {
      const { res, headers } = createHarness();

      res.json({ ok: true });
      expect(res._isSent()).toBe(true);
      expect(res._discardPendingSend?.()).toBe(true);
      expect(res._isSent()).toBe(false);

      res.rawJson({ code: 500 }, 500);
      res._flush?.();
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("rejects invalid response header names and values before send", () => {
      const { res } = createHarness();

      expect(() => res.setHeader("bad\r\nname", "value")).toThrow();
      expect(() => res.setHeader("x-bad", "bad\r\nvalue")).toThrow();
      expect(res.headersSent).toBe(false);
    });
  },
);
