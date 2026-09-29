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
  designMeasureSpacing,
  designOriginTranslationShift,
  designRotationCursor,
  designSelectionBox,
  designSelectionOverlayFrame,
  type DesignCanvasRect,
  type DesignConstraintSide,
  type DesignConstraintSides,
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
  designMotionTimeAtOffset,
  designMotionTranslationAtOffset,
  designMotionTranslationPoints,
} from "./design-motion-values";
import {
  DesignLayoutTools,
  type DesignLayoutSpacingControl,
  type DesignLayoutToolsProps,
} from "./design-layout-tools-overlay";
import {
  designSizeBadgeText,
  type DesignSizeBadgeMode,
} from "./design-layout-tools";
import { designBackgroundWork } from "./state/design-background-work";
import {
  publishDesignLayoutToolsLive,
  readDesignLayoutToolsLive,
  type DesignLayoutToolsLiveGeometry,
} from "./state/design-layout-tools-live";
import { designLivePreviewValue } from "./state/design-live-preview";
import { useDesignMotionPlayhead } from "./state/design-motion-playhead";
import { useDesignRuntimeStore } from "./state/design-runtime-store";

export function frameGeometry(
  frame: DesignCanvasFrameWire,
): DesignFrameGeometryWire {
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
export function paintDesignLabelText(
  element: HTMLElement | null,
  text: string,
): void {
  if (!element) return;
  const first = element.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE && !first.nextSibling) {
    if (first.nodeValue !== text) first.nodeValue = text;
    return;
  }
  element.textContent = text;
}

/** The sizing modes a badge was rendered with (`fixed,hug`), so a gesture
 * repaint keeps its Hug/Fill words. */
