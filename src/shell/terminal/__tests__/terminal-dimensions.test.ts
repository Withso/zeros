import { describe, expect, it } from "vitest";

import {
  MIN_REAL_TERMINAL_COLS,
  MIN_REAL_TERMINAL_ROWS,
  isUsableTerminalDimensions,
} from "../terminal-dimensions";

describe("terminal dimension validation", () => {
  it("rejects transient 2x1 grids and accepts the shared settled floor", () => {
    expect(isUsableTerminalDimensions({ cols: 2, rows: 1 })).toBe(false);
    expect(
      isUsableTerminalDimensions({
        cols: MIN_REAL_TERMINAL_COLS - 1,
        rows: MIN_REAL_TERMINAL_ROWS,
      }),
    ).toBe(false);
    expect(
      isUsableTerminalDimensions({
        cols: MIN_REAL_TERMINAL_COLS,
        rows: MIN_REAL_TERMINAL_ROWS - 1,
      }),
    ).toBe(false);
    expect(
      isUsableTerminalDimensions({
        cols: MIN_REAL_TERMINAL_COLS,
        rows: MIN_REAL_TERMINAL_ROWS,
      }),
    ).toBe(true);
  });

  it("rejects missing and non-finite proposals", () => {
    expect(isUsableTerminalDimensions(undefined)).toBe(false);
    expect(isUsableTerminalDimensions({ cols: Number.NaN, rows: 24 })).toBe(
      false,
    );
    expect(
      isUsableTerminalDimensions({ cols: 80, rows: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });
});
