// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import {
  AlertTriangle,
  Component as ComponentGlyph,
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
  useSyncExternalStore,
} from "react";

import {
  DESIGN_FRAME_COORDINATE_LIMIT,
  DESIGN_FRAME_MAX_SIZE,
  DESIGN_TRANSACTION_MAX_OPERATIONS,
  type DesignOperation,
} from "@zeros/design-core";
import type { DesignRuntimeNodeDetails, DesignRuntimeNodeState } from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";

import {
  designFrameRuntime,
  waitForDesignFrameRuntime,
} from "../../platform/bridge/design-frame-runtime";
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
  DropdownMenuSeparator,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
  usePopoverOpenControl,
} from "../../shared/ui/primitives";
import {
  dispatchFocusedDesignHistory,
  isDesignHistoryFocusOwner,
  isDesignTextEntryTarget,
  isNativeHistoryTarget,
  registerDesignHistoryCommand,
} from "./state/design-history-commands";
import { useDesignHistoryStep } from "./use-design-history-step";
import { designShiftAConvertsInPlace } from "./design-frame-insertion";
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
import { designCanvasItemOwner, setDesignCanvasItemSelection } from "./state/design-canvas-item-selection";
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
import { DesignFieldOverlays, readDesignCardField } from "./design-style-card";
import { designInputResetsOnAltBackspace, useDesignFieldOverlays, type DesignFieldOverlaysApi } from "./design-field-overlays";
import { designComputedValueBrief, designControlBoundValueBrief, designForcedValueBrief } from "./design-agent-brief";
import { DesignStyledByLine } from "./design-styled-by";
import { DesignHeldStateNote, DesignStateVariantNote, useDesignHeldReadOnly } from "./design-state-picker";
import { designDeclaredVariants, showDesignComponentVariant, useDesignComponentVariantStore, useDesignShownComponentState } from "./state/design-component-variants";
import { designHeldStateChanges, designStylePropertyLabel } from "./design-style-origins";
import {
  designHeldStateEntry,
  designHeldStateHolds,
  designHeldStateWatch,
  holdDesignNodeState,
  measureDesignLayoutUnheld,
  releaseDesignNodeState,
  releaseDesignNodeStateUnless,
  useDesignHeldStateStore,
} from "./state/design-held-state";
import {
  DesignFieldOriginsContext,
  designFieldOrigins,
  designFieldOriginsWithControls,
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
import { designLayoutSelectionUpdates } from "./design-layout-selection";
import {
  designLayoutActionStyles,
  designLayoutActionForConfirmedDetails,
  designLayoutActionUpdates,
  designLayoutFieldValue,
  designLayoutStepBase,
  roundDesignLayoutValue,
  type DesignLayoutAction,
  type DesignLayoutFieldOptions,
} from "./design-layout-values";
import { blockingDesignLintReason, frameBlockingDesignLintErrors } from "./design-lint-summary";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { DesignStyleEditor } from "./design-style-editor";
import { DesignColorRevalidatingContext } from "./design-color-picker";
import {
  clampDesignStyleFieldValue,
  convertDesignLength,
  designAuthoredLength,
  designLengthBasis,
  designLengthUnitOptions,
  designMixedScrubValues,
  designStyleFieldRefusal,
  designStyleFieldValue,
  evaluateDesignNumericExpression,
  type DesignLengthBasis,
  designStylePropertyAffectsLayout,
  designStyleUnitOptions,
  designStyleCommitCoalesceKey,
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
  clearDesignLivePreview,
  designLivePreviewValue,
  publishDesignLivePreviewStyles,
  useDesignFrameGeometryLiveValue,
  useDesignLivePreviewValue,
  type DesignLivePreviewPublication,
  type DesignFrameGeometryLiveKey,
} from "./state/design-live-preview";
import { useShallow } from "zustand/react/shallow";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { designHandedSelectionPresentation, useDesignSelectionHandoff, type DesignSelectionSubject } from "./state/design-selection-handoff";
import { designLayoutToolsKey, emphasizeDesignLayoutTools } from "./state/design-layout-tools-live";
import { DesignGesturePreview } from "./state/design-gesture-preview";
import {
  beginDesignHistorySelection,
  captureDesignRuntimeScreenshot,
  clearDesignNodeStylePreviewTransient,
  previewDesignNodeGeometry,
  selectDesignTargets,
  setDesignNodeVisibility,
  settleDesignHistorySelection,
} from "./state/design-selection";
import { designComponentPartOf, designComponentSlotOf } from "@zeros/protocol/design-runtime";
import { useDesignHistoryPresentation } from "./state/design-history-presentation";
import { designComponentDisplayTitle, designComponentIdentityLabel, designComponentInstanceIdentity, designComponentSlotLabel, designFrameComponentPresentation,
  designComponentTextLock, designMissingComponentOf, isDesignComponentPartNodeId } from "./state/design-component-parts";
import { designBindingLayerId, designBoundControlsFor, designSizeAxisControls, designControlLabels, designGatedReadPending, designRuntimeBindingsVersion, readDesignGatedBindings, subscribeDesignRuntimeBindings, designLayerBoundStyles, designMainLayerControls, designPartControls, designRuntimeBoundStyles, designSizingTargets, designWithoutBoundStyles, rememberDesignRuntimeBindings } from "./state/design-component-bindings";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import type { DesignComponentOptionsTarget } from "./design-component-options";
import {
  applyDesignEditCached,
  hasPendingDesignRootSizing,
  trackDesignRootSizing,
  applyDesignHistoryCached,
  designWorkspaceSnapshotCache,
  saveDesigns,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
  moveDesignComponentCached, hasPendingDesignEdits } from "./state/design-workspace-cache";
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
import { type DesignCanvasZoomActions, type DesignInspectorProps } from "./design-workspace-types";
import { loadDesignComponentOptions } from "./design-component-options-loader";
import { PanelHeader } from "@/renderer/shared/ui/primitives/panel-header";


// Only a component frame's selection shows Options, so its rows and the Design
// core's option code load on their own; the workspace warms them once it has
// a component frame.
const DesignComponentOptions = React.lazy(() => loadDesignComponentOptions().then((module) => ({ default: module.DesignComponentOptions })));

/** A component's title, as the header names it: its main frame's title, or
 * its tag's name as a sentence for a components/ file. */
function designComponentTitle(workspaceId: string, name: string, component: { file: string; frame: boolean }): string {
  return designComponentDisplayTitle(name, component, (file) =>
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find((candidate) => candidate.file === file)?.title);
}

/** What canvas metadata can store; frame fields settle inside it. */
const DESIGN_FRAME_SIZE_RANGE = { min: 1, max: DESIGN_FRAME_MAX_SIZE };
const DESIGN_FRAME_POSITION_RANGE = {
  min: -DESIGN_FRAME_COORDINATE_LIMIT,
  max: DESIGN_FRAME_COORDINATE_LIMIT,
};
/** A percentage field (opacity) writes 0–100% of its value; the field shows
 * the same bound so a scrub past either end reads what is written. */
const DESIGN_PERCENTAGE_RANGE = { min: 0, max: 100 };
const EMPTY_COMPONENT_DECLARATION = { elements: [], reach: {} };
/** Only a complete numeric entry is a display percentage; functions, keywords
 * and tokens are already CSS values and must not become a numeric conversion. */
const DESIGN_PERCENTAGE_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;

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
  revalidating?: boolean;
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
  /** What the units are measured against: given, the unit menu offers px,
   * and percent and rem where their basis is known, and converts the value. */
  unitBasis?: DesignLengthBasis;
  /** Emptying the field means something here (X, Y and rotation remove the
   * offset or turn); elsewhere an emptied field restores its value. */
  emptyCommits?: boolean;
  /** The layers differ: a scrub or arrow moves each by the same number of
   * steps from its own value while the field keeps reading Mixed. */
  mixedSteps?: {
    preview: (steps: number, fine: boolean) => void;
    /** Returns what the field message should say, if anything. */
    commit: (steps: number, fine: boolean) => string | null;
    cancel: () => void;
  };
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

/** A commit that ends a gesture the user saw previewed, such as a released
 *  scrub, as opposed to an edit computed from the current details. */
interface DesignGestureCommit {
  gesture?: boolean;
}

interface DesignStylePreviewRequest {
  styles: Record<string, string | null>;
  perNode?: (nodeId: string) => Record<string, string | null>;
}

/** Which node a selection styles. A selected frame styles its root, named by
 *  the root's details whatever their generation: after an edit the frame's
 *  generation advances before its details are read again, and dropping the
 *  target then would remount every field and discard a value being typed.
 *  Edits still wait for details at the current generation. */
export function designStyleTargetNodeId({
  selectedNodeId,
  frameSelected,
  explicitFrameIdentityNodeId,
  legacyExactInstanceNodeId,
  layoutRootId,
  details,
}: {
  selectedNodeId: string | null;
  frameSelected: boolean;
  explicitFrameIdentityNodeId: string | null;
  legacyExactInstanceNodeId: string | null;
  layoutRootId: string | undefined;
  details: { oid: string } | null | undefined;
}): string | null {
  if (selectedNodeId) return selectedNodeId;
  if (!frameSelected) return null;
  return explicitFrameIdentityNodeId ?? legacyExactInstanceNodeId ??
    (details && details.oid === layoutRootId ? details.oid : null);
}

function inspectorCanvasViewport(from: Element): HTMLElement | null {
  return (from.closest("[data-design-workspace-surface]") ?? document.querySelector("[data-design-workspace-surface]:not([inert])"))
    ?.querySelector<HTMLElement>("[data-design-canvas-viewport]") ?? null;
}

function focusInspectorCanvasViewport(from: Element): void {
  inspectorCanvasViewport(from)?.focus({ preventScroll: true });
}

/** Figma's zoom menu: an editable percentage, then zoom in/out, fit, the
 * selection and fixed steps. Shift+0/1/2 are handled on the canvas. */
function DesignZoomMenu({
  zoom,
  disabled,
  historyOwner,
  zoomActionsRef,
}: {
  zoom: number;
  disabled: boolean;
  historyOwner: string | undefined;
  zoomActionsRef: React.MutableRefObject<DesignCanvasZoomActions | null>;
}) {
  const percentage = Math.round(zoom * 100);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(percentage));
  const inputRef = useRef<HTMLInputElement>(null);
  // As in Figma, the menu opens with its percentage selected for typing; the
  // menu focuses itself on mount, so the field takes focus a frame later.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const commitDraft = () => {
    const value = Number.parseFloat(draft);
    if (Number.isFinite(value) && value > 0) zoomActionsRef.current?.zoomTo(value / 100);
    setOpen(false);
  };
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(String(percentage));
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="text-fg2 h-7 min-w-12 px-2 text-xs tabular-nums"
          disabled={disabled}
          aria-label={`Canvas zoom ${percentage}%`}
        >
          {percentage}%
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-design-history-owner={historyOwner}
        align="end"
        className="w-48"
      >
        <div className="p-1">
          <Input
            ref={inputRef}
            size="compact"
            aria-label="Zoom percentage"
            inputMode="decimal"
            className="text-xs tabular-nums"
            value={draft}
            onChange={(event) => setDraft(event.target.value.replace(/%/g, ""))}
            onKeyDown={(event) => {
              // The menu's typeahead and arrow keys must not take the field's keys.
              if (event.key !== "Escape") event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
              }
            }}
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={zoom >= DESIGN_MAX_ZOOM}
          aria-label="Zoom in"
          onSelect={() => zoomActionsRef.current?.zoomIn()}
        >
          <span>Zoom in</span>
          <DropdownMenuShortcut>+</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={zoom <= DESIGN_MIN_ZOOM}
          aria-label="Zoom out"
          onSelect={() => zoomActionsRef.current?.zoomOut()}
        >
          <span>Zoom out</span>
          <DropdownMenuShortcut>−</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem aria-label="Zoom to fit" onSelect={() => zoomActionsRef.current?.zoomToFit()}>
          <span>Zoom to fit</span>
          <DropdownMenuShortcut>⇧1</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem aria-label="Zoom to selection" onSelect={() => zoomActionsRef.current?.zoomToSelection()}>
          <span>Zoom to selection</span>
          <DropdownMenuShortcut>⇧2</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {DESIGN_ZOOM_MENU_STEPS.map((step) => (
          <DropdownMenuItem
            key={step}
            aria-label={`Zoom to ${step * 100}%`}
            onSelect={() => zoomActionsRef.current?.zoomTo(step)}
          >
            <span>Zoom to {step * 100}%</span>
            {step === 1 ? <DropdownMenuShortcut>⇧0</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DESIGN_ZOOM_MENU_STEPS = [0.5, 1, 2] as const;

export function InspectorEditField({
  numericValue,
  icon,
  shortLabel,
  suffix: fieldSuffix,
  percentage,
  label,
  value: valueProp,
  applied = false,
  disabled = false,
  revalidating = false,
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
  unitBasis,
  emptyCommits = false,
  mixedSteps,
}: InspectorEditFieldProps) {
  const id = useId();
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const revalidatingRef = useRef(revalidating);
  revalidatingRef.current = revalidating;
  const pendingCommitRef = useRef<string | null>(null);
  const commitRef = useRef<((draft?: string) => Promise<void>) | null>(null);
  const origin = useDesignFieldOrigin(styleProperty, linkedProperties);
  // A computed value (calc(), clamp()…) shows as written and is edited in
  // CSS; layers that differ still read Mixed.
  const value =
    origin.lock?.kind === "computed" && String(valueProp) !== "" ? origin.lock.text : valueProp;
  const [focused, setFocused] = useState(false);
  /** A key typed on the pill: the field edits a plain value until it settles. */
  const [typingOverToken, setTypingOverToken] = useState(false);
  const tokensOffered = useDesignTokensFor(tokenAccepts);
  const overlays = useDesignFieldOverlays();
  const setPopoverOpen = usePopoverOpenControl();
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
  const mixedScrubRef = useRef(false);
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
  const arrowSequenceRef = useRef<{ start: string } | null>(null);
  const [arrowStepping, setArrowStepping] = useState(false);
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
    ? unitBasis
      ? designLengthUnitOptions(styleProperty ?? "", presentation.unit, unitBasis)
      : designStyleUnitOptions(styleProperty ?? "", presentation.unit)
    : [];

  /** A ranged value (opacity) settles inside its range. */
  const withinBounds = (next: string) => {
    const parts = range ? parseDesignStyleNumericParts(next) : null;
    if (!range || !parts) return next;
    const bounded = Math.min(range.max, Math.max(range.min, parts.number));
    return bounded === parts.number ? next : `${bounded}${parts.unit}`;
  };
  /** A scrub or arrow press also stops at zero where CSS takes no negative;
   * a typed negative is refused instead (refusalOf). */
  const withinRange = (next: string) =>
    withinBounds(styleProperty ? clampDesignStyleFieldValue(styleProperty, next) : next);
  /** One pointer pixel or arrow press, in the value's own unit. */
  const scrubStepFor = (start: string, fine: boolean) => {
    const scrubStep = whole
      ? { step: 1, fine: null }
      : designScrubStep(styleProperty, parseDesignStyleNumericParts(start)?.unit ?? "");
    return fine && scrubStep.fine !== null ? scrubStep.fine : scrubStep.step;
  };
  const typedValue = (next: string, baseline: string) => {
    const resolved = styleProperty
      ? normalizeDesignStyleFieldInput(styleProperty, next, baseline)
      : resolveDesignNumericExpression(next, baseline);
    return whole ? roundDesignLayoutValue(resolved) : resolved;
  };
  const resolveDraft = (next: string, baseline: string) => withinRange(typedValue(next, baseline));
  /** Why a typed value is not taken, in the words the field message shows. */
  const refusalOf = (next: string, baseline: string): string | null => {
    const shown = inspectorFieldPresentation(styleProperty, baseline, whole).text;
    const kept = shown.trim() ? ` Kept ${shown}.` : "";
    const maths = evaluateDesignNumericExpression(next, baseline);
    if (maths && "refused" in maths)
      return maths.refused === "mixed-units" ? "Use CSS for mixed units." : `Cannot divide by zero.${kept}`;
    const refused = styleProperty ? designStyleFieldRefusal(styleProperty, typedValue(next, baseline)) : null;
    if (!styleProperty || refused === null) return null;
    const field = messageField();
    const name = field ? readDesignCardField(field, styleProperty).label : label;
    return refused === "negative" ? `${name} cannot be negative.${kept}` : `${name} does not take ${next.trim()}.${kept}`;
  };
  /** Steps a Mixed field's scrub or arrows have moved its layers. */
  const mixedStepsRef = useRef<{ steps: number; fine: boolean } | null>(null);
  /** The field itself, which carries the attributes the card reads. */
  const messageField = () =>
    fieldRef.current?.querySelector<HTMLElement>("[data-design-inspector-field]") ?? fieldRef.current;
  const showMixedMessage = (text: string | null) => {
    const field = messageField();
    if (text && field) overlays.showFieldMessage(field, text, "info");
  };
  const mixed = Boolean(mixedSteps) && String(value) === "" && draft === "";

  // Finish an unfocused incoming value in this commit. A passive state update
  // can land after the next focus/select-all and overwrite that user's draft.
  useLayoutEffect(() => {
    if (scrubRef.current || pendingCommitRef.current !== null) return;
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
    // A scrub outlives a revalidation (its readback returns to the same
    // layers); only a field disabled outright ends it.
    if (disabled && (!revalidating || (!scrubRef.current && !mixedScrubRef.current))) scrubCancelRef.current?.();
  }, [disabled, revalidating]);

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
    arrowSequenceRef.current = null;
    setArrowStepping(false);
    if (disabledRef.current) {
      if (revalidatingRef.current) {
        pendingCommitRef.current = requestedDraft;
        return;
      }
      cancelPreview();
      setPresentedDraft(baselineRef.current);
      return;
    }
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      cancelPreview();
      return;
    }
    const pendingSteps = mixedStepsRef.current;
    if (pendingSteps && mixedSteps) {
      mixedStepsRef.current = null;
      if (pendingSteps.steps === 0) mixedSteps.cancel();
      else showMixedMessage(mixedSteps.commit(pendingSteps.steps, pendingSteps.fine));
      return;
    }
    const baseline = baselineRef.current;
    if (requestedDraft === baseline) {
      cancelPreview();
      adoptIncomingValue();
      return;
    }
    // An emptied field restores its value; Clear and Reset remove one.
    if (!emptyCommits && requestedDraft.trim() === "" && baseline.trim() !== "") {
      cancelPreview();
      setPresentedDraft(baseline);
      return;
    }
    const refusal = refusalOf(requestedDraft, baseline);
    if (refusal) {
      cancelPreview();
      setPresentedDraft(baseline);
      const field = messageField();
      if (field) overlays.showFieldMessage(field, refusal, "error");
      return;
    }
    const resolvedDraft = withinBounds(typedValue(requestedDraft, baseline));
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
  commitRef.current = commit;
  useLayoutEffect(() => {
    const pending = pendingCommitRef.current;
    if (pending === null || revalidating) return;
    pendingCommitRef.current = null;
    if (disabled) {
      cancelPreview();
      setPresentedDraft(baselineRef.current);
    } else {
      void commitRef.current?.(pending);
    }
  }, [disabled, revalidating, setPresentedDraft]);

  const glyph =
    icon ?? (compact && label === "Rotation" ? ("rotation" as const) : null);
  const labelText = glyph ? null : (shortLabel ?? label);
  // Letters and glyphs sit in one square slot so values start on one line;
  // words size to their text instead of wrapping inside a compact field.
  const letterLabel = glyph !== null || (labelText?.length ?? 0) <= 2;
  // A value written as calc() carries its own units.
  const writtenAsIs = origin.lock?.kind === "computed" && value !== valueProp;
  const suffix = writtenAsIs
    ? null
    : (fieldSuffix ??
      (compact && styleProperty === "rotate"
        ? "°"
        : compact && percentage
          ? "%"
          : null));
  // A token reads as the value only while nothing is being edited.
  const tokenShown =
    Boolean(token) && !typingOverToken && !focused && draft === String(value);
  const showUnit =
    !compact && !tokenShown && Boolean(presentation.unit) && unitOptions.length > 0;
  const motionPersistent = Boolean(motion?.trackActive);

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
        data-design-theme-mark={origin.themed ? "" : undefined}
        aria-readonly={origin.lock ? true : undefined}
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
            if (mixed && mixedSteps) {
              event.preventDefault();
              const originX = event.clientX;
              let lastX = event.clientX;
              let distance = 0;
              let moved = false;
              let sent = 0;
              let fine = false;
              mixedScrubRef.current = true;
              const end = () => {
                mixedScrubRef.current = false;
                scrubCancelRef.current = null;
              };
              scrubCancelRef.current = beginDesignPointerGesture({
                target: event.currentTarget,
                pointerId: event.pointerId,
                cursor: "ew-resize",
                onMove: (pointerEvent) => {
                  if (!moved && Math.abs(pointerEvent.clientX - originX) < 3) return;
                  moved = true;
                  fine = pointerEvent.altKey;
                  distance += (pointerEvent.clientX - lastX) * (pointerEvent.shiftKey ? 10 : 1);
                  lastX = pointerEvent.clientX;
                  const steps = Math.round(distance);
                  if (steps === sent) return;
                  sent = steps;
                  mixedSteps.preview(steps, fine);
                },
                onFinish: () => {
                  end();
                  if (sent === 0) {
                    mixedSteps.cancel();
                    return;
                  }
                  // Admitted now even while the layers read back, so an Undo
                  // pressed after the release reverts this scrub.
                  showMixedMessage(mixedSteps.commit(sent, fine));
                },
                onCancel: () => {
                  end();
                  mixedSteps.cancel();
                },
              });
              return;
            }
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
                void commitRef.current?.(scrub.latestValue);
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
          data-design-draft={draft === String(value) && !arrowStepping ? "clean" : "dirty"}
          value={presentation.text}
          placeholder={placeholder}
          disabled={disabled && !(revalidating && focused)}
          readOnly={Boolean(origin.lock)}
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
              const input = event.currentTarget;
              void commit();
              // Fields inside a popover keep it open, like the unit menu beside them.
              if (input.closest("[data-design-popover]")) input.blur();
              else focusInspectorCanvasViewport(input);
            } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && mixed && mixedSteps) {
              event.preventDefault();
              const current = mixedStepsRef.current ?? { steps: 0, fine: false };
              const next = {
                steps: current.steps + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1),
                fine: event.altKey,
              };
              mixedStepsRef.current = next;
              mixedSteps.preview(next.steps, next.fine);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const normalized = resolveDraft(draftRef.current, baselineRef.current);
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
                arrowSequenceRef.current ??= { start: baselineRef.current };
                const resolved = withinRange(next);
                const moved = resolved !== arrowSequenceRef.current.start;
                if (!moved) arrowSequenceRef.current = null;
                setArrowStepping(moved);
                setPresentedDraft(resolved);
                preview(resolved);
              }
            } else if (
              event.key === "Backspace" &&
              event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              designInputResetsOnAltBackspace(event.currentTarget)
            ) {
              // Reset: the draft is dropped so blur cannot write it back. With
              // a caret in the text the keys keep their own meaning, delete
              // the word before it.
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
              const sequenceStart = arrowSequenceRef.current?.start;
              arrowSequenceRef.current = null;
              setArrowStepping(false);
              // A preceding commit can publish its authoritative computed
              // value while this input is focused. The synchronization effect
              // deliberately leaves an active draft alone, so the focus-time
              // baseline may now be stale (notably after removing an authored
              // declaration). Escape must restore the latest exact-key value
              // from props; once we blur there may be no further value change
              // to trigger the effect again.
              const restored = sequenceStart ?? String(value);
              baselineRef.current = restored;
              setPresentedDraft(restored);
              cancelPreview();
              if (mixedStepsRef.current) {
                mixedStepsRef.current = null;
                mixedSteps?.cancel();
              }
              const input = event.currentTarget;
              if (setPopoverOpen && input.closest("[data-design-popover]")) {
                setPopoverOpen(false);
                return;
              }
              const viewport = inspectorCanvasViewport(input);
              input.blur();
              window.requestAnimationFrame(() => viewport?.focus({ preventScroll: true }));
            }
          }}
        />
        )}
        {suffix && !tokenShown ? <span className="zd-field-suffix">{suffix}</span> : null}
        {tokenShown && token && origin.lock?.kind !== "control" ? (
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
              // The menu converts: 12px of a 400px parent becomes 3%.
              const next =
                (unitBasis ? convertDesignLength(resolved, unit, unitBasis, { whole }) : null) ??
                replaceDesignStyleNumericUnit(resolved, unit);
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
            <SelectContent align="end" data-design-popover="" className="min-w-20">
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
                onBlur={(event) => {
                  if (fieldRef.current?.contains(event.relatedTarget)) return;
                  void commit();
                }}
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
  active = true,
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
  active?: boolean;
}) {
  const shown = useDesignFrameGeometryLiveValue(workspaceId, frame, geometryKey, active) ?? saved;
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
  revalidating,
  applied,
  onPreviewStyles,
  onCancelPreview,
  onCommitStyles,
  motionModeActive,
  motionTrackActive,
  onAddMotionKeyframe,
  onDetachToken,
  selection,
  active,
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
  /** Every selected layer whose details are loaded: a Mixed field moves each
   * from its own value. */
  selection?: readonly DesignRuntimeNodeDetails[];
  originLabel?: DesignStyleOriginLabel;
  onLayoutAction?: (action: DesignLayoutAction, options?: DesignGestureCommit) => Promise<void>;
  onPreviewLayoutAction?: (action: DesignLayoutAction) => Promise<void>;
  disabled?: boolean;
  revalidating?: boolean;
  active: boolean;
  applied: boolean;
  onPreviewStyles: (
    styles: Record<string, string | null>,
    perNode?: (nodeId: string) => Record<string, string | null>,
  ) => void | Promise<void>;
  onCancelPreview: () => void | Promise<void>;
  onCommitStyles: (
    styles: Record<string, string | null>,
    perNode?: (nodeId: string) => Record<string, string | null>,
    intent?: "reset" | "token" | "detach",
    options?: DesignGestureCommit,
  ) => Promise<void>;
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
    active,
  );
  const farEdge =
    property === "left" ? "right" : property === "top" ? "bottom" : property;
  const farLiveValue = useDesignLivePreviewValue(
    workspaceId,
    frame,
    nodeId,
    farEdge,
    active,
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
  // or an edit gives the field one value for all of them. A Mixed scrub's
  // preview moves each by the same amount, so they still differ: the field
  // keeps reading Mixed until that preview clears, however often a
  // readback replaces these details meanwhile.
  const steppingRef = useRef(false);
  if (liveValue === undefined) steppingRef.current = false;
  if (options?.mixed && (liveValue === undefined || steppingRef.current)) displayedValue = "";
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
      options?.percentage && next.trim() && DESIGN_PERCENTAGE_INPUT.test(next.trim())
        ? String(
            Math.max(DESIGN_PERCENTAGE_RANGE.min, Math.min(DESIGN_PERCENTAGE_RANGE.max, Number.parseFloat(next))) / 100,
          )
        : next || null;
    return Object.fromEntries(
      [property, ...(options?.linkedProperties ?? [])].map((key) => [
        key,
        value,
      ]),
    );
  };
  // Units convert against what the value is measured by; a percentage
  // field (opacity) and geometry keep their own presentation.
  const unitBasis = useMemo(
    () => (details && !options?.geometry && !options?.percentage ? designLengthBasis(details, property, displayedValue) : undefined),
    [details, displayedValue, options?.geometry, options?.percentage, property],
  );
  // As in a design tool, pointing at a padding or gap field shows that space
  // on the canvas; the field's own state is untouched.
  const linkedKey = options?.linkedProperties?.join(" ") ?? "";
  const spaces = useMemo(
    () => [property, ...(linkedKey ? linkedKey.split(" ") : [])].filter((name) =>
      name.startsWith("padding-") || name === "row-gap" || name === "column-gap"),
    [linkedKey, property],
  );
  const emphasisKey = designLayoutToolsKey(workspaceId, frame, nodeId);
  const [emphasisOwner] = useState(() => ({}));
  const pointedRef = useRef({ hovered: false, focused: false });
  const point = (change: Partial<{ hovered: boolean; focused: boolean }>) => {
    Object.assign(pointedRef.current, change);
    const { hovered, focused } = pointedRef.current;
    emphasizeDesignLayoutTools(emphasisKey, emphasisOwner, active && (hovered || focused) ? spaces : null);
  };
  useEffect(() => () => emphasizeDesignLayoutTools(emphasisKey, emphasisOwner, null), [emphasisKey, emphasisOwner]);
  useEffect(() => {
    if (!active) emphasizeDesignLayoutTools(emphasisKey, emphasisOwner, null);
  }, [active, emphasisKey, emphasisOwner]);
  const mixedSteps = options?.mixed && selection && selection.length > 1
    ? designMixedSteps({
        property,
        linked: options.linkedProperties ?? [],
        geometry: options.geometry,
        whole: Boolean(options.whole),
        selection,
        stepping: (on) => {
          steppingRef.current = on;
        },
        preview: (styles, perNode) => void Promise.resolve(onPreviewStyles(styles, perNode)).catch(() => {}),
        previewLayout: (action) => void Promise.resolve(onPreviewLayoutAction?.(action)).catch(() => {}),
        cancel: () => void Promise.resolve(onCancelPreview()).catch(() => {}),
        commit: (styles, perNode) =>
          void onCommitStyles(styles, perNode, undefined, { gesture: true }).catch((error) =>
            toast.error(`Couldn't update ${label.toLowerCase()}`, { description: errorMessage(error) }),
          ),
        commitLayout: (action) =>
          void Promise.resolve(onLayoutAction?.(action, { gesture: true })).catch((error) =>
            toast.error(`Couldn't update ${label.toLowerCase()}`, { description: errorMessage(error) }),
          ),
      })
    : undefined;
  const field = (
    <InspectorEditField
      label={label}
      value={displayedValue}
      icon={options?.icon}
      shortLabel={options?.shortLabel}
      suffix={options?.suffix}
      percentage={options?.percentage}
      range={options?.percentage ? DESIGN_PERCENTAGE_RANGE : undefined}
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
      disabled={disabled || options?.disabled}
      revalidating={revalidating && !options?.disabled}
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
      onPreview={(next) => {
        steppingRef.current = false;
        return options?.geometry && onPreviewLayoutAction
          ? onPreviewLayoutAction(layoutAction(next))
          : onPreviewStyles(styleUpdate(next));
      }}
      onCancelPreview={onCancelPreview}
      onCommit={(next) => {
        steppingRef.current = false;
        return options?.geometry && onLayoutAction
          ? onLayoutAction(layoutAction(next))
          : onCommitStyles(styleUpdate(next));
      }}
      unitBasis={unitBasis}
      // Emptying X, Y or rotation removes the offset or turn, which no menu
      // offers; elsewhere an emptied field restores its value.
      emptyCommits={Boolean(options?.geometry) && property !== "width" && property !== "height"}
      mixedSteps={mixedSteps}
    />
  );
  if (!spaces.length) return field;
  return (
    <div
      className="contents"
      onPointerEnter={() => point({ hovered: true })}
      onPointerLeave={() => point({ hovered: false })}
      onFocus={() => point({ focused: true })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) point({ focused: false });
      }}
    >
      {field}
    </div>
  );
}, sameInspectorStyleFieldProps);

