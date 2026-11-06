import { describe, expect, it } from "vitest";

import type { PaneNode } from "../../../state/chat-panes";
import { NO_PANE_EDGES, paneEdges, type PaneEdges } from "../pane-edges";

const leaf = (id: string): PaneNode => ({ type: "leaf", id });
const idOf = (node: PaneNode) => node.id;
const row = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
  type: "split", id: `row:${idOf(first)}:${idOf(second)}`, direction: "row", ratio, first, second,
});
const column = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
  type: "split", id: `column:${idOf(first)}:${idOf(second)}`, direction: "column", ratio, first, second,
});
const edges = (overrides: Partial<PaneEdges>): PaneEdges => ({ ...NO_PANE_EDGES, ...overrides });
const FULL = [{ start: 0, end: 1 }];

describe("paneEdges", () => {
  it("leaves a lone pane square, with no fades", () => {
    expect(paneEdges(leaf("a"), "a")).toEqual(new Map([["a", NO_PANE_EDGES]]));
  });

  it("rounds only the corners where side-by-side panes meet", () => {
    const result = paneEdges(row(leaf("a"), row(leaf("b"), leaf("c"))), "b");
    expect(result.get("a")).toEqual(edges({ roundTopRight: true }));
    expect(result.get("b")).toEqual(edges({ roundTopLeft: true, roundTopRight: true }));
    expect(result.get("c")).toEqual(edges({ roundTopLeft: true }));
  });

  it("keeps a side plain against the focused pane and parts two unfocused neighbours with a valley", () => {
    const result = paneEdges(row(leaf("a"), row(leaf("b"), leaf("c"))), "a");
    expect(result.get("b")).toEqual(edges({ roundTopLeft: true, roundTopRight: true, fadeRight: FULL }));
    expect(result.get("c")).toEqual(edges({ roundTopLeft: true, fadeLeft: FULL }));
  });

  it("fades a pane into the chrome over a stacked seam and rounds nothing at full width", () => {
    for (const focused of ["top", "bottom"]) {
      const result = paneEdges(column(leaf("top"), leaf("bottom")), focused);
      expect(result.get("top")).toEqual(edges({ fadeBottom: true }));
      expect(result.get("bottom")).toEqual(NO_PANE_EDGES);
    }
  });

  it("parts the unfocused panes of a four-pane grid, stacked or side by side", () => {
    // Split right, then down on both sides, with the top-left pane focused.
    const result = paneEdges(row(column(leaf("tl"), leaf("bl")), column(leaf("tr"), leaf("br"))), "tl");
    expect(result.get("tl")).toEqual(edges({ roundTopRight: true, fadeBottom: true }));
    expect(result.get("tr")).toEqual(edges({ roundTopLeft: true, fadeBottom: true }));
    expect(result.get("bl")).toEqual(edges({ roundTopRight: true, fadeRight: FULL }));
    expect(result.get("br")).toEqual(edges({ roundTopLeft: true, fadeLeft: FULL }));
  });

  it("fades only the stretch of a side that borders another unfocused pane", () => {
    // The left column's seam sits lower, so the focused top-left pane also
    // borders the top fifth of the lower-right pane: that stretch stays plain.
    const result = paneEdges(
      row(column(leaf("tl"), leaf("bl"), 0.6), column(leaf("tr"), leaf("br"), 0.5)),
      "tl",
    );
    const [span] = result.get("br")?.fadeLeft ?? [];
    expect(result.get("br")?.fadeLeft).toHaveLength(1);
    expect(span.start).toBeCloseTo(0.2);
    expect(span.end).toBeCloseTo(1);
    expect(result.get("bl")?.fadeRight).toEqual(FULL);
    expect(result.get("tr")?.fadeLeft).toEqual([]);
  });

  it("parts both sides of a T-junction valley along the stretch they share", () => {
    const result = paneEdges(row(leaf("left"), column(leaf("rt"), leaf("rb"))), "rb");
    expect(result.get("left")?.fadeRight).toEqual([{ start: 0, end: 0.5 }]);
    expect(result.get("rt")?.fadeLeft).toEqual(FULL);
    expect(result.get("rb")).toEqual(edges({ roundTopLeft: true }));
  });

  it("joins two unfocused neighbours stacked along one side into one stretch", () => {
    const result = paneEdges(row(leaf("left"), row(column(leaf("rt"), leaf("rb")), leaf("far"))), "far");
    expect(result.get("left")?.fadeRight).toEqual(FULL);
  });

  it("rounds a lower pane at its T-junction", () => {
    const result = paneEdges(row(leaf("left"), column(leaf("rt"), leaf("rb"))), "left");
    expect(result.get("left")).toEqual(edges({ roundTopRight: true }));
    expect(result.get("rt")).toEqual(edges({ roundTopLeft: true, fadeBottom: true }));
    expect(result.get("rb")).toEqual(edges({ roundTopLeft: true }));
  });
});
