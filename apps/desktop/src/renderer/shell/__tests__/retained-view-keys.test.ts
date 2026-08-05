import { describe, expect, it } from "vitest";

import {
  isRetainedViewVisible,
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
