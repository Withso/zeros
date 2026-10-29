// Composer toolbar pills (model, effort, permissions, context). All state is
// per-chat and dispatched through UPDATE_CHAT_SETTINGS; no local component
// state.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Map as MapIcon,
  Shield,
  ShieldEllipsis,
  ShieldHalf,
  ShieldQuestionMark,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ChatEffort } from "../../state/store";
import type { InitializeResponse } from "../../platform/bridge/agent-events";
import {
  agentFamily,
  modelsForAgent as catalogModelsForAgent,
  configuredModelLabelParts,
  effortLabel,
  permissionMenuItems,
  resolveModelOption,
} from "./model-catalog";
import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";
import type { ModelConfiguration } from "./model-preferences";
import { AgentModelMenu, type AgentModelSelection } from "./agent-model-menu";
import { AgentIcon } from "./agent-icon";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  resolvePermissionFeedbackPlacement,
  type PermissionFeedbackPlacement,
} from "./permission-feedback-placement";
import "./composer-pills.css";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";

// Wave 3 close-out (2026-05-16): the in-file useClickAway helper that
// every pill once shared was deleted. All pills now use shadcn Popover,
// which handles outside-click + Esc natively. If a future pill needs a
// custom outside-click again, prefer Popover or add a small typed hook
// in apps/desktop/src/renderer/shared/lib/ rather than redefining it inline here.

// The one canonical composer-toolbar pill chrome. Density variants pass an
// override through cn(TOOLBAR_PILL, …) so tailwind-merge resolves the px delta.
// Labels are text-xs, one step under the textarea's text-sm, so chrome reads
// quieter than the text being written; rounded-md is the 6px radius
// (styles/zeros-tokens.css).
export const TOOLBAR_PILL =
  "inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs font-medium text-fg2 cursor-pointer transition-[background-color,color] duration-150 ease-out hover:bg-bg2-hover hover:text-fg1";

// The model pill is just logo + label, with no caret.

// The engaged pill chrome, used only by the Fast pill when on: --bg3-hover fill
// and --yellow-fg text, hugging its content.
export const TOOLBAR_PILL_ACTIVE =
  "inline-flex items-center gap-1.5 rounded-md border-0 bg-bg2-hover px-2 py-1 text-xs font-medium text-yellow-fg cursor-pointer transition-[background-color,color] duration-150 ease-out";

// True while a permission or question card has taken the composer's slot and
// the composer card is display:none (not unmounted, so the draft survives).
// Pills whose popovers portal to <body> must close then, or Radix re-parks them
// at the viewport origin. Default false: the edit composer has no provider.
export const ComposerConcealedContext = createContext(false);

// Opens the unified agent+model menu. A same-agent pick calls `onChange`; a
// pick under another agent calls `onSelectAgentModel`, since a chat's agentId
// is set once.

