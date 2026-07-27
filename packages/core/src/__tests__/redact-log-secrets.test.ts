// redactLogSecrets — the LOG-payload scrubber (feedback exports / View).
//
// Contract: credential material is removed; session UUIDs, file paths, and
// commit SHAs SURVIVE (that's what makes shared logs debuggable — the
// aggressive analytics scrubber redactSensitive() would destroy them).

import { describe, it, expect } from "vitest";
import { redactLogSecrets } from "../scrub";

describe("redactLogSecrets — removes credentials", () => {
  it("redacts secret-bearing JSON fields, keeping the line parseable", () => {
    const line = JSON.stringify({
      text: "auth ok",
      access_token: "abc.def-123",
      nested: "fine",
    });
    const out = redactLogSecrets(line);
    expect(out).not.toContain("abc.def-123");
    const parsed = JSON.parse(out) as Record<string, string>;
    expect(parsed.access_token).toBe("[redacted]");
    expect(parsed.nested).toBe("fine");
  });

  // The store writes every record with JSON.stringify, so a secret logged as
  // an object field lands in the file with the structural quotes BACKSLASH-
  // escaped (\"access_token\":\"…\"). redactLogSecrets runs over that encoded
  // tail — not the pretty object — so it must catch the escaped form too.
  it("redacts secrets logged as object fields inside a JSONL text value", () => {
    // console.log({ access_token }) → the object is stringified into the
    // record's `text`, which the store re-stringifies — so the field lands
    // in the file with escaped quotes: "text":"{\"access_token\":\"…\"}".
    // Invented hex — fixture input proving the redactor rewrites access_token.
    const text = JSON.stringify({ ok: true, access_token: "9f8e7d6c5b4a3210ffee" }); // gitleaks:allow
    const line = JSON.stringify({ origin: "frontend", level: "log", text });
    const out = redactLogSecrets(line);
    expect(out).not.toContain("9f8e7d6c5b4a3210ffee");
    // The whole line is still valid JSON, and the inner payload too.
    const inner = JSON.parse((JSON.parse(out) as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(inner.access_token).toBe("[redacted]");
    expect(inner.ok).toBe(true);
  });

  it("redacts every secret field on a multi-field line without merging them", () => {
    const text = JSON.stringify({
      token: "AAAsecretAAA",
      keep: "visible",
      secret: "BBBsecretBBB",
    });
    const line = JSON.stringify({ origin: "frontend", level: "log", text });
    const out = redactLogSecrets(line);
    expect(out).not.toContain("AAAsecretAAA");
    expect(out).not.toContain("BBBsecretBBB");
    const inner = JSON.parse((JSON.parse(out) as { text: string }).text) as Record<
      string,
      unknown
    >;
    // Both secrets gone, the non-secret field and full 3-key structure intact.
    expect(inner.token).toBe("[redacted]");
    expect(inner.secret).toBe("[redacted]");
    expect(inner.keep).toBe("visible");
    expect(Object.keys(inner)).toHaveLength(3);
  });

  it("redacts a key=value secret without breaking a following escaped quote", () => {
    // A log line whose text embeds a literal quote → escaped as \" in the file.
    // The value class must stop before the backslash so the line stays parseable.
    const line = JSON.stringify({
      origin: "main",
      level: "info",
      text: 'headers token=abc123XYZsecretVALUE"end',
    });
    const out = redactLogSecrets(line);
    expect(out).not.toContain("abc123XYZsecretVALUE");
    expect(out).toContain("token=[redacted]");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("redacts key=value secrets, bearer headers, JWTs, and API keys", () => {
    const s = [
      "retry with token=tok_12345 ok",
      "authorization: Bearer abcdefgh12345678",
      `jwt eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`,
      "openai sk-proj-abcdefghijklmnop123456",
      "github ghp_ABCDEFGHIJKLMNOP1234",
      "stripe sk_live_ABCDEFGHIJKLMNOP1234", // gitleaks:allow — fixture proving the redactor catches it
      // Split the literal: the redactor still sees a contiguous AKIA<16> at
      // runtime, but the repo's own check:secrets gate (same shape) won't flag
      // this fixture — mirrors the deliberately-short bodies above.
      "aws AKIA" + "IOSFODNN7EXAMPLE",
      "mail from user@example.com",
    ].join("\n");
    const out = redactLogSecrets(s);
    expect(out).toContain("token=[redacted]");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("[jwt]");
    expect(out).not.toContain("sk-proj-");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("sk_live_");
    expect(out).not.toContain("AKIA");
    expect(out).toContain("[email]");
  });
});

describe("redactLogSecrets — keeps debugging signal", () => {
  it("preserves session UUIDs, paths, and commit SHAs", () => {
    const s =
      'Advanced feed offset {"sessionId":"00000000-0000-0000-0000-000000000000"} ' +
      "at /Users/someone/project/src/engine/runtime.ts " +
      "commit 7bbf8eea24ed0b90c18b98bf03cbc39d18308a12";
    const out = redactLogSecrets(s);
    expect(out).toContain("00000000-0000-0000-0000-000000000000");
    expect(out).toContain("/Users/someone/project/src/engine/runtime.ts");
    expect(out).toContain("7bbf8eea24ed0b90c18b98bf03cbc39d18308a12");
  });
});
