import { describe, expect, it } from "vitest";
import {
  appendHeader,
  getHeaderValues,
  setHeader,
} from "../../../src/lib/headers.js";
import type { VextHeaders } from "../../../src/types/headers.js";

describe("header record own-property safety", () => {
  it("stores __proto__ as a legal own header without changing the bag prototype", () => {
    const headers: VextHeaders = {};

    setHeader(headers, "__proto__", ["first", "second"]);
    appendHeader(headers, "__proto__", "third");

    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(Object.keys(headers)).toContain("__proto__");
    expect(getHeaderValues(headers, "__proto__")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
