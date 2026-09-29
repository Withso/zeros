import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  DesignColorPanel,
  DesignColorValueInputs,
  DesignColorSwatch,
  type DesignColorPanelHandle,
} from "./design-color-picker";
import {
  InspectorSegmented,
  InspectorSelect,
  keepDesignPopoverWhileEditing,
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import { parseDesignColor } from "./design-color-values";
import {
  classifyDesignFill,
  DEFAULT_DESIGN_GRADIENT,
  formatDesignGradient,
  formatDesignImageUrl,
  parseDesignGradient,
  readDesignImageUrl,
  type DesignFillType,
  type DesignGradientValue,
} from "./design-fill-values";

interface DesignFillEditorProps {
  color: string;
  image: string;
  position: string;
  size: string;
  repeat: string;
  disabled?: boolean;
  onPreview?: (styles: Record<string, string | null>) => void;
  onCancelPreview?: () => void;
  onCommit: (styles: Record<string, string | null>) => void;
}

// A new gradient starts from the current solid color toward black, as in
// Figma. These are authored CSS values, not application chrome.
const NEW_GRADIENT_START = "#FFFFFF"; // check:ui ignore-line -- authored CSS default
const NEW_GRADIENT_END = "#000000"; // check:ui ignore-line -- authored CSS default

const FILL_TYPES = [
  { value: "solid", label: "Solid" },
  { value: "gradient", label: "Gradient" },
  { value: "image", label: "Image" },
] as const;

const GRADIENT_TYPES = [
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "conic", label: "Conic" },
] as const;

const IMAGE_POSITIONS = [
  "left top",
  "center top",
  "right top",
  "left center",
  "center center",
  "right center",
  "left bottom",
  "center bottom",
  "right bottom",
] as const;

const IMAGE_MODES = [
  { value: "fit", label: "Fit", size: "contain", repeat: "no-repeat" },
  { value: "fill", label: "Fill", size: "cover", repeat: "no-repeat" },
  { value: "tile", label: "Tile", size: "auto", repeat: "repeat" },
] as const;

function imageMode(size: string, repeat: string): string | null {
  return (
    IMAGE_MODES.find((mode) => mode.size === size && mode.repeat === repeat)
      ?.value ?? null
  );
}

/** Whether an element paints any background at all. */
export function designFillIsEmpty(color: string, image: string): boolean {
  const imageValue = image.trim().toLocaleLowerCase();
  if (imageValue && imageValue !== "none") return false;
  const value = color.trim();
  if (!value) return true;
  const parsed = parseDesignColor(value);
  return parsed ? parsed.a === 0 : value.toLocaleLowerCase() === "transparent";
}

/** One fill row: the swatch opens the fill popover (type tabs + inline
 * picker); hex and opacity edit in place for solid fills. */
export function DesignFillEditor({
  color,
  image,
  position,
  size,
  repeat,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignFillEditorProps) {
  const fillType = classifyDesignFill(image);
  const gradient = parseDesignGradient(image);
  const swatch = (
    <span className="relative block size-4.5 shrink-0 overflow-hidden rounded-sm">
      <DesignColorSwatch value={color} className="size-full" />
      {fillType !== "solid" ? (
        <span
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: image }}
        />
      ) : null}
    </span>
  );
  const popover = (
    <DesignFillPopover
      color={color}
      image={image}
      position={position}
      size={size}
      repeat={repeat}
      disabled={disabled}
      onPreview={onPreview}
      onCancelPreview={onCancelPreview}
      onCommit={onCommit}
      trigger={swatch}
    />
  );

  // One field for every fill type, with the popover always its first child,
  // so switching Solid ↔ Gradient ↔ Image inside the open popover never
  // remounts (and closes) it.
  return (
    <div
      data-design-color-field=""
      data-design-style-property="background-color"
      className="zd-field relative min-w-0 gap-0 pl-1"
    >
      {popover}
      {fillType === "solid" ? (
        <DesignColorValueInputs
          value={color}
          label="Fill"
          disabled={disabled}
          onPreview={(next) => onPreview?.({ "background-color": next })}
          onCommit={(next) =>
            onCommit({ "background-color": next, "background-image": "none" })
          }
        />
      ) : (
        <span className="text-fg1 min-w-0 flex-1 truncate pl-1.5">
          {fillType === "gradient"
            ? `${
                GRADIENT_TYPES.find((type) => type.value === gradient?.type)
                  ?.label ?? "Custom"
              } gradient`
            : "Image"}
        </span>
      )}
    </div>
  );
}

interface DesignFillPopoverProps extends DesignFillEditorProps {
  trigger: React.ReactNode;
}

