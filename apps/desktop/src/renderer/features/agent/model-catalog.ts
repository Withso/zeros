// The picker shows the curated list in catalogs/models-v1.json. Live discovery
// (Claude supportedModels, Codex model/list, Cursor's SDK list) overlays
// capabilities and, when account-scoped and complete, eligibility, but never
// names: providers rename the same wire id, so overlayLiveCapabilities keeps
// label off its allowlist. A family with no curated entries falls back to its
// live list. Add a model with `pnpm models:list <agent>`, the catalog, then
// `pnpm models:verify`.

import type {
  InitializeResponse,
  SessionMode,
} from "../../platform/bridge/agent-events";
import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";
import type {
  ChatThread,
  ChatEffort,
  ChatPermissionMode,
} from "../../state/store";
import { getSetting } from "../../platform/settings";
import {
  getClaudeAutoMemoryEnabled,
  getClaudeIdleCompactionEnabled,
  getClaudeIdleTimeoutMinutes,
} from "./reliability-settings";
import catalogJson from "../../../../../../catalogs/models-v1.json";

export type ModelOption = {
  value: string;
  label: string;
  badge?: string;
  description?: string;
  aliases?: string[];
  parameters?: Array<{
    id: string;
    label?: string;
    values: Array<{ value: string; label?: string }>;
  }>;
  variants?: Array<{
    label: string;
    description?: string;
    parameters: Array<{ id: string; value: string }>;
    isDefault?: boolean;
  }>;
  selectable?: boolean;
  /** Curated product rule: render only after exact live discovery says the
   * execution mode can send this model. */
  liveRequired?: boolean;
  /** Per-model reasoning-effort ladder (ordered low→high). Authoritative for
   *  the EffortPill. Exact live discovery overrides the bundled fallback when
   *  present; otherwise the curated value stands. */
  effortLevels?: ChatEffort[];
  /** Initial effort only when the user has no remembered configuration. */
  defaultEffort?: ChatEffort;
  /** Whether this model supports Fast mode (drives the FastPill). */
  supportsFast?: boolean;
  /** Minimum agent CLI version this model needs, verified at build time by
   *  models:verify; runtime capability comes from live discovery. */
  minCliVersion?: string;
};

// Declared before the JSON-derived constants below, which run them at load.

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

/** Coerce a catalog or _meta.models entry into a ModelOption, keeping known
 *  effort levels; malformed entries return null. */
function coerceModelOption(x: unknown): ModelOption | null {
  if (!isModelOption(x)) return null;
  const o = x as Record<string, unknown>;
  const out: ModelOption = {
    value: o.value as string,
    label: o.label as string,
  };
  if (typeof o.badge === "string") out.badge = o.badge;
  if (typeof o.description === "string") out.description = o.description;
  if (Array.isArray(o.aliases)) {
    out.aliases = o.aliases.filter(
      (alias): alias is string => typeof alias === "string" && !!alias.trim(),
    );
  }
  if (Array.isArray(o.parameters)) {
    out.parameters = o.parameters.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const parameter = candidate as Record<string, unknown>;
      if (
        typeof parameter.id !== "string" ||
        !Array.isArray(parameter.values)
      ) {
        return [];
      }
      return [
        {
          id: parameter.id,
          ...(typeof (parameter.label ?? parameter.displayName) === "string"
            ? { label: (parameter.label ?? parameter.displayName) as string }
            : {}),
          values: parameter.values.flatMap((rawValue) => {
            if (!rawValue || typeof rawValue !== "object") return [];
            const value = rawValue as Record<string, unknown>;
            return typeof value.value === "string"
              ? [
                  {
                    value: value.value,
                    ...(typeof (value.label ?? value.displayName) === "string"
                      ? { label: (value.label ?? value.displayName) as string }
                      : {}),
                  },
                ]
              : [];
          }),
        },
      ];
    });
  }
  if (Array.isArray(o.variants)) {
    out.variants = o.variants.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const variant = candidate as Record<string, unknown>;
      const label = variant.label ?? variant.displayName;
      const parameters = variant.parameters ?? variant.params;
      if (typeof label !== "string" || !Array.isArray(parameters)) {
        return [];
      }
      return [
        {
          label,
          ...(typeof variant.description === "string"
            ? { description: variant.description }
            : {}),
          parameters: parameters.flatMap((candidateParameter) => {
            if (!candidateParameter || typeof candidateParameter !== "object") {
              return [];
            }
            const parameter = candidateParameter as Record<string, unknown>;
            return typeof parameter.id === "string" &&
              typeof parameter.value === "string"
              ? [{ id: parameter.id, value: parameter.value }]
              : [];
          }),
          ...(typeof variant.isDefault === "boolean"
            ? { isDefault: variant.isDefault }
            : {}),
        },
      ];
    });
  }
  if (typeof o.selectable === "boolean") out.selectable = o.selectable;
  if (typeof o.liveRequired === "boolean") out.liveRequired = o.liveRequired;
  if (Array.isArray(o.effortLevels)) {
    out.effortLevels = o.effortLevels.filter(
      (e): e is ChatEffort =>
        typeof e === "string" &&
        (VALID_EFFORTS as readonly string[]).includes(e),
    );
  }
  if (typeof o.supportsFast === "boolean") out.supportsFast = o.supportsFast;
  if (typeof o.defaultEffort === "string" && (VALID_EFFORTS as readonly string[]).includes(o.defaultEffort))
    out.defaultEffort = o.defaultEffort as ChatEffort;
  if (typeof o.minCliVersion === "string") out.minCliVersion = o.minCliVersion;
  return out;
}

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

