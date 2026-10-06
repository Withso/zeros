// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import {
  AlertTriangle,
  Diamond,
  Download,
  ExternalLink,
  File,
  Frame as FrameIcon,
  Image as ImageIcon,
  Layers,
  Spline,
  Type,
} from "lucide-react";
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
  DESIGN_FRAME_COORDINATE_LIMIT,
  DESIGN_FRAME_MAX_SIZE,
  DESIGN_TRANSACTION_MAX_OPERATIONS,
  type DesignOperation,
} from "@zeros/design-core";
import type { DesignStyleProvenance } from "@zeros/design-web";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { exportDesignPng } from "../../platform/design";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { openDesignFramePreview } from "../../platform/bridge/design-context-bridge";
import { shellOpenUrl } from "../../platform/app";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { workspacePreviewAvailable } from "../../platform/cloud-workspace-access";
import { cloudWorkspaceCanEdit, useCloudWorkspaceCanEdit } from "../../state/use-cloud-workspace-can-edit";
import { useWorkspaceStore, workbenchScopeForFolder } from "../../state/workspace-store";
import { defaultScopeFor } from "../../shell/workbench/tab-model";
import { planBrowserOpen } from "../../shell/workbench/use-open-browser";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { isInternalFeatureActive, useInternalFeatureActive } from "../settings/internal-features";
import { cn } from "../../shared/ui/cn";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { isEditableHotkeyTarget } from "../../shell/editable-target";
import {
  designAutoLayoutUpdates,
  designFrameRootFixedStyles,
  designHugFrameSize,
  designSizingMode,
  designSizingStyles,
  hasDesignIntrinsicSize,
} from "./design-auto-layout-values";
import { normalizeDesignCanvasBackground } from "./design-canvas-background";
import { DesignCanvasBackgroundEditor } from "./design-canvas-background-editor";
import { DesignPagePicker } from "./design-page-picker";
import { restoreDesignPageHistorySelection } from "./state/design-page-history";
import { DesignComputedCssEditor } from "./design-computed-css-editor";
import {
  InspectorGlyph,
  InspectorSection,
  InspectorSelect,
} from "./design-inspector-kit";
import {
  designFrameLayerLabel,
  designRuntimeLayerLabel,
} from "./design-layer-label";
import {
  designLayoutChildUpdates,
  designLayoutChildrenSummary,
  designLayoutResizedFrame,
  isDesignLayoutChildAction,
} from "./design-layout-children";
import {
  designLayoutActionStyles,
  designLayoutActionUpdates,
  designLayoutFieldValue,
  roundDesignLayoutValue,
  type DesignLayoutAction,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import { blockingDesignLintReason } from "./design-lint-summary";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { DesignStyleEditor } from "./design-style-editor";
import {
  clampDesignStyleFieldValue,
  designStyleFieldValue,
  designStylePropertyAffectsLayout,
  designStyleUnitOptions,
  isDesignRuntimeStylePropertyAuthored,
  normalizeDesignStyleFieldInput,
  parseDesignStyleNumericParts,
  readDesignComputedStyle,
  replaceDesignStyleNumericUnit,
  resolveDesignNumericExpression,
  scrubDesignNumericValue,
  withDesignPositionContext,
} from "./design-style-values";
import { dispatchDesignWorkspaceShortcut } from "./design-workspace-shortcuts";
import {
  publishDesignLivePreviewStyles,
  useDesignLivePreviewValue,
} from "./state/design-live-preview";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import {
  captureDesignRuntimeScreenshot,
  clearDesignNodeStylePreviewTransient,
  inspectDesignNodeStyleProvenance,
  previewDesignNodeGeometry,
} from "./state/design-selection";
import {
  applyDesignEditCached,
  applyDesignHistoryCached,
  designWorkspaceSnapshotCache,
  saveDesigns,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
} from "./state/design-workspace-cache";
import {
  DEFAULT_DESIGN_WORKSPACE_VIEW,
  DESIGN_MAX_ZOOM,
  DESIGN_MIN_ZOOM,
  designWorkspaceView,
  captureDesignPageOwner,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";
import { useDesignFoundation } from "./state/use-design-foundation";

import { errorMessage } from "./design-workspace-error";
import {
  designInspectorPreviewOverlay,
  frameGeometry,
  paintDesignFrameGeometryPreview,
  paintDesignInlineGapHandles,
  paintDesignInspectorPreviewDetails,
  paintedDesignFrameGeometry,
} from "./design-workspace-overlays";
import { type DesignInspectorProps } from "./design-workspace-types";
import { PanelHeader } from "@/renderer/shared/ui/primitives/panel-header";


/** What canvas metadata can store; frame fields settle inside it. */
const DESIGN_FRAME_SIZE_RANGE = { min: 1, max: DESIGN_FRAME_MAX_SIZE };
const DESIGN_FRAME_POSITION_RANGE = {
  min: -DESIGN_FRAME_COORDINATE_LIMIT,
  max: DESIGN_FRAME_COORDINATE_LIMIT,
};

function designFrameSizeValue(value: number): number {
  return Math.min(DESIGN_FRAME_MAX_SIZE, Math.max(1, Math.round(value)));
}

interface InspectorProvenanceState {
  ownerKey: string;
  property: string;
  loading: boolean;
  value: DesignStyleProvenance | null;
  error: string | null;
}

interface InspectorEditFieldProps {
  numericValue?: string;
  icon?: DesignLayoutFieldOptions["icon"];
  shortLabel?: string;
  /** Static trailing unit text for unit-less presentations ("°", "%", "ms"). */
  suffix?: string;
  percentage?: boolean;
  label: string;
  value: string | number;
  applied?: boolean;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
  styleProperty?: string;
  whole?: boolean;
  /** Bounds a plain numeric value: typed, stepped or scrubbed input settles
   * on the nearest allowed value instead of failing on commit. */
  range?: { min: number; max: number };
  compact?: boolean;
  motion?: {
    modeActive: boolean;
    trackActive: boolean;
    onAddKeyframe: () => void;
  };
  onInspect?: () => void;
  onPreview?: (value: string) => Promise<unknown> | void;
  onCancelPreview?: () => Promise<unknown> | void;
  onCommit: (value: string) => Promise<unknown>;
}

interface InspectorFieldPresentation {
  text: string;
  unit: string | null;
}

function inspectorFieldPresentation(
  property: string | undefined,
  value: string,
  whole = false,
): InspectorFieldPresentation {
  if (whole) value = roundDesignLayoutValue(value);
  if (!property || value.trim() === "") return { text: value, unit: null };
  const numeric = parseDesignStyleNumericParts(value);
  if (!numeric) return { text: value, unit: null };
  const units = designStyleUnitOptions(property, numeric.unit);
  if (units.length === 0) return { text: value, unit: null };
  return {
    text: numeric.text,
    unit: numeric.unit || units[0] || null,
  };
}

function inspectorFieldDraftWithUnit(text: string, unit: string): string {
  const candidate = text.trim();
  // A leading plus and x/operator notation are equations against the value
  // captured on focus. Leave them unitless until commit resolves the equation.
  if (/^\+/.test(candidate) || /[xX()*/^]/.test(candidate)) return text;
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate)) {
    return `${candidate}${unit}`;
  }
  return text;
}

