// ──────────────────────────────────────────────────────────
// Model catalog — CURATED display + live capability overlay
// ──────────────────────────────────────────────────────────
//
// The composer model picker shows a CURATED list we control: the per-family
// `families` map in `catalogs/models-v1.json` (a plain bundled file — NO remote
// fetch / cache / publish system; those were retired). You decide exactly which
// models appear, in what order, with what labels.
//
// Live agent discovery (Claude `query.supportedModels()`, Codex `model/list`,
// Cursor's SDK model list, surfaced via `initialize._meta.models`) does NOT
// drive the displayed list — it only OVERLAYS each curated model's CAPABILITIES
// (effort ladder + fast support) when we can match it, and powers
// `pnpm models:verify`. So the picker is complete, stable, and controllable,
// while per-model effort/fast stay accurate to what the live agent supports.
//
// Resolution per agent family:
//   1. CURATED_FAMILIES[family]                         (drives DISPLAY)
//      └─ overlaid with live _meta.models capabilities  (effort + fast)
//   2. If a family has no curated entries → fall back to whatever the agent
//      advertised live (so an unmapped/3rd-party agent still shows something).
//
// Adding a model: run `pnpm models:list <agent>` to copy the exact real id,
// add it to `catalogs/models-v1.json`, then `pnpm models:verify`.
// ──────────────────────────────────────────────────────────

import type { InitializeResponse, SessionMode } from "../bridge/agent-events";
import type {
  ChatThread,
  ChatEffort,
  ChatPermissionMode,
} from "../store/store";
import {
  getClaudeBudgetCapUsd,
  getClaudeFallbackModel,
} from "./reliability-settings";
import catalogJson from "../../../catalogs/models-v1.json";

export type ModelOption = {
  value: string;
  label: string;
  badge?: string;
  /** Per-model reasoning-effort ladder (ordered low→high). Authoritative for
   *  the EffortPill. Live discovery overlays this onto the curated entry when a
   *  match is found; otherwise the curated value stands. */
  effortLevels?: ChatEffort[];
  /** Whether this model supports Fast mode (drives the FastPill). */
  supportsFast?: boolean;
  /** Minimum agent CLI version this model needs (e.g. Fable 5 → "2.1.170").
   *  Gated by {@link modelsForAgent} against the agent-advertised
   *  `_meta.cliVersion` so a model never silently downgrades on an older CLI. */
  minCliVersion?: string;
};

// ── Coercion helpers (declared before the JSON-derived constants below, which
//    run them at module load) ───────────────────────────────

const VALID_EFFORTS: readonly ChatEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
];

function isModelOption(x: unknown): x is { value: string; label: string } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.value === "string" && typeof o.label === "string";
}

/** Coerce a raw catalog / `_meta.models[]` entry into a {@link ModelOption},
 *  validating the advertised effort ladder + fast flag. Returns null for
 *  malformed entries (dropped). Effort levels arrive as plain strings; we filter
 *  to known ChatEfforts. */
function coerceModelOption(x: unknown): ModelOption | null {
  if (!isModelOption(x)) return null;
  const o = x as Record<string, unknown>;
  const out: ModelOption = {
    value: o.value as string,
    label: o.label as string,
  };
  if (typeof o.badge === "string") out.badge = o.badge;
  if (Array.isArray(o.effortLevels)) {
    out.effortLevels = o.effortLevels.filter(
      (e): e is ChatEffort =>
        typeof e === "string" &&
        (VALID_EFFORTS as readonly string[]).includes(e),
    );
  }
  if (typeof o.supportsFast === "boolean") out.supportsFast = o.supportsFast;
  if (typeof o.minCliVersion === "string") out.minCliVersion = o.minCliVersion;
  return out;
}

// ── Curated catalog (bundled JSON) ────────────────────────

interface CuratedCatalog {
  families: Record<string, unknown[]>;
  modelEnvVars: Record<string, string>;
  defaultFavorites?: Record<string, string>;
  aliases?: Record<string, Record<string, string>>;
}
const catalog = catalogJson as unknown as CuratedCatalog;

/** The curated per-family display list (the source of truth for WHICH models
 *  the picker shows). Coerced + validated from the bundled JSON at load. */
const CURATED_FAMILIES: Record<string, ModelOption[]> = Object.fromEntries(
  Object.entries(catalog.families).map(([fam, list]) => [
    fam,
    (Array.isArray(list) ? list : [])
      .map(coerceModelOption)
      .filter((m): m is ModelOption => m !== null),
  ]),
);

/** Env var each family's chosen model is written to, used when the agent's
 *  initialize hasn't advertised `_meta.modelEnvVar`. */
const MODEL_ENV_VARS: Record<string, string> = catalog.modelEnvVars ?? {};

/** Per-family alias map (short/legacy id → canonical curated slug), used by
 *  {@link normalizeModelSlug} to match a picked/persisted/discovered id back to
 *  its curated entry. */
const ALIASES: Record<string, Record<string, string>> = catalog.aliases ?? {};

