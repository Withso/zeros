// ──────────────────────────────────────────────────────────
// Settled xterm dimensions
// ──────────────────────────────────────────────────────────

/** Smaller proposals are transient flex/collapse measurements that would
 * destructively reflow scrollback into a nearly unusable grid. */
export const MIN_REAL_TERMINAL_COLS = 4;
export const MIN_REAL_TERMINAL_ROWS = 2;

interface TerminalDimensions {
  cols: number;
  rows: number;
}

/** Whether a FitAddon proposal is finite and large enough to represent a
 * settled terminal host rather than an intermediate layout frame. */
export function isUsableTerminalDimensions(
  proposed: TerminalDimensions | undefined,
): proposed is TerminalDimensions {
  return Boolean(
    proposed &&
    Number.isFinite(proposed.cols) &&
    Number.isFinite(proposed.rows) &&
    proposed.cols >= MIN_REAL_TERMINAL_COLS &&
    proposed.rows >= MIN_REAL_TERMINAL_ROWS,
  );
}
