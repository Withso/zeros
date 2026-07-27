// ──────────────────────────────────────────────────────────
// new-chat-defaults — what a freshly created chat is born with
// ──────────────────────────────────────────────────────────
//
// 2026-07-10 spec — TWO separate concepts drive a new chat:
//   - The default AGENT ([[default-agent]]) — picked in Settings → Models
//     (falls back to "claude" when unset). Decides WHICH agent "+" / ⌘T /
//     new-workspace chats open with.
//   - The favorite MODEL per agent ([[model-favorites]]) — the ★ in the
//     composer's model dropdown, exactly one per family, falling back to
//     the catalog's defaultFavorites (Opus 4.8 / 5.6 Sol / Composer
//     2.5). Decides WHICH model that agent's new chats open on.
// Starring a model no longer flips the default agent — the old
// "default model = default agent + favorite" coupling was retired with
// the Settings → Default agent picker.
//
// This module also owns the remaining new-chat defaults (reasoning effort
// per family, plan mode, fast mode) and exposes `newChatBornDefaults()` —
// the single source of truth every spawn path calls to stamp a fresh
// ChatThread, so the paths can never drift (they used to hardcode
// conflicting effort: "high" vs "medium").
//
// Persistence + pub/sub mirror model-favorites.ts / default-agent.ts:
// getSetting/setSetting (read synchronously at spawn time, which is why
// this lives in localStorage and not the async settings.toml bridge) and a
// small bus so every open ModelPill / settings surface re-renders in sync.
// No React components are exported, so importers stay Fast-Refresh-safe.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../native/settings";
import { getActiveBridge } from "../bridge/active-bridge";
import { bridgeSettingsWrite } from "../bridge/workspace-bridge";
import { getDefaultAgentId, setDefaultAgentId } from "../panels/default-agent";
import {
  agentFamily,
  agentSupportsFast,
  effortLevelsFor,
  familyForModelValue,
  modelsForAgent,
} from "./model-catalog";
import {
  effectiveFavoriteModel,
  getFavoriteModel,
  setFavoriteModel,
} from "./model-favorites";
import {
  getClaudeBudgetCapUsd,
  getClaudeFallbackModel,
  setClaudeBudgetCapUsd,
  setClaudeFallbackModel,
} from "./reliability-settings";
import type { ChatEffort, ChatPermissionMode } from "../store/store";

/** Per-family default reasoning effort (mirrors the favorite-model map). */
const DEFAULT_EFFORT_KEY = "default-effort-by-family";
/** Start new chats in plan mode (global, all agents). */
const DEFAULT_PLAN_KEY = "default-plan-mode";
/** Start new chats in fast mode (global; applied only when the model supports it). */
const DEFAULT_FAST_KEY = "default-fast-mode";
/** The model used to auto-generate chat titles (Settings → Models → "Custom models"). */
const CHAT_TITLE_MODEL_KEY = "chat-title-model";

type EffortMap = Record<string, ChatEffort>;

function readEffortMap(): EffortMap {
  const raw = getSetting<EffortMap | null>(DEFAULT_EFFORT_KEY, null);
  return raw && typeof raw === "object" ? raw : {};
}

/** The default reasoning effort for an agent's family, or null if unset. */
export function getDefaultEffort(
  agentId: string | null | undefined,
): ChatEffort | null {
  const fam = agentFamily(agentId ?? null);
  if (!fam) return null;
  const v = readEffortMap()[fam];
  return typeof v === "string" && v.length > 0 ? (v as ChatEffort) : null;
}

/** Set (or clear, with null) the default effort for an agent's family. */
export function setDefaultEffort(
  agentId: string | null | undefined,
  effort: ChatEffort | null,
): void {
  const fam = agentFamily(agentId ?? null);
  if (!fam) return;
  const map = readEffortMap();
  if (effort) map[fam] = effort;
  else delete map[fam];
  setSetting(DEFAULT_EFFORT_KEY, map);
  notify();
  mirrorModelsToSettings();
}

/** Whether new chats start in plan mode. */
export function getDefaultPlanMode(): boolean {
  return getSetting<boolean>(DEFAULT_PLAN_KEY, false) === true;
}
export function setDefaultPlanMode(on: boolean): void {
  setSetting(DEFAULT_PLAN_KEY, on);
  notify();
  mirrorModelsToSettings();
}

