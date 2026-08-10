import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Image as ImageIcon,
  PaintBucket,
  RotateCcw,
} from "lucide-react";

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
  Slider,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorPicker, DesignColorSwatch } from "./design-color-picker";
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
  const initialType = classifyDesignFill(image);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<DesignFillType>(initialType);
  const [draftColor, setDraftColor] = useState(color);
  const [gradient, setGradient] = useState<DesignGradientValue>(
    () => parseDesignGradient(image) ?? { ...DEFAULT_DESIGN_GRADIENT },
  );
  const [unsupportedGradient, setUnsupportedGradient] = useState(
    () => initialType === "gradient" && parseDesignGradient(image) === null,
  );
  const [imageUrl, setImageUrl] = useState(() => readDesignImageUrl(image));
  const [imagePosition, setImagePosition] = useState(position);
  const [imageSize, setImageSize] = useState(size);
  const [imageRepeat, setImageRepeat] = useState(repeat);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    if (open) return;
    setType(classifyDesignFill(image));
    setDraftColor(color);
    const parsedGradient = parseDesignGradient(image);
    setGradient(parsedGradient ?? { ...DEFAULT_DESIGN_GRADIENT });
    setUnsupportedGradient(
      classifyDesignFill(image) === "gradient" && parsedGradient === null,
    );
    setImageUrl(readDesignImageUrl(image));
    setImagePosition(position);
    setImageSize(size);
    setImageRepeat(repeat);
  }, [color, image, open, position, repeat, size]);

  const gradientCss = useMemo(
    () =>
      type === "gradient" && unsupportedGradient
        ? image
        : formatDesignGradient(gradient),
    [gradient, image, type, unsupportedGradient],
  );
  const imageCss = useMemo(() => formatDesignImageUrl(imageUrl), [imageUrl]);
  const previewStyle =
    type === "solid"
      ? { backgroundColor: draftColor }
      : type === "gradient"
        ? { backgroundImage: gradientCss }
        : {
            backgroundColor: color,
            backgroundImage: imageCss,
            backgroundPosition: imagePosition,
            backgroundSize: imageSize,
            backgroundRepeat: imageRepeat,
          };

  const selectType = (nextType: string) => {
    const next = nextType as DesignFillType;
    if (next === "gradient" && type !== "gradient") {
      setGradient({ ...DEFAULT_DESIGN_GRADIENT });
      setUnsupportedGradient(false);
    }
    setType(next);
    if (next === "solid") {
      onPreview?.({
        "background-color": draftColor,
        "background-image": "none",
      });
    } else if (next === "gradient") {
      onPreview?.({ "background-image": gradientCss });
    } else {
      onPreview?.({
        "background-image": imageCss,
        "background-position": imagePosition,
        "background-size": imageSize,
        "background-repeat": imageRepeat,
      });
    }
  };

  const updateGradient = (patch: Partial<DesignGradientValue>) => {
    const next = { ...gradient, ...patch };
    setGradient(next);
    onPreview?.({ "background-image": formatDesignGradient(next) });
    return next;
  };

  const commitCurrent = () => {
    if (type === "gradient" && unsupportedGradient) return;
    if (type === "solid") {
      onCommit({ "background-color": draftColor, "background-image": "none" });
    } else if (type === "gradient") {
      onCommit({ "background-image": gradientCss });
    } else {
      onCommit({
        "background-image": imageCss,
        "background-position": imagePosition,
        "background-size": imageSize,
        "background-repeat": imageRepeat,
      });
    }
  };

  const commitOnBlur = (styles: Record<string, string | null>) => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    onCommit(styles);
  };

  const setImagePreset = (
    nextSize: string,
    nextRepeat: string,
    nextPosition = "center center",
  ) => {
    setImageSize(nextSize);
    setImageRepeat(nextRepeat);
    setImagePosition(nextPosition);
    const styles = {
      "background-image": imageCss,
      "background-position": nextPosition,
      "background-size": nextSize,
      "background-repeat": nextRepeat,
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
          setType(classifyDesignFill(image));
          setDraftColor(color);
          const parsedGradient = parseDesignGradient(image);
          setGradient(parsedGradient ?? { ...DEFAULT_DESIGN_GRADIENT });
          setUnsupportedGradient(
            classifyDesignFill(image) === "gradient" && parsedGradient === null,
          );
          setImageUrl(readDesignImageUrl(image));
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Edit fill"
          className="zd-design-control-applied flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left focus-visible:outline-none disabled:opacity-50"
        >
          <span className="relative size-5 shrink-0 overflow-hidden rounded-sm">
            <DesignColorSwatch value={color} className="size-full" />
            {initialType !== "solid" ? (
              <span
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: image }}
              />
            ) : null}
          </span>
          <span className="text-fg2 flex-1 text-[11px]">Fill</span>
          <span className="text-muted-fg max-w-32 truncate font-mono text-[9px]">
            {initialType === "solid" ? color : initialType}
          </span>
          <ChevronRight className="text-muted-fg size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        className="w-72 overflow-hidden rounded-md"
        onEscapeKeyDown={() => {
          skipBlurCommitRef.current = true;
          onCancelPreview?.();
        }}
      >
        <Tabs value={type} onValueChange={selectType}>
          <div className="border-border1 flex h-10 items-center gap-2 border-b px-2">
            <PaintBucket className="text-muted-fg ml-1 size-3.5" />
            <TabsList variant="chrome" className="min-w-0 flex-1">
              <TabsTrigger value="solid" variant="chrome">
                Color
              </TabsTrigger>
              <TabsTrigger value="gradient" variant="chrome">
                Gradient
              </TabsTrigger>
              <TabsTrigger value="image" variant="chrome">
                Image
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="solid" className="m-0 p-3">
            <div className="bg-bg1-hover relative flex h-28 items-center justify-center overflow-hidden rounded-md">
              <div className="absolute inset-0" style={previewStyle} />
              <DesignColorPicker
                value={draftColor}
                label="Fill color"
                disabled={disabled}
                side="left"
                className="bg-bg1/80 relative size-9 shadow"
                onPreview={(next) => {
                  setDraftColor(next);
                  onPreview?.({ "background-color": next });
                }}
                onCancelPreview={onCancelPreview}
                onCommit={(next) => {
                  setDraftColor(next);
                  onCommit({
                    "background-color": next,
                    "background-image": "none",
                  });
                }}
              />
            </div>
            <div className="mt-3 grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2">
              <DesignColorPicker
                value={draftColor}
                label="Fill color"
                disabled={disabled}
                onPreview={(next) => {
                  setDraftColor(next);
                  onPreview?.({ "background-color": next });
                }}
                onCancelPreview={onCancelPreview}
                onCommit={(next) => {
                  setDraftColor(next);
                  onCommit({
                    "background-color": next,
                    "background-image": "none",
                  });
                }}
              />
              <Input
                value={draftColor}
                className="zd-design-control-applied h-7 min-w-0 font-mono text-[11px]"
                aria-label="Fill color value"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setDraftColor(next);
                  onPreview?.({ "background-color": next });
                }}
                onBlur={() =>
                  commitOnBlur({
                    "background-color": draftColor,
                    "background-image": "none",
                  })
                }
              />
            </div>
          </TabsContent>

          <TabsContent value="gradient" className="m-0 flex flex-col gap-3 p-3">
            <div
              className="h-24 rounded-md"
              style={{ backgroundImage: gradientCss }}
            />
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["Start", "start"],
                  ["End", "end"],
                ] as const
              ).map(([label, key]) => (
                <div
                  key={key}
                  className="zd-design-control-applied flex h-8 items-center gap-1 rounded-sm px-1"
                >
                  <DesignColorPicker
                    value={gradient[key]}
                    label={`${label} stop`}
                    disabled={disabled || unsupportedGradient}
                    onPreview={(next) => {
                      updateGradient({ [key]: next });
                    }}
                    onCancelPreview={onCancelPreview}
                    onCommit={(next) => {
                      const updated = updateGradient({ [key]: next });
                      onCommit({
                        "background-image": formatDesignGradient(updated),
                      });
                    }}
                  />
                  <span className="text-muted-fg truncate text-[10px]">
                    {label}
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[88px_minmax(0,1fr)_52px] items-center gap-2">
              <Select
                value={gradient.type}
                disabled={disabled || unsupportedGradient}
                onValueChange={(next) =>
                  updateGradient({ type: next as DesignGradientValue["type"] })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="zd-design-control-applied h-7 w-full text-[10px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="linear">Linear</SelectItem>
                  <SelectItem value="radial">Radial</SelectItem>
                  <SelectItem value="conic">Conic</SelectItem>
                </SelectContent>
              </Select>
              <Slider
                min={0}
                max={360}
                step={1}
                value={[gradient.angle]}
                disabled={
                  disabled || unsupportedGradient || gradient.type === "radial"
                }
                aria-label="Gradient angle"
                onValueChange={([angle = 0]) => updateGradient({ angle })}
                onValueCommit={([angle = 0]) =>
                  onCommit({
                    "background-image": formatDesignGradient({
                      ...gradient,
                      angle,
                    }),
                  })
                }
              />
              <Input
                type="number"
                value={gradient.angle}
                disabled={
                  disabled || unsupportedGradient || gradient.type === "radial"
                }
                className="zd-design-control-applied h-7 px-1 text-center font-mono text-[10px]"
                aria-label="Gradient angle value"
                onChange={(event) => {
                  const angle = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(angle)) updateGradient({ angle });
                }}
                onBlur={() => commitOnBlur({ "background-image": gradientCss })}
              />
            </div>
            {unsupportedGradient ? (
              <p className="text-muted-fg m-0 text-[10px] leading-4">
                This authored gradient uses stops or syntax the visual editor
                cannot preserve. Edit it in code, or choose another fill type
                before replacing it.
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="image" className="m-0 flex flex-col gap-3 p-3">
            <div
              className="bg-bg1-hover flex h-24 items-center justify-center rounded-md bg-center bg-no-repeat"
              style={{
                backgroundImage: imageCss,
                backgroundSize: imageSize,
              }}
            >
              {!imageUrl ? (
                <ImageIcon className="text-muted-fg size-5" />
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-fg text-[10px]">Image URL</span>
              <Input
                value={imageUrl}
                className="zd-design-control-applied h-7 font-mono text-[11px]"
                placeholder="./assets/image.png"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setImageUrl(next);
                  onPreview?.({
                    "background-image": formatDesignImageUrl(next),
                  });
                }}
                onBlur={() => commitOnBlur({ "background-image": imageCss })}
              />
              <span className="text-muted-fg text-[9px]">
                You can also drag an asset directly onto the selected frame.
              </span>
            </div>
            <div className="zd-design-segment-group grid grid-cols-3 rounded-sm">
              {[
                ["Fit", "contain", "no-repeat"],
                ["Fill", "cover", "no-repeat"],
                ["Tile", "auto", "repeat"],
              ].map(([label, nextSize, nextRepeat]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={
                    imageSize === nextSize && imageRepeat === nextRepeat
                  }
                  className={cn(
                    "zd-design-segment text-muted-fg h-7 text-[10px]",
                    imageSize === nextSize &&
                      imageRepeat === nextRepeat &&
                      "bg-bg2 text-fg1",
                  )}
                  onClick={() => setImagePreset(nextSize!, nextRepeat!)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
              <div className="zd-design-control-applied grid size-16 grid-cols-3 rounded-md p-1">
                {[
                  "left top",
                  "center top",
                  "right top",
                  "left center",
                  "center center",
                  "right center",
                  "left bottom",
                  "center bottom",
                  "right bottom",
                ].map((nextPosition) => (
                  <button
                    key={nextPosition}
                    type="button"
                    className="hover:bg-bg2 relative rounded-sm"
                    aria-label={`Position ${nextPosition}`}
                    aria-pressed={imagePosition === nextPosition}
                    onClick={() => {
                      setImagePosition(nextPosition);
                      const styles = {
                        "background-position": nextPosition,
                      };
                      onPreview?.(styles);
                      onCommit(styles);
                    }}
                  >
                    <span
                      className={cn(
                        "absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                        imagePosition === nextPosition
                          ? "bg-highlighted-bright"
                          : "bg-muted-fg",
                      )}
                    />
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Input
                  value={imagePosition}
                  className="zd-design-control-applied h-7 font-mono text-[10px]"
                  aria-label="Background position"
                  onChange={(event) =>
                    setImagePosition(event.currentTarget.value)
                  }
                  onBlur={() =>
                    commitOnBlur({ "background-position": imagePosition })
                  }
                />
                <Input
                  value={imageRepeat}
                  className="zd-design-control-applied h-7 font-mono text-[10px]"
                  aria-label="Background repeat"
                  onChange={(event) =>
                    setImageRepeat(event.currentTarget.value)
                  }
                  onBlur={() =>
                    commitOnBlur({ "background-repeat": imageRepeat })
                  }
                />
              </div>
            </div>
          </TabsContent>

          <div className="border-border1 flex h-10 items-center justify-between border-t px-3">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove fill"
              onClick={() => {
                onCommit({
                  "background-color": "transparent",
                  "background-image": "none",
                });
                setOpen(false);
              }}
            >
              <RotateCcw />
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                disabled || (type === "gradient" && unsupportedGradient)
              }
              onClick={() => {
                commitCurrent();
                setOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
