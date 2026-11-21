// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  LINE_STEP_WAIT_MS,
  REVEAL_LAG_CAP_MS,
  UNDECIDED_STEP_LINES,
  UNIT_STAGGER_MS,
  afterTail,
  groupLines,
  release,
  releasePending,
  releaseState,
  revealCuts,
  revealRole,
  revealUnitElements,
  tailClosed,
  tailHold,
  type Cut,
} from "../renderers/text-reveal";

const FRAME = 1_000 / 60;

function dom(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

/** Run releases at 60fps over a timeline of cut lists; record each step. */
function drive(timeline: [number, Cut[]][], until: number, options?: Parameters<typeof release>[3]) {
  const state = releaseState();
  const steps: { t: number; y: number }[] = [];
  let cuts: Cut[] = [];
  let next = 0;
  for (let t = 0; t <= until; t += FRAME) {
    while (next < timeline.length && timeline[next][0] <= t) cuts = timeline[next++][1];
    const before = state.shownY;
    release(state, cuts, t, options);
    if (state.shownY !== before) steps.push({ t, y: state.shownY });
  }
  return { state, steps, cuts };
}

const unit = (y: number): Cut => ({ y, kind: "unit" });
const line = (y: number): Cut => ({ y, kind: "line" });

describe("unit segmentation", () => {
  it("splits blocks, list items and code into units in order", () => {
    const units = revealUnitElements(dom(
      "<h2>Title</h2><p>One.</p><ul><li>a</li><li>b</li></ul><blockquote><p>Quoted.</p></blockquote>" +
      "<div class=\"zeros-md-codeblock\"><pre><code>x\ny</code></pre></div><p><img src=\"x.png\"></p><hr>"));
    expect(units.map(({ el, kind }) => `${kind}:${el.tagName.toLowerCase()}`)).toEqual([
      "text:h2", "text:p", "text:li", "text:li", "text:p", "code:div", "block:img", "block:hr",
    ]);
  });

  it("shows a table's header row with its first body row", () => {
    const units = revealUnitElements(dom(
      "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>"));
    expect(units.map(({ el, kind }) => `${kind}:${el.textContent}`)).toEqual(["row:1", "row:2"]);
  });

  it("splits a list item at its nested items", () => {
    const units = revealUnitElements(dom("<ul><li>Parent<ul><li>child one</li><li>child two</li></ul></li><li>next</li></ul>"));
    expect(units.map(({ el }) => el.textContent)).toEqual(["child one", "child two", "next"]);
  });

  it("knows when the last block is finished", () => {
    expect(tailClosed("One paragraph")).toBe(false);
    expect(tailClosed("One paragraph\n\n")).toBe(true);
    expect(tailClosed("- a\n- b\n")).toBe(false);
    expect(tailClosed("```ts\nconst a = 1;\n")).toBe(false);
    expect(tailClosed("```ts\nconst a = 1;\n```")).toBe(true);
    expect(tailClosed("```ts\nconst a = 1;\n```\n")).toBe(true);
  });

  it("groups text rects into line boxes", () => {
    expect(groupLines([
      { top: 0, bottom: 18 }, { top: 2, bottom: 16 }, { top: 20, bottom: 38 }, { top: 21, bottom: 37 }, { top: 40, bottom: 58 },
    ])).toEqual([{ top: 0, bottom: 18 }, { top: 20, bottom: 38 }, { top: 40, bottom: 58 }]);
  });

  it("cuts after complete units, and after the complete lines of the one still growing", () => {
    const lines = [{ top: 100, bottom: 118 }, { top: 122, bottom: 140 }, { top: 144, bottom: 162 }];
    expect(revealCuts([{ kind: "text", bottom: 40 }, { kind: "text", bottom: 162, lines }], false))
      .toEqual([unit(40), line(120), line(142)]);
    expect(revealCuts([{ kind: "text", bottom: 40 }, { kind: "text", bottom: 162, lines }], true))
      .toEqual([unit(40), unit(162)]);
    // A line holding an unclosed opener (and everything after) waits.
    expect(revealCuts([{ kind: "text", bottom: 162, lines }], false, 122)).toEqual([line(120)]);
  });

  it("releases a long code block's complete lines too", () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ top: i * 20, bottom: i * 20 + 18 }));
    expect(revealCuts([{ kind: "code", bottom: 118, lines }], false).length).toBe(5);
  });

  it.each([
    ["Some **bold", "**"],
    ["Run `pnpm", "`"],
    ["See [the docs", "["],
    ["See [the docs](https://example", "["],
    ["Done **bold** and `code` ok.", null],
    ["See [the docs](https://example.test) now.", null],
  ])("finds the earliest unclosed opener in %j", (source, opener) => {
    expect(tailHold(source).opener).toBe(opener);
  });

  it("holds a block that may still change kind", () => {
    expect(tailHold("Intro\n\n```ts\nconst a = 1;").block).toBe(true);
    expect(tailHold("Intro\n\n| a | b |").block).toBe(true);
    expect(tailHold("Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\nmore").block).toBe(true);
    expect(tailHold("Intro\n\n#").block).toBe(true);
    expect(tailHold("Intro\n\n- ").block).toBe(true);
    expect(tailHold("Para\n---").block).toBe(true);
    expect(tailHold("Intro\n\n```ts\nconst a = 1;\n```\n").block).toBe(false);
    expect(tailHold("Plain words.").block).toBe(false);
  });
});