/** Per-family default model for a chat with no selection, curated in
 *  models-v1.json. A misspelled id degrades to the family's first model. */
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

// The default-model read path lives here, not in model-favorites.ts, so every
// surface answers "what does a null ChatThread.model mean?" the same way:
// model-favorites imports this module, so it cannot be imported back. When the
// sides disagreed, a null-model Claude chat showed "Opus 5" while the engine
// ran Fable 5. Writes and the pub/sub bus stay in model-favorites.

export const DEFAULT_MODEL_SELECTION_KEY = "default-model-selection";
export const LEGACY_DEFAULT_AGENT_KEY = "default-agent-id";
export const LEGACY_FAVORITE_MODELS_KEY = "favorite-models-by-family";

export interface FavoriteModelSelection {
  /** Canonical agent family for the model. */
  agentId: string;
  /** Null means use that family's current catalog fallback. */
  model: string | null;
}

function sanitizeSelection(value: unknown): FavoriteModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const agentId =
    typeof raw.agentId === "string" ? agentFamily(raw.agentId) : "";
  if (!agentId) return null;
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : null;
  return { agentId, model };
}

/** The curated (family → model) pairs a pre-redesign `favorite-models-by-family`
 *  map really carries. Keys route through agentFamily, so a wrapper id
 *  ("claude-code") lands on the same family its model belongs to. */
export function curatedLegacyFavorites(
  favorites: unknown,
): Map<string, string> {
  const curated = new Map<string, string>();
  if (!favorites || typeof favorites !== "object" || Array.isArray(favorites)) {
    return curated;
  }
  for (const [key, value] of Object.entries(
    favorites as Record<string, unknown>,
  )) {
    const family = agentFamily(key);
    if (!family || typeof value !== "string" || !value.trim()) continue;
    curated.set(family, value.trim());
  }
  return curated;
}

/** The one family a legacy favorites map speaks for. A map naming exactly one
 *  curated family is that identity: the old composer star never wrote
 *  default-agent-id. Two or more is ambiguous, and forging one would move the
 *  user's provider, so those use catalog fallbacks. "" when there is no sole
 *  family. */
export function soleLegacyFavoriteFamily(favorites: unknown): string {
  const curated = curatedLegacyFavorites(favorites);
  if (curated.size !== 1) return "";
  return curated.keys().next().value ?? "";
}

function legacySelection(): FavoriteModelSelection | null {
  const favorites = getSetting<unknown>(LEGACY_FAVORITE_MODELS_KEY, null);
  const legacyAgent = getSetting<string | null>(LEGACY_DEFAULT_AGENT_KEY, null);
  const agentId =
    agentFamily(legacyAgent) || soleLegacyFavoriteFamily(favorites);
  if (!agentId) return null;
  return {
    agentId,
    model: curatedLegacyFavorites(favorites).get(agentId) ?? null,
  };
}

