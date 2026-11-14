import React from "react";
import {
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Ellipsis,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Maximize,
  Minimize,
  Shrink,
} from "lucide-react";
import type {
  DesignRuntimeChildrenLayout,
  DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";

import { cn } from "../../shared/ui/cn";
import {
  Tooltip,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../../shared/ui/primitives";
import {
  InspectorCheckboxRow,
  InspectorIconButton,
  InspectorSection,
  InspectorSelect,
} from "./design-inspector-kit";
import {
  designLayoutAbsolutePosition,
  designLayoutConstraint,
  designLayoutFieldValue,
  designLayoutPlacedByParent,
  type DesignLayoutAction,
  type DesignLayoutAxis,
  type DesignLayoutConstraint,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import { designAutoLayoutFlow } from "./design-auto-layout-values";
import { readDesignComputedStyle } from "./design-style-values";

type RenderField = (
  label: string,
  property: string,
  value: string,
  options?: DesignLayoutFieldOptions,
) => React.ReactNode;

const ALIGNMENTS = [
  ["x", "start", "Align left", AlignHorizontalJustifyStart],
  ["x", "center", "Align horizontal centers", AlignHorizontalJustifyCenter],
  ["x", "end", "Align right", AlignHorizontalJustifyEnd],
  ["y", "start", "Align top", AlignVerticalJustifyStart],
  ["y", "center", "Align vertical centers", AlignVerticalJustifyCenter],
  ["y", "end", "Align bottom", AlignVerticalJustifyEnd],
] as const;

const ROTATE_AND_FLIP = [
  ["Rotate 90° clockwise", RotateCw, { type: "rotate", delta: 90 }],
  ["Flip horizontal", FlipHorizontal, { type: "flip", axis: "x" }],
  ["Flip vertical", FlipVertical, { type: "flip", axis: "y" }],
] as const;

const CONSTRAINT_LABELS: Record<
  DesignLayoutAxis,
  Record<Exclude<DesignLayoutConstraint, "stretch">, string> & { stretch: string }
> = {
  x: { start: "Left", end: "Right", center: "Center", stretch: "Left and right", scale: "Scale" },
  y: { start: "Top", end: "Bottom", center: "Center", stretch: "Top and bottom", scale: "Scale" },
};

const CONSTRAINT_ORDER: readonly DesignLayoutConstraint[] = [
  "start",
  "end",
  "center",
  "stretch",
  "scale",
];

/** One shared value for a multi-selection, else "mixed". */
function shared<T>(values: readonly T[]): T | "mixed" {
  const [first] = values;
  return values.every((value) => value === first) ? (first as T) : "mixed";
}

function PinnedEdges({
  x,
  y,
}: {
  x: DesignLayoutConstraint | "mixed";
  y: DesignLayoutConstraint | "mixed";
}) {
  // Which parent edges the layer keeps its distance from; Scale keeps none
  // fixed, so its pins show at both ends as shares of the parent.
  const on = (axis: DesignLayoutAxis, side: "start" | "end" | "center") => {
    const value = axis === "x" ? x : y;
    if (value === "mixed") return false;
    if (side === "center") return value === "center";
    return value === side || value === "stretch" || value === "scale";
  };
  const pinned = [
    on("x", "start") && "left",
    on("x", "end") && "right",
    on("y", "start") && "top",
    on("y", "end") && "bottom",
    (on("x", "center") || on("y", "center")) && "center",
  ].filter(Boolean);
  return (
    <div
      role="img"
      aria-label={`Pinned edges: ${pinned.length ? pinned.join(", ") : "none"}`}
      className="zd-constraint-pad relative grid size-16 shrink-0 grid-cols-3 grid-rows-3 rounded-lg"
    >
      <span
        aria-hidden="true"
        className="zd-constraint-box pointer-events-none absolute inset-5 rounded-sm"
      />
      {(
        [
          ["x", "start", "col-start-1 row-start-2"],
          ["x", "end", "col-start-3 row-start-2"],
          ["y", "start", "col-start-2 row-start-1"],
          ["y", "end", "col-start-2 row-start-3"],
        ] as const
      ).map(([axis, side, position]) => (
        <span
          key={`${axis}:${side}`}
          aria-hidden="true"
          className={cn(
            "zd-constraint-pin",
            position,
            on(axis, side) && "zd-constraint-pin-on",
          )}
        >
          <span
            className={cn(
              "rounded-full bg-current",
              axis === "x" ? "h-0.5 w-2.5" : "h-2.5 w-0.5",
            )}
          />
        </span>
      ))}
      <span
        aria-hidden="true"
        className="zd-constraint-pin col-start-2 row-start-2"
      >
        <span className="relative flex size-2.5 items-center justify-center">
          <span
            className={cn(
              "absolute h-0.5 w-2.5 rounded-full bg-current",
              on("x", "center") && "zd-constraint-pin-on",
            )}
          />
          <span
            className={cn(
              "absolute h-2.5 w-0.5 rounded-full bg-current",
              on("y", "center") && "zd-constraint-pin-on",
            )}
          />
        </span>
      </span>
    </div>
  );
}

/** Position: where the selected layer sits and what it keeps when its parent
 * resizes. Every action acts on the selected layers themselves; a layer of an
 * auto layout parent offers Absolute position, and its X and Y lock while
 * auto layout places it. */
export function DesignPositionSection({
  details,
  renderField,
  onAction,
  disabled,
  frameSelected,
  layoutParents,
}: {
  details: DesignRuntimeNodeDetails;
  renderField: RenderField;
  onAction: (action: DesignLayoutAction) => void;
  disabled: boolean;
  /** The frame's root: the canvas places it, so it has no pins. */
  frameSelected?: boolean;
  layoutParents?: readonly DesignRuntimeNodeDetails[];
}) {
  const selection = layoutParents?.length ? layoutParents : [details];
  const placed = !frameSelected && selection.some(designLayoutPlacedByParent);
  const free = !frameSelected && !placed && selection.every((node) => node.layout?.parentId);
  const absolute = frameSelected ? null : designLayoutAbsolutePosition(selection);
  const field = (label: string, property: string, extra: DesignLayoutFieldOptions = {}) =>
    renderField(label, property, designLayoutFieldValue(details, property), {
      whole: true,
      compact: true,
      geometry: true,
      ...extra,
    });
  const x = shared(selection.map((node) => designLayoutConstraint(node, "x")));
  const y = shared(selection.map((node) => designLayoutConstraint(node, "y")));
  // Fit to content sizes a free-layout container to its children; with auto
  // layout, Hug does that.
  const fits =
    (details.childrenLayout?.count ?? 0) > 0 && designAutoLayoutFlow(details) === "none";
  return (
    <InspectorSection
      title="Position"
      data-design-position-section=""
      actions={
        fits ? (
          <InspectorIconButton
            label="Fit to content"
            tooltip="Fit to content"
            disabled={disabled}
            onClick={() => onAction({ type: "resize-fit" })}
          >
            <Shrink />
          </InspectorIconButton>
        ) : null
      }
    >
      {absolute ? (
        <div
          data-design-position-absolute={absolute}
          {...(absolute === "off" ? { "data-design-position-placed": "" } : {})}
        >
          <InspectorCheckboxRow
            label="Absolute position"
            checked={absolute === "on"}
            mixed={absolute === "mixed"}
            disabled={disabled}
            title={absolute === "on"
              ? "Placed freely. Untick to let the parent's auto layout place it."
              : "Placed by its parent's auto layout. Tick to place it freely."}
            onChange={() => onAction({ type: absolute === "on" ? "join-auto-layout" : "place-freely" })}
          />
        </div>
      ) : null}
      {free ? (
        <div
          data-design-position-align=""
          className="grid grid-cols-2 gap-2"
        >
          {(["x", "y"] as const).map((axis) => (
            <div
              key={axis}
              role="group"
              aria-label={axis === "x" ? "Align horizontally" : "Align vertically"}
              className="zd-segmented grid-cols-3"
            >
              {ALIGNMENTS.filter(([alignAxis]) => alignAxis === axis).map(
                ([, value, label, Icon]) => (
                  <Tooltip key={label} label={label}>
                    <button
                      type="button"
                      className="zd-segment"
                      aria-label={label}
                      disabled={disabled}
                      onClick={() =>
                        onAction({ type: "align", axis, value, target: "self" })
                      }
                    >
                      <Icon />
                    </button>
                  </Tooltip>
                ),
              )}
            </div>
          ))}
        </div>
      ) : null}
      <div
        data-design-layout-geometry=""
        className="grid grid-cols-2 gap-2"
      >
        {field("X", "left", placed ? { disabled: true } : {})}
        {field("Y", "top", placed ? { disabled: true } : {})}
        {field("Rotation", "rotate")}
        <div
          className="zd-segmented grid-cols-3"
          role="group"
          aria-label="Rotate and flip"
        >
          {ROTATE_AND_FLIP.map(([label, Icon, action]) => (
            <Tooltip key={label} label={label}>
              <button
                type="button"
                className="zd-segment"
                aria-label={label}
                disabled={disabled}
                onClick={() => onAction(action)}
              >
                <Icon />
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
      {free ? (
        <div
          data-design-layout-constraints=""
          className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2"
        >
          <PinnedEdges x={x} y={y} />
          <div className="flex min-w-0 flex-col gap-2">
            {(["x", "y"] as const).map((axis) => {
              const value = axis === "x" ? x : y;
              return (
                <InspectorSelect
                  key={axis}
                  label={axis === "x" ? "Horizontal constraint" : "Vertical constraint"}
                  value={value}
                  disabled={disabled}
                  options={[
                    ...(value === "mixed"
                      ? [{ value: "mixed", label: "Mixed", disabled: true }]
                      : []),
                    ...CONSTRAINT_ORDER.map((constraint) => ({
                      value: constraint,
                      label: CONSTRAINT_LABELS[axis][constraint],
                    })),
                  ]}
                  onChange={(next) =>
                    onAction({
                      type: "constraint",
                      axis,
                      value: next as DesignLayoutConstraint,
                      target: "self",
                    })
                  }
                />
              );
            })}
          </div>
        </div>
      ) : null}
      {free
        ? renderField(
            "Stacking order",
            "z-index",
            readDesignComputedStyle(details.styles, "z-index") || "auto",
            { compact: true, whole: true, shortLabel: "Z" },
          )
        : null}
    </InspectorSection>
  );
}

/** Layout's ⋯ menu: what acts on the selected container's children (align,
 * distribute, resize to fit) and Resize to fill on the layer itself. */
export function DesignLayoutArrangeMenu({
  details,
  onAction,
  disabled,
  frameSelected,
  autoLayout,
  childrenLayout = details.childrenLayout,
  canDistribute = (childrenLayout?.nodeIds.length ?? 0) >= 3,
}: {
  details: DesignRuntimeNodeDetails;
  onAction: (action: DesignLayoutAction) => void;
  disabled: boolean;
  frameSelected?: boolean;
  autoLayout: boolean;
  childrenLayout?: DesignRuntimeChildrenLayout;
  canDistribute?: boolean;
}) {
  // Auto layout already places the children; aligning them by hand there is
  // the Alignment pad's job, and Hug sizes the container to them.
  const showChildren = (childrenLayout?.count ?? 0) > 0 && !autoLayout;
  const fillable = !frameSelected && !!details.layout?.parentId;
  // A canvas frame has nothing to fill; beside its children's actions the
  // item stays, disabled, so the menu reads the same for every container.
  if (!showChildren && !fillable) return null;
  const unavailable = childrenLayout?.truncated
    ? "Select a smaller frame to arrange its children together"
    : showChildren && childrenLayout?.nodeIds.length === 0
      ? "Show a child layer to arrange it"
      : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InspectorIconButton
          label="More layout actions"
          tooltip={unavailable ?? "Arrange"}
          disabled={disabled}
        >
          <Ellipsis />
        </InspectorIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {showChildren ? (
          <>
            <DropdownMenuLabel>Children</DropdownMenuLabel>
            {ALIGNMENTS.map(([axis, value, label, Icon]) => (
              <DropdownMenuItem
                key={label}
                disabled={Boolean(unavailable)}
                onSelect={() => onAction({ type: "align", axis, value })}
              >
                <Icon />
                {label.replace("Align ", "Align children ")}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={Boolean(unavailable) || !canDistribute}
              onSelect={() => onAction({ type: "distribute", axis: "y" })}
            >
              <AlignVerticalDistributeCenter /> Distribute vertically
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={Boolean(unavailable) || !canDistribute}
              onSelect={() => onAction({ type: "distribute", axis: "x" })}
            >
              <AlignHorizontalDistributeCenter /> Distribute horizontally
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={Boolean(unavailable)}
              onSelect={() => onAction({ type: "resize-fit" })}
            >
              <Minimize /> Resize to fit
            </DropdownMenuItem>
          </>
        ) : null}
        {fillable || showChildren ? (
          <>
            {showChildren ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={!fillable}
              onSelect={() => onAction({ type: "resize-fill" })}
            >
              <Maximize /> Resize to fill
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
