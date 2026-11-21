// Render first, then reveal, block by block (text-reveal.ts). The live tail
// answer is laid out in full as text arrives; the box is clipped to the last
// released unit, and each release fades in place (opacity only). An
// in-between message is never revealed: hidden while written, then shown
// whole. A message that is not the live tail keeps none of this, except the
// brief in-place finish after a natural turn end, which always ends in a
// clear.

import { createContext, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { TAIL_GROWTH_EVENT } from "@/renderer/shared/ui/motion/soft-motion";
import {
  CODE_STEP_LINES,
  INTERACTIVE_SELECTOR,
  LINE_STEP_LINES,
  REVEAL_MAX_SOURCE,
  UNDECIDED_STEP_LINES,
  UNIT_FADE_MS,
  afterTail,
  groupLines,
  release,
  releasePending,
  releaseState,
  releaseWaitsOnTime,
  revealCuts,
  revealRole,
  revealUnitElements,
  tailHold,
  tailClosed,
  type Cut,
  type MeasuredUnit,
  type ReleaseState,
  type RevealRole,
  type UnitKind,
} from "./text-reveal";

/** The live feed hears when its tail message is held (written out of sight,
 * nothing shown yet) or shown, so the tail can present as if the message
 * were not there yet and change once, when it appears. */
export const RevealHeldContext = createContext<((id: string, held: boolean | null) => void) | null>(null);

/** A message this young when it first renders reveals from its start;
 * anything older (a remount, a reactivated chat) shows what it has. */
const FRESH_MS = 2_000;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface Fade { from: number; to: number; at: number }

interface RevealState {
  /** Null: not revealing; the message is simply complete. */
  release: ReleaseState | null;
  cuts: Cut[];
  lastKind: UnitKind | null;
  fades: Fade[];
  clip: number | null;
  /** The turn ended naturally: layout is final (no clip); the rest fades in
   * where it already is. */
  inPlace: boolean;
  /** Something has been shown: a phase-less message is the answer. */
  shownAny: boolean;
  source: string;
  started: boolean;
  frame: number;
  width: number;
  /** As of the last render: frames scheduled earlier read these. */
  live: boolean;
  role: RevealRole;
  /** Watches layout while a reveal runs (only then: settled and hidden
   * messages are never observed or measured). */
  watch?: { root: HTMLElement; observer?: ResizeObserver; onLoad: (event: Event) => void } | undefined;
  /** Units and the boundary the accessibility pass last ran for. */
  units: { el: Element; bottom: number }[];
  inertFor: number;
  /** Told whether the message is held, on every change; null on unmount. */
  onHeld?: (held: boolean | null) => void;
  held?: boolean;
}

/** Tell the feed when the message starts or stops being held. */
function reportHeld(root: HTMLElement, state: RevealState): void {
  const held = root.dataset.revealHeld !== undefined;
  if (state.held === held) return;
  state.held = held;
  state.onHeld?.(held);
}

function motionAllowed(root: Element, active: boolean, source: string): boolean {
  return active && document.visibilityState !== "hidden" && source.length <= REVEAL_MAX_SOURCE &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    // Comparison only (harnesses): show text as it arrives, unrevealed.
    !root.closest('[data-text-reveal="off"]');
}

/** Drop every trace of a reveal: the message is simply complete. */
function clearReveal(root: HTMLElement, state: RevealState): void {
  cancelAnimationFrame(state.frame);
  state.frame = 0;
  state.release = null;
  state.cuts = [];
  state.fades = [];
  state.clip = null;
  state.inPlace = false;
  state.units = [];
  state.inertFor = NaN;
  unwatch(state);
  if (root.dataset.revealing === undefined) return;
  delete root.dataset.revealing;
  delete root.dataset.revealHeld;
  root.style.removeProperty("max-height");
  root.style.removeProperty("--reveal-mask");
  for (const el of root.querySelectorAll<HTMLElement>("[data-reveal-inert]")) {
    el.inert = false;
    delete el.dataset.revealInert;
  }
}

/** The units' places: the last one with its line boxes when it may grow. */
function measure(root: HTMLElement, state: RevealState, complete: boolean): void {
  const top = root.getBoundingClientRect().top;
  const elements = revealUnitElements(root);
  const lastComplete = complete || tailClosed(state.source);
  const hold = lastComplete ? { block: false, opener: null } : tailHold(state.source);
  let holdTop = Infinity;
  const units: MeasuredUnit[] = elements.map(({ el, kind }, index) => {
    const unit: MeasuredUnit = { kind, bottom: el.getBoundingClientRect().bottom - top };
    if (index < elements.length - 1 || lastComplete || kind === "block" || kind === "row" ||
        (kind === "text" && hold.block)) return unit;
    const body = kind === "code" ? el.querySelector("code") ?? el.querySelector("pre") ?? el : el;
    const range = document.createRange();
    range.selectNodeContents(body);
    unit.lines = groupLines([...range.getClientRects()].map((rect) => ({ top: rect.top - top, bottom: rect.bottom - top })));
    // A line holding an unclosed opener may still change: hold from it.
    if (kind === "text" && hold.opener) holdTop = openerTop(el, hold.opener, top);
    return unit;
  });
  state.lastKind = elements.at(-1)?.kind ?? null;
  state.cuts = revealCuts(units, lastComplete, holdTop);
  state.units = elements.map(({ el }, index) => ({ el, bottom: units[index].bottom }));
  state.inertFor = NaN;
}

/** The top of the line where the last unclosed `opener` renders literally. */
function openerTop(el: Element, opener: string, top: number): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let found: { node: Text; at: number } | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.lastIndexOf(opener);
    if (at >= 0) found = { node, at };
  }
  if (!found) return Infinity;
  const range = document.createRange();
  range.setStart(found.node, found.at);
  range.setEnd(found.node, Math.min(found.node.length, found.at + opener.length));
  return range.getBoundingClientRect().top - top;
}

