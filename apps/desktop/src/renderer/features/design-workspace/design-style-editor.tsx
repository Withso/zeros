// ============================================
// COMPONENT: DesignStyleEditor
// PURPOSE: Dense, progressive element styling, effects, motion, and CSS tools
// USED IN: DesignInspector for the exact selected data-oid
// ============================================

import React, { useState } from "react";
import {
  ChevronDown,
  Diamond,
  Play,
  RotateCw,
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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorPicker } from "./design-color-picker";
import {
  DesignShadowControl,
  DesignTransformControl,
} from "./design-effect-editor";
import { DesignAutoLayoutControls } from "./design-auto-layout-controls";
import { designRuntimeLayerLabel } from "./design-layer-label";
import {
  type DesignLayoutAction,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import { DesignFillEditor } from "./design-fill-editor";
import { readDesignComputedStyle } from "./design-style-values";
import { useDesignLivePreviewValue } from "./state/design-live-preview";

interface DesignLivePreviewOwner {
  workspaceId: string;
  frame: string;
  nodeId: string;
}

interface DesignStyleEditorProps {
  details: DesignRuntimeNodeDetails;
  livePreviewOwner?: DesignLivePreviewOwner;
  renderField: (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => React.ReactNode;
  onLayoutAction: (action: DesignLayoutAction) => Promise<void>;
  frameSelected?: boolean;
  layoutParents?: readonly DesignRuntimeNodeDetails[];
  onPreviewStyles?: (styles: Record<string, string | null>) => Promise<void>;
  onCancelStylePreview?: () => Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
  motionTimelineOpen?: boolean;
  motionProperties?: readonly string[];
  onOpenMotionTimeline: (property?: string, value?: string) => void;
  disabled?: boolean;
}

function LiveDesignTransformControl({
  owner,
  value,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  owner?: DesignLivePreviewOwner;
  value: string;
  disabled: boolean;
  onPreview: (value: string) => void;
  onCancelPreview: () => void;
  onCommit: (value: string) => void;
}) {
  const liveValue = useDesignLivePreviewValue(
    owner?.workspaceId ?? "",
    owner?.frame ?? "",
    owner?.nodeId ?? "",
    "transform",
  );
  return (
    <DesignTransformControl
      value={owner && liveValue !== undefined ? (liveValue ?? "none") : value}
      disabled={disabled}
      onPreview={onPreview}
      onCancelPreview={onCancelPreview}
      onCommit={onCommit}
    />
  );
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
  fixed = false,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  fixed?: boolean;
  defaultOpen?: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (fixed)
    return (
      <section
        data-design-layout-section={title === "Layout" ? "" : undefined}
        className="border-border1 border-b"
      >
        <h3 className="text-fg1 flex h-9 items-center px-3 text-xs font-medium">
          {title}
        </h3>
        <div className="flex flex-col gap-2 px-3 pb-3">{children}</div>
      </section>
    );
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="border-border1 border-b">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-bg1-hover flex h-9 w-full items-center gap-2 px-3 text-left"
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          >
            <span className="text-muted-fg [&>svg]:size-3.5">{icon}</span>
            <span className="text-fg1 text-xs font-medium">{title}</span>
            {summary ? (
              <span className="text-muted-fg ml-auto max-w-32 truncate text-[10px]">
                {summary}
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                "text-muted-fg size-3.5 transition-transform",
                open ? "rotate-0" : "-rotate-90",
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
    <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
      <span className="text-muted-fg truncate text-[10px]" title={label}>
        {label}
      </span>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          size="sm"
          className="zd-design-control-quiet h-7 w-full min-w-0 px-2 text-[11px]"
          aria-label={label}
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
  const choices = options.some((option) => option.value === value)
    ? options
    : [{ value, label: value, title: value }, ...options];
  return (
    <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
      <Label className="text-muted-fg truncate text-[10px]" title={label}>
        {label}
      </Label>
      <div
        className="zd-design-segment-group grid h-7 grid-flow-col rounded-sm"
        role="group"
        aria-label={label}
      >
        {choices.map((option) => (
          <Tooltip key={option.value} label={option.title ?? option.label}>
            <button
              type="button"
              disabled={disabled}
              aria-label={option.title ?? `${label}: ${option.label}`}
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

function MotionPropertyAction({
  label,
  property,
  value,
  active,
  timelineOpen,
  disabled,
  onRequest,
}: {
  label: string;
  property: string;
  value: string;
  active: boolean;
  timelineOpen: boolean;
  disabled?: boolean;
  onRequest: (property: string, value: string) => void;
}) {
  if (!timelineOpen) return null;

  return (
    <Tooltip
      label={
        active ? `Add ${label} keyframe at the playhead` : `Animate ${label}`
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "size-7 shrink-0 transition-opacity",
          active ? "zd-design-motion-property-active" : "opacity-100",
        )}
        aria-label={
          active ? `Add ${label} keyframe at the playhead` : `Animate ${label}`
        }
        disabled={disabled}
        onClick={() => onRequest(property, value)}
      >
        <Diamond className={cn("size-3", active && "fill-current")} />
      </Button>
    </Tooltip>
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

const OBJECT_FIT_TAGS = new Set(["img", "video", "canvas", "svg", "iframe"]);

export function DesignStyleEditor({
  details,
  livePreviewOwner,
  renderField,
  onPreviewStyles,
  onCancelStylePreview,
  onCommitStyles,
  onLayoutAction,
  frameSelected,
  layoutParents,
  motionTimelineOpen = false,
  motionProperties = [],
  onOpenMotionTimeline,
  disabled = false,
}: DesignStyleEditorProps) {
  const [appearanceAdvancedOpen, setAppearanceAdvancedOpen] = useState(false);
  const [typographyAdvancedOpen, setTypographyAdvancedOpen] = useState(false);

  const commit = (styles: Record<string, string | null>, label: string) => {
    // Selects and segmented controls do not emit a separate drag/change
    // preview. Mirror their choice into the mounted runtime immediately while
    // the ordered source mutation persists in the background.
    void onPreviewStyles?.(styles).catch(() => {});
    void onCommitStyles(styles).catch((error) => {
      toast.error(`Couldn't update ${label.toLocaleLowerCase()}`, {
        description: errorMessage(error),
      });
    });
  };

  const textLayer = designRuntimeLayerLabel(details) === "Text";
  const showAdvancedAppearance = appearanceAdvancedOpen;
  const showAdvancedTypography = typographyAdvancedOpen;

  return (
    <div data-design-style-editor className="flex flex-col">
      <StyleSection title="Layout" fixed>
        <DesignAutoLayoutControls
          details={details}
          livePreviewOwner={livePreviewOwner}
          renderField={renderField}
          disabled={disabled}
          frameSelected={frameSelected}
          layoutParents={layoutParents}
          onCommit={(styles) => commit(styles, "layout")}
          onAction={(action) => {
            void onLayoutAction(action).catch((error) =>
              toast.error("Couldn't update layout", {
                description: errorMessage(error),
              }),
            );
          }}
        />
        {OBJECT_FIT_TAGS.has(details.tag) ? (
          <>
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
              onChange={(value) =>
                commit({ "object-fit": value }, "object fit")
              }
            />
            {renderField(
              "Object",
              "object-position",
              styleValue(details, "object-position", "50% 50%"),
            )}
          </>
        ) : null}
      </StyleSection>

      <StyleSection
        title="Appearance"
        icon={<Square />}
        defaultOpen
        summary={textLayer ? "Text" : undefined}
      >
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Opacity",
            "opacity",
            styleValue(details, "opacity", "1"),
            { percentage: true, compact: true, icon: "opacity" },
          )}
          {!textLayer &&
            renderField(
              "Radius",
              "border-radius",
              styleValue(details, "border-radius", "0px"),
              { compact: true, shortLabel: "R" },
            )}
        </div>
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
      <StyleSection title="Fill" defaultOpen>
        <div className="group/motion flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            {textLayer ? (
              <ColorField
                label="Fill"
                property="color"
                value={styleValue(details, "color", "currentColor")}
                disabled={disabled}
                renderField={renderField}
                onPreview={(color) => void onPreviewStyles?.({ color })}
                onCancelPreview={() => void onCancelStylePreview?.()}
                onCommit={(color) => commit({ color }, "text fill")}
              />
            ) : (
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
            )}
          </div>
          <MotionPropertyAction
            label="fill"
            property={textLayer ? "color" : "background-color"}
            value={styleValue(
              details,
              textLayer ? "color" : "background-color",
              "transparent",
            )}
            active={motionProperties.includes(
              textLayer ? "color" : "background-color",
            )}
            timelineOpen={motionTimelineOpen}
            disabled={disabled}
            onRequest={onOpenMotionTimeline}
          />
        </div>
        {!textLayer &&
          styleValue(details, "background-blend-mode", "normal") !==
            "normal" && (
            <PropertySelect
              label="Fill mode"
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
          )}
      </StyleSection>
      <StyleSection title="Stroke">
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-fg h-7 justify-start px-1.5 text-[10px]"
          aria-expanded={showAdvancedAppearance}
          onClick={() => setAppearanceAdvancedOpen((open) => !open)}
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              showAdvancedAppearance ? "rotate-0" : "-rotate-90",
            )}
          />
          {showAdvancedAppearance
            ? "Hide independent sides"
            : "Independent sides"}
        </Button>
        {showAdvancedAppearance ? (
          <>
            <span className="text-muted-fg text-[10px] font-medium tracking-wide uppercase">
              Border width
            </span>
            <div className="grid grid-cols-2 gap-2">
              {renderField(
                "Top",
                "border-top-width",
                styleValue(details, "border-top-width", "0px"),
              )}
              {renderField(
                "Right",
                "border-right-width",
                styleValue(details, "border-right-width", "0px"),
              )}
              {renderField(
                "Bottom",
                "border-bottom-width",
                styleValue(details, "border-bottom-width", "0px"),
              )}
              {renderField(
                "Left",
                "border-left-width",
                styleValue(details, "border-left-width", "0px"),
              )}
            </div>
            <span className="text-muted-fg text-[10px] font-medium tracking-wide uppercase">
              Corner radius
            </span>
            <div className="grid grid-cols-2 gap-2">
              {renderField(
                "Top L",
                "border-top-left-radius",
                styleValue(details, "border-top-left-radius", "0px"),
              )}
              {renderField(
                "Top R",
                "border-top-right-radius",
                styleValue(details, "border-top-right-radius", "0px"),
              )}
              {renderField(
                "Bottom R",
                "border-bottom-right-radius",
                styleValue(details, "border-bottom-right-radius", "0px"),
              )}
              {renderField(
                "Bottom L",
                "border-bottom-left-radius",
                styleValue(details, "border-bottom-left-radius", "0px"),
              )}
            </div>
          </>
        ) : null}
        <span className="text-muted-fg mt-1 text-[10px] font-medium tracking-wide uppercase">
          Outline
        </span>
        <div className="grid grid-cols-2 gap-2">
          {renderField(
            "Width",
            "outline-width",
            styleValue(details, "outline-width", "0px"),
          )}
          {renderField(
            "Offset",
            "outline-offset",
            styleValue(details, "outline-offset", "0px"),
          )}
        </div>
        <PropertySelect
          label="Style"
          value={styleValue(details, "outline-style", "none")}
          disabled={disabled}
          options={[
            { value: "none", label: "None" },
            { value: "solid", label: "Solid" },
            { value: "dashed", label: "Dashed" },
            { value: "dotted", label: "Dotted" },
            { value: "double", label: "Double" },
          ]}
          onChange={(value) =>
            commit({ "outline-style": value }, "outline style")
          }
        />
        <ColorField
          label="Outline color"
          property="outline-color"
          value={styleValue(details, "outline-color", "currentColor")}
          disabled={disabled}
          renderField={renderField}
          onPreview={(value) =>
            void onPreviewStyles?.({ "outline-color": value })
          }
          onCancelPreview={() => void onCancelStylePreview?.()}
          onCommit={(value) =>
            commit({ "outline-color": value }, "outline color")
          }
        />
      </StyleSection>

      <StyleSection
        title="Typography"
        icon={<Type />}
        defaultOpen={Boolean(details.text)}
        summary={styleValue(details, "font-size")}
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
        <PropertySelect
          label="Style"
          value={styleValue(details, "font-style", "normal")}
          disabled={disabled}
          options={[
            { value: "normal", label: "Normal" },
            { value: "italic", label: "Italic" },
            { value: "oblique", label: "Oblique" },
          ]}
          onChange={(value) => commit({ "font-style": value }, "font style")}
        />
        {!textLayer && (
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
        )}
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
          label="White space"
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-fg h-7 justify-start px-1.5 text-[10px]"
          aria-expanded={showAdvancedTypography}
          onClick={() => setTypographyAdvancedOpen((open) => !open)}
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              showAdvancedTypography ? "rotate-0" : "-rotate-90",
            )}
          />
          {showAdvancedTypography ? "Hide text details" : "Text details"}
        </Button>
        {showAdvancedTypography ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {renderField(
                "Stretch",
                "font-stretch",
                styleValue(details, "font-stretch", "100%"),
              )}
              {renderField(
                "Word gap",
                "word-spacing",
                styleValue(details, "word-spacing", "0px"),
              )}
              {renderField(
                "Indent",
                "text-indent",
                styleValue(details, "text-indent", "0px"),
              )}
            </div>
            <PropertySelect
              label="Line wrap"
              value={styleValue(details, "text-wrap", "wrap")}
              disabled={disabled}
              options={[
                { value: "wrap", label: "Wrap" },
                { value: "nowrap", label: "No wrap" },
                { value: "balance", label: "Balance" },
                { value: "pretty", label: "Pretty" },
                { value: "stable", label: "Stable" },
              ]}
              onChange={(value) => commit({ "text-wrap": value }, "line wrap")}
            />
            <PropertySelect
              label="Overflow"
              value={styleValue(details, "text-overflow", "clip")}
              disabled={disabled}
              options={[
                { value: "clip", label: "Clip" },
                { value: "ellipsis", label: "Ellipsis" },
              ]}
              onChange={(value) =>
                commit({ "text-overflow": value }, "text overflow")
              }
            />
            <PropertySelect
              label="Word break"
              value={styleValue(details, "word-break", "normal")}
              disabled={disabled}
              options={[
                { value: "normal", label: "Normal" },
                { value: "break-all", label: "Break all" },
                { value: "keep-all", label: "Keep all" },
                { value: "break-word", label: "Break word" },
              ]}
              onChange={(value) =>
                commit({ "word-break": value }, "word break")
              }
            />
            <PropertySelect
              label="Long words"
              value={styleValue(details, "overflow-wrap", "normal")}
              disabled={disabled}
              options={[
                { value: "normal", label: "Normal" },
                { value: "break-word", label: "Break word" },
                { value: "anywhere", label: "Anywhere" },
              ]}
              onChange={(value) =>
                commit({ "overflow-wrap": value }, "long word wrapping")
              }
            />
            <PropertySelect
              label="Vertical"
              value={styleValue(details, "vertical-align", "baseline")}
              disabled={disabled}
              options={[
                { value: "baseline", label: "Baseline" },
                { value: "middle", label: "Middle" },
                { value: "top", label: "Top" },
                { value: "bottom", label: "Bottom" },
                { value: "text-top", label: "Text top" },
                { value: "text-bottom", label: "Text bottom" },
                { value: "sub", label: "Subscript" },
                { value: "super", label: "Superscript" },
              ]}
              onChange={(value) =>
                commit({ "vertical-align": value }, "vertical alignment")
              }
            />
            <PropertySelect
              label="Writing"
              value={styleValue(details, "writing-mode", "horizontal-tb")}
              disabled={disabled}
              options={[
                { value: "horizontal-tb", label: "Horizontal" },
                { value: "vertical-rl", label: "Vertical right" },
                { value: "vertical-lr", label: "Vertical left" },
              ]}
              onChange={(value) =>
                commit({ "writing-mode": value }, "writing mode")
              }
            />
            <PropertySelect
              label="Hyphens"
              value={styleValue(details, "hyphens", "manual")}
              disabled={disabled}
              options={[
                { value: "none", label: "None" },
                { value: "manual", label: "Manual" },
                { value: "auto", label: "Auto" },
              ]}
              onChange={(value) => commit({ hyphens: value }, "hyphens")}
            />
          </>
        ) : null}
      </StyleSection>

      <StyleSection
        title="Effects"
        icon={<Sparkles />}
        summary={styleValue(details, "box-shadow", "none")}
      >
        <div className="group/motion flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <DesignShadowControl
              label="Box shadow"
              value={styleValue(details, "box-shadow", "none")}
              disabled={disabled}
              onPreview={(value) =>
                void onPreviewStyles?.({ "box-shadow": value })
              }
              onCancelPreview={() => void onCancelStylePreview?.()}
              onCommit={(value) =>
                commit({ "box-shadow": value }, "box shadow")
              }
            />
          </div>
          <MotionPropertyAction
            label="box shadow"
            property="box-shadow"
            value={styleValue(details, "box-shadow", "none")}
            active={motionProperties.includes("box-shadow")}
            timelineOpen={motionTimelineOpen}
            disabled={disabled}
            onRequest={onOpenMotionTimeline}
          />
        </div>
        <div className="group/motion flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <DesignShadowControl
              label="Text shadow"
              value={styleValue(details, "text-shadow", "none")}
              textShadow
              disabled={disabled}
              onPreview={(value) =>
                void onPreviewStyles?.({ "text-shadow": value })
              }
              onCancelPreview={() => void onCancelStylePreview?.()}
              onCommit={(value) =>
                commit({ "text-shadow": value }, "text shadow")
              }
            />
          </div>
          <MotionPropertyAction
            label="text shadow"
            property="text-shadow"
            value={styleValue(details, "text-shadow", "none")}
            active={motionProperties.includes("text-shadow")}
            timelineOpen={motionTimelineOpen}
            disabled={disabled}
            onRequest={onOpenMotionTimeline}
          />
        </div>
        {renderField("Filter", "filter", styleValue(details, "filter", "none"))}
        {renderField(
          "Backdrop",
          "backdrop-filter",
          styleValue(details, "backdrop-filter", "none"),
        )}
        {renderField(
          "Clip path",
          "clip-path",
          styleValue(details, "clip-path", "none"),
        )}
      </StyleSection>

      <StyleSection
        title="Transform"
        icon={<RotateCw />}
        summary={styleValue(details, "transform", "none")}
      >
        <div className="group/motion flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <LiveDesignTransformControl
              owner={livePreviewOwner}
              value={styleValue(details, "transform", "none")}
              disabled={disabled}
              onPreview={(value) =>
                void onPreviewStyles?.({ transform: value })
              }
              onCancelPreview={() => void onCancelStylePreview?.()}
              onCommit={(value) => commit({ transform: value }, "transform")}
            />
          </div>
          <MotionPropertyAction
            label="transform"
            property="transform"
            value={styleValue(details, "transform", "none")}
            active={motionProperties.includes("transform")}
            timelineOpen={motionTimelineOpen}
            disabled={disabled}
            onRequest={onOpenMotionTimeline}
          />
        </div>
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
        {renderField(
          "Perspective origin",
          "perspective-origin",
          styleValue(details, "perspective-origin", "50% 50%"),
        )}
      </StyleSection>

      <StyleSection
        title="Transition"
        icon={<Play />}
        summary={styleValue(details, "transition-duration", "0s")}
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
      >
        <p className="text-muted-fg text-[11px] leading-4">
          Edit property tracks, keyframes, timing, and playback in the canvas
          timeline.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="zd-design-control-applied"
          disabled={disabled}
          onClick={() => onOpenMotionTimeline()}
        >
          <Diamond />
          Open motion timeline
        </Button>
      </StyleSection>
    </div>
  );
}
