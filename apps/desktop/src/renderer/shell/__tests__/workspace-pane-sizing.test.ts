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
  CONVERSATION_MAX_PX,
  CONVERSATION_MIN_PX,
  CONVERSATION_RATIO_DEFAULT,
  CONVERSATION_RATIO_MAX,
  CONVERSATION_RATIO_VAR,
  WORKBENCH_MIN_PX,
} from "../conversation/pane-sizing";
import {
  FILES_SIDEBAR_MAX_FRACTION,
  FILES_SIDEBAR_MIN_PX,
} from "../workbench/tabs/files-sidebar-width";
import {
  TERMINAL_PANEL_DEFAULT_PCT,
  TERMINAL_PANEL_HEIGHT_VAR,
  TERMINAL_PANEL_MAX_OFFSET_PX,
  TERMINAL_PANEL_MIN_PX,
  WORKBENCH_CONTENT_MIN_PX,
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

describe("conversation/workbench sizing bounds stay in lockstep with CSS", () => {
  const conversation = read("../conversation/conversation-pane.tsx");
  const workbench = read("../workbench/workbench-pane.tsx");

  it("the conversation pane's min-width matches CONVERSATION_MIN_PX", () => {
    expect(conversation).toContain(`min-w-[${CONVERSATION_MIN_PX}px]`);
  });

  it("raises the rendered conversation and split-child floors for the active tree", () => {
    const paneLayout = read("../conversation/pane-layout.tsx");
    expect(conversation).toContain("onMinimumSizeChange={setPaneMinimumSize}");
    expect(conversation).toContain("minWidth: paneMinimumSize.width");
    expect(paneLayout).toContain("paneTreeMinimumSize(node.first)");
    expect(paneLayout).toContain("minWidth: isRow ? firstMinimum.width : 0");
    expect(paneLayout).toContain("minWidth: isRow ? secondMinimum.width : 0");
  });

  it("bootstraps the first right split through both menu and drag paths", () => {
    const paneLayout = read("../conversation/pane-layout.tsx");
    expect(paneLayout).toContain("data-pane-layout-surface");
    expect(paneLayout).toContain("canSplitPaneTree({");
    expect(paneLayout).toContain("canSplitAtCurrentSize");
    expect(paneLayout).toContain("handleSplit(paneId, dropZone)");
  });

  it("the conversation pane's max-width matches its pixel ceiling and share cap", () => {
    expect(conversation).toContain(
      `max-w-[min(${CONVERSATION_MAX_PX}px,${pct(CONVERSATION_RATIO_MAX)}%)]`,
    );
  });

  it("the conversation pane's flex-grow reads the ratio var with its fallback", () => {
    // ×100 keeps the two columns' grow sum ≥ 1 so flexbox hands the
    // full remainder to workbench when conversation pane freezes at its 2400px cap.
    expect(conversation).toContain(
      `calc(var(${CONVERSATION_RATIO_VAR},${CONVERSATION_RATIO_DEFAULT})*100)`,
    );
  });

  it("the workbench's min-width matches WORKBENCH_MIN_PX", () => {
    expect(workbench).toContain(`min-w-[${WORKBENCH_MIN_PX}px]`);
  });

  it("the workbench flex-grow complements the conversation ratio", () => {
    expect(workbench).toContain(
      `calc((1_-_var(${CONVERSATION_RATIO_VAR},${CONVERSATION_RATIO_DEFAULT}))*100)`,
    );
  });

  it("paints live drag grow factors directly instead of invalidating an inherited variable", () => {
    expect(conversation).toMatch(/style\.setProperty\(\s*"flex-grow"/);
    expect(conversation).toContain("[data-zeros-column-3]");
    expect(workbench).toContain('data-zeros-column-3=""');
  });

  it("pins hidden retained layers and iframes during seam gestures", () => {
    // The freeze marker (resize-gesture-freeze.ts) must ride the same
    // conditional as `inert` on every retained-deck layer, and sit
    // unconditionally on the browser iframe. Losing one of these silently
    // re-adds a full hidden-subtree relayout to every drag frame; the drag
    // still works, it just gets slower the more content is open — exactly
    // the regression this architecture replaced.
    const chatDeck = read("../conversation/chat-deck.tsx");
    const terminalDeck = read("../conversation/terminal-deck.tsx");
    const terminalTab = read("../workbench/tabs/terminal-tab.tsx");
    const changesTab = read("../workbench/tabs/changes-surface.tsx");
    const browserTab = read("../workbench/tabs/browser-tab.tsx");
    for (const source of [chatDeck, terminalDeck, terminalTab, changesTab]) {
      expect(source).toContain('"data-zeros-resize-freeze": ""');
    }
    expect(workbench).toContain('"data-zeros-resize-freeze": ""');
    expect(browserTab).toContain('data-zeros-resize-freeze=""');
  });

  it("visible surfaces reflow live — the shrink-side width floor is gone", () => {
    // The previous regime floored min-width on the pane bodies, so the
    // shrinking pane clipped its own live content at the moving seam (the
    // composer's send button cut in half, transcript sliding under the
    // workbench). Active content must track the seam; only hidden layers freeze.
    const terminalTab = read("../workbench/tabs/terminal-tab.tsx");
    for (const source of [conversation, workbench, terminalTab]) {
      expect(source).not.toContain("data-zeros-resize-width-lock");
    }
    expect(conversation).not.toContain("lockResizeDescendantWidths");
  });

  it("every seam drag joins the shared continuous-resize gesture", () => {
    // The freeze module and the xterm fit schedulers key off ONE signal; a
    // seam that forgets to begin/finish it re-lays-out hidden decks per
    // frame and lets xterm refit mid-drag.
    for (const seam of [
      "../conversation/conversation-pane.tsx",
      "../conversation/pane-layout.tsx",
      "../terminal/terminal-panel-resizer.tsx",
      "../workbench/tabs/use-sidebar-drag.ts",
      "../use-home-sidebar-drag.ts",
    ]) {
      expect(read(seam)).toContain("beginContinuousLayoutResize()");
    }
    expect(read("../../main.tsx")).toContain("installResizeGestureFreeze()");
  });
});

// ── The workbench expand jerk, guarded ────────────────────────────────────────
// Collapsing workbench and expanding it again used to snap conversation pane down to
// its 360px floor and then ease back out to the saved split (measured:
// 1600 → 360 → 800px). Two independent mistakes combined to produce it, and
// either one alone would bring it back, so both are asserted here.
describe("collapsing the workbench cannot move the conversation pane", () => {
  const conversation = code("../conversation/conversation-pane.tsx");
  const flexDecl = `[flex:calc(var(${CONVERSATION_RATIO_VAR},${CONVERSATION_RATIO_DEFAULT})*100)_1_0px]`;

  it("uses the SAME flex declaration collapsed and expanded", () => {
    // Mistake 1: the collapsed state used `flex-1 basis-auto` (grow 1). The
    // first expanded frame therefore split the panes 1 : ratio·100 — about 2%
    // for conversation pane — before flexbox handed it the intended share back.
    // `basis-auto` also forced a max-content measurement of the whole chat
    // transcript just to size the column.
    const declarations =
      conversation.match(/\[flex:calc\(var\([^\]]*\]/g) ?? [];
    expect(declarations.length).toBe(2);
    expect(new Set(declarations).size).toBe(1);
    expect(declarations[0]).toBe(flexDecl);
    expect(conversation).not.toContain("basis-auto");
  });

  it("lifts only the max-width cap while collapsed", () => {
    // Conversation pane is the sole flex item then, so the 70% share cap would leave a
    // 30% void where workbench used to be.
    expect(conversation).toContain(
      `${flexDecl} min-w-[${CONVERSATION_MIN_PX}px] max-w-none`,
    );
  });

  it("never transitions a flex property", () => {
    // Mistake 2: `transition-[flex-grow] duration-150` turned the overshoot
    // above into a visible 150ms animation, and re-ran it on every launch
    // (see boot-layout-vars.test.ts). Animating a grow factor is not a width
    // animation anyway — grow 1→50 against a fixed 50 is wildly non-linear —
    // and every frame reflows the transcript, workbench, and every xterm.
    expect(conversation).not.toMatch(/transition-\[[^\]]*flex/);
  });
});

// ── The terminal-panel collapse jank, guarded ─────────────────────────────
describe("terminal panel seam geometry stays in lockstep with CSS", () => {
  const terminalTab = code("../workbench/tabs/terminal-tab.tsx");
  const setupTab = code("../workbench/tabs/setup-tab.tsx");
  const terminalSession = code("../terminal/terminal-session-view.tsx");

  it("derives the panel max from the workbench floor plus the seam", () => {
    expect(TERMINAL_PANEL_MAX_OFFSET_PX).toBe(
      WORKBENCH_CONTENT_MIN_PX + TERMINAL_SEAM_PX,
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
    expect(resizer).toMatch(/style\.setProperty\(\s*"flex-basis"/);
    expect(resizer).toContain("terminalPanelFlexBasisForPct(pct)");
  });

  it("keeps padding outside Setup's measured xterm host", () => {
    // FitAddon reads the terminal parent's computed dimensions but subtracts
    // only the terminal element's own padding. With app-wide border-box sizing,
    // parent padding is included and would over-count usable rows/columns.
    expect(setupTab).toContain(
      'className="size-full min-h-0 min-w-0 overflow-hidden"',
    );
    expect(setupTab).not.toMatch(
      /ref=\{hostRef\}[\s\S]{0,160}className=\{cn\([\s\S]{0,160}\b(?:px-|py-|p-)/,
    );
  });

  it("uses the same settled-dimension guard for Setup and shell terminals", () => {
    expect(setupTab).toContain("isUsableTerminalDimensions(proposed)");
    expect(terminalSession).toContain("isUsableTerminalDimensions(proposed)");
  });

  it("keeps reveal redraw and focus behind the continuous-resize gate", () => {
    expect(terminalSession).toContain("createTerminalRevealScheduler");
    expect(terminalSession).toMatch(
      /createTerminalRevealScheduler\(\(\) => \{[\s\S]{0,500}term\.refresh\([\s\S]{0,200}term\.focus\(\)/,
    );
  });
});

describe("files/changes sidebar bounds stay in lockstep with CSS", () => {
  const filesTab = read("../workbench/tabs/files-tab.tsx");
  const changesTab = read("../workbench/tabs/changes-surface.tsx");

  for (const [name, src] of [
    ["files-tab", filesTab],
    ["changes-surface", changesTab],
  ] as const) {
    it(`${name}'s sidebar min-width matches FILES_SIDEBAR_MIN_PX`, () => {
      expect(src).toContain(`min-w-[${FILES_SIDEBAR_MIN_PX}px]`);
    });

    it(`${name}'s sidebar max-width matches FILES_SIDEBAR_MAX_FRACTION`, () => {
      expect(src).toContain(`max-w-[${pct(FILES_SIDEBAR_MAX_FRACTION)}%]`);
    });
  }
});