/** Raw user choice; null means provider connectivity decides. Pure by
 *  contract: every model surface calls this during render, so the legacy-key
 *  normalization is a separate boot step (migrateDefaultModelSelection). */
export function getFavoriteSelection(): FavoriteModelSelection | null {
  return (
    sanitizeSelection(getSetting<unknown>(DEFAULT_MODEL_SELECTION_KEY, null)) ??
    legacySelection()
  );
}

/** The legacy-derived selection, for the one-time boot normalization in
 * model-favorites.ts. Null when there is nothing to move across. */
export function legacyFavoriteSelection(): FavoriteModelSelection | null {
  if (sanitizeSelection(getSetting<unknown>(DEFAULT_MODEL_SELECTION_KEY, null)))
    return null;
  return legacySelection();
}

/** The raw globally selected model only when `agentId` owns it. */
export function getFavoriteModel(
  agentId: string | null | undefined,
): string | null {
  const family = agentFamily(agentId ?? null);
  const selection = getFavoriteSelection();
  return family && selection?.agentId === family ? selection.model : null;
}

/** Model a chat explicitly created for this agent should use. The one global
 * choice wins for its owner; every other family uses its own catalog fallback.
 * This is ALSO the meaning of a null `ChatThread.model`: see resolveModelOption
 * and envForChatSettings, which both route their null case through here. */
export function effectiveFavoriteModel(
  agentId: string | null | undefined,
): string | null {
  const family = agentFamily(agentId ?? null);
  if (!family) return null;
  const selected = getFavoriteModel(agentId);
  // An account-qualified (liveRequired) row is hidden from the cold picker, but an
  // exact saved value or alias still names a curated model. Keep it, so
  // discovery cannot silently rewrite the user's favorite.
  if (selected && curatedModelForValue(family, selected)) return selected;
  return defaultFavoriteModelFor(family);
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

/** The curated family that lists modelValue, or "". Unlike agentFamily this
 *  matches catalog membership, so Cursor's claude-opus-4-8-thinking-high
 *  resolves to "cursor". A value shared by families resolves to the first;
 *  callers needing the exact owner must carry the agent id. */
export function familyForModelValue(
  modelValue: string | null | undefined,
): string {
  if (!modelValue) return "";
  for (const fam of Object.keys(CURATED_FAMILIES)) {
    if (CURATED_FAMILIES[fam].some((m) => m.value === modelValue)) return fam;
  }
  return "";
}

/** Normalize an id to its curated slug across version drift: strip a context
 *  suffix ([1m]) and a dated snapshot (-YYYYMMDD), then resolve aliases (opus →
 *  claude-opus-4-8). */
export function normalizeModelSlug(family: string, id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]\s*$/, "");
  s = s.replace(/-\d{8}$/, "");
  const famAliases = ALIASES[family];
  if (famAliases && typeof famAliases[s] === "string") return famAliases[s];
  return s;
}

/** Match a persisted/provider value against every curated entry, including an
 * account-qualified row that is currently hidden from the picker. */
function curatedModelForValue(family: string, id: string): ModelOption | null {
  const curated = CURATED_FAMILIES[family] ?? [];
  const exact = curated.find((model) => model.value === id);
  if (exact) return exact;
  const normalized = normalizeModelSlug(family, id);
  return (
    curated.find(
      (model) => normalizeModelSlug(family, model.value) === normalized,
    ) ?? null
  );
}

/** Preserve a hidden account-qualified model as a display/configuration
 * identity without putting it back in the selectable model list. The requested
 * value stays verbatim so a saved legacy alias is not migrated as a side
 * effect of rendering it. */
function hiddenCompatibilityModel(
  family: string,
  id: string,
): ModelOption | null {
  const curated = curatedModelForValue(family, id);
  return curated?.liveRequired
    ? { ...curated, value: id, selectable: false }
    : null;
}

/** Agents with a discrete reasoning-effort level: Claude's SDK effort option,
 *  Codex's turn/start effort, and Cursor models with an advertised ladder. */
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

