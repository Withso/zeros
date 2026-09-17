import {
  DESIGN_CANVAS_INVERSE_ZOOM,
  designCanvasScreenPixels,
} from "./design-canvas-camera";
// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import { Diamond } from "lucide-react";
import React, { useMemo } from "react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  type DesignCanvasFrameWire,
  type DesignFrameGeometryWire,
} from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import {
  DESIGN_ROTATION_CORNERS,
  designConstraintGuides,
  designGridTrackSegments,
  designInlineGapGeometry,
  designInlineGapRegions,
  designMeasureSpacing,
  designOriginTranslationShift,
  designRotationCursor,
  designSelectionBox,
  designSelectionOverlayFrame,
  type DesignCanvasRect,
  type DesignConstraintSide,
  type DesignConstraintSides,
  type DesignInlineGapRegion,
  type DesignResizeHandle,
  type DesignRotationCorner,
  type DesignSelectionBox,
  type DesignSelectionOverlayFrame,
} from "./design-canvas-math";
import {
  formatDesignTransform,
  type DesignTransformValue,
} from "./design-effect-values";
import { type DesignMotionTimelineDraft } from "./design-motion-timeline";
import {
  designDurationMs,
  designMotionProperties,
  designMotionTimeAtOffset,
  designMotionTranslationAtOffset,
  designMotionTranslationPoints,
} from "./design-motion-values";
import { designBackgroundWork } from "./state/design-background-work";
import { designLivePreviewValue } from "./state/design-live-preview";
import { useDesignMotionPlayhead } from "./state/design-motion-playhead";
import { useDesignRuntimeStore } from "./state/design-runtime-store";



export function frameGeometry(frame: DesignCanvasFrameWire): DesignFrameGeometryWire {
  return {
    x: frame.x,
    y: frame.y,
    w: frame.width,
    h: frame.height,
    z: frame.z,
  };
}

/** Pointer gestures paint the one frame DOM node directly and commit once. */
export function paintFrameGeometry(
  element: HTMLElement,
  geometry: DesignFrameGeometryWire,
): void {
  designBackgroundWork.touch();
  element.style.left = `${geometry.x}px`;
  element.style.top = `${geometry.y}px`;
  element.style.width = `${geometry.w}px`;
  element.style.height = `${geometry.h}px`;
  element.style.zIndex = String(geometry.z);
}

/** Every gesture paints the one selected overlay directly, so its placement
 * must be expressible without React. A rotated selection is anchored on its
 * pivot, which no rotation can move, and an upright one keeps the exact
 * left/top/width/height it has always had. */
export function designSelectionOverlayStyle(
  overlay: DesignSelectionOverlayFrame,
): React.CSSProperties {
  return {
    left: overlay.left,
    top: overlay.top,
    width: overlay.width,
    height: overlay.height,
    ...(overlay.rotation
      ? {
          transform: `rotate(${overlay.rotation}deg)`,
          transformOrigin: `${overlay.pivotX}px ${overlay.pivotY}px`,
        }
      : {}),
  };
}

/** Write a label's text without replacing the node React rendered.
 * `replaceChildren` and `textContent` both detach the text node React's fiber
 * points at; React's next update then writes into a node that is no longer in
 * the document, and the label silently freezes at its last painted value. */
export function paintDesignLabelText(element: HTMLElement | null, text: string): void {
  if (!element) return;
  const first = element.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE && !first.nextSibling) {
    if (first.nodeValue !== text) first.nodeValue = text;
    return;
  }
  element.textContent = text;
}

export function paintDesignNodeOverlayGeometry(
  element: HTMLElement,
  overlay: DesignSelectionOverlayFrame,
): void {
  element.style.left = `${overlay.left}px`;
  element.style.top = `${overlay.top}px`;
  element.style.width = `${overlay.width}px`;
  element.style.height = `${overlay.height}px`;
  element.style.transform = overlay.rotation
    ? `rotate(${overlay.rotation}deg)`
    : "";
  element.style.transformOrigin = overlay.rotation
    ? `${overlay.pivotX}px ${overlay.pivotY}px`
    : "";
  paintDesignLabelText(
    element.querySelector<HTMLElement>("[data-design-selection-size]"),
    `${Math.round(overlay.width)} × ${Math.round(overlay.height)}`,
  );
  // The pivot rides the box it turns about, and both it and the angle readout
  // counter-rotate to stay upright. React renders them from the same overlay
  // frame; a gesture that repaints the box owes them the same update, or the
  // reticle drifts off the pivot and the readout tilts as you drag.
  const pivot = element.querySelector<HTMLElement>(
    "[data-design-origin-handle]",
  );
  if (pivot) {
    const originX = Number(pivot.dataset.designOriginX);
    const originY = Number(pivot.dataset.designOriginY);
    if (Number.isFinite(originX) && Number.isFinite(originY)) {
      pivot.style.left = `${originX * overlay.width}px`;
      pivot.style.top = `${originY * overlay.height}px`;
    }
    pivot.style.transform = `translate(-50%, -50%) rotate(${-overlay.rotation}deg)`;
  }
  const readout = element.querySelector<HTMLElement>(
    "[data-design-rotation-feedback]",
  );
  if (readout) {
    readout.style.transform = `rotate(${-overlay.rotation}deg) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`;
  }
}

/** Dashed runs from the selection to the parent edges its CSS pins it to — the
 * constraint, in the properties HTML actually has. They live in frame space
 * rather than inside the rotated overlay, because a constraint describes where
 * the box is anchored, not which way the element faces. The spans render even
 * at zero length (hidden) so gesture paints can reveal them. */
