// ============================================
// COMPONENT: DesignMotionTimeline
// PURPOSE: Source-backed, multi-track CSS keyframe editing and live preview
// USED IN: DesignCanvas as a persistent bottom work surface
// ============================================

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Diamond,
  Minus,
  Pause,
  Play,
  Plus,
  Save,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";

import { cn } from "../../shared/ui/cn";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import {
  addDesignMotionPropertyKeyframe,
  designDurationMs,
  designMotionEasingIsValid,
  designMotionFirstListValue,
  designMotionIterationCount,
  designMotionNudgedOffset,
  designMotionPlaybackStartOffset,
  designMotionPoints,
  designMotionPresetKeyframes,
  designMotionPreviewCurrentTime,
  designMotionProperties,
  designMotionRulerMarks,
  designMotionTimeAtOffset,
  designMotionTimeInputOffset,
  designMotionTracksAreValid,
  moveDesignMotionPoint,
  removeDesignMotionPoint,
  setDesignMotionPoint,
  type DesignMotionKeyframe,
  type DesignMotionPresetId,
} from "./design-motion-values";
import "./design-motion-timeline.css";

const MOTION_HEIGHT_KEY = "zeros.design.motion-timeline-height";
const MOTION_HEIGHT_VAR = "--zeros-design-motion-height";
const MOTION_HEIGHT_DEFAULT = 240;
const MOTION_HEIGHT_MIN = 160;
const MOTION_HEIGHT_MAX = 480;

function boundedMotionHeight(value: number, maximum = MOTION_HEIGHT_MAX) {
  return Math.round(
    Math.min(
      maximum,
      Math.max(
        MOTION_HEIGHT_MIN,
        Number.isFinite(value) ? value : MOTION_HEIGHT_DEFAULT,
      ),
    ),
  );
}

function readMotionHeight() {
  try {
    const raw = window.localStorage.getItem(MOTION_HEIGHT_KEY);
    if (raw?.trim()) return boundedMotionHeight(Number(raw));
  } catch {
    // Storage is best-effort; private windows keep the default height.
  }
  return MOTION_HEIGHT_DEFAULT;
}

const MotionTimelineResizeHandle = React.memo(
  function MotionTimelineResizeHandle() {
    const handleRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLElement | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const [height, setHeight] = useState(readMotionHeight);
    const [maximum, setMaximum] = useState(MOTION_HEIGHT_MAX);
    const heightRef = useRef(height);
    const preferredHeightRef = useRef(height);
    const maximumRef = useRef(maximum);

    // The canvas and its floating tool rail share this variable. Pointer moves
    // publish directly to the DOM; only a committed size enters React state.
    const publish = useCallback((value: number) => {
      const next = boundedMotionHeight(value, maximumRef.current);
      heightRef.current = next;
      rootRef.current?.style.setProperty(MOTION_HEIGHT_VAR, `${next}px`);
      handleRef.current?.setAttribute("aria-valuenow", String(next));
      handleRef.current?.setAttribute("aria-valuetext", `${next} pixels`);
      return next;
    }, []);

    const commit = useCallback(
      (value: number) => {
        const next = publish(value);
        preferredHeightRef.current = next;
        setHeight(next);
        try {
          window.localStorage.setItem(MOTION_HEIGHT_KEY, String(next));
        } catch {
          // The current canvas still keeps its committed size if storage fails.
        }
        window.dispatchEvent(
          new CustomEvent(MOTION_HEIGHT_KEY, { detail: next }),
        );
      },
      [publish],
    );

    useLayoutEffect(() => {
      const timeline = handleRef.current?.parentElement;
      const root = timeline?.offsetParent ?? timeline?.parentElement;
      if (!(root instanceof HTMLElement)) return;
      rootRef.current = root;
      const measure = () => {
        // Retain the requested pixel size when a smaller canvas temporarily
        // caps it. Extremely short canvases keep the 160px control surface.
        const cap = Math.max(
          MOTION_HEIGHT_MIN,
          Math.min(MOTION_HEIGHT_MAX, Math.floor(root.clientHeight * 0.6)),
        );
        maximumRef.current = cap;
        setMaximum(cap);
        setHeight(publish(preferredHeightRef.current));
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      const synchronize = (event: Event) => {
        if (cleanupRef.current) return;
        if (
          event instanceof StorageEvent &&
          event.key !== MOTION_HEIGHT_KEY &&
          event.key !== null
        )
          return;
        const next =
          event instanceof CustomEvent
            ? boundedMotionHeight(event.detail)
            : readMotionHeight();
        preferredHeightRef.current = next;
        setHeight(publish(next));
      };
      window.addEventListener("storage", synchronize);
      window.addEventListener(MOTION_HEIGHT_KEY, synchronize);
      return () => {
        cleanupRef.current?.();
        observer.disconnect();
        window.removeEventListener("storage", synchronize);
        window.removeEventListener(MOTION_HEIGHT_KEY, synchronize);
        root.style.removeProperty(MOTION_HEIGHT_VAR);
        rootRef.current = null;
      };
    }, [publish]);

    return (
      <div
        ref={handleRef}
        role="separator"
        tabIndex={0}
        aria-label="Resize motion timeline"
        aria-orientation="horizontal"
        aria-valuemin={MOTION_HEIGHT_MIN}
        aria-valuemax={maximum}
        aria-valuenow={height}
        aria-valuetext={`${height} pixels`}
        className="zd-motion-resize-handle"
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 32 : 8;
          commit(heightRef.current + (event.key === "ArrowUp" ? step : -step));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !rootRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          cleanupRef.current?.();
          const handle = event.currentTarget;
          const root = rootRef.current;
          const pointerId = event.pointerId;
          const startY = event.clientY;
          const startHeight = heightRef.current;
          const cursor = document.body.style.cursor;
          const userSelect = document.body.style.userSelect;
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(pointerId);
          root.dataset.designMotionResizing = "true";
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
          const move = (next: PointerEvent) => {
            if (next.pointerId === pointerId)
              publish(startHeight + startY - next.clientY);
          };
          const cleanup = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
            if (handle.hasPointerCapture(pointerId))
              handle.releasePointerCapture(pointerId);
            delete root.dataset.designMotionResizing;
            document.body.style.cursor = cursor;
            document.body.style.userSelect = userSelect;
            cleanupRef.current = null;
          };
          const finish = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            cleanup();
            commit(heightRef.current);
          };
          const cancel = () => {
            cleanup();
            setHeight(publish(startHeight));
          };
          cleanupRef.current = cleanup;
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish);
          window.addEventListener("pointercancel", cancel);
          window.addEventListener("blur", cancel);
        }}
      />
    );
  },
);

