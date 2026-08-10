// ──────────────────────────────────────────────────────────
// new-chat-defaults — what a freshly created chat is born with
// ──────────────────────────────────────────────────────────
//
// One atomic default-model identity drives the agent + model for a new chat.
// With no user choice, connected agents resolve in Codex → Claude → Cursor
// order and each family uses its catalog fallback (Opus 5 / GPT-5.6 Sol /
// Composer 2.5). Exactly one model is starred across the whole picker.
//
// Effort and Fast are remembered by exact family + model (never globally or
// per family). Permission mode is remembered as an exact native id per agent
// family; the global plan default remains an explicit higher-priority override.
// This module exposes `newChatBornDefaults()` —
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

import { getSetting, setSetting } from "../../platform/settings";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { bridgeSettingsWrite } from "../../platform/bridge/workspace-bridge";
import {
  getDefaultAgentId,
  setDefaultAgentId,
} from "../settings/default-agent";
import {
  agentFamily,
  curatedLegacyFavorites,
  defaultFavoriteModelFor,
  familyForModelValue,
  modelsForAgent,
  nativeModeIdForPosture,
  permissionForAgentMode,
  soleLegacyFavoriteFamily,
} from "./model-catalog";
import {
  effectiveFavoriteModel,
  getFavoriteSelection,
  setFavoriteModel,
} from "./model-favorites";
import {
  hasModelPreferenceStorage,
  replaceModelPreferences,
  resolveModelConfiguration,
  serializeModelPreferences,
  setModelPreference,
  type PersistedModelPreference,
} from "./model-preferences";
import {
  replacePermissionPreferences,
  resolvePermissionConfiguration,
  serializePermissionPreferences,
  setPermissionPreference,
} from "./permission-preferences";
import {
  DEFAULT_CLAUDE_FALLBACK,
  DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
  getClaudeBudgetCapUsd,
  getClaudeFallbackModel,
  getClaudeIdleTimeoutMinutes,
  isClaudeIdleTimeoutMinutes,
  setClaudeBudgetCapUsd,
  setClaudeFallbackModel,
  setClaudeIdleTimeoutMinutes,
} from "./reliability-settings";
import type { ChatEffort, ChatPermissionMode } from "../../state/store";

/** Legacy per-family effort cache. It is read once to migrate the selected
 * default model, then exact-model records become authoritative. */
const DEFAULT_EFFORT_KEY = "default-effort-by-family";
/** Start new chats in plan mode (global, all agents). */
const DEFAULT_PLAN_KEY = "default-plan-mode";
/** Legacy global Fast cache, retained only as a migration input. */
const DEFAULT_FAST_KEY = "default-fast-mode";
/** The model used to auto-generate chat titles (Settings → Models → "Custom models"). */
const CHAT_TITLE_MODEL_KEY = "chat-title-model";

type EffortMap = Record<string, ChatEffort>;

