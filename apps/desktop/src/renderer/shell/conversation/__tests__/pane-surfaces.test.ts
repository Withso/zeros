import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PANE_SPLITTER_PX, PANE_SPLIT_GUTTER_PX } from "../pane-portal-store";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/shell/conversation", path), "utf8");
const paneLayout = () => read("pane-layout.tsx");

/** A component's body: `function NAME(` up to the next top-level declaration. */
function component(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export |function |interface |const |\/\*\*)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string[] {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1].split(/\s+/);
}

// 2026-11-06 direction (Zeros Design v391, "Solid split", replacing the soft
// valleys of v378 to v383): only while the column is split, panes stand apart
// as solid surfaces on the bg1 chrome, 12px apart and 12px in from the
// column's edges, with 12px corners and nothing fading between them. An
// unfocused pane keeps the sidebar's fill. A lone pane runs edge to edge.
describe("split pane surfaces", () => {
  it("makes the divider the 12px gap between split panes, still the resize handle", () => {
    expect(PANE_SPLITTER_PX).toBe(12);
    const splitter = component(paneLayout(), "PaneSplitter");
    expect(splitter).toContain('isRow ? "w-3 cursor-ew-resize" : "h-3 cursor-ns-resize"');
    expect(splitter).not.toMatch(/-m[lrtbxy]?-/);
    expect(splitter).not.toContain("bg-border1");
  });

  it("insets a split from the column's left and bottom, and its right when Workbench is not beside it", () => {
    expect(PANE_SPLIT_GUTTER_PX).toBe(12);
    const src = paneLayout();
    expect(src).toContain('"flex min-h-0 min-w-0 flex-1 bg-bg1"');
    expect(src).toContain('split && "pb-3 pl-3"');
    expect(src).toContain('split && !workbenchBeside && "pr-3"');
    expect(read("conversation-pane.tsx")).toContain("workbenchBeside={!workbenchCollapsed}");
    // The column's floor and the split gate both charge the gutters, the gate
    // before any split exists.
    expect(src).toContain("paneSurfaceMinimumSize(layout.root, workbenchBeside)");
    expect(component(src, "measureSplitCapacity")).toContain("splitPaneGutters(workbenchWidth > 0)");
  });

  it("rounds every corner of a split pane and none of a lone pane", () => {
    const pane = component(paneLayout(), "ChatPane");
    expect(pane).toContain("const split = ctx.paneCount > 1;");
    expect(pane).toContain('split && "overflow-hidden rounded-[calc(var(--radius-lg)*1.5)]"');
    expect(pane).not.toMatch(/rounded-t[lr]-/);
    expect(pane).toContain('!isFocused && "[--pane-bg:var(--sidebar-bg)]"');
  });

  it("draws no seam fades, valleys or tab-strip fade", () => {
    const src = paneLayout();
    expect(src).not.toContain("data-pane-seam-fade");
    expect(src).not.toContain("pane-edges");
    expect(classConstant(read("chat-tabs.tsx"), "CHAT_STRIP_SHELL_CLS")).toEqual([
      "flex",
      "h-10",
      "shrink-0",
      "items-center",
      "overflow-hidden",
    ]);
  });

  it("shows a drop zone as a soft fill without a border", () => {
    const overlay = component(paneLayout(), "PaneDropOverlay");
    expect(overlay).toContain('"bg-highlighted-bg/40 pointer-events-none absolute rounded-sm"');
    expect(overlay).not.toContain("border-highlighted-bright");
    expect(overlay).not.toMatch(/\bborder"/);
  });
});
