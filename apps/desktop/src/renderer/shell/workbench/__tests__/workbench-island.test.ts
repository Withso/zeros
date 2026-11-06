import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/shell/workbench", path), "utf8");

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string[] {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1].split(/\s+/);
}

// 2026-11-06 direction (Zeros Design v384 to v390), replacing the 2026-07-11
// flush column: the side column's tab row stays on the column, and the open
// tab's content sits in one island under it. Nothing inside a tab changes.
describe("side column island", () => {
  it("drops the column's seam to the chat: the island's edge separates them", () => {
    const pane = classConstant(read("workbench-pane.tsx"), "WORKBENCH_PANE_CLS");
    expect(pane).not.toContain("border-l");
    expect(pane).not.toContain("border-border1");
    expect(pane).toContain("bg-bg1");
  });

  it("holds the content in a bg1 island 12px in, with a 12px radius and a border1 edge", () => {
    const island = classConstant(read("workbench-pane.tsx"), "WORKBENCH_ISLAND_CLS");
    expect(island).toEqual(
      expect.arrayContaining([
        "mx-3", "mb-3", "flex", "min-h-0", "flex-1", "flex-col", "overflow-hidden",
        "rounded-[calc(var(--radius-lg)*1.5)]", "border", "border-(--surface-border)",
      ]),
    );
    // Surface kind="canvas" paints bg1 and binds --surface-border to border1.
    expect(read("workbench-pane.tsx").match(/<Surface\s[^>]*kind="canvas"[^>]*className=\{WORKBENCH_ISLAND_CLS\}/g)).toHaveLength(2);
  });

  it("keeps the tab row outside the island and the PR row, tab bodies and docked terminal inside it", () => {
    const src = read("workbench-pane.tsx");
    const header = src.indexOf('data-testid="workbench-header"');
    const island = src.indexOf("data-workbench-island", header);
    const end = src.indexOf("</Surface>", island);
    expect(header).toBeGreaterThan(0);
    expect(island).toBeGreaterThan(header);
    const inside = src.slice(island, end);
    for (const part of ["<PrStatusRow", "<RetainedDesignDeck", "<RetainedBrowserDeck", "<TerminalPanel"]) {
      expect(inside).toContain(part);
    }
    // The docked terminal sizes against the island it lives in.
    expect(inside).toContain("containerRef={islandRef}");
  });

  it("starts the first tab 12px in, in line with the island's edge", () => {
    expect(read("tab-strip.tsx")).toContain('<div className="flex h-full min-w-0 items-center pl-2">');
  });
});
