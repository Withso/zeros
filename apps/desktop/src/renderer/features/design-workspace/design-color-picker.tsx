import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pipette } from "lucide-react";

import {
  Button,
  Input,
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
import {
  formatDesignColor,
  formatDesignColorNotation,
  hsvaToRgba,
  parseDesignColor,
  rgbaToHsva,
  type DesignHsvaColor,
  type DesignColorNotation,
  type DesignRgbaColor,
} from "./design-color-values";

interface DesignColorPickerProps {
  value: string;
  label: string;
  trigger?: React.ReactNode;
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  onPreview?: (value: string) => void | Promise<void>;
  onCancelPreview?: () => void | Promise<void>;
  onCommit: (value: string) => void | Promise<void>;
}

const FALLBACK_COLOR: DesignHsvaColor = { h: 0, s: 0, v: 0, a: 1 };

interface DesignEyeDropper {
  open(): Promise<{ sRGBHex: string }>;
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

function resolveBrowserColor(value: string): DesignRgbaColor | null {
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

function hsvaFromValue(value: string): DesignHsvaColor {
  const parsed = parseDesignColor(value) ?? resolveBrowserColor(value);
  return parsed ? rgbaToHsva(parsed) : FALLBACK_COLOR;
}

function notationFromValue(value: string): DesignColorNotation {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.startsWith("rgb")) return "rgb";
  if (normalized.startsWith("hsl")) return "hsl";
  return "hex";
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
  handler: DesignColorPickerProps["onPreview"],
  value: string,
) {
  if (!handler) return;
  void Promise.resolve(handler(value)).catch(() => {});
}

function safeCancel(handler: DesignColorPickerProps["onCancelPreview"]) {
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
        "border-border3 relative block shrink-0 overflow-hidden rounded-sm border",
        className,
      )}
      style={checkerboardBackground()}
      aria-hidden="true"
    >
      <span className="absolute inset-0" style={{ background: value }} />
    </span>
  );
}

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
  const [hsva, setHsva] = useState<DesignHsvaColor>(() => hsvaFromValue(value));
  const [draft, setDraft] = useState(value);
  const [format, setFormat] = useState<DesignColorNotation>(() =>
    notationFromValue(value),
  );
  const [sampling, setSampling] = useState(false);
  const baselineRef = useRef(value);
  const previewingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    if (open) return;
    baselineRef.current = value;
    setDraft(value);
    setHsva(hsvaFromValue(value));
    setFormat(notationFromValue(value));
  }, [open, value]);

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
    setHsva(next);
    setDraft(nextValue);
    previewingRef.current = true;
    safePreview(onPreview, nextValue);
    return nextValue;
  };

  const commitValue = (nextValue: string) => {
    const next = nextValue.trim();
    if (!next) return;
    // One interaction is one source write. Enter blurs, and Done steals focus
    // and so blurs too, which brings the already-committed value back around a
    // second time — two source generations for one keypress or click, and one
    // undo with nothing visible left to do.
    if (next === baselineRef.current) {
      cancelPreview();
      return;
    }
    baselineRef.current = next;
    previewingRef.current = false;
    setDraft(next);
    void Promise.resolve(onCommit(next)).catch(() => {
      setDraft(value);
      setHsva(hsvaFromValue(value));
    });
  };

  const commitOnBlur = (nextValue: string) => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    commitValue(nextValue);
  };

  const cancelPreview = () => {
    if (previewingRef.current) safeCancel(onCancelPreview);
    previewingRef.current = false;
    setDraft(baselineRef.current);
    setHsva(hsvaFromValue(baselineRef.current));
  };

  const updateSaturation = (
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): DesignHsvaColor => {
    const bounds = element.getBoundingClientRect();
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
    const bounds = element.getBoundingClientRect();
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    return {
      ...hsva,
      [property]: property === "h" ? ratio * 360 : ratio,
    };
  };

  const commitHsva = (next: DesignHsvaColor) =>
    commitValue(formatDesignColorNotation(hsvaToRgba(next), format));

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          skipBlurCommitRef.current = false;
          baselineRef.current = value;
          setDraft(value);
          setHsva(hsvaFromValue(value));
          setFormat(notationFromValue(value));
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "focus-visible:ring-highlighted-bright/50 focus-visible:border-highlighted-bright flex size-7 items-center justify-center rounded-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50",
            className,
          )}
          aria-label={`Edit ${label.toLocaleLowerCase()}`}
        >
          {trigger ?? <DesignColorSwatch value={value} className="size-5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        padding="none"
        className="w-64 overflow-hidden rounded-md"
        onEscapeKeyDown={() => {
          skipBlurCommitRef.current = true;
          cancelPreview();
        }}
      >
        <div className="border-border1 flex h-9 items-center justify-between border-b px-3">
          <span className="text-fg1 text-xs font-medium">{label}</span>
          <span className="text-muted-fg text-[10px]">sRGB</span>
        </div>

        <div className="flex flex-col gap-3 p-3">
          <button
            type="button"
            role="slider"
            aria-label={`${label} saturation and brightness`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsva.s)}
            className="focus-visible:ring-highlighted-bright/60 relative h-36 w-full touch-none overflow-hidden rounded-sm focus-visible:ring-2 focus-visible:outline-none"
            style={{
              backgroundColor: `hsl(${hsva.h} 100% 50%)`, // check:ui ignore-line -- dynamic HSV hue is user-authored color data, not app chrome.
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              previewHsva(
                updateSaturation(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                ),
              );
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              previewHsva(
                updateSaturation(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                ),
              );
            }}
            onPointerUp={(event) => {
              const next = updateSaturation(
                event.currentTarget,
                event.clientX,
                event.clientY,
              );
              event.currentTarget.releasePointerCapture(event.pointerId);
              previewHsva(next);
              commitHsva(next);
            }}
            onPointerCancel={() => cancelPreview()}
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
              className="border-bg1 pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow"
              style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%` }}
            />
          </button>

          <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
            <DesignColorSwatch
              value={formatted}
              className="size-6 rounded-full"
            />
            <button
              type="button"
              role="slider"
              aria-label={`${label} hue`}
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsva.h)}
              className={
                "focus-visible:ring-highlighted-bright/60 relative h-2.5 touch-none rounded-full bg-[linear-gradient(to_right,hsl(0_100%_50%),hsl(60_100%_50%),hsl(120_100%_50%),hsl(180_100%_50%),hsl(240_100%_50%),hsl(300_100%_50%),hsl(360_100%_50%))] focus-visible:ring-2 focus-visible:outline-none" // check:ui ignore-line -- a hue spectrum is functional color-picker data, not app chrome.
              }
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                previewHsva(
                  updateTrack(event.currentTarget, event.clientX, "h"),
                );
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId))
                  return;
                previewHsva(
                  updateTrack(event.currentTarget, event.clientX, "h"),
                );
              }}
              onPointerUp={(event) => {
                const next = updateTrack(
                  event.currentTarget,
                  event.clientX,
                  "h",
                );
                event.currentTarget.releasePointerCapture(event.pointerId);
                previewHsva(next);
                commitHsva(next);
              }}
              onPointerCancel={() => cancelPreview()}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const next = {
                  ...hsva,
                  h:
                    (hsva.h + direction * (event.shiftKey ? 10 : 1) + 360) %
                    360,
                };
                previewHsva(next);
                commitHsva(next);
              }}
            >
              <span
                className="border-bg1 absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow"
                style={{ left: `${(hsva.h / 360) * 100}%` }}
              />
            </button>

            <span className="text-muted-fg text-center text-[10px]">A</span>
            <div
              className="relative h-2.5 rounded-full"
              style={checkerboardBackground()}
            >
              <button
                type="button"
                role="slider"
                aria-label={`${label} opacity`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hsva.a * 100)}
                className="focus-visible:ring-highlighted-bright/60 absolute inset-0 touch-none rounded-full focus-visible:ring-2 focus-visible:outline-none"
                style={{
                  backgroundImage: `linear-gradient(to right, transparent, ${opaque})`,
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  previewHsva(
                    updateTrack(event.currentTarget, event.clientX, "a"),
                  );
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId))
                    return;
                  previewHsva(
                    updateTrack(event.currentTarget, event.clientX, "a"),
                  );
                }}
                onPointerUp={(event) => {
                  const next = updateTrack(
                    event.currentTarget,
                    event.clientX,
                    "a",
                  );
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  previewHsva(next);
                  commitHsva(next);
                }}
                onPointerCancel={() => cancelPreview()}
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
                  className="border-bg1 absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow"
                  style={{ left: `${hsva.a * 100}%` }}
                />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-[72px_minmax(0,1fr)_52px] gap-1.5">
            <Select
              value={format}
              onValueChange={(nextFormat) => {
                if (
                  nextFormat !== "hex" &&
                  nextFormat !== "rgb" &&
                  nextFormat !== "hsl"
                ) {
                  return;
                }
                setFormat(nextFormat);
                setDraft(
                  formatDesignColorNotation(hsvaToRgba(hsva), nextFormat),
                );
              }}
            >
              <SelectTrigger
                size="sm"
                className="zd-design-control-applied h-7 w-full text-[10px]"
                aria-label="Color notation"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hex">HEX</SelectItem>
                <SelectItem value="rgb">RGB</SelectItem>
                <SelectItem value="hsl">HSL</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={draft}
              className="zd-design-control-applied h-7 min-w-0 px-2 font-mono text-xs"
              aria-label={`${label} value`}
              spellCheck={false}
              onChange={(event) => {
                // Typed text stays a draft: the canvas hears about it on Enter
                // or on blur, not on every character.
                const nextValue = event.currentTarget.value;
                setDraft(nextValue);
                const parsed =
                  parseDesignColor(nextValue) ?? resolveBrowserColor(nextValue);
                if (parsed) setHsva(rgbaToHsva(parsed));
              }}
              onBlur={() => commitOnBlur(draft)}
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
            <Input
              value={`${Math.round(hsva.a * 100)}%`}
              className="zd-design-control-applied h-7 px-1 text-center font-mono text-xs"
              aria-label={`${label} opacity value`}
              onChange={(event) => {
                const opacity = clamp(
                  Number.parseFloat(event.currentTarget.value) / 100,
                  0,
                  1,
                );
                if (!Number.isFinite(opacity)) return;
                setHsva({ ...hsva, a: opacity });
              }}
              onBlur={() => commitOnBlur(formatted)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.currentTarget.blur();
              }}
            />
          </div>

          <div className="border-border1 flex items-center justify-between border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || sampling || !eyeDropperConstructor()}
              aria-label={`Pick ${label.toLocaleLowerCase()} from screen`}
              onClick={() => {
                const EyeDropper = eyeDropperConstructor();
                if (!EyeDropper) return;
                setSampling(true);
                void new EyeDropper()
                  .open()
                  .then(({ sRGBHex }) => {
                    const parsed = parseDesignColor(sRGBHex);
                    if (!parsed) return;
                    const next = rgbaToHsva(parsed);
                    previewHsva(next);
                    commitValue(sRGBHex);
                    setOpen(false);
                  })
                  .catch((error: unknown) => {
                    // Native sampling rejects with AbortError when the user
                    // presses Escape; the authored color remains untouched.
                    if (
                      !error ||
                      typeof error !== "object" ||
                      !("name" in error) ||
                      error.name !== "AbortError"
                    ) {
                      cancelPreview();
                    }
                  })
                  .finally(() => setSampling(false));
              }}
            >
              <Pipette />
              {sampling ? "Sampling…" : "Eyedropper"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                commitValue(draft);
                setOpen(false);
              }}
            >
              <Check />
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
