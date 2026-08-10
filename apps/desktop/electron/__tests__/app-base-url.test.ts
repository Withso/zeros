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

  it("skips invalid configured values and continues through precedence", () => {
    expect(
      resolveAppBaseUrl([
        "https://app-alpha.zeros.build/handoff",
        "https://app-beta.zeros.build/",
        "https://app.zeros.build",
      ]),
    ).toBe("https://app-beta.zeros.build");
  });

  it("falls back to production when every configured value is invalid", () => {
    expect(
      resolveAppBaseUrl([
        "http://app-alpha.zeros.build",
        "https://user:pass@app-alpha.zeros.build",
        "javascript:alert(1)",
      ]),
    ).toBe("https://app.zeros.build");
  });
});
