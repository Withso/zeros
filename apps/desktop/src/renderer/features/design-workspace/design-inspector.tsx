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
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { exportDesignPng } from "../../platform/design";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { openDesignFramePreview } from "../../platform/bridge/design-context-bridge";
import { shellOpenUrl } from "../../platform/app";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
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
import {
  dispatchFocusedDesignHistory,
  isDesignHistoryFocusOwner,
  isDesignTextEntryTarget,
  isNativeHistoryTarget,
  registerDesignHistoryCommand,
} from "./state/design-history-commands";
import { useDesignHistoryStep } from "./use-design-history-step";
import {
  designAutoLayoutFlow,
  designAutoLayoutUpdates,
  designInferredAutoLayoutFlow,
  designFrameRootFixedStyles,
  designHugFrameSize,
  designSizingMode,
  designRelativeSizeStyles,
  designSizingStyles,
  hasDesignIntrinsicSize,
} from "./design-auto-layout-values";
import { normalizeDesignCanvasBackground } from "./design-canvas-background";
import { DesignCanvasBackgroundEditor } from "./design-canvas-background-editor";
import { DesignPagePicker } from "./design-page-picker";
import { restoreDesignPageHistorySelection } from "./state/design-page-history";
import { DesignComputedCssEditor } from "./design-computed-css-editor";
import {
  DesignTokenCatalogContext,
  DesignTokenDetachContext,
  useDesignFrameTokenCatalog,
} from "./design-token-context";
import {
  designTokenFieldTypes,
  type DesignTokenType,
} from "./design-token-catalog";
import {
  DesignTokenDetachButton,
  DesignTokenPill,
  useDesignTokensFor,
  type DesignFieldToken,
} from "./design-token-picker";
import { DesignFieldOverlays } from "./design-style-card";
import { useDesignFieldOverlays } from "./design-field-overlays";
import { DesignStyledByLine } from "./design-styled-by";
import {
  DesignFieldOriginsContext,
  designFieldOrigins,
  designResetStyles,
  useDesignFieldOrigin,
  useDesignStyleOriginsContext,
} from "./design-field-origins";
import {
  DesignStyleOriginLabelContext,
  designDetachedStyles,
  designSelectionStyleUpdates,
  designStyleTokenDisplay,
  useDesignStyleOriginLabel,
  type DesignStyleOriginLabel,
} from "./design-style-provenance";
import {
  InspectorGlyph,
  InspectorSection,
  InspectorSelect,
} from "./design-inspector-kit";
import {
  designFrameDisplayName,
  designFrameLayerLabel,
  designRuntimeLayerDisplayName,
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
  designScrubStep,
  scrubDesignNumericValue,
  scrubDesignSteppedValue,
  withDesignPositionContext,
} from "./design-style-values";
import { designFieldMixed, designValuesMixed } from "./design-style-mixed";
import { dispatchDesignWorkspaceShortcut } from "./design-workspace-shortcuts";
import {
  publishDesignLivePreviewStyles,
  useDesignFrameGeometryLiveValue,
  useDesignLivePreviewValue,
  type DesignFrameGeometryLiveKey,
} from "./state/design-live-preview";
import { useShallow } from "zustand/react/shallow";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import {
  beginDesignHistorySelection,
  captureDesignRuntimeScreenshot,
  clearDesignNodeStylePreviewTransient,
  previewDesignNodeGeometry,
  settleDesignHistorySelection,
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
  placeholder?: string;
  styleProperty?: string;
  /** Properties the field writes with styleProperty, such as both sides of
   * Horizontal padding; Reset covers them too. */
  linkedProperties?: readonly string[];
  whole?: boolean;
  /** Bounds a plain numeric value: typed, stepped or scrubbed input settles
   * on the nearest allowed value instead of failing on commit. */
  range?: { min: number; max: number };
  compact?: boolean;
  /** A design token the winning declaration reads, shown as a pill in
   * place of the value while the field is unfocused and unedited. */
  token?: DesignFieldToken;
  /** The token types this field takes; null offers no picker. */
  tokenAccepts?: readonly DesignTokenType[] | null;
  onDetachToken?: () => void;
  motion?: {
    modeActive: boolean;
    trackActive: boolean;
    onAddKeyframe: () => void;
  };
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

export function InspectorEditField({
  numericValue,
  icon,
  shortLabel,
  suffix: fieldSuffix,
  percentage,
  label,
  value,
  applied = false,
  disabled = false,
  placeholder,
  styleProperty,
  linkedProperties,
  whole = false,
  range,
  compact = false,
  token,
  tokenAccepts = null,
  onDetachToken,
  motion,
  onPreview,
  onCancelPreview,
  onCommit,
}: InspectorEditFieldProps) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  /** A key typed on the pill: the field edits a plain value until it settles. */
  const [typingOverToken, setTypingOverToken] = useState(false);
  const tokensOffered = useDesignTokensFor(tokenAccepts);
  const overlays = useDesignFieldOverlays();
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const baselineRef = useRef(String(value));
  /** The value shown when this field took focus. */
  const focusValueRef = useRef(String(value));
  const skipCommitRef = useRef(false);
  const historyStep = useDesignHistoryStep();
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
  /** The newest value asked for while this frame's preview already left. */
  const pendingPreviewRef = useRef<string | null>(null);
  const previewDirtyRef = useRef(false);
  const cancelPreviewRef = useRef(onCancelPreview);
  cancelPreviewRef.current = onCancelPreview;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
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
      // An equal presentation keeps its identity, so a mounted field that
      // adopts the value it was initialized with schedules no render.
      const presented = inspectorFieldPresentation(styleProperty, next, whole);
      setPresentation((current) =>
        current.text === presented.text && current.unit === presented.unit
          ? current
          : presented,
      );
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
  /** One pointer pixel or arrow press, in the value's own unit. */
  const scrubStepFor = (start: string, fine: boolean) => {
    const scrubStep = whole
      ? { step: 1, fine: null }
      : designScrubStep(styleProperty, parseDesignStyleNumericParts(start)?.unit ?? "");
    return fine && scrubStep.fine !== null ? scrubStep.fine : scrubStep.step;
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
    if (scrubRef.current) return;
    const focused = document.activeElement === inputRef.current;
    // The one focused case that adopts at once: this field's own undo or redo,
    // and only while the field holds no draft the person started.
    if (
      focused &&
      (draftRef.current !== baselineRef.current || !historyStep.handedBack())
    ) return;
    const next = String(value);
    baselineRef.current = next;
    if (focused) focusValueRef.current = next;
    setPresentedDraft(next);
  }, [historyStep, setPresentedDraft, value]);

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

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!typingOverToken || !input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [typingOverToken]);

  const typeOverToken = (key: string | null) => {
    setTypingOverToken(true);
    if (key !== null) setPresentedDraft(key);
  };

  const cancelPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    pendingPreviewRef.current = null;
    if (!previewDirtyRef.current) return;
    previewDirtyRef.current = false;
    void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
  };

  const finishCommittedPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    pendingPreviewRef.current = null;
    // Preserve the last exact live scalar until the authoritative source
    // generation arrives. Clearing here causes a visible value snap-back.
    previewDirtyRef.current = false;
  };

  /** The first value of a scrub or drag previews at once; later ones within
   * the same frame coalesce into the newest, sent on the next frame. Waiting a
   * frame before the first one added a frame of lag to every scrub. */
  const preview = (next: string) => {
    if (!onPreview) return;
    previewDirtyRef.current = true;
    if (previewFrameRef.current !== null) {
      pendingPreviewRef.current = next;
      return;
    }
    void Promise.resolve(onPreview(next)).catch(() => {});
    const trailing = () => {
      previewFrameRef.current = null;
      const pending = pendingPreviewRef.current;
      if (pending === null) return;
      pendingPreviewRef.current = null;
      void Promise.resolve(onPreviewRef.current?.(pending)).catch(() => {});
      previewFrameRef.current = window.requestAnimationFrame(trailing);
    };
    previewFrameRef.current = window.requestAnimationFrame(trailing);
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
  // A token reads as the value only while nothing is being edited.
  const tokenShown =
    Boolean(token) && !typingOverToken && !focused && draft === String(value);
  const showUnit =
    !compact && !tokenShown && Boolean(presentation.unit) && unitOptions.length > 0;
  const motionPersistent = Boolean(motion?.trackActive);
  const origin = useDesignFieldOrigin(styleProperty);

  return (
    <div
      ref={fieldRef}
      data-design-filter-out={origin.hidden ? "" : undefined}
      className="group/design-field relative min-w-0"
    >
      <div
        data-design-inspector-field=""
        data-design-applied={applied ? "" : undefined}
        data-design-style-property={styleProperty}
        data-design-linked-properties={linkedProperties?.length ? linkedProperties.join(" ") : undefined}
        data-design-field-label={label}
        data-design-origin={origin.mark}
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
            if (scrubDesignNumericValue(startValue, 0) === null) return;
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
                const unitStep = scrubStepFor(scrub.startValue, pointerEvent.altKey);
                scrub.distance +=
                  (pointerEvent.clientX - scrub.startX) * unitStep * (pointerEvent.shiftKey ? 10 : 1);
                scrub.startX = pointerEvent.clientX;
                const next = scrubDesignSteppedValue(
                  scrub.startValue,
                  scrub.distance,
                  unitStep,
                );
                if (next === null) return;
                const resolved = withinRange(next);
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
          }}
        >
          <Label htmlFor={id} className="pointer-events-none text-inherit">
            {glyph ? <InspectorGlyph name={glyph} /> : labelText}
          </Label>
        </button>
        {tokenShown && token ? (
          <span className="flex min-w-0 flex-1 items-center pr-1">
            <DesignTokenPill
              ref={pillRef}
              label={label}
              token={token}
              disabled={disabled}
              onType={typeOverToken}
              {...(tokensOffered
                ? {
                    // The panel's one picker keeps aria-expanded current.
                    "aria-haspopup": "dialog" as const,
                    "aria-expanded": false,
                    "aria-keyshortcuts": "Alt+ArrowDown",
                    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                      const field = event.currentTarget.closest<HTMLElement>("[data-design-style-property]");
                      if (field) overlays.openPickerForField(field, event.currentTarget);
                    },
                  }
                : { onClick: () => typeOverToken(null) })}
            />
          </span>
        ) : (
        <Input
          ref={inputRef}
          id={id}
          aria-label={label}
          data-design-draft={draft === String(value) ? "clean" : "dirty"}
          value={presentation.text}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent py-0 pl-0 font-sans text-xs shadow-none focus-visible:border-transparent",
            applied ? "text-fg1" : "text-fg2",
            (suffix && !tokenShown) || showUnit ? "pr-1" : "pr-2",
          )}
          onFocus={() => {
            setFocused(true);
            historyStep.drop();
            baselineRef.current = String(value);
            focusValueRef.current = String(value);
          }}
          onChange={(event) => {
            // Deliberately local. A canvas write per keystroke reflowed the
            // document on every character — and on a backspace it removed the
            // declaration outright before the next digit put it back.
            const text = event.target.value;
            historyStep.drop();
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
            setFocused(false);
            setTypingOverToken(false);
            if (
              unitMenuOpenRef.current ||
              fieldRef.current?.contains(event.relatedTarget)
            ) {
              return;
            }
            void commit();
          }}
          aria-keyshortcuts={tokensOffered ? "Alt+ArrowDown" : undefined}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const normalized = resolveDraft(draft, baselineRef.current);
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const start = parseDesignStyleNumericParts(normalized)
                ? normalized
                : (numericValue ?? normalized);
              const unitStep = scrubStepFor(start, event.altKey);
              const next = scrubDesignSteppedValue(
                start,
                direction * unitStep * (event.shiftKey ? 10 : 1),
                unitStep,
              );
              if (next !== null) {
                event.preventDefault();
                setPresentedDraft(withinRange(next));
              }
            } else if (
              event.key === "Backspace" &&
              event.altKey &&
              !event.metaKey &&
              !event.ctrlKey
            ) {
              // Reset: the draft is dropped so blur cannot write it back.
              event.preventDefault();
              skipCommitRef.current = true;
              setPresentedDraft(String(value));
              cancelPreview();
              const input = event.currentTarget;
              input.blur();
              overlays.resetField(input);
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
        )}
        {suffix && !tokenShown ? <span className="zd-field-suffix">{suffix}</span> : null}
        {tokenShown && token ? (
          <span
            className="zd-field-token-detach"
            data-design-token-action={token.missing ? "always" : "hover"}
            data-design-token-motion={motion ? "" : undefined}
          >
          <DesignTokenDetachButton
            disabled={disabled}
            onDetach={() => {
              if (onDetachToken) {
                onDetachToken();
                return;
              }
              // The token's resolved value, written as a plain value; an
              // empty reading would remove the declaration instead.
              if (!String(value).trim()) {
                toast.error("Couldn't detach the token", {
                  description: "The layer has not reported its value yet.",
                });
                return;
              }
              void onCommit(String(value)).catch((fieldError) =>
                toast.error(`Couldn't update ${label.toLowerCase()}`, {
                  description: errorMessage(fieldError),
                }),
              );
            }}
          />
          </span>
        ) : null}
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
        {motion ? (
          <div
            className={cn(
              "zd-field-motion absolute inset-y-0 right-0 flex items-center",
              motionPersistent && "zd-field-motion-active",
            )}
          >
            <Tooltip
              label={motion.trackActive ? "Add keyframe" : "Animate"}
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

/** A frame's X, Y, W or H: its saved value, or the one a drag or resize on
 * the canvas is painting right now. Only this field subscribes to the gesture. */
function InspectorFrameGeometryField({
  workspaceId,
  frame,
  geometryKey,
  saved,
  ...field
}: Omit<InspectorEditFieldProps, "value" | "numericValue"> & {
  workspaceId: string;
  frame: string;
  geometryKey: DesignFrameGeometryLiveKey;
  saved: number;
}) {
  const shown = useDesignFrameGeometryLiveValue(workspaceId, frame, geometryKey) ?? saved;
  return <InspectorEditField {...field} value={shown} />;
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
  originLabel,
  onLayoutAction,
  onPreviewLayoutAction,
  disabled,
  applied,
  onPreviewStyles,
  onCancelPreview,
  onCommitStyles,
  motionModeActive,
  motionTrackActive,
  onAddMotionKeyframe,
  onDetachToken,
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
  originLabel?: DesignStyleOriginLabel;
  onLayoutAction?: (action: DesignLayoutAction) => Promise<void>;
  onPreviewLayoutAction?: (action: DesignLayoutAction) => Promise<void>;
  disabled?: boolean;
  applied: boolean;
  onPreviewStyles: (
    styles: Record<string, string | null>,
  ) => void | Promise<void>;
  onCancelPreview: () => void | Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
  motionModeActive: boolean;
  motionTrackActive: boolean;
  onAddMotionKeyframe: (property: string, value: string) => void;
  /** Writes each selected layer's own resolved value over its token. */
  onDetachToken?: (properties: readonly string[]) => void;
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
  // Several layers that differ show the Mixed placeholder until a preview
  // or an edit gives the field one value for all of them.
  if (options?.mixed && liveValue === undefined) displayedValue = "";
  // Measured geometry (X, Y, rotation) never shows a token; a live preview
  // shows its own value, and differing layers read Mixed.
  const tokenAccepts = designTokenFieldTypes(property);
  const ownToken =
    tokenAccepts && !options?.mixed && !options?.tokenHidden && liveValue === undefined && originLabel
      ? designStyleTokenDisplay(details, property, originLabel)
      : null;
  // A paired field (horizontal padding) shows a pill only when every side
  // it edits reads the same token.
  const token =
    ownToken &&
    (options?.linkedProperties ?? []).every(
      (linked) => designStyleTokenDisplay(details, linked, originLabel!)?.name === ownToken.name,
    )
      ? ownToken
      : null;
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
      placeholder={options?.mixed ? "Mixed" : (options?.placeholder ?? "–")}
      styleProperty={property}
      linkedProperties={options?.linkedProperties}
      whole={options?.whole}
      compact={options?.compact}
      token={
        token
          ? {
              name: token.name,
              missing: !token.value.trim(),
            }
          : undefined
      }
      tokenAccepts={tokenAccepts}
      onDetachToken={
        onDetachToken
          ? () => onDetachToken([property, ...(options?.linkedProperties ?? [])])
          : undefined
      }
      disabled={disabled}
      applied={applied}
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

export const DesignInspector = React.memo(function DesignInspector({
  workspaceId,
  pages,
  activePageId,
  pageFrames,
  folder,
  frame,
  frameSelected,
  details,
  selectedNode,
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
  const styleOriginLabel = useDesignStyleOriginLabel(workspaceId);
  const tokenCatalog = useDesignFrameTokenCatalog(workspaceId, frame?.file);
  // Cloud workspaces have no Design preview; the control stays visible and inert.
  const previewAllowed = !isCloudWorkspace(workspaceId);
  const previewDirectoryId = useDesignWorkspaceUiStore(state =>
    workspaceId ? state.byWorkspace[workspaceId]?.directoryId : undefined,
  );
  const previewOwner = useMemo(() => ({
    active, workspaceId, directoryId: previewDirectoryId,
    file: frame?.file, frameId: frame?.frameId,
  }), [active, workspaceId, previewDirectoryId, frame?.file, frame?.frameId]);
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
      await shellOpenUrl(result.previewUrl);
    } catch (error) {
      if (previewOwnerRef.current === previewOwner)
        toast.error("Couldn’t open frame preview", { description: errorMessage(error) });
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
      void queueInspectorAction(() => {
        beginDesignHistorySelection(workspaceId);
        return applyDesignHistoryCached(workspaceId, frame?.file ?? null, direction);
      })
        .then((result) => {
          // A frame-level step restores its own frame selection below; an
          // in-document step brings back the node selection of the state it
          // returns to.
          settleDesignHistorySelection(workspaceId, result.historySelection === undefined ? result.historyFrame ?? null : null);
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


  const historyActionRef = useRef(runHistory);
  const historyDirectoryRevision = useDesignWorkspaceUiStore(state => workspaceId ? state.byWorkspace[workspaceId]?.directoryRevision : undefined);
  useLayoutEffect(() => { historyActionRef.current = runHistory; }, [runHistory]);
  useLayoutEffect(() => {
    if (!active || !workspaceId) return;
    const root = inspectorRef.current?.closest("[data-design-workspace-surface]");
    if (!root) return;
    return registerDesignHistoryCommand({
      workspaceId, root,
      isCurrent: () => useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.directoryRevision === historyDirectoryRevision,
      run: (direction) => historyActionRef.current(direction),
    });
  }, [active, workspaceId, historyDirectoryRevision]);

  // The layout commit is defined below with the style owner it captures.
  const layoutShortcutRef = useRef<(action: DesignLayoutAction) => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    if (!active || !workspaceId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Review owns its keyboard, including portaled filter options. This
      // capture listener runs before a dialog's React handlers can intercept
      // the event; keep document undo/save out of that modal interaction.
      if (
        (event.metaKey || event.ctrlKey) &&
        document.querySelector('[data-design-review][data-state="open"]')
      ) return;
      if (event.defaultPrevented || !isDesignHistoryFocusOwner(workspaceId, true)) return;
      const editableTarget = isNativeHistoryTarget(event.target);
      if (!isDesignTextEntryTarget(event.target) && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
        event.key.toLowerCase() === "a") {
        // Figma's Shift+A. The motion timeline is Shift+M.
        event.preventDefault();
        void layoutShortcutRef.current({ type: "auto-layout", flow: "column", infer: true }).catch((error: unknown) =>
          toast.error("Couldn't add auto layout", { description: errorMessage(error) }));
        return;
      }
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
        undo: () => { dispatchFocusedDesignHistory("undo"); },
        redo: () => { dispatchFocusedDesignHistory("redo"); },
      });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, workspaceId, saveDesignChanges]);

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
  // Exactly the styled nodes' readbacks and the frame root id: hover reads,
  // screenshots and other nodes' details must not re-render every field.
  const styleNodeDetails = useDesignRuntimeStore(useShallow((state) => {
    const frameState = workspaceId && frame
      ? state.byWorkspace[workspaceId]?.frames[frame.file]
      : undefined;
    return styleNodeIds.map((nodeId) => frameState?.detailsByNode[nodeId] ?? null);
  }));
  const layoutRootId = useDesignRuntimeStore((state) =>
    workspaceId && frame
      ? state.byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.frame.oid
      : undefined,
  );
  const layoutParents = useMemo(
    () =>
      styleNodeIds.flatMap((nodeId, index) => {
        const node =
          nodeId === elementDetails?.oid
            ? elementDetails
            : styleNodeDetails[index];
        return node && node.sourceVersion === elementDetails?.sourceVersion
          ? [node]
          : [];
      }),
    [elementDetails, styleNodeDetails, styleNodeIds],
  );
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
  const originsContext = useDesignStyleOriginsContext(workspaceId);
  // The Styled-by filter belongs to the selection it was chosen for.
  const [sourceFilter, setSourceFilter] = useState<{ owner: string; key: string } | null>(null);
  const sourceFilterKey = sourceFilter?.owner === styleOwnerKey ? sourceFilter.key : null;
  const fieldOrigins = useMemo(
    () => designFieldOrigins(layoutParents, originsContext, sourceFilterKey),
    [layoutParents, originsContext, sourceFilterKey],
  );
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
    (
      styles: Record<string, string | null>,
      /** Each layer's own values for the same properties, such as the value
       * a token resolves to on that layer. */
      perNode?: (nodeId: string) => Record<string, string | null>,
    ): Promise<void> => {
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
      const updates = designSelectionStyleUpdates(styleNodeIds, styles, perNode).map(
        (update) => ({ nodeId: update.nodeId, styles: stylesForNode(update.nodeId, update.styles) }),
      );
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
            intent: `Set ${properties.join(", ")} on ${updates.length} layers`,
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

  /** Detach: every selected layer keeps the value its token resolves to on
   * that layer, in one undoable step. */
  const detachSelectedToken = useCallback(
    (properties: readonly string[]) => {
      const context = styleEditContextRef.current;
      const updates = designDetachedStyles(context.styleNodeIds, properties, (nodeId, property) => {
        const details =
          (context.workspaceId && context.frame
            ? useDesignRuntimeStore.getState().byWorkspace[context.workspaceId]
                ?.frames[context.frame.file]?.detailsByNode[nodeId]
            : undefined) ??
          (nodeId === context.elementDetails?.oid ? context.elementDetails : undefined);
        return details ? readDesignComputedStyle(details.styles, property) : undefined;
      });
      if (updates.length === 0) {
        toast.error("Couldn't detach the token", {
          description: "The selected layers have not reported their values yet.",
        });
        return;
      }
      const byNode = new Map(updates.map((update) => [update.nodeId, update.styles]));
      void commitSelectedStyles(
        Object.assign({}, ...updates.map((update) => update.styles)),
        (nodeId) => byNode.get(nodeId) ?? {},
      ).catch((error) =>
        toast.error("Couldn't detach the token", { description: errorMessage(error) }),
      );
    },
    [commitSelectedStyles],
  );

  const layoutParentsRef = useRef(layoutParents);
  layoutParentsRef.current = layoutParents;
  const originsContextRef = useRef(originsContext);
  originsContextRef.current = originsContext;
  const chooseFieldToken = useCallback(
    (properties: readonly string[], name: string, companion?: Record<string, string>) => {
      const next = `var(${name})`;
      void commitSelectedStyles({
        ...companion,
        ...Object.fromEntries(properties.map((property) => [property, next])),
      }).catch((error) =>
        toast.error("Couldn't use the token", { description: errorMessage(error) }),
      );
    },
    [commitSelectedStyles],
  );
  /** Reset: each selected layer's own declaration for the field, removed
   * whole in one step, so its class or component value shows again. */
  const resetField = useCallback(
    (properties: readonly string[]) => {
      const updates = designResetStyles(layoutParentsRef.current, originsContextRef.current, properties);
      if (updates.length === 0) {
        toast("Nothing to reset", {
          description: "No selected layer changes this value over its class or component.",
        });
        return;
      }
      const byNode = new Map(updates.map((update) => [update.nodeId, update.styles]));
      void commitSelectedStyles(
        Object.assign({}, ...updates.map((update) => update.styles)),
        (nodeId) => byNode.get(nodeId) ?? {},
      ).catch((error) =>
        toast.error("Couldn't reset the value", { description: errorMessage(error) }),
      );
    },
    [commitSelectedStyles],
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
          // Shift+A leaves an existing layout, and a layer with nothing to
          // lay out, exactly as they are.
          if (action.type === "auto-layout" && action.infer &&
            (liveChildren.length === 0 || details.some((node) => designAutoLayoutFlow(node) !== "none"))) return;
          updates =
            action.type === "auto-layout"
              ? designAutoLayoutUpdates(details, liveChildren,
                  action.infer ? designInferredAutoLayoutFlow(liveChildren) : action.flow)
              : designLayoutChildUpdates(details, liveChildren, action);
        } else if (action.type === "sizing" && action.mode === "relative") {
          // A percentage resolves against the parent, so each layer reads its
          // own parent's padding.
          const parents = await Promise.all(
            details.map((node) =>
              node.layout?.parentId
                ? runtime.getNodeDetails(node.layout.parentId)
                : Promise.resolve(null),
            ),
          );
          updates = new Map(
            details.map((node, index) => [
              node.oid,
              designRelativeSizeStyles(node, parents[index] ?? null, action.axis),
            ]),
          );
        } else if (action.type === "sizing") {
          const { mode } = action;
          if (mode === "relative") return;
          updates = new Map(
            details.map((node) => [
              node.oid,
              designSizingStyles(node, action.axis, mode),
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
  useLayoutEffect(() => { layoutShortcutRef.current = commitLayoutAction; }, [commitLayoutAction]);

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
        <InspectorFrameGeometryField
          key={`${styleContext.workspaceId}:${styleContext.frame.file}:frame:${geometryKey}`}
          workspaceId={styleContext.workspaceId}
          frame={styleContext.frame.file}
          geometryKey={geometryKey}
          saved={geometryValue}
          label={label}
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
    // The same value from different tokens is Mixed too: a pill shows only
    // when every selected layer names one token.
    const mixed =
      options?.mixed ||
      designFieldMixed(layoutParents, styleNodeIds.length, property, {
        geometry: options?.geometry,
        whole: options?.whole,
        linkedProperties: options?.linkedProperties,
      }) ||
      designValuesMixed(
        layoutParents.map(
          (node) => designStyleTokenDisplay(node, property, styleOriginLabel)?.name ?? "",
        ),
        styleNodeIds.length,
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
        options={mixed ? { ...options, mixed } : options}
        details={elementDetails ?? undefined}
        originLabel={styleOriginLabel}
        onLayoutAction={commitLayoutAction}
        onPreviewLayoutAction={previewLayoutAction}
        disabled={!active || pendingHistoryActions > 0}
        applied={applied}
        motionModeActive={motionTimelineOpen}
        motionTrackActive={motionProperties.includes(property)}
        onAddMotionKeyframe={onOpenMotionTimeline}
        onPreviewStyles={previewSelectedStyles}
        onCancelPreview={clearSelectedStylePreview}
        onCommitStyles={commitSelectedStyles}
        onDetachToken={detachSelectedToken}
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
            ? selectedNode?.oid === selectedNodeId
              ? designRuntimeLayerLabel(selectedNode)
              : "Nothing selected"
            : "Page";
  // The layer's own name, as in Layers; the type sits beside it when the name
  // says something else. `selectionName` stays the type, as the glyph and
  // `data-design-selection-type` read it.
  const selectionTitle =
    styleNodeIds.length > 1
      ? null
      : frameSelected && frame && !selectedNodeId
        ? designFrameDisplayName(frame)
        : selectedNode && selectedNodeId && selectedNode.oid === selectedNodeId
          ? designRuntimeLayerDisplayName(selectedNode)
          : elementDetails
            ? designRuntimeLayerDisplayName(elementDetails)
            : null;
  const selectionType =
    selectionTitle && selectionTitle !== selectionName ? selectionName : null;
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
        data-design-selection-type={selectionName}
        className="flex h-9 min-w-0 items-center gap-2 pr-1.5 pl-3"
      >
        {selectionName === "Page" && workspaceId && pages?.length ? (
          <DesignPagePicker workspaceId={workspaceId} directoryId={previewDirectoryId} pages={pages}
            activePageId={activePageId} frames={pageFrames ?? []} active={active} />
        ) : <>
          <SelectionGlyph className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">{selectionTitle ?? selectionName}</span>
          {selectionType ? (
            <span className="text-fg3 shrink-0 text-3xxs leading-4 tabular-nums">{selectionType}</span>
          ) : null}
        </>}
      </div>
    </section>
  );
  const exportSection =
    frame && folder && (frameSelected || selectedNodeId) ? (
      <InspectorSection title="Export" data-design-export-section="">
        <Button type="button" variant="secondary" className="w-full" disabled={openingPreview || !active || !previewAllowed} onClick={() => void openPreview()}>
          <ExternalLink /> Open preview
        </Button>
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
      data-design-source-filter={fieldOrigins.filter ? "" : undefined}
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
            <DropdownMenuContent data-design-history-owner={workspaceId ?? undefined} align="end" className="w-48">
              <DropdownMenuItem
                disabled={zoom >= DESIGN_MAX_ZOOM}
                aria-label="Zoom in"
                onSelect={() => zoomActionsRef.current?.zoomIn()}
              >
                <span>Zoom in</span>
                <DropdownMenuShortcut>
                  +
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={zoom <= DESIGN_MIN_ZOOM}
                aria-label="Zoom out"
                onSelect={() => zoomActionsRef.current?.zoomOut()}
              >
                <span>Zoom out</span>
                <DropdownMenuShortcut>
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
            originLabel={styleOriginLabel}
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
            {styleContext && elementDetails && fieldOrigins.styledBy ? (
              <DesignStyledByLine
                key={styleOwnerKey}
                styledBy={fieldOrigins.styledBy}
                filter={fieldOrigins.filter}
                onFilter={(key) => setSourceFilter(key ? { owner: styleOwnerKey, key } : null)}
              />
            ) : null}

            {styleTargetNodeId && errors.length > 0 ? (
              <Tooltip label={`${firstBlockingReason}: ${errors[0]?.message}`}>
                <section className="bg-red-bg text-red-fg flex min-h-9 shrink-0 items-center gap-2 px-3 py-1.5">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="text-3xxs min-w-0 flex-1 truncate leading-4">
                    {firstBlockingReason}
                  </span>
                </section>
              </Tooltip>
            ) : null}

            {styleContext && elementDetails ? (
              <DesignStyleOriginLabelContext.Provider value={styleOriginLabel}>
                <DesignFieldOriginsContext.Provider value={fieldOrigins}>
                <DesignTokenCatalogContext.Provider value={tokenCatalog}>
                <DesignTokenDetachContext.Provider value={detachSelectedToken}>
                <DesignFieldOverlays
                  rootRef={inspectorRef}
                  active={active}
                  ownerKey={styleOwnerKey}
                  origins={fieldOrigins}
                  disabled={!active || pendingHistoryActions > 0}
                  onChooseToken={chooseFieldToken}
                  onReset={resetField}
                >
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
                    selectionCount={styleNodeIds.length}
                    disabled={!active || pendingHistoryActions > 0}
                    onPreviewStyles={previewSelectedStyles}
                    onCancelStylePreview={clearSelectedStylePreview}
                    onCommitStyles={commitSelectedStyles}
                    motionTimelineOpen={motionTimelineOpen}
                    motionProperties={motionProperties}
                    onOpenMotionTimeline={onOpenMotionTimeline}
                  />
                </DesignFieldOverlays>
                </DesignTokenDetachContext.Provider>
                </DesignTokenCatalogContext.Provider>
                </DesignFieldOriginsContext.Provider>
              </DesignStyleOriginLabelContext.Provider>
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
                    <InspectorFrameGeometryField
                      key={key}
                      workspaceId={workspaceId}
                      frame={frame.file}
                      geometryKey={key}
                      saved={value}
                      label={label}
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
});
