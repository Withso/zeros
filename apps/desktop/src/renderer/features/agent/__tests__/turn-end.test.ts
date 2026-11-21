import { describe, expect, it } from "vitest";
import { turnEndedNaturally } from "../turn-end";

describe("how a turn ended", () => {
  it.each(["end_turn", "max_tokens", "max_turn_requests", "budget_exhausted"])("counts %s as the agent finishing", (stopReason) => {
    expect(turnEndedNaturally({ stopReason, failure: null, cancelled: false })).toBe(true);
  });

  it("treats a Stop, an error, a refusal, a provider block and an unknown ending as not natural", () => {
    expect(turnEndedNaturally({ stopReason: "cancelled", failure: null, cancelled: false })).toBe(false);
    expect(turnEndedNaturally({ stopReason: "end_turn", failure: null, cancelled: true })).toBe(false);
    expect(turnEndedNaturally({ stopReason: "end_turn", failure: { kind: "provider" } as never, cancelled: false })).toBe(false);
    expect(turnEndedNaturally({ stopReason: "refusal", failure: null, cancelled: false })).toBe(false);
    expect(turnEndedNaturally({ stopReason: "blocking_limit", failure: null, cancelled: false })).toBe(false);
    // Not known yet at the frame streaming ends: the safe side (complete at once).
    expect(turnEndedNaturally({ stopReason: null, failure: null, cancelled: false })).toBe(false);
    expect(turnEndedNaturally({ stopReason: undefined, failure: null, cancelled: false })).toBe(false);
  });
});
