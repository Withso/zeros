import { DesignReviewDialog } from "./design-review-dialog";
// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import { AlertTriangle, Diamond, Download, X } from "lucide-react";
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
  DESIGN_TRANSACTION_MAX_OPERATIONS,
  type DesignOperation,
} from "@zeros/design-core";
import type { DesignStyleProvenance } from "@zeros/design-web";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { exportDesignPng } from "../../platform/design";
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
  designHugFrameSize,
  designSizingMode,
  designSizingStyles,
  hasDesignIntrinsicSize,
} from "./design-auto-layout-values";
import { normalizeDesignCanvasBackground } from "./design-canvas-background";
import { DesignCanvasBackgroundEditor } from "./design-canvas-background-editor";
import { DesignComputedCssEditor } from "./design-computed-css-editor";
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
import { DesignPanelResizeHandle } from "./design-panel-resize-handle";
import { DesignStyleEditor } from "./design-style-editor";
import {
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
  DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_STYLE_WIDTH_MAX,
  DESIGN_WORKSPACE_STYLE_WIDTH_MIN,
  DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
  clampDesignWorkspaceStyleWidth,
  persistDesignWorkspaceStyleWidth,
  readPersistedDesignWorkspaceStyleWidth,
} from "./design-workspace-width";
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
  selectDesignFrame,
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
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";
import { useDesignFoundation } from "./state/use-design-foundation";

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
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
  percentage?: boolean;
  label: string;
  value: string | number;
  applied?: boolean;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
  styleProperty?: string;
  whole?: boolean;
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
  percentage,
  label,
  value,
  applied = false,
  disabled = false,
  hint,
  placeholder,
  styleProperty,
  whole = false,
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
  const skipCommitRef = useRef(false);
  const unitMenuOpenRef = useRef(false);
  const commitIntentRef = useRef(0);
  const scrubRef = useRef<{
    pointerId: number;
    startX: number;
    startValue: string;
    latestValue: string;
    distance: number;
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

  const resolveDraft = (next: string, baseline: string) => {
    const resolved = styleProperty
      ? normalizeDesignStyleFieldInput(styleProperty, next, baseline)
      : resolveDesignNumericExpression(next, baseline);
    return whole ? roundDesignLayoutValue(resolved) : resolved;
  };

  useEffect(() => {
    if (document.activeElement === inputRef.current || scrubRef.current) return;
    const next = String(value);
    baselineRef.current = next;
    setPresentedDraft(next);
  }, [setPresentedDraft, value]);

  useEffect(
    () => () => {
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

  const commit = async (requestedDraft = draftRef.current) => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      cancelPreview();
      return;
    }
    const baseline = baselineRef.current;
    if (requestedDraft === baseline) {
      cancelPreview();
      return;
    }
    const resolvedDraft = resolveDraft(requestedDraft, baseline);
    if (resolvedDraft !== requestedDraft) setPresentedDraft(resolvedDraft);
    if (resolvedDraft === baseline) {
      cancelPreview();
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

  return (
    <div ref={fieldRef} className="group/design-field relative min-w-0">
      <div
        data-design-inspector-field=""
        data-design-applied={applied ? "" : undefined}
        data-design-style-property={styleProperty}
        data-design-layout-field={compact ? "" : undefined}
        className={cn(
          "flex h-7 min-w-0 items-center overflow-hidden rounded-sm transition-colors",
          compact
            ? "zd-design-layout-field"
            : applied
              ? "zd-design-control-applied"
              : "zd-design-control-quiet",
        )}
      >
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "text-muted-fg hover:text-fg1 flex h-full shrink-0 cursor-ew-resize items-center justify-center text-[10px] font-medium focus-visible:outline-none disabled:cursor-default",
            compact
              ? "w-5"
              : label.length > 4
                ? "max-w-16 min-w-10 px-1.5"
                : "w-7",
          )}
          title={
            whole
              ? `Drag to scrub ${label}. Shift for larger steps.`
              : `Drag to scrub ${label}. Option for decimals; Shift for larger steps.`
          }
          aria-label={`Scrub ${label}`}
          onPointerDown={(event) => {
            const startValue = numericValue ?? baselineRef.current;
            if (scrubDesignNumericValue(startValue, 0) === null) {
              onInspect?.();
              return;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startValue,
              latestValue: startValue,
              distance: 0,
            };
            onInspect?.();
          }}
          onPointerMove={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            const multiplier =
              !whole && event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
            scrub.distance += (event.clientX - scrub.startX) * multiplier;
            scrub.startX = event.clientX;
            const next = scrubDesignNumericValue(
              scrub.startValue,
              scrub.distance,
            );
            if (next === null) return;
            const resolved = whole ? roundDesignLayoutValue(next) : next;
            if (resolved === scrub.latestValue) return;
            scrub.latestValue = resolved;
            setPresentedDraft(resolved);
            preview(resolved);
          }}
          onPointerUp={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            scrubRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void commit(scrub.latestValue);
          }}
          onPointerCancel={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            scrubRef.current = null;
            setPresentedDraft(baselineRef.current);
            cancelPreview();
          }}
        >
          <Label
            htmlFor={id}
            className={cn(
              "pointer-events-none",
              compact ? "text-xs" : "text-[10px]",
            )}
          >
            {icon ? (
              <svg
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                aria-hidden="true"
              >
                {icon === "padding-x" ? (
                  <path d="M3 2v12M13 2v12M6 5v6M10 5v6" />
                ) : icon === "padding-y" ? (
                  <path d="M2 3h12M2 13h12M5 6h6M5 10h6" />
                ) : icon === "gap" ? (
                  <path d="M3 2v12M13 2v12M5 8h6M6 6 4 8l2 2M10 6l2 2-2 2" />
                ) : (
                  <>
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <path d="M5 8h1m1-3h1m-1 6h1m2-3h1" />
                  </>
                )}
              </svg>
            ) : compact && label === "Rotation" ? (
              <svg
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                aria-hidden="true"
              >
                <path d="M2 12h12M3 12l7-9M7 12a4 4 0 0 0-1.5-3" />
              </svg>
            ) : (
              (shortLabel ?? label)
            )}
          </Label>
        </button>
        <Input
          ref={inputRef}
          id={id}
          aria-label={label}
          value={presentation.text}
          placeholder={placeholder}
          disabled={disabled}
          title={hint}
          className={cn(
            "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-1.5 py-0 shadow-none focus-visible:border-transparent",
            compact ? "px-0.5 font-sans text-xs" : "font-mono text-[11px]",
          )}
          onFocus={() => {
            baselineRef.current = String(value);
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
                setPresentedDraft(next);
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
        {compact && styleProperty === "rotate" ? (
          <span className="text-muted-fg pr-2 text-xs">°</span>
        ) : null}
        {compact && percentage ? (
          <span className="text-muted-fg pr-2 text-xs">%</span>
        ) : null}
        {!compact && presentation.unit && unitOptions.length > 0 ? (
          <Select
            value={presentation.unit}
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
              className="zd-design-unit-trigger h-full w-11 shrink-0 gap-0 rounded-none border-0 bg-transparent px-1 text-[10px] shadow-none [&>svg]:size-2.5"
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
        {motion || (!compact && applied) ? (
          <div
            className={cn(
              "zd-design-field-actions absolute top-0 right-0 flex h-full items-center rounded-r-sm",
              (motion?.modeActive || motion?.trackActive) &&
                "zd-design-field-actions-visible",
            )}
            data-has-unit={presentation.unit && !compact ? "true" : undefined}
            data-has-hint={hint ? "true" : undefined}
          >
            {motion ? (
              <Tooltip
                label={
                  motion.trackActive
                    ? `Add ${label} keyframe at the playhead`
                    : `Animate ${label}`
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-6 shrink-0",
                    motion.trackActive &&
                      "text-[var(--design-selection-stroke)]",
                  )}
                  aria-label={
                    motion.trackActive
                      ? `Add ${label} keyframe at the playhead`
                      : `Animate ${label}`
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={motion.onAddKeyframe}
                >
                  <Diamond
                    className={motion.trackActive ? "fill-current" : undefined}
                  />
                </Button>
              </Tooltip>
            ) : null}
            {applied ? (
              <Tooltip label={`Remove authored ${label}`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 shrink-0"
                  aria-label={`Remove authored ${label}`}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    setPresentedDraft("");
                    void commit("");
                  }}
                >
                  <X />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {hint ? (
          <span
            className="bg-highlighted-bright mr-1 size-1.5 shrink-0 rounded-full"
            title={hint}
            aria-label={hint}
          />
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
      percentage={options?.percentage}
      numericValue={
        options?.sizing && details
          ? designLayoutFieldValue(details, property)
          : undefined
      }
      placeholder="-"
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
  const [pendingHistoryActions, setPendingHistoryActions] = useState(0);
  const [cssMode, setCssMode] = useState(false);
  const [provenance, setProvenance] = useState<InspectorProvenanceState | null>(
    null,
  );
  const provenanceAbortRef = useRef<AbortController | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [stylePanelWidth, setStylePanelWidth] = useState(
    readPersistedDesignWorkspaceStyleWidth,
  );
  const inspectorId = workspaceId
    ? `design-style-panel-${workspaceId}`
    : "design-style-panel";

  useLayoutEffect(() => {
    inspectorRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${stylePanelWidth}px`,
    );
  }, [stylePanelWidth]);

  const persistStylePanelWidth = useCallback((next: number) => {
    const committed = persistDesignWorkspaceStyleWidth(next);
    setStylePanelWidth(committed);
    inspectorRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
  }, []);

  const paintCanvasBackground = useCallback((value: string) => {
    const normalized = normalizeDesignCanvasBackground(value);
    if (!normalized) return;
    inspectorRef.current?.parentElement
      ?.querySelector<HTMLElement>("[data-design-canvas-viewport]")
      ?.style.setProperty("background-color", normalized);
  }, []);
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
      // Start every request immediately. applyDesignHistoryCached registers it
      // with the workspace mutation lane before returning its promise, so two
      // fast keypresses become two ordered history steps rather than one being
      // discarded while the first bridge round trip is in flight.
      setPendingHistoryActions((current) => current + 1);
      void queueInspectorAction(() =>
        applyDesignHistoryCached(workspaceId, frame?.file ?? null, direction),
      )
        .then((result) => {
          if (result.historySelection === undefined) return;
          const selected = result.historySelection
            ? (result.snapshot?.frames.find(
                (candidate) => candidate.file === result.historySelection,
              ) ?? null)
            : null;
          void selectDesignFrame(workspaceId, selected, {
            selected: direction === "undo" && selected !== null,
          }).catch((selectionError: unknown) => {
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
    try {
      const screenshot = await captureDesignRuntimeScreenshot(
        workspaceId,
        folder,
        frame.file,
        frame.sourceVersion,
        null,
        1,
      );
      if (!screenshot) {
        throw new Error("The selected frame is not ready to export yet.");
      }
      const result = await exportDesignPng(screenshot.dataUrl, frame.title);
      if (result.saved) {
        toast.success("Design PNG exported", {
          ...(result.path ? { description: result.path } : {}),
        });
      }
    } catch (exportError) {
      toast.error("Couldn't export the design frame", {
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
  const styleEditContextRef = useRef({
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
  });
  const stylePreviewIntentRef = useRef(0);
  styleEditContextRef.current = {
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
  };
  const stylesForNode = useCallback(
    (nodeId: string, styles: Record<string, string | null>) => {
      const context = styleEditContextRef.current;
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
      const context = styleEditContextRef.current;
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
          stylesForNode(nodeId, styles),
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
            styles: stylesForNode(nodeId, styles),
            children: wantsChildren && nodeId === context.selectedNodeId,
          }),
        ),
      );
      if (stylePreviewIntentRef.current !== intent) return;
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
    [stylesForNode],
  );

  const restoreSelectedStylePreview = useCallback(async () => {
    const context = styleEditContextRef.current;
    if (!context.workspaceId || !context.folder || !context.frame) return;
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
    if (stylePreviewIntentRef.current !== intent) return;
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
    if (stylePreviewIntentRef.current !== intent) return;
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
  }, []);

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
    [stylesForNode],
  );

  const previewLayoutAction = useCallback(
    async (action: DesignLayoutAction) => {
      const context = styleEditContextRef.current;
      if (!context.workspaceId || !context.frame) return;
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
    [],
  );

  const commitLayoutAction = useCallback(
    (action: DesignLayoutAction): Promise<void> => {
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
        if (rootStyles && action.type === "sizing" && action.mode === "fixed") {
          rootStyles[action.axis === "x" ? "width" : "height"] =
            action.axis === "x" ? "100%" : "100vh";
        }
        if (
          rootStyles &&
          action.type === "auto-layout" &&
          action.flow === "none"
        ) {
          rootStyles.width = "100%";
          rootStyles.height = "100vh";
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
    [],
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
          compact={options?.compact}
          disabled={pendingHistoryActions > 0}
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
              if (number < 1)
                throw new Error("Enter a frame size of at least one pixel.");
              await applyDesignEditCached(
                styleContext.workspaceId,
                styleContext.frame,
                {
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
                      styles: {
                        [geometryKey === "w" ? "width" : "height"]:
                          geometryKey === "w" ? "100%" : "100vh",
                      },
                      scope: "auto",
                      responsiveContext: "base",
                      stateContext: "default",
                    },
                    {
                      operationId: `layout:${crypto.randomUUID()}`,
                      type: "frame.set-geometry",
                      frame: styleContext.frame.file,
                      geometry: {
                        x: styleContext.frame.x,
                        y: styleContext.frame.y,
                        width:
                          geometryKey === "w"
                            ? Math.round(number)
                            : styleContext.frame.width,
                        height:
                          geometryKey === "h"
                            ? Math.round(number)
                            : styleContext.frame.height,
                        z: styleContext.frame.z,
                      },
                    },
                  ],
                },
              );
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
        disabled={pendingHistoryActions > 0}
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

  const inspectorSelectionHeader = (
    <section className="border-border1 shrink-0 border-b">
      <div
        data-design-inspector-header=""
        className="flex h-10 min-w-0 items-center gap-1 px-3"
      >
        <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
          {styleNodeIds.length > 1
            ? `${styleNodeIds.length} layers`
            : elementDetails
              ? designRuntimeLayerLabel(elementDetails)
              : frameSelected && frame
                ? designFrameLayerLabel(frame.kind)
                : selectedNodeId
                  ? "Nothing selected"
                  : "Page"}
        </span>
        {frameSelected || selectedNodeId ? (
          <Tooltip label="Export PNG">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!frame || !folder || frameAction !== null}
              aria-label="Export PNG"
              onClick={() => void exportPng()}
            >
              <Download />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </section>
  );

  return (
    <aside
      ref={inspectorRef}
      id={inspectorId}
      data-design-inspector=""
      {...popoverBoundaryProps}
      className="border-border1 bg-bg1 relative flex w-[var(--zeros-design-style-width,280px)] max-w-[min(640px,50%)] min-w-[min(220px,45%)] [flex:0_1_var(--zeros-design-style-width,280px)] flex-col overflow-hidden border-l"
    >
      <DesignPanelResizeHandle
        panelRef={inspectorRef}
        edge="left"
        value={stylePanelWidth}
        defaultValue={DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT}
        minimum={DESIGN_WORKSPACE_STYLE_WIDTH_MIN}
        maximum={DESIGN_WORKSPACE_STYLE_WIDTH_MAX}
        clampValue={clampDesignWorkspaceStyleWidth}
        onCommit={persistStylePanelWidth}
        ariaLabel="Resize Style panel"
        controlsId={inspectorId}
      />
      <div
        data-design-style-panel-header=""
        className="border-border1 bg-bg1 flex h-10 shrink-0 items-center justify-between border-b px-2"
      >
        <span className="bg-bg2 text-fg1 flex h-7 items-center rounded-md px-2.5 text-xs font-medium">
          Style
        </span>
        <div className="flex items-center gap-1">
          {workspaceId ? <DesignReviewDialog key={workspaceId} workspaceId={workspaceId} folder={folder} active={active} queueAction={queueInspectorAction} /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 min-w-14 px-2 font-mono text-xs tabular-nums"
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
      </div>
      {cssMode && styleContext && elementDetails ? (
        <div
          data-design-style-panel-css-mode=""
          className="flex min-h-0 flex-1 flex-col"
        >
          {inspectorSelectionHeader}
          <DesignComputedCssEditor
            key={`${frame!.file}:${styleNodeIds.join(":")}:css`}
            details={elementDetails}
            disabled={pendingHistoryActions > 0}
            onPreviewStyles={previewSelectedStyles}
            onCancelStylePreview={clearSelectedStylePreview}
            onCommitStyles={commitSelectedStyles}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            {inspectorSelectionHeader}

            {styleTargetNodeId && errors.length > 0 ? (
              <section className="text-red-primary flex min-h-8 items-center gap-2 px-3 py-1.5">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span
                  className="min-w-0 flex-1 truncate text-[10px]"
                  title={`${firstBlockingReason}: ${errors[0]?.message}`}
                >
                  {errors.length} blocking · {firstBlockingReason}
                </span>
              </section>
            ) : null}

            {styleContext && elementDetails ? (
              <DesignStyleEditor
                key={`${styleContext.workspaceId}:${frame!.file}:${styleNodeIds.join(":")}`}
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
                disabled={pendingHistoryActions > 0}
                onPreviewStyles={previewSelectedStyles}
                onCancelStylePreview={clearSelectedStylePreview}
                onCommitStyles={commitSelectedStyles}
                motionTimelineOpen={motionTimelineOpen}
                motionProperties={motionProperties}
                onOpenMotionTimeline={onOpenMotionTimeline}
              />
            ) : workspaceId && !frameSelected && !selectedNodeId ? (
              <DesignCanvasBackgroundEditor
                value={canvasBackground}
                disabled={!active}
                onPreview={previewCanvasBackground}
                onCancelPreview={cancelCanvasBackgroundPreview}
                onCommit={commitCanvasBackground}
              />
            ) : frame && workspaceId ? (
              <section className="border-border1 flex flex-col gap-3 border-b p-3">
                <span className="text-fg2 text-xs font-medium">
                  Frame position &amp; size
                </span>
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
              </section>
            ) : null}
          </div>
        </ScrollArea>
      )}
      <div
        data-design-style-panel-footer=""
        className="border-border1 bg-bg1 flex h-12 shrink-0 items-center justify-end border-t px-2"
      >
        <Button
          type="button"
          variant={cssMode ? "default" : "ghost"}
          size="sm"
          disabled={!styleContext && !cssMode}
          aria-label="CSS"
          aria-pressed={cssMode}
          onClick={() => setCssMode((current) => !current)}
        >
          CSS
        </Button>
      </div>
    </aside>
  );
}
