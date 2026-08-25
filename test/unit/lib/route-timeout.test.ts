import { describe, expect, it, vi } from "vitest";
import { createRouteTimeoutMiddleware } from "../../../src/lib/middlewares/route-timeout.js";
import type { VextRequest } from "../../../src/types/request.js";
import type { VextResponse } from "../../../src/types/response.js";

function createContext() {
  let sent = false;
  const req = {
    requestId: "req-timeout",
    signal: new AbortController().signal,
    app: { logger: { error: vi.fn() } },
  } as unknown as VextRequest;
  const res = {
    rawJson: vi.fn(() => {
      sent = true;
    }),
    _isSent: vi.fn(() => sent),
  } as unknown as VextResponse;
  return { req, res };
}

describe("route timeout middleware", () => {
  it("sends a 504 response when the route exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { req, res } = createContext();
      let release!: () => void;
      const downstream = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = createRouteTimeoutMiddleware(50)(
        req,
        res,
        () => downstream,
      );

      await vi.advanceTimersByTimeAsync(50);
      await running;
      expect(res.rawJson).toHaveBeenCalledWith(
        {
          code: 504,
          message: "Request Timeout",
          requestId: "req-timeout",
        },
        504,
      );
      expect(req.signal.aborted).toBe(true);

      release();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles at the deadline and exposes cooperative cancellation", async () => {
    vi.useFakeTimers();
    try {
      const { req, res } = createContext();
      let release!: () => void;
      let lateWriteCommitted = false;
      const running = createRouteTimeoutMiddleware(25)(req, res, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (!req.signal.aborted) {
          lateWriteCommitted = true;
        }
      });

      await vi.advanceTimersByTimeAsync(25);
      await running;
      expect(req.signal.aborted).toBe(true);
      expect(res.rawJson).toHaveBeenCalledTimes(1);

      release();
      await Promise.resolve();
      expect(lateWriteCommitted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline when a response starts", async () => {
    vi.useFakeTimers();
    try {
      const { req, res } = createContext();
      await createRouteTimeoutMiddleware(50)(req, res, async () => {
        res._onBeforeSend?.("json", { ok: true }, 200, {});
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(res.rawJson).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid timeout values during route registration", () => {
    expect(() => createRouteTimeoutMiddleware(0)).toThrow(
      "must be a positive integer",
    );
    expect(() => createRouteTimeoutMiddleware(1.5)).toThrow(
      "must be a positive integer",
    );
  });
});