/** Per-family FALLBACK favorite (2026-07 spec): the model a new chat opens on
 *  when the user hasn't starred one — claude → Opus 4.8, codex → 5.6 Sol,
 *  cursor → Composer 2.5. Curated in models-v1.json so the catalog stays the
 *  single source of truth; validated against family membership here (a typo'd
 *  id degrades to the family's first curated model instead of a dead value). */
const DEFAULT_FAVORITES: Record<string, string> =
  catalog.defaultFavorites ?? {};

/** The model value `family` falls back to when no user favorite is set: the
 *  curated `defaultFavorites` entry when it names a real curated model, else
 *  the family's first curated model, else null (unknown family). */
export function defaultFavoriteModelFor(family: string): string | null {
  const list = CURATED_FAMILIES[family] ?? [];
  const pinned = DEFAULT_FAVORITES[family];
  if (pinned && list.some((m) => m.value === pinned)) return pinned;
  return list[0]?.value ?? null;
}

/** Prefix-match agent id → family. Wrapper variants (claude,
 *  claude-code, @anthropic-ai/claude-code, etc.) all resolve here. */
export function agentFamily(agentId: string | null): string {
  if (!agentId) return "";
  const id = agentId.toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("codex") || id.includes("openai")) return "codex";
  if (id.includes("cursor")) return "cursor";
  return "";
}

/** The curated family that LISTS `modelValue`, or "" if none does. Unlike
 *  agentFamily() — which substring-matches an AGENT id — this matches a MODEL
 *  value against catalog membership, so a model whose value embeds another
 *  family's name (e.g. Cursor's `claude-opus-4-8-thinking-high` or `gpt-5.3-codex`)
 *  resolves to its real owner ("cursor"), not "claude"/"codex". A value shared
 *  across families (e.g. `gpt-5.3-codex`, under both codex and cursor) resolves
 *  to the FIRST curated family that lists it — callers that need an exact owner
 *  must carry the agent id, not the bare model value. */
export function familyForModelValue(
  modelValue: string | null | undefined,
): string {
  if (!modelValue) return "";
  for (const fam of Object.keys(CURATED_FAMILIES)) {
    if (CURATED_FAMILIES[fam].some((m) => m.value === modelValue)) return fam;
  }
  return "";
}

/** Normalize a model id to its canonical curated slug, so a picked / persisted
 *  / live-discovered id matches the right curated entry across version drift:
 *    1. strip a context-window suffix (`[1m]`) → base model,
 *    2. strip a trailing dated snapshot (`-YYYYMMDD`) → dateless id,
 *    3. resolve a known alias (`opus` → `claude-opus-4-8`).
 *  Used for the capability overlay (curated ↔ live) and {@link resolveModelOption}. */
export function normalizeModelSlug(family: string, id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]\s*$/, ""); // drop "[1m]"-style context suffix
  s = s.replace(/-\d{8}$/, ""); // drop trailing dated snapshot
  const famAliases = ALIASES[family];
  if (famAliases && typeof famAliases[s] === "string") return famAliases[s];
  return s;
}

/** Agents that honour a discrete reasoning-effort level.
 *  - Claude: the Agent SDK `effort` option (low|medium|high|xhigh|max) +
 *    the `ultracode` setting.
 *  - Codex: reads ZEROS_THINKING_EFFORT → `turn/start.effort`.
 *  Cursor exposes no effort knob, so the effort toggle is hidden for it
 *  rather than writing a value nothing consumes. */
export function agentSupportsEffort(
  agentId: string | null,
  model: string | null = null,
  initialize: InitializeResponse | null = null,
): boolean {
  // Prefer the resolved model's ladder when present (an empty ladder means
  // "this model has no effort knob").
  const advertised = resolveModelOption(
    agentId,
    model,
    initialize,
  )?.effortLevels;
  if (advertised) return advertised.length > 0;
  const fam = agentFamily(agentId);
  return fam === "claude" || fam === "codex";
}

/** Heuristic effort ladders — the FALLBACK when a model has no resolved
 *  per-model `effortLevels` (i.e. it's neither curated nor advertised). Verified
 *  against code.claude.com/model-config (2026-06): Opus/Fable = low…max(+xhigh);
 *  Sonnet 4.6 = low,medium,high,max (NO xhigh); Haiku = low…high; Codex =
 *  low…xhigh. `ultracode` is our setting-tier on top of xhigh. */
const CLAUDE_OPUS_LADDER: ChatEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
];
const CLAUDE_SONNET_LADDER: ChatEffort[] = ["low", "medium", "high", "max"];
const CODEX_LADDER: ChatEffort[] = ["low", "medium", "high", "xhigh"];
const BASIC_LADDER: ChatEffort[] = ["low", "medium", "high"];

/** DEFAULT display labels for each effort level — the fallback when a family
 *  doesn't override a level in EFFORT_LABELS_BY_FAMILY. Prefer {@link effortLabel}
 *  (which is family-aware) over indexing this directly. */
export const EFFORT_LABELS: Record<ChatEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultracode: "Ultra Code",
};

