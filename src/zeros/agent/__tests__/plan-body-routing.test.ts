// Plan-body guard — the predicate that tells Claude's ExitPlanMode apart from
// Codex's "Expand permissions" escalation.
//
// `switch_mode` is overloaded: Claude's ExitPlanMode carries a `plan` body;
// Codex's escalation is ALSO kind=switch_mode but has no plan. Both the
// renderer registry matcher (`toolKind === "switch_mode" && hasPlanBody(...)`)
// and the composer's plan-review detection guard on THIS predicate — so a Codex
// escalation never renders as an empty Claude plan card and never steals the
// plan-review composer treatment. This is the latent bug the guard closes.

import { describe, it, expect } from "vitest";
import { readPlan, hasPlanBody } from "../renderers/plan-body";

describe("readPlan / hasPlanBody", () => {
  it("reads a non-empty plan string (Claude ExitPlanMode)", () => {
    expect(readPlan({ plan: "1. do X\n2. do Y" })).toBe("1. do X\n2. do Y");
    expect(hasPlanBody({ plan: "1. do X" })).toBe(true);
  });

  it("treats a Codex escalation (no plan body) as NOT a plan", () => {
    expect(readPlan({ permissions: ["net"], reason: "curl" })).toBeNull();
    expect(hasPlanBody({ permissions: ["net"], reason: "curl" })).toBe(false);
  });

  it("rejects a missing / blank / non-string plan", () => {
    expect(readPlan({})).toBeNull();
    expect(readPlan({ plan: "   " })).toBeNull();
    expect(readPlan({ plan: 42 })).toBeNull();
    expect(readPlan(null)).toBeNull();
    expect(readPlan(undefined)).toBeNull();
    expect(readPlan("nope")).toBeNull();
    expect(hasPlanBody({})).toBe(false);
  });
});