function InspectorEditField({
  numericValue,
  icon,
  shortLabel,
  suffix: fieldSuffix,
  percentage,
  label,
  value,
  applied = false,
  disabled = false,
  hint,
  placeholder,
  styleProperty,
  whole = false,
  range,
  compact = false,
  motion,
  onInspect,
  onPreview,
  onCancelPreview,
  onCommit,
}: InspectorEditFieldProps) {
  const id = useId();
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baselineRef = useRef(String(value));
  /** The value shown when this field took focus. */
  const focusValueRef = useRef(String(value));
  const skipCommitRef = useRef(false);
  const unitMenuOpenRef = useRef(false);
  const commitIntentRef = useRef(0);
  const scrubCancelRef = useRef<(() => void) | null>(null);
  const scrubRef = useRef<{
    pointerId: number;
    originX: number;
    startX: number;
    startValue: string;
    initialDraft: string;
    latestValue: string;
    distance: number;
    moved: boolean;
  } | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const previewDirtyRef = useRef(false);
  const cancelPreviewRef = useRef(onCancelPreview);
  cancelPreviewRef.current = onCancelPreview;
  const [draft, setDraft] = useState(String(value));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [presentation, setPresentation] = useState<InspectorFieldPresentation>(
    () => inspectorFieldPresentation(styleProperty, String(value), whole),
  );

  const setPresentedDraft = useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      setPresentation(inspectorFieldPresentation(styleProperty, next, whole));
    },
    [styleProperty, whole],
  );
  const unitOptions = presentation.unit
    ? designStyleUnitOptions(styleProperty ?? "", presentation.unit)
    : [];

  const withinRange = (next: string) => {
    if (styleProperty) next = clampDesignStyleFieldValue(styleProperty, next);
    const number = Number(next);
    if (!range || next.trim() === "" || !Number.isFinite(number)) return next;
    const bounded = Math.min(range.max, Math.max(range.min, number));
    return bounded === number ? next : String(bounded);
  };
  const resolveDraft = (next: string, baseline: string) => {
    const resolved = styleProperty
      ? normalizeDesignStyleFieldInput(styleProperty, next, baseline)
      : resolveDesignNumericExpression(next, baseline);
    return withinRange(whole ? roundDesignLayoutValue(resolved) : resolved);
  };

  // Finish an unfocused incoming value in this commit. A passive state update
  // can land after the next focus/select-all and overwrite that user's draft.
  useLayoutEffect(() => {
    if (document.activeElement === inputRef.current || scrubRef.current) return;
    const next = String(value);
    baselineRef.current = next;
    setPresentedDraft(next);
  }, [setPresentedDraft, value]);

  useEffect(
    () => () => {
      scrubCancelRef.current?.();
      if (previewFrameRef.current !== null) {
        window.cancelAnimationFrame(previewFrameRef.current);
      }
      if (previewDirtyRef.current) {
        previewDirtyRef.current = false;
        void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
      }
    },
    [],
  );

  useEffect(() => {
    if (disabled) scrubCancelRef.current?.();
  }, [disabled]);

  const cancelPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (!previewDirtyRef.current) return;
    previewDirtyRef.current = false;
    void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
  };

  const finishCommittedPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    // Preserve the last exact live scalar until the authoritative source
    // generation arrives. Clearing here causes a visible value snap-back.
    previewDirtyRef.current = false;
  };

  const preview = (next: string) => {
    if (!onPreview) return;
    previewDirtyRef.current = true;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      void Promise.resolve(onPreview(next)).catch(() => {});
    });
  };

  /** A value published while this field was focused but untouched is held
   * back so it cannot disturb focus or the selected text. Adopt it once the
   * field settles; otherwise a later untouched blur would write the stale
   * draft back over it. */
  const adoptIncomingValue = () => {
    const latest = String(value);
    if (latest === focusValueRef.current) return;
    focusValueRef.current = latest;
    baselineRef.current = latest;
    setPresentedDraft(latest);
  };

  const commit = async (requestedDraft = draftRef.current) => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      cancelPreview();
      return;
    }
    const baseline = baselineRef.current;
    if (requestedDraft === baseline) {
      cancelPreview();
      adoptIncomingValue();
      return;
    }
    const resolvedDraft = resolveDraft(requestedDraft, baseline);
    if (resolvedDraft !== requestedDraft) setPresentedDraft(resolvedDraft);
    if (resolvedDraft === baseline) {
      cancelPreview();
      adoptIncomingValue();
      return;
    }
    // A committed preview belongs to the save, not to a later editable draft.
    // Flush the newest value immediately and release the scrub's pending frame;
    // Escape in the next draft must not roll this accepted intent back.
    finishCommittedPreview();
    if (onPreview)
      void Promise.resolve(onPreview(resolvedDraft)).catch(() => {});
    // Enter, unit-menu close and blur may all reach this field before a save
    // replies. Advance the local baseline now so that intent is registered once.
    baselineRef.current = resolvedDraft;
    const intent = ++commitIntentRef.current;
    try {
      await onCommit(resolvedDraft);
    } catch (fieldError) {
      if (commitIntentRef.current !== intent) return;
      baselineRef.current = baseline;
      if (document.activeElement !== inputRef.current && !scrubRef.current)
        setPresentedDraft(baseline);
      if (!previewDirtyRef.current)
        void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
      toast.error(`Couldn't update ${label.toLowerCase()}`, {
        description: errorMessage(fieldError),
      });
    }
  };

  const glyph =
    icon ?? (compact && label === "Rotation" ? ("rotation" as const) : null);
  const labelText = glyph ? null : (shortLabel ?? label);
  // Letters and glyphs sit in one square slot so values start on one line;
  // words size to their text instead of wrapping inside a compact field.
  const letterLabel = glyph !== null || (labelText?.length ?? 0) <= 2;
  const suffix =
    fieldSuffix ??
    (compact && styleProperty === "rotate"
      ? "°"
      : compact && percentage
        ? "%"
        : null);
  const showUnit = !compact && Boolean(presentation.unit) && unitOptions.length > 0;
  const motionPersistent = Boolean(motion?.trackActive);

  return (
    <div ref={fieldRef} className="group/design-field relative min-w-0">
      <div
        data-design-inspector-field=""
        data-design-applied={applied ? "" : undefined}
        data-design-style-property={styleProperty}
        data-design-layout-field={compact ? "" : undefined}
        data-design-motion-field={motion ? "" : undefined}
        data-design-motion-tracked={motionPersistent ? "" : undefined}
        className="zd-field zd-inspector-field relative overflow-hidden"
      >
        <button
          type="button"
          disabled={disabled}
          tabIndex={-1}
          className={cn(
            "zd-field-label zd-field-scrub cursor-ew-resize focus-visible:outline-none disabled:cursor-default",
            letterLabel ? "w-6" : "pr-1.5 pl-2 whitespace-nowrap",
          )}
          aria-label={`Scrub ${label}`}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            scrubCancelRef.current?.();
            const resolvedDraft = resolveDraft(
              draftRef.current,
              baselineRef.current,
            );
            const startValue = parseDesignStyleNumericParts(resolvedDraft)
              ? resolvedDraft
              : (numericValue ?? resolvedDraft);
            if (scrubDesignNumericValue(startValue, 0) === null) {
              onInspect?.();
              return;
            }
            event.preventDefault();
            const scrub = {
              pointerId: event.pointerId,
              originX: event.clientX,
              startX: event.clientX,
              startValue,
              initialDraft: draftRef.current,
              latestValue: startValue,
              distance: 0,
              moved: false,
            };
            scrubRef.current = scrub;
            const restore = () => {
              scrubRef.current = null;
              scrubCancelRef.current = null;
              setPresentedDraft(scrub.initialDraft);
              cancelPreview();
            };
            scrubCancelRef.current = beginDesignPointerGesture({
              target: event.currentTarget,
              pointerId: event.pointerId,
              cursor: "ew-resize",
              onMove: (pointerEvent) => {
                if (
                  !scrub.moved &&
                  Math.abs(pointerEvent.clientX - scrub.originX) < 3
                ) return;
                scrub.moved = true;
                const multiplier =
                  !whole && pointerEvent.altKey
                    ? 0.1
                    : pointerEvent.shiftKey ? 10 : 1;
                scrub.distance +=
                  (pointerEvent.clientX - scrub.startX) * multiplier;
                scrub.startX = pointerEvent.clientX;
                const next = scrubDesignNumericValue(
                  scrub.startValue,
                  scrub.distance,
                );
                if (next === null) return;
                const resolved = withinRange(
                  whole ? roundDesignLayoutValue(next) : next,
                );
                if (resolved === scrub.latestValue) return;
                scrub.latestValue = resolved;
                setPresentedDraft(resolved);
                preview(resolved);
              },
              onFinish: () => {
                // Merely pressing a label must not turn Hug/Fill/auto into a
                // fixed number. Returning to the start is also a no-op.
                if (
                  !scrub.moved ||
                  scrub.distance === 0 ||
                  scrub.latestValue === scrub.startValue
                ) {
                  restore();
                  return;
                }
                scrubRef.current = null;
                scrubCancelRef.current = null;
                void commit(scrub.latestValue);
              },
              onCancel: restore,
            });
            onInspect?.();
          }}
        >
          <Label htmlFor={id} className="pointer-events-none text-inherit">
            {glyph ? <InspectorGlyph name={glyph} /> : labelText}
          </Label>
        </button>
        <Input
          ref={inputRef}
          id={id}
          aria-label={label}
          value={presentation.text}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent py-0 pl-0 font-sans text-xs shadow-none focus-visible:border-transparent",
            applied ? "text-fg1" : "text-fg2",
            suffix || showUnit || hint ? "pr-1" : "pr-2",
          )}
          onFocus={() => {
            baselineRef.current = String(value);
            focusValueRef.current = String(value);
            onInspect?.();
          }}
          onChange={(event) => {
            // Deliberately local. A canvas write per keystroke reflowed the
            // document on every character — and on a backspace it removed the
            // declaration outright before the next digit put it back.
            const text = event.target.value;
            const pastedNumeric = parseDesignStyleNumericParts(text);
            if (
              styleProperty &&
              pastedNumeric?.unit &&
              designStyleUnitOptions(
                styleProperty,
                pastedNumeric.unit,
              ).includes(pastedNumeric.unit)
            ) {
              setPresentedDraft(text);
              return;
            }
            if (
              presentation.unit &&
              (text.trim() === "" || /^[\d.+\-*/^xX()\s]*$/.test(text))
            ) {
              const next = inspectorFieldDraftWithUnit(text, presentation.unit);
              draftRef.current = next;
              setDraft(next);
              setPresentation({ text, unit: presentation.unit });
              return;
            }
            setPresentedDraft(text);
          }}
          onBlur={(event) => {
            if (
              unitMenuOpenRef.current ||
              fieldRef.current?.contains(event.relatedTarget)
            ) {
              return;
            }
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const normalized = resolveDraft(draft, baselineRef.current);
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const multiplier =
                !whole && event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
              const next = scrubDesignNumericValue(
                parseDesignStyleNumericParts(normalized)
                  ? normalized
                  : (numericValue ?? normalized),
                direction * multiplier,
              );
              if (next !== null) {
                event.preventDefault();
                setPresentedDraft(withinRange(next));
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              skipCommitRef.current = true;
              // A preceding commit can publish its authoritative computed
              // value while this input is focused. The synchronization effect
              // deliberately leaves an active draft alone, so the focus-time
              // baseline may now be stale (notably after removing an authored
              // declaration). Escape must restore the latest exact-key value
              // from props; once we blur there may be no further value change
              // to trigger the effect again.
              const restored = String(value);
              baselineRef.current = restored;
              setPresentedDraft(restored);
              cancelPreview();
              event.currentTarget.blur();
            }
          }}
        />
        {suffix ? <span className="zd-field-suffix">{suffix}</span> : null}
        {showUnit ? (
          <Select
            value={presentation.unit!}
            disabled={disabled}
            onOpenChange={(open) => {
              if (open) {
                unitMenuOpenRef.current = true;
              } else if (unitMenuOpenRef.current) {
                unitMenuOpenRef.current = false;
                void commit();
              }
            }}
            onValueChange={(unit) => {
              unitMenuOpenRef.current = false;
              const resolved = resolveDraft(
                draftRef.current,
                baselineRef.current,
              );
              const next = replaceDesignStyleNumericUnit(resolved, unit);
              if (next === null) return;
              setPresentedDraft(next);
              void commit(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="zd-design-unit-trigger h-full w-auto shrink-0 gap-0 rounded-none border-0 bg-transparent py-0 pr-2 pl-1 text-3xxs shadow-none [&>svg]:hidden"
              aria-label={`Unit for ${label}`}
              onPointerDown={() => {
                unitMenuOpenRef.current = true;
              }}
              onBlur={(event) => {
                if (
                  unitMenuOpenRef.current ||
                  fieldRef.current?.contains(event.relatedTarget)
                ) {
                  return;
                }
                void commit();
              }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-20">
              {unitOptions.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {unit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {hint ? (
          <Tooltip label={hint}>
            <span
              className="bg-highlighted-bright mr-2 size-1.5 shrink-0 rounded-full"
              aria-label={hint}
              role="img"
            />
          </Tooltip>
        ) : null}
        {motion ? (
          <div
            className={cn(
              "zd-field-motion absolute inset-y-0 right-0 flex items-center pr-0.5 pl-3",
              motionPersistent && "zd-field-motion-active",
            )}
          >
            <Tooltip
              label={
                motion.trackActive
                  ? `Add ${label} keyframe at the playhead`
                  : `Animate ${label}`
              }
            >
              <button
                type="button"
                disabled={disabled}
                className="zd-field-keyframe"
                aria-label={
                  motion.trackActive
                    ? `Add ${label} keyframe at the playhead`
                    : `Animate ${label}`
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={motion.onAddKeyframe}
              >
                <Diamond
                  className={cn(
                    "size-3",
                    motion.trackActive && "fill-current",
                  )}
                />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const InspectorStyleField = React.memo(function InspectorStyleField({
  workspaceId,
  frame,
  nodeId,
  label,
  property,
  value,
  computedValue,
  options,
  details,
  onLayoutAction,
  onPreviewLayoutAction,
  disabled,
  applied,
  hint,
  onInspect,
  onPreviewStyles,
  onCancelPreview,
  onCommitStyles,
  motionModeActive,
  motionTrackActive,
  onAddMotionKeyframe,
}: {
  workspaceId: string;
  frame: string;
  nodeId: string;
  label: string;
  property: string;
  value: string;
  computedValue: string;
  options?: DesignLayoutFieldOptions;
  details?: DesignRuntimeNodeDetails;
  onLayoutAction?: (action: DesignLayoutAction) => Promise<void>;
  onPreviewLayoutAction?: (action: DesignLayoutAction) => Promise<void>;
  disabled?: boolean;
  applied: boolean;
  hint?: string;
  onInspect: (property: string, computedValue: string) => void;
  onPreviewStyles: (
    styles: Record<string, string | null>,
  ) => void | Promise<void>;
  onCancelPreview: () => void | Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
  motionModeActive: boolean;
  motionTrackActive: boolean;
  onAddMotionKeyframe: (property: string, value: string) => void;
}) {
  const liveValue = useDesignLivePreviewValue(
    workspaceId,
    frame,
    nodeId,
    property,
  );
  const farEdge =
    property === "left" ? "right" : property === "top" ? "bottom" : property;
  const farLiveValue = useDesignLivePreviewValue(
    workspaceId,
    frame,
    nodeId,
    farEdge,
  );
  let displayedValue =
    liveValue === undefined ? value || computedValue : (liveValue ?? "");
  if (options?.geometry && details) {
    displayedValue = designLayoutFieldValue(details, property);
    if (
      (property === "left" || property === "top") &&
      liveValue === "auto" &&
      typeof farLiveValue === "string"
    ) {
      const difference =
        (parseFloat(readDesignComputedStyle(details.styles, farEdge)) || 0) -
        (parseFloat(farLiveValue) || 0);
      displayedValue = `${(parseFloat(displayedValue) || 0) + difference}px`;
    }
    if (
      typeof liveValue === "string" &&
      Number.isFinite(parseFloat(liveValue))
    ) {
      const baseline =
        parseFloat(readDesignComputedStyle(details.styles, property)) || 0;
      displayedValue = `${(parseFloat(displayedValue) || 0) + parseFloat(liveValue) - baseline}${property === "rotate" ? "deg" : "px"}`;
    }
  }
  const layoutAction = (next: string): DesignLayoutAction => {
    if (next.trim() === "") return { type: "reset", property };
    const number = Number.parseFloat(next);
    if (!Number.isFinite(number)) throw new Error("Enter a finite number.");
    return property === "rotate"
      ? { type: "rotation", value: number }
      : {
          type:
            property === "width" || property === "height" ? "size" : "position",
          axis: property === "left" || property === "width" ? "x" : "y",
          value: number,
        };
  };
  if (
    options?.percentage &&
    Number.isFinite(Number.parseFloat(displayedValue))
  ) {
    displayedValue = `${Math.round(Number.parseFloat(displayedValue) * 10000) / 100}%`;
  }
  if (options?.sizing && liveValue === undefined)
    displayedValue = options.sizing === "hug" ? "Hug" : "Fill";
  const styleUpdate = (next: string): Record<string, string | null> => {
    const value =
      options?.percentage && next.trim()
        ? String(Math.max(0, Math.min(100, Number.parseFloat(next))) / 100)
        : next || null;
    return Object.fromEntries(
      [property, ...(options?.linkedProperties ?? [])].map((key) => [
        key,
        value,
      ]),
    );
  };
  return (
    <InspectorEditField
      label={label}
      value={displayedValue}
      icon={options?.icon}
      shortLabel={options?.shortLabel}
      suffix={options?.suffix}
      percentage={options?.percentage}
      numericValue={
        options?.sizing && details
          ? designLayoutFieldValue(details, property)
          : undefined
      }
      placeholder={options?.placeholder ?? "–"}
      styleProperty={property}
      whole={options?.whole}
      compact={options?.compact}
      disabled={disabled}
      applied={applied}
      hint={hint}
      motion={
        motionModeActive
          ? {
              modeActive: true,
              trackActive: motionTrackActive,
              onAddKeyframe: () =>
                onAddMotionKeyframe(property, displayedValue || computedValue),
            }
          : undefined
      }
      onInspect={() =>
        onInspect(
          property,
          typeof liveValue === "string" ? liveValue : computedValue,
        )
      }
      onPreview={(next) =>
        options?.geometry && onPreviewLayoutAction
          ? onPreviewLayoutAction(layoutAction(next))
          : onPreviewStyles(styleUpdate(next))
      }
      onCancelPreview={onCancelPreview}
      onCommit={(next) =>
        options?.geometry && onLayoutAction
          ? onLayoutAction(layoutAction(next))
          : onCommitStyles(styleUpdate(next))
      }
    />
  );
});

export function DesignInspector({
  workspaceId,
  pages,
  activePageId,
  pageFrames,
  folder,
  frame,
  frameSelected,
  details,
  selectedNodeId,
  selectedNodeIds,
  lint,
  active,
  canvasBackground,
  onCanvasBackgroundChange,
  motionTimelineOpen,
  motionProperties,
  onOpenMotionTimeline,
  zoomActionsRef,
}: DesignInspectorProps) {
  const cloudPreview = isCloudWorkspace(workspaceId);
  const cloudPreviewsEnabled = useInternalFeatureActive("cloudComputerV2");
  const cloudCanEdit = useCloudWorkspaceCanEdit(workspaceId ?? undefined);
  const previewAllowed = !cloudPreview || (cloudPreviewsEnabled && cloudCanEdit && !!workspaceId && workspacePreviewAvailable(workspaceId));
  const previewAccount = cloudPreview ? getOrganizationStoreGeneration() : 0;
  const previewDirectoryId = useDesignWorkspaceUiStore(state =>
    workspaceId ? state.byWorkspace[workspaceId]?.directoryId : undefined,
  );
  const previewOwner = useMemo(() => ({
    active, workspaceId, directoryId: previewDirectoryId,
    file: frame?.file, frameId: frame?.frameId, previewAllowed, previewAccount,
  }), [active, workspaceId, previewDirectoryId, frame?.file, frame?.frameId, previewAllowed, previewAccount]);
  const [openingPreviewOwner, setOpeningPreviewOwner] = useState<typeof previewOwner | null>(null);
  const openingPreview = openingPreviewOwner === previewOwner;
  const previewOwnerRef = useRef<typeof previewOwner | null>(previewOwner);
  previewOwnerRef.current = previewOwner;
  useLayoutEffect(() => {
    previewOwnerRef.current = previewOwner;
    return () => { previewOwnerRef.current = null; };
  }, [previewOwner]);
  const openPreview = async () => {
    const previewBridge = getActiveBridge();
    if (!active || !previewAllowed || !previewBridge || !workspaceId || !frame || openingPreview) return;
    const directoryId = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.directoryId;
    if (!directoryId || directoryId !== previewDirectoryId) return;
    setOpeningPreviewOwner(previewOwner);
    try {
      const result = await openDesignFramePreview(previewBridge, workspaceId, directoryId, frame.file);
      if (previewOwnerRef.current !== previewOwner || getActiveBridge() !== previewBridge ||
          useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.directoryId !== directoryId ||
          result.reference.workspaceId !== workspaceId || result.reference.directoryId !== directoryId ||
          result.reference.frame !== frame.file || (frame.frameId && result.reference.frameId !== frame.frameId)) return;
      if (cloudPreview) {
        if (getOrganizationStoreGeneration() !== previewAccount || !cloudWorkspaceCanEdit(workspaceId) ||
            !isInternalFeatureActive("cloudComputerV2") || !workspacePreviewAvailable(workspaceId)) return;
        const url = new URL(result.previewUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || Number(url.port) < 1024)
          throw new Error("Invalid cloud Design preview destination.");
        // Keep the logical VM URL in its exact workspace's Browser tab. That
        // tab alone obtains/revokes the existing frame-bound preview grant.
        const scope = workbenchScopeForFolder(workspaceId);
        const state = useWorkspaceStore.getState();
        const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
        const action = planBrowserOpen(current.tabs, current.activeId, { url: result.previewUrl, title: frame.title });
        if (!action) throw new Error("Invalid cloud Design preview destination.");
        state.dispatch({ ...action, scope });
      } else await shellOpenUrl(result.previewUrl);
    } catch (error) {
      if (previewOwnerRef.current === previewOwner)
        toast.error("Couldn’t open frame preview", { description: cloudPreview ? "Refresh the canvas and try again." : errorMessage(error) });
    } finally {
      if (previewOwnerRef.current === previewOwner) setOpeningPreviewOwner(null);
    }
  };
  const styleTargetNodeId =
    selectedNodeId ?? (frameSelected && details?.oid ? details.oid : null);
  const frameStyleTarget =
    frameSelected && !selectedNodeId && styleTargetNodeId !== null;
  const elementDetails = styleTargetNodeId ? details : null;
  const errors =
    lint?.violations.filter((violation) => violation.severity === "error") ??
    [];
  const firstBlockingReason = errors[0]
    ? blockingDesignLintReason(errors[0])
    : null;
  const zoom = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.zoom ??
        DEFAULT_DESIGN_WORKSPACE_VIEW.zoom)
      : DEFAULT_DESIGN_WORKSPACE_VIEW.zoom,
  );
  const zoomPercentage = Math.round(zoom * 100);
  const [frameAction, setFrameAction] = useState<"export" | null>(null);
  const [exportScale, setExportScale] = useState(1);
  const [pendingHistoryActions, setPendingHistoryActions] = useState(0);
  const [cssMode, setCssMode] = useState(false);
  const [provenance, setProvenance] = useState<InspectorProvenanceState | null>(
    null,
  );
  const provenanceAbortRef = useRef<AbortController | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorId = workspaceId
    ? `design-style-panel-${workspaceId}`
    : "design-style-panel";
  const backgroundOwner = useMemo(() => workspaceId ? { workspaceId, directoryId: previewDirectoryId, pageId: activePageId } : undefined,
    [workspaceId, previewDirectoryId, activePageId]);

  // The inspector sits in the floating panel above the canvas; its owning
  // Design surface holds exactly one canvas viewport for this workspace.
  const paintCanvasBackground = useCallback((value: string) => {
    if (backgroundOwner && !isCurrentDesignPageOwner(backgroundOwner)) return;
    const normalized = normalizeDesignCanvasBackground(value);
    if (!normalized) return;
    inspectorRef.current
      ?.closest("[data-design-workspace-surface]")
      ?.querySelector<HTMLElement>("[data-design-canvas-viewport]")
      ?.style.setProperty("background-color", normalized);
  }, [backgroundOwner]);
  const previewCanvasBackground = useCallback(
    (value: string) => paintCanvasBackground(value),
    [paintCanvasBackground],
  );
  const cancelCanvasBackgroundPreview = useCallback(
    () => paintCanvasBackground(canvasBackground),
    [canvasBackground, paintCanvasBackground],
  );
  const commitCanvasBackground = useCallback(
    (value: string) => {
      const normalized = normalizeDesignCanvasBackground(value);
      if (!normalized) return;
      paintCanvasBackground(normalized);
      onCanvasBackgroundChange(normalized);
    },
    [onCanvasBackgroundChange, paintCanvasBackground],
  );

  const foundation = useDesignFoundation(
    workspaceId,
    frame?.file,
    frame?.sourceVersion,
    active,
  );
  const foundationData = foundation.data;
  const provenanceOwnerKey = `${workspaceId ?? ""}\u0000${frame?.file ?? ""}\u0000${frame?.sourceVersion ?? ""}\u0000${foundationData?.summary.revision ?? ""}\u0000${styleTargetNodeId ?? ""}`;

  useEffect(() => {
    provenanceAbortRef.current?.abort();
    provenanceAbortRef.current = null;
    setProvenance(null);
    return () => {
      provenanceAbortRef.current?.abort();
      provenanceAbortRef.current = null;
    };
  }, [provenanceOwnerKey]);

  const inspectStyle = useCallback(
    (property: string, computedValue: string) => {
      if (
        !active ||
        !workspaceId ||
        !frame ||
        !styleTargetNodeId ||
        !foundationData
      ) {
        return;
      }
      provenanceAbortRef.current?.abort();
      const controller = new AbortController();
      provenanceAbortRef.current = controller;
      const ownerKey = provenanceOwnerKey;
      setProvenance({
        ownerKey,
        property,
        loading: true,
        value: null,
        error: null,
      });
      void inspectDesignNodeStyleProvenance({
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        expectedRevision: foundationData.summary.revision,
        nodeId: styleTargetNodeId,
        property,
        computedValue,
        signal: controller.signal,
      })
        .then((value) => {
          if (controller.signal.aborted) return;
          setProvenance((current) =>
            current?.ownerKey === ownerKey && current.property === property
              ? { ...current, loading: false, value, error: null }
              : current,
          );
        })
        .catch((provenanceError) => {
          if (controller.signal.aborted) return;
          setProvenance((current) =>
            current?.ownerKey === ownerKey && current.property === property
              ? {
                  ...current,
                  loading: false,
                  value: null,
                  error: errorMessage(provenanceError),
                }
              : current,
          );
        });
    },
    [
      active,
      foundationData,
      frame,
      provenanceOwnerKey,
      styleTargetNodeId,
      workspaceId,
    ],
  );

  const layoutActionQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueInspectorAction = useCallback(
    <T,>(action: () => Promise<T>): Promise<T> => {
      const task = layoutActionQueueRef.current.then(() => ({
        result: action(),
      }));
      layoutActionQueueRef.current = task.then(
        () => {},
        () => {},
      );
      return task.then((prepared) => prepared.result);
    },
    [],
  );

  const runHistory = useCallback(
    (direction: "undo" | "redo") => {
      if (!workspaceId) return;
      const owner = captureDesignPageOwner(workspaceId);
      // Start every request immediately. applyDesignHistoryCached registers it
      // with the workspace mutation lane before returning its promise, so two
      // fast keypresses become two ordered history steps rather than one being
      // discarded while the first bridge round trip is in flight.
      setPendingHistoryActions((current) => current + 1);
      void queueInspectorAction(() =>
        applyDesignHistoryCached(workspaceId, frame?.file ?? null, direction),
      )
        .then((result) => {
          void restoreDesignPageHistorySelection(workspaceId, owner, result, direction).catch((selectionError: unknown) => {
            toast.error("Couldn't save the restored frame selection", {
              description: errorMessage(selectionError),
            });
          });
        })
        .catch((historyError: unknown) => {
          toast.error(`Couldn't ${direction} the design edit`, {
            description: errorMessage(historyError),
          });
        })
        .finally(() => {
          setPendingHistoryActions((current) => Math.max(0, current - 1));
        });
    },
    [frame, workspaceId, queueInspectorAction],
  );

  const saveDesignChanges = useCallback(() => {
    if (!workspaceId) return;
    // Do not suppress a repeated Command-S while an earlier save is running.
    // Each request enters the same workspace mutation lane as focused-draft
    // publication, so the newest edit is always validated after publication.
    void queueInspectorAction(() => saveDesigns(workspaceId))
      .then(() => toast.dismiss(`design-save:${workspaceId}`))
      .catch((saveError: unknown) => {
        toast.error("Couldn't save design draft", {
          description: errorMessage(saveError),
          id: `design-save:${workspaceId}`,
          duration: Infinity,
          action: { label: "Retry", onClick: () => saveDesignChanges() },
        });
      });
  }, [workspaceId, queueInspectorAction]);


  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Review owns its keyboard, including portaled filter options. This
      // capture listener runs before a dialog's React handlers can intercept
      // the event; keep document undo/save out of that modal interaction.
      if (
        (event.metaKey || event.ctrlKey) &&
        document.querySelector('[data-design-review][data-state="open"]')
      ) return;
      const editableTarget = isEditableHotkeyTarget(event.target);
      dispatchDesignWorkspaceShortcut(event, editableTarget, {
        save: () => {
          // Inspector and inline-text fields publish drafts on blur. React
          // dispatches that blur synchronously, registering its mutation before
          // saveDesigns joins the same ordered workspace lane.
          if (editableTarget && event.target instanceof HTMLElement) {
            event.target.blur();
          }
          saveDesignChanges();
        },
        undo: () => runHistory("undo"),
        redo: () => runHistory("redo"),
      });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, runHistory, saveDesignChanges]);

  const exportPng = async () => {
    if (!workspaceId || !folder || !frame || frameAction) return;
    setFrameAction("export");
    // A selected layer exports on its own, at the chosen scale; the frame
    // itself (or its authored root) exports the whole frame.
    const exportNodeId =
      selectedNodeId && selectedNodeId !== layoutRootId ? selectedNodeId : null;
    try {
      const screenshot = await captureDesignRuntimeScreenshot(
        workspaceId,
        folder,
        frame.file,
        frame.sourceVersion,
        exportNodeId,
        exportScale,
      );
      if (!screenshot) {
        throw new Error("The selected frame is not ready to export yet.");
      }
      await exportDesignPng(
        screenshot.dataUrl,
        exportNodeId && elementDetails
          ? `${frame.title} ${designRuntimeLayerLabel(elementDetails)}`
          : frame.title,
      );
    } catch (exportError) {
      toast.error("Couldn't export the design", {
        description: errorMessage(exportError),
      });
    } finally {
      setFrameAction(null);
    }
  };

  const styleNodeIds = useMemo(
    () =>
      styleTargetNodeId
        ? [
            styleTargetNodeId,
            ...(selectedNodeId
              ? selectedNodeIds.filter((nodeId) => nodeId !== styleTargetNodeId)
              : []),
          ].slice(0, DESIGN_SELECTION_NODE_LIMIT)
        : [],
    [selectedNodeId, selectedNodeIds, styleTargetNodeId],
  );
  const layoutRuntimeState = useDesignRuntimeStore((state) =>
    workspaceId && frame
      ? state.byWorkspace[workspaceId]?.frames[frame.file]
      : undefined,
  );
  const layoutParents = useMemo(
    () =>
      styleNodeIds.flatMap((nodeId) => {
        const node =
          nodeId === elementDetails?.oid
            ? elementDetails
            : layoutRuntimeState?.detailsByNode[nodeId];
        return node && node.sourceVersion === elementDetails?.sourceVersion
          ? [node]
          : [];
      }),
    [elementDetails, layoutRuntimeState, styleNodeIds],
  );
  const layoutRootId = layoutRuntimeState?.snapshot?.frame.oid;
  const styleDirectoryKey = workspaceId
    ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directoryId ??
      designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directory ?? ""
    : "";
  const styleEditContextRef = useRef({
    active,
    pageId: activePageId,
    directoryKey: styleDirectoryKey,
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
  });
  styleEditContextRef.current = {
    active,
    pageId: activePageId,
    directoryKey: styleDirectoryKey,
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
  };
  const styleOwnerKey = `${workspaceId ?? ""}\u0000${styleDirectoryKey}\u0000${activePageId ?? ""}\u0000${frame?.file ?? ""}\u0000${styleNodeIds.join("\u0000")}`;
  // A keyed editor's cleanup runs after the new selection has rendered. Keep
  // its callbacks and cancellation baseline attached to its own owner; using
  // the live selection here would restore the incoming layer instead.
  const styleOwner = useMemo(
    () => ({
      key: styleOwnerKey,
      contextRef: { current: styleEditContextRef.current },
      previewIntentRef: { current: 0 },
    }),
    [styleOwnerKey],
  );
  styleOwner.contextRef.current = styleEditContextRef.current;
  const currentStyleOwnerRef = useRef(styleOwner);
  currentStyleOwnerRef.current = styleOwner;
  const stylePreviewIntentRef = styleOwner.previewIntentRef;
  const stylesForNode = useCallback(
    (
      nodeId: string,
      styles: Record<string, string | null>,
      context = styleEditContextRef.current,
    ) => {
      const runtimeDetails =
        context.workspaceId && context.frame
          ? useDesignRuntimeStore.getState().byWorkspace[context.workspaceId]
              ?.frames[context.frame.file]?.detailsByNode[nodeId]
          : null;
      return withDesignPositionContext(
        styles,
        runtimeDetails?.styles.position ??
          (nodeId === context.selectedNodeId
            ? context.elementDetails?.styles.position
            : undefined) ??
          "static",
      );
    },
    [],
  );

  const previewSelectedStyles = useCallback(
    async (styles: Record<string, string | null>) => {
      const context = styleOwner.contextRef.current;
      if (currentStyleOwnerRef.current !== styleOwner || !context.active) return;
      if (
        !context.workspaceId ||
        !context.folder ||
        !context.frame ||
        context.styleNodeIds.length === 0
      ) {
        throw new Error("Select one or more design layers first.");
      }
      const intent = ++stylePreviewIntentRef.current;
      for (const nodeId of context.styleNodeIds)
        publishDesignLivePreviewStyles(
          context.workspaceId,
          context.frame.file,
          nodeId,
          stylesForNode(nodeId, styles, context),
        );
      // A slider, a colour drag or a label scrub can ask for this many times a
      // second, so it asks for the same lean geometry a canvas gesture does —
      // including the container's children in the same round trip, rather than a
      // second O(children) read behind it.
      const wantsChildren =
        Object.keys(styles).some(designStylePropertyAffectsLayout) &&
        Boolean(
          context.selectedNodeId &&
          designInspectorPreviewOverlay(
            context.workspaceId,
            context.frame.file,
            context.selectedNodeId,
          )?.querySelector("[data-design-inline-spacing-root]"),
        );
      const previewGeometries = await Promise.all(
        context.styleNodeIds.map((nodeId) =>
          previewDesignNodeGeometry({
            workspaceId: context.workspaceId!,
            frame: context.frame!,
            nodeId,
            styles: stylesForNode(nodeId, styles, context),
            children: wantsChildren && nodeId === context.selectedNodeId,
          }),
        ),
      );
      if (
        stylePreviewIntentRef.current !== intent ||
        currentStyleOwnerRef.current !== styleOwner ||
        !styleOwner.contextRef.current.active
      ) return;
      for (const geometry of previewGeometries) {
        const spacingRoot = paintDesignInspectorPreviewDetails(
          context.workspaceId,
          context.frame.file,
          geometry,
        );
        if (spacingRoot && geometry.children.length > 0) {
          paintDesignInlineGapHandles(
            spacingRoot,
            geometry,
            geometry.children,
            designWorkspaceView(context.workspaceId).zoom,
          );
        }
      }
    },
    [styleOwner, stylePreviewIntentRef, stylesForNode],
  );

  const restoreSelectedStylePreview = useCallback(async () => {
    const context = styleOwner.contextRef.current;
    if (!context.workspaceId || !context.folder || !context.frame) return;
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(context.workspaceId).data;
    if ((snapshot?.directoryId ?? snapshot?.directory ?? "") !== context.directoryKey)
      return;
    const intent = ++stylePreviewIntentRef.current;
    const restoredDetails = await Promise.all(
      context.styleNodeIds.map((nodeId) => {
        const input = {
          workspaceId: context.workspaceId!,
          frame: context.frame!.file,
          sourceVersion: context.frame!.sourceVersion,
          nodeId,
        };
        return clearDesignNodeStylePreviewTransient(input);
      }),
    );
    if (
      stylePreviewIntentRef.current !== intent ||
      currentStyleOwnerRef.current !== styleOwner ||
      !styleOwner.contextRef.current.active
    ) return;
    for (const details of restoredDetails) {
      paintDesignInspectorPreviewDetails(
        context.workspaceId,
        context.frame.file,
        details,
      );
    }
    const primary = restoredDetails.find(
      (details) => details.oid === context.selectedNodeId,
    );
    if (!primary) return;
    // The restored layout still owes the gap affordances their positions; one
    // lean measurement answers that without re-reading every child in full.
    const restored = await previewDesignNodeGeometry({
      workspaceId: context.workspaceId,
      frame: context.frame,
      nodeId: primary.oid,
      children: true,
    });
    if (
      stylePreviewIntentRef.current !== intent ||
      currentStyleOwnerRef.current !== styleOwner ||
      !styleOwner.contextRef.current.active
    ) return;
    const spacingRoot = paintDesignInspectorPreviewDetails(
      context.workspaceId,
      context.frame.file,
      restored,
    );
    if (spacingRoot && restored.children.length > 0) {
      paintDesignInlineGapHandles(
        spacingRoot,
        restored,
        restored.children,
        designWorkspaceView(context.workspaceId).zoom,
      );
    }
  }, [styleOwner, stylePreviewIntentRef]);

  /** Cancelling a speculative preview cannot fail in a way the user can act on:
   * the source was never written. A commit landing mid-cancel makes the runtime
   * reject the clear, and that must not surface as a page error. */
  const clearSelectedStylePreview = useCallback(async () => {
    try {
      await restoreSelectedStylePreview();
    } catch {
      // Speculative cleanup only.
    }
  }, [restoreSelectedStylePreview]);

  const commitSelectedStyles = useCallback(
    (styles: Record<string, string | null>): Promise<void> => {
      const context = styleEditContextRef.current;
      // Retire stale callbacks during render, before passive unmount cleanup.
      // An eyedropper or a pending animation frame cannot follow a new layer.
      if (currentStyleOwnerRef.current !== styleOwner || !context.active)
        return Promise.resolve();
      if (
        !context.workspaceId ||
        !context.frame ||
        context.styleNodeIds.length === 0
      ) {
        return Promise.reject(
          new Error("Select one or more design layers first."),
        );
      }
      const { workspaceId, frame, styleNodeIds } = context;
      const updates = styleNodeIds.map((nodeId) => ({
        nodeId,
        styles: stylesForNode(nodeId, styles),
      }));
      // Serialize local geometry preparation only. The cache orders durable
      // writes separately, so a later choice can paint while this one saves.
      const task = layoutActionQueueRef.current.then(async () => {
        const root =
          useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
            frame.file
          ]?.snapshot?.frame;
        let resizedFrame: DesignOperation | null = null;
        if (
          root &&
          hasDesignIntrinsicSize(root) &&
          Object.keys(styles).some(designStylePropertyAffectsLayout)
        ) {
          const runtime = designFrameRuntime(workspaceId, frame.file);
          if (!runtime) throw new Error("The selected frame is still loading.");
          await Promise.all(
            updates.map((update) =>
              previewDesignNodeGeometry({
                workspaceId,
                frame: { ...frame, sourceVersion: runtime.sourceVersion },
                ...update,
              }),
            ),
          );
          const measured = await runtime.getNodeDetails(root.oid);
          const current =
            designWorkspaceSnapshotCache
              .peekSnapshot(workspaceId)
              .data?.frames.find((entry) => entry.file === frame.file) ?? frame;
          const size = designHugFrameSize(measured, current);
          if (size.width !== current.width || size.height !== current.height)
            resizedFrame = {
              operationId: `layout:${crypto.randomUUID()}`,
              type: "frame.set-geometry",
              frame: frame.file,
              geometry: { x: current.x, y: current.y, z: current.z, ...size },
            };
        }
        if (updates.length === 1 && !resizedFrame) {
          return {
            persist: updateDesignNodeStylesCached(workspaceId, {
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              ...updates[0]!,
            }).then(() => {}),
          };
        }
        const properties = Object.keys(styles).sort();
        return {
          persist: applyDesignEditCached(workspaceId, frame, {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            actor: { kind: "human", id: "desktop" },
            intent: `Set ${properties.join(", ")} on ${styleNodeIds.length} layers`,
            createdAt: Date.now(),
            coalesceKey: `styles:${styleNodeIds.join(":")}:${properties.join(":")}`,
            operations: [
              ...updates.map((update) => ({
                operationId: `styles:${crypto.randomUUID()}`,
                type: "node.set-styles" as const,
                ...update,
                scope: "auto" as const,
                responsiveContext: "base",
                stateContext: "default" as const,
              })),
              ...(resizedFrame ? [resizedFrame] : []),
            ],
          }).then(() => {}),
        };
      });
      layoutActionQueueRef.current = task.then(
        () => {},
        () => {},
      );
      return task.then((prepared) => prepared.persist);
    },
    [styleOwner, stylesForNode],
  );

  const previewLayoutAction = useCallback(
    async (action: DesignLayoutAction) => {
      const context = styleOwner.contextRef.current;
      if (currentStyleOwnerRef.current !== styleOwner || !context.active) return;
      if (!context.workspaceId || !context.frame) return;
      const intent = ++stylePreviewIntentRef.current;
      const runtimeState =
        useDesignRuntimeStore.getState().byWorkspace[context.workspaceId]
          ?.frames[context.frame.file];
      await Promise.all(
        context.styleNodeIds.map(async (nodeId) => {
          const details =
            runtimeState?.detailsByNode[nodeId] ??
            (nodeId === context.selectedNodeId ? context.elementDetails : null);
          if (!details) return;
          const geometry = await previewDesignNodeGeometry({
            workspaceId: context.workspaceId!,
            frame: context.frame!,
            nodeId,
            styles: designLayoutActionStyles(details, action),
            children: true,
          });
          if (
            stylePreviewIntentRef.current !== intent ||
            currentStyleOwnerRef.current !== styleOwner ||
            !styleOwner.contextRef.current.active
          ) return;
          const spacingRoot = paintDesignInspectorPreviewDetails(
            context.workspaceId!,
            context.frame!.file,
            geometry,
          );
          if (spacingRoot)
            paintDesignInlineGapHandles(
              spacingRoot,
              geometry,
              geometry.children,
              designWorkspaceView(context.workspaceId!).zoom,
            );
        }),
      );
    },
    [styleOwner, stylePreviewIntentRef],
  );

  const commitLayoutAction = useCallback(
    (action: DesignLayoutAction): Promise<void> => {
      if (currentStyleOwnerRef.current !== styleOwner || !styleEditContextRef.current.active)
        return Promise.resolve();
      const intent = ++stylePreviewIntentRef.current;
      // Capture the semantic owner at intent. Queued clicks must never follow a
      // later selection, and every relative rotation reads its own latest value.
      const context = styleEditContextRef.current;
      const task = layoutActionQueueRef.current.then(async () => {
        const { workspaceId, frame, styleNodeIds } = context;
        if (!workspaceId || !frame || styleNodeIds.length === 0) return;
        const runtime = designFrameRuntime(workspaceId, frame.file);
        if (!runtime) throw new Error("The selected frame is still loading.");
        const details = await Promise.all(
          styleNodeIds.map((nodeId) => runtime.getNodeDetails(nodeId)),
        );
        let updates: Map<string, Record<string, string | null>>;
        if (
          isDesignLayoutChildAction(action) ||
          action.type === "auto-layout"
        ) {
          const children = designLayoutChildrenSummary(details);
          if (children.truncated)
            throw new Error(
              "Select a smaller frame to arrange its children together.",
            );
          const childDetails = await Promise.all(
            children.nodeIds.map(async (nodeId) => {
              try {
                return await runtime.getNodeDetails(nodeId);
              } catch (error) {
                // A child removed after intent no longer belongs in this batch.
                if (
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "NODE_NOT_FOUND"
                )
                  return null;
                throw error;
              }
            }),
          );
          const liveChildren = childDetails.filter(
            (node): node is DesignRuntimeNodeDetails => node !== null,
          );
          updates =
            action.type === "auto-layout"
              ? designAutoLayoutUpdates(details, liveChildren, action.flow)
              : designLayoutChildUpdates(details, liveChildren, action);
        } else if (action.type === "sizing") {
          updates = new Map(
            details.map((node) => [
              node.oid,
              designSizingStyles(node, action.axis, action.mode),
            ]),
          );
          if (action.mode === "fill") {
            const parentIds = [
              ...new Set(
                details.flatMap((node) =>
                  node.layout?.parentId ? [node.layout.parentId] : [],
                ),
              ),
            ];
            const parents = await Promise.all(
              parentIds.map((nodeId) => runtime.getNodeDetails(nodeId)),
            );
            for (const parent of parents) {
              if (designSizingMode(parent, action.axis) === "hug")
                updates.set(parent.oid, {
                  ...updates.get(parent.oid),
                  ...designSizingStyles(parent, action.axis, "fixed"),
                });
            }
          }
        } else if (action.type === "resize-fill") {
          const targets = details.filter(
            (node) =>
              node.oid !== context.layoutRootId && node.layout?.parentId,
          );
          const parentIds = [
            ...new Set(targets.map((node) => node.layout!.parentId!)),
          ];
          const parents = await Promise.all(
            parentIds.map((nodeId) => runtime.getNodeDetails(nodeId)),
          );
          updates = designLayoutChildUpdates(parents, targets, {
            type: "center",
          });
          for (const node of targets)
            updates.set(node.oid, {
              ...updates.get(node.oid),
              ...designLayoutActionStyles(node, action),
            });
        } else updates = designLayoutActionUpdates(details, action);
        // A fixed canvas frame is sized by its viewport metadata. Its shell
        // continues to follow that viewport after later canvas resizes.
        const rootStyles = context.layoutRootId
          ? updates.get(context.layoutRootId)
          : undefined;
        const rootDetails = details.find(
          (node) => node.oid === context.layoutRootId,
        );
        if (
          rootStyles &&
          rootDetails &&
          action.type === "sizing" &&
          action.mode === "fixed"
        ) {
          Object.assign(
            rootStyles,
            designFrameRootFixedStyles(rootDetails, {
              width: action.axis === "x",
              height: action.axis === "y",
            }),
          );
        }
        if (
          rootStyles &&
          rootDetails &&
          action.type === "auto-layout" &&
          action.flow === "none"
        ) {
          Object.assign(
            rootStyles,
            designFrameRootFixedStyles(rootDetails, {
              width: true,
              height: true,
            }),
          );
        }
        if (updates.size === 0) return;
        const currentFrame = { ...frame, sourceVersion: runtime.sourceVersion };
        const fittedRoot =
          action.type === "resize-fit"
            ? details.find(
                (node) =>
                  node.oid === context.layoutRootId && updates.has(node.oid),
              )
            : undefined;
        const fittedGeometry = fittedRoot
          ? {
              x: frame.x,
              y: frame.y,
              z: frame.z,
              ...designLayoutResizedFrame(
                fittedRoot,
                updates.get(fittedRoot.oid)!,
              ),
            }
          : null;
        const operations: DesignOperation[] = [...updates].map(
          ([nodeId, styles]) => ({
            operationId: `layout:${crypto.randomUUID()}`,
            type: "node.set-styles",
            nodeId,
            styles,
            scope: "auto",
            responsiveContext: "base",
            stateContext: "default",
          }),
        );
        if (fittedGeometry)
          operations.push({
            operationId: `layout:${crypto.randomUUID()}`,
            type: "frame.set-geometry",
            frame: frame.file,
            geometry: fittedGeometry,
          });
        if (operations.length > DESIGN_TRANSACTION_MAX_OPERATIONS)
          throw new Error(
            "Select a smaller frame to arrange its children together.",
          );
        const recover = async (error: unknown): Promise<never> => {
          // An earlier failed save must not erase a more recent local choice.
          if (stylePreviewIntentRef.current !== intent) throw error;
          await Promise.all(
            [...updates.keys()].map(async (nodeId) => {
              try {
                const restored = await clearDesignNodeStylePreviewTransient({
                  workspaceId,
                  frame: frame.file,
                  sourceVersion: runtime.sourceVersion,
                  nodeId,
                });
                paintDesignInspectorPreviewDetails(
                  workspaceId,
                  frame.file,
                  restored,
                );
              } catch {
                /* The runtime may have been replaced by a newer generation. */
              }
            }),
          );
          throw error;
        };
        try {
          const batch = [...updates].map(([nodeId, styles]) => ({
            nodeId,
            styles,
          }));
          for (const update of batch)
            publishDesignLivePreviewStyles(
              workspaceId,
              frame.file,
              update.nodeId,
              update.styles,
            );
          const geometries = runtime.supports("previewLayout")
            ? await runtime.previewLayout({
                updates: batch,
                nodeIds: styleNodeIds,
              })
            : await Promise.all(
                batch.map((update) =>
                  previewDesignNodeGeometry({
                    workspaceId,
                    frame: currentFrame,
                    ...update,
                    children: true,
                  }),
                ),
              );
          for (const geometry of geometries) {
            const spacingRoot = paintDesignInspectorPreviewDetails(
              workspaceId,
              frame.file,
              geometry,
            );
            if (spacingRoot)
              paintDesignInlineGapHandles(
                spacingRoot,
                geometry,
                geometry.children,
                designWorkspaceView(workspaceId).zoom,
              );
          }
          const root =
            useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.snapshot?.frame;
          if (
            root &&
            (hasDesignIntrinsicSize(root) ||
              (action.type === "sizing" && updates.has(root.oid)))
          ) {
            const measured = await runtime.getNodeDetails(root.oid);
            const current =
              designWorkspaceSnapshotCache
                .peekSnapshot(workspaceId)
                .data?.frames.find((entry) => entry.file === frame.file) ??
              frame;
            const size = designHugFrameSize(measured, current);
            if (action.type === "sizing" && updates.has(root.oid)) {
              const box = measured.box ?? measured.rect;
              const property = action.axis === "x" ? "width" : "height";
              size[property] = Math.max(
                1,
                Math.min(16_384, Math.ceil(box[property])),
              );
            }
            if (size.width !== current.width || size.height !== current.height)
              operations.push({
                operationId: `layout:${crypto.randomUUID()}`,
                type: "frame.set-geometry",
                frame: frame.file,
                geometry: { x: current.x, y: current.y, z: current.z, ...size },
              });
          }
          if (operations.length > DESIGN_TRANSACTION_MAX_OPERATIONS)
            throw new Error(
              "Select a smaller frame to arrange its children together.",
            );
          if (operations.length === 1) {
            const [nodeId, styles] = updates.entries().next().value!;
            return {
              persist: updateDesignNodeStylesCached(workspaceId, {
                frame: frame.file,
                nodeId,
                sourceVersion: currentFrame.sourceVersion,
                styles,
              }).then(() => {}, recover),
            };
          } else {
            return {
              persist: applyDesignEditCached(workspaceId, currentFrame, {
                schemaVersion: 1,
                transactionId: `desktop:${crypto.randomUUID()}`,
                actor: { kind: "human", id: "desktop" },
                intent: `Update layout on ${styleNodeIds.length} layers`,
                createdAt: Date.now(),
                operations,
              }).then(() => {}, recover),
            };
          }
        } catch (error) {
          return recover(error);
        }
      });
      layoutActionQueueRef.current = task.then(
        () => {},
        () => {},
      );
      return task.then((prepared) => prepared?.persist);
    },
    [styleOwner, stylePreviewIntentRef],
  );

  const styleContext =
    workspaceId && folder && frame && styleTargetNodeId && elementDetails
      ? { workspaceId, folder, frame, nodeId: styleTargetNodeId }
      : null;
  const styleField = (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => {
    if (!styleContext) return null;
    const frameGeometryProperty = frameStyleTarget
      ? (
          {
            left: ["x", styleContext.frame.x],
            top: ["y", styleContext.frame.y],
            width: ["w", styleContext.frame.width],
            height: ["h", styleContext.frame.height],
          } as const
        )[property as "left" | "top" | "width" | "height"]
      : undefined;
    if (frameGeometryProperty) {
      const [geometryKey, geometryValue] = frameGeometryProperty;
      return (
        <InspectorEditField
          key={`${styleContext.workspaceId}:${styleContext.frame.file}:frame:${geometryKey}`}
          label={label}
          value={
            options?.sizing
              ? options.sizing === "hug"
                ? "Hug"
                : "Fill"
              : geometryValue
          }
          numericValue={options?.sizing ? String(geometryValue) : undefined}
          whole={options?.whole}
          range={
            geometryKey === "w" || geometryKey === "h"
              ? DESIGN_FRAME_SIZE_RANGE
              : DESIGN_FRAME_POSITION_RANGE
          }
          compact={options?.compact}
          disabled={!active || pendingHistoryActions > 0}
          applied
          onPreview={(next) => {
            const number = Number(next);
            if (!Number.isFinite(number)) return;
            const geometry = paintedDesignFrameGeometry(
              styleContext.workspaceId,
              styleContext.frame.file,
              frameGeometry(styleContext.frame),
            );
            paintDesignFrameGeometryPreview(
              styleContext.workspaceId,
              styleContext.frame.file,
              { ...geometry, [geometryKey]: number },
            );
          }}
          onCancelPreview={() =>
            paintDesignFrameGeometryPreview(
              styleContext.workspaceId,
              styleContext.frame.file,
              frameGeometry(styleContext.frame),
            )
          }
          onCommit={async (next) => {
            const number = Number(next);
            if (!Number.isFinite(number)) {
              throw new Error("Enter a finite number.");
            }
            if (
              (geometryKey === "w" || geometryKey === "h") &&
              elementDetails
            ) {
              const size = designFrameSizeValue(number);
              const { workspaceId: owner, frame: target } = styleContext;
              const rootStyles = designFrameRootFixedStyles(elementDetails, {
                width: geometryKey === "w",
                height: geometryKey === "h",
              });
              // Built in the mutation lane: W then H typed before the first
              // save replies must each keep the other's confirmed axis.
              await applyDesignEditCached(owner, target, () => {
                const latest =
                  designWorkspaceSnapshotCache
                    .peekSnapshot(owner)
                    .data?.frames.find(
                      (candidate) => candidate.file === target.file,
                    ) ?? target;
                return {
                  schemaVersion: 1,
                  transactionId: `desktop:${crypto.randomUUID()}`,
                  actor: { kind: "human", id: "desktop" },
                  intent: "Resize canvas frame",
                  createdAt: Date.now(),
                  operations: [
                    {
                      operationId: `layout:${crypto.randomUUID()}`,
                      type: "node.set-styles",
                      nodeId: elementDetails.oid,
                      styles: rootStyles,
                      scope: "auto",
                      responsiveContext: "base",
                      stateContext: "default",
                    },
                    {
                      operationId: `layout:${crypto.randomUUID()}`,
                      type: "frame.set-geometry",
                      frame: target.file,
                      geometry: {
                        x: latest.x,
                        y: latest.y,
                        width: geometryKey === "w" ? size : latest.width,
                        height: geometryKey === "h" ? size : latest.height,
                        z: latest.z,
                      },
                    },
                  ],
                };
              });
              return;
            }
            await updateDesignFrameGeometryCached(
              styleContext.workspaceId,
              styleContext.frame.file,
              {
                ...frameGeometry(styleContext.frame),
                [geometryKey]: number,
              },
              [geometryKey],
            );
          }}
        />
      );
    }
    const authoredProperties = elementDetails?.authoredStyleProperties;
    const applied = isDesignRuntimeStylePropertyAuthored(
      authoredProperties,
      property,
      value,
    );
    return (
      <InspectorStyleField
        key={`${styleContext.workspaceId}:${styleContext.frame.file}:${styleNodeIds.join(":")}:${property}`}
        workspaceId={styleContext.workspaceId}
        frame={styleContext.frame.file}
        nodeId={styleContext.nodeId}
        label={label}
        property={property}
        value={designStyleFieldValue(authoredProperties, property, value)}
        computedValue={value}
        options={options}
        details={elementDetails ?? undefined}
        onLayoutAction={commitLayoutAction}
        onPreviewLayoutAction={previewLayoutAction}
        disabled={!active || pendingHistoryActions > 0}
        applied={applied}
        hint={
          provenance?.ownerKey === provenanceOwnerKey &&
          provenance.property === property
            ? provenance.loading
              ? "Resolving…"
              : provenance.value?.winner
                ? `${provenance.value.winner.origin} · ${provenance.value.winner.file}`
                : provenance.value?.origin
            : undefined
        }
        motionModeActive={motionTimelineOpen}
        motionTrackActive={motionProperties.includes(property)}
        onAddMotionKeyframe={onOpenMotionTimeline}
        onInspect={inspectStyle}
        onPreviewStyles={previewSelectedStyles}
        onCancelPreview={clearSelectedStylePreview}
        onCommitStyles={commitSelectedStyles}
      />
    );
  };

  const selectionName =
    styleNodeIds.length > 1
      ? `${styleNodeIds.length} layers`
      : elementDetails
        ? designRuntimeLayerLabel(elementDetails)
        : frameSelected && frame
          ? designFrameLayerLabel(frame.kind)
          : selectedNodeId
            ? "Nothing selected"
            : "Page";
  const SelectionGlyph =
    styleNodeIds.length > 1
      ? Layers
      : selectionName === "Text"
        ? Type
        : selectionName === "Image"
          ? ImageIcon
          : selectionName === "Vector Path"
            ? Spline
            : selectionName === "Page"
              ? File
              : FrameIcon;

  const inspectorSelectionHeader = (
    <section className="border-border1 shrink-0 border-b">
      <div
        data-design-inspector-header=""
        className="flex h-10 min-w-0 items-center gap-2 px-3"
      >
        {selectionName === "Page" && workspaceId && pages?.length ? (
          <DesignPagePicker workspaceId={workspaceId} directoryId={previewDirectoryId} pages={pages}
            activePageId={activePageId} frames={pageFrames ?? []} active={active} />
        ) : <>
          <SelectionGlyph className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">{selectionName}</span>
        </>}
      </div>
    </section>
  );
  const exportSection =
    frame && folder && (frameSelected || selectedNodeId) ? (
      <InspectorSection title="Export" data-design-export-section="">
        {(!cloudPreview || cloudPreviewsEnabled) && (
          <Button type="button" variant="secondary" className="w-full" disabled={openingPreview || !active || !previewAllowed} onClick={() => void openPreview()}>
            <ExternalLink /> Open preview
          </Button>
        )}
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
          <InspectorSelect
            label="Export scale"
            value={String(exportScale)}
            options={[
              { value: "0.5", label: "0.5x" },
              { value: "1", label: "1x" },
              { value: "2", label: "2x" },
            ]}
            onChange={(value) => setExportScale(Number(value))}
          />
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={frameAction !== null}
            aria-label="Export PNG"
            onClick={() => void exportPng()}
          >
            <Download />
            {frameAction === "export" ? "Exporting…" : "Export PNG"}
          </Button>
        </div>
      </InspectorSection>
    ) : null;

  // Width, placement, and the popover boundary belong to the floating panel
  // that stacks this inspector below Layers.
  return (
    <aside
      ref={inspectorRef}
      id={inspectorId}
      data-design-inspector=""
      className="bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <PanelHeader data-design-style-panel-header="" size="window">
        <div
          role="group"
          aria-label="Inspector view"
          className="flex items-center gap-0.5"
        >
          <button
            type="button"
            className="zd-panel-tab"
            aria-pressed={!cssMode}
            onClick={() => setCssMode(false)}
          >
            Style
          </button>
          <button
            type="button"
            className="zd-panel-tab"
            disabled={!styleContext && !cssMode}
            aria-label="CSS"
            aria-pressed={cssMode}
            onClick={() => setCssMode((current) => !current)}
          >
            CSS
          </button>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-fg2 h-7 min-w-12 px-2 text-xs tabular-nums"
                disabled={!active || !workspaceId}
                aria-label={`Canvas zoom ${zoomPercentage}%`}
              >
                {zoomPercentage}%
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={zoom >= DESIGN_MAX_ZOOM}
                aria-label="Zoom in"
                onSelect={() => zoomActionsRef.current?.zoomIn()}
              >
                <span>Zoom in</span>
                <DropdownMenuShortcut className="tracking-normal">
                  +
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={zoom <= DESIGN_MIN_ZOOM}
                aria-label="Zoom out"
                onSelect={() => zoomActionsRef.current?.zoomOut()}
              >
                <span>Zoom out</span>
                <DropdownMenuShortcut className="tracking-normal">
                  −
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PanelHeader>
      {cssMode && styleContext && elementDetails ? (
        <div
          data-design-style-panel-css-mode=""
          className="flex min-h-0 flex-1 flex-col"
        >
          {inspectorSelectionHeader}
          <DesignComputedCssEditor
            key={`${styleOwner.key}:css`}
            details={elementDetails}
            disabled={!active || pendingHistoryActions > 0}
            onPreviewStyles={previewSelectedStyles}
            onCancelStylePreview={clearSelectedStylePreview}
            onCommitStyles={commitSelectedStyles}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col pb-6">
            {inspectorSelectionHeader}

            {styleTargetNodeId && errors.length > 0 ? (
              <Tooltip label={`${firstBlockingReason}: ${errors[0]?.message}`}>
                <PanelHeader as="section" size="panel" className="text-red-primary">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="text-3xxs min-w-0 flex-1 truncate">
                    {firstBlockingReason}
                  </span>
                </PanelHeader>
              </Tooltip>
            ) : null}

            {styleContext && elementDetails ? (
              <DesignStyleEditor
                key={styleOwner.key}
                details={elementDetails}
                livePreviewOwner={
                  styleContext
                    ? {
                        workspaceId: styleContext.workspaceId,
                        frame: styleContext.frame.file,
                        nodeId: styleContext.nodeId,
                      }
                    : undefined
                }
                renderField={styleField}
                onLayoutAction={commitLayoutAction}
                frameSelected={
                  frameStyleTarget || elementDetails.oid === layoutRootId
                }
                layoutParents={layoutParents}
                disabled={!active || pendingHistoryActions > 0}
                onPreviewStyles={previewSelectedStyles}
                onCancelStylePreview={clearSelectedStylePreview}
                onCommitStyles={commitSelectedStyles}
                motionTimelineOpen={motionTimelineOpen}
                motionProperties={motionProperties}
                onOpenMotionTimeline={onOpenMotionTimeline}
              />
            ) : workspaceId && !frameSelected && !selectedNodeId ? (
              <DesignCanvasBackgroundEditor
                key={activePageId ?? "legacy"}
                value={canvasBackground}
                disabled={!active}
                onPreview={previewCanvasBackground}
                onCancelPreview={cancelCanvasBackgroundPreview}
                onCommit={commitCanvasBackground}
              />
            ) : frame && workspaceId ? (
              <InspectorSection title="Frame">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["X", "x", frame.x],
                      ["Y", "y", frame.y],
                      ["W", "w", frame.width],
                      ["H", "h", frame.height],
                    ] as const
                  ).map(([label, key, value]) => (
                    <InspectorEditField
                      key={key}
                      label={label}
                      value={value}
                      compact
                      whole
                      range={
                        key === "w" || key === "h"
                          ? DESIGN_FRAME_SIZE_RANGE
                          : DESIGN_FRAME_POSITION_RANGE
                      }
                      applied
                      onPreview={(next) => {
                        const number = Number(next);
                        if (!Number.isFinite(number)) return;
                        const geometry = paintedDesignFrameGeometry(
                          workspaceId,
                          frame.file,
                          frameGeometry(frame),
                        );
                        paintDesignFrameGeometryPreview(
                          workspaceId,
                          frame.file,
                          { ...geometry, [key]: number },
                        );
                      }}
                      onCancelPreview={() =>
                        paintDesignFrameGeometryPreview(
                          workspaceId,
                          frame.file,
                          frameGeometry(frame),
                        )
                      }
                      onCommit={async (next) => {
                        const number = Number(next);
                        if (!Number.isFinite(number)) {
                          throw new Error("Enter a finite number.");
                        }
                        await updateDesignFrameGeometryCached(
                          workspaceId,
                          frame.file,
                          { ...frameGeometry(frame), [key]: number },
                          [key],
                        );
                      }}
                    />
                  ))}
                </div>
              </InspectorSection>
            ) : null}
            {exportSection}
          </div>
        </ScrollArea>
      )}
    </aside>
  );
}
