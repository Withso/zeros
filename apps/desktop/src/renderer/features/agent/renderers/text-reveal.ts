// Render first, then reveal, block by block: a streaming answer is laid out as
// markdown as soon as text arrives and shown one completed unit at a time
// (a paragraph, heading, list item, table row, code block, image). A long
// block releases its completed lines in steps. Nothing inside an unfinished
// unit is shown, so partial markdown never is. This module is the pure part:
// segmentation, completion, release pacing and classification.

/** Messages longer than this show at once. */
export const REVEAL_MAX_SOURCE = 32_768;
/** A released unit fades in over this long: opacity only, in place. */
export const UNIT_FADE_MS = 220;
/** Units that complete together release this far apart, in order. */
export const UNIT_STAGGER_MS = 100;
/** The display never trails a completed unit by more than this: beyond it,
 * everything waiting is released together. */
export const REVEAL_LAG_CAP_MS = 1_200;
/** A growing paragraph or list item releases its completed lines once this
 * many wait, or once the oldest has waited LINE_STEP_WAIT_MS. */
export const LINE_STEP_LINES = 2;
/** The same for a code block still being written. */
export const CODE_STEP_LINES = 4;
export const LINE_STEP_WAIT_MS = 1_000;
/** Before a phase-less message has shown anything, a growing first paragraph
 * waits for this many complete lines: an in-between message rarely has more. */
export const UNDECIDED_STEP_LINES = 3;

// ── Units ───────────────────────────────────────────────

/** Blocks shown whole. A code block may release its lines in steps. */
const ATOMIC = "pre, .zeros-md-codeblock, img, svg, hr, video, iframe, .katex-display, [data-reveal-unit]";
const CODE = "pre, .zeros-md-codeblock";
const TEXT_BLOCK = "p, h1, h2, h3, h4, h5, h6, li, dt, dd";
/** Block children that split a text block into several units. Inline media
 * (an image with its caption) stays in its paragraph's unit. */
const NESTED = `${TEXT_BLOCK}, pre, .zeros-md-codeblock, hr, video, iframe, .katex-display, [data-reveal-unit], tr, blockquote`;
export const INTERACTIVE_SELECTOR = "a[href], button, input, select, textarea, summary, [tabindex]";

export type UnitKind = "text" | "code" | "block" | "row";
export interface UnitElement { el: Element; kind: UnitKind }

/** The top-level reveal units of rendered markdown, in document order.
 * Header rows are not units of their own: they show with the first body row.
 * A list item holding a nested list is split at its nested items; its own
 * leading text shows with the first of them. */
export function revealUnitElements(root: Element): UnitElement[] {
  const units: UnitElement[] = [];
  const visit = (el: Element) => {
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (child.matches(ATOMIC)) units.push({ el: child, kind: child.matches(CODE) ? "code" : "block" });
      else if (child.matches("tr")) {
        if (!child.closest("thead")) units.push({ el: child, kind: "row" });
      } else if (child.matches(TEXT_BLOCK) && !child.querySelector(NESTED)) units.push({ el: child, kind: "text" });
      else visit(child);
    }
  };
  visit(root);
  return units;
}

/** Code fences in one pass (CommonMark): an opener is 3+ backticks or
 * tildes indented at most 3 spaces; its closer uses the same marker, at
 * least as long, with nothing after it but spaces. Whether a fence is still
 * open at the end, and whether the last non-blank line closed one. */
function fenceState(source: string): { open: boolean; closedLast: boolean } {
  let open: { marker: string; length: number } | null = null;
  let closedLast = false;
  for (let start = 0; start <= source.length;) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const line = source.slice(start, end);
    if (line.trim()) closedLast = false;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const run = fence[1];
      const rest = line.slice(fence[0].length);
      if (!open) {
        // A backtick fence's info string cannot hold a backtick.
        if (run[0] === "~" || !rest.includes("`")) open = { marker: run[0], length: run.length };
      } else if (run[0] === open.marker && run.length >= open.length && !rest.trim()) {
        open = null;
        closedLast = true;
      }
    }
    start = end + 1;
  }
  return { open: open !== null, closedLast };
}

/** Whether the trailing whitespace holds a blank line (two line breaks with
 * only spaces or tabs between them). One backward scan. */
function endsWithBlankLine(source: string): boolean {
  let from = source.length;
  while (from > 0 && /\s/.test(source[from - 1])) from--;
  let afterBreak = false;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === "\n") {
      if (afterBreak) return true;
      afterBreak = true;
    } else if (char !== " " && char !== "\t" && char !== "\r") afterBreak = false;
  }
  return false;
}

