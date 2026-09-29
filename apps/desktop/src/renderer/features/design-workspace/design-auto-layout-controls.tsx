import React, { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  Columns3,
  Grid2X2,
  Maximize2,
  Minimize2,
  Minus,
  MoveHorizontal,
  Rows3,
  Scan,
  SlidersHorizontal,
  Square,
  WrapText,
} from "lucide-react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  InspectorCheckboxRow,
  InspectorGlyph,
  InspectorIconButton,
  InspectorSelect,
  type InspectorGlyphName,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  DesignLayoutChildren,
  DesignLayoutGeometry,
} from "./design-layout-controls";
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

const FLOWS = [
  ["none", "None", Square],
  ["column", "Vertical", ArrowDown],
  ["row", "Horizontal", ArrowRight],
  ["grid", "Grid", Grid2X2],
] as const;

function TrackCount({
  label,
  icon,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  icon: React.ReactNode;
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
    <div className="zd-field">
      <Tooltip label={label}>
        <span className="zd-field-label w-6" aria-hidden="true">
          {icon}
        </span>
      </Tooltip>
      <input
        aria-label={label}
        inputMode="numeric"
        className="pr-2"
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
    </div>
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
  /** null follows the values (unequal sides open independently); a click
   * records the user's choice without rewriting any padding. */
  const [independentPadding, setIndependentPadding] = useState<boolean | null>(
    null,
  );
  const paddingDiffers =
    value("padding-left", "0px") !== value("padding-right", "0px") ||
    value("padding-top", "0px") !== value("padding-bottom", "0px");
  const separatePadding = independentPadding ?? paddingDiffers;
  const horizontalMixed =
    value("padding-left", "0px") !== value("padding-right", "0px");
  const verticalMixed =
    value("padding-top", "0px") !== value("padding-bottom", "0px");
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
    icon?: InspectorGlyphName,
    mixed = false,
  ) =>
    renderField(
      label,
      property,
      mixed
        ? ""
        : value(property, fallback) === "normal"
          ? "0px"
          : value(property, fallback),
      {
        linkedProperties,
        whole: true,
        compact: true,
        shortLabel:
          label.startsWith("Min") || label.startsWith("Max")
            ? label
            : undefined,
        icon,
        placeholder: mixed ? "Mixed" : undefined,
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
      <div className="zd-size-control relative min-w-0">
        {resizing && (mode === "hug" || mode === "fill")
          ? renderField(axis === "x" ? "W" : "H", dimension, value(dimension), {
              whole: true,
              compact: true,
              geometry: true,
              sizing: mode,
            })
          : field}
        {resizing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="zd-size-trigger"
                disabled={disabled}
                aria-label={`${axis === "x" ? "Width" : "Height"} resizing`}
              >
                <ChevronDown />
              </button>
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
  const limits = ["min-width", "min-height", "max-width", "max-height"].filter(
    hasLimit,
  );
  const mainGapProperty =
    flow === "grid" || !alignment.column ? "column-gap" : "row-gap";
  const crossGap =
    flow === "grid" || wrapped
      ? {
          label: flow !== "grid" && alignment.column ? "Column gap" : "Row gap",
          property:
            flow !== "grid" && alignment.column ? "column-gap" : "row-gap",
        }
      : null;

  const layoutSettingsTrigger = autoLayout ? (
    <PopoverTrigger asChild>
      <InspectorIconButton
        label="Layout settings"
        size="row"
        disabled={disabled}
      >
        <SlidersHorizontal />
      </InspectorIconButton>
    </PopoverTrigger>
  ) : null;
  const layoutSettingsContent = autoLayout ? (
    <PopoverContent
      data-design-popover=""
      onOpenAutoFocus={focusDesignPopoverSurface}
      side="left"
      align="start"
      sideOffset={8}
      padding="none"
      className="w-64"
      onEscapeKeyDown={keepDesignPopoverWhileEditing}
    >
      <div className="zd-popover">
        <div className="zd-popover-header">
          <span className="zd-popover-title">Layout settings</span>
        </div>
        <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
          <span className="zd-row-label">Align items</span>
          <InspectorSelect
            label="Alignment"
            value={value("align-items", "normal")}
            disabled={disabled}
            options={[
              { value: "normal", label: "Default" },
              { value: "flex-start", label: "Start" },
              { value: "center", label: "Center" },
              { value: "flex-end", label: "End" },
              { value: "stretch", label: "Stretch" },
              { value: "baseline", label: "Text baseline" },
            ]}
            onChange={(next) => onCommit({ "align-items": next })}
          />
          {flow !== "grid" ? (
            <>
              <span className="zd-row-label">Spacing</span>
              <InspectorSelect
                label="Spacing"
                value={value("justify-content", "flex-start")}
                disabled={disabled}
                options={[
                  { value: "normal", label: "Packed" },
                  { value: "flex-start", label: "Packed at start" },
                  { value: "center", label: "Packed at center" },
                  { value: "flex-end", label: "Packed at end" },
                  { value: "space-between", label: "Space between" },
                  { value: "space-around", label: "Space around" },
                  { value: "space-evenly", label: "Space evenly" },
                ]}
                onChange={setSpacing}
              />
            </>
          ) : null}
        </div>
        {flow !== "grid" ? (
          <InspectorCheckboxRow
            label="Reverse order"
            checked={value("flex-direction").endsWith("reverse")}
            disabled={disabled}
            onChange={() =>
              onCommit({
                "flex-direction": `${flow}${value("flex-direction").endsWith("reverse") ? "" : "-reverse"}`,
              })
            }
          />
        ) : null}
      </div>
    </PopoverContent>
  ) : null;

  return (
    <div data-design-auto-layout className="flex flex-col gap-2">
      <DesignLayoutGeometry
        details={details}
        renderField={renderField}
        disabled={disabled}
        renderSize={resize}
        onAction={onAction}
      />
      {resizing && limits.length > 0 ? (
        // Limits sit under the W/H column they constrain, on the geometry's
        // own three-column track, with their remove action inside the field.
        <div
          data-design-layout-limits=""
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(72px,1fr)] gap-2"
        >
          {limits.map((property) => (
            <div
              key={property}
              className={cn(
                "zd-limit-field relative min-w-0",
                property.endsWith("width") ? "col-start-1" : "col-start-2",
                property.startsWith("min") ? "row-start-1" : "row-start-2",
              )}
            >
              {renderField(
                property
                  .replace("min-width", "Min W")
                  .replace("min-height", "Min H")
                  .replace("max-width", "Max W")
                  .replace("max-height", "Max H"),
                property,
                value(property, property.startsWith("min") ? "0px" : "none"),
                {
                  whole: true,
                  compact: true,
                  shortLabel: property.startsWith("min") ? "Min" : "Max",
                },
              )}
              <InspectorIconButton
                label={`Remove ${property.replace("-", " ")}`}
                className="zd-limit-remove"
                disabled={disabled}
                onClick={() => {
                  setAddedLimits((current) =>
                    current.filter((entry) => entry !== property),
                  );
                  onCommit({ [property]: null });
                }}
              >
                <Minus />
              </InspectorIconButton>
            </div>
          ))}
        </div>
      ) : null}
      {container ? (
        // The row anchors Layout settings, which opens beside the inspector.
        <Popover>
          <div className="relative flex min-w-0 items-center gap-2">
            <div
              role="group"
              aria-label="Auto layout"
              className="zd-segmented min-w-0 flex-1"
            >
              {FLOWS.map(([key, label, Icon]) => (
                <Tooltip
                  key={key}
                  label={
                    key === "row" || key === "column"
                      ? `${label} auto layout`
                      : key === "none"
                        ? "No auto layout"
                        : "Grid"
                  }
                >
                  <button
                    type="button"
                    className="zd-segment"
                    disabled={disabled}
                    aria-label={`Auto layout: ${label}`}
                    aria-pressed={flow === key}
                    onClick={() => onAction({ type: "auto-layout", flow: key })}
                  >
                    <Icon />
                  </button>
                </Tooltip>
              ))}
            </div>
            {autoLayout && flow !== "grid" ? (
              <InspectorIconButton
                label="Wrap children"
                tooltip="Wrap"
                size="row"
                pressed={wrapped}
                disabled={disabled}
                onClick={() =>
                  onCommit({ "flex-wrap": wrapped ? "nowrap" : "wrap" })
                }
              >
                <WrapText />
              </InspectorIconButton>
            ) : null}
            {layoutSettingsTrigger}
            <InspectorPopoverAnchor />
          </div>
          {layoutSettingsContent}
        </Popover>
      ) : null}
      {autoLayout ? (
        <>
          {flow === "grid" ? (
            <div className="grid grid-cols-2 gap-2">
              <TrackCount
                label="Columns"
                icon={<Columns3 className="size-3.5" />}
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
                icon={<Rows3 className="size-3.5" />}
                value={designGridTrackCount(value("grid-template-rows"))}
                disabled={disabled}
                onCommit={(count) =>
                  onCommit({
                    "grid-template-rows": `repeat(${count}, minmax(0, 1fr))`,
                  })
                }
              />
            </div>
          ) : null}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
            <div
              role="group"
              aria-label="Align children"
              className="zd-alignment-pad grid size-16 grid-cols-3 grid-rows-3 rounded-md p-1"
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
                    <button
                      key={`${x}:${y}`}
                      type="button"
                      className="zd-design-alignment-point zd-alignment-point"
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
                          selected && !alignment.column && "rotate-90",
                        )}
                      />
                    </button>
                  );
                }),
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_28px] gap-2">
                {alignment.auto ? (
                  <div className="zd-field text-fg2 pl-0" aria-live="polite">
                    <span className="zd-field-label w-6" aria-hidden="true">
                      <InspectorGlyph
                        name={alignment.column ? "gap-y" : "gap"}
                      />
                    </span>
                    Auto
                  </div>
                ) : (
                  field(
                    "Gap",
                    mainGapProperty,
                    "0px",
                    undefined,
                    alignment.column && flow !== "grid" ? "gap-y" : "gap",
                  )
                )}
                <InspectorIconButton
                  label={alignment.auto ? "Use fixed gap" : "Auto spacing"}
                  tooltip={alignment.auto ? "Fixed gap" : "Auto spacing"}
                  size="row"
                  pressed={alignment.auto}
                  disabled={disabled || flow === "grid"}
                  onClick={() =>
                    setSpacing(alignment.auto ? "flex-start" : "space-between")
                  }
                >
                  <MoveHorizontal
                    className={alignment.column ? "rotate-90" : undefined}
                  />
                </InspectorIconButton>
              </div>
              {crossGap
                ? field(
                    crossGap.label,
                    crossGap.property,
                    "0px",
                    undefined,
                    crossGap.property === "row-gap" ? "gap-y" : "gap",
                  )
                : null}
            </div>
          </div>
          <div
            className={cn(
              "grid min-w-0 gap-2",
              "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px]",
            )}
          >
            {separatePadding ? (
              <>
                {field(
                  "Left",
                  "padding-left",
                  "0px",
                  undefined,
                  "padding-left",
                )}
                {field("Top", "padding-top", "0px", undefined, "padding-top")}
              </>
            ) : (
              <>
                {field(
                  "Horizontal",
                  "padding-left",
                  "0px",
                  ["padding-right"],
                  "padding-x",
                  horizontalMixed,
                )}
                {field(
                  "Vertical",
                  "padding-top",
                  "0px",
                  ["padding-bottom"],
                  "padding-y",
                  verticalMixed,
                )}
              </>
            )}
            <InspectorIconButton
              label="Independent padding"
              tooltip={
                separatePadding
                  ? "Use horizontal and vertical padding"
                  : "Independent padding"
              }
              size="row"
              pressed={separatePadding}
              disabled={disabled}
              onClick={() => setIndependentPadding(!separatePadding)}
            >
              <InspectorGlyph name="corners" />
            </InspectorIconButton>
            {separatePadding ? (
              <>
                {field(
                  "Right",
                  "padding-right",
                  "0px",
                  undefined,
                  "padding-right",
                )}
                {field(
                  "Bottom",
                  "padding-bottom",
                  "0px",
                  undefined,
                  "padding-bottom",
                )}
              </>
            ) : null}
          </div>
        </>
      ) : (
        <DesignLayoutChildren
          details={details}
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
          onAction={onAction}
        />
      )}
      {container ? (
        <InspectorCheckboxRow
          label="Clip content"
          checked={clipped}
          disabled={disabled}
          onChange={() => onAction({ type: "clip" })}
        />
      ) : null}
    </div>
  );
}