/** Fallback effort ladders for models with no resolved effortLevels, checked
 *  against code.claude.com/model-config: Sonnet 4.6 has no xhigh, Haiku stops
 *  at high. ultracode is a Zeros setting tier above xhigh. */
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

/** Per-family effort labels that differ from EFFORT_LABELS: Codex calls the
 *  internal ultracode tier "Ultra", Claude "Ultracode". Cursor uses the
 *  defaults. */
const EFFORT_LABELS_BY_FAMILY: Record<
  string,
  Partial<Record<ChatEffort, string>>
> = {
  claude: { ultracode: "Ultracode" },
  codex: { ultracode: "Ultra" },
};

/** The display label for an effort level in the given agent's vocabulary. Used
 *  by the composer EffortPill and model menu so both surfaces read identically
 *  per family (e.g. Codex "Ultra", Claude "Ultracode" for the same internal
 *  level). Falls back to the default label. */
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
  // An advertised ladder is authoritative, even empty ("no effort knob"); only an
  // absent one falls through to the family heuristic.
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

/** Rank of each effort tier (ladder position, low→high). */
const EFFORT_RANK: Record<ChatEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultracode: 5,
};

/** High is the product floor. For a ladder without High, its highest advertised
 * tier is the closest equivalent; a model with no knob still carries an inert
 * `high` in ChatThread for a stable serialized shape. Re-exported by
 * model-preferences.ts, which owns the remembered-value side. */
export function defaultEffortForLevels(levels: ChatEffort[]): ChatEffort {
  if (levels.includes("high")) return "high";
  return (
    levels.reduce<ChatEffort | null>(
      (highest, level) =>
        highest === null || EFFORT_RANK[level] > EFFORT_RANK[highest]
          ? level
          : highest,
      null,
    ) ?? "high"
  );
}

/** A model's initial effort never widens the installed runtime's ladder. */
export function defaultEffortForModel(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null = null,
): ChatEffort {
  const levels = effortLevelsFor(agentId, model, initialize);
  const initial = resolveModelOption(agentId, model, initialize)?.defaultEffort;
  return initial && levels.includes(initial) ? initial : defaultEffortForLevels(levels);
}

/** The effort this model can actually run: the stored tier when its ladder has
 *  it, else the ladder's default. One clamp shared by the pill label, the
 *  menu's editor and the spawn env, because a stored tier can go off-ladder
 *  (a retired tier, a hand-edited settings.toml) and the surfaces disagreed. */
export function effectiveEffort(
  agentId: string | null,
  model: string | null,
  effort: ChatEffort,
  initialize: InitializeResponse | null = null,
): ChatEffort {
  const levels = effortLevelsFor(agentId, model, initialize);
  if (levels.length === 0 || levels.includes(effort)) return effort;
  return defaultEffortForModel(agentId, model, initialize);
}

/** Whether the model supports Fast mode: the resolved option's supportsFast
 *  when present, else the family heuristic (Claude Opus, Codex GPT-5.x). */
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

/** The picker label: the curated label with a redundant brand prefix dropped
 *  for the claude family ("Claude Opus 5" → "Opus 5") and a "(1M)" suffix
 *  normalized to "1M". */
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

export interface ConfiguredModelLabelParts {
  model: string;
  metadata: string[];
}

/** The parts of the composer's model label. Capability-gated, so stale stored
 *  flags cannot claim an option the model cannot run, with effort clamped
 *  through effectiveEffort. */
export function configuredModelLabelParts(
  agentId: string | null,
  model: string | null,
  label: string,
  effort: ChatEffort,
  fast: boolean,
  initialize: InitializeResponse | null = null,
): ConfiguredModelLabelParts {
  const metadata: string[] = [];
  if (agentSupportsEffort(agentId, model, initialize)) {
    metadata.push(
      effortLabel(agentId, effectiveEffort(agentId, model, effort, initialize)),
    );
  }
  if (fast && agentSupportsFast(agentId, model, initialize)) {
    metadata.push("Fast");
  }
  return { model: displayModelLabel(agentId, label), metadata };
}

