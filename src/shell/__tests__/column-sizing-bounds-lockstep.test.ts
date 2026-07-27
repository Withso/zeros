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

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
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
