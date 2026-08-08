// ============================================
// COMPONENT: DesignMotionTimeline
// PURPOSE: Source-backed, multi-track CSS keyframe editing and live preview
// USED IN: DesignCanvas as a persistent bottom work surface
// ============================================

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Diamond,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";

import { cn } from "../../shared/ui/cn";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import {
  designDurationMs,
  designMotionIterationCount,
  designMotionPoints,
  designMotionProperties,
  moveDesignMotionPoint,
  removeDesignMotionPoint,
  setDesignMotionPoint,
  type DesignMotionKeyframe,
} from "./design-motion-values";

export interface DesignMotionTimelineDraft {
  file: string;
  name: string;
  keyframes: DesignMotionKeyframe[];
  duration: string;
  delay: string;
  easing: string;
  iterations: string;
  direction: "normal" | "reverse" | "alternate" | "alternate-reverse";
  fillMode: "none" | "forwards" | "backwards" | "both";
}

interface DesignMotionTimelineProps {
  open: boolean;
  details: DesignRuntimeNodeDetails | null;
  definitions: readonly DesignAuthoredKeyframes[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (
    draft: DesignMotionTimelineDraft,
    currentTime: number,
    playing: boolean,
  ) => Promise<void>;
  onClearPreview: () => Promise<void>;
  onSave: (draft: DesignMotionTimelineDraft) => Promise<void>;
}

interface SelectedPoint {
  property: string;
  offset: number;
}

const MOTION_PROPERTY_OPTIONS = [
  "opacity",
  "transform",
  "background-color",
  "color",
  "filter",
  "border-radius",
  "clip-path",
  "letter-spacing",
] as const;

const RULER_MARKS = [0, 25, 50, 75, 100] as const;

function style(
  details: DesignRuntimeNodeDetails,
  camelProperty: string,
  fallback: string,
): string {
  return details.styles[camelProperty] || fallback;
}

function animationName(details: DesignRuntimeNodeDetails): string | null {
  const value = style(details, "animationName", "none")
    .split(",", 1)[0]
    ?.trim();
  return !value || value === "none" ? null : value;
}

function hasAuthoredMotion(
  details: DesignRuntimeNodeDetails,
  definitions: readonly DesignAuthoredKeyframes[],
): boolean {
  const name = animationName(details);
  return Boolean(
    name && definitions.some((definition) => definition.name === name),
  );
}

function defaultMotionName(details: DesignRuntimeNodeDetails): string {
  const suffix = details.oid.replace(/[^A-Za-z0-9_-]+/g, "-");
  return `motion-${suffix}`.slice(0, 128);
}

function initialMotionDraft(
  details: DesignRuntimeNodeDetails,
  definitions: readonly DesignAuthoredKeyframes[],
): DesignMotionTimelineDraft {
  const authoredName = animationName(details);
  const definition = definitions.find((item) => item.name === authoredName);
  const name = definition?.name ?? authoredName ?? defaultMotionName(details);
  const finalOpacity = style(details, "opacity", "1");
  const authoredDuration = style(details, "animationDuration", "300ms")
    .split(",", 1)[0]!
    .trim();
  const keyframes = definition?.keyframes.length
    ? definition.keyframes.map((keyframe) => ({
        offset: keyframe.offset,
        styles: { ...keyframe.styles },
      }))
    : [
        { offset: 0, styles: { opacity: finalOpacity === "0" ? "1" : "0" } },
        { offset: 100, styles: { opacity: finalOpacity } },
      ];
  return {
    file: definition?.file ?? "tokens.css",
    name,
    keyframes,
    duration: /^0(?:\.0+)?(?:ms|s)$/i.test(authoredDuration)
      ? "300ms"
      : authoredDuration,
    delay: style(details, "animationDelay", "0ms").split(",", 1)[0]!,
    easing: style(details, "animationTimingFunction", "ease-out").split(
      ",",
      1,
    )[0]!,
    iterations: style(details, "animationIterationCount", "1").split(
      ",",
      1,
    )[0]!,
    direction: designMotionDirection(
      style(details, "animationDirection", "normal"),
    ),
    fillMode: designMotionFill(style(details, "animationFillMode", "both")),
  };
}

function designMotionDirection(
  value: string,
): DesignMotionTimelineDraft["direction"] {
  const candidate = value.split(",", 1)[0]?.trim();
  return candidate === "reverse" ||
    candidate === "alternate" ||
    candidate === "alternate-reverse"
    ? candidate
    : "normal";
}

function designMotionFill(
  value: string,
): DesignMotionTimelineDraft["fillMode"] {
  const candidate = value.split(",", 1)[0]?.trim();
  return candidate === "none" ||
    candidate === "forwards" ||
    candidate === "backwards"
    ? candidate
    : "both";
}

function defaultMotionPropertyValue(
  property: string,
  details: DesignRuntimeNodeDetails,
  edge: "from" | "to",
): string {
  const computed =
    details.styles[
      property.replace(/-([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      )
    ];
  if (edge === "to" && computed) return computed;
  if (property === "opacity") return edge === "from" ? "0" : "1";
  if (property === "transform")
    return edge === "from" ? "translateY(16px)" : "none";
  if (property === "filter") return edge === "from" ? "blur(8px)" : "none";
  if (property === "border-radius") return edge === "from" ? "0px" : "16px";
  return computed || "initial";
}

function signedTimeMs(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)(ms|s)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return Math.min(
    60_000,
    Math.max(-60_000, match[2].toLowerCase() === "s" ? amount * 1_000 : amount),
  );
}

function previewIterations(value: string): number {
  const parsed = designMotionIterationCount(value);
  return parsed === Infinity ? 1_000 : (parsed ?? 1);
}

function validMotionDraft(draft: DesignMotionTimelineDraft): boolean {
  const iterations = designMotionIterationCount(draft.iterations);
  return (
    /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(draft.name) &&
    draft.keyframes.length >= 2 &&
    draft.keyframes.length <= 32 &&
    designDurationMs(draft.duration, 0) > 0 &&
    iterations !== null &&
    iterations > 0 &&
    draft.keyframes.every((keyframe) => Object.keys(keyframe.styles).length > 0)
  );
}

export function DesignMotionTimeline({
  open,
  details,
  definitions,
  disabled = false,
  onOpenChange,
  onPreview,
  onClearPreview,
  onSave,
}: DesignMotionTimelineProps) {
  const [draft, setDraft] = useState<DesignMotionTimelineDraft | null>(() =>
    details ? initialMotionDraft(details, definitions) : null,
  );
  const [playhead, setPlayhead] = useState(0);
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    null,
  );
  const [propertyDraft, setPropertyDraft] = useState("opacity");
  const [dirty, setDirty] = useState(() =>
    details ? !hasAuthoredMotion(details, definitions) : false,
  );
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const playOriginRef = useRef<{ time: number; offset: number } | null>(null);
  const queuedPreviewRef = useRef<{
    draft: DesignMotionTimelineDraft;
    currentTime: number;
    playing: boolean;
  } | null>(null);
  const previewInFlightRef = useRef(false);
  const motionPreviewActiveRef = useRef(false);
  const clearPreviewRef = useRef(onClearPreview);
  clearPreviewRef.current = onClearPreview;

  const properties = useMemo(
    () => (draft ? designMotionProperties(draft.keyframes) : []),
    [draft],
  );
  const points = useMemo(
    () => (draft ? designMotionPoints(draft.keyframes) : []),
    [draft],
  );
  const durationMs = draft ? designDurationMs(draft.duration) : 300;
  const iterationCount = draft
    ? (designMotionIterationCount(draft.iterations) ?? 1)
    : 1;

  useEffect(() => {
    if (!details) {
      setDraft(null);
      setPlaying(false);
      return;
    }
    setDraft(initialMotionDraft(details, definitions));
    setPlayhead(0);
    setSelectedPoint(null);
    setDirty(!hasAuthoredMotion(details, definitions));
    setPlaying(false);
  }, [definitions, details]);

  const queuePreview = useCallback(
    (
      nextDraft: DesignMotionTimelineDraft,
      currentTime: number,
      shouldPlay: boolean,
    ) => {
      queuedPreviewRef.current = {
        draft: nextDraft,
        currentTime,
        playing: shouldPlay,
      };
      motionPreviewActiveRef.current = true;
      if (previewInFlightRef.current) return;
      previewInFlightRef.current = true;
      const drain = async () => {
        while (queuedPreviewRef.current) {
          const preview = queuedPreviewRef.current;
          queuedPreviewRef.current = null;
          await onPreview(preview.draft, preview.currentTime, preview.playing);
        }
      };
      void drain()
        .catch(() => {
          // Scrubbing is speculative; save reports persistent failures.
        })
        .finally(() => {
          previewInFlightRef.current = false;
          if (queuedPreviewRef.current) {
            const preview = queuedPreviewRef.current;
            queuePreview(preview.draft, preview.currentTime, preview.playing);
          }
        });
    },
    [onPreview],
  );

  useEffect(() => {
    if (!open || !draft || playing) return;
    queuePreview(draft, (playhead / 100) * durationMs, false);
  }, [draft, durationMs, open, playhead, playing, queuePreview]);

  useEffect(() => {
    if (!open || !draft || !playing) return;
    const startingPlayhead = playheadRef.current;
    queuePreview(draft, (startingPlayhead / 100) * durationMs, true);
    const origin = {
      time: performance.now(),
      offset: (startingPlayhead / 100) * durationMs,
    };
    playOriginRef.current = origin;
    let animationFrame = 0;
    const tick = (time: number) => {
      const elapsed = time - origin.time;
      const absoluteTime = origin.offset + elapsed;
      if (
        Number.isFinite(iterationCount) &&
        absoluteTime >= durationMs * iterationCount
      ) {
        setPlayhead(100);
        setPlaying(false);
        return;
      }
      const timeInCycle = absoluteTime % durationMs;
      setPlayhead((timeInCycle / durationMs) * 100);
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      playOriginRef.current = null;
    };
  }, [draft, durationMs, iterationCount, open, playing, queuePreview]);

  useEffect(() => {
    if (open) return;
    queuedPreviewRef.current = null;
    setPlaying(false);
    if (!motionPreviewActiveRef.current) return;
    motionPreviewActiveRef.current = false;
    void clearPreviewRef.current().catch(() => {});
  }, [open]);

  useEffect(
    () => () => {
      queuedPreviewRef.current = null;
      if (!motionPreviewActiveRef.current) return;
      motionPreviewActiveRef.current = false;
      void clearPreviewRef.current().catch(() => {});
    },
    [],
  );

  const mutateDraft = useCallback(
    (
      mutate: (current: DesignMotionTimelineDraft) => DesignMotionTimelineDraft,
    ) => {
      setPlaying(false);
      setDraft((current) => (current ? mutate(current) : current));
      setDirty(true);
    },
    [],
  );

  const addProperty = useCallback(() => {
    if (!details || !draft) return;
    const property = propertyDraft.trim().toLowerCase();
    if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      toast.error("Enter a valid CSS property.");
      return;
    }
    mutateDraft((current) => ({
      ...current,
      keyframes: setDesignMotionPoint(
        setDesignMotionPoint(
          current.keyframes,
          property,
          0,
          defaultMotionPropertyValue(property, details, "from"),
        ),
        property,
        100,
        defaultMotionPropertyValue(property, details, "to"),
      ),
    }));
    setSelectedPoint({ property, offset: 0 });
  }, [details, draft, mutateDraft, propertyDraft]);

