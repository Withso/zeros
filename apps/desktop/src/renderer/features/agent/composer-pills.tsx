// ──────────────────────────────────────────────────────────
// Composer pills — model, effort, permissions, context
// ──────────────────────────────────────────────────────────
//
// Reusable dropdown/pill primitives for the agent chat composer.
// Uses the same visual language as the legacy AIChatPanel so the
// two surfaces feel part of one product, not two.
//
// All state is per-chat and dispatched via UPDATE_CHAT_SETTINGS
// in the workspace store — no local component state.
// ──────────────────────────────────────────────────────────

import {
  createContext,
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
  displayModelLabel,
  effortLabel,
  permissionMenuItems,
} from "./model-catalog";
import {
  AgentModelMenu,
  type AgentModelSelection,
} from "./agent-model-menu";
import { AgentIcon } from "./agent-icon";
import { Tooltip } from "@/renderer/shared/ui/primitives";

// Wave 3 close-out (2026-05-16): the in-file useClickAway helper that
// every pill once shared was deleted. All pills now use shadcn Popover,
// which handles outside-click + Esc natively. If a future pill needs a
// custom outside-click again, prefer Popover or add a small typed hook
// in apps/desktop/src/renderer/shared/lib/ rather than redefining it inline here.

// Shared Tailwind utility string for the composer toolbar pill trigger.
// Exported (01c Wave 2) as the SINGLE CANONICAL pill chrome — every
// composer-toolbar pill (Model, Effort, Permissions, Branch, Agent,
// Workspace) consumes this constant. Density variants (e.g. AgentPill's
// compact mode) pass an override class through cn(TOOLBAR_PILL, …) so
// tailwind-merge resolves the px-* delta cleanly. Replaces the dropped
// `.zeros-chat-toolbar-pill` CSS rule from engine-chat-leftovers.css.
// Pill labels use text-xs (12px), one step under the text-sm (14px) textarea
// body so chrome reads one
// notch quieter than the text you are writing. Stays a stock token
// (no arbitrary px). Icon sizes
// at 11 stay (icon-to-label balance reads correctly at 12/11).
// Composer toolbar pills sit at a 6px radius:
// rounded-md on the fixed 4/6/8 scale (model pill + context pills are the
// canonical 6px use case; see styles/zeros-tokens.css radii block).
export const TOOLBAR_PILL =
  "inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs font-medium text-fg2 cursor-pointer transition-[background-color,color] duration-150 ease-out hover:bg-bg2-hover hover:text-fg1";

// The model pill is just logo + label, with no caret.

// The "engaged" pill chrome — the Fast pill (on) is its sole consumer.
// Background = --bg3-hover (the same neutral fill as model-dropdown row
// hover; replaced --highlighted-secondary-bg when that token was retired,
// 2026-07-11), text + icon = --yellow-fg (replaced --highlighted-fg when
// that token was retired, 2026-07-11). Width hugs the content (inline-flex,
// no fixed width), so the background fits the text, not the other way
// around.
export const TOOLBAR_PILL_ACTIVE =
  "inline-flex items-center gap-1.5 rounded-md border-0 bg-bg2-hover px-2 py-1 text-xs font-medium text-yellow-fg cursor-pointer transition-[background-color,color] duration-150 ease-out";

// ── ComposerConcealedContext ─────────────────────────────
//
// True while the composer hosting these pills is concealed — the permission
// or question card has taken the composer's slot, so the composer card is
// display:none (NOT unmounted; the typed draft must survive). Any pill whose
// popover content portals to <body> must close while concealed: once the
// trigger loses its layout box, Radix's popper has a zero-rect anchor and
// re-parks the still-open popover at the viewport origin (top-left corner).
// Default false — the edit composer (turn-container) renders the same pills
// without a provider and is never concealed.
export const ComposerConcealedContext = createContext(false);

// ── ModelPill ────────────────────────────────────────────
//
// The pill opens the UNIFIED agent+model dropdown
// (AgentModelMenu — ★ favorites + one rail tab per agent, search, 1/2/3 +
// ⌘1…⌘9 shortcuts). A same-agent pick routes through `onChange` exactly as
// before; a pick under a DIFFERENT agent routes through `onSelectAgentModel`
// so the host can move the chat to that agent (agent-chat opens a tab bound
// to it — a chat's agentId is set-once by design).

