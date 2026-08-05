// The durable "last rendered status" contract (2026-07-21): an app relaunch
// or dev reload must resume the island from the state it last showed —
// "Loading..." and the brown glyph fallback are reserved for a PR with no
// derivation history — and the persisted state must arm the anti-flap mask so
// the first post-relaunch fetch that echoes "unknown" cannot repaint the row.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { PrIslandState } from "../pr-status";
import {
  getPrIslandLastState,
  hydratePrIslandLastStatesForTesting,
  rememberPrIslandLastState,
  resetPrIslandLastStatesForTesting,
} from "../pr-island-last-state";
import {
  resetPrIslandStabilityForTesting,
  stabilizePrIslandState,
} from "../pr-status-stability";

const ready: PrIslandState = {
  kind: "ready-to-merge",
  label: "Ready to merge",
  tone: "success",
  actions: [
    { kind: "merge", label: "Merge", behavior: "merge", variant: "primary" },
  ],
};
const checking: PrIslandState = {
  kind: "checking",
  label: "Checking mergeability…",
  tone: "neutral",
  actions: [],
};

/** Minimal window.localStorage for the node test env. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
    },
  };
  return backing;
}

let backing: Map<string, string>;

beforeEach(() => {
  backing = installStorage();
  resetPrIslandStabilityForTesting();
  resetPrIslandLastStatesForTesting();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("pr-island-last-state", () => {
  it("returns null for a PR never derived here", () => {
    expect(getPrIslandLastState("ws#1")).toBeNull();
  });

  it("remembers and returns the last derived state", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    expect(getPrIslandLastState("ws#1")).toEqual(ready);
  });

  it("never persists a 'checking' transient", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", checking);
    expect(getPrIslandLastState("ws#1")).toBeNull();
  });

  it("survives a relaunch (rehydrates from storage)", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    // Simulate the relaunch: in-memory caches die, storage survives.
    hydratePrIslandLastStatesForTesting();
    expect(getPrIslandLastState("ws#1")).toEqual(ready);
  });

  it("hydration arms the stability mask — the first post-relaunch 'unknown' echo is masked", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    resetPrIslandStabilityForTesting(); // relaunch wipes the in-memory mask
    hydratePrIslandLastStatesForTesting();
    expect(stabilizePrIslandState("ws#1@main:sha", checking)).toEqual(ready);
  });

  it("hydration seed never outranks a live derivation for the same generation", () => {
    const behind: PrIslandState = {
      kind: "behind-base",
      label: "Require branch to be up to date",
      tone: "neutral",
      actions: [],
    };
    // A live definitive state lands first…
    stabilizePrIslandState("ws#1@main:sha", behind);
    // …then hydration replays an older persisted state for the same key.
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    hydratePrIslandLastStatesForTesting();
    expect(stabilizePrIslandState("ws#1@main:sha", checking)).toEqual(behind);
  });

  it("a NEW head generation is not masked by the persisted state (honest checking)", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:old-sha", ready);
    resetPrIslandStabilityForTesting();
    hydratePrIslandLastStatesForTesting();
    expect(stabilizePrIslandState("ws#1@main:new-sha", checking)).toEqual(
      checking,
    );
  });

  it("ignores corrupt storage documents", () => {
    backing.set("zeros.pr-island.last-states.v1", "{not json");
    hydratePrIslandLastStatesForTesting();
    expect(getPrIslandLastState("ws#1")).toBeNull();
  });

  it("drops structurally invalid entries and keeps valid ones", () => {
    backing.set(
      "zeros.pr-island.last-states.v1",
      JSON.stringify({
        "ws#invalid": { stabilityKey: 42, state: { nope: true }, at: "x" },
        "ws#good": {
          stabilityKey: "ws#good@main:sha",
          state: ready,
          at: 123,
        },
      }),
    );
    hydratePrIslandLastStatesForTesting();
    expect(getPrIslandLastState("ws#invalid")).toBeNull();
    expect(getPrIslandLastState("ws#good")).toEqual(ready);
  });

  it("skips the storage write when the state is unchanged", () => {
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    const written = backing.get("zeros.pr-island.last-states.v1");
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", { ...ready });
    expect(backing.get("zeros.pr-island.last-states.v1")).toBe(written);
  });

  it("bounds the number of persisted entries (LRU)", () => {
    for (let i = 0; i < 70; i++) {
      rememberPrIslandLastState(`ws#${i}`, `ws#${i}@main:sha`, ready);
    }
    expect(getPrIslandLastState("ws#0")).toBeNull();
    expect(getPrIslandLastState("ws#69")).toEqual(ready);
  });

  it("works without localStorage (memory-only degradation)", () => {
    delete (globalThis as { window?: unknown }).window;
    resetPrIslandLastStatesForTesting();
    rememberPrIslandLastState("ws#1", "ws#1@main:sha", ready);
    expect(getPrIslandLastState("ws#1")).toEqual(ready);
  });
});
