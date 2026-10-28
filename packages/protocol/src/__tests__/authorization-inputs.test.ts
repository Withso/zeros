import { describe, expect, it } from "vitest";
import { localModeForLevel, localModeLevel } from "../local-orchestration";
import { redactLogSecrets, redactSensitive } from "../scrub";

describe("untrusted permission names", () => {
  it.each(["constructor", "toString", "__proto__", "unknown"])("rejects %s across providers", (mode) => {
    for (const provider of ["claude", "codex", "cursor"]) {
      expect(localModeLevel(provider, mode)).toBeNull();
      expect(localModeForLevel(provider, mode as never)).toBeNull();
    }
  });
});

it("redacts email candidates in bounded time without truncating neighboring credentials", () => {
  const malformed = "a.".repeat(32_768);
  const text = `${malformed} user@example.test token=synthetic-secret`;
  for (const redact of [redactSensitive, redactLogSecrets]) {
    const start = performance.now();
    const result = redact(text);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result).not.toContain("user@example.test");
  }
  expect(redactLogSecrets(text)).not.toContain("synthetic-secret");
});

it.each(["A", "-", "_"])("redacts an opaque desktop session handle ending in %s outside named secret fields", last => {
  const handle = `z0d_${"A".repeat(42)}${last}`;
  for (const redact of [redactSensitive, redactLogSecrets]) {
    expect(redact(`desktop handle ${handle}; retry`)).toBe("desktop handle [redacted]; retry");
    expect(redact(`https://example.test/?sessionId=${handle}`)).not.toContain(handle);
  }
  expect(redactLogSecrets("session 12345678-1234-1234-1234-123456789abc")).toBe("session 12345678-1234-1234-1234-123456789abc");
});
