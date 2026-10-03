import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pipette } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import {
  InspectorIconButton,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  designColorValueText,
  formatDesignColor,
  formatDesignColorNotation,
  hsvaToRgba,
  parseDesignColor,
  rgbaToHsva,
  type DesignHsvaColor,
  type DesignColorNotation,
  type DesignRgbaColor,
} from "./design-color-values";

interface DesignColorCallbacks {
  onPreview?: (value: string) => void | Promise<void>;
  onCancelPreview?: () => void | Promise<void>;
  onCommit: (value: string) => void | Promise<void>;
}

interface DesignColorPickerProps extends DesignColorCallbacks {
  value: string;
  label: string;
  trigger?: React.ReactNode;
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}

const FALLBACK_COLOR: DesignHsvaColor = { h: 0, s: 0, v: 0, a: 1 };

interface DesignEyeDropper {
  open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
}

type DesignEyeDropperConstructor = new () => DesignEyeDropper;

function eyeDropperConstructor(): DesignEyeDropperConstructor | null {
  if (typeof window === "undefined") return null;
  return (
    (
      window as typeof window & {
        EyeDropper?: DesignEyeDropperConstructor;
      }
    ).EyeDropper ?? null
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveBrowserColor(value: string): DesignRgbaColor | null {
  if (
    typeof document === "undefined" ||
    typeof CSS === "undefined" ||
    value.includes("var(") ||
    !CSS.supports("color", value)
  ) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, alpha = 0] = context.getImageData(
    0,
    0,
    1,
    1,
  ).data;
  return { r, g, b, a: alpha / 255 };
}

/** Parse any CSS color the inspector can show as channels. */
export function readDesignColor(value: string): DesignRgbaColor | null {
  return parseDesignColor(value) ?? resolveBrowserColor(value);
}

function hsvaFromValue(value: string): DesignHsvaColor {
  const parsed = readDesignColor(value);
  return parsed ? rgbaToHsva(parsed) : FALLBACK_COLOR;
}

/** Inspector values arrive as computed `rgb()`, so a designer-friendly hex is
 * the default; an explicitly HSL value keeps its notation. */
function notationFromValue(value: string): DesignColorNotation {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.startsWith("hsl")) return "hsl";
  return "hex";
}

/** A value the picker cannot read (a `var()`, say) stays verbatim. */
function colorValueText(value: string, notation: DesignColorNotation): string {
  const parsed = readDesignColor(value);
  return parsed ? designColorValueText(parsed, notation) : value;
}

function sameDesignColor(left: string, right: string): boolean {
  if (left === right) return true;
  const a = readDesignColor(left);
  const b = readDesignColor(right);
  return Boolean(a && b && formatDesignColor(a) === formatDesignColor(b));
}

function checkerboardBackground(): React.CSSProperties {
  return {
    backgroundColor: "var(--bg1)",
    backgroundImage:
      "linear-gradient(45deg,var(--border2) 25%,transparent 25%),linear-gradient(-45deg,var(--border2) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--border2) 75%),linear-gradient(-45deg,transparent 75%,var(--border2) 75%)",
    backgroundPosition: "0 0,0 4px,4px -4px,-4px 0",
    backgroundSize: "8px 8px",
  };
}

function safePreview(
  handler: DesignColorCallbacks["onPreview"],
  value: string,
) {
  if (!handler) return;
  void Promise.resolve(handler(value)).catch(() => {});
}

function safeCancel(handler: DesignColorCallbacks["onCancelPreview"]) {
  if (!handler) return;
  void Promise.resolve(handler()).catch(() => {});
}

export function DesignColorSwatch({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative block shrink-0 overflow-hidden rounded-sm shadow-[inset_0_0_0_1px_var(--border3)]",
        className,
      )}
      style={checkerboardBackground()}
      aria-hidden="true"
    >
      <span className="absolute inset-0" style={{ background: value }} />
      <span className="absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--border3)]" />
    </span>
  );
}