export function DesignConstraintGuides({
  nodeId,
  bounds,
  parentRect,
  sides,
}: {
  nodeId: string;
  bounds: DesignCanvasRect;
  parentRect: DesignCanvasRect;
  sides: DesignConstraintSides;
}) {
  const guides = designConstraintGuides(bounds, parentRect, sides);
  return (
    <span
      data-design-parent-guides={nodeId}
      data-parent-x={parentRect.x}
      data-parent-y={parentRect.y}
      data-parent-width={parentRect.width}
      data-parent-height={parentRect.height}
      data-constraint-sides={[...sides.horizontal, ...sides.vertical].join(" ")}
      className="pointer-events-none absolute inset-0 z-[1]"
      aria-hidden="true"
    >
      {guides.map((guide) => (
        <span
          key={guide.side}
          data-design-parent-guide={guide.side}
          className={cn(
            "zd-design-parent-guide absolute border-dashed",
            guide.axis === "vertical" ? "border-l" : "border-t",
          )}
          style={{
            left: guide.x,
            top: guide.y,
            width: guide.axis === "vertical" ? 0 : guide.length,
            height: guide.axis === "vertical" ? guide.length : 0,
            borderLeftWidth:
              guide.axis === "vertical"
                ? designCanvasScreenPixels(1)
                : undefined,
            borderTopWidth:
              guide.axis === "horizontal"
                ? designCanvasScreenPixels(1)
                : undefined,
            display: guide.length > 0.5 ? undefined : "none",
          }}
        />
      ))}
    </span>
  );
}

/** Gesture paints repaint the guides directly: the parent stays put while one
 * element moves or resizes, so the runs follow the painted bounding box. */
export function paintDesignConstraintGuides(
  guides: HTMLElement | null,
  bounds: DesignCanvasRect,
): void {
  if (!guides) return;
  const parent = {
    x: Number(guides.dataset.parentX),
    y: Number(guides.dataset.parentY),
    width: Number(guides.dataset.parentWidth),
    height: Number(guides.dataset.parentHeight),
  };
  if (Object.values(parent).some((value) => !Number.isFinite(value))) return;
  const sides = (guides.dataset.constraintSides ?? "")
    .split(" ")
    .filter(Boolean) as DesignConstraintSide[];
  const painted = designConstraintGuides(bounds, parent, {
    horizontal: sides.filter((side) => side === "left" || side === "right"),
    vertical: sides.filter((side) => side === "top" || side === "bottom"),
  });
  for (const guide of painted) {
    const element = guides.querySelector<HTMLElement>(
      `[data-design-parent-guide="${guide.side}"]`,
    );
    if (!element) continue;
    element.style.left = `${guide.x}px`;
    element.style.top = `${guide.y}px`;
    if (guide.axis === "vertical") element.style.height = `${guide.length}px`;
    else element.style.width = `${guide.length}px`;
    element.style.display = guide.length > 0.5 ? "" : "none";
  }
}

/** Option/Alt measurement overlay: red distance lines between the selection
 * and its measured target — the hovered node when the pointer rests on one,
 * otherwise the selection's parent (or the frame itself). Geometry is
 * frame-local, so this renders as a direct child of the frame article. */