export function ModelPill({
  agentId,
  iconUrl,
  initialize,
  value,
  onChange,
  onSelectAgentModel,
  redirectCrossAgent,
}: {
  agentId: string | null;
  /** Optional brand-logo URL fallback. Usually unset — AgentIcon prefers
   *  the bundled SVG keyed by agentId (claude/codex/cursor/…). */
  iconUrl?: string | null;
  /** When provided, the pill prefers the agent's advertised model
   *  catalog (initialize._meta.models) over the curated fallback. */
  initialize: InitializeResponse | null;
  value: string | null;
  onChange: (next: string | null) => void;
  /** A pick under a DIFFERENT agent (the unified dropdown lists them all).
   *  Omitted ⇒ cross-agent rows still render but picking one is a no-op. */
  onSelectAgentModel?: (sel: AgentModelSelection) => void;
  /** True once the chat's session has started (first prompt sent) — other
   *  agents' models then show a ↗ in the dropdown ("opens a new chat"). */
  redirectCrossAgent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Close while the host composer is concealed (see ComposerConcealedContext).
  // The derived prop closes in the SAME render the composer hides (no
  // one-frame strand at the viewport origin); the effect syncs local state so
  // the popover doesn't spring back open when the composer returns.
  const concealed = useContext(ComposerConcealedContext);
  useEffect(() => {
    if (concealed && open) setOpen(false);
  }, [concealed, open]);

  // Models come straight from the agent's advertised `_meta.models` (via the
  // `initialize` prop) or the cold-start floor — both reactive to prop changes,
  // so no manual catalog warm/refresh is needed (the remote system is gone).
  const models = catalogModelsForAgent(agentId, initialize);
  // A null model means "the agent's catalog default" — resolve it the same
  // way the Effort/Fast capability gates do (models[0]) so the pill, the
  // menu's ✓, and the toggles always agree.
  const activeValue = value ?? models[0]?.value ?? null;
  const current = models.find((m) => m.value === activeValue) ?? null;
  const displayLabel = displayModelLabel(agentId, current?.label ?? "Model");

  // If the agent family has no catalog (unknown wrapper) AND the agent
  // didn't advertise its own models either, hide the pill — a dropdown
  // with no choices is confusing.
  if (models.length === 0) return null;

  return (
    <AgentModelMenu
      value={{ agentId, model: activeValue }}
      open={open && !concealed}
      onOpenChange={setOpen}
      redirectCrossAgent={redirectCrossAgent}
      onSelect={(sel) => {
        if (agentFamily(sel.agentId) === agentFamily(agentId)) {
          onChange(sel.model);
        } else {
          onSelectAgentModel?.(sel);
        }
      }}
    >
      {/* 12px logo and no ChevronDown caret; the pill is just logo + label. */}
      <button type="button" className={TOOLBAR_PILL}>
        <AgentIcon
          agentId={agentId}
          iconUrl={iconUrl ?? null}
          size={12}
          monochrome
          className="shrink-0"
        />
        <span>{displayLabel}</span>
      </button>
    </AgentModelMenu>
  );
}

// ── EffortPill (effort toggle) ───────────────────────────
//
// A minimal, text-only toggle: it renders the current effort label (e.g.
// "Max") and cycles the model's ladder (wrapping) on click; default High.
// Text only: no resting background and no battery/charge-fill indicator. Label
// color is --fg2,
// matching the composer toolbar's default (inactive) pill; hover gets the same
// bg-bg3 wash as the other pills (2026-07-10 follow-up). The label still drops
// in gently from the top on each USER toggle (only on a real click — see
// labelAnimKey below); motion is slow + smooth (calm deceleration ease).

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
  // Click-driven label animation. The drop-in must replay ONLY when the user
  // clicks the toggle — NOT on mount/remount (app refresh, workspace change,
  // chat-tab switch) and NOT when `value` changes because a different chat's
  // effort rendered. `userToggledRef` is armed in onClick; the layout effect
  // (which also runs on mount) only bumps the key when that flag is set, so a
  // fresh mount or an external value change never animates. Hooks sit above the
  // early return to satisfy the rules of hooks. useLayoutEffect (not useEffect)
  // so the keyed remount lands before paint — no flash of the un-animated text.
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
    <Tooltip label="Adjust effort level">
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

// ── FastPill ─────────────────────────────────────────────
//
// Fast mode — lower-latency inference at higher token cost. Claude maps it to
// the SDK `fastMode` setting (Opus only); Codex to `service_tier: "fast"`
// (GPT-5.x). Off = outline bolt only; On = engaged chrome + filled bolt +
// "Fast" label. The parent only renders this when the model supports it
// (agentSupportsFast).

export function FastPill({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip
      label={active ? "Disable fast mode" : "Enable fast mode"}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        aria-label={active ? "Disable fast mode" : "Enable fast mode"}
        className={active ? TOOLBAR_PILL_ACTIVE : TOOLBAR_PILL}
      >
        <Zap size={16} className={active ? "fill-current" : ""} />
        {active && <span>Fast</span>}
      </button>
    </Tooltip>
  );
}

// ── PermissionToggle ─────────────────────────────────────
//
// The composer's permission-mode toggle — replaces both the old Plan pill and
// the "+" → Permissions submenu. Icon-only at rest: no
// resting background, icon in --fg2, hover gets the bg-bg3 wash (mirrors the
// stripped EffortPill). Clicking the ICON cycles the agent's REAL native modes
// in menu order (wrapping); the picked mode's name flashes to the right for 3s;
// hover names the current mode (tooltip = just the name, no prefix). Each
// family's modes get their own icon:
//
//   Claude: Manual=shield-question-mark · Accept Edits=shield-ellipsis ·
//           Plan=map · Auto=shield · Bypass=shield-half
//   Codex:  Ask for approval=map · Approve for me=shield · Full access=shield-half
//   Cursor: Ask=map · Auto=shield · Full access=shield-half
//
// The "map" modes (agent proposes instead of acting) also draw the dashed
// composer frame — see permissionModeShowsFrame + PlanModeFrame. The icon drops
// in from the top on each USER toggle, exactly like the effort label (same
// keyframe, same click-armed key bump — see EffortPill's labelAnimKey notes).

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

export function PermissionToggle({
  agentId,
  model,
  currentModeId,
  onSelectMode,
}: {
  agentId: string | null;
  /** The picked model — Claude Haiku drops "auto" from the cycle. */
  model: string | null;
  /** The active native mode id (already coerced to one this model offers —
   *  see coerceModeIdForModel). null pre-bind ⇒ the first mode shows. */
  currentModeId: string | null;
  /** A cycle lands on the NEXT native mode id — the caller switches the live
   *  session (session/set_mode) and persists chat.lastModeId. */
  onSelectMode: (modeId: string) => void;
}) {
  // Click-driven animation — same contract as EffortPill's labelAnimKey: armed
  // only by a real click, bumped when the mode actually changes, so a
  // mount/tab-switch or an external mode change never replays the drop-in. The
  // SAME key drives the icon and the transient name label, so rapid clicks
  // remount + replay both in lockstep. Each click also (re)arms the 3s hide
  // timer on the label.
  const [animKey, setAnimKey] = useState(0);
  const [labelVisible, setLabelVisible] = useState(false);
  const userToggledRef = useRef(false);
  const hideLabelTimerRef = useRef<number | null>(null);
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
        hideLabelTimerRef.current = null;
      }, 3000);
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

  const items = permissionMenuItems(agentId, model);
  // No native-mode vocabulary for this agent → no toggle.
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
    <span className="inline-flex items-center">
      <Tooltip label={current.label}>
        <button
          type="button"
          onClick={() => {
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
          <span key={animKey} className={animKey > 0 ? `flex ${dropIn}` : "flex"}>
            <Icon size={16} />
          </span>
        </button>
      </Tooltip>
      {/* The picked mode's name, flashed to the RIGHT of the icon for 3s after
          each user toggle. Shares the icon's animKey so both remount + drop in
          together — the name on a 30ms delay (fill-mode both holds it invisible
          through the delay) so it trails the icon just slightly.
          The outer span clips the slide (the animated element can't clip
          itself), mirroring EffortPill's button-clips-label structure. */}
      {labelVisible && (
        <span className="text-fg2 inline-flex items-center overflow-hidden py-1 pl-0.5 text-xs font-medium">
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

// ── PlanModeFrame (dashed "guarded mode" border) ─────────
//
// In the guarded permission modes (Claude Plan, Codex Ask for approval, Cursor
// Ask — see permissionModeShowsFrame) the composer
// card gets a frame of evenly-spaced DASHES in --border4. Native
// `border-style: dashed` packs
// segments too tightly with no length/spacing control, so we overlay an
// absolutely-positioned SVG <rect> with round caps + an explicit dash array:
// `3 5` paints a 3-long rounded dash with a 5 gap; the near-zero `0.01` dot is
// too small. The svg is inset 1px so we avoid
// calc() in SVG geometry (Chromium-flaky) and the rect fills it at 100%.
// Render INSIDE the composer card (position: relative); pair with a
// transparent base border so only the dashes show.
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
        rx="11"
        ry="11"
        fill="none"
        strokeWidth="1"
        strokeDasharray="3 5"
        strokeLinecap="round"
        style={{ stroke: "var(--border4)" }}
      />
    </svg>
  );
}
