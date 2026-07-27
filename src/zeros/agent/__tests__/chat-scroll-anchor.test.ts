// chat-scroll-anchor — the stable-currency layer for transcript scroll
// positions. Node-env: the measurement helpers take a structural element
// surface, so fakes stand in for the DOM.

import { describe, expect, it } from "vitest";

import {
  captureScrollAnchor,
  isAtChatContentBottom,
  normalizeChatScrollPosition,
  resolveAnchorTop,
  restoreTargetTop,
  sameChatScrollPosition,
  shouldCaptureChatScroll,
  type AnchorScrollElement,
  type AnchorTurnElement,
  type ChatScrollPosition,
} from "../chat-scroll-anchor";

describe("chat scroll capture gates", () => {
  const visible = {
    force: false,
    surfaceActive: true,
    restoreInProgress: false,
    connected: true,
    clientHeight: 600,
    pendingHydrate: false,
  };

  it("accepts a live visible reader position", () => {
    expect(shouldCaptureChatScroll(visible)).toBe(true);
  });

  it("rejects the temporary correction frame during restoration", () => {
    expect(
      shouldCaptureChatScroll({ ...visible, restoreInProgress: true }),
    ).toBe(false);
  });

  it("lets pre-detach capture bypass only the active flag", () => {
    expect(
      shouldCaptureChatScroll({
        ...visible,
        force: true,
        surfaceActive: false,
      }),
    ).toBe(true);
    expect(
      shouldCaptureChatScroll({
        ...visible,
        force: true,
        surfaceActive: false,
        connected: false,
      }),
    ).toBe(false);
  });

  it("rejects cold-hydrate and zero-height clamp snapshots", () => {
    expect(shouldCaptureChatScroll({ ...visible, pendingHydrate: true })).toBe(
      false,
    );
    expect(shouldCaptureChatScroll({ ...visible, clientHeight: 0 })).toBe(
      false,
    );
  });
});

describe("chat content bottom", () => {
  it("recognizes the true live tail within the threshold", () => {
    expect(
      isAtChatContentBottom({
        scrollHeight: 2_000,
        scrollTop: 1_380,
        clientHeight: 600,
        bottomInset: 0,
      }),
    ).toBe(true);
  });

  it("does not turn checkpoint spacer navigation into tail-following", () => {
    expect(
      isAtChatContentBottom({
        scrollHeight: 2_400,
        scrollTop: 1_800,
        clientHeight: 600,
        bottomInset: 400,
      }),
    ).toBe(false);
  });
});

/** A fake transcript: turns at fixed content-relative tops. The container's
 *  viewport rect top is 0, so a turn's client top = contentTop - scrollTop. */
function fakeScroller(
  turns: Array<{ id: string | null; top: number }>,
  scrollTop: number,
): AnchorScrollElement {
  const makeTurn = (turn: {
    id: string | null;
    top: number;
  }): AnchorTurnElement => ({
    getBoundingClientRect: () => ({ top: turn.top - scrollTop }),
    getAttribute: (name: string) =>
      name === "data-checkpoint-id" ? turn.id : null,
  });
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => turns.map(makeTurn),
    querySelector: (selector: string) => {
      const match = /="(.*)"\]$/.exec(selector);
      const id = match?.[1];
      const turn = turns.find((t) => t.id === id);
      return turn ? makeTurn(turn) : null;
    },
  };
}