/** Whether the source's last block is finished: closed by a blank line, or a
 * code fence just closed. Any other last unit may still grow. */
export function tailClosed(source: string): boolean {
  const fences = fenceState(source);
  if (fences.open) return false;
  return endsWithBlankLine(source) || fences.closedLast;
}

/** Inline openers that, unclosed at the tail, render literally and later
 * resolve: a line holding one may still change. */
const INLINE_OPENERS = ["**", "__", "~~", "`", "["] as const;

/** What the tail of a still-streaming source asks the reveal to hold back.
 * - `block`: the last block may still change kind (an open code fence, a
 *   table being typed, a line that may become a heading or list item, a
 *   setext underline).
 * - `opener`: the earliest unclosed inline opener of the last paragraph. */
export interface TailHold {
  block: boolean;
  opener: string | null;
}

export function tailHold(source: string): TailHold {
  const lastLine = source.slice(source.lastIndexOf("\n") + 1);
  const firstLine = source.slice(source.lastIndexOf("\n\n") + 2).split("\n")[0];
  const block = fenceState(source).open || /^ {0,3}\|/.test(firstLine) || /^ {0,3}\|/.test(lastLine) ||
    /^ {0,3}(#{1,6}|>|[-*+]|\d+[.)])?\s*$/.test(lastLine) && lastLine.trim().length > 0 ||
    /^ {0,3}(=+|-+)\s*$/.test(lastLine);
  const paragraph = source.slice(source.lastIndexOf("\n\n") + 1);
  let opener: string | null = null;
  let earliest = Infinity;
  for (const marker of INLINE_OPENERS) {
    const index = unclosedAt(paragraph, marker);
    if (index >= 0 && index < earliest) {
      earliest = index;
      opener = marker;
    }
  }
  return { block, opener };
}

/** Index of an unclosed `marker` in `text`, or -1. */
function unclosedAt(text: string, marker: string): number {
  if (marker === "[") {
    // A link or reference still being typed: "[text" or "[text](url".
    const open = text.lastIndexOf("[");
    if (open < 0) return -1;
    const rest = text.slice(open);
    // A target still being typed: the last "](" has no ")" after it.
    const target = rest.lastIndexOf("](");
    const unfinishedTarget = target >= 0 && rest.indexOf(")", target) < 0;
    return /^\[[^\]]*\](\([^)]*\))?(?!\()/.test(rest) && !unfinishedTarget ? -1 : open;
  }
  let count = 0;
  let first = -1;
  for (let index = text.indexOf(marker); index >= 0; index = text.indexOf(marker, index + marker.length)) {
    if (marker === "`" && text.startsWith("``", index)) {
      index += 1;
      continue;
    }
    if (count % 2 === 0) first = index;
    count++;
  }
  return count % 2 === 1 ? first : -1;
}

// ── Lines and cuts ──────────────────────────────────────

export interface Band { top: number; bottom: number }

/** Group the client rects of a block's text into its line boxes. */
export function groupLines(rects: readonly Band[]): Band[] {
  const lines: Band[] = [];
  for (const rect of [...rects].filter((r) => r.bottom > r.top).sort((a, b) => a.top - b.top)) {
    const line = lines.at(-1);
    const overlap = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0;
    if (line && overlap > Math.min(line.bottom - line.top, rect.bottom - rect.top) / 2) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else lines.push({ top: rect.top, bottom: rect.bottom });
  }
  return lines;
}

/** A place the message may be shown down to. `unit` cuts close a completed
 * unit; `line` cuts close a completed line of the unit still growing. */
export interface Cut { y: number; kind: "unit" | "line" }

export interface MeasuredUnit {
  kind: UnitKind;
  bottom: number;
  /** Line boxes, for the last unit when it may release lines. */
  lines?: Band[];
}

/** Where the message may be shown down to, in order. Every unit but the last
 * is complete; the last one is when `lastComplete`. A last unit still growing
 * offers its completed lines (all but its last, and only above `holdTop`). */
export function revealCuts(units: readonly MeasuredUnit[], lastComplete: boolean, holdTop = Infinity): Cut[] {
  const cuts: Cut[] = [];
  units.forEach((unit, index) => {
    if (index < units.length - 1 || lastComplete) {
      cuts.push({ y: unit.bottom, kind: "unit" });
      return;
    }
    const lines = unit.lines ?? [];
    for (let line = 0; line < lines.length - 1; line++) {
      if (lines[line].bottom > holdTop) break;
      // Between this line and the next: the line keeps its own leading.
      cuts.push({ y: (lines[line].bottom + lines[line + 1].top) / 2, kind: "line" });
    }
  });
  return cuts;
}

