import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { RunWave } from "../../loaders/run-wave";
import {
  RUN_WAVE_MOTION,
  RUN_WAVE_SAMPLE_COUNT,
  runWaveScaleAtProgress,
} from "../../loaders/run-wave-motion";

describe("RunWave", () => {
  it("renders five true SVG strokes rather than filled vector shapes", () => {
    const markup = renderToStaticMarkup(
      createElement(RunWave, {
        className: "text-fg2",
        size: 14,
      }),
    );

    expect(markup.match(/<line/g)).toHaveLength(5);
    expect(markup.match(/<animateTransform/g)).toHaveLength(5);
    expect(markup).toMatch(/class="[^"]*\btext-fg2\b/);
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('stroke-width="1"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('vector-effect="non-scaling-stroke"');
    expect(markup.match(/transform="translate\([^ ]+ 18\)"/g)).toHaveLength(5);
    expect(
      [...markup.matchAll(/transform="translate\(([^ ]+) 18\)"/g)].map(
        (match) => Number(match[1]),
      ),
    ).toEqual([2.5, 6.25, 10, 13.75, 17.5]);
    expect(markup.match(/y1="-14"/g)).toHaveLength(5);
    expect(markup).not.toContain('y1="-16"');
    expect(markup.match(/y2="0"/g)).toHaveLength(5);
    expect(markup).not.toMatch(/transform="translate\([^ ]+ 10\)"/);
    expect(markup).not.toContain("<path");
  });

  it("pins the requested size against an inherited [&_svg]:size-* rule", () => {
    // width/height are presentation attributes, which ANY author rule outranks
    // — and this icon's real placement is inside a Button carrying a blanket
    // `[&_svg]:size-3.5`. Without an inline size the box renders at 14px while
    // runWaveStrokeWidth keeps weighting the stroke for the 12 that was asked
    // for, so the two silently disagree.
    const markup = renderToStaticMarkup(createElement(RunWave, { size: 12 }));

    expect(markup).toMatch(/style="width:12px;height:12px"/);
    expect(markup).toContain('width="12"');
    expect(markup).toContain('height="12"');
    expect(markup).toContain('stroke-width="0.8"');
  });

  it("keeps the requested 16px weight and seamless faster loop", () => {
    const markup = renderToStaticMarkup(
      createElement(RunWave, {
        size: 16,
      }),
    );

    expect(markup).toContain('stroke-width="1.2"');
    expect(markup).toContain(`dur="${RUN_WAVE_MOTION.cycleDurationMs}ms"`);
    expect(markup).toContain('repeatCount="indefinite"');
    expect(RUN_WAVE_SAMPLE_COUNT).toBe(60);

    for (let bar = 0; bar < RUN_WAVE_MOTION.bars.length; bar += 1) {
      expect(runWaveScaleAtProgress(bar, 1)).toBe(
        runWaveScaleAtProgress(bar, 0),
      );
    }
  });
});