function sameFieldOptions(
  left: DesignLayoutFieldOptions | undefined,
  right: DesignLayoutFieldOptions | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left) as (keyof DesignLayoutFieldOptions)[];
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(right, key)) return false;
    if (key !== "linkedProperties") return Object.is(left[key], right[key]);
    const before = left.linkedProperties;
    const after = right.linkedProperties;
    return before === after || (
      before !== undefined && after !== undefined &&
      before.length === after.length && before.every((property, index) => property === after[index])
    );
  });
}

/** Sections build each field's options inline, so a section that re-renders
 * for one live value would otherwise re-render every field it holds. */
function sameInspectorStyleFieldProps<Props extends { options?: DesignLayoutFieldOptions }>(
  left: Readonly<Props>,
  right: Readonly<Props>,
): boolean {
  const keys = Object.keys(left) as (keyof Props)[];
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) =>
    Object.hasOwn(right, key) &&
    (key === "options" ? sameFieldOptions(left.options, right.options) : Object.is(left[key], right[key])),
  );
}

/** A Mixed field's steps as per-layer writes: geometry by an amount from
 * each layer's own box, a style from each layer's own value in its own unit.
 * One preview per tick and one commit for every layer. */
function designMixedSteps(input: {
  property: string;
  linked: readonly string[];
  geometry?: boolean;
  whole: boolean;
  selection: readonly DesignRuntimeNodeDetails[];
  /** While true, the field keeps reading Mixed over its live preview. */
  stepping: (on: boolean) => void;
  preview: (styles: Record<string, string | null>, perNode: (nodeId: string) => Record<string, string | null>) => void;
  previewLayout: (action: DesignLayoutAction) => void;
  cancel: () => void;
  commit: (styles: Record<string, string | null>, perNode: (nodeId: string) => Record<string, string | null>) => void;
  commitLayout: (action: DesignLayoutAction) => void;
}): NonNullable<InspectorEditFieldProps["mixedSteps"]> {
  const { property, linked, selection } = input;
  // Each layer moves from where it was when the scrub began: its preview
  // must not move the base the commit adds to.
  const bases = input.geometry
    ? Object.fromEntries(selection.map((node) => [node.oid, designLayoutStepBase(node, property)]))
    : {};
  const layoutStep = (steps: number): DesignLayoutAction =>
    property === "rotate"
      ? { type: "rotate", delta: steps, bases }
      : {
          type: property === "width" || property === "height" ? "size" : "position",
          axis: property === "left" || property === "width" ? "x" : "y",
          value: steps,
          by: true,
          bases,
        };
  const writes = (steps: number, fine: boolean) => {
    const { values, skipped } = designMixedScrubValues(
      property,
      selection.map((node) => ({
        nodeId: node.oid,
        value: designAuthoredLength(node, property) ?? readDesignComputedStyle(node.styles, property),
      })),
      steps,
      { whole: input.whole, fine },
    );
    const perNode = (nodeId: string): Record<string, string | null> => {
      const next = values[nodeId];
      return next === undefined ? {} : Object.fromEntries([property, ...linked].map((key) => [key, next]));
    };
    const first = Object.values(values)[0];
    const styles = Object.fromEntries([property, ...linked].map((key) => [key, first ?? null]));
    return { perNode, styles, moved: Object.keys(values).length, skipped: skipped.length };
  };
  return {
    preview: (steps, fine) => {
      input.stepping(true);
      if (input.geometry) {
        input.previewLayout(layoutStep(steps));
        return;
      }
      const { styles, perNode, moved } = writes(steps, fine);
      if (moved > 0) input.preview(styles, perNode);
    },
    commit: (steps, fine) => {
      input.stepping(true);
      if (input.geometry) {
        input.commitLayout(layoutStep(steps));
        return null;
      }
      const { styles, perNode, moved, skipped } = writes(steps, fine);
      if (moved > 0) input.commit(styles, perNode);
      else input.cancel();
      if (skipped === 0) return null;
      if (moved === 0) return skipped === 1 ? "The layer has no number to move." : `None of the ${skipped} layers has a number to move.`;
      return `${moved} ${moved === 1 ? "layer" : "layers"} moved. ${skipped} ${skipped === 1 ? "has" : "have"} no number to move.`;
    },
    cancel: () => {
      input.stepping(false);
      input.cancel();
    },
  };
}

