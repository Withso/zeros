// ============================================
// COMPONENT: DesignMotionTimeline
// PURPOSE: Source-backed, multi-track CSS keyframe editing and live preview
// USED IN: DesignCanvas as a persistent bottom work surface
// ============================================

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Clock3,
  Diamond,
  Pause,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";

import { cn } from "../../shared/ui/cn";
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
  onOffsetChange,
}: {
  label: string;
  time: number;
  duration: number;
  className?: string;
  disabled?: boolean;
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
    <Input
      ref={inputRef}
      type="number"
      min={0}
      max={duration}
      step={1}
      value={draft}
      aria-label={label}
      className={className}
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
  const motionEasingsListId = useId();
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
    cachedSession?.propertyDraft ?? "opacity",
  );
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
    setPropertyDraft(property);
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
    setSelectedProperty(property);
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
      toast.success(persistedMotion ? "Motion removed" : "Motion cleared");
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
        data-design-controls
        className="border-border1 bg-bg1 absolute inset-x-0 bottom-0 z-40 flex h-52 flex-col border-t shadow-lg"
        aria-label="Motion timeline"
      >
        <div className="flex h-10 items-center gap-2 px-3">
          <Diamond className="text-highlighted-bright size-3.5" />
          <span className="text-fg1 text-xs font-medium">Motion</span>
          <span className="text-muted-fg text-[11px]">
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
  const draftIssue = motionDraftIssue(draft);

  return (
    <section
      data-design-controls
      className="zd-design-motion-timeline border-border1 bg-bg1 absolute inset-x-0 bottom-0 z-40 flex h-80 min-w-0 flex-col border-t shadow-lg"
      aria-label="Motion timeline"
    >
      <div className="zd-design-motion-header border-border1 flex h-10 shrink-0 items-center gap-1 border-b px-3">
        <span className="zd-design-motion-accent mr-1 flex size-5 items-center justify-center rounded-sm">
          <Diamond className="size-3 fill-current" />
        </span>
        <span className="text-fg1 text-xs font-semibold">Motion</span>
        {dirty ? (
          <span
            className="bg-highlighted-bright size-1.5 shrink-0 rounded-full"
            aria-label="Unsaved motion changes"
            title="Unsaved motion changes"
          />
        ) : null}
        <span className="zd-design-motion-owner bg-bg2 text-fg2 ml-1 max-w-44 truncate rounded px-1.5 py-0.5 text-[10px]">
          {details.name}
        </span>
        <span className="zd-design-motion-owner text-muted-fg font-mono text-[9px] uppercase">
          {details.tag}
        </span>
        <div className="border-border1 ml-2 flex items-center gap-0.5 border-l pl-2">
          <Tooltip label={playing ? "Pause preview" : "Play preview"}>
            <Button
              type="button"
              variant={playing ? "secondary-on" : "ghost"}
              size="icon-sm"
              className={playing ? "zd-design-state-active" : undefined}
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
          <Clock3 className="text-muted-fg ml-1 size-3" />
          <MotionTimeField
            label="Motion current time"
            time={designMotionTimeAtOffset(playhead, durationMs)}
            duration={durationMs}
            className="zd-design-control-quiet h-6 w-16 shrink-0 text-right font-mono text-[10px]"
            disabled={disabled}
            onOffsetChange={(offset) => {
              setPlaying(false);
              setPlayhead(offset);
            }}
          />
          <span className="text-muted-fg shrink-0 font-mono text-[9px]">
            ms / {durationMs}ms
          </span>
        </div>
        <span className="zd-design-motion-hint text-muted-fg ml-auto shrink-0 text-[9px]">
          Inspector diamonds add keys at the playhead
        </span>
        {persistedMotion || draft.keyframes.length > 0 ? (
          <Tooltip
            label={persistedMotion ? "Delete motion" : "Clear motion draft"}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
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
          label={dirty ? (draftIssue ?? "Save keyframes") : "Motion is saved"}
        >
          <Button
            type="button"
            variant={dirty ? "default" : "ghost"}
            size="sm"
            disabled={disabled || saving || !dirty || draftIssue !== null}
            onClick={() => void save()}
          >
            <Save />
            <span className="zd-design-motion-save-label">
              {saving ? "Saving…" : "Save"}
            </span>
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

      <div className="zd-design-motion-settings border-border1 flex h-9 min-w-0 shrink-0 items-center gap-1.5 border-b px-3">
        <span className="zd-design-motion-setting-label text-muted-fg text-[9px] uppercase">
          Preset
        </span>
        <Select
          value={presetId ?? ""}
          disabled={disabled}
          onValueChange={applyPreset}
        >
          <SelectTrigger
            size="sm"
            className="zd-design-control-quiet h-6 w-24 shrink-0 text-[10px]"
            aria-label="Motion preset"
          >
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            {MOTION_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="bg-border1 mx-0.5 h-4 w-px shrink-0" />
        <span className="zd-design-motion-setting-label text-muted-fg text-[9px] uppercase">
          Duration
        </span>
        <Input
          value={draft.duration}
          aria-label="Animation duration"
          aria-invalid={designDurationMs(draft.duration, 0) <= 0}
          className="zd-design-control-applied h-6 w-16 shrink-0 font-mono text-[10px]"
          disabled={disabled}
          onChange={(event) => {
            const duration = event.currentTarget.value;
            mutateDraft((current) => ({ ...current, duration }));
          }}
        />
        <span className="zd-design-motion-setting-label text-muted-fg text-[9px] uppercase">
          Ease
        </span>
        <Input
          list={motionEasingsListId}
          value={draft.easing}
          aria-label="Animation easing"
          aria-invalid={!designMotionEasingIsValid(draft.easing)}
          className="zd-design-control-applied h-6 min-w-24 flex-1 font-mono text-[10px]"
          disabled={disabled}
          onChange={(event) => {
            const easing = event.currentTarget.value;
            mutateDraft((current) => ({ ...current, easing }));
          }}
        />
        <datalist id={motionEasingsListId}>
          <option value="linear" />
          <option value="ease" />
          <option value="ease-in" />
          <option value="ease-out" />
          <option value="ease-in-out" />
          <option value="cubic-bezier(0.22, 1, 0.36, 1)" />
          <option value="cubic-bezier(0.34, 1.56, 0.64, 1)" />
          <option value="steps(4, end)" />
        </datalist>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="More motion settings"
              disabled={disabled}
            >
              <SlidersHorizontal />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            data-design-motion-settings
            align="end"
            sideOffset={6}
            className="w-72 p-3"
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-fg1 text-xs font-medium">
                  Motion settings
                </span>
                <span className="text-muted-fg text-[10px]">
                  Naming, delay, looping, and playback behavior
                </span>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-muted-fg text-[10px]">Name</span>
                <Input
                  value={draft.name}
                  aria-label="Animation name"
                  aria-invalid={
                    !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(draft.name)
                  }
                  className="zd-design-control-applied h-7 font-mono text-[10px]"
                  disabled={disabled}
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    mutateDraft((current) => ({ ...current, name }));
                  }}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-muted-fg text-[10px]">Delay</span>
                  <Input
                    value={draft.delay}
                    aria-label="Animation delay"
                    aria-invalid={
                      !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s)$/i.test(
                        draft.delay.trim(),
                      )
                    }
                    className="zd-design-control-applied h-7 font-mono text-[10px]"
                    disabled={disabled}
                    onChange={(event) => {
                      const delay = event.currentTarget.value;
                      mutateDraft((current) => ({ ...current, delay }));
                    }}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-muted-fg text-[10px]">Loop</span>
                  <Input
                    value={draft.iterations}
                    aria-label="Animation iterations"
                    aria-invalid={
                      designMotionIterationCount(draft.iterations) === null ||
                      (designMotionIterationCount(draft.iterations) ?? 0) <= 0
                    }
                    className="zd-design-control-applied h-7 font-mono text-[10px]"
                    disabled={disabled}
                    onChange={(event) => {
                      const iterations = event.currentTarget.value;
                      mutateDraft((current) => ({ ...current, iterations }));
                    }}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-muted-fg text-[10px]">Direction</span>
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
                      className="zd-design-control-applied h-7 w-full text-[10px]"
                      aria-label="Animation direction"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "normal",
                        "reverse",
                        "alternate",
                        "alternate-reverse",
                      ].map((direction) => (
                        <SelectItem key={direction} value={direction}>
                          {direction}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-muted-fg text-[10px]">Fill</span>
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
                      className="zd-design-control-applied h-7 w-full text-[10px]"
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
              </div>
              <span className="text-muted-fg truncate font-mono text-[9px]">
                {draft.file}
              </span>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="zd-design-motion-grid border-border1 grid h-7 shrink-0 border-b">
        <div className="border-border1 flex items-center gap-1 border-r px-2">
          <Input
            list={motionPropertiesListId}
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
          <datalist id={motionPropertiesListId}>
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
        <div
          className="relative cursor-ew-resize"
          aria-label="Motion time ruler"
          onPointerDown={startTimelineScrub}
        >
          {rulerMarks.map((mark) => (
            <span
              key={mark.time}
              className={cn(
                "text-muted-fg pointer-events-none absolute top-1/2 -translate-y-1/2 font-mono text-[9px]",
                mark.offset === 0
                  ? "translate-x-0"
                  : mark.offset === 100
                    ? "-translate-x-full"
                    : "-translate-x-1/2",
              )}
              style={{ left: `${mark.offset}%` }}
            >
              {mark.time}ms
            </span>
          ))}
          <span
            className="zd-design-motion-playhead pointer-events-none absolute inset-y-0 z-20 w-px"
            style={{ left: `${playhead}%` }}
          >
            <span className="absolute top-0 left-1/2 size-1.5 -translate-x-1/2 rotate-45" />
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="zd-design-motion-grid grid h-8">
          <div className="border-border1 flex min-w-0 items-center gap-1 border-r px-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5 shrink-0"
              aria-label={
                layerExpanded ? "Collapse motion layer" : "Expand motion layer"
              }
              aria-expanded={layerExpanded}
              onClick={() => setLayerExpanded((current) => !current)}
            >
              {layerExpanded ? <ChevronDown /> : <ChevronRight />}
            </Button>
            <Box className="text-muted-fg size-3 shrink-0" />
            <span className="text-fg1 min-w-0 flex-1 truncate text-[10px] font-medium">
              {details.name}
            </span>
            <span className="text-muted-fg font-mono text-[9px]">
              {properties.length}
            </span>
          </div>
          <div
            className="relative cursor-ew-resize"
            data-motion-track
            onPointerDown={startTimelineScrub}
          >
            {rulerMarks.map((mark) => (
              <span
                key={mark.time}
                className="bg-border1 pointer-events-none absolute inset-y-0 w-px opacity-50"
                style={{ left: `${mark.offset}%` }}
              />
            ))}
            <span className="zd-design-motion-range pointer-events-none absolute top-1/2 right-1.5 left-1.5 h-3 -translate-y-1/2 rounded-sm border">
              <span className="absolute inset-y-0 left-0 w-1 rounded-l-sm" />
              <span className="absolute inset-y-0 right-0 w-1 rounded-r-sm" />
            </span>
            <span
              className="zd-design-motion-playhead pointer-events-none absolute inset-y-0 z-20 w-px"
              style={{ left: `${playhead}%` }}
            />
          </div>
        </div>
        {layerExpanded
          ? properties.map((property) => {
              const propertyPoints = points.filter(
                (point) => point.property === property,
              );
              const propertySelected = selectedProperty === property;
              return (
                <div
                  key={property}
                  data-design-motion-track-row=""
                  data-selected={propertySelected ? "true" : undefined}
                  className={cn(
                    "zd-design-motion-grid group/track grid h-8",
                    propertySelected && "zd-design-motion-track-selected",
                  )}
                >
                  <div
                    className="border-border1 group flex min-w-0 items-center border-r pr-1 pl-8"
                    onClick={() => setSelectedProperty(property)}
                  >
                    <Diamond
                      className={cn(
                        "mr-1 size-2.5 shrink-0",
                        propertySelected
                          ? "zd-design-motion-keyframe-icon fill-current"
                          : "text-muted-fg",
                      )}
                    />
                    <span className="text-fg2 min-w-0 flex-1 truncate font-mono text-[10px]">
                      {property}
                    </span>
                    <span className="text-muted-fg mr-0.5 font-mono text-[8px]">
                      {propertyPoints.length}
                    </span>
                    <Tooltip
                      label={`Add ${property} keyframe at ${designMotionTimeAtOffset(playhead, durationMs)}ms`}
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
                      disabled={disabled}
                      onClick={() => removeProperty(property)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div
                    data-motion-track
                    className="hover:bg-bg1-hover relative cursor-ew-resize"
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
                    <span className="bg-border2 pointer-events-none absolute top-1/2 right-0 left-0 h-px opacity-70" />
                    {rulerMarks.map((mark) => (
                      <span
                        key={mark.time}
                        className="bg-border1 pointer-events-none absolute inset-y-0 w-px opacity-60"
                        style={{ left: `${mark.offset}%` }}
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
                            "zd-design-motion-keyframe absolute top-1/2 z-10 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border",
                            selected && "zd-design-motion-keyframe-selected",
                          )}
                          style={{
                            left:
                              point.offset === 0
                                ? 6
                                : point.offset === 100
                                  ? "calc(100% - 6px)"
                                  : `${point.offset}%`,
                          }}
                          aria-label={`${property} keyframe at ${point.offset}% (${designMotionTimeAtOffset(point.offset, durationMs)}ms)`}
                          aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete Backspace"
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
                    <span
                      className="zd-design-motion-playhead pointer-events-none absolute inset-y-0 z-20 w-px"
                      style={{ left: `${playhead}%` }}
                    />
                  </div>
                </div>
              );
            })
          : null}
      </div>

      <div className="border-border1 flex h-10 shrink-0 items-center gap-2 border-t px-3">
        {selectedPoint && selectedValue != null ? (
          <>
            <Diamond className="zd-design-motion-keyframe-icon size-3 fill-current" />
            <span className="text-fg2 max-w-28 truncate font-mono text-[10px]">
              {selectedPoint.property}
            </span>
            <MotionTimeField
              label="Selected keyframe time"
              time={designMotionTimeAtOffset(selectedPoint.offset, durationMs)}
              duration={durationMs}
              className="zd-design-control-applied h-7 w-16 shrink-0 text-right font-mono text-[10px]"
              disabled={disabled}
              onOffsetChange={(nextOffset) =>
                retimePoint(
                  selectedPoint.property,
                  selectedPoint.offset,
                  nextOffset,
                )
              }
            />
            <span className="text-muted-fg font-mono text-[9px]">ms</span>
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
              disabled={disabled}
              onClick={() =>
                removePoint(selectedPoint.property, selectedPoint.offset)
              }
            >
              <Trash2 />
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-fg min-w-0 truncate text-[10px]">
              {properties.length === 0
                ? "No motion on this layer · add a property or choose a preset"
                : "Click to scrub · double-click a track to add · drag a diamond to retime"}
            </span>
            <span className="zd-design-motion-accent-soft rounded px-1.5 py-0.5 text-[9px]">
              {properties.length} {properties.length === 1 ? "track" : "tracks"}
            </span>
          </>
        )}
        {dirty && draftIssue ? (
          <span
            className="text-red-primary min-w-0 truncate text-[10px]"
            title={draftIssue}
            role="status"
          >
            {draftIssue}
          </span>
        ) : null}
        <span className="zd-design-motion-footer-meta text-muted-fg ml-auto shrink-0 font-mono text-[9px]">
          {draft.file} · delay {signedTimeMs(draft.delay)}ms ·{" "}
          {draft.iterations}× · {draft.direction} · {draft.fillMode}
        </span>
      </div>
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
