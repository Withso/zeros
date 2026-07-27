// ──────────────────────────────────────────────────────────
// Canvas resize knobs — centered pill on right (width) and
// bottom (height). Shared by the live browser frame + variants.
// ──────────────────────────────────────────────────────────

import React from "react";

export type CanvasKnobAxis = "left" | "right" | "bottom";

const ZONE = 12;

interface CanvasKnobHandlesProps {
  /** Which edges get a knob. Variants use right+bottom only. */
  axes: CanvasKnobAxis[];
  /** Axis currently being dragged — highlights that knob. */
  activeAxis?: CanvasKnobAxis | null;
  onStart: (
    e: React.PointerEvent,
    axis: CanvasKnobAxis,
    handle: HTMLElement,
  ) => void;
}

/** Pointer-capture resize zones with a centered pill knob on each
 *  edge. Hit area sits outside the frame bounds so it never
 *  overlaps iframe content. */
export function CanvasKnobHandles({
  axes,
  activeAxis = null,
  onStart,
}: CanvasKnobHandlesProps) {
  const sideClass =
    "group absolute flex items-center justify-center bg-transparent pointer-events-auto";
  const barBase =
    "rounded-full pointer-events-none transition-[background,transform] duration-150 ease-out";

  const verticalVisual = (axis: CanvasKnobAxis) => {
    const active = activeAxis === axis;
    return active
      ? "bg-fg1 scale-y-[1.6]"
      : "bg-border1 group-hover:bg-fg1/60 group-hover:scale-y-[1.4]";
  };

  const horizontalVisual = (axis: CanvasKnobAxis) => {
    const active = activeAxis === axis;
    return active
      ? "bg-fg1 scale-x-[1.6]"
      : "bg-border1 group-hover:bg-fg1/60 group-hover:scale-x-[1.4]";
  };

  return (
    <>
      {axes.includes("left") && (
        <div
          className={sideClass}
          data-zeros-canvas-chrome
          onPointerDown={(e) => {
            e.stopPropagation();
            onStart(e, "left", e.currentTarget as HTMLElement);
          }}
          style={{
            top: 0,
            bottom: 0,
            left: -ZONE,
            width: ZONE,
            cursor: "ew-resize",
            zIndex: 20,
          }}
        >
          <div className={`h-12 w-1 ${barBase} ${verticalVisual("left")}`} />
        </div>
      )}
      {axes.includes("right") && (
        <div
          className={sideClass}
          data-zeros-canvas-chrome
          onPointerDown={(e) => {
            e.stopPropagation();
            onStart(e, "right", e.currentTarget as HTMLElement);
          }}
          style={{
            top: 0,
            bottom: 0,
            right: -ZONE,
            width: ZONE,
            cursor: "ew-resize",
            zIndex: 20,
          }}
        >
          <div className={`h-12 w-1 ${barBase} ${verticalVisual("right")}`} />
        </div>
      )}
      {axes.includes("bottom") && (
        <div
          className={sideClass}
          data-zeros-canvas-chrome
          onPointerDown={(e) => {
            e.stopPropagation();
            onStart(e, "bottom", e.currentTarget as HTMLElement);
          }}
          style={{
            left: 0,
            right: 0,
            bottom: -ZONE,
            height: ZONE,
            cursor: "ns-resize",
            zIndex: 20,
          }}
        >
          <div
            className={`h-1 w-12 ${barBase} ${horizontalVisual("bottom")}`}
          />
        </div>
      )}
    </>
  );
}
