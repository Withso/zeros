import { describe, expect, it } from "vitest";

import {
  MAX_EXTERNAL_URL_LENGTH,
  normalizeExternalHttpUrl,
} from "../external-url";

describe("normalizeExternalHttpUrl", () => {
  it("accepts and canonicalizes ordinary browser URLs", () => {
    expect(normalizeExternalHttpUrl("https://example.com/docs?q=1#part")).toBe(
      "https://example.com/docs?q=1#part",
    );
    expect(normalizeExternalHttpUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/",
    );
  });

  it("rejects non-web schemes, userinfo, malformed/control input, and oversized values", () => {
    for (const value of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.com/",
      " https://example.com/",
      "https://example.com/\nnext",
      "not a url",
      "",
      "https://example.com/" + "a".repeat(MAX_EXTERNAL_URL_LENGTH),
    ]) {
      expect(normalizeExternalHttpUrl(value)).toBeNull();
    }
  });
});