/** Whether new chats start in fast mode (no-op for models that don't support it). */
export function getDefaultFastMode(): boolean {
  return getSetting<boolean>(DEFAULT_FAST_KEY, false) === true;
}
export function setDefaultFastMode(on: boolean): void {
  setSetting(DEFAULT_FAST_KEY, on);
  notify();
  mirrorModelsToSettings();
}

// ── Chat-title model ("Custom models" in Settings → Models) ──
//
// One global pick for the cheap model that writes AI chat titles from the
// first prompt. 2026-07-10 spec (v2 — the "Default agents" option was
// removed): the dropdown is just the three title models, Haiku by default,
// and CONNECTIVITY drives the actual call — when the picked model's agent
// isn't connected, resolveChatTitleModel() falls down the fixed chain
// Haiku → Luna → Composer 2.5 to the first connected one (no Claude ⇒
// Luna; only Cursor ⇒ Composer 2.5). The Settings dropdown disables picks
// whose agent isn't connected; the runtime chain covers a later
// disconnect, and any remaining failure just leaves the seeded title.

export type ChatTitleModelChoice =
  | "claude-haiku-4-5"
  | "gpt-5.6-luna"
  | "composer-2.5";

/** The Settings dropdown rows: value + display label + the agent family
 *  the option needs connected. Order IS the runtime fallback chain. */
export const CHAT_TITLE_MODEL_OPTIONS: ReadonlyArray<{
  value: ChatTitleModelChoice;
  label: string;
  family: string;
}> = [
  { value: "claude-haiku-4-5", label: "Haiku", family: "claude" },
  { value: "gpt-5.6-luna", label: "Luna", family: "codex" },
  { value: "composer-2.5", label: "Composer 2.5", family: "cursor" },
];

const DEFAULT_CHAT_TITLE_MODEL: ChatTitleModelChoice = "claude-haiku-4-5";

/** Last-resort title model per chat-agent family — used only when the
 *  connectivity snapshot rules out the whole chain (the chat's own agent
 *  must be live: it just sent a message). */
export const DEFAULT_TITLE_MODEL_BY_FAMILY: Record<string, string> = {
  claude: "claude-haiku-4-5",
  codex: "gpt-5.6-luna",
  cursor: "composer-2.5",
};

function isChatTitleModelChoice(v: unknown): v is ChatTitleModelChoice {
  return CHAT_TITLE_MODEL_OPTIONS.some((o) => o.value === v);
}

/** The saved chat-title model choice. Unset, unknown, or the retired
 *  "default" (Default agents) value all resolve to Haiku (the spec
 *  default). */
export function getChatTitleModel(): ChatTitleModelChoice {
  const v = getSetting<string | null>(CHAT_TITLE_MODEL_KEY, null);
  return isChatTitleModelChoice(v) ? v : DEFAULT_CHAT_TITLE_MODEL;
}

export function setChatTitleModel(choice: ChatTitleModelChoice): void {
  setSetting(CHAT_TITLE_MODEL_KEY, choice);
  notify();
  mirrorModelsToSettings();
}

/** The system instruction for the one-shot title-generation call. The model's
 *  reply is used VERBATIM as the chat title, so the contract is strict: name
 *  the message, never answer it, and keep it to 2–3 words so the sidebar and
 *  tab strip never truncate. */
export const CHAT_TITLE_SYSTEM_PROMPT = [
  "You generate a short title for a chat based on the user's first message.",
  "Reply with ONLY the title — your entire reply is used verbatim as the chat title.",
  "The title must be a minimum of 2 words and a maximum of 3 words.",
  "Capture the user's intent or topic in those 2–3 words.",
  "Use plain sentence case. No quotes, no trailing punctuation, no emojis, no markdown.",
  "Never answer, act on, or ask about the message itself — only name it.",
  "If the message is unclear, still produce your best 2–3 word topic name.",
].join(" ");

/** The {family, model} a title-generation call for a chat on `agentId`
 *  should use. The saved pick wins when its agent is connected; otherwise
 *  fall down the chain (Haiku → Luna → Composer 2.5) to the first
 *  connected family. `connectedFamilies` null = connectivity unknown
 *  (agents snapshot not loaded yet) — trust the pick as saved. Null result
 *  only when even the chat's own agent has no catalog family
 *  (retired/unknown agents) — skip AI titling. */
