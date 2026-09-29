// ============================================
// COMPONENT: DesignEffectsSection / DesignTransformSection
// PURPOSE: Figma-style effect rows (drop/inner shadow, layer/background blur)
//          and the transform popover, both over authored CSS
// USED IN: DesignStyleEditor
// ============================================

import React, { useEffect, useRef, useState } from "react";
import { Box, Diamond, Minus, Plus, RotateCcw, Sun } from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorField } from "./design-color-picker";
import {
  InspectorIconButton,
  InspectorSection,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  designEffectEntries,
  designEffectKindAvailable,
  designEffectLabel,
  designEffectsAdd,
  designEffectsChangeKind,
  designEffectsRemove,
  designEffectsUpdateBlur,
  designEffectsUpdateShadow,
  designRawEffectFilters,
  formatDesignTransform,
  parseDesignTransform,
  DESIGN_EFFECT_LIMIT,
  type DesignEffectEntry,
  type DesignEffectKind,
  type DesignEffectsState,
  type DesignShadowValue,
  type DesignTransformValue,
} from "./design-effect-values";
import type { DesignLayoutFieldOptions } from "./design-layout-values";
import { readDesignComputedStyle } from "./design-style-values";

type RenderField = (
  label: string,
  property: string,
  value: string,
  options?: DesignLayoutFieldOptions,
) => React.ReactNode;

interface DesignMotionActions {
  timelineOpen: boolean;
  properties: readonly string[];
  onRequest: (property: string, value: string) => void;
}

// --- NUMBER FIELD ---

/** A compact numeric field for popover-local values. The label scrubs; typed
 * text stays a draft until Enter or blur. */
export function EffectNumberField({
  label,
  name,
  value,
  step = 1,
  minimum,
  suffix,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  label: string;
  /** Accessible name when the visible label is a letter. */
  name?: string;
  value: number;
  step?: number;
  minimum?: number;
  suffix?: string;
  disabled?: boolean;
  onPreview?: (value: number) => void;
  onCancelPreview?: () => void;
  onCommit: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(String(value));
  const skipCommitRef = useRef(false);
  const previewedRef = useRef(false);
  const focusBaselineRef = useRef(value);
  const scrubRef = useRef<{
    pointerId: number;
    startX: number;
    start: number;
    latest: number;
  } | null>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current && !scrubRef.current)
      setDraft(String(value));
  }, [value]);

  const clampValue = (next: number) =>
    Math.round(
      (minimum === undefined ? next : Math.max(minimum, next)) * 1_000,
    ) / 1_000;

  const commitDraft = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    const previewed = previewedRef.current;
    previewedRef.current = false;
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(focusBaselineRef.current));
      if (previewed) onCancelPreview?.();
      return;
    }
    const next = clampValue(parsed);
    setDraft(String(next));
    if (next !== focusBaselineRef.current) onCommit(next);
    else if (previewed) onCancelPreview?.();
  };

  return (
    <div className="zd-field">
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={`Scrub ${name ?? label}`}
        className="zd-field-label zd-field-scrub w-6 cursor-ew-resize"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          scrubRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            start: value,
            latest: value,
          };
        }}
        onPointerMove={(event) => {
          const scrub = scrubRef.current;
          if (!scrub || scrub.pointerId !== event.pointerId) return;
          const multiplier = event.shiftKey ? 10 : 1;
          const next = clampValue(
            scrub.start +
              ((event.clientX - scrub.startX) / 2) * step * multiplier,
          );
          if (next === scrub.latest) return;
          scrub.latest = next;
          setDraft(String(next));
          previewedRef.current = true;
          onPreview?.(next);
        }}
        onPointerUp={(event) => {
          const scrub = scrubRef.current;
          if (!scrub || scrub.pointerId !== event.pointerId) return;
          scrubRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const previewed = previewedRef.current;
          previewedRef.current = false;
          if (scrub.latest !== scrub.start) {
            focusBaselineRef.current = scrub.latest;
            onCommit(scrub.latest);
          } else if (previewed) onCancelPreview?.();
        }}
        onPointerCancel={() => {
          const start = scrubRef.current?.start ?? value;
          scrubRef.current = null;
          setDraft(String(start));
          if (previewedRef.current) onCancelPreview?.();
          previewedRef.current = false;
        }}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-label={name ?? label}
        className={suffix ? "pr-1" : "pr-2"}
        onFocus={() => {
          focusBaselineRef.current = value;
          skipCommitRef.current = false;
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            event.preventDefault();
            skipCommitRef.current = true;
            setDraft(String(focusBaselineRef.current));
            if (previewedRef.current) onCancelPreview?.();
            previewedRef.current = false;
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const parsed = Number(draft);
            const next = clampValue(
              (Number.isFinite(parsed) ? parsed : value) +
                (event.key === "ArrowUp" ? step : -step) *
                  (event.shiftKey ? 10 : 1),
            );
            setDraft(String(next));
            previewedRef.current = true;
            onPreview?.(next);
          }
        }}
      />
      {suffix ? <span className="zd-field-suffix">{suffix}</span> : null}
    </div>
  );
}

