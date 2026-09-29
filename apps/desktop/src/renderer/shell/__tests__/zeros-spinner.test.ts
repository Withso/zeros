import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { loaderFrame } from "../../shared/ui/loading/loader-frame";
import {
  ORBIT_HEAD,
  ORBIT_LAP_MS,
  ORBIT_LAYERS,
  ORBIT_TAIL,
  orbitDashArray,
} from "../../shared/ui/loading/orbit-motion";
import { PUZZLE_CELLS, PUZZLE_CORNERS, PUZZLE_HOLES } from "../../shared/ui/loading/puzzle-motion";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";

const render = (props: Parameters<typeof ZerosSpinner>[0]) =>
  renderToStaticMarkup(createElement(ZerosSpinner, props));

/** Cells ("x,y" → index) the puzzle's tiles start in, read from markup. */
function puzzleCells(markup: string): number[] {
  return [...markup.matchAll(/transform:translate\((\d)px, (\d)px\)/g)]
    .map((m) => Number(m[2]) * 4 + Number(m[1]))
    .sort((a, b) => a - b);
}

describe("loader geometry", () => {
  it("keeps tiles on whole device pixels at every product size", () => {
    expect(loaderFrame(12)).toEqual({ cell: 2.5, extent: 10, offset: 1 });
    expect(loaderFrame(14)).toEqual({ cell: 2.5, extent: 10, offset: 2 });
    expect(loaderFrame(16)).toEqual({ cell: 3, extent: 12, offset: 2 });
    expect(loaderFrame(20)).toEqual({ cell: 4, extent: 16, offset: 2 });
    expect(loaderFrame(24)).toEqual({ cell: 4.5, extent: 18, offset: 3 });
  });
});

describe("ZerosSpinner — Orbit", () => {
  it("draws the ring as a continuous track plus a layered comet, not blocks", () => {
    const markup = render({ size: 16 });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading"');
    expect(markup).toContain('data-zeros-loader="orbit"');
    expect(markup).not.toContain("<rect");
    // Track + one path per comet layer, all on the same ring.
    expect(markup.match(/<path/g)).toHaveLength(ORBIT_LAYERS.length + 1);
    expect(markup.match(/d="M0.5 0.5H3.5V3.5H0.5Z"/g)).toHaveLength(ORBIT_LAYERS.length + 1);
    expect(markup.match(new RegExp(`animation:zeros-orbit-lap ${ORBIT_LAP_MS}ms linear infinite`, "g"))).toHaveLength(
      ORBIT_LAYERS.length,
    );
  });

  it("gives every layer the same phase, so the snake moves as one piece", () => {
    const markup = render({ size: 16 });
    const delays = new Set([...markup.matchAll(/animation-delay:(-?[\d.]+)ms/g)].map((m) => m[1]));
    expect(delays.size).toBe(1);
  });

  it("ramps the tail smoothly from a solid head", () => {
    const head = ORBIT_LAYERS[ORBIT_LAYERS.length - 1];
    expect(head).toEqual({ length: ORBIT_HEAD, alpha: 1 });
    // Compound opacity at each tail slice, head → tail end, strictly falls.
    const slices = ORBIT_LAYERS.slice(0, -1).map((layer) => layer.length).sort((a, b) => a - b);
    let last = 1;
    for (const at of slices) {
      const through = ORBIT_LAYERS.filter((layer) => layer.length >= at).reduce((t, l) => t * (1 - l.alpha), 1);
      const alpha = 1 - through;
      expect(alpha).toBeLessThan(last);
      last = alpha;
    }
    expect(Math.max(...ORBIT_LAYERS.map((l) => l.length))).toBeCloseTo(ORBIT_HEAD + ORBIT_TAIL);
    // Every dash ends at the head: the pattern is exactly one ring long.
    for (const { length } of ORBIT_LAYERS) {
      const parts = orbitDashArray(length).split(" ").map(Number);
      expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(12);
      expect(parts[2]).toBeCloseTo(length);
    }
  });

  it("paints each tone from its semantic tokens", () => {
    expect(render({ size: 16 })).toContain("color:var(--loader-active, var(--fg2))");
    expect(render({ size: 16 })).toContain("stroke:var(--loader-rest, var(--muted-fg))");
    expect(render({ size: 16, tone: "inverted" })).toContain(
      "color:var(--loader-active-inverted, var(--primary-button-fg))",
    );
    expect(render({ size: 12, tone: "inherit" })).not.toMatch(/<span[^>]*style="[^"]*color:/);
  });
});

describe("ZerosSpinner — agent puzzle", () => {
  it("starts as a square of tiles with every corner filled", () => {
    const markup = render({ size: 16, variant: "agent", label: "Agent working" });
    expect(markup).toContain('data-zeros-loader="agent"');
    expect(markup).toContain('aria-label="Agent working"');
    const cells = puzzleCells(markup);
    expect(cells).toHaveLength(PUZZLE_CELLS - PUZZLE_HOLES);
    expect(new Set(cells).size).toBe(cells.length);
    for (const corner of PUZZLE_CORNERS) expect(cells).toContain(corner);
  });

  it("starts every mount from a different random square", () => {
    const starts = new Set(
      Array.from({ length: 24 }, () => puzzleCells(render({ size: 16, variant: "agent" })).join(",")),
    );
    expect(starts.size).toBeGreaterThan(12);
  });
});

describe("ZerosSpinner — sizing and guards", () => {
  it("pins its own svg size against blanket [&_svg]:size-* rules", () => {
    for (const variant of ["orbit", "agent", "glass"] as const) {
      const markup = render({ size: 14, variant });
      expect(markup).toMatch(/<span[^>]*style="width:14px;height:14px/);
      expect(markup).toMatch(/<svg[^>]*style="position:absolute;left:2px;top:2px;width:10px;height:10px/);
    }
  });

  it("gates the agent's squares on visibility and keeps the keyframes global", () => {
    const loop = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer/shared/ui/loading/loader-loop.ts"),
      "utf8",
    );
    expect(loop).toContain("isElementActuallyVisible(run.host)");
    // Both squares stepped from script run in that one loop.
    for (const square of ["puzzle-square.tsx", "glass-square.tsx"]) {
      const source = readFileSync(
        resolve(process.cwd(), `apps/desktop/src/renderer/shared/ui/loading/${square}`),
        "utf8",
      );
      expect(source, square).toContain("startLoaderRun(");
      expect(source, square).not.toContain("requestAnimationFrame");
    }
    const css = readFileSync(resolve(process.cwd(), "styles/global/animations.css"), "utf8");
    expect(css).toMatch(/@keyframes zeros-orbit-lap\s*\{\s*from\s*\{\s*stroke-dashoffset:\s*12;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\[data-zeros-loader\] path/);
  });
});