export const DesignMeasureOverlay = React.memo(function DesignMeasureOverlay({
  workspaceId,
  frameFile,
  sourceVersion,
  selected,
  parentRect,
}: {
  workspaceId: string;
  frameFile: string;
  sourceVersion: string;
  selected: DesignRuntimeNodeDetails;
  parentRect: { x: number; y: number; width: number; height: number } | null;
}) {
  const hovered = useDesignRuntimeStore((state) => {
    const workspace = state.byWorkspace[workspaceId];
    if (workspace?.hoveredFrame !== frameFile || !workspace.hoveredNodeId) {
      return null;
    }
    const details =
      workspace.frames[frameFile]?.detailsByNode[workspace.hoveredNodeId] ??
      null;
    if (
      !details ||
      details.sourceVersion !== sourceVersion ||
      details.oid === selected.oid
    ) {
      return null;
    }
    return details;
  });
  const target = hovered?.rect ?? parentRect;
  if (!target) return null;
  const { lines, extensions } = designMeasureSpacing(selected.rect, target);
  return (
    <div
      data-design-measure-overlay=""
      data-design-spacing-measurement=""
      className="pointer-events-none absolute inset-0 z-30"
      aria-hidden="true"
    >
      <span
        data-design-measure-target=""
        className="absolute outline"
        style={{
          left: target.x,
          top: target.y,
          width: target.width,
          height: target.height,
          outlineColor: "var(--red-primary)",
          outlineWidth: designCanvasScreenPixels(1),
        }}
      />
      {extensions.map((extension, index) => (
        <span
          key={`extension:${index}`}
          data-design-measure-extension=""
          className={cn(
            "absolute border-dashed",
            extension.axis === "vertical" ? "border-l" : "border-t",
          )}
          style={{
            left: extension.x,
            top: extension.y,
            width: extension.axis === "vertical" ? 0 : extension.length,
            height: extension.axis === "vertical" ? extension.length : 0,
            borderColor: "var(--red-primary)",
            borderLeftWidth:
              extension.axis === "vertical"
                ? designCanvasScreenPixels(1)
                : undefined,
            borderTopWidth:
              extension.axis === "horizontal"
                ? designCanvasScreenPixels(1)
                : undefined,
          }}
        />
      ))}
      {lines.map((measurement) => {
        const horizontal = measurement.axis === "horizontal";
        return (
          <span
            key={measurement.side}
            data-design-measure={measurement.side}
            className="bg-red-primary absolute"
            style={{
              left: measurement.x,
              top: measurement.y,
              width: horizontal
                ? measurement.length
                : designCanvasScreenPixels(1),
              height: horizontal
                ? designCanvasScreenPixels(1)
                : measurement.length,
            }}
          >
            <span
              className="bg-red-primary absolute rounded-sm px-1 font-mono text-[9px] leading-4 whitespace-nowrap text-[var(--design-selection-label-fg)]"
              style={{
                left: horizontal ? "50%" : 0,
                top: horizontal ? 0 : "50%",
                transform: `translate(-50%, -50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                transformOrigin: "center",
              }}
            >
              {Math.round(measurement.distance)}
            </span>
          </span>
        );
      })}
    </div>
  );
});

export const DESIGN_RESIZE_HANDLES: ReadonlyArray<{
  handle: DesignResizeHandle;
  x: "left" | "center" | "right";
  y: "top" | "center" | "bottom";
  cursor: string;
}> = [
  { handle: "nw", x: "left", y: "top", cursor: "nwse-resize" },
  { handle: "n", x: "center", y: "top", cursor: "ns-resize" },
  { handle: "ne", x: "right", y: "top", cursor: "nesw-resize" },
  { handle: "e", x: "right", y: "center", cursor: "ew-resize" },
  { handle: "se", x: "right", y: "bottom", cursor: "nwse-resize" },
  { handle: "s", x: "center", y: "bottom", cursor: "ns-resize" },
  { handle: "sw", x: "left", y: "bottom", cursor: "nesw-resize" },
  { handle: "w", x: "left", y: "center", cursor: "ew-resize" },
];
const DESIGN_CORNER_RESIZE_HANDLES = DESIGN_RESIZE_HANDLES.filter(
  ({ x, y }) => x !== "center" && y !== "center",
);
const DESIGN_EDGE_RESIZE_HANDLES = DESIGN_RESIZE_HANDLES.filter(
  ({ x, y }) => x === "center" || y === "center",
);

export function DesignResizeHandles({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: DesignResizeHandle,
  ) => void;
}) {
  const size = designCanvasScreenPixels(8);
  // Keep a crisp four-screen-pixel resize strip inside the outline. Wider
  // bands steal pointer intent from padding/gap controls that legitimately
  // approach the same edge on small or zero-spacing containers.
  const edgeHitSize = designCanvasScreenPixels(4);
  // Visible squares live on the four corners only; edges keep their invisible
  // resize strips so mid-edge resizing still works without the extra chrome.
  const handles = DESIGN_CORNER_RESIZE_HANDLES;
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {DESIGN_EDGE_RESIZE_HANDLES.map(({ handle, x, y, cursor }) => {
        const horizontal = x === "center";
        return (
          <button
            key={`edge:${handle}`}
            data-design-controls
            data-design-resize-edge={handle}
            type="button"
            className="pointer-events-auto absolute z-0 border-0 bg-transparent p-0"
            style={
              horizontal
                ? {
                    right: designCanvasScreenPixels(4),
                    left: designCanvasScreenPixels(4),
                    top: y === "top" ? 0 : `calc(100% - ${edgeHitSize})`,
                    height: edgeHitSize,
                    cursor,
                  }
                : {
                    top: designCanvasScreenPixels(4),
                    bottom: designCanvasScreenPixels(4),
                    left: x === "left" ? 0 : `calc(100% - ${edgeHitSize})`,
                    width: edgeHitSize,
                    cursor,
                  }
            }
            aria-label={`Resize ${label} from ${handle} edge`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPointerDown(event, handle);
            }}
          />
        );
      })}
      {handles.map(({ handle, x, y, cursor }) => (
        <button
          key={handle}
          data-design-controls
          type="button"
          className="zd-design-selection-handle pointer-events-auto absolute rounded-[1px] border"
          style={{
            width: size,
            height: size,
            left: x === "left" ? 0 : x === "center" ? "50%" : "100%",
            top: y === "top" ? 0 : y === "center" ? "50%" : "100%",
            transform: "translate(-50%, -50%)",
            cursor,
            borderWidth: designCanvasScreenPixels(1),
          }}
          aria-label={`Resize ${label} from ${handle}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPointerDown(event, handle);
          }}
        />
      ))}
    </div>
  );
}

/** Rotation lives just outside each corner instead of on a separate button:
 * hovering past a corner shows a rotation cursor aimed the way the drag will
 * turn, which keeps the resting selection free of extra chrome. The zones stop
 * short of the corner so the resize square keeps its own hit area, and entering
 * one arms the rotation pivot for dragging. */
export function DesignRotationHandles({
  label,
  rotation,
  onPointerDown,
}: {
  label: string;
  /** The selection's painted rotation, so each cursor stays aimed at the box. */
  rotation: number;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    corner: DesignRotationCorner,
  ) => void;
}) {
  const size = designCanvasScreenPixels(20);
  const inset = designCanvasScreenPixels(5);
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {DESIGN_ROTATION_CORNERS.map(({ corner, x, y, cursorAngle }) => (
        <button
          key={corner}
          data-design-controls
          data-design-rotate-corner={corner}
          type="button"
          className="pointer-events-auto absolute border-0 bg-transparent p-0"
          style={{
            width: size,
            height: size,
            [x === 0 ? "right" : "left"]: `calc(100% - ${inset})`,
            [y === 0 ? "bottom" : "top"]: `calc(100% - ${inset})`,
            cursor: designRotationCursor(rotation + cursorAngle),
          }}
          aria-label={`Rotate ${label} from ${corner} corner`}
          // Arming here, in the DOM, keeps hover off React's render path.
          onPointerEnter={(event) =>
            event.currentTarget
              .closest("[data-design-element-overlay]")
              ?.setAttribute("data-design-origin-armed", "")
          }
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPointerDown(event, corner);
          }}
        />
      ))}
    </div>
  );
}