function designInspectorHistoryOwnerKey(
  workspaceId: string,
  directoryId: string | undefined,
  directoryRevision: number,
): string {
  return JSON.stringify([workspaceId, directoryId ?? null, directoryRevision]);
}

type DesignInspectorTab = "options" | "style" | "css";
const NO_BOUND_STYLES: Readonly<Record<string, readonly string[]>> = Object.freeze({});
/** H when the control W shows sets it too: no raw field and no second copy. */
const SHARED_HEIGHT = <span key="size:y" data-design-size-axis-shared="y" hidden />;
/** What the inspector edits for a selection. A control is the only way to
 * change a component from outside, so an instance shows its size and Controls,
 * a part or slot its instance's Controls, and a main Controls and Style with
 * no CSS tab; plain layers keep Style and CSS. */
export type DesignInspectorSelectionKind =
  | "ordinary"
  | "main-root"
  | "main-layer"
  | "instance"
  | "component-inner"
  /** Several layers with an instance among them: only their size. */
  | "instances"
  /** Several layers with a part or slot among them: nothing to edit. */
  | "component-inner-many";
const MAX_DESIGN_INSPECTOR_TAB_PREFERENCES = 32;

export function designInspectorTabKey({
  workspaceId,
  directoryId,
  pageId,
  frameFile,
  selection,
}: {
  workspaceId: string | null;
  directoryId: string | undefined;
  pageId: string | null;
  frameFile: string | null;
  selection: readonly string[];
}): string {
  return JSON.stringify([workspaceId ?? "", directoryId ?? "", pageId ?? "", frameFile ?? "", selection]);
}

export function rememberDesignInspectorTab(
  preferences: Map<string, DesignInspectorTab>,
  key: string,
  value: DesignInspectorTab,
): void {
  preferences.delete(key);
  preferences.set(key, value);
  while (preferences.size > MAX_DESIGN_INSPECTOR_TAB_PREFERENCES) {
    const oldest = preferences.keys().next().value;
    if (oldest === undefined) break;
    preferences.delete(oldest);
  }
}

/** What stands in for the Style editor while details are pending: the
 * frame's own geometry only when the frame itself is selected, otherwise a
 * disabled Size until the layers' details arrive. */
export function designInspectorPendingGeometry(input: { frameSelected: boolean; selectedNodeId: string | null | undefined; count: number }): "frame" | "size" {
  return input.frameSelected && !input.selectedNodeId && input.count <= 1 ? "frame" : "size";
}

/** A main's root is the component: selected as its frame, or as a layer
 * (from Layers, Escape or a restore), it is the main. */
export function designInspectorMainRootSelected(input: {
  main: boolean;
  frameSelected: boolean;
  selectedNodeId: string | null | undefined;
  layoutRootId: string | null | undefined;
  count: number;
}): boolean {
  if (!input.main || input.count > 1) return false;
  const isRoot = !!input.selectedNodeId && input.selectedNodeId === input.layoutRootId;
  return input.frameSelected ? !input.selectedNodeId || isRoot : isRoot;
}

export function designInspectorSelectionKind(evidence: {
  count: number;
  mainRoot: boolean;
  mainLayer: boolean;
  /** An instance host is selected (alone, or among several layers). */
  instance: boolean;
  /** A part or slot is selected (alone, or among several layers). */
  inner: boolean;
}): DesignInspectorSelectionKind {
  if (evidence.count > 1)
    return evidence.inner ? "component-inner-many" : evidence.instance ? "instances" : evidence.mainLayer ? "main-layer" : "ordinary";
  if (evidence.inner) return "component-inner";
  if (evidence.instance) return "instance";
  if (evidence.mainRoot) return "main-root";
  return evidence.mainLayer ? "main-layer" : "ordinary";
}

const DESIGN_INSPECTOR_TABS: Readonly<Record<DesignInspectorSelectionKind, readonly DesignInspectorTab[]>> = {
  ordinary: ["style", "css"],
  "main-root": ["options", "style"],
  "main-layer": ["style"],
  instance: ["options"],
  "component-inner": ["options"],
  instances: ["style"],
  "component-inner-many": [],
};

/** The panels a selection has, its default first. */
export function designInspectorTabs(kind: DesignInspectorSelectionKind): readonly DesignInspectorTab[] {
  return DESIGN_INSPECTOR_TABS[kind];
}

/** A remembered tab the selection no longer has falls back to its default. */
export function designInspectorActiveTab(kind: DesignInspectorSelectionKind, stored: DesignInspectorTab | null): DesignInspectorTab | null {
  const tabs = designInspectorTabs(kind);
  return stored && tabs.includes(stored) ? stored : tabs[0] ?? null;
}

export function designInspectorSimilarTabKey(
  owner: { workspaceId: string | null; directoryId: string | undefined },
  kind: DesignInspectorSelectionKind,
): string {
  return JSON.stringify(["similar", owner.workspaceId ?? "", owner.directoryId ?? "", kind]);
}

export function designInspectorTabForSelection(
  preferences: ReadonlyMap<string, DesignInspectorTab>,
  exactKey: string,
  similarKey: string,
): DesignInspectorTab | null {
  return preferences.get(exactKey) ?? preferences.get(similarKey) ?? null;
}

export function rememberDesignInspectorSelectionTab(
  preferences: Map<string, DesignInspectorTab>,
  exactKey: string,
  similarKey: string,
  value: DesignInspectorTab,
): void {
  rememberDesignInspectorTab(preferences, exactKey, value);
  if (similarKey !== exactKey) rememberDesignInspectorTab(preferences, similarKey, value);
}

export function designInspectorPanelState(activeTab: DesignInspectorTab, tab: DesignInspectorTab) {
  const active = activeTab === tab;
  return { active, inert: !active, ariaHidden: !active };
}

