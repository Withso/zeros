import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

import { useResizeHint } from "../../shell/use-resize-hint";
import { beginContinuousLayoutResize } from "../../shell/terminal/continuous-layout-resize";
import { cn } from "../../shared/ui/cn";
import { beginDesignPointerGesture } from "./design-pointer-gesture";

const DRAG_THRESHOLD_PX = 3;
const KEYBOARD_STEP_PX = 8;

/** The panel edge that moves. `left`/`right` resize width; `bottom` resizes
 * height (the Layers split inside the floating Design panel). */
export type DesignPanelResizeEdge = "left" | "right" | "bottom";

interface DesignPanelResizeHandleProps {
  active: boolean;
  panelRef: RefObject<HTMLElement | null>;
  edge: DesignPanelResizeEdge;
  /** The preferred (persisted) size; CSS may render the panel smaller. */
  value: number;
  defaultValue: number;
  minimum: number;
  maximum: number;
  /** Mirrors the panel's CSS bounds for the size of its parent element. */
  clampValue: (raw: number, containerSize: number) => number;
  onCommit: (value: number) => void;
  /** Paints each live drag frame into state other chrome reads (for example
   * a CSS variable); `null` restores the committed value after a cancel. */
  onLivePaint?: (value: number | null) => void;
  ariaLabel: string;
  controlsId: string;
  className?: string;
  children?: React.ReactNode;
}

/** One resize interaction for every Design panel seam. Live pointer frames
 * write only the panel's standard size/flex-basis properties (plus an optional
 * live paint); persistence and the inherited boot variable update once on
 * release. Each drag starts from the rendered size and retains the pointer's
 * grab offset, so an inset floating panel never jumps under the pointer.
 * Keyboard steps and the separator's values follow the rendered size, which
 * CSS bounds may hold below the stored preference. */
