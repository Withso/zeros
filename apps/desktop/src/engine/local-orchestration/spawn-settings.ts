// ──────────────────────────────────────────────────────────
// Local orchestration — a new chat's agent, model, effort and mode
// ──────────────────────────────────────────────────────────
//
// With no flags a child copies its creator exactly (D10): agent, resolved
// model, effort, Fast, exact native mode (lastModeId / prePlanModeId) and, in
// the same folder, additional directories. Flags override any of them (D11),
// validated against the same curated catalog the composer picker uses
// (catalogs/models-v1.json) plus the provider's live list when known.
//
// A child never gets a higher permission level than its creator. Same family
// keeps native ids; another family gets the broadest native mode at or below
// the creator's level (LOCAL_MODE_FOR_LEVEL_BY_FAMILY).
//
// The env mirrors the renderer's envForChatSettings: model env var, effort,
// Fast, permission mode, additional dirs and the Claude lifetime knobs.
// Provider credentials, base URL and binary come from the gateway's trusted
// headless fallback (settings/provider-env.ts), never from here.
// ──────────────────────────────────────────────────────────

import modelCatalogJson from "../../../../../catalogs/models-v1.json";
import type { InitializeResponse } from "@zeros/protocol/agent-events";
import {
  LOCAL_MODE_LEVEL_BY_FAMILY,
  LocalOrchestrationError,
  localAgentFamily,
  localModeForLevel,
  localModeLevel,
  localModeRank,
  type LocalModeLevel,
} from "@zeros/protocol/local-orchestration";
import type { ChatRow } from "../db/chats";

// ── The picker's model rules (mirror of renderer/features/agent/model-catalog.ts)
//
// The renderer module reads renderer settings, so the engine keeps this pure
// copy of the rules a new chat's settings depend on: curated rows own which
// models exist and what they are called; live discovery overlays capability
// and, only when account-scoped and complete, eligibility. The parity test
// (__tests__/spawn-settings-parity.test.ts) checks both against fixtures.

interface ModelOption {
  value: string;
  label: string;
  selectable?: boolean;
  liveRequired?: boolean;
  effortLevels?: string[];
  defaultEffort?: string;
  supportsFast?: boolean;
}

interface ModelCatalog {
  families: Record<string, unknown[]>;
  defaultFavorites?: Record<string, string>;
  modelEnvVars?: Record<string, string>;
  aliases?: Record<string, Record<string, string>>;
}

const catalog = modelCatalogJson as unknown as ModelCatalog;
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultracode: 5 };
const CLAUDE_OPUS_LADDER = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const CLAUDE_SONNET_LADDER = ["low", "medium", "high", "max"];
const CODEX_LADDER = ["low", "medium", "high", "xhigh"];
const BASIC_LADDER = ["low", "medium", "high"];
/** The live-discovery fields allowed to overlay a curated row. */
const LIVE_OVERLAYABLE = ["selectable", "effortLevels", "supportsFast"] as const;

function coerceOption(x: unknown): ModelOption | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.value !== "string" || typeof o.label !== "string") return null;
  const out: ModelOption = { value: o.value, label: o.label };
  if (typeof o.selectable === "boolean") out.selectable = o.selectable;
  if (o.liveRequired === true) out.liveRequired = true;
  if (Array.isArray(o.effortLevels)) {
    out.effortLevels = o.effortLevels.filter((e): e is string => typeof e === "string" && (VALID_EFFORTS as readonly string[]).includes(e));
  }
  if (typeof o.defaultEffort === "string" && (VALID_EFFORTS as readonly string[]).includes(o.defaultEffort)) out.defaultEffort = o.defaultEffort;
  if (typeof o.supportsFast === "boolean") out.supportsFast = o.supportsFast;
  return out;
}

const CURATED: Record<string, ModelOption[]> = Object.fromEntries(
  Object.entries(catalog.families).map(([family, rows]) => [
    family,
    rows.map(coerceOption).filter((m): m is ModelOption => m !== null),
  ]),
);

/** A model id's canonical curated slug: no `[1m]`-style context suffix, no
 * trailing `-YYYYMMDD` snapshot, known aliases resolved. */
export function normalizeModelSlug(family: string, id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]\s*$/, "");
  s = s.replace(/-\d{8}$/, "");
  const alias = catalog.aliases?.[family]?.[s];
  return typeof alias === "string" ? alias : s;
}

function familyOf(agentId: string | null): string {
  return localAgentFamily(agentId) ?? "";
}