type InertTabsContentProps = React.ComponentProps<typeof TabsContent> & { inert?: "" };
const InertTabsContent = TabsContent as React.ComponentType<InertTabsContentProps>;

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
  onAskAgent,
  panelVisible = true,
  selectionSettlingRef,
}: DesignInspectorProps) {
  const styleOriginLabel = useDesignStyleOriginLabel(workspaceId);
  const tokenCatalog = useDesignFrameTokenCatalog(workspaceId, frame?.file);
  // Cloud workspaces have no Design preview; the control stays visible and inert.
  const previewAllowed = !isCloudWorkspace(workspaceId);
  const previewDirectoryId = useDesignWorkspaceUiStore(state =>
    workspaceId ? state.byWorkspace[workspaceId]?.directoryId : undefined,
  );
  const pendingHistoryByOwnerRef = useRef(new Map<string, number>());
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
  const layoutRootId = useDesignRuntimeStore((state) =>
    workspaceId && frame
      ? state.byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.frame.oid
      : undefined,
  );
  const runtimeSourceVersion = useDesignRuntimeStore((state) =>
    workspaceId && frame ? state.byWorkspace[workspaceId]?.frames[frame.file]?.sourceVersion : undefined,
  );
  const legacyExactInstanceNodeId = frame?.componentIdentity === undefined &&
    runtimeSourceVersion === frame?.sourceVersion && layoutRootId && frame?.instances && Object.hasOwn(frame.instances.hosts, layoutRootId)
    ? layoutRootId
    : null;
  // An edit still saving adopts its generation in the runtime before the
  // workspace snapshot names it; that readback is current for the next edit.
  const runtimeAheadBySave = Boolean(workspaceId && runtimeSourceVersion &&
    runtimeSourceVersion !== frame?.sourceVersion && hasPendingDesignEdits(workspaceId));
  const currentReadback = (sourceVersion: string | undefined) =>
    sourceVersion === frame?.sourceVersion || (runtimeAheadBySave && sourceVersion === runtimeSourceVersion);
  const explicitFrameIdentityNodeId = frame?.componentIdentity?.kind === "instance"
    ? frame.componentIdentity.nodeId
    : null;
  const styleTargetNodeId = designStyleTargetNodeId({
    selectedNodeId,
    frameSelected,
    explicitFrameIdentityNodeId,
    legacyExactInstanceNodeId,
    layoutRootId,
    details,
  });
  const elementDetails = styleTargetNodeId && details?.oid === styleTargetNodeId && currentReadback(details.sourceVersion)
    ? details
    : null;
  // The selected layer's winners complete what its component's bindings say
  // (rules in linked stylesheets); the cache refuses by the same answer.
  if (workspaceId && frame && elementDetails) rememberDesignRuntimeBindings(workspaceId, frame, elementDetails);
  // And what rules gated on its controls would set at another value: read
  // once per layer and generation, while shown; the panel re-reads on arrival.
  useSyncExternalStore(subscribeDesignRuntimeBindings, designRuntimeBindingsVersion, designRuntimeBindingsVersion);
  const gatedReadKey = workspaceId && frame && elementDetails && active && designGatedReadPending(workspaceId, frame, elementDetails.oid)
    ? JSON.stringify([workspaceId, frame.file, frame.sourceVersion, elementDetails.oid])
    : null;
  useEffect(() => {
    if (!gatedReadKey || !workspaceId || !frame || !elementDetails) return;
    void readDesignGatedBindings(workspaceId, frame, elementDetails.oid, designFrameRuntime(workspaceId, frame.file));
  }, [gatedReadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const frameComponentPresentation = frame ? designFrameComponentPresentation(frame, (file) =>
    designWorkspaceSnapshotCache.peekSnapshot(workspaceId ?? "").data?.frames.find((candidate) => candidate.file === file)?.title) : null;
  const errors = useMemo(
    () => frameBlockingDesignLintErrors(lint?.violations ?? [], frame?.file),
    [lint, frame?.file],
  );
  const firstBlockingReason = errors[0]
    ? blockingDesignLintReason(errors[0])
    : null;
  const zoom = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.zoom ??
        DEFAULT_DESIGN_WORKSPACE_VIEW.zoom)
      : DEFAULT_DESIGN_WORKSPACE_VIEW.zoom,
  );
  const [frameAction, setFrameAction] = useState<"export" | null>(null);
  const [exportScale, setExportScale] = useState(1);
  // A slot takes layers, not styles: its frame is the main's.
  const slotSelected = !!selectedNodeId && designComponentSlotOf(selectedNodeId) !== null;
  const editsDisabled = !active || slotSelected;
  const tabPreferencesRef = useRef(new Map<string, DesignInspectorTab>());
  const [tabPreference, setTabPreference] = useState<{ key: string; value: DesignInspectorTab } | null>(null);
  const tabKeyRef = useRef("");
  const tabSimilarityKeyRef = useRef("");
  const selectInspectorTab = useCallback((value: DesignInspectorTab) => {
    const key = tabKeyRef.current;
    if (!key) return;
    rememberDesignInspectorSelectionTab(tabPreferencesRef.current, key, tabSimilarityKeyRef.current, value);
    setTabPreference({ key, value });
  }, []);
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
      const task = layoutActionQueueRef.current.then(() => ({ result: action() }));
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
      const view = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
      const historyOwner = {
        directoryId: view?.directoryId,
        directoryRevision: view?.directoryRevision ?? 0,
      };
      const historyOwnerKey = designInspectorHistoryOwnerKey(
        workspaceId,
        historyOwner.directoryId,
        historyOwner.directoryRevision,
      );
      pendingHistoryByOwnerRef.current.set(
        historyOwnerKey,
        (pendingHistoryByOwnerRef.current.get(historyOwnerKey) ?? 0) + 1,
      );
      // Admit history before later edits; the workspace mutation lane orders
      // its bridge write with inspector and direct canvas mutations.
      beginDesignHistorySelection(workspaceId);
      void applyDesignHistoryCached(workspaceId, frame?.file ?? null, direction)
        .then((result) => {
          if (!result || !isCurrentDesignPageOwner(owner)) return;
          // A frame-level step restores its own frame selection below; an
          // in-document step brings back the node selection of the state it
          // returns to.
          settleDesignHistorySelection(workspaceId, result.historySelection === undefined ? result.historyFrame ?? null : null);
          void restoreDesignPageHistorySelection(workspaceId, owner, result, direction, (itemId, page) => {
            setDesignCanvasItemSelection(designCanvasItemOwner(workspaceId, owner.directoryId, page.id), itemId);
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
          const pending = pendingHistoryByOwnerRef.current.get(historyOwnerKey) ?? 0;
          if (pending <= 1) pendingHistoryByOwnerRef.current.delete(historyOwnerKey);
          else pendingHistoryByOwnerRef.current.set(historyOwnerKey, pending - 1);
        });
    },
    [frame, workspaceId],
  );

  const readPreparedLayoutRuntime = useCallback(async (
    owner: string,
    file: string,
    assertCurrent: () => void,
  ) => {
    assertCurrent();
    const currentFrame = designWorkspaceSnapshotCache.peekSnapshot(owner).data?.frames.find(
      (candidate) => candidate.file === file,
    );
    if (!currentFrame) throw new Error("The selected Design frame is no longer available.");
    let runtime = designFrameRuntime(owner, file);
    if (!runtime || runtime.sourceVersion !== currentFrame.sourceVersion) {
      runtime = await waitForDesignFrameRuntime(owner, file, 2_000, {
        sourceVersion: currentFrame.sourceVersion,
      });
    }
    assertCurrent();
    const assertFrameCurrent = () => {
      assertCurrent();
      const latest = designWorkspaceSnapshotCache.peekSnapshot(owner).data?.frames.find(
        (candidate) => candidate.file === file,
      );
      if (latest?.sourceVersion !== currentFrame.sourceVersion)
        throw new Error(`Design frame changed before the mutation: ${file}. Re-read it and retry.`);
    };
    assertFrameCurrent();
    if (!runtime || runtime.sourceVersion !== currentFrame.sourceVersion)
      throw new Error("The selected frame is still loading at the current generation.");
    return { frame: currentFrame, runtime, assertFrameCurrent };
  }, []);

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
        // A selected frame, or one frame layer that holds layers, is laid out
        // in place; the canvas wraps any other layer selection.
        const view = designWorkspaceView(workspaceId);
        const context = styleEditContextRef.current;
        if (view.selectedNodeId && (view.selectedNodeIds.length > 1 || context.selectedNodeId !== view.selectedNodeId ||
          !designShiftAConvertsInPlace([context.elementDetails]))) return;
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
  // An Undo or Redo painted ahead of its save reads its layers back; every
  // selected layer steps from that, as the primary one already does.
  const presentedHistoryFrame = useDesignHistoryPresentation(workspaceId)?.runtime.get(frame?.file ?? "");
  const styleNodeDetails = useDesignRuntimeStore(useShallow((state) => {
    const frameState = workspaceId && frame
      ? state.byWorkspace[workspaceId]?.frames[frame.file]
      : undefined;
    // Only an Undo still painted over the generation the frame holds.
    const presented = presentedHistoryFrame?.sourceVersion === frameState?.sourceVersion
      ? presentedHistoryFrame
      : undefined;
    return styleNodeIds.map((nodeId) =>
      presented?.details.get(nodeId) ?? frameState?.detailsByNode[nodeId] ?? null);
  }));
  const styleDirectoryKey = workspaceId
    ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directoryId ??
      designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directory ?? ""
    : "";
  const styleOwnerKey = `${workspaceId ?? ""}\u0000${folder ?? ""}\u0000${styleDirectoryKey}\u0000${activePageId ?? ""}\u0000${frame?.file ?? ""}\u0000${styleNodeIds.join("\u0000")}`;
  const confirmedStyleDetailsRef = useRef<{ owner: string; details: DesignRuntimeNodeDetails } | null>(null);
  if (confirmedStyleDetailsRef.current?.owner !== styleOwnerKey) confirmedStyleDetailsRef.current = null;
  if (elementDetails) confirmedStyleDetailsRef.current = { owner: styleOwnerKey, details: elementDetails };
  // Revalidation retains presentation only; edit contexts still require exact-source details.
  // A copy or a moved layer is the layer it was made from until it reads
  // back: the panel keeps that layer's values instead of emptying. Shown only;
  // edits wait for the target's own details.
  const shownSubjectRef = useRef<(DesignSelectionSubject & { details: DesignRuntimeNodeDetails; parents: DesignRuntimeNodeDetails[] }) | null>(null);
  const selectionHandoff = useDesignSelectionHandoff(workspaceId);
  const selectionSubject: DesignSelectionSubject | null = frame && selectedNodeIds.length <= 1 && (frameSelected || selectedNodeId)
    ? { frame: frame.file, nodeId: frameSelected && !selectedNodeId ? null : selectedNodeId }
    : null;
  const handed = !elementDetails && !confirmedStyleDetailsRef.current
    ? designHandedSelectionPresentation(shownSubjectRef.current, selectionHandoff, selectionSubject)
    : null;
  const presentedElementDetails = elementDetails ?? confirmedStyleDetailsRef.current?.details ?? handed?.details ?? null;
  // A handed-over panel already looks as it will once its target reads back:
  // disabled controls would dim it for that moment. It is inert instead, and
  // its edit contexts refuse writes.
  const styleEditsDisabled = editsDisabled || (!elementDetails && !handed);
  const presentedTargetNodeId = styleTargetNodeId ?? (handed ? handed.details.oid : null);
  const frameStyleTarget =
    frameSelected && !selectedNodeId && presentedTargetNodeId !== null;
  const layoutParents = useMemo(
    () => handed ? handed.parents :
      styleNodeIds.flatMap((nodeId, index) => {
        const node =
          nodeId === presentedElementDetails?.oid
            ? presentedElementDetails
            : styleNodeDetails[index];
        return node && node.sourceVersion === presentedElementDetails?.sourceVersion
          ? [node]
          : [];
      }),
    [handed, presentedElementDetails, styleNodeDetails, styleNodeIds],
  );
  if (elementDetails && selectionSubject && styleNodeIds.length === 1 && layoutParents.length === 1)
    shownSubjectRef.current = { ...selectionSubject, details: elementDetails, parents: layoutParents };
  /** Layers the panel shows: a handed-over subject's while its target reads back. */
  const presentedNodeCount = handed ? handed.parents.length : styleNodeIds.length;
  // A main component showing one of its states: style edits write that
  // state's rule in the main, not the layers' own style.
  const shownState = useDesignShownComponentState(workspaceId ?? "", frame ?? null);
  const shownVariant = useDesignComponentVariantStore((state) => {
    if (!workspaceId || !frame?.component) return null;
    const variant = state.byWorkspace[workspaceId]?.frames[frame.file];
    return variant && designDeclaredVariants(frame.component).includes(variant) ? variant : null;
  });
  const styleActiveNow = active && Boolean(elementDetails);
  const styleEditableNow = !editsDisabled && Boolean(presentedElementDetails) && !handed;
  const styleEditContextRef = useRef({
    get active() { return styleActiveNow && !selectionSettlingRef?.current; },
    get editable() { return styleEditableNow && !selectionSettlingRef?.current; },
    pageId: activePageId ?? null,
    directoryKey: styleDirectoryKey,
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
    stateContext: shownState,
  });
  styleEditContextRef.current = {
    get active() { return styleActiveNow && !selectionSettlingRef?.current; },
    get editable() { return styleEditableNow && !selectionSettlingRef?.current; },
    pageId: activePageId ?? null,
    directoryKey: styleDirectoryKey,
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    layoutRootId,
    stateContext: shownState,
  };
  // A keyed editor's cleanup runs after the new selection has rendered. Keep
  // its callbacks and cancellation baseline attached to its own owner; using
  // the live selection here would restore the incoming layer instead.
  const styleOwner = useMemo(
    () => ({
      key: styleOwnerKey,
      contextRef: { current: styleEditContextRef.current },
      previewIntentRef: { current: 0 },
      gesturePreview: new DesignGesturePreview<DesignStylePreviewRequest>(),
    }),
    [styleOwnerKey],
  );
  styleOwner.contextRef.current = styleEditContextRef.current;
  // A layer held in one of its states (single selection only): its details
  // come from the held slot under the exact layer, frame and generation, and
  // never from the runtime store, which keeps Default.
  const heldKey =
    active && workspaceId && frame && elementDetails && styleNodeIds.length === 1
      ? { workspaceId, frame: frame.file, sourceVersion: elementDetails.sourceVersion, nodeId: elementDetails.oid }
      : null;
  const heldEntry = useDesignHeldStateStore((store) => (heldKey ? designHeldStateEntry(store, heldKey) : null));
  const heldDetails = heldEntry?.details ?? null;
  // A hold still waiting for its reply is read-only too: the canvas may
  // already show the state.
  const holding = heldEntry !== null;
  const heldParents = useMemo(() => (heldDetails ? [heldDetails] : null), [heldDetails]);
  const heldChanges = useMemo(() => (heldDetails ? designHeldStateChanges(heldDetails) : null), [heldDetails]);
  const shownDetails = heldDetails ?? presentedElementDetails;
  // A selected layer read back at another generation than the primary one
  // drops out of layoutParents until it catches up. Its fields keep showing
  // the last complete selection meanwhile, so a Mixed field stays Mixed.
  const completeParentsRef = useRef<{ owner: string; parents: DesignRuntimeNodeDetails[] } | null>(null);
  if (completeParentsRef.current?.owner !== styleOwnerKey) completeParentsRef.current = null;
  if (layoutParents.length === styleNodeIds.length)
    completeParentsRef.current = { owner: styleOwnerKey, parents: layoutParents };
  const presentedParents = layoutParents.length < styleNodeIds.length && completeParentsRef.current
    ? completeParentsRef.current.parents
    : layoutParents;
  const shownParents = heldParents ?? presentedParents;
  const heldState = heldDetails?.heldState ?? null;
  const originsContext = useDesignStyleOriginsContext(workspaceId);
  // The Styled-by filter belongs to the selection it was chosen for. A held
  // state narrows the panel to what it changes and leaves this filter as it
  // was, so Back to Default restores it.
  const [sourceFilter, setSourceFilter] = useState<{ owner: string; key: string } | null>(null);
  const sourceFilterKey = sourceFilter?.owner === styleOwnerKey ? sourceFilter.key : null;
  const defaultOrigins = useMemo(
    () => designFieldOrigins(layoutParents, originsContext, sourceFilterKey),
    [layoutParents, originsContext, sourceFilterKey],
  );
  const fieldOrigins = useMemo(
    () => (heldParents && heldChanges ? designFieldOrigins(heldParents, originsContext, null, heldChanges) : defaultOrigins),
    [defaultOrigins, heldChanges, heldParents, originsContext],
  );
  const fieldOriginsRef = useRef(fieldOrigins);
  fieldOriginsRef.current = fieldOrigins;
  /** The panel's overlays, for what a commit says under its field. */
  const overlaysApiRef = useRef<DesignFieldOverlaysApi | null>(null);
  const askAgentRef = useRef(onAskAgent);
  askAgentRef.current = onAskAgent;
  /** A forced value's card: the agent frees it, as the person sees it. A
   * value a control sets: the agent changes the control on the main. A
   * computed value on a layer with no CSS tab: the agent edits its source. */
  const askAgentToChange = useCallback(
    (properties: readonly string[]) => {
      const property = properties[0];
      const lock = property ? fieldOriginsRef.current.lock(property) : null;
      const { workspaceId: owner, frame: shown } = styleEditContextRef.current;
      const askAgent = askAgentRef.current;
      if (!askAgent || !property || !owner || !shown) return;
      if (lock?.kind === "control" && lock.controls?.length) {
        askAgent(designControlBoundValueBrief({
          directory: designWorkspaceSnapshotCache.peekSnapshot(owner).data?.directory ?? "",
          file: shown.file,
          title: shown.title,
          layer: lock.layer,
          nodeId: lock.nodeId,
          property,
          label: designStylePropertyLabel(property),
          controls: lock.controls,
        }));
        return;
      }
      // A component's layers have no CSS tab, so their computed card asks the agent.
      if (lock?.kind === "computed") {
        askAgent(designComputedValueBrief({
          directory: designWorkspaceSnapshotCache.peekSnapshot(owner).data?.directory ?? "",
          frame: shown.file,
          layer: lock.layer,
          nodeId: lock.nodeId,
          property,
          label: designStylePropertyLabel(property),
          value: lock.text,
        }));
        return;
      }
      if (lock?.kind !== "forced" || !lock.rule) return;
      askAgent(designForcedValueBrief({
        directory: designWorkspaceSnapshotCache.peekSnapshot(owner).data?.directory ?? "",
        frame: shown.file,
        layer: lock.layer,
        nodeId: lock.nodeId,
        property,
        label: designStylePropertyLabel(property),
        value: lock.text,
        rule: lock.rule,
        ...(lock.source ? { source: lock.source } : {}),
      }));
    },
    [],
  );
  // Anything but this single layer on this frame and generation, or a hidden
  // surface, lets a held state go.
  useEffect(() => {
    if (!workspaceId) return;
    releaseDesignNodeStateUnless(workspaceId, heldKey);
  }, [workspaceId, heldKey?.frame, heldKey?.sourceVersion, heldKey?.nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (workspaceId) releaseDesignNodeState(workspaceId); }, [workspaceId]);
  useDesignHeldReadOnly(inspectorRef, holding);
  const latestPickRef = useRef({ heldKey, elementDetails });
  latestPickRef.current = { heldKey, elementDetails };
  /** Hold a layer state: one request, painted when it answers. Letting go
   * (null) paints the retained Default box at once. Never awaited. */
  const pickLayerState = useCallback((state: DesignRuntimeNodeState | null) => {
    const { heldKey: key, elementDetails: rest } = latestPickRef.current;
    if (!key || !rest) return;
    if (state === null) {
      releaseDesignNodeState(key.workspaceId);
      paintDesignInspectorPreviewDetails(key.workspaceId, key.frame, rest);
      return;
    }
    holdDesignNodeState({
      ...key,
      state,
      onHeld: (held) => paintDesignInspectorPreviewDetails(key.workspaceId, key.frame, held),
    });
  }, []);
  /** A computed value's card: the CSS tab, which edits Default. */
  const editInCss = useCallback(() => {
    selectInspectorTab("css");
  }, [selectInspectorTab]);
  const currentStyleOwnerRef = useRef(styleOwner);
  currentStyleOwnerRef.current = styleOwner;
  const stylePreviewIntentRef = styleOwner.previewIntentRef;
  const replayStylePreviewRef = useRef<() => void>(() => {});
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
    async (
      styles: Record<string, string | null>,
      /** Each layer's own values, as a Mixed scrub writes them. */
      perNode?: (nodeId: string) => Record<string, string | null>,
    ) => {
      const context = styleOwner.contextRef.current;
      if (currentStyleOwnerRef.current !== styleOwner) return;
      const request: DesignStylePreviewRequest = { styles, perNode };
      const generation = context.active ? context.elementDetails?.sourceVersion ?? null : null;
      styleOwner.gesturePreview.ask(request, generation);
      if (!context.active) {
        // Waiting for the layers to read back: the live preview holds it so
        // it shows once they do.
        if (context.workspaceId && context.frame)
          for (const nodeId of context.styleNodeIds)
            publishDesignLivePreviewStyles(
              context.workspaceId,
              context.frame.file,
              nodeId,
              stylesForNode(nodeId, perNode ? perNode(nodeId) : styles, context),
            );
        return;
      }
      if (
        !context.workspaceId ||
        !context.folder ||
        !context.frame ||
        context.styleNodeIds.length === 0
      ) {
        throw new Error("Select one or more design layers first.");
      }
      const intent = ++stylePreviewIntentRef.current;
      const runtimeAtAsk = designFrameRuntime(context.workspaceId, context.frame.file);
      const ownStyles = (nodeId: string) => (perNode ? perNode(nodeId) : styles);
      for (const nodeId of context.styleNodeIds)
        publishDesignLivePreviewStyles(
          context.workspaceId,
          context.frame.file,
          nodeId,
          stylesForNode(nodeId, ownStyles(nodeId), context),
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
      let previewGeometries: Awaited<ReturnType<typeof previewDesignNodeGeometry>>[];
      try {
        previewGeometries = await Promise.all(
        context.styleNodeIds.map((nodeId) =>
          previewDesignNodeGeometry({
            workspaceId: context.workspaceId!,
            frame: context.frame!,
            nodeId,
            styles: stylesForNode(nodeId, ownStyles(nodeId), context),
            children: wantsChildren && nodeId === context.selectedNodeId,
          }),
        ),
        );
      } catch (error) {
        styleOwner.gesturePreview.failed(request);
        // A runtime that replaced the refusing one while this was in flight
        // has already announced itself; offer the preview to it now.
        if (designFrameRuntime(context.workspaceId, context.frame.file) !== runtimeAtAsk)
          replayStylePreviewRef.current();
        throw error;
      }
      if (
        stylePreviewIntentRef.current !== intent ||
        currentStyleOwnerRef.current !== styleOwner ||
        !styleOwner.contextRef.current.active
      ) {
        styleOwner.gesturePreview.failed(request);
        return;
      }
      if (generation) styleOwner.gesturePreview.shown(request, generation);
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

  // A new generation (an undo finishing, another edit) replaces the document
  // under a gesture's preview; show the same preview on it, and again on a
  // replacement runtime if that attempt did not reach the document.
  const styleGeneration = elementDetails?.sourceVersion ?? null;
  const styleFrameFile = frame?.file;
  useEffect(() => {
    if (!active || !workspaceId || !styleFrameFile) return;
    const replay = () => {
      if (currentStyleOwnerRef.current !== styleOwner) return;
      const generation = styleOwner.contextRef.current.active
        ? styleOwner.contextRef.current.elementDetails?.sourceVersion ?? null
        : null;
      const request = styleOwner.gesturePreview.replay(generation);
      if (!request) return;
      // Only a preview still showing returns: a save that landed, a restore
      // or an undo past it has already taken it out of the live preview.
      const context = styleOwner.contextRef.current;
      const showing = context.styleNodeIds.some((nodeId) =>
        Object.keys(request.perNode ? request.perNode(nodeId) : request.styles).some((property) =>
          designLivePreviewValue(workspaceId, styleFrameFile, nodeId, property) !== undefined));
      if (!showing) {
        styleOwner.gesturePreview.clear();
        return;
      }
      void previewSelectedStyles(request.styles, request.perNode).catch(() => {});
    };
    replayStylePreviewRef.current = replay;
    replay();
    // A runtime that goes away retires the frame's entry and the next one
    // replaces it, so any change to the entry is worth a cheap check.
    const entryOf = (state: ReturnType<typeof useDesignRuntimeStore.getState>) =>
      state.byWorkspace[workspaceId]?.frames[styleFrameFile];
    let last = entryOf(useDesignRuntimeStore.getState());
    return useDesignRuntimeStore.subscribe((state) => {
      const next = entryOf(state);
      if (next === last) return;
      last = next;
      replay();
    });
  }, [active, previewSelectedStyles, styleFrameFile, styleGeneration, styleOwner, workspaceId]);

  const restoreSelectedStylePreview = useCallback(async () => {
    styleOwner.gesturePreview.clear();
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
      intent?: "reset" | "token" | "detach",
      options?: DesignGestureCommit,
    ): Promise<void> => {
      const context = styleEditContextRef.current;
      // Retire stale callbacks during render, before passive unmount cleanup.
      // An eyedropper or a pending animation frame cannot follow a new layer.
      // A released gesture whose layers still read back at a new generation
      // takes its save: the values it showed are captured here and the lane
      // prepares the rest at its turn. Other edits wait for current details.
      if (currentStyleOwnerRef.current !== styleOwner || !(context.active || (options?.gesture && context.editable)))
        return Promise.resolve();
      styleOwner.gesturePreview.clear();
      // A held state is view only, answered or not: no value reaches the source.
      if (context.workspaceId && context.frame && designHeldStateHolds(context.workspaceId, context.frame.file, context.styleNodeIds))
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
      const { workspaceId, frame, styleNodeIds, stateContext } = context;
      // Capture each clicked layer's value before admitting the edit. The
      // shared lane performs only state-relative runtime preparation later.
      const updates = designSelectionStyleUpdates(styleNodeIds, styles, perNode).map(
        (update) => ({ nodeId: update.nodeId, styles: stylesForNode(update.nodeId, update.styles, context) }),
      );
      const previewIntent = stylePreviewIntentRef.current;
      const restoreStylePreview = async (assertCurrent: () => void) => {
        const assertPreviewCurrent = () => {
          assertCurrent();
          if (
            stylePreviewIntentRef.current !== previewIntent ||
            currentStyleOwnerRef.current !== styleOwner
          )
            throw new Error("The style preview owner changed during cleanup.");
        };
        if (
          stylePreviewIntentRef.current !== previewIntent ||
          currentStyleOwnerRef.current !== styleOwner
        ) return;
        await Promise.all(updates.map(async (update) => {
          try {
            assertPreviewCurrent();
            const restored = await clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId: update.nodeId,
            });
            assertPreviewCurrent();
            paintDesignInspectorPreviewDetails(workspaceId, frame.file, restored);
          } catch {
            /* The runtime may have been replaced by a newer generation. */
          }
        }));
      };
      const properties = Object.keys(styles).sort();
      const committedRoot =
        useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.frame;
      // Only a Hug frame resizes with its content; other layout edits keep the
      // direct style save. Behind a queued Undo, Redo or sizing edit, which can
      // make the root hug, the lane decides at its turn.
      const needsIntrinsicPreparation =
        !stateContext &&
        !!committedRoot &&
        (hasDesignIntrinsicSize(committedRoot) || hasPendingDesignRootSizing(workspaceId)) &&
        Object.keys(styles).some(designStylePropertyAffectsLayout);
      const transaction = (operations: DesignOperation[]) => ({
        schemaVersion: 1 as const,
        transactionId: `desktop:${crypto.randomUUID()}`,
        actor: { kind: "human" as const, id: "desktop" as const },
        intent: stateContext
          ? `Set ${properties.join(", ")} in the ${stateContext} state`
          : `Set ${properties.join(", ")} on ${updates.length} layers`,
        createdAt: Date.now(),
        coalesceKey: designStyleCommitCoalesceKey(styleNodeIds, properties, intent),
        operations,
      });
      const saved = needsIntrinsicPreparation
        ? applyDesignEditCached(workspaceId, frame, async ({ assertCurrent }) => {
            const { frame: currentFrame, runtime, assertFrameCurrent } =
              await readPreparedLayoutRuntime(workspaceId, frame.file, assertCurrent);
            const rootFrame =
              useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
                frame.file
              ]?.snapshot?.frame;
            const held = designHeldStateWatch(workspaceId, frame.file, styleNodeIds);
            let resizedFrame: DesignOperation | null = null;
            if (rootFrame && rootFrame.sourceVersion !== currentFrame.sourceVersion)
              throw new Error("The selected frame details are stale at the current generation.");
            assertFrameCurrent();
            if (rootFrame && hasDesignIntrinsicSize(rootFrame)) {
              if (!runtime.supports("measureLayout") || !runtime.measureLayout)
                throw new Error(
                  "This Design frame cannot safely prepare layout edits. Reload the frame and try again.",
                );
              const measured = await measureDesignLayoutUnheld(runtime, {
                updates,
                nodeIds: [...new Set([...styleNodeIds, rootFrame.oid])],
              }, held);
              assertFrameCurrent();
              if (!measured) {
                await restoreStylePreview(assertFrameCurrent);
                return null;
              }
              const current = designWorkspaceSnapshotCache
                .peekSnapshot(workspaceId)
                .data?.frames.find((entry) => entry.file === frame.file);
              if (!current || current.sourceVersion !== currentFrame.sourceVersion)
                throw new Error("The selected frame changed before style measurement completed.");
              const size = designHugFrameSize(measured.get(rootFrame.oid)!, current);
              if (size.width !== current.width || size.height !== current.height)
                resizedFrame = {
                  operationId: `layout:${crypto.randomUUID()}`,
                  type: "frame.set-geometry",
                  frame: frame.file,
                  geometry: { x: current.x, y: current.y, z: current.z, ...size },
                };
            }
            assertFrameCurrent();
            if (held.blocked()) {
              await restoreStylePreview(assertFrameCurrent);
              return null;
            }
            return transaction([
              ...updates.map((update) => ({
                operationId: `styles:${crypto.randomUUID()}`,
                type: "node.set-styles" as const,
                ...update,
                scope: "auto" as const,
                responsiveContext: "base" as const,
                stateContext: stateContext ?? "default",
              })),
              ...(resizedFrame ? [resizedFrame] : []),
            ]);
          }, undefined, {
            recover: async ({ assertCurrent }) => {
              await restoreStylePreview(assertCurrent);
            },
          }).then(() => {})
        : updates.length === 1 && !stateContext
          ? updateDesignNodeStylesCached(workspaceId, {
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              ...updates[0]!,
            }).then(() => {})
          : applyDesignEditCached(workspaceId, frame, transaction(updates.map((update) => ({
              operationId: `styles:${crypto.randomUUID()}`,
              type: "node.set-styles" as const,
              ...update,
              scope: "auto" as const,
              responsiveContext: "base" as const,
              stateContext: stateContext ?? "default",
            })))).then(() => {});
      // A plain value written over values the themes gave apart is one
      // value for all of them now; say so under the field once it saved.
      // Read before the write: after it, the value no longer differs.
      const themed =
        intent === undefined || intent === "detach"
          ? Object.keys(styles).find((property) => styles[property] !== null && fieldOriginsRef.current.themeChange(property))
          : undefined;
      if (themed) {
        const text = fieldOriginsRef.current.themeChange(themed)!;
        void saved.then(() => {
          if (currentStyleOwnerRef.current !== styleOwner) return;
          const field = inspectorRef.current?.querySelector<HTMLElement>(`[data-design-style-property="${CSS.escape(themed)}"]`);
          if (field) overlaysApiRef.current?.showFieldMessage(field, text, "info");
        }, () => {});
      }
      return saved;
    },
    [readPreparedLayoutRuntime, styleOwner, stylePreviewIntentRef, stylesForNode],
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
        "detach",
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
      }, undefined, "token").catch((error) =>
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
          description: "No selected layer changes this value over its class or component, or sets it in its own style.",
        });
        return;
      }
      const byNode = new Map(updates.map((update) => [update.nodeId, update.styles]));
      const styles = Object.assign({}, ...updates.map((update) => update.styles));
      const perNode = (nodeId: string) => byNode.get(nodeId) ?? {};
      // The canvas shows it at once, as a typed commit does, before the save.
      void previewSelectedStyles(styles, perNode).catch(() => {});
      void commitSelectedStyles(styles, perNode, "reset").catch((error) =>
        toast.error("Couldn't reset the value", { description: errorMessage(error) }),
      );
    },
    [commitSelectedStyles, previewSelectedStyles],
  );

  const previewLayoutAction = useCallback(
    async (action: DesignLayoutAction) => {
      const context = styleOwner.contextRef.current;
      if (currentStyleOwnerRef.current !== styleOwner || !context.active) return;
      if (!context.workspaceId || !context.frame) return;
      const owner = captureDesignPageOwner(context.workspaceId);
      const directoryRevision = useDesignWorkspaceUiStore.getState().byWorkspace[context.workspaceId]?.directoryRevision ?? 0;
      const historyOwnerKey = designInspectorHistoryOwnerKey(
        context.workspaceId,
        owner.directoryId,
        directoryRevision,
      );
      const historyPending = () => (pendingHistoryByOwnerRef.current.get(historyOwnerKey) ?? 0) > 0;
      if (!isCurrentDesignPageOwner(owner) || historyPending()) return;
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
            !styleOwner.contextRef.current.active ||
            !isCurrentDesignPageOwner(owner) ||
            historyPending()
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
    (action: DesignLayoutAction, options?: DesignGestureCommit): Promise<void> => {
      // As the style commit: a released gesture whose layers still read back
      // takes its save, prepared from confirmed measurements at its turn.
      const admissible = styleEditContextRef.current.active ||
        (options?.gesture === true && styleEditContextRef.current.editable);
      if (currentStyleOwnerRef.current !== styleOwner || !admissible)
        return Promise.resolve();
      const currentContext = styleEditContextRef.current;
      const { workspaceId, frame, stateContext } = currentContext;
      const styleNodeIds = [...currentContext.styleNodeIds];
      if (!workspaceId || !frame || styleNodeIds.length === 0)
        return Promise.resolve();
      if (designHeldStateHolds(workspaceId, frame.file, styleNodeIds))
        return Promise.resolve();
      const capturedFrame = { ...frame };
      const context = {
        ...currentContext,
        frame: capturedFrame,
        styleNodeIds,
      };
      const intent = ++stylePreviewIntentRef.current;
      const previewedNodeIds = new Set<string>();
      const previewPublications = new Map<string, DesignLivePreviewPublication>();
      const historyOwner = captureDesignPageOwner(workspaceId);
      const directoryRevision = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.directoryRevision ?? 0;
      const historyOwnerKey = designInspectorHistoryOwnerKey(
        workspaceId,
        historyOwner.directoryId,
        directoryRevision,
      );
      const canPaintPreview = () =>
        stylePreviewIntentRef.current === intent &&
        currentStyleOwnerRef.current === styleOwner &&
        (pendingHistoryByOwnerRef.current.get(historyOwnerKey) ?? 0) === 0;
      // A failed or skipped save must not leave its scrub painted on the canvas.
      const restorePreview = async (checkCurrent: () => void): Promise<void> => {
        admissionPaintOpen = false;
        const previewCurrent = () =>
          stylePreviewIntentRef.current === intent && currentStyleOwnerRef.current === styleOwner;
        if (!previewCurrent()) return;
        await Promise.all([...new Set([...styleNodeIds, ...previewedNodeIds])].map(async (nodeId) => {
          try {
            checkCurrent();
            if (!previewCurrent()) return;
            const publication = previewPublications.get(nodeId);
            if (publication) clearDesignLivePreview(workspaceId, capturedFrame.file, nodeId, publication);
            const restored = await clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: capturedFrame.file,
              sourceVersion: capturedFrame.sourceVersion,
              nodeId,
            });
            checkCurrent();
            if (previewCurrent()) paintDesignInspectorPreviewDetails(workspaceId, capturedFrame.file, restored);
          } catch {
            /* The runtime may have been replaced by a newer generation. */
          }
        }));
      };
      // A sizing choice paints at admission, from what is visible now
      // (including an earlier choice still saving), before any newer preview
      // can exist. Its durable values are still prepared from confirmed state.
      let admissionPaintOpen = true;
      if (action.type === "sizing" && action.mode !== "relative" && canPaintPreview()) {
        const runtimeState = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[capturedFrame.file];
        const frameRuntime = designFrameRuntime(workspaceId, capturedFrame.file);
        const { axis, mode } = action;
        // A target whose axis a control drives is not changed, so not previewed.
        for (const nodeId of designSizingTargets(workspaceId, capturedFrame, styleNodeIds.map((oid) => ({ oid })), axis).map((node) => node.oid)) {
          const cached =
            runtimeState?.detailsByNode[nodeId] ??
            (nodeId === currentContext.selectedNodeId ? currentContext.elementDetails : null);
          if (!cached || !frameRuntime?.supports("previewLayout")) continue;
          previewedNodeIds.add(nodeId);
          void (async () => {
            const visible = await frameRuntime.getNodeDetails(nodeId).catch(() => cached);
            if (!admissionPaintOpen || !canPaintPreview() || designFrameRuntime(workspaceId, capturedFrame.file) !== frameRuntime) return;
            const styles = designSizingStyles(visible, axis, mode);
            previewPublications.set(nodeId, publishDesignLivePreviewStyles(workspaceId, capturedFrame.file, nodeId, styles));
            const geometries = await frameRuntime.previewLayout({ updates: [{ nodeId, styles }], nodeIds: [nodeId] });
            if (!canPaintPreview()) return;
            for (const geometry of geometries)
              paintDesignInspectorPreviewDetails(workspaceId, capturedFrame.file, geometry);
          })().catch(() => {}); // The durable preparation reports an unsupported choice.
        }
      }
      const saved = applyDesignEditCached(workspaceId, capturedFrame, async ({ assertCurrent }) => {
        assertCurrent();
        const { frame: currentFrame, runtime, assertFrameCurrent } =
          await readPreparedLayoutRuntime(workspaceId, capturedFrame.file, assertCurrent);
        assertFrameCurrent();
        if (!runtime.supports("measureLayout") || !runtime.measureLayout)
          throw new Error(
            "This Design frame cannot safely prepare layout edits. Reload the frame and try again.",
          );
        // A hold can begin while these reads are awaited: what they return
        // inside it is the state's, never Default to write.
        const held = designHeldStateWatch(workspaceId, frame.file, styleNodeIds);
        const measureConfirmed = async (nodeIds: readonly string[]) => {
          const ids = [...new Set(nodeIds)];
          const confirmed = new Map<string, DesignRuntimeNodeDetails>();
          for (let offset = 0; offset < ids.length; offset += 64) {
            const chunk = ids.slice(offset, offset + 64);
            assertFrameCurrent();
            const measured = await runtime.measureLayout({ updates: [], nodeIds: chunk });
            assertFrameCurrent();
            const byNode = new Map(measured.map((node) => [node.oid, held.read(node)]));
            for (const nodeId of chunk) {
              const node = byNode.get(nodeId);
              if (!node) throw new Error(`The requested Design layer is no longer available: ${nodeId}.`);
              confirmed.set(nodeId, node);
            }
          }
          return confirmed;
        };
        const rootFrame =
          useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
            capturedFrame.file
          ]?.snapshot?.frame;
        if (!rootFrame || rootFrame.sourceVersion !== currentFrame.sourceVersion)
          throw new Error(`Design frame details changed before the mutation: ${capturedFrame.file}.`);
        const detailsByNode = await measureConfirmed([
          ...styleNodeIds,
          rootFrame.oid,
        ]);
        const details = styleNodeIds.map((nodeId) => detailsByNode.get(nodeId)).filter(
          (node): node is DesignRuntimeNodeDetails => node !== undefined,
        );
        if (details.length !== styleNodeIds.length)
          throw new Error("The selected Design layers are no longer available.");
        assertFrameCurrent();
        let updates: Map<string, Record<string, string | null>>;
        if (
          (action.type === "align" || action.type === "distribute") &&
          action.target === "self" &&
          details.length > 1
        ) {
          updates = designLayoutSelectionUpdates(details, action);
        } else if (
          isDesignLayoutChildAction(action) ||
          action.type === "auto-layout"
        ) {
          const children = designLayoutChildrenSummary(details);
          if (children.truncated)
            throw new Error(
              "Select a smaller frame to arrange its children together.",
            );
          const childDetails = await measureConfirmed(children.nodeIds);
          const liveChildren = [...childDetails.values()];
          // Shift+A leaves an existing layout, and a layer with nothing to
          // lay out, exactly as they are.
          if (action.type === "auto-layout" && action.infer &&
            (liveChildren.length === 0 || details.some((node) => designAutoLayoutFlow(node) !== "none"))) return null;
          updates =
            action.type === "auto-layout"
              ? designAutoLayoutUpdates(details, liveChildren,
                  action.infer ? designInferredAutoLayoutFlow(liveChildren) : action.flow,
                  { drawnSpacing: action.infer === true })
              : designLayoutChildUpdates(details, liveChildren, action);
        } else if (action.type === "sizing" && action.mode === "relative") {
          // A percentage resolves against the parent, so each layer reads its
          // own parent's padding.
          const sized = designSizingTargets(workspaceId, currentFrame, details, action.axis);
          if (!sized.length) return null;
          const parents = await measureConfirmed(sized.flatMap((node) =>
            node.layout?.parentId ? [node.layout.parentId] : [],
          ));
          updates = new Map(
            sized.map((node) => [
              node.oid,
              designRelativeSizeStyles(node, parents.get(node.layout?.parentId ?? "") ?? null, action.axis),
            ]),
          );
        } else if (action.type === "sizing") {
          const { mode } = action;
          if (mode === "relative") return null;
          const sized = designSizingTargets(workspaceId, currentFrame, details, action.axis);
          if (!sized.length) return null;
          updates = new Map(
            sized.map((node) => [
              node.oid,
              designSizingStyles(node, action.axis, mode),
            ]),
          );
          if (action.mode === "fill") {
            const parentIds = [
              ...new Set(
                sized.flatMap((node) =>
                  node.layout?.parentId ? [node.layout.parentId] : [],
                ),
              ),
            ];
            const parents = await measureConfirmed(parentIds);
            for (const parent of parents.values()) {
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
          const parents = await measureConfirmed(parentIds);
          updates = designLayoutChildUpdates([...parents.values()], targets, {
            type: "center",
          });
          for (const node of targets)
            updates.set(node.oid, {
              ...updates.get(node.oid),
              ...designLayoutActionStyles(node, action),
            });
        } else {
          updates = designLayoutActionUpdates(
            details,
            designLayoutActionForConfirmedDetails(action),
          );
        }
        // A fixed canvas frame is sized by its viewport metadata. Its shell
        // continues to follow that viewport after later canvas resizes. A
        // main's root is the component, sized as itself, not a shell.
        const rootStyles = context.layoutRootId && frameComponentPresentation?.kind !== "main"
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
        for (const [nodeId, styles] of [...updates]) {
          const kept = designWithoutBoundStyles(workspaceId, currentFrame, nodeId, styles);
          if (kept) updates.set(nodeId, kept);
          else updates.delete(nodeId);
        }
        if (updates.size === 0 || held.blocked()) return null;
        const fittedRoot =
          action.type === "resize-fit" && !stateContext
            ? details.find(
                (node) =>
                  node.oid === context.layoutRootId && updates.has(node.oid),
              )
            : undefined;
        const fittedGeometry = fittedRoot
          ? {
              x: currentFrame.x,
              y: currentFrame.y,
              z: currentFrame.z,
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
            stateContext: stateContext ?? "default",
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
        for (const nodeId of updates.keys()) previewedNodeIds.add(nodeId);
        const batch = [...updates].map(([nodeId, styles]) => ({
          nodeId,
          styles,
        }));
        assertFrameCurrent();
        if (canPaintPreview()) {
          admissionPaintOpen = false;
          for (const update of batch) {
            previewPublications.set(update.nodeId, publishDesignLivePreviewStyles(
              workspaceId,
              capturedFrame.file,
              update.nodeId,
              update.styles,
            ));
          }
          // Shift+A paints in the frame now; the saved source replaces the
          // preview, and a failed save restores every previewed layer.
          if (action.type === "auto-layout")
            for (const update of batch) void runtime.previewStyles(update.nodeId, update.styles).catch(() => null);
        }
        assertFrameCurrent();
        const proposedDetails = await runtime.measureLayout({
          updates: batch,
          nodeIds: [...new Set([...styleNodeIds, rootFrame.oid])],
        });
        assertFrameCurrent();
        const proposedByNode = new Map(proposedDetails.map((node) => [node.oid, held.read(node)]));
        const root = proposedByNode.get(rootFrame.oid) ?? null;
        if (
          root &&
          (hasDesignIntrinsicSize(root) ||
            (action.type === "sizing" && updates.has(root.oid)))
        ) {
          // A hold can begin on the root after the preview let go of any.
          assertFrameCurrent();
          const measured = root && !held.blocked() ? root : null;
          if (!measured) {
            if (stylePreviewIntentRef.current === intent) await restorePreview(assertFrameCurrent);
            return null;
          }
          const current =
            designWorkspaceSnapshotCache
              .peekSnapshot(workspaceId)
              .data?.frames.find((entry) => entry.file === capturedFrame.file);
          if (!current || current.sourceVersion !== currentFrame.sourceVersion)
            throw new Error(`Design frame changed before the mutation: ${capturedFrame.file}. Re-read it and retry.`);
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
              frame: capturedFrame.file,
              geometry: { x: current.x, y: current.y, z: current.z, ...size },
            });
        }
        if (operations.length > DESIGN_TRANSACTION_MAX_OPERATIONS)
          throw new Error(
            "Select a smaller frame to arrange its children together.",
          );
        // Nothing is persisted once a hold has met the edit.
        if (held.blocked()) {
          if (stylePreviewIntentRef.current === intent) await restorePreview(assertFrameCurrent);
          return null;
        }
        assertFrameCurrent();
        return {
          schemaVersion: 1,
          transactionId: `desktop:${crypto.randomUUID()}`,
          actor: { kind: "human", id: "desktop" },
          intent: `Update layout on ${styleNodeIds.length} layers`,
          createdAt: Date.now(),
          operations,
        };
      }, undefined, {
        recover: async ({ assertCurrent }) => {
          await restorePreview(assertCurrent);
        },
      }).then(() => {});
      // A sizing or auto-layout choice can make the root hug before later edits' turns.
      return action.type === "sizing" || action.type === "auto-layout"
        ? trackDesignRootSizing(workspaceId, saved)
        : saved;
    },
    [readPreparedLayoutRuntime, styleOwner, stylePreviewIntentRef, frameComponentPresentation?.kind],
  );
  useLayoutEffect(() => { layoutShortcutRef.current = commitLayoutAction; }, [commitLayoutAction]);

  const styleContext =
    workspaceId && folder && frame && presentedTargetNodeId && presentedElementDetails
      ? { workspaceId, folder, frame, nodeId: presentedTargetNodeId }
      : null;
  const styleField = (
    label: string,
    property: string,
    value: string,
    options?: DesignLayoutFieldOptions,
  ) => {
    if (!styleContext) return null;
    // On a main, a value a control drives is that control's: the field shows
    // the control while the winner reads it, and otherwise is locked, its
    // card naming what sets it.
    const boundControls = [...new Set([property, ...(options?.linkedProperties ?? [])].flatMap((name) => designBoundControlsFor(mainBoundStyles, name)))];
    const boundControl = boundControls.length ? boundStyleField(label, property, boundControls) : null;
    if (boundControl) return boundControl;
    // A main's W and H are its root's, the component's own size; its X and Y
    // still place the frame.
    const frameGeometryProperty = frameStyleTarget &&
      !(frameComponentPresentation?.kind === "main" && (property === "width" || property === "height"))
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
          active={active && styleActive}
          label={label}
          whole={options?.whole}
          range={
            geometryKey === "w" || geometryKey === "h"
              ? DESIGN_FRAME_SIZE_RANGE
              : DESIGN_FRAME_POSITION_RANGE
          }
          compact={options?.compact}
          disabled={styleEditsDisabled || !styleActive}
          revalidating={!elementDetails && !editsDisabled && styleActive}
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
            if (!styleEditContextRef.current.active) return;
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
              const rootNodeId = elementDetails.oid;
              const confirmedRoot = elementDetails;
              const axes = { width: geometryKey === "w", height: geometryKey === "h" };
              await applyDesignEditCached(owner, target, async ({ assertCurrent }) => {
                let latest: typeof target;
                let rootStyles: Record<string, string | null>;
                const current = designWorkspaceSnapshotCache.peekSnapshot(owner).data?.frames.find(
                  (candidate) => candidate.file === target.file,
                ) ?? target;
                let live = designFrameRuntime(owner, target.file);
                if (live && live.sourceVersion !== current.sourceVersion)
                  live = await waitForDesignFrameRuntime(owner, target.file, 2_000, {
                    sourceVersion: current.sourceVersion,
                  });
                assertCurrent();
                if (!live) {
                  // A frame that runs no document at this generation, such as
                  // one too small on screen or still reloading, has no preview
                  // over its confirmed readback.
                  latest = designWorkspaceSnapshotCache.peekSnapshot(owner).data?.frames.find(
                    (candidate) => candidate.file === target.file,
                  ) ?? target;
                  rootStyles = designFrameRootFixedStyles(confirmedRoot, axes);
                } else {
                  const prepared = await readPreparedLayoutRuntime(owner, target.file, assertCurrent);
                  const { runtime, assertFrameCurrent } = prepared;
                  latest = prepared.frame;
                  assertFrameCurrent();
                  if (!runtime.supports("measureLayout") || !runtime.measureLayout)
                    throw new Error(
                      "This Design frame cannot safely prepare layout edits. Reload the frame and try again.",
                    );
                  // Confirmed source, never a newer padding or border preview.
                  const held = designHeldStateWatch(owner, target.file, [rootNodeId]);
                  const measured = await measureDesignLayoutUnheld(
                    runtime,
                    { updates: [], nodeIds: [rootNodeId] },
                    held,
                  );
                  assertFrameCurrent();
                  if (!measured)
                    throw new Error("The frame's state changed while its size was prepared. Try again.");
                  rootStyles = designFrameRootFixedStyles(measured.get(rootNodeId)!, axes);
                }
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
                      nodeId: rootNodeId,
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
    const authoredProperties = shownDetails?.authoredStyleProperties;
    const applied = isDesignRuntimeStylePropertyAuthored(
      authoredProperties,
      property,
      value,
    );
    // The same value from different tokens is Mixed too: a pill shows only
    // when every selected layer names one token.
    const mixed =
      options?.mixed ||
      designFieldMixed(shownParents, presentedNodeCount, property, {
        geometry: options?.geometry,
        whole: options?.whole,
        linkedProperties: options?.linkedProperties,
      }) ||
      designValuesMixed(
        shownParents.map(
          (node) => designStyleTokenDisplay(node, property, styleOriginLabel)?.name ?? "",
        ),
        presentedNodeCount,
      );
    return (
      <InspectorStyleField
        key={`${styleContext.workspaceId}:${styleContext.frame.file}:${styleNodeIds.join(":")}:${property}`}
        workspaceId={styleContext.workspaceId}
        frame={styleContext.frame.file}
        nodeId={styleContext.nodeId}
        active={active && styleActive}
        label={label}
        property={property}
        value={
          // A Mixed field never shows one layer's value, even when that
          // layer reads back ahead of the others mid-scrub.
          mixed ? "" :
          (!options?.geometry && shownDetails ? designAuthoredLength(shownDetails, property) : null) ??
          designStyleFieldValue(authoredProperties, property, value)
        }
        computedValue={value}
        options={mixed ? { ...options, mixed } : options}
        details={shownDetails ?? undefined}
        selection={shownParents}
        originLabel={styleOriginLabel}
        onLayoutAction={commitLayoutAction}
        onPreviewLayoutAction={previewLayoutAction}
        disabled={styleEditsDisabled || !styleActive}
        revalidating={!elementDetails && !editsDisabled && styleActive}
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

  const namedDetails = elementDetails ?? handed?.details ?? null;
  const selectionName =
    styleNodeIds.length > 1
      ? `${styleNodeIds.length} layers`
      : namedDetails
        ? designRuntimeLayerLabel(namedDetails)
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
          : namedDetails
            ? designRuntimeLayerDisplayName(namedDetails)
            : null;
  // A frame whose file declares options is a component: its Controls section
  // mounts only while the frame itself is selected and the panel is shown.
  // One selected instance in another frame shows that instance's; a part of
  // one names the instance and shows nothing to edit.
  const selectedPart = selectedNodeId ? designComponentPartOf(selectedNodeId) : null;
  const selectedSlot = selectedNodeId ? designComponentSlotOf(selectedNodeId) : null;
  const instanceNodeId = selectedPart?.host ?? selectedSlot?.host ??
    (frameSelected
      ? explicitFrameIdentityNodeId ?? legacyExactInstanceNodeId
      : styleNodeIds.length <= 1 ? selectedNodeId : null);
  // Own entries only: a layer id such as "constructor" is not a host.
  const instanceHost = instanceNodeId && frame?.instances && Object.hasOwn(frame.instances.hosts, instanceNodeId)
    ? frame.instances.hosts[instanceNodeId] : undefined;
  const instanceComponent = instanceHost && frame?.instances && Object.hasOwn(frame.instances.components, instanceHost.component)
    ? frame.instances.components[instanceHost.component] : undefined;
  const instanceTitle = instanceHost && instanceComponent && workspaceId
    ? designComponentTitle(workspaceId, instanceHost.component, instanceComponent)
    : null;
  const mainComponent = frame?.component ?? (frameComponentPresentation?.kind === "main"
    ? EMPTY_COMPONENT_DECLARATION
    : undefined);
  // The main's root is the component, so selecting it selects the main.
  const mainRootSelected = !!frame && designInspectorMainRootSelected({ main: frameComponentPresentation?.kind === "main",
    frameSelected, selectedNodeId, layoutRootId, count: styleNodeIds.length });
  const instanceSelected = !mainRootSelected && !selectedPart && !selectedSlot && !!instanceNodeId && !!instanceHost &&
    (styleNodeIds.length === 1 || (frameSelected && explicitFrameIdentityNodeId === instanceNodeId && styleNodeIds.length === 0));
  const selectionKind = designInspectorSelectionKind({
    count: styleNodeIds.length,
    mainRoot: mainRootSelected,
    mainLayer: frameComponentPresentation?.kind === "main" && !!selectedNodeId && selectedNodeId !== layoutRootId,
    instance: instanceSelected || (styleNodeIds.length > 1 && !!frame?.instances &&
      styleNodeIds.some((nodeId) => Object.hasOwn(frame.instances!.hosts, nodeId))),
    inner: selectedPart !== null || selectedSlot !== null ||
      (styleNodeIds.length > 1 && styleNodeIds.some((nodeId) => isDesignComponentPartNodeId(nodeId))),
  });
  const instanceOptionsTarget: DesignComponentOptionsTarget | null = frame && instanceNodeId && instanceHost && instanceComponent && instanceTitle
    ? { kind: "instance", nodeId: instanceNodeId, title: instanceTitle, host: instanceHost, component: instanceComponent,
        ...(frame.instances?.notApplied ? { notApplied: frame.instances.notApplied } : {}) }
    : null;
  const optionsTarget: DesignComponentOptionsTarget | null = !workspaceId || !active || !panelVisible || !frame
    ? null
    : mainRootSelected
      ? { kind: "main", component: mainComponent!, ...(frame.component ? {} : { undeclared: true as const }) }
      : instanceSelected ? instanceOptionsTarget : null;
  // A part or slot shows its instance's Controls: a part only those bound to
  // it, once the record says which (without bindings, all of them).
  const controlsTarget = optionsTarget ?? (selectionKind === "component-inner" && workspaceId && active && panelVisible
    ? instanceOptionsTarget
    : null);
  const partControls = selectedPart && frame ? designPartControls(frame, selectedNodeId!) : null;
  const layerControls = partControls?.length && selectedPart
    ? { controls: partControls, layer: { id: designBindingLayerId(selectedPart.part), name: selectionTitle ?? selectionName } }
    : undefined;
  // A layer inside a main shows above its Style the controls that set its
  // text, visibility or attributes, and any its style reads that no field
  // showed in its place (measured after layout: a text layer has no radius).
  const mainLayerKey = selectionKind === "main-layer" && frame && selectedNodeId && workspaceId && active && panelVisible
    ? JSON.stringify([workspaceId, frame.file, selectedNodeId])
    : null;
  const [notInPlace, setNotInPlace] = useState<{ key: string; controls: readonly string[] } | null>(null);
  const inPlaceRef = useRef(new Set<string>());
  inPlaceRef.current = new Set();
  const mainLayerBase = mainLayerKey ? designMainLayerControls(mainComponent, selectedNodeId!) : null;
  const mainLayerControls = mainLayerBase && notInPlace?.key === mainLayerKey && notInPlace.controls.length
    ? [...mainLayerBase, ...notInPlace.controls]
    : mainLayerBase;
  const optionsFrame = controlsTarget ? frame : null;
  const componentIdentity = optionsTarget?.kind === "main" && frame
    ? designComponentIdentityLabel(frame.title, shownVariant)
    : null;
  const instanceIdentity = frame && instanceNodeId
    ? designComponentInstanceIdentity(frame, instanceNodeId, (file) => designWorkspaceSnapshotCache.peekSnapshot(workspaceId ?? "").data?.frames.find((candidate) => candidate.file === file)?.title)
    : null;
  const selectionKey = frameSelected && !selectedNodeId
    ? ["frame-root"]
    : styleNodeIds.length ? styleNodeIds : selectedNodeId ? [selectedNodeId] : ["page"];
  const inspectorTabKey = designInspectorTabKey({
    workspaceId,
    directoryId: previewDirectoryId,
    pageId: activePageId ?? null,
    frameFile: frame?.file ?? null,
    selection: selectionKey,
  });
  const similarTabKey = designInspectorSimilarTabKey({ workspaceId, directoryId: previewDirectoryId }, selectionKind);
  tabKeyRef.current = inspectorTabKey;
  tabSimilarityKeyRef.current = similarTabKey;
  const storedTab = tabPreference?.key === inspectorTabKey
    ? tabPreference.value
    : designInspectorTabForSelection(tabPreferencesRef.current, inspectorTabKey, similarTabKey);
  const inspectorTabs = designInspectorTabs(selectionKind);
  const activeTab = designInspectorActiveTab(selectionKind, storedTab) ?? "style";
  // An instance's Size sits in its Controls panel, so the style fields are
  // live while whichever panel holds them is shown.
  const styleActive = selectionKind === "instance" ? activeTab === "options" : inspectorTabs.includes("style") && activeTab === "style";
  const cssActive = activeTab === "css";
  // An instance whose main is gone renders nothing; it is named by the
  // component it asks for rather than read as an empty Frame.
  const missingComponent = frame && instanceNodeId && !selectedPart && !selectedSlot && styleNodeIds.length <= 1
    ? designMissingComponentOf(frame, instanceNodeId)
    : null;
  // As in Layers, the header names the instance by its component, and a part
  // or slot by its instance's component and its own name; Escape selects the
  // instance from either.
  const componentHeader = instanceTitle && instanceComponent && instanceNodeId && (selectedPart || selectedSlot || optionsTarget?.kind === "instance")
    ? { title: instanceTitle, identity: instanceIdentity ?? designComponentIdentityLabel(instanceTitle, null), component: instanceComponent,
        host: instanceNodeId, part: selectedPart?.part ?? null, slot: selectedSlot?.name ?? null }
    : null;
  const headerInner = !!componentHeader && (componentHeader.part !== null || componentHeader.slot !== null);
  const textLock = frame && selectedNodeId ? designComponentTextLock(frame, selectedNodeId) : null;
  const selectionType = optionsTarget?.kind === "main"
    ? "Component"
    : missingComponent ? "Missing component"
    : selectionTitle && selectionTitle !== selectionName ? selectionName : null;
  const openMain = (file: string, part: string | null, pageId?: string) => {
    if (!workspaceId || !folder) return;
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    zoomActionsRef.current?.revealFrames?.({ files: [file], pageId: pageId ?? snapshot?.pages?.find((page) => page.frameFiles.includes(file))?.id });
    // A part's layer on the main has the id the part was made from.
    const nodeId = part ? part.replace(/#.*$/, "") : null;
    void selectDesignTargets({ workspaceId, folder, targets: [{ frame: file, ...(nodeId ? { nodeId } : {}) }] })
      .catch((error) => toast.error("Couldn't open the main component", { description: errorMessage(error) }));
  };
  // A components/ file is not on the canvas; moving it there makes it a main
  // frame like any other, which Edit main then opens.
  const editMain = () => {
    if (!workspaceId || !folder || !componentHeader || !instanceHost) return;
    const { component, part } = componentHeader;
    if (component.frame) return openMain(component.file, part);
    void moveDesignComponentCached(workspaceId, instanceHost.component, activePageId ?? undefined)
      .then((moved) => openMain(moved.frame.file, part, moved.frame.pageId))
      .catch((error) => toast.error("Couldn't move the main to the canvas", { description: errorMessage(error) }));
  };
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

  // A hidden layer stays editable; the header says so, and offers Show when
  // the layer hides itself: the Layers eye's canvas visibility, which writes
  // no source and so adds no undo step.
  const hiddenBy = styleNodeIds.length === 1 ? elementDetails?.hiddenBy : undefined;
  const showSelectedLayer = () => {
    if (!workspaceId || !folder || !frame || !elementDetails) return;
    void setDesignNodeVisibility({
      workspaceId,
      folder,
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: elementDetails.oid,
      visible: true,
    }).catch((error) => {
      toast.error("Couldn't show the layer", { description: errorMessage(error) });
    });
  };
  const zoomMenu = (
    <DesignZoomMenu
      zoom={zoom}
      disabled={!active || !workspaceId}
      historyOwner={workspaceId ?? undefined}
      zoomActionsRef={zoomActionsRef}
    />
  );
  const inspectorSelectionHeader = (
    <section className="border-border1 shrink-0 border-b">
      <div
        data-design-inspector-header=""
        data-design-selection-type={selectionName}
        data-design-component-of={componentHeader ? componentHeader.slot !== null ? "slot" : componentHeader.part ? "part" : "instance" : undefined}
        className="flex h-10 min-w-0 items-center gap-2 pr-1.5 pl-3"
      >
        {selectionName === "Page" && workspaceId && pages?.length ? (
          <DesignPagePicker workspaceId={workspaceId} directoryId={previewDirectoryId} pages={pages}
            activePageId={activePageId} frames={pageFrames ?? []} active={active} />
        ) : <>
          {componentHeader || optionsTarget?.kind === "main" || missingComponent
            ? componentHeader
              ? <Diamond className="text-violet-text size-3.5 shrink-0" aria-hidden="true" />
              : <ComponentGlyph className="text-violet-text fill-current size-3.5 shrink-0" aria-hidden="true" />
            : <SelectionGlyph className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />}
          {componentHeader && headerInner ? (
            // The identity gives way first, so the layer's name always shows.
            <span data-design-inspector-title="" className="text-violet-text flex min-w-0 flex-1 gap-1 text-xs font-medium">
              <span data-design-inspector-title-identity="" className="min-w-0 truncate">{componentHeader.identity}</span>
              <span data-design-inspector-title-layer="" className="max-w-1/2 shrink-0 truncate">
                {/* A slot reads as Layers names it, not by its frame. */}
                {`· ${componentHeader.slot !== null ? `${designComponentSlotLabel(componentHeader.slot)} slot` : selectionTitle ?? selectionName}`}
              </span>
            </span>
          ) : (
            componentHeader && componentHeader.identity.lastIndexOf("/") > 0 ? (
              // The component's name gives way first, so its variant stays readable.
              <span data-design-inspector-title="" className="text-violet-text flex min-w-0 flex-1 text-xs font-medium">
                <span data-design-inspector-title-identity="" className="min-w-0 truncate">
                  {componentHeader.identity.slice(0, componentHeader.identity.lastIndexOf("/"))}
                </span>
                <span data-design-inspector-title-variant="" className="max-w-1/2 shrink-0 truncate">
                  {componentHeader.identity.slice(componentHeader.identity.lastIndexOf("/"))}
                </span>
              </span>
            ) : (
              <span data-design-inspector-title="" className={cn(componentHeader || optionsTarget?.kind === "main" ? "text-violet-text" : "text-fg1", "min-w-0 flex-1 truncate text-xs font-medium")}>
                {componentHeader
                  ? componentHeader.identity
                  : optionsTarget?.kind === "main" ? componentIdentity : missingComponent ? `zd-${missingComponent}` : selectionTitle ?? selectionName}
              </span>
            )
          )}
          {componentHeader ? (
            <Button type="button" variant="ghost" size="compact" data-design-edit-main="" disabled={!componentHeader.component.frame && !active} onClick={editMain}>
              {componentHeader.component.frame ? "Edit main" : "Move main to canvas"}
            </Button>
          ) : selectionType ? (
            <span className="text-fg3 shrink-0 text-3xxs leading-4 tabular-nums">{selectionType}</span>
          ) : null}
          {hiddenBy === "self" ? (
            <>
              <span data-design-hidden="self" className="text-fg2 shrink-0 text-3xxs leading-4">Hidden</span>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                data-design-hidden-show=""
                disabled={editsDisabled}
                onClick={showSelectedLayer}
              >
                Show
              </Button>
            </>
          ) : hiddenBy === "ancestor" ? (
            <span data-design-hidden="ancestor" className="text-fg3 shrink-0 text-3xxs leading-4">In a hidden layer</span>
          ) : null}
        </>}
        {inspectorTabs.length > 1 ? null : zoomMenu}
      </div>
      {missingComponent ? (
        <MessageRow
          tone="error"
          role="alert"
          data-design-component-missing={missingComponent}
          className="border-border1 border-t"
          title={`The main of zd-${missingComponent} is gone: it was deleted, renamed or unregistered, so this instance shows nothing.`}
        >
          {`Component zd-${missingComponent} is missing`}
        </MessageRow>
      ) : null}
    </section>
  );
  const exportSection =
    frame && folder && (frameSelected || selectedNodeId) ? (
      <InspectorSection title="Export" data-design-export-section="">
        <Button type="button" variant="secondary" size="compact" className="w-full" disabled={openingPreview || !active || !previewAllowed} onClick={() => void openPreview()}>
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
            size="compact"
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
  const cssTargetLabel = selectionTitle ?? selectionName;
  /** The style fields for the selection, with the providers their marks,
   * cards and tokens read; an instance and several selected instances get only
   * their Size. */
  const styleEditor = (only?: "size", boundSize?: { x?: React.ReactNode; y?: React.ReactNode }) => {
    const details = presentedElementDetails;
    if (!styleContext || !details) return null;
    return (
            <DesignStyleOriginLabelContext.Provider value={styleOriginLabel}>
              <DesignFieldOriginsContext.Provider value={controlOrigins}>
              <DesignTokenCatalogContext.Provider value={tokenCatalog}>
              <DesignTokenDetachContext.Provider value={detachSelectedToken}>
              <DesignFieldOverlays
                rootRef={inspectorRef}
                active={active && styleActive}
                ownerKey={styleOwnerKey}
                origins={controlOrigins}
                disabled={styleEditsDisabled || !styleActive}
                readOnly={holding}
                apiRef={overlaysApiRef}
                onChooseToken={chooseFieldToken}
                onReset={resetField}
                onEditInCss={inspectorTabs.includes("css") ? editInCss : undefined}
                onAskAgent={askAgentToChange}
                onOpenControls={selectionKind === "main-root" ? () => selectInspectorTab("options") : undefined}
              >
                <DesignColorRevalidatingContext.Provider value={!elementDetails && !editsDisabled && styleActive}>
                <DesignStyleEditor
                  key={styleOwner.key}
                  only={only}
                  boundSize={boundSize}
                  details={shownDetails ?? details}
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
                    frameStyleTarget || details.oid === layoutRootId
                  }
                  layoutParents={shownParents}
                  selectionCount={presentedNodeCount}
                  active={active && styleActive}
                  disabled={styleEditsDisabled || !styleActive}
                  onPreviewStyles={previewSelectedStyles}
                  onCancelStylePreview={clearSelectedStylePreview}
                  onCommitStyles={commitSelectedStyles}
                  motionTimelineOpen={motionTimelineOpen}
                  motionProperties={motionProperties}
                  onOpenMotionTimeline={onOpenMotionTimeline}
                />
                </DesignColorRevalidatingContext.Provider>
              </DesignFieldOverlays>
              </DesignTokenDetachContext.Provider>
              </DesignTokenCatalogContext.Provider>
              </DesignFieldOriginsContext.Provider>
            </DesignStyleOriginLabelContext.Provider>
    );
  };
  const optionsPanel = designInspectorPanelState(activeTab, "options");
  // An instance's root size a control drives shows that control in Size.
  const boundSizeControl = (controls: readonly string[], axis: "x" | "y") => controls.length && optionsFrame && controlsTarget?.kind === "instance" && workspaceId ? (
    <React.Suspense key={axis} fallback={null}>
      <DesignComponentOptions
        workspaceId={workspaceId}
        frame={optionsFrame}
        target={controlsTarget}
        directory=""
        lint={lint}
        active={active && optionsPanel.active}
        disabled={!active || !optionsPanel.active}
        only={{ controls, layer: { id: controlsTarget.nodeId, name: controlsTarget.title } }}
        embedded
      />
    </React.Suspense>
  ) : undefined;
  const instanceBound = selectionKind === "instance" && instanceNodeId && workspaceId ? designLayerBoundStyles(workspaceId, frame, instanceNodeId) : null;
  const instanceRootSize = instanceBound ? { width: designBoundControlsFor(instanceBound, "width"), height: designBoundControlsFor(instanceBound, "height") } : null;
  const instanceAxes = instanceRootSize ? designSizeAxisControls(instanceRootSize) : null;
  const instanceBoundSize = instanceAxes && (instanceAxes.width.length || instanceAxes.height.length || instanceAxes.heightShared)
    ? { x: boundSizeControl(instanceAxes.width, "x"), y: instanceAxes.heightShared ? SHARED_HEIGHT : boundSizeControl(instanceAxes.height, "y") }
    : undefined;
  const instanceSizeControls = instanceBoundSize ? [...(instanceRootSize?.width ?? []), ...(instanceRootSize?.height ?? [])] : [];
  const stylePanel = designInspectorPanelState(activeTab, "style");
  const cssPanel = designInspectorPanelState(activeTab, "css");
  // A main's own layers: what its controls drive, statically and as the
  // runtime reported for this layer.
  const mainBoundStyles = workspaceId && frame && styleContext && frameComponentPresentation?.kind === "main" && mainComponent
    ? designLayerBoundStyles(workspaceId, frame, styleContext.nodeId)
    : NO_BOUND_STYLES;
  const mainControl = (controls: readonly string[], key: string, name: string) => workspaceId && frame && mainComponent ? (
    <React.Suspense key={key} fallback={null}>
      <DesignComponentOptions
        workspaceId={workspaceId}
        frame={frame}
        target={{ kind: "main", component: mainComponent, ...(frame.component ? {} : { undeclared: true as const }) }}
        directory=""
        lint={lint}
        active={active && stylePanel.active}
        shownVariant={shownVariant}
        disabled={!active || !stylePanel.active}
        only={{ controls, layer: { id: styleContext?.nodeId ?? "", name } }}
        embedded
      />
    </React.Suspense>
  ) : null;
  /** The control in a field's place while the winner reads it; otherwise
   * null, and the field shows locked (controlOrigins). */
  const boundStyleField = (label: string, property: string, controls: readonly string[]) => {
    const winner = presentedElementDetails?.authoredStyles?.[property];
    const reads = mainComponent && winner && Object.keys(designRuntimeBoundStyles(mainComponent, { [property]: winner })).length > 0;
    if (!reads) return null;
    for (const name of controls) inPlaceRef.current.add(name);
    return mainControl(controls, `bound:${property}`, label);
  };
  // Bound in some variant, state or condition, or through a field with no
  // control of its own: read only, naming the controls.
  const controlOrigins = mainBoundStyles !== NO_BOUND_STYLES && frame && styleContext
    ? designFieldOriginsWithControls(fieldOrigins, {
        nodeId: styleContext.nodeId,
        layer: presentedElementDetails?.name ?? styleContext.nodeId,
        controls: Object.fromEntries(Object.entries(mainBoundStyles).map(([property, names]) => [property, designControlLabels(frame, styleContext.nodeId, names)])),
        openControls: selectionKind === "main-root",
      })
    : fieldOrigins;
  fieldOriginsRef.current = controlOrigins;
  const styleOnlyControls = mainLayerBase
    ? [...new Set(Object.values(mainBoundStyles).flat())].filter((name) => !mainLayerBase.includes(name)).sort()
    : [];
  // After every commit, before paint: inPlaceRef fills while the Style
  // editor renders its fields. The update settles in one pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const leftover = mainLayerKey && stylePanel.active ? styleOnlyControls.filter((name) => !inPlaceRef.current.has(name)) : [];
    setNotInPlace((current) => {
      if (!mainLayerKey || !leftover.length) return current === null ? current : null;
      return current?.key === mainLayerKey && current.controls.join("\u0000") === leftover.join("\u0000") ? current : { key: mainLayerKey, controls: leftover };
    });
  });
  const mainSizeControls = designSizeAxisControls({ width: designBoundControlsFor(mainBoundStyles, "width"), height: designBoundControlsFor(mainBoundStyles, "height") });
  const mainBoundSize = selectionKind === "main-root" || selectionKind === "main-layer"
    ? { x: mainSizeControls.width.length ? mainControl(mainSizeControls.width, "size:x", "Width") : undefined,
        y: mainSizeControls.heightShared ? SHARED_HEIGHT
          : mainSizeControls.height.length ? mainControl(mainSizeControls.height, "size:y", "Height") : undefined }
    : undefined;
  if (mainBoundSize) for (const name of [...mainSizeControls.width, ...mainSizeControls.height]) inPlaceRef.current.add(name);

  // Width, placement, and the popover boundary belong to the floating panel
  // that stacks this inspector below Layers.
  return (
    <aside
      ref={inspectorRef}
      id={inspectorId}
      data-design-inspector=""
      data-design-source-filter={fieldOrigins.filter ? "" : undefined}
      data-design-state-held={heldState ?? undefined}
      className="bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <Tabs value={activeTab} onValueChange={(value) => selectInspectorTab(value as DesignInspectorTab)} className="flex min-h-0 flex-1 flex-col">
        {inspectorSelectionHeader}
        {/* One panel needs no tab bar: the zoom then sits in the header row. */}
        {inspectorTabs.length > 1 ? (
          <PanelHeader data-design-style-panel-header="" size="window">
            <TabsList aria-label="Inspector" className="h-7">
              {inspectorTabs.includes("options") ? <TabsTrigger value="options">Controls</TabsTrigger> : null}
              <TabsTrigger value="style">Style</TabsTrigger>
              {inspectorTabs.includes("css") ? (
                <TabsTrigger value="css" disabled={!styleContext && !cssActive}>CSS</TabsTrigger>
              ) : null}
            </TabsList>
            <div className="ml-auto flex items-center gap-0.5">{zoomMenu}</div>
          </PanelHeader>
        ) : null}
        {/* A shown state changes what Options and Style both display. */}
        {shownState && frame && workspaceId ? (
          <DesignStateVariantNote state={shownState} onBack={() => showDesignComponentVariant(workspaceId, frame.file, null)} />
        ) : null}
        {workspaceId && frame && inspectorTabs.includes("options") ? (
          <InertTabsContent value="options" forceMount inert={optionsPanel.inert ? "" : undefined} aria-hidden={optionsPanel.ariaHidden}
            data-design-options-panel="" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=inactive]:!hidden">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col pb-6">
              {selectionKind === "instance" ? styleEditor("size", instanceBoundSize) : null}
              {optionsFrame && controlsTarget ? (
                <DesignTokenCatalogContext.Provider value={tokenCatalog}>
                  <React.Suspense fallback={null}>
                    <DesignComponentOptions
                      key={JSON.stringify([workspaceId, designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directoryId ?? "", optionsFrame.file,
                        controlsTarget.kind === "instance" ? [controlsTarget.nodeId, controlsTarget.host.component] : "main"])}
                      workspaceId={workspaceId}
                      frame={optionsFrame}
                      target={controlsTarget}
                      directory={designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directory ?? ""}
                      lint={lint}
                      active={active && optionsPanel.active}
                      shownVariant={shownVariant}
                      disabled={!active || !optionsPanel.active}
                      {...(layerControls ? { only: layerControls } : {})}
                      {...(instanceSizeControls.length ? { except: instanceSizeControls } : {})}
                      onAskAgent={onAskAgent}
                    />
                  </React.Suspense>
                </DesignTokenCatalogContext.Provider>
              ) : null}
              {/* Export is the frame's: an instance offers it, its parts and slots do not. */}
              {selectionKind === "instance" ? exportSection : null}
              </div>
            </ScrollArea>
          </InertTabsContent>
        ) : null}
        {inspectorTabs.includes("style") ? (
        <InertTabsContent value="style" forceMount inert={stylePanel.inert ? "" : undefined} aria-hidden={stylePanel.ariaHidden}
          data-design-style-panel="" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=inactive]:!hidden">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col pb-6" {...(handed ? ({ inert: "" } as React.HTMLAttributes<HTMLDivElement>) : null)}>
              {textLock?.kind === "option" ? (
              <p data-design-text-set-by="" className="border-border1 text-fg2 border-b px-3 py-2 text-3xxs leading-4">{textLock.message}</p>
            ) : null}
            {heldState && heldChanges ? (
              <DesignHeldStateNote state={heldState} count={heldChanges.count} onBack={() => pickLayerState(null)} />
            ) : null}
            {mainLayerControls?.length && frame && workspaceId && mainComponent ? (
              <DesignTokenCatalogContext.Provider value={tokenCatalog}>
                <React.Suspense fallback={null}>
                  <DesignComponentOptions
                    key={JSON.stringify([workspaceId, frame.file, "main-layer"])}
                    workspaceId={workspaceId}
                    frame={frame}
                    target={{ kind: "main", component: mainComponent, ...(frame.component ? {} : { undeclared: true as const }) }}
                    directory={designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.directory ?? ""}
                    lint={lint}
                    active={active && stylePanel.active}
                    shownVariant={shownVariant}
                    disabled={!active || !stylePanel.active}
                    only={{ controls: mainLayerControls, layer: { id: selectedNodeId!, name: selectionTitle ?? selectionName } }}
                    onAskAgent={onAskAgent}
                  />
                </React.Suspense>
              </DesignTokenCatalogContext.Provider>
            ) : null}
            {styleContext && presentedElementDetails && defaultOrigins.styledBy ? (
              <DesignStyledByLine
                key={styleOwnerKey}
                styledBy={defaultOrigins.styledBy}
                filter={heldState ? null : defaultOrigins.filter}
                inert={heldState !== null}
                onFilter={(key) => setSourceFilter(key ? { owner: styleOwnerKey, key } : null)}
              />
            ) : null}

            {styleTargetNodeId && errors.length > 0 ? (
              <Tooltip label={`${firstBlockingReason}: ${errors[0]?.message}`}>
                <section className="bg-red-bg text-red-on-bg flex min-h-9 shrink-0 items-center gap-2 px-3 py-1.5">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="text-3xxs min-w-0 flex-1 truncate leading-4">
                    {firstBlockingReason}
                  </span>
                </section>
              </Tooltip>
            ) : null}

            {styleContext && presentedElementDetails ? (
              styleEditor(selectionKind === "instances" ? "size" : undefined, mainBoundSize)
            ) : workspaceId && !frameSelected && !selectedNodeId ? (
              <DesignCanvasBackgroundEditor
                key={activePageId ?? "legacy"}
                value={canvasBackground}
                disabled={!active || !styleActive}
                onPreview={previewCanvasBackground}
                onCancelPreview={cancelCanvasBackgroundPreview}
                onCommit={commitCanvasBackground}
              />
            ) : frame && workspaceId && designInspectorPendingGeometry({ frameSelected, selectedNodeId, count: styleNodeIds.length }) === "size" ? (
              <InspectorSection title="Size" data-design-size-section="" data-design-size-pending="">
                <div className="grid grid-cols-2 gap-2">
                  {(["W", "H"] as const).map((label) => (
                    <Input key={label} aria-label={label} placeholder={label} disabled />
                  ))}
                </div>
              </InspectorSection>
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
                      active={active && styleActive}
                      workspaceId={workspaceId}
                      frame={frame.file}
                      geometryKey={key}
                      saved={value}
                      disabled={!active || !styleActive}
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
        </InertTabsContent>
        ) : null}
        {inspectorTabs.includes("css") ? (
        <InertTabsContent value="css" forceMount inert={cssPanel.inert ? "" : undefined} aria-hidden={cssPanel.ariaHidden}
          data-design-style-panel-css-mode="" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=inactive]:!hidden">
          {styleContext && elementDetails ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div data-design-base-css-context="" className="border-border1 text-fg2 flex shrink-0 items-center gap-2 border-b px-3 py-2 text-3xxs leading-4">
                <div className="min-w-0 flex-1">
                  <div className="text-fg1 font-medium">Base CSS</div>
                  <div className="truncate">{cssTargetLabel}</div>
                </div>
              </div>
              <DesignComputedCssEditor
                key={`${styleOwner.key}:css`}
                details={elementDetails}
                originLabel={styleOriginLabel}
                active={active && cssActive}
                disabled={editsDisabled || !cssActive}
                onPreviewStyles={previewSelectedStyles}
                onCancelStylePreview={clearSelectedStylePreview}
                onCommitStyles={commitSelectedStyles}
              />
            </div>
          ) : (
            <p data-design-css-unavailable="" className="text-fg3 px-3 py-3 text-xs">Select one layer to edit its Base CSS.</p>
          )}
        </InertTabsContent>
        ) : null}
      </Tabs>
    </aside>
  );
});
