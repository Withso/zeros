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
  designMotionPlaybackPosition,
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
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { DesignMotionInput } from "./design-motion-input";
import {
  focusDesignPopoverSurface,
  keepDesignPopoverWhileEditing,
} from "./design-inspector-kit";

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
  function MotionTimelineResizeHandle({ disabled }: { disabled: boolean }) {
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
      if (disabled) return;
      const timeline = handleRef.current?.parentElement;
      const root = timeline?.offsetParent ?? timeline?.parentElement;
      if (!(root instanceof HTMLElement)) return;
      rootRef.current = root;
      // A retained hidden timeline suspends its listeners. Restore the current
      // app preference before its first visible measurement after activation.
      preferredHeightRef.current = readMotionHeight();
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
    }, [disabled, publish]);

    return (
      <div
        ref={handleRef}
        role="separator"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Resize motion timeline"
        aria-orientation="horizontal"
        aria-valuemin={MOTION_HEIGHT_MIN}
        aria-valuemax={maximum}
        aria-valuenow={height}
        aria-valuetext={`${height} pixels`}
        className="zd-motion-resize-handle"
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 32 : 8;
          commit(heightRef.current + (event.key === "ArrowUp" ? step : -step));
        }}
        onPointerDown={(event) => {
          if (
            disabled ||
            event.button !== 0 ||
            !event.isPrimary ||
            !rootRef.current
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          cleanupRef.current?.();
          const handle = event.currentTarget;
          const root = rootRef.current;
          const pointerId = event.pointerId;
          const startY = event.clientY;
          const startHeight = heightRef.current;
          handle.focus({ preventScroll: true });
          root.dataset.designMotionResizing = "true";
          const cleanup = () => {
            delete root.dataset.designMotionResizing;
            cleanupRef.current = null;
          };
          cleanupRef.current = beginDesignPointerGesture({
            target: handle,
            pointerId,
            cursor: "row-resize",
            onMove: (next) => {
              publish(startHeight + startY - next.clientY);
            },
            onFinish: () => {
              cleanup();
              commit(heightRef.current);
            },
            onCancel: () => {
              cleanup();
              setHeight(publish(startHeight));
            },
          });
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
  onValidityChange,
}: {
  value: string;
  disabled: boolean;
  compact: boolean;
  onChange: (value: string) => void;
  onValidityChange: (id: string, valid: boolean) => void;
}) {
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
      <DesignMotionInput
        value={value}
        displayValue={preset?.label ?? value}
        aria-label="Animation easing"
        isValid={designMotionEasingIsValid}
        onValidityChange={onValidityChange}
        className="px-2"
        disabled={disabled}
        onCommit={onChange}
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
  draft: DesignMotionTimelineDraft;
  playhead: number;
  playbackTime: number | null;
  selectedPoint: SelectedPoint | null;
  selectedProperty: string | null;
  presetId: DesignMotionPresetId | null;
  layerExpanded: boolean;
  propertyDraft: string;
  persistedMotion: boolean;
}

const motionDraftCache = new Map<string, MotionDraftCacheEntry>();
const MOTION_DRAFT_CACHE_LIMIT = 16;

interface MotionWrite {
  type: "save" | "delete";
  draft: DesignMotionTimelineDraft;
  acknowledged: boolean;
}

type MotionWriteEvent = MotionWrite | { type: "pending"; pending: boolean };

// A write belongs to the node's session, which can outlive one mounted editor
// while the user selects another layer. Keep only pending writes and mounted
// subscribers; completed drafts use the existing bounded retention cache.
const pendingMotionWrites = new Map<string, MotionWrite>();
const motionWriteListeners = new Map<
  string,
  Set<(event: MotionWriteEvent) => void>
>();

function publishMotionWrite(key: string, event: MotionWriteEvent) {
  for (const listener of motionWriteListeners.get(key) ?? []) listener(event);
}

function acknowledgeMotionWrite(key: string, write: MotionWrite) {
  write.acknowledged = true;
  const cached = motionDraftCache.get(key);
  if (cached?.draft === write.draft) {
    motionDraftCache.delete(key);
  } else if (cached) {
    rememberMotionDraft(key, {
      ...cached,
      persistedMotion: write.type === "save",
    });
  }
  publishMotionWrite(key, write);
}

function finishMotionWrite(key: string, write: MotionWrite) {
  if (pendingMotionWrites.get(key) !== write) return;
  pendingMotionWrites.delete(key);
  publishMotionWrite(key, { type: "pending", pending: false });
}

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
  return (
    <span className={cn("zd-field zd-motion-time-field", className)}>
      <DesignMotionInput
        type="number"
        min={0}
        max={duration}
        step={1}
        value={String(time)}
        aria-label={label}
        className="px-2 text-right"
        disabled={disabled}
        isValid={(value) =>
          designMotionTimeInputOffset(value, duration) !== null
        }
        normalize={(value) => {
          const offset = designMotionTimeInputOffset(value, duration);
          return offset === null
            ? value
            : String(designMotionTimeAtOffset(offset, duration));
        }}
        onCommit={(value) => {
          const offset = designMotionTimeInputOffset(value, duration);
          if (offset !== null) onOffsetChange(offset);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!open || disabled || !timeline) return;
    // The settings surface is portaled, so mirror the timeline's container
    // breakpoint there. Container queries handle the header before this read.
    const update = (width: number) => setCompactTiming(width <= 720);
    update(timeline.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [disabled, open]);
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
  const authoredTimingSignature = [
    details?.styles.animationName,
    details?.styles.animationDuration,
    details?.styles.animationDelay,
    details?.styles.animationTimingFunction,
    details?.styles.animationIterationCount,
    details?.styles.animationDirection,
    details?.styles.animationFillMode,
  ].join("\u0000");
  const initializedSessionRef = useRef<string | null>(null);
  const cachedSession = motionDraftCache.get(sessionOwnerKey) ?? null;
  const [draft, setDraftState] = useState<DesignMotionTimelineDraft | null>(
    () =>
      cachedSession?.draft ??
      (details ? initialMotionDraft(details, definitions, ownerKey) : null),
  );
  // A field's blur can commit during the pointerdown that begins a gesture.
  // Capture that accepted draft immediately, before React's next render.
  const draftRef = useRef(draft);
  const setDraft = useCallback(
    (update: React.SetStateAction<DesignMotionTimelineDraft | null>) => {
      const next =
        typeof update === "function" ? update(draftRef.current) : update;
      draftRef.current = next;
      setDraftState(next);
    },
    [],
  );
  const [playhead, setPlayheadState] = useState(cachedSession?.playhead ?? 0);
  const playheadRef = useRef(playhead);
  const playbackTimeRef = useRef<number | null>(
    cachedSession?.playbackTime ?? null,
  );
  const setPlayhead = useCallback((offset: number) => {
    // An explicit seek chooses an effect-local time; pause/resume retains the
    // elapsed loop time separately so alternate playback cannot change phase.
    playbackTimeRef.current = null;
    playheadRef.current = offset;
    setPlayheadState(offset);
  }, []);
  const [selectedPoint, setSelectedPointState] = useState<SelectedPoint | null>(
    cachedSession?.selectedPoint ?? null,
  );
  const selectedPointRef = useRef(selectedPoint);
  const setSelectedPoint = useCallback(
    (update: React.SetStateAction<SelectedPoint | null>) => {
      const next =
        typeof update === "function" ? update(selectedPointRef.current) : update;
      selectedPointRef.current = next;
      setSelectedPointState(next);
    },
    [],
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
  const [dirty, setDirtyState] = useState(cachedSession !== null);
  const dirtyRef = useRef(dirty);
  const setDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);
  const [persistedMotion, setPersistedMotion] = useState(
    () =>
      cachedSession?.persistedMotion ??
      (details ? animationName(details) !== null : false),
  );
  const [saving, setSaving] = useState(() =>
    pendingMotionWrites.has(sessionOwnerKey),
  );
  const [playing, setPlaying] = useState(false);
  const [invalidInputs, setInvalidInputs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onValidityChange = useCallback((id: string, valid: boolean) => {
    setInvalidInputs((current) => {
      if (current.has(id) === !valid) return current;
      const next = new Set(current);
      if (valid) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  playheadRef.current = playhead;
  const playOriginRef = useRef<{ time: number; offset: number } | null>(null);
  const playToggleIntentRef = useRef<boolean | null>(null);
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
  const focusPointRef = useRef(false);
  const motionDraftSessionRef = useRef<MotionDraftCacheEntry | null>(null);
  motionDraftSessionRef.current = draft
    ? {
        draft,
        playhead,
        playbackTime: playbackTimeRef.current,
        selectedPoint,
        selectedProperty,
        presetId,
        layerExpanded,
        propertyDraft,
        persistedMotion,
      }
    : null;
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

  const clearMotionDraft = useCallback(() => {
    const ownerDetails = detailsRef.current;
    setDraft(ownerDetails ? emptyMotionDraft(ownerDetails, ownerKey) : null);
    setPlayhead(0);
    setSelectedPoint(null);
    setSelectedProperty(null);
    setPresetId(null);
    setDirty(false);
    setPropertyDraft("");
  }, [ownerKey, setDirty, setDraft, setPlayhead, setSelectedPoint]);

  useLayoutEffect(() => {
    const listener = (event: MotionWriteEvent) => {
      if (event.type === "pending") {
        setSaving(event.pending);
        return;
      }
      setPersistedMotion(event.type === "save");
      // Clean remounts and source refreshes can replace the draft object.
      // Only accepted local edits can outlive this acknowledgement.
      const hasNewerEdits =
        dirtyRef.current && draftRef.current !== event.draft;
      if (event.type === "save" || hasNewerEdits) {
        setDirty(hasNewerEdits);
        return;
      }
      clearMotionDraft();
    };
    const listeners = motionWriteListeners.get(sessionOwnerKey) ?? new Set();
    listeners.add(listener);
    motionWriteListeners.set(sessionOwnerKey, listeners);
    setSaving(pendingMotionWrites.has(sessionOwnerKey));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) motionWriteListeners.delete(sessionOwnerKey);
    };
  }, [clearMotionDraft, sessionOwnerKey, setDirty]);

  useLayoutEffect(() => {
    if (!focusPointRef.current) return;
    focusPointRef.current = false;
    const point =
      selectedPoint &&
      timelineRef.current?.querySelector<HTMLButtonElement>(
        `[data-motion-property="${CSS.escape(selectedPoint.property)}"][data-motion-offset="${selectedPoint.offset}"]`,
      );
    (point || timelineRef.current)?.focus({ preventScroll: true });
  }, [selectedPoint]);

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
    const sameSession = initializedSessionRef.current === sessionOwnerKey;
    initializedSessionRef.current = sessionOwnerKey;
    // Source refreshes include definitions for every node in the document.
    // They can update a clean editor, but cannot replace this node's unsaved
    // work. The directory/frame/node owner already fences draft restoration.
    if (sameSession && dirtyRef.current) return;
    const cached = motionDraftCache.get(sessionOwnerKey);
    if (cached) {
      motionDraftCache.delete(sessionOwnerKey);
      setDraft(cached.draft);
      setPlayhead(cached.playhead);
      playbackTimeRef.current = cached.playbackTime;
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
  }, [
    authoredTimingSignature,
    definitionsSignature,
    motionOwner,
    ownerKey,
    sessionOwnerKey,
    setDirty,
    setDraft,
    setPlayhead,
    setSelectedPoint,
  ]);

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
    if (!open || disabled || playing) return;
    if (!draft || !validMotionDraft(draft)) {
      clearActivePreview();
      return;
    }
    queuePreview(
      draft,
      playbackTimeRef.current ?? (playhead / 100) * durationMs,
      false,
    );
  }, [
    clearActivePreview,
    draft,
    disabled,
    durationMs,
    open,
    playhead,
    playing,
    queuePreview,
  ]);

  useEffect(() => {
    if (!open || disabled || !draft || !playing || !validMotionDraft(draft))
      return;
    const startingTime =
      playbackTimeRef.current ?? (playheadRef.current / 100) * durationMs;
    queuePreview(draft, startingTime, true);
    const origin = {
      time: performance.now(),
      offset: startingTime,
    };
    playOriginRef.current = origin;
    let animationFrame = 0;
    const tick = (time: number) => {
      const elapsed = time - origin.time;
      const absoluteTime = origin.offset + elapsed;
      const position = designMotionPlaybackPosition(
        absoluteTime,
        durationMs,
        iterationCount,
        draft.direction,
      );
      playbackTimeRef.current = position.elapsed;
      playheadRef.current = position.offset;
      setPlayheadState(position.offset);
      if (position.finished) {
        setPlaying(false);
        return;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      playOriginRef.current = null;
    };
  }, [
    disabled,
    draft,
    durationMs,
    iterationCount,
    open,
    playing,
    queuePreview,
  ]);

  useEffect(() => {
    if (open && !disabled) return;
    activePointerCleanupRef.current?.();
    setPlaying(false);
    clearActivePreview();
  }, [clearActivePreview, disabled, open]);

  useEffect(
    () => () => {
      activePointerCleanupRef.current?.();
      activePointerCleanupRef.current = null;
      const cachedDraft = motionDraftSessionRef.current;
      if (dirtyRef.current && cachedDraft && draftRef.current) {
        rememberMotionDraft(sessionOwnerKeyRef.current, {
          ...cachedDraft,
          draft: draftRef.current,
          playhead: playheadRef.current,
          playbackTime: playbackTimeRef.current,
          selectedPoint: selectedPointRef.current,
        });
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
      setDraft((current) => {
        if (!current) return current;
        const next = mutate(current);
        const elapsed = playbackTimeRef.current;
        if (elapsed !== null) {
          const duration = designDurationMs(next.duration);
          // Settings and values edit the current pose, not the seek position.
          // Preserve completed loops and fractional progress when duration
          // changes, then settle within a newly shortened iteration count.
          const position = designMotionPlaybackPosition(
            (elapsed / designDurationMs(current.duration)) * duration,
            duration,
            designMotionIterationCount(next.iterations) ?? 1,
            next.direction,
          );
          playbackTimeRef.current = position.elapsed;
          playheadRef.current = position.offset;
          setPlayheadState(position.offset);
        }
        return next;
      });
      setDirty(true);
    },
    [setDirty, setDraft],
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
    [mutateDraft, setPlayhead, setSelectedPoint],
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
    const requestedProperty = propertyRequest.property.trim();
    const property = requestedProperty.startsWith("--")
      ? requestedProperty
      : requestedProperty.toLowerCase();
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
  }, [
    details,
    mutateDraft,
    onPropertyRequestHandled,
    open,
    propertyRequest,
    setPlayhead,
    setSelectedPoint,
  ]);

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
  }, [onSeekRequestHandled, open, seekRequest, setPlayhead]);

  const addProperty = useCallback(() => {
    if (!details || !draft) return;
    const requestedProperty = propertyDraft.trim();
    const property = requestedProperty.startsWith("--")
      ? requestedProperty
      : requestedProperty.toLowerCase();
    if (!/^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      setPropertyInvalid(true);
      return;
    }
    setPropertyInvalid(false);
    const existing = points.filter((point) => point.property === property);
    if (existing.length > 0) {
      const nearest = existing.reduce((closest, point) =>
        Math.abs(point.offset - playheadRef.current) <
        Math.abs(closest.offset - playheadRef.current)
          ? point
          : closest,
      );
      setSelectedProperty(property);
      setSelectedPoint({ property, offset: nearest.offset });
      setLayerExpanded(true);
      setPropertyDraft("");
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
    setPropertyDraft("");
  }, [details, draft, mutateDraft, points, propertyDraft, setSelectedPoint]);

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
    [details, draft, mutateDraft, playhead, points, setSelectedPoint],
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
    [mutateDraft, setSelectedPoint],
  );

  const removePoint = useCallback(
    (property: string, offset: number, focus = false) => {
      mutateDraft((current) => ({
        ...current,
        keyframes: removeDesignMotionPoint(current.keyframes, property, offset),
      }));
      const remaining = points.filter(
        (point) => point.property === property && point.offset !== offset,
      );
      const next =
        remaining.find((point) => point.offset > offset) ?? remaining.at(-1);
      focusPointRef.current = focus;
      setSelectedPoint(next ? { property, offset: next.offset } : null);
    },
    [mutateDraft, points, setSelectedPoint],
  );

  const retimePoint = useCallback(
    (property: string, offset: number, nextOffset: number, focus = false) => {
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
      focusPointRef.current = focus;
      setSelectedPoint({ property, offset: nextOffset });
      setSelectedProperty(property);
    },
    [mutateDraft, setPlayhead, setSelectedPoint],
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
    [setPlayhead],
  );

  const startTimelineScrub = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      activePointerCleanupRef.current?.();
      const track = event.currentTarget;
      // Lanes are not focusable. Settle a focused field before capturing the
      // seek baseline so its eventual blur cannot undo this gesture.
      timelineRef.current?.focus({ preventScroll: true });
      const startPlayhead = playheadRef.current;
      const startPlaybackTime = playbackTimeRef.current;
      activePointerCleanupRef.current = beginDesignPointerGesture({
        target: track,
        pointerId: event.pointerId,
        cursor: "ew-resize",
        onMove: (pointerEvent) =>
          setPlayheadFromClientX(pointerEvent.clientX, track),
        onFinish: () => {
          activePointerCleanupRef.current = null;
        },
        onCancel: () => {
          activePointerCleanupRef.current = null;
          setPlayhead(startPlayhead);
          playbackTimeRef.current = startPlaybackTime;
        },
      });
      setPlayheadFromClientX(event.clientX, track);
    },
    [disabled, setPlayhead, setPlayheadFromClientX],
  );

  const startPointDrag = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      property: string,
      pressedOffset: number,
    ) => {
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      activePointerCleanupRef.current?.();
      pointDragMovedRef.current = false;
      const track = event.currentTarget.closest<HTMLElement>(
        "[data-motion-track]",
      );
      if (!track) return;
      const selectedBeforeFocus = selectedPointRef.current;
      const draftBeforeFocus = draftRef.current;
      event.currentTarget.focus({ preventScroll: true });
      const baseline = draftRef.current;
      if (!baseline) return;
      // Focusing the diamond can commit its time field and replace the point.
      // Follow that accepted offset only when this is the same selected point.
      const selectedAfterFocus = selectedPointRef.current;
      const initialOffset =
        selectedBeforeFocus?.property === property &&
        selectedBeforeFocus.offset === pressedOffset &&
        selectedAfterFocus?.property === property
          ? selectedAfterFocus.offset
          : pressedOffset;
      const baselineDirty = dirtyRef.current;
      const baselinePreset = baseline === draftBeforeFocus ? presetId : null;
      const pendingWrite = pendingMotionWrites.get(sessionOwnerKey);
      const startX = event.clientX;
      const bounds = track.getBoundingClientRect();
      if (bounds.width <= 0) return;
      let lastOffset = initialOffset;
      const restoreBaseline = () => {
        // A reply can settle while the gesture temporarily differs from its
        // baseline. Restoring that baseline must also restore its saved/deleted
        // status, while preserving accepted edits made after the captured write.
        const baselineWasAcknowledged =
          pendingWrite?.acknowledged &&
          (!baselineDirty || baseline === pendingWrite.draft);
        focusPointRef.current = true;
        if (baselineWasAcknowledged && pendingWrite.type === "delete") {
          clearMotionDraft();
          return;
        }
        setDraft(baseline);
        setDirty(baselineWasAcknowledged ? false : baselineDirty);
        setPresetId(baselinePreset);
        setPlayhead(initialOffset);
        setSelectedPoint({ property, offset: initialOffset });
        setSelectedProperty(property);
      };
      const move = (pointerEvent: PointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        if (!pointDragMovedRef.current && Math.abs(delta) < 3) return;
        const nextOffset =
          Math.round(
            Math.min(
              100,
              Math.max(0, initialOffset + (delta / bounds.width) * 100),
            ) * 10,
          ) / 10;
        if (nextOffset === lastOffset) return;
        pointDragMovedRef.current = true;
        lastOffset = nextOffset;
        if (nextOffset === initialOffset) {
          restoreBaseline();
          return;
        }
        // Recompute from the pointerdown snapshot. Incremental moves erase a
        // neighboring point as soon as the pointer crosses its time.
        setDraft({
          ...baseline,
          keyframes: moveDesignMotionPoint(
            baseline.keyframes,
            property,
            initialOffset,
            nextOffset,
          ),
        });
        setPresetId(null);
        setPlayhead(nextOffset);
        focusPointRef.current = true;
        setSelectedPoint({ property, offset: nextOffset });
        setSelectedProperty(property);
        setDirty(true);
      };
      activePointerCleanupRef.current = beginDesignPointerGesture({
        // A retimed point changes its React key; the lane retains capture.
        target: track,
        pointerId: event.pointerId,
        cursor: "ew-resize",
        onMove: move,
        onFinish: () => {
          activePointerCleanupRef.current = null;
        },
        onCancel: () => {
          activePointerCleanupRef.current = null;
          restoreBaseline();
        },
      });
      setPlaying(false);
      setPlayhead(initialOffset);
      focusPointRef.current = true;
      setSelectedPoint({ property, offset: initialOffset });
      setSelectedProperty(property);
    },
    [
      clearMotionDraft,
      disabled,
      presetId,
      sessionOwnerKey,
      setDirty,
      setDraft,
      setPlayhead,
      setSelectedPoint,
    ],
  );

  const save = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (
      !currentDraft ||
      !validMotionDraft(currentDraft) ||
      pendingMotionWrites.has(sessionOwnerKey)
    )
      return;
    const write: MotionWrite = {
      type: "save",
      draft: currentDraft,
      acknowledged: false,
    };
    pendingMotionWrites.set(sessionOwnerKey, write);
    publishMotionWrite(sessionOwnerKey, { type: "pending", pending: true });
    try {
      await onSave(currentDraft);
      acknowledgeMotionWrite(sessionOwnerKey, write);
    } catch (error) {
      toast.error("Couldn't save the motion", {
        description:
          error instanceof Error
            ? error.message
            : "The motion could not be saved.",
      });
    } finally {
      finishMotionWrite(sessionOwnerKey, write);
    }
  }, [onSave, sessionOwnerKey]);

  const deleteMotion = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!details || !currentDraft || pendingMotionWrites.has(sessionOwnerKey))
      return;
    setPlaying(false);
    clearActivePreview();
    const write: MotionWrite = {
      type: "delete",
      draft: currentDraft,
      acknowledged: false,
    };
    pendingMotionWrites.set(sessionOwnerKey, write);
    publishMotionWrite(sessionOwnerKey, { type: "pending", pending: true });
    try {
      if (persistedMotion) await onDeleteMotion();
      acknowledgeMotionWrite(sessionOwnerKey, write);
    } catch (error) {
      toast.error("Couldn't remove the motion", {
        description:
          error instanceof Error
            ? error.message
            : "The motion could not be removed.",
      });
    } finally {
      finishMotionWrite(sessionOwnerKey, write);
    }
  }, [
    clearActivePreview,
    details,
    onDeleteMotion,
    persistedMotion,
    sessionOwnerKey,
  ]);

  const settingsAvailable = open && details !== null && draft !== null;
  useEffect(() => {
    if (!settingsAvailable) setSettingsOpen(false);
  }, [settingsAvailable]);

  if (!open) return null;

  if (!details || !draft) {
    return (
      <section
        ref={timelineRef}
        data-design-controls
        data-design-motion-timeline=""
        className="zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col"
        aria-label="Motion timeline"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MotionTimelineResizeHandle disabled={disabled} />
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
  const durationValue = (value: string) => {
    const candidate = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
      ? `${value.trim()}${durationUnit}`
      : value.trim();
    const milliseconds = designDurationMs(candidate, 0);
    const unit = /ms$/i.test(candidate) ? "ms" : "s";
    return {
      milliseconds,
      value: `${unit === "s" ? milliseconds / 1000 : milliseconds}${unit}`,
    };
  };
  const durationField = (
    <span className="zd-field zd-motion-duration-field">
      <DesignMotionInput
        value={draft.duration.replace(/(?:ms|s)$/i, "")}
        aria-label="Animation duration"
        isValid={(value) => durationValue(value).milliseconds > 0}
        onValidityChange={onValidityChange}
        className="px-2"
        disabled={disabled}
        onCommit={(value) => {
          const duration = durationValue(value).value;
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
      onValidityChange={onValidityChange}
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
      className="zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col"
      aria-label="Motion timeline"
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MotionTimelineResizeHandle disabled={disabled} />
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
              disabled={
                disabled ||
                (!playing &&
                  (invalidInputs.size > 0 || !validMotionDraft(draft)))
              }
              onPointerDown={(event) => {
                if (event.button === 0 && event.isPrimary)
                  playToggleIntentRef.current = playing;
              }}
              onClick={(event) => {
                // Focus settles a field before click and may stop playback.
                // Honor the transport action the pointer originally chose.
                // Keyboard clicks ignore an abandoned pointer press.
                const pause =
                  event.detail > 0 && playToggleIntentRef.current !== null
                    ? playToggleIntentRef.current
                    : playing;
                playToggleIntentRef.current = null;
                if (pause) {
                  setPlaying(false);
                  return;
                }
                const elapsed = playbackTimeRef.current;
                if (
                  elapsed !== null &&
                  Number.isFinite(iterationCount) &&
                  elapsed >= durationMs * iterationCount
                ) {
                  setPlayhead(0);
                } else if (elapsed === null) {
                  setPlayhead(
                    designMotionPlaybackStartOffset(playheadRef.current),
                  );
                }
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
        <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
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
            onOpenAutoFocus={focusDesignPopoverSurface}
            onEscapeKeyDown={keepDesignPopoverWhileEditing}
            onKeyDown={(event) => {
              // Radix's Escape layer index can lag behind the initial focus.
              // Field Escape handlers prevent default when reverting a draft.
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                setSettingsOpen(false);
              }
            }}
          >
            <div className="zd-popover-header">
              <span className="zd-popover-title">Motion settings</span>
            </div>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Name</span>
              <DesignMotionInput
                value={draft.name}
                aria-label="Animation name"
                isValid={(name) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name)}
                onValidityChange={onValidityChange}
                className="zd-field px-2"
                disabled={disabled}
                onCommit={(name) => {
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
              <DesignMotionInput
                value={draft.delay}
                aria-label="Animation delay"
                isValid={(delay) =>
                  /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s)$/i.test(delay.trim())
                }
                onValidityChange={onValidityChange}
                className="zd-field px-2"
                disabled={disabled}
                onCommit={(delay) => {
                  mutateDraft((current) => ({ ...current, delay }));
                }}
              />
            </label>
            <label className="zd-motion-setting">
              <span className="zd-row-label">Loop</span>
              <DesignMotionInput
                value={draft.iterations}
                aria-label="Animation iterations"
                isValid={(iterations) =>
                  (designMotionIterationCount(iterations) ?? 0) > 0
                }
                onValidityChange={onValidityChange}
                className="zd-field px-2"
                disabled={disabled}
                onCommit={(iterations) => {
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
              disabled={
                disabled ||
                saving ||
                !dirty ||
                invalidInputs.size > 0 ||
                draftIssue !== null
              }
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
                              data-motion-property={property}
                              data-motion-offset={point.offset}
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
                                  removePoint(property, point.offset, true);
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
                                retimePoint(
                                  property,
                                  point.offset,
                                  nextOffset,
                                  true,
                                );
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
            key={`time:${selectedPoint.property}:${selectedPoint.offset}`}
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
          <DesignMotionInput
            key={`value:${selectedPoint.property}:${selectedPoint.offset}`}
            value={selectedValue}
            aria-label={`${selectedPoint.property} keyframe value`}
            isValid={(value) => value.trim().length > 0}
            onValidityChange={onValidityChange}
            className="zd-field zd-motion-keyframe-value px-2"
            disabled={disabled}
            onCommit={(value) => {
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
  const position = designMotionPlaybackPosition(
    currentTime,
    duration,
    designMotionIterationCount(draft.iterations) ?? 1,
    draft.direction,
  );
  return {
    keyframes: draft.keyframes.map((keyframe) => ({
      offset: keyframe.offset,
      styles: { ...keyframe.styles },
    })),
    duration,
    delay,
    easing: draft.easing,
    iterations: position.iterations,
    direction: position.direction,
    fill: draft.fillMode,
    currentTime: designMotionPreviewCurrentTime(
      position.cycleTime,
      duration,
      delay,
    ),
    playing,
  } as const;
}
