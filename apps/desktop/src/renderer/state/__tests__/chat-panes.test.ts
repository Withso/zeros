// ──────────────────────────────────────────────────────────
// chat-panes — pure split-pane layout model tests
// ──────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_LAYOUT,
  MAIN_PANE_ID,
  MAX_PANE_LAYOUT_FOLDERS,
  MAX_PANES,
  type PaneLayout,
  assignChat,
  firstLeafId,
  hasLeaf,
  isDefaultLayout,
  leafIds,
  paneForChat,
  parsePaneLayout,
  parsePaneLayoutMap,
  reconcileLayout,
  removeLeaf,
  resolvePaneActiveChatId,
  setActiveInPane,
  setSplitRatio,
  splitLeaf,
} from "../chat-panes";

const chat = (id: string, createdAt = 0) => ({ id, createdAt });

function splitRight(
  layout: PaneLayout,
  target: string,
  newPane: string,
  moved?: string,
): PaneLayout {
  const next = splitLeaf(layout, target, "row", newPane, moved ?? null);
  expect(next).not.toBeNull();
  return next!;
}

describe("splitLeaf", () => {
  it("splits the root leaf into a 50/50 row with the new pane second", () => {
    const next = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    expect(next.root.type).toBe("split");
    if (next.root.type !== "split") return;
    expect(next.root.direction).toBe("row");
    expect(next.root.ratio).toBe(0.5);
    expect(leafIds(next.root)).toEqual([MAIN_PANE_ID, "p2"]);
  });

  it("moves the given chat into the new pane and makes it pane-active", () => {
    const next = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c1");
    expect(next.assignments["c1"]).toBe("p2");
    expect(next.activeByPane["p2"]).toBe("c1");
  });

  it("clears the source pane's active entry when the moved chat held it", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    layout = setActiveInPane(layout, MAIN_PANE_ID, "c1");
    const next = splitLeaf(layout, MAIN_PANE_ID, "column", "p3", "c1")!;
    expect(next.activeByPane[MAIN_PANE_ID]).toBeUndefined();
    expect(next.activeByPane["p3"]).toBe("c1");
  });

  it("supports nested splits and preserves visual order", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    layout = splitLeaf(layout, "p2", "column", "p3", null)!;
    expect(leafIds(layout.root)).toEqual([MAIN_PANE_ID, "p2", "p3"]);
  });

  it("returns null for a missing target pane", () => {
    expect(
      splitLeaf(DEFAULT_PANE_LAYOUT, "nope", "row", "p2", null),
    ).toBeNull();
  });

  it("returns null at the pane cap", () => {
    let layout: PaneLayout = DEFAULT_PANE_LAYOUT;
    for (let i = 2; i <= MAX_PANES; i++) {
      layout = splitLeaf(layout, MAIN_PANE_ID, "row", `p${i}`, null)!;
      expect(layout).not.toBeNull();
    }
    expect(splitLeaf(layout, MAIN_PANE_ID, "row", "overflow", null)).toBeNull();
  });

  it("returns null when the new pane id already exists", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    expect(splitLeaf(layout, "p2", "row", MAIN_PANE_ID, null)).toBeNull();
  });
});

describe("removeLeaf", () => {
  it("promotes the sibling and drops the pane's assignments/active", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c1");
    layout = assignChat(layout, "c2", MAIN_PANE_ID);
    const next = removeLeaf(layout, "p2");
    expect(next.root.type).toBe("leaf");
    expect(firstLeafId(next.root)).toBe(MAIN_PANE_ID);
    expect(next.assignments["c1"]).toBeUndefined();
    expect(next.activeByPane["p2"]).toBeUndefined();
  });

  it("normalizes a collapsed single leaf whose maps are empty to the default", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c1");
    const next = removeLeaf(layout, "p2");
    // c1's assignment pointed at p2 and is dropped with it; main had no
    // entries — so this collapses all the way back to the default.
    expect(isDefaultLayout(next)).toBe(true);
  });

  it("is a no-op for the only pane or an unknown pane", () => {
    expect(removeLeaf(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID)).toBe(
      DEFAULT_PANE_LAYOUT,
    );
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    expect(removeLeaf(layout, "ghost")).toBe(layout);
  });
});

