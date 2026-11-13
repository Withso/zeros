import React, { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Columns3,
  Grid2X2,
  Maximize2,
  Minimize2,
  Minus,
  MoveHorizontal,
  Percent,
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
  InspectorGroup,
  InspectorIconButton,
  InspectorSelect,
  type InspectorGlyphName,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  type DesignLayoutAction,
  type DesignLayoutAxis,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import {
  designFrameAlwaysClips,
  canFillDesignContainer,
  canHugDesignContents,
  designAutoLayoutAlignment,
  designAutoLayoutAlignmentStyles,
  designAutoLayoutFlow,
  designGridTrackCount,
  designSizingMode,
} from "./design-auto-layout-values";
import { designStylePropertyAffectsLayout, readDesignComputedStyle } from "./design-style-values";
import { designLayerHasMargin } from "./design-style-advanced";
import { designValuesMixed } from "./design-style-mixed";
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
  /** How many layers are selected; Mixed needs every one loaded. */
  selectionCount?: number;
  disabled: boolean;
}

/** Every live property this section's values and helpers read. Alignment
 * also reads `direction`, which the layout set leaves out. */
function autoLayoutReads(property: string): boolean {
  return property === "direction" || designStylePropertyAffectsLayout(property);
}

const SIZING_WORDS = {
  fixed: "px",
  relative: "%",
  hug: "Hug",
  fill: "Fill",
} as const;

const SIZING_LABELS = {
  fixed: "Fixed",
  relative: "Relative",
  hug: "Hug",
  fill: "Fill",
  custom: "Custom",
} as const;

/** A size no mode names (auto in normal flow, 12em, calc()) ends in what it
 * is written as, short enough for the field's end. */