// --- EFFECTS ---

const EFFECT_KINDS: readonly { value: DesignEffectKind; label: string }[] = [
  { value: "drop-shadow", label: "Drop shadow" },
  { value: "inner-shadow", label: "Inner shadow" },
  { value: "layer-blur", label: "Layer blur" },
  { value: "background-blur", label: "Background blur" },
];

function MotionDiamond({
  label,
  property,
  value,
  motion,
  disabled,
}: {
  label: string;
  property: string;
  value: string;
  motion?: DesignMotionActions;
  disabled?: boolean;
}) {
  if (!motion?.timelineOpen) return null;
  const active = motion.properties.includes(property);
  return (
    <InspectorIconButton
      label={
        active ? `Add ${label} keyframe at the playhead` : `Animate ${label}`
      }
      className={active ? "text-[var(--design-selection-stroke)]" : undefined}
      disabled={disabled}
      onClick={() => motion.onRequest(property, value)}
    >
      <Diamond className={cn("size-3", active && "fill-current")} />
    </InspectorIconButton>
  );
}

interface DesignEffectsSectionProps {
  details: DesignRuntimeNodeDetails;
  textLayer: boolean;
  disabled?: boolean;
  isAuthored: (property: string) => boolean;
  renderField: RenderField;
  motion?: DesignMotionActions;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string | null>, label: string) => void;
}