export function resolveChatTitleModel(
  agentId: string | null | undefined,
  connectedFamilies: ReadonlySet<string> | null = null,
): { family: string; model: string } | null {
  const choice = getChatTitleModel();
  const chain = [
    choice,
    ...CHAT_TITLE_MODEL_OPTIONS.map((o) => o.value).filter((v) => v !== choice),
  ];
  for (const value of chain) {
    const opt = CHAT_TITLE_MODEL_OPTIONS.find((o) => o.value === value);
    if (!opt) continue;
    if (connectedFamilies === null || connectedFamilies.has(opt.family)) {
      return { family: opt.family, model: opt.value };
    }
  }
  // Whole chain reads disconnected — distrust the snapshot over the chat
  // itself (it JUST sent a message) and title through its own family.
  const fam = agentFamily(agentId ?? null);
  const model = DEFAULT_TITLE_MODEL_BY_FAMILY[fam];
  return model ? { family: fam, model } : null;
}

/** Star a model as `agentId`'s favorite (the model its new chats open on)
 *  and mirror the change into settings.toml. 2026-07 spec: this NO LONGER
 *  flips the default agent — that's picked separately in Settings → Models.
 *  Pass null to clear the user star (reverts to the catalog fallback). */
export function starFavoriteModel(
  agentId: string | null | undefined,
  modelValue: string | null,
): void {
  if (!agentId) return;
  setFavoriteModel(agentId, modelValue);
  mirrorModelsToSettings();
}

/** The fields a brand-new chat for `agentId` is born with — the single
 *  source of truth shared by every spawn path (new workspace, "+" → Chat,
 *  ⌘T). Model = the family's effective favorite (the user's ★, else the
 *  catalog fallback: Opus 4.8 / 5.6 Sol / Composer 2.5); effort = the
 *  saved default, clamped to the model's ladder (Sonnet has no
 *  xhigh/ultracode, etc.); permissionMode + fast from the plan/fast toggles. */
export function newChatBornDefaults(agentId: string | null): {
  model: string | null;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
  fast: boolean;
} {
  const model = effectiveFavoriteModel(agentId);
  const levels = effortLevelsFor(agentId, model, null);
  let effort: ChatEffort = getDefaultEffort(agentId) ?? "high";
  if (levels.length > 0 && !levels.includes(effort)) {
    effort = levels.includes("high") ? "high" : levels[levels.length - 1];
  }
  // Every new chat is born in the SAFE default posture, never inheriting a prior
  // chat's pick. Family-aware (2026-07 spec):
  //   • Codex → ALWAYS "tool-approval" ("Ask for approval" — the spec default
  //     for every Codex model). Codex's 3-mode menu (Ask / Approve for me / Full
  //     access) has NO plan/read-only mode, and the Plan pill is inert, so a
  //     Codex chat must never be born in "plan" — it would be unreachable to exit.
  //   • Claude / Cursor → "plan" when the global "start in plan" toggle is on,
  //     else "auto" (Claude's classifier / Cursor's agent mode).
  const permissionMode: ChatPermissionMode =
    agentFamily(agentId) === "codex"
      ? "tool-approval"
      : getDefaultPlanMode()
        ? "plan"
        : "auto";
  const fast = getDefaultFastMode() && agentSupportsFast(agentId, model, null);
  return { model, effort, permissionMode, fast };
}

// ── settings.toml mirror — the user [models] table ─────
//
// settings.toml is the durable source of truth; the localStorage keys above are
// the synchronous spawn-read cache. The setters write the cache AND mirror it
// into the user `[models]` table (the [[project-settings-foundation]]
// provider-prefs dual-write); boot sync (useModelsSettingsSync) copies the
// resolved table back into the cache so a direct file edit or another device is
// honored. Family === agent id (claude/codex/cursor), so the mapping is identity.

const EFFORT_SET = new Set<ChatEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);
function isEffort(v: unknown): v is ChatEffort {
  return typeof v === "string" && (EFFORT_SET as Set<string>).has(v);
}

/** While hydrating the cache FROM settings.toml, suppress the mirror so a
 *  hydration write never loops straight back into the file. */
let suppressMirror = false;

/** The user `[models]` table built from the cache. A null
 *  leaf deletes that key via applySettingsPatch, so the file mirrors the cache
 *  exactly (off toggles + unset efforts drop out, keeping the file clean). */
/** The families the favorites table persists (the curated catalog set). */
const FAVORITE_FAMILIES = ["claude", "codex", "cursor"] as const;