function readEffortMap(): EffortMap {
  const raw = getSetting<EffortMap | null>(DEFAULT_EFFORT_KEY, null);
  return raw && typeof raw === "object" ? raw : {};
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

/** Legacy global Fast preference. New behavior resolves Fast per model. */
function getDefaultFastMode(): boolean {
  return getSetting<boolean>(DEFAULT_FAST_KEY, false) === true;
}

/** Persist a user's effort/Fast choice for one exact model and mirror it to the
 * durable user settings file. All interactive surfaces route through here. */
export function rememberModelConfiguration(
  agentId: string | null | undefined,
  model: string | null | undefined,
  next: Partial<{ effort: ChatEffort; fast: boolean }>,
): void {
  const exactModel = model ?? effectiveFavoriteModel(agentId);
  migrateLegacyConfigurationFor(agentId ?? null, exactModel);
  setModelPreference(agentId, exactModel, next);
  notify();
  mirrorModelsToSettings();
}

/** Persist one exact native permission mode for this agent family and mirror it
 * into the durable user settings file. Every user-driven permission surface
 * routes through here so future chats restore the same choice.
 *
 * EXCEPT the danger posture (Claude `bypass`, Codex `full-access`, Cursor
 * `agent`), which stays with the chat that asked for it. Those modes turn off
 * the prompts standing between an agent and the machine, so letting one chat's
 * escape hatch become the birth posture of every later chat — indefinitely,
 * across every workspace, behind an icon-only pill that shows no label until
 * hovered — is a much bigger promise than the click made. The chat still
 * switches; only the durable default is left on its last non-danger value. A
 * user who genuinely wants that default can still write it in settings.toml,
 * where it is an explicit, visible choice rather than a side effect. */
export function rememberPermissionMode(
  agentId: string | null | undefined,
  modeId: string | null | undefined,
): void {
  if (modeId && permissionForAgentMode(modeId, agentId ?? null) === "danger") {
    return;
  }
  setPermissionPreference(agentId, modeId);
  notify();
  mirrorModelsToSettings();
}

// ── Chat-title model ("Custom models" in Settings → Models) ──
//
// One global pick for the cheap model that writes AI chat titles from the
// first prompt. The dropdown contains the three title models, with Haiku as
// the default,
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
 *  "default" value all resolve to Haiku. */
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

/** Move the one global default-model star (agent + model atomically) and mirror
 * the change into settings.toml. Null keeps the agent and restores its catalog
 * fallback. */
export function starFavoriteModel(
  agentId: string | null | undefined,
  modelValue: string | null,
): void {
  if (!agentId) return;
  setFavoriteModel(agentId, modelValue);
  mirrorModelsToSettings();
}

/** One-time localStorage migration. The old family effort + global Fast values
 * cannot truthfully describe every model, so preserve them only on the model
 * each family had selected when the migration happened. Every other model starts
 * at High/Fast-off, preventing the old cross-model leakage from continuing.
 *
 * EVERY family migrates in this single pass. The marker written below makes this
 * a permanent no-op and the clear drops the whole legacy map, so a family left
 * for "its own turn" would never get one: migrating Codex first used to erase a
 * Claude Max the user had set, silently reopening every Claude chat at High. */
function migrateLegacyConfigurationFor(
  agentId: string | null,
  model: string | null,
): void {
  if (!agentId || !model || hasModelPreferenceStorage()) return;
  const family = agentFamily(agentId);
  const legacyEfforts = readEffortMap();
  const legacyFast = getDefaultFastMode();
  const records: PersistedModelPreference[] = Object.entries(
    legacyEfforts,
  ).flatMap(([owner, effort]) => {
    if (!isEffort(effort)) return [];
    // The caller's own family keeps the model in hand (which is the model the
    // user was configuring); every other family lands on its own selection.
    const target = owner === family ? model : effectiveFavoriteModel(owner);
    return target ? [{ agent: owner, model: target, effort }] : [];
  });
  // Legacy Fast was one global flag, so the model in hand is the only one it can
  // honestly describe — fanning it across families would recreate exactly the
  // cross-model leakage this migration exists to end.
  if (legacyFast) {
    const own = records.find(
      (record) => record.agent === family && record.model === model,
    );
    if (own) own.fast = true;
    else records.push({ agent: family, model, fast: true });
  }
  // An absence of local legacy values is not proof that migration is done:
  // settings.toml hydrates asynchronously and may still contain the durable
  // legacy copy. Writing an empty marker here would mask that later source.
  if (records.length === 0) return;
  replaceModelPreferences(records);
  // Clear only after the new marker demonstrably landed. This prevents old
  // fields from repeatedly re-triggering migration while preserving them if
  // localStorage rejected the write.
  if (hasModelPreferenceStorage()) {
    setSetting(DEFAULT_EFFORT_KEY, {});
    setSetting(DEFAULT_FAST_KEY, false);
  }
}

function legacyMigrationAgentId(): string | null {
  const explicit = getDefaultAgentId();
  if (explicit) return explicit;
  const effort = readEffortMap();
  // Before provider-priority defaults, an unset agent meant Claude. Preserve
  // that historical selected-model meaning; a Codex-only effort slot still
  // identifies Codex unambiguously.
  if (isEffort(effort.claude) || getDefaultFastMode()) return "claude";
  if (isEffort(effort.codex)) return "codex";
  return null;
}

/** The fields a brand-new chat for `agentId` is born with — the single
 *  source of truth shared by every spawn path (new workspace, "+" → Chat,
 *  ⌘T). Model = the global default when this agent owns it, otherwise the
 *  family fallback. Effort/Fast restore this exact model's last user choice. */
export function newChatBornDefaults(agentId: string | null): {
  model: string | null;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
  lastModeId?: string;
  fast: boolean;
} {
  const model = effectiveFavoriteModel(agentId);
  migrateLegacyConfigurationFor(agentId, model);
  const { effort, fast } = resolveModelConfiguration(agentId, model, null);
  // Default exact native modes: Claude Auto, Codex Approve for me, Cursor Auto.
  // A user's last choice wins independently per family. The explicit Settings
  // "Default to plan mode" switch remains a higher-priority override for agents
  // that expose Plan; Codex intentionally has no Plan row in its composer menu.
  const remembered = resolvePermissionConfiguration(agentId);
  const forcePlan = getDefaultPlanMode() && agentFamily(agentId) !== "codex";
  const lastModeId = forcePlan
    ? (nativeModeIdForPosture(agentId, "plan") ?? undefined)
    : (remembered.modeId ?? undefined);
  const permissionMode: ChatPermissionMode = forcePlan
    ? "plan"
    : remembered.permissionMode;
  return { model, effort, permissionMode, lastModeId, fast };
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
function buildModelsTable(): Record<string, unknown> {
  const defaultAgentId = getDefaultAgentId();
  let defaultModel: string | null = null;
  if (defaultAgentId) {
    defaultModel =
      effectiveFavoriteModel(defaultAgentId) ??
      modelsForAgent(defaultAgentId, null)[0]?.value ??
      null;
  }
  const migrationAgentId = defaultAgentId ?? legacyMigrationAgentId();
  if (migrationAgentId) {
    migrateLegacyConfigurationFor(
      migrationAgentId,
      effectiveFavoriteModel(migrationAgentId),
    );
  }
  const preferences = serializeModelPreferences();
  const permissionPreferences = serializePermissionPreferences();
  return {
    default: defaultModel,
    // Persist the OWNING agent too: `default` is a bare model value, and a value
    // can't reliably identify its agent (Cursor lists `claude-opus-4-8-thinking-high`
    // / `gpt-5.3-codex`, which embed or share other families' names). Storing the
    // agent makes the hydrate round-trip lossless. null deletes the key.
    default_agent: defaultAgentId,
    // Explicit migration cleanup: there is one global default now, represented
    // by default + default_agent above. The old multi-star table must not keep
    // rendering as three favorites after a downgrade/re-hydration round trip.
    favorites: null,
    // Keep an explicit empty array as the new-schema marker. That lets a
    // synced/settings-file clear replace stale device-local memory instead of
    // being mistaken for a legacy file that never had exact-model records.
    model_preferences: preferences,
    // Exact native ids are agent-scoped (not model-scoped). Keep an explicit
    // empty array so a synced settings clear replaces stale device-local memory.
    permission_preferences: permissionPreferences,
    default_plan_mode: getDefaultPlanMode() ? true : null,
    // Legacy global Fast was migrated onto the selected exact model.
    default_fast_mode: null,
    // The Haiku default drops out of the file (null deletes the key) —
    // only a non-default pick persists, keeping the table clean.
    chat_title_model:
      getChatTitleModel() === DEFAULT_CHAT_TITLE_MODEL
        ? null
        : getChatTitleModel(),
    claude_code: {
      // Legacy family effort was migrated onto the selected exact model.
      default_effort_level: null,
      // Claude reliability knobs, mirrored losslessly: the fallback
      // writes its resolved value ("none" for explicit fail-fast) so the
      // default never forges a user pick; a null cap (off) drops its key. The
      // idle timeout is always explicit so every process receives one of the
      // four bounded choices even after a hand edit or cache migration.
      fallback_model: getClaudeFallbackModel() ?? "none",
      budget_cap_usd: getClaudeBudgetCapUsd(),
      idle_timeout_minutes: getClaudeIdleTimeoutMinutes(),
    },
    codex: { default_thinking_level: null },
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

/** Copy a resolved `[models]` table into the synchronous cache. The exact-model
 * array is authoritative when present. Legacy family/global fields migrate only
 * to the selected default model; they never fan out to every model. */
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
    const explicitDefaultAgent =
      typeof m.default_agent === "string" && m.default_agent.trim()
        ? m.default_agent.trim()
        : null;
    const explicitFamily = explicitDefaultAgent
      ? agentFamily(explicitDefaultAgent)
      : "";
    // Infer ownership from the bare model only when the file did not provide
    // an agent. An extension is allowed to use a model id that also appears in
    // the curated catalog; its explicit identity must still win.
    const inferredFamily =
      !explicitDefaultAgent && typeof m.default === "string" && m.default
        ? familyForModelValue(m.default)
        : "";
    // A current file's bare default is the one global model. A legacy favorites
    // table wins for its selected default family because older mirrors wrote the
    // fallback to `default` and the user's real choice to `favorites.<family>`.
    const curatedFavorites = curatedLegacyFavorites(m.favorites);
    // A file carrying ONLY a favorites table still has to migrate here, by the
    // same sole-family rule the localStorage read uses: the old mirror wrote
    // `default`/`default_agent` only when a default agent existed, so a
    // star-but-no-agent user's file has favorites alone — and buildModelsTable
    // deletes that key on the very next mirror write.
    const fam =
      explicitFamily ||
      inferredFamily ||
      (explicitDefaultAgent ? "" : soleLegacyFavoriteFamily(m.favorites));
    if (fam) {
      const legacyFavorite = curatedFavorites.get(fam);
      const candidate =
        legacyFavorite ??
        (typeof m.default === "string" && m.default ? m.default : null);
      const fallback = defaultFavoriteModelFor(fam);
      const rawModel =
        candidate === fallback && !legacyFavorite ? null : candidate;
      const current = getFavoriteSelection();
      if (current?.agentId !== fam || current.model !== rawModel) {
        setFavoriteModel(fam, rawModel);
      }
    } else if (explicitDefaultAgent) {
      // Preserve extension-provided agent ids even though the curated global
      // model record is family-scoped to Claude/Codex/Cursor.
      if (getDefaultAgentId() !== explicitDefaultAgent) {
        setDefaultAgentId(explicitDefaultAgent);
      }
    } else if (
      Array.isArray(m.model_preferences) &&
      typeof m.default !== "string" &&
      getDefaultAgentId() !== null
    ) {
      // The explicit exact-model array marks a current-format file. With no
      // default identity in that file, clear a stale device-local choice; old
      // files without the marker retain their additive migration behavior.
      setDefaultAgentId(null);
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
    const claude = (m.claude_code as Record<string, unknown> | undefined)
      ?.default_effort_level;
    const codex = (m.codex as Record<string, unknown> | undefined)
      ?.default_thinking_level;

    if (Array.isArray(m.model_preferences)) {
      replaceModelPreferences(m.model_preferences);
      setSetting(DEFAULT_EFFORT_KEY, {});
      setSetting(DEFAULT_FAST_KEY, false);
    } else if (!hasModelPreferenceStorage() && fam) {
      // Loss-minimizing migration: an old field described only its family's
      // selected model. Preserve each one there and leave every other model
      // High/Fast-off. EVERY family migrates here for the same reason the
      // localStorage pass does — the marker below closes the door behind it,
      // and buildModelsTable then deletes both legacy keys from the file.
      replaceModelPreferences([]);
      const legacyFast = m.default_fast_mode === true;
      for (const [owner, legacyEffort] of [
        ["claude", claude],
        ["codex", codex],
      ] as const) {
        const selectedModel = effectiveFavoriteModel(owner);
        if (selectedModel && isEffort(legacyEffort)) {
          setModelPreference(owner, selectedModel, { effort: legacyEffort });
        }
      }
      // Global Fast can only describe the default family's own model.
      const selectedModel = effectiveFavoriteModel(fam);
      if (selectedModel && legacyFast) {
        setModelPreference(fam, selectedModel, { fast: true });
      }
      if (hasModelPreferenceStorage()) {
        setSetting(DEFAULT_EFFORT_KEY, {});
        setSetting(DEFAULT_FAST_KEY, false);
      }
    }
    if (Array.isArray(m.permission_preferences)) {
      replacePermissionPreferences(m.permission_preferences);
    }
    // Claude reliability knobs. ADDITIVE for the fallback (an absent
    // key keeps the local value — legacy files predate it); the cap follows
    // the same rule (absent = keep; explicit null in TOML can't occur). Idle
    // timeout is authoritative: absence/invalid means the bounded default.
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
    const idleTimeout = isClaudeIdleTimeoutMinutes(cc?.idle_timeout_minutes)
      ? cc.idle_timeout_minutes
      : DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES;
    if (getClaudeIdleTimeoutMinutes() !== idleTimeout) {
      setClaudeIdleTimeoutMinutes(idleTimeout);
    }
  } finally {
    suppressMirror = false;
  }
}

/** True when the cache holds at least one explicit default worth migrating into
 *  an empty settings.toml on first boot (so an existing user's choices land in
 *  the file without them having to re-pick). */
export function hasModelDefaults(): boolean {
  if (getFavoriteSelection() || getDefaultAgentId()) return true;
  if (getDefaultPlanMode()) return true;
  if (serializeModelPreferences().length > 0) return true;
  if (serializePermissionPreferences().length > 0) return true;
  if (getChatTitleModel() !== DEFAULT_CHAT_TITLE_MODEL) return true;
  if (getClaudeFallbackModel() !== DEFAULT_CLAUDE_FALLBACK) return true;
  if (getClaudeBudgetCapUsd() != null) return true;
  if (getClaudeIdleTimeoutMinutes() !== DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES)
    return true;
  // Legacy values count only until the exact-model migration marker lands.
  if (!hasModelPreferenceStorage()) {
    const effort = readEffortMap();
    return Boolean(effort.claude || effort.codex || getDefaultFastMode());
  }
  return false;
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
