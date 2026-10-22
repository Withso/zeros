import { expect, it } from "vitest";
import { createPrivateRateLimitKey } from "./ratelimit.js";

it("keeps one limiter's buckets stable without retaining the credential", () => {
  const key = createPrivateRateLimitKey(), credential = "synthetic-worker-credential";
  expect(key(credential)).toBe(key(credential));
  expect(key(credential)).not.toContain(credential);
  expect(key(credential)).not.toBe(key("another-synthetic-credential"));
});

it("does not expose a reusable credential fingerprint across process instances", () => {
  const first = createPrivateRateLimitKey(), second = createPrivateRateLimitKey();
  expect(first("synthetic-worker-credential")).not.toBe(second("synthetic-worker-credential"));
});