describe("setSplitRatio", () => {
  it("updates the targeted split and clamps to [0.1, 0.9]", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    const splitId = layout.root.type === "split" ? layout.root.id : "";
    const next = setSplitRatio(layout, splitId, 0.02);
    expect(next.root.type === "split" && next.root.ratio).toBe(0.1);
    const next2 = setSplitRatio(layout, splitId, 0.97);
    expect(next2.root.type === "split" && next2.root.ratio).toBe(0.9);
  });

  it("returns the same reference for an unknown split or unchanged ratio", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    const splitId = layout.root.type === "split" ? layout.root.id : "";
    expect(setSplitRatio(layout, "ghost", 0.3)).toBe(layout);
    expect(setSplitRatio(layout, splitId, 0.5)).toBe(layout);
  });
});

describe("paneForChat / resolvePaneActiveChatId", () => {
  it("falls back to the first leaf for unassigned chats and dead panes", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    expect(paneForChat(layout, "unassigned")).toBe(MAIN_PANE_ID);
    layout = { ...layout, assignments: { c1: "dead-pane" } };
    expect(paneForChat(layout, "c1")).toBe(MAIN_PANE_ID);
  });

  it("prefers the global active chat for its own pane", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c2");
    const paneChats = [chat("c2", 2)];
    expect(resolvePaneActiveChatId(layout, "p2", "c2", paneChats)).toBe("c2");
  });

  it("uses the remembered entry for unfocused panes, else the newest member", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c9");
    layout = setActiveInPane(layout, MAIN_PANE_ID, "c1");
    const mainChats = [chat("c1", 1), chat("c2", 2)];
    // Global active lives in p2 → main falls back to its memory.
    expect(resolvePaneActiveChatId(layout, MAIN_PANE_ID, "c9", mainChats)).toBe(
      "c1",
    );
    // Stale memory → newest member.
    const stale = setActiveInPane(layout, MAIN_PANE_ID, "gone");
    expect(resolvePaneActiveChatId(stale, MAIN_PANE_ID, "c9", mainChats)).toBe(
      "c2",
    );
    // Empty pane → null.
    expect(resolvePaneActiveChatId(layout, MAIN_PANE_ID, "c9", [])).toBeNull();
  });

  it("ignores a global active chat that is not in the pane's live list", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    // "other-folder-chat" resolves to main (unassigned) but isn't in the
    // pane's chat list — e.g. it belongs to another workspace.
    expect(
      resolvePaneActiveChatId(layout, MAIN_PANE_ID, "other-folder-chat", [
        chat("c1", 1),
      ]),
    ).toBe("c1");
  });
});

describe("reconcileLayout", () => {
  it("returns the same reference when nothing changed", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c2");
    layout = setActiveInPane(layout, MAIN_PANE_ID, "c1");
    const live = [chat("c1", 1), chat("c2", 2)];
    expect(reconcileLayout(layout, live)).toBe(layout);
  });

  it("collapses a pane whose chats are all gone", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c2");
    const next = reconcileLayout(layout, [chat("c1", 1)]);
    expect(next.root.type).toBe("leaf");
    expect(isDefaultLayout(next)).toBe(true);
  });

  it("is fully inert when the folder has zero live chats (boot window)", () => {
    // Zero live chats = no information (empty first HYDRATE while SQLite
    // recovery is in flight, sync gap, all-archived workspace). The
    // layout must survive COMPLETELY untouched — tree, assignments and
    // pane-active memory — or the next hydrate would collapse the split.
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c2");
    expect(reconcileLayout(layout, [])).toBe(layout);
  });

  it("spares protected panes from collapse", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    const next = reconcileLayout(layout, [chat("c1", 1)], new Set(["p2"]));
    expect(leafIds(next.root)).toEqual([MAIN_PANE_ID, "p2"]);
  });

  it("repairs a stale pane-active entry to the newest member", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c3");
    layout = setActiveInPane(layout, MAIN_PANE_ID, "gone");
    const next = reconcileLayout(layout, [
      chat("c1", 1),
      chat("c2", 2),
      chat("c3", 3),
    ]);
    expect(next.activeByPane[MAIN_PANE_ID]).toBe("c2");
    expect(next.activeByPane["p2"]).toBe("c3");
  });

  it("cascades collapses until every pane has a member", () => {
    // main + p2 + p3; only one live chat assigned to p3.
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    layout = splitLeaf(layout, "p2", "column", "p3", null)!;
    layout = assignChat(layout, "c1", "p3");
    const next = reconcileLayout(layout, [chat("c1", 1)]);
    // main (fallback, zero members) and p2 both collapse; the surviving
    // single leaf then NORMALIZES to the canonical default layout so the
    // store can drop the folder entry. c1 resolves to the only pane.
    expect(next.root.type).toBe("leaf");
    expect(isDefaultLayout(next)).toBe(true);
    expect(paneForChat(next, "c1")).toBe(firstLeafId(next.root));
  });
});