  const addPoint = useCallback(
    (property: string) => {
      if (!draft || !details) return;
      const existing = points.find(
        (point) => point.property === property && point.offset === playhead,
      );
      const prior = [...points]
        .filter(
          (point) => point.property === property && point.offset <= playhead,
        )
        .at(-1);
      const value =
        existing?.value ??
        prior?.value ??
        defaultMotionPropertyValue(property, details, "to");
      mutateDraft((current) => ({
        ...current,
        keyframes: setDesignMotionPoint(
          current.keyframes,
          property,
          playhead,
          value,
        ),
      }));
      setSelectedPoint({ property, offset: Math.round(playhead * 10) / 10 });
    },
    [details, draft, mutateDraft, playhead, points],
  );

  const removeProperty = useCallback(
    (property: string) => {
      mutateDraft((current) => ({
        ...current,
        keyframes: designMotionPoints(current.keyframes)
          .filter((point) => point.property !== property)
          .reduce<DesignMotionKeyframe[]>(
            (frames, point) =>
              setDesignMotionPoint(
                frames,
                point.property,
                point.offset,
                point.value,
              ),
            [],
          ),
      }));
      setSelectedPoint((current) =>
        current?.property === property ? null : current,
      );
    },
    [mutateDraft],
  );

  const startPointDrag = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      property: string,
      initialOffset: number,
    ) => {
      if (disabled || !draft || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const track = event.currentTarget.closest<HTMLElement>(
        "[data-motion-track]",
      );
      if (!track) return;
      let lastOffset = initialOffset;
      const move = (pointerEvent: PointerEvent) => {
        const bounds = track.getBoundingClientRect();
        const nextOffset = Math.round(
          Math.min(
            100,
            Math.max(
              0,
              ((pointerEvent.clientX - bounds.left) / bounds.width) * 100,
            ),
          ),
        );
        if (nextOffset === lastOffset) return;
        setDraft((current) =>
          current
            ? {
                ...current,
                keyframes: moveDesignMotionPoint(
                  current.keyframes,
                  property,
                  lastOffset,
                  nextOffset,
                ),
              }
            : current,
        );
        lastOffset = nextOffset;
        setPlayhead(nextOffset);
        setSelectedPoint({ property, offset: nextOffset });
        setDirty(true);
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      setPlaying(false);
      setSelectedPoint({ property, offset: initialOffset });
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [disabled, draft],
  );

  const save = useCallback(async () => {
    if (!draft || !validMotionDraft(draft) || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      setDirty(false);
      toast.success("Motion saved", {
        description: `${draft.name} · ${draft.keyframes.length} keyframes`,
      });
    } catch (error) {
      toast.error("Couldn't save the motion", {
        description:
          error instanceof Error
            ? error.message
            : "The motion could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, saving]);

  if (!open) return null;

  if (!details || !draft) {
    return (
      <section
        data-design-controls
        className="border-border1 bg-bg1 absolute inset-x-0 bottom-0 z-40 flex h-52 flex-col border-t shadow-lg"
        aria-label="Motion timeline"
      >
        <div className="flex h-10 items-center gap-2 px-3">
          <Diamond className="text-highlighted-bright size-3.5" />
          <span className="text-fg1 text-xs font-medium">Motion</span>
          <span className="text-fg3 text-[11px]">
            Select an element to animate.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close motion timeline"
            onClick={() => onOpenChange(false)}
          >
            <ChevronDown />
          </Button>
        </div>
      </section>
    );
  }

  const selectedValue = selectedPoint
    ? points.find(
        (point) =>
          point.property === selectedPoint.property &&
          point.offset === selectedPoint.offset,
      )?.value
    : null;

  return (
    <section
      data-design-controls
      className="border-border1 bg-bg1 absolute inset-x-0 bottom-0 z-40 flex h-72 min-w-0 flex-col border-t shadow-lg"
      aria-label="Motion timeline"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto px-3">
        <Diamond className="text-highlighted-bright mr-1 size-3.5 fill-current" />
        <span className="text-fg1 mr-1 text-xs font-medium">Motion</span>
        <Input
          value={draft.name}
          aria-label="Animation name"
          className="zd-design-control-applied h-7 w-32 shrink-0 font-mono text-[11px]"
          disabled={disabled}
          onChange={(event) =>
            mutateDraft((current) => ({
              ...current,
              name: event.currentTarget.value,
            }))
          }
        />
        <Tooltip label={playing ? "Pause preview" : "Play preview"}>
          <Button
            type="button"
            variant={playing ? "secondary-on" : "ghost"}
            size="icon-sm"
            className={playing ? "zd-design-state-active" : undefined}
            aria-label={
              playing ? "Pause motion preview" : "Play motion preview"
            }
            onClick={() => setPlaying((current) => !current)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
        </Tooltip>
        <span className="text-fg3 ml-auto shrink-0 font-mono text-[10px]">
          {Math.round(playhead)}% · {Math.round((playhead / 100) * durationMs)}
          ms
        </span>
        <Tooltip label={dirty ? "Save keyframes" : "Motion is saved"}>
          <Button
            type="button"
            variant={dirty ? "default" : "ghost"}
            size="sm"
            disabled={disabled || saving || !dirty || !validMotionDraft(draft)}
            onClick={() => void save()}
          >
            <Save />
            {saving ? "Saving…" : "Save"}
          </Button>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close motion timeline"
          onClick={() => onOpenChange(false)}
        >
          <ChevronDown />
        </Button>
      </div>

      <div className="border-border1 flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-3">
        <span className="text-fg3 text-[9px] uppercase">Duration</span>
        <Input
          value={draft.duration}
          aria-label="Animation duration"
          className="zd-design-control-applied h-6 w-16 shrink-0 font-mono text-[10px]"
          disabled={disabled}
          onChange={(event) =>
            mutateDraft((current) => ({
              ...current,
              duration: event.currentTarget.value,
            }))
          }
        />
        <span className="text-fg3 text-[9px] uppercase">Delay</span>
        <Input
          value={draft.delay}
          aria-label="Animation delay"
          className="zd-design-control-applied h-6 w-16 shrink-0 font-mono text-[10px]"
          disabled={disabled}
          onChange={(event) =>
            mutateDraft((current) => ({
              ...current,
              delay: event.currentTarget.value,
            }))
          }
        />
        <span className="text-fg3 text-[9px] uppercase">Ease</span>
        <Select
          value={draft.easing}
          disabled={disabled}
          onValueChange={(easing) =>
            mutateDraft((current) => ({ ...current, easing }))
          }
        >
          <SelectTrigger
            size="sm"
            className="zd-design-control-applied h-6 w-24 shrink-0 text-[10px]"
            aria-label="Animation easing"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              ...new Set([
                draft.easing,
                "linear",
                "ease",
                "ease-in",
                "ease-out",
                "ease-in-out",
              ]),
            ].map((easing) => (
              <SelectItem key={easing} value={easing}>
                {easing}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-fg3 text-[9px] uppercase">Loop</span>
        <Input
          value={draft.iterations}
          aria-label="Animation iterations"
          className="zd-design-control-applied h-6 w-12 shrink-0 font-mono text-[10px]"
          disabled={disabled}
          onChange={(event) =>
            mutateDraft((current) => ({
              ...current,
              iterations: event.currentTarget.value,
            }))
          }
        />
        <Select
          value={draft.direction}
          disabled={disabled}
          onValueChange={(direction) =>
            mutateDraft((current) => ({
              ...current,
              direction: designMotionDirection(direction),
            }))
          }
        >
          <SelectTrigger
            size="sm"
            className="zd-design-control-applied h-6 w-24 shrink-0 text-[10px]"
            aria-label="Animation direction"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["normal", "reverse", "alternate", "alternate-reverse"].map(
              (direction) => (
                <SelectItem key={direction} value={direction}>
                  {direction}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        <Select
          value={draft.fillMode}
          disabled={disabled}
          onValueChange={(fillMode) =>
            mutateDraft((current) => ({
              ...current,
              fillMode: designMotionFill(fillMode),
            }))
          }
        >
          <SelectTrigger
            size="sm"
            className="zd-design-control-applied h-6 w-20 shrink-0 text-[10px]"
            aria-label="Animation fill mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["none", "forwards", "backwards", "both"].map((fill) => (
              <SelectItem key={fill} value={fill}>
                {fill}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="border-border1 grid h-8 shrink-0 grid-cols-[176px_minmax(280px,1fr)] border-b">
        <div className="border-border1 flex items-center gap-1 border-r px-2">
          <Input
            list="design-motion-properties"
            value={propertyDraft}
            aria-label="Motion property"
            className="zd-design-control-quiet h-6 min-w-0 flex-1 font-mono text-[10px]"
            onChange={(event) => setPropertyDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addProperty();
              }
            }}
          />
          <datalist id="design-motion-properties">
            {MOTION_PROPERTY_OPTIONS.map((property) => (
              <option key={property} value={property} />
            ))}
          </datalist>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Add animated property"
            disabled={disabled}
            onClick={addProperty}
          >
            <Plus />
          </Button>
        </div>
        <div className="relative">
          {RULER_MARKS.map((mark) => (
            <span
              key={mark}
              className={cn(
                "text-fg3 absolute top-1/2 -translate-y-1/2 font-mono text-[9px]",
                mark === 0
                  ? "translate-x-0"
                  : mark === 100
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{ left: `${mark}%` }}
            >
              {mark}%
            </span>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {properties.map((property) => {
          const propertyPoints = points.filter(
            (point) => point.property === property,
          );
          return (
            <div
              key={property}
              data-design-motion-track-row=""
              className="group/track grid h-8 grid-cols-[176px_minmax(280px,1fr)]"
            >
              <div className="border-border1 group flex min-w-0 items-center border-r px-2">
                <span className="text-fg2 min-w-0 flex-1 truncate font-mono text-[10px]">
                  {property}
                </span>
                <Tooltip
                  label={`Add ${property} keyframe at ${Math.round(playhead)}%`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Add ${property} keyframe`}
                    disabled={disabled}
                    onClick={() => addPoint(property)}
                  >
                    <Diamond />
                  </Button>
                </Tooltip>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Remove ${property} track`}
                  disabled={disabled || properties.length === 1}
                  onClick={() => removeProperty(property)}
                >
                  <Trash2 />
                </Button>
              </div>
              <div
                data-motion-track
                className="hover:bg-bg1-hover relative cursor-crosshair"
                onPointerDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setPlaying(false);
                  setPlayhead(
                    Math.round(
                      Math.min(
                        100,
                        Math.max(
                          0,
                          ((event.clientX - bounds.left) / bounds.width) * 100,
                        ),
                      ),
                    ),
                  );
                }}
                onDoubleClick={() => addPoint(property)}
              >
                {RULER_MARKS.map((mark) => (
                  <span
                    key={mark}
                    className="bg-border1 pointer-events-none absolute inset-y-0 w-px opacity-60"
                    style={{ left: `${mark}%` }}
                  />
                ))}
                {propertyPoints.map((point) => {
                  const selected =
                    selectedPoint?.property === property &&
                    selectedPoint.offset === point.offset;
                  return (
                    <button
                      key={point.offset}
                      type="button"
                      className={cn(
                        "border-highlighted-bright absolute top-1/2 z-10 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border",
                        selected
                          ? "bg-highlighted-bright"
                          : "bg-bg1 hover:bg-highlighted-bg",
                      )}
                      style={{
                        left:
                          point.offset === 0
                            ? 6
                            : point.offset === 100
                              ? "calc(100% - 6px)"
                              : `${point.offset}%`,
                      }}
                      aria-label={`${property} keyframe at ${point.offset}%`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPlaying(false);
                        setPlayhead(point.offset);
                        setSelectedPoint({ property, offset: point.offset });
                      }}
                      onPointerDown={(event) =>
                        startPointDrag(event, property, point.offset)
                      }
                    />
                  );
                })}
                <span
                  className="bg-red-primary pointer-events-none absolute inset-y-0 z-20 w-px"
                  style={{ left: `${playhead}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-border1 flex h-10 shrink-0 items-center gap-2 border-t px-3">
        {selectedPoint && selectedValue !== null ? (
          <>
            <Diamond className="text-highlighted-bright size-3 fill-current" />
            <span className="text-fg3 font-mono text-[10px]">
              {selectedPoint.offset}%
            </span>
            <span className="text-fg2 max-w-28 truncate font-mono text-[10px]">
              {selectedPoint.property}
            </span>
            <Input
              value={selectedValue}
              aria-label={`${selectedPoint.property} keyframe value`}
              className="zd-design-control-applied h-7 min-w-40 flex-1 font-mono text-[11px]"
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                mutateDraft((current) => ({
                  ...current,
                  keyframes: setDesignMotionPoint(
                    current.keyframes,
                    selectedPoint.property,
                    selectedPoint.offset,
                    value,
                  ),
                }));
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete selected keyframe"
              disabled={disabled || points.length <= 2}
              onClick={() => {
                mutateDraft((current) => ({
                  ...current,
                  keyframes: removeDesignMotionPoint(
                    current.keyframes,
                    selectedPoint.property,
                    selectedPoint.offset,
                  ),
                }));
                setSelectedPoint(null);
              }}
            >
              <Trash2 />
            </Button>
          </>
        ) : (
          <span className="text-fg3 text-[10px]">
            Double-click a track to add a keyframe. Drag diamonds to retime.
          </span>
        )}
        <span className="text-fg3 ml-auto font-mono text-[9px]">
          {draft.file} · delay {signedTimeMs(draft.delay)}ms ·{" "}
          {draft.iterations}× · {draft.direction} · {draft.fillMode}
        </span>
      </div>
    </section>
  );
}

export function designMotionPreviewInput(
  draft: DesignMotionTimelineDraft,
  currentTime: number,
  playing: boolean,
) {
  return {
    keyframes: draft.keyframes.map((keyframe) => ({
      offset: keyframe.offset,
      styles: { ...keyframe.styles },
    })),
    duration: designDurationMs(draft.duration),
    delay: signedTimeMs(draft.delay),
    easing: draft.easing,
    iterations: previewIterations(draft.iterations),
    direction: draft.direction,
    fill: draft.fillMode,
    currentTime: Math.min(
      designDurationMs(draft.duration),
      Math.max(0, currentTime),
    ),
    playing,
  } as const;
}