/** Per-family effort-label OVERRIDES (2026-07 spec). Each agent brands its
 *  reasoning tiers differently: Codex reads "Light … Extra High … Max …
 *  Ultra" (2026-07-10 follow-up: "Max" sits between "Extra High" and
 *  "Ultra", so max keeps its default label and the internal ultracode
 *  level carries "Ultra"), Claude "Low … Extra … Max … Ultracode". Only
 *  the levels that DIFFER from {@link EFFORT_LABELS} are listed; unlisted
 *  levels fall back to the default. Cursor (Grok low/medium/high) uses the
 *  defaults, so it needs no entry. */
const EFFORT_LABELS_BY_FAMILY: Record<
  string,
  Partial<Record<ChatEffort, string>>
> = {
  claude: { xhigh: "Extra", max: "Max", ultracode: "Ultracode" },
  codex: { low: "Light", xhigh: "Extra High", ultracode: "Ultra" },
};

/** Rank of each effort tier (ladder position, low→high). Used by
 *  {@link nearestEffort} to clamp a carried effort DOWN to what a target
 *  model actually offers. */
const EFFORT_RANK: Record<ChatEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultracode: 5,
};

/** The closest effort a target model's ladder offers to a REQUESTED level —
 *  the carry-over rule when switching/redirecting models (2026-07-10 spec):
 *  the exact level when the ladder has it, else the HIGHEST ladder level
 *  BELOW it (max → high on Grok 4.5's low/medium/high; max → xhigh on 5.5),
 *  else the ladder floor (requested below everything). Null for an empty
 *  ladder (the model has no effort knob — nothing to carry to). */
export function nearestEffort(
  ladder: ChatEffort[],
  effort: ChatEffort,
): ChatEffort | null {
  if (ladder.length === 0) return null;
  if (ladder.includes(effort)) return effort;
  const want = EFFORT_RANK[effort] ?? EFFORT_RANK.high;
  let best: ChatEffort | null = null;
  for (const lvl of ladder) {
    const r = EFFORT_RANK[lvl];
    if (r <= want && (best === null || r > EFFORT_RANK[best])) best = lvl;
  }
  return best ?? ladder[0];
}

/** The display label for an effort level in the given agent's vocabulary. Used
 *  by the composer EffortPill + the Settings → Models default-effort dropdown so
 *  both surfaces read identically per family (e.g. Codex "Ultra", Claude
 *  "Ultracode" for the same internal level). Falls back to the default label. */
export function effortLabel(
  agentId: string | null,
  effort: ChatEffort,
): string {
  const fam = agentFamily(agentId);
  return (
    EFFORT_LABELS_BY_FAMILY[fam]?.[effort] ?? EFFORT_LABELS[effort] ?? effort
  );
}

export function effortLevelsFor(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null = null,
): ChatEffort[] {
  // Prefer the resolved (curated, capability-overlaid) per-model ladder. An
  // advertised array — even empty ("no effort knob") — is authoritative; only
  // an absent advertisement (undefined) falls through to the family heuristic.
  const advertised = resolveModelOption(
    agentId,
    model,
    initialize,
  )?.effortLevels;
  if (advertised) return advertised;
  const fam = agentFamily(agentId);
  if (fam === "claude") {
    const m = (model ?? "").toLowerCase();
    if (m.includes("opus") || m.includes("fable")) return CLAUDE_OPUS_LADDER;
    if (m.includes("sonnet")) return CLAUDE_SONNET_LADDER;
    if (m.includes("haiku")) return BASIC_LADDER;
    // Unknown/default Claude model (null = the agent's default, usually Opus):
    // expose the full ladder so the highest tiers aren't hidden.
    return CLAUDE_OPUS_LADDER;
  }
  if (fam === "codex") return CODEX_LADDER;
  return [];
}

/** Whether the agent+model supports Fast mode (lower-latency inference at
 *  higher token cost). Advertised per-model via the resolved option's
 *  `supportsFast` when present; otherwise the family heuristic: Claude Opus
 *  only, Codex GPT-5.x. When the model is null (agent default) we optimistically
 *  allow it for Claude/Codex — the agent silently no-ops if unsupported. */
export function agentSupportsFast(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null = null,
): boolean {
  const opt = resolveModelOption(agentId, model, initialize);
  if (opt && typeof opt.supportsFast === "boolean") return opt.supportsFast;
  const fam = agentFamily(agentId);
  const m = (model ?? "").toLowerCase();
  if (fam === "claude") return m === "" || m.includes("opus");
  if (fam === "codex") return m === "" || m.startsWith("gpt-5");
  return false;
}

/** The label shown in the model picker. Drops a redundant brand prefix (the
 *  agent is already implied by the dropdown heading / composer context) and
 *  normalizes a "(1M)"-style context suffix to a bare "1M". Examples (claude
 *  family): "Claude Opus 4.8 (1M)" → "Opus 4.8 1M"; "Claude Sonnet 4.6" →
 *  "Sonnet 4.6". Other families keep their labels ("GPT-5.5"); the brand is
 *  only stripped for the claude family, so e.g. Cursor's "Claude Opus 4.8"
 *  (Cursor running a Claude model) keeps its brand. */
export function displayModelLabel(
  agentId: string | null,
  label: string,
): string {
  let out = label;
  if (agentFamily(agentId) === "claude") out = out.replace(/^claude\s+/i, "");
  out = out.replace(
    /\s*\((\d+\s*[MK])\)/i,
    (_m, g) => ` ${g.replace(/\s+/g, "")}`,
  );
  return out.trim();
}