export function DesignEffectsSection({
  details,
  textLayer,
  disabled,
  isAuthored,
  renderField,
  motion,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignEffectsSectionProps) {
  const read = (property: string, fallback = "none") =>
    readDesignComputedStyle(details.styles, property) || fallback;
  const state: DesignEffectsState = {
    boxShadow: read("box-shadow"),
    textShadow: read("text-shadow"),
    filter: read("filter"),
    backdropFilter: read("backdrop-filter"),
  };
  const entries = designEffectEntries(state, textLayer);
  const raw = designRawEffectFilters(state);
  const clipPath = read("clip-path");
  const hasClipPath = clipPath !== "none" && clipPath !== "";
  const empty =
    entries.length === 0 &&
    !raw.boxShadow &&
    !raw.textShadow &&
    !raw.filter &&
    !raw.backdropFilter &&
    !hasClipPath;
  // A raw shadow list cannot take a structured shadow without rewriting it.
  const addBlocked = textLayer ? raw.textShadow : raw.boxShadow;

  /** A property the element no longer needs is removed where it was
   * authored instead of being pinned to an explicit `none`. */
  const settle = (styles: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(styles).map(([property, value]) => [
        property,
        value === "none" && isAuthored(property) ? null : value,
      ]),
    );

  const add = () => {
    const styles = designEffectsAdd(state, textLayer);
    if (!styles) return;
    onPreview?.(styles);
    onCommit(styles, "effect");
  };

  return (
    <InspectorSection
      title="Effects"
      empty={empty}
      data-design-effects-section=""
      actions={
        <>
          {entries.some(
            (entry) =>
              entry.property === (textLayer ? "text-shadow" : "box-shadow"),
          ) ? null : (
            <MotionDiamond
              label={textLayer ? "text shadow" : "box shadow"}
              property={textLayer ? "text-shadow" : "box-shadow"}
              value={textLayer ? state.textShadow : state.boxShadow}
              motion={motion}
              disabled={disabled}
            />
          )}
          <InspectorIconButton
            label="Add effect"
            disabled={
              disabled || addBlocked || entries.length >= DESIGN_EFFECT_LIMIT
            }
            onClick={add}
          >
            <Plus />
          </InspectorIconButton>
        </>
      }
    >
      {entries.map((entry) => (
        <EffectRow
          key={entry.id}
          entry={entry}
          state={state}
          textLayer={textLayer}
          disabled={disabled}
          motion={motion}
          onPreview={onPreview}
          onCancelPreview={onCancelPreview}
          onCommit={(styles, label) => onCommit(settle(styles), label)}
        />
      ))}
      {raw.boxShadow ? (
        <RawEffectRow
          label="Shadow"
          property="box-shadow"
          value={state.boxShadow}
          disabled={disabled}
          renderField={renderField}
          onRemove={() => onCommit(settle({ "box-shadow": "none" }), "shadow")}
        />
      ) : null}
      {raw.textShadow ? (
        <RawEffectRow
          label="Text shadow"
          property="text-shadow"
          value={state.textShadow}
          disabled={disabled}
          renderField={renderField}
          onRemove={() =>
            onCommit(settle({ "text-shadow": "none" }), "text shadow")
          }
        />
      ) : null}
      {raw.filter ? (
        <RawEffectRow
          label="Filter"
          property="filter"
          value={state.filter}
          disabled={disabled}
          renderField={renderField}
          onRemove={() => onCommit(settle({ filter: "none" }), "filter")}
        />
      ) : null}
      {raw.backdropFilter ? (
        <RawEffectRow
          label="Backdrop"
          property="backdrop-filter"
          value={state.backdropFilter}
          disabled={disabled}
          renderField={renderField}
          onRemove={() =>
            onCommit(settle({ "backdrop-filter": "none" }), "backdrop filter")
          }
        />
      ) : null}
      {hasClipPath ? (
        <RawEffectRow
          label="Clip path"
          property="clip-path"
          value={clipPath}
          disabled={disabled}
          renderField={renderField}
          onRemove={() =>
            onCommit(settle({ "clip-path": "none" }), "clip path")
          }
        />
      ) : null}
    </InspectorSection>
  );
}

function RawEffectRow({
  label,
  property,
  value,
  disabled,
  renderField,
  onRemove,
}: {
  label: string;
  property: string;
  value: string;
  disabled?: boolean;
  renderField: RenderField;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_24px] items-center gap-1">
      {renderField(label, property, value)}
      <InspectorIconButton
        label={`Remove ${label.toLocaleLowerCase()}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Minus />
      </InspectorIconButton>
    </div>
  );
}

function EffectRow({
  entry,
  state,
  textLayer,
  disabled,
  motion,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  entry: DesignEffectEntry;
  state: DesignEffectsState;
  textLayer: boolean;
  disabled?: boolean;
  motion?: DesignMotionActions;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string>, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = designEffectLabel(entry, textLayer);
  const kinds =
    entry.property === "text-shadow" && !textLayer
      ? [{ value: "drop-shadow" as const, label: "Text shadow" }]
      : EFFECT_KINDS;
  const currentValue =
    entry.property === "box-shadow"
      ? state.boxShadow
      : entry.property === "text-shadow"
        ? state.textShadow
        : entry.property === "filter"
          ? state.filter
          : state.backdropFilter;
  const blur = entry.kind === "layer-blur" || entry.kind === "background-blur";

  const previewShadow = (shadow: DesignShadowValue) =>
    onPreview?.(designEffectsUpdateShadow(state, entry, shadow));
  const commitShadow = (shadow: DesignShadowValue) =>
    onCommit(designEffectsUpdateShadow(state, entry, shadow), label);

  return (
    <div
      className="relative grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-1"
      data-design-effect={entry.kind}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <InspectorIconButton
            label={`Edit ${label.toLocaleLowerCase()}`}
            tooltip={`${label} settings`}
            disabled={disabled}
          >
            <Sun />
          </InspectorIconButton>
        </PopoverTrigger>
        <InspectorPopoverAnchor />
        <PopoverContent
          data-design-popover=""
          onOpenAutoFocus={focusDesignPopoverSurface}
          side="left"
          align="start"
          sideOffset={8}
          padding="none"
          className="w-60"
          onEscapeKeyDown={(event) => {
            if (keepDesignPopoverWhileEditing(event)) return;
            onCancelPreview?.();
          }}
        >
          <div className="zd-popover">
            <div className="zd-popover-header">
              <span className="zd-popover-title">{label}</span>
            </div>
            {blur ? (
              <EffectNumberField
                label="B"
                name={`${label} radius`}
                value={entry.radius ?? 0}
                minimum={0}
                suffix="px"
                disabled={disabled}
                onCancelPreview={onCancelPreview}
                onPreview={(radius) =>
                  onPreview?.(designEffectsUpdateBlur(entry, radius))
                }
                onCommit={(radius) =>
                  onCommit(designEffectsUpdateBlur(entry, radius), label)
                }
              />
            ) : entry.shadow ? (
              <ShadowSettings
                label={label}
                shadow={entry.shadow}
                spread={entry.property === "box-shadow"}
                disabled={disabled}
                onPreview={previewShadow}
                onCancelPreview={onCancelPreview}
                onCommit={commitShadow}
              />
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <InspectorSelect
        label={`${label} type`}
        value={entry.kind}
        disabled={disabled || kinds.length === 1}
        options={kinds.map((kind) => ({
          ...kind,
          disabled: !designEffectKindAvailable(state, entry, kind.value),
        }))}
        onChange={(kind) => {
          if (!designEffectKindAvailable(state, entry, kind)) return;
          const styles = designEffectsChangeKind(state, entry, kind, textLayer);
          if (Object.keys(styles).length === 0) return;
          onPreview?.(styles);
          onCommit(styles, "effect type");
        }}
      />
      <div className="flex items-center">
        <MotionDiamond
          label={label.toLocaleLowerCase()}
          property={entry.property}
          value={currentValue}
          motion={motion}
          disabled={disabled}
        />
        <InspectorIconButton
          label={`Remove ${label.toLocaleLowerCase()}`}
          disabled={disabled}
          onClick={() => {
            const styles = designEffectsRemove(state, entry);
            onPreview?.(styles);
            onCommit(styles, label);
          }}
        >
          <Minus />
        </InspectorIconButton>
      </div>
    </div>
  );
}

function ShadowSettings({
  label,
  shadow,
  spread,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  label: string;
  shadow: DesignShadowValue;
  spread: boolean;
  disabled?: boolean;
  onPreview: (shadow: DesignShadowValue) => void;
  onCancelPreview?: () => void;
  onCommit: (shadow: DesignShadowValue) => void;
}) {
  // Successive edits build on this popover's own latest shadow; the confirmed
  // value can lag behind a pending save.
  const [draft, setDraft] = useState(shadow);
  const draftRef = useRef(shadow);
  const { inset, x, y, blur, spread: spreadValue, color } = shadow;
  useEffect(() => {
    const confirmed = { inset, x, y, blur, spread: spreadValue, color };
    draftRef.current = confirmed;
    setDraft(confirmed);
  }, [inset, x, y, blur, spreadValue, color]);
  const commit = (next: DesignShadowValue) => {
    draftRef.current = next;
    setDraft(next);
    onCommit(next);
  };
  const preview = (next: DesignShadowValue) => onPreview(next);
  const field = (
    key: "x" | "y" | "blur" | "spread",
    letter: string,
    name: string,
    minimum?: number,
  ) => (
    <EffectNumberField
      label={letter}
      name={`${label} ${name}`}
      value={draft[key]}
      minimum={minimum}
      disabled={disabled}
      onPreview={(value) => preview({ ...draftRef.current, [key]: value })}
      onCancelPreview={onCancelPreview}
      onCommit={(value) => commit({ ...draftRef.current, [key]: value })}
    />
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {field("x", "X", "X")}
        {field("y", "Y", "Y")}
        {field("blur", "B", "blur", 0)}
        {spread ? field("spread", "S", "spread") : null}
      </div>
      <DesignColorField
        value={draft.color}
        label={`${label} color`}
        disabled={disabled}
        onPreview={(next) => preview({ ...draftRef.current, color: next })}
        onCancelPreview={onCancelPreview}
        onCommit={(next) => commit({ ...draftRef.current, color: next })}
      />
    </>
  );
}

// --- TRANSFORM ---

interface DesignTransformSectionProps {
  details: DesignRuntimeNodeDetails;
  /** Live transform while a canvas gesture streams it; else confirmed CSS. */
  value: string;
  disabled?: boolean;
  isAuthored: (property: string) => boolean;
  renderField: RenderField;
  motion?: DesignMotionActions;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string | null>, label: string) => void;
}

export function DesignTransformSection({
  details,
  value,
  disabled,
  isAuthored,
  renderField,
  motion,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignTransformSectionProps) {
  const transform = value || "none";
  const empty = transform === "none";
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // One popover, anchored to the whole section, serves both the header `+`
  // and the summary row. Adding the first transform turns the section from
  // empty to populated without remounting (and closing) the open editor.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef}>
          <InspectorSection
            title="Transform"
            empty={empty}
            data-design-transform-section=""
            actions={
              empty ? (
                <>
                  <MotionDiamond
                    label="transform"
                    property="transform"
                    value={transform}
                    motion={motion}
                    disabled={disabled}
                  />
                  <InspectorIconButton
                    label="Edit transform"
                    tooltip="Add transform"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    disabled={disabled}
                    onClick={() => setOpen(true)}
                  >
                    <Plus />
                  </InspectorIconButton>
                </>
              ) : null
            }
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
              <button
                type="button"
                disabled={disabled}
                aria-label="Edit transform"
                aria-haspopup="dialog"
                aria-expanded={open}
                className="zd-field w-full min-w-0 gap-2 px-2 text-left disabled:opacity-50"
                onClick={() => setOpen(true)}
              >
                <Box className="text-muted-fg size-3.5 shrink-0" />
                <span className="text-fg1 min-w-0 flex-1 truncate">
                  {transform}
                </span>
              </button>
              <div className="flex items-center">
                <MotionDiamond
                  label="transform"
                  property="transform"
                  value={transform}
                  motion={motion}
                  disabled={disabled}
                />
                <InspectorIconButton
                  label="Remove transform"
                  disabled={disabled}
                  onClick={() =>
                    onCommit(
                      { transform: isAuthored("transform") ? null : "none" },
                      "transform",
                    )
                  }
                >
                  <Minus />
                </InspectorIconButton>
              </div>
            </div>
          </InspectorSection>
        </div>
      </PopoverAnchor>
      <DesignTransformEditor
        open={open}
        value={transform}
        disabled={disabled}
        details={details}
        renderField={renderField}
        anchorRef={anchorRef}
        onPreview={(next) => onPreview?.({ transform: next })}
        onCancelPreview={onCancelPreview}
        onCommit={(next) => onCommit({ transform: next }, "transform")}
      />
    </Popover>
  );
}

function DesignTransformEditor({
  open,
  value,
  disabled,
  details,
  renderField,
  anchorRef,
  onPreview,
  onCancelPreview,
  onCommit,
}: {
  open: boolean;
  value: string;
  disabled?: boolean;
  details?: DesignRuntimeNodeDetails;
  renderField?: RenderField;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onPreview?: (value: string) => void;
  onCancelPreview?: () => void;
  onCommit: (value: string) => void;
}) {
  const [transform, setTransform] = useState(() => parseDesignTransform(value));
  const [rawTransform, setRawTransform] = useState(value || "none");
  const skipRawCommitRef = useRef(false);
  /** The last transform this popover wrote, for reverting a field draft. */
  const committedRef = useRef(value || "none");

  // Adopt confirmed values only while closed; an open editor owns its draft.
  useEffect(() => {
    if (open) return;
    skipRawCommitRef.current = false;
    committedRef.current = value || "none";
    setTransform(parseDesignTransform(value));
    setRawTransform(value || "none");
  }, [open, value]);

  const update = (patch: Partial<DesignTransformValue>) => {
    const next = { ...transform, ...patch };
    const formatted = formatDesignTransform(next);
    setTransform(next);
    setRawTransform(formatted);
    onPreview?.(formatted);
    return next;
  };
  const commit = (next = transform) => {
    const formatted = formatDesignTransform(next);
    committedRef.current = formatted;
    setRawTransform(formatted);
    onCommit(formatted);
  };
  const commitRawTransform = () => {
    if (skipRawCommitRef.current) {
      skipRawCommitRef.current = false;
      return;
    }
    const next = rawTransform.trim() || "none";
    setRawTransform(next);
    setTransform(parseDesignTransform(next));
    if (next !== committedRef.current) {
      committedRef.current = next;
      onCommit(next);
    }
  };

  const fields: Array<{
    label: string;
    name: string;
    key: "x" | "y" | "rotate" | "scaleX" | "scaleY" | "skewX" | "skewY";
    step?: number;
  }> = [
    { label: "X", name: "Translate X", key: "x" },
    { label: "Y", name: "Translate Y", key: "y" },
    { label: "SX", name: "Scale X", key: "scaleX", step: 0.05 },
    { label: "SY", name: "Scale Y", key: "scaleY", step: 0.05 },
    { label: "KX", name: "Skew X", key: "skewX" },
    { label: "KY", name: "Skew Y", key: "skewY" },
    { label: "R", name: "Rotate", key: "rotate" },
  ];
  const read = (property: string, fallback: string) =>
    details
      ? readDesignComputedStyle(details.styles, property) || fallback
      : fallback;

  return (
    <PopoverContent
      data-design-popover=""
      onOpenAutoFocus={focusDesignPopoverSurface}
      side="left"
      align="start"
      sideOffset={8}
      padding="none"
      className="w-64"
      onInteractOutside={(event) => {
        // The section's own triggers reopen rather than toggle the editor.
        if (
          event.target instanceof Node &&
          anchorRef.current?.contains(event.target)
        )
          event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        if (keepDesignPopoverWhileEditing(event)) return;
        skipRawCommitRef.current = true;
        onCancelPreview?.();
      }}
    >
      <div className="zd-popover">
        <div className="zd-popover-header">
          <span className="zd-popover-title">Transform</span>
          <InspectorIconButton
            label="Reset transform"
            onClick={() => {
              const next = parseDesignTransform("none");
              setTransform(next);
              setRawTransform("none");
              commit(next);
            }}
          >
            <RotateCcw />
          </InspectorIconButton>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {fields.map((field) => (
            <EffectNumberField
              key={field.key}
              label={field.label}
              name={field.name}
              value={transform[field.key]}
              step={field.step}
              disabled={disabled || transform.raw !== undefined}
              onPreview={(nextValue) => update({ [field.key]: nextValue })}
              onCancelPreview={() => {
                setTransform(parseDesignTransform(committedRef.current));
                setRawTransform(committedRef.current);
                onCancelPreview?.();
              }}
              onCommit={(nextValue) =>
                commit(update({ [field.key]: nextValue }))
              }
            />
          ))}
        </div>
        <div className="zd-field">
          <span className="zd-field-label pr-1.5 pl-2">CSS</span>
          <input
            value={rawTransform}
            spellCheck={false}
            className="pr-2"
            aria-label="Transform CSS value"
            onChange={(event) => {
              // Raw CSS is a draft until Enter or blur: a half-typed
              // `rotate(1` is not a transform, and applying every keystroke
              // reflowed the element through every intermediate state.
              const next = event.currentTarget.value;
              setRawTransform(next);
              setTransform(parseDesignTransform(next));
            }}
            onBlur={commitRawTransform}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              else if (event.key === "Escape") {
                event.preventDefault();
                skipRawCommitRef.current = true;
                setRawTransform(committedRef.current);
                setTransform(parseDesignTransform(committedRef.current));
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        {renderField ? (
          <div className="grid grid-cols-2 gap-2">
            {renderField(
              "Origin",
              "transform-origin",
              read("transform-origin", "50% 50%"),
            )}
            {renderField(
              "Perspective",
              "perspective",
              read("perspective", "none"),
            )}
          </div>
        ) : null}
        {renderField
          ? renderField(
              "Perspective origin",
              "perspective-origin",
              read("perspective-origin", "50% 50%"),
            )
          : null}
      </div>
    </PopoverContent>
  );
}
