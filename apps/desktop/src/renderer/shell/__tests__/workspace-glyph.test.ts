import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PUZZLE_CORNERS, PuzzleBoard, seededRandom } from "../../shared/ui/loading/puzzle-motion";
import {
  PUZZLE_RESTING_LIMIT,
  PuzzleSquare,
  rememberRestingSquare,
  restingSquare,
} from "../../shared/ui/loading/puzzle-square";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";
import {
  WorkspaceGlyph,
  workspaceGlyphSeed,
  workspacePrTone,
} from "../workspace-glyph";

const ROW = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx"),
  "utf8",
);
const SIDEBAR = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/shell/app-sidebar.tsx"),
  "utf8",
);

const render = (props: Parameters<typeof WorkspaceGlyph>[0]) =>
  renderToStaticMarkup(createElement(WorkspaceGlyph, props));

/** Each tile's starting cell, in tile order, read from markup. */
function tiles(markup: string): number[] {
  return [...markup.matchAll(/transform:translate\((\d)px, (\d)px\)/g)].map(
    (m) => Number(m[2]) * 4 + Number(m[1]),
  );
}

/** The cells the square fills. */
const cells = (markup: string) => tiles(markup).sort((a, b) => a - b);

describe("workspace glyph", () => {
  it("draws each workspace's own square, the same on every render", () => {
    const seed = workspaceGlyphSeed("zeros", "zeros/palembang");
    expect(seed).toBe("zeros/zeros/palembang");
    const first = cells(render({ seed }));
    expect(cells(render({ seed }))).toEqual(first);
    for (const corner of PUZZLE_CORNERS) expect(first).toContain(corner);
    const others = new Set(
      ["boston", "atlanta", "seville", "lisbon", "kyoto", "oslo"].map((name) =>
        cells(render({ seed: workspaceGlyphSeed("zeros", `zeros/${name}`) })).join(","),
      ),
    );
    expect(others.size).toBeGreaterThan(3);
  });

  it("comes back where it last rested after its row swapped it out", () => {
    const seed = workspaceGlyphSeed("zeros", "zeros/cairo");
    const board = new PuzzleBoard(seededRandom(seed), seededRandom("hands"));
    board.start(0);
    for (let now = 0; now < 5000; now += 16) board.step(now);
    const rested = board.cellOf.slice();
    expect(rested.slice().sort((a, b) => a - b)).not.toEqual(cells(render({ seed })));

    rememberRestingSquare(seed, rested);
    expect(tiles(render({ seed }))).toEqual(rested);
    // Only seeded squares resume; the chat loaders stay random per mount.
    expect(restingSquare(workspaceGlyphSeed("zeros", "zeros/lima"))).toBeUndefined();
  });

  it("remembers a bounded number of resting squares", () => {
    const cellsOf = new PuzzleBoard(seededRandom("bound")).cellOf;
    rememberRestingSquare("bound/first", cellsOf);
    for (let i = 0; i < PUZZLE_RESTING_LIMIT; i++) rememberRestingSquare(`bound/${i}`, cellsOf);
    expect(restingSquare("bound/first")).toBeUndefined();
    expect(restingSquare(`bound/${PUZZLE_RESTING_LIMIT - 1}`)).toEqual(cellsOf);
  });

  // 2026-11-25 (FndGlyphs): the glyph is a still fg3 square; PR and agent
  // state read from the sidebar's marks and the chat tabs.
  it("rests in fg3 and carries no PR or agent state", () => {
    const seed = workspaceGlyphSeed("zeros", "zeros/palembang");
    expect(render({ seed })).toMatch(/class="[^"]*\btext-fg3\b/);
    expect(render({ seed })).not.toContain('data-active="true"');
    expect(render({ seed })).not.toMatch(/text-(green|violet|red|yellow)-/);
  });

  it("maps PR state the way the former PR icons did", () => {
    const pr = (prState: string | null, island: string | null, prNumber: number | null = 7) =>
      workspacePrTone({ prNumber, prState: prState as never }, island);
    expect(pr(null, null, null)).toBeNull();
    expect(pr("open", null)).toBe("open");
    expect(pr("open", "checks-running")).toBe("open");
    expect(pr("open", "ready-to-merge")).toBe("ready");
    expect(pr("open", "merge-conflicts")).toBe("conflicts");
    expect(pr("open", "unable-to-merge")).toBe("conflicts");
    expect(pr("open", "merged")).toBe("merged");
    // Terminal persisted states outrank a stale live island kind.
    expect(pr("merged", "ready-to-merge")).toBe("merged");
    expect(pr("closed", "ready-to-merge")).toBe("closed");
  });
});

