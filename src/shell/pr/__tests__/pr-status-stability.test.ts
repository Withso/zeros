// The anti-flap contract: "Checking mergeability…" is a transient, not a
// status. A raw "checking" derivation is masked — indefinitely, actions
// intact — by the generation's last definitive state, so background
// re-checks (app resume, workspace hops, the slow poll) repaint the row only
// when GitHub settles on a state that actually differs (2026-07-21 spec;
// hardens the 2026-07-19 push → unknown → clean roundtrip fix).
import { describe, it, expect, beforeEach } from "vitest";

import type { PrIslandState } from "../pr-status";
import {
  clearPrIslandStability,
  resetPrIslandStabilityForTesting,
  stabilizePrIslandState,
} from "../pr-status-stability";

const ready: PrIslandState = {
  kind: "ready-to-merge",
  label: "Ready to merge",
  tone: "success",
  actions: [
    {
      kind: "merge",
      label: "Merge",
      behavior: "merge",
      variant: "primary",
    },
  ],
};
const checking: PrIslandState = {
  kind: "checking",
  label: "Checking mergeability…",
  tone: "neutral",
  actions: [],
};
const behind: PrIslandState = {
  kind: "behind-base",
  label: "Require branch to be up to date",
  tone: "neutral",
  actions: [],
};

beforeEach(() => resetPrIslandStabilityForTesting());

describe("stabilizePrIslandState", () => {
  it("passes definitive states through untouched", () => {
    expect(stabilizePrIslandState("k", ready)).toBe(ready);
  });

  it("masks a transient checking with the last definitive state — actions intact (the push flap)", () => {
    stabilizePrIslandState("k", ready);
    // Push → refetch lands with GitHub still recomputing → raw "checking".
    const held = stabilizePrIslandState("k", checking);
    expect(held).toBe(ready);
    // The Merge button never blinked away.
    expect(held.actions).toEqual(ready.actions);
    // Recompute settles → clean again. The row never flapped.
    expect(stabilizePrIslandState("k", ready)).toBe(ready);
  });

  it("masks indefinitely — an app resume hours later must not repaint an unchanged status", () => {
    stabilizePrIslandState("k", ready);
    // Return to the app long after the old 30s hold would have expired:
    // GitHub's evicted mergeability cache echoes "unknown" on the first poll.
    for (let i = 0; i < 5; i++) {
      expect(stabilizePrIslandState("k", checking)).toBe(ready);
    }
  });

  it("a NEW definitive state replaces the mask immediately (no staleness)", () => {
    stabilizePrIslandState("k", ready);
    stabilizePrIslandState("k", checking);
    expect(stabilizePrIslandState("k", behind)).toBe(behind);
    // ...and it becomes the new mask anchor.
    expect(stabilizePrIslandState("k", checking)).toBe(behind);
  });

  it("shows checking on a true first load (nothing to mask)", () => {
    expect(stabilizePrIslandState("k", checking)).toBe(checking);
  });

  it("clearPrIslandStability drops the mask (direct actions invalidate state)", () => {
    stabilizePrIslandState("k", ready);
    clearPrIslandStability("k");
    // e.g. Ready-for-review just fired: masking with the stale Draft/Ready
    // state would read as a dead click — honest checking instead.
    expect(stabilizePrIslandState("k", checking)).toBe(checking);
  });

  it("keys are independent per workspace#pr", () => {
    stabilizePrIslandState("a#1", ready);
    expect(stabilizePrIslandState("b#2", checking)).toBe(checking);
  });

  it("does not carry a prior head generation into a newly pushed head", () => {
    stabilizePrIslandState("ws#1@main:old-head", ready);
    expect(stabilizePrIslandState("ws#1@main:new-head", checking)).toBe(
      checking,
    );
  });
});