// --- PANEL ---

export interface DesignColorPanelHandle {
  /** Commit a typed-but-unsubmitted value (closing by an outside click). */
  flush(): void;
  /** Revert any live preview to the value the panel opened with. */
  cancel(): void;
}

interface DesignColorPanelProps extends DesignColorCallbacks {
  value: string;
  label: string;
  disabled?: boolean;
  /** Shows the eyedropper beside the strips (a popover header may own it). */
  eyedropper?: boolean;
  onSampled?: () => void;
  panelRef?: React.MutableRefObject<DesignColorPanelHandle | null>;
}

/** The picker body: saturation field, hue and alpha strips, notation and
 * value. Drags preview live and commit once on release; typed values stay a
 * draft until Enter or blur. It renders inline, so fill and stroke popovers
 * never stack a second popover on top of themselves. */
export function DesignColorPanel({
  value,
  label,
  disabled = false,
  eyedropper = true,
  onSampled,
  panelRef,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignColorPanelProps) {
  const [hsva, setHsva] = useState<DesignHsvaColor>(() => hsvaFromValue(value));
  const [format, setFormat] = useState<DesignColorNotation>(() =>
    notationFromValue(value),
  );
  const [draft, setDraft] = useState(() =>
    colorValueText(value, notationFromValue(value)),
  );
  const formatRef = useRef(format);
  formatRef.current = format;
  const hsvaRef = useRef(hsva);
  hsvaRef.current = hsva;
  const valueInputRef = useRef<HTMLInputElement | null>(null);
  const alphaInputRef = useRef<HTMLInputElement | null>(null);
  const valueDirtyRef = useRef(false);
  const alphaDirtyRef = useRef(false);
  const [alphaDraft, setAlphaDraft] = useState(() =>
    String(Math.round(hsva.a * 100)),
  );
  const [sampling, setSampling] = useState(false);
  const baselineRef = useRef(value);
  const confirmedValueRef = useRef(value);
  const pendingValuesRef = useRef<Array<{ id: number; value: string; key: string }>>([]);
  const sequenceRef = useRef(0);
  const previewingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const draggingRef = useRef(false);
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const samplingAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  /** Track bounds are read once per gesture, not on every pointer move. */
  const boundsRef = useRef<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gestureCancelRef.current?.();
      samplingAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    gestureCancelRef.current?.();
    samplingAbortRef.current?.abort();
  }, [disabled]);

  const adoptColorValue = React.useCallback((nextValue: string) => {
    baselineRef.current = nextValue;
    previewingRef.current = false;
    const current = hsvaRef.current;
    const next = sameDesignColor(formatDesignColor(hsvaToRgba(current)), nextValue)
      ? current : hsvaFromValue(nextValue);
    hsvaRef.current = next;
    setHsva(next);
    // Preserve the active text draft. Its unedited channels still advance to
    // the latest accepted color, so an opacity edit cannot restore stale RGB.
    if (document.activeElement !== valueInputRef.current)
      setDraft(colorValueText(nextValue, formatRef.current));
    if (document.activeElement !== alphaInputRef.current)
      setAlphaDraft(String(Math.round(next.a * 100)));
  }, []);

  // A confirmation can arrive while either text field owns focus. Acknowledge
  // earlier saves without replacing a newer accepted color; external changes
  // still become the baseline while each raw input retains its own draft.
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    const key = colorInputKey(value);
    const previousKey = colorInputKey(confirmedValueRef.current);
    confirmedValueRef.current = value;
    const acknowledged = pendingValuesRef.current.findIndex(
      (entry) => entry.key === key,
    );
    if (acknowledged >= 0) pendingValuesRef.current.splice(0, acknowledged + 1);
    else if (key === previousKey && pendingValuesRef.current.length > 0) return;
    else pendingValuesRef.current = [];
    if (pendingValuesRef.current.length === 0) adoptColorValue(value);
  }, [adoptColorValue, value]);

  const formatted = useMemo(
    () => formatDesignColorNotation(hsvaToRgba(hsva), format),
    [format, hsva],
  );
  const opaque = useMemo(
    () => formatDesignColor({ ...hsvaToRgba(hsva), a: 1 }),
    [hsva],
  );

  const previewHsva = (next: DesignHsvaColor): string => {
    const nextValue = formatDesignColorNotation(hsvaToRgba(next), format);
    hsvaRef.current = next;
    setHsva(next);
    setDraft(designColorValueText(hsvaToRgba(next), format));
    setAlphaDraft(String(Math.round(next.a * 100)));
    previewingRef.current = true;
    safePreview(onPreview, nextValue);
    return nextValue;
  };

  const cancelPreview = () => {
    if (previewingRef.current) safeCancel(onCancelPreview);
    previewingRef.current = false;
    valueDirtyRef.current = false;
    alphaDirtyRef.current = false;
    setDraft(colorValueText(baselineRef.current, formatRef.current));
    const restored = hsvaFromValue(baselineRef.current);
    hsvaRef.current = restored;
    setHsva(restored);
    setAlphaDraft(String(Math.round(restored.a * 100)));
  };

  const commitValue = (nextValue: string) => {
    const next = nextValue.trim();
    if (!next) return;
    // One interaction is one source write. Enter blurs, and closing steals
    // focus and so blurs too; the same color must not be written twice, even
    // when it arrives in another notation.
    if (sameDesignColor(next, baselineRef.current)) {
      cancelPreview();
      return;
    }
    const id = ++sequenceRef.current;
    pendingValuesRef.current.push({ id, value: next, key: colorInputKey(next) });
    baselineRef.current = next;
    previewingRef.current = false;
    setDraft(colorValueText(next, formatRef.current));
    void Promise.resolve(onCommit(next)).catch(() => {
      if (!mountedRef.current) return;
      const index = pendingValuesRef.current.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const latest = index === pendingValuesRef.current.length - 1;
      pendingValuesRef.current.splice(index, 1);
      if (latest)
        adoptColorValue(pendingValuesRef.current.at(-1)?.value ?? confirmedValueRef.current);
    });
  };

  /** Typed text is authored only when it reads as a color; a bare hex keeps
   * the current opacity. Anything else reverts without a write. */
  const commitTyped = (text: string) => {
    const next = designColorFromHexInput(text, hsvaToRgba(hsvaRef.current));
    if (!next) {
      setDraft(colorValueText(baselineRef.current, formatRef.current));
      return;
    }
    const parsed = readDesignColor(next);
    if (parsed) {
      hsvaRef.current = rgbaToHsva(parsed);
      setHsva(hsvaRef.current);
      setAlphaDraft(String(Math.round(parsed.a * 100)));
    }
    commitValue(next);
  };

  const commitTypedDraft = () => {
    const dirty = valueDirtyRef.current;
    valueDirtyRef.current = false;
    if (dirty) commitTyped(draft);
    else setDraft(colorValueText(baselineRef.current, formatRef.current));
  };

  const commitAlphaDraft = () => {
    const dirty = alphaDirtyRef.current;
    alphaDirtyRef.current = false;
    const opacity = Number.parseFloat(alphaDraft);
    if (!dirty || !Number.isFinite(opacity)) {
      setAlphaDraft(String(Math.round(hsvaRef.current.a * 100)));
      return;
    }
    const next = { ...hsvaRef.current, a: clamp(opacity / 100, 0, 1) };
    hsvaRef.current = next;
    setHsva(next);
    setAlphaDraft(String(Math.round(next.a * 100)));
    commitValue(formatDesignColorNotation(hsvaToRgba(next), formatRef.current));
  };

  const commitOnBlur = (commit: () => void) => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    commit();
  };

  if (panelRef) {
    panelRef.current = {
      flush: () => {
        if (valueDirtyRef.current) commitTypedDraft();
        if (alphaDirtyRef.current) commitAlphaDraft();
      },
      cancel: () => {
        skipBlurCommitRef.current = true;
        cancelPreview();
      },
    };
  }

  const updateSaturation = (
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): DesignHsvaColor => {
    const bounds = boundsRef.current ?? element.getBoundingClientRect();
    return {
      ...hsva,
      s: clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
      v: clamp(100 - ((clientY - bounds.top) / bounds.height) * 100, 0, 100),
    };
  };

  const updateTrack = (
    element: HTMLElement,
    clientX: number,
    property: "h" | "a",
  ): DesignHsvaColor => {
    const bounds = boundsRef.current ?? element.getBoundingClientRect();
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    return {
      ...hsva,
      [property]: property === "h" ? ratio * 360 : ratio,
    };
  };

  const commitHsva = (next: DesignHsvaColor) =>
    commitValue(formatDesignColorNotation(hsvaToRgba(next), format));

  const trackHandlers = (
    read: (
      element: HTMLElement,
      event: Pick<PointerEvent, "clientX" | "clientY">,
    ) => DesignHsvaColor,
  ) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      gestureCancelRef.current?.();
      event.preventDefault();
      const target = event.currentTarget;
      draggingRef.current = true;
      boundsRef.current = target.getBoundingClientRect();
      let latest = read(target, event);
      previewHsva(latest);
      gestureCancelRef.current = beginDesignPointerGesture({
        target,
        pointerId: event.pointerId,
        cursor: getComputedStyle(target).cursor,
        onMove: (pointerEvent) => {
          latest = read(target, pointerEvent);
          previewHsva(latest);
        },
        onFinish: () => {
          gestureCancelRef.current = null;
          draggingRef.current = false;
          boundsRef.current = null;
          commitHsva(latest);
        },
        onCancel: () => {
          gestureCancelRef.current = null;
          draggingRef.current = false;
          boundsRef.current = null;
          cancelPreview();
        },
      });
    },
  });

  const sample = () => {
    const EyeDropper = eyeDropperConstructor();
    if (!EyeDropper || disabled || samplingAbortRef.current) return;
    const controller = new AbortController();
    samplingAbortRef.current = controller;
    setSampling(true);
    void new EyeDropper()
      .open({ signal: controller.signal })
      .then(({ sRGBHex }) => {
        // Sampling can finish after closing the picker or replacing its layer.
        // Even when native sampling cannot abort, a retired picker must never
        // dispatch that late result.
        if (controller.signal.aborted || !mountedRef.current || disabledRef.current)
          return;
        const parsed = parseDesignColor(sRGBHex);
        if (!parsed) return;
        previewHsva(rgbaToHsva(parsed));
        commitValue(sRGBHex);
        onSampled?.();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        // Native sampling rejects with AbortError when the user presses
        // Escape; the authored color remains untouched.
        if (
          !error ||
          typeof error !== "object" ||
          !("name" in error) ||
          error.name !== "AbortError"
        ) {
          cancelPreview();
        }
      })
      .finally(() => {
        if (samplingAbortRef.current === controller)
          samplingAbortRef.current = null;
        if (mountedRef.current) setSampling(false);
      });
  };

  return (
    <div
      ref={rootRef}
      data-design-color-panel=""
      className="flex flex-col gap-3"
    >
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsva.s)}
        aria-valuetext={`Saturation ${Math.round(hsva.s)}%, brightness ${Math.round(hsva.v)}%`}
        aria-disabled={disabled || undefined}
        className="focus-visible:ring-highlighted-bright/60 relative h-40 w-full cursor-crosshair touch-none overflow-hidden rounded-md focus-visible:ring-2 focus-visible:outline-none"
        style={{
          backgroundColor: `hsl(${hsva.h} 100% 50%)`, // check:ui ignore-line -- dynamic HSV hue is user-authored color data, not app chrome.
        }}
        {...trackHandlers((element, event) =>
          updateSaturation(element, event.clientX, event.clientY),
        )}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          let next: DesignHsvaColor | null = null;
          if (event.key === "ArrowLeft")
            next = { ...hsva, s: clamp(hsva.s - step, 0, 100) };
          if (event.key === "ArrowRight")
            next = { ...hsva, s: clamp(hsva.s + step, 0, 100) };
          if (event.key === "ArrowDown")
            next = { ...hsva, v: clamp(hsva.v - step, 0, 100) };
          if (event.key === "ArrowUp")
            next = { ...hsva, v: clamp(hsva.v + step, 0, 100) };
          if (!next) return;
          event.preventDefault();
          previewHsva(next);
          commitHsva(next);
        }}
      >
        <span className="absolute inset-0 bg-[linear-gradient(to_right,white,transparent)]" />
        <span className="absolute inset-0 bg-[linear-gradient(to_top,black,transparent)]" />
        <span
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_white,0_0_0_3px_rgb(0_0_0/0.25)]" // check:ui ignore-line -- the picker thumb must read on every user color.
          style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%` }}
        />
      </div>

      <div className="flex items-center gap-2">
        {eyedropper ? (
          <InspectorIconButton
            label={`Pick ${label.toLocaleLowerCase()} from screen`}
            tooltip="Eyedropper"
            size="row"
            disabled={disabled || sampling || !eyeDropperConstructor()}
            onClick={sample}
          >
            <Pipette />
          </InspectorIconButton>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${label} hue`}
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsva.h)}
            className={
              "focus-visible:ring-highlighted-bright/60 relative h-3 cursor-pointer touch-none rounded-full bg-[linear-gradient(to_right,hsl(0_100%_50%),hsl(60_100%_50%),hsl(120_100%_50%),hsl(180_100%_50%),hsl(240_100%_50%),hsl(300_100%_50%),hsl(360_100%_50%))] focus-visible:ring-2 focus-visible:outline-none" // check:ui ignore-line -- a hue spectrum is functional color-picker data, not app chrome.
            }
            {...trackHandlers((element, event) =>
              updateTrack(element, event.clientX, "h"),
            )}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              const direction = event.key === "ArrowRight" ? 1 : -1;
              const next = {
                ...hsva,
                h: (hsva.h + direction * (event.shiftKey ? 10 : 1) + 360) % 360,
              };
              previewHsva(next);
              commitHsva(next);
            }}
          >
            <span
              className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_white,0_0_0_3px_rgb(0_0_0/0.25)]" // check:ui ignore-line -- the picker thumb must read on every user color.
              style={{
                left: `${(hsva.h / 360) * 100}%`,
                backgroundColor: `hsl(${hsva.h} 100% 50%)`, // check:ui ignore-line -- dynamic HSV hue is user-authored color data, not app chrome.
              }}
            />
          </div>
          <div
            className="relative h-3 rounded-full"
            style={checkerboardBackground()}
          >
            <div
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={`${label} opacity`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsva.a * 100)}
              className="focus-visible:ring-highlighted-bright/60 absolute inset-0 cursor-pointer touch-none rounded-full focus-visible:ring-2 focus-visible:outline-none"
              style={{
                backgroundImage: `linear-gradient(to right, transparent, ${opaque})`,
              }}
              {...trackHandlers((element, event) =>
                updateTrack(element, event.clientX, "a"),
              )}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const next = {
                  ...hsva,
                  a: clamp(
                    hsva.a + direction * (event.shiftKey ? 0.1 : 0.01),
                    0,
                    1,
                  ),
                };
                previewHsva(next);
                commitHsva(next);
              }}
            >
              <span
                className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_white,0_0_0_3px_rgb(0_0_0/0.25)]" // check:ui ignore-line -- the picker thumb must read on every user color.
                style={{ left: `${hsva.a * 100}%`, backgroundColor: formatted }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
        <Select
          value={format}
          disabled={disabled}
          onValueChange={(nextFormat) => {
            if (
              nextFormat !== "hex" &&
              nextFormat !== "rgb" &&
              nextFormat !== "hsl"
            ) {
              return;
            }
            setFormat(nextFormat);
            setDraft(designColorValueText(hsvaToRgba(hsva), nextFormat));
          }}
        >
          <SelectTrigger
            aria-label="Color notation"
            className="zd-field w-full justify-between gap-1 pr-1.5 pl-2"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-24">
            <SelectItem value="hex">Hex</SelectItem>
            <SelectItem value="rgb">RGB</SelectItem>
            <SelectItem value="hsl">HSL</SelectItem>
          </SelectContent>
        </Select>
        <div className="zd-field">
          <input
            ref={valueInputRef}
            value={draft}
            className="pl-2"
            aria-label={`${label} value`}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => {
              // Typed text stays a draft: the canvas and the thumbs hear about
              // it on Enter or on blur, not on every character.
              valueDirtyRef.current = true;
              setDraft(event.currentTarget.value);
            }}
            onFocus={() => { valueDirtyRef.current = false; }}
            onBlur={() => commitOnBlur(commitTypedDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                skipBlurCommitRef.current = true;
                cancelPreview();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="bg-border2 h-4 w-px shrink-0" aria-hidden="true" />
          <input
            ref={alphaInputRef}
            value={alphaDraft}
            className="zd-field-fixed w-9 text-right"
            inputMode="numeric"
            aria-label={`${label} opacity value`}
            disabled={disabled}
            onChange={(event) => {
              alphaDirtyRef.current = true;
              setAlphaDraft(event.currentTarget.value);
            }}
            onFocus={() => { alphaDirtyRef.current = false; }}
            onBlur={() => commitOnBlur(commitAlphaDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                skipBlurCommitRef.current = true;
                cancelPreview();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="zd-field-suffix pl-0.5">%</span>
        </div>
      </div>
    </div>
  );
}

// --- POPOVER ---

/** A swatch (or custom trigger) that opens the picker panel. Closing by an
 * outside click keeps a typed value; Escape reverts any live preview. */
export function DesignColorPicker({
  value,
  label,
  trigger,
  disabled = false,
  side = "left",
  align = "start",
  className,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignColorPickerProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<DesignColorPanelHandle | null>(null);
  const escapedRef = useRef(false);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !escapedRef.current) panelRef.current?.flush();
        escapedRef.current = false;
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "focus-visible:ring-highlighted-bright/50 flex size-7 shrink-0 items-center justify-center rounded-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50",
            className,
          )}
          aria-label={`Edit ${label.toLocaleLowerCase()}`}
        >
          {trigger ?? <DesignColorSwatch value={value} className="size-5" />}
        </button>
      </PopoverTrigger>
      {side === "left" ? <InspectorPopoverAnchor /> : null}
      <PopoverContent
        data-design-popover=""
        onOpenAutoFocus={focusDesignPopoverSurface}
        side={side}
        align={align}
        sideOffset={8}
        padding="none"
        className="w-64"
        onEscapeKeyDown={(event) => {
          if (keepDesignPopoverWhileEditing(event)) return;
          escapedRef.current = true;
          panelRef.current?.cancel();
        }}
      >
        <div className="zd-popover">
          <div className="zd-popover-header">
            <span className="zd-popover-title">{label}</span>
          </div>
          <DesignColorPanel
            value={value}
            label={label}
            disabled={disabled}
            panelRef={panelRef}
            onSampled={() => setOpen(false)}
            onPreview={onPreview}
            onCancelPreview={onCancelPreview}
            onCommit={onCommit}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- FIELD ---

function hexText(color: DesignRgbaColor): string {
  return formatDesignColor({ ...color, a: 1 }).slice(1);
}

/** Resolve a typed hex/CSS color against the current alpha. A bare 3/6-digit
 * hex keeps the field's opacity; an explicit alpha or CSS color wins. */
export function designColorFromHexInput(
  input: string,
  current: DesignRgbaColor | null,
): string | null {
  const text = input.trim();
  if (!text) return null;
  const bare = text.replace(/^#/, "");
  if (/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(bare)) {
    const parsed = parseDesignColor(`#${bare}`);
    if (!parsed) return null;
    return formatDesignColor({ ...parsed, a: current?.a ?? 1 });
  }
  if (/^(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(bare)) {
    const parsed = parseDesignColor(`#${bare}`);
    return parsed ? formatDesignColor(parsed) : null;
  }
  if (text.startsWith("var(")) return text;
  const parsed = readDesignColor(text);
  return parsed ? text : null;
}

interface DesignColorFieldProps extends DesignColorCallbacks {
  value: string;
  /** Names the swatch ("Edit fill"), inputs ("Fill color") and popover. */
  label: string;
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  /** Replaces the default picker swatch (e.g. the fill-type popover). */
  swatch?: React.ReactNode;
  /** The CSS property this color edits, exposed for tooling and tests. */
  property?: string;
}

function colorInputKey(value: string): string {
  const parsed = readDesignColor(value);
  return parsed ? formatDesignColor(parsed) : value;
}

/** The hex and opacity inputs of a color row, for use inside a `.zd-field`
 * that supplies its own leading swatch. Both commit on Enter/blur. */
export function DesignColorValueInputs({
  value,
  label,
  disabled = false,
  onPreview,
  onCommit,
}: Pick<
  DesignColorFieldProps,
  "value" | "label" | "disabled" | "onPreview" | "onCommit"
>) {
  const [acceptedValue, setAcceptedValue] = useState(value);
  const confirmedValueRef = useRef(value);
  const pendingRef = useRef<Array<{ id: number; value: string; key: string }>>(
    [],
  );
  const sequenceRef = useRef(0);
  // Earlier confirmations acknowledge the queue without replacing a newer
  // local color. Both inputs compose from that same accepted color.
  useEffect(() => {
    const key = colorInputKey(value);
    const previousKey = colorInputKey(confirmedValueRef.current);
    confirmedValueRef.current = value;
    const acknowledged = pendingRef.current.findIndex(
      (entry) => entry.key === key,
    );
    if (acknowledged >= 0) pendingRef.current.splice(0, acknowledged + 1);
    else if (key === previousKey) return;
    else pendingRef.current = [];
    if (pendingRef.current.length === 0) setAcceptedValue(value);
  }, [value]);
  const parsed = useMemo(() => readDesignColor(acceptedValue), [acceptedValue]);
  const displayHex = parsed ? hexText(parsed) : acceptedValue;
  const displayAlpha = parsed ? String(Math.round(parsed.a * 100)) : "100";
  const [hexDraft, setHexDraft] = useState(displayHex);
  const [alphaDraft, setAlphaDraft] = useState(displayAlpha);
  const hexRef = useRef<HTMLInputElement | null>(null);
  const alphaRef = useRef<HTMLInputElement | null>(null);
  const skipRef = useRef(false);
  const hexDirtyRef = useRef(false);
  const alphaDirtyRef = useRef(false);

  const commitColor = (next: string) => {
    const id = ++sequenceRef.current;
    pendingRef.current.push({ id, value: next, key: colorInputKey(next) });
    setAcceptedValue(next);
    void Promise.resolve(onPreview?.(next)).catch(() => {});
    void Promise.resolve(onCommit(next)).catch(() => {
      const index = pendingRef.current.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const latest = index === pendingRef.current.length - 1;
      pendingRef.current.splice(index, 1);
      if (latest)
        setAcceptedValue(
          pendingRef.current.at(-1)?.value ?? confirmedValueRef.current,
        );
    });
  };

  useEffect(() => {
    if (document.activeElement !== hexRef.current) setHexDraft(displayHex);
    if (document.activeElement !== alphaRef.current)
      setAlphaDraft(displayAlpha);
  }, [displayAlpha, displayHex]);

  const commitHex = () => {
    const dirty = hexDirtyRef.current;
    hexDirtyRef.current = false;
    if (skipRef.current) {
      skipRef.current = false;
      return;
    }
    if (!dirty || hexDraft === displayHex) {
      setHexDraft(displayHex);
      return;
    }
    const next = designColorFromHexInput(hexDraft, parsed);
    if (!next) {
      setHexDraft(displayHex);
      return;
    }
    commitColor(next);
  };

  const commitAlpha = () => {
    const dirty = alphaDirtyRef.current;
    alphaDirtyRef.current = false;
    if (skipRef.current) {
      skipRef.current = false;
      return;
    }
    if (!dirty || alphaDraft === displayAlpha || !parsed) {
      setAlphaDraft(displayAlpha);
      return;
    }
    const percent = Number.parseFloat(alphaDraft);
    if (!Number.isFinite(percent)) {
      setAlphaDraft(displayAlpha);
      return;
    }
    const next = formatDesignColor({
      ...parsed,
      a: clamp(percent, 0, 100) / 100,
    });
    setAlphaDraft(String(Math.round(clamp(percent, 0, 100))));
    commitColor(next);
  };

  const keyDown =
    (restore: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        skipRef.current = true;
        restore();
        event.currentTarget.blur();
      } else if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        event.currentTarget === alphaRef.current
      ) {
        event.preventDefault();
        const step =
          (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1);
        const current = Number.parseFloat(alphaDraft);
        alphaDirtyRef.current = true;
        setAlphaDraft(
          String(
            clamp((Number.isFinite(current) ? current : 100) + step, 0, 100),
          ),
        );
      }
    };

  return (
    <>
      <input
        ref={hexRef}
        value={hexDraft}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        className={cn("pl-1.5", parsed && "uppercase")}
        onChange={(event) => {
          hexDirtyRef.current = true;
          setHexDraft(event.currentTarget.value);
        }}
        onFocus={(event) => {
          hexDirtyRef.current = false;
          event.currentTarget.select();
        }}
        onBlur={commitHex}
        onKeyDown={keyDown(() => setHexDraft(displayHex))}
      />
      {parsed ? (
        <>
          <span className="bg-border2 h-4 w-px shrink-0" aria-hidden="true" />
          <input
            ref={alphaRef}
            value={alphaDraft}
            disabled={disabled}
            inputMode="numeric"
            aria-label={`${label} opacity`}
            className="zd-field-fixed w-9 text-right"
            onChange={(event) => {
              alphaDirtyRef.current = true;
              setAlphaDraft(event.currentTarget.value);
            }}
            onFocus={(event) => {
              alphaDirtyRef.current = false;
              event.currentTarget.select();
            }}
            onBlur={commitAlpha}
            onKeyDown={keyDown(() => setAlphaDraft(displayAlpha))}
          />
          <span className="zd-field-suffix pl-0.5">%</span>
        </>
      ) : null}
    </>
  );
}

export function DesignColorField({
  value,
  label,
  disabled = false,
  side = "left",
  className,
  swatch,
  property,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignColorFieldProps) {
  return (
    <div
      data-design-color-field=""
      data-design-style-property={property}
      className={cn("zd-field relative min-w-0 gap-0 pl-1", className)}
    >
      {swatch ?? (
        <DesignColorPicker
          value={value}
          label={label}
          disabled={disabled}
          side={side}
          className="size-6 rounded-sm"
          trigger={<DesignColorSwatch value={value} className="size-4.5" />}
          onPreview={onPreview}
          onCancelPreview={onCancelPreview}
          onCommit={onCommit}
        />
      )}
      <DesignColorValueInputs
        value={value}
        label={label}
        disabled={disabled}
        onPreview={onPreview}
        onCommit={onCommit}
      />
    </div>
  );
}