/** The pivot every rotation turns about, authored as `transform-origin`. It
 * counter-rotates so the crosshair stays upright, and hides on a selection too
 * small to spare its center to a drag target.
 *
 * The marker is visible at rest but inert until the pointer has entered a
 * rotation corner: it sits at the element's center, where a drag means "move
 * this element" and a double-click means "edit this text". Rotation and its
 * pivot arrive together, so approaching one arms the other. */
export function DesignOriginHandle({
  label,
  overlay,
  origin,
  onPointerDown,
  onReset,
}: {
  label: string;
  overlay: DesignSelectionOverlayFrame;
  /** The pivot as a fraction of the box, so a gesture repainting the overlay can
   * place the marker without re-deriving it. */
  origin: { originX: number; originY: number };
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onReset: () => void;
}) {
  const size = designCanvasScreenPixels(13);
  const hit = designCanvasScreenPixels(18);
  return (
    <div
      data-design-origin-root=""
      className="pointer-events-none absolute inset-0 z-40"
    >
      <button
        data-design-controls
        data-design-origin-handle=""
        data-design-origin-x={origin.originX}
        data-design-origin-y={origin.originY}
        type="button"
        className="absolute flex items-center justify-center border-0 bg-transparent p-0"
        style={{
          left: overlay.pivotX,
          top: overlay.pivotY,
          width: hit,
          height: hit,
          transform: `translate(-50%, -50%) rotate(${-overlay.rotation}deg)`,
          cursor: "move",
        }}
        aria-label={`Move the rotation origin of ${label}`}
        title="Drag to move the rotation origin. Double-click to center it."
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPointerDown(event);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onReset();
        }}
      >
        {/* A reticle reads as a pivot rather than a resize square: a ringed
         * center with four ticks aimed at the axes it turns about. Stroke
         * widths are authored in screen pixels because this marker lives inside
         * the zoomed world and must not thicken with the camera. */}
        <svg
          className="zd-design-origin-marker block"
          style={{ width: size, height: size }}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          // User units inside a constant-screen-size box already hold their
          // screen width; compensating again would thin the reticle at zoom.
          strokeWidth={1.4}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="3.4" />
          <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
          <path d="M8 0.6V3M8 13V15.4M0.6 8H3M13 8H15.4" />
        </svg>
      </button>
    </div>
  );
}

/** The nine anchors a dragged origin snaps to, revealed only while dragging so
 * the resting selection stays quiet. */
export function DesignOriginAnchors() {
  const size = designCanvasScreenPixels(9);
  return (
    <div
      data-design-origin-anchors=""
      className="pointer-events-none absolute inset-0 z-30 hidden"
      aria-hidden="true"
    >
      {[0, 0.5, 1].flatMap((y) =>
        [0, 0.5, 1].map((x) => (
          <span
            key={`${x}:${y}`}
            className="zd-design-origin-anchor absolute block"
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: size,
              height: size,
              transform: "translate(-50%, -50%)",
              borderWidth: designCanvasScreenPixels(1),
            }}
          />
        )),
      )}
    </div>
  );
}

/** Percentage origins keep the pivot in place when the element resizes, which
 * is what a pivot should do, and read cleanly in the authored source. */
