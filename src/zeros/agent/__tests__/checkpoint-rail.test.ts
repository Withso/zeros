import { describe, it, expect } from "vitest";
import {
  activeCheckpointIndex,
  checkpointBottomSpacer,
  checkpointIdSignature,
  checkpointTickPitch,
  sameCheckpoints,
  summarizeCheckpointText,
  type Checkpoint,
} from "../checkpoint-rail";

describe("summarizeCheckpointText", () => {
  it("collapses internal whitespace to one line", () => {
    expect(summarizeCheckpointText("fix the\n\nbug\t in  auth")).toBe(
      "fix the bug in auth",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(summarizeCheckpointText("  hello  ")).toBe("hello");
  });

  it("labels attachment-only prompts instead of a blank row", () => {
    expect(summarizeCheckpointText("")).toBe("(attachment)");
    expect(summarizeCheckpointText("  \n ")).toBe("(attachment)");
  });

  it("caps pathological lengths (CSS truncation supplies the ellipsis)", () => {
    const wall = "x".repeat(5000);
    expect(summarizeCheckpointText(wall)).toHaveLength(200);
  });
});

describe("activeCheckpointIndex", () => {
  // Three prompts at content offsets 0 / 1000 / 2000, anchor 100px.
  const tops = [0, 1000, 2000];

  it("is the first checkpoint when parked at the very top", () => {
    expect(activeCheckpointIndex(tops, 0, 100, false)).toBe(0);
  });

  it("advances once a prompt's top passes the anchor line", () => {
    // Prompt 1 sits 50px below the viewport top — inside the anchor
    // band, so the reader is now "in" checkpoint 1.
    expect(activeCheckpointIndex(tops, 950, 100, false)).toBe(1);
    // Still 150px below the anchor line — reader remains in region 0.
    expect(activeCheckpointIndex(tops, 750, 100, false)).toBe(0);
  });

  it("stays in the last region while scrolled past every prompt", () => {
    expect(activeCheckpointIndex(tops, 2600, 100, false)).toBe(2);
  });

  it("pins to the last checkpoint at the bottom once scrolled past the first prompt, even when its prompt sits below the anchor", () => {
    // Scrolled well down (past prompts 0 and 1), last prompt still 400px
    // below the viewport top (short answer), viewport flush against the
    // bottom → latest exchange, so the last tick wins.
    expect(activeCheckpointIndex(tops, 1600, 100, true)).toBe(2);
  });

  it("keeps the FIRST tick lit when the whole transcript fits (top and bottom coincide)", () => {
    // The reported glitch: a short chat that fits entirely has scrollTop
    // pinned at 0, so the viewport is simultaneously at the top and the
    // bottom. The first prompt is visibly at the top — "at bottom" must
    // NOT drag the highlight to the last tick. Before the fix a fitting
    // 2-message chat flickered onto the 2nd tick on every tab switch.
    expect(activeCheckpointIndex(tops, 0, 100, true)).toBe(0);
    // The exact reported shape: two prompts, both on screen, first at the
    // top, "at bottom" true because nothing scrolls. Must stay 0, not 1.
    expect(activeCheckpointIndex([0, 600], 0, 100, true)).toBe(0);
  });

  it("pins a scrollable two-checkpoint transcript to the latest tick at the bottom", () => {
    // The view has genuinely scrolled, but the second prompt is still 300px
    // below the viewport top and has not crossed the 100px anchor. This must
    // not be confused with the scrollTop=0 whole-transcript-fits case above.
    expect(activeCheckpointIndex([0, 1000], 700, 100, true)).toBe(1);
  });

  it("still lands on a mid prompt at the bottom when an earlier one is at the top", () => {
    // At the bottom but the anchor line sits in region 1 (prompt 1 at the
    // top, prompt 2 just below the anchor with a short answer): the
    // transcript HAS scrolled past prompt 0, so the bottom rule promotes
    // to the last tick — the reader is in the latest exchange.
    expect(activeCheckpointIndex(tops, 950, 100, true)).toBe(2);
  });

  it("skips unmeasurable (null) entries without throwing", () => {
    expect(activeCheckpointIndex([0, null, 2000], 2100, 100, false)).toBe(2);
    expect(activeCheckpointIndex([null, null], 500, 100, false)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(activeCheckpointIndex([], 0, 100, false)).toBe(0);
    expect(activeCheckpointIndex([], 0, 100, true)).toBe(0);
  });
});

describe("checkpointBottomSpacer", () => {
  // Content 2000px tall in a 600px viewport → maxScroll is 1400.

  it("returns 0 when the target is already reachable (no gratuitous blank)", () => {
    expect(checkpointBottomSpacer(1400, 2000, 600)).toBe(0);
    expect(checkpointBottomSpacer(0, 2000, 600)).toBe(0);
    expect(checkpointBottomSpacer(1000, 2000, 600)).toBe(0);
  });

  it("covers the shortfall EXACTLY when the target is past maxScroll", () => {
    // Last prompt at 1700 with a short answer: 300px short of reach.
    // Exactly 300 — no slack — so maxScroll lands ON the target: the
    // click parks the viewport at the true bottom, there's no leftover
    // scrollable blank, and the jump-to-latest pill stays hidden
    // (2026-07-16 user report). The auto-follow suppression the old
    // 48px slack provided now lives in useStickyBottom's bottomInsetPx.
    expect(checkpointBottomSpacer(1700, 2000, 600)).toBe(300);
  });

  it("handles content shorter than the viewport (nothing scrolls yet)", () => {
    // 500px of content in a 600px pane: maxScroll is 0; reaching a
    // prompt at 200 needs the full 300px.
    expect(checkpointBottomSpacer(200, 500, 600)).toBe(300);
  });

  it("ceils fractional layout so the target is never past maxScroll", () => {
    // Rounding DOWN would leave the target 0.4px beyond maxScroll and
    // the browser would clamp the landing short.
    expect(checkpointBottomSpacer(1700.4, 2000, 600)).toBe(301);
  });
});

describe("sameCheckpoints", () => {
  // Referential-stability equality: a `true` result lets AgentChat hand
  // back the previous array reference so the rail's memo holds and it
  // doesn't re-measure every tick on a streamed chunk that touched no
  // user prompt.
  const base: Checkpoint[] = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ];

  it("treats content-equal lists as equal so streaming keeps one reference", () => {
    // A fresh array rebuilt by turn-grouping on a mid-stream chunk — same
    // prompts, so the reference must be reusable.
    expect(
      sameCheckpoints(base, [
        { id: "a", text: "first" },
        { id: "b", text: "second" },
      ]),
    ).toBe(true);
  });

  it("short-circuits on identity", () => {
    expect(sameCheckpoints(base, base)).toBe(true);
  });

  it("is unequal when a prompt is appended (real prompt add)", () => {
    expect(sameCheckpoints(base, [...base, { id: "c", text: "third" }])).toBe(
      false,
    );
  });

  it("is unequal when the latest id is swapped at the same length (edit-and-resubmit)", () => {
    expect(
      sameCheckpoints(base, [
        { id: "a", text: "first" },
        { id: "b2", text: "second edited" },
      ]),
    ).toBe(false);
  });

  it("is unequal when only the preview text changed (edited preview must propagate)", () => {
    expect(
      sameCheckpoints(base, [
        { id: "a", text: "first" },
        { id: "b", text: "second — reworded" },
      ]),
    ).toBe(false);
  });
});

describe("checkpointIdSignature", () => {
  // The rail resets its pin + bottom spacer when this signature changes.
  // It keys on IDS only (text excluded) because the pin/spacer are
  // id-anchored.
  const list: Checkpoint[] = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ];

  it("is unchanged when only preview text changes (pin/spacer stay valid)", () => {
    expect(
      checkpointIdSignature([
        { id: "a", text: "first EDITED" },
        { id: "b", text: "second" },
      ]),
    ).toBe(checkpointIdSignature(list));
  });

  it("changes on edit-and-resubmit — same length, new last id (the count check missed this)", () => {
    // The regression this guards: a bare `length` comparison sees 2 == 2
    // and skips the reset, stranding a spacer bound to the removed id.
    const resubmitted: Checkpoint[] = [
      { id: "a", text: "first" },
      { id: "b2", text: "second, redone" },
    ];
    expect(checkpointIdSignature(resubmitted)).not.toBe(
      checkpointIdSignature(list),
    );
  });

  it("changes on a history prepend and on a tail truncate", () => {
    const prepended: Checkpoint[] = [{ id: "z", text: "older" }, ...list];
    const truncated: Checkpoint[] = [{ id: "a", text: "first" }];
    expect(checkpointIdSignature(prepended)).not.toBe(
      checkpointIdSignature(list),
    );
    expect(checkpointIdSignature(truncated)).not.toBe(
      checkpointIdSignature(list),
    );
  });

  it("is empty for an empty list", () => {
    expect(checkpointIdSignature([])).toBe("");
  });
});

describe("checkpointTickPitch", () => {
  it("keeps a roomy pitch for short chats", () => {
    expect(checkpointTickPitch(1)).toBe(8);
    expect(checkpointTickPitch(16)).toBe(8);
  });

  it("tightens as checkpoints accumulate", () => {
    expect(checkpointTickPitch(17)).toBe(6);
    expect(checkpointTickPitch(32)).toBe(6);
    expect(checkpointTickPitch(33)).toBe(4);
    expect(checkpointTickPitch(120)).toBe(4);
  });
});
