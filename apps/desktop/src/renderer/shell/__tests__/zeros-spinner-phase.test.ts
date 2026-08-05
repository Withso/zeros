import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ZerosSpinner,
  gridFadeDelayMs,
  lapPhase,
} from "../../shared/ui/loading/zeros-spinner";

/** Mirrors the module's own constants — kept local on purpose, so a change to
 *  the lap length or the diagonal stagger has to be made deliberately here
 *  too instead of the test silently following it. */
const LAP_MS = 1320;
const GRID_FADE_STEP_MS = 100;

/** The phase the browser actually paints for the sweep-origin resting dot:
 *  a CSS animation with delay `d` runs at local time `elapsed - d`, and the
 *  fade's period is one lap. This is the ground truth the synced shape loop
 *  has to agree with. */
function cssFadePhase(elapsedMs: number, offsetMs: number) {
  const localTime = elapsedMs - gridFadeDelayMs(0, 0, offsetMs);
  return (((localTime % LAP_MS) + LAP_MS) % LAP_MS) / LAP_MS;
}

/** Pull the (0,0) resting dot's animation-delay out of rendered markup. */
function firstFadeDelay(markup: string) {
  const m = markup.match(/animation-delay:\s*(-?[\d.]+)ms/);
  return m ? Number(m[1]) : null;
}

/** The lit cells in rendered markup as "x,y" grid coords. Every agent pose
 *  lights exactly four dots, so only WHICH ones are lit identifies a pose. */
function litCells(markup: string) {
  const lit: string[] = [];
  for (const chunk of markup.split("grid-column-start:").slice(1)) {
    const pos = chunk.match(/^(\d+);grid-row-start:(\d+)/);
    const active = chunk.match(/z-index:1;opacity:([\d.]+)/);
    if (pos && active && Number(active[1]) > 0) {
      lit.push(`${Number(pos[1]) - 1},${Number(pos[2]) - 1}`);
    }
  }
  return lit.sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ZerosSpinner phase jitter", () => {
  it("keeps the grid fade and the shape loop locked at every offset", () => {
    // The whole point of the agent variant: pose 0 and fade phase 0 restart on
    // the same frame. The jitter shifts both, so it must not pull them apart.
    for (const offsetMs of [0, 1, 137.5, 660, 1319.9, LAP_MS]) {
      for (const elapsedMs of [0, 17, 132, 660, 1320, 4021.7, 60_000]) {
        expect(lapPhase(elapsedMs, offsetMs)).toBeCloseTo(
          cssFadePhase(elapsedMs, offsetMs),
          10,
        );
      }
    }
  });

  it("reproduces the old lockstep behaviour at offset 0", () => {
    // Backwards-compat guard: zero jitter must equal the pre-jitter formula.
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        expect(gridFadeDelayMs(x, y, 0)).toBe(
          (x + y) * GRID_FADE_STEP_MS - LAP_MS,
        );
      }
    }
    expect(lapPhase(0, 0)).toBe(0);
  });

  it("still walks the fade down the TL→BR diagonal", () => {
    // Jitter shifts the whole instance; it must not flatten the sweep.
    const offsetMs = 400;
    const origin = gridFadeDelayMs(0, 0, offsetMs);
    expect(gridFadeDelayMs(1, 0, offsetMs) - origin).toBe(GRID_FADE_STEP_MS);
    expect(gridFadeDelayMs(3, 3, offsetMs) - origin).toBe(
      6 * GRID_FADE_STEP_MS,
    );
  });

  it("gives two spinners mounted together different phases", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.8);

    const first = firstFadeDelay(
      renderToStaticMarkup(createElement(ZerosSpinner, { variant: "agent" })),
    );
    const second = firstFadeDelay(
      renderToStaticMarkup(createElement(ZerosSpinner, { variant: "agent" })),
    );

    expect(first).toBeCloseTo(-LAP_MS - 0.25 * LAP_MS, 6);
    expect(second).toBeCloseTo(-LAP_MS - 0.8 * LAP_MS, 6);
    expect(first).not.toBe(second);
  });

  it("starts the piece mid-lap instead of always on the rest pose", () => {
    // 0.25 through a 10-pose agent lap = pose 2 ("the crest peaks"), NOT the
    // pose-6 mid-descent square every instance used to boot on.
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const markup = renderToStaticMarkup(
      createElement(ZerosSpinner, { variant: "agent", size: 16 }),
    );

    expect(litCells(markup)).toEqual(["1,0", "1,1", "2,0", "2,1"]);
    // The old boot pose, for contrast — this is what it must no longer be.
    expect(litCells(markup)).not.toEqual(["2,1", "2,2", "3,1", "3,2"]);
  });

  it("boots two spinners on different poses", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.05)
      .mockReturnValueOnce(0.65);
    const a = renderToStaticMarkup(
      createElement(ZerosSpinner, { variant: "agent" }),
    );
    const b = renderToStaticMarkup(
      createElement(ZerosSpinner, { variant: "agent" }),
    );

    expect(litCells(a)).not.toEqual(litCells(b));
  });
});
