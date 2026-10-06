import { describe, expect, it } from "vitest";
import { designHistorySourceVersions } from "../route-params";

describe("cloud Design history source preconditions", () => {
  it("accepts portable legacy and page-qualified frames without changing their generations", () => {
    const input = {
      "home.html": "a".repeat(24),
      "page-1/home.html": "b".repeat(24),
    };
    expect(designHistorySourceVersions(input)).toBe(input);
    expect(designHistorySourceVersions({})).toEqual({});
  });
  it.each([
    null,
    [],
    "generation",
    { "../home.html": "a".repeat(24) },
    { "home.html": "not-a-generation" },
    { "home.html": 123 },
    Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `frame-${index}.html`,
        "a".repeat(24),
      ]),
    ),
  ])("rejects malformed or oversized preconditions (%#)", (value) => {
    expect(() => designHistorySourceVersions(value)).toThrow(
      /Invalid Design history/,
    );
  });
});
