import { describe, expect, it } from "vitest";
import { failureSignature, forkDestinationBinding, qualificationPhrase, rawSecretObserver } from "../cloud-workspace-validation/lib/native-qualification-steps";

describe("native qualification steps", () => {
  it("uses unique values a model will repeat verbatim", () => {
    const values = new Set(Array.from({ length: 200 }, () => qualificationPhrase()));
    expect(values.size).toBe(200);
    for (const value of values) {
      // A prefix plus hex reads as a credential, which providers may withhold;
      // the replay checks must depend on the redactor, not on model policy.
      expect(value).toMatch(/^[a-z]+(?:-[a-z]+){5}-[0-9]{1,5}$/);
      expect(value).not.toMatch(/secret|token|key|password|synthetic|credential/i);
      expect(value.length).toBeGreaterThanOrEqual(24);
    }
  });
  it("takes a fork destination's binding from its stream or, for Codex and Cursor, its start", () => {
    const source = { providerId: "cursor", resumeId: "source" }, started = { providerId: "cursor", resumeId: "fresh" };
    expect(forkDestinationBinding(undefined, started)).toBe(started);
    const streamed = { providerId: "claude", resumeId: "streamed" };
    expect(forkDestinationBinding(streamed, { providerId: "claude", resumeId: "provisional" })).toBe(streamed);
    expect(forkDestinationBinding(undefined, undefined)).toBeUndefined();
    expect(forkDestinationBinding(undefined, started)?.resumeId).not.toBe(source.resumeId);
  });
});

describe("raw secret observation", () => {
  const chunk = (text: string) => ({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  it("observes a secret streamed across message chunks, once per turn", () => {
    const phrase = "amber-harbor-velvet-copper-meadow-ivory-4821", observer = rawSecretObserver(phrase);
    // Providers stream replies token by token, so no single chunk holds the value.
    expect(["The result was: amber-har", "bor-velvet-copper-mea", "dow-ivory-4821", " again amber-harbor-velvet-copper-meadow-ivory-4821"].map(text => observer.observe(chunk(text))))
      .toEqual([false, false, true, false]);
    observer.reset();
    expect(observer.observe(chunk(phrase))).toBe(true);
  });
  it("observes a complete value in any other notification", () => {
    const phrase = "cedar-lagoon-willow-raven-mint-sage-7", observer = rawSecretObserver(phrase);
    expect(observer.observe({ update: { sessionUpdate: "tool_call_update", rawOutput: `probe\n${phrase}` } })).toBe(true);
    expect(observer.observe({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cedar-lagoon" } } })).toBe(false);
  });
});

describe("failure signature", () => {
  it("keeps only fixed-format error codes and class names", () => {
    const erofs = Object.assign(new Error("EROFS: read-only file system, open '/srv/zeros/home/agent/.codex/x'"), { code: "EROFS" });
    expect(failureSignature(erofs)).toEqual({ code: "EROFS", name: "Error" });
    expect(failureSignature(Object.assign(new TypeError("private text"), { cause: { code: "ERR_STREAM_PREMATURE_CLOSE" } })))
      .toEqual({ code: "ERR_STREAM_PREMATURE_CLOSE", name: "TypeError" });
    // Free text, lowercase or oversized values never pass through.
    expect(failureSignature(Object.assign(new Error("x"), { code: "sk-live secret value", name: "Error: with a message" }))).toEqual({});
    expect(failureSignature("a string")).toEqual({});
  });
});