// ── Permission posture ⇆ native agent mode ───────────────
//
// The composer's "Permissions" menu offers four postures — Plan / Auto / Tool
// approval / Danger. Each maps to a CONCRETE native mode PER AGENT, by id, so we
// never guess from prose. `auto` is the safe default (Claude's classifier,
// Codex's on-failure sandbox); `danger` is the explicit no-checks escape hatch.
// Cursor has only plan/agent, so every execute-posture collapses to "agent".

/** posture → native mode id, keyed by agent family. */
const NATIVE_MODE_BY_POSTURE: Record<
  string,
  Partial<Record<ChatPermissionMode, string>>
> = {
  claude: {
    plan: "plan",
    auto: "auto",
    "tool-approval": "default",
    danger: "bypass",
  },
  codex: {
    plan: "read-only",
    auto: "auto-edit",
    "tool-approval": "ask",
    danger: "full-access",
  },
  cursor: {
    plan: "plan",
    auto: "auto",
    // Cursor has no per-tool ask; the classifier-gated Auto is the nearest.
    "tool-approval": "auto",
    danger: "agent",
  },
};

/** native mode id → posture, keyed by family (reverse of the above; Claude's
 *  accept-edits and auto both fold into "auto"). */
const POSTURE_BY_NATIVE: Record<string, Record<string, ChatPermissionMode>> = {
  claude: {
    plan: "plan",
    default: "tool-approval",
    "accept-edits": "auto",
    auto: "auto",
    bypass: "danger",
  },
  codex: {
    "read-only": "plan",
    ask: "tool-approval",
    "auto-edit": "auto",
    "full-access": "danger",
  },
  cursor: { plan: "plan", auto: "auto", agent: "danger" },
};

/** Resolve a posture to the agent's native {@link SessionMode}, or null when the
 *  agent doesn't advertise a matching mode (the caller then keeps the current
 *  mode). Used at session bind to apply the chat's persisted posture, and by the
 *  composer to translate a menu pick into a `session/set_mode` call. */
export function agentModeForPermission(
  permission: ChatPermissionMode,
  availableModes: SessionMode[],
  agentId?: string | null,
): SessionMode | null {
  const fam = agentFamily(agentId ?? null);
  const targetId = fam ? NATIVE_MODE_BY_POSTURE[fam]?.[permission] : undefined;
  if (!targetId) return null;
  return availableModes.find((m) => m.id === targetId) ?? null;
}

/** Reverse of {@link agentModeForPermission}: classify a native mode id into a
 *  posture bucket, so an in-session mode change (or a restored `lastModeId`)
 *  shows the right ✓ in the Permissions menu and persists a meaningful posture.
 *  Falls back to id-shape heuristics for a mode we don't explicitly map (an
 *  adapter renaming/adding one), defaulting to the safe "auto". */
export function permissionForAgentMode(
  modeId: string,
  agentId?: string | null,
): ChatPermissionMode {
  const fam = agentFamily(agentId ?? null);
  const mapped = fam ? POSTURE_BY_NATIVE[fam]?.[modeId] : undefined;
  if (mapped) return mapped;
  if (/plan|read.?only/i.test(modeId)) return "plan";
  if (/bypass|danger|yolo|full|skip|unsafe/i.test(modeId)) return "danger";
  if (/accept|auto/i.test(modeId)) return "auto";
  if (/^ask$|default|approval/i.test(modeId)) return "tool-approval";
  return "auto";
}

/** posture → this family's native mode id, WITHOUT needing the live
 *  `availableModes` (unlike {@link agentModeForPermission}). Used pre-session by
 *  the new-workspace dispatcher to seed a LOSSLESS native modeId from the born
 *  posture, so a dispatcher pick of e.g. Claude "Accept Edits" is stamped as
 *  lastModeId="accept-edits" (not collapsed to "auto" at bind). Returns null for
 *  a family/posture with no mapping. */
export function nativeModeIdForPosture(
  agentId: string | null,
  permission: ChatPermissionMode,
): string | null {
  const fam = agentFamily(agentId);
  return NATIVE_MODE_BY_POSTURE[fam]?.[permission] ?? null;
}

// ── Native permission modes cycled by the composer permission toggle ──
//
// The toggle (composer-pills PermissionToggle) cycles each agent's REAL native
// modes (by id), relabelled to the 2026-07 spec vocabulary — NOT the internal
// 4-posture bucket. This lets modes that share one posture bucket (Claude
// accept-edits AND auto both bucket to "auto") be picked DISTINCTLY, and each
// pick round-trips losslessly via chat.lastModeId. Selecting a mode calls the
// live session's setMode(id) and persists lastModeId=id (+ its posture bucket
// for env carriage / pre-session). Because the ids are STATIC per family, the
// toggle renders identically before or after the session binds (no dependency
// on advertised availableModes).
//
//   Claude: Manual(default) · Accept Edits · Plan · Auto · Bypass
//           (Haiku drops Auto — its classifier isn't available, so Auto would
//            silently behave like Accept Edits; offering it is misleading.)
//   Codex:  Ask for approval(ask) · Approve for me(auto-edit) · Full access
//           (read-only is intentionally omitted — the spec wants exactly these
//            three modes for every Codex model.)
//   Cursor: Ask(plan) · Auto(auto) · Full access(agent) — sdk mode plan|agent
//           paired with the create-time autoReview flag (Auto = agent+autoReview).