function buildModelsTable(): Record<string, unknown> {
  const defaultAgentId = getDefaultAgentId();
  let defaultModel: string | null = null;
  if (defaultAgentId) {
    defaultModel =
      effectiveFavoriteModel(defaultAgentId) ??
      modelsForAgent(defaultAgentId, null)[0]?.value ??
      null;
  }
  const effort = readEffortMap();
  // Per-family USER stars (raw — the catalog fallback is code, not file
  // state). null deletes the key, so an un-starred family drops out.
  const favorites: Record<string, string | null> = {};
  for (const fam of FAVORITE_FAMILIES) favorites[fam] = getFavoriteModel(fam);
  return {
    default: defaultModel,
    // Persist the OWNING agent too: `default` is a bare model value, and a value
    // can't reliably identify its agent (Cursor lists `claude-opus-4-8-thinking-high`
    // / `gpt-5.3-codex`, which embed or share other families' names). Storing the
    // agent makes the hydrate round-trip lossless. null deletes the key.
    default_agent: defaultAgentId,
    favorites,
    default_plan_mode: getDefaultPlanMode() ? true : null,
    default_fast_mode: getDefaultFastMode() ? true : null,
    // The Haiku default drops out of the file (null deletes the key) —
    // only a non-default pick persists, keeping the table clean.
    chat_title_model:
      getChatTitleModel() === DEFAULT_CHAT_TITLE_MODEL
        ? null
        : getChatTitleModel(),
    claude_code: {
      default_effort_level: effort.claude ?? null,
      // §3.6 R2/R3 — the reliability knobs, mirrored losslessly: the fallback
      // writes its resolved value ("none" for explicit fail-fast) so the
      // default never forges a user pick; a null cap (off) drops its key.
      fallback_model: getClaudeFallbackModel() ?? "none",
      budget_cap_usd: getClaudeBudgetCapUsd(),
    },
    codex: { default_thinking_level: effort.codex ?? null },
  };
}

/** Mirror the cache into the user settings.toml `[models]` table. Best-effort
 *  (like provider-prefs) — a missed write self-heals on the next change. No-op
 *  while hydrating, or when there's no engine bridge (web offline / boot). */
export function mirrorModelsToSettings(): void {
  if (suppressMirror) return;
  const bridge = getActiveBridge();
  if (!bridge) return;
  void bridgeSettingsWrite(bridge, "user", {
    models: buildModelsTable(),
  }).catch(() => {
    /* best-effort mirror */
  });
}

/** Copy a resolved `[models]` table into the localStorage cache. Authoritative
 *  for the plan/fast bools + per-agent effort (the file wins); ADDITIVE for
 *  `default` (a file that omits it never clears a cached default, so an empty
 *  file can't wipe a user mid-migration). Guards skip no-op writes so a refresh
 *  with no real change fires no listeners. */