/** Valid live models, or null when there are none to trust. An
 * account-scoped list must be complete to make eligibility claims. */
function liveModels(initialize: InitializeResponse | null): { models: ModelOption[]; accountScoped: boolean } | null {
  const meta = initialize?._meta as { models?: unknown; modelsAccountScoped?: unknown } | null | undefined;
  if (!meta || !Array.isArray(meta.models)) return null;
  const valid = meta.models.map(coerceOption).filter((m): m is ModelOption => m !== null);
  if (meta.modelsAccountScoped === true) {
    return valid.length === meta.models.length ? { models: valid, accountScoped: true } : null;
  }
  return valid.length > 0 ? { models: valid, accountScoped: false } : null;
}

function overlay(curated: ModelOption, live: ModelOption): ModelOption {
  const out: ModelOption = { ...curated };
  for (const field of LIVE_OVERLAYABLE) {
    if (live[field] !== undefined) (out as unknown as Record<string, unknown>)[field] = live[field];
  }
  return out;
}

/** The models the picker shows for an agent (renderer `modelsForAgent`). */
export function modelsForAgent(agentId: string | null, initialize: InitializeResponse | null): ModelOption[] {
  const family = familyOf(agentId);
  const curated = CURATED[family] ?? [];
  const live = liveModels(initialize);
  if (curated.length === 0) return live?.models ?? [];
  if (!live) return curated.filter((m) => !m.liveRequired);
  const bySlug = new Map(live.models.map((m) => [normalizeModelSlug(family, m.value), m] as const));
  return curated.flatMap((c) => {
    const match = bySlug.get(normalizeModelSlug(family, c.value));
    if (c.liveRequired && (!match || match.selectable !== true)) return [];
    if (live.accountScoped) return [match ? overlay(c, match) : { ...c, selectable: false }];
    if (match?.selectable === false) return [];
    return [match ? overlay(c, match) : c];
  });
}

/** The user's one global default model (settings `[models] default` and
 * `default_agent`, written by the picker) when this family owns it — the
 * renderer's `effectiveFavoriteModel`. Otherwise the catalog default. */
export function favoriteModelFor(agentId: string | null, userSettings: Record<string, unknown>): string | null {
  const family = familyOf(agentId);
  if (!family) return null;
  const models = userSettings.models as Record<string, unknown> | undefined;
  const agent = typeof models?.default_agent === "string" ? models.default_agent : null;
  const selected = typeof models?.default === "string" ? models.default : null;
  if (agent && selected && familyOf(agent) === family) {
    const curated = (CURATED[family] ?? []).some(
      (m) => m.value === selected || normalizeModelSlug(family, m.value) === normalizeModelSlug(family, selected),
    );
    if (curated) return selected;
  }
  return catalog.defaultFavorites?.[family] ?? null;
}

/** Persisted null-model rows predate the current birth policy; the renderer
 * freezes them to the user's pick or these prior defaults when it loads them
 * (renderer/features/agent/legacy-default-models.ts). */
const LEGACY_DEFAULT_MODELS: Record<string, string> = {
  claude: "claude-opus-5[1m]",
  codex: "gpt-5.6-sol",
  cursor: "composer-2.5",
};

/** What a saved null model means (renderer `legacySelectedModel`). */
export function legacySelectedModel(agentId: string | null, userSettings: Record<string, unknown>): string | null {
  const family = familyOf(agentId);
  const models = userSettings.models as Record<string, unknown> | undefined;
  const agent = typeof models?.default_agent === "string" ? models.default_agent : null;
  const selected = typeof models?.default === "string" ? models.default : null;
  if (agent && selected && familyOf(agent) === family && resolveModelOption(agentId, selected, null)) return selected;
  return LEGACY_DEFAULT_MODELS[family] ?? null;
}

/** The option a saved or requested model id means (renderer
 * `resolveModelOption`); a null model is the user's default for the family. */
function resolveModelOption(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null,
  favorite: string | null = catalog.defaultFavorites?.[familyOf(agentId)] ?? null,
): ModelOption | null {
  const family = familyOf(agentId);
  const list = modelsForAgent(agentId, initialize);
  const find = (id: string) =>
    list.find((m) => m.value === id) ?? list.find((m) => normalizeModelSlug(family, m.value) === normalizeModelSlug(family, id));
  const hidden = (id: string): ModelOption | null => {
    const curated = (CURATED[family] ?? []).find((m) => m.value === id || normalizeModelSlug(family, m.value) === normalizeModelSlug(family, id));
    return curated?.liveRequired ? { ...curated, value: id, selectable: false } : null;
  };
  if (!model) {
    if (favorite) {
      const starred = find(favorite) ?? hidden(favorite);
      if (starred) return starred;
    }
    return list[0] ?? null;
  }
  return find(model) ?? hidden(model);
}

