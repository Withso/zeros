// ============================================
// COMPONENT: DesignStrokeSection
// PURPOSE: Figma-style strokes over CSS: an Inside stroke is the border, an
//          Outside stroke is the outline. Each stroke is a weight / sides row
//          and a color row; position and style are in Stroke settings.
// USED IN: DesignStyleEditor
// ============================================

import React, { useState } from "react";
import { Ellipsis, Minus, Plus } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives";
import { DesignColorField } from "./design-color-picker";
import { useDesignStyleToken } from "./design-style-provenance";
import {
  InspectorIconButton,
  InspectorSection,
  InspectorSegmented,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  DESIGN_MIXED_VALUE,
  designMixedSegment,
  designMixedSelect,
  designStyleMixed,
  designValuesMixed,
} from "./design-style-mixed";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import {
  designPaintRemovalStyles,
  readDesignComputedStyle,
} from "./design-style-values";

type StrokeKind = "border" | "outline";

interface DesignStrokeSectionProps {
  details: DesignRuntimeNodeDetails;
  /** Every selected layer whose details are loaded, for Mixed readings. */
  selection?: readonly DesignRuntimeNodeDetails[];
  selectionCount?: number;
  disabled?: boolean;
  renderField: (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => React.ReactNode;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string | null>, label: string) => void;
}

const STROKE_STYLES = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "double", label: "Double" },
] as const;

const BORDER_SIDES = [
  ["Top", "border-top-width"],
  ["Right", "border-right-width"],
  ["Bottom", "border-bottom-width"],
  ["Left", "border-left-width"],
] as const;

const DEFAULT_STROKE_COLOR = "#000000"; // check:ui ignore-line -- authored CSS default for a new stroke.

export type DesignStrokeSides = "all" | "top" | "right" | "bottom" | "left" | "custom";

const SIDE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "top", label: "Top" },
  { value: "right", label: "Right" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
] as const;

/** Which sides a border draws: all four at one weight, one side alone, or a
 * custom mix that Stroke settings edits side by side. */
export function designStrokeSides(details: DesignRuntimeNodeDetails): DesignStrokeSides {
  const widths = BORDER_SIDES.map(([, property]) => Number.parseFloat(style(details, property)) || 0);
  if (widths.every((width) => width > 0 && width === widths[0])) return "all";
  const drawn = widths.flatMap((width, index) => (width > 0 ? [index] : []));
  if (drawn.length === 1)
    return (["top", "right", "bottom", "left"] as const)[drawn[0]!]!;
  return "custom";
}

export function designStrokeSideStyles(
  side: Exclude<DesignStrokeSides, "custom">,
  width: string,
): Record<string, string> {
  if (side === "all") return { "border-width": width };
  return Object.fromEntries(
    BORDER_SIDES.map(([label, property]) => [
      property,
      label.toLocaleLowerCase() === side ? width : "0px",
    ]),
  );
}

function style(details: DesignRuntimeNodeDetails, property: string): string {
  return readDesignComputedStyle(details.styles, property);
}

/** The first token of a possibly per-side shorthand ("solid none" → solid). */
function firstToken(value: string): string {
  return value.trim().split(/\s+/)[0] ?? "";
}

function hasWidth(value: string): boolean {
  return value
    .trim()
    .split(/\s+/)
    .some((part) => (Number.parseFloat(part) || 0) > 0);
}

function borderPresent(details: DesignRuntimeNodeDetails): boolean {
  const styles = style(details, "border-style");
  return (
    styles
      .split(/\s+/)
      .some((part) => part && part !== "none" && part !== "hidden") &&
    hasWidth(style(details, "border-width"))
  );
}

function outlinePresent(details: DesignRuntimeNodeDetails): boolean {
  const value = style(details, "outline-style");
  return (
    Boolean(value) &&
    value !== "none" &&
    hasWidth(style(details, "outline-width"))
  );
}

