import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RUN_STREAM_BEAT_MS,
  RUN_STREAM_CYCLE_MS,
  RUN_STREAM_MOVE_MS,
  RUN_STREAM_PATTERN,
  RunStream,
  runStreamRowPath,
} from "../../shared/ui/loading/run-stream";

const render = (props: Parameters<typeof RunStream>[0]) =>
  renderToStaticMarkup(createElement(RunStream, props));

describe("RunStream", () => {
  it("streams an irregular 4 × 4 square of ten tiles", () => {
    expect(RUN_STREAM_PATTERN).toHaveLength(4);
    expect(RUN_STREAM_PATTERN.flat().filter(Boolean)).toHaveLength(10);
    const markup = render({ size: 12, className: "text-blue-primary" });
    expect(markup).toContain('data-run-stream=""');
    expect(markup).toContain('data-animated="true"');
    expect(markup).toMatch(/class="[^"]*\btext-blue-primary\b/);
    expect(markup).toContain('fill="currentColor"');
    expect(markup.match(/<path/g)).toHaveLength(4);
  });

  it("draws each row as one path holding two copies, so the wrap is seamless", () => {
    const d = runStreamRowPath([1, 1, 0, 1], 0);
    expect(d).toBe("M-4 0h1v1h-1zM-3 0h1v1h-1zM-1 0h1v1h-1zM0 0h1v1h-1zM1 0h1v1h-1zM3 0h1v1h-1z");
    expect(render({ size: 16 })).toContain('overflow:hidden');
  });

  it("cascades the rows one beat apart on the shared keyframe", () => {
    const markup = render({ size: 16 });
    expect(RUN_STREAM_CYCLE_MS).toBe(1520);
    expect(markup.match(new RegExp(`animation:zeros-run-stream ${RUN_STREAM_CYCLE_MS}ms linear infinite`, "g"))).toHaveLength(4);
    const delays = [...markup.matchAll(/animation-delay:(-?[\d.]+)ms/g)].map((m) => Number(m[1]));
    expect(delays).toHaveLength(4);
    for (let row = 1; row < 4; row++) expect(delays[row] - delays[row - 1]).toBeCloseTo(RUN_STREAM_BEAT_MS);
  });

  it("keeps the keyframe's slides in step with RUN_STREAM_MOVE_MS", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/global/animations.css"), "utf8");
    const block = css.slice(css.indexOf("@keyframes zeros-run-stream"));
    const share = ((RUN_STREAM_MOVE_MS / RUN_STREAM_CYCLE_MS) * 100).toFixed(2);
    expect(block).toContain(`${share}% {`);
    for (const quarter of [25, 50, 75]) {
      expect(block).toContain(`${(quarter + Number(share)).toFixed(2)}% {`);
    }
    expect(block).toMatch(/100% \{\s*transform: translateX\(4px\);/);
  });

  it("pins its size inline and stays decorative unless labelled", () => {
    const decorative = render({ size: 12 });
    expect(decorative).toMatch(/<span[^>]*style="width:12px;height:12px"/);
    expect(decorative).toContain('aria-hidden="true"');
    const labelled = render({ size: 16, label: "Running" });
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Running"');
  });
});