function effortLevelsFor(agentId: string | null, model: string | null, initialize: InitializeResponse | null): string[] {
  const advertised = resolveModelOption(agentId, model, initialize)?.effortLevels;
  if (advertised) return advertised;
  const family = familyOf(agentId);
  if (family === "claude") {
    const m = (model ?? "").toLowerCase();
    if (m.includes("opus") || m.includes("fable")) return CLAUDE_OPUS_LADDER;
    if (m.includes("sonnet")) return CLAUDE_SONNET_LADDER;
    if (m.includes("haiku")) return BASIC_LADDER;
    return CLAUDE_OPUS_LADDER;
  }
  if (family === "codex") return CODEX_LADDER;
  return [];
}

function defaultEffortForLevels(levels: string[]): string {
  if (levels.includes("high")) return "high";
  return levels.reduce<string | null>((top, level) => (top === null || EFFORT_RANK[level]! > EFFORT_RANK[top]! ? level : top), null) ?? "high";
}

function defaultEffortForModel(agentId: string | null, model: string | null, initialize: InitializeResponse | null): string {
  const levels = effortLevelsFor(agentId, model, initialize);
  const initial = resolveModelOption(agentId, model, initialize)?.defaultEffort;
  return initial && levels.includes(initial) ? initial : defaultEffortForLevels(levels);
}

/** The tier a model can actually run (renderer `effectiveEffort`). */
export function effectiveEffort(agentId: string | null, model: string | null, effort: string, initialize: InitializeResponse | null): string {
  const levels = effortLevelsFor(agentId, model, initialize);
  if (levels.length === 0 || levels.includes(effort)) return effort;
  return defaultEffortForModel(agentId, model, initialize);
}

function agentSupportsEffort(agentId: string | null, model: string | null, initialize: InitializeResponse | null): boolean {
  const advertised = resolveModelOption(agentId, model, initialize)?.effortLevels;
  if (advertised) return advertised.length > 0;
  const family = familyOf(agentId);
  return family === "claude" || family === "codex";
}

function agentSupportsFast(agentId: string | null, model: string | null, initialize: InitializeResponse | null): boolean {
  const option = resolveModelOption(agentId, model, initialize);
  if (option && typeof option.supportsFast === "boolean") return option.supportsFast;
  const family = familyOf(agentId);
  const m = (model ?? "").toLowerCase();
  if (family === "claude") return m === "" || m.includes("opus");
  if (family === "codex") return m === "" || m.startsWith("gpt-5");
  return false;
}

/** Chat posture bucket persisted in `chats.permission_mode` (renderer
 * ChatPermissionMode). The exact native id lives in `last_mode_id`. */
const POSTURE_BY_LEVEL: Record<LocalModeLevel, string> = {
  plan: "plan",
  ask: "tool-approval",
  auto: "auto",
  full: "danger",
};
const LEVEL_BY_POSTURE: Record<string, LocalModeLevel> = {
  plan: "plan",
  "plan-only": "plan",
  "tool-approval": "ask",
  ask: "ask",
  auto: "auto",
  "auto-edit": "auto",
  danger: "full",
  full: "full",
};

export interface LocalModelChoice {
  agent: string;
  model: string;
  label: string;
  effortLevels: string[];
  defaultEffort: string | null;
  supportsFast: boolean;
  availability: "available" | "unavailable" | "unknown";
}

/** The picker's list for one agent, with account availability when the
 * provider has reported it. */
export function modelChoicesFor(agentId: string, initialize: InitializeResponse | null): LocalModelChoice[] {
  const family = familyOf(agentId);
  const live = liveModels(initialize);
  const liveSlugs = new Set((live?.models ?? []).map((m) => normalizeModelSlug(family, m.value)));
  return modelsForAgent(agentId, initialize).map((m) => ({
    agent: agentId,
    model: m.value,
    label: m.label,
    effortLevels: effortLevelsFor(agentId, m.value, initialize),
    defaultEffort: defaultEffortForModel(agentId, m.value, initialize),
    supportsFast: agentSupportsFast(agentId, m.value, initialize),
    availability: m.selectable === false ? "unavailable" : liveSlugs.has(normalizeModelSlug(family, m.value)) ? "available" : "unknown",
  }));
}

