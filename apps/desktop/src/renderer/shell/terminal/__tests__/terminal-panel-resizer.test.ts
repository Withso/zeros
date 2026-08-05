import { describe, expect, it } from "vitest";

import {
  isTerminalPanelDoubleClick,
  terminalPanelFlexBasisForPct,
  terminalPanelPctForPointer,
} from "../terminal-panel-resizer";
import {
  TERMINAL_PANEL_MAX_OFFSET_PX,
  TERMINAL_PANEL_MIN_PX,
} from "../terminal-panel-layout";

describe("terminal-panel resizer geometry", () => {
  it("maps the centered seam to an even split", () => {
    expect(
      terminalPanelPctForPointer({
        containerHeight: 1000,
        containerBottom: 1000,
        clientY: 500,
      }),
    ).toBe(50);
  });

  it("preserves the 140px terminal panel and 180px workbench floors", () => {
    expect(
      terminalPanelPctForPointer({
        containerHeight: 1000,
        containerBottom: 1000,
        clientY: 999,
      }),
    ).toBeCloseTo(14);
    expect(
      terminalPanelPctForPointer({
        containerHeight: 1000,
        containerBottom: 1000,
        clientY: 0,
      }),
    ).toBeCloseTo(81.9);
  });

  it("falls back safely when geometry is unavailable", () => {
    expect(
      terminalPanelPctForPointer({
        containerHeight: 0,
        containerBottom: 0,
        clientY: 0,
      }),
    ).toBe(50);
  });

  it("keeps live drag geometry behind the same CSS pixel-floor clamp", () => {
    expect(terminalPanelFlexBasisForPct(62.5)).toBe(
      `clamp(${TERMINAL_PANEL_MIN_PX}px, 62.5%, calc(100% - ${TERMINAL_PANEL_MAX_OFFSET_PX}px))`,
    );
  });
});

describe("terminal-panel double-click detector", () => {
  it("accepts a quick second press at the same seam position", () => {
    expect(
      isTerminalPanelDoubleClick({ at: 1_000, y: 400 }, { at: 1_250, y: 404 }),
    ).toBe(true);
  });

  it("rejects late, distant, and out-of-order presses", () => {
    expect(
      isTerminalPanelDoubleClick({ at: 1_000, y: 400 }, { at: 1_400, y: 400 }),
    ).toBe(false);
    expect(
      isTerminalPanelDoubleClick({ at: 1_000, y: 400 }, { at: 1_100, y: 406 }),
    ).toBe(false);
    expect(
      isTerminalPanelDoubleClick({ at: 1_000, y: 400 }, { at: 900, y: 400 }),
    ).toBe(false);
  });
});
