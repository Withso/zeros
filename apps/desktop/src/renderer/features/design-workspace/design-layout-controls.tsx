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
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  designLayoutFieldValue,
  type DesignLayoutAction,
  type DesignLayoutAxis,
  type DesignLayoutConstraint,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";

const ALIGNMENTS = [
  ["x", "start", "Align left", AlignHorizontalJustifyStart],
  ["x", "center", "Align horizontal centers", AlignHorizontalJustifyCenter],
  ["x", "end", "Align right", AlignHorizontalJustifyEnd],
  ["y", "start", "Align top", AlignVerticalJustifyStart],
  ["y", "center", "Align vertical centers", AlignVerticalJustifyCenter],
  ["y", "end", "Align bottom", AlignVerticalJustifyEnd],
] as const;

export function DesignLayoutControls({
  details,
  renderField,
  onAction,
  disabled,
  frameSelected,
  childrenLayout = details.childrenLayout,
  canDistribute = (childrenLayout?.nodeIds.length ?? 0) >= 3,
}: {
  details: DesignRuntimeNodeDetails;
  renderField: (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => React.ReactNode;
  onAction: (action: DesignLayoutAction) => void;
  disabled: boolean;
  frameSelected?: boolean;
  childrenLayout?: DesignRuntimeChildrenLayout;
  canDistribute?: boolean;
}) {
  const x = childrenLayout?.x ?? "start";
  const y = childrenLayout?.y ?? "start";
  const hasChildren = (childrenLayout?.count ?? 0) > 0;
  const unavailable = childrenLayout?.truncated
    ? "Select a smaller frame to arrange its children together"
    : childrenLayout?.nodeIds.length === 0
      ? "Show a child layer to arrange it"
      : null;
  const clipped = [
    details.styles.overflowX,
    details.styles.overflowY,
    details.styles.overflow,
  ].some((value) => value === "hidden" || value === "clip");
  const pinDisabled = disabled || Boolean(unavailable);
  const field = (label: string, property: string) =>
    renderField(label, property, designLayoutFieldValue(details, property), {
      whole: true,
      compact: true,
      geometry: true,
    });
  const pin = (
    axis: DesignLayoutAxis,
    value: "start" | "end",
    additive: boolean,
  ) => {
    onAction({ type: "constraint", axis, value, pin: additive });
  };
  return (
    <div data-design-layout-controls className="flex flex-col gap-2">
      <div
        data-design-layout-geometry
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(72px,1fr)] gap-2"
      >
        {field("X", "left")}
        {field("Y", "top")}
        {field("Rotation", "rotate")}
        {field("W", "width")}
        {field("H", "height")}
        <div
          className="bg-bg2 grid h-7 min-w-0 grid-cols-3 overflow-hidden rounded-md"
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
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="border-border1 h-7 w-full min-w-0 rounded-none border-l first:border-l-0 [&>svg]:size-3.5"
                aria-label={label}
                disabled={disabled}
                onClick={() => onAction(action)}
              >
                <Icon />
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
      {hasChildren ? (
        <div
          role="group"
          aria-label="Arrange children"
          className="grid grid-cols-7 gap-1"
        >
          {ALIGNMENTS.map(([axis, value, label, Icon]) => (
            <Tooltip key={label} label={unavailable ?? label}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-full min-w-0"
                aria-label={label}
                disabled={pinDisabled}
                onClick={() => onAction({ type: "align", axis, value })}
              >
                <Icon className="size-4" />
              </Button>
            </Tooltip>
          ))}
          <DropdownMenu>
            <Tooltip label={unavailable ?? "More layout actions"}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-full min-w-0"
                  aria-label="More layout actions"
                  disabled={pinDisabled}
                >
                  <Ellipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
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
              <DropdownMenuItem
                onSelect={() => onAction({ type: "resize-fit" })}
              >
                <Minimize /> Resize to fit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      {hasChildren ? (
        <div data-design-layout-constraints className="flex flex-col gap-2">
          <span className="text-fg2 text-[11px] font-medium">Constraints</span>
          <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3">
            <div
              role="group"
              aria-label="Constraint pins"
              className="bg-bg2 grid h-[72px] grid-cols-3 grid-rows-3 rounded-md px-1"
            >
              {(
                [
                  ["x", "start", "left", "col-start-1 row-start-2", x],
                  ["x", "end", "right", "col-start-3 row-start-2", x],
                  ["y", "start", "top", "col-start-2 row-start-1", y],
                  ["y", "end", "bottom", "col-start-2 row-start-3", y],
                ] as const
              ).map(([axis, value, label, position, current]) => (
                <Tooltip key={label} label={`Pin ${label}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "h-6 w-full",
                      position,
                      (current === value || current === "stretch") &&
                        "text-blue-fg",
                    )}
                    aria-label={`Pin ${label}`}
                    aria-pressed={current === value || current === "stretch"}
                    disabled={pinDisabled}
                    onClick={(event) => pin(axis, value, event.shiftKey)}
                  >
                    <span
                      className={cn(
                        "rounded-full bg-current",
                        axis === "x" ? "h-0.5 w-3" : "h-3 w-0.5",
                      )}
                    />
                  </Button>
                </Tooltip>
              ))}
              <Tooltip label="Pin center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "col-start-2 row-start-2 h-6 w-full",
                    x === "center" && y === "center" && "text-blue-fg",
                  )}
                  aria-label="Pin center"
                  aria-pressed={x === "center" && y === "center"}
                  disabled={pinDisabled}
                  onClick={() => onAction({ type: "center" })}
                >
                  <span className="relative flex size-3 items-center justify-center">
                    <span
                      className={cn(
                        "absolute h-0.5 w-3 rounded-full bg-current",
                        x === "center" && "text-blue-fg",
                      )}
                    />
                    <span
                      className={cn(
                        "absolute h-3 w-0.5 rounded-full bg-current",
                        y === "center" && "text-blue-fg",
                      )}
                    />
                  </span>
                </Button>
              </Tooltip>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              {(["x", "y"] as const).map((axis) => (
                <Select
                  key={axis}
                  value={axis === "x" ? x : y}
                  disabled={pinDisabled}
                  onValueChange={(value) =>
                    onAction({
                      type: "constraint",
                      axis,
                      value: value as DesignLayoutConstraint,
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="zd-design-control-quiet h-7 w-full min-w-0 px-2 text-[11px]"
                    aria-label={
                      axis === "x"
                        ? "Horizontal constraint"
                        : "Vertical constraint"
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(axis === "x" ? x : y) === "mixed" ? (
                      <SelectItem value="mixed" disabled>
                        Mixed
                      </SelectItem>
                    ) : null}
                    <SelectItem value="start">
                      {axis === "x" ? "Left" : "Top"}
                    </SelectItem>
                    <SelectItem value="center">Center</SelectItem>
                    <SelectItem value="end">
                      {axis === "x" ? "Right" : "Bottom"}
                    </SelectItem>
                    <SelectItem value="stretch">
                      {axis === "x" ? "Left and right" : "Top and bottom"}
                    </SelectItem>
                  </SelectContent>
                </Select>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <label className="text-fg2 flex h-7 cursor-pointer items-center gap-2 text-[11px]">
        <Checkbox
          aria-label="Clip content"
          disabled={disabled}
          checked={clipped}
          onChange={() => onAction({ type: "clip" })}
        />
        Clip content
      </label>
    </div>
  );
}
