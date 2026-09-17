import { describe, expect, it } from "vitest";
import { runSessionId } from "@zeros/protocol/run-actions";
import type { ContextGraphItemWire } from "../../../platform/context-graph";
import type { WorkbenchTab } from "../../workbench/tab-model";
import {
  recentSummaryContext,
  summaryDestinationTab,
  summaryHasSplitColumns,
} from "../summary-model";
import { DEFAULT_PANE_LAYOUT, splitLeaf } from "../../../state/chat-panes";

describe("Summary split layout", () => {
  it("uses the icon for side-by-side panes, including nested splits", () => {
    expect(summaryHasSplitColumns(DEFAULT_PANE_LAYOUT.root)).toBe(false);
    const stacked = splitLeaf(DEFAULT_PANE_LAYOUT, "main", "column", "bottom")!;
    expect(summaryHasSplitColumns(stacked.root)).toBe(false);
    const columns = splitLeaf(stacked, "bottom", "row", "right")!;
    expect(summaryHasSplitColumns(columns.root)).toBe(true);
  });
});

function item(name: string, mtimeMs: number): ContextGraphItemWire {
  return {
    name,
    mtimeMs,
    relPath: `.context/${name}`,
    scope: "local",
    category: "attachment",
    kind: "image",
    bytes: 1,
  };
}

describe("Summary context", () => {
  it("shows the newest three, preserves item identity and leaves the canvas snapshot alone", () => {
    const items = Object.freeze([
      item("old.png", 1),
      item("c.png", 3),
      item("a.png", 5),
      item("b.png", 5),
    ]);
    const recent = recentSummaryContext(items);
    expect(recent.map((entry) => entry.name)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
    expect(recent[0]).toBe(items[2]);
    expect(items[0].name).toBe("old.png");
  });

  it("handles empty and short listings", () => {
    expect(recentSummaryContext([])).toEqual([]);
    const only = item("one.png", 1);
    expect(recentSummaryContext([only])).toEqual([only]);
  });
});

describe("Summary navigation", () => {
  it("opens the permanent Files home and retains its selected file", () => {
    const extra: WorkbenchTab = { id: "extra", type: "files", title: "Other" };
    const fixed: WorkbenchTab = {
      id: "home",
      type: "files",
      title: "readme.md",
      fixed: true,
      filePath: "readme.md",
    };
    expect(summaryDestinationTab([extra, fixed], extra.id, "files")).toBe(
      fixed,
    );
  });

  it("reuses the current browser instead of creating duplicate tabs", () => {
    const tabs: WorkbenchTab[] = [
      { id: "a", type: "browser", title: "A" },
      { id: "b", type: "browser", title: "B" },
    ];
    expect(summaryDestinationTab(tabs, "b", "browser")).toBe(tabs[1]);
    expect(summaryDestinationTab(tabs, "changes", "browser")).toBe(tabs[0]);
    expect(summaryDestinationTab([], "", "browser")).toBeUndefined();
  });

  it("Terminal opens a shell, including a docked one, without selecting setup or a run", () => {
    const tabs: WorkbenchTab[] = [
      { id: "setup", type: "terminal", title: "Setup", terminalId: "setup" },
      {
        id: "run",
        type: "terminal",
        title: "Run",
        terminalId: runSessionId("/a", "dev"),
      },
      { id: "add", type: "terminal", title: "Add", terminalId: "run:add" },
      {
        id: "shell",
        type: "terminal",
        title: "Terminal",
        terminalId: "pty-a",
        terminalPlacement: "panel",
      },
    ];
    expect(summaryDestinationTab(tabs, "run", "terminal")).toBe(tabs[3]);
    expect(
      summaryDestinationTab(tabs.slice(0, 3), "setup", "terminal"),
    ).toBeUndefined();
  });
});