/** family → native mode id → user-facing label (the vocabulary the menu shows). */
const PERMISSION_MODE_LABELS: Record<string, Record<string, string>> = {
  claude: {
    default: "Manual",
    "accept-edits": "Accept Edits",
    plan: "Plan",
    auto: "Auto",
    bypass: "Bypass",
  },
  codex: {
    ask: "Ask for approval",
    "auto-edit": "Approve for me",
    "full-access": "Full access",
  },
  cursor: {
    plan: "Ask",
    auto: "Auto",
    agent: "Full access",
  },
};

/** family → the native mode ids to show, in display order (spec order). */
const PERMISSION_MODE_ORDER: Record<string, string[]> = {
  claude: ["default", "accept-edits", "plan", "auto", "bypass"],
  codex: ["ask", "auto-edit", "full-access"],
  cursor: ["plan", "auto", "agent"],
};

export type PermissionMenuItem = { modeId: string; label: string };

/** The native permission modes the composer permission toggle cycles through
 *  for this agent+model, each with its user-facing label, in display order.
 *  Per-model filtering: Claude Haiku drops "auto" (no classifier). Returns []
 *  for a family we don't model modes for (the toggle then hides itself). */
export function permissionMenuItems(
  agentId: string | null,
  model: string | null = null,
): PermissionMenuItem[] {
  const fam = agentFamily(agentId);
  const order = PERMISSION_MODE_ORDER[fam];
  const labels = PERMISSION_MODE_LABELS[fam];
  if (!order || !labels) return [];
  const m = (model ?? "").toLowerCase();
  const dropAuto = fam === "claude" && m.includes("haiku");
  return order
    .filter((id) => !(dropAuto && id === "auto"))
    .map((id) => ({ modeId: id, label: labels[id] ?? id }));
}

/** Whether the composer's permission toggle should render for this agent+model
 *  (i.e. we have a native-mode vocabulary for it). Now true for Cursor too
 *  (Ask/Edit), where it used to be Claude/Codex only. */
export function agentHasPermissionMenu(
  agentId: string | null,
  model: string | null = null,
): boolean {
  return permissionMenuItems(agentId, model).length > 0;
}

// The native modes where the agent PROPOSES instead of acting — Claude's Plan,
// Codex's Ask for approval (its read-only twin included for persisted chats),
// Cursor's Ask. 2026-07-10 spec: these are the modes that draw the dashed
// composer frame (and the "map" icon on the permission toggle).
const GUARDED_PERMISSION_MODES: Record<string, string[]> = {
  claude: ["plan"],
  codex: ["ask", "read-only"],
  cursor: ["plan"],
};

/** Whether the composer should draw its dashed "guarded" frame for this
 *  agent+mode — the modes where the agent asks/plans before acting. */
export function permissionModeShowsFrame(
  agentId: string | null,
  modeId: string | null,
): boolean {
  if (!modeId) return false;
  return (
    GUARDED_PERMISSION_MODES[agentFamily(agentId)]?.includes(modeId) ?? false
  );
}

/** Coerce a native permission-mode id to one the given model's menu actually
 *  OFFERS, for marking the active (✓) row. When the mode is still valid it's
 *  returned unchanged; when it isn't — e.g. an "auto" chat whose model is
 *  switched to Claude Haiku, whose menu drops "auto" (no classifier) — it's
 *  coerced so the Permissions menu never ends up with NO active row (the user
 *  can't tell what mode they're in). "auto" already behaves as "accept-edits" on
 *  a classifier-less model (see CLAUDE_MODES), so coercing to it is TRUTHFUL, not
 *  a silent change: the persisted mode is left alone, so switching back to a
 *  model that supports "auto" restores it. Prefers "accept-edits", else the
 *  menu's first entry. A null/unset mode, or a family with no menu, passes
 *  through unchanged. */
export function coerceModeIdForModel(
  agentId: string | null,
  model: string | null,
  modeId: string | null,
): string | null {
  if (!modeId) return modeId;
  const items = permissionMenuItems(agentId, model);
  if (items.length === 0) return modeId;
  if (items.some((i) => i.modeId === modeId)) return modeId;
  return (items.find((i) => i.modeId === "accept-edits") ?? items[0]).modeId;
}