const px = (value: number) => `${value.toFixed(1)}px`;
const alpha = (value: number, at: number) => `color-mix(in srgb, black ${(value * 100).toFixed(1)}%, transparent) ${px(at)}`;

/** Clip to what is shown (unless finishing in place), fade what was just
 * released, and keep anything not shown out of reach. Returns whether a
 * release is still fading. */
function paint(root: HTMLElement, state: RevealState, now: number, held: boolean): boolean {
  const shownY = state.release!.shownY;
  state.fades = state.fades.filter((fade) => now - fade.at < UNIT_FADE_MS);
  root.dataset.revealing = "";
  if (held) root.dataset.revealHeld = "";
  else delete root.dataset.revealHeld;
  if (state.fades.length || state.inPlace) {
    // Alpha masks, not UI colors: black supplies opaque coverage.
    const stops = ["black 0px"];
    for (const fade of [...state.fades].sort((a, b) => a.from - b.from)) {
      const value = Math.max(0, Math.min(1, (now - fade.at) / UNIT_FADE_MS));
      stops.push(`black ${px(fade.from)}`, alpha(value, fade.from), alpha(value, fade.to), `black ${px(fade.to)}`);
    }
    stops.push(`black ${px(shownY)}`, `transparent ${px(shownY)}`);
    root.style.setProperty("--reveal-mask", `linear-gradient(to bottom, ${stops.join(", ")})`);
  } else root.style.removeProperty("--reveal-mask");
  const clip = state.inPlace ? null : Math.ceil(shownY);
  if (clip === null) {
    if (state.clip !== null) root.style.removeProperty("max-height");
    state.clip = null;
  } else if (clip !== state.clip) {
    const grew = clip > (state.clip ?? 0);
    state.clip = clip;
    root.style.maxHeight = px(clip);
    // The message grew by a unit: the agent's growth at the tail (it may settle).
    if (grew) root.dispatchEvent(new Event(TAIL_GROWTH_EVENT, { bubbles: true }));
  }
  if (state.inertFor !== shownY) {
    state.inertFor = shownY;
    // Nothing not yet shown is reachable, by pointer, keyboard or assistive
    // technology: a unit not wholly released is inert (out of the
    // accessibility tree, not focusable, not hittable). A paragraph released
    // in line steps stays inert until it completes, so a screen reader reads
    // it whole, once, rather than lines that are still being written.
    // Interactive elements and table header rows below the shown part too.
    const setInert = (el: HTMLElement, hidden: boolean) => {
      if (hidden === (el.dataset.revealInert !== undefined)) return;
      el.inert = hidden;
      if (hidden) el.dataset.revealInert = "";
      else delete el.dataset.revealInert;
    };
    for (const { el, bottom } of state.units) if (el instanceof HTMLElement) setInert(el, bottom > shownY + 0.5);
    const top = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll<HTMLElement>(`${INTERACTIVE_SELECTOR}, thead tr`))
      if (!state.units.some((unit) => unit.el.contains(el))) setInert(el, el.getBoundingClientRect().top - top >= shownY - 0.5);
  }
  return state.fades.length > 0;
}

