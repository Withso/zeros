// ============================================
// COMPONENT: Design inspector kit
// PURPOSE: The section, action, select and segmented primitives that give
//          every Style inspector section one geometry: 36px headers, 28px
//          controls, 13px values and 14px glyphs on quiet bg2 fills
// USED IN: DesignStyleEditor and its property editors
// ============================================

import React from "react";

import { cn } from "../../shared/ui/cn";
import { getLastInputModality } from "../../shared/ui/overlay-focus";
import type { InspectorGlyphName } from "./design-layout-values";
import {
  PopoverAnchor,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
} from "../../shared/ui/primitives";

// --- SECTIONS ---

interface InspectorSectionProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
  title: React.ReactNode;
  /** Header-trailing actions: add, settings, blend, … (24px icon buttons). */
  actions?: React.ReactNode;
  /** A section with nothing authored renders as its header alone. */
  empty?: boolean;
  bodyClassName?: string;
}

/** Sections never collapse. An empty one is a quiet header with its `+`. */
export function InspectorSection({
  title,
  actions,
  empty = false,
  className,
  bodyClassName,
  children,
  ...rest
}: InspectorSectionProps) {
  const hasBody = !empty && React.Children.count(children) > 0;
  return (
    <section
      {...rest}
      data-empty={empty ? "true" : undefined}
      className={cn("zd-section", className)}
    >
      <div className="zd-section-header">
        <h3 className="zd-section-title">{title}</h3>
        {actions ? (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        ) : null}
      </div>
      {hasBody ? (
        <div className={cn("zd-section-body", bodyClassName)}>{children}</div>
      ) : null}
    </section>
  );
}

// --- ACTIONS ---

interface InspectorIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name and tooltip text. */
  label: string;
  tooltip?: React.ReactNode;
  shortcut?: React.ReactNode;
  /** 24px for headers and trailing row actions, 28px for a row control. */
  size?: "header" | "row";
  pressed?: boolean;
}

/** A quiet 24/28px glyph button that always carries a name and a tooltip. It
 * forwards its ref so Popover/DropdownMenu triggers can wrap it. */
export const InspectorIconButton = React.forwardRef<
  HTMLButtonElement,
  InspectorIconButtonProps