export function ModelPill({
  agents,
  agentId,
  iconUrl,
  initialize,
  value,
  effort,
  fast,
  onChange,
  onConfigure,
  onRefreshModels,
  onSelectAgentModel,
  redirectCrossAgent,
  selectionTiming,
  active = true,
}: {
  agents?: BridgeRegistryAgent[] | null;
  agentId: string | null;
  /** Optional brand-logo URL fallback. Usually unset — AgentIcon prefers
   *  the bundled SVG keyed by agentId (claude/codex/cursor/…). */
  iconUrl?: string | null;
  /** When provided, the agent's advertised capabilities
   *  (initialize._meta.models) refine the curated rows' effort/Fast/selectable
   *  state. Names stay curated — see model-catalog's overlayLiveCapabilities. */
  initialize: InitializeResponse | null;
  value: string | null;
  effort: ChatEffort;
  fast: boolean;
  onChange: (next: string | null) => void;
  onConfigure: (configuration: ModelConfiguration) => void;
  /** Optional cloud metadata revalidation. Opens immediately with the retained
   * snapshot; the worker and control plane bound provider discovery. */
  onRefreshModels?: () => void;
  /** A pick under a DIFFERENT agent (the unified dropdown lists them all).
   *  Omitted ⇒ cross-agent rows still render but picking one is a no-op. */
  onSelectAgentModel?: (sel: AgentModelSelection) => void;
  /** True once the chat's session has started (first prompt sent) — other
   *  agents' models then show a ↗ in the dropdown ("opens a new chat"). */
  redirectCrossAgent?: boolean;
  selectionTiming?: "next-message";
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Close while the host composer is concealed (see ComposerConcealedContext).
  // The derived prop closes in the SAME render the composer hides (no
  // one-frame strand at the viewport origin); the effect syncs local state so
  // the popover doesn't spring back open when the composer returns.
  const concealed = useContext(ComposerConcealedContext);
  useEffect(() => {
    if ((concealed || !active) && open) setOpen(false);
  }, [concealed, active, open]);

  // Curated rows, capability-overlaid from the agent's advertised
  // `_meta.models` (via the `initialize` prop) or the cold-start floor — both
  // reactive to prop changes, so no manual catalog warm/refresh is needed (the
  // remote system is gone). The label the pill prints is curated either way, so
  // it does not shift when live discovery lands mid-session.
  const models = catalogModelsForAgent(agentId, initialize);
  // A null model means "the agent's global default". resolveModelOption is the
  // ONE place that chain lives, and the Effort/Fast capability gates plus the
  // spawn env resolve through it too — so the pill, the menu's ✓, the toggles,
  // and the model the engine actually runs can never disagree.
  const current =
    models.find((m) => m.value === value) ??
    resolveModelOption(agentId, value ?? null, initialize);
  const activeValue = current?.value ?? value ?? null;
  const displayLabel = configuredModelLabelParts(
    agentId,
    activeValue,
    current?.label ?? "Model",
    effort,
    fast,
    initialize,
  );

  // If the agent family has no catalog (unknown wrapper) AND the agent
  // didn't advertise its own models either, hide the pill — a dropdown
  // with no choices is confusing.
  if (models.length === 0) return null;

  return (
    <AgentModelMenu
      agents={agents}
      initialize={initialize}
      value={{ agentId, model: activeValue, effort, fast }}
      open={open && !concealed && active}
      onOpenChange={(nextOpen) => { if (nextOpen && active && !concealed) onRefreshModels?.(); setOpen(nextOpen); }}
      redirectCrossAgent={redirectCrossAgent}
      selectionTiming={selectionTiming}
      onConfigure={onConfigure}
      onSelect={(sel) => {
        if (agentFamily(sel.agentId) === agentFamily(agentId)) {
          onChange(sel.model);
        } else {
          onSelectAgentModel?.(sel);
        }
      }}
    >
      {/* 12px logo and no ChevronDown caret; the pill is just logo + label. */}
      <button type="button" className={`${TOOLBAR_PILL} min-w-0`}>
        <AgentIcon
          agentId={agentId}
          iconUrl={iconUrl ?? null}
          size={12}
          monochrome
          className="shrink-0"
        />
        <span className="sr-only">
          Model: {displayLabel.model} {displayLabel.metadata.join(" ")}
        </span>
        <span
          data-model-pill-label
          aria-hidden="true"
          className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        >
          <span data-model-pill-name>{displayLabel.model} </span>
          {displayLabel.metadata.length > 0 && (
            <span data-model-pill-metadata className="text-fg2 opacity-80">
              {displayLabel.metadata.join(" ")}
            </span>
          )}
        </span>
      </button>
    </AgentModelMenu>
  );
}

// A text-only toggle that cycles the model's effort ladder (wrapping; default
// High). No resting background; the label drops in only on a user click (see
// labelAnimKey).

export function EffortPill({
  agentId,
  levels,
  value,
  onChange,
}: {
  /** The agent whose family brands the effort tiers (e.g. Codex "Ultra" vs
   *  Claude "Ultracode" for the same internal level). Drives {@link effortLabel}. */
  agentId: string | null;
  /** Ordered effort ladder this model exposes (from effortLevelsFor). The
   *  toggle cycles through it, wrapping. */
  levels: ChatEffort[];
  value: ChatEffort;
  onChange: (v: ChatEffort) => void;
}) {
  // The drop-in replays only on a user click, never on mount or when another
  // chat's value renders: onClick arms `userToggledRef`, and the layout effect
  // bumps the key only when it is set, before paint so nothing flashes. Hooks sit
  // above the early return.
  const [labelAnimKey, setLabelAnimKey] = useState(0);
  const userToggledRef = useRef(false);
  useLayoutEffect(() => {
    if (userToggledRef.current) {
      userToggledRef.current = false;
      setLabelAnimKey((k) => k + 1);
    }
  }, [value]);

  if (levels.length === 0) return null;
  // Locate the current value in the ladder; if it's not present (e.g. the
  // model changed from Opus→Sonnet and value was "ultracode"), fall back to
  // "high" for display + cycle origin.
  let idx = levels.indexOf(value);
  if (idx < 0) idx = Math.max(0, levels.indexOf("high"));
  const current = levels[idx] ?? value;
  const label = effortLabel(agentId, current);
  const next = levels[(idx + 1) % levels.length];

  return (
    <Tooltip label="Reasoning">
      <button
        type="button"
        onClick={() => {
          // Arm the label animation only for a real cycle (a single-level ladder
          // has next === current — clicking changes nothing, so don't animate).
          if (next !== current) userToggledRef.current = true;
          onChange(next);
        }}
        aria-label={`Reasoning effort: ${label}`}
        className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex cursor-pointer items-center overflow-hidden rounded-md border-0 px-2 py-1 text-xs font-medium transition-[background-color,color] duration-150 ease-out"
      >
        {/* Label — drops in gently from the top, but ONLY on a user toggle. The
            key is bumped solely by the click path (labelAnimKey), so a remount
            (tab switch / refresh / workspace change) renders at key 0 with no
            animation class; the first real click flips key→1 and replays it. */}
        <span
          key={labelAnimKey}
          className={
            labelAnimKey > 0
              ? "[animation:zeros-effort-label-in_520ms_cubic-bezier(0.22,1,0.36,1)_both]"
              : undefined
          }
        >
          {label}
        </span>
      </button>
    </Tooltip>
  );
}

// Fast mode trades token cost for latency (Claude `fastMode`, Codex
// `service_tier: "fast"`, Cursor a fast model variant). Rendered only when the
// model supports it (agentSupportsFast).

export function FastPill({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip label="Fast mode">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={active ? "Disable fast mode" : "Enable fast mode"}
        className={active ? TOOLBAR_PILL_ACTIVE : TOOLBAR_PILL}
      >
        <Zap size={16} className={active ? "fill-current" : ""} />
      </button>
    </Tooltip>
  );
}

// Icon-only permission-mode toggle. Clicking cycles the agent's real native
// modes in menu order (wrapping), and the picked name flashes beside it for 3s;
// hover names the current mode. Each family's modes get their own icon:
//
//   Claude: Manual=shield-question-mark · Accept Edits=shield-ellipsis ·
//           Plan=map · Auto=shield · Bypass=shield-half
//   Codex:  Ask for approval=map · Approve for me=shield · Full access=shield-half
//   Cursor: Ask=map · Auto=shield · Full access=shield-half
//
// The "map" modes (the agent proposes instead of acting) also draw the dashed
// composer frame (permissionModeShowsFrame, PlanModeFrame). The icon drop-in is
// click-armed like EffortPill's labelAnimKey.

/** family → native mode id → toggle icon (see the box comment above). */
const PERMISSION_MODE_ICONS: Record<string, Record<string, LucideIcon>> = {
  claude: {
    default: ShieldQuestionMark,
    "accept-edits": ShieldEllipsis,
    plan: MapIcon,
    auto: Shield,
    bypass: ShieldHalf,
  },
  codex: {
    ask: MapIcon,
    "read-only": MapIcon,
    "auto-edit": Shield,
    "full-access": ShieldHalf,
  },
  cursor: {
    plan: MapIcon,
    auto: Shield,
    agent: ShieldHalf,
  },
};

const PERMISSION_FEEDBACK_DURATION_MS = 3000;
const PERMISSION_FEEDBACK_BOUNDARY = "[data-permission-feedback-boundary]";
const COMPOSER_TOOLBAR_ACTIONS = "[data-composer-toolbar-actions]";

export function PermissionToggle({
  agentId,
  model,
  boundary = null,
  currentModeId,
  onSelectMode,
}: {
  agentId: string | null;
  /** The picked model — Claude Haiku drops "auto" from the cycle. */
  model: string | null;
  boundary?: ExecutionBoundaryStatus | null;
  /** The active native mode id (already coerced to one this model offers —
   *  see coerceModeIdForModel). null pre-bind ⇒ the first mode shows. */
  currentModeId: string | null;
  /** A cycle lands on the NEXT native mode id — the caller switches the live
   *  session (session/set_mode) and persists chat.lastModeId. */
  onSelectMode: (modeId: string) => void;
}) {
  // Same click-armed contract as EffortPill's labelAnimKey. One key drives the
  // icon and the transient name label, so rapid clicks replay both in lockstep;
  // each click re-arms the label's 3s hide timer.
  const [animKey, setAnimKey] = useState(0);
  const [labelVisible, setLabelVisible] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [feedbackPlacement, setFeedbackPlacement] =
    useState<PermissionFeedbackPlacement>("right");
  const userToggledRef = useRef(false);
  const pointerOverTriggerRef = useRef(false);
  const hideLabelTimerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const feedbackRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (userToggledRef.current) {
      userToggledRef.current = false;
      setAnimKey((k) => k + 1);
      setLabelVisible(true);
      if (hideLabelTimerRef.current) {
        window.clearTimeout(hideLabelTimerRef.current);
      }
      hideLabelTimerRef.current = window.setTimeout(() => {
        setLabelVisible(false);
        // Radix has already consumed the pointer-enter that preceded a click,
        // so a stationary pointer will not emit another event after the forced
        // closed period. Re-open explicitly once feedback ends, but only while
        // the pointer is still genuinely over the permission trigger.
        if (pointerOverTriggerRef.current) setTooltipOpen(true);
        hideLabelTimerRef.current = null;
      }, PERMISSION_FEEDBACK_DURATION_MS);
    }
  }, [currentModeId]);
  useEffect(
    () => () => {
      if (hideLabelTimerRef.current) {
        window.clearTimeout(hideLabelTimerRef.current);
      }
    },
    [],
  );

  const measureFeedbackPlacement = useCallback(() => {
    const trigger = triggerRef.current;
    const feedback = feedbackRef.current;
    if (!trigger || !feedback) return;

    const triggerRect = trigger.getBoundingClientRect();
    const boundary = trigger.closest<HTMLElement>(PERMISSION_FEEDBACK_BOUNDARY);
    const fallbackBoundary = trigger.closest<HTMLElement>("[data-pane-root]");
    const boundaryRect = (
      boundary ?? fallbackBoundary
    )?.getBoundingClientRect();
    let boundaryRight =
      boundaryRect?.right ?? document.documentElement.clientWidth;
    const actions = boundary?.querySelector<HTMLElement>(
      COMPOSER_TOOLBAR_ACTIONS,
    );
    if (actions) {
      boundaryRight = Math.min(
        boundaryRight,
        actions.getBoundingClientRect().left,
      );
    }

    const next = resolvePermissionFeedbackPlacement({
      triggerRight: triggerRect.right,
      feedbackWidth: feedback.getBoundingClientRect().width,
      boundaryRight,
    });
    setFeedbackPlacement((current) => (current === next ? current : next));
  }, []);

  useLayoutEffect(() => {
    if (!labelVisible) return;
    measureFeedbackPlacement();

    const trigger = triggerRef.current;
    const feedback = feedbackRef.current;
    const boundary = trigger?.closest<HTMLElement>(
      PERMISSION_FEEDBACK_BOUNDARY,
    );
    const actions = boundary?.querySelector<HTMLElement>(
      COMPOSER_TOOLBAR_ACTIONS,
    );
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureFeedbackPlacement);
    if (trigger) observer?.observe(trigger);
    if (feedback) observer?.observe(feedback);
    if (boundary) observer?.observe(boundary);
    if (actions) observer?.observe(actions);
    window.addEventListener("resize", measureFeedbackPlacement);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureFeedbackPlacement);
    };
  }, [labelVisible, measureFeedbackPlacement]);

  const items = permissionMenuItems(agentId, model, boundary);
  // No native-mode vocabulary for this agent → no toggle. This check stays
  // below every hook because a chat can switch between supported agents.
  if (items.length === 0) return null;

  let idx = items.findIndex((i) => i.modeId === currentModeId);
  if (idx < 0) idx = 0;
  const current = items[idx];
  const next = items[(idx + 1) % items.length];
  const Icon =
    PERMISSION_MODE_ICONS[agentFamily(agentId)]?.[current.modeId] ?? Shield;
  const dropIn =
    "[animation:zeros-effort-label-in_520ms_cubic-bezier(0.22,1,0.36,1)_both]";

  return (
    // The transient name label sits OUTSIDE the button (a non-interactive
    // sibling), so only the icon itself is the click target — clicking where
    // the name flashes must NOT cycle the mode.
    <span className="relative inline-flex shrink-0 items-center">
      <Tooltip
        label={current.label}
        disabled={labelVisible}
        open={labelVisible ? false : tooltipOpen}
        onOpenChange={setTooltipOpen}
      >
        <button
          ref={triggerRef}
          type="button"
          onPointerEnter={() => {
            pointerOverTriggerRef.current = true;
          }}
          onPointerLeave={() => {
            pointerOverTriggerRef.current = false;
          }}
          onClick={() => {
            // A tooltip that was already open after a long hover must yield to
            // the click feedback before the transient label is shown.
            setTooltipOpen(false);
            setFeedbackPlacement("right");
            // Arm the animation only for a real cycle (a single-mode list
            // has next === current — clicking changes nothing, so don't animate).
            if (next.modeId !== current.modeId) userToggledRef.current = true;
            onSelectMode(next.modeId);
          }}
          aria-label={`Permission mode: ${current.label}`}
          className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex cursor-pointer items-center overflow-hidden rounded-md border-0 px-2 py-1 text-xs font-medium transition-[background-color,color] duration-150 ease-out"
        >
          {/* Icon — drops in gently from the top, but ONLY on a user toggle
              (keyed remount; key 0 = no animation class, same as EffortPill). */}
          <span
            key={animKey}
            className={animKey > 0 ? `flex ${dropIn}` : "flex"}
          >
            <Icon size={16} />
          </span>
        </button>
      </Tooltip>
      {/* The picked mode's name floats to the RIGHT when it fits, then moves
          above only when the toolbar boundary/actions leave insufficient room.
          Absolute positioning is load-bearing: feedback never consumes toolbar
          width or pushes this single-row composer onto a second line. */}
      {labelVisible && (
        <span
          ref={feedbackRef}
          data-permission-mode-feedback
          data-placement={feedbackPlacement}
          className={`text-fg2 pointer-events-none absolute z-[2] inline-flex items-center overflow-hidden py-1 text-xs font-medium whitespace-nowrap ${
            feedbackPlacement === "right"
              ? "top-1/2 left-full ml-1 -translate-y-1/2"
              : "bottom-full left-1/2 mb-1 -translate-x-1/2"
          }`}
        >
          <span
            key={animKey}
            className="[animation:zeros-effort-label-in_520ms_cubic-bezier(0.22,1,0.36,1)_30ms_both]"
          >
            {current.label}
          </span>
        </span>
      )}
    </span>
  );
}

