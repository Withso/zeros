// Lockstep guard — the resize clamps are pure TS constants, but the
// pixel floors / share caps they enforce are ALSO baked into Tailwind
// arbitrary-value classes (which can't read JS). If the two drift, the
// live drag clamps against one bound while CSS renders another and the
// on-release snap-back the proportional-columns refactor eliminated
// silently returns — with the unit tests still green (they only
// exercise the constants). This test reads the render sources and
// asserts every class still spells out its constant, so a change to one
// side that forgets the other fails here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COLUMN_2_MAX_PX,
  COLUMN_2_MIN_PX,
  COLUMN_2_RATIO_DEFAULT,
  COLUMN_2_RATIO_MAX,
  COLUMN_2_RATIO_VAR,
  COLUMN_3_MIN_PX,
} from "../column2-ratio";
import {
  FILES_SIDEBAR_MAX_FRACTION,
  FILES_SIDEBAR_MIN_PX,
} from "../column3-tabs/files-sidebar-width";
import {
  TERMINAL_PANEL_DEFAULT_PCT,
  TERMINAL_PANEL_HEIGHT_VAR,
  TERMINAL_PANEL_MAX_OFFSET_PX,
  TERMINAL_PANEL_MIN_PX,
  TERMINAL_ROW1_MIN_PX,
  TERMINAL_SEAM_PX,
} from "../terminal/terminal-panel-layout";

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

/** Source with comments removed. The "never transitions X" guards below scan
 *  for class names, and these files explain at length which transitions were
 *  removed and why — a naive scan matches the explanation and fails. */