>(function InspectorIconButton(
  {
    label,
    tooltip,
    shortcut,
    size = "header",
    pressed,
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <Tooltip label={tooltip ?? label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-size={size === "row" ? "row" : undefined}
        className={cn("zd-icon-button", className)}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});

// --- SELECT ---

export interface InspectorOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface InspectorSelectProps<T extends string> {
  /** Accessible name; the value itself is the visible text. */
  label: string;
  value: string;
  options: readonly InspectorOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Optional in-field glyph/letter before the value. */
  leading?: React.ReactNode;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
}

/** A 28px field-surface Select. An authored value outside the preset list
 * stays visible and selected rather than silently snapping to a preset. */
export function InspectorSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  leading,
  placeholder,
  className,
  contentClassName,
}: InspectorSelectProps<T>) {
  const choices: readonly InspectorOption<string>[] =
    value && !options.some((option) => option.value === value)
      ? [{ value, label: value }, ...options]
      : options;
  return (
    <Select
      value={value || undefined}
      disabled={disabled}
      onValueChange={(next) => onChange(next as T)}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "zd-field zd-select w-full min-w-0 justify-between gap-1 pr-1.5 pl-2 text-left",
          leading ? "pl-0" : null,
          className,
        )}
      >
        {leading ? (
          <span className="zd-field-label w-7" aria-hidden="true">
            {leading}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          <SelectValue placeholder={placeholder} />
        </span>
      </SelectTrigger>
      <SelectContent className={cn("min-w-36", contentClassName)}>
        {choices.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.icon}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- SEGMENTED ---

export interface InspectorSegment<T extends string = string> {
  value: T;
  /** Accessible name (and visible text when there is no icon). */
  label: string;
  icon?: React.ReactNode;
  tooltip?: React.ReactNode;
  disabled?: boolean;
}

interface InspectorSegmentedProps<T extends string> {
  label: string;
  value: string | null;
  options: readonly InspectorSegment<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  /** Names each segment `${label}: ${option.label}` for icon-only groups. */
  qualifiedNames?: boolean;
}

export function InspectorSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  qualifiedNames = false,
}: InspectorSegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("zd-segmented", className)}
    >
      {options.map((option) => (
        <Tooltip
          key={option.value}
          label={
            option.icon ? (option.tooltip ?? option.label) : option.tooltip
          }
        >
          <button
            type="button"
            className="zd-segment"
            disabled={disabled || option.disabled}
            aria-label={
              qualifiedNames ? `${label}: ${option.label}` : option.label
            }
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.icon ?? option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

// --- CHECKBOX ROW ---

export function InspectorCheckboxRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "text-fg2 hover:text-fg1 flex h-7 w-fit cursor-pointer items-center gap-2 text-xs select-none",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        aria-hidden="true"
        className={cn(
          "peer-focus-visible:ring-highlighted-bright/50 grid size-3.5 shrink-0 place-items-center rounded-sm border peer-focus-visible:ring-[3px]",
          checked
            ? "bg-inverted-bg border-inverted-bg text-inverted-fg"
            : "border-border4",
        )}
      >
        {checked ? (
          <svg
            viewBox="0 0 16 16"
            className="size-2.5"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3.5 8.5 6.5 11.5 12.5 4.5"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      {label}
    </label>
  );
}

// --- GLYPHS ---
// 16px-grid outline glyphs for concepts the icon set does not draw. They render
// at 14px and inherit currentColor, matching lucide's 1.25–1.5 stroke weight.

export type { InspectorGlyphName };

const GLYPH_PATHS: Record<InspectorGlyphName, React.ReactNode> = {
  opacity: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 5.5h1m2 0h1m-3 2.5h1m2 0h1m-5 2.5h1m2 0h1" />
    </>
  ),
  radius: <path d="M3 13V8a5 5 0 0 1 5-5h5" />,
  corners: (
    <path d="M2.5 6V4.5a2 2 0 0 1 2-2H6m4 0h1.5a2 2 0 0 1 2 2V6m0 4v1.5a2 2 0 0 1-2 2H10m-4 0H4.5a2 2 0 0 1-2-2V10" />
  ),
  "padding-x": <path d="M2.5 2.5v11m11-11v11M6 5.5v5m4-5v5" />,
  "padding-y": <path d="M2.5 2.5h11m-11 11h11M5.5 6h5m-5 4h5" />,
  "padding-top": (
    <>
      <path d="M2.5 2.5h11" />
      <rect
        x="4.5"
        y="6"
        width="7"
        height="7"
        rx="1"
        strokeDasharray="1.5 1.5"
      />
    </>
  ),
  "padding-right": (
    <>
      <path d="M13.5 2.5v11" />
      <rect
        x="3"
        y="4.5"
        width="7"
        height="7"
        rx="1"
        strokeDasharray="1.5 1.5"
      />
    </>
  ),
  "padding-bottom": (
    <>
      <path d="M2.5 13.5h11" />
      <rect
        x="4.5"
        y="3"
        width="7"
        height="7"
        rx="1"
        strokeDasharray="1.5 1.5"
      />
    </>
  ),
  "padding-left": (
    <>
      <path d="M2.5 2.5v11" />
      <rect
        x="6"
        y="4.5"
        width="7"
        height="7"
        rx="1"
        strokeDasharray="1.5 1.5"
      />
    </>
  ),
  gap: <path d="M2.5 2.5v11m11-11v11M5 8h6M6.5 6 4.5 8l2 2m3-4 2 2-2 2" />,
  "gap-y": <path d="M2.5 2.5h11m-11 11h11M8 5v6M6 6.5l2-2 2 2m-4 3 2 2 2-2" />,
  rotation: (
    <path d="M2.5 12.5h11M3.5 12.5 10 3.5M7.5 12.5a4.5 4.5 0 0 0-1.6-3.4" />
  ),
  "line-height": (
    <path d="M2.5 2.5h11m-11 11h11M5.5 11l2.5-6 2.5 6M6.4 9h3.2" />
  ),
  "letter-spacing": (
    <path d="M2.5 2.5v11m11-11v11M5.5 11l2.5-6 2.5 6M6.4 9h3.2" />
  ),
  "stroke-weight": (
    <>
      <path d="M2.5 3.5h11" strokeWidth="1" />
      <path d="M2.5 7.5h11" strokeWidth="1.75" />
      <path d="M2.5 12h11" strokeWidth="2.75" />
    </>
  ),
  "radius-tl": <path d="M3.5 13V8a4.5 4.5 0 0 1 4.5-4.5h5" />,
  "radius-tr": <path d="M12.5 13V8A4.5 4.5 0 0 0 8 3.5H3" />,
  "radius-br": <path d="M12.5 3v5A4.5 4.5 0 0 1 8 12.5H3" />,
  "radius-bl": <path d="M3.5 3v5A4.5 4.5 0 0 0 8 12.5h5" />,
  "font-size": (
    <path d="M1.5 12.5 5 3.5l3.5 9M2.6 9.5h4.8M9.5 12.5l2.25-5.5 2.25 5.5M10.2 10.8h3.1" />
  ),
};

export function InspectorGlyph({
  name,
  className,
}: {
  name: InspectorGlyphName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-3.5 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPH_PATHS[name]}
    </svg>
  );
}

// --- CANVAS TOOLBAR ---

interface DesignToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tooltip?: React.ReactNode;
  shortcut?: React.ReactNode;
  pressed?: boolean;
  /** A modal canvas tool paints its active state in the design accent;
   * panel toggles (source, themes, motion) stay neutral. */
  tool?: boolean;
}