describe("persistence parsing", () => {
  it("round-trips a valid two-pane layout", () => {
    const layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2", "c1");
    const parsed = parsePaneLayout(JSON.parse(JSON.stringify(layout)));
    expect(parsed).not.toBeNull();
    expect(leafIds(parsed!.root)).toEqual([MAIN_PANE_ID, "p2"]);
    expect(parsed!.assignments["c1"]).toBe("p2");
    expect(parsed!.activeByPane["p2"]).toBe("c1");
  });

  it("rejects malformed shapes", () => {
    expect(parsePaneLayout(null)).toBeNull();
    expect(parsePaneLayout("x")).toBeNull();
    // Bare leaf roots should never have been persisted.
    expect(parsePaneLayout({ root: { type: "leaf", id: "main" } })).toBeNull();
    // Duplicate leaf ids.
    expect(
      parsePaneLayout({
        root: {
          type: "split",
          id: "s",
          direction: "row",
          ratio: 0.5,
          first: { type: "leaf", id: "a" },
          second: { type: "leaf", id: "a" },
        },
      }),
    ).toBeNull();
    // Unknown direction.
    expect(
      parsePaneLayout({
        root: {
          type: "split",
          id: "s",
          direction: "diagonal",
          ratio: 0.5,
          first: { type: "leaf", id: "a" },
          second: { type: "leaf", id: "b" },
        },
      }),
    ).toBeNull();
  });

  it("clamps ratios and drops entries pointing at unknown panes", () => {
    const parsed = parsePaneLayout({
      root: {
        type: "split",
        id: "s",
        direction: "row",
        ratio: 42,
        first: { type: "leaf", id: "a" },
        second: { type: "leaf", id: "b" },
      },
      assignments: { c1: "a", c2: "ghost", c3: 7 },
      activeByPane: { a: "c1", ghost: "c2" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.root.type === "split" && parsed!.root.ratio).toBe(0.9);
    expect(parsed!.assignments).toEqual({ c1: "a" });
    expect(parsed!.activeByPane).toEqual({ a: "c1" });
  });

  it("parses a map and drops corrupt folder entries", () => {
    const good = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    const map = parsePaneLayoutMap({
      "/w/a": JSON.parse(JSON.stringify(good)),
      "/w/b": { root: { type: "leaf", id: "main" } },
      "": JSON.parse(JSON.stringify(good)),
      "/w/c": "garbage",
    });
    expect(Object.keys(map)).toEqual(["/w/a"]);
  });

  it("bounds persisted folder layouts to the newest owner window", () => {
    const good = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    const raw = Object.fromEntries(
      Array.from({ length: MAX_PANE_LAYOUT_FOLDERS + 4 }, (_, index) => [
        `/w/${index}`,
        JSON.parse(JSON.stringify(good)),
      ]),
    );

    const map = parsePaneLayoutMap(raw);

    expect(Object.keys(map)).toHaveLength(MAX_PANE_LAYOUT_FOLDERS);
    expect(map["/w/0"]).toBeUndefined();
    expect(map[`/w/${MAX_PANE_LAYOUT_FOLDERS + 3}`]).toBeDefined();
  });

  it("rejects layouts deeper than the depth cap", () => {
    let node: unknown = { type: "leaf", id: "deep" };
    for (let i = 0; i < 8; i++) {
      node = {
        type: "split",
        id: `s${i}`,
        direction: "row",
        ratio: 0.5,
        first: node,
        second: { type: "leaf", id: `l${i}` },
      };
    }
    expect(parsePaneLayout({ root: node })).toBeNull();
  });
});

describe("hasLeaf", () => {
  it("finds nested leaves", () => {
    let layout = splitRight(DEFAULT_PANE_LAYOUT, MAIN_PANE_ID, "p2");
    layout = splitLeaf(layout, "p2", "column", "p3", null)!;
    expect(hasLeaf(layout.root, "p3")).toBe(true);
    expect(hasLeaf(layout.root, "nope")).toBe(false);
  });
});
