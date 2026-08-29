import React, { useCallback, type RefObject } from "react";

import { useResizeHint } from "../../shell/use-resize-hint";
import { beginContinuousLayoutResize } from "../../shell/terminal/continuous-layout-resize";
import { cn } from "../../shared/ui/cn";

const DRAG_THRESHOLD_PX = 3;
const KEYBOARD_STEP_PX = 8;

interface DesignPanelResizeHandleProps {
  panelRef: RefObject<HTMLElement | null>;
  edge: "left" | "right";
  value: number;
  defaultValue: number;
  minimum: number;
  maximum: number;
  clampValue: (raw: number, rowWidth: number) => number;
  onCommit: (value: number) => void;
  ariaLabel: string;
  controlsId: string;
}

/** One resize interaction for both Layers and Style. Live pointer frames write
 * only the panel's standard width/flex-basis properties; persistence and the
 * inherited boot variable update once on release. */
export function DesignPanelResizeHandle({
  panelRef,
  edge,
  value,
  defaultValue,
  minimum,
  maximum,
  clampValue,
  onCommit,
  ariaLabel,
  controlsId,
}: DesignPanelResizeHandleProps) {
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      const row = panel?.parentElement;
      if (!panel || !row || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Window listeners below preserve the gesture if capture is absent.
      }

      const bounds = row.getBoundingClientRect();
      const startClientX = event.clientX;
      const startInlineWidth = panel.style.getPropertyValue("width");
      const startInlineBasis = panel.style.getPropertyValue("flex-basis");
      let lastClientX = event.clientX;
      let lastWidth = value;
      let frameId: number | null = null;
      let moved = false;
      let finished = false;
      const finishContinuousResize = beginContinuousLayoutResize();

      const paint = () => {
        frameId = null;
        const raw =
          edge === "right"
            ? lastClientX - bounds.left
            : bounds.right - lastClientX;
        lastWidth = clampValue(raw, bounds.width);
        panel.style.setProperty("width", `${lastWidth}px`);
        panel.style.setProperty("flex-basis", `${lastWidth}px`);
      };

      const onMove = (move: PointerEvent) => {
        if (finished) return;
        lastClientX = move.clientX;
        if (
          !moved &&
          Math.abs(move.clientX - startClientX) > DRAG_THRESHOLD_PX
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
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          // Capture can already be released by pointercancel or window blur.
        }
        if (moved) {
          onCommit(lastWidth);
          // onCommit synchronously publishes the committed CSS variable, so
          // removing drag-only properties cannot move the seam on release.
          panel.style.removeProperty("width");
          panel.style.removeProperty("flex-basis");
        } else {
          if (startInlineWidth) {
            panel.style.setProperty("width", startInlineWidth);
          } else {
            panel.style.removeProperty("width");
          }
          if (startInlineBasis) {
            panel.style.setProperty("flex-basis", startInlineBasis);
          } else {
            panel.style.removeProperty("flex-basis");
          }
        }
        finishContinuousResize();
      };

      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", finish);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [clampValue, edge, onCommit, panelRef, value],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const rowWidth =
        panelRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
      let next: number | null = null;
      const step = event.shiftKey ? KEYBOARD_STEP_PX * 4 : KEYBOARD_STEP_PX;
      if (event.key === "Home") next = minimum;
      if (event.key === "End") next = maximum;
      if (event.key === "ArrowLeft") {
        next = value + (edge === "left" ? step : -step);
      }
      if (event.key === "ArrowRight") {
        next = value + (edge === "right" ? step : -step);
      }
      if (next === null) return;
      event.preventDefault();
      onCommit(clampValue(next, rowWidth));
    },
    [clampValue, edge, maximum, minimum, onCommit, panelRef, value],
  );

  return (
    <>
      <div
        data-design-panel-resize={edge}
        role="separator"
        aria-orientation="vertical"
        aria-label={ariaLabel}
        aria-controls={controlsId}
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={Math.round(value)}
        tabIndex={0}
        className={cn(
          "absolute inset-y-0 z-20 w-1.5 cursor-ew-resize",
          edge === "right" ? "right-0" : "left-0",
        )}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onCommit(defaultValue)}
        {...hintHandlers}
      />
      {hint}
    </>
  );
}