// In the guarded modes (permissionModeShowsFrame) the composer card gets an
// SVG frame of evenly spaced dashes in --border4: native `border-style: dashed`
// has no length or spacing control. The `3 5` array paints 3-long round-capped
// dashes with 5 gaps. The svg is inset 1px to avoid calc() in SVG geometry
// (Chromium-flaky), so rx/ry are COMPOSER_SURFACE_RADIUS − 1 = 17. Render
// inside the card (position: relative) with a transparent base border.
export function PlanModeFrame() {
  // An <svg> is a REPLACED element with an intrinsic 300×150 size — absolute
  // insets alone do NOT stretch it (it'd paint a 300×150 dotted box in the
  // corner). So give it explicit CSS dimensions: offset 1px from the top-left
  // and size to the card minus 2px via calc (reliable in CSS, unlike calc in
  // SVG geometry attributes). The rect then fills the svg at a plain 100%.
  return (
    <svg
      className="pointer-events-none absolute top-[1px] left-[1px] z-[3] overflow-visible"
      style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)" }}
      aria-hidden="true"
    >
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        rx="17"
        ry="17"
        fill="none"
        strokeWidth="1"
        strokeDasharray="3 5"
        strokeLinecap="round"
        style={{ stroke: "var(--border4)" }}
      />
    </svg>
  );
}
