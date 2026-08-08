import React, { useEffect, useRef, useState } from "react";
import { Box, ChevronRight, RotateCcw, Sparkles } from "lucide-react";

import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import { DesignColorPicker } from "./design-color-picker";
import {
  formatDesignShadow,
  formatDesignTransform,
  parseDesignShadow,
  parseDesignTransform,
  type DesignShadowValue,
  type DesignTransformValue,
} from "./design-effect-values";

interface DesignEffectCallbacks {
  disabled?: boolean;
  onPreview?: (value: string) => void;
  onCancelPreview?: () => void;
  onCommit: (value: string) => void;
}

function EffectNumberField({
  label,
  value,
  step = 1,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(value));
  }, [value]);

  const publishDraft = (next: string) => {
    setDraft(next);
    const parsed = Number(next);
    if (next.trim() && Number.isFinite(parsed)) onChange(parsed);
  };

  return (
    <label className="zd-design-control-applied flex h-7 min-w-0 items-center overflow-hidden rounded-sm">
      <span className="text-muted-fg flex h-full w-7 shrink-0 items-center justify-center text-[10px]">
        {label}
      </span>
      <Input
        ref={inputRef}
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        className="h-full min-w-0 rounded-none border-0 px-1.5 py-0 font-mono text-[11px] shadow-none focus-visible:border-transparent"
        onChange={(event) => publishDraft(event.currentTarget.value)}
        onBlur={() => {
          const parsed = Number(draft);
          if (!draft.trim() || !Number.isFinite(parsed)) {
            setDraft(String(value));
            return;
          }
          onChange(parsed);
          onCommit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const parsed = Number(draft);
            const next =
              (Number.isFinite(parsed) ? parsed : value) +
              (event.key === "ArrowUp" ? step : -step) *
                (event.shiftKey ? 10 : 1);
            publishDraft(String(Math.round(next * 1_000) / 1_000));
          }
        }}
      />
    </label>
  );
}

