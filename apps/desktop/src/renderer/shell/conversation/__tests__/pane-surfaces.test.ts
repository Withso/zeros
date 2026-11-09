import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as panePortalStore from "../pane-portal-store";
import { PANE_SPLITTER_PX } from "../pane-portal-store";

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

// 2026-11-09 direction (Zeros Design v414, "Flush"), replacing the solid
// islands of 2026-11-06 to 2026-11-08: split panes run edge to edge like a lone
// pane, with no gutter, gap or rounded corner. Between two panes the divider is
// an 8px resize strip that draws one 1px border1 line; it is bg1 like the panes,
// so they meet at that line. Every pane keeps bg1 and draws no edge of its own:
// an unfocused pane's strip and body dim to 80% and its composer is its Ask pill.
describe("split pane surfaces", () => {
  it("makes the divider an 8px resize strip that draws one crisp 1px border1 line", () => {
    expect(PANE_SPLITTER_PX).toBe(8);
    const splitter = component(paneLayout(), "PaneSplitter");
    // w-2 and h-2 are the 8px the split math charges for the divider.
    expect(splitter).toContain('isRow ? "w-2 cursor-ew-resize" : "h-2 cursor-ns-resize"');
    expect(splitter).not.toMatch(/-m[lrtbxy]?-/);
    const line = /className=\{cn\(\s*"bg-border1 pointer-events-none absolute",\s*isRow\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)",?\s*\)\}/.exec(splitter);
    expect(line, "the divider's line").not.toBeNull();
    expect(line![1].split(" ")).toEqual(["inset-y-0", "left-1/2", "w-px"]);
    expect(line![2].split(" ")).toEqual(["inset-x-0", "top-1/2", "h-px"]);
    // No transform, so the line lands on whole pixels instead of blurring.
    expect(splitter).not.toContain("translate");
  });

  it("runs a split edge to edge: no gutters, with or without Workbench beside it", () => {
    expect("PANE_SPLIT_GUTTER_PX" in panePortalStore).toBe(false);
    expect("splitPaneGutters" in panePortalStore).toBe(false);
    expect("paneSurfaceMinimumSize" in panePortalStore).toBe(false);
    const src = paneLayout();
    expect(src).toContain('className="flex min-h-0 min-w-0 flex-1 bg-bg1"');
    expect(src).not.toContain("px-3 pb-3");
    expect(src).not.toContain("workbenchBeside");
    expect(read("conversation-pane.tsx")).not.toContain("workbenchBeside");
    // The column's floor and the split gate charge the panes alone.
    expect(src).toContain("paneTreeMinimumSize(layout.root)");
    const capacity = component(src, "measureSplitCapacity");
    expect(capacity).toContain("containerWidth: rect.width,");
    expect(capacity).toContain("containerHeight: rect.height,");
  });

  it("squares every pane and draws no pane edge, split or not", () => {
    const pane = component(paneLayout(), "ChatPane");
    expect(pane).toContain("const split = ctx.paneCount > 1;");
    expect(pane).not.toMatch(/\brounded-/);
    expect(pane).not.toMatch(/\bborder-border[12]\b/);
    expect(pane).not.toMatch(/"[^"]*\bborder\b[^"]*"/);
  });

  it("tells a split pane's focus by the 80% dim alone, eased like every opacity change", () => {
    const pane = component(paneLayout(), "ChatPane");
    // One fill for every pane: nothing overrides the bg1 window surface.
    expect(pane).toContain('"relative flex min-h-0 min-w-0 flex-1 flex-col bg-(--pane-bg)"');
    expect(pane).not.toContain("[--pane-bg:");
    expect(pane).not.toContain("sidebar-bg");
    expect(pane).toContain('split && "*:transition-opacity *:duration-120 *:ease-out motion-reduce:*:transition-none"');
    expect(pane).toContain('split && !isFocused && "*:opacity-80"');
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