describe("sidebar workspace rows", () => {
  const confirmed = ROW.slice(
    ROW.indexOf("export function SidebarWorkspaceRow("),
    ROW.indexOf("/** Placeholder row"),
  );
  const pending = ROW.slice(ROW.indexOf("export function PendingSidebarWorkspaceRow("));

  // Step 2 (v14 B01/B04): the leading slot is the project logo; PR state
  // moved to line 2's marks, so the seeded PR-coloured square is gone.
  it("lead with the project logo instead of the seeded square or Git icons", () => {
    expect(ROW).not.toMatch(/<GitBranch|<GitMerge/);
    expect(ROW).not.toContain("<WorkspaceGlyph");
    expect(confirmed).toContain("sidebarRowLead(");
    expect(confirmed).toContain(": <WorkspaceProjectIcon project={project} />;");
  });

  it("show the agent loader in the leading slot while an agent works", () => {
    expect(confirmed).toMatch(/lead === "working" \? <AgentActivityIndicator activity=\{activity\} \/>/);
    expect(confirmed).toMatch(/lead === "archiving" \? <ZerosSpinner size=\{16\} label="Archiving workspace" \/>/);
  });

  it("give the optimistic row the same logo and Creating… on line 2", () => {
    expect(pending).toContain("<WorkspaceProjectIcon project={project} />");
    expect(pending).toContain("Creating…");
    expect(SIDEBAR).toMatch(/<PendingSidebarWorkspaceRow[\s\S]{0,400}?cloud=\{item\.pending\.placement === "cloud"\}/);
  });
});

describe("workspace glyph depth", () => {
  const seed = workspaceGlyphSeed("zeros", "zeros/palembang");
  /** Each tile's cell and opacity, in tile order. */
  const tileShades = (markup: string) =>
    [...markup.matchAll(/<rect[^>]*style="([^"]*)"/g)].map((m) => {
      const [, x, y] = /translate\((\d)px, (\d)px\)/.exec(m[1]) ?? [];
      const opacity = /opacity:([\d.]+)/.exec(m[1]);
      return { cell: Number(y) * 4 + Number(x), opacity: opacity ? Number(opacity[1]) : 1 };
    });

  it("shades a working square's moving tiles in three close tones", () => {
    {
      const tiles = tileShades(renderToStaticMarkup(createElement(PuzzleSquare, { seed, active: true, shaded: true })));
      expect(tiles).toHaveLength(10);
      const channel = tiles.filter((t) => !PUZZLE_CORNERS.includes(t.cell));
      const tones = new Set(channel.map((t) => t.opacity));
      expect(tones.size).toBe(3);
      expect(Math.max(...tones)).toBe(1);
      // Subtle: every tone stays close to the colour itself.
      expect(Math.min(...tones)).toBeGreaterThanOrEqual(0.6);
      // The corners keep the square's outline at full strength.
      for (const t of tiles.filter((t) => PUZZLE_CORNERS.includes(t.cell))) expect(t.opacity).toBe(1);
    }
  });

  it("rests in one flat colour", () => {
    expect(new Set(tileShades(render({ seed })).map((t) => t.opacity))).toEqual(new Set([1]));
  });

  it("belongs to the workspace glyph alone, not the agent loader", () => {
    const loader = renderToStaticMarkup(createElement(ZerosSpinner, { size: 16, variant: "agent" }));
    expect(loader).not.toMatch(/opacity:/);
    const plain = renderToStaticMarkup(createElement(PuzzleSquare, { seed, active: true }));
    expect(plain).not.toMatch(/<rect[^>]*opacity:/);
  });
});