/** Re-measure after the layout changed under a running reveal (a width
 * change reflows the lines; an image loads and grows its unit). What was
 * shown stays shown, at once, without a fade. */
function remap(root: HTMLElement, state: RevealState): void {
  if (!state.release || state.release.shownY <= 0) return;
  const shown = state.cuts.filter((cut) => cut.y <= state.release!.shownY + 0.5).length;
  measure(root, state, state.inPlace);
  state.release.shownY = Math.max(state.release.shownY, state.cuts[shown - 1]?.y ?? 0);
  state.fades = [];
  paint(root, state, performance.now(), root.dataset.revealHeld !== undefined);
}

/** Watch layout while a reveal runs, and only then. */
function watch(root: HTMLElement, state: RevealState): void {
  if (state.watch) return;
  const onLoad = () => remap(root, state);
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
    if (!state.release) return;
    const width = root.getBoundingClientRect().width;
    if (Math.abs(width - state.width) < 0.5) return;
    state.width = width;
    remap(root, state);
  });
  observer?.observe(root);
  // Image loads do not bubble: listen in the capture phase.
  root.addEventListener("load", onLoad, true);
  state.watch = { root, observer, onLoad };
}

function unwatch(state: RevealState): void {
  if (!state.watch) return;
  state.watch.observer?.disconnect();
  state.watch.root.removeEventListener("load", state.watch.onLoad, true);
  state.watch = undefined;
}

/** Release what may go now, paint, and keep frames running while anything
 * waits or fades. A message no longer live ends in a clear. */
function tick(root: HTMLElement, state: RevealState, now: number): void {
  const { live, role } = state;
  const rel = state.release!;
  const before = rel.shownY;
  const undecided = role === "undecided" && !state.shownAny && live;
  const pacing = undecided
    ? { stepLines: UNDECIDED_STEP_LINES, lineWaitMs: Infinity }
    : { stepLines: state.lastKind === "code" ? CODE_STEP_LINES : LINE_STEP_LINES };
  release(rel, state.cuts, now, pacing);
  if (rel.shownY > before) {
    if (!state.shownAny) {
      // The first release puts the row back in flow, where its lines are
      // measured again: the same units, at their in-flow places.
      const count = state.cuts.filter((cut) => cut.y <= rel.shownY + 0.5).length;
      delete root.dataset.revealHeld;
      measure(root, state, !live);
      rel.shownY = state.cuts[count - 1]?.y ?? rel.shownY;
    }
    state.fades.push({ from: before, to: rel.shownY, at: now });
    state.shownAny = true;
  }
  const fading = paint(root, state, now, !state.shownAny);
  const pending = releasePending(rel, state.cuts);
  if (!live && !pending && !fading) {
    clearReveal(root, state);
    reportHeld(root, state);
    return;
  }
  reportHeld(root, state);
  // Frames run only while time can change something: a fade, or a release
  // that waits on its stagger or line wait. Lines that need more text wait
  // for the next render (new text or a lifecycle change).
  if ((fading || (pending && releaseWaitsOnTime(rel, state.cuts, pacing))) && !state.frame) {
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      // The same clock the fades started on (a frame's timestamp can be
      // earlier than a render that ran during that frame).
      const at = performance.now();
      if (!state.release) return;
      if (!motionAllowed(root, true, state.source)) {
        clearReveal(root, state);
        reportHeld(root, state);
        return;
      }
      tick(root, state, at);
    });
  }
}