function roundedOriginPercentage(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/** The `transform-origin` change plus the translation that keeps an already
 * transformed element from jumping when its pivot moves. An authored transform
 * the editor cannot decompose keeps its exact text: rewriting it from a partial
 * parse would silently discard the parts it did not understand. */
export function designOriginStyles(
  box: DesignSelectionBox,
  transform: DesignTransformValue,
  next: { originX: number; originY: number },
): Record<string, string> {
  const styles: Record<string, string> = {
    "transform-origin": `${roundedOriginPercentage(next.originX)}% ${roundedOriginPercentage(next.originY)}%`,
  };
  if (transform.raw !== undefined) return styles;
  const shift = designOriginTranslationShift({
    width: box.width,
    height: box.height,
    originX: box.originX,
    originY: box.originY,
    nextOriginX: next.originX,
    nextOriginY: next.originY,
    transform,
  });
  if (Math.abs(shift.x) > 0.01 || Math.abs(shift.y) > 0.01) {
    styles.transform = formatDesignTransform({
      ...transform,
      x: transform.x + shift.x,
      xUnit: "px",
      y: transform.y + shift.y,
      yUnit: "px",
    });
  }
  return styles;
}

/** What every canvas paint actually reads. A node's full runtime details and a
 * gesture's lean geometry both satisfy it, so one helper serves both. */
export type DesignPaintedNode = {
  rect: DesignCanvasRect;
  styles: Record<string, string>;
};

export type DesignPaintedChild = DesignPaintedNode & {
  oid: string;
  name: string;
};

export function designPixelValue(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
  return match?.[1] ? Math.max(0, Number(match[1])) : 0;
}

function designPixelLength(value: string | undefined): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value?.trim() ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

/** The pixel value one gesture step must build on.
 *
 * A second drag can begin before the first one's source commit has been
 * adopted, and the runtime store still holds the pre-commit details until it
 * is. Building on those authors the new delta from the stale base and silently
 * discards the previous drag, so the speculative value the commit is still
 * landing wins — but only where it is a length a gesture can add to. An
 * inspector can leave `50%` or `calc(…)` speculative on the same property, and
 * there only the computed value says where that actually put the element. */
export function designGesturePixelBase(
  owner: { workspaceId: string; frame: string; nodeId: string },
  property: string,
  computed: string | undefined,
  fallback = 0,
): number {
  const live = designLivePreviewValue(
    owner.workspaceId,
    owner.frame,
    owner.nodeId,
    property,
  );
  return (
    (typeof live === "string" ? designPixelLength(live) : null) ??
    designPixelLength(computed) ??
    fallback
  );
}

export interface DesignInlineSpacingControl {
  property:
    | "padding-top"
    | "padding-right"
    | "padding-bottom"
    | "padding-left"
    | "gap"
    | "row-gap"
    | "column-gap";
  oppositeProperty?:
    | "padding-top"
    | "padding-right"
    | "padding-bottom"
    | "padding-left";
  axis: "x" | "y";
  direction: 1 | -1;
  value: number;
  regionKey?: string;
}

export interface DesignMotionOverlayState {
  owner: string;
  draft: DesignMotionTimelineDraft | null;
}

function paintDesignInlineGapHandle(
  handle: HTMLElement,
  region: DesignInlineGapRegion,
  zoom: number,
): void {
  const { hitRect, visualRect } = designInlineGapGeometry(region, zoom);
  handle.style.visibility = "visible";
  handle.style.left = `${hitRect.x}px`;
  handle.style.top = `${hitRect.y}px`;
  handle.style.width = `${hitRect.width}px`;
  handle.style.height = `${hitRect.height}px`;
  const visual = handle.querySelector<HTMLElement>(
    "[data-design-inline-gap-visual]",
  );
  if (!visual) return;
  visual.style.left = `${visualRect.x}px`;
  visual.style.top = `${visualRect.y}px`;
  visual.style.width = `${visualRect.width}px`;
  visual.style.height = `${visualRect.height}px`;
}

export function paintDesignInlineGapHandles(
  root: HTMLElement,
  containerDetails: DesignPaintedNode,
  childDetails: readonly DesignPaintedChild[],
  zoom: number,
): void {
  const regions = designInlineGapRegions({
    container: containerDetails.rect,
    children: childDetails.map((child) => ({
      id: child.oid,
      rect: child.rect,
      position: child.styles.position,
    })),
    display: containerDetails.styles.display,
    flexDirection: containerDetails.styles.flexDirection,
    flexWrap: containerDetails.styles.flexWrap,
  });
  const regionsByKey = new Map(regions.map((region) => [region.key, region]));
  for (const handle of root.querySelectorAll<HTMLElement>(
    "[data-design-inline-gap-region]",
  )) {
    const key = handle.dataset.designInlineGapRegion;
    const region = key ? regionsByKey.get(key) : null;
    if (!region) {
      handle.style.visibility = "hidden";
      continue;
    }
    paintDesignInlineGapHandle(handle, region, zoom);
  }
}

export function paintDesignInlinePaddingGeometry(
  root: HTMLElement,
  details: DesignPaintedNode,
): void {
  const sides = [
    ["top", details.styles.paddingTop, details.rect.height / 2],
    ["right", details.styles.paddingRight, details.rect.width / 2],
    ["bottom", details.styles.paddingBottom, details.rect.height / 2],
    ["left", details.styles.paddingLeft, details.rect.width / 2],
  ] as const;
  for (const [side, rawValue, maximum] of sides) {
    const value = Math.min(maximum, designPixelValue(rawValue));
    root.style.setProperty(`--design-inline-padding-${side}`, `${value}px`);
    root.style.setProperty(
      `--design-inline-padding-${side}-center`,
      `${value / 2}px`,
    );
  }
}

export function designInspectorPreviewOverlay(
  workspaceId: string,
  frame: string,
  nodeId: string,
): HTMLElement | null {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const frameElement = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  return (
    frameElement?.querySelector<HTMLElement>(
      `[data-design-element-overlay="${CSS.escape(nodeId)}"]`,
    ) ?? null
  );
}

export function paintDesignFrameGeometryPreview(
  workspaceId: string,
  frame: string,
  geometry: DesignFrameGeometryWire,
): void {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const frameElement = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  if (!frameElement) return;
  frameElement.style.left = `${geometry.x}px`;
  frameElement.style.top = `${geometry.y}px`;
  frameElement.style.width = `${geometry.w}px`;
  frameElement.style.height = `${geometry.h}px`;
  const size = frameElement.querySelector<HTMLElement>(
    "[data-design-frame-size]",
  );
  if (size) {
    size.textContent = `${Math.round(geometry.w)} × ${Math.round(geometry.h)}`;
  }
}

export function paintedDesignFrameGeometry(
  workspaceId: string,
  frame: string,
  fallback: DesignFrameGeometryWire,
): DesignFrameGeometryWire {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const element = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  if (!element) return fallback;
  const number = (value: string, prior: number) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : prior;
  };
  return {
    x: number(element.style.left, fallback.x),
    y: number(element.style.top, fallback.y),
    w: number(element.style.width, fallback.w),
    h: number(element.style.height, fallback.h),
    z: fallback.z,
  };
}

/** Paint one inspector preview into the already-mounted selection island.
 * The iframe owns element pixels; this keeps only the blue overlay and its
 * spacing geometry in lockstep without publishing a broad runtime snapshot. */
export function paintDesignInspectorPreviewDetails(
  workspaceId: string,
  frame: string,
  details: DesignPaintedNode & { oid: string; box?: DesignSelectionBox },
): HTMLElement | null {
  const overlay = designInspectorPreviewOverlay(
    workspaceId,
    frame,
    details.oid,
  );
  if (!overlay) return null;
  paintDesignNodeOverlayGeometry(
    overlay,
    designSelectionOverlayFrame(designSelectionBox(details)),
  );
  const spacingRoot = overlay.querySelector<HTMLElement>(
    "[data-design-inline-spacing-root]",
  );
  if (spacingRoot) paintDesignInlinePaddingGeometry(spacingRoot, details);
  return spacingRoot;
}