/** One compact accessible/plain-text label for non-visual consumers. */
export function configuredModelLabel(
  agentId: string | null,
  model: string | null,
  label: string,
  effort: ChatEffort,
  fast: boolean,
  initialize: InitializeResponse | null = null,
): string {
  const parts = configuredModelLabelParts(
    agentId,
    model,
    label,
    effort,
    fast,
    initialize,
  );
  return [parts.model, ...parts.metadata].join(" ");
}

// The Permissions menu's four postures (Plan, Auto, Tool approval, Danger) map
// to a concrete native mode per agent, by id. Cursor has only plan and agent,
// so every execute posture collapses to "agent".

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

/** Resolve a posture to the agent's native mode, or null when the agent offers
 *  none (the caller keeps the current mode). */
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

/** Classify a native mode id into a posture, with id-shape heuristics for
 *  unmapped modes, defaulting to the safe "auto". */
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

/** posture → native mode id without the live availableModes, so the
 *  new-workspace dispatcher stamps a lossless lastModeId (Claude
 *  "accept-edits", not "auto"). null when unmapped. */
export function nativeModeIdForPosture(
  agentId: string | null,
  permission: ChatPermissionMode,
): string | null {
  const fam = agentFamily(agentId);
  return NATIVE_MODE_BY_POSTURE[fam]?.[permission] ?? null;
}

// The permission toggle cycles each agent's real native modes, relabelled, so
// modes sharing a posture (Claude accept-edits and auto) stay distinct and
// round-trip through chat.lastModeId. Static ids render the same before and
// after bind. Claude Haiku drops Auto (no classifier); Codex omits read-only;
// Cursor's Auto is agent plus the create-time autoReview flag.

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

/** family → the native mode ids to show, in product display order. */
const PERMISSION_MODE_ORDER: Record<string, string[]> = {
  claude: ["default", "accept-edits", "plan", "auto", "bypass"],
  codex: ["ask", "auto-edit", "full-access"],
  cursor: ["plan", "auto", "agent"],
};

export type PermissionMenuItem = { modeId: string; label: string };

/** The modes the permission toggle cycles for this agent and model, labelled,
 *  in display order; [] hides the toggle. */
export function permissionMenuItems(
  agentId: string | null,
  model: string | null = null,
  boundary: ExecutionBoundaryStatus | null = null,
): PermissionMenuItem[] {
  const fam = agentFamily(agentId);
  const order = PERMISSION_MODE_ORDER[fam];
  const labels = PERMISSION_MODE_LABELS[fam];
  if (!order || !labels) return [];
  const m = (model ?? "").toLowerCase();
  const dropAuto = fam === "claude" && m.includes("haiku");
  const designProtected =
    boundary?.state === "ready" &&
    boundary.designProtection.required &&
    boundary.designProtection.enforced;
  const bypassDisabled =
    designProtected &&
    boundary.parity.restrictions.includes("provider-bypass-mode-disabled");
  return order
    .filter(
      (id) =>
        !(dropAuto && id === "auto") && !(bypassDisabled && id === "bypass"),
    )
    .map((id) => ({
      modeId: id,
      label: labels[id] ?? id,
    }));
}

/** Whether the permission toggle renders: we have a native-mode vocabulary. */
export function agentHasPermissionMenu(
  agentId: string | null,
  model: string | null = null,
): boolean {
  return permissionMenuItems(agentId, model).length > 0;
}

// Modes where the agent proposes instead of acting (Claude Plan, Codex Ask and
// its read-only twin, Cursor Ask) draw the dashed composer frame.
const GUARDED_PERMISSION_MODES: Record<string, string[]> = {
  claude: ["plan"],
  codex: ["ask", "read-only"],
  cursor: ["plan"],
};

export function permissionModeShowsFrame(
  agentId: string | null,
  modeId: string | null,
): boolean {
  if (!modeId) return false;
  return (
    GUARDED_PERMISSION_MODES[agentFamily(agentId)]?.includes(modeId) ?? false
  );
}

/** Coerce a mode id to one this model's menu offers, so the menu always has an
 *  active row: an "auto" chat switched to Claude Haiku shows "accept-edits",
 *  which is how auto behaves without a classifier. The persisted mode is left
 *  alone, so switching back restores it. */