function DesignFillPopover({
  color,
  image,
  position,
  size,
  repeat,
  disabled,
  trigger,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignFillPopoverProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<DesignFillType>(() =>
    classifyDesignFill(image),
  );
  const [gradient, setGradient] = useState<DesignGradientValue>(
    () => parseDesignGradient(image) ?? { ...DEFAULT_DESIGN_GRADIENT },
  );
  const [unsupportedGradient, setUnsupportedGradient] = useState(false);
  const [stop, setStop] = useState<"start" | "end">("start");
  const [imageUrl, setImageUrl] = useState(() => readDesignImageUrl(image));
  const [imagePosition, setImagePosition] = useState(position);
  const [imageSize, setImageSize] = useState(size);
  const [imageRepeat, setImageRepeat] = useState(repeat);
  const panelRef = useRef<DesignColorPanelHandle | null>(null);
  const escapedRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  const reset = () => {
    const nextType = classifyDesignFill(image);
    const parsedGradient = parseDesignGradient(image);
    setType(nextType);
    setGradient(parsedGradient ?? { ...DEFAULT_DESIGN_GRADIENT });
    setUnsupportedGradient(nextType === "gradient" && parsedGradient === null);
    setImageUrl(readDesignImageUrl(image));
    setImagePosition(position);
    setImageSize(size);
    setImageRepeat(repeat);
  };

  useEffect(() => {
    if (!open) reset();
    // Reset only from confirmed values while closed; an open editor owns its
    // draft until it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, image, open, position, repeat, size]);

  const imageCss = useMemo(() => formatDesignImageUrl(imageUrl), [imageUrl]);

  const selectType = (next: DesignFillType) => {
    if (next === type) return;
    if (next === "gradient" && type !== "gradient") {
      const seeded: DesignGradientValue = {
        ...DEFAULT_DESIGN_GRADIENT,
        start: parseDesignColor(color)?.a ? color : NEW_GRADIENT_START,
        end: NEW_GRADIENT_END,
      };
      setGradient(seeded);
      setUnsupportedGradient(false);
      setType(next);
      const css = formatDesignGradient(seeded);
      onPreview?.({ "background-image": css });
      onCommit({ "background-image": css });
      return;
    }
    setType(next);
    if (next === "solid") {
      onPreview?.({ "background-image": "none" });
      onCommit({ "background-image": "none" });
    } else if (next === "image" && imageUrl) {
      const styles = {
        "background-image": imageCss,
        "background-position": imagePosition,
        "background-size": imageSize,
        "background-repeat": imageRepeat,
      };
      onPreview?.(styles);
      onCommit(styles);
    }
  };

  const updateGradient = (
    patch: Partial<DesignGradientValue>,
    commit: boolean,
  ) => {
    const next = { ...gradient, ...patch };
    setGradient(next);
    const css = formatDesignGradient(next);
    onPreview?.({ "background-image": css });
    if (commit) onCommit({ "background-image": css });
    return next;
  };

  const commitOnBlur = (styles: Record<string, string | null>) => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    onCommit(styles);
  };

  /** Typed values are drafts: Enter commits by blurring, Escape restores the
   * confirmed values and leaves without a write. */
  const commitFieldOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      skipBlurCommitRef.current = true;
      reset();
      event.currentTarget.blur();
    }
  };

  const setImageMode = (value: string) => {
    const mode = IMAGE_MODES.find((entry) => entry.value === value);
    if (!mode) return;
    setImageSize(mode.size);
    setImageRepeat(mode.repeat);
    const styles = {
      "background-image": imageCss,
      "background-position": imagePosition,
      "background-size": mode.size,
      "background-repeat": mode.repeat,
    };
    onPreview?.(styles);
    onCommit(styles);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          skipBlurCommitRef.current = false;
          escapedRef.current = false;
          reset();
        } else if (!escapedRef.current) {
          panelRef.current?.flush();
        }
        escapedRef.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Edit fill"
          className="focus-visible:ring-highlighted-bright/50 flex size-6 shrink-0 items-center justify-center rounded-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <InspectorPopoverAnchor />
      <PopoverContent
        data-design-popover=""
        onOpenAutoFocus={focusDesignPopoverSurface}
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        className="w-64"
        onEscapeKeyDown={(event) => {
          if (keepDesignPopoverWhileEditing(event)) return;
          escapedRef.current = true;
          skipBlurCommitRef.current = true;
          panelRef.current?.cancel();
          onCancelPreview?.();
        }}
      >
        <div className="zd-popover">
          <InspectorSegmented
            label="Fill type"
            value={type}
            options={FILL_TYPES}
            disabled={disabled}
            onChange={selectType}
          />

          {type === "solid" ? (
            <DesignColorPanel
              value={color}
              label="Fill"
              disabled={disabled}
              panelRef={panelRef}
              onPreview={(next) => onPreview?.({ "background-color": next })}
              onCancelPreview={onCancelPreview}
              onCommit={(next) =>
                onCommit({
                  "background-color": next,
                  "background-image": "none",
                })
              }
            />
          ) : null}

          {type === "gradient" ? (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_76px] gap-2">
                <InspectorSelect
                  label="Gradient type"
                  value={gradient.type}
                  options={GRADIENT_TYPES}
                  disabled={disabled || unsupportedGradient}
                  onChange={(next) => updateGradient({ type: next }, true)}
                />
                <div className="zd-field">
                  <span className="zd-field-label w-6" aria-hidden="true">
                    ∠
                  </span>
                  <input
                    inputMode="decimal"
                    value={String(gradient.angle)}
                    disabled={
                      disabled ||
                      unsupportedGradient ||
                      gradient.type === "radial"
                    }
                    aria-label="Gradient angle value"
                    onChange={(event) => {
                      const angle = Number.parseFloat(
                        event.currentTarget.value,
                      );
                      setGradient({
                        ...gradient,
                        angle: Number.isFinite(angle) ? angle : 0,
                      });
                    }}
                    onBlur={() =>
                      commitOnBlur({
                        "background-image": formatDesignGradient(gradient),
                      })
                    }
                    onKeyDown={commitFieldOnEnter}
                  />
                  <span className="zd-field-suffix">°</span>
                </div>
              </div>
              <div
                className="relative h-7 rounded-md shadow-[inset_0_0_0_1px_var(--border2)]"
                style={{
                  backgroundImage: `linear-gradient(to right, ${gradient.start}, ${gradient.end})`,
                }}
              >
                {(["start", "end"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={`${key === "start" ? "Start" : "End"} stop`}
                    aria-pressed={stop === key}
                    disabled={disabled || unsupportedGradient}
                    className={cn(
                      "absolute top-1/2 size-5 -translate-y-1/2 rounded-sm outline-none",
                      key === "start" ? "left-1" : "right-1",
                      stop === key
                        ? "shadow-[0_0_0_2px_var(--bg3),0_0_0_3px_var(--highlighted-bright)]"
                        : "shadow-[0_0_0_2px_var(--bg3)]",
                    )}
                    onClick={() => setStop(key)}
                  >
                    <DesignColorSwatch
                      value={gradient[key]}
                      className="size-full"
                    />
                  </button>
                ))}
              </div>
              {unsupportedGradient ? null : (
                <DesignColorPanel
                  key={stop}
                  value={gradient[stop]}
                  label={stop === "start" ? "Start stop" : "End stop"}
                  disabled={disabled}
                  panelRef={panelRef}
                  onPreview={(next) =>
                    void updateGradient({ [stop]: next }, false)
                  }
                  onCancelPreview={onCancelPreview}
                  onCommit={(next) =>
                    void updateGradient({ [stop]: next }, true)
                  }
                />
              )}
            </>
          ) : null}

          {type === "image" ? (
            <>
              <div
                className="bg-bg2 flex h-28 items-center justify-center rounded-md bg-center bg-no-repeat"
                style={{
                  backgroundImage: imageCss,
                  backgroundSize: imageSize,
                }}
              >
                {!imageUrl ? (
                  <ImageIcon className="text-muted-fg size-5" />
                ) : null}
              </div>
              <div className="zd-field">
                <input
                  value={imageUrl}
                  className="pl-2"
                  placeholder="Image URL"
                  aria-label="Image URL"
                  spellCheck={false}
                  onChange={(event) => setImageUrl(event.currentTarget.value)}
                  onBlur={() =>
                    commitOnBlur({
                      "background-image": imageCss,
                      "background-position": imagePosition,
                      "background-size": imageSize,
                      "background-repeat": imageRepeat,
                    })
                  }
                  onKeyDown={commitFieldOnEnter}
                />
              </div>
              <InspectorSegmented
                label="Image fit"
                value={imageMode(imageSize, imageRepeat)}
                options={IMAGE_MODES}
                disabled={disabled || !imageUrl}
                onChange={setImageMode}
              />
              <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
                <div
                  role="group"
                  aria-label="Image position"
                  className="bg-bg2 grid size-16 grid-cols-3 rounded-md p-1"
                >
                  {IMAGE_POSITIONS.map((nextPosition) => (
                    <button
                      key={nextPosition}
                      type="button"
                      className="hover:bg-bg2-hover relative rounded-sm"
                      aria-label={`Position ${nextPosition}`}
                      aria-pressed={imagePosition === nextPosition}
                      disabled={disabled || !imageUrl}
                      onClick={() => {
                        setImagePosition(nextPosition);
                        const styles = { "background-position": nextPosition };
                        onPreview?.(styles);
                        onCommit(styles);
                      }}
                    >
                      <span
                        className={cn(
                          "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                          imagePosition === nextPosition
                            ? "bg-fg1 size-1.5"
                            : "bg-muted-fg size-1",
                        )}
                      />
                    </button>
                  ))}
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="zd-field">
                    <input
                      value={imagePosition}
                      className="pl-2"
                      aria-label="Background position"
                      spellCheck={false}
                      onChange={(event) =>
                        setImagePosition(event.currentTarget.value)
                      }
                      onBlur={() =>
                        commitOnBlur({ "background-position": imagePosition })
                      }
                      onKeyDown={commitFieldOnEnter}
                    />
                  </div>
                  <div className="zd-field">
                    <input
                      value={imageRepeat}
                      className="pl-2"
                      aria-label="Background repeat"
                      spellCheck={false}
                      onChange={(event) =>
                        setImageRepeat(event.currentTarget.value)
                      }
                      onBlur={() =>
                        commitOnBlur({ "background-repeat": imageRepeat })
                      }
                      onKeyDown={commitFieldOnEnter}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
