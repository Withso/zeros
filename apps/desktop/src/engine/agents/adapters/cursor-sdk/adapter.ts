import { CursorUsageReconciler, cursorTokenUsage, sumCursorUsage } from "./usage-accounting";
// ──────────────────────────────────────────────────────────
// Cursor adapter — @cursor/sdk backend (the SOLE Cursor backend)
// ──────────────────────────────────────────────────────────
//
// Bespoke AgentAdapter that drives Cursor through the official `@cursor/sdk`
// (in-process Agent.create/send + run.stream()): real image input, native
// cross-restart resume, typed events, live model catalog. No CLI/ACP
// fallback — one Cursor code path.
//
// Auth: `CURSOR_API_KEY` (Settings → Providers → Cursor → API key). Bills to
// the user's Cursor plan. The SDK is loaded lazily so the engine boots even
// if the package / its native sqlite3 binding is missing.
// ──────────────────────────────────────────────────────────

import type { SteerOutcome } from "@zeros/protocol/messages";
import { createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  sessionToolGroups,
  type SessionToolInventoryEntry,
  type SessionToolsSnapshot,
} from "@zeros/protocol/agent-extensions";
import { providerBindingForResume } from "@zeros/protocol/identities";
import type { AdvertisedModel, ModelSettingsSummary } from "@zeros/protocol/agent-events";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import modelCatalogJson from "../../../../../../../catalogs/models-v1.json";
import { isDevRuntime } from "../../../runtime";

import { AgentFailureError } from "../../types";
import { mcpWorkingDirectory } from "../../mcp-working-directory";
import { materializeMcpServerRegistrations } from "../../mcp-registration";
import { scanCursorMcpServers } from "../../mcp-scan";
import { normalizeProviderError, providerErrorFailure } from "../shared/provider-error";
import { nativeMcpPassthroughEnabled } from "../shared/mcp-passthrough";
import { AccountModelDiscovery, ACCOUNT_MODEL_TTL_MS } from "../shared/account-model-discovery";
import { requireExplicitModel, requiresExactModel } from "../shared/exact-model-selection";
import {
  extractUnavailableModelId,
  parseAvailableModelsFromError,
} from "../shared/model-availability";
import type {
  AgentAdapter,
  AgentAdapterContext,
  AgentFailureStage,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServerRegistration,
  NewSessionResponse,
  NativePromptStage,
  NativePromptOutputKind,
  PromptResponse,
  ProviderCredentialUpdate,
  SessionMode,
  StopReason,
  TurnUsage,
} from "../../types";
import { withProviderConnection } from "../shared/provider-connection";
import { advertiseAgentCapabilities } from "../../capabilities";
import { CursorSdkTranslator } from "./translator";
import { CursorSubagentTranscriptReader } from "./subagent-transcript-reader";
import {
  createCursorHostRuntime,
  getCursorHostModule,
  CURSOR_HOST_EXITED_CODE,
  CURSOR_HOST_CRASH_LOOP_CODE,
  CURSOR_HOST_CRASH_LOOP_ADVICE,
} from "./host/host-client";
import { wrapSdkWithLocalStore, type RawCursorSdk } from "./local-store";
import type { PreparedBoundary } from "../../containment/types";
import { durableCursorStateRoot } from "./state-overlay";
import { configurationProvenanceFor } from "../../provider-diagnostics";

const AGENT_ID = "cursor";
/** Cursor LOCAL SDK agents (we always run `local: { cwd }`) require an
 *  EXPLICIT model selection. An absent selection therefore falls back to a
 *  concrete model. Cursor SDK 1.0.31's live catalog exposes the real Auto
 *  router as canonical id `default` with alias `auto`; both are valid explicit
 *  selections and must pass through rather than silently becoming Composer.
 *
 *  IMPORTANT: the substitute MUST be a model the user's Cursor account
 *  actually offers, or `Agent.create/resume/send` throw "Cannot use this
 *  model: <id>. Available models: …". The previous default `composer-2-fast`
 *  is NOT in current accounts' catalogs (the SDK lists `composer-2.5` /
 *  `composer-2` / `default`, no `-fast` variant), so it failed every spawn.
 *  `composer-2.5` is Cursor's current native flagship (no external-provider
 *  auth needed). We ALSO validate the resolved id against the live
 *  `Cursor.models.list()` (see resolveValidModelId) so any stale pick — from
 *  a persisted chat or the bundled catalog — falls back instead of throwing.
 *  Overridable per-chat via the CURSOR_MODEL env the model pill writes. */
const DEFAULT_MODEL = "composer-2.5";
const CURSOR_AUTO_IDS = new Set(["auto", "default"]);

/** The curated Cursor rows in `catalogs/models-v1.json`. The adapter never
 *  chooses a model outside this set on the user's behalf. */
const CURATED_CURSOR_MODELS: ReadonlySet<string> = new Set(
  modelCatalogJson.families.cursor.map((model) => model.value),
);

/** Ordered substitutes when the selected model can't run for this account:
 *  stale picks (absent from the account's list) and models Cursor refuses at
 *  run time alike. Owned by the catalog's `fallbacks.cursor`; the catalog
 *  validator requires curated, cold-startable rows, and anything else is
 *  dropped here rather than run. A model can be listed by api.cursor.com yet
 *  refused by the run backend, so each substitute must also be in the
 *  account's live list before it is tried. */
export const CURSOR_FALLBACK_MODELS: readonly string[] = (
  (modelCatalogJson as { fallbacks?: Record<string, readonly string[]> })
    .fallbacks?.cursor ?? []
).filter((id) => CURATED_CURSOR_MODELS.has(id));

/** Native attempts one turn may make before any model output: the requested
 *  settings, up to three advertised registry settings, and the two curated
 *  fallbacks. Every rejection arrives before inference, so retrying costs a
 *  round trip, never a duplicated answer. */
const CURSOR_MAX_TURN_ATTEMPTS = 6;

/** Process-local salt for account cache partitions. The corresponding model
 * state is memory-only, so a fresh salt on every engine start preserves all
 * required behavior while preventing a leaked fingerprint from becoming an
 * offline API-key guessing oracle. */
const CURSOR_MODEL_STATE_FINGERPRINT_SALT = randomBytes(32);

/** Return a memory-hard pseudonym for an API key without retaining the
 * credential in model discovery state. Exported to lock the security property
 * in tests. */
