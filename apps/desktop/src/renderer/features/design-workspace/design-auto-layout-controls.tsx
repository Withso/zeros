import React, { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  Grid2X2,
  Group,
  Maximize2,
  Minimize2,
  Minus,
  Scan,
  SlidersHorizontal,
  WrapText,
} from "lucide-react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignLayoutControls } from "./design-layout-controls";
import { designLayoutChildrenSummary } from "./design-layout-children";
import {
  type DesignLayoutAction,
  type DesignLayoutAxis,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import {
  canFillDesignContainer,
  canHugDesignContents,
  designAutoLayoutAlignment,
  designAutoLayoutAlignmentStyles,
  designAutoLayoutFlow,
  designGridTrackCount,
  designSizingMode,
} from "./design-auto-layout-values";
import { readDesignComputedStyle } from "./design-style-values";
import { useDesignLivePreviewStyles } from "./state/design-live-preview";
import { designRuntimeLayerLabel } from "./design-layer-label";

interface Props {
  details: DesignRuntimeNodeDetails;
  livePreviewOwner?: { workspaceId: string; frame: string; nodeId: string };
  renderField: (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => React.ReactNode;
  onAction: (action: DesignLayoutAction) => void;
  onCommit: (styles: Record<string, string | null>) => void;
  frameSelected?: boolean;
  layoutParents?: readonly DesignRuntimeNodeDetails[];
  disabled: boolean;
}

function LayoutSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-fg2 text-[11px]">{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          size="sm"
          className="zd-design-layout-select h-7 w-full text-xs"
          aria-label={label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!options.some(([key]) => key === value) && (
            <SelectItem value={value}>{value}</SelectItem>
          )}
          {options.map(([key, title]) => (
            <SelectItem key={key} value={key}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function TrackCount({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (count: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const count = Number(draft);
    setDraft(null);
    if (Number.isInteger(count) && count > 0 && count <= 64 && count !== value)
      onCommit(count);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-fg2 text-[11px]">{label}</span>
      <Input
        aria-label={label}
        inputMode="numeric"
        className="zd-design-layout-select h-7 text-xs tabular-nums"
        value={draft ?? value}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setDraft(
              String(
                Math.max(
                  1,
                  Math.min(
                    64,
                    Number(draft ?? value) + (event.key === "ArrowUp" ? 1 : -1),
                  ),
                ),
              ),
            );
          }
        }}
      />
    </label>
  );
}

export function DesignAutoLayoutControls({
  details: confirmedDetails,
  livePreviewOwner,
  renderField,
  onAction,
  onCommit,
  frameSelected,
  layoutParents,
  disabled,
}: Props) {
  const liveStyles = useDesignLivePreviewStyles(
    livePreviewOwner?.workspaceId ?? "",
    livePreviewOwner?.frame ?? "",
    livePreviewOwner?.nodeId ?? "",
  );
  const styles = { ...confirmedDetails.styles };
  for (const [property, value] of Object.entries(liveStyles ?? {})) {
    const key = property.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    styles[key] = value ?? "";
    styles[property] = value ?? "";
  }
  const details = liveStyles
    ? { ...confirmedDetails, styles }
    : confirmedDetails;
  const value = (property: string, fallback = "") =>
    readDesignComputedStyle(details.styles, property) || fallback;
  const flow = designAutoLayoutFlow(details);
  const autoLayout = flow !== "none";
  const textLayer = designRuntimeLayerLabel(details) === "Text";
  const container = !textLayer && designRuntimeLayerLabel(details) === "Frame";
  const fillAllowed =
    !frameSelected &&
    (layoutParents ?? [details]).every(canFillDesignContainer);
  const hugAllowed = (layoutParents ?? [details]).every(canHugDesignContents);
  const resizing = autoLayout || fillAllowed;
  const [addedLimits, setAddedLimits] = useState<string[]>([]);
  const [independentPadding, setIndependentPadding] = useState(false);
  const paddingDiffers =
    value("padding-left", "0px") !== value("padding-right", "0px") ||
    value("padding-top", "0px") !== value("padding-bottom", "0px");
  const separatePadding = independentPadding || paddingDiffers;
  const alignment = designAutoLayoutAlignment(details);
  const wrapped = value("flex-wrap", "nowrap") !== "nowrap";
  const clipped = ["overflow", "overflow-x", "overflow-y"].some((property) =>
    ["hidden", "clip"].includes(value(property)),
  );
  const hasLimit = (property: string) =>
    addedLimits.includes(property) ||
    !["", "0px", "auto", "none"].includes(value(property));
  const field = (
    label: string,
    property: string,
    fallback = "0px",
    linkedProperties?: string[],
  ) =>
    renderField(
      label,
      property,
      value(property, fallback) === "normal"
        ? "0px"
        : value(property, fallback),
      {
        linkedProperties,
        whole: true,
        compact: true,
        shortLabel:
          label.startsWith("Min") || label.startsWith("Max")
            ? property.endsWith("width")
              ? "W"
              : "H"
            : ["Left", "Top", "Right", "Bottom"].includes(label)
              ? label[0]
              : undefined,
        icon:
          label === "Horizontal"
            ? "padding-x"
            : label === "Vertical"
              ? "padding-y"
              : label === "Gap" || label === "Row gap" || label === "Column gap"
                ? "gap"
                : undefined,
      },
    );
  const resize = (axis: DesignLayoutAxis, field: React.ReactNode) => {
    // Keep the field mounted when a reparent changes resizing eligibility;
    // a late layout snapshot must not discard the next focused numeric draft.
    const dimension = axis === "x" ? "width" : "height";
    const measuredMode = designSizingMode(details, axis);
    const mode =
      frameSelected && measuredMode === "custom" ? "fixed" : measuredMode;
    return (
      <div className="zd-design-size-control flex min-w-0 items-center rounded-md">
        <div className="min-w-0 flex-1">
          {resizing && (mode === "hug" || mode === "fill")
            ? renderField(
                axis === "x" ? "W" : "H",
                dimension,
                value(dimension),
                { whole: true, compact: true, geometry: true, sizing: mode },
              )
            : field}
        </div>
        {resizing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-6 shrink-0 rounded-l-none"
                disabled={disabled}
                aria-label={`${axis === "x" ? "Width" : "Height"} resizing`}
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(mode) =>
                  onAction({
                    type: "sizing",
                    axis,
                    mode: mode as "fixed" | "hug" | "fill",
                  })
                }
              >
                {mode === "custom" && (
                  <DropdownMenuRadioItem value="custom" disabled>
                    Custom sizing
                  </DropdownMenuRadioItem>
                )}
                <DropdownMenuRadioItem value="fixed">
                  <Maximize2 />
                  Fixed {dimension}
                </DropdownMenuRadioItem>
                {hugAllowed && (
                  <DropdownMenuRadioItem value="hug">
                    <Minimize2 />
                    Hug contents
                  </DropdownMenuRadioItem>
                )}
                {fillAllowed && (
                  <DropdownMenuRadioItem value="fill">
                    <Scan />
                    Fill container
                  </DropdownMenuRadioItem>
                )}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {(["min", "max"] as const).map((limit) => {
                const property = `${limit}-${dimension}`;
                const shown = hasLimit(property);
                return (
                  <DropdownMenuItem
                    key={limit}
                    onSelect={() => {
                      if (shown) {
                        setAddedLimits((limits) =>
                          limits.filter((entry) => entry !== property),
                        );
                        onCommit({ [property]: null });
                      } else setAddedLimits((limits) => [...limits, property]);
                    }}
                  >
                    {shown ? "Remove" : "Add"} {limit} {dimension}
                    {shown ? "" : "…"}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };
  const setSpacing = (next: string) =>
    onCommit({
      "justify-content": next,
      ...(next.startsWith("space-")
        ? { [alignment.column ? "row-gap" : "column-gap"]: "0px" }
        : {}),
    });
  const alignAt = (x: number, y: number) =>
    onCommit(designAutoLayoutAlignmentStyles(details, x, y));

  return (
    <div data-design-auto-layout className="flex flex-col gap-3">
      <DesignLayoutControls
        details={details}
        renderField={renderField}
        disabled={disabled}
        frameSelected={frameSelected}
        childrenLayout={
          layoutParents
            ? designLayoutChildrenSummary(layoutParents)
            : details.childrenLayout
        }
        canDistribute={layoutParents?.some(
          (parent) => (parent.childrenLayout?.nodeIds.length ?? 0) >= 3,
        )}
        renderSize={resize}
        showClip={false}
        showChildren={!autoLayout}
        onAction={onAction}
      />
      {container && (
        <div className="flex flex-col gap-1.5">
          <span className="text-fg2 text-[11px]">Flow</span>
          <div
            role="group"
            aria-label="Auto layout"
            className="zd-design-layout-flow grid h-8 grid-cols-4 gap-1 rounded-md p-0.5"
          >
            {(
              [
                ["none", "None", Group],
                ["column", "Vertical", ArrowDown],
                ["row", "Horizontal", ArrowRight],
                ["grid", "Grid", Grid2X2],
              ] as const
            ).map(([key, label, Icon]) => (
              <Tooltip
                key={key}
                label={
                  key === "row" || key === "column"
                    ? `${label} flex layout`
                    : label
                }
              >
                <Button
                  variant="ghost"
                  className="zd-design-segment h-7 w-full min-w-0 gap-1 px-1 text-[11px]"
                  disabled={disabled}
                  aria-label={`Auto layout: ${label}`}
                  aria-pressed={flow === key}
                  onClick={() => onAction({ type: "auto-layout", flow: key })}
                >
                  <Icon className="size-4 shrink-0" />
                </Button>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
      {resizing && (
        <div className="grid grid-cols-2 gap-x-2 gap-y-2 empty:hidden">
          {["min-width", "min-height", "max-width", "max-height"]
            .filter(hasLimit)
            .map((property) => (
              <div
                key={property}
                className={cn(
                  "min-w-0",
                  property.endsWith("width") ? "col-start-1" : "col-start-2",
                )}
              >
                <div className="text-fg2 mb-1.5 text-[11px]">
                  {property.replace("min-", "Min ").replace("max-", "Max ")}
                </div>
                <div className="flex min-w-0 items-center gap-1">
                  <div className="min-w-0 flex-1">
                    {field(
                      property
                        .replace("min-width", "Min W")
                        .replace("min-height", "Min H")
                        .replace("max-width", "Max W")
                        .replace("max-height", "Max H"),
                      property,
                      property.startsWith("min") ? "0px" : "none",
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={disabled}
                    aria-label={`Remove ${property.replace("-", " ")}`}
                    onClick={() => {
                      setAddedLimits((limits) =>
                        limits.filter((entry) => entry !== property),
                      );
                      onCommit({ [property]: null });
                    }}
                  >
                    <Minus className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
      {autoLayout && (
        <>
          {flow === "grid" && (
            <div className="grid grid-cols-2 gap-2">
              <TrackCount
                label="Columns"
                value={designGridTrackCount(value("grid-template-columns"))}
                disabled={disabled}
                onCommit={(count) =>
                  onCommit({
                    "grid-template-columns": `repeat(${count}, minmax(0, 1fr))`,
                  })
                }
              />
              <TrackCount
                label="Rows"
                value={designGridTrackCount(value("grid-template-rows"))}
                disabled={disabled}
                onCommit={(count) =>
                  onCommit({
                    "grid-template-rows": `repeat(${count}, minmax(0, 1fr))`,
                  })
                }
              />
            </div>
          )}
          <div className="grid grid-cols-2 items-start gap-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-fg2 text-[11px]">Alignment</span>
              <div
                role="group"
                aria-label="Align children"
                className="zd-design-alignment-grid grid h-[76px] grid-cols-3 grid-rows-3 rounded-md p-1"
              >
                {[0, 1, 2].flatMap((y) =>
                  [0, 1, 2].map((x) => {
                    const available =
                      !alignment.auto || (alignment.column ? y === 1 : x === 1);
                    const selected =
                      available &&
                      (alignment.auto
                        ? alignment.column
                          ? x === alignment.x
                          : y === alignment.y
                        : x === alignment.x && y === alignment.y);
                    return (
                      <Button
                        key={`${x}:${y}`}
                        variant="ghost"
                        size="icon-sm"
                        className="zd-design-alignment-point h-full w-full rounded-sm"
                        aria-label={`Align children ${["top", "middle", "bottom"][y]} ${["left", "center", "right"][x]}`}
                        aria-pressed={selected}
                        disabled={disabled || !available}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => alignAt(x, y)}
                        onKeyDown={(event) => {
                          const delta = {
                            ArrowLeft: [-1, 0],
                            ArrowRight: [1, 0],
                            ArrowUp: [0, -1],
                            ArrowDown: [0, 1],
                          }[event.key];
                          if (!delta) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const nextX =
                            alignment.auto && !alignment.column
                              ? 1
                              : Math.max(0, Math.min(2, x + delta[0]!));
                          const nextY =
                            alignment.auto && alignment.column
                              ? 1
                              : Math.max(0, Math.min(2, y + delta[1]!));
                          if (nextX === x && nextY === y) return;
                          alignAt(nextX, nextY);
                          const group = event.currentTarget.parentElement;
                          (
                            group?.children[nextY * 3 + nextX] as
                              | HTMLButtonElement
                              | undefined
                          )?.focus();
                        }}
                      >
                        <span
                          className={cn(
                            "zd-design-alignment-mark",
                            selected && "zd-design-alignment-mark-selected",
                          )}
                        />
                      </Button>
                    );
                  }),
                )}
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex h-4 items-center justify-between">
                <span className="text-fg2 text-[11px]">Gap</span>
                <Popover>
                  <Tooltip label="Layout settings">
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6"
                        aria-label="Layout settings"
                        disabled={disabled}
                      >
                        <SlidersHorizontal className="size-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </Tooltip>
                  <PopoverContent align="end" className="w-64 p-3">
                    <div className="flex flex-col gap-3">
                      <span className="text-fg1 text-xs font-medium">
                        Layout settings
                      </span>
                      <LayoutSelect
                        label="Alignment"
                        value={value("align-items", "normal")}
                        disabled={disabled}
                        options={[
                          ["normal", "Default"],
                          ["flex-start", "Start"],
                          ["center", "Center"],
                          ["flex-end", "End"],
                          ["stretch", "Stretch"],
                          ["baseline", "Text baseline"],
                        ]}
                        onChange={(next) => onCommit({ "align-items": next })}
                      />
                      {flow !== "grid" && (
                        <>
                          <LayoutSelect
                            label="Spacing"
                            value={value("justify-content", "flex-start")}
                            disabled={disabled}
                            options={[
                              ["normal", "Packed"],
                              ["flex-start", "Packed at start"],
                              ["center", "Packed at center"],
                              ["flex-end", "Packed at end"],
                              ["space-between", "Space between"],
                              ["space-around", "Space around"],
                              ["space-evenly", "Space evenly"],
                            ]}
                            onChange={setSpacing}
                          />
                          <label className="text-fg2 flex items-center gap-2 text-xs">
                            <Checkbox
                              aria-label="Reverse order"
                              checked={value("flex-direction").endsWith(
                                "reverse",
                              )}
                              disabled={disabled}
                              onChange={() =>
                                onCommit({
                                  "flex-direction": `${flow}${value("flex-direction").endsWith("reverse") ? "" : "-reverse"}`,
                                })
                              }
                            />
                            Reverse order
                          </label>
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              {alignment.auto ? (
                <Button
                  variant="ghost"
                  className="zd-design-layout-select h-7 justify-start px-2 text-xs"
                  onClick={() => setSpacing("flex-start")}
                  disabled={disabled}
                  aria-label="Use fixed gap"
                >
                  Auto <ChevronDown className="ml-auto size-3" />
                </Button>
              ) : (
                field(
                  "Gap",
                  flow === "grid" || !alignment.column
                    ? "column-gap"
                    : "row-gap",
                )
              )}
              {flow === "grid" || wrapped ? (
                field(
                  flow !== "grid" && alignment.column
                    ? "Column gap"
                    : "Row gap",
                  flow !== "grid" && alignment.column
                    ? "column-gap"
                    : "row-gap",
                )
              ) : (
                <Button
                  variant="ghost"
                  className="text-muted-fg h-7 justify-start px-2 text-[11px]"
                  disabled={disabled}
                  onClick={() =>
                    setSpacing(alignment.auto ? "flex-start" : "space-between")
                  }
                >
                  {alignment.auto ? "Use fixed gap" : "Auto spacing"}
                </Button>
              )}
            </div>
          </div>
          {flow !== "grid" && (
            <label className="text-fg2 flex h-6 cursor-pointer items-center gap-2 text-[11px]">
              <Checkbox
                aria-label="Wrap children"
                checked={wrapped}
                disabled={disabled}
                onChange={() =>
                  onCommit({ "flex-wrap": wrapped ? "nowrap" : "wrap" })
                }
              />
              <WrapText className="text-muted-fg size-3.5" />
              Wrap
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex h-6 items-center justify-between">
              <span className="text-fg2 text-[11px]">Padding</span>
              <Tooltip
                label={
                  separatePadding
                    ? "Use horizontal and vertical padding"
                    : "Independent padding"
                }
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  disabled={disabled}
                  aria-label="Independent padding"
                  aria-pressed={separatePadding}
                  onClick={() => {
                    if (paddingDiffers)
                      onCommit({
                        "padding-right": value("padding-left", "0px"),
                        "padding-bottom": value("padding-top", "0px"),
                      });
                    setIndependentPadding(!separatePadding);
                  }}
                >
                  <Scan className="size-3.5" />
                </Button>
              </Tooltip>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {separatePadding ? (
                <>
                  {field("Left", "padding-left")}
                  {field("Top", "padding-top")}
                  {field("Right", "padding-right")}
                  {field("Bottom", "padding-bottom")}
                </>
              ) : (
                <>
                  {field("Horizontal", "padding-left", "0px", [
                    "padding-right",
                  ])}
                  {field("Vertical", "padding-top", "0px", ["padding-bottom"])}
                </>
              )}
            </div>
          </div>
        </>
      )}
      {container && (
        <label className="text-fg2 flex h-7 cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            aria-label="Clip content"
            disabled={disabled}
            checked={clipped}
            onChange={() => onAction({ type: "clip" })}
          />
          Clip content
        </label>
      )}
    </div>
  );
}
