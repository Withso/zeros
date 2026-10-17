import { describe, expect, it } from "vitest";

import { createTraceparent, TRACEPARENT_PATTERN } from "../trace-context";

describe("createTraceparent", () => {
  it("encodes injected trace and parent IDs with the sampled flag", () => {
    const randomBytes = (length: number) => Uint8Array.from({ length }, (_, index) => index);
    expect(createTraceparent({ sampled: true, randomBytes })).toBe(
      "00-000102030405060708090a0b0c0d0e0f-0001020304050607-01",
    );
    expect(createTraceparent({ sampled: false, randomBytes })).toBe(
      "00-000102030405060708090a0b0c0d0e0f-0001020304050607-00",
    );
  });

  it("replaces all-zero IDs with a valid non-zero last byte", () => {
    const value = createTraceparent({ sampled: true, randomBytes: length => new Uint8Array(length) });
    expect(value).toBe("00-00000000000000000000000000000001-0000000000000001-01");
    expect(TRACEPARENT_PATTERN.test(value)).toBe(true);
  });

  it("generates distinct, valid values by default", () => {
    const values = Array.from({ length: 100 }, () => createTraceparent({ sampled: false }));
    expect(new Set(values).size).toBe(100);
    for (const value of values) expect(value).toMatch(TRACEPARENT_PATTERN);
  });

  it("rejects a random source that returns the wrong length", () => {
    expect(() => createTraceparent({ sampled: true, randomBytes: () => new Uint8Array(3) })).toThrow(RangeError);
  });
});
