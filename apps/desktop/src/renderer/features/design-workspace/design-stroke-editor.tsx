// ============================================
// COMPONENT: DesignStrokeSection
// PURPOSE: Figma-style strokes over CSS: an Inside stroke is the border, an
//          Outside stroke is the outline. Each stroke is one color row plus a
//          position / weight / settings row.
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
import {
  InspectorIconButton,
  InspectorSection,
  InspectorSegmented,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import {
  designPaintRemovalStyles,
  readDesignComputedStyle,
} from "./design-style-values";

type StrokeKind = "border" | "outline";

interface DesignStrokeSectionProps {
  details: DesignRuntimeNodeDetails;
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
  const lineStyle = firstToken(style(details, `${kind}-style`)) || "solid";
  return (
    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div
        className="relative flex min-w-0 flex-col gap-2"
        data-design-stroke={kind}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_24px] items-center gap-1">
          <DesignColorField
            value={style(details, colorProperty) || DEFAULT_STROKE_COLOR}
            label={name}
            property={colorProperty}
            disabled={disabled}
            onPreview={(value) => onPreview?.({ [colorProperty]: value })}
            onCancelPreview={onCancelPreview}
            onCommit={(value) =>
              onCommit({ [colorProperty]: value }, `${name} color`)
            }
          />
          <InspectorIconButton
            label={`Remove ${name.toLocaleLowerCase()}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Minus />
          </InspectorIconButton>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24px] items-center gap-2">
          <InspectorSelect
            label={`${name} position`}
            value={kind === "border" ? "inside" : "outside"}
            disabled={disabled || !canMove}
            options={[
              { value: "inside", label: "Inside" },
              { value: "outside", label: "Outside" },
            ]}
            onChange={(value) => {
              if ((value === "outside") === (kind === "border")) onMove();
            }}
          />
          {renderField(
            `${name} weight`,
            `${kind}-width`,
            firstToken(style(details, `${kind}-width`)) || "0px",
            { icon: "stroke-weight" },
          )}
          <PopoverTrigger asChild>
            <InspectorIconButton label={`${name} settings`} disabled={disabled}>
              <Ellipsis />
            </InspectorIconButton>
          </PopoverTrigger>
          <InspectorPopoverAnchor />
        </div>
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
          <InspectorSegmented
            label={`${name} style`}
            value={lineStyle}
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
