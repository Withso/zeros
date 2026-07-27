import { describe, expect, it } from "vitest";

import {
  isTerminalPanelDoubleClick,
  terminalPanelPctForPointer,
} from "../terminal-panel-resizer";

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

  it("preserves the 140px row-2 and 180px row-1 floors", () => {
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