function customSizingWord(value: string): string {
  if (value === "auto" || value === "") return "Auto";
  const unit = /^-?\d*\.?\d+([a-z]+)$/i.exec(value)?.[1];
  return unit && unit.length <= 3 ? unit : "CSS";
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
  selectionCount = 1,
  disabled,
}: Props) {
  const liveStyles = useDesignLivePreviewStyles(
    livePreviewOwner?.workspaceId ?? "",
    livePreviewOwner?.frame ?? "",
    livePreviewOwner?.nodeId ?? "",
    autoLayoutReads,
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
  const flowMixed = designValuesMixed(
    (layoutParents ?? [details]).map(designAutoLayoutFlow),
    selectionCount,
  );
  const autoLayout = flow !== "none";
  const textLayer = designRuntimeLayerLabel(details) === "Text";
  const container = !textLayer && designRuntimeLayerLabel(details) === "Frame";
  const fillAllowed =
    !frameSelected &&
    (layoutParents ?? [details]).every(canFillDesignContainer);
  const hugAllowed = (layoutParents ?? [details]).every(canHugDesignContents);
  // Relative needs a parent to size against; the canvas sizes a frame root.
  const relativeAllowed =
    !frameSelected && (layoutParents ?? [details]).every((node) => !!node.layout?.parentId);
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
  const [independentMargin, setIndependentMargin] = useState<boolean | null>(null);
  const margins = ["margin-left", "margin-right", "margin-top", "margin-bottom"].map(
    (property) => value(property, "0px"),
  );
  // Margin shows only when the layer has one; More styles lists a zero one.
  const hasMargin = designLayerHasMargin(details);
  const separateMargin =
    independentMargin ?? (margins[0] !== margins[1] || margins[2] !== margins[3]);
  const horizontalMixed =
    value("padding-left", "0px") !== value("padding-right", "0px");
  const verticalMixed =
    value("padding-top", "0px") !== value("padding-bottom", "0px");
  const alignment = designAutoLayoutAlignment(details);
  const wrapped = value("flex-wrap", "nowrap") !== "nowrap";
  const clipped = ["overflow", "overflow-x", "overflow-y"].some((property) =>
    ["hidden", "clip"].includes(value(property)),
  );
  const frameClips = designFrameAlwaysClips(details, frameSelected);
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
  const sizingWord = (mode: ReturnType<typeof designSizingMode>, axis: DesignLayoutAxis) =>
    mode === "custom"
      ? customSizingWord(value(axis === "x" ? "width" : "height"))
      : SIZING_WORDS[mode];
  /** W or H, ending in the word for its sizing (px, %, Hug, Fill), which opens
   * that axis's sizing menu. The field shows the measured number in every
   * mode; typing one makes the size fixed. */
  const resize = (axis: DesignLayoutAxis) => {
    const dimension = axis === "x" ? "width" : "height";
    const measuredMode = designSizingMode(details, axis);
    const mode =
      frameSelected && measuredMode === "custom" ? "fixed" : measuredMode;
    // Differing modes check nothing in the menu and show no word for one.
    const modeMixed = designValuesMixed(
      (layoutParents ?? [details]).map((node) => designSizingMode(node, axis)),
      selectionCount,
    );
    const label = axis === "x" ? "W" : "H";
    const relativeValue =
      (axis === "x" ? details.layout?.widthValue : details.layout?.heightValue) ?? "";
    return (
      <div className="zd-size-control relative min-w-0" data-design-size-axis={axis}>
        {mode === "relative"
          ? renderField(label, dimension, relativeValue, { whole: true, compact: true })
          : renderField(label, dimension, value(dimension), {
              whole: true,
              compact: true,
              geometry: true,
            })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="zd-size-trigger"
              disabled={disabled}
              aria-label={`${axis === "x" ? "Width" : "Height"} sizing: ${modeMixed ? "Mixed" : SIZING_LABELS[mode]}`}
            >
              {modeMixed ? "–" : sizingWord(mode, axis)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuRadioGroup
              value={modeMixed ? "" : mode}
              onValueChange={(next) =>
                onAction({
                  type: "sizing",
                  axis,
                  mode: next as "fixed" | "relative" | "hug" | "fill",
                })
              }
            >
              {mode === "custom" && !modeMixed && (
                <DropdownMenuRadioItem value="custom" disabled>
                  Custom
                </DropdownMenuRadioItem>
              )}
              <DropdownMenuRadioItem value="fixed">
                <Maximize2 />
                Fixed
              </DropdownMenuRadioItem>
              {relativeAllowed && (
                <DropdownMenuRadioItem value="relative">
                  <Percent />
                  Relative
                </DropdownMenuRadioItem>
              )}
              {hugAllowed && (
                <DropdownMenuRadioItem value="hug">
                  <Minimize2 />
                  Hug
                </DropdownMenuRadioItem>
              )}
              {fillAllowed && (
                <DropdownMenuRadioItem value="fill">
                  <Scan />
                  Fill
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
      size="sm"
      onEscapeKeyDown={keepDesignPopoverWhileEditing}
    >
      <div className="zd-popover">
        <div className="zd-popover-header">
          <span className="zd-popover-title">Layout settings</span>
        </div>
        <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
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
    <div data-design-auto-layout className="flex flex-col gap-3">
      {container ? (
        <InspectorGroup label="Flow">
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
                    aria-pressed={!flowMixed && flow === key}
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
        </InspectorGroup>
      ) : null}
      <InspectorGroup label="Size">
        <div className="grid grid-cols-2 gap-2">
          {resize("x")}
          {resize("y")}
        </div>
        {limits.length > 0 ? (
        <div
          data-design-layout-limits=""
          className="grid grid-cols-2 gap-2"
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
              <span className="zd-limit-remove">
                <InspectorIconButton
                  label={`Remove ${property.replace("-", " ")}`}
                  size="inline"
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
              </span>
            </div>
          ))}
        </div>
        ) : null}
      </InspectorGroup>
      {autoLayout ? (
        <InspectorGroup label="Alignment">
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
            <div
              role="group"
              aria-label="Align children"
              className="zd-alignment-pad grid size-16 grid-cols-3 grid-rows-3 rounded-lg p-1"
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
        </InspectorGroup>
      ) : null}
      {autoLayout ? (
        <InspectorGroup label="Padding">
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
                  ? "Linked padding"
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
        </InspectorGroup>
      ) : null}
      {hasMargin ? (
        <InspectorGroup label="Margin" data-design-layout-margin="">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-2">
            {separateMargin ? (
              <>
                {field("Left margin", "margin-left", "0px", undefined, "padding-left")}
                {field("Top margin", "margin-top", "0px", undefined, "padding-top")}
              </>
            ) : (
              <>
                {field("Horizontal margin", "margin-left", "0px", ["margin-right"], "padding-x",
                  value("margin-left", "0px") !== value("margin-right", "0px"))}
                {field("Vertical margin", "margin-top", "0px", ["margin-bottom"], "padding-y",
                  value("margin-top", "0px") !== value("margin-bottom", "0px"))}
              </>
            )}
            <InspectorIconButton
              label="Independent margin"
              tooltip={separateMargin ? "Linked margin" : "Independent margin"}
              size="row"
              pressed={separateMargin}
              disabled={disabled}
              onClick={() => setIndependentMargin(!separateMargin)}
            >
              <InspectorGlyph name="corners" />
            </InspectorIconButton>
            {separateMargin ? (
              <>
                {field("Right margin", "margin-right", "0px", undefined, "padding-right")}
                {field("Bottom margin", "margin-bottom", "0px", undefined, "padding-bottom")}
              </>
            ) : null}
          </div>
        </InspectorGroup>
      ) : null}
      {container ? (
        <InspectorCheckboxRow
          label="Clip content"
          checked={clipped}
          disabled={disabled}
          title={frameClips ? "The canvas always clips a frame at its edges. This sets the frame's own overflow." : undefined}
          onChange={() => onAction({ type: "clip" })}
        />
      ) : null}
    </div>
  );
}
