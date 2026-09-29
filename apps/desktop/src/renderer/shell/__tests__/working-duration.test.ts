import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityShimmer } from "../../shared/ui/loading/activity-shimmer";
import {
  WorkingDuration,
  formatElapsed,
  formatWorkingElapsed,
} from "../../shared/ui/loading/live-duration";

vi.mock("../../shared/ui/loading/zeros-spinner", () => ({
  ZerosSpinner: () => createElement("span", { "data-agent-loader": "" }),
}));

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("the agent's working timer", () => {
  it("counts in tenths of a second, minutes and seconds past a minute", () => {
    expect(formatWorkingElapsed(0)).toBe("0.0s");
    expect(formatWorkingElapsed(99)).toBe("0.0s");
    expect(formatWorkingElapsed(100)).toBe("0.1s");
    expect(formatWorkingElapsed(7_450)).toBe("7.4s");
    expect(formatWorkingElapsed(57_500)).toBe("57.5s");
    expect(formatWorkingElapsed(59_999)).toBe("59.9s");
    expect(formatWorkingElapsed(MINUTE)).toBe("1m, 0.0s");
    expect(formatWorkingElapsed(MINUTE + 27_300)).toBe("1m, 27.3s");
    // Minutes keep counting past the hour.
    expect(formatWorkingElapsed(103 * MINUTE + 57_500)).toBe("103m, 57.5s");
    expect(formatWorkingElapsed(-50)).toBe("0.0s");
  });

  it("leaves every other duration in whole seconds", () => {
    expect(formatElapsed(MINUTE + 27_300)).toBe("1m 27s");
    expect(formatElapsed(103 * MINUTE)).toBe("1h 43m");
  });

  it("shows at 12px in plain --fg2 with no pulse, and isn't read aloud on every tick", () => {
    const markup = renderToStaticMarkup(createElement(WorkingDuration, { startedAt: Date.now() - 7_450 }));
    expect(markup).toMatch(/^<span[^>]*class="[^"]*\btext-fg2\b[^"]*"/);
    // text-3xxs is the 12px step (zeros-tokens.css); text-xs is 13px here.
    expect(markup).toMatch(/class="[^"]*\btext-3xxs\b/);
    expect(markup).not.toMatch(/\btext-xs\b/);
    expect(markup).toContain("tabular-nums");
    expect(markup).not.toContain("zeros-agent-live-duration");
    expect(markup).toContain('aria-live="off"');
    expect(markup).toMatch(/>7\.[45]s<\/span>$/);
  });

  it("is the timer on the active turn's rail, a little apart from the loader", () => {
    const markup = renderToStaticMarkup(createElement(ActivityShimmer, { startedAt: Date.now() - 2 * MINUTE }));
    expect(markup).toMatch(/>2m, 0\.\ds<\/span>/);
    expect(markup).toMatch(/^<div[^>]*class="[^"]*\bgap-3\b/);
    expect(markup).not.toContain("zeros-agent-live-duration");
  });

  it("ticks on the shared frame loop, so a hidden retained chat stays inert", () => {
    const text = source("apps/desktop/src/renderer/shared/ui/loading/live-duration.tsx");
    const working = text.slice(text.indexOf("export const WorkingDuration"));
    expect(working).toContain("startLoaderRun(");
  });
});
