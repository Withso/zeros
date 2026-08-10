import { describe, expect, it } from "vitest";

import { resolveAppBaseUrl } from "../app-base-url";

describe("resolveAppBaseUrl", () => {
  it("uses the first configured origin and normalizes its trailing slash", () => {
    expect(
      resolveAppBaseUrl([
        "",
        "https://app-alpha.zeros.build/",
        "https://app.zeros.build",
      ]),
    ).toBe("https://app-alpha.zeros.build");
  });

  it("defaults to production only when no candidate exists", () => {
    expect(resolveAppBaseUrl(["", "  "])).toBe("https://app.zeros.build");
  });

  it("allows loopback HTTP for local development", () => {
    expect(resolveAppBaseUrl(["http://127.0.0.1:8788"])).toBe(
      "http://127.0.0.1:8788",
    );
  });

  it("rejects insecure, credential-bearing, and path-bearing destinations", () => {
    for (const raw of [
      "http://app-alpha.zeros.build",
      "https://user:pass@app-alpha.zeros.build",
      "https://app-alpha.zeros.build/handoff",
      "javascript:alert(1)",
    ]) {
      expect(() => resolveAppBaseUrl([raw]), raw).toThrow();
    }
  });
});