/** Reveal the live tail message (`live`) unit by unit; show everything
 * otherwise.
 * - `phase`: the provider's word on what the text is (`commentary`: an
 *   in-between message; `final_answer`/`partial_answer`: output). Without
 *   one, a message is held until its first unit completes: completed by the
 *   next unit, it is the answer; by a tool call, an in-between message.
 * - `endedNaturally`: the turn just ended because the agent finished
 *   (turn-end.ts): the layout is final at once and the rest fades in place.
 *   Any other end, or more work after it, shows the message complete at once. */
export function useTextReveal(rootRef: RefObject<HTMLElement>, { source, live, turnLive, endedNaturally = false, active, createdAt, phase, onHeld }: {
  source: string;
  live: boolean;
  turnLive: boolean;
  endedNaturally?: boolean;
  active: boolean;
  createdAt: number;
  phase?: string | null;
  onHeld?: (held: boolean | null) => void;
}): void {
  const stateRef = useRef<RevealState>({
    release: null, cuts: [], lastKind: null, fades: [], clip: null, inPlace: false,
    shownAny: false, source: "", started: false, frame: 0, width: 0, live: false, role: "undecided",
    units: [], inertFor: NaN,
  });

  useBrowserLayoutEffect(() => {
    const root = rootRef.current;
    const state = stateRef.current;
    if (!root) return;
    state.onHeld = onHeld;
    update(root, state);
    reportHeld(root, state);
  });

  /** One render's worth of reveal: the decisions above, then a paint. */
  function update(root: HTMLElement, state: RevealState): void {
    const role = revealRole(phase, state.shownAny);
    if (!motionAllowed(root, active, source)) {
      // Hidden, reduced motion, oversized: complete, as text arrives.
      clearReveal(root, state);
      if (live) state.started = true;
      return;
    }
    if (!live) {
      if (afterTail({ role, revealing: state.release !== null, turnLive, endedNaturally }) === "complete") {
        clearReveal(root, state);
        return;
      }
      state.inPlace = true;
    }
    const corrected = state.release !== null && !source.startsWith(state.source);
    state.source = source;
    const now = performance.now();
    state.width = root.getBoundingClientRect().width;
    if (role === "between") {
      // Written out of sight; shown whole once the next event arrives.
      state.release ??= releaseState(0);
      state.started = true;
      state.cuts = [];
      paint(root, state, now, true);
      return;
    }
    measure(root, state, !live);
    if (!state.release) {
      const fresh = !state.started && Date.now() - createdAt < FRESH_MS;
      state.started = true;
      // Not fresh (a remount, a reactivated chat): show what it has complete,
      // as it was shown before.
      state.release = releaseState(fresh ? 0 : state.cuts.at(-1)?.y ?? 0);
      state.shownAny = state.release.shownY > 0;
    }
    if (corrected) {
      // A correction: show what is there now, at once (a held draft too).
      state.release.shownY = Math.max(state.release.shownY, root.scrollHeight);
      state.shownAny = state.release.shownY > 0;
      state.fades = [];
    }
    watch(root, state);
    state.live = live;
    state.role = role;
    tick(root, state, now);
  }

  // A hidden tab or a reduced-motion switch completes the message at once.
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => {
      const root = rootRef.current;
      if (root && stateRef.current.release && !motionAllowed(root, active, stateRef.current.source)) {
        clearReveal(root, stateRef.current);
        reportHeld(root, stateRef.current);
      }
    };
    document.addEventListener("visibilitychange", changed);
    media.addEventListener("change", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      media.removeEventListener("change", changed);
    };
  }, [rootRef, active]);

  useEffect(() => () => {
    cancelAnimationFrame(stateRef.current.frame);
    stateRef.current.frame = 0;
    unwatch(stateRef.current);
    // Gone: the feed forgets what it heard (a remount reports afresh).
    stateRef.current.onHeld?.(null);
    stateRef.current.held = undefined;
  }, []);
}