function designSizeBadgeModesOf(
  element: HTMLElement | null,
): { x?: DesignSizeBadgeMode; y?: DesignSizeBadgeMode } | undefined {
  const value = element?.dataset.designSizeModes;
  if (!value) return undefined;
  const [x, y] = value.split(",") as DesignSizeBadgeMode[];
  return { x, y };
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
  const size = element.querySelector<HTMLElement>(
    "[data-design-selection-size]",
  );
  paintDesignLabelText(
    size,
    designSizeBadgeText(
      overlay.width,
      overlay.height,
      designSizeBadgeModesOf(size),
    ),
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
 * constraint, in the properties HTML actually has — plus a short marker on a
 * Center axis and a dotted outline of the parent they are measured against.
 * They live in frame space rather than inside the rotated overlay, because a
 * constraint describes where the box is anchored, not which way the element
 * faces. The run spans render even at zero length (hidden) so gesture paints
 * can reveal them. */
export function DesignConstraintGuides({
  nodeId,
  bounds,
  parentRect,
  outlineRect,
  sides,
}: {
  nodeId: string;
  bounds: DesignCanvasRect;
  /** The reference box insets are measured from (the parent's padding box). */
  parentRect: DesignCanvasRect;
  /** The parent's own box, outlined while its child is pinned to it. */
  outlineRect?: DesignCanvasRect;
  sides: DesignConstraintSides;
}) {
  const guides = designConstraintGuides(bounds, parentRect, sides);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
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
      {outlineRect ? (
        <span
          data-design-constraint-parent=""
          className="zd-design-constraint-parent absolute"
          style={{
            left: outlineRect.x,
            top: outlineRect.y,
            width: outlineRect.width,
            height: outlineRect.height,
            outlineWidth: designCanvasScreenPixels(1),
          }}
        />
      ) : null}
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
      {sides.center?.x ? (
        <span
          data-design-parent-guide="center-x"
          className="zd-design-parent-guide absolute border-t border-dashed"
          style={{
            left: `calc(${centerX}px - ${designCanvasScreenPixels(6)})`,
            top: centerY,
            width: designCanvasScreenPixels(12),
            height: 0,
            borderTopWidth: designCanvasScreenPixels(1),
          }}
        />
      ) : null}
      {sides.center?.y ? (
        <span
          data-design-parent-guide="center-y"
          className="zd-design-parent-guide absolute border-l border-dashed"
          style={{
            left: centerX,
            top: `calc(${centerY}px - ${designCanvasScreenPixels(6)})`,
            width: 0,
            height: designCanvasScreenPixels(12),
            borderLeftWidth: designCanvasScreenPixels(1),
          }}
        />
      ) : null}
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
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const markX = guides.querySelector<HTMLElement>(
    '[data-design-parent-guide="center-x"]',
  );
  if (markX) {
    markX.style.left = `calc(${centerX}px - ${designCanvasScreenPixels(6)})`;
    markX.style.top = `${centerY}px`;
  }
  const markY = guides.querySelector<HTMLElement>(
    '[data-design-parent-guide="center-y"]',
  );
  if (markY) {
    markY.style.left = `${centerX}px`;
    markY.style.top = `calc(${centerY}px - ${designCanvasScreenPixels(6)})`;
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
              className="bg-red-primary text-2xxs absolute rounded-sm px-1 leading-4 font-medium whitespace-nowrap text-[var(--design-selection-label-fg)] tabular-nums"
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
  onEdgeDoubleClick,
}: {
  label: string;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: DesignResizeHandle,
  ) => void;
  /** Double-clicking an edge sizes its axis to Hug (Option: Fill). */
  onEdgeDoubleClick?: (handle: DesignResizeHandle, fill: boolean) => void;
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
            onDoubleClick={(event) => {
              if (!onEdgeDoubleClick) return;
              event.preventDefault();
              event.stopPropagation();
              onEdgeDoubleClick(handle, event.altKey);
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
  /** Untransformed box in the parent's padding box (turned parents only). */
  local?: DesignCanvasRect;
  hidden?: boolean;
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

/** One canvas spacing value; see `DesignLayoutSpacingControl`. */
export type DesignInlineSpacingControl = DesignLayoutSpacingControl;

export interface DesignMotionOverlayState {
  owner: string;
  draft: DesignMotionTimelineDraft | null;
}

/** The live-store key a mounted layout-tools island reads from. */
function layoutToolsKeyOf(root: HTMLElement | null): string | null {
  return root?.dataset.designLayoutToolsKey ?? null;
}

function liveGeometryOf(
  details: DesignPaintedNode & { box?: DesignSelectionBox },
): DesignLayoutToolsLiveGeometry {
  return { rect: details.rect, box: details.box, styles: details.styles };
}

/** Repaint an owner's gap tools from a measurement of it and its children. */
export function paintDesignInlineGapHandles(
  root: HTMLElement | null,
  containerDetails: DesignPaintedNode & { box?: DesignSelectionBox },
  childDetails: readonly DesignPaintedChild[],
  _zoom?: number,
): void {
  const key = layoutToolsKeyOf(root);
  if (!key) return;
  publishDesignLayoutToolsLive(key, {
    geometry: { ...liveGeometryOf(containerDetails), children: childDetails },
  });
}

/** Repaint an owner's padding bands (and the tools' size) from a measurement
 * of the owner alone; its children keep their last measurement. */
export function paintDesignInlinePaddingGeometry(
  root: HTMLElement | null,
  details: DesignPaintedNode & { box?: DesignSelectionBox },
): void {
  const key = layoutToolsKeyOf(root);
  if (!key) return;
  const children = readDesignLayoutToolsLive(key)?.geometry?.children;
  publishDesignLayoutToolsLive(key, {
    geometry: {
      ...liveGeometryOf(details),
      ...(children ? { children } : {}),
    },
  });
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
  // Element overlays and the frame's own layout owner both carry the owner
  // attribute, so inspector previews repaint a selected frame root as well.
  return (
    frameElement?.querySelector<HTMLElement>(
      `[data-design-layout-owner="${CSS.escape(nodeId)}"]`,
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
    "[data-design-frame-size-badge]",
  );
  paintDesignLabelText(
    size,
    designSizeBadgeText(geometry.w, geometry.h, designSizeBadgeModesOf(size)),
  );
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

/** The selected owner's canvas layout tools and its size badge. */
export function DesignSelectionMeasurements({
  ownerKey,
  details,
  children,
  zoom,
  showSize = true,
  sizeModes,
  sizeWidth,
  sizeHeight,
  onSpacingPointerDown,
  onSpacingCommit,
}: {
  ownerKey: string;
  details: DesignPaintedNode & { box?: DesignSelectionBox };
  children: readonly DesignPaintedChild[];
  zoom: number;
  /** A multi-selection labels only its group bounds. */
  showSize?: boolean;
  sizeModes?: { x?: DesignSizeBadgeMode; y?: DesignSizeBadgeMode };
  /** Painted border-box size the badge reads. */
  sizeWidth: number;
  sizeHeight: number;
  onSpacingPointerDown?: DesignLayoutToolsProps["onSpacingPointerDown"];
  onSpacingCommit?: DesignLayoutToolsProps["onSpacingCommit"];
}) {
  return (
    <>
      {onSpacingPointerDown ? (
        <DesignLayoutTools
          ownerKey={ownerKey}
          details={details}
          children={children}
          zoom={zoom}
          onSpacingPointerDown={onSpacingPointerDown}
          onSpacingCommit={onSpacingCommit}
        />
      ) : null}
      {showSize ? (
        <span
          data-design-selection-size=""
          data-design-size-modes={
            sizeModes
              ? `${sizeModes.x ?? "fixed"},${sizeModes.y ?? "fixed"}`
              : undefined
          }
          className="zd-design-selection-label text-2xxs pointer-events-none absolute top-full left-1/2 -translate-x-1/2 rounded-sm px-1.5 py-0.5 leading-4 font-medium whitespace-nowrap tabular-nums"
          style={{
            marginTop: designCanvasScreenPixels(4),
            transform: `translateX(-50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
            transformOrigin: "top center",
          }}
        >
          {designSizeBadgeText(sizeWidth, sizeHeight, sizeModes)}
        </span>
      ) : null}
    </>
  );
}

export const DesignLayerHoverOverlay = React.memo(
  function DesignLayerHoverOverlay({
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
  },
);

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
          <span className="text-2xxs font-medium whitespace-nowrap tabular-nums">
            {designMotionTimeAtOffset(playhead, duration)} ms
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
