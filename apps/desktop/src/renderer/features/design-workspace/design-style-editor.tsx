// ============================================
// COMPONENT: DesignStyleEditor
// PURPOSE: Figma-grade element styling over authored CSS: Layout,
//          Appearance, Fill, Stroke, Effects, Typography, Transform,
//          Transition and Motion as always-visible sections
// USED IN: DesignInspector for the exact selected data-oid
// ============================================

import React, { useState } from "react";
import { Blend, Diamond, Minus, Plus } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorField } from "./design-color-picker";
import {
  DesignEffectsSection,
  DesignTransformSection,
} from "./design-effect-editor";
import { DesignAutoLayoutControls } from "./design-auto-layout-controls";
import { designFillIsEmpty, DesignFillEditor } from "./design-fill-editor";
import {
  InspectorGlyph,
  InspectorIconButton,
  InspectorSection,
  InspectorSelect,
} from "./design-inspector-kit";
import { designRuntimeLayerLabel } from "./design-layer-label";
import {
  type DesignLayoutAction,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import { DesignStrokeSection } from "./design-stroke-editor";
import {
  designPaintRemovalStyles,
  isDesignRuntimeStylePropertyAuthored,
  readDesignComputedStyle,
} from "./design-style-values";
import { DesignTypographySection } from "./design-typography-editor";
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

const BLEND_MODES = [
  ["normal", "Normal"],
  ["darken", "Darken"],
  ["multiply", "Multiply"],
  ["color-burn", "Color burn"],
  ["lighten", "Lighten"],
  ["screen", "Screen"],
  ["color-dodge", "Color dodge"],
  ["overlay", "Overlay"],
  ["soft-light", "Soft light"],
  ["hard-light", "Hard light"],
  ["difference", "Difference"],
  ["exclusion", "Exclusion"],
  ["hue", "Hue"],
  ["saturation", "Saturation"],
  ["color", "Color"],
  ["luminosity", "Luminosity"],
] as const;

/** Menu groups mirror Figma's: normal, darken, lighten, contrast, compare,
 * component. A divider precedes each group's first mode. */
const BLEND_GROUP_STARTS = new Set([
  "darken",
  "lighten",
  "overlay",
  "difference",
  "hue",
]);

const EASINGS = [
  { value: "linear", label: "Linear" },
  { value: "ease", label: "Ease" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in-out", label: "Ease in out" },
] as const;

const OBJECT_FIT_TAGS = new Set(["img", "video", "canvas", "svg", "iframe"]);

/** A new frame fill starts white, as in Figma. Authored CSS, not chrome. */
const NEW_FILL_COLOR = "#FFFFFF"; // check:ui ignore-line -- authored CSS default

const CORNERS = [
  ["Top left", "border-top-left-radius", "radius-tl"],
  ["Top right", "border-top-right-radius", "radius-tr"],
  ["Bottom left", "border-bottom-left-radius", "radius-bl"],
  ["Bottom right", "border-bottom-right-radius", "radius-br"],
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The style could not be updated.";
}

function styleValue(
  details: DesignRuntimeNodeDetails,
  property: string,
  fallback = "",
): string {
  return readDesignComputedStyle(details.styles, property) || fallback;
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
    <InspectorIconButton
      label={
        active ? `Add ${label} keyframe at the playhead` : `Animate ${label}`
      }
      className={active ? "zd-design-motion-property-active" : undefined}
      disabled={disabled}
      onClick={() => onRequest(property, value)}
    >
      <Diamond className={cn("size-3", active && "fill-current")} />
    </InspectorIconButton>
  );
}

function LiveTransformSection(
  props: Omit<React.ComponentProps<typeof DesignTransformSection>, "value"> & {
    owner?: DesignLivePreviewOwner;
    confirmed: string;
  },
) {
  const { owner, confirmed, ...rest } = props;
  const liveValue = useDesignLivePreviewValue(
    owner?.workspaceId ?? "",
    owner?.frame ?? "",
    owner?.nodeId ?? "",
    "transform",
  );
  return (
    <DesignTransformSection
      {...rest}
      value={
        owner && liveValue !== undefined ? (liveValue ?? "none") : confirmed
      }
    />
  );
}

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
  const commit = (styles: Record<string, string | null>, label: string) => {
    // Selects and segmented controls do not emit a separate drag/change
    // preview. Mirror their choice into the mounted runtime immediately while
    // the ordered source mutation persists in the background.
    void onPreviewStyles?.(styles).catch(() => {});
    const task = onCommitStyles(styles);
    void task.catch((error) => {
      toast.error(`Couldn't update ${label.toLocaleLowerCase()}`, {
        description: errorMessage(error),
      });
    });
    return task;
  };
  const preview = (styles: Record<string, string | null>) =>
    void onPreviewStyles?.(styles).catch(() => {});
  const cancelPreview = () => void onCancelStylePreview?.().catch(() => {});
  const isAuthored = (property: string) =>
    isDesignRuntimeStylePropertyAuthored(
      details.authoredStyleProperties,
      property,
      styleValue(details, property),
    );
  const motion = {
    timelineOpen: motionTimelineOpen,
    properties: motionProperties,
    onRequest: onOpenMotionTimeline,
  };

  const textLayer = designRuntimeLayerLabel(details) === "Text";
  const radii = CORNERS.map(([, property]) =>
    styleValue(details, property, "0px"),
  );
  const [cornersOpen, setCornersOpen] = useState(false);
  const cornersDiffer = radii.some((radius) => radius !== radii[0]);
  const independentCorners = cornersOpen || cornersDiffer;
  const blendMode = styleValue(details, "mix-blend-mode", "normal");

  const fillProperty = textLayer ? "color" : "background-color";
  const fillColor = styleValue(
    details,
    fillProperty,
    textLayer ? "currentColor" : "transparent",
  );
  const fillImage = styleValue(details, "background-image", "none");
  // A fill the user authored stays a row even at 0% (so a popover editing it
  // stays open); only an unauthored, fully transparent background is empty.
  const fillEmpty =
    !textLayer &&
    designFillIsEmpty(fillColor, fillImage) &&
    !isAuthored("background-color") &&
    !isAuthored("background-image");

  const transitionDuration = styleValue(details, "transition-duration", "0s");
  const transitionActive =
    isAuthored("transition-property") ||
    isAuthored("transition-duration") ||
    transitionDuration
      .split(",")
      .some((duration) => (Number.parseFloat(duration) || 0) > 0);
  const animationName = styleValue(details, "animation-name", "none");

  return (
    <div data-design-style-editor className="flex flex-col">
      <InspectorSection title="Layout" data-design-layout-section="">
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
          <div className="grid grid-cols-2 gap-2">
            <InspectorSelect
              label="Fit"
              value={styleValue(details, "object-fit", "fill")}
              disabled={disabled}
              options={[
                { value: "fill", label: "Stretch" },
                { value: "contain", label: "Fit" },
                { value: "cover", label: "Fill" },
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
          </div>
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Appearance"
        data-design-appearance-section=""
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InspectorIconButton
                label="Blend mode"
                tooltip={`Blend · ${
                  BLEND_MODES.find(([value]) => value === blendMode)?.[1] ??
                  blendMode
                }`}
                pressed={blendMode !== "normal"}
                disabled={disabled}
              >
                <Blend />
              </InspectorIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel>Blend mode</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={blendMode}
                onValueChange={(value) =>
                  commit({ "mix-blend-mode": value }, "blend mode")
                }
              >
                {BLEND_MODES.map(([value, label]) => (
                  <React.Fragment key={value}>
                    {BLEND_GROUP_STARTS.has(value) ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    <DropdownMenuRadioItem value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  </React.Fragment>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <div
          className={cn(
            "grid items-center gap-2",
            textLayer
              ? "grid-cols-2"
              : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px]",
          )}
        >
          {renderField(
            "Opacity",
            "opacity",
            styleValue(details, "opacity", "1"),
            { percentage: true, compact: true, icon: "opacity" },
          )}
          {!textLayer
            ? renderField(
                "Radius",
                "border-radius",
                cornersDiffer
                  ? ""
                  : styleValue(details, "border-radius", "0px"),
                {
                  compact: true,
                  icon: "radius",
                  whole: true,
                  placeholder: cornersDiffer ? "Mixed" : undefined,
                },
              )
            : null}
          {!textLayer ? (
            <InspectorIconButton
              label="Independent corners"
              size="row"
              pressed={independentCorners}
              disabled={disabled}
              onClick={() => {
                if (cornersDiffer) {
                  commit({ "border-radius": radii[0] ?? "0px" }, "radius");
                  setCornersOpen(false);
                  return;
                }
                setCornersOpen((current) => !current);
              }}
            >
              <InspectorGlyph name="corners" />
            </InspectorIconButton>
          ) : null}
        </div>
        {!textLayer && independentCorners ? (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] gap-2">
            {CORNERS.slice(0, 2).map(([label, property, glyph]) => (
              <React.Fragment key={property}>
                {renderField(
                  label,
                  property,
                  styleValue(details, property, "0px"),
                  {
                    compact: true,
                    whole: true,
                    icon: glyph,
                  },
                )}
              </React.Fragment>
            ))}
            <span />
            {CORNERS.slice(2).map(([label, property, glyph]) => (
              <React.Fragment key={property}>
                {renderField(
                  label,
                  property,
                  styleValue(details, property, "0px"),
                  {
                    compact: true,
                    whole: true,
                    icon: glyph,
                  },
                )}
              </React.Fragment>
            ))}
          </div>
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Fill"
        empty={fillEmpty}
        data-design-fill-section=""
        actions={
          fillEmpty ? (
            <>
              <MotionPropertyAction
                label="fill"
                property={fillProperty}
                value={fillColor}
                active={motionProperties.includes(fillProperty)}
                timelineOpen={motionTimelineOpen}
                disabled={disabled}
                onRequest={onOpenMotionTimeline}
              />
              <InspectorIconButton
                label="Add fill"
                disabled={disabled}
                onClick={() =>
                  commit(
                    {
                      "background-color": NEW_FILL_COLOR,
                      "background-image": "none",
                    },
                    "fill",
                  )
                }
              >
                <Plus />
              </InspectorIconButton>
            </>
          ) : null
        }
      >
        <div
          className={cn(
            "grid min-w-0 items-center gap-1",
            textLayer
              ? "grid-cols-[minmax(0,1fr)_auto]"
              : "grid-cols-[minmax(0,1fr)_auto]",
          )}
        >
          {textLayer ? (
            <DesignColorField
              value={fillColor}
              label="Fill"
              property="color"
              disabled={disabled}
              onPreview={(color) => preview({ color })}
              onCancelPreview={cancelPreview}
              onCommit={(color) => commit({ color }, "text fill")}
            />
          ) : (
            <DesignFillEditor
              color={fillColor}
              image={fillImage}
              position={styleValue(details, "background-position", "0% 0%")}
              size={styleValue(details, "background-size", "auto")}
              repeat={styleValue(details, "background-repeat", "repeat")}
              disabled={disabled}
              onPreview={preview}
              onCancelPreview={cancelPreview}
              onCommit={(styles) => commit(styles, "fill")}
            />
          )}
          <div className="flex items-center">
            <MotionPropertyAction
              label="fill"
              property={fillProperty}
              value={fillColor}
              active={motionProperties.includes(fillProperty)}
              timelineOpen={motionTimelineOpen}
              disabled={disabled}
              onRequest={onOpenMotionTimeline}
            />
            {!textLayer ? (
              <InspectorIconButton
                label="Remove fill"
                disabled={disabled}
                onClick={() =>
                  commit(
                    designPaintRemovalStyles(
                      "fill",
                      details.authoredStyleProperties,
                    ),
                    "fill",
                  )
                }
              >
                <Minus />
              </InspectorIconButton>
            ) : null}
          </div>
        </div>
        {!textLayer &&
        styleValue(details, "background-blend-mode", "normal") !== "normal" ? (
          <InspectorSelect
            label="Fill blend"
            value={styleValue(details, "background-blend-mode", "normal")}
            disabled={disabled}
            options={BLEND_MODES.map(([value, label]) => ({ value, label }))}
            onChange={(value) =>
              commit({ "background-blend-mode": value }, "fill blend")
            }
          />
        ) : null}
      </InspectorSection>

      <DesignStrokeSection
        details={details}
        disabled={disabled}
        renderField={renderField}
        onPreview={preview}
        onCancelPreview={cancelPreview}
        onCommit={commit}
      />

      <DesignEffectsSection
        details={details}
        textLayer={textLayer}
        disabled={disabled}
        isAuthored={isAuthored}
        renderField={renderField}
        motion={motion}
        onPreview={preview}
        onCancelPreview={cancelPreview}
        onCommit={commit}
      />

      <DesignTypographySection
        details={details}
        textLayer={textLayer}
        disabled={disabled}
        isAuthored={isAuthored}
        renderField={renderField}
        onPreview={preview}
        onCancelPreview={cancelPreview}
        onCommit={commit}
      />

      <LiveTransformSection
        owner={livePreviewOwner}
        confirmed={styleValue(details, "transform", "none")}
        details={details}
        disabled={disabled}
        isAuthored={isAuthored}
        renderField={renderField}
        motion={motion}
        onPreview={preview}
        onCancelPreview={cancelPreview}
        onCommit={commit}
      />

      <InspectorSection
        title="Transition"
        empty={!transitionActive}
        data-design-transition-section=""
        actions={
          transitionActive ? (
            <InspectorIconButton
              label="Remove transition"
              disabled={disabled}
              onClick={() =>
                commit(
                  {
                    "transition-property": null,
                    "transition-duration": null,
                    "transition-delay": null,
                    "transition-timing-function": null,
                  },
                  "transition",
                )
              }
            >
              <Minus />
            </InspectorIconButton>
          ) : (
            <InspectorIconButton
              label="Add transition"
              disabled={disabled}
              onClick={() =>
                commit(
                  {
                    "transition-property": "all",
                    "transition-duration": "200ms",
                    "transition-timing-function": "ease-out",
                  },
                  "transition",
                )
              }
            >
              <Plus />
            </InspectorIconButton>
          )
        }
      >
        {renderField(
          "Property",
          "transition-property",
          styleValue(details, "transition-property", "all"),
        )}
        <div className="grid grid-cols-2 gap-2">
          {renderField("Duration", "transition-duration", transitionDuration)}
          {renderField(
            "Delay",
            "transition-delay",
            styleValue(details, "transition-delay", "0s"),
          )}
        </div>
        <InspectorSelect
          label="Easing"
          value={styleValue(details, "transition-timing-function", "ease")}
          disabled={disabled}
          options={EASINGS}
          onChange={(value) =>
            commit({ "transition-timing-function": value }, "easing")
          }
        />
      </InspectorSection>

      <InspectorSection
        title="Motion"
        empty={animationName === "none"}
        data-design-motion-section=""
        actions={
          <InspectorIconButton
            label="Open motion timeline"
            shortcut="⇧A"
            pressed={motionTimelineOpen}
            disabled={disabled}
            onClick={() => onOpenMotionTimeline()}
          >
            <Diamond />
          </InspectorIconButton>
        }
      >
        {animationName !== "none" ? (
          <button
            type="button"
            disabled={disabled}
            className="zd-field w-full min-w-0 gap-2 px-2 text-left disabled:opacity-50"
            aria-label={`Edit motion ${animationName}`}
            onClick={() => onOpenMotionTimeline()}
          >
            <Diamond className="size-3.5 shrink-0 fill-current text-[var(--design-selection-stroke)]" />
            <span className="text-fg1 min-w-0 flex-1 truncate">
              {animationName}
            </span>
            <span className="text-muted-fg text-3xxs shrink-0 tabular-nums">
              {styleValue(details, "animation-duration", "0s")}
            </span>
          </button>
        ) : null}
      </InspectorSection>
    </div>
  );
}
