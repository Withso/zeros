// Coverage for clearStrandedPlanReview — the turn-settle self-heal for a
// stranded Claude plan-review card (ExitPlanMode gate).
//
// A plan gate BLOCKS its turn, so in the happy path the user's Approve / typed
// follow-up clears pendingPermission before the turn settles. The card is only
// ever "stranded" when the turn reached a TERMINAL state with the gate still
// pending — the adapter's 30-min auto-deny fired, or the turn died mid-plan —
// and the engine already released the gate underneath, so the card's buttons
// would click into the void. The turn-settle `finally` calls this to drop it,
// but ONLY for plan reviews — never a real Allow/Deny gate (which REPLACES the
// composer; clearing it would be a different, riskier change).

import { beforeEach, describe, expect, it } from "vitest";

import { useSessionsStore, BLANK } from "../sessions-store";
import type { PendingPermission } from "../use-agent-session";

// isPlanReviewRequest keys off the tool call's title (/exit.?plan.?mode/i) OR a
// `plan` body in rawInput — so this reads as Claude's ExitPlanMode.
const planPermission: PendingPermission = {
  agentId: "claude",
  permissionId: "perm-plan",
  request: {
    sessionId: "sid",
    toolCall: {
      toolCallId: "t1",
      title: "ExitPlanMode",
      rawInput: { plan: "1. do the thing\n2. do the other thing" },
    },
    options: [],
  } as never,
};

// A regular tool gate — no plan title, no plan body → a real Allow/Deny.
const bashPermission: PendingPermission = {
  agentId: "claude",
  permissionId: "perm-bash",
  request: {
    sessionId: "sid",
    toolCall: {
      toolCallId: "t2",
      title: "Bash",
      rawInput: { command: "rm -rf build" },
    },
    options: [],
  } as never,
};

describe("clearStrandedPlanReview", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("clears a stranded plan-review card (ExitPlanMode gate still pending at turn-settle)", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sid",
      pendingPermission: planPermission,
    });
    s.clearStrandedPlanReview("chatA");
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingPermission,
    ).toBeNull();
  });

  it("leaves a real Allow/Deny gate untouched (only plan reviews self-heal)", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sid",
      pendingPermission: bashPermission,
    });
    s.clearStrandedPlanReview("chatA");
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingPermission,
    ).toBe(bashPermission);
  });

  it("is a no-op in the happy path (Approve already cleared the gate)", () => {
    const s = useSessionsStore.getState();
    s.setSession("chatA", { ...BLANK, agentId: "claude", sessionId: "sid" });
    expect(() => s.clearStrandedPlanReview("chatA")).not.toThrow();
    expect(
      useSessionsStore.getState().sessions["chatA"]?.pendingPermission,
    ).toBeNull();
  });

  it("is a no-op for an unknown chat id", () => {
    const s = useSessionsStore.getState();
    expect(() => s.clearStrandedPlanReview("nope")).not.toThrow();
  });
});