export function hydrateModelsFromSettings(models: unknown): void {
  if (!models || typeof models !== "object") return;
  const m = models as Record<string, unknown>;
  suppressMirror = true;
  try {
    // Recover the default AGENT: prefer the explicit `default_agent` (lossless,
    // and the only way to disambiguate a model value shared across agents), and
    // fall back to `default`'s catalog membership for a file that carries only
    // the model (a hand-edit, a config written by another tool, or one from before
    // the agent was persisted). NEVER substring-match the model value here — a
    // Cursor model like `claude-opus-4-8-thinking-high` would misclassify as
    // "claude" and silently switch the user's default agent.
    const fam =
      (typeof m.default_agent === "string"
        ? agentFamily(m.default_agent)
        : "") ||
      (typeof m.default === "string" && m.default
        ? familyForModelValue(m.default)
        : "");
    if (fam && getDefaultAgentId() !== fam) setDefaultAgentId(fam);
    // Per-family favorite stars. The new-shape `favorites` table wins (it's the
    // raw star map the mirror writes); a legacy file that only carries `default`
    // seeds the default agent's family favorite from it instead. ADDITIVE both
    // ways — an absent key never clears a local star mid-migration.
    const favs =
      m.favorites && typeof m.favorites === "object"
        ? (m.favorites as Record<string, unknown>)
        : null;
    if (favs) {
      for (const family of FAVORITE_FAMILIES) {
        const v = favs[family];
        if (typeof v === "string" && v && getFavoriteModel(family) !== v) {
          setFavoriteModel(family, v);
        }
      }
    } else if (typeof m.default === "string" && m.default && fam) {
      // Legacy file (no favorites table): seed the star ONLY when the value
      // differs from what resolution already lands on. The mirror writes
      // `default` even for users with no explicit star (the effective
      // favorite — and an all-null favorites table drops out of the file
      // entirely), so blindly seeding here would forge a durable user star
      // out of a code-level fallback and pin those users against future
      // catalog defaultFavorites bumps.
      if (
        effectiveFavoriteModel(fam) !== m.default &&
        getFavoriteModel(fam) !== m.default
      ) {
        setFavoriteModel(fam, m.default);
      }
    }
    // Authoritative like the bools: a file without the key means Haiku
    // (the mirror deletes the key for the default, so absence IS the
    // value; a legacy "default" string also lands here → Haiku).
    const title = isChatTitleModelChoice(m.chat_title_model)
      ? m.chat_title_model
      : DEFAULT_CHAT_TITLE_MODEL;
    if (getChatTitleModel() !== title) setChatTitleModel(title);
    const plan = m.default_plan_mode === true;
    if (getDefaultPlanMode() !== plan) setDefaultPlanMode(plan);
    const fast = m.default_fast_mode === true;
    if (getDefaultFastMode() !== fast) setDefaultFastMode(fast);
    const claude = (m.claude_code as Record<string, unknown> | undefined)
      ?.default_effort_level;
    if (isEffort(claude) && getDefaultEffort("claude") !== claude) {
      setDefaultEffort("claude", claude);
    }
    // §3.6 R2/R3 — reliability knobs. ADDITIVE for the fallback (an absent
    // key keeps the local value — legacy files predate it); the cap follows
    // the same rule (absent = keep; explicit null in TOML can't occur).
    const cc = m.claude_code as Record<string, unknown> | undefined;
    if (typeof cc?.fallback_model === "string" && cc.fallback_model) {
      const fb = cc.fallback_model === "none" ? null : cc.fallback_model;
      if (getClaudeFallbackModel() !== fb) setClaudeFallbackModel(fb);
    }
    if (typeof cc?.budget_cap_usd === "number" && cc.budget_cap_usd > 0) {
      if (getClaudeBudgetCapUsd() !== cc.budget_cap_usd) {
        setClaudeBudgetCapUsd(cc.budget_cap_usd);
      }
    }
    const codex = (m.codex as Record<string, unknown> | undefined)
      ?.default_thinking_level;
    if (isEffort(codex) && getDefaultEffort("codex") !== codex) {
      setDefaultEffort("codex", codex);
    }
  } finally {
    suppressMirror = false;
  }
}

/** True when the cache holds at least one explicit default worth migrating into
 *  an empty settings.toml on first boot (so an existing user's choices land in
 *  the file without them having to re-pick). */
export function hasModelDefaults(): boolean {
  if (getDefaultAgentId()) return true;
  if (FAVORITE_FAMILIES.some((fam) => getFavoriteModel(fam))) return true;
  if (getDefaultPlanMode() || getDefaultFastMode()) return true;
  if (getChatTitleModel() !== DEFAULT_CHAT_TITLE_MODEL) return true;
  const e = readEffortMap();
  return Boolean(e.claude || e.codex);
}

// ── Pub/sub bus (mirrors model-favorites.ts) ─────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw; keep going */
    }
  }
}

/** Hook: the default effort for `agentId`'s family. Re-renders when any
 *  caller of setDefaultEffort() fires (e.g. the Settings dropdown). */
export function useDefaultEffort(
  agentId: string | null | undefined,
): ChatEffort | null {
  const [effort, setEffort] = useState<ChatEffort | null>(() =>
    getDefaultEffort(agentId),
  );
  useEffect(() => {
    const sync = () => setEffort(getDefaultEffort(agentId));
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [agentId]);
  return effort;
}

/** Hook: `[on, setOn]` for the "start new chats in plan mode" default. */
export function useDefaultPlanMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(getDefaultPlanMode);
  useEffect(() => {
    const sync = () => setOn(getDefaultPlanMode());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((next: boolean) => setDefaultPlanMode(next), []);
  return [on, set];
}

/** Hook: `[choice, setChoice]` for the chat-title model ("Custom models"). */
export function useChatTitleModel(): [
  ChatTitleModelChoice,
  (choice: ChatTitleModelChoice) => void,
] {
  const [choice, setChoice] = useState<ChatTitleModelChoice>(getChatTitleModel);
  useEffect(() => {
    const sync = () => setChoice(getChatTitleModel());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback(
    (next: ChatTitleModelChoice) => setChatTitleModel(next),
    [],
  );
  return [choice, set];
}

/** Hook: `[on, setOn]` for the "start new chats in fast mode" default. */
export function useDefaultFastMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(getDefaultFastMode);
  useEffect(() => {
    const sync = () => setOn(getDefaultFastMode());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((next: boolean) => setDefaultFastMode(next), []);
  return [on, set];
}
