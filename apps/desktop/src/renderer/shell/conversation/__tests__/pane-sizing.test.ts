// Conversation pane share-of-row math — the pure clamp/sanitize behind the
// conversation/workbench seam drag (proportional columns).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_MIN_PX,
  LEGACY_CONVERSATION_WIDTH_KEY,
  CONVERSATION_RATIO_KEY,
  clampConversationRatio,
  flushPendingConversationRatioPaint,
  persistConversationRatio,
  readPersistedConversationRatio,
  sanitizeConversationRatio,
} from "../pane-sizing";
import {
  MIN_PANE_WIDTH,
  PANE_SPLITTER_PX,
  canSplitPaneTree,
  canSplitPaneDimension,
  clampPaneSplitRatio,
  growablePaneSurfaceWidth,
  paneTreeHasDirection,
  paneTreeMinimumSize,
  paneTreeMinimumSizeAfterSplit,
} from "../pane-portal-store";
import { WORKBENCH_MIN_PX } from "../pane-sizing";

describe("chat pane width floors", () => {
  it("keeps both the conversation column and every split chat pane at 360px", () => {
    expect(CONVERSATION_MIN_PX).toBe(360);
    expect(MIN_PANE_WIDTH).toBe(360);
  });

  it("offers a horizontal split only when two 360px panes and its seam fit", () => {
    const exact = MIN_PANE_WIDTH * 2 + PANE_SPLITTER_PX;
    expect(canSplitPaneDimension(exact - 0.01, MIN_PANE_WIDTH)).toBe(false);
    expect(canSplitPaneDimension(exact, MIN_PANE_WIDTH)).toBe(true);
    expect(canSplitPaneDimension(Number.NaN, MIN_PANE_WIDTH)).toBe(false);
  });

  it("reserves the 6px seam while clamping both resized children", () => {
    const container = 1_000;
    const available = container - PANE_SPLITTER_PX;
    const leftFloorPointer = MIN_PANE_WIDTH + PANE_SPLITTER_PX / 2;
    expect(
      clampPaneSplitRatio(leftFloorPointer - 100, container, MIN_PANE_WIDTH),
    ).toBeCloseTo(MIN_PANE_WIDTH / available);
    expect(
      clampPaneSplitRatio(
        container - leftFloorPointer + 100,
        container,
        MIN_PANE_WIDTH,
      ),
    ).toBeCloseTo(1 - MIN_PANE_WIDTH / available);
    expect(clampPaneSplitRatio(100, MIN_PANE_WIDTH * 2, MIN_PANE_WIDTH)).toBe(
      0.5,
    );
  });

  it("computes the physical floor for nested row and column split trees", () => {
    const leaf = (id: string) => ({ type: "leaf" as const, id });
    const stacked = {
      type: "split" as const,
      id: "stacked",
      direction: "column" as const,
      ratio: 0.5,
      first: leaf("a"),
      second: leaf("b"),
    };
    const mixed = {
      type: "split" as const,
      id: "mixed",
      direction: "row" as const,
      ratio: 0.5,
      first: stacked,
      second: leaf("c"),
    };
    const threeAcross = {
      type: "split" as const,
      id: "three-across",
      direction: "row" as const,
      ratio: 0.5,
      first: {
        type: "split" as const,
        id: "left-pair",
        direction: "row" as const,
        ratio: 0.5,
        first: leaf("d"),
        second: leaf("e"),
      },
      second: leaf("f"),
    };

    expect(paneTreeMinimumSize(leaf("single"))).toEqual({
      width: 360,
      height: 160,
    });
    expect(paneTreeMinimumSize(stacked)).toEqual({
      width: 360,
      height: 326,
    });
    expect(paneTreeMinimumSize(mixed)).toEqual({
      width: 726,
      height: 326,
    });
    expect(paneTreeMinimumSize(threeAcross).width).toBe(1_092);
  });

  it("clamps asymmetric nested children against each subtree's own floor", () => {
    const container = 1_200;
    const available = container - PANE_SPLITTER_PX;
    expect(clampPaneSplitRatio(0, container, 726, 360)).toBeCloseTo(
      726 / available,
    );
    expect(clampPaneSplitRatio(container, container, 726, 360)).toBeCloseTo(
      1 - 360 / available,
    );
  });

  it("lets the first right split grow into workbench's surrenderable width", () => {
    const root = { type: "leaf" as const, id: "only" };
    expect(paneTreeHasDirection(root, "row")).toBe(false);
    expect(paneTreeMinimumSizeAfterSplit(root, "only", "row")).toEqual({
      width: 726,
      height: 160,
    });
    // 500px surface today, workbench sitting at 500 of which 300 is surrenderable
    // above its 200px floor → 800px reachable, so the 726px tree fits.
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "row",
        containerWidth: 500,
        containerHeight: 800,
        growableWidth: growablePaneSurfaceWidth(500, 500, WORKBENCH_MIN_PX),
      }),
    ).toBe(true);
  });

  // The bootstrap exception is bounded by REACHABLE space. On a minimum-width
  // window (840 − 248px repository nav = 592px row) workbench is already at its
  // 200px floor, so the conversation column can never reach 726px: offering the
  // split there produced a clipped row that the seam then refused to drag back.
  it("refuses the first right split when the row can never fit the result", () => {
    const root = { type: "leaf" as const, id: "only" };
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "row",
        containerWidth: 392,
        containerHeight: 800,
        growableWidth: growablePaneSurfaceWidth(392, 200, WORKBENCH_MIN_PX),
      }),
    ).toBe(false);
    // A collapsed workbench has nothing to surrender either — the conversation
    // column already owns the whole row.
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "row",
        containerWidth: 592,
        containerHeight: 800,
        growableWidth: growablePaneSurfaceWidth(592, 0, WORKBENCH_MIN_PX),
      }),
    ).toBe(false);
    // Unmeasured geometry proves nothing, so it cannot authorize a split.
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "row",
        containerWidth: Number.NaN,
        containerHeight: Number.NaN,
      }),
    ).toBe(false);
  });

  it("counts only workbench's slack above its own floor as growth room", () => {
    expect(growablePaneSurfaceWidth(400, 600, WORKBENCH_MIN_PX)).toBe(800);
    expect(growablePaneSurfaceWidth(400, 200, WORKBENCH_MIN_PX)).toBe(400);
    expect(growablePaneSurfaceWidth(400, 120, WORKBENCH_MIN_PX)).toBe(400);
    expect(growablePaneSurfaceWidth(400, Number.NaN, WORKBENCH_MIN_PX)).toBe(
      400,
    );
    expect(
      growablePaneSurfaceWidth(Number.NaN, 600, WORKBENCH_MIN_PX),
    ).toBeNaN();
  });

  it("also bootstraps the first right split from a vertical-only layout", () => {
    const root = {
      type: "split" as const,
      id: "vertical",
      direction: "column" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, id: "top" },
      second: { type: "leaf" as const, id: "bottom" },
    };
    expect(paneTreeHasDirection(root, "row")).toBe(false);
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "top",
        direction: "row",
        containerWidth: 360,
        containerHeight: 326,
        growableWidth: growablePaneSurfaceWidth(360, 566, WORKBENCH_MIN_PX),
      }),
    ).toBe(true);
  });

  it("blocks later right splits until the whole post-split tree fits", () => {
    const root = {
      type: "split" as const,
      id: "first-right",
      direction: "row" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, id: "left" },
      second: { type: "leaf" as const, id: "right" },
    };
    expect(paneTreeHasDirection(root, "row")).toBe(true);
    expect(paneTreeMinimumSizeAfterSplit(root, "left", "row")?.width).toBe(
      1_092,
    );
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "left",
        direction: "row",
        containerWidth: 1_091.99,
        containerHeight: 800,
      }),
    ).toBe(false);
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "left",
        direction: "row",
        containerWidth: 1_092,
        containerHeight: 800,
      }),
    ).toBe(true);
  });

  it("uses whole-tree height for down splits and rejects missing targets", () => {
    const root = { type: "leaf" as const, id: "only" };
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "column",
        containerWidth: 800,
        containerHeight: 325.99,
      }),
    ).toBe(false);
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "only",
        direction: "column",
        containerWidth: 800,
        containerHeight: 326,
      }),
    ).toBe(true);
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "missing",
        direction: "row",
        containerWidth: 2_000,
        containerHeight: 2_000,
      }),
    ).toBe(false);
  });

  it("does not reserve a phantom extra pane when a cross-pane drop empties its source", () => {
    const root = {
      type: "split" as const,
      id: "two-panes",
      direction: "row" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, id: "source" },
      second: { type: "leaf" as const, id: "target" },
    };
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "target",
        direction: "row",
        containerWidth: 726,
        containerHeight: 800,
      }),
    ).toBe(false);
    expect(
      canSplitPaneTree({
        root,
        targetPaneId: "target",
        direction: "row",
        containerWidth: 726,
        containerHeight: 800,
        collapsedPaneId: "source",
      }),
    ).toBe(true);
  });
});

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

  it("floors at conversation pane's 360px share of the row", () => {
    // 1600px row: 360px floor = 0.225.
    expect(clampConversationRatio(0.05, 1600)).toBeCloseTo(0.225);
  });

  it("uses the active split tree's wider physical floor", () => {
    // Two horizontal 360px panes plus their 6px splitter.
    expect(clampConversationRatio(0.05, 1600, 726)).toBeCloseTo(726 / 1600);
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
    expect(migrated).toBeCloseTo(
      sanitizeConversationRatio(480 / window.innerWidth),
    );
    expect(
      window.localStorage.getItem(LEGACY_CONVERSATION_WIDTH_KEY),
    ).toBeNull();
    // Idempotent: the boot read and the hook read run back to back and must
    // produce the SAME number, or the second one animates the columns.
    expect(readPersistedConversationRatio()).toBe(migrated);
  });
});