export function DesignSelectionMeasurements({
  details,
  overlay,
  children,
  zoom,
  onSpacingPointerDown,
}: {
  details: DesignRuntimeNodeDetails;
  /** Painted geometry of the owning overlay. Padding, tracks, and the size
   * label all describe the element's own box, which a rotation grows a larger
   * bounding box around. */
  overlay: DesignSelectionOverlayFrame;
  children: readonly DesignPaintedChild[];
  zoom: number;
  onSpacingPointerDown?: (
    event: React.PointerEvent<HTMLButtonElement>,
    control: DesignInlineSpacingControl,
  ) => void;
}) {
  const paddingTop = designPixelValue(details.styles.paddingTop);
  const paddingRight = designPixelValue(details.styles.paddingRight);
  const paddingBottom = designPixelValue(details.styles.paddingBottom);
  const paddingLeft = designPixelValue(details.styles.paddingLeft);
  const top = Math.min(overlay.height / 2, paddingTop);
  const right = Math.min(overlay.width / 2, paddingRight);
  const bottom = Math.min(overlay.height / 2, paddingBottom);
  const left = Math.min(overlay.width / 2, paddingLeft);
  const display = details.styles.display;
  const rowGap =
    designPixelValue(details.styles.rowGap) ||
    designPixelValue(details.styles.gap);
  const columnGap =
    designPixelValue(details.styles.columnGap) ||
    designPixelValue(details.styles.gap);
  const layoutToolsActive =
    Boolean(onSpacingPointerDown) &&
    ["flex", "inline-flex", "grid", "inline-grid"].includes(display);
  const gapRegions = layoutToolsActive
    ? designInlineGapRegions({
        container: details.rect,
        children: children.map((child) => ({
          id: child.oid,
          rect: child.rect,
          position: child.styles.position,
        })),
        display,
        flexDirection: details.styles.flexDirection,
        flexWrap: details.styles.flexWrap,
      })
    : [];
  const gridColumns =
    display === "grid"
      ? designGridTrackSegments(
          details.styles.gridTemplateColumns,
          Math.max(1, overlay.width - left - right),
        )
      : [];
  const gridRows =
    display === "grid"
      ? designGridTrackSegments(
          details.styles.gridTemplateRows,
          Math.max(1, overlay.height - top - bottom),
        )
      : [];
  const paddingControls = [
    {
      property: "padding-top" as const,
      oppositeProperty: "padding-bottom" as const,
      axis: "y" as const,
      direction: 1 as const,
      value: paddingTop,
      left: "50%",
      top: "var(--design-inline-padding-top-center)",
      highlight: {
        top: 0,
        right: 0,
        left: 0,
        height: "var(--design-inline-padding-top)",
      },
      cursor: "ns-resize",
    },
    {
      property: "padding-right" as const,
      oppositeProperty: "padding-left" as const,
      axis: "x" as const,
      direction: -1 as const,
      value: paddingRight,
      left: "calc(100% - var(--design-inline-padding-right-center))",
      top: "50%",
      highlight: {
        top: 0,
        right: 0,
        bottom: 0,
        width: "var(--design-inline-padding-right)",
      },
      cursor: "ew-resize",
    },
    {
      property: "padding-bottom" as const,
      oppositeProperty: "padding-top" as const,
      axis: "y" as const,
      direction: -1 as const,
      value: paddingBottom,
      left: "50%",
      top: "calc(100% - var(--design-inline-padding-bottom-center))",
      highlight: {
        right: 0,
        bottom: 0,
        left: 0,
        height: "var(--design-inline-padding-bottom)",
      },
      cursor: "ns-resize",
    },
    {
      property: "padding-left" as const,
      oppositeProperty: "padding-right" as const,
      axis: "x" as const,
      direction: 1 as const,
      value: paddingLeft,
      left: "var(--design-inline-padding-left-center)",
      top: "50%",
      highlight: {
        top: 0,
        bottom: 0,
        left: 0,
        width: "var(--design-inline-padding-left)",
      },
      cursor: "ew-resize",
    },
  ];
  const spacingRootStyle = {
    "--design-inline-padding-top": `${top}px`,
    "--design-inline-padding-right": `${right}px`,
    "--design-inline-padding-bottom": `${bottom}px`,
    "--design-inline-padding-left": `${left}px`,
    "--design-inline-padding-top-center": `${top / 2}px`,
    "--design-inline-padding-right-center": `${right / 2}px`,
    "--design-inline-padding-bottom-center": `${bottom / 2}px`,
    "--design-inline-padding-left-center": `${left / 2}px`,
  } as React.CSSProperties;
  const gapValue = (region: DesignInlineGapRegion) => {
    const automatic = [
      "space-between",
      "space-around",
      "space-evenly",
    ].includes(details.styles.justifyContent ?? "");
    const main = (details.styles.flexDirection ?? "row").startsWith("column")
      ? "y"
      : "x";
    if (automatic && region.axis === main)
      return region.axis === "x" ? region.width : region.height;
    return region.axis === "x" ? columnGap : rowGap;
  };
  return (
    <>
      {layoutToolsActive ? (
        <span
          data-design-inline-spacing-root=""
          className="pointer-events-none absolute inset-0"
          style={spacingRootStyle}
        >
          {gridColumns.map((segment, index) =>
            segment.end < 100 ? (
              <span
                key={`column:${index}`}
                data-design-grid-track="column"
                className="zd-design-grid-line pointer-events-none absolute top-0 bottom-0 border-l border-dashed"
                style={{
                  left:
                    left + ((overlay.width - left - right) * segment.end) / 100,
                  borderWidth: 1 / zoom,
                }}
              />
            ) : null,
          )}
          {gridColumns.length <= 12
            ? gridColumns.map((segment, index) => (
                <span
                  key={`column-label:${index}`}
                  data-design-grid-track-label="column"
                  className="zd-design-grid-track-label pointer-events-none absolute z-20 rounded-sm border px-1 font-mono whitespace-nowrap"
                  style={{
                    left:
                      left +
                      ((overlay.width - left - right) *
                        ((segment.start + segment.end) / 2)) /
                        100,
                    top,
                    borderWidth: 1 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${14 / zoom}px`,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  {segment.label.replace(/(\.\d{1})\d+(px)$/i, "$1$2")}
                </span>
              ))
            : null}
          {gridRows.map((segment, index) =>
            segment.end < 100 ? (
              <span
                key={`row:${index}`}
                data-design-grid-track="row"
                className="zd-design-grid-line pointer-events-none absolute right-0 left-0 border-t border-dashed"
                style={{
                  top:
                    top + ((overlay.height - top - bottom) * segment.end) / 100,
                  borderWidth: 1 / zoom,
                }}
              />
            ) : null,
          )}
          {gridRows.length <= 12
            ? gridRows.map((segment, index) => (
                <span
                  key={`row-label:${index}`}
                  data-design-grid-track-label="row"
                  className="zd-design-grid-track-label pointer-events-none absolute z-20 rounded-sm border px-1 font-mono whitespace-nowrap"
                  style={{
                    left,
                    top:
                      top +
                      ((overlay.height - top - bottom) *
                        ((segment.start + segment.end) / 2)) /
                        100,
                    borderWidth: 1 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${14 / zoom}px`,
                    transform: "translate(-50%, -50%) rotate(-90deg)",
                  }}
                >
                  {segment.label.replace(/(\.\d{1})\d+(px)$/i, "$1$2")}
                </span>
              ))
            : null}
          {paddingControls.map((control) => (
            <span
              key={control.property}
              data-design-inline-padding-control={control.property}
              className="zd-design-inline-padding-control pointer-events-none absolute inset-0"
            >
              <span
                data-design-inline-spacing-highlight={control.property}
                className="zd-design-inline-spacing-highlight pointer-events-none absolute"
                style={control.highlight}
                aria-hidden="true"
              />
              <button
                data-design-controls
                data-design-inline-spacing={control.property}
                data-design-inline-spacing-axis={control.axis}
                type="button"
                className="zd-design-inline-spacing-handle pointer-events-auto absolute z-30 flex items-center justify-center"
                style={{
                  left: control.left,
                  top: control.top,
                  width: 28 / zoom,
                  height: 20 / zoom,
                  transform: "translate(-50%, -50%)",
                  cursor: control.cursor,
                }}
                aria-label={`Adjust ${control.property}`}
                title={`Drag to adjust ${control.property}. Shift snaps to 10px; Option mirrors the opposite side.`}
                onPointerDown={(event) =>
                  onSpacingPointerDown?.(event, control)
                }
              >
                <span
                  data-design-inline-spacing-line=""
                  className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                  style={{
                    width: (control.axis === "y" ? 14 : 3) / zoom,
                    height: (control.axis === "x" ? 14 : 3) / zoom,
                    borderWidth: 1 / zoom,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-value={control.property}
                  className="zd-design-inline-spacing-value pointer-events-none absolute left-1/2 rounded-sm font-mono font-medium whitespace-nowrap"
                  style={{
                    bottom: `calc(50% + ${5 / zoom}px)`,
                    paddingInline: 4 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${16 / zoom}px`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {Math.round(control.value)}
                </span>
              </button>
            </span>
          ))}
          {gapRegions.map((region) => {
            const value = gapValue(region);
            const { hitRect, visualRect } = designInlineGapGeometry(
              region,
              zoom,
            );
            const childNames = children
              .filter(
                (child) =>
                  child.oid === region.leadingId ||
                  child.oid === region.trailingId,
              )
              .map((child) => child.name);
            return (
              <button
                key={region.key}
                data-design-controls
                data-design-inline-spacing={region.property}
                data-design-inline-spacing-axis={region.axis}
                data-design-inline-gap-region={region.key}
                type="button"
                className="zd-design-inline-gap-handle pointer-events-auto absolute z-20 flex items-center justify-center"
                style={{
                  left: hitRect.x,
                  top: hitRect.y,
                  width: hitRect.width,
                  height: hitRect.height,
                  // A gesture paint may hide a region that momentarily has no
                  // space; naming it here is what lets React reveal it again.
                  visibility: "visible",
                  cursor: region.axis === "x" ? "ew-resize" : "ns-resize",
                }}
                aria-label={`Adjust ${region.property} between ${childNames.join(" and ")}`}
                title="Drag to adjust gap. Shift snaps to 10px."
                onPointerDown={(event) =>
                  onSpacingPointerDown?.(event, {
                    property: region.property,
                    axis: region.axis,
                    direction: 1,
                    value,
                    regionKey: region.key,
                  })
                }
              >
                <span
                  data-design-inline-gap-visual=""
                  data-design-inline-spacing-highlight={region.key}
                  className="zd-design-inline-spacing-highlight pointer-events-none absolute"
                  style={{
                    left: visualRect.x,
                    top: visualRect.y,
                    width: visualRect.width,
                    height: visualRect.height,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-line=""
                  className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                  style={{
                    width: (region.axis === "y" ? 14 : 3) / zoom,
                    height: (region.axis === "x" ? 14 : 3) / zoom,
                    borderWidth: 1 / zoom,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-value={region.property}
                  className="zd-design-inline-spacing-value pointer-events-none absolute left-1/2 rounded-sm font-mono font-medium whitespace-nowrap"
                  style={{
                    bottom: `calc(50% + ${5 / zoom}px)`,
                    paddingInline: 4 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${16 / zoom}px`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {Math.round(value)}
                </span>
              </button>
            );
          })}
        </span>
      ) : null}
      <span
        data-design-selection-size=""
        className="zd-design-selection-label pointer-events-none absolute top-full left-1/2 -translate-x-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
        style={{
          marginTop: designCanvasScreenPixels(4),
          transform: `translateX(-50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
          transformOrigin: "top center",
        }}
      >
        {`${Math.round(overlay.width)} × ${Math.round(overlay.height)}`}
      </span>
    </>
  );
}

export const DesignLayerHoverOverlay = React.memo(function DesignLayerHoverOverlay({
  workspaceId,
  frame,
  sourceVersion,
  selectedNodeIds,
}: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  selectedNodeIds: readonly string[];
}) {
  const details = useDesignRuntimeStore((state) => {
    const workspace = state.byWorkspace[workspaceId];
    if (workspace?.hoveredFrame !== frame || !workspace.hoveredNodeId) {
      return null;
    }
    const hovered =
      workspace.frames[frame]?.detailsByNode[workspace.hoveredNodeId] ?? null;
    if (
      !hovered ||
      hovered.sourceVersion !== sourceVersion ||
      selectedNodeIds.includes(hovered.oid)
    ) {
      return null;
    }
    return hovered;
  });
  if (!details) return null;
  return (
    <div
      data-design-element-overlay={details.oid}
      className="zd-design-hover-outline pointer-events-none absolute z-[1] outline"
      style={{
        ...designSelectionOverlayStyle(
          designSelectionOverlayFrame(designSelectionBox(details)),
        ),
        outlineWidth: designCanvasScreenPixels(1),
      }}
    />
  );
});

export const DesignMotionCanvasOverlay = React.memo(
  function DesignMotionCanvasOverlay({
    owner,
    details,
    draft,
    onSeek,
  }: {
    owner: string;
    details: DesignRuntimeNodeDetails;
    draft: DesignMotionTimelineDraft;
    onSeek: (offset: number) => void;
  }) {
    const playhead = useDesignMotionPlayhead(owner);
    const pathPoints = useMemo(
      () => designMotionTranslationPoints(draft.keyframes),
      [draft.keyframes],
    );
    const currentTranslation = designMotionTranslationAtOffset(
      draft.keyframes,
      playhead,
    );
    const properties = useMemo(
      () => designMotionProperties(draft.keyframes),
      [draft.keyframes],
    );
    const duration = useMemo(
      () => designDurationMs(draft.duration),
      [draft.duration],
    );
    const center = useMemo(
      () => ({
        x: details.rect.width / 2,
        y: details.rect.height / 2,
      }),
      [details.rect.height, details.rect.width],
    );
    return (
      <>
        <div
          data-design-motion-inline-toolbar=""
          className="zd-design-motion-inline-toolbar pointer-events-none absolute top-0 right-0 z-30 flex items-center gap-1 rounded-sm border px-1.5 py-0.5 shadow-sm"
          style={{
            marginTop: designCanvasScreenPixels(4),
            marginRight: designCanvasScreenPixels(4),
            transform: `scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
            transformOrigin: "top right",
          }}
        >
          <Diamond className="size-2.5 fill-current" />
          <span className="text-[9px] font-medium whitespace-nowrap">
            {properties.length} {properties.length === 1 ? "track" : "tracks"}
          </span>
          <span className="font-mono text-[9px] opacity-75">
            {designMotionTimeAtOffset(playhead, duration)}ms
          </span>
        </div>
        {pathPoints.length > 1 ? (
          <>
            <svg
              data-design-motion-path=""
              aria-hidden="true"
              className="pointer-events-none absolute overflow-visible"
              style={{ left: center.x, top: center.y, width: 1, height: 1 }}
            >
              <polyline
                className="zd-design-motion-path-line"
                points={pathPoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                fill="none"
                style={{
                  strokeWidth: designCanvasScreenPixels(2),
                  strokeDasharray: `${designCanvasScreenPixels(5)} ${designCanvasScreenPixels(3)}`,
                }}
              />
            </svg>
            {pathPoints.map((point) => {
              const selected = Math.abs(point.offset - playhead) < 0.05;
              return (
                <button
                  key={point.offset}
                  data-design-controls
                  data-design-motion-path-point={point.offset}
                  type="button"
                  className={cn(
                    "zd-design-motion-path-point pointer-events-auto absolute z-30 rounded-full border shadow-sm",
                    selected && "zd-design-motion-path-point-selected",
                  )}
                  style={{
                    left: center.x + point.x,
                    top: center.y + point.y,
                    width: designCanvasScreenPixels(12),
                    height: designCanvasScreenPixels(12),
                    borderWidth: designCanvasScreenPixels(1),
                    transform: "translate(-50%, -50%)",
                  }}
                  aria-label={`Seek motion to ${designMotionTimeAtOffset(point.offset, duration)}ms`}
                  aria-pressed={selected}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSeek(point.offset);
                  }}
                />
              );
            })}
            {currentTranslation ? (
              <span
                data-design-motion-current-point=""
                className="zd-design-motion-current-point pointer-events-none absolute z-20 rounded-full"
                style={{
                  left: center.x + currentTranslation.x,
                  top: center.y + currentTranslation.y,
                  width: designCanvasScreenPixels(5),
                  height: designCanvasScreenPixels(5),
                  transform: "translate(-50%, -50%)",
                }}
              />
            ) : null}
          </>
        ) : null}
      </>
    );
  },
);