// ── Release pacing ──────────────────────────────────────

export interface ReleaseState {
  /** Shown down to here. */
  shownY: number;
  lastReleaseAt: number;
  /** When each waiting cut (by rounded y) became available. */
  readyAt: Map<number, number>;
}

export function releaseState(shownY = 0): ReleaseState {
  return { shownY, lastReleaseAt: -Infinity, readyAt: new Map() };
}

/** Advance what is shown. Completed units release one at a time, a stagger
 * apart, in order; a run of completed lines releases as one step once
 * `stepLines` wait or the oldest has waited `lineWaitMs`. Nothing that
 * is ready waits longer than REVEAL_LAG_CAP_MS: then everything ready shows
 * together. Returns the new shown y (the state is updated). */
export function release(state: ReleaseState, cuts: readonly Cut[], now: number,
  { stepLines = LINE_STEP_LINES, lineWaitMs = LINE_STEP_WAIT_MS }: { stepLines?: number; lineWaitMs?: number } = {}): number {
  const waiting = cuts.filter((cut) => cut.y > state.shownY + 0.5);
  for (const cut of waiting) {
    const key = Math.round(cut.y);
    if (!state.readyAt.has(key)) state.readyAt.set(key, now);
  }
  for (const key of state.readyAt.keys()) if (key <= state.shownY + 0.5) state.readyAt.delete(key);
  const units = waiting.filter((cut) => cut.kind === "unit");
  const lines = waiting.filter((cut) => cut.kind === "line");
  const since = (cut: Cut) => now - (state.readyAt.get(Math.round(cut.y)) ?? now);
  // A run of lines counts as one step when it may go.
  const steps = [...units];
  if (lines.length && (lines.length >= stepLines || since(lines[0]) >= lineWaitMs)) steps.push(lines.at(-1)!);
  if (!steps.length) return state.shownY;
  let to: Cut | undefined;
  if (since(steps[0]) >= REVEAL_LAG_CAP_MS) to = steps.at(-1);
  else if (now - state.lastReleaseAt >= UNIT_STAGGER_MS) to = steps[0];
  if (!to) return state.shownY;
  state.shownY = to.y;
  state.lastReleaseAt = now;
  for (const key of state.readyAt.keys()) if (key <= state.shownY + 0.5) state.readyAt.delete(key);
  return state.shownY;
}

/** Whether time alone can release something: a completed unit (it may only
 * wait out the stagger), or lines that are enough already or may go after
 * their wait. Lines that need more of their paragraph wait on new text, so
 * no frame needs to run for them. */
export function releaseWaitsOnTime(state: ReleaseState, cuts: readonly Cut[],
  { stepLines = LINE_STEP_LINES, lineWaitMs = LINE_STEP_WAIT_MS }: { stepLines?: number; lineWaitMs?: number } = {}): boolean {
  const waiting = cuts.filter((cut) => cut.y > state.shownY + 0.5);
  if (waiting.some((cut) => cut.kind === "unit")) return true;
  const lines = waiting.length;
  return lines > 0 && (lines >= stepLines || Number.isFinite(lineWaitMs));
}

/** Whether a later frame could release more. */
export function releasePending(state: ReleaseState, cuts: readonly Cut[]): boolean {
  return cuts.some((cut) => cut.y > state.shownY + 0.5);
}

// ── Classification ──────────────────────────────────────

/** How an agent message shows while its turn is live.
 * - `between`: an in-between message. Never revealed: hidden while it is
 *   still being written, then shown whole, at once.
 * - `output`: the answer. Revealed unit by unit.
 * - `undecided`: phase-less; held until its first unit completes. */
export type RevealRole = "between" | "output" | "undecided";

export function revealRole(phase: string | null | undefined, shownAny: boolean): RevealRole {
  if (phase === "commentary") return "between";
  if (phase === "final_answer" || phase === "partial_answer" || shownAny) return "output";
  return "undecided";
}

/** What a message does once it is no longer the live tail. More work after
 * it (a tool call completed it), a stop, a failure or an unknown end: it is
 * complete at once, so a phase-less message nothing of which was shown
 * appears whole, as an in-between message. A natural turn end finishes a
 * revealing answer in place. */
export function afterTail({ role, revealing, turnLive, endedNaturally }: {
  role: RevealRole;
  revealing: boolean;
  turnLive: boolean;
  endedNaturally: boolean;
}): "complete" | "finish-in-place" {
  return !turnLive && endedNaturally && revealing && role !== "between" ? "finish-in-place" : "complete";
}
