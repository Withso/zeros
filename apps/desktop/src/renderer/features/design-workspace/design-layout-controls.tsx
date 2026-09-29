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
} from "lucide-react";
import type {
  DesignRuntimeChildrenLayout,
  DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import {
  Tooltip,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { InspectorIconButton, InspectorSelect } from "./design-inspector-kit";
import {
  designLayoutFieldValue,
  type DesignLayoutAction,
  type DesignLayoutAxis,
  type DesignLayoutConstraint,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";

type RenderField = (
  label: string,
  property: string,
  value: string,
  options?: DesignLayoutFieldOptions,
) => React.ReactNode;

/** These arrange the selected container's direct children, so the tooltip
 * says so; the accessible names stay the familiar align commands. */
const ALIGNMENTS = [
  [
    "x",
    "start",
    "Align left",
    "Align children left",
    AlignHorizontalJustifyStart,
  ],
  [
    "x",
    "center",
    "Align horizontal centers",
    "Align children to horizontal centers",
    AlignHorizontalJustifyCenter,
  ],
  [
    "x",
    "end",
    "Align right",
    "Align children right",
    AlignHorizontalJustifyEnd,
  ],
  ["y", "start", "Align top", "Align children top", AlignVerticalJustifyStart],
  [
    "y",
    "center",
    "Align vertical centers",
    "Align children to vertical centers",
    AlignVerticalJustifyCenter,
  ],
  [
    "y",
    "end",
    "Align bottom",
    "Align children bottom",
    AlignVerticalJustifyEnd,
  ],
] as const;

/** Position, size, rotation and quarter-turn/flip actions. Three columns at
 * normal widths; the container query in design-workspace-ui.css reflows the
 * rotation cells onto a third row in narrow inspectors. */
export function DesignLayoutGeometry({
  details,
  renderField,
  onAction,
  disabled,
  renderSize,
}: {
  details: DesignRuntimeNodeDetails;
  renderField: RenderField;
  onAction: (action: DesignLayoutAction) => void;
  disabled: boolean;
  renderSize?: (
    axis: DesignLayoutAxis,
    field: React.ReactNode,
  ) => React.ReactNode;
}) {
  const field = (label: string, property: string) =>
    renderField(label, property, designLayoutFieldValue(details, property), {
      whole: true,
      compact: true,
      geometry: true,
    });
  return (
    <div
      data-design-layout-geometry
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(72px,1fr)] gap-2"
    >
      {field("X", "left")}
      {field("Y", "top")}
      {field("Rotation", "rotate")}
      {renderSize ? renderSize("x", field("W", "width")) : field("W", "width")}
      {renderSize
        ? renderSize("y", field("H", "height"))
        : field("H", "height")}
      <div
        className="zd-segmented grid-cols-3"
        role="group"
        aria-label="Rotate and flip"
      >
        {(
          [
            ["Rotate 90° clockwise", RotateCw, { type: "rotate", delta: 90 }],
            ["Flip horizontal", FlipHorizontal, { type: "flip", axis: "x" }],
            ["Flip vertical", FlipVertical, { type: "flip", axis: "y" }],
          ] as const
        ).map(([label, Icon, action]) => (
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
  );
}

/** Free-layout arrangement for a container's direct children: align,
 * distribute, resize to fit/fill, and the shared constraint pins. */
export function DesignLayoutChildren({
  details,
  onAction,
  disabled,
  frameSelected,
  childrenLayout = details.childrenLayout,
  canDistribute = (childrenLayout?.nodeIds.length ?? 0) >= 3,
}: {
  details: DesignRuntimeNodeDetails;
  onAction: (action: DesignLayoutAction) => void;
  disabled: boolean;
  frameSelected?: boolean;
  childrenLayout?: DesignRuntimeChildrenLayout;
  canDistribute?: boolean;
}) {
  const x = childrenLayout?.x ?? "start";
  const y = childrenLayout?.y ?? "start";
  if ((childrenLayout?.count ?? 0) === 0) return null;
  const unavailable = childrenLayout?.truncated
    ? "Select a smaller frame to arrange its children together"
    : childrenLayout?.nodeIds.length === 0
      ? "Show a child layer to arrange it"
      : null;
  const pinDisabled = disabled || Boolean(unavailable);
  const pin = (
    axis: DesignLayoutAxis,
    value: "start" | "end",
    additive: boolean,
  ) => {
    onAction({ type: "constraint", axis, value, pin: additive });
  };
  const alignButton = ([
    axis,
    value,
    label,
    tooltip,
    Icon,
  ]: (typeof ALIGNMENTS)[number]) => (
    <Tooltip key={label} label={unavailable ?? tooltip}>
      <button
        type="button"
        className="zd-segment"
        aria-label={label}
        disabled={pinDisabled}
        onClick={() => onAction({ type: "align", axis, value })}
      >
        <Icon />
      </button>
    </Tooltip>
  );
  return (
    <>
      <div
        role="group"
        aria-label="Arrange children"
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-2"
      >
        <div className="zd-segmented grid-cols-3">
          {ALIGNMENTS.slice(0, 3).map(alignButton)}
        </div>
        <div className="zd-segmented grid-cols-3">
          {ALIGNMENTS.slice(3).map(alignButton)}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <InspectorIconButton
              label="More layout actions"
              tooltip={unavailable ?? "More layout actions"}
              size="row"
              disabled={pinDisabled}
            >
              <Ellipsis />
            </InspectorIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!canDistribute}
              onSelect={() => onAction({ type: "distribute", axis: "y" })}
            >
              <AlignVerticalDistributeCenter /> Distribute vertically
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canDistribute}
              onSelect={() => onAction({ type: "distribute", axis: "x" })}
            >
              <AlignHorizontalDistributeCenter /> Distribute horizontally
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={frameSelected || !details.layout?.parentId}
              onSelect={() => onAction({ type: "resize-fill" })}
            >
              <Maximize /> Resize to fill
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ type: "resize-fit" })}>
              <Minimize /> Resize to fit
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        data-design-layout-constraints
        className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2"
      >
        <div
          role="group"
          aria-label="Constraint pins"
          className="zd-constraint-pad relative grid size-16 grid-cols-3 grid-rows-3 rounded-md"
        >
          <span
            aria-hidden="true"
            className="zd-constraint-box pointer-events-none absolute inset-[18px] rounded-sm"
          />
          {(
            [
              ["x", "start", "left", "col-start-1 row-start-2", x],
              ["x", "end", "right", "col-start-3 row-start-2", x],
              ["y", "start", "top", "col-start-2 row-start-1", y],
              ["y", "end", "bottom", "col-start-2 row-start-3", y],
            ] as const
          ).map(([axis, value, label, position, current]) => {
            const pinned = current === value || current === "stretch";
            return (
              <Tooltip key={label} label={`Pin ${label}`}>
                <button
                  type="button"
                  className={cn("zd-constraint-pin", position)}
                  aria-label={`Pin ${label}`}
                  aria-pressed={pinned}
                  disabled={pinDisabled}
                  onClick={(event) => pin(axis, value, event.shiftKey)}
                >
                  <span
                    className={cn(
                      "rounded-full bg-current",
                      axis === "x" ? "h-0.5 w-2.5" : "h-2.5 w-0.5",
                    )}
                  />
                </button>
              </Tooltip>
            );
          })}
          <Tooltip label="Pin center">
            <button
              type="button"
              className="zd-constraint-pin col-start-2 row-start-2"
              aria-label="Pin center"
              aria-pressed={x === "center" && y === "center"}
              disabled={pinDisabled}
              onClick={() => onAction({ type: "center" })}
            >
              <span className="relative flex size-2.5 items-center justify-center">
                <span
                  className={cn(
                    "absolute h-0.5 w-2.5 rounded-full bg-current",
                    x === "center" && "zd-constraint-pin-on",
                  )}
                />
                <span
                  className={cn(
                    "absolute h-2.5 w-0.5 rounded-full bg-current",
                    y === "center" && "zd-constraint-pin-on",
                  )}
                />
              </span>
            </button>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {(["x", "y"] as const).map((axis) => {
            const value = axis === "x" ? x : y;
            return (
              <InspectorSelect
                key={axis}
                label={
                  axis === "x" ? "Horizontal constraint" : "Vertical constraint"
                }
                value={value}
                disabled={pinDisabled}
                options={[
                  ...(value === "mixed"
                    ? [{ value: "mixed", label: "Mixed", disabled: true }]
                    : []),
                  { value: "start", label: axis === "x" ? "Left" : "Top" },
                  { value: "center", label: "Center" },
                  { value: "end", label: axis === "x" ? "Right" : "Bottom" },
                  {
                    value: "stretch",
                    label: axis === "x" ? "Left and right" : "Top and bottom",
                  },
                ]}
                onChange={(next) =>
                  onAction({
                    type: "constraint",
                    axis,
                    value: next as DesignLayoutConstraint,
                  })
                }
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