export function DesignPanelResizeHandle({
  active,
  panelRef,
  edge,
  value,
  defaultValue,
  minimum,
  maximum,
  clampValue,
  onCommit,
  onLivePaint,
  ariaLabel,
  controlsId,
  className,
  children,
}: DesignPanelResizeHandleProps) {
  const { hintHandlers, hint } = useResizeHint("Drag to resize");
  const handleRef = useRef<HTMLDivElement | null>(null);
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const vertical = edge === "bottom";

  useLayoutEffect(() => {
    if (!active) gestureCancelRef.current?.();
    return () => {
      gestureCancelRef.current?.();
      gestureCancelRef.current = null;
    };
  }, [active]);

  /** The parent's content size (borders excluded, as CSS percentages are) and
   * the panel's rendered size along the resized axis. */
  const measure = useCallback(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) return null;
    const containerSize = vertical
      ? container.clientHeight
      : container.clientWidth;
    const bounds = panel.getBoundingClientRect();
    const rendered = vertical ? bounds.height : bounds.width;
    return {
      containerSize,
      // A hidden panel has no rendered size; its preference still stands.
      current:
        rendered > 0 && Math.abs(rendered - value) > 1
          ? Math.round(rendered)
          : value,
    };
  }, [panelRef, value, vertical]);

  /** Assistive technology reads the bounds and size the surface can reach. */
  const syncAria = useCallback(() => {
    if (!active) return;
    const handle = handleRef.current;
    const measured = measure();
    if (!handle || !measured) return;
    const { containerSize, current } = measured;
    const low =
      containerSize > 0 ? clampValue(minimum, containerSize) : minimum;
    const high =
      containerSize > 0 ? clampValue(maximum, containerSize) : maximum;
    handle.setAttribute("aria-valuemin", String(Math.round(low)));
    handle.setAttribute("aria-valuemax", String(Math.round(high)));
    handle.setAttribute("aria-valuenow", String(Math.round(current)));
  }, [active, clampValue, maximum, measure, minimum]);

  useLayoutEffect(() => {
    syncAria();
  }, [syncAria]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!active || !event.isPrimary || event.button !== 0) return;
      gestureCancelRef.current?.();
      const panel = panelRef.current;
      const handle = event.currentTarget;
      handle.focus({ preventScroll: true });
      const measured = measure();
      if (!panel || !measured) return;
      event.preventDefault();
      const { containerSize } = measured;
      const sizeProperty = vertical ? "height" : "width";
      const pointerOf = (input: { clientX: number; clientY: number }) =>
        vertical ? input.clientY : input.clientX;
      const startPointer = pointerOf(event);
      const startInlineSize = panel.style.getPropertyValue(sizeProperty);
      const startInlineBasis = panel.style.getPropertyValue("flex-basis");
      let lastValue = measured.current;
      let moved = false;
      const finishContinuousResize = beginContinuousLayoutResize();

      const settle = (commit: boolean) => {
        gestureCancelRef.current = null;
        delete handle.dataset.dragging;
        if (commit && moved && lastValue !== measured.current) {
          onCommit(lastValue);
          // onCommit synchronously publishes the committed CSS variable, so
          // removing drag-only properties cannot move the seam on release.
          panel.style.removeProperty(sizeProperty);
          panel.style.removeProperty("flex-basis");
          handle.setAttribute("aria-valuenow", String(Math.round(lastValue)));
        } else {
          if (startInlineSize) {
            panel.style.setProperty(sizeProperty, startInlineSize);
          } else {
            panel.style.removeProperty(sizeProperty);
          }
          if (startInlineBasis) {
            panel.style.setProperty("flex-basis", startInlineBasis);
          } else {
            panel.style.removeProperty("flex-basis");
          }
          onLivePaint?.(null);
          handle.setAttribute(
            "aria-valuenow",
            String(Math.round(measured.current)),
          );
        }
        finishContinuousResize();
      };

      handle.dataset.dragging = "";
      gestureCancelRef.current = beginDesignPointerGesture({
        target: handle,
        pointerId: event.pointerId,
        cursor: vertical ? "ns-resize" : "ew-resize",
        onMove: (move) => {
          const travel = pointerOf(move) - startPointer;
          if (!moved && Math.abs(travel) < DRAG_THRESHOLD_PX) return;
          moved = true;
          // Keep the grab offset: returning to the starting pointer restores
          // the exact size, even when the seam extends beyond the panel edge.
          lastValue = clampValue(
            measured.current + travel * (edge === "left" ? -1 : 1),
            containerSize,
          );
          panel.style.setProperty(sizeProperty, `${lastValue}px`);
          panel.style.setProperty("flex-basis", `${lastValue}px`);
          handle.setAttribute("aria-valuenow", String(Math.round(lastValue)));
          onLivePaint?.(lastValue);
        },
        onFinish: () => settle(true),
        onCancel: () => settle(false),
      });
    },
    [
      active,
      clampValue,
      edge,
      measure,
      onCommit,
      onLivePaint,
      panelRef,
      vertical,
    ],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!active || gestureCancelRef.current) return;
      const measured = measure();
      const containerSize = measured?.containerSize ?? 0;
      // Step from what is on screen, so the first press always moves it.
      const current = measured?.current ?? value;
      let next: number | null = null;
      const step = event.shiftKey ? KEYBOARD_STEP_PX * 4 : KEYBOARD_STEP_PX;
      if (event.key === "Home") next = minimum;
      if (event.key === "End") next = maximum;
      if (vertical) {
        if (event.key === "ArrowUp") next = current - step;
        if (event.key === "ArrowDown") next = current + step;
      } else {
        if (event.key === "ArrowLeft") {
          next = current + (edge === "left" ? step : -step);
        }
        if (event.key === "ArrowRight") {
          next = current + (edge === "right" ? step : -step);
        }
      }
      if (next === null) return;
      event.preventDefault();
      onCommit(clampValue(next, containerSize));
    },
    [active, clampValue, edge, maximum, measure, minimum, onCommit, value, vertical],
  );

  return (
    <>
      <div
        ref={handleRef}
        data-design-panel-resize={edge}
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label={ariaLabel}
        aria-controls={controlsId}
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={Math.round(value)}
        tabIndex={0}
        className={cn(
          vertical
            ? "absolute inset-x-0 -bottom-1 z-20 h-2 cursor-ns-resize"
            : "absolute inset-y-0 z-20 w-1.5 cursor-ew-resize",
          edge === "right" && "right-0",
          edge === "left" && "left-0",
          className,
        )}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onFocus={syncAria}
        onDoubleClick={() => {
          if (active) onCommit(defaultValue);
        }}
        {...hintHandlers}
      >
        {children}
      </div>
      {hint}
    </>
  );
}