describe("normalizeChatScrollPosition", () => {
  it("normalizes legacy bare numbers to {top}", () => {
    expect(normalizeChatScrollPosition(120)).toEqual({ top: 120 });
    expect(normalizeChatScrollPosition(-1)).toBeUndefined();
    expect(normalizeChatScrollPosition(NaN)).toBeUndefined();
  });

  it("sanitizes objects and drops garbage", () => {
    expect(
      normalizeChatScrollPosition({
        top: 40,
        anchorId: "m1",
        anchorOffset: 12,
        atBottom: true,
      }),
    ).toEqual({ top: 40, anchorId: "m1", anchorOffset: 12, atBottom: true });
    // Anchor without a usable offset defaults the offset to 0.
    expect(
      normalizeChatScrollPosition({
        top: 40,
        anchorId: "m1",
        anchorOffset: -3,
      }),
    ).toEqual({ top: 40, anchorId: "m1", anchorOffset: 0 });
    // Empty anchor id is no anchor.
    expect(normalizeChatScrollPosition({ top: 40, anchorId: "" })).toEqual({
      top: 40,
    });
    expect(normalizeChatScrollPosition({ anchorId: "m1" })).toBeUndefined();
    expect(normalizeChatScrollPosition(null)).toBeUndefined();
    expect(normalizeChatScrollPosition("120")).toBeUndefined();
  });
});

describe("sameChatScrollPosition", () => {
  it("compares by value across all fields", () => {
    const a: ChatScrollPosition = { top: 1, anchorId: "x", anchorOffset: 2 };
    expect(sameChatScrollPosition(a, { ...a })).toBe(true);
    expect(sameChatScrollPosition(a, { ...a, anchorOffset: 3 })).toBe(false);
    expect(sameChatScrollPosition(a, { ...a, atBottom: true })).toBe(false);
    expect(sameChatScrollPosition(undefined, a)).toBe(false);
    expect(sameChatScrollPosition(undefined, undefined)).toBe(true);
  });
});

describe("captureScrollAnchor", () => {
  const turns = [
    { id: "t1", top: 0 },
    { id: "t2", top: 300 },
    { id: null, top: 450 }, // system turn — no id, never an anchor
    { id: "t3", top: 700 },
  ];

  it("picks the turn spanning the viewport top with the offset into it", () => {
    expect(captureScrollAnchor(fakeScroller(turns, 420))).toEqual({
      anchorId: "t2",
      anchorOffset: 120,
    });
  });

  it("picks a turn exactly at the viewport top with offset 0", () => {
    expect(captureScrollAnchor(fakeScroller(turns, 300))).toEqual({
      anchorId: "t2",
      anchorOffset: 0,
    });
  });

  it("returns undefined when the viewport sits above the first turn", () => {
    expect(
      captureScrollAnchor(
        fakeScroller(
          [
            { id: "t1", top: 200 },
            { id: "t2", top: 500 },
          ],
          50,
        ),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an empty transcript", () => {
    expect(captureScrollAnchor(fakeScroller([], 0))).toBeUndefined();
  });
});

describe("resolveAnchorTop / restoreTargetTop", () => {
  const turns = [
    { id: "t1", top: 0 },
    { id: "t2", top: 300 },
  ];

  it("resolves the anchor's content-relative top in the current layout", () => {
    // Same content, different current scroll — content-relative top is stable.
    expect(resolveAnchorTop(fakeScroller(turns, 0), "t2")).toBe(300);
    expect(resolveAnchorTop(fakeScroller(turns, 1000), "t2")).toBe(300);
    expect(resolveAnchorTop(fakeScroller(turns, 0), "gone")).toBeNull();
  });

  it("restore target = live anchor top + saved offset", () => {
    // Saved when t2 sat at content-top 300; after layout refinement t2 now
    // measures at 520 — the anchor-based target follows it, the raw top
    // (which would land 220px off) is ignored.
    const refined = fakeScroller([{ id: "t2", top: 520 }], 0);
    const pos: ChatScrollPosition = {
      top: 420,
      anchorId: "t2",
      anchorOffset: 120,
    };
    expect(restoreTargetTop(refined, pos)).toBe(640);
  });

  it("falls back to the raw top when the anchor is gone", () => {
    const scroller = fakeScroller([{ id: "t1", top: 0 }], 0);
    expect(
      restoreTargetTop(scroller, {
        top: 420,
        anchorId: "deleted",
        anchorOffset: 5,
      }),
    ).toBe(420);
    expect(restoreTargetTop(scroller, { top: 77 })).toBe(77);
  });
});