export function DesignStrokeSection({
  details,
  selection = [details],
  selectionCount = 1,
  disabled,
  renderField,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignStrokeSectionProps) {
  const strokes: StrokeKind[] = [
    ...(borderPresent(details) ? (["border"] as const) : []),
    ...(outlinePresent(details) ? (["outline"] as const) : []),
  ];
  const clear = (kind: StrokeKind) =>
    designPaintRemovalStyles(kind, details.authoredStyleProperties);

  const remove = (kind: StrokeKind) =>
    onCommit(clear(kind), "stroke");

  const add = () => {
    if (!strokes.includes("border")) {
      onCommit(
        {
          "border-width": "1px",
          "border-style": "solid",
          "border-color": DEFAULT_STROKE_COLOR,
        },
        "stroke",
      );
      return;
    }
    onCommit(
      {
        "outline-width": "1px",
        "outline-style": "solid",
        "outline-color": DEFAULT_STROKE_COLOR,
        "outline-offset": "0px",
      },
      "stroke",
    );
  };

  /** Moving a stroke between Inside and Outside rewrites it onto the other
   * CSS property in one transaction, keeping its weight, style and color. */
  const move = (kind: StrokeKind) => {
    const width = firstToken(style(details, `${kind}-width`)) || "1px";
    const lineStyle = firstToken(style(details, `${kind}-style`)) || "solid";
    const color = style(details, `${kind}-color`) || DEFAULT_STROKE_COLOR;
    if (kind === "border") {
      onCommit(
        {
          ...clear("border"),
          "outline-width": width,
          "outline-style": lineStyle,
          "outline-color": color,
          "outline-offset": "0px",
        },
        "stroke position",
      );
    } else {
      onCommit(
        {
          ...clear("outline"),
          "border-width": width,
          "border-style": lineStyle,
          "border-color": color,
        },
        "stroke position",
      );
    }
  };

  return (
    <InspectorSection
      title="Stroke"
      empty={strokes.length === 0}
      data-design-stroke-section=""
      actions={
        <InspectorIconButton
          label="Add stroke"
          disabled={disabled || strokes.length >= 2}
          onClick={add}
        >
          <Plus />
        </InspectorIconButton>
      }
    >
      {strokes.map((kind) => (
        <StrokeRows
          key={kind}
          kind={kind}
          details={details}
          selection={selection}
          selectionCount={selectionCount}
          disabled={disabled}
          canMove={strokes.length < 2}
          renderField={renderField}
          onPreview={onPreview}
          onCancelPreview={onCancelPreview}
          onCommit={onCommit}
          onMove={() => move(kind)}
          onRemove={() => remove(kind)}
        />
      ))}
    </InspectorSection>
  );
}

function StrokeRows({
  kind,
  details,
  selection,
  selectionCount,
  disabled,
  canMove,
  renderField,
  onPreview,
  onCancelPreview,
  onCommit,
  onMove,
  onRemove,
}: {
  kind: StrokeKind;
  details: DesignRuntimeNodeDetails;
  selection: readonly DesignRuntimeNodeDetails[];
  selectionCount: number;
  disabled?: boolean;
  canMove: boolean;
  renderField: DesignStrokeSectionProps["renderField"];
  onPreview?: DesignStrokeSectionProps["onPreview"];
  onCancelPreview?: () => void;
  onCommit: DesignStrokeSectionProps["onCommit"];
  onMove: () => void;
  onRemove: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const name = kind === "border" ? "Stroke" : "Outline";
  const colorProperty = `${kind}-color`;
  const colorToken = useDesignStyleToken(details, colorProperty);
  const lineStyle = firstToken(style(details, `${kind}-style`)) || "solid";
  const sides = kind === "border" ? designStrokeSides(details) : "all";
  const mixed = (property: string) =>
    designStyleMixed(selection, selectionCount, property);
  const sidesSelect = designMixedSelect(
    kind === "border" &&
      designValuesMixed(selection.map(designStrokeSides), selectionCount),
    sides,
    [
      ...SIDE_OPTIONS,
      ...(sides === "custom"
        ? [{ value: "custom" as const, label: "Custom", disabled: true }]
        : []),
    ],
  );
  const positionMixed = designValuesMixed(
    selection.map((node) => (borderPresent(node) ? "border" : "outline")),
    selectionCount,
  );
  return (
    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div
        className="relative flex min-w-0 flex-col gap-2"
        data-design-stroke={kind}
      >
        <div
          className={
            kind === "border"
              ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24px_24px] items-center gap-1"
              : "grid grid-cols-[minmax(0,1fr)_24px_24px] items-center gap-1"
          }
        >
          {renderField(
            `${name} weight`,
            `${kind}-width`,
            firstToken(style(details, `${kind}-width`)) || "0px",
            { icon: "stroke-weight" },
          )}
          {kind === "border" ? (
            <InspectorSelect
              label={`${name} sides`}
              filterCompanion
              value={sidesSelect.value}
              disabled={disabled}
              options={sidesSelect.options}
              onChange={(next) => {
                if (next === "custom" || next === DESIGN_MIXED_VALUE) return;
                const weight = BORDER_SIDES.map(([, property]) => Number.parseFloat(style(details, property)) || 0)
                  .reduce((largest, width) => Math.max(largest, width), 0);
                const styles = designStrokeSideStyles(
                  next as Exclude<DesignStrokeSides, "custom">,
                  `${weight || 1}px`,
                );
                onPreview?.(styles);
                onCommit(styles, `${name} sides`);
              }}
            />
          ) : null}
          <PopoverTrigger asChild>
            <InspectorIconButton label={`${name} settings`} disabled={disabled}>
              <Ellipsis />
            </InspectorIconButton>
          </PopoverTrigger>
          <InspectorIconButton
            label={`Remove ${name.toLocaleLowerCase()}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Minus />
          </InspectorIconButton>
          <InspectorPopoverAnchor />
        </div>
        <DesignColorField
          value={style(details, colorProperty) || DEFAULT_STROKE_COLOR}
          label={name}
          property={colorProperty}
          disabled={disabled}
          {...colorToken}
          mixed={mixed(colorProperty)}
          onPreview={(value) => onPreview?.({ [colorProperty]: value })}
          onCancelPreview={onCancelPreview}
          onCommit={(value) =>
            onCommit({ [colorProperty]: value }, `${name} color`)
          }
        />
      </div>
      <PopoverContent
        data-design-popover=""
        onOpenAutoFocus={focusDesignPopoverSurface}
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        className="w-60"
        onEscapeKeyDown={keepDesignPopoverWhileEditing}
      >
        <div className="zd-popover">
          <div className="zd-popover-header">
            <span className="zd-popover-title">{name} settings</span>
          </div>
          <InspectorSelect
            label={`${name} position`}
            {...designMixedSelect(
              positionMixed,
              kind === "border" ? "inside" : "outside",
              [
                { value: "inside", label: "Inside" },
                { value: "outside", label: "Outside" },
              ],
            )}
            disabled={disabled || !canMove}
            onChange={(value) => {
              if (value === DESIGN_MIXED_VALUE) return;
              if ((value === "outside") === (kind === "border")) onMove();
            }}
          />
          <InspectorSegmented
            label={`${name} style`}
            value={designMixedSegment(mixed(`${kind}-style`), lineStyle)}
            options={STROKE_STYLES}
            disabled={disabled}
            onChange={(value) => {
              const styles = { [`${kind}-style`]: value };
              onPreview?.(styles);
              onCommit(styles, `${name} style`);
            }}
          />
          {kind === "border" ? (
            <div className="grid grid-cols-2 gap-2">
              {BORDER_SIDES.map(([label, property]) =>
                renderField(
                  label,
                  property,
                  style(details, property) || "0px",
                  {
                    shortLabel: label[0],
                    whole: true,
                  },
                ),
              )}
            </div>
          ) : (
            renderField(
              "Offset",
              "outline-offset",
              style(details, "outline-offset") || "0px",
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
