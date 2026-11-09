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

// 2026-11-09 direction (Zeros Design v414, "Flush"), replacing the side island
// of 2026-11-06 to 2026-11-08 as the 2026-07-11 flush column did the floating
// islands: the side column's tab row and the open tab fill the column to the
// window's right and bottom edges, on a 1px border1 seam against the chat.
// Nothing inside a tab changes.
describe("side column", () => {
  it("draws the seam to the chat as its own 1px border1 left edge, the line the chat's resize handle runs along", () => {
    const pane = classConstant(read("workbench-pane.tsx"), "WORKBENCH_PANE_CLS");
    expect(pane).toEqual(expect.arrayContaining(["border-l", "border-border1", "bg-bg1"]));
  });

  it("holds the open tab flush under the tab row: no inset, corner or edge of its own", () => {
    const body = classConstant(read("workbench-pane.tsx"), "WORKBENCH_BODY_CLS");
    expect(body).toEqual(["flex", "min-h-0", "flex-1", "flex-col", "overflow-hidden"]);
    expect(read("workbench-pane.tsx")).not.toContain("WORKBENCH_ISLAND_CLS");
    // Surface kind="canvas" paints bg1 and binds --surface-border to border1
    // for what sits inside.
    expect(read("workbench-pane.tsx").match(/<Surface\s[^>]*kind="canvas"[^>]*className=\{WORKBENCH_BODY_CLS\}/g)).toHaveLength(1);
  });

  it("keeps one body mounted through the setting-up reveal, so the docked terminal finds it", () => {
    // The terminal panel's resizer applies the stored height from a layout
    // effect that reads its containerRef, and React attaches a parent's ref
    // only after its children's layout effects. A body that mounted with the
    // panel was still null there, so a panel revealed after setting up fell
    // back to the boot-time height.
    const src = read("workbench-pane.tsx");
    const bodies = src.match(/<Surface\b[^>]*>/g) ?? [];
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? "";
    expect(body).toContain("ref={bodyRef}");
    const start = src.indexOf(body);
    const inside = src.slice(start, src.indexOf("</Surface>", start));
    expect(inside).toContain("<SettingUpRow grow />");
    expect(inside).toContain("<TerminalPanel");
  });

  it("keeps the tab row outside the body and the PR row, tab bodies and docked terminal inside it", () => {
    const src = read("workbench-pane.tsx");
    const header = src.indexOf('data-testid="workbench-header"');
    const body = src.indexOf("data-workbench-body", header);
    const end = src.indexOf("</Surface>", body);
    expect(header).toBeGreaterThan(0);
    expect(body).toBeGreaterThan(header);
    const inside = src.slice(body, end);
    for (const part of ["<PrStatusRow", "<RetainedDesignDeck", "<RetainedBrowserDeck", "<TerminalPanel"]) {
      expect(inside).toContain(part);
    }
    // The docked terminal sizes against the body it lives in.
    expect(inside).toContain("containerRef={bodyRef}");
    expect(src).not.toContain("data-workbench-island");
  });

  it("starts the first tab 8px in from the seam", () => {
    expect(read("tab-strip.tsx")).toContain('<div className="flex h-full min-w-0 items-center pl-1">');
  });
});