describe("release pacing", () => {
  it("releases a unit as soon as it completes", () => {
    const { steps } = drive([[500, [unit(40)]]], 700);
    expect(steps).toEqual([{ t: expect.closeTo(500, -1), y: 40 }]);
  });

  it("staggers a burst of completed units in order", () => {
    const { steps } = drive([[100, [unit(20), unit(40), unit(60), unit(80)]]], 1_000);
    expect(steps.map((step) => step.y)).toEqual([20, 40, 60, 80]);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].t - steps[i - 1].t).toBeGreaterThanOrEqual(UNIT_STAGGER_MS);
      expect(steps[i].t - steps[i - 1].t).toBeLessThan(UNIT_STAGGER_MS + FRAME + 1);
    }
  });

  it("never trails a completed unit by more than the cap: the rest shows together", () => {
    const burst = Array.from({ length: 30 }, (_, i) => unit((i + 1) * 20));
    const { steps } = drive([[0, burst]], 2_000);
    expect(steps.at(-1)!.y).toBe(600);
    expect(steps.at(-1)!.t).toBeLessThanOrEqual(REVEAL_LAG_CAP_MS + FRAME);
    expect(steps.length).toBeLessThan(burst.length);
  });

  it("releases a growing paragraph's lines in steps of two", () => {
    // A line completes every 400ms.
    const timeline: [number, Cut[]][] = [];
    for (let n = 1; n <= 6; n++) timeline.push([n * 400, Array.from({ length: n }, (_, i) => line((i + 1) * 20))]);
    const { steps } = drive(timeline, 2_600);
    expect(steps.map((step) => step.y)).toEqual([40, 80, 120]);
  });

  it("does not let a lone complete line wait longer than about a second", () => {
    const { steps } = drive([[300, [line(20)]]], 2_000);
    expect(steps).toHaveLength(1);
    expect(steps[0].t - 300).toBeGreaterThanOrEqual(LINE_STEP_WAIT_MS - FRAME);
    expect(steps[0].t - 300).toBeLessThanOrEqual(LINE_STEP_WAIT_MS + FRAME);
  });

  it("holds a phase-less first paragraph until it is clearly long", () => {
    const options = { stepLines: UNDECIDED_STEP_LINES, lineWaitMs: Infinity };
    expect(drive([[0, [line(20), line(40)]]], 3_000, options).steps).toEqual([]);
    expect(drive([[0, [line(20), line(40), line(60)]]], 200, options).steps.map((step) => step.y)).toEqual([60]);
    // Completed by the next unit: it is the answer, shown at once.
    expect(drive([[0, [unit(40)]]], 200, options).steps.map((step) => step.y)).toEqual([40]);
  });

  it("knows when nothing is left to release", () => {
    const state = releaseState(40);
    expect(releasePending(state, [unit(40)])).toBe(false);
    expect(releasePending(state, [unit(40), unit(60)])).toBe(true);
  });
});

describe("classification", () => {
  it("follows an explicit phase, and a phase-less message once it showed", () => {
    expect(revealRole("commentary", false)).toBe("between");
    expect(revealRole("commentary", true)).toBe("between");
    expect(revealRole("final_answer", false)).toBe("output");
    expect(revealRole("partial_answer", false)).toBe("output");
    expect(revealRole(undefined, false)).toBe("undecided");
    expect(revealRole(null, true)).toBe("output");
  });

  it("completes a phase-less message at once when a tool call follows it", () => {
    expect(afterTail({ role: "undecided", revealing: true, turnLive: true, endedNaturally: false })).toBe("complete");
    expect(afterTail({ role: "output", revealing: true, turnLive: true, endedNaturally: false })).toBe("complete");
  });

  it("finishes an answer in place only after a natural turn end", () => {
    expect(afterTail({ role: "undecided", revealing: true, turnLive: false, endedNaturally: true })).toBe("finish-in-place");
    expect(afterTail({ role: "output", revealing: true, turnLive: false, endedNaturally: true })).toBe("finish-in-place");
    expect(afterTail({ role: "output", revealing: true, turnLive: false, endedNaturally: false })).toBe("complete");
    expect(afterTail({ role: "between", revealing: true, turnLive: false, endedNaturally: true })).toBe("complete");
    expect(afterTail({ role: "output", revealing: false, turnLive: false, endedNaturally: true })).toBe("complete");
  });
});
