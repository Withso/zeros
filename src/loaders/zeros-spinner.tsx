// ──────────────────────────────────────────────────────────
// ZerosSpinner — the "Orbit" + "Agent" shimmers
// (dot-matrix tetromino motion over a fading dot grid)
// ──────────────────────────────────────────────────────────
//
// A 4×4 dot-matrix with two layers in every cell:
//
//   • ACTIVE PIECE — a Tetris piece (4 dots) morphs shape to shape. Only
//     the active piece is lit, in the tone's active color (--loader-active
//     → --fg2 by default; see TONE_COLORS). The walk is CHOREOGRAPHED
//     per variant (see VARIANTS below):
//       – orbit: the piece's centroid glides clockwise around the board —
//         top edge → right → bottom → left → loop (12 stops).
//       – agent: a compact wave crest rolls diagonally top-left →
//         bottom-right (10 stops) — the "agent is working" shimmer.
//     Consecutive shapes share cells, so shared dots hold still while the
//     piece glides. Asymmetric fades give a comet trail: dots JOINING fade
//     in fast (FADE_IN_MS), dots LEAVING fade out slower (FADE_OUT_MS).
//
//   • GRID — behind the piece, all 16 cells carry a faint resting dot
//     (--loader-rest → --fg3 by default; see TONE_COLORS). A
//     one-directional diagonal fade (zeros-grid-fade keyframe in
//     styles/globals.css) sweeps TL → BR: each resting dot fades from
//     --fg3 @ 40% down to 0 by mid-cycle and HOLDS there, then snaps back
//     only at the loop boundary — it never fades back in mid-loop. The
//     fade lives on the resting layer ONLY, so it never dims the piece.
//
// Both loops share ONE lap length (LAP_MS = 1320ms) in every variant: a
// variant with fewer shapes holds each pose longer to fill the same lap
// (orbit 12 × 110ms, agent 10 × 132ms), and the grid fade runs exactly
// one sweep per lap. The agent variant goes further and locks its shape
// loop to the grid-fade's OWN animation clock (document.timeline via the
// sweep-origin resting dot), so pose 0 and fade phase 0 restart on the
// same frame, forever — no drift. Orbit keeps its original setInterval
// cadence, fully unchanged.
//
// PER-INSTANCE PHASE JITTER — every mount picks one random offset into the
// lap (see phaseOffsetMs) and shifts BOTH of its loops by it. A turn
// starting lights up three shimmers on the same frame (top bar, chat tab,
// activity row); they'd otherwise share a CSS-animation start time and
// march in exact lockstep, reading as one cloned element stamped three
// times. The offset is applied to the grid-fade's animation-delay AND to
// the synced shape loop's elapsed time — the SAME amount to both — so
// each instance enters the lap at its own point while staying internally
// phase-locked. Design is identical everywhere; only the entry point
// differs. offset = 0 reproduces the old lockstep behavior exactly.
//
// prefers-reduced-motion: the shape loop and the fade stop; the piece
// rests on the variant's rest pose (orbit: the Z tetromino — the brand
// shape; agent: the mid-descent square) and the grid holds at 40%.
// ──────────────────────────────────────────────────────────

import React from "react";

import { cn } from "@/zeros/ui/cn";

// ── Shared tuning (all variants, all sizes) ───────────────
/** How long a shape rests fully-formed before the next morph starts.
 *  HOLD + FADE_IN = 110ms per shape × 12 shapes = 1320ms per orbit lap. */
const HOLD_MS = 45;
/** Fade-in for dots joining the piece — quick, the piece "arrives". */
const FADE_IN_MS = 65;
/** Fade-out for dots leaving the piece — slower, the comet trail. */
const FADE_OUT_MS = 145;
/** Extra per-dot delay along the TL→BR diagonal — the "settle" ripple. */
const STAGGER_MS = 7;
/** Opacity of a lit active dot — solid --fg2 at 70%. Dots outside the
 *  piece are fully invisible (0). */
