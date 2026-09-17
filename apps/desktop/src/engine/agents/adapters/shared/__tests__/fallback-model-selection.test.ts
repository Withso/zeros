import { describe, expect, it, vi } from "vitest";
import { FallbackModelSelection } from "../fallback-model-selection";

describe("fallback model selection", () => {
  it("adopts a confirmed fallback for the next send", () => {
    const s = new FallbackModelSelection("original");
    s.beginTurn();
    expect(s.adopt("fallback", "original")).toMatchObject({
      model: "fallback",
      previousModel: "original",
    });
    expect(s.model).toBe("fallback");
  });
  it("does not undo a manual selection, including A → B → A", () => {
    const s = new FallbackModelSelection("a");
    s.beginTurn();
    s.select("b");
    s.select("a");
    expect(s.adopt("fallback", "a")).toBeNull();
    s.beginTurn();
    expect(s.adopt("fallback", "a")).not.toBeNull();
  });
  it("rejects a stale request even when a later turn reuses the same model", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const s = new FallbackModelSelection("a");
    s.beginTurn();
    const startedAt = s.startedAt;
    now.mockReturnValue(200);
    s.beginTurn();
    expect(s.adopt("fallback", "a", startedAt)).toBeNull();
    now.mockRestore();
  });
  it("accepts versioned Claude aliases but rejects unrelated or malformed targets", () => {
    const s = new FallbackModelSelection("claude-opus-5[1m]");
    s.beginTurn();
    expect(s.adopt("", "claude-opus-5")).toBeNull();
    expect(s.adopt("bad\nmodel", "claude-opus-5")).toBeNull();
    expect(s.adopt("fallback", "different")).toBeNull();
    expect(s.adopt("fallback", "claude-opus-5-20260101")).not.toBeNull();
  });
});
