import { describe, expect, it } from "vitest";
import { forkDestinationBinding, qualificationPhrase } from "../cloud-workspace-validation/lib/native-qualification-steps";

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