function code(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Fraction → integer percent, dodging float drift (0.7 * 100 !== 70). */
function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

describe("column 2 / column 3 sizing bounds stay in lockstep with CSS", () => {
  const col2 = read("../column2-workspace.tsx");
  const col3 = read("../column3.tsx");

  it("col 2's min-width class matches COLUMN_2_MIN_PX", () => {
    expect(col2).toContain(`min-w-[${COLUMN_2_MIN_PX}px]`);
  });

  it("col 2's max-width class matches the px ceiling + share cap", () => {
    expect(col2).toContain(
      `max-w-[min(${COLUMN_2_MAX_PX}px,${pct(COLUMN_2_RATIO_MAX)}%)]`,
    );
  });

  it("col 2's flex-grow reads the ratio var with the default fallback", () => {
    // ×100 keeps the two columns' grow sum ≥ 1 so flexbox hands the
    // full remainder to col 3 when col 2 freezes at its 2400px cap.
    expect(col2).toContain(
      `calc(var(${COLUMN_2_RATIO_VAR},${COLUMN_2_RATIO_DEFAULT})*100)`,
    );
  });

  it("col 3's min-width class matches COLUMN_3_MIN_PX", () => {
    expect(col3).toContain(`min-w-[${COLUMN_3_MIN_PX}px]`);
  });

  it("col 3's flex-grow is the complement of col 2's ratio", () => {
    expect(col3).toContain(
      `calc((1_-_var(${COLUMN_2_RATIO_VAR},${COLUMN_2_RATIO_DEFAULT}))*100)`,
    );
  });

  it("paints live drag grow factors directly instead of invalidating an inherited variable", () => {
    expect(col2).toContain('style.setProperty("flex-grow"');
    expect(col2).toContain('[data-zeros-column-3]');
    expect(col3).toContain('data-zeros-column-3=""');
  });

  it("locks expensive child surfaces to one reflow per column drag", () => {
    const terminalTab = read("../column3-tabs/terminal-tab.tsx");
    expect(col2).toContain("lockResizeDescendantWidths(row)");
    expect(col2).toContain('data-zeros-resize-width-lock=""');
    expect(col3).toContain('data-zeros-resize-width-lock=""');
    expect(terminalTab).toContain('data-zeros-resize-width-lock=""');
  });
});

// ── The col-3 expand jerk, guarded ────────────────────────────────────────
// Collapsing column 3 and expanding it again used to snap column 2 down to
// its 320px floor and then ease back out to the saved split (measured:
// 1600 → 320 → 800px). Two independent mistakes combined to produce it, and
// either one alone would bring it back, so both are asserted here.
describe("collapsing column 3 cannot move column 2", () => {
  const col2 = code("../column2-workspace.tsx");
  const flexDecl = `[flex:calc(var(${COLUMN_2_RATIO_VAR},${COLUMN_2_RATIO_DEFAULT})*100)_1_0px]`;

  it("uses the SAME flex declaration collapsed and expanded", () => {
    // Mistake 1: the collapsed state used `flex-1 basis-auto` (grow 1). The
    // first expanded frame therefore split the row 1 : ratio·100 — about 2%
    // for column 2 — before flexbox handed it the intended share back.
    // `basis-auto` also forced a max-content measurement of the whole chat
    // transcript just to size the column.
    const declarations = col2.match(/\[flex:calc\(var\([^\]]*\]/g) ?? [];
    expect(declarations.length).toBe(2);
    expect(new Set(declarations).size).toBe(1);
    expect(declarations[0]).toBe(flexDecl);
    expect(col2).not.toContain("basis-auto");
  });

  it("lifts only the max-width cap while collapsed", () => {
    // Column 2 is the sole flex item then, so the 70% share cap would leave a
    // 30% void where column 3 used to be.
    expect(col2).toContain(
      `${flexDecl} min-w-[${COLUMN_2_MIN_PX}px] max-w-none`,
    );
  });

  it("never transitions a flex property", () => {
    // Mistake 2: `transition-[flex-grow] duration-150` turned the overshoot
    // above into a visible 150ms animation, and re-ran it on every launch
    // (see boot-layout-vars.test.ts). Animating a grow factor is not a width
    // animation anyway — grow 1→50 against a fixed 50 is wildly non-linear —
    // and every frame reflows the transcript, column 3, and every xterm.
    expect(col2).not.toMatch(/transition-\[[^\]]*flex/);
  });
});

// ── The terminal-panel collapse jank, guarded ─────────────────────────────
describe("terminal panel seam geometry stays in lockstep with CSS", () => {
  const terminalTab = code("../column3-tabs/terminal-tab.tsx");
  const setupTab = code("../column3-tabs/setup-tab.tsx");

  it("derives the panel max from the row-1 floor plus the seam", () => {
    expect(TERMINAL_PANEL_MAX_OFFSET_PX).toBe(
      TERMINAL_ROW1_MIN_PX + TERMINAL_SEAM_PX,
    );
  });

  it("keeps the emitted flex-basis clamp equal to the geometry constants", () => {
    // Tailwind must see a literal arbitrary class at build time, so this guard
    // derives that literal from the TS constants and catches either side
    // changing alone.
    expect(terminalTab).toContain(
      `[flex-basis:clamp(${TERMINAL_PANEL_MIN_PX}px,var(${TERMINAL_PANEL_HEIGHT_VAR},${TERMINAL_PANEL_DEFAULT_PCT}%),calc(100%_-_${TERMINAL_PANEL_MAX_OFFSET_PX}px))]`,
    );
  });

  it("keeps the expanded min-height class equal to TERMINAL_PANEL_MIN_PX", () => {
    expect(terminalTab).toContain(`min-h-[${TERMINAL_PANEL_MIN_PX}px]`);
  });

  it("never transitions flex-basis or min-height", () => {
    // The panel carried `transition-[flex-basis,min-height] duration-300`.
    // Its body is hidden the instant `expanded` flips, so a collapse animated
    // an empty box shut; worse, an expand walked the body through 14 distinct
    // heights, and xterm's ResizeObserver refits + resizes the PTY on each one
    // — the shell-redraw storm the spawn path was written to avoid.
    expect(terminalTab).not.toMatch(
      /transition-\[[^\]]*(flex-basis|min-height)/,
    );
  });

  it("paints live flex-basis directly instead of invalidating xterm descendants", () => {
    const resizer = code("../terminal/terminal-panel-resizer.tsx");
    expect(resizer).toContain('style.setProperty("flex-basis"');
  });

  it("keeps padding outside Setup's measured xterm host", () => {
    // FitAddon measures the terminal element's parent border box. Padding on
    // that same host makes it over-count usable rows/columns and clip the grid
    // at narrow sizes.
    expect(setupTab).toContain(
      'className="size-full min-h-0 min-w-0 overflow-hidden"',
    );
    expect(setupTab).not.toMatch(
      /ref=\{hostRef\}[\s\S]{0,160}className=\{cn\([\s\S]{0,160}\b(?:px-|py-|p-)/,
    );
  });
});

describe("files/changes sidebar bounds stay in lockstep with CSS", () => {
  const filesTab = read("../column3-tabs/files-tab.tsx");
  const changesTab = read("../column3-tabs/changes-row1-tab.tsx");

  for (const [name, src] of [
    ["files-tab", filesTab],
    ["changes-row1-tab", changesTab],
  ] as const) {
    it(`${name}'s sidebar min-width matches FILES_SIDEBAR_MIN_PX`, () => {
      expect(src).toContain(`min-w-[${FILES_SIDEBAR_MIN_PX}px]`);
    });

    it(`${name}'s sidebar max-width matches FILES_SIDEBAR_MAX_FRACTION`, () => {
      expect(src).toContain(`max-w-[${pct(FILES_SIDEBAR_MAX_FRACTION)}%]`);
    });
  }
});
