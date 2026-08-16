// ──────────────────────────────────────────────────────────
// useResizeHint — the cursor-following "Drag to resize" hint
// ──────────────────────────────────────────────────────────
//
// The single hover affordance for EVERY resize seam (the Home rail, the
// chat column edge, the split panes, the terminal seam, and the workbench
// File / Changes sidebars). It replaces both the old anchored Radix
// tooltip AND the vertical "grip" pill — the cursor + this chip are now
// the only affordances.
//
// One interaction model everywhere:
//   • Hovering a seam turns the cursor into the resize cursor. A beat
//     after the pointer goes IDLE over the seam, a small glass chip fades
//     in directly ON TOP OF (just above) the pointer.
//   • Any pointer movement hides it instantly; going idle again re-shows
//     it at the new spot. Leaving the seam hides it.
//   • While a button is held (an active drag) it stays hidden, and
//     re-appears on idle once the drag is released without leaving.
//
// Usage: spread `hintHandlers` on the seam element and render `hint`
// nearby (it portals to <body>, so its place in the tree is irrelevant).
//
//   const { hintHandlers, hint } = useResizeHint("Drag to resize");
//   return (
//     <>
//       <div role="separator" {...hintHandlers} … />
//       {hint}
//     </>
//   );

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { publishNativeSurfaceOverlayIntent } from "../shared/ui/native-surface-overlay";

// How long the pointer must sit still over a seam before the hint shows.
// Short enough to read as a direct response to hovering, long enough not
// to flicker while the pointer is still gliding across the seam.
const IDLE_MS = 300;
// Gap between the pointer and the chip so the chip clears the resize
// cursor and sits clearly ON TOP OF (above) it rather than under it.
const CURSOR_GAP_PX = 14;
// Keep the chip at least this far from the viewport edges. The terminal
// seam spans the full width, so a centred chip can reach either side.
const VIEWPORT_MARGIN_PX = 8;

// The same glass chip the app Tooltip renders, minus Radix's anchored
// positioning — this one follows the pointer.
const CHIP_CLS =
  "pointer-events-none fixed z-50 w-fit select-none whitespace-nowrap rounded-md border border-border2/50 bg-bg2/40 px-2.5 py-1.5 text-xs text-fg1 shadow-[var(--shadow-dropdown)] backdrop-blur-[10px] backdrop-saturate-[1.7] animate-in fade-in-0 zoom-in-95";

interface HintPos {
  x: number;
  y: number;
}

/** Place the chip centred on and ABOVE the pointer, clamped inside the
 *  viewport. Flips below the pointer only when there isn't room above (a
 *  seam that reaches the top edge). Pure so the geometry stays tested. */
export function computeHintPlacement({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): { left: number; top: number } {
  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(v, max));
  const left = clamp(
    x - width / 2,
    VIEWPORT_MARGIN_PX,
    viewportWidth - VIEWPORT_MARGIN_PX - width,
  );
  // Prefer above the pointer; flip below only when it would clip the top.
  let top = y - CURSOR_GAP_PX - height;
  if (top < VIEWPORT_MARGIN_PX) top = y + CURSOR_GAP_PX + 8;
  top = clamp(top, VIEWPORT_MARGIN_PX, viewportHeight - VIEWPORT_MARGIN_PX - height);
  return { left, top };
}

/** The floating chip. Measures itself once, then clamps into the viewport
 *  and lifts above the pointer in a layout pass (before paint → no flash). */
function ResizeHintChip({ x, y, label }: HintPos & { label: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlaced(
      computeHintPlacement({
        x,
        y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={CHIP_CLS}
      // Until measured, render at the raw pointer spot but hidden, so the
      // pre-clamp position is never painted.
      style={
        placed
          ? { left: placed.left, top: placed.top }
          : { left: x, top: y, visibility: "hidden" }
      }
    >
      {label}
    </div>,
    document.body,
  );
}

export interface UseResizeHint {
  /** Spread onto the seam element (composes with its own pointer handlers). */
  hintHandlers: {
    onPointerEnter: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerLeave: () => void;
    onPointerUp: (e: ReactPointerEvent) => void;
  };
  /** The floating chip (portalled to <body>); render it anywhere. */
  hint: ReactNode;
}

export function useResizeHint(label: ReactNode): UseResizeHint {
  const [pos, setPos] = useState<HintPos | null>(null);
  const insideRef = useRef(false);
  const lastRef = useRef<HintPos>({ x: 0, y: 0 });
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Hide now, then (re)arm the idle timer to re-show at the latest pointer
  // spot — unless a button is held (a drag in progress), where it stays away.
  const bump = useCallback(
    (x: number, y: number, buttons: number) => {
      lastRef.current = { x, y };
      if (pos) publishNativeSurfaceOverlayIntent(false);
      setPos(null);
      clearTimer();
      if (buttons !== 0) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (insideRef.current) {
          publishNativeSurfaceOverlayIntent(true);
          setPos({ ...lastRef.current });
        }
      }, IDLE_MS);
    },
    [clearTimer, pos],
  );

  const onPointerEnter = useCallback(
    (e: ReactPointerEvent) => {
      insideRef.current = true;
      bump(e.clientX, e.clientY, e.buttons);
    },
    [bump],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      insideRef.current = true;
      bump(e.clientX, e.clientY, e.buttons);
    },
    [bump],
  );

  // A drag released with the pointer still on the seam → treat the rest
  // position as a fresh hover so the hint can re-appear on idle. If the
  // pointer left during the drag, a pointerleave clears `insideRef` first.
  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (insideRef.current) bump(e.clientX, e.clientY, 0);
    },
    [bump],
  );

  const onPointerLeave = useCallback(() => {
    insideRef.current = false;
    clearTimer();
    if (pos) publishNativeSurfaceOverlayIntent(false);
    setPos(null);
  }, [clearTimer, pos]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(
    () => () => {
      if (pos) publishNativeSurfaceOverlayIntent(false);
    },
    [pos],
  );

  const hint =
    pos && label != null && label !== "" ? (
      <ResizeHintChip x={pos.x} y={pos.y} label={label} />
    ) : null;

  return {
    hintHandlers: { onPointerEnter, onPointerMove, onPointerLeave, onPointerUp },
    hint,
  };
}
