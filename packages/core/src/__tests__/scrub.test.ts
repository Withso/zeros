import { describe, it, expect } from "vitest";
import { redactSensitive, scrubError } from "../scrub";

describe("redactSensitive", () => {
  it("strips the username from a POSIX home dir", () => {
    expect(redactSensitive("ENOENT at /Users/alice/.ssh/id_rsa")).not.toContain(
      "alice",
    );
    expect(redactSensitive("/home/bob/secret")).not.toContain("bob");
  });

  it("strips the username from a Windows user dir", () => {
    const out = redactSensitive("C:\\Users\\Carol\\AppData\\thing");
    expect(out).not.toContain("Carol");
  });

  it("keeps the filename but drops the directory tree for deep paths", () => {
    const out = redactSensitive("failed reading /opt/zeros/engine/src/index.ts");
    expect(out).toContain("index.ts");
    expect(out).not.toContain("/opt/zeros/engine");
    expect(out).toContain("/…/index.ts");
  });

  it("redacts long opaque tokens (SHAs, JWT segments, API keys)", () => {
    const sha = "a".repeat(40);
    expect(redactSensitive(`commit ${sha} not found`)).toBe(
      "commit [redacted] not found",
    );
    // Built by concatenation so no full Stripe-shaped key literal lands in the
    // source (trips GitHub push protection). The scrubber keys off token
    // length/char-class, not the prefix, so this exercises the same path.
    const fakeApiKey = "sk_" + "live_" + "Z".repeat(32);
    expect(redactSensitive(`key ${fakeApiKey}`)).toContain("[redacted]");
  });

  it("redacts email addresses (PII — analytics is anonymous)", () => {
    expect(redactSensitive("user alice@example.com not found")).toBe(
      "user [email] not found",
    );
    expect(redactSensitive("a.b+tag@sub.domain.co.uk failed")).toContain(
      "[email]",
    );
    expect(redactSensitive("user alice@example.com")).not.toContain("alice");
  });

  it("redacts credentials embedded in a URL authority", () => {
    expect(redactSensitive("https://user:pw@host.com/path")).toContain(
      "[email]",
    );
  });

  it("is idempotent — re-scrubbing already-scrubbed text is stable", () => {
    const once = redactSensitive(
      "open /Users/alice/proj/src/a.ts token " + "b".repeat(33) + " m@x.com",
    );
    expect(redactSensitive(once)).toBe(once);
  });

  it("leaves benign text untouched", () => {
    expect(redactSensitive("Connection refused")).toBe("Connection refused");
  });
});

describe("scrubError", () => {
  it("preserves the error class/name and scrubs the message", () => {
    const err = new TypeError("cannot read /Users/alice/x");
    const s = scrubError(err);
    expect(s.name).toBe("TypeError");
    expect(s.message).not.toContain("alice");
  });

  it("scrubs the stack", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at /Users/alice/proj/src/index.ts:1:1";
    const s = scrubError(err);
    expect(s.stack).toBeDefined();
    expect(s.stack).not.toContain("alice");
  });

  it("truncates an overlong message and stack", () => {
    const err = new Error("x".repeat(5000));
    err.stack = "y".repeat(5000);
    const s = scrubError(err);
    expect(s.message.length).toBeLessThanOrEqual(300);
    expect((s.stack ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("handles a thrown string", () => {
    const s = scrubError("plain failure at /Users/alice/x");
    expect(s.name).toBe("NonError");
    expect(s.message).not.toContain("alice");
    expect(s.stack).toBeUndefined();
  });

  it("handles a thrown non-Error object without throwing", () => {
    const s = scrubError({ weird: true });
    expect(s.name).toBe("NonError");
    expect(typeof s.message).toBe("string");
  });

  it("handles null/undefined without throwing", () => {
    expect(() => scrubError(undefined)).not.toThrow();
    expect(() => scrubError(null)).not.toThrow();
  });

  it("falls back to a default name for a nameless Error", () => {
    const err = new Error("x");
    err.name = ""; // force the empty-name edge
    expect(scrubError(err).name).toBe("Error");
  });
});