const LIT = 0.7;
/** Shared loop length. BOTH the active shape cycle and the inactive
 *  grid-fade run for exactly this long in EVERY variant, so they stay in
 *  lock-step no matter how many shapes a variant has. 1320ms = the
 *  orbit's natural 12-stop lap (12 × 110ms); a variant with fewer stops
 *  holds each stop longer to fill the same lap (agent: 10 → 132ms). */
const LAP_MS = 12 * (HOLD_MS + FADE_IN_MS);

// ── Resting grid + fade ────────────────────────────────────
/** Peak opacity of a resting (inactive) dot — --fg3 @ 40% — and its
 *  static value under reduced-motion. The fade dissolves from here to 0. */
const REST_OPACITY = 0.4;
/** One full fade cycle — the shared lap, so exactly one sweep runs per
 *  active lap and the two loops stay phase-locked in every variant. */
const GRID_FADE_PERIOD_MS = LAP_MS;
/** Per-diagonal stagger — the TL→BR sweep (larger = tighter band). */
const GRID_FADE_STEP_MS = 100;
/** Trough the resting dots dissolve to (0 = fully out). */
const GRID_FADE_TROUGH = 0;

// ── Per-instance phase jitter ──────────────────────────────
// These two helpers are the ONLY places the jitter enters, and they must
// stay in step: the fade is shifted by a CSS animation-delay, the shape
// loop by adding to its elapsed time, and the synced (agent) variant is
// only drift-free while both land on the same phase. Exported so the
// phase-lock test can assert exactly that (zeros-spinner-phase.test.ts).

/** CSS `animation-delay` for the resting dot at (x, y). Negative, so the
 *  fade is already mid-cycle at mount (no intro); the (x + y) term walks
 *  the sweep down the TL→BR diagonal, and `offsetMs` slides this whole
 *  instance to its own entry point in the lap. */
export function gridFadeDelayMs(x: number, y: number, offsetMs: number) {
  return (x + y) * GRID_FADE_STEP_MS - GRID_FADE_PERIOD_MS - offsetMs;
}

/** Phase (0 → 1) through the shared lap, `elapsedMs` after the
 *  sweep-origin dot's CSS animation started, for an instance jittered by
 *  `offsetMs`. Drives the synced shape loop. */
export function lapPhase(elapsedMs: number, offsetMs: number) {
  const t = elapsedMs + offsetMs;
  return (
    (((t % GRID_FADE_PERIOD_MS) + GRID_FADE_PERIOD_MS) % GRID_FADE_PERIOD_MS) /
    GRID_FADE_PERIOD_MS
  );
}

/** Uniform proportions — every size is a pure scale of the 24px look, so
 *  dot size, gaps and frame padding read identically at every size. */
function tuningFor() {
  return {
    /** Fraction of the box used by the dot grid (rest is padding). */
    innerRatio: 0.75,
    /** Dot diameter as a fraction of its grid cell. */
    dotRatio: 0.66,
    /** Hard floor for dot diameter in px (low enough to never distort). */
    minDotPx: 1,
  };
}

const toSets = (arr: string[][]): ReadonlyArray<ReadonlySet<string>> =>
  arr.map((cells) => new Set(cells));

/** ORBIT — choreographed tetromino orbit ("x,y" cells): every shape is a
 *  real Tetris piece, and the ORDER is arranged so the piece's centroid
 *  glides clockwise around the board — three stops per side (corner →
 *  two edge steps), twelve per lap. Every consecutive pair (including
 *  last→first) shares at least one cell, so the piece flows instead
 *  of jumping. */
const ORBIT_SHAPES = toSets([
  ["0,0", "1,0", "0,1", "1,1"], // O — top-left corner
  ["1,0", "2,0", "0,1", "1,1"], // S — sliding right along the top
  ["1,0", "2,0", "3,0", "2,1"], // T — pointing down, top edge
  ["2,0", "3,0", "2,1", "3,1"], // O — top-right corner
  ["3,0", "3,1", "2,1", "2,2"], // S — vertical, turning down the right
  ["3,1", "3,2", "3,3", "2,3"], // J — down the right edge
  ["2,2", "3,2", "2,3", "3,3"], // O — bottom-right corner
  ["2,2", "3,2", "1,3", "2,3"], // S — sliding left along the bottom
  ["1,2", "0,3", "1,3", "2,3"], // T — pointing up, bottom edge
  ["0,2", "1,2", "0,3", "1,3"], // O — bottom-left corner
  ["0,1", "0,2", "0,3", "1,3"], // L — up the left edge
  ["1,1", "1,2", "0,2", "0,3"], // Z — the Zeros piece, closes the lap
]);