// A native agent's permission modes, mirrored on the renderer for the
// PRE-SESSION window — a brand-new chat that's still warming, or one whose
// bind failed (no folder). Until the engine advertises `availableModes`, the
// "+" → Permissions menu would otherwise fall back to the GENERIC local posture
// list (Full Access / Auto Edit / Ask First / Plan Only), which has no Bypass
// and reads like Codex's vocabulary — confusing on a Claude chat. Returning the
// agent's REAL modes here surfaces e.g. Claude's Bypass immediately. Once the
// session binds, the engine's live modes (same ids) replace these, so a pick
// made pre-bind reconciles by id (reconcilePermissionModeAtBind + lastModeId).
// Keep CLAUDE_MODES byte-for-byte in sync with claude-sdk/adapter.ts `MODES`.
const CLAUDE_MODES: SessionMode[] = [
  { id: "default", name: "Default", description: "Ask before edits." },
  { id: "plan", name: "Plan", description: "Design without executing." },
  {
    id: "accept-edits",
    name: "Accept Edits",
    description: "Auto-approve file edits.",
  },
  {
    id: "auto",
    name: "Auto",
    description:
      "A model classifier approves or denies each permission prompt. Models without the classifier (e.g. Haiku) fall back to Accept Edits.",
  },
  {
    id: "bypass",
    name: "Bypass",
    description: "Auto-approve EVERYTHING. Disables all permission checks.",
  },
];

// Cursor's three Zeros modes (sdk mode plan|agent × create-time autoReview).
// Mirror them for the pre-session window so a reopened Cursor chat shows its
// mode toggle IMMEDIATELY from persisted state — before the SDK re-advertises
// `availableModes` (which otherwise only happened after the user switched chats
// and back). Keep in sync with cursor-sdk/adapter.ts CURSOR_SDK_MODES.
const CURSOR_MODES: SessionMode[] = [
  { id: "plan", name: "Ask", description: "Designs a plan; makes no edits." },
  {
    id: "auto",
    name: "Auto",
    description:
      "Runs tools, with Cursor's Auto-review classifier gating risky calls (best-effort; needs backend support).",
  },
  {
    id: "agent",
    name: "Full access",
    description: "Runs tools with no gating.",
  },
];

/** The selected agent's statically-known permission modes for the pre-session
 *  window. Claude + Cursor mirror their real modes here so the pre-bind composer
 *  matches the agent's true vocabulary — Claude's Bypass in the "+" menu,
 *  Cursor's Plan toggle. Codex returns [] on purpose: its Plan toggle is covered
 *  by the family shortcut, its "+" menu by the fixed posture list, and its live
 *  modes reconcile by posture at bind. Unknown agents also get []. */
export function staticModesForAgent(agentId: string | null): SessionMode[] {
  switch (agentFamily(agentId)) {
    case "claude":
      return CLAUDE_MODES;
    case "cursor":
      return CURSOR_MODES;
    default:
      return [];
  }
}

// ── Live-discovery extraction (capability overlay source) ──

function extractMetaModels(
  initialize: InitializeResponse | null,
): ModelOption[] | null {
  const meta = initialize?._meta as
    | { models?: unknown; modelEnvVar?: unknown }
    | undefined;
  if (!meta || !Array.isArray(meta.models)) return null;
  const valid = meta.models
    .map(coerceModelOption)
    .filter((m): m is ModelOption => m !== null);
  return valid.length > 0 ? valid : null;
}

/** Resolve the {@link ModelOption} for a picked model value against the (curated,
 *  capability-overlaid) list, preferring an exact match then an alias-normalized
 *  one. Returns null when `model` is null/unset or not found — so callers fall
 *  back to family heuristics. */
function resolveModelOption(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null,
): ModelOption | null {
  const family = agentFamily(agentId);
  const list = modelsForAgent(agentId, initialize);
  // A null/empty model means "the agent's catalog default" — the very model the
  // ModelPill DISPLAYS as active (models[0]) when the user hasn't picked or
  // starred one. Resolve to it so the Effort/Fast capability gates match what the
  // pill shows. Without this a fresh Cursor chat displays "Composer 2.5" but the
  // gates read the cursor family heuristic (false) and HIDE the Fast toggle that
  // Composer 2.5 supports — likewise Codex/Claude defaults read their true
  // curated capabilities instead of an optimistic family guess.
  if (!model) return list[0] ?? null;
  const exact = list.find((m) => m.value === model);
  if (exact) return exact;
  const norm = normalizeModelSlug(family, model);
  return list.find((m) => normalizeModelSlug(family, m.value) === norm) ?? null;
}

// ── Public API ────────────────────────────────────────────

/** Resolve the model list the picker DISPLAYS for the given agent. The curated
 *  catalog drives WHICH models show; live `initialize._meta.models` discovery
 *  only OVERLAYS per-model capabilities (effort ladder + fast). Families with no
 *  curated entries fall back to whatever the agent advertised live.
 *
 *  Note: a model's `minCliVersion` is checked at BUILD time by
 *  `pnpm models:verify` (and the catalog vitest), NOT gated here at runtime — a
 *  runtime gate made a model VANISH the moment you selected it (the version
 *  signal transitions as the session binds), and the SDK is pinned to a CLI that
 *  supports the curated models anyway. */
