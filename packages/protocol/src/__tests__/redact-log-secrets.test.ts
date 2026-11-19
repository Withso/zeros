
import { describe, it, expect } from "vitest";
import { redactLogSecrets } from "../scrub";

describe("redactLogSecrets — removes credentials", () => {
  it("removes cloud capabilities in headers and browser WebSocket protocols", () => {
    for (const prefix of ["zws", "zwh", "zwb", "zwp", "zsh", "zgw", "zwa"]) {
      const token = `${prefix}_${"a".repeat(42)}-`;
      const input = JSON.stringify({ headers: { "x-zeros-runtime-service": token,
        "sec-websocket-protocol": `zeros.service.v1, zeros.authorization.${token}` } });
      const output = redactLogSecrets(input);
      expect(output).not.toContain(token);
      expect(() => JSON.parse(output)).not.toThrow();
    }
    const encoded = Buffer.from(`zws_${"a".repeat(43)}`).toString("base64url");
    expect(redactLogSecrets(`sec-websocket-protocol: zeros-v1,zeros-cloud-token.${encoded}`)).not.toContain(encoded);
  });
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

  // The log store wraps serialized object text in JSONL, escaping the field quotes a second time.
  it("redacts secrets logged as object fields inside a JSONL text value", () => {
    const text = JSON.stringify({ ok: true, access_token: "9f8e7d6c5b4a3210ffee" }); // gitleaks:allow
    const line = JSON.stringify({ origin: "frontend", level: "log", text });
    const out = redactLogSecrets(line);
    expect(out).not.toContain("9f8e7d6c5b4a3210ffee");
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
    expect(inner.token).toBe("[redacted]");
    expect(inner.secret).toBe("[redacted]");
    expect(inner.keep).toBe("visible");
    expect(Object.keys(inner)).toHaveLength(3);
  });

  it("redacts a key=value secret without breaking a following escaped quote", () => {
    // Stopping before the backslash preserves the following escaped quote.
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
      // Assemble the fake AWS-shaped fixture so the repository secret scanner does not flag a literal.
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

  it("redacts the complete dotted GitHub App installation-token shape", () => {
    const installationToken =
      "ghs_" + "1".repeat(8) + "." + "A".repeat(64) + "." + "B".repeat(64);
    const out = redactLogSecrets(`credential ${installationToken} failed`);
    expect(out).toBe("credential [api-key] failed");
    expect(out).not.toContain("A".repeat(16));
    expect(out).not.toContain("B".repeat(16));
  });

  it("redacts the GitHub App token shape with an app-id underscore", () => {
    const installationToken =
      "ghs_1234567_" +
      "eyJhbGciOiJSUzI1NiJ9." +
      "eyJpc3MiOiIxMjM0NTY3In0." +
      "signature0123456789";
    expect(redactLogSecrets(`credential ${installationToken} failed`)).toBe(
      "credential [api-key] failed",
    );
  });

  it("redacts a signed refresh-owner binding by shape and field name", () => {
    const binding = `zghrb_v1.${"a".repeat(43)}.${"b".repeat(43)}`;
    expect(redactLogSecrets(`binding ${binding} failed`)).toBe(
      "binding [redacted] failed",
    );
    const line = JSON.stringify({ refreshBinding: binding, keep: true });
    const parsed = JSON.parse(redactLogSecrets(line)) as Record<
      string,
      unknown
    >;
    expect(parsed.refreshBinding).toBe("[redacted]");
    expect(parsed.keep).toBe(true);
  });
});

describe("redactLogSecrets — keeps debugging signal", () => {
  it("preserves session UUIDs, paths, and commit SHAs", () => {
    const s =
      'Advanced feed offset {"sessionId":"00000000-0000-0000-0000-000000000000"} ' +
      "at /Users/someone/project/apps/desktop/src/engine/runtime.ts " +
      "commit 7bbf8eea24ed0b90c18b98bf03cbc39d18308a12";
    const out = redactLogSecrets(s);
    expect(out).toContain("00000000-0000-0000-0000-000000000000");
    expect(out).toContain("/Users/someone/project/apps/desktop/src/engine/runtime.ts");
    expect(out).toContain("7bbf8eea24ed0b90c18b98bf03cbc39d18308a12");
  });
});

it("redacts native GitHub broker capabilities even outside an authorization field", () => {
  const capability = `zgn_${"x".repeat(42)}-`;
  expect(redactLogSecrets(`native request failed ${capability}`).includes(capability)).toBe(false);
});