/** AGENT — a diagonal WAVE crest. A compact four-dot cluster rolls and
 *  tumbles along the main diagonal, top-left → bottom-right, like a wave
 *  washing across the grid. The engine's fast-in / slow-out trail gives
 *  each pose a curl, and at the loop the crest dissolves at the
 *  bottom-right as the next wave surges in at the top-left — "the agent
 *  is working." Change ONLY these active dots to retune the agent
 *  motion; the orbit is untouched. */
const AGENT_SHAPES = toSets([
  ["0,0", "0,1", "1,1", "1,2"], // crest rises, top-left        (S-piece)
  ["0,0", "1,0", "1,1", "2,1"], // rolls right into the trough
  ["1,0", "2,0", "1,1", "2,1"], // square — the crest peaks     (□)
  ["2,0", "1,1", "2,1", "1,2"], // curls forward, spilling down
  ["2,0", "3,0", "2,1", "3,1"], // square, sliding up the right
  ["3,0", "2,1", "3,1", "2,2"], // curls down the right flank
  ["2,1", "3,1", "2,2", "3,2"], // square, mid-descent          (rest pose)
  ["3,1", "2,2", "3,2", "2,3"], // curls toward the floor
  ["1,2", "2,2", "2,3", "3,3"], // step — breaking on the shore (⌐)
  ["2,2", "3,2", "2,3", "3,3"], // square, lands bottom-right → loops
]);

export type ZerosSpinnerVariant = "orbit" | "agent";

export type ZerosSpinnerTone = "default" | "inverted" | "inherit";

/** Dot colors per tone — semantic loader tokens (semantic-tokens.css),
 *  with primitive fallbacks so the spinner still paints if the semantic
 *  layer isn't loaded (e.g. a bare preview page).
 *    default  — chrome/dialog surfaces: --loader-active/-rest (fg2/fg3).
 *    inverted — primary-button fills: the on-inverted foreground for
 *               both layers (the 70%/40% opacity split keeps them
 *               distinct) so the piece never vanishes against the
 *               near-white (Shade) / near-black (Light) fill.
 *    inherit  — currentColor: for bespoke fills (green Merge, red
 *               destructive, tone-flipping PR-island actions) where the
 *               button's own text color already carries the theme logic
 *               — exactly how the retired Loader2 spinner matched. */
const TONE_COLORS: Record<
  ZerosSpinnerTone,
  { active: string | undefined; rest: string | undefined }
> = {
  default: {
    active: "var(--loader-active, var(--fg2))",
    rest: "var(--loader-rest, var(--fg3))",
  },
  inverted: {
    active: "var(--loader-active-inverted, var(--primary-button-fg))",
    rest: "var(--loader-rest-inverted, var(--primary-button-fg))",
  },
  // undefined = don't set `color` at all — both layers inherit.
  inherit: { active: undefined, rest: undefined },
};

interface VariantSpec {
  shapes: ReadonlyArray<ReadonlySet<string>>;
  /** Static reduced-motion pose (also the boot pose). */
  restIndex: number;
  /** Lock the shape loop to the grid-fade's OWN clock (see the rAF
   *  scheduler in the mount effect) so both loops restart on the same
   *  frame. Orbit stays on its original setInterval cadence. */
  sync?: boolean;
}

const VARIANTS: Record<ZerosSpinnerVariant, VariantSpec> = {
  orbit: { shapes: ORBIT_SHAPES, restIndex: 11 },
  agent: { shapes: AGENT_SHAPES, restIndex: 6, sync: true },
};

