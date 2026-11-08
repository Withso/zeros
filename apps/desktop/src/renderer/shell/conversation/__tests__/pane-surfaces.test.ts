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
// as solid surfaces on the bg1 chrome, 12px in from the column's edges, with
// 12px corners and nothing fading between them. A lone pane runs edge to edge.
// 2026-11-07: every pane keeps bg1 and edges tell them apart, border2 on the
// focused pane and border1 on the others, whose content dims to 80%. The side
// island sits on the column's edge, so the split keeps its own right gutter.
// 2026-11-08: panes sit 8px apart both ways; the outer gutters keep 12px.
describe("split pane surfaces", () => {
  it("makes the divider the 8px gap between split panes both ways, still the resize handle", () => {
    expect(PANE_SPLITTER_PX).toBe(8);
    const splitter = component(paneLayout(), "PaneSplitter");
    // w-2 and h-2 are the 8px the split math charges for the divider.
    expect(splitter).toContain('isRow ? "w-2 cursor-ew-resize" : "h-2 cursor-ns-resize"');
    expect(splitter).not.toMatch(/-m[lrtbxy]?-/);
    expect(splitter).not.toContain("bg-border1");
  });

  it("insets a split 12px from the column's left, right and bottom, with or without Workbench beside it", () => {
    expect(PANE_SPLIT_GUTTER_PX).toBe(12);
    const src = paneLayout();
    expect(src).toContain('"flex min-h-0 min-w-0 flex-1 bg-bg1"');
    expect(src).toContain('split && "px-3 pb-3"');
    // The side island sits on the column's edge, so nothing about Workbench
    // changes the gutters.
    expect(src).not.toContain("workbenchBeside");
    expect(read("conversation-pane.tsx")).not.toContain("workbenchBeside");
    // The column's floor and the split gate both charge the gutters, the gate
    // before any split exists.
    expect(src).toContain("paneSurfaceMinimumSize(layout.root)");
    expect(component(src, "measureSplitCapacity")).toContain("splitPaneGutters()");
  });

  it("rounds every corner of a split pane and none of a lone pane", () => {
    const pane = component(paneLayout(), "ChatPane");
    expect(pane).toContain("const split = ctx.paneCount > 1;");
    expect(pane).toContain('"overflow-hidden rounded-[calc(var(--radius-lg)*1.5)] border');
    expect(pane).not.toMatch(/rounded-t[lr]-/);
  });

  it("tells split panes apart by edge, not fill: border2 focused, border1 and an 80% dim elsewhere", () => {
    const pane = component(paneLayout(), "ChatPane");
    // One fill for every pane: nothing overrides the bg1 window surface.
    expect(pane).toContain('"relative flex min-h-0 min-w-0 flex-1 flex-col bg-(--pane-bg)"');
    expect(pane).not.toContain("[--pane-bg:");
    expect(pane).not.toContain("sidebar-bg");
    expect(pane).toContain('split && (isFocused ? "border-border2" : "border-border1 *:opacity-80")');
    // The dim is on the strip and body, so the edge keeps its own tier, and it
    // eases like every other opacity change.
    expect(pane).toContain("*:transition-opacity *:duration-120 *:ease-out motion-reduce:*:transition-none");
    expect(pane).not.toMatch(/(?<!\*:)opacity-80/);
  });

  it("snaps a context switch but not a focus move between split panes", () => {
    // Keyed on the active chat, the one-paint transition kill also froze every
    // focus move between panes, so their edges, dims and the Ask pill never
    // eased. Keyed on what each pane shows, only a real switch snaps.
    const src = paneLayout();
    expect(src).toContain(
      "`panes:${activeWorkspacePath ?? activeFolder ?? \"none\"}:${displayedChatIds.join(\",\")}:${activeOffPane}`",
    );
    expect(src).toContain("resolvePaneActiveChatId(layout, paneId, selectedChatId, chatsByPane.get(paneId) ?? EMPTY_CHATS)");
    expect(src).not.toContain("${activeChatId ?? \"none\"}`");
  });

  it("publishes each pane's focus and split apart from the slots the decks read whole", () => {
    const pane = component(paneLayout(), "ChatPane");
    expect(pane).toContain("setSlot(paneId, { activeChatId: paneActiveChatId });");
    expect(pane).toContain("setPaneFocus(paneId, { focused: isFocused, split });");
    expect(pane).toContain("[paneId, isFocused, split, setPaneFocus]");
    const store = read("pane-portal-store.ts");
    expect(store).toMatch(/interface PanePortalSlot \{\s*host: HTMLElement \| null;\s*activeChatId: string \| null;\s*\}/);
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
