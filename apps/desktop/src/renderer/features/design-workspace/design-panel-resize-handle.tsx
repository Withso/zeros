import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

import { useResizeHint } from "../../shell/use-resize-hint";
import { beginContinuousLayoutResize } from "../../shell/terminal/continuous-layout-resize";
import { cn } from "../../shared/ui/cn";

const DRAG_THRESHOLD_PX = 3;
const KEYBOARD_STEP_PX = 8;

/** The panel edge that moves. `left`/`right` resize width; `bottom` resizes
 * height (the Layers split inside the floating Design panel). */
export type DesignPanelResizeEdge = "left" | "right" | "bottom";

interface DesignPanelResizeHandleProps {
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
 * release. The size is measured from the panel's own opposite edge, so an
 * inset floating panel resizes from exactly where the pointer took hold of it.
 * Keyboard steps and the separator's values follow the rendered size, which
 * CSS bounds may hold below the stored preference. */
export function DesignPanelResizeHandle({
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
  const vertical = edge === "bottom";

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
  }, [clampValue, maximum, measure, minimum]);

  useLayoutEffect(() => {
    syncAria();
  }, [syncAria]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      const measured = measure();
      if (!panel || !measured || !event.isPrimary || event.button !== 0) {
        return;
      }
      event.preventDefault();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Window listeners below preserve the gesture if capture is absent.
      }

      const panelBounds = panel.getBoundingClientRect();
      const { containerSize } = measured;
      const sizeProperty = vertical ? "height" : "width";
      const pointerOf = (input: { clientX: number; clientY: number }) =>
        vertical ? input.clientY : input.clientX;
      const startPointer = pointerOf(event);
      const startInlineSize = panel.style.getPropertyValue(sizeProperty);
      const startInlineBasis = panel.style.getPropertyValue("flex-basis");
      let lastPointer = startPointer;
      let lastValue = measured.current;
      let frameId: number | null = null;
      let moved = false;
      let finished = false;
      const finishContinuousResize = beginContinuousLayoutResize();

      const paint = () => {
        frameId = null;
        const raw =
          edge === "right"
            ? lastPointer - panelBounds.left
            : edge === "left"
              ? panelBounds.right - lastPointer
              : lastPointer - panelBounds.top;
        lastValue = clampValue(raw, containerSize);
        panel.style.setProperty(sizeProperty, `${lastValue}px`);
        panel.style.setProperty("flex-basis", `${lastValue}px`);
        onLivePaint?.(lastValue);
      };

      const onMove = (move: PointerEvent) => {
        if (finished) return;
        lastPointer = pointerOf(move);
        if (
          !moved &&
          Math.abs(lastPointer - startPointer) > DRAG_THRESHOLD_PX
        ) {
          moved = true;
        }
        if (!moved || frameId !== null) return;
        frameId = requestAnimationFrame(paint);
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        handle.removeEventListener("lostpointercapture", finish);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (frameId !== null) {
          cancelAnimationFrame(frameId);
          paint();
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        delete handle.dataset.dragging;
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          // Capture can already be released by pointercancel or window blur.
        }
        if (moved) {
          onCommit(lastValue);
          // onCommit synchronously publishes the committed CSS variable, so
          // removing drag-only properties cannot move the seam on release.
          panel.style.removeProperty(sizeProperty);
          panel.style.removeProperty("flex-basis");
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
        }
        finishContinuousResize();
        syncAria();
      };

      document.body.style.cursor = vertical ? "ns-resize" : "ew-resize";
      document.body.style.userSelect = "none";
      handle.dataset.dragging = "";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [
      clampValue,
      edge,
      measure,
      onCommit,
      onLivePaint,
      panelRef,
      syncAria,
      vertical,
    ],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
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
    [clampValue, edge, maximum, measure, minimum, onCommit, value, vertical],
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
        onDoubleClick={() => onCommit(defaultValue)}
        {...hintHandlers}
      >
        {children}
      </div>
      {hint}
    </>
  );
}