export async function cursorModelStateFingerprint(
  apiKey: string,
  processSalt: Uint8Array,
): Promise<string> {
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(apiKey, processSalt, 32, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  return derivedKey.toString("hex");
}

// Billing is supplementary telemetry. The SDK may consult a provider/local
// store that is temporarily unavailable, so cap both before/after snapshots;
// an agent turn must never inherit the control client's much longer timeout.
const CURSOR_USAGE_READ_BUDGET_MS = 500;

/** A turn whose first streamed item takes longer than this is reported with its
 *  measured latency. Chosen to sit above ordinary model time-to-first-token and
 *  well below the stall this exists to make visible — a cold host's FIRST
 *  turn has been measured at 77s while later turns in the same host take ~4s.
 *  Mirrors SLOW_FIRST_ITEM_MS in host/cursor-host.cjs, which reports the same
 *  window broken down by outbound request and child process. */
const SLOW_FIRST_ITEM_MS = 5_000;

/** Stream frames that are the SDK acknowledging the run locally rather than the
 *  model answering. Both land within ~10ms of `send` even on a turn whose first
 *  token takes 77s, so time-to-first-output must be measured past them. Mirrors
 *  RUN_CONTROL_FRAME_TYPES in host/cursor-host.cjs. */
const CURSOR_RUN_CONTROL_FRAMES = new Set(["request", "status", "summary"]);
function isCursorRunControlFrame(type: string | undefined): boolean {
  return CURSOR_RUN_CONTROL_FRAMES.has(type ?? "");
}
/** Stream frames only a running model produces. Their arrival proves Cursor
 *  accepted the attempt's model selection. */
const CURSOR_MODEL_CONTENT_FRAMES = new Set(["assistant", "thinking", "tool_call", "task"]);

/** True when a Cursor run's recovered error reason means the chosen MODEL
 *  can't run on this account's local runtime (vs an auth/network/transient
 *  failure). The canonical case is a "Max Mode" model that the local runtime
 *  can't enable for the user's plan — the SDK accepts the id but the RunSSE
 *  backend rejects it. Retrying with a confirmed-good model recovers the turn;
 *  retrying an auth/plan/network failure would not, so those are NOT matched. */
export function isCursorModelGatedError(message: string): boolean {
  return normalizeProviderError("cursor", message).category === "model-unavailable";
}

/** Cursor's run backend refuses a registry model's parameter set with "AI
 *  Model Not Found Invalid parameters for registry model: "grok-4.7"" (seen
 *  2026-10-14…17 for Extra High). It names the settings sent with the model,
 *  not the account's access to it: the same id has run with other settings. */
export function isCursorRegistrySettingsRejection(message: string): boolean {
  return /invalid\s+parameters?\s+for\s+registry\s+model/i.test(message);
}

/** TLS / certificate verification failures (Node's ERR_TLS_* family + the
 *  OpenSSL chain errors). The hallmark of HTTPS interception on the network
 *  path to Cursor's servers — a substitute cert that doesn't validate. */
const TLS_CERT_RX =
  /altnames|ERR_TLS_CERT_ALTNAME_INVALID|does\s+not\s+contain\s+a\s+DNS\s+name|self[-\s]?signed\s+certificate|unable\s+to\s+(?:verify|get\s+local\s+issuer)|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS|certificate\s+(?:has\s+expired|is\s+not\s+yet\s+valid)/i;

/** Plain socket/DNS reachability errors — usually transient. */


/** Resolve an explicit Cursor model id, defaulting only an absent pick. */
export function resolveCursorModelId(envModel: string | undefined): string {
  const m = envModel?.trim();
  if (!m) return DEFAULT_MODEL;
  const normalized = m.toLowerCase();
  if (CURSOR_AUTO_IDS.has(normalized)) return normalized;
  return m;
}

/** Validate a concrete model id against the account's live catalog, falling
 *  back to the first curated fallback the account offers when it isn't.
 *  Pure (exported for tests). `available === null` means "catalog not
 *  discovered yet" → trust the id (the SDK still validates and we surface its
 *  error cleanly). With no curated fallback offered, the id is kept: an
 *  account-only model the picker never shows is not a substitute. */
export function resolveValidModelId(
  modelId: string,
  available: Set<string> | null,
): string {
  if (!available || available.has(modelId)) return modelId;
  return CURSOR_FALLBACK_MODELS.find((id) => available.has(id)) ?? modelId;
}

/** Compatibility mapper for older Cursor catalogs that bake reasoning depth +
 *  speed into the MODEL ID itself (e.g. `<base>-thinking-high`, `<base>-fast`).
 *  Current parameterized models use `cursorModelSelection` below; this legacy
 *  path still lets saved/base ids resolve when an account advertises only
 *  suffixed variants.
 *
 *  This maps (base id, effort, fast) → a variant id, and is BEST-EFFORT: we try
 *  the id shapes VERIFIED against `cursor-agent models` (2026-07-10, CLI
 *  2026.05.28) and accept the FIRST that's actually present in `available`
 *  (the account's live catalog). Verified fast shapes: an unsuffixed base
 *  APPENDS ("composer-2.5" → "composer-2.5-fast"); a base that already ends in
 *  a reasoning level INSERTS -fast before it ("grok-4.5-xhigh" →
 *  "grok-4.5-fast-xhigh") — though a thinking-suffixed id may also append
 *  ("claude-opus-4-8-thinking-high-fast"), so both shapes are tried. It returns
 *  `base` UNCHANGED when the catalog is unknown (`available === null`), the
 *  base already carries a reasoning/speed suffix (beyond the fast swap above),
 *  or nothing matches — so it can NEVER synthesize an unoffered id and trip
 *  "Cannot use this model". Pure; exported for tests. */
export function applyCursorReasoning(
  base: string,
  effort: string | undefined,
  fast: boolean,
  available: Set<string> | null,
): string {
  // Only ever swap to an id the account demonstrably offers.
  if (!available) return base;
  const eff = (effort ?? "").trim().toLowerCase();
  const level =
    eff === "low" || eff === "medium" || eff === "high" || eff === "xhigh"
      ? eff
      : "";
  // Retarget a level-suffixed base when the user explicitly picked
  // a DIFFERENT level. A persisted pre-v6 pick (grok-4.5-xhigh) must honour
  // the effort pill instead of silently ignoring it (the old "already encodes
  // reasoning" guard swallowed the pick). Candidate order: fast+level (both
  // shapes), then level-only — honour as much of the request as the live
  // catalog offers; when none exists, fall through to the fast-twin / guard
  // paths below (the old behavior).
  if (level && !/-fast\b/i.test(base)) {
    const m = /^(.*?)(?:-thinking)?-(low|medium|high|xhigh|max)$/i.exec(base);
    if (m && m[2].toLowerCase() !== level) {
      const stem = m[1];
      const retarget: string[] = [];
      if (fast) {
        retarget.push(
          `${stem}-thinking-${level}-fast`,
          `${stem}-fast-${level}`,
        );
      }
      retarget.push(`${stem}-thinking-${level}`, `${stem}-${level}`);
      for (const c of retarget) {
        if (available.has(c)) return c;
      }
    }
  }
  // Fast on a LEVEL-suffixed base: swap to its verified fast twin. Cursor's
  // scheme varies per model (Grok inserts -fast BEFORE the trailing level,
  // Opus/Sol append it AFTER), so try both; the live catalog decides.
  if (fast && !/-fast\b/i.test(base)) {
    const lvl = /^(.*)-(low|medium|high|xhigh|max)$/i.exec(base);
    if (lvl) {
      for (const c of [`${lvl[1]}-fast-${lvl[2]}`, `${base}-fast`]) {
        if (available.has(c)) return c;
      }
    }
  }
  // Never double-apply onto an id that already encodes reasoning/speed.
  if (/-(?:thinking|fast|low|medium|xhigh|high|max)\b/i.test(base)) return base;
  const candidates: string[] = [];
  // Prefer the most specific (fast + level), then either alone, in the id shapes
  // Cursor is known to use. First hit that exists in the catalog wins.
  if (fast && level) {
    candidates.push(`${base}-thinking-${level}-fast`, `${base}-fast-${level}`);
  }
  if (fast) candidates.push(`${base}-fast`);
  if (level) candidates.push(`${base}-thinking-${level}`, `${base}-${level}`);
  // Complete the id for a curated level-free base that isn't a live
  // id itself (grok-4.5: the catalog curates the bare base so the effort pill
  // can pick the level, but Cursor's live catalog only offers suffixed ids).
  // When no level/fast candidate above lands, complete the bare base to its
  // TOP tier so the pick degrades to the same model's flagship instead of
  // resolveValidModelId's cross-family Composer fallback. Last in line, so a
  // real level pick always wins.
  if (!available.has(base)) {
    if (fast) {
      candidates.push(`${base}-fast-xhigh`, `${base}-thinking-xhigh-fast`);
    }
    candidates.push(`${base}-xhigh`, `${base}-thinking-xhigh`);
  }
  for (const c of candidates) {
    if (available.has(c)) return c;
  }
  return base;
}

// The @cursor/sdk `mode` field is only "agent" | "plan". We expose THREE Zeros
// modes by pairing it with the create-time `autoReview` flag:
//   Ask         → sdk mode "plan"                     — read-only; designs, no edits
//   Auto        → sdk mode "agent" + autoReview:true  — acts, classifier-gated
//   Full access → sdk mode "agent" + autoReview:false — acts, no gating
// Auto is BEST-EFFORT: the SDK engages the classifier only when the backend has
// the Auto-review feature; without it, autoReview:true degrades to full access
// (never MORE permissive than "Full access", so it's a safe default). autoReview
// is a CREATE-TIME option (absent from LocalSendOptions), so switching in/out of
// Auto mid-chat rebuilds the agent — see ensureSessionConfiguration().
const CURSOR_SDK_MODES: SessionMode[] = [
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
type CursorSdkModeId = "agent" | "plan" | "auto";

/** Zeros modeId → the @cursor/sdk `mode` (only "plan" | "agent"). Auto and Full
 *  access both run as "agent"; they differ only by autoReview. */
function sdkModeFor(modeId: CursorSdkModeId): "agent" | "plan" {
  return modeId === "plan" ? "plan" : "agent";
}
/** Whether this Zeros mode requests Cursor's Auto-review classifier. */
function autoReviewFor(modeId: CursorSdkModeId): boolean {
  return modeId === "auto";
}

/** Born default for a fresh Cursor session: the classifier-gated "Auto" — the
 *  safe middle of the Ask→Auto→Full-access ladder, and consistent with the
 *  "auto" posture Claude/Codex chats are born into. Degrades to full access
 *  when the backend lacks the classifier, so it's never LESS capable than the
 *  old "agent" default. The renderer reconciles a chat's persisted mode on top
 *  of this at bind (lastModeId / posture). */
const CURSOR_DEFAULT_MODE: CursorSdkModeId = "auto";

// ── Minimal structural views of @cursor/sdk (decoupled from the SDK's
// exported types so the "tool-call schema is not stable" churn can't
// break our compile; the runtime feeds plain objects we tolerate). ──

export interface SdkRun {
  /** Run id for recovering terminal errors from older SDK stores. */
  readonly id?: string;
  stream(): AsyncGenerator<unknown, void> | AsyncIterable<unknown>;
  // Recent SDKs expose a structured error; older hosts returned a string.
  wait(): Promise<
    | {
        status?: string;
        result?: string;
        errorCode?: string;
        error?: string | { message?: string; code?: string };
        model?: { id?: string };
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          reasoningTokens?: number;
        };
      }
    | undefined
  >;
  cancel(): Promise<void>;
  steer?(text: string): Promise<"complete_delivered" | "revert_to_followup">;
}

export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorAgentUsage {
  usage: CursorTokenUsage;
  cost?: { rawCostCents: number; chargedCents: number };
  runs: Array<{
    runId: string;
    usage: CursorTokenUsage;
    cost?: { rawCostCents: number; chargedCents: number };
  }>;
}

export interface CursorSdkSendOptions {
  model?: unknown;
  mode?: string;
  local?: Record<string, unknown>;
  idempotencyKey?: string;
  onStep?: (args: { step: unknown }) => void | Promise<void>;
  onDelta?: (args: { update: unknown }) => void | Promise<void>;
  onNativePromptStage?: (stage: NativePromptStage) => void;
}

export interface SdkAgent {
  readonly agentId: string;
  send(message: unknown, options?: CursorSdkSendOptions): Promise<SdkRun>;
  summarize?(): Promise<SdkRun>;
  getUsage?(options?: { runId?: string }): Promise<CursorAgentUsage>;
  close?(): void;
}

export interface CursorModelParameterValue {
  value: string;
  displayName?: string;
}

export interface CursorModelParameter {
  id: string;
  displayName?: string;
  values?: CursorModelParameterValue[];
}

export interface CursorModelVariant {
  displayName: string;
  description?: string;
  params?: Array<{ id: string; value: string }>;
  isDefault?: boolean;
}

export interface CursorModelListItem {
  id?: string;
  displayName?: string;
  description?: string;
  aliases?: string[];
  /** Newer runtimes may explicitly declare whether an entry can be selected
   * by local SDK clients. Keep both spellings at the adapter boundary so a
   * future Cursor Router can light up without changing Zeros' catalog. */
  selectable?: boolean;
  supportsLocal?: boolean;
  parameters?: CursorModelParameter[];
  variants?: CursorModelVariant[];
}

const CURSOR_EFFORT_PARAMETER_RX = /effort|reason|thinking/i;
const CURSOR_FAST_PARAMETER_RX = /speed|fast/i;

/** These registry models require account-owned parameter definitions/defaults.
 * Display capabilities are not a native wire schema: the SDK validates only
 * the ID and forwards incomplete params unchanged. Never guess that schema. */
const CURSOR_REGISTRY_PARAMETER_MODELS = new Set(["grok-4.7", "grok-4.6"]);
// A slow TLS/auth connection must not look like an account that lacks Grok's
// schema. One shared flight covers its optional retry and still has a hard end.
const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
const CURSOR_MODEL_DISCOVERY_RETRY_MS = 500;
type CursorDiscoveryFailure = "transport-closed" | "auth-required" | "rate-limited" | "protocol-error";

function unavailableCursorModelSettings(stage: AgentFailureStage): AgentFailureError {
  return new AgentFailureError({
    kind: "protocol-error", stage, agentId: AGENT_ID,
    message: "Cursor model settings could not be verified for this account.",
    advice: "Cursor model settings are unavailable. Open the model menu and choose another model before sending again.",
  });
}

function failedCursorModelDiscovery(stage: AgentFailureStage, kind: CursorDiscoveryFailure): AgentFailureError {
  const message = kind === "auth-required" ? "Cursor could not verify your sign-in. Reconnect Cursor and try again."
    : kind === "rate-limited" ? "Cursor is limiting requests. Wait a moment and try again."
      : kind === "protocol-error" ? "Cursor returned an invalid model catalog. Try again."
        : "Couldn't reach Cursor to load model settings. Try again.";
  return new AgentFailureError({ kind, stage, agentId: AGENT_ID, message, advice: message });
}

/** Parse ZEROS_ADDITIONAL_DIRS (the `/add-dir` JSON array of absolute paths)
 *  into a de-duplicated string[]. Tolerant by design — an unset or malformed
 *  value yields [], never throws into session creation. Mirrors the Claude
 *  adapter's parseAdditionalDirs; kept local because the two adapters do not
 *  import each other. Relative entries are dropped: `local.dirs` must be
 *  absolute for the SDK to resolve project settings, and the selected native
 *  or kernel boundary admits only engine-validated canonical roots. */
export function parseCursorAdditionalDirs(
  raw: string | undefined,
  pathApi: Pick<typeof import("node:path"), "isAbsolute"> = { isAbsolute },
): string[] {
  const value = raw?.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") continue;
      const dir = entry.trim();
      if (!dir || !pathApi.isAbsolute(dir) || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
    return out;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readCursorAgentUsage(
  agent: SdkAgent,
): Promise<CursorAgentUsage | undefined> {
  if (typeof agent.getUsage !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      agent.getUsage(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, CURSOR_USAGE_READ_BUDGET_MS, undefined);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Usage/cost is telemetry. A temporarily unavailable billing endpoint must
    // never fail or delay an otherwise valid agent turn.
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cursorTurnIdempotencyKey(
  sessionId: string,
  turnId: string | undefined,
): string {
  const stableTurn = turnId?.trim() || randomUUID();
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(stableTurn)
    .digest("hex")
    .slice(0, 32);
  return `zeros-${digest}`;
}

const CURSOR_EFFORT_VALUES = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);

/** Preserve Cursor's full model record at the adapter boundary while deriving
 * only the common capabilities Zeros already knows how to render. `label` is
 * advisory: a curated cursor row keeps its catalog name (see
 * AdvertisedModel.label), so Cursor rebranding an id renames nothing. */
export function cursorAdvertisedModel(
  item: CursorModelListItem,
): AdvertisedModel | null {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) return null;
  const parameters = (item.parameters ?? []).flatMap((parameter) => {
    if (!parameter || typeof parameter.id !== "string") return [];
    return [
      {
        id: parameter.id,
        ...(typeof parameter.displayName === "string"
          ? { label: parameter.displayName }
          : {}),
        values: (parameter.values ?? []).flatMap((value) =>
          value && typeof value.value === "string"
            ? [
                {
                  value: value.value,
                  ...(typeof value.displayName === "string"
                    ? { label: value.displayName }
                    : {}),
                },
              ]
            : [],
        ),
      },
    ];
  });
  const variants = (item.variants ?? []).flatMap((variant) => {
    if (!variant || typeof variant.displayName !== "string") return [];
    return [
      {
        label: variant.displayName,
        ...(typeof variant.description === "string"
          ? { description: variant.description }
          : {}),
        parameters: (variant.params ?? []).flatMap((parameter) =>
          parameter &&
          typeof parameter.id === "string" &&
          typeof parameter.value === "string"
            ? [{ id: parameter.id, value: parameter.value }]
            : [],
        ),
        ...(typeof variant.isDefault === "boolean"
          ? { isDefault: variant.isDefault }
          : {}),
      },
    ];
  });
  // Unlike an omitted schema, an explicit empty list is a negative capability
  // answer and must suppress the renderer's curated configuration controls.
  const emptyParameterSchema = Array.isArray(item.parameters) && item.parameters.length === 0;
  const executableSchema = !CURSOR_REGISTRY_PARAMETER_MODELS.has(id) ||
    Array.isArray(item.parameters) || Array.isArray(item.variants);
  const effortParameters = parameters.filter((parameter) =>
    CURSOR_EFFORT_PARAMETER_RX.test(parameter.id),
  );
  const effortLevels = effortParameters
    .flatMap((parameter) => parameter.values.map((value) => value.value))
    .filter((value, index, values) => {
      const normalized = value.toLowerCase();
      return (
        CURSOR_EFFORT_VALUES.has(normalized) &&
        values.findIndex(
          (candidate) => candidate.toLowerCase() === normalized,
        ) === index
      );
    });
  const hasSpeedMetadata = parameters.some((parameter) =>
    CURSOR_FAST_PARAMETER_RX.test(parameter.id),
  );
  const supportsFast =
    parameters.some((parameter) =>
      parameter.values.some((value) => {
        const normalized = value.value.trim().toLowerCase();
        return (
          /fast/i.test(normalized) ||
          (CURSOR_FAST_PARAMETER_RX.test(parameter.id) &&
            ["true", "on", "1"].includes(normalized))
        );
      }),
    ) ||
    variants.some(
      (variant) =>
        /fast/i.test(variant.label) ||
        variant.parameters.some((parameter) => {
          const normalized = parameter.value.trim().toLowerCase();
          return (
            /fast/i.test(normalized) ||
            (CURSOR_FAST_PARAMETER_RX.test(parameter.id) &&
              ["true", "on", "1"].includes(normalized))
          );
        }),
    );
  return {
    value: id,
    label:
      typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName
        : id,
    ...(typeof item.description === "string"
      ? { description: item.description }
      : {}),
    ...(Array.isArray(item.aliases)
      ? {
          aliases: item.aliases.filter(
            (alias): alias is string =>
              typeof alias === "string" && alias.trim().length > 0,
          ),
        }
      : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    selectable: executableSchema && (
      typeof item.selectable === "boolean"
        ? item.selectable
        : typeof item.supportsLocal === "boolean"
          ? item.supportsLocal
          : true),
    ...(effortParameters.length > 0 || emptyParameterSchema ? { effortLevels } : {}),
    ...(supportsFast || hasSpeedMetadata || emptyParameterSchema ? { supportsFast } : {}),
  };
}

type CursorModelSelection = {
  id: string;
  params?: Array<{ id: string; value: string }>;
};

function cursorParameterValue(
  parameter: CursorModelParameter,
  candidates: string[],
): string | undefined {
  const byNormalized = new Map(
    (parameter.values ?? []).map((value) => [
      value.value.trim().toLowerCase(),
      value.value,
    ]),
  );
  for (const candidate of candidates) {
    const value = byNormalized.get(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

function setCursorModelParameter(
  params: Array<{ id: string; value: string }>,
  id: string,
  value: string,
): void {
  const existing = params.findIndex((parameter) => parameter.id === id);
  const next = { id, value };
  if (existing >= 0) params[existing] = next;
  else params.push(next);
}

/** Map Zeros' durable effort/Fast settings onto @cursor/sdk's native
 * `ModelSelection.params` wire. SDK 1.0.31 advertises Grok 4.6 as one model id
 * with `effort` + `fast` parameters rather than suffixed ids; starting from the
 * advertised default variant preserves unrelated provider choices while the
 * explicit composer controls override only their matching parameters.
 *
 * Auto's current live record omits a Fast definition. Cursor's SDK accepts and
 * forwards model params without filtering them, and every Fast-capable record
 * uses the same `{ id: "fast", value: "true" }` wire, so an enabled Auto Fast
 * toggle uses that provider-native parameter while the capability is unknown.
 * An explicit live speed parameter—even empty/false-only—is authoritative, and
 * no effort parameter is ever synthesized for Auto. */
export function cursorModelSelection(
  id: string,
  model: CursorModelListItem | undefined,
  effort: string | undefined,
  fast: boolean,
): CursorModelSelection {
  const defaultVariant = model?.variants?.find(
    (variant) => variant.isDefault === true,
  );
  const params = (defaultVariant?.params ?? []).flatMap((parameter) =>
    parameter &&
    typeof parameter.id === "string" &&
    typeof parameter.value === "string"
      ? [{ id: parameter.id, value: parameter.value }]
      : [],
  );

  const normalizedEffort = effort?.trim().toLowerCase();
  if (normalizedEffort) {
    const effortCandidates =
      normalizedEffort === "xhigh"
        ? ["xhigh", "extra-high"]
        : [normalizedEffort];
    for (const parameter of model?.parameters ?? []) {
      if (!CURSOR_EFFORT_PARAMETER_RX.test(parameter.id)) continue;
      const value = cursorParameterValue(parameter, effortCandidates);
      if (value === undefined) continue;
      setCursorModelParameter(params, parameter.id, value);
      break;
    }
  }

  const hasFastCapabilityAnswer = (model?.parameters ?? []).some((parameter) =>
    CURSOR_FAST_PARAMETER_RX.test(parameter.id),
  );
  let mappedFast = false;
  for (const parameter of model?.parameters ?? []) {
    if (!CURSOR_FAST_PARAMETER_RX.test(parameter.id)) continue;
    const value = cursorParameterValue(
      parameter,
      fast
        ? ["true", "fast", "on"]
        : ["false", "balanced", "standard", "normal", "off"],
    );
    if (value === undefined) continue;
    setCursorModelParameter(params, parameter.id, value);
    mappedFast = true;
    break;
  }
  if (
    fast &&
    !mappedFast &&
    !hasFastCapabilityAnswer &&
    CURSOR_AUTO_IDS.has(id.toLowerCase())
  ) {
    setCursorModelParameter(params, "fast", "true");
  }

  return { id, ...(params.length > 0 ? { params } : {}) };
}

/** Order-insensitive identity of a native selection, for de-duplication. */
function cursorSelectionKey(selection: CursorModelSelection): string {
  return JSON.stringify([
    selection.id,
    (selection.params ?? []).map((p) => `${p.id}=${p.value}`).sort(),
  ]);
}

function cursorEffortValue(value: string | undefined | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized === "extra-high" ? "xhigh" : normalized;
}

/** The effort and Fast a native selection actually runs. `null` means the
 *  selection leaves that setting to Cursor's defaults. */
export function cursorSelectionSettings(
  selection: CursorModelSelection,
): Required<ModelSettingsSummary> {
  let effort: string | null = null;
  let fast: boolean | null = null;
  for (const parameter of selection.params ?? []) {
    if (effort === null && CURSOR_EFFORT_PARAMETER_RX.test(parameter.id)) {
      effort = cursorEffortValue(parameter.value);
    } else if (fast === null && CURSOR_FAST_PARAMETER_RX.test(parameter.id)) {
      fast = ["true", "fast", "on", "1"].includes(parameter.value.trim().toLowerCase());
    }
  }
  return { effort, fast };
}

function cursorVariantSelection(id: string, variant: CursorModelVariant): CursorModelSelection {
  const params = (variant.params ?? []).flatMap((parameter) =>
    parameter && typeof parameter.id === "string" && typeof parameter.value === "string"
      ? [{ id: parameter.id, value: parameter.value }]
      : [],
  );
  return { id, ...(params.length > 0 ? { params } : {}) };
}

/** Settings to try, in order, after Cursor refuses a registry model's
 *  requested settings: the advertised variant closest to the requested effort
 *  and Fast, the advertised default variant, then the bare id so Cursor applies
 *  its own defaults. Every candidate comes from the account's own record —
 *  nothing is synthesized — and the requested selection is never repeated. */
export function cursorRegistrySettingsLadder(
  requested: CursorModelSelection,
  model: CursorModelListItem | undefined,
  effort: string | undefined,
  fast: boolean,
): CursorModelSelection[] {
  const id = requested.id;
  const wantedEffort = cursorEffortValue(effort);
  const variants = (model?.variants ?? []).filter(
    (variant): variant is CursorModelVariant => !!variant && Array.isArray(variant.params),
  );
  const closest = variants
    .map((variant, index) => {
      const settings = cursorSelectionSettings(cursorVariantSelection(id, variant));
      const score =
        (wantedEffort !== null && settings.effort === wantedEffort ? 4 : 0) +
        ((settings.fast ?? false) === fast ? 2 : 0) +
        (variant.isDefault === true ? 1 : 0);
      return { variant, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.variant;
  const defaultVariant = variants.find((variant) => variant.isDefault === true);
  const seen = new Set([cursorSelectionKey(requested)]);
  const ladder: CursorModelSelection[] = [];
  for (const candidate of [
    closest && cursorVariantSelection(id, closest),
    defaultVariant && cursorVariantSelection(id, defaultVariant),
    { id },
  ]) {
    if (!candidate) continue;
    const key = cursorSelectionKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ladder.push(candidate);
  }
  return ladder;
}

/** One line describing an advertised registry schema, for the dev log. */
function describeCursorSchema(model: CursorModelListItem): string {
  const parameters = (model.parameters ?? [])
    .map((parameter) => `${parameter.id}=[${(parameter.values ?? []).map((value) => value.value).join("|")}]`)
    .join(" ");
  const variants = (model.variants ?? [])
    .map((variant) => `${variant.isDefault ? "*" : ""}{${(variant.params ?? []).map((p) => `${p.id}=${p.value}`).join(",")}}`)
    .join(" ");
  return `parameters ${parameters || "(none)"}; variants ${variants || "(none)"}`;
}

function describeCursorSelection(selection: CursorModelSelection): string {
  const params = (selection.params ?? []).map((p) => `${p.id}=${p.value}`).join(",");
  return params ? `${selection.id} {${params}}` : selection.id;
}

/** Preserve the SDK's explicit remote transport, including SSE. */
type CursorMcpConfig = import("@cursor/sdk").McpServerConfig;
/** Compatibility view of local run records. Current SDKs return the error
 * on RunResult directly; older hosts may require this exact-run fallback. */
export interface CursorLocalRunDoc {
  status?: string;
  error?: string | { message?: string; code?: string } | null;
  errorCode?: string;
  result?: string | null;
}
export interface CursorLocalStore {
  runs: {
    get(input: {
      agentId: string;
      runId: string;
    }): Promise<CursorLocalRunDoc | null>;
  };
  dispose(): Promise<void>;
}
export interface CursorSdkModule {
  Agent: {
    create(opts: Record<string, unknown>): Promise<SdkAgent>;
    resume(agentId: string, opts?: Record<string, unknown>): Promise<SdkAgent>;
    list(
      opts?: Record<string, unknown>,
    ): Promise<
      | { items?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>
    >;
  };
  /** Account/platform operations — `Cursor.models.list()` returns the
   *  catalog usable in local mode (the SDK validates local model picks
   *  against this same list). Optional so the bundle tolerates an older
   *  SDK without the export. */
  Cursor?: {
    models: {
      list(opts?: Record<string, unknown>): Promise<CursorModelListItem[]>;
    };
  };
  /** Build this workspace's local executor ahead of the first `send()` —
   *  @cursor/sdk 1.0.26's `platform.prewarmLocalWorkspace`, proxied to the
   *  session host. Resolving a workspace (rules, skills, MCP, ignore
   *  mappings, and the backend auth/config round-trips behind them) is the bulk
   *  of a cold first turn, and none of it depends on the user's message.
   *
   *  Optional: an older SDK, or the in-process loader, simply doesn't offer it
   *  and the first turn pays as before. Callers must treat it as best-effort —
   *  prewarming is a pure optimization and `send()` rebuilds on failure. */
  platform?: {
    prewarm(
      opts: Record<string, unknown>,
    ): Promise<{ prewarmed: boolean; elapsedMs?: number }>;
  };
  /** Opens the on-disk local agent store — the SAME instance the agents write
   *  through (JSONL) — so we can recover a run's real terminal `error` after
   *  wait() reports a detail-less failure.
   *
   *  NOT a @cursor/sdk export. The package exports a `JsonlLocalAgentStore`
   *  CONSTRUCTOR (and `LocalAgentStore` only as a TYPE), so this is a surface
   *  BOTH loaders synthesize: the host client proxies it to the `store.open`
   *  protocol op, and local-store.ts builds it from the constructor in-process.
   *  Named for what it does rather than after any SDK symbol, because probing
   *  for an SDK-looking name is precisely how this went dead in-process —
   *  nothing on the real namespace could ever have matched it. Optional so the
   *  bundle tolerates a loader without the op. */
  localStore?: {
    open(opts: {
      workspaceRef: string;
      stateRoot?: string;
    }): Promise<CursorLocalStore>;
  };
}

/** Select the SDK's ripgrep executable from deployment configuration.
 * Packaged Zeros stages its product-owned search binary; the
 * compiled engine cannot resolve the source package, so ignoring that staged
 * path produced a burst of "Ripgrep path not configured" errors per session. */
export function cursorRipgrepPathFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env.CURSOR_RIPGREP_PATH?.trim();
  if (explicit) return explicit;
  // Old desktops can still courier the previous environment name.
  const staged = env.ZEROS_RIPGREP_PATH?.trim() || env.ZEROS_ZSR_RIPGREP_PATH?.trim();
  return staged && isAbsolute(staged) ? staged : null;
}

/** The SDK's file-ignore / codebase-search service needs a ripgrep binary and
 * reads its path from CURSOR_RIPGREP_PATH. Prefer the product-owned packaged
 * helper, then resolve the optional source dependency for development. */
async function ensureRipgrep(): Promise<void> {
  const configured = cursorRipgrepPathFromEnvironment(process.env);
  if (configured) {
    process.env.CURSOR_RIPGREP_PATH = configured;
    return;
  }
  try {
    const spec = "@vscode/ripgrep";
    // @vscode/ripgrep is CJS — dynamic import may surface rgPath on the
    // namespace or under `default`. Check both.
    const rg = (await import(spec)) as {
      rgPath?: string;
      default?: { rgPath?: string };
    };
    const rgPath = rg?.rgPath ?? rg?.default?.rgPath;
    if (rgPath) process.env.CURSOR_RIPGREP_PATH = rgPath;
  } catch {
    /* optional dep absent — install @vscode/ripgrep to enable file search */
  }
}

/** True when @cursor/sdk must run in the Node host subprocess instead of
 *  in-process. Under bun the SDK's agent-run streaming (connect-node → node:http2)
 *  can't reliably reach api2.cursor.sh — bun mis-parses the cert's SANs
 *  (ERR_TLS_CERT_ALTNAME_INVALID "Cert does not contain a DNS name") and flaps
 *  ALPN ("h2 is not supported"), while Node connects fine. So under bun we route
 *  every SDK call through host/cursor-host.cjs (mirrors the node-pty host).
 *  Escape hatch ZEROS_CURSOR_IN_PROCESS=1 forces in-process (a Node engine, or
 *  to A/B the host). */
function shouldUseCursorHost(): boolean {
  if (process.env.ZEROS_CURSOR_IN_PROCESS === "1") return false;
  return Boolean((process as { versions?: { bun?: string } }).versions?.bun);
}

let sdkPromise: Promise<CursorSdkModule> | null = null;
async function loadSdk(): Promise<CursorSdkModule> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      await ensureRipgrep();
      // Under bun, the SDK's http2 transport is broken — drive it from a Node
      // subprocess instead (see shouldUseCursorHost / host/cursor-host.cjs).
      if (shouldUseCursorHost()) return getCursorHostModule();
      const m = await import("@cursor/sdk");
      // NEVER hand the raw namespace to the adapter. 1.0.26's default local
      // store needs the node:sqlite builtin (Node >= 22.5), so on a Node 20/21
      // engine every create/resume/list throws — the same failure the host
      // fixes for the packaged app. wrapSdkWithLocalStore attaches the JSONL
      // store the host attaches, and supplies the `localStore` surface the
      // adapter's error recovery reads.
      return wrapSdkWithLocalStore(m as unknown as RawCursorSdk);
    })();
  }
  return sdkPromise;
}

// Ordinary local Code chats load every Cursor settings layer, as the Cursor
// app would: project and user rules, AGENTS.md, skills, plugins and MCP
// servers declared in Cursor's own settings. Restricted actors and the host opt-out keep only their admitted runtime.
// Capture the sources once at admission: they key the SDK's executor cache,
// so prewarm, create, resume and mode rebuilds must reuse them.
const NATIVE_CURSOR_SETTING_SOURCES = [
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
] as const;
type CursorSettingSources = readonly (typeof NATIVE_CURSOR_SETTING_SOURCES)[number][];

function cursorSettingSources(
  boundary?: PreparedBoundary,
): CursorSettingSources {
  return nativeMcpPassthroughEnabled(undefined, boundary)
    ? NATIVE_CURSOR_SETTING_SOURCES
    : [];
}

interface Session {
  /** Zeros-owned live execution route; deliberately not the SDK agent id. */
  zerosSessionId: string;
  cwd: string;
  apiKey: string;
  /** The key `agent` was created or resumed with. A Local connection change
   *  replaces `apiKey`; the next run resumes the agent under it. */
  appliedApiKey: string;
  /** Account-scoped discovery and runtime denylist captured at admission. The
   * adapter may later activate another API key without changing this session's
   * model semantics. */
  modelState: CursorModelState;
  modelId: string;
  modeId: CursorSdkModeId;
  agent: SdkAgent;
  /** Per-session SDK transport. Production always points at a dedicated
   * Cursor host below this session's prepared execution boundary. */
  sdk: CursorSdkModule;
  disposeRuntime?: () => Promise<void>;
  /** The HOME this session's Cursor host actually runs with, and where the SDK
   * writes `.cursor/projects/<slug>/agent-transcripts` — so every engine-side read
   * of that tree must be rooted here, not at the engine's own home. Host-parity
   * boundaries expose the deployment's real HOME. */
  providerHome?: string;
  store?: Promise<CursorLocalStore | null>;
  activeRun: SdkRun | null;
  /** Compaction admission only: the engine can admit a new prompt while an
   * older ghost prompt is still unsettled, so this must never lock prompts. */
  promptsInFlight: number;
  compacting?: {
    settled: Promise<void>;
    stop: AbortController;
    flush: () => Promise<void>;
  };
  billing?: CursorUsageReconciler;
  pendingSteers?: Set<(outcome: SteerOutcome) => void>;
  /** Set by cancel() so the prompt loop can distinguish a user-requested
   *  abort (benign — keep the translator's `cancelled` stop reason) from a
   *  genuine mid-stream failure (which must surface as an AgentFailure, not
   *  a silent empty turn). Reset at the start of each prompt. */
  cancelRequested: boolean;
  /** Session env + MCP registry, kept so ensureSessionConfiguration() can rebuild the
   *  agent (Agent.resume) with the SAME sandbox/MCP wiring when the user
   *  toggles into/out of Auto mode — autoReview is create-time only. */
  env?: Record<string, string>;
  mcpServers?: McpServerRegistration[];
  settingSources: CursorSettingSources;
  /** The autoReview value currently baked into `agent` (set at create/resume).
   *  A mode change flips the DESIRED value (autoReviewFor(modeId)); when it
   *  diverges, the next prompt rebuilds the agent to reconcile. */
  appliedAutoReview: boolean;
  /** autoReview shapes this session has already asked the host to build an
   *  executor for. @cursor/sdk keys its workspace executor on autoReview (with
   *  cwd, apiKey, settingSources, sandbox and MCP), so the two possible values
   *  are two SEPARATE executors — and rebuilding one costs the full workspace
   *  resolution. At most two entries, so this cannot grow with toggling. */
  prewarmedAutoReview: Set<boolean>;
  appliedMcpCatalog: string;
  configurationRefresh?: Promise<void>;
  preparingPrompt?: AbortController;
  disposing?: boolean;
}

interface CursorModelState {
  fingerprint: string | null;
  authenticationContext: string;
  discoveredModelIds: Set<string> | null;
  discoveredModels: Map<string, CursorModelListItem>;
  discoveredModelAliases: Map<string, string>;
  deniedModels: Set<string>;
  deniedUntil: number;
  /** Advertised settings Cursor ran after refusing the requested settings of a
   *  registry model, keyed by the requested selection. Later turns start from
   *  them for the denial window instead of repeating a known refusal. */
  acceptedSettings: Map<string, { selection: CursorModelSelection; until: number }>;
  cache: AccountModelDiscovery<CursorModelCatalog>;
  confirmed?: CursorModelCatalog;
  discoveryFailure: CursorDiscoveryFailure | null;
  discoveryRetrying: boolean;
  discoveryListeners: Set<() => void>;
  discoveryFlight?: symbol;
}

interface CursorModelCatalog {
  ids: Set<string>;
  records: Map<string, CursorModelListItem>;
  aliases: Map<string, string>;
  models: AdvertisedModel[];
}

function createCursorModelState(fingerprint: string | null, authenticationContext = "default"): CursorModelState {
  return {
    fingerprint,
    authenticationContext,
    discoveredModelIds: null,
    discoveredModels: new Map(),
    discoveredModelAliases: new Map(),
    deniedModels: new Set(),
    deniedUntil: 0,
    acceptedSettings: new Map(),
    discoveryFailure: null,
    discoveryRetrying: false,
    discoveryListeners: new Set(),
    cache: new AccountModelDiscovery(() => fingerprint ?? "undiscovered", {
      ttlMs: ACCOUNT_MODEL_TTL_MS,
      timeoutMs: CURSOR_MODEL_DISCOVERY_TIMEOUT_MS,
    }),
  };
}

interface CursorSessionRuntime {
  sdk: CursorSdkModule;
  dispose?: () => Promise<void>;
  /** See Session.providerHome. */
  providerHome?: string;
}

export class CursorSdkAdapter implements AgentAdapter {
  readonly agentId = AGENT_ID;
  readonly capabilityPorts = {
    sessionTools: {
      list: async ({ sessionId }) => this.readSessionTools(sessionId),
      inventory: async ({ sessionId }) => {
        const list = this.readSessionTools(sessionId);
        const local = this.localMcpEntries(sessionId, list.entries);
        return {
          ...list,
          groups: sessionToolGroups(list).map((group) =>
            group.kind === "mcp"
              ? { ...group, entries: [...group.entries, ...local] }
              : group,
          ),
        };
      },
    },
    runtimeConfiguration: {
      updateCredentials: (opts) => this.updateCredentials(opts),
    },
    configuration: {
      readProvenance: async (opts) =>
        configurationProvenanceFor("cursor", {
          protectedTerritory: Boolean(opts.territory),
          nativeSettingSources: cursorSettingSources(opts.executionBoundary),
          suppressUnsafeSources: Boolean(
            opts.territory && !opts.executionBoundary,
          ),
        }),
    },
  } satisfies import("../../types").AgentCapabilityPorts;
  private readonly ctx: AgentAdapterContext;
  private readonly sessions = new Map<string, Session>();

  private readSessionTools(sessionId: string): SessionToolsSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("This chat session ended.");
    return {
      state: "unsupported",
      detail:
        "Cursor does not report MCP connection status. Dashboard tools require Cursor-hosted agents.",
      entries: (session.mcpServers ?? this.ctx.mcpServers).map((server) => ({
        id: server.name,
        name: server.name,
        status: "error",
        detail: "Cursor cannot verify this connection through its SDK.",
      })),
    };
  }

  /** MCP servers Cursor's own settings declare for a session that loads them.
   *  Cursor reports no connection status, so they stay unverified. */
  private localMcpEntries(
    sessionId: string,
    admitted: readonly { name: string }[],
  ): SessionToolInventoryEntry[] {
    const session = this.sessions.get(sessionId);
    if (!session?.settingSources.includes("project")) return [];
    const taken = new Set(admitted.map((entry) => entry.name));
    return scanCursorMcpServers(session.providerHome ?? homedir(), session.cwd)
      .filter((server) => !taken.has(server.name))
      .slice(0, Math.max(0, 1_000 - admitted.length))
      .map((server) => ({
        // Native configuration names are not constrained by our wire schema.
        // Hash oversized identities so truncating their labels cannot merge
        // two rows or invalidate the entire Tools inventory response.
        id: server.name.length > 512
          ? `local:${createHash("sha256").update(server.name).digest("hex")}`
          : server.name,
        name: server.name.slice(0, 512),
        status: "unverified",
        source: "local",
        detail:
          "Declared in Cursor's MCP settings. Cursor does not report whether it connected.",
      }));
  }
  private cachedInitialize: InitializeResponse | null = null;
  /** The most recently activated account feeds initialize metadata and new
   * admissions. Existing sessions retain the state object captured for their
   * own API key. */
  private modelState = createCursorModelState(null);
  private modelActivationRevision = 0;
  private appliedModelActivationRevision = 0;
  constructor(ctx: AgentAdapterContext) {
    this.ctx = ctx;
  }

  async initialize(): Promise<InitializeResponse> {
    const authenticationContext = this.ctx.authenticationContext?.() ?? "default";
    if (this.modelState.authenticationContext !== authenticationContext) {
      this.modelState = createCursorModelState(null, authenticationContext);
      this.clearPublishedModels();
    }
    if (!this.cachedInitialize) {
      this.cachedInitialize = {
        protocolVersion: 1,
        agentInfo: { name: "Cursor Agent", version: "sdk" },
        agentCapabilities: {
          loadSession: true,
          steering: true,
          promptCapabilities: {
            image: true, // SDKImage — base64 or url
            audio: false,
            embeddedContext: false,
          },
        },
        // Model pill writes CURSOR_MODEL; newSession reads it. modelsDynamic
        // tells the gateway to re-read initialize after a real provider
        // session populates `models`. Initialization itself never starts
        // SDK/provider work merely because the engine inherited CURSOR_API_KEY.
        _meta: { modelEnvVar: "CURSOR_MODEL", modelsDynamic: true },
        authMethods: [
          {
            type: "env_var",
            id: "api_key",
            name: "Cursor API key",
            description:
              "Paste a Cursor API key (Dashboard → API Keys). Injected as CURSOR_API_KEY; bills to your Cursor plan.",
            vars: [
              {
                name: "CURSOR_API_KEY",
                label: "Cursor API key",
                secret: true,
              },
            ],
          },
        ],
      };
    }
    this.publishModelState(this.modelState);
    const session = [...this.sessions.values()].find(candidate => candidate.modelState === this.modelState && !candidate.disposing);
    if (session) void this.discoverModels(session.apiKey, session.modelState, session.sdk);
    return advertiseAgentCapabilities(this, this.cachedInitialize);
  }

  async initializeSession(sessionId: string): Promise<InitializeResponse> {
    const base = await this.initialize();
    // Always strip the Local account snapshot for an unknown/retired route.
    const { models: _models, modelsAccountScoped: _scope, ...meta } = base._meta ?? {};
    const generic = { ...base, _meta: meta };
    const session = this.sessions.get(sessionId);
    if (!session || session.disposing) return generic;
    return base;
  }

  private clearPublishedModels(): void {
    if (!this.cachedInitialize?._meta) return;
    const { models: _models, modelsAccountScoped: _scope, ...meta } = this.cachedInitialize._meta;
    this.cachedInitialize = { ...this.cachedInitialize, _meta: meta };
  }

  private publishModelState(state: CursorModelState): void {
    if (this.modelState !== state || !this.cachedInitialize || !state.confirmed) return;
    const models = state.confirmed.models;
    if (this.cachedInitialize._meta?.models === models) return;
    this.cachedInitialize = {
      ...this.cachedInitialize,
      _meta: { ...this.cachedInitialize._meta, models, modelsAccountScoped: true },
    };
  }

  /** Credential-scoped discovery is independent of native admission. */
  private async activateModelState(apiKey: string): Promise<CursorModelState> {
    const revision = ++this.modelActivationRevision;
    const authenticationContext = this.ctx.authenticationContext?.() ?? "default";
    const fingerprint = await cursorModelStateFingerprint(
      apiKey,
      CURSOR_MODEL_STATE_FINGERPRINT_SALT,
    );
    if (authenticationContext !== (this.ctx.authenticationContext?.() ?? "default"))
      return createCursorModelState(fingerprint, authenticationContext);
    if (this.modelState.fingerprint === fingerprint && this.modelState.authenticationContext === authenticationContext) return this.modelState;
    if (revision < this.appliedModelActivationRevision) return createCursorModelState(fingerprint, authenticationContext);
    this.appliedModelActivationRevision = revision;
    this.modelState = createCursorModelState(fingerprint, authenticationContext);
    this.clearPublishedModels();
    return this.modelState;
  }

  private async discoverModels(
    apiKey: string,
    state: CursorModelState,
    sessionSdk?: CursorSdkModule,
  ): Promise<void> {
    if (state.deniedUntil && Date.now() >= state.deniedUntil) {
      state.deniedModels.clear();
      state.deniedUntil = 0;
      state.cache.invalidate(state.cache.current());
    }
    const snapshot = state.cache.current();
    let active = true;
    let ownedFlight: symbol | undefined;
    let cancelBackoff: (() => void) | undefined;
    try { await state.cache.discover(snapshot, async () => {
      ownedFlight = state.discoveryFlight = Symbol();
      const deadline = performance.now() + CURSOR_MODEL_DISCOVERY_TIMEOUT_MS;
      const current = () => active && performance.now() < deadline;
      // No response before the deadline is a connection failure, not a
      // successful catalog saying the selected model is unavailable.
      state.discoveryFailure = "transport-closed";
      try {
        const sdk = sessionSdk ?? (await loadSdk());
        if (!current()) throw new Error("Cursor model discovery expired");
        if (!sdk.Cursor?.models?.list) {
          state.discoveryFailure = "protocol-error";
          throw new Error("Cursor model discovery is unavailable");
        }
        let list: CursorModelListItem[];
        for (let attempt = 0; ; attempt++) {
          try { list = await sdk.Cursor.models.list({ apiKey }); break; }
          catch (error) {
            if (!current()) throw error;
            const category = normalizeProviderError("cursor", error).category;
            state.discoveryFailure = category === "auth-required" || category === "rate-limited" ? category
              : category === "transport-closed" ? "transport-closed" : "protocol-error";
            if (attempt !== 0 || state.discoveryFailure !== "transport-closed") throw error;
            state.discoveryRetrying = true;
            for (const notify of state.discoveryListeners) {
              try { notify(); } catch { /* Progress cannot change discovery. */ }
            }
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, CURSOR_MODEL_DISCOVERY_RETRY_MS);
              cancelBackoff = () => { clearTimeout(timer); resolve(); };
            });
            // The cache owns the original deadline. A late rejection or a
            // backoff that crosses it cannot start another provider request.
            if (!current()) throw error;
          }
        }
        if (!current()) throw new Error("Cursor model discovery expired");
        if (!Array.isArray(list) || list.length > 2_048) {
          state.discoveryFailure = "protocol-error";
          throw new Error("Cursor returned an invalid model catalog");
        }
        const ids = new Set<string>();
        const records = new Map<string, CursorModelListItem>();
        const aliases = new Map<string, string>();
        const models: AdvertisedModel[] = [];
        for (const m of list) {
          const advertised = cursorAdvertisedModel(m);
          if (!advertised) {
            state.discoveryFailure = "protocol-error";
            throw new Error("Cursor returned an invalid model catalog");
          }
          const id = advertised.value;
          // Execution denials expire independently of the registry. Retain
          // native eligibility so a saved pick can retry while refresh waits.
          const selectable = advertised.selectable;
          if (state.deniedModels.has(id) || advertised.aliases?.some(alias => state.deniedModels.has(alias)))
            advertised.selectable = false;
          records.set(id, m);
          models.push(advertised);
          if (selectable) ids.add(id);
          for (const alias of advertised.aliases ?? []) {
            aliases.set(alias, id);
            if (selectable) ids.add(alias);
          }
        }
        models.sort((a, b) => a.label.localeCompare(b.label));
        // Registry settings are validated only by Cursor's run backend. Keep
        // the account's advertised schema in the dev log next to any refusal.
        if (isDevRuntime()) {
          for (const id of CURSOR_REGISTRY_PARAMETER_MODELS) {
            const record = records.get(id);
            if (record) console.info(`[cursor-sdk] ${id} advertises ${describeCursorSchema(record)}`);
          }
        }
        return { ids, records, aliases, models };
      } catch (err) {
        if (active) this.ctx.emit.onAgentStderr(
          AGENT_ID,
          "[cursor-sdk] Model discovery is unavailable; retaining the previous catalog.",
        );
        throw err;
      }
    }, catalog => {
      state.discoveryFailure = null;
      state.confirmed = catalog;
      state.discoveredModelIds = catalog.ids;
      state.discoveredModels = catalog.records;
      state.discoveredModelAliases = catalog.aliases;
      this.publishModelState(state);
    }); } finally {
      active = false;
      cancelBackoff?.();
      if (ownedFlight && state.discoveryFlight === ownedFlight) state.discoveryRetrying = false;
    }
  }

  private modelSelection(
    modelId: string,
    state: CursorModelState = this.modelState,
    env?: Record<string, string>,
    stage: AgentFailureStage = "newSession",
  ): CursorModelSelection {
    const id = state.discoveredModelAliases.get(modelId) ?? modelId;
    const model = state.discoveredModels.get(id);
    // Preserve the full default variant, including provider parameters outside
    // Zeros' effort/Fast controls. An explicit empty schema is authoritative.
    if (CURSOR_REGISTRY_PARAMETER_MODELS.has(id) &&
        (!model || !Array.isArray(model.parameters) && !Array.isArray(model.variants)))
      throw unavailableCursorModelSettings(stage);
    const selection = cursorModelSelection(
      id,
      model,
      env?.ZEROS_THINKING_EFFORT,
      env?.ZEROS_FAST_MODE === "1",
    );
    if (requiresExactModel(env)) {
      const effort = env?.ZEROS_THINKING_EFFORT;
      const acceptableEfforts = effort === "xhigh" ? ["xhigh", "extra-high"] : [effort];
      if (
        selection.id !== env?.CURSOR_MODEL ||
        (effort && !selection.params?.some(parameter =>
          CURSOR_EFFORT_PARAMETER_RX.test(parameter.id) && acceptableEfforts.includes(parameter.value))) ||
        (env?.ZEROS_FAST_MODE === "1" && !selection.params?.some(parameter =>
          CURSOR_FAST_PARAMETER_RX.test(parameter.id) && ["true", "fast", "on"].includes(parameter.value)))
      ) throw new AgentFailureError({
        kind: "protocol-error", stage, agentId: AGENT_ID,
        message: "The exact requested Cursor model settings are unavailable; substitution is disabled.",
      });
    }
    return selection;
  }

  /** Start one credential-scoped discovery flight. ID-only selections retain
   * nonblocking startup. Parameterized registry selections join its existing
   * bounded budget because required default parameters are a correctness input,
   * not display metadata. The native call rechecks its original authority. */
  private async startModelDiscoveryForSession(
    apiKey: string,
    sessionSdk: CursorSdkModule,
    env?: Record<string, string>,
    admission?: { executionId: string; stage: "newSession" | "loadSession" },
  ): Promise<CursorModelState> {
    const state = await this.activateModelState(apiKey);
    const registry = CURSOR_REGISTRY_PARAMETER_MODELS.has(env?.CURSOR_MODEL?.trim() ?? "");
    const stage = admission?.stage ?? "newSession";
    let notified = false;
    const notify = () => {
      if (notified || !admission) return;
      try {
        this.assertModelAuthority(state, stage);
        notified = true;
        this.ctx.emit.onSessionUpdate(AGENT_ID, {
          sessionId: admission.executionId,
          update: { sessionUpdate: "error_notice", noticeId: `cursor-model-retry-${admission.executionId}`,
            code: "api_retry", severity: "warning", recoverable: true,
            message: "Couldn't reach Cursor. Retrying…" },
        });
      } catch { /* Recheck admission after the read; progress is advisory. */ }
    };
    if (registry) state.discoveryListeners.add(notify);
    try {
      if (registry && state.discoveryRetrying) notify();
      const discovery = this.discoverModels(apiKey, state, sessionSdk);
      // ID-only models keep detached discovery. Registry models need a
      // successful account answer; a timeout must not become an account denial.
      void discovery.catch(() => undefined);
      if (registry) {
        await discovery;
        this.assertModelAuthority(state, stage);
        if (!state.confirmed) throw failedCursorModelDiscovery(stage, state.discoveryFailure ?? "transport-closed");
      } else await Promise.resolve();
    } finally { state.discoveryListeners.delete(notify); }
    return state;
  }

  private assertModelAuthority(state: CursorModelState, stage: AgentFailureStage = "newSession"): void {
    if (state.authenticationContext !== (this.ctx.authenticationContext?.() ?? "default"))
      throw new AgentFailureError({
        kind: "lifecycle-superseded", stage, agentId: AGENT_ID,
        message: "The Cursor account changed while its model settings were loading.",
      });
  }

  /** Production gateway sessions never load @cursor/sdk in the trusted engine
   * and never share a host. The direct/in-process fallback remains for narrow
   * adapter unit tests and non-session provider probes. */
  private async createSessionRuntime(opts: {
    cwd: string;
    env?: Record<string, string>;
    executionBoundary?: PreparedBoundary;
  }): Promise<CursorSessionRuntime> {
    await ensureRipgrep();
    if (!opts.executionBoundary) return { sdk: await loadSdk() };
    if (!opts.env) {
      throw new Error(
        "a Cursor session host requires a complete environment",
      );
    }
    const env = { ...opts.env };
    if (process.env.CURSOR_RIPGREP_PATH && !env.CURSOR_RIPGREP_PATH) {
      env.CURSOR_RIPGREP_PATH = process.env.CURSOR_RIPGREP_PATH;
    }
    // Local stores retain their exact serialized location.
    const localState = await durableCursorStateRoot(opts.cwd);
    env.ZEROS_CURSOR_STATE_ROOT = localState;
    const runtime = createCursorHostRuntime({
      executionBoundary: opts.executionBoundary,
      cwd: opts.cwd,
      env,
    });
    return {
      sdk: runtime.module,
      dispose: runtime.dispose,
      ...(opts.executionBoundary.providerHomePath
        ? { providerHome: opts.executionBoundary.providerHomePath }
        : {}),
    };
  }

  /** Start building this session's workspace executor the moment its host
   *  exists, instead of letting the user's first message pay for it.
   *
   *  A cold turn resolves API-key exchanges, server config, feature gates and
   *  the workspace scan before processing the message. Start that work while
   *  admission, model discovery and `Agent.create` finish.
   *
   *  Deliberately NOT awaited. It is a pure optimization, so session start must
   *  not wait on it, and it must not fail a session: the host dispatches
   *  requests concurrently, so a slow prewarm cannot hold up the `Agent.create`
   *  that follows, and `send()` rebuilds whatever isn't ready.
   *
   *  The executor cache is keyed on the options that SHAPE it, so this passes
   *  the same cwd / apiKey / local / mcpServers the agent is about to be created
   *  with. `model` and `mode` are deliberately omitted — they are not part of
   *  that key, and requiring the model here would put model discovery back in
   *  front of the prewarm, which is the wait we are trying to overlap.
   *
   *  `autoReview` IS part of that key, so it is a parameter rather than a
   *  constant: the two values name two different executors (see
   *  prewarmForDesiredMode). */
  private prewarmWorkspace(
    sdk: CursorSdkModule,
    apiKey: string,
    opts: {
      cwd: string;
      env?: Record<string, string>;
      mcpServers?: McpServerRegistration[];
      settingSources: CursorSettingSources;
    },
    autoReview: boolean = autoReviewFor(CURSOR_DEFAULT_MODE),
  ): void {
    if (!sdk.platform?.prewarm) return;
    const reportSkipped = (error: unknown) => {
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] workspace prewarm skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    };
    try {
      const sessionMcp = this.mcpServers(opts.mcpServers, opts.env, opts.cwd);
      void Promise.resolve(
        sdk.platform.prewarm({
          apiKey,
          cwd: opts.cwd,
          local: this.buildLocalOpts(
            opts.cwd,
            opts.env,
            autoReview,
            opts.settingSources,
          ),
          ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
        }),
      ).catch(reportSkipped);
    } catch (error) {
      // Both option materialization and an SDK implementation may throw before
      // returning a promise. Prewarm is best-effort in either case.
      reportSkipped(error);
    }
  }

  /** Build the executor a mode change is going to need, at the moment the mode
   *  changes, instead of inside the send that discovers it is missing.
   *
   *  `autoReview` is a create-time @cursor/sdk option AND part of its workspace
   *  executor cache key, so "Auto" and "not Auto" are two separate executors.
   *  ensureSessionConfiguration() reconciles the agent lazily at prompt time — correct,
   *  and deliberately so (see its doc) — but the `Agent.resume` it issues has
   *  to resolve a workspace that was never built: the full rules / skills /
   *  ignore / MCP walk, measured at 8-12s on this repo, landing squarely on the
   *  user's first message. The session-start prewarm does not cover it, because
   *  that one warmed the OTHER shape.
   *
   *  Fire-and-forget, exactly like the session-start prewarm: a mode toggle must
   *  stay instant, and every failure here is recoverable by the send. The lazy
   *  reconcile is untouched — A→B→A still settles to one agent rebuild — this
   *  only makes sure the executor it lands on is already warm.
   *
   *  Guarded on the shapes already requested, so holding a toggle down cannot
   *  queue redundant builds. There are only two shapes, so the set is bounded. */
  private prewarmForDesiredMode(session: Session): void {
    const want = autoReviewFor(session.modeId);
    // Already baked into the live agent — nothing to rebuild, so nothing to warm.
    if (want === session.appliedAutoReview) return;
    if (session.prewarmedAutoReview.has(want)) return;
    session.prewarmedAutoReview.add(want);
    this.prewarmWorkspace(
      session.sdk,
      session.apiKey,
      {
        cwd: session.cwd,
        settingSources: session.settingSources,
        ...(session.env ? { env: session.env } : {}),
        mcpServers: this.mcpCatalog(session.mcpServers).servers,
      },
      want,
    );
  }

  /** Stop a dedicated Cursor host. State is already durable under host parity;
   * older generation-overlay holds are handled only by boot recovery. */
  private async finalizeSessionRuntime(
    runtime: Pick<CursorSessionRuntime, "dispose">,
  ): Promise<void> {
    await runtime.dispose?.();
  }

  private async finalizeRejectedSessionRuntime(
    runtime: Pick<CursorSessionRuntime, "dispose">,
  ): Promise<void> {
    try {
      await this.finalizeSessionRuntime(runtime);
    } catch (error) {
      // Keep the provider's actionable startup failure as the thrown result.
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] failed to finalize rejected runtime: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Resolve CURSOR_MODEL → a concrete id, then validate it against the
   *  account's live catalog (falling back to a known-good model). Current
   *  parameterized effort/Fast settings are attached later by modelSelection;
   *  this resolver also supports legacy suffixed variants via
   *  {@link applyCursorReasoning}. If the resolved id was already rejected by
   *  the local backend this session (deniedModels), swap to a confirmed-good
   *  retry model so we don't re-send a model we know can't run. */
  private resolveModel(
    envModel: string | undefined,
    env?: Record<string, string>,
    state: CursorModelState = this.modelState,
    stage: AgentFailureStage = "newSession",
  ): string {
    const exact = requireExplicitModel(env, "CURSOR_MODEL");
    if (exact !== null) {
      if (
        (state.discoveredModelIds && !state.discoveredModelIds.has(exact)) ||
        state.deniedModels.has(exact)
      ) {
        throw new AgentFailureError({
          kind: "protocol-error", stage, agentId: AGENT_ID,
          message: "The exact requested Cursor model is unavailable; model substitution is disabled.",
        });
      }
      return exact;
    }
    // Env-var names are Zeros conventions (mirror EFFORT_ENV_VAR /
    // FAST_MODE_ENV_VAR in model-catalog.ts, which is renderer-side and must not
    // be imported into the engine). The Claude/Codex adapters read the same
    // literals. envForChatSettings emits ZEROS_FAST_MODE only when ON ("1").
    const effort = env?.ZEROS_THINKING_EFFORT;
    const fast = env?.ZEROS_FAST_MODE === "1";
    const requested = envModel?.trim();
    if (requested && CURSOR_REGISTRY_PARAMETER_MODELS.has(requested)) {
      if (state.deniedModels.has(requested)) {
        const retry = this.pickRetryModel(requested, state);
        if (retry) return retry;
        throw unavailableCursorModelSettings(stage);
      }
      if (state.discoveredModelIds && !state.discoveredModelIds.has(requested))
        throw unavailableCursorModelSettings(stage);
    }
    // Cursor SDK 1.0.31 exposes Auto as canonical `default` plus alias `auto`.
    // Discovery canonicalizes the alias, while a cold selection stays intact
    // for the SDK's own model-list validator to canonicalize. Only an absent
    // selection takes the concrete Composer fallback.
    const liveRequested =
      requested && state.discoveredModelIds?.has(requested)
        ? (state.discoveredModelAliases.get(requested) ?? requested)
        : undefined;
    const base = liveRequested ?? resolveCursorModelId(envModel);
    // Apply the legacy reasoning-id swap before catalog validation. Some
    // accounts advertise a saved/base model (notably Grok 4.5) only through
    // suffixed variants; validating the base first would fall back to Composer
    // before the effort suffix could ever apply. applyCursorReasoning only returns ids
    // verified against the live catalog, so a successful swap needs no
    // re-validation; an unswapped base still goes through resolveValidModelId
    // (whose Composer fallback then gets its own best-effort reasoning pass,
    // preserving the old fast-on-fallback behavior).
    const swapped = applyCursorReasoning(
      base,
      effort,
      fast,
      state.discoveredModelIds,
    );
    const resolved =
      swapped !== base
        ? swapped
        : applyCursorReasoning(
            resolveValidModelId(base, state.discoveredModelIds),
            effort,
            fast,
            state.discoveredModelIds,
          );
    if (!state.deniedModels.has(resolved)) return resolved;
    return this.pickRetryModel(resolved, state) ?? resolved;
  }

  /** Pick the first curated fallback that differs from `failed`, isn't
   *  denied, and is in the account's discovered catalog. null when there's
   *  nothing else worth trying — never a model outside the curated catalog. */
  private pickRetryModel(
    failed: string,
    state: CursorModelState = this.modelState,
  ): string | null {
    const canonical = (id: string) => state.discoveredModelAliases.get(id) ?? id;
    for (const m of CURSOR_FALLBACK_MODELS) {
      if (canonical(m) === canonical(failed) || state.deniedModels.has(m) || state.deniedModels.has(canonical(m))) continue;
      if (state.discoveredModelIds?.has(m))
        return m;
    }
    return null;
  }

  /** The selection a turn sends for `modelId`: the requested settings, or the
   *  advertised settings Cursor ran after refusing them in this window. */
  private turnSelection(
    modelId: string,
    state: CursorModelState,
    env: Record<string, string> | undefined,
  ): { requested: CursorModelSelection; selection: CursorModelSelection; substituted: boolean } {
    const requested = this.modelSelection(modelId, state, env, "prompt");
    if (requiresExactModel(env)) return { requested, selection: requested, substituted: false };
    const key = cursorSelectionKey(requested);
    const accepted = state.acceptedSettings.get(key);
    if (accepted && accepted.until > Date.now()) return { requested, selection: accepted.selection, substituted: true };
    if (accepted) state.acceptedSettings.delete(key);
    return { requested, selection: requested, substituted: false };
  }

  /** After an attempt is refused before any model output, choose the next
   *  bounded attempt. A registry model whose settings Cursor refused first
   *  tries the account's other advertised settings; only when none remain is
   *  the model denied for this account and a curated fallback chosen. Exact
   *  model mode records the refusal and never substitutes. */
  private nextAttemptAfterRefusal(
    session: Session,
    attempt: { modelId: string; requested: CursorModelSelection; selection: CursorModelSelection },
    error: unknown,
    tried: ReadonlySet<string>,
  ): { modelId: string; requested: CursorModelSelection; selection: CursorModelSelection; substitute: "settings" | "model" } | null {
    const native = normalizeProviderError("cursor", error);
    if (native.category !== "model-unavailable") return null;
    const state = session.modelState;
    const env = session.env;
    const canonical = state.discoveredModelAliases.get(attempt.modelId) ?? attempt.modelId;
    if (isDevRuntime()) {
      console.info(
        `[cursor-sdk] refused ${describeCursorSelection(attempt.selection)}: ` +
          redactLogSecrets(native.message).slice(0, 240),
      );
    }
    const exact = requiresExactModel(env);
    if (
      !exact &&
      isCursorRegistrySettingsRejection(native.message) &&
      CURSOR_REGISTRY_PARAMETER_MODELS.has(canonical)
    ) {
      const key = cursorSelectionKey(attempt.requested);
      if (state.acceptedSettings.get(key)?.selection === attempt.selection) state.acceptedSettings.delete(key);
      // A turn may start from a cached substitute. Its refusal says nothing
      // about the user's original settings until this turn has tried them.
      const next = [attempt.requested, ...cursorRegistrySettingsLadder(
        attempt.requested,
        state.discoveredModels.get(canonical),
        env?.ZEROS_THINKING_EFFORT,
        env?.ZEROS_FAST_MODE === "1",
      )].find((candidate) => !tried.has(cursorSelectionKey(candidate)));
      if (next) return { modelId: attempt.modelId, requested: attempt.requested, selection: next, substitute: "settings" };
    }
    // No advertised setting runs: the model itself is refused for this account.
    this.absorbModelRejection(state, attempt.modelId, error);
    void this.discoverModels(session.apiKey, state, session.sdk);
    if (exact) return null;
    const retry = this.pickRetryModel(attempt.modelId, state);
    if (!retry) return null;
    let requested: CursorModelSelection;
    try {
      requested = this.modelSelection(retry, state, env, "prompt");
    } catch {
      return null;
    }
    if (tried.has(cursorSelectionKey(requested))) return null;
    return { modelId: retry, requested, selection: requested, substitute: "model" };
  }

  /** Fold a "Cannot use this model: <id>. Available models: …" rejection from
   *  `Agent.create`/`Agent.resume` back into the account's model state so the
   *  next resolve lands on a model that exists. Returns true when the error WAS
   *  a model rejection (caller re-resolves and retries once), false for any
   *  other failure (caller rethrows untouched).
   *
   *  ID-only catalog discovery is detached from the session critical path
   *  (see startModelDiscoveryForSession), so a first session can resolve against
   *  no catalog and pass the user's pick through. A retired pick — a persisted chat
   *  on `grok-4.5` after the account moved to `grok-4.6`, observed 2026-09 — then
   *  throws on every reopen, and resolveModel never learns why. The rejection
   *  itself carries the live list, so it is the catalog we were missing. */
  private absorbModelRejection(
    state: CursorModelState,
    rejectedModelId: string,
    error: unknown,
  ): boolean {
    const native = normalizeProviderError("cursor", error);
    if (native.category !== "model-unavailable") return false;
    const message = native.message;
    state.deniedModels.add(rejectedModelId);
    state.deniedUntil = Date.now() + ACCOUNT_MODEL_TTL_MS;
    state.cache.invalidate(state.cache.current());
    const named = extractUnavailableModelId(message);
    if (named) state.deniedModels.add(named);
    // The registry may still list a model its execution endpoint rejected.
    // Retain its identity for existing chats, but immediately remove selection
    // eligibility for this account, including during a failed/late refresh.
    if (state.confirmed) {
      state.confirmed = { ...state.confirmed, models: state.confirmed.models.map(model =>
        state.deniedModels.has(model.value) || model.aliases?.some(alias => state.deniedModels.has(alias))
          ? { ...model, selectable: false } : model) };
      this.publishModelState(state);
    }
    const listed = parseAvailableModelsFromError(message);
    if (listed.length > 0) {
      // The provider's own list is authoritative — it just refused what the
      // cached catalog (or the absence of one) let through.
      state.discoveredModelIds = new Set(listed);
    }
    return true;
  }

  /** Run one `Agent.create`/`Agent.resume` with the resolved model, retrying
   *  ONCE on a model rejection with a model the account offers. Anything other
   *  than a model rejection — auth, network, a missing agent — propagates
   *  unchanged so the existing classifiers keep owning it. */
  private async withModelRecovery<T>(
    opts: {
      state: CursorModelState;
      apiKey: string;
      sdk: CursorSdkModule;
      envModel: string | undefined;
      env: Record<string, string> | undefined;
      modelId: string;
      stage: "newSession" | "loadSession";
    },
    attempt: (modelId: string) => Promise<T>,
  ): Promise<{ result: T; modelId: string }> {
    try {
      this.assertModelAuthority(opts.state, opts.stage);
      return { result: await attempt(opts.modelId), modelId: opts.modelId };
    } catch (err) {
      const message = normalizeProviderError("cursor", err).message;
      if (!this.absorbModelRejection(opts.state, opts.modelId, err)) {
        throw err;
      }
      void this.discoverModels(opts.apiKey, opts.state, opts.sdk);
      if (requiresExactModel(opts.env)) throw err;
      const retryModelId = this.resolveModel(
        opts.envModel,
        opts.env,
        opts.state,
        opts.stage,
      );
      if (
        retryModelId === opts.modelId ||
        opts.state.deniedModels.has(retryModelId)
      ) {
        throw err;
      }
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] ${opts.stage}: model "${opts.modelId}" is not offered ` +
          `on this account (${message.slice(0, 160)}); retrying with ` +
          `${retryModelId}.`,
      );
      this.assertModelAuthority(opts.state, opts.stage);
      return { result: await attempt(retryModelId), modelId: retryModelId };
    }
  }

  /** Lazily open (and cache) the on-disk local agent store for a cwd. The store
   *  defaults its state root to the same place the SDK writes runs, so reads
   *  see the agent's own rows. Best-effort: null when unavailable. */
  private async openStore(session: Session): Promise<CursorLocalStore | null> {
    if (!session.store) {
      session.store = (async () => {
        try {
          const sdk = session.sdk;
          if (!sdk.localStore?.open) return null;
          return await sdk.localStore.open({ workspaceRef: session.cwd });
        } catch (err) {
          this.ctx.emit.onAgentStderr(
            AGENT_ID,
            `[cursor-sdk] local store open failed: ${String(err)}`,
          );
          return null;
        }
      })();
    }
    return session.store;
  }

  /** Compatibility fallback for older SDK/host runs that omitted terminal
   * details from wait() and the stream. Native message and code stay paired. */
  private async readRunError(
    session: Session,
    runId: string | undefined,
  ): Promise<{ message?: string; code?: string } | string | null> {
    if (!runId) return null;
    try {
      const store = await this.openStore(session);
      if (!store) return null;
      const doc = await store.runs.get({
        agentId: session.agent.agentId,
        runId,
      });
      const detail = doc?.error;
      if (detail && typeof detail === "object") return detail;
      const message = typeof detail === "string" && detail.trim() ? detail.trim() : undefined;
      // SDK 1.1 stores a native code as `[code] message`. Match its bounded
      // prefix contract only; incidental tags in provider prose are not codes.
      // The helper is SDK-internal, so preserve this fallback without a deep import.
      const stored = message && /^\[([A-Za-z][A-Za-z0-9_]{0,63})\] ([\s\S]*)$/.exec(message);
      if (message || doc?.errorCode) return {
        message: stored ? stored[2] : message,
        code: doc?.errorCode ?? (stored ? stored[1] : undefined),
      };
      return null;
    } catch (err) {
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] local store read failed: ${String(err)}`,
      );
      return null;
    }
  }

  async newSession(opts: {
    executionId?: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    executionBoundary?: PreparedBoundary;
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }> {
    const executionId = opts.executionId ?? randomUUID();
    const initialMode: CursorSdkModeId = opts.env?.ZEROS_PERMISSION_MODE === "plan" ? "plan" : opts.env?.ZEROS_PERMISSION_MODE === "agent" ? "agent" : CURSOR_DEFAULT_MODE;
    const apiKey = this.resolveApiKey(opts.env);
    const settingSources = cursorSettingSources(opts.executionBoundary);
    const runtime = await this.createSessionRuntime(opts);
    const mcpSource = opts.mcpServers ? [...opts.mcpServers] : undefined;
    const catalog = this.mcpCatalog(mcpSource);
    // Fire-and-forget, and BEFORE the awaits below on purpose: the whole point
    // is to overlap the workspace/backend warm-up with model discovery and
    // `Agent.create` rather than serialize behind them.
    this.prewarmWorkspace(runtime.sdk, apiKey, { ...opts, mcpServers: catalog.servers, settingSources }, autoReviewFor(initialMode));
    // Start credential-scoped catalog discovery before model resolution.
    // Local fallback stays within the configured account. Refresh never
    // replays a turn.
    let modelState: CursorModelState;
    try {
      modelState = await this.startModelDiscoveryForSession(apiKey, runtime.sdk, opts.env,
        { executionId, stage: "newSession" });
    } catch (error) {
      await this.finalizeRejectedSessionRuntime(runtime);
      throw this.classify(error, "newSession");
    }
    let modelId: string;
    const sdk = runtime.sdk;
    let agent: SdkAgent;
    try {
      this.assertModelAuthority(modelState);
      modelId = this.resolveModel(opts.env?.CURSOR_MODEL, opts.env, modelState);
      const sessionMcp = this.mcpServers(catalog.servers, opts.env, opts.cwd);
      // ID-only discovery is detached, so a retired pick can reach the SDK;
      // withModelRecovery keeps the existing listed-model fallback. A denied
      // registry pick uses a confirmed retry and reports it on the next turn.
      const created = await this.withModelRecovery(
        {
          state: modelState,
          apiKey, sdk,
          envModel: opts.env?.CURSOR_MODEL,
          env: opts.env,
          modelId,
          stage: "newSession",
        },
        (id) =>
          sdk.Agent.create({
            apiKey,
            model: this.modelSelection(id, modelState, opts.env),
            // Pin cwd at BOTH the top level and on `local`. @cursor/sdk's local
            // executor roots shell commands at `local.cwd ?? process.cwd()`; the
            // host's process.cwd() is a neutral non-repo dir (see resolveHostCwd in
            // host-client.ts), so an un-threaded cwd must never silently fall back
            // there and run `git` inside the engine's own repo. Top-level `cwd` is
            // belt-and-suspenders against SDK version drift.
            cwd: opts.cwd,
            local: this.buildLocalOpts(
              opts.cwd,
              opts.env,
              autoReviewFor(initialMode),
              settingSources,
            ),
            mode: sdkModeFor(initialMode),
            ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
          }),
      );
      agent = created.result;
      modelId = created.modelId;
    } catch (err) {
      await this.finalizeRejectedSessionRuntime(runtime);
      throw this.classify(err, "newSession");
    }

    const session: Session = {
      zerosSessionId: executionId,
      cwd: opts.cwd,
      apiKey,
      appliedApiKey: apiKey,
      modelState,
      modelId,
      modeId: initialMode,
      agent,
      sdk,
      ...(runtime.dispose ? { disposeRuntime: runtime.dispose } : {}),
      ...(runtime.providerHome ? { providerHome: runtime.providerHome } : {}),
      activeRun: null,
      promptsInFlight: 0,
      cancelRequested: false,
      env: opts.env,
      mcpServers: mcpSource,
      settingSources,
      appliedAutoReview: autoReviewFor(initialMode),
      prewarmedAutoReview: new Set([autoReviewFor(initialMode)]),
      appliedMcpCatalog: catalog.key,
    };
    this.sessions.set(executionId, session);

    return {
      session: {
        executionId,
        sessionId: executionId,
        providerBinding: providerBindingForResume("cursor", agent.agentId),
        modes: {
          currentModeId: initialMode,
          availableModes: CURSOR_SDK_MODES,
        },
      } as never,
      initialize: await this.initializeSession(executionId),
    };
  }

  async loadSession(opts: {
    executionId?: string;
    providerBinding?: import("@zeros/protocol/identities").ProviderBinding;
    sessionId?: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    executionBoundary?: PreparedBoundary;
  }): Promise<LoadSessionResponse> {
    const initialMode: CursorSdkModeId = opts.env?.ZEROS_PERMISSION_MODE === "plan" ? "plan" : opts.env?.ZEROS_PERMISSION_MODE === "agent" ? "agent" : CURSOR_DEFAULT_MODE;
    const apiKey = this.resolveApiKey(opts.env);
    const settingSources = cursorSettingSources(opts.executionBoundary);
    const executionId = opts.executionId ?? opts.sessionId ?? randomUUID();
    const providerResumeId = opts.providerBinding?.resumeId ?? opts.sessionId;
    if (!providerResumeId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "loadSession",
        message: "Cursor resume requires a provider agent binding.",
      });
    }
    const runtime = await this.createSessionRuntime(opts);
    const mcpSource = opts.mcpServers ? [...opts.mcpServers] : undefined;
    const catalog = this.mcpCatalog(mcpSource);
    // Same overlap as newSession: a reopened chat pays the identical cold
    // workspace/backend cost on its first turn, so warm it while the catalog
    // and `Agent.resume` are still in flight.
    this.prewarmWorkspace(runtime.sdk, apiKey, { ...opts, mcpServers: catalog.servers, settingSources }, autoReviewFor(initialMode));
    // Discover the account's catalog (cached, once per process) so the model
    // is validated BEFORE create/resume — otherwise a stale id (e.g. the old
    // `composer-2-fast` default, or a persisted pick) throws "Cannot use this
    // model: <id>". resolveModel falls back to a known-good model when the
    // selection isn't offered by this account.
    let modelState: CursorModelState;
    try {
      modelState = await this.startModelDiscoveryForSession(apiKey, runtime.sdk, opts.env,
        { executionId, stage: "loadSession" });
    } catch (error) {
      await this.finalizeRejectedSessionRuntime(runtime);
      throw this.classify(error, "loadSession");
    }
    let modelId = "";
    const sdk = runtime.sdk;
    // Per-session MCP registry (gateway-resolved for this cwd). `Agent.resume`
    // takes a Partial<AgentOptions>, which accepts `mcpServers` — so we re-inject
    // on resume too. Without this, a resumed chat kept whatever MCP set it was
    // first created with, so a server the user ADDED after the chat opened never
    // appeared until they started a brand-new chat.
    let sessionMcp: Record<string, CursorMcpConfig> | null = null;
    let agent: SdkAgent;
    // True when resume failed and we seeded a FRESH agent below — the gateway
    // re-injects the first-turn <system_instruction> (the fresh agent has no
    // prior transcript carrying it).
    let resumedFresh = false;
    try {
      this.assertModelAuthority(modelState, "loadSession");
      modelId = this.resolveModel(opts.env?.CURSOR_MODEL, opts.env, modelState, "loadSession");
      sessionMcp = this.mcpServers(catalog.servers, opts.env, opts.cwd);
      // A reopened chat carries the model it was created on; if Cursor has
      // retired it since, `Agent.resume` throws "Cannot use this model" on
      // every reopen. withModelRecovery retries once on a listed model.
      const resumed = await this.withModelRecovery(
        {
          state: modelState,
          apiKey, sdk,
          envModel: opts.env?.CURSOR_MODEL,
          env: opts.env,
          modelId,
          stage: "loadSession",
        },
        (id) =>
          sdk.Agent.resume(providerResumeId, {
            apiKey,
            // Bind the resolved model on resume too. `Agent.resume` reconstructs
            // the agent from Cursor's local SQLite store, which may hold NO
            // persisted model (a cross-worktree id, a rotated cache, or a
            // pre-SDK cursor-agent CLI id). Without an explicit model the
            // resumed agent's internal `_model` is undefined and the next
            // `send()` throws "Local SDK agents require an explicit `model`" —
            // the exact error users hit on every reopened chat. `resume` takes a
            // Partial<AgentOptions>, which accepts `model`.
            model: this.modelSelection(id, modelState, opts.env, "loadSession"),
            // Pin cwd here too — a resumed agent's executor roots at `local.cwd`,
            // and resuming a chat in a different worktree MUST retarget it (else
            // shells run wherever the agent was first created, or fall back to the
            // host's process.cwd()). See resolveHostCwd in host-client.ts.
            cwd: opts.cwd,
            local: this.buildLocalOpts(
              opts.cwd,
              opts.env,
              autoReviewFor(initialMode),
              settingSources,
            ),
            ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
          }),
      );
      agent = resumed.result;
      modelId = resumed.modelId;
    } catch (err) {
      const failure = this.classify(err, "loadSession");
      // The stored agentId is gone from Cursor's local agent store — the
      // SDK throws "Agent <uuid> not found". This is COMMON and benign:
      // the chat was created in another worktree's store, the SDK cache
      // was rotated, or (post-migration) the stored id is a pre-SDK
      // cursor-agent CLI chat id that the SDK never knew. Rather than
      // failing the reopen (which surfaced an "Agent error" toast on
      // every worktree / legacy chat), transparently seed a FRESH agent
      // in the same cwd so the chat opens clean. The on-disk transcript
      // still renders; the fresh agent simply has no prior in-memory
      // Cursor context — the same trade-off the renderer's
      // session-expired rebuild path documents. Only the "agent gone"
      // case recovers this way; auth / transport failures still throw so
      // the UI can prompt re-auth or retry instead of silently dropping
      // the user's context.
      if (failure.failure.kind !== "session-expired") {
        await this.finalizeRejectedSessionRuntime(runtime);
        throw failure;
      }
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] resume of ${providerResumeId} failed (${
          err instanceof Error ? err.message : String(err)
        }); starting a fresh agent in ${opts.cwd}.`,
      );
      try {
        const created = await this.withModelRecovery(
          {
            state: modelState,
            apiKey, sdk,
            envModel: opts.env?.CURSOR_MODEL,
            env: opts.env,
            modelId,
            stage: "loadSession",
          },
          (id) =>
            sdk.Agent.create({
              apiKey,
              model: this.modelSelection(id, modelState, opts.env, "loadSession"),
              // Same cwd pinning as the primary create — the fresh fallback agent
              // must also root at the worktree, never the host's process.cwd().
              cwd: opts.cwd,
              local: this.buildLocalOpts(
                opts.cwd,
                opts.env,
                autoReviewFor(initialMode),
                settingSources,
              ),
              mode: sdkModeFor(initialMode),
              ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
            }),
        );
        agent = created.result;
        modelId = created.modelId;
        resumedFresh = true;
      } catch (createErr) {
        await this.finalizeRejectedSessionRuntime(runtime);
        throw this.classify(createErr, "loadSession");
      }
    }
    this.sessions.set(executionId, {
      zerosSessionId: executionId,
      cwd: opts.cwd,
      apiKey,
      appliedApiKey: apiKey,
      modelState,
      modelId,
      modeId: initialMode,
      agent,
      sdk,
      ...(runtime.dispose ? { disposeRuntime: runtime.dispose } : {}),
      ...(runtime.providerHome ? { providerHome: runtime.providerHome } : {}),
      activeRun: null,
      promptsInFlight: 0,
      cancelRequested: false,
      env: opts.env,
      mcpServers: mcpSource,
      settingSources,
      appliedAutoReview: autoReviewFor(initialMode),
      prewarmedAutoReview: new Set([autoReviewFor(initialMode)]),
      appliedMcpCatalog: catalog.key,
    });
    return {
      executionId,
      providerBinding: providerBindingForResume("cursor", agent.agentId),
      modes: {
        currentModeId: initialMode,
        availableModes: CURSOR_SDK_MODES,
      },
      resumedFresh,
      ...(resumedFresh ? { replacementSessionId: agent.agentId } : {}),
    } as never;
  }

  async listSessions(opts: {
    cwd?: string;
    cursor?: string | null;
    env?: Record<string, string>;
    executionBoundary?: PreparedBoundary;
  }): Promise<ListSessionsResponse> {
    let runtime: CursorSessionRuntime | undefined;
    try {
      runtime = opts.executionBoundary
        ? await this.createSessionRuntime({
            cwd: opts.cwd ?? this.ctx.projectRoot,
            env: opts.env,
            executionBoundary: opts.executionBoundary,
          })
        : { sdk: await loadSdk() };
      const res = await runtime.sdk.Agent.list({
        runtime: "local",
        cwd: opts.cwd,
      });
      const items = Array.isArray(res) ? res : (res.items ?? []);
      const sessions = items
        .map((it) => ({
          sessionId: String(it.agentId ?? it.id ?? ""),
          providerBinding: providerBindingForResume(
            "cursor",
            String(it.agentId ?? it.id ?? ""),
          ),
          cwd: typeof it.cwd === "string" ? it.cwd : (opts.cwd ?? ""),
          title: typeof it.name === "string" ? it.name : undefined,
          updatedAt:
            typeof it.lastModified === "number"
              ? new Date(it.lastModified).toISOString()
              : undefined,
        }))
        .filter((s) => s.sessionId);
      return { sessions };
    } catch {
      return { sessions: [] } as never;
    } finally {
      if (runtime?.dispose) {
        await this.finalizeSessionRuntime(runtime);
      }
    }
  }

  async prompt(opts: {
    sessionId: string;
    turnId?: string;
    prompt: ContentBlock[];
    onNativePromptStage?: (stage: NativePromptStage) => void;
    onNativeOutput?: (kind: NativePromptOutputKind, receivedAtMs?: number) => void;
  }): Promise<{ stopReason: StopReason; response: PromptResponse }> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return this.runPrompt(opts);
    session.promptsInFlight++;
    try {
      const compaction = session.compacting;
      if (compaction) {
        let stopWaiting!: () => void;
        const stopped = new Promise<void>(resolve => { stopWaiting = resolve; });
        const signal = compaction.stop.signal;
        if (signal.aborted) stopWaiting();
        else signal.addEventListener("abort", stopWaiting, { once: true });
        try {
          // The settlement barrier never rejects: a summary failure belongs
          // to /compact and must not discard the user's next prompt.
          await Promise.race([compaction.settled, stopped]);
        } finally { signal.removeEventListener("abort", stopWaiting); }
        // runPrompt resets cancelRequested. Observe Stop before entering it,
        // even if native summarize has not returned a cancellable run yet.
        // Only this wait's signal counts: cancelRequested may still hold an
        // earlier Stop that belonged to an earlier prompt.
        if (signal.aborted || session.disposing || this.sessions.get(opts.sessionId) !== session) {
          return { stopReason: "cancelled", response: { stopReason: "cancelled" } };
        }
      }
      return await this.runPrompt(opts);
    } finally { session.promptsInFlight--; }
  }

  private async runPrompt(opts: Parameters<CursorSdkAdapter["prompt"]>[0]): Promise<{ stopReason: StopReason; response: PromptResponse }> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) {
      // An id this adapter never registered is a session from a previous
      // engine process (or one already retired), not a protocol violation.
      // protocol-error is NOT recoverable, so it used to surface as a hard
      // "no live session (load it first)" toast and drop the user's message
      // on every engine respawn. session-expired makes the renderer rebuild
      // and resend, matching how Codex and Claude already behave.
      throw new AgentFailureError({
        kind: "session-expired",
        message: `cursor-sdk: session ${opts.sessionId} is no longer live`,
        stage: "prompt",
        agentId: AGENT_ID,
      });
    }

    void this.discoverModels(session.apiKey, session.modelState, session.sdk);
    const message = buildUserMessage(opts.prompt);
    session.cancelRequested = false;

    // Configuration refresh is preparation, not a submitted prompt. Stop must
    // settle immediately even if native resume is slow. A later queued send
    // joins that same refresh instead of racing a second native handle into it.
    const preparation = new AbortController();
    session.preparingPrompt = preparation;
    let stopPreparing!: () => void;
    const stopped = new Promise<void>((resolve) => { stopPreparing = resolve; });
    preparation.signal.addEventListener("abort", stopPreparing, { once: true });
    try {
      await Promise.race([this.ensureSessionConfiguration(session), stopped]);
    } catch (err) {
      if (!preparation.signal.aborted && !session.disposing) throw this.classify(err, "prompt");
    } finally {
      preparation.signal.removeEventListener("abort", stopPreparing);
      if (session.preparingPrompt === preparation) session.preparingPrompt = undefined;
    }
    if (preparation.signal.aborted || session.disposing || this.sessions.get(opts.sessionId) !== session) {
      return { stopReason: "cancelled", response: { stopReason: "cancelled" } };
    }
    session.billing ??= new CursorUsageReconciler(
      () => readCursorAgentUsage(session.agent),
      (turnId, usage) => {
        if (this.sessions.get(opts.sessionId) === session) this.ctx.emit.onSessionUpdate(AGENT_ID, {
          sessionId: opts.sessionId, update: { sessionUpdate: "turn_usage_update", turnId, usage },
        });
      },
    );
    const idempotencyKey = cursorTurnIdempotencyKey(
      session.agent.agentId,
      opts.turnId,
    );
    const requestedModel = session.env?.CURSOR_MODEL?.trim() || session.modelId;
    const fallbackNoticeId = `cursor-${opts.sessionId}-${opts.turnId ?? randomUUID()}`;
    const canonicalModel = (id: string) =>
      session.modelState.discoveredModelAliases.get(id) ??
      (CURSOR_AUTO_IDS.has(id.toLowerCase()) ? "default" : id);

    // Prefer RunResult.error; legacy hosts can still require the local store
    // fallback. A refusal before any model output moves to the next bounded
    // attempt (nextAttemptAfterRefusal): the account's other advertised
    // settings for a registry model, then the catalog's curated fallbacks.
    const MAX_ATTEMPTS = requiresExactModel(session.env) ? 1 : CURSOR_MAX_TURN_ATTEMPTS;
    const tried = new Set<string>();
    let planned: {
      modelId: string;
      requested: CursorModelSelection;
      selection: CursorModelSelection;
      substitute: "settings" | "model" | null;
    } | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const lastAttempt = attempt >= MAX_ATTEMPTS;
      // Attempt 1 honours the chat's pick (minus anything already refused for
      // this account); later attempts run the planned substitute.
      let current: NonNullable<typeof planned>;
      try {
        if (planned) current = planned;
        else {
          const modelId = this.resolveModel(
            session.env?.CURSOR_MODEL ?? session.modelId,
            session.env,
            session.modelState,
            "prompt",
          );
          const chosen = this.turnSelection(modelId, session.modelState, session.env);
          current = {
            modelId,
            requested: chosen.requested,
            selection: chosen.selection,
            substitute:
              canonicalModel(modelId) !== canonicalModel(requestedModel) &&
              CURSOR_FALLBACK_MODELS.includes(modelId)
                ? "model"
                : chosen.substituted ? "settings" : null,
          };
        }
      } catch (err) {
        if (session.cancelRequested) return { stopReason: "cancelled", response: { stopReason: "cancelled" } };
        throw this.classify(err, "prompt");
      }
      planned = null;
      const modelId = current.modelId;
      tried.add(cursorSelectionKey(current.selection));

      // Fresh translator per attempt so a retried run doesn't inherit the
      // failed run's partial state. A model-gated run errors before emitting
      // assistant text, so the retry won't duplicate visible content.
      const transcripts = new CursorSubagentTranscriptReader({
        cwd: session.cwd, parentAgentId: session.agent.agentId,
        ...(session.providerHome ? { home: session.providerHome } : {}),
      });
      const translator = new CursorSdkTranslator({
        sessionId: opts.sessionId,
        emit: (n) => this.ctx.emit.onSessionUpdate(AGENT_ID, n),
        onUnknown: () => {
          /* tolerate unknown message types */
        },
        // Native taskUpdate callbacks supply live child activity. Older or
        // incomplete transports can instead use owned transcript checkpoints.
        // The translator selects one child feed, avoiding duplicate native /
        // file histories. Readers stay scoped to the native parent and HOME.
        readSubagentTranscript: (child, final) => transcripts.read(child, final),
        onLog: (m) =>
          this.ctx.emit.onAgentStderr(AGENT_ID, `${m} (cwd=${session.cwd})`),
      });

      // Verification breadcrumb, mirroring the Claude and Codex adapters: one
      // line per turn echoing what was actually sent. Cursor had none, so a
      // turn's model/mode could only be inferred from the renderer's telemetry.
      if (isDevRuntime()) {
        console.info(
          `[cursor-sdk] turn: model=${describeCursorSelection(current.selection)} mode=${session.modeId} ` +
            `attempt=${attempt}/${MAX_ATTEMPTS}`,
        );
      }
      // Time to the turn's first MODEL OUTPUT, measured end-to-end (host bridge
      // included) rather than inside the host. Deliberately not the first
      // streamed item: the SDK acknowledges a run with `request`/`status`
      // frames within ~10ms of send, and a cold host has been measured
      // delivering those on time and then taking 77s to produce a first token
      // (against ~4s for later turns in the same host). Reported whenever it is
      // slow, into the engine log the user already has, next to the
      // [cursor-host] attribution lines that say what was blocking.
      const turnStartedAt = Date.now();
      let sawModelOutput = false;
      let callbackUsage: TurnUsage | undefined;
      let acceptingUpdates = true;
      const ownsUpdates = () =>
        acceptingUpdates &&
        !session.cancelRequested &&
        this.sessions.get(opts.sessionId) === session;
      // Cursor ran this attempt: its first model output (or a quiet success)
      // proves the selection. Only then remember settings it accepted and
      // narrate a substitute, so a refused attempt never claims it ran. The
      // saved pick stays: this turn's recovery is not a sticky model switch.
      let accepted = false;
      const acceptAttempt = () => {
        if (accepted || session.cancelRequested || this.sessions.get(opts.sessionId) !== session) return;
        accepted = true;
        if (current.substitute === "settings") {
          const key = cursorSelectionKey(current.requested);
          if (!session.modelState.acceptedSettings.has(key))
            session.modelState.acceptedSettings.set(key, { selection: current.selection, until: Date.now() + ACCOUNT_MODEL_TTL_MS });
          const fromSettings = cursorSelectionSettings(current.requested);
          const toSettings = cursorSelectionSettings(current.selection);
          // A substitute differing only in settings the composer doesn't
          // control (such as context) changes nothing the user chose.
          if (fromSettings.effort === toSettings.effort && fromSettings.fast === toSettings.fast) return;
          this.ctx.emit.onSessionUpdate(AGENT_ID, {
            sessionId: opts.sessionId,
            update: {
              sessionUpdate: "model_fallback", noticeId: fallbackNoticeId,
              provider: "cursor", fromModel: requestedModel, toModel: modelId,
              scope: "local", reason: "settings", fromSettings, toSettings,
            },
          });
        } else if (current.substitute === "model") {
          this.ctx.emit.onSessionUpdate(AGENT_ID, {
            sessionId: opts.sessionId,
            update: {
              sessionUpdate: "model_fallback", noticeId: fallbackNoticeId,
              provider: "cursor", fromModel: requestedModel, toModel: modelId,
              scope: "local", reason: "unavailable",
            },
          });
        }
      };

      let run: SdkRun;
      try {
        // Always pass the model on `send` (not just at create/resume): the SDK
        // resolves a run's model as `sendOptions.model ?? agent._model`, and a
        // resumed agent's `_model` can be undefined → "Local SDK agents require
        // an explicit `model`". `local.force` expires any wedged prior run so
        // it can't collide with this one.
        run = await session.agent.send(message, {
          // Auto & Full access both run as sdk "agent"; they differ only by the
          // (create-time) autoReview already baked in via ensureSessionConfiguration().
          mode: sdkModeFor(session.modeId),
          model: current.selection,
          local: { force: true },
          ...(opts.onNativePromptStage ? { onNativePromptStage: (stage: NativePromptStage) => {
            if (!ownsUpdates()) return;
            try { void Promise.resolve(opts.onNativePromptStage!(stage)).catch(() => {}); } catch { /* observation is inert */ }
          } } : {}),
          // The engine-owned turn id survives renderer reconnect/resend. Hash
          // it before crossing the harness boundary so provider logs never
          // receive Zeros' durable identity verbatim. A model-gate fallback is
          // a distinct provider attempt and gets a deterministic suffix.
          idempotencyKey:
            attempt === 1
              ? idempotencyKey
              : `${idempotencyKey}-retry-${attempt}`,
          onDelta: ({ update }) => {
            if (!ownsUpdates()) return;
            // The host routes this callback by its engine-generated native
            // runId. Never observe a generic session/subagent stream or a
            // transcript/step fallback as output from the current prompt.
            if (opts.onNativeOutput && isRecord(update)) {
              const kind = update.type === "text-delta" && typeof update.text === "string" && update.text.length > 0 ? "text" :
                ["tool-call-started", "partial-tool-call", "tool-call-completed"].includes(String(update.type)) &&
                  typeof update.callId === "string" && update.callId.trim().length > 0 && isRecord(update.toolCall) &&
                  typeof update.toolCall.type === "string" && update.toolCall.type.trim().length > 0 ? "tool" : undefined;
              if (kind) {
                try { void Promise.resolve(opts.onNativeOutput(kind)).catch(() => {}); } catch { /* observation is inert */ }
              }
            }
            if (isRecord(update) && typeof update.type === "string" && /^(?:text-|thinking-|tool-call-|partial-tool-call)/.test(update.type)) {
              sawModelOutput = true;
              acceptAttempt();
            }
            if (isRecord(update) && update.type === "turn-ended") {
              callbackUsage = sumCursorUsage(callbackUsage, cursorTokenUsage(update.usage));
            }
            translator.feedDelta(update);
          },
          onStep: ({ step }) => {
            if (ownsUpdates()) {
              sawModelOutput = true;
              acceptAttempt();
              translator.feedStep(step);
            }
          },
        });
      } catch (err) {
        acceptingUpdates = false;
        transcripts.dispose();
        if (session.cancelRequested) {
          return {
            stopReason: "cancelled",
            response: { stopReason: "cancelled" },
          };
        }
        if (sawModelOutput) {
          if (this.absorbModelRejection(session.modelState, modelId, err))
            void this.discoverModels(session.apiKey, session.modelState, session.sdk);
        } else {
          const next = this.nextAttemptAfterRefusal(session, current, err, tried);
          if (next && !lastAttempt) {
            planned = next;
            continue;
          }
        }
        throw this.classify(err, "prompt");
      }
      session.activeRun = run;
      translator.bindRunIdentity(session.agent.agentId, run.id);
      // Stop clicked while `agent.send()` was still in flight — cancel()
      // saw activeRun=null and had nothing to abort, so without this the
      // run would stream to completion while the UI showed stopped.
      if (session.cancelRequested) {
        try {
          await run.cancel();
        } catch {
          /* best effort */
        }
      }

      // Poll children without native taskUpdate delivery once their transcript
      // ownership is known. Children already receiving callbacks skip disk. The
      // translator correlates calls/results across polls and reconciles final
      // results and marks uncaptured completion. ~1.2s balances liveness vs file churn.
      const SUBAGENT_POLL_MS = 1200;
      const pollTimer = setInterval(() => {
        if (!ownsUpdates()) return;
        void translator.pollSubagents(ownsUpdates).catch(() => {
          /* best-effort live update — flush is the authority */
        });
      }, SUBAGENT_POLL_MS);

      // Drain the stream, then settle on the run's final status. We DON'T
      // swallow failures: a genuine failure throws a classified AgentFailure
      // (→ AGENT_PROMPT_FAILED) rather than returning a clean-looking empty
      // turn (which would also wrongly re-light the green dot via markAuthOk).
      let streamError: unknown = null;
      let streamedUsage: TurnUsage | undefined;
      let waitResult: Awaited<ReturnType<SdkRun["wait"]>>;
      try {
        for await (const msg of run.stream()) {
          if (!ownsUpdates()) break;
          if (!translator.acceptsMessage(msg)) continue;
          const sdkMessage = msg as {
            type?: string;
            usage?: unknown;
          };
          if (!sawModelOutput && !isCursorRunControlFrame(sdkMessage.type)) {
            sawModelOutput = true;
            const waited = Date.now() - turnStartedAt;
            if (waited >= SLOW_FIRST_ITEM_MS) {
              this.ctx.emit.onAgentStderr(
                AGENT_ID,
                `[cursor-sdk] first model output after ${waited}ms — see the ` +
                  `[cursor-host] attribution lines above for what the Cursor ` +
                  `runtime was blocked on`,
              );
            }
          }
          if (sdkMessage.type === "usage") {
            streamedUsage = sumCursorUsage(streamedUsage, cursorTokenUsage(sdkMessage.usage));
          }
          if (CURSOR_MODEL_CONTENT_FRAMES.has(sdkMessage.type ?? "")) acceptAttempt();
          translator.feed(msg);
        }
        waitResult = await run.wait();
      } catch (err) {
        streamError = err;
      } finally {
        acceptingUpdates = false;
        clearInterval(pollTimer);
        // Stop/disposal revokes live reads. Final reads are bounded and awaited
        // before another turn can publish into this transcript.
        try {
          await translator.flushSubagents({
            readFinal: !session.cancelRequested,
            canReadFinal: () => !session.cancelRequested,
            ownsUpdates: () => this.sessions.get(opts.sessionId) === session && session.activeRun === run,
          });
        } finally { transcripts.dispose(); }
        if (session.activeRun === run) {
          session.activeRun = null;
          this.finishPendingSteers(session);
        }
      }

      // Capture usage on every terminal path, including failures and Stop.
      const usage = await session.billing.finish(opts.turnId, run.id,
        cursorTokenUsage(waitResult?.usage) ?? streamedUsage ?? callbackUsage);

      const runStatus =
        typeof waitResult?.status === "string"
          ? waitResult.status.toLowerCase()
          : null;
      // Stop is authoritative even when cancelling removed the host's run
      // before wait(), or when the stream omitted its final status frame.
      if (
        session.cancelRequested ||
        runStatus === "cancelled" ||
        translator.stopReason === "cancelled"
      ) {
        const stopReason: StopReason = "cancelled";
        return {
          stopReason,
          response: {
            stopReason,
            effectiveModel: waitResult?.model?.id ?? modelId,
            ...(usage ? { usage } : {}),
          } as PromptResponse,
        };
      }

      const waitError = waitResult?.error;
      const waitMessage = typeof waitError === "string"
        ? waitError
        : typeof waitError?.message === "string" ? waitError.message : undefined;
      const waitCode = typeof waitError === "object" && typeof waitError?.code === "string"
        ? waitError.code
        : typeof waitResult?.errorCode === "string" ? waitResult.errorCode : undefined;
      const terminalDetail = { message: waitMessage?.trim(), code: waitCode?.trim() };
      const hasWaitError = !!(terminalDetail.message || terminalDetail.code);
      const runErrored = runStatus === "error" || runStatus === "expired" || hasWaitError;
      const completed =
        runStatus === "finished" ||
        (runStatus === null && translator.sawTerminal && !translator.sawError);
      if (
        streamError == null &&
        !runErrored &&
        !translator.sawError &&
        !completed
      ) {
        throw new AgentFailureError({
          kind: "transport-closed",
          message:
            "Cursor disconnected before confirming that the turn finished.",
          stage: "prompt",
          agentId: AGENT_ID,
        });
      }

      // Success.
      if (streamError == null && !runErrored && !translator.sawError) {
        // A quiet success still proves the selection; narrate it before the
        // recovered answer so the notice keeps its place in source order.
        acceptAttempt();
        // The final result is authoritative even after commentary or partial
        // output. Reconcile it within this run instead of dropping it merely
        // because some assistant text was visible.
        translator.recoverFinalAnswer(waitResult?.result);
        const stopReason = translator.stopReason;
        return {
          stopReason,
          response: {
            stopReason,
            effectiveModel: waitResult?.model?.id ?? modelId,
            ...(usage ? { usage } : {}),
          } as PromptResponse,
        };
      }

      // The final error object is authoritative. Use the stream/store only
      // when it omitted details, and never classify our own recovery advice.
      const recovered = hasWaitError
        ? terminalDetail
        : streamError ?? translator.terminalFailure ?? (runStatus === "expired"
          ? { code: "session_expired", message: "Cursor run expired before completion." }
          : await this.readRunError(session, run.id));
      if (session.cancelRequested || this.sessions.get(opts.sessionId) !== session) {
        return { stopReason: "cancelled", response: { stopReason: "cancelled" } };
      }
      const native = normalizeProviderError("cursor", recovered ?? {
        message: `Cursor run ended in "${runStatus ?? "error"}" without an error message.`,
      });
      const refusal = recovered ?? { message: native.message };
      if (sawModelOutput) {
        if (this.absorbModelRejection(session.modelState, modelId, refusal))
          void this.discoverModels(session.apiKey, session.modelState, session.sdk);
      } else if (native.category === "model-unavailable") {
        // Refused before any output: try the account's other advertised
        // settings, then a curated fallback, so the user's turn still runs.
        const next = this.nextAttemptAfterRefusal(session, current, refusal, tried);
        if (next && !lastAttempt) {
          this.ctx.emit.onAgentStderr(
            AGENT_ID,
            `[cursor-sdk] ${describeCursorSelection(current.selection)} can't run locally on this ` +
              `account (${native.message.slice(0, 160)}); retrying with ` +
              `${describeCursorSelection(next.selection)}.`,
          );
          planned = next;
          continue;
        }
      }

      this.ctx.emit.onAgentStderr(AGENT_ID, `[cursor-sdk] turn failed: ${native.message}`);
      const failure = this.classify(recovered ?? { message: native.message }, "prompt");
      // Network-shaped (recoverable) stream death: the renderer is about to
      // reconnect — rebuild via Agent.resume (full server-side thread) and
      // resend, or keep a partially-streamed answer + AGENT STOPPED pill.
      // Leave a transcript row saying WHY the stream blipped (parity with the
      // Claude adapter's exhausted-retry row); without it the recovery was
      // completely silent. Cursor's SDK has no in-turn retry phase, so this
      // is a plain error row, not the live "Reconnecting agent" shimmer
      // (which would claim a vendor retry that isn't happening).
      if (failure.failure.kind === "transport-closed") {
        // Simple copy by design (UI-indication consolidation 2026-07-10):
        // the user can't act on host/stack detail — it's already logged via
        // onAgentStderr above for support/diagnosis.
        this.ctx.emit.onSessionUpdate(AGENT_ID, {
          sessionId: opts.sessionId,
          update: {
            sessionUpdate: "error_notice",
            noticeId: `cursor-neterr-${randomUUID()}`,
            severity: "error",
            recoverable: true,
            // Live reconnect status, then a quiet row; never a lasting banner.
            code: "connection_lost",
            message: "Connection lost — reconnecting…",
          },
        });
      }
      throw failure;
    }

    // Unreachable: every loop iteration returns or throws.
    throw new AgentFailureError({
      kind: "protocol-error",
      message: "Cursor could not complete the requested turn.",
      stage: "prompt",
      agentId: AGENT_ID,
    });
  }

  /** Local run.steer owns delivery acknowledgement; reference attachments are
   * ordinary text. Legacy native binary blocks must remain queued intact. */
  async steer(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<SteerOutcome> {
    const session = this.sessions.get(opts.sessionId);
    const run = session?.activeRun;
    if (
      !session ||
      !run?.steer ||
      session.compacting ||
      session.cancelRequested ||
      opts.prompt.some((block) => block.type !== "text")
    )
      return "queued";
    const text = opts.prompt
      .map((block) => (block as { text: string }).text)
      .join("\n\n");
    if (!text.trim()) return "queued";
    return new Promise((resolve) => {
      const pending = (session.pendingSteers ??= new Set());
      let submitted = false;
      const settle = (outcome: SteerOutcome) => {
        if (!pending.delete(settle)) return;
        resolve(outcome === "interrupted" && !submitted ? "queued" : outcome);
      };
      pending.add(settle);
      void Promise.resolve()
        .then(() => {
          if (
            session.cancelRequested ||
            session.activeRun !== run ||
            this.sessions.get(opts.sessionId) !== session
          )
            return "revert_to_followup";
          submitted = true;
          return run.steer!(text);
        })
        .then(
          (outcome) =>
            settle(
              outcome === "complete_delivered"
                ? "delivered"
                : outcome === "revert_to_followup"
                  ? "queued"
                  : "interrupted",
            ),
          () => settle("interrupted"),
        );
    });
  }

  private finishPendingSteers(session: Session): void {
    for (const settle of session.pendingSteers ?? []) settle("interrupted");
  }

  /** SDK 1.2 summarizes an existing idle conversation with a native run. Keep
   * it turnless: no user prompt or private summary text enters the transcript. */
  async compactContext(opts: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session || session.disposing) throw new AgentFailureError({
      kind: "session-expired", stage: "prompt", agentId: AGENT_ID, message: "Cursor session is no longer live.",
    });
    if (session.promptsInFlight > 0 || session.compacting || session.activeRun || session.preparingPrompt || session.configurationRefresh) {
      throw new Error("Cursor is busy. Wait for the current run to finish before compacting context.");
    }
    const agent = session.agent;
    if (!agent.summarize) throw new Error("Cursor SDK context compaction is unavailable.");
    session.cancelRequested = false;
    let run: SdkRun | undefined;
    const ownsSession = () => this.sessions.get(opts.sessionId) === session && !session.disposing && session.agent === agent;
    const translator = new CursorSdkTranslator({ sessionId: opts.sessionId, compactionTrigger: "manual",
      emit: event => { if (ownsSession()) this.ctx.emit.onSessionUpdate(AGENT_ID, event); } });
    let releasePrompts!: () => void;
    const compaction = {
      settled: new Promise<void>(resolve => { releasePrompts = resolve; }),
      stop: new AbortController(),
      flush: () => translator.flushSubagents({ readFinal: false, ownsUpdates: ownsSession }),
    };
    session.compacting = compaction;
    try {
      run = await agent.summarize();
      if (!ownsSession() || session.cancelRequested) { await run.cancel().catch(() => {}); return; }
      session.activeRun = run;
      translator.bindRunIdentity(agent.agentId, run.id);
      for await (const message of run.stream()) {
        if (!ownsSession() || session.cancelRequested || session.activeRun !== run) break;
        if (isRecord(message) && (message.type === "summary" || message.type === "status")) translator.feed(message);
      }
      if (!ownsSession() || session.cancelRequested) return;
      const result = await run.wait();
      if (!ownsSession() || session.cancelRequested || result?.status?.toLowerCase() === "cancelled") return;
      if (result?.error || translator.sawError || ["error", "expired"].includes(result?.status?.toLowerCase() ?? "")) {
        throw result?.error ?? translator.terminalFailure ?? new Error("Cursor context compaction failed.");
      }
      if (result?.status?.toLowerCase() !== "finished" && !translator.sawTerminal) {
        throw new Error("Cursor disconnected before confirming that context compaction finished.");
      }
    } catch (error) {
      await run?.cancel().catch(() => {});
      if (ownsSession() && !session.cancelRequested) throw this.classify(error, "prompt");
    } finally {
      try { await compaction.flush(); }
      finally {
        if (session.activeRun === run) session.activeRun = null;
        if (session.compacting === compaction) session.compacting = undefined;
        releasePrompts();
      }
    }
  }

  async cancel(opts: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (session) {
      session.cancelRequested = true;
      // Release the prompts waiting now. A fresh signal keeps this Stop from
      // cancelling prompts sent while the stopped summary unwinds.
      if (session.compacting) {
        session.compacting.stop.abort();
        session.compacting.stop = new AbortController();
      }
      session.preparingPrompt?.abort();
    }
    // Native cancel can finish after its run has settled and the user has
    // started another. Only reconcile requests owned at the Stop boundary.
    const pending = [...(session?.pendingSteers ?? [])];
    try {
      await session?.activeRun?.cancel();
    } catch {
      /* best effort */
    } finally {
      for (const settle of pending) settle("interrupted");
    }
  }

  async setMode(opts: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    // Cheap: just record the pick. Ask↔Full access is a per-send `mode` change;
    // toggling Auto flips the DESIRED autoReview, reconciled lazily by
    // ensureSessionConfiguration() on the next prompt (autoReview is create-time only).
    if (
      opts.modeId === "agent" ||
      opts.modeId === "plan" ||
      opts.modeId === "auto"
    ) {
      session.modeId = opts.modeId;
      // Still cheap — fire-and-forget — but it starts the workspace build that
      // reconcile will otherwise do inside the user's next send.
      this.prewarmForDesiredMode(session);
      this.ctx.emit.onSessionUpdate(AGENT_ID, {
        sessionId: opts.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: session.modeId },
      });
    }
  }

  /** Cursor accepts a model on every `agent.send`, so a composer model change
   * does not require replacing the SDK agent or losing its conversation. */
  async setModel(opts: { sessionId: string; model: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    const model = opts.model.trim();
    if (!session || !model) return;
    session.env = { ...(session.env ?? {}), CURSOR_MODEL: model };
    session.modelId = this.resolveModel(model, session.env, session.modelState, "setMode");
  }

  /** Apply the renderer's complete composer snapshot. Effort and Fast become
   * native model parameters for current models, with legacy suffixed variants
   * resolved when advertised, and are sent on the next run. Keys encoded by
   * omission must be removed first so toggling Fast off cannot leave stale
   * model settings selected. */
  async updateConfig(opts: {
    sessionId: string;
    env: Record<string, string>;
  }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    const carried = { ...(session.env ?? {}) };
    delete carried.CURSOR_MODEL;
    delete carried.ZEROS_THINKING_EFFORT;
    delete carried.ZEROS_FAST_MODE;
    delete carried.ZEROS_ADDITIONAL_DIRS;
    delete carried.ZEROS_PERMISSION_MODE;
    const env = { ...carried, ...opts.env };
    const modelId = this.resolveModel(
      env.CURSOR_MODEL,
      env,
      session.modelState,
      "setMode",
    );
    session.env = env;
    session.modelId = modelId;
  }

  /** Reconcile only between runs. A versioned gateway header is part of the
   * SDK's executor cache key: it isolates the refreshed catalog from running
   * siblings and stale prewarm leases. agent.reload() cannot do this safely:
   * in 1.0.31 it affects a shared executor and is a no-op before first send. */
  private async ensureSessionConfiguration(session: Session): Promise<void> {
    if (session.configurationRefresh) await session.configurationRefresh;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (session.disposing || this.sessions.get(session.zerosSessionId) !== session) return;
      const want = autoReviewFor(session.modeId);
      const catalog = this.mcpCatalog(session.mcpServers);
      const catalogChanged = catalog.key !== session.appliedMcpCatalog;
      const credentialChanged = session.apiKey !== session.appliedApiKey;
      if (!catalogChanged && !credentialChanged && want === session.appliedAutoReview) return;
      if (session.activeRun) throw new Error("Cursor MCP configuration cannot refresh during an active run.");
      const previous = session.agent;
      const apiKey = session.apiKey;
      const refresh = async () => {
        const sessionMcp = this.mcpServers(catalog.servers, session.env, session.cwd);
        const agent = await session.sdk.Agent.resume(previous.agentId, {
          apiKey,
          model: this.modelSelection(session.modelId, session.modelState, session.env, "loadSession"),
          cwd: session.cwd,
          local: this.buildLocalOpts(session.cwd, session.env, want, session.settingSources),
          ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
        });
        if (session.disposing || this.sessions.get(session.zerosSessionId) !== session) {
          agent.close?.();
          return;
        }
        // The host proxy owns an individual native handle, not just agentId;
        // releasing the old executor cannot close the replacement conversation.
        session.agent = agent;
        session.appliedApiKey = apiKey;
        session.appliedAutoReview = want;
        session.appliedMcpCatalog = catalog.key;
        if (previous !== agent) previous.close?.();
      };
      const pending = refresh();
      session.configurationRefresh = pending;
      try {
        await pending;
      } catch (err) {
        // Keep the prior mode-only recovery behavior. A stale tool catalog or
        // a replaced credential must instead fail before submitting the
        // prompt: the old handle would keep running under the previous key.
        if (catalogChanged || credentialChanged || session.apiKey !== session.appliedApiKey ||
            this.mcpCatalog(session.mcpServers).key !== session.appliedMcpCatalog) throw err;
        this.ctx.emit.onAgentStderr(AGENT_ID,
          `[cursor-sdk] Auto-review rebuild (autoReview=${want}) failed; keeping current agent: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        if (session.configurationRefresh === pending) session.configurationRefresh = undefined;
      }
      // Re-read after the await: a second publication cannot be acknowledged by
      // a handle created with the first revision. Bound pathological churn.
    }
    if (this.mcpCatalog(session.mcpServers).key !== session.appliedMcpCatalog ||
        session.apiKey !== session.appliedApiKey ||
        autoReviewFor(session.modeId) !== session.appliedAutoReview) {
      throw new Error("Cursor MCP configuration kept changing. Please retry the message.");
    }
  }

  /** Local connection change (API key or Cursor account). An agent handle is
   * bound to its key, so the next run resumes this agent under the new one
   * (ensureSessionConfiguration); a running turn keeps its handle. */
  async updateCredentials(opts: ProviderCredentialUpdate): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    const env = withProviderConnection(session.env, opts);
    // A removed key or signed-out account asks for a connection, exactly as a
    // new session would; it never falls back to the previous key.
    const apiKey = this.resolveApiKey(env);
    session.env = env;
    if (apiKey === session.apiKey) return;
    session.apiKey = apiKey;
    session.modelState = await this.activateModelState(apiKey);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Mark the teardown as deliberate BEFORE cancelling the run so an in-flight
    // prompt (which still holds this session reference) ends via the clean
    // cancel branch instead of throwing AGENT_PROMPT_FAILED. Matters when a
    // session is superseded mid-turn (one-live-session-per-chat teardown in the
    // engine) — mirrors the claude/codex deliberate-teardown semantics.
    session.billing?.dispose();
    session.cancelRequested = true;
    session.compacting?.stop.abort();
    session.preparingPrompt?.abort();
    // readFinal:false synchronously settles already-published summary rows.
    // Start that flush before fencing the emitter, with no await in between;
    // late native completion must never leave a retired row spinning.
    const compactionSettlement = session.compacting?.flush();
    session.disposing = true;
    await compactionSettlement?.catch(() => {});
    try {
      await session.activeRun?.cancel();
    } catch {
      // Best effort, and deliberately NOT fail-closed for the lifecycle reaper:
      // cancelling an already-finished run rejects routinely, and the SDK owns
      // the child either way — so a throw here says nothing about whether a
      // process survived. See CodexAppServerAdapter.disposeSession for the one
      // teardown that does observe a real process-group stop.
    }
    try {
      session.agent.close?.();
    } catch {
      /* ignore */
    }
    try {
      await (await session.store)?.dispose();
    } catch {
      /* best-effort store flush; boundary teardown remains authoritative */
    }
    await this.finalizeSessionRuntime({ dispose: session.disposeRuntime });
    this.finishPendingSteers(session);
    // Retain the cleanup handle until host stop succeeds. A fail-closed caller
    // can then retry in this same engine process.
    this.sessions.delete(sessionId);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) =>
        this.disposeSession(sessionId),
      ),
    );
  }

  /** Save-time key check for Settings → Providers → Cursor: one cheap
   *  authenticated call (models.list) with the CANDIDATE key — never the
   *  stored one — so a rejected key surfaces at Save instead of on the
   *  user's next prompt. ok=false only on a definitive provider rejection
   *  (native authentication code/401); anything else (network, SDK shape
   *  drift) is inconclusive → ok=null, caller saves normally. The key is
   *  never logged or retained here. */
  async validateApiKey(
    apiKey: string,
    opts?: {
      cwd: string;
      env?: Record<string, string>;
      executionBoundary?: PreparedBoundary;
    },
  ): Promise<{ ok: boolean | null; error?: string }> {
    let runtime: CursorSessionRuntime | undefined;
    try {
      runtime = opts?.executionBoundary
        ? await this.createSessionRuntime({
            cwd: opts.cwd,
            env: opts.env,
            executionBoundary: opts.executionBoundary,
          })
        : { sdk: await loadSdk() };
      if (!runtime.sdk.Cursor?.models?.list) return { ok: null };
      await runtime.sdk.Cursor.models.list({ apiKey });
      return { ok: true };
    } catch (err) {
      const rejected = normalizeProviderError("cursor", err).category === "auth-required";
      return rejected
        ? { ok: false, error: "Cursor rejected this API key." }
        : { ok: null };
    } finally {
      if (runtime?.dispose) {
        await this.finalizeSessionRuntime(runtime);
      }
    }
  }

  // ── helpers ─────────────────────────────────────────────

  private resolveApiKey(env?: Record<string, string>): string {
    const key = (env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY)?.trim();
    if (!key) {
      throw new AgentFailureError({
        kind: "auth-required",
        message:
          "Connect your Cursor account or add an API key in Settings → Providers → Cursor.",
        agentId: AGENT_ID,
      });
    }
    return key;
  }

  /** @cursor/sdk LocalAgentOptions. Enables the SDK's coarse sandbox —
   *  the closest native substitute for a permission round-trip (which the
   *  SDK doesn't expose) — when CURSOR_SANDBOX=1 is in the session env.
   *  Default OFF: full tool access, matching the CLI's behaviour. Set at
   *  create time, so it applies for the whole session.
   *  `autoReview` is the "Auto" mode's classifier gate — also create-time,
   *  which is why a mode change into/out of Auto needs a rebuild. */
  private buildLocalOpts(
    cwd: string,
    env: Record<string, string> | undefined,
    autoReview: boolean,
    settingSources: CursorSettingSources,
  ): Record<string, unknown> {
    // Multi-root parity with Claude's `--add-dir` (`/add-dir` writes
    // ZEROS_ADDITIONAL_DIRS). @cursor/sdk 1.0.28 added `local.dirs` for exactly
    // this: `cwd` stays the primary root (default shell cwd and agent-store
    // scoping) while `dirs` widens which folders project rules, skills, and
    // request-context metadata are loaded from. Before 1.0.28 there was no way
    // to express it, so an added directory was silently invisible to Cursor even
    // though the selected boundary had already granted the session authority.
    const additionalDirs = parseCursorAdditionalDirs(
      env?.ZEROS_ADDITIONAL_DIRS,
    ).filter((dir) => dir !== cwd);
    const local: Record<string, unknown> = {
      cwd,
      ...(additionalDirs.length > 0 ? { dirs: [cwd, ...additionalDirs] } : {}),
      ...(autoReview ? { autoReview: true } : {}),
      // Admission-time settings layers (see cursorSettingSources). Dashboard
      // MCP still belongs to Cursor-hosted execution.
      settingSources: [...settingSources],
    };
    if (env?.CURSOR_SANDBOX === "1") {
      local.sandboxOptions = { enabled: true };
    }
    return local;
  }

  /** Only an engine-owned, exact-endpoint revision may partition the SDK
   * cache. This header contains no credentials and is neither persisted nor
   * forwarded to backend MCP servers. Preserve the user's registry verbatim. */
  private mcpCatalog(override?: McpServerRegistration[]): { key: string; servers: McpServerRegistration[] } {
    const revisions: Array<[string, string, string]> = [];
    const servers = (override ?? this.ctx.mcpServers).map((server) => {
      const revision = this.ctx.mcpCatalogRevision?.(server);
      if (server.transport === "stdio" || revision === undefined) return server;
      revisions.push([server.name, server.url, revision]);
      return { ...server, headers: { ...server.headers, "X-Zeros-Mcp-Catalog": revision } };
    });
    return { key: JSON.stringify(revisions), servers };
  }

  /** Render the MCP registry into @cursor/sdk's shape. `override` is the
   *  gateway-resolved per-session registry (user + repo + workspace layers,
   *  RCE-gated); undefined → the global ctx.mcpServers. */
  private mcpServers(
    override?: McpServerRegistration[],
    env: Readonly<Record<string, string | undefined>> = {},
    cwd = this.ctx.projectRoot,
  ): Record<string, CursorMcpConfig> | null {
    const list = materializeMcpServerRegistrations(
      override ?? this.ctx.mcpServers,
      env,
    );
    if (list.length === 0) return null;
    return Object.fromEntries(
      list.map((s) => [
        s.name,
        s.transport === "stdio"
          ? {
              command: s.command,
              ...(s.cwd ? { cwd: mcpWorkingDirectory(s.cwd, cwd) } : {}),
              ...(s.args ? { args: s.args } : {}),
              ...(s.env ? { env: s.env } : {}),
            }
          : { type: s.transport, url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
      ]),
    );
  }

  private classify(
    err: unknown,
    stage: "newSession" | "loadSession" | "prompt",
  ): AgentFailureError {
    if (err instanceof AgentFailureError) return err;
    return classifyCursorSdkError(err, stage);
  }
}

/** Preserve host-specific recovery, then map the normalized native category
 * into the shared failure taxonomy. Advice is never classification input. */
export function classifyCursorSdkError(
  err: unknown,
  stage: "newSession" | "loadSession" | "prompt",
): AgentFailureError {
  if (err instanceof AgentFailureError) return err;
  const native = normalizeProviderError("cursor", err);
  const message = native.message;
  // 0. An UNEXPECTED Cursor host death (tagged by host-client.onExit). The
  //    host lazily respawns on the next call, so this is transport-closed
  //    (RECOVERABLE → the renderer silently rebuilds + resends) — the user
  //    used to get a hard "Agent error" toast even though the very next send
  //    worked. Checked by explicit code, not message wording, so it can't
  //    drift. True spawn failures ("couldn't start the Cursor SDK host") and
  //    fatal-preceded deaths carry NO tag and stay terminal below — a respawn
  //    would fail identically there.
  const hostCode = (err as { code?: unknown } | null | undefined)?.code;
  if (hostCode === CURSOR_HOST_EXITED_CODE) {
    return new AgentFailureError({
      kind: "transport-closed",
      message:
        `cursor-sdk ${stage} failed: ${message}. The host respawns on the ` +
        `next call — retrying.`,
      stage,
      agentId: AGENT_ID,
    });
  }
  // 0b. The crash-loop guard tripped (repeated boot deaths). TERMINAL — but
  //     the fix instructions must reach the USER, and the toast layer drops
  //     technical `message` detail (UI-indication consolidation 2026-07-10).
  //     `advice` is the explicit carve-out: the toast shows it as the
  //     description, at every stage.
  if (hostCode === CURSOR_HOST_CRASH_LOOP_CODE) {
    return new AgentFailureError({
      kind: "protocol-error",
      message: `cursor-sdk ${stage} failed: ${message}`,
      stage,
      agentId: AGENT_ID,
      advice: CURSOR_HOST_CRASH_LOOP_ADVICE,
    });
  }
  // TLS / certificate failures connecting to Cursor's HTTP/2 backend. The SDK
  // streams the turn over TLS to api2.cursor.sh, so a cert that doesn't validate
  // ("self-signed certificate", "unable to verify", a real altname mismatch)
  // means something on the MACHINE's network path is intercepting HTTPS
  // (antivirus web/SSL scanning, a corporate proxy/MDM, or a debug proxy like
  // Proxyman/Charles) — NOT a model/auth problem. NOTE: the bun runtime used to
  // raise the SAME family of errors *spuriously* (it mis-parses Cursor's valid
  // cert under node:http2 — see host/cursor-host.cjs); that path now runs in the
  // Node host, so reaching here means a genuine interception. The raw Node error
  // is cryptic, so we name the cause and the fix. Terminal (protocol-error)
  // because a silent retry to the same intercepted path just fails again; the
  // user must trust the CA or disable inspection.
  if (native.category === "protocol-error" && TLS_CERT_RX.test(`${native.code ?? ""} ${message}`)) {
    return new AgentFailureError({
      kind: "protocol-error",
      message:
        `cursor-sdk ${stage} failed: couldn't establish a secure (TLS) ` +
        `connection to Cursor (${message}). This is a network/proxy issue, ` +
        `not your model or login — usually HTTPS-inspecting software ` +
        `(antivirus "web/SSL scan", a corporate proxy/MDM, or a debug proxy ` +
        `like Proxyman/Charles). Fix: allow/trust *.cursor.sh and ` +
        `*.cursor.com (disable HTTPS inspection for them), or point ` +
        `NODE_EXTRA_CA_CERTS at the intercepting proxy's root CA, then retry.`,
      stage,
      agentId: AGENT_ID,
    });
  }
  // Local SDK 1.0.31 can erase the error class/code while persisting a failed
  // refresh, leaving only these SDK-owned prefixes (observed on a 503 exchange).
  // Retain connection recovery for that narrow case. Explicit native status /
  // codes and TLS failures above still own their existing recovery semantics.
  if (
    native.category === "protocol-error" &&
    native.status === undefined &&
    (!native.code || native.code.toLowerCase() === "unknown") &&
    /^(?:\[unknown\]\s*)?(?:Server error during API key exchange:|Failed to connect to API key exchange endpoint:)/i.test(message)
  ) {
    return providerErrorFailure(
      "cursor",
      { ...native, category: "transport-closed" },
      stage,
    );
  }
  return providerErrorFailure("cursor", native, stage);
}

/** ContentBlock[] → the SDK's `{ text, images }` user message. Text
 *  blocks concatenate; image blocks map to SDKImage (base64 or url). */
function buildUserMessage(blocks: ContentBlock[]): {
  text: string;
  images?: Array<{ data: string; mimeType: string } | { url: string }>;
} {
  const texts: string[] = [];
  const images: Array<{ data: string; mimeType: string } | { url: string }> =
    [];
  for (const raw of blocks) {
    const b = raw as unknown as {
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
      uri?: string;
    };
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    } else if (b.type === "image") {
      if (b.data && b.mimeType)
        images.push({ data: b.data, mimeType: b.mimeType });
      else if (b.uri) images.push({ url: b.uri });
    }
  }
  return { text: texts.join("\n\n"), ...(images.length ? { images } : {}) };
}
