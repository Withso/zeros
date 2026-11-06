import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

// 2026-11-06 direction (Zeros Design v378 to v383): split panes meet as
// surfaces, not boxes. No seam line divides them, an unfocused pane takes the
// sidebar's fill, corners round where panes meet, and the chrome (bg1, the
// header's and the focused pane's fill) dissolves into each pane at its seams.
describe("split pane surfaces", () => {
  it("draws no resting seam and keeps the 6px resize strip out of layout", () => {
    const splitter = component(paneLayout(), "PaneSplitter");
    expect(splitter).not.toContain("bg-border1");
    // 2px over the first pane, 4px over the second: the first tab starts 4px in.
    expect(splitter).toContain('"-mr-1 -ml-0.5 w-1.5 cursor-ew-resize"');
    expect(splitter).toContain('"-mt-0.5 -mb-1 h-1.5 cursor-ns-resize"');
    expect(PANE_SPLITTER_PX).toBe(0);
  });

  it("shows a drop zone as a soft fill without a border", () => {
    const overlay = component(paneLayout(), "PaneDropOverlay");
    expect(overlay).toContain('"bg-highlighted-bg/40 pointer-events-none absolute rounded-sm"');
    expect(overlay).not.toContain("border-highlighted-bright");
    expect(overlay).not.toMatch(/\bborder"/);
  });

  it("paints the chrome behind the panes, where their rounded corners show it", () => {
    expect(paneLayout()).toContain('className="flex min-h-0 min-w-0 flex-1 bg-bg1"');
  });

  it("starts every tab strip in the chrome and dissolves it into the pane over 8px", () => {
    // 20% of the 40px strip; behind the tabs, so they keep their own fills.
    expect(classConstant(read("chat-tabs.tsx"), "CHAT_STRIP_SHELL_CLS")).toEqual(
      expect.arrayContaining(["h-10", "bg-gradient-to-b", "from-bg1", "to-transparent", "to-20%"]),
    );
  });

  it("rounds a pane's corners and fades its seams from its computed edges", () => {
    const pane = component(paneLayout(), "ChatPane");
    expect(pane).toContain("ctx.paneEdges.get(paneId)");
    expect(pane).toContain('edges.roundTopLeft && "rounded-tl-[calc(var(--radius-lg)*1.5)]"');
    expect(pane).toContain('edges.roundTopRight && "rounded-tr-[calc(var(--radius-lg)*1.5)]"');
    expect(pane).toContain('!isFocused && "[--pane-bg:var(--sidebar-bg)]"');
    for (const side of ["bottom", "left", "right"]) {
      expect(pane).toContain(`data-pane-seam-fade="${side}"`);
    }
    const fades = paneLayout();
    expect(fades).toContain('"pointer-events-none absolute inset-x-0 bottom-0 z-2 h-2 bg-gradient-to-t from-bg1 to-transparent"');
    expect(fades).toContain('"pointer-events-none absolute inset-y-0 left-0 z-2 w-2 bg-gradient-to-r from-bg1 to-transparent"');
    expect(fades).toContain('"pointer-events-none absolute inset-y-0 right-0 z-2 w-2 bg-gradient-to-l from-bg1 to-transparent"');
  });
});
