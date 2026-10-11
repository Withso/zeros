// ──────────────────────────────────────────────────────────
// Browser device toolbar — responsive viewport + device presets
// ──────────────────────────────────────────────────────────
//
// The toolbar only edits numbers; the Browser tab owns the viewport frame,
// its knob handles, and persistence (`viewportWidth` / `viewportHeight` are
// shared with Canvas mode so both modes resume at the same size).

import { useRef, useState } from "react";
import { ChevronDown, RotateCwSquare, X } from "lucide-react";

import type { CanvasKnobAxis } from "./canvas-knob-handles";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tooltip,
} from "../../shared/ui/primitives";

/** CSS-pixel viewports, portrait for handheld devices. */
export const BROWSER_DEVICE_PRESETS = [
  { id: "4k", label: "4K", width: 3840, height: 2160 },
  { id: "laptop", label: "Laptop", width: 1440, height: 900 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  {
    id: "galaxy-s24-ultra",
    label: "Samsung Galaxy S24 Ultra",
    width: 384,
    height: 824,
  },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
] as const;

export type BrowserDevicePreset = (typeof BROWSER_DEVICE_PRESETS)[number];
export type BrowserDevicePresetId = "custom" | BrowserDevicePreset["id"];

export const BROWSER_DEVICE_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;
export type BrowserDeviceZoom = "fit" | (typeof BROWSER_DEVICE_ZOOMS)[number];

export const BROWSER_DEVICE_MIN_WIDTH = 320;
export const BROWSER_DEVICE_MIN_HEIGHT = 300;
export const BROWSER_DEVICE_MAX_SIZE = 7680;
/** Gap around the device frame; also leaves room for the edge knobs. */
export const BROWSER_DEVICE_PADDING = 24;
const BROWSER_DEVICE_MIN_ZOOM = 0.1;

export function browserDevicePreset(
  id: BrowserDevicePresetId | undefined,
): BrowserDevicePreset | undefined {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id);
}

/** Persisted tab state is user-editable; anything unknown is Custom. */
export function normalizeBrowserDevicePreset(
  value: unknown,
): BrowserDevicePresetId {
  return typeof value === "string" &&
    BROWSER_DEVICE_PRESETS.some((preset) => preset.id === value)
    ? (value as BrowserDevicePresetId)
    : "custom";
}

/** A preset stays selected while the frame keeps its size in either
 * orientation; any other size is Custom. */
export function browserDevicePresetForSize(
  presetId: BrowserDevicePresetId,
  width: number,
  height: number,
): BrowserDevicePresetId {
  const preset = browserDevicePreset(presetId);
  if (!preset) return "custom";
  const matches =
    (preset.width === width && preset.height === height) ||
    (preset.width === height && preset.height === width);
  return matches ? presetId : "custom";
}

export function clampBrowserDeviceSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const clamp = (value: number, min: number) =>
    Number.isFinite(value)
      ? Math.min(BROWSER_DEVICE_MAX_SIZE, Math.max(min, Math.round(value)))
      : min;
  return {
    width: clamp(width, BROWSER_DEVICE_MIN_WIDTH),
    height: clamp(height, BROWSER_DEVICE_MIN_HEIGHT),
  };
}

export interface BrowserDeviceLayout {
  /** Effective scale applied to the device frame. */
  zoom: number;
  /** Frame offset inside the scrollable body, in screen px. */
  left: number;
  top: number;
  /** Scrollable extent that fits the scaled frame plus padding. */
  contentWidth: number;
  contentHeight: number;
  /** Centered frames grow on both sides, so a width knob moves at half the
   * frame's width change. */
  centered: boolean;
}

/** Top-aligned, horizontally centered device frame. "Fit" never enlarges a
 * frame past 100%; an unmeasured (hidden) body falls back to 100%. */
