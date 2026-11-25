import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { loaderFrame } from "../../shared/ui/loading/loader-frame";
import { PUZZLE_CELLS, PUZZLE_CORNERS, PUZZLE_HOLES } from "../../shared/ui/loading/puzzle-motion";
import { RUN_STREAM_BEAT_MS, RUN_STREAM_CYCLE_MS, RUN_STREAM_PATTERN } from "../../shared/ui/loading/run-stream";
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

// 2026-11-25 (P11): Stream-run is the app's loader everywhere but startup;
// ZerosSpinner's default draws its rows (the Island Z weave stays in
// index.html and StartupLogoLoader only).
describe("ZerosSpinner — stream (default)", () => {
  it("draws Stream-run's four streaming rows, clipped to the square", () => {
    const markup = render({ size: 16 });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading"');
    expect(markup).toContain('data-zeros-loader="stream"');
    expect(markup.match(/<path/g)).toHaveLength(RUN_STREAM_PATTERN.length);
    expect(markup).toMatch(/<svg[^>]*style="[^"]*overflow:hidden/);
  });

  it("runs the shared stream keyframe one beat per row", () => {
    const markup = render({ size: 16 });
    const rows = [...markup.matchAll(/animation:zeros-run-stream (\d+)ms linear infinite;animation-delay:(-?[\d.]+)ms/g)];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => Number(row[1]))).toEqual(Array(4).fill(RUN_STREAM_CYCLE_MS));
    const delays = rows.map((row) => Number(row[2]));
    for (let i = 1; i < delays.length; i++) expect(delays[i] - delays[i - 1]).toBeCloseTo(RUN_STREAM_BEAT_MS);
  });

  it("keeps the Island Z weave out of the app's stylesheet", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/global/animations.css"), "utf8");
    expect(css).not.toContain("zeros-logo-weave");
    expect(css).toContain("@keyframes zeros-run-stream");
  });

  it("paints each tone from its semantic tokens", () => {
    expect(render({ size: 16 })).toContain("color:var(--loader-active, var(--fg2))");
    expect(render({ size: 16 })).toContain('fill="currentColor"');
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
    for (const variant of ["stream", "agent", "glass"] as const) {
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
    expect(css).toContain("@keyframes zeros-run-stream");
    expect(css).not.toContain("zeros-orbit-lap");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\[data-zeros-loader\] path/);
  });
});
