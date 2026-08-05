// Conversation pane share-of-row math — the pure clamp/sanitize behind the
// conversation/workbench seam drag (proportional columns).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_CONVERSATION_WIDTH_KEY,
  CONVERSATION_RATIO_KEY,
  clampConversationRatio,
  flushPendingConversationRatioPaint,
  persistConversationRatio,
  readPersistedConversationRatio,
  sanitizeConversationRatio,
} from "../pane-sizing";

describe("flushPendingConversationRatioPaint", () => {
  it("cancels and paints the latest ratio before pointer-up persists it", () => {
    const calls: string[] = [];
    const cancel = (id: number) => calls.push(`cancel:${id}`);
    const paint = () => calls.push("paint");

    expect(flushPendingConversationRatioPaint(42, cancel, paint)).toBe(true);
    expect(calls).toEqual(["cancel:42", "paint"]);
  });

  it("does nothing after the latest ratio has already painted", () => {
    const cancel = vi.fn();
    const paint = vi.fn();

    expect(flushPendingConversationRatioPaint(null, cancel, paint)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
  });
});

describe("sanitizeConversationRatio", () => {
  it("passes through an in-range ratio", () => {
    expect(sanitizeConversationRatio(0.5)).toBe(0.5);
  });

  it("clamps to the global bounds", () => {
    expect(sanitizeConversationRatio(0)).toBe(0.1);
    expect(sanitizeConversationRatio(1)).toBe(0.7);
  });

  it("falls back to the default for a malformed persisted value", () => {
    expect(sanitizeConversationRatio(Number.NaN)).toBe(0.5);
    expect(sanitizeConversationRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe("clampConversationRatio", () => {
  it("passes through an in-range drag ratio", () => {
    expect(clampConversationRatio(0.5, 1600)).toBe(0.5);
  });

  it("floors at conversation pane's 320px share of the row", () => {
    // 1600px row: 320px floor = 0.2.
    expect(clampConversationRatio(0.05, 1600)).toBeCloseTo(0.2);
  });

  it("reserves workbench's 200px floor when tighter than the 70% cap", () => {
    // 600px row: (600 - 200) / 600 ≈ 0.667 beats the 0.7 share cap.
    expect(clampConversationRatio(0.9, 600)).toBeCloseTo(400 / 600);
  });

  it("caps at the 70% share on ordinary rows", () => {
    expect(clampConversationRatio(0.9, 1600)).toBe(0.7);
  });

  it("caps at 2400px on very wide rows", () => {
    // 5000px row: 70% would be 3500px — the pixel ceiling wins (0.48).
    expect(clampConversationRatio(0.69, 5000)).toBeCloseTo(2400 / 5000);
  });

  it("stays persistable when the row can't fit both floors", () => {
    // 400px row: conversation pane's floor share (0.8) exceeds the persistable 0.7
    // ceiling — the clamp pins there instead, so the live drag value
    // and the stored value never diverge (CSS min-widths own the
    // squeeze at this size either way).
    expect(clampConversationRatio(0.5, 400)).toBe(0.7);
  });

  it("survives a degenerate row width", () => {
    expect(clampConversationRatio(0.5, 0)).toBe(0.5);
    expect(clampConversationRatio(0.9, Number.NaN)).toBe(0.7);
  });
});

// The persisted ratio has TWO readers: the ConversationPane hook and the
// pre-render boot write in main.tsx (via boot-layout-vars). They share this
// function precisely so they can never disagree — a disagreement re-creates
// the launch-time column animation the boot write exists to remove.
describe("readPersistedConversationRatio / persistConversationRatio", () => {
  // The suite runs on `environment: "node"` (no jsdom in this repo), so stand
  // up the two browser globals these readers touch. Deterministic in-memory
  // storage also keeps Node's own `localStorage` file out of the picture.
  const store = new Map<string, string>();
  const stubWindow = {
    innerWidth: 1600,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", stubWindow);
    return () => vi.unstubAllGlobals();
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readPersistedConversationRatio()).toBe(0.5);
  });

  it("round-trips a committed ratio", () => {
    expect(persistConversationRatio(0.35)).toBe(0.35);
    expect(readPersistedConversationRatio()).toBe(0.35);
  });

  it("clamps what it stores, so the stored and painted values agree", () => {
    expect(persistConversationRatio(0.95)).toBe(0.7);
    expect(readPersistedConversationRatio()).toBe(0.7);
  });

  it("sanitizes a corrupt stored value instead of laying out with NaN", () => {
    window.localStorage.setItem(CONVERSATION_RATIO_KEY, "not-a-number");
    expect(readPersistedConversationRatio()).toBe(0.5);
  });

  it("migrates the pixel-era width once, then reads the migrated share", () => {
    window.localStorage.setItem(LEGACY_CONVERSATION_WIDTH_KEY, "480");
    const migrated = readPersistedConversationRatio();
    expect(migrated).toBeCloseTo(sanitizeConversationRatio(480 / window.innerWidth));
    expect(window.localStorage.getItem(LEGACY_CONVERSATION_WIDTH_KEY)).toBeNull();
    // Idempotent: the boot read and the hook read run back to back and must
    // produce the SAME number, or the second one animates the columns.
    expect(readPersistedConversationRatio()).toBe(migrated);
  });
});
