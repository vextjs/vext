import { describe, expect, it } from "vitest";
import { flattenQueryRecord, parseQueryString } from "../../src/lib/query.js";

describe("query normalization", () => {
  it("uses first-wins for multi-value query strings", () => {
    expect(parseQueryString("dup=a&dup=b")).toEqual({ dup: "a" });
    expect(parseQueryString("single=value&empty=")).toEqual({
      single: "value",
      empty: "",
    });
  });

  it("flattens host framework arrays to the first string", () => {
    expect(
      flattenQueryRecord({
        dup: ["a", "b"],
        single: "value",
        nested: { ignored: true },
      }),
    ).toEqual({
      dup: "a",
      single: "value",
    });
  });

  it("preserves legal prototype-named query keys as enumerable own properties", () => {
    const parsed = parseQueryString(
      "__proto__=proto&constructor=ctor&toString=string&dup=a&dup=b",
    );
    const flattened = flattenQueryRecord(
      JSON.parse('{"__proto__":"proto","constructor":"ctor"}'),
    );

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toBe("proto");
    expect(parsed.constructor).toBe("ctor");
    expect(parsed.toString).toBe("string");
    expect(parsed.dup).toBe("a");
    expect(Object.getPrototypeOf(flattened)).toBe(Object.prototype);
    expect(Object.hasOwn(flattened, "__proto__")).toBe(true);
    expect(flattened.__proto__).toBe("proto");
  });
});