export function coerceModeIdForModel(
  agentId: string | null,
  model: string | null,
  modeId: string | null,
  boundary: ExecutionBoundaryStatus | null = null,
): string | null {
  if (!modeId) return modeId;
  const items = permissionMenuItems(agentId, model, boundary);
  if (items.length === 0) return modeId;
  if (items.some((i) => i.modeId === modeId)) return modeId;
  return (items.find((i) => i.modeId === "accept-edits") ?? items[0]).modeId;
}

// Native modes mirrored for the pre-session window, so the menu shows the
// agent's real vocabulary (Claude's Bypass) before availableModes arrives; the
// live modes reconcile by id on bind. Keep in sync with claude-sdk/adapter.ts
// MODES.
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

// Cursor's modes (plan or agent, times autoReview), mirrored so a reopened chat
// shows its toggle before the SDK re-advertises. Keep in sync with
// cursor-sdk/adapter.ts CURSOR_SDK_MODES.
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

/** Statically known permission modes for the pre-session window. Codex returns
 *  [] on purpose: its modes reconcile by posture at bind. */
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

/** The unified cloud menu can show Codex while Claude/Cursor owns the chat.
 * Never apply one agent's account eligibility to another, or borrow a Local
 * connection's model list for a cloud workspace. */
export function modelCatalogInitialize(
  agentId: string | null | undefined,
  selectedAgentId: string | null | undefined,
  initialize: InitializeResponse | null,
): InitializeResponse | null {
  if (agentId === selectedAgentId) return initialize;
  const scope = initialize?._meta?.cloudModelScope;
  if (agentFamily(agentId ?? null) !== "codex" || !scope?.startsWith("cloud/")) return null;
  const models = initialize?._meta?.cloudCodexModels;
  return { protocolVersion: initialize!.protocolVersion, _meta: {
    modelEnvVar: "OPENAI_MODEL", modelsDynamic: true, cloudModelScope: scope,
    ...(models ? { models, modelsAccountScoped: true } : {}),
  } };
}

function extractMetaModels(
  initialize: InitializeResponse | null,
): ModelOption[] | null {
  const meta = initialize?._meta;
  if (!meta || !Array.isArray(meta.models)) return null;
  const valid = meta.models
    .map(coerceModelOption)
    .filter((m): m is ModelOption => m !== null);
  if (meta.modelsAccountScoped === true) {
    // An incomplete/malformed snapshot cannot make account eligibility claims.
    return valid.length === meta.models.length ? valid : null;
  }
  return valid.length > 0 ? valid : null;
}

/** Resolve the ModelOption for a model value: exact match first, then alias.
 *  A hidden account-qualified value resolves for labels with selectable false.
 *  A null model resolves to the agent's global default: the single meaning of a
 *  null ChatThread.model, shared by capability gates, the spawn env and the
 *  pill. */
export function resolveModelOption(
  agentId: string | null,
  model: string | null,
  initialize: InitializeResponse | null,
): ModelOption | null {
  const family = agentFamily(agentId);
  const list = modelsForAgent(agentId, initialize);
  // Resolve null through the same favorite-first chain the pill displays, so the
  // Effort and Fast gates match what is on screen.
  if (!model) {
    const favorite = effectiveFavoriteModel(agentId);
    if (favorite) {
      const exact = list.find((candidate) => candidate.value === favorite);
      const normalized = normalizeModelSlug(family, favorite);
      const starred =
        exact ??
        list.find(
          (candidate) =>
            normalizeModelSlug(family, candidate.value) === normalized,
        );
      if (starred) return starred;
      const compatibility = hiddenCompatibilityModel(family, favorite);
      if (compatibility) return compatibility;
    }
    return list[0] ?? null;
  }
  const exact = list.find((m) => m.value === model);
  if (exact) return exact;
  const norm = normalizeModelSlug(family, model);
  return (
    list.find((m) => normalizeModelSlug(family, m.value) === norm) ??
    hiddenCompatibilityModel(family, model)
  );
}

/** The only fields live discovery may write onto a curated row. An allowlist on
 *  purpose: a new display field must be opted in, so provider copy cannot leak
 *  into the picker by accident. */
