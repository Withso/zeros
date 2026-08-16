import { describe, expect, it } from "vitest";

import {
  isRetainedViewVisible,
  preserveRetainedViewOrder,
  retainLatestViewKeyPerIdentity,
  retainRecentViewKeys,
  retainRecentViewKeySet,
} from "../retained-view-keys";

describe("retainRecentViewKeys", () => {
  it("keeps the active view last without duplicates", () => {
    expect(retainRecentViewKeys(["a", "b", "c"], "b", 4)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("evicts the least recently used view at the bound", () => {
    expect(retainRecentViewKeys(["a", "b", "c"], "d", 3)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("preserves reference identity when the deck is already current", () => {
    const keys = ["a", "b"];
    expect(retainRecentViewKeys(keys, "b", 4)).toBe(keys);
  });

  it("drops views that no longer exist without losing the active view", () => {
    expect(
      retainRecentViewKeys(
        ["closed", "a", "also-closed"],
        "b",
        3,
        new Set(["a", "b"]),
      ),
    ).toEqual(["a", "b"]);
  });

  it("empties a disabled deck", () => {
    expect(retainRecentViewKeys(["a"], "a", 0)).toEqual([]);
  });
});

describe("retainRecentViewKeySet", () => {
  it("retains every visible split-pane key while evicting old views", () => {
    expect(
      retainRecentViewKeySet(
        ["old-a", "old-b", "pane-a"],
        ["pane-a", "pane-b"],
        3,
      ),
    ).toEqual(["old-b", "pane-a", "pane-b"]);
  });

  it("drops closed keys and preserves an already-current reference", () => {
    const retained = ["chat-a", "chat-b"];
    expect(
      retainRecentViewKeySet(
        retained,
        ["chat-a", "chat-b"],
        4,
        new Set(retained),
      ),
    ).toBe(retained);
  });
});

describe("preserveRetainedViewOrder", () => {
  it("does not move retained iframe keys during an A → B → A switch", () => {
    const firstMru = retainRecentViewKeySet([], ["a", "b", "a"], 8);
    const firstDomOrder = preserveRetainedViewOrder([], firstMru);
    expect(firstMru).toEqual(["b", "a"]);

    const secondMru = retainRecentViewKeySet(firstMru, ["a", "b", "b"], 8);
    expect(secondMru).toEqual(["a", "b"]);
    const secondDomOrder = preserveRetainedViewOrder(firstDomOrder, secondMru);
    expect(secondDomOrder).toBe(firstDomOrder);

    const thirdMru = retainRecentViewKeySet(secondMru, ["a", "b", "a"], 8);
    expect(thirdMru).toEqual(["b", "a"]);
    expect(preserveRetainedViewOrder(secondDomOrder, thirdMru)).toBe(
      firstDomOrder,
    );
  });

  it("removes evicted keys in place and appends only newly mounted keys", () => {
    const previous = ["a", "b", "c"];
    expect(preserveRetainedViewOrder(previous, ["c", "b", "d"])).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("is bounded by the retained set and discards closed keys", () => {
    const previous = Array.from({ length: 32 }, (_, index) => `old-${index}`);
    const retained = ["old-30", "old-31", "new-a", "new-b"];
    const next = preserveRetainedViewOrder(previous, retained);
    expect(next).toEqual(["old-30", "old-31", "new-a", "new-b"]);
    expect(next).toHaveLength(retained.length);
    expect(preserveRetainedViewOrder(next, [])).toEqual([]);
  });
});

describe("isRetainedViewVisible", () => {
  it("does not let a selected child paint through an inactive parent", () => {
    expect(isRetainedViewVisible(false, "selected", "selected")).toBe(false);
    expect(isRetainedViewVisible(true, "selected", "selected")).toBe(true);
    expect(isRetainedViewVisible(true, "other", "selected")).toBe(false);
  });
});

describe("retainLatestViewKeyPerIdentity", () => {
  it("keeps the newest metadata variant without reordering other views", () => {
    expect(
      retainLatestViewKeyPerIdentity(
        ["a:old", "b:only", "a:new"],
        (key) => key.split(":")[0],
      ),
    ).toEqual(["b:only", "a:new"]);
  });

  it("preserves the collection reference when every identity is unique", () => {
    const keys = ["a:only", "b:only"];
    expect(
      retainLatestViewKeyPerIdentity(keys, (key) => key.split(":")[0]),
    ).toBe(keys);
  });
});