export function browserDeviceLayout(input: {
  bodyWidth: number;
  bodyHeight: number;
  width: number;
  height: number;
  zoom: BrowserDeviceZoom;
}): BrowserDeviceLayout {
  const pad = BROWSER_DEVICE_PADDING;
  const measured = input.bodyWidth > 0 && input.bodyHeight > 0;
  const fit = measured
    ? Math.min(
        1,
        (input.bodyWidth - 2 * pad) / input.width,
        (input.bodyHeight - 2 * pad) / input.height,
      )
    : 1;
  const zoom =
    input.zoom === "fit" ? Math.max(BROWSER_DEVICE_MIN_ZOOM, fit) : input.zoom;
  const scaledWidth = input.width * zoom;
  const scaledHeight = input.height * zoom;
  const centered = scaledWidth + 2 * pad <= input.bodyWidth;
  return {
    zoom,
    left: centered ? (input.bodyWidth - scaledWidth) / 2 : pad,
    top: pad,
    contentWidth: Math.max(input.bodyWidth, scaledWidth + 2 * pad),
    contentHeight: Math.max(input.bodyHeight, scaledHeight + 2 * pad),
    centered,
  };
}

export interface BrowserDeviceResizeStart {
  axis: CanvasKnobAxis;
  width: number;
  height: number;
  zoom: BrowserDeviceZoom;
  /** Device body measured when the drag started: its client size and
   * scroll offsets. */
  bodyWidth: number;
  bodyHeight: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface BrowserDeviceResize {
  width: number;
  height: number;
  /** Body scroll that keeps the knob under the pointer. */
  scrollLeft: number;
  scrollTop: number;
}

/** Longest pointer travel a frame that cannot follow an inward knob takes to
 * bring it back under the pointer: a fixed-zoom frame that overflows the
 * panel, or a Fit frame that fills it. */
const CATCH_UP_MAX_PX = 120;

const clampScroll = (value: number, content: number, client: number) =>
  Math.min(Math.max(0, content - client), Math.max(0, value));

/** Device size and body scroll for a knob dragged `dx`/`dy` screen px from
 * its start, keeping the knob under the pointer wherever the layout allows.
 *
 * A frame that fits is centered horizontally, so a side knob moves at half
 * the width change. Once the frame outgrows the panel it sits at the padding
 * and the body scrolls: the right and bottom knobs keep the scroll, so the
 * opposite edge stays put, and the left knob scrolls so the right edge stays
 * put. Each switch happens where both layouts agree, so the size never jumps.
 *
 * An overflowing frame's knob cannot cross the padding inward until the frame
 * fits again. Instead of jumping to that size, the frame shrinks over a short
 * catch-up and the knob rejoins the pointer. "Fit" stays live during the
 * drag, so releasing never rescales the frame: past the panel edge the frame
 * keeps growing and scales down instead of overflowing, and a frame that
 * fills the panel along the dragged axis catches up the same way while its
 * zoom recovers. */
export function browserDeviceResizeSize(
  start: BrowserDeviceResizeStart,
  dx: number,
  dy: number,
): BrowserDeviceResize {
  const pad = BROWSER_DEVICE_PADDING;
  const layout = browserDeviceLayout(start);
  const measured = start.bodyWidth > 0 && start.bodyHeight > 0;
  const vertical = start.axis === "bottom";
  const nearKnob = start.axis === "left";
  const size = vertical ? start.height : start.width;
  const scaled = size * layout.zoom;
  // Largest screen size that fits, and the body's scroll range on this axis.
  const fill = (vertical ? start.bodyHeight : start.bodyWidth) - 2 * pad;
  const overflow = measured ? Math.max(0, scaled - fill) : 0;
  const scroll = clampScroll(
    vertical ? start.scrollTop : start.scrollLeft,
    overflow,
    0,
  );
  const grow = vertical ? dy : nearKnob ? -dx : dx;
  const fitRate = vertical ? 1 : 2;
  // Screen size that keeps the knob under the pointer, how fast it changes
  // per pointer px, and the body scroll for the size the frame ends up with.
  let target = scaled + grow;
  let rate = 1;
  let scrollFor: (screen: number) => number = () => 0;
  if (overflow > 0) {
    // Inward travel the knob can follow before the frame reaches the
    // padding at the end of its scroll range.
    const trackable = nearKnob ? scroll : overflow - scroll;
    if (grow >= -trackable) {
      scrollFor = nearKnob ? (screen) => scroll + screen - scaled : () => scroll;
    } else {
      const excess = overflow - trackable;
      const past = -grow - trackable;
      const span = Math.min(CATCH_UP_MAX_PX, excess / 2);
      if (past >= span) {
        target = fill - fitRate * past;
        rate = fitRate;
      } else {
        // The knob waits at the padding while the frame overflows, then
        // moves faster than the pointer until it is back under it.
        const from = fill + excess;
        const to = fill - fitRate * span;
        target = from + (to - from) * (past / span);
        if (!nearKnob) scrollFor = (screen) => screen - fill;
      }
    }
  } else if (measured && !vertical) {
    const room = (fill - scaled) / 2;
    if (grow <= room) {
      target = scaled + 2 * grow;
      rate = 2;
    } else {
      target = fill + grow - room;
      if (nearKnob) scrollFor = (screen) => screen - fill;
    }
  }
  let next = target / layout.zoom;
  const shrink = scaled - target;
  if (start.zoom === "fit" && measured && overflow === 0 && shrink > 0) {
    // The zoom this axis would have once it no longer limits the fit.
    const otherAvailable =
      (vertical ? start.bodyWidth : start.bodyHeight) - 2 * pad;
    const free = Math.min(
      1,
      otherAvailable / (vertical ? start.width : start.height),
    );
    const gap = size * free - scaled;
    if (gap > 0) {
      const span = Math.min(gap / 2, CATCH_UP_MAX_PX * rate);
      next =
        shrink >= span
          ? target / free
          : size + ((scaled - span) / free - size) * (shrink / span);
    }
  }
  const clamped = vertical
    ? clampBrowserDeviceSize(start.width, next)
    : clampBrowserDeviceSize(next, start.height);
  const after = browserDeviceLayout({ ...start, ...clamped });
  const axisScroll = scrollFor(
    (vertical ? clamped.height : clamped.width) * after.zoom,
  );
  return {
    ...clamped,
    scrollLeft: clampScroll(
      vertical ? start.scrollLeft : axisScroll,
      after.contentWidth,
      start.bodyWidth,
    ),
    scrollTop: clampScroll(
      vertical ? axisScroll : start.scrollTop,
      after.contentHeight,
      start.bodyHeight,
    ),
  };
}

/** Arrow-key step from the number the field shows, bounded like a committed
 * size so the field never displays a value the frame cannot take. */
export function stepBrowserDeviceDimension(
  shown: string,
  value: number,
  delta: number,
  min: number,
): number {
  const base = Number.parseInt(shown, 10);
  const next = (Number.isFinite(base) ? base : value) + delta;
  return Math.min(BROWSER_DEVICE_MAX_SIZE, Math.max(min, next));
}

/** The number to commit when a field loses focus. `draft` is null until the
 * user edits, so an untouched field never writes stale text back over a size
 * that changed while it was focused. */
export function browserDeviceDimensionCommit(
  draft: string | null,
  value: number,
): number | null {
  if (draft === null) return null;
  const parsed = Number.parseInt(draft, 10);
  return Number.isFinite(parsed) && parsed !== value ? parsed : null;
}

export function browserDevicePresetLabel(
  presetId: BrowserDevicePresetId,
): string {
  return browserDevicePreset(presetId)?.label ?? "Custom";
}

interface BrowserDeviceToolbarProps {
  presetId: BrowserDevicePresetId;
  width: number;
  height: number;
  zoom: BrowserDeviceZoom;
  effectiveZoom: number;
  onPresetChange: (presetId: BrowserDevicePresetId) => void;
  onSizeChange: (width: number, height: number) => void;
  onRotate: () => void;
  onZoomChange: (zoom: BrowserDeviceZoom) => void;
  onClose: () => void;
}

export function BrowserDeviceToolbar({
  presetId,
  width,
  height,
  zoom,
  effectiveZoom,
  onPresetChange,
  onSizeChange,
  onRotate,
  onZoomChange,
  onClose,
}: BrowserDeviceToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Device toolbar"
      className="border-border1 bg-bg1 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
      data-testid="browser-device-toolbar"
    >
      <span className="text-fg3 shrink-0 pl-1 text-xs">Dimensions:</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="compact"
            className="text-fg1 data-[state=open]:bg-bg2-highlight shrink-0"
            aria-label={`Dimensions: ${browserDevicePresetLabel(presetId)}`}
          >
            {browserDevicePresetLabel(presetId)}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[240px]">
          <DropdownMenuRadioGroup
            value={presetId}
            onValueChange={(value) =>
              onPresetChange(normalizeBrowserDevicePreset(value))
            }
          >
            <DropdownMenuRadioItem value="custom" indicator="check">
              Custom
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {BROWSER_DEVICE_PRESETS.map((preset) => (
              <DropdownMenuRadioItem
                key={preset.id}
                value={preset.id}
                indicator="check"
              >
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                <span className="text-muted-fg pl-4 tabular-nums">
                  {preset.width}×{preset.height}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DimensionInput
        value={width}
        min={BROWSER_DEVICE_MIN_WIDTH}
        label="Viewport width"
        onCommit={(next) => onSizeChange(next, height)}
      />
      <span className="text-fg3 text-xs" aria-hidden="true">
        ×
      </span>
      <DimensionInput
        value={height}
        min={BROWSER_DEVICE_MIN_HEIGHT}
        label="Viewport height"
        onCommit={(next) => onSizeChange(width, next)}
      />

      <Tooltip label="Rotate">
        <Button
          variant="ghost"
          size="icon-compact"
          className="text-fg2 hover:text-fg1 shrink-0"
          onClick={onRotate}
          aria-label="Rotate viewport"
        >
          <RotateCwSquare aria-hidden="true" />
        </Button>
      </Tooltip>

      <DropdownMenu>
        <Tooltip label="Zoom">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="compact"
              className="text-fg2 data-[state=open]:bg-bg2-highlight data-[state=open]:text-fg1 shrink-0 tabular-nums"
              aria-label={`Zoom: ${Math.round(effectiveZoom * 100)}%`}
            >
              {Math.round(effectiveZoom * 100)}%
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-[160px]">
          <DropdownMenuRadioGroup
            value={String(zoom)}
            onValueChange={(value) => {
              if (value === "fit") {
                onZoomChange("fit");
                return;
              }
              const next = BROWSER_DEVICE_ZOOMS.find(
                (candidate) => String(candidate) === value,
              );
              if (next) onZoomChange(next);
            }}
          >
            <DropdownMenuRadioItem value="fit" indicator="check">
              Fit to panel
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {BROWSER_DEVICE_ZOOMS.map((candidate) => (
              <DropdownMenuRadioItem
                key={candidate}
                value={String(candidate)}
                indicator="check"
              >
                {Math.round(candidate * 100)}%
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="min-w-0 flex-1" />
      <Tooltip label="Close device toolbar">
        <Button
          variant="ghost"
          size="icon-compact"
          className="text-fg2 hover:text-fg1 shrink-0"
          onClick={onClose}
          aria-label="Close device toolbar"
        >
          <X aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

function DimensionInput({
  value,
  min,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  label: string;
  onCommit: (next: number) => void;
}) {
  // null while untouched: the field then always shows the live size, which
  // also follows knob drags and rotation while it is focused.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const shown = draft ?? String(value);

  return (
    <Input
      value={shown}
      inputMode="numeric"
      aria-label={label}
      spellCheck={false}
      className="h-6 w-16 shrink-0 px-1.5 text-center text-xs tabular-nums shadow-none"
      onFocus={(event) => {
        cancelledRef.current = false;
        event.currentTarget.select();
      }}
      onChange={(event) =>
        setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))
      }
      onBlur={() => {
        const next = cancelledRef.current
          ? null
          : browserDeviceDimensionCommit(draft, value);
        cancelledRef.current = false;
        setDraft(null);
        if (next !== null) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelledRef.current = true;
          event.currentTarget.blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const step =
            (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          const next = stepBrowserDeviceDimension(shown, value, step, min);
          setDraft(null);
          if (next !== value) onCommit(next);
        }
      }}
    />
  );
}