export const LIVE_OVERLAYABLE_FIELDS = [
  "aliases",
  "parameters",
  "variants",
  "selectable",
  "effortLevels",
  "supportsFast",
] as const satisfies readonly (keyof ModelOption)[];

/** Merge a curated row with the same model's live record. Names are never
 *  fetched: providers rename wire ids, and an alias landing on a neighbouring
 *  row once put one model's name on another. Live may only fill a blank
 *  description. A capability the live record carries is authoritative even when
 *  it says none; an omitted one leaves the curated fallback. */
export function overlayLiveCapabilities(
  curated: ModelOption,
  live: ModelOption,
): ModelOption {
  const out: ModelOption = { ...curated };
  if (curated.description === undefined && live.description !== undefined) {
    out.description = live.description;
  }
  for (const field of LIVE_OVERLAYABLE_FIELDS) {
    if (live[field] === undefined) continue;
    // Widened through `unknown`: the loop assigns field-by-field from the same
    // key on both sides, which TS can't narrow across a union of keys.
    (out as Record<string, unknown>)[field] = live[field];
  }
  return out;
}

/** The model list the picker displays: curated rows with live capabilities and
 *  eligibility overlaid; families without curated rows use the live list.
 *  minCliVersion is checked at build time (models:verify), not here: a runtime
 *  gate made a model vanish as its session bound. */
export function modelsForAgent(
  agentId: string | null,
  initialize: InitializeResponse | null,
): ModelOption[] {
  const family = agentFamily(agentId);
  const curated = CURATED_FAMILIES[family] ?? [];
  const advertised = extractMetaModels(initialize);

  if (curated.length === 0) return advertised ?? [];
  if (!advertised) return curated.filter((model) => !model.liveRequired);

  const liveBySlug = new Map<string, ModelOption>();
  for (const m of advertised)
    liveBySlug.set(normalizeModelSlug(family, m.value), m);
  return curated.flatMap((c) => {
    const live = liveBySlug.get(normalizeModelSlug(family, c.value));
    if (c.liveRequired && (!live || live.selectable !== true)) return [];
    if (initialize?._meta?.modelsAccountScoped === true) {
      // Keep saved identities and curated labels visible. A complete account
      // list is authoritative about eligibility, including an empty list.
      return [live ? overlayLiveCapabilities(c, live) : { ...c, selectable: false }];
    }
    if (live?.selectable === false) return [];
    if (!live) return [c];
    return [overlayLiveCapabilities(c, live)];
  });
}

/** A wire model id's display label, or the raw id when uncatalogued. Used by
 *  the usage popover and the model-switched and turn-stopped cards. */