export function modelsForAgent(
  agentId: string | null,
  initialize: InitializeResponse | null,
): ModelOption[] {
  const family = agentFamily(agentId);
  const curated = CURATED_FAMILIES[family] ?? [];
  const advertised = extractMetaModels(initialize);

  if (curated.length === 0) return advertised ?? [];
  if (!advertised) return curated;

  // Overlay live per-model capabilities (effort + fast) onto the curated
  // entries — but CURATED WINS. Live only FILLS a capability the curated entry
  // OMITS; it never overrides one the curated entry set explicitly. This is what
  // makes the effort/fast toggles deterministic: a model the catalog marks with
  // an empty effort ladder (Haiku) or supportsFast:false (Sonnet 5) can't have a
  // toggle flip on when late live discovery advertises something different. The
  // curated catalog is the source of truth for WHICH models show AND (when set)
  // their capabilities; live discovery is a best-effort fallback for gaps.
  const liveBySlug = new Map<string, ModelOption>();
  for (const m of advertised)
    liveBySlug.set(normalizeModelSlug(family, m.value), m);
  return curated.map((c) => {
    const live = liveBySlug.get(normalizeModelSlug(family, c.value));
    if (!live) return c;
    return {
      ...c,
      ...(c.effortLevels === undefined && live.effortLevels
        ? { effortLevels: live.effortLevels }
        : {}),
      ...(c.supportsFast === undefined && typeof live.supportsFast === "boolean"
        ? { supportsFast: live.supportsFast }
        : {}),
    };
  });
}

/** §3.6 R2/R6 — a WIRE model id's display label ("claude-fable-5-20260203" →
 *  "Fable 5"), falling back to the raw id when the catalog doesn't list it.
 *  `agentId` may be null — a model id substring-matches its own family
 *  (agentFamily("claude-sonnet-5") === "claude"), so the id itself is used as
 *  the owner then. Used by the turn footer's usage popover and the
 *  Model-switched / Turn-stopped transcript cards. */
export function displayNameForModelValue(
  agentId: string | null,
  id: string,
): string {
  if (!id) return id;
  const owner = agentId ?? id;
  const family = agentFamily(owner);
  const norm = normalizeModelSlug(family, id);
  const hit = modelsForAgent(owner, null).find(
    (m) =>
      m.value === id ||
      normalizeModelSlug(family, m.value) === norm ||
      norm.startsWith(normalizeModelSlug(family, m.value)),
  );
  return hit ? displayModelLabel(owner, hit.label) : id;
}

/** Resolve the env var name for a model override. Agent's
 *  `_meta.modelEnvVar` wins when provided; else the curated family default. */
export function modelEnvVarForAgent(
  agentId: string | null,
  initialize: InitializeResponse | null,
): string | undefined {
  const meta = initialize?._meta as { modelEnvVar?: unknown } | undefined;
  if (typeof meta?.modelEnvVar === "string") return meta.modelEnvVar;
  return MODEL_ENV_VARS[agentFamily(agentId)];
}

/** Env var for thinking effort. Zeros convention, not agent spec. */
export const EFFORT_ENV_VAR = "ZEROS_THINKING_EFFORT";

/** Env var carrying the composer's Fast-mode toggle ("1" when on). Zeros
 *  convention. Read by the Claude SDK adapter (→ `fastMode` setting) and the
 *  Codex app-server adapter (→ `service_tier: "fast"`). */
export const FAST_MODE_ENV_VAR = "ZEROS_FAST_MODE";

/** Env var carrying the composer's local permission posture
 *  (full | auto-edit | ask | plan-only). Zeros convention. Mode-advertising
 *  agents are driven live by the PermissionsPill via setMode, so this is
 *  the carriage channel for env-consuming agents plus a durable record of
 *  the pre-session choice the session-start reconcile applies. */
export const PERMISSION_MODE_ENV_VAR = "ZEROS_PERMISSION_MODE";

/** Stable key for "which composer env is this live session actually running",
 *  used BOTH to stamp a session slot (`appliedChatEnvKey`) and to compare
 *  against the chat's current env in sendPrompt's settings-drift reconcile.
 *  One function so the two sites can never drift apart — a stamp computed
 *  differently from the comparison is indistinguishable from a real change and
 *  costs a cold respawn.
 *
 *  Object key order is NOT normalized on purpose: every env here is built by
 *  envForChat, which assigns keys in a fixed order, so JSON.stringify is
 *  already stable between the two callers.
 *
 *  PERMISSION_MODE_ENV_VAR is excluded. The permission posture is applied to a
 *  live session through its own RPC (AGENT_SET_MODE — implemented by all three
 *  adapters, not an optional hook), so a mode change can never be a reason to
 *  rebuild. Leaving it in the key made every Plan-mode toggle look like drift,
 *  and the reconcile then force-respawned COLD on the next send — dropping the
 *  agent's conversation while the transcript stayed on screen. */
export function chatEnvDriftKey(
  env: Record<string, string> | undefined,
): string {
  if (!env) return JSON.stringify({});
  const { [PERMISSION_MODE_ENV_VAR]: _mode, ...rest } = env;
  return JSON.stringify(rest);
}

