// ============================================
// COMPONENT: DesignStyleEditor
// PURPOSE: Dense, progressive element styling, effects, motion, and CSS tools
// USED IN: DesignInspector for the exact selected data-oid
// ============================================

import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  Code2,
  Diamond,
  Layers3,
  Play,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Type,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorPicker } from "./design-color-picker";
import {
  DesignShadowControl,
  DesignTransformControl,
} from "./design-effect-editor";
import { DesignFillEditor } from "./design-fill-editor";
import {
  parseDesignCssDeclarations,
  readDesignComputedStyle,
  serializeDesignCssDeclarations,
} from "./design-style-values";

interface DesignStyleEditorProps {
  details: DesignRuntimeNodeDetails;
  renderField: (
    label: string,
    property: string,
    value: string,
  ) => React.ReactNode;
  onPreviewStyles?: (styles: Record<string, string | null>) => Promise<void>;
  onCancelStylePreview?: () => Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
  onOpenMotionTimeline: () => void;
  disabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The style could not be updated.";
}

function StyleSection({
  title,
  icon,
  defaultOpen = false,
  summary,
  filter = "",
  keywords = "",
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  summary?: string;
  filter?: string;
  keywords?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (
    filter &&
    !`${title} ${keywords}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase())
  ) {
    return null;
  }
  const effectiveOpen = Boolean(filter) || open;
  return (
    <Collapsible open={effectiveOpen} onOpenChange={setOpen}>
      <section className="border-border1 border-b">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-bg1-hover flex h-9 w-full items-center gap-2 px-3 text-left"
            aria-label={`${effectiveOpen ? "Collapse" : "Expand"} ${title}`}
          >
            <span className="text-fg3 [&>svg]:size-3.5">{icon}</span>
            <span className="text-fg1 text-xs font-medium">{title}</span>
            {summary ? (
              <span className="text-fg3 ml-auto max-w-32 truncate text-[10px]">
                {summary}
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                "text-fg3 size-3.5 transition-transform",
                effectiveOpen ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-1.5 px-3 pb-3">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function PropertySelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const choices = options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];
  return (
    <div className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
      <span className="text-fg3 truncate text-[10px]" title={label}>
        {label}
      </span>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          size="sm"
          className="zd-design-control-quiet h-7 w-full min-w-0 px-2 text-[11px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FlexAlignmentControl({
  align,
  justify,
  direction,
  disabled,
  onChange,
}: {
  align: string;
  justify: string;
  direction: string;
  disabled?: boolean;
  onChange: (styles: Record<string, string>) => void;
}) {
  const values = ["flex-start", "center", "flex-end"] as const;
  const column = direction.startsWith("column");
  const selectedX = column ? align : justify;
  const selectedY = column ? justify : align;
  return (
    <div className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-3">
      <div className="zd-design-control-applied grid size-[68px] grid-cols-3 rounded-md p-1">
        {values.flatMap((vertical) =>
          values.map((horizontal) => {
            const selected = selectedX === horizontal && selectedY === vertical;
            return (
              <button
                key={`${horizontal}:${vertical}`}
                type="button"
                disabled={disabled}
                aria-label={`Align ${horizontal} ${vertical}`}
                aria-pressed={selected}
                className="hover:bg-bg2-hover focus-visible:ring-highlighted-bright/50 relative rounded-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                onClick={() =>
                  onChange(
                    column
                      ? {
                          "align-items": horizontal,
                          "justify-content": vertical,
                        }
                      : {
                          "justify-content": horizontal,
                          "align-items": vertical,
                        },
                  )
                }
              >
                <span
                  className={cn(
                    "absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    selected ? "bg-highlighted-bright" : "bg-fg3",
                  )}
                />
              </button>
            );
          }),
        )}
      </div>
      <div className="text-fg3 flex flex-col gap-1.5 text-[10px]">
        <span className="text-fg2">Alignment</span>
        <span className="truncate">X · {selectedX}</span>
        <span className="truncate">Y · {selectedY}</span>
        <span>Click a point to align</span>
      </div>
    </div>
  );
}

function ChoiceGroup({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; title?: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
      <Label className="text-fg3 truncate text-[10px]" title={label}>
        {label}
      </Label>
      <div className="zd-design-segment-group grid h-7 grid-flow-col rounded-sm">
        {options.map((option) => (
          <Tooltip key={option.value} label={option.title ?? option.label}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={value === option.value}
              className={cn(
                "zd-design-segment text-fg2 min-w-0 px-1 text-[10px] disabled:opacity-50",
                value === option.value && "text-fg1",
              )}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function ColorField({
  label,
  property,
  value,
  disabled,
  renderField,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  label: string;
  property: string;
  value: string;
  disabled?: boolean;
  renderField: DesignStyleEditorProps["renderField"];
  onPreview?: (value: string) => void;
  onCancelPreview?: () => void;
  onCommit: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-end gap-2">
      <DesignColorPicker
        value={value}
        label={label}
        disabled={disabled}
        onPreview={onPreview}
        onCancelPreview={onCancelPreview}
        onCommit={onCommit}
      />
      {renderField(label, property, value)}
    </div>
  );
}

function styleValue(
  details: DesignRuntimeNodeDetails,
  property: string,
  fallback = "",
): string {
  return readDesignComputedStyle(details.styles, property) || fallback;
}

const CSS_EXPORT_PROPERTIES = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "aspect-ratio",
  "box-sizing",
  "z-index",
  "overflow",
  "object-fit",
  "object-position",
  "display",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "gap",
  "row-gap",
  "column-gap",
  "align-items",
  "align-self",
  "justify-content",
  "justify-self",
  "grid-template-columns",
  "grid-template-rows",
  "padding",
  "margin",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-blend-mode",
  "border",
  "border-radius",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "white-space",
  "opacity",
  "mix-blend-mode",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "transform",
  "transform-origin",
  "perspective",
  "transition",
  "animation",
] as const;

const OBJECT_FIT_TAGS = new Set(["img", "video", "canvas", "svg", "iframe"]);

const STYLE_SEARCH_INDEX = [
  "size position width height min max aspect ratio object fit overflow z-index",
  "layout display flex grid gap padding margin align justify wrap",
  "fill background gradient image border radius opacity blend",
  "typography text font color weight line height tracking alignment decoration",
  "effects shadow blur filter backdrop blend",
  "transform translate rotate scale skew origin perspective",
  "transition duration delay easing timing",
  "motion animation keyframes timeline iterations direction fill mode",
  "css declarations advanced code",
];

export function DesignStyleEditor({
  details,
  renderField,
  onPreviewStyles,
  onCancelStylePreview,
  onCommitStyles,
  onOpenMotionTimeline,
  disabled = false,
}: DesignStyleEditorProps) {
  const [cssDraft, setCssDraft] = useState("");
  const [propertyQuery, setPropertyQuery] = useState("");
  const [cssError, setCssError] = useState<string | null>(null);
  const [cssSaving, setCssSaving] = useState(false);

  const computedCss = useMemo(
    () =>
      serializeDesignCssDeclarations(
        Object.fromEntries(
          CSS_EXPORT_PROPERTIES.map((property) => [
            property,
            styleValue(details, property),
          ]).filter(([, value]) => Boolean(value)),
        ),
      ),
    [details],
  );

  const commit = (styles: Record<string, string | null>, label: string) => {
    void onCommitStyles(styles).catch((error) => {
      toast.error(`Couldn't update ${label.toLocaleLowerCase()}`, {
        description: errorMessage(error),
      });
    });
  };

  const applyCss = async () => {
    setCssError(null);
    setCssSaving(true);
    try {
      const declarations = parseDesignCssDeclarations(cssDraft, 64);
      if (Object.keys(declarations).length === 0) {
        throw new Error("Enter at least one CSS declaration.");
      }
      await onCommitStyles(declarations);
      setCssDraft("");
      toast.success("CSS declarations applied");
    } catch (error) {
      const message = errorMessage(error);
      setCssError(message);
      toast.error("Couldn't apply CSS", { description: message });
    } finally {
      setCssSaving(false);
    }
  };

  const normalizedQuery = propertyQuery.trim().toLocaleLowerCase();
  const hasSearchMatch =
    !normalizedQuery ||
    STYLE_SEARCH_INDEX.some((terms) => terms.includes(normalizedQuery));
  const display = styleValue(details, "display", "block");

  return (
    <div className="flex flex-col">
      <div className="bg-bg1 sticky top-0 z-10 flex h-11 items-center px-3">
        <div className="relative min-w-0 flex-1">
          <Search className="text-fg3 pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2" />
          <Input
            value={propertyQuery}
            className="zd-design-search h-7 pl-7 text-[11px]"
            aria-label="Find a style property"
            placeholder="Find a property"
            onChange={(event) => setPropertyQuery(event.currentTarget.value)}
          />
        </div>
      </div>
      {!hasSearchMatch ? (
        <div className="text-fg3 px-3 py-6 text-center text-xs">
          No visual control matches “{propertyQuery}”. Use CSS for any valid
          property.
        </div>
      ) : null}
      <StyleSection
        title="Size & position"
        icon={<Square />}
        defaultOpen
        summary={`${Math.round(details.rect.width)} × ${Math.round(details.rect.height)}`}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[0]}
      >
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "X",
            "left",
            styleValue(details, "left", `${Math.round(details.rect.x)}px`),
          )}
          {renderField(
            "Y",
            "top",
            styleValue(details, "top", `${Math.round(details.rect.y)}px`),
          )}
          {renderField(
            "W",
            "width",
            styleValue(details, "width", `${Math.round(details.rect.width)}px`),
          )}
          {renderField(
            "H",
            "height",
            styleValue(
              details,
              "height",
              `${Math.round(details.rect.height)}px`,
            ),
          )}
          {renderField(
            "Min W",
            "min-width",
            styleValue(details, "min-width", "0px"),
          )}
          {renderField(
            "Min H",
            "min-height",
            styleValue(details, "min-height", "0px"),
          )}
          {renderField(
            "Max W",
            "max-width",
            styleValue(details, "max-width", "none"),
          )}
          {renderField(
            "Max H",
            "max-height",
            styleValue(details, "max-height", "none"),
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Ratio",
            "aspect-ratio",
            styleValue(details, "aspect-ratio", "auto"),
          )}
          {renderField(
            "Object",
            "object-position",
            styleValue(details, "object-position", "50% 50%"),
          )}
        </div>
        {OBJECT_FIT_TAGS.has(details.tag) ? (
          <PropertySelect
            label="Fit"
            value={styleValue(details, "object-fit", "fill")}
            disabled={disabled}
            options={[
              { value: "fill", label: "Fill" },
              { value: "contain", label: "Fit" },
              { value: "cover", label: "Cover" },
              { value: "none", label: "None" },
              { value: "scale-down", label: "Scale down" },
            ]}
            onChange={(value) => commit({ "object-fit": value }, "object fit")}
          />
        ) : null}
        <PropertySelect
          label="Position"
          value={styleValue(details, "position", "static")}
          disabled={disabled}
          options={[
            { value: "static", label: "Static" },
            { value: "relative", label: "Relative" },
            { value: "absolute", label: "Absolute" },
            { value: "fixed", label: "Fixed" },
            { value: "sticky", label: "Sticky" },
          ]}
          onChange={(value) => commit({ position: value }, "position")}
        />
        <div className="grid grid-cols-2 gap-2">
          {renderField("Z", "z-index", styleValue(details, "z-index", "auto"))}
          {renderField(
            "Box",
            "box-sizing",
            styleValue(details, "box-sizing", "border-box"),
          )}
        </div>
        <PropertySelect
          label="Overflow"
          value={styleValue(details, "overflow", "visible")}
          disabled={disabled}
          options={[
            { value: "visible", label: "Visible" },
            { value: "hidden", label: "Hidden" },
            { value: "clip", label: "Clip" },
            { value: "auto", label: "Auto" },
            { value: "scroll", label: "Scroll" },
          ]}
          onChange={(value) => commit({ overflow: value }, "overflow")}
        />
      </StyleSection>

      <StyleSection
        title="Layout"
        icon={<Layers3 />}
        defaultOpen
        summary={display}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[1]}
      >
        <ChoiceGroup
          label="Display"
          value={display}
          disabled={disabled}
          options={[
            { value: "block", label: "Block" },
            { value: "flex", label: "Flex" },
            { value: "grid", label: "Grid" },
            { value: "none", label: "None" },
          ]}
          onChange={(value) => commit({ display: value }, "display")}
        />
        {display === "flex" ? (
          <>
            <ChoiceGroup
              label="Flow"
              value={styleValue(details, "flex-direction", "row")}
              disabled={disabled}
              options={[
                { value: "row", label: "→", title: "Row" },
                { value: "column", label: "↓", title: "Column" },
                { value: "row-reverse", label: "←", title: "Reverse row" },
                {
                  value: "column-reverse",
                  label: "↑",
                  title: "Reverse column",
                },
              ]}
              onChange={(value) => commit({ "flex-direction": value }, "flow")}
            />
            <FlexAlignmentControl
              align={styleValue(details, "align-items", "flex-start")}
              justify={styleValue(details, "justify-content", "flex-start")}
              direction={styleValue(details, "flex-direction", "row")}
              disabled={disabled}
              onChange={(styles) => commit(styles, "alignment")}
            />
            <div className="grid grid-cols-2 gap-2">
              {renderField("Gap", "gap", styleValue(details, "gap", "0px"))}
              {renderField(
                "Row",
                "row-gap",
                styleValue(details, "row-gap", "0px"),
              )}
            </div>
            <PropertySelect
              label="Wrap"
              value={styleValue(details, "flex-wrap", "nowrap")}
              disabled={disabled}
              options={[
                { value: "nowrap", label: "No wrap" },
                { value: "wrap", label: "Wrap" },
                { value: "wrap-reverse", label: "Reverse wrap" },
              ]}
              onChange={(value) => commit({ "flex-wrap": value }, "wrap")}
            />
          </>
        ) : null}
        {display === "grid" ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {renderField("Gap", "gap", styleValue(details, "gap", "0px"))}
              {renderField(
                "Row",
                "row-gap",
                styleValue(details, "row-gap", "0px"),
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {renderField(
                "Columns",
                "grid-template-columns",
                styleValue(details, "grid-template-columns", "none"),
              )}
              {renderField(
                "Rows",
                "grid-template-rows",
                styleValue(details, "grid-template-rows", "none"),
              )}
            </div>
          </>
        ) : null}
        <span className="text-fg3 text-[10px] font-medium tracking-wide uppercase">
          Padding
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          {renderField(
            "T",
            "padding-top",
            styleValue(details, "padding-top", "0px"),
          )}
          {renderField(
            "R",
            "padding-right",
            styleValue(details, "padding-right", "0px"),
          )}
          {renderField(
            "B",
            "padding-bottom",
            styleValue(details, "padding-bottom", "0px"),
          )}
          {renderField(
            "L",
            "padding-left",
            styleValue(details, "padding-left", "0px"),
          )}
        </div>
        <span className="text-fg3 text-[10px] font-medium tracking-wide uppercase">
          Margin
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          {renderField(
            "T",
            "margin-top",
            styleValue(details, "margin-top", "0px"),
          )}
          {renderField(
            "R",
            "margin-right",
            styleValue(details, "margin-right", "0px"),
          )}
          {renderField(
            "B",
            "margin-bottom",
            styleValue(details, "margin-bottom", "0px"),
          )}
          {renderField(
            "L",
            "margin-left",
            styleValue(details, "margin-left", "0px"),
          )}
        </div>
        <span className="text-fg3 text-[10px] font-medium tracking-wide uppercase">
          Flex child
        </span>
        <ChoiceGroup
          label="Grow"
          value={styleValue(details, "flex-grow", "0")}
          disabled={disabled}
          options={[
            { value: "0", label: "0", title: "Do not grow" },
            { value: "1", label: "1", title: "Fill available space" },
            { value: "2", label: "2", title: "Grow twice as much" },
          ]}
          onChange={(value) => commit({ "flex-grow": value }, "flex grow")}
        />
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Shrink",
            "flex-shrink",
            styleValue(details, "flex-shrink", "1"),
          )}
          {renderField(
            "Basis",
            "flex-basis",
            styleValue(details, "flex-basis", "auto"),
          )}
          {renderField("Order", "order", styleValue(details, "order", "0"))}
          <PropertySelect
            label="Self"
            value={styleValue(details, "align-self", "auto")}
            disabled={disabled}
            options={[
              { value: "auto", label: "Auto" },
              { value: "flex-start", label: "Start" },
              { value: "center", label: "Center" },
              { value: "flex-end", label: "End" },
              { value: "stretch", label: "Stretch" },
            ]}
            onChange={(value) => commit({ "align-self": value }, "align self")}
          />
        </div>
      </StyleSection>

      <StyleSection
        title="Fill & border"
        icon={<Square />}
        defaultOpen
        summary={styleValue(details, "background-color", "transparent")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[2]}
      >
        <DesignFillEditor
          color={styleValue(details, "background-color", "transparent")}
          image={styleValue(details, "background-image", "none")}
          position={styleValue(details, "background-position", "0% 0%")}
          size={styleValue(details, "background-size", "auto")}
          repeat={styleValue(details, "background-repeat", "repeat")}
          disabled={disabled}
          onPreview={(styles) => void onPreviewStyles?.(styles)}
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(styles) => commit(styles, "fill")}
        />
        <PropertySelect
          label="Blend"
          value={styleValue(details, "background-blend-mode", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "multiply", label: "Multiply" },
            { value: "screen", label: "Screen" },
            { value: "overlay", label: "Overlay" },
            { value: "soft-light", label: "Soft light" },
          ]}
          onChange={(value) =>
            commit({ "background-blend-mode": value }, "blend")
          }
        />
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Width",
            "border-width",
            styleValue(details, "border-width", "0px"),
          )}
          <PropertySelect
            label="Style"
            value={styleValue(details, "border-style", "none")}
            disabled={disabled}
            options={[
              { value: "none", label: "None" },
              { value: "solid", label: "Solid" },
              { value: "dashed", label: "Dashed" },
              { value: "dotted", label: "Dotted" },
              { value: "double", label: "Double" },
            ]}
            onChange={(value) =>
              commit({ "border-style": value }, "border style")
            }
          />
        </div>
        <ColorField
          label="Border color"
          property="border-color"
          value={styleValue(details, "border-color", "transparent")}
          disabled={disabled}
          renderField={renderField}
          onPreview={(value) =>
            void onPreviewStyles?.({ "border-color": value })
          }
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) =>
            commit({ "border-color": value }, "border color")
          }
        />
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Radius",
            "border-radius",
            styleValue(details, "border-radius", "0px"),
          )}
          {renderField(
            "Opacity",
            "opacity",
            styleValue(details, "opacity", "1"),
          )}
        </div>
      </StyleSection>

      <StyleSection
        title="Typography"
        icon={<Type />}
        defaultOpen={Boolean(details.text)}
        summary={styleValue(details, "font-size")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[3]}
      >
        {renderField("Font", "font-family", styleValue(details, "font-family"))}
        <div className="grid grid-cols-2 gap-2">
          {renderField("Size", "font-size", styleValue(details, "font-size"))}
          {renderField(
            "Weight",
            "font-weight",
            styleValue(details, "font-weight"),
          )}
          {renderField(
            "Line",
            "line-height",
            styleValue(details, "line-height"),
          )}
          {renderField(
            "Tracking",
            "letter-spacing",
            styleValue(details, "letter-spacing"),
          )}
        </div>
        <ColorField
          label="Text color"
          property="color"
          value={styleValue(details, "color", "currentColor")}
          disabled={disabled}
          renderField={renderField}
          onPreview={(value) => void onPreviewStyles?.({ color: value })}
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) => commit({ color: value }, "text color")}
        />
        <ChoiceGroup
          label="Align"
          value={styleValue(details, "text-align", "start")}
          disabled={disabled}
          options={[
            { value: "start", label: "L", title: "Start" },
            { value: "center", label: "C", title: "Center" },
            { value: "end", label: "R", title: "End" },
            { value: "justify", label: "J", title: "Justify" },
          ]}
          onChange={(value) => commit({ "text-align": value }, "text align")}
        />
        <PropertySelect
          label="Case"
          value={styleValue(details, "text-transform", "none")}
          disabled={disabled}
          options={[
            { value: "none", label: "Original" },
            { value: "uppercase", label: "Uppercase" },
            { value: "lowercase", label: "Lowercase" },
            { value: "capitalize", label: "Capitalize" },
          ]}
          onChange={(value) => commit({ "text-transform": value }, "case")}
        />
        <PropertySelect
          label="Decorate"
          value={styleValue(details, "text-decoration", "none")}
          disabled={disabled}
          options={[
            { value: "none", label: "None" },
            { value: "underline", label: "Underline" },
            { value: "line-through", label: "Strike through" },
            { value: "overline", label: "Overline" },
          ]}
          onChange={(value) =>
            commit({ "text-decoration": value }, "decoration")
          }
        />
        <PropertySelect
          label="Wrap"
          value={styleValue(details, "white-space", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "nowrap", label: "No wrap" },
            { value: "pre-wrap", label: "Preserve" },
            { value: "break-spaces", label: "Break spaces" },
          ]}
          onChange={(value) => commit({ "white-space": value }, "wrap")}
        />
      </StyleSection>

      <StyleSection
        title="Effects"
        icon={<Sparkles />}
        summary={styleValue(details, "box-shadow", "none")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[4]}
      >
        <DesignShadowControl
          label="Box shadow"
          value={styleValue(details, "box-shadow", "none")}
          disabled={disabled}
          onPreview={(value) => void onPreviewStyles?.({ "box-shadow": value })}
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) => commit({ "box-shadow": value }, "box shadow")}
        />
        <DesignShadowControl
          label="Text shadow"
          value={styleValue(details, "text-shadow", "none")}
          textShadow
          disabled={disabled}
          onPreview={(value) =>
            void onPreviewStyles?.({ "text-shadow": value })
          }
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) => commit({ "text-shadow": value }, "text shadow")}
        />
        {renderField("Filter", "filter", styleValue(details, "filter", "none"))}
        {renderField(
          "Backdrop",
          "backdrop-filter",
          styleValue(details, "backdrop-filter", "none"),
        )}
        <PropertySelect
          label="Blend"
          value={styleValue(details, "mix-blend-mode", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "multiply", label: "Multiply" },
            { value: "screen", label: "Screen" },
            { value: "overlay", label: "Overlay" },
            { value: "difference", label: "Difference" },
          ]}
          onChange={(value) =>
            commit({ "mix-blend-mode": value }, "blend mode")
          }
        />
      </StyleSection>

      <StyleSection
        title="Transform"
        icon={<RotateCw />}
        summary={styleValue(details, "transform", "none")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[5]}
      >
        <DesignTransformControl
          value={styleValue(details, "transform", "none")}
          disabled={disabled}
          onPreview={(value) => void onPreviewStyles?.({ transform: value })}
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) => commit({ transform: value }, "transform")}
        />
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Origin",
            "transform-origin",
            styleValue(details, "transform-origin", "50% 50%"),
          )}
          {renderField(
            "Perspective",
            "perspective",
            styleValue(details, "perspective", "none"),
          )}
        </div>
      </StyleSection>

      <StyleSection
        title="Transition"
        icon={<Play />}
        summary={styleValue(details, "transition-duration", "0s")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[6]}
      >
        {renderField(
          "Property",
          "transition-property",
          styleValue(details, "transition-property", "all"),
        )}
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Duration",
            "transition-duration",
            styleValue(details, "transition-duration", "0s"),
          )}
          {renderField(
            "Delay",
            "transition-delay",
            styleValue(details, "transition-delay", "0s"),
          )}
        </div>
        <PropertySelect
          label="Easing"
          value={styleValue(details, "transition-timing-function", "ease")}
          disabled={disabled}
          options={[
            { value: "linear", label: "Linear" },
            { value: "ease", label: "Ease" },
            { value: "ease-in", label: "Ease in" },
            { value: "ease-out", label: "Ease out" },
            { value: "ease-in-out", label: "Ease in out" },
          ]}
          onChange={(value) =>
            commit({ "transition-timing-function": value }, "easing")
          }
        />
      </StyleSection>

      <StyleSection
        title="Motion"
        icon={<Diamond />}
        summary={styleValue(details, "animation-name", "none")}
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[7]}
      >
        <p className="text-fg3 text-[11px] leading-4">
          Edit property tracks, keyframes, timing, and playback in the canvas
          timeline.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="zd-design-control-applied"
          disabled={disabled}
          onClick={onOpenMotionTimeline}
        >
          <Diamond />
          Open motion timeline
        </Button>
      </StyleSection>

      <StyleSection
        title="CSS"
        icon={<Code2 />}
        summary="Declarations"
        filter={normalizedQuery}
        keywords={STYLE_SEARCH_INDEX[8]}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-fg3 text-xs">
            Paste a declaration list; selectors and nested rules are rejected.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCssDraft(computedCss);
              setCssError(null);
            }}
          >
            Computed
          </Button>
        </div>
        <Textarea
          value={cssDraft}
          className="zd-design-control-applied min-h-32 resize-y font-mono text-xs"
          aria-label="Element CSS declarations"
          placeholder={"display: flex;\ngap: 16px;\ntransform: translateY(0);"}
          spellCheck={false}
          onChange={(event) => {
            setCssDraft(event.target.value);
            setCssError(null);
          }}
        />
        {cssError ? (
          <span className="text-red-primary text-xs">{cssError}</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={disabled || cssSaving || !cssDraft.trim()}
          onClick={() => void applyCss()}
        >
          <Plus />
          {cssSaving ? "Applying…" : "Apply CSS"}
        </Button>
      </StyleSection>
    </div>
  );
}