const MOTION_EASINGS = [
  { label: "Linear", value: "linear" },
  { label: "Ease", value: "ease" },
  { label: "Ease in", value: "ease-in" },
  { label: "Ease out", value: "ease-out" },
  { label: "Ease in out", value: "ease-in-out" },
  { label: "Spring-ish", value: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
  { label: "Smooth", value: "cubic-bezier(0.22, 1, 0.36, 1)" },
  { label: "Steps", value: "steps(4, end)" },
];

function MotionEasingField({
  value,
  disabled,
  compact,
  onChange,
}: {
  value: string;
  disabled: boolean;
  compact: boolean;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const preset = MOTION_EASINGS.find(
    (easing) =>
      easing.value.replace(/\s/g, "") ===
      value.replace(/\s/g, "").toLowerCase(),
  );
  return (
    <span className="zd-field zd-motion-easing-field">
      {!compact ? (
        <span className="zd-field-label zd-motion-control-label">Easing</span>
      ) : null}
      <Input
        value={editing ? value : (preset?.label ?? value)}
        aria-label="Animation easing"
        aria-invalid={!designMotionEasingIsValid(value)}
        className="px-2"
        disabled={disabled}
        onBlur={() => setEditing(false)}
        onChange={(event) => {
          setEditing(true);
          onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="zd-icon-button zd-motion-easing-trigger"
            aria-label="Choose easing curve"
            disabled={disabled}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="zd-motion-easing-menu"
        >
          <DropdownMenuRadioGroup
            value={preset?.value ?? value}
            onValueChange={onChange}
          >
            {MOTION_EASINGS.map((easing) => (
              <DropdownMenuRadioItem key={easing.value} value={easing.value}>
                {easing.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

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

export interface DesignMotionPropertyRequest {
  id: number;
  property: string;
  value: string;
}

export interface DesignMotionSeekRequest {
  id: number;
  offset: number;
}

interface DesignMotionTimelineProps {
  open: boolean;
  ownerKey: string;
  sessionOwnerKey: string;
  details: DesignRuntimeNodeDetails | null;
  definitions: readonly DesignAuthoredKeyframes[];
  propertyRequest?: DesignMotionPropertyRequest | null;
  seekRequest?: DesignMotionSeekRequest | null;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (
    draft: DesignMotionTimelineDraft,
    currentTime: number,
    playing: boolean,
  ) => Promise<void>;
  onClearPreview: () => Promise<void>;
  onSave: (draft: DesignMotionTimelineDraft) => Promise<void>;
  onDeleteMotion: () => Promise<void>;
  onPropertyRequestHandled?: (id: number) => void;
  onSeekRequestHandled?: (id: number) => void;
  onPropertiesChange?: (properties: readonly string[]) => void;
  onDraftChange?: (draft: DesignMotionTimelineDraft | null) => void;
  onPlayheadChange?: (offset: number) => void;
}

interface SelectedPoint {
  property: string;
  offset: number;
}

interface MotionDraftCacheEntry {
  definitionsSignature: string;
  draft: DesignMotionTimelineDraft;
  playhead: number;
  selectedPoint: SelectedPoint | null;
  selectedProperty: string | null;
  presetId: DesignMotionPresetId | null;
  layerExpanded: boolean;
  propertyDraft: string;
  persistedMotion: boolean;
}

const motionDraftCache = new Map<string, MotionDraftCacheEntry>();
const MOTION_DRAFT_CACHE_LIMIT = 16;

function rememberMotionDraft(key: string, entry: MotionDraftCacheEntry) {
  motionDraftCache.delete(key);
  motionDraftCache.set(key, entry);
  while (motionDraftCache.size > MOTION_DRAFT_CACHE_LIMIT) {
    const oldest = motionDraftCache.keys().next().value;
    if (oldest === undefined) break;
    motionDraftCache.delete(oldest);
  }
}

function MotionTimeField({
  label,
  time,
  duration,
  className,
  disabled,
  suffix,
  onOffsetChange,
}: {
  label: string;
  time: number;
  duration: number;
  className?: string;
  disabled?: boolean;
  suffix?: string;
  onOffsetChange: (offset: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef(false);
  const [draft, setDraft] = useState(String(time));

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(time));
  }, [time]);

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    const offset = designMotionTimeInputOffset(draft, duration);
    if (offset === null) {
      setDraft(String(time));
      return;
    }
    onOffsetChange(offset);
  };

  return (
    <span className={cn("zd-field zd-motion-time-field", className)}>
      <Input
        ref={inputRef}
        type="number"
        min={0}
        max={duration}
        step={1}
        value={draft}
        aria-label={label}
        className="px-2 text-right"
        disabled={disabled}
        onFocus={() => setDraft(String(time))}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRef.current = true;
            setDraft(String(time));
            event.currentTarget.blur();
          }
        }}
      />
      {suffix ? <span className="zd-field-suffix">{suffix}</span> : null}
    </span>
  );
}

const MOTION_PROPERTY_OPTIONS = [
  "opacity",
  "transform",
  "translate",
  "rotate",
  "scale",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "gap",
  "row-gap",
  "column-gap",
  "background-color",
  "color",
  "border-color",
  "border-width",
  "filter",
  "border-radius",
  "box-shadow",
  "text-shadow",
  "clip-path",
  "font-size",
  "line-height",
  "letter-spacing",
] as const;

const MOTION_PRESETS: ReadonlyArray<{
  id: DesignMotionPresetId;
  label: string;
  easing: string;
}> = [
  { id: "fade-in", label: "Fade in", easing: "ease-out" },
  {
    id: "slide-up",
    label: "Slide up",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  {
    id: "slide-down",
    label: "Slide down",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  {
    id: "slide-left",
    label: "Slide left",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  {
    id: "slide-right",
    label: "Slide right",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  {
    id: "scale-in",
    label: "Scale in",
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  { id: "blur-in", label: "Blur in", easing: "ease-out" },
  { id: "pulse", label: "Pulse", easing: "ease-in-out" },
  { id: "spin", label: "Spin", easing: "linear" },
];

function style(
  details: DesignRuntimeNodeDetails,
  camelProperty: string,
  fallback: string,
): string {
  return details.styles[camelProperty] || fallback;
}

function animationName(details: DesignRuntimeNodeDetails): string | null {
  const value = designMotionFirstListValue(
    style(details, "animationName", "none"),
  );
  return !value || value === "none" ? null : value;
}

function motionOwnerHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function defaultMotionName(
  details: DesignRuntimeNodeDetails,
  ownerKey: string,
): string {
  const suffix = details.oid
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `motion-${suffix || "layer"}-${motionOwnerHash(`${ownerKey}\u0000${details.oid}`)}`;
}

function emptyMotionDraft(
  details: DesignRuntimeNodeDetails,
  ownerKey: string,
): DesignMotionTimelineDraft {
  return {
    file: "tokens.css",
    name: defaultMotionName(details, ownerKey),
    keyframes: [],
    duration: "300ms",
    delay: "0ms",
    easing: "ease-out",
    iterations: "1",
    direction: "normal",
    fillMode: "both",
  };
}

function initialMotionDraft(
  details: DesignRuntimeNodeDetails,
  definitions: readonly DesignAuthoredKeyframes[],
  ownerKey: string,
): DesignMotionTimelineDraft {
  const authoredName = animationName(details);
  const definition = definitions.find((item) => item.name === authoredName);
  if (!authoredName && !definition) return emptyMotionDraft(details, ownerKey);
  const name =
    definition?.name ?? authoredName ?? defaultMotionName(details, ownerKey);
  const authoredDuration = designMotionFirstListValue(
    style(details, "animationDuration", "300ms"),
  );
  const keyframes = definition?.keyframes.length
    ? definition.keyframes.map((keyframe) => ({
        offset: keyframe.offset,
        styles: { ...keyframe.styles },
      }))
    : [];
  return {
    file: definition?.file ?? "tokens.css",
    name,
    keyframes,
    duration: /^0(?:\.0+)?(?:ms|s)$/i.test(authoredDuration)
      ? "300ms"
      : authoredDuration,
    delay: designMotionFirstListValue(style(details, "animationDelay", "0ms")),
    easing: designMotionFirstListValue(
      style(details, "animationTimingFunction", "ease-out"),
    ),
    iterations: designMotionFirstListValue(
      style(details, "animationIterationCount", "1"),
    ),
    direction: designMotionDirection(
      style(details, "animationDirection", "normal"),
    ),
    fillMode: designMotionFill(style(details, "animationFillMode", "both")),
  };
}

function designMotionDirection(
  value: string,
): DesignMotionTimelineDraft["direction"] {
  const candidate = designMotionFirstListValue(value);
  return candidate === "reverse" ||
    candidate === "alternate" ||
    candidate === "alternate-reverse"
    ? candidate
    : "normal";
}

function designMotionFill(
  value: string,
): DesignMotionTimelineDraft["fillMode"] {
  const candidate = designMotionFirstListValue(value);
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

function motionDraftIssue(draft: DesignMotionTimelineDraft): string | null {
  const iterations = designMotionIterationCount(draft.iterations);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(draft.name)) {
    return "Use a CSS-safe animation name.";
  }
  if (draft.keyframes.length < 2) return "Add at least two keyframes.";
  if (draft.keyframes.length > 32) return "Keep the motion to 32 keyframes.";
  if (!designMotionTracksAreValid(draft.keyframes)) {
    return "Every property track needs at least two keyframes.";
  }
  if (designDurationMs(draft.duration, 0) <= 0) {
    return "Enter a duration greater than 0ms.";
  }
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s)$/i.test(draft.delay.trim())) {
    return "Enter the delay in ms or s.";
  }
  if (!designMotionEasingIsValid(draft.easing)) {
    return "Choose or enter a valid CSS easing.";
  }
  if (iterations === null || iterations <= 0) {
    return "Enter a positive loop count or infinite.";
  }
  if (
    draft.keyframes.some(
      (keyframe) =>
        Object.keys(keyframe.styles).length === 0 ||
        Object.values(keyframe.styles).some((value) => !value.trim()),
    )
  ) {
    return "Keyframe values cannot be empty.";
  }
  return null;
}

function validMotionDraft(draft: DesignMotionTimelineDraft): boolean {
  return motionDraftIssue(draft) === null;
}

export const DesignMotionTimeline = React.memo(function DesignMotionTimeline({
  open,
  ownerKey,
  sessionOwnerKey,
  details,
  definitions,
  propertyRequest = null,
  seekRequest = null,
  disabled = false,
  onOpenChange,
  onPreview,
  onClearPreview,
  onSave,
  onDeleteMotion,
  onPropertyRequestHandled,
  onSeekRequestHandled,
  onPropertiesChange,
  onDraftChange,
  onPlayheadChange,
}: DesignMotionTimelineProps) {
  const motionPropertiesListId = useId();
  const timelineRef = useRef<HTMLElement | null>(null);
  const [compactTiming, setCompactTiming] = useState(false);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!open || !timeline) return;
    // The settings surface is portaled, so mirror the timeline's container
    // breakpoint there. Container queries handle the header before this read.
    const update = (width: number) => setCompactTiming(width <= 720);
    update(timeline.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [open]);
  const detailsOwner = details?.oid ?? "";
  const motionOwner = `${ownerKey}\u0000${detailsOwner}`;
  const definitionsSignature = useMemo(
    () => JSON.stringify(definitions),
    [definitions],
  );
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const cachedSessionCandidate = motionDraftCache.get(sessionOwnerKey);
  const cachedSession =
    cachedSessionCandidate?.definitionsSignature === definitionsSignature
      ? cachedSessionCandidate
      : null;
  const [draft, setDraft] = useState<DesignMotionTimelineDraft | null>(
    () =>
      cachedSession?.draft ??
      (details ? initialMotionDraft(details, definitions, ownerKey) : null),
  );
  const [playhead, setPlayhead] = useState(cachedSession?.playhead ?? 0);
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    cachedSession?.selectedPoint ?? null,
  );
  const [selectedProperty, setSelectedProperty] = useState<string | null>(
    cachedSession?.selectedProperty ?? null,
  );
  const [presetId, setPresetId] = useState<DesignMotionPresetId | null>(
    cachedSession?.presetId ?? null,
  );
  const [layerExpanded, setLayerExpanded] = useState(
    cachedSession?.layerExpanded ?? true,
  );
  const [propertyDraft, setPropertyDraft] = useState(
    cachedSession?.propertyDraft ?? "",
  );
  const [propertyInvalid, setPropertyInvalid] = useState(false);
  const [dirty, setDirty] = useState(cachedSession !== null);
  const [persistedMotion, setPersistedMotion] = useState(
    () =>
      cachedSession?.persistedMotion ??
      (details ? animationName(details) !== null : false),
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
  const handledPropertyRequestIdRef = useRef<number | null>(null);
  const handledSeekRequestIdRef = useRef<number | null>(null);
  const pointDragMovedRef = useRef(false);
  const activePointerCleanupRef = useRef<(() => void) | null>(null);
  const motionDraftSessionRef = useRef<MotionDraftCacheEntry | null>(null);
  motionDraftSessionRef.current = draft
    ? {
        definitionsSignature,
        draft,
        playhead,
        selectedPoint,
        selectedProperty,
        presetId,
        layerExpanded,
        propertyDraft,
        persistedMotion,
      }
    : null;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const sessionOwnerKeyRef = useRef(sessionOwnerKey);
  sessionOwnerKeyRef.current = sessionOwnerKey;

  const properties = useMemo(
    () => (draft ? designMotionProperties(draft.keyframes) : []),
    [draft],
  );
  const points = useMemo(
    () => (draft ? designMotionPoints(draft.keyframes) : []),
    [draft],
  );
  const durationMs = draft ? designDurationMs(draft.duration) : 300;
  const rulerMarks = useMemo(
    () => designMotionRulerMarks(durationMs),
    [durationMs],
  );
  const iterationCount = draft
    ? (designMotionIterationCount(draft.iterations) ?? 1)
    : 1;

  useEffect(() => {
    onPropertiesChange?.(properties);
  }, [onPropertiesChange, properties]);

  useEffect(() => {
    onDraftChange?.(draft && validMotionDraft(draft) ? draft : null);
  }, [draft, onDraftChange]);

  useEffect(() => {
    onPlayheadChange?.(playhead);
  }, [onPlayheadChange, playhead]);

  useEffect(() => {
    const cached = motionDraftCache.get(sessionOwnerKey);
    if (cached?.definitionsSignature === definitionsSignature) {
      motionDraftCache.delete(sessionOwnerKey);
      setDraft(cached.draft);
      setPlayhead(cached.playhead);
      setSelectedPoint(cached.selectedPoint);
      setSelectedProperty(cached.selectedProperty);
      setPresetId(cached.presetId);
      setLayerExpanded(cached.layerExpanded);
      setPropertyDraft(cached.propertyDraft);
      setDirty(true);
      setPersistedMotion(cached.persistedMotion);
      setPlaying(false);
      return;
    }
    motionDraftCache.delete(sessionOwnerKey);
    const ownerDetails = detailsRef.current;
    if (!ownerDetails) {
      setDraft(null);
      setPlaying(false);
      return;
    }
    setDraft(
      initialMotionDraft(ownerDetails, definitionsRef.current, ownerKey),
    );
    setPlayhead(0);
    setSelectedPoint(null);
    setSelectedProperty(null);
    setPresetId(null);
    setLayerExpanded(true);
    setDirty(false);
    setPersistedMotion(animationName(ownerDetails) !== null);
    setPlaying(false);
  }, [definitionsSignature, motionOwner, ownerKey, sessionOwnerKey]);

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

  const clearActivePreview = useCallback(() => {
    queuedPreviewRef.current = null;
    if (!motionPreviewActiveRef.current) return;
    motionPreviewActiveRef.current = false;
    void clearPreviewRef.current().catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || playing) return;
    if (!draft || !validMotionDraft(draft)) {
      clearActivePreview();
      return;
    }
    queuePreview(draft, (playhead / 100) * durationMs, false);
  }, [
    clearActivePreview,
    draft,
    durationMs,
    open,
    playhead,
    playing,
    queuePreview,
  ]);

  useEffect(() => {
    if (!open || !draft || !playing || !validMotionDraft(draft)) return;
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
    setPlaying(false);
    clearActivePreview();
  }, [clearActivePreview, open]);

  // A disabled timeline (its Design surface went inactive, or its Foundation
  // is not ready) stops playing; the draft and playhead stay for its return.
  useEffect(() => {
    if (disabled) setPlaying(false);
  }, [disabled]);

  useEffect(
    () => () => {
      activePointerCleanupRef.current?.();
      activePointerCleanupRef.current = null;
      const cachedDraft = motionDraftSessionRef.current;
      if (dirtyRef.current && cachedDraft) {
        rememberMotionDraft(sessionOwnerKeyRef.current, cachedDraft);
      }
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
      setPresetId(null);
      setDraft((current) => (current ? mutate(current) : current));
      setDirty(true);
    },
    [],
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = MOTION_PRESETS.find(({ id }) => id === presetId);
      if (!preset) return;
      mutateDraft((current) => ({
        ...current,
        keyframes: designMotionPresetKeyframes(preset.id),
        duration: preset.id === "pulse" ? "600ms" : "300ms",
        easing: preset.easing,
        iterations: "1",
        direction: "normal",
        fillMode: "both",
      }));
      setPlayhead(0);
      setSelectedPoint(null);
      setSelectedProperty(null);
      setPresetId(preset.id);
      setLayerExpanded(true);
    },
    [mutateDraft],
  );

  useEffect(() => {
    if (
      !open ||
      !details ||
      !propertyRequest ||
      handledPropertyRequestIdRef.current === propertyRequest.id
    ) {
      return;
    }
    handledPropertyRequestIdRef.current = propertyRequest.id;
    const property = propertyRequest.property.trim().toLocaleLowerCase();
    if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      onPropertyRequestHandled?.(propertyRequest.id);
      return;
    }
    const offset = Math.round(playheadRef.current * 10) / 10;
    mutateDraft((current) => ({
      ...current,
      keyframes: addDesignMotionPropertyKeyframe(
        current.keyframes,
        property,
        offset,
        propertyRequest.value,
      ),
    }));
    setPlayhead(offset);
    setSelectedPoint({ property, offset });
    setSelectedProperty(property);
    onPropertyRequestHandled?.(propertyRequest.id);
  }, [details, mutateDraft, onPropertyRequestHandled, open, propertyRequest]);

  useEffect(() => {
    if (
      !open ||
      !seekRequest ||
      handledSeekRequestIdRef.current === seekRequest.id
    ) {
      return;
    }
    handledSeekRequestIdRef.current = seekRequest.id;
    setPlaying(false);
    setPlayhead(
      Math.round(Math.min(100, Math.max(0, seekRequest.offset)) * 10) / 10,
    );
    onSeekRequestHandled?.(seekRequest.id);
  }, [onSeekRequestHandled, open, seekRequest]);

  const addProperty = useCallback(() => {
    if (!details || !draft) return;
    const property = propertyDraft.trim().toLowerCase();
    if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      setPropertyInvalid(true);
      return;
    }
    setPropertyInvalid(false);
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
    setSelectedProperty(property);
    setPropertyDraft("");
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
      setSelectedProperty(property);
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
      setSelectedProperty((current) => (current === property ? null : current));
    },
    [mutateDraft],
  );

  const removePoint = useCallback(
    (property: string, offset: number) => {
      mutateDraft((current) => ({
        ...current,
        keyframes: removeDesignMotionPoint(current.keyframes, property, offset),
      }));
      setSelectedPoint(null);
    },
    [mutateDraft],
  );

  const retimePoint = useCallback(
    (property: string, offset: number, nextOffset: number) => {
      if (offset === nextOffset) return;
      mutateDraft((current) => ({
        ...current,
        keyframes: moveDesignMotionPoint(
          current.keyframes,
          property,
          offset,
          nextOffset,
        ),
      }));
      setPlayhead(nextOffset);
      setSelectedPoint({ property, offset: nextOffset });
      setSelectedProperty(property);
    },
    [mutateDraft],
  );

  const setPlayheadFromClientX = useCallback(
    (clientX: number, track: HTMLElement) => {
      const bounds = track.getBoundingClientRect();
      if (bounds.width <= 0) return;
      setPlaying(false);
      setPlayhead(
        Math.round(
          Math.min(
            100,
            Math.max(0, ((clientX - bounds.left) / bounds.width) * 100),
          ) * 10,
        ) / 10,
      );
    },
    [],
  );

  const startTimelineScrub = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      activePointerCleanupRef.current?.();
      const track = event.currentTarget;
      const move = (pointerEvent: PointerEvent) =>
        setPlayheadFromClientX(pointerEvent.clientX, track);
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (activePointerCleanupRef.current === finish) {
          activePointerCleanupRef.current = null;
        }
      };
      activePointerCleanupRef.current = finish;
      setPlayheadFromClientX(event.clientX, track);
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [disabled, setPlayheadFromClientX],
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
      activePointerCleanupRef.current?.();
      pointDragMovedRef.current = false;
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
        pointDragMovedRef.current = true;
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
        setPresetId(null);
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
        if (activePointerCleanupRef.current === finish) {
          activePointerCleanupRef.current = null;
        }
      };
      activePointerCleanupRef.current = finish;
      setPlaying(false);
      setSelectedPoint({ property, offset: initialOffset });
      setSelectedProperty(property);
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
      motionDraftCache.delete(sessionOwnerKey);
      setDirty(false);
      setPersistedMotion(true);
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
  }, [draft, onSave, saving, sessionOwnerKey]);

  const deleteMotion = useCallback(async () => {
    if (!details || saving) return;
    setPlaying(false);
    clearActivePreview();
    setSaving(true);
    try {
      if (persistedMotion) await onDeleteMotion();
      motionDraftCache.delete(sessionOwnerKey);
      setDraft(emptyMotionDraft(details, ownerKey));
      setPlayhead(0);
      setSelectedPoint(null);
      setSelectedProperty(null);
      setPresetId(null);
      setDirty(false);
      setPersistedMotion(false);
      setPropertyDraft("");
    } catch (error) {
      toast.error("Couldn't remove the motion", {
        description:
          error instanceof Error
            ? error.message
            : "The motion could not be removed.",
      });
    } finally {
      setSaving(false);
    }
  }, [
    clearActivePreview,
    details,
    onDeleteMotion,
    ownerKey,
    persistedMotion,
    saving,
    sessionOwnerKey,
  ]);

  if (!open) return null;

  if (!details || !draft) {
    return (
      <section
        ref={timelineRef}
        data-design-controls
        data-design-motion-timeline=""
        className="zd-motion-timeline bg-bg1 absolute z-40 flex min-w-0 flex-col"
        aria-label="Motion timeline"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MotionTimelineResizeHandle />
        <div className="zd-motion-header">
          <Diamond className="zd-motion-accent size-3.5 fill-current" />
          <span className="text-fg1 text-xs font-medium">Motion</span>
          <Tooltip label="Close motion timeline">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="zd-icon-button ml-auto"
              data-size="row"
              aria-label="Close motion timeline"
              onClick={() => onOpenChange(false)}
            >
              <ChevronDown />
            </Button>
          </Tooltip>
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
  const draftIssue = motionDraftIssue(draft);
  const durationUnit = /ms$/i.test(draft.duration)
    ? "ms"
    : /s$/i.test(draft.duration)
      ? "s"
      : "ms";
  const durationField = (
    <span className="zd-field zd-motion-duration-field">
      <Input
        value={draft.duration.replace(/(?:ms|s)$/i, "")}
        aria-label="Animation duration"
        aria-invalid={designDurationMs(draft.duration, 0) <= 0}
        className="px-2"
        disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value;
          const duration = /^-?(?:\d*(?:\.\d*)?)$/.test(value)
            ? `${value}${durationUnit}`
            : value;
          mutateDraft((current) => ({ ...current, duration }));
        }}
      />
      <span className="zd-field-suffix">{durationUnit}</span>
    </span>
  );
  const easingField = (
    <MotionEasingField
      value={draft.easing}
      compact={compactTiming}
      disabled={disabled}
      onChange={(easing) => mutateDraft((current) => ({ ...current, easing }))}
    />
  );
  const laneGuides = (
    <>
      {rulerMarks.map((mark) => (
        <span
          key={mark.time}
          className="zd-motion-grid-line"
          style={{ left: `${mark.offset}%` }}
        />
      ))}
      <span className="zd-motion-playhead" style={{ left: `${playhead}%` }} />
    </>
  );

  return (
    <section
      ref={timelineRef}
      data-design-controls
      data-design-motion-timeline=""
      className="zd-motion-timeline bg-bg1 absolute z-40 flex min-w-0 flex-col"
      aria-label="Motion timeline"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MotionTimelineResizeHandle />
      <div className="zd-motion-header">
        <div className="zd-motion-heading">
          <Diamond className="zd-motion-accent size-3.5 shrink-0 fill-current" />
          <span className="zd-motion-title text-fg1 text-xs font-medium">
            Motion
          </span>
          {dirty ? (
            <Tooltip label="Unsaved motion changes">
              <span
                className="zd-motion-unsaved"
                aria-label="Unsaved motion changes"
              />
            </Tooltip>
          ) : null}
          <Tooltip label={details.name}>
            <span className="zd-motion-owner">{details.name}</span>
          </Tooltip>
        </div>
        <div className="zd-motion-transport">
          <Tooltip label={playing ? "Pause preview" : "Play preview"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="zd-icon-button zd-motion-play"
              data-size="row"
              aria-pressed={playing}
              aria-label={
                playing ? "Pause motion preview" : "Play motion preview"
              }
              disabled={disabled || !validMotionDraft(draft)}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                  return;
                }
                setPlayhead(
                  designMotionPlaybackStartOffset(playheadRef.current),
                );
                setPlaying(true);
              }}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
          </Tooltip>
          <MotionTimeField
            label="Motion current time"
            time={designMotionTimeAtOffset(playhead, durationMs)}
            duration={durationMs}
            disabled={disabled}
            onOffsetChange={(offset) => {
              setPlaying(false);
              setPlayhead(offset);
            }}
          />
          <span className="zd-motion-total">/ {durationMs} ms</span>
        </div>
        <Select
          value={presetId ?? ""}
          disabled={disabled}
          onValueChange={applyPreset}
        >
          <Tooltip label="Motion preset">
            <SelectTrigger
              size="sm"
              className="zd-field zd-motion-preset"
              aria-label="Motion preset"
            >
              <Sparkles className="zd-motion-preset-icon size-3.5" />
              <span className="zd-motion-preset-label">
                <SelectValue placeholder="Preset" />
              </span>
            </SelectTrigger>
          </Tooltip>
          <SelectContent>
            {MOTION_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="zd-motion-header-timing">
          {!compactTiming ? (
            <>
              {easingField}
              {durationField}
            </>
          ) : null}
        </div>
        <Popover>
          <Tooltip label="More motion settings">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="zd-icon-button"
                data-size="row"
                aria-label="More motion settings"
                disabled={disabled}
              >
                <Settings />
              </Button>
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent
            data-design-motion-settings
            align="end"
            side="top"
            sideOffset={8}
            className="zd-popover zd-motion-settings-popover"
          >
            <div className="zd-popover-header">
              <span className="zd-popover-title">Motion settings</span>
            </div>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Name</span>
              <Input
                value={draft.name}
                aria-label="Animation name"
                aria-invalid={
                  !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(draft.name)
                }
                className="zd-field px-2"
                disabled={disabled}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  mutateDraft((current) => ({ ...current, name }));
                }}
              />
            </label>
            {compactTiming ? (
              <>
                <label className="zd-motion-setting">
                  <span className="zd-row-label">Easing</span>
                  {easingField}
                </label>
                <label className="zd-motion-setting">
                  <span className="zd-row-label">Duration</span>
                  {durationField}
                </label>
              </>
            ) : null}
            <label className="zd-motion-setting">
              <span className="zd-row-label">Delay</span>
              <Input
                value={draft.delay}
                aria-label="Animation delay"
                aria-invalid={
                  !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s)$/i.test(
                    draft.delay.trim(),
                  )
                }
                className="zd-field px-2"
                disabled={disabled}
                onChange={(event) => {
                  const delay = event.currentTarget.value;
                  mutateDraft((current) => ({ ...current, delay }));
                }}
              />
            </label>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Loop</span>
              <Input
                value={draft.iterations}
                aria-label="Animation iterations"
                aria-invalid={
                  designMotionIterationCount(draft.iterations) === null ||
                  (designMotionIterationCount(draft.iterations) ?? 0) <= 0
                }
                className="zd-field px-2"
                disabled={disabled}
                onChange={(event) => {
                  const iterations = event.currentTarget.value;
                  mutateDraft((current) => ({ ...current, iterations }));
                }}
              />
            </label>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Direction</span>
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
                  className="zd-field w-full"
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
            </label>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Fill</span>
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
                  className="zd-field w-full"
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
            </label>
          </PopoverContent>
        </Popover>
        {persistedMotion || draft.keyframes.length > 0 ? (
          <Tooltip
            label={persistedMotion ? "Delete motion" : "Clear motion draft"}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="zd-icon-button"
              data-size="row"
              aria-label={
                persistedMotion ? "Delete motion" : "Clear motion draft"
              }
              disabled={disabled || saving}
              onClick={() => void deleteMotion()}
            >
              <Trash2 />
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip
          label={draftIssue ?? (dirty ? "Save keyframes" : "Motion is saved")}
        >
          <span className="zd-motion-save-target">
            <Button
              type="button"
              variant={dirty ? "default" : "ghost"}
              size="sm"
              className="zd-motion-save"
              aria-label={saving ? "Saving…" : "Save"}
              disabled={disabled || saving || !dirty || draftIssue !== null}
              onClick={() => void save()}
            >
              <Save />
              <span className="zd-motion-save-label">
                {saving ? "Saving…" : "Save"}
              </span>
            </Button>
          </span>
        </Tooltip>
        <Tooltip label="Close motion timeline">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="zd-icon-button"
            data-size="row"
            aria-label="Close motion timeline"
            onClick={() => onOpenChange(false)}
          >
            <ChevronDown />
          </Button>
        </Tooltip>
      </div>

      <div className="zd-motion-scroll">
        <div
          className="zd-motion-grid"
          style={
            {
              "--motion-rows": `28px 32px ${layerExpanded && properties.length ? `repeat(${properties.length}, 28px)` : ""} minmax(0, 1fr)`,
            } as React.CSSProperties
          }
        >
          <div className="zd-motion-ruler-row">
            <div className="zd-motion-property-control">
              <Tooltip
                label={
                  propertyInvalid
                    ? "Enter a valid CSS property."
                    : "Add property"
                }
              >
                <Input
                  list={motionPropertiesListId}
                  value={propertyDraft}
                  placeholder="Add property"
                  aria-label="Motion property"
                  aria-invalid={propertyInvalid}
                  className="zd-field px-2"
                  disabled={disabled}
                  onChange={(event) => {
                    setPropertyDraft(event.currentTarget.value);
                    setPropertyInvalid(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addProperty();
                    }
                  }}
                />
              </Tooltip>
              <datalist id={motionPropertiesListId}>
                {MOTION_PROPERTY_OPTIONS.map((property) => (
                  <option key={property} value={property} />
                ))}
              </datalist>
              <Tooltip label="Add animated property">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="zd-icon-button"
                  data-size="row"
                  aria-label="Add animated property"
                  disabled={disabled || !propertyDraft.trim()}
                  onClick={addProperty}
                >
                  <Plus />
                </Button>
              </Tooltip>
            </div>
            <div className="zd-motion-lane-cell">
              <div
                className="zd-motion-lane zd-motion-ruler"
                aria-label="Motion time ruler"
                onPointerDown={startTimelineScrub}
              >
                {rulerMarks.map((mark) => (
                  <span
                    key={mark.time}
                    className="zd-motion-ruler-mark"
                    data-edge={
                      mark.offset === 0
                        ? "start"
                        : mark.offset === 100
                          ? "end"
                          : undefined
                    }
                    style={{ left: `${mark.offset}%` }}
                  >
                    {mark.time}
                    {mark.offset === 100 ? " ms" : ""}
                  </span>
                ))}
                <span
                  className="zd-motion-playhead"
                  style={{ left: `${playhead}%` }}
                >
                  <span className="zd-motion-playhead-handle" />
                </span>
              </div>
            </div>
          </div>
          <div className="zd-motion-layer-row">
            <div className="zd-motion-layer-name">
              <Tooltip
                label={
                  layerExpanded
                    ? "Collapse motion layer"
                    : "Expand motion layer"
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="zd-icon-button"
                  aria-label={
                    layerExpanded
                      ? "Collapse motion layer"
                      : "Expand motion layer"
                  }
                  aria-expanded={layerExpanded}
                  onClick={() => setLayerExpanded((current) => !current)}
                >
                  {layerExpanded ? <ChevronDown /> : <ChevronRight />}
                </Button>
              </Tooltip>
              <Box className="text-fg2 size-3.5 shrink-0" />
              <span className="text-fg1 min-w-0 flex-1 truncate text-xs">
                {details.name}
              </span>
              <span className="text-muted-fg text-3xxs tabular-nums">
                {properties.length}
              </span>
            </div>
            <div className="zd-motion-lane-cell">
              <div
                className="zd-motion-lane"
                data-motion-track
                onPointerDown={startTimelineScrub}
              >
                {laneGuides}
                <span className="zd-motion-clip" />
              </div>
            </div>
          </div>
          {layerExpanded
            ? properties.map((property) => {
                const propertyPoints = points.filter(
                  (point) => point.property === property,
                );
                const propertySelected = selectedProperty === property;
                const firstOffset = propertyPoints[0]?.offset ?? 0;
                const lastOffset = propertyPoints.at(-1)?.offset ?? firstOffset;
                return (
                  <div
                    key={property}
                    data-design-motion-track-row=""
                    data-selected={propertySelected ? "true" : undefined}
                    className="zd-motion-property-row"
                  >
                    <div
                      className="zd-motion-property-name"
                      aria-invalid={dirty && propertyPoints.length < 2}
                      onClick={() => setSelectedProperty(property)}
                    >
                      <Tooltip label={property}>
                        <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
                          {property}
                        </span>
                      </Tooltip>
                      <div className="zd-motion-track-actions">
                        <Tooltip
                          label={`Add ${property} keyframe at ${designMotionTimeAtOffset(playhead, durationMs)}ms`}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="zd-icon-button"
                            aria-label={`Add ${property} keyframe`}
                            disabled={disabled}
                            onClick={() => addPoint(property)}
                          >
                            <Diamond />
                          </Button>
                        </Tooltip>
                        <Tooltip label={`Remove ${property} track`}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="zd-icon-button"
                            aria-label={`Remove ${property} track`}
                            disabled={disabled}
                            onClick={() => removeProperty(property)}
                          >
                            <Minus />
                          </Button>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="zd-motion-lane-cell">
                      <div
                        data-motion-track
                        className="zd-motion-lane zd-motion-property-lane"
                        onPointerDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          setSelectedProperty(property);
                          startTimelineScrub(event);
                        }}
                        onDoubleClick={(event) => {
                          if (event.target !== event.currentTarget) return;
                          addPoint(property);
                        }}
                      >
                        {laneGuides}
                        <span
                          className="zd-motion-connector"
                          style={{
                            left: `${firstOffset}%`,
                            width: `${lastOffset - firstOffset}%`,
                          }}
                        />
                        {propertyPoints.map((point) => {
                          const selected =
                            selectedPoint?.property === property &&
                            selectedPoint.offset === point.offset;
                          return (
                            <button
                              key={point.offset}
                              type="button"
                              className={cn(
                                "zd-design-motion-keyframe zd-motion-keyframe",
                                selected &&
                                  "zd-design-motion-keyframe-selected",
                              )}
                              style={{ left: `${point.offset}%` }}
                              aria-label={`${property} keyframe at ${point.offset}% (${designMotionTimeAtOffset(point.offset, durationMs)}ms)`}
                              aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete Backspace"
                              aria-pressed={selected}
                              disabled={disabled}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (pointDragMovedRef.current) {
                                  pointDragMovedRef.current = false;
                                  return;
                                }
                                setPlaying(false);
                                setPlayhead(point.offset);
                                setSelectedPoint({
                                  property,
                                  offset: point.offset,
                                });
                                setSelectedProperty(property);
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Delete" ||
                                  event.key === "Backspace"
                                ) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  removePoint(property, point.offset);
                                  return;
                                }
                                let nextOffset: number | null = null;
                                if (event.key === "ArrowLeft") {
                                  nextOffset = designMotionNudgedOffset(
                                    point.offset,
                                    -1,
                                    event.shiftKey,
                                  );
                                } else if (event.key === "ArrowRight") {
                                  nextOffset = designMotionNudgedOffset(
                                    point.offset,
                                    1,
                                    event.shiftKey,
                                  );
                                } else if (event.key === "Home") {
                                  nextOffset = 0;
                                } else if (event.key === "End") {
                                  nextOffset = 100;
                                }
                                if (nextOffset === null) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setPlaying(false);
                                retimePoint(property, point.offset, nextOffset);
                              }}
                              onPointerDown={(event) =>
                                startPointDrag(event, property, point.offset)
                              }
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })
            : null}
          <div className="zd-motion-empty-lanes" aria-hidden="true">
            <div className="zd-motion-empty-label" />
            <div className="zd-motion-lane-cell">
              <div className="zd-motion-lane">{laneGuides}</div>
            </div>
          </div>
        </div>
      </div>

      {selectedPoint && selectedValue != null ? (
        <div className="zd-motion-keyframe-bar">
          <span className="zd-motion-selected-property">
            <Diamond className="zd-motion-accent size-3.5 shrink-0 fill-current" />
            <span className="truncate">{selectedPoint.property}</span>
          </span>
          <MotionTimeField
            label="Selected keyframe time"
            time={designMotionTimeAtOffset(selectedPoint.offset, durationMs)}
            duration={durationMs}
            className="zd-motion-keyframe-time"
            suffix="ms"
            disabled={disabled}
            onOffsetChange={(nextOffset) =>
              retimePoint(
                selectedPoint.property,
                selectedPoint.offset,
                nextOffset,
              )
            }
          />
          <Input
            value={selectedValue}
            aria-label={`${selectedPoint.property} keyframe value`}
            aria-invalid={!selectedValue.trim()}
            className="zd-field zd-motion-keyframe-value px-2"
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
          <Tooltip label="Delete selected keyframe">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="zd-icon-button"
              data-size="row"
              aria-label="Delete selected keyframe"
              disabled={disabled}
              onClick={() =>
                removePoint(selectedPoint.property, selectedPoint.offset)
              }
            >
              <Trash2 />
            </Button>
          </Tooltip>
        </div>
      ) : null}
    </section>
  );
});

export function designMotionPreviewInput(
  draft: DesignMotionTimelineDraft,
  currentTime: number,
  playing: boolean,
) {
  const duration = designDurationMs(draft.duration);
  const delay = signedTimeMs(draft.delay);
  return {
    keyframes: draft.keyframes.map((keyframe) => ({
      offset: keyframe.offset,
      styles: { ...keyframe.styles },
    })),
    duration,
    delay,
    easing: draft.easing,
    iterations: previewIterations(draft.iterations),
    direction: draft.direction,
    fill: draft.fillMode,
    currentTime: designMotionPreviewCurrentTime(currentTime, duration, delay),
    playing,
  } as const;
}
