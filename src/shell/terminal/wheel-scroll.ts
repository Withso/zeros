// ──────────────────────────────────────────────────────────
// Wheel → scrollback lines, for the terminal's capture-phase wheel handler
// ──────────────────────────────────────────────────────────
//
// TerminalSessionView intercepts `wheel` in the CAPTURE phase (see its handler)
// because TUIs that enable mouse tracking — vim, tmux, claude-code, codex —
// consume the event before xterm's own viewport listener runs, which would
// otherwise make scrollback unreachable while an agent is working. Intercepting
// means we OWN the whole gesture, including the parts xterm used to handle:
//
//   • deltaMode. A wheel event measures in pixels, lines or pages depending on
//     the device and browser. Treating a `DOM_DELTA_LINE` delta of 3 as "3px"
//     silently reduced a mouse notch to a third of a line.
//   • sub-line residue. A macOS trackpad emits a stream of small pixel deltas
//     (often 1–8px). Rounding each one independently floored them all to zero,
//     so slow two-finger scrolling did NOTHING — and because the handler still
//     called preventDefault(), the native viewport couldn't save it either.
//     The residue has to persist ACROSS events, which is why this is a class.
//
// Pure + framework-free so the arithmetic is unit-testable without a DOM.
// ──────────────────────────────────────────────────────────

/** WheelEvent.deltaMode values (mirrored so this module needs no DOM lib). */
export const DELTA_MODE_PIXEL = 0;
export const DELTA_MODE_LINE = 1;
export const DELTA_MODE_PAGE = 2;

/** Approximate terminal row height in CSS pixels. Only used to convert PIXEL
 *  deltas; xterm's own viewport uses the real measured cell height, but it is
 *  not exposed on the public API, and being a few px off just changes gesture
 *  gain slightly — the residue accumulator keeps it smooth either way. */
const PIXELS_PER_LINE = 18;

export interface WheelDelta {
  deltaY: number;
  deltaMode: number;
}

/** Turns a stream of wheel events into whole scrollback lines, carrying the
 *  fractional remainder between calls so no gesture is silently dropped. */
export class WheelLineAccumulator {
  private residue = 0;

  constructor(
    private readonly pixelsPerLine: number = PIXELS_PER_LINE,
    /** Rows per PAGE delta. Callers pass the live viewport height so a
     *  page-mode wheel scrolls exactly one screen. */
    private readonly rowsPerPage: number = 24,
  ) {}

  /** Whole lines to scroll for this event (negative = up). Zero means the
   *  gesture is still sub-line: nothing to scroll YET, but the remainder is
   *  banked, so the caller should still consume the event rather than let a
   *  second accumulator (xterm's viewport) double-count the same gesture. */
  lines(evt: WheelDelta, rowsPerPage = this.rowsPerPage): number {
    const raw = this.toLines(evt, rowsPerPage);
    if (!Number.isFinite(raw)) return 0;
    // Reset on a DECISIVE direction change — a whole line or more the other way
    // — so a reversed flick responds immediately instead of first paying off
    // residue built up in the old direction.
    //
    // The `>= 1` is the load-bearing part. Resetting on ANY sign flip reproduced
    // the exact bug this class exists to fix: a real trackpad gesture is not
    // monotonic, and a hesitant slow drag arrives as `+4, -1, +4, -1, …`. Each
    // tiny reversal threw away the bank, so 60px of finger travel scrolled ZERO
    // lines — while the handler still called preventDefault(), so xterm's own
    // viewport (which does survive jitter) couldn't rescue it either. Residue is
    // bounded to (-1, 1), so the worst this costs a genuine reversal is one row.
    if (Math.abs(raw) >= 1 && Math.sign(raw) !== Math.sign(this.residue)) {
      this.residue = 0;
    }
    const total = this.residue + raw;
    const whole = Math.trunc(total);
    this.residue = total - whole;
    return whole || 0; // normalize -0, which reads oddly at call sites
  }

  private toLines(evt: WheelDelta, rowsPerPage: number): number {
    switch (evt.deltaMode) {
      case DELTA_MODE_LINE:
        return evt.deltaY;
      case DELTA_MODE_PAGE:
        return evt.deltaY * Math.max(1, rowsPerPage);
      case DELTA_MODE_PIXEL:
      default:
        return evt.deltaY / this.pixelsPerLine;
    }
  }

  /** Drop pending residue. Called when the gesture stops being ours — at a
   *  scrollback boundary, where the event is released to an outer scroller.
   *  Not wired to session attach / pane hide on purpose: residue is bounded to
   *  under one line, so a stale fraction is at most one row of slack on the next
   *  gesture, which is not worth an extra effect dependency. */
  reset(): void {
    this.residue = 0;
  }
}