/** Move an EXISTING `appliedChatEnvKey` stamp onto a new effort, leaving every
 *  other component of the key untouched.
 *
 *  For a PROVIDER-ORIGINATED effort change (Codex raising its own thread to
 *  Ultra, reported back via `current_effort_update`) the running session is
 *  already at the new tier, so persisting it onto the chat must NOT read as
 *  user drift in sendPrompt's reconcile — that respawns COLD (no resume, so
 *  Codex loses the thread). Re-stamping only the effort slot is what keeps a
 *  genuinely-unapplied model/Fast/add-dir change still visible as drift, which
 *  a full `chatEnvDriftKey(envForChat(chat))` re-stamp would silently swallow.
 *
 *  Returns undefined when there is nothing safe to re-stamp: an unstamped slot
 *  (legacy — the reconcile skips those anyway), an unparseable stamp, or one
 *  built without an effort entry. */
export function effortAdoptedEnvKey(
  appliedChatEnvKey: string | undefined,
  effort: string,
): string | undefined {
  if (!appliedChatEnvKey) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(appliedChatEnvKey);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const env = parsed as Record<string, unknown>;
  if (typeof env[EFFORT_ENV_VAR] !== "string") return undefined;
  if (env[EFFORT_ENV_VAR] === effort) return appliedChatEnvKey;
  // In-place assignment keeps envForChat's insertion order, so the result is
  // byte-identical to the key the reconcile will compute for the updated chat.
  env[EFFORT_ENV_VAR] = effort;
  return JSON.stringify(env);
}

/** Env var carrying the composer's extra working directories (Claude `/add-dir`)
 *  as a JSON array of absolute paths. Zeros convention. Read by the Claude SDK
 *  adapter (→ `Options.additionalDirectories`). Only emitted when non-empty so
 *  it never perturbs the respawn key for chats without extra dirs. */
export const ADDITIONAL_DIRS_ENV_VAR = "ZEROS_ADDITIONAL_DIRS";

/** §3.6 R2 — env var carrying the Settings → Models fallback model. Read by
 *  the Claude SDK adapter (→ `Options.fallbackModel`). Only emitted when a
 *  fallback is configured and differs from the chat's own model. */
export const FALLBACK_MODEL_ENV_VAR = "CLAUDE_FALLBACK_MODEL";

/** §3.6 R3 — env var carrying the Settings → Models per-turn budget cap in
 *  USD. Read by the Claude SDK adapter (→ `Options.maxBudgetUsd`). Only
 *  emitted when the cap is on. */
export const BUDGET_CAP_ENV_VAR = "CLAUDE_MAX_BUDGET_USD";

/** Build env map from a chat's composer settings. */
export function envForChatSettings(args: {
  agentId: string | null;
  initialize: InitializeResponse | null;
  model: string | null;
  effort: string;
  fast?: boolean;
  additionalDirectories?: string[];
  permissionMode?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const modelEnv = modelEnvVarForAgent(args.agentId, args.initialize);
  // A null model means "the agent's catalog default". Resolve it to the SAME
  // model the ModelPill displays (models[0] — see ModelPill's activeValue)
  // and SEND it, instead of omitting the env var and letting the agent CLI
  // fall back to its own configured default — which can silently differ
  // from what the pill shows (2026-07-13: pill displayed the catalog default
  // while the engine ran the user's ~/.claude model). Unknown families with
  // no catalog still omit (nothing displayed to contradict).
  const model =
    args.model ??
    modelsForAgent(args.agentId, args.initialize)[0]?.value ??
    null;
  if (model && modelEnv) env[modelEnv] = model;
  env[EFFORT_ENV_VAR] = args.effort;
  // Only emit the fast flag when ON, so an off→off toggle never perturbs the
  // env tuple (the respawn key) for agents that don't support it.
  if (args.fast) env[FAST_MODE_ENV_VAR] = "1";
  // Same: only carry extra dirs when there's at least one, so the empty case
  // never changes the env tuple. JSON encodes any path safely (spaces/commas).
  const dirs = (args.additionalDirectories ?? []).filter(
    (d) => typeof d === "string" && d.trim().length > 0,
  );
  if (dirs.length > 0) env[ADDITIONAL_DIRS_ENV_VAR] = JSON.stringify(dirs);
  if (args.permissionMode) env[PERMISSION_MODE_ENV_VAR] = args.permissionMode;
  // §3.6 R2/R3 — the global reliability knobs ride the same env channel,
  // Claude-only (the other adapters expose no fallback/budget hook). Emitted
  // by omission when off so they never perturb the env tuple for chats that
  // don't use them. A self-fallback is skipped (the adapter guards too).
  if (agentFamily(args.agentId) === "claude") {
    const fallback = getClaudeFallbackModel();
    if (fallback && fallback !== args.model) {
      env[FALLBACK_MODEL_ENV_VAR] = fallback;
    }
    const cap = getClaudeBudgetCapUsd();
    if (cap != null) env[BUDGET_CAP_ENV_VAR] = String(cap);
  }
  return env;
}

/** Convenience wrapper: extract model/effort/permission from a ChatThread. */
export function envForChat(
  chat: ChatThread,
  initialize: InitializeResponse | null = null,
): Record<string, string> {
  return envForChatSettings({
    agentId: chat.agentId,
    initialize,
    model: chat.model,
    effort: chat.effort,
    fast: chat.fast,
    additionalDirectories: chat.additionalDirectories,
    permissionMode: chat.permissionMode,
  });
}