export function displayNameForModelValue(
  agentId: string | null,
  id: string,
): string {
  if (!id) return id;
  const owner = agentId ?? id;
  const family = agentFamily(owner);
  const norm = normalizeModelSlug(family, id);
  // Labels are compatibility data too: a liveRequired row may be absent from
  // today's picker while old transcripts/settings still carry its id or alias.
  const hit = (CURATED_FAMILIES[family] ?? []).find(
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
  const meta = initialize?._meta;
  if (typeof meta?.modelEnvVar === "string") return meta.modelEnvVar;
  return MODEL_ENV_VARS[agentFamily(agentId)];
}

/** Env var for thinking effort. Zeros convention, not agent spec. */
export const EFFORT_ENV_VAR = "ZEROS_THINKING_EFFORT";

/** Env var carrying the Fast toggle ("1" when on), read by the Claude SDK
 *  (fastMode), Codex (service_tier fast) and Cursor adapters. */
export const FAST_MODE_ENV_VAR = "ZEROS_FAST_MODE";

/** Env var carrying the pre-session permission posture, for env-consuming
 *  agents and the session-start reconcile; mode-advertising agents change mode
 *  live through setMode. */
export const PERMISSION_MODE_ENV_VAR = "ZEROS_PERMISSION_MODE";

/** The key both stamped on a slot (appliedChatEnvKey) and compared in
 *  sendPrompt's drift reconcile; one function so the two can never differ,
 *  which would cost a cold respawn. Key order is stable because envForChat
 *  assigns keys in a fixed order. PERMISSION_MODE_ENV_VAR is excluded: modes
 *  change live through AGENT_SET_MODE, and including it made every Plan toggle
 *  look like drift. */
export function chatEnvDriftKey(
  env: Record<string, string> | undefined,
): string {
  if (!env) return JSON.stringify({});
  const { [PERMISSION_MODE_ENV_VAR]: _mode, ...rest } = env;
  return JSON.stringify(rest);
}

/** Move an existing appliedChatEnvKey stamp onto a new effort, leaving the rest
 *  of the key untouched. A provider-originated effort change (Codex raising
 *  itself to Ultra) is already applied, so it must not read as drift, while an
 *  unapplied model, Fast or add-dir change stays visible. undefined when there
 *  is nothing safe to re-stamp. */
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

/** Env var carrying extra working directories (Claude /add-dir) as a JSON
 *  array; emitted only when non-empty so it never perturbs the respawn key. */
export const ADDITIONAL_DIRS_ENV_VAR = "ZEROS_ADDITIONAL_DIRS";

/** Renderer→engine carriage for the bounded persistent-query idle lifetime. */
export const CLAUDE_IDLE_TIMEOUT_ENV_VAR = "ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES";

/** Build env map from a chat's composer settings. */
export function envForChatSettings(args: {
  agentId: string | null;
  initialize: InitializeResponse | null;
  model: string | null;
  effort: string;
  fast?: boolean;
  additionalDirectories?: string[];
  permissionMode?: string;
  lastModeId?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const modelEnv = modelEnvVarForAgent(args.agentId, args.initialize);
  // Resolve a null model to what the pill displays and send it, rather than
  // letting the CLI fall back to its own default, which can differ from the pill.
  const model =
    args.model ??
    resolveModelOption(args.agentId, null, args.initialize)?.value ??
    null;
  if (model && modelEnv) env[modelEnv] = model;
  // Send the tier this model can run, the same clamp the label and editor apply.
  // Unknown strings pass through: extension agents own their vocabulary.
  const family = agentFamily(args.agentId);
  const nativeFamily =
    family === "claude" || family === "codex" || family === "cursor";
  if (
    !nativeFamily ||
    agentSupportsEffort(args.agentId, model, args.initialize)
  ) {
    env[EFFORT_ENV_VAR] = Object.prototype.hasOwnProperty.call(
      EFFORT_RANK,
      args.effort,
    )
      ? effectiveEffort(
          args.agentId,
          model,
          args.effort as ChatEffort,
          args.initialize,
        )
      : args.effort;
  }
  // Only emit the fast flag when ON, so an off→off toggle never perturbs the
  // env tuple (the respawn key) for agents that don't support it.
  if (args.fast && agentSupportsFast(args.agentId, model, args.initialize)) {
    env[FAST_MODE_ENV_VAR] = "1";
  }
  // Same: only carry extra dirs when there's at least one, so the empty case
  // never changes the env tuple. JSON encodes any path safely (spaces/commas).
  const dirs = (args.additionalDirectories ?? []).filter(
    (d) => typeof d === "string" && d.trim().length > 0,
  );
  if (dirs.length > 0) env[ADDITIONAL_DIRS_ENV_VAR] = JSON.stringify(dirs);
  if (args.permissionMode) env[PERMISSION_MODE_ENV_VAR] = args.permissionMode;
  if (args.lastModeId && permissionMenuItems(args.agentId, null).some(item => item.modeId === args.lastModeId)) {
    env[PERMISSION_MODE_ENV_VAR] = coerceModeIdForModel(args.agentId, model, args.lastModeId) ?? args.permissionMode ?? "auto";
  }
  // Claude process lifetime and memory settings remain explicit, including
  // the 30-minute idle default. Model fallback and spend caps are retired.
  if (agentFamily(args.agentId) === "claude") {
    env[CLAUDE_IDLE_TIMEOUT_ENV_VAR] = String(getClaudeIdleTimeoutMinutes());
    env.ZEROS_CLAUDE_AUTO_MEMORY = getClaudeAutoMemoryEnabled() ? "1" : "0";
    env.ZEROS_CLAUDE_IDLE_COMPACTION = getClaudeIdleCompactionEnabled() ? "1" : "0";
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
    lastModeId: chat.lastModeId,
  });
}