// Flat list of all 16 (x,y) coordinates in the 4×4 grid.
const FIELD_CELLS: ReadonlyArray<{ x: number; y: number }> = (() => {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      cells.push({ x, y });
    }
  }
  return cells;
})();

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );

  React.useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface ZerosSpinnerProps {
  /** Side length of the spinner box in CSS pixels (square). Default 24.
   *  The inner animation area is 2/3 of this — a 24 px box has a
   *  16 px animation grid. */
  size?: number;
  /** Accessible label. Defaults to "Loading". */
  label?: string;
  /** Motion variant. "orbit" (default) — the clockwise tetromino lap,
   *  for loading / reconnecting states. "agent" — the diagonal wave
   *  crest, for "the agent is working" states (tool/subagent/task rows,
   *  chat tab + top bar while a turn streams). */
  variant?: ZerosSpinnerVariant;
  /** Color tone. "default" — normal surfaces (fg2/fg3 via the --loader-*
   *  semantic tokens). "inverted" — primary-button fills. "inherit" —
   *  currentColor, for buttons with bespoke fills. See TONE_COLORS. */
  tone?: ZerosSpinnerTone;
  /** Optional extra className for the outer wrapper. */
  className?: string;
}

export function ZerosSpinner({
  size = 24,
  label = "Loading",
  variant = "orbit",
  tone = "default",
  className,
}: ZerosSpinnerProps) {
  const { shapes, restIndex, sync } = VARIANTS[variant];
  const toneColors = TONE_COLORS[tone];
  const { innerRatio, dotRatio, minDotPx } = tuningFor();
  const innerPx = size * innerRatio;
  const padPx = (size - innerPx) / 2;
  const cellPx = innerPx / 4;
  const dotPx = Math.max(cellPx * dotRatio, minDotPx);

  const reducedMotion = usePrefersReducedMotion();
  // One random entry point into the lap, picked ONCE per mount so it holds
  // steady across re-renders (see PER-INSTANCE PHASE JITTER up top). Every
  // simultaneously-mounted spinner gets its own, so they never march in
  // lockstep even though the design is identical.
  const [phaseOffsetMs] = React.useState(() => Math.random() * LAP_MS);
  // Boot pose follows the jitter, so the piece is already mid-lap on the
  // first painted frame rather than snapping there once the loop starts.
  // (Reduced motion ignores this and pins restIndex — see `shape` below.)
  const [shapeIndex, setShapeIndex] = React.useState(
    () =>
      Math.floor(lapPhase(0, phaseOffsetMs) * shapes.length) % shapes.length,
  );
  // (0,0) resting dot — the fade sweep's origin. Its CSS-animation clock
  // drives the synced (agent) shape loop.
  const restOriginRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (reducedMotion) return;
    // Every variant fills the SAME lap: orbit 1320/12 = 110ms per shape
    // (its original cadence, unchanged), agent 1320/10 = 132ms.
    const stepMs = LAP_MS / shapes.length;

    // Synced variant (agent): read the phase straight off the sweep-origin
    // resting dot's CSS animation timeline, so the wave lap and the fade
    // sweep share ONE clock — they restart on the exact same frame
    // (pose 0 ↔ fade phase 0) and can never drift. The (0,0) dot's
    // animation-delay is exactly -GRID_FADE_PERIOD_MS (one full period),
    // so `currentTime - startTime` maps 1:1 onto its fade phase.
    const origin = restOriginRef.current;
    if (
      sync &&
      origin &&
      typeof origin.getAnimations === "function" &&
      typeof document !== "undefined" &&
      document.timeline
    ) {
      let raf = 0;
      let refAnim: Animation | null = null;
      let lastIdx = -1;
      const tick = () => {
        if (!refAnim) refAnim = origin.getAnimations()[0] ?? null;
        const now = document.timeline.currentTime;
        const start = refAnim?.startTime;
        if (typeof now === "number" && typeof start === "number") {
          // Same offset the grid fade carries in its animation-delay, so
          // the two loops stay locked to each other while this instance
          // sits at its own point in the lap.
          const phase = lapPhase(now - start, phaseOffsetMs);
          const idx = Math.floor(phase * shapes.length) % shapes.length;
          if (idx !== lastIdx) {
            lastIdx = idx;
            setShapeIndex(idx);
          }
        }
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
      return () => window.cancelAnimationFrame(raf);
    }

    // Orbit (and the agent's fallback when the Web Animations clock is
    // unavailable): the original free-running interval cadence.
    const id = window.setInterval(() => {
      setShapeIndex((i) => (i + 1) % shapes.length);
    }, stepMs);
    return () => window.clearInterval(id);
  }, [reducedMotion, shapes, sync, phaseOffsetMs]);

  const shape =
    shapes[reducedMotion ? restIndex : shapeIndex % shapes.length];

  return (
    <div
      role="status"
      aria-label={label}
      // `align-middle`: in inline flow the default `vertical-align: baseline`
      // seats the box ON the text baseline — visually low next to a label.
      // Middle centers it on the line box; flex parents ignore it entirely.
      className={cn("zeros-spinner relative inline-grid align-middle", className)}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        padding: `${padPx}px`,
        gridTemplateColumns: `repeat(4, ${cellPx}px)`,
        gridTemplateRows: `repeat(4, ${cellPx}px)`,
        boxSizing: "border-box",
        // Active-piece color; the resting layer overrides with its own.
        // `inherit` tone sets neither, so both ride currentColor.
        color: toneColors.active,
      }}
    >
      {FIELD_CELLS.map(({ x, y }) => {
        const key = `${x},${y}`;
        const lit = shape.has(key);
        // A lit active dot is solid --fg2 (no gradient, no wave).
        const shapeOpacity = lit ? LIT : 0;
        // Resting-grid fade: staggered along the TL→BR diagonal, shifted by
        // this instance's jitter so it doesn't sweep in lockstep with the
        // other shimmers on screen.
        const gridFadeDelay = gridFadeDelayMs(x, y, phaseOffsetMs);
        return (
          <span
            key={key}
            aria-hidden="true"
            className="relative inline-flex items-center justify-center"
            style={{
              gridColumnStart: x + 1,
              gridRowStart: y + 1,
            }}
          >
            {/* Resting layer — faint --fg3 background dot. The one-way
                diagonal fade lives HERE only, so it never dims the piece. */}
            <span
              ref={x === 0 && y === 0 ? restOriginRef : undefined}
              aria-hidden="true"
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: `${dotPx}px`,
                height: `${dotPx}px`,
                borderRadius: "50%",
                backgroundColor: "currentColor",
                display: "inline-block",
                color: toneColors.rest,
                opacity: REST_OPACITY,
                ["--zeros-grid-fade-peak" as unknown as keyof React.CSSProperties]:
                  REST_OPACITY,
                ["--zeros-grid-fade-trough" as unknown as keyof React.CSSProperties]:
                  GRID_FADE_TROUGH,
                animation: reducedMotion
                  ? undefined
                  : `zeros-grid-fade ${GRID_FADE_PERIOD_MS}ms ease-in-out infinite`,
                animationDelay: `${gridFadeDelay}ms`,
                willChange: "opacity",
              } as React.CSSProperties}
            />
            {/* Active layer — shape membership (morph crossfade). Lifted
                above the resting dot; a lit dot is solid --fg2. Joining
                dots fade in fast; leaving dots trail out slow (comet tail). */}
            <span
              className="relative inline-flex items-center justify-center"
              style={{
                zIndex: 1,
                opacity: shapeOpacity,
                transition: reducedMotion
                  ? undefined
                  : `opacity ${lit ? FADE_IN_MS : FADE_OUT_MS}ms ease-in-out ${(x + y) * STAGGER_MS}ms`,
                willChange: "opacity",
              }}
            >
              <span
                style={{
                  width: `${dotPx}px`,
                  height: `${dotPx}px`,
                  borderRadius: "50%",
                  backgroundColor: "currentColor",
                  display: "inline-block",
                }}
              />
            </span>
          </span>
        );
      })}
    </div>
  );
}