/** A chat's effective native mode id and level. */
export function chatModeOf(chat: Pick<ChatRow, "agentId" | "lastModeId" | "permissionMode">, liveModeId?: string | null): {
  modeId: string | null;
  level: LocalModeLevel | null;
} {
  const family = localAgentFamily(chat.agentId);
  const known = family ? LOCAL_MODE_LEVEL_BY_FAMILY[family] ?? {} : {};
  for (const candidate of [liveModeId, chat.lastModeId]) {
    if (candidate && known[candidate]) return { modeId: candidate, level: known[candidate]! };
  }
  const posture = LEVEL_BY_POSTURE[chat.permissionMode];
  if (posture) {
    return { modeId: localModeForLevel(chat.agentId, posture), level: posture };
  }
  return { modeId: null, level: null };
}

export interface LocalRequestedSettings {
  agent?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  mode?: string;
}

export interface LocalResolvedSettings {
  agentId: string;
  model: string | null;
  effort: string;
  fast: boolean;
  modeId: string | null;
  level: LocalModeLevel | null;
  permissionMode: string;
  prePlanModeId: string | null;
  additionalDirectories: string[];
  env: Record<string, string>;
}

export function resolveChildSettings(input: {
  parent: ChatRow;
  parentLiveModeId: string | null;
  requested: LocalRequestedSettings;
  sameFolder: boolean;
  initialize: (agentId: string) => InitializeResponse | null;
  isKnownAgent: (agentId: string) => boolean;
  userSettings: Record<string, unknown>;
}): LocalResolvedSettings {
  const parentAgent = input.parent.agentId ?? "";
  const agentId = input.requested.agent ?? parentAgent;
  if (!agentId || !input.isKnownAgent(agentId)) {
    throw new LocalOrchestrationError("UNAVAILABLE", `Agent "${agentId || "(none)"}" is not available in Zeros.`, {
      details: { agent: agentId },
    });
  }
  const sameFamily = localAgentFamily(agentId) === localAgentFamily(parentAgent);
  const initialize = input.initialize(agentId);

  // Model: explicit (validated against the picker), else the creator's exact
  // id (same family, even one the catalog does not name), else the family
  // default. A null model means "the agent's default", as on the creator's
  // row; the env still names the default the picker shows.
  let modelId: string | null;
  if (input.requested.model) {
    const requested = resolveModelOption(agentId, input.requested.model, initialize);
    if (!requested) {
      throw new LocalOrchestrationError(
        "USAGE",
        `Model "${input.requested.model}" is not offered for ${agentId}. Run \`zeros local models --agent ${agentId}\`.`,
        { details: { valid: modelsForAgent(agentId, initialize).filter((m) => m.selectable !== false).map((m) => m.value) } },
      );
    }
    if (requested.selectable === false) {
      throw new LocalOrchestrationError("UNAVAILABLE", `${requested.label} is not available for this account.`);
    }
    modelId = requested.value;
  } else if (sameFamily) {
    modelId = input.parent.model;
  } else {
    modelId = resolveModelOption(agentId, null, initialize, favoriteModelFor(agentId, input.userSettings))?.value ?? null;
  }
  // A null model on a saved row is a legacy row: name the model the renderer
  // freezes it to when the tab loads, so the child runs what its tab shows.
  const envModel = modelId ?? legacySelectedModel(agentId, input.userSettings) ??
    resolveModelOption(agentId, null, initialize, favoriteModelFor(agentId, input.userSettings))?.value ?? null;
  const sameModel = sameFamily && modelId === input.parent.model;
  const label = resolveModelOption(agentId, envModel, initialize)?.label ?? envModel ?? agentId;

  // Effort: explicit (validated), else the creator's for the same model as the
  // picker would run it, else the model default.
  const ladder = effortLevelsFor(agentId, envModel, initialize);
  let effort: string;
  if (input.requested.effort) {
    if (ladder.length > 0 && !ladder.includes(input.requested.effort)) {
      throw new LocalOrchestrationError(
        "USAGE",
        `Effort "${input.requested.effort}" is not offered for ${label}. Valid: ${ladder.join(", ")}.`,
        { details: { valid: ladder } },
      );
    }
    effort = input.requested.effort;
  } else if (sameModel && input.parent.effort) {
    effort = input.parent.effort in EFFORT_RANK ? effectiveEffort(agentId, envModel, input.parent.effort, initialize) : input.parent.effort;
  } else {
    effort = defaultEffortForModel(agentId, envModel, initialize);
  }

  // Fast: explicit, else the creator's for the same model.
  const supportsFast = agentSupportsFast(agentId, envModel, initialize);
  if (input.requested.fast === true && !supportsFast) {
    throw new LocalOrchestrationError("USAGE", `${label} has no Fast mode.`);
  }
  const fast = (input.requested.fast ?? (sameModel ? input.parent.fast : false)) && supportsFast;

  // Permission mode: never above the creator's level.
  const parentMode = chatModeOf(input.parent, input.parentLiveModeId);
  const parentLevel = parentMode.level;
  let modeId: string | null;
  let prePlanModeId: string | null = null;
  if (input.requested.mode) {
    const level = localModeLevel(agentId, input.requested.mode);
    if (!level) {
      const family = localAgentFamily(agentId);
      const valid = Object.keys((family && LOCAL_MODE_LEVEL_BY_FAMILY[family]) || {});
      throw new LocalOrchestrationError("USAGE", `Mode "${input.requested.mode}" is not a ${agentId} mode. Valid: ${valid.join(", ")}.`, {
        details: { valid },
      });
    }
    if (parentLevel && localModeRank(level) > localModeRank(parentLevel)) {
      throw new LocalOrchestrationError(
        "MODE_FORBIDS",
        `A new chat cannot have a higher permission level than yours (${parentLevel}). The user can raise it in that chat.`,
        { details: { yourLevel: parentLevel, requested: level } },
      );
    }
    modeId = input.requested.mode;
  } else if (sameFamily && parentMode.modeId) {
    modeId = parentMode.modeId;
    prePlanModeId = input.parent.prePlanModeId ?? null;
  } else {
    modeId = parentLevel ? localModeForLevel(agentId, parentLevel) : null;
  }
  const level = modeId ? localModeLevel(agentId, modeId) : null;

  const additionalDirectories = input.sameFolder && sameFamily ? [...(input.parent.additionalDirectories ?? [])] : [];

  const env: Record<string, string> = {};
  const modelEnvVar =
    (initialize?._meta as { modelEnvVar?: unknown } | null | undefined)?.modelEnvVar ??
    catalog.modelEnvVars?.[localAgentFamily(agentId) ?? ""];
  if (typeof modelEnvVar === "string" && envModel) env[modelEnvVar] = envModel;
  const family = localAgentFamily(agentId);
  if (!(family === "claude" || family === "codex" || family === "cursor") || agentSupportsEffort(agentId, envModel, initialize)) {
    env.ZEROS_THINKING_EFFORT = effort in EFFORT_RANK ? effectiveEffort(agentId, envModel, effort, initialize) : effort;
  }
  if (fast) env.ZEROS_FAST_MODE = "1";
  if (additionalDirectories.length > 0) env.ZEROS_ADDITIONAL_DIRS = JSON.stringify(additionalDirectories);
  if (modeId) env.ZEROS_PERMISSION_MODE = modeId;
  if (localAgentFamily(agentId) === "claude") {
    const claude = claudeSettings(input.userSettings);
    env.ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES = String(claude.idleTimeoutMinutes);
    env.ZEROS_CLAUDE_AUTO_MEMORY = claude.autoMemory ? "1" : "0";
    env.ZEROS_CLAUDE_IDLE_COMPACTION = claude.idleCompaction ? "1" : "0";
  }

  return {
    agentId,
    model: modelId,
    effort,
    fast,
    modeId,
    level,
    permissionMode: level ? POSTURE_BY_LEVEL[level] : input.parent.permissionMode,
    prePlanModeId,
    additionalDirectories,
    env,
  };
}

const CLAUDE_IDLE_TIMEOUTS = new Set([30, 60, 120, 300]);

/** The renderer's Claude lifetime defaults (reliability-settings.ts): 30 min,
 * auto memory on, idle compaction off — read from the user's settings.toml. */
export function claudeSettings(effective: Record<string, unknown>): {
  idleTimeoutMinutes: number;
  autoMemory: boolean;
  idleCompaction: boolean;
} {
  const models = effective.models as Record<string, unknown> | undefined;
  const claude = (models?.claude_code ?? {}) as Record<string, unknown>;
  const timeout = claude.idle_timeout_minutes;
  return {
    idleTimeoutMinutes: typeof timeout === "number" && CLAUDE_IDLE_TIMEOUTS.has(timeout) ? timeout : 30,
    autoMemory: claude.auto_memory_enabled !== false,
    idleCompaction: claude.idle_compaction_enabled === true,
  };
}
