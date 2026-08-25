import { describe, expect, it, vi } from "vitest";
import { createBodyParserMiddleware } from "../../src/lib/middlewares/body-parser.js";
import type { VextRequest } from "../../src/types/request.js";
import type { VextResponse } from "../../src/types/response.js";

describe("URL-encoded body record safety", () => {
  it("preserves __proto__ as an enumerable own field without prototype mutation", async () => {
    const rawBody = Buffer.from(
      "__proto__=proto&constructor=ctor&toString=string",
    );
    const req = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      requestId: "body-record",
      body: undefined,
      _getRawBodyBuffer: vi.fn().mockResolvedValue(rawBody),
    } as unknown as VextRequest;
    const res = { rawJson: vi.fn() } as unknown as VextResponse;
    const next = vi.fn();

    await createBodyParserMiddleware({ enabled: true })(req, res, next);

    const body = req.body as Record<string, string>;
    expect(next).toHaveBeenCalledOnce();
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect(body.__proto__).toBe("proto");
    expect(body.constructor).toBe("ctor");
    expect(body.toString).toBe("string");
  });
});