export const DesignToolbarButton = React.forwardRef<
  HTMLButtonElement,
  DesignToolbarButtonProps
>(function DesignToolbarButton(
  {
    label,
    tooltip,
    shortcut,
    pressed,
    tool = false,
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <Tooltip label={tooltip ?? label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={
          props["aria-expanded"] === undefined ? pressed : undefined
        }
        data-tool={tool ? "" : undefined}
        className={cn("zd-canvas-tool", className)}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});

// --- POPOVER ESCAPE ---

/** Escape inside a popover's text field reverts that field first (its own
 * handler blurs it); only an Escape outside a field dismisses the popover.
 * Radix hears Escape in the document capture phase, before the field does,
 * so the focused element still identifies an in-progress edit here. */
export function keepDesignPopoverWhileEditing(event: KeyboardEvent): boolean {
  const active = document.activeElement;
  const editing =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  if (editing) event.preventDefault();
  return editing;
}

/** A property popover opened by pointer keeps the canvas feel: no field
 * grabs focus (and paints its ring); the surface itself takes focus so
 * Escape and Tab still work. Keyboard openings focus the first control. */
export function focusDesignPopoverSurface(event: Event): void {
  if (getLastInputModality() !== "pointer") return;
  event.preventDefault();
  if (event.target instanceof HTMLElement)
    event.target.focus({ preventScroll: true });
}

// --- POPOVER PLACEMENT ---

/** Anchors a property popover beside the inspector rather than over it. The
 * anchor is a zero-width edge placed 12px left of the (positioned) row that
 * renders it — the inspector's content edge, or a parent popover's — so
 * `side="left" align="start"` lands every popover 8px clear of the panel,
 * level with the row that opened it. */
export function InspectorPopoverAnchor() {
  return (
    <PopoverAnchor asChild>
      <span aria-hidden="true" className="zd-popover-edge-anchor" />
    </PopoverAnchor>
  );
}
