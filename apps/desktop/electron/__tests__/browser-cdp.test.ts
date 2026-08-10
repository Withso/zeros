import { describe, expect, it } from "vitest";

import { parseBrowserCdpRequest } from "../browser-cdp";

describe("developer browser CDP boundary", () => {
  it("accepts a bounded method and object parameters", () => {
    expect(
      parseBrowserCdpRequest({
        method: "Runtime.evaluate",
        params: { expression: "document.title", returnByValue: true },
      }),
    ).toEqual({
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true },
    });
  });

  it("rejects malformed methods, non-object parameters, and oversized requests", () => {
    expect(() => parseBrowserCdpRequest({ method: "bad method" })).toThrow(
      /method/i,
    );
    expect(() =>
      parseBrowserCdpRequest({ method: "Runtime.evaluate", params: [] }),
    ).toThrow(/parameters/i);
    expect(() =>
      parseBrowserCdpRequest({
        method: "Runtime.evaluate",
        params: { expression: "x".repeat(200_000) },
      }),
    ).toThrow(/large/i);
  });
});