export function DesignShadowControl({
  label,
  value,
  textShadow = false,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignEffectCallbacks & {
  label: string;
  value: string;
  textShadow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [shadow, setShadow] = useState(() => parseDesignShadow(value));
  const skipCommitRef = useRef(false);

  useEffect(() => {
    if (!open) setShadow(parseDesignShadow(value));
  }, [open, value]);

  const update = (patch: Partial<DesignShadowValue>) => {
    const next = { ...shadow, ...patch };
    setShadow(next);
    onPreview?.(formatDesignShadow(next, !textShadow));
    return next;
  };
  const commit = (next = shadow) => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    onCommit(formatDesignShadow(next, !textShadow));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          skipCommitRef.current = false;
          setShadow(parseDesignShadow(value));
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Edit ${label.toLocaleLowerCase()}`}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left focus-visible:outline-none disabled:opacity-50",
            value === "none"
              ? "zd-design-control-quiet"
              : "zd-design-control-applied",
          )}
        >
          <span
            className="bg-bg2-hover size-4 shrink-0 rounded-sm"
            style={{ boxShadow: textShadow ? undefined : value }}
          >
            {textShadow ? (
              <span className="text-fg2 flex size-full items-center justify-center text-[9px] font-bold">
                T
              </span>
            ) : null}
          </span>
          <span className="text-fg2 min-w-0 flex-1 truncate text-[11px]">
            {label}
          </span>
          <span className="text-muted-fg max-w-24 truncate font-mono text-[9px]">
            {value === "none"
              ? "None"
              : `${shadow.x}, ${shadow.y}, ${shadow.blur}`}
          </span>
          <ChevronRight className="text-muted-fg size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        className="w-72 overflow-hidden rounded-md"
        onEscapeKeyDown={() => {
          skipCommitRef.current = true;
          onCancelPreview?.();
        }}
      >
        <div className="border-border1 flex h-9 items-center justify-between border-b px-3">
          <div className="flex items-center gap-2">
            <Sparkles className="text-muted-fg size-3.5" />
            <span className="text-fg1 text-xs font-medium">{label}</span>
          </div>
          {!textShadow ? (
            <div className="zd-design-segment-group grid grid-cols-2 rounded-sm">
              {[
                [false, "Outside"],
                [true, "Inside"],
              ].map(([inset, option]) => (
                <button
                  key={String(inset)}
                  type="button"
                  aria-pressed={shadow.inset === inset}
                  className={cn(
                    "zd-design-segment text-muted-fg h-6 px-2 text-[10px]",
                    shadow.inset === inset && "bg-bg2 text-fg1",
                  )}
                  onClick={() => {
                    const next = update({ inset: Boolean(inset) });
                    commit(next);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 p-3">
          <div className="bg-bg1-hover relative flex h-20 items-center justify-center overflow-hidden rounded-md">
            <span
              className="bg-bg1 border-border2 flex size-10 items-center justify-center rounded-md border text-xs"
              style={{
                boxShadow: textShadow
                  ? undefined
                  : formatDesignShadow(shadow, true),
                textShadow: textShadow
                  ? formatDesignShadow(shadow, false)
                  : undefined,
              }}
            >
              {textShadow ? "Aa" : null}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <EffectNumberField
              label="X"
              value={shadow.x}
              disabled={disabled}
              onChange={(x) => update({ x })}
              onCommit={() => commit()}
            />
            <EffectNumberField
              label="Y"
              value={shadow.y}
              disabled={disabled}
              onChange={(y) => update({ y })}
              onCommit={() => commit()}
            />
            <EffectNumberField
              label="B"
              value={shadow.blur}
              disabled={disabled}
              onChange={(blur) => update({ blur: Math.max(0, blur) })}
              onCommit={() => commit()}
            />
            {!textShadow ? (
              <EffectNumberField
                label="S"
                value={shadow.spread}
                disabled={disabled}
                onChange={(spread) => update({ spread })}
                onCommit={() => commit()}
              />
            ) : null}
          </div>
          <div className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2">
            <DesignColorPicker
              value={shadow.color}
              label={`${label} color`}
              disabled={disabled}
              onPreview={(color) => {
                update({ color });
              }}
              onCancelPreview={onCancelPreview}
              onCommit={(color) => {
                const next = update({ color });
                commit(next);
              }}
            />
            <Input
              value={shadow.color}
              className="zd-design-control-applied h-7 min-w-0 font-mono text-[11px]"
              aria-label={`${label} color value`}
              onChange={(event) => update({ color: event.currentTarget.value })}
              onBlur={() => commit()}
            />
          </div>
          <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-2">
            <span className="text-muted-fg text-[10px]">Blur</span>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[shadow.blur]}
              aria-label={`${label} blur`}
              onValueChange={([blur = 0]) => update({ blur })}
              onValueCommit={([blur = 0]) => commit({ ...shadow, blur })}
            />
            <span className="text-fg2 text-right font-mono text-[10px]">
              {shadow.blur}px
            </span>
          </div>
          <div className="border-border1 flex justify-between border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onCommit("none");
                setOpen(false);
              }}
            >
              Remove
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                commit();
                setOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function DesignTransformControl({
  value,
  disabled,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignEffectCallbacks & { value: string }) {
  const [open, setOpen] = useState(false);
  const [transform, setTransform] = useState(() => parseDesignTransform(value));
  const [rawTransform, setRawTransform] = useState(value || "none");
  const skipRawCommitRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setTransform(parseDesignTransform(value));
      setRawTransform(value || "none");
    }
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
    onCommit(next);
  };

  const fields: Array<{
    label: string;
    key: "x" | "y" | "rotate" | "scaleX" | "scaleY" | "skewX" | "skewY";
    step?: number;
  }> = [
    { label: "X", key: "x" },
    { label: "Y", key: "y" },
    { label: "R", key: "rotate" },
    { label: "SX", key: "scaleX", step: 0.05 },
    { label: "SY", key: "scaleY", step: 0.05 },
    { label: "KX", key: "skewX" },
    { label: "KY", key: "skewY" },
  ];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          skipRawCommitRef.current = false;
          setTransform(parseDesignTransform(value));
          setRawTransform(value || "none");
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Edit transform"
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left focus-visible:outline-none disabled:opacity-50",
            value === "none"
              ? "zd-design-control-quiet"
              : "zd-design-control-applied",
          )}
        >
          <Box className="text-muted-fg size-3.5" />
          <span className="text-fg2 flex-1 text-[11px]">Transform</span>
          <span className="text-muted-fg max-w-32 truncate font-mono text-[9px]">
            {value}
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
          skipRawCommitRef.current = true;
          onCancelPreview?.();
        }}
      >
        <div className="border-border1 flex h-9 items-center justify-between border-b px-3">
          <span className="text-fg1 text-xs font-medium">Transform</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reset transform"
            onClick={() => {
              const next = parseDesignTransform("none");
              setTransform(next);
              setRawTransform("none");
              commit(next);
            }}
          >
            <RotateCcw />
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-3">
          <div className="bg-bg1-hover relative flex h-24 items-center justify-center overflow-hidden rounded-md">
            <div
              className="border-border3 bg-bg1 size-10 rounded-sm border"
              style={{ transform: formatDesignTransform(transform) }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {fields.map((field) => (
              <EffectNumberField
                key={field.key}
                label={field.label}
                value={transform[field.key]}
                step={field.step}
                disabled={disabled || transform.raw !== undefined}
                onChange={(nextValue) => update({ [field.key]: nextValue })}
                onCommit={() => commit()}
              />
            ))}
          </div>
          <div className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2">
            <span className="text-muted-fg text-center text-[10px]">CSS</span>
            <Input
              value={rawTransform}
              className="zd-design-control-applied h-7 min-w-0 font-mono text-[11px]"
              aria-label="Transform CSS value"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setRawTransform(next);
                setTransform(parseDesignTransform(next));
                onPreview?.(next.trim() || "none");
              }}
              onBlur={commitRawTransform}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                else if (event.key === "Escape") {
                  skipRawCommitRef.current = true;
                }
              }}
            />
          </div>
          {transform.raw !== undefined ? (
            <p className="text-muted-fg m-0 text-[10px] leading-4">
              This transform uses syntax the numeric controls cannot preserve.
              Edit it with the CSS field.
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={() => {
              commitRawTransform();
              setOpen(false);
            }}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
