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

import { createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { isAbsolute } from "node:path";
import { providerBindingForResume } from "@zeros/protocol/identities";
import type { AdvertisedModel } from "@zeros/protocol/agent-events";
import { isDevRuntime } from "../../../runtime";
import modelCatalogJson from "../../../../../../../catalogs/models-v1.json";

import { AgentFailureError } from "../../types";
import { materializeMcpServerRegistrations } from "../../mcp-registration";
import { SESSION_EXPIRED_KEYWORDS } from "../shared/session-expiry";
import type {
  AgentAdapter,
  AgentAdapterContext,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServerRegistration,
  NewSessionResponse,
  PromptResponse,
  SessionMode,
  StopReason,
  TurnUsage,
} from "../../types";
import { advertiseAgentCapabilities } from "../../capabilities";
import { CursorSdkTranslator } from "./translator";
import {
  loadSubagentTranscript,
  loadSubagentTranscriptByPath,
  findSubagentByPrompt,
} from "./subagent-transcript";
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
/** Preferred concrete fallbacks, in order, when the resolved model isn't in
 *  the account's live catalog. Native Composer models need no external auth. */
const FALLBACK_MODEL_PREFERENCE = [
  "composer-2.5",
  "composer-2",
  "composer-1.5",
];

/** Models to RETRY with when the selected model can't actually RUN on this
 *  account's local runtime — distinct from the catalog check above, because a
 *  model can be in the catalog (api.cursor.com) yet be rejected by the local
 *  RunSSE backend. `composer-2` is confirmed to run on local SDK agents on all
 *  plans (forum.cursor.com #160019); the frontier "Max Mode" models silently
 *  error on plan-gated accounts. composer-1.5 is the older concrete fallback.
 *  Ordered most-capable-confirmed-good first. */
const LOCAL_RETRY_MODELS = ["composer-2", "composer-1.5"];

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
 *  well below the stall this exists to make visible — a contained host's FIRST
 *  turn has been measured at 77s while later turns in the same host take ~4s.
 *  Mirrors SLOW_FIRST_ITEM_MS in host/cursor-host.cjs, which reports the same
 *  window broken down by outbound request and child process. */
const SLOW_FIRST_ITEM_MS = 5_000;

/** Stream frames that are the SDK acknowledging the run locally rather than the
 *  model answering. Both land within ~10ms of `send` even on a turn whose first
 *  token takes 77s, so time-to-first-output must be measured past them. Mirrors
 *  RUN_CONTROL_FRAME_TYPES in host/cursor-host.cjs. */
const CURSOR_RUN_CONTROL_FRAMES = new Set(["request", "status"]);
function isCursorRunControlFrame(type: string | undefined): boolean {
  return CURSOR_RUN_CONTROL_FRAMES.has(type ?? "");
}

/** True when a Cursor run's recovered error reason means the chosen MODEL
 *  can't run on this account's local runtime (vs an auth/network/transient
 *  failure). The canonical case is a "Max Mode" model that the local runtime
 *  can't enable for the user's plan — the SDK accepts the id but the RunSSE
 *  backend rejects it. Retrying with a confirmed-good model recovers the turn;
 *  retrying an auth/plan/network failure would not, so those are NOT matched. */
export function isCursorModelGatedError(message: string): boolean {
  return /max\s*mode|cannot\s+use\s+this\s+model|unsupported\s+model|\bmodel\b[^.]{0,60}\b(?:not\s+supported|not\s+available|unavailable|not\s+enabled|requires)/i.test(
    message,
  );
}

/** TLS / certificate verification failures (Node's ERR_TLS_* family + the
 *  OpenSSL chain errors). The hallmark of HTTPS interception on the network
 *  path to Cursor's servers — a substitute cert that doesn't validate. */
const TLS_CERT_RX =
  /altnames|ERR_TLS_CERT_ALTNAME_INVALID|does\s+not\s+contain\s+a\s+DNS\s+name|self[-\s]?signed\s+certificate|unable\s+to\s+(?:verify|get\s+local\s+issuer)|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS|certificate\s+(?:has\s+expired|is\s+not\s+yet\s+valid)/i;

/** Plain socket/DNS reachability errors — usually transient. */
const NETWORK_ERR_RX =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|socket\s+hang\s*up|getaddrinfo|network\s+(?:error|timeout|unreachable)/i;

/** Resolve an explicit Cursor model id, defaulting only an absent pick. */
export function resolveCursorModelId(envModel: string | undefined): string {
  const m = envModel?.trim();
  if (!m) return DEFAULT_MODEL;
  const normalized = m.toLowerCase();
  if (CURSOR_AUTO_IDS.has(normalized)) return normalized;
  return m;
}

/** Validate a concrete model id against the account's live catalog, falling
 *  back to a known-good one when it isn't offered. Pure (exported for tests).
 *  `available === null` means "catalog not discovered yet" → trust the id
 *  (the SDK still validates and we surface its error cleanly). */
export function resolveValidModelId(
  modelId: string,
  available: Set<string> | null,
): string {
  if (!available || available.has(modelId)) return modelId;
  for (const pref of FALLBACK_MODEL_PREFERENCE) {
    if (available.has(pref)) return pref;
  }
  // Last resort: any concrete Composer model the account offers, else the
  // first listed model. Never returns an auto-select placeholder.
  const composer = [...available].find((id) => /^composer/i.test(id));
  return composer ?? [...available][0] ?? modelId;
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
// Auto mid-chat rebuilds the agent — see ensureAutoReview().
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
  /** Run id — needed to look the terminal error up in the SDK's local store
   *  (the only place the real reason survives; see CursorLocalStore). */
  readonly id?: string;
  stream(): AsyncGenerator<unknown, void> | AsyncIterable<unknown>;
  // NOTE: the SDK's public `RunResult` from wait() only carries `status` +
  // `result` — it deliberately DROPS `errorCode` (where the real reason
  // lives). So on an error/expired run wait() returns nothing useful; the
  // detail must be read from the local store via CursorLocalStore. We keep
  // these optional fields for forward-compat but never rely on them.
  wait(): Promise<
    | {
        status?: string;
        result?: string;
        errorCode?: string;
        error?: string;
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
}

export interface SdkAgent {
  readonly agentId: string;
  send(message: unknown, options?: CursorSdkSendOptions): Promise<SdkRun>;
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

type CuratedCursorModel = {
  value: string;
  effortLevels?: string[];
  supportsFast?: boolean;
};

const CURSOR_EFFORT_PARAMETER_RX = /effort|reason|thinking/i;
const CURSOR_FAST_PARAMETER_RX = /speed|fast/i;

/** Parameter names verified against @cursor/sdk 1.0.31's models.list wire.
 * The capability values stay owned by catalogs/models-v1.json, so the cold
 * path cannot grow a second model menu or drift from renderer validation. */
const CURSOR_CURATED_PARAMETER_WIRES: Readonly<
  Record<string, { effort?: string; fast?: string }>
> = {
  "grok-4.6": { effort: "effort", fast: "fast" },
};

/** Build the native parameter record used only while asynchronous provider
 * discovery is absent. Once a live record exists—even one with explicit empty
 * values—it wins in full and this fallback is not consulted. */
function curatedCursorModelWire(id: string): CursorModelListItem | undefined {
  const wire = CURSOR_CURATED_PARAMETER_WIRES[id];
  if (!wire) return undefined;
  const curated = (
    modelCatalogJson.families.cursor as CuratedCursorModel[]
  ).find((candidate) => candidate.value === id);
  if (!curated) return undefined;
  const parameters: CursorModelParameter[] = [];
  if (wire.effort && Array.isArray(curated.effortLevels)) {
    parameters.push({
      id: wire.effort,
      values: curated.effortLevels.map((value) => ({ value })),
    });
  }
  if (wire.fast && typeof curated.supportsFast === "boolean") {
    parameters.push({
      id: wire.fast,
      values: [
        { value: "false" },
        ...(curated.supportsFast ? [{ value: "true" }] : []),
      ],
    });
  }
  return { id, parameters };
}

/** Merge only capabilities a live record did not answer. Parameter presence is
 * authoritative even when its values are empty/false-only; absence is unknown
 * and inherits the verified curated wire so asynchronous partial discovery
 * cannot discard a selection the renderer still exposes. */
function cursorModelWireWithCuratedFallback(
  id: string,
  live: CursorModelListItem | undefined,
): CursorModelListItem | undefined {
  const fallback = curatedCursorModelWire(id);
  if (!live || !fallback) return live ?? fallback;
  const liveParameters = live.parameters ?? [];
  const missingParameters = (fallback.parameters ?? []).filter((candidate) => {
    if (CURSOR_EFFORT_PARAMETER_RX.test(candidate.id)) {
      return !liveParameters.some((parameter) =>
        CURSOR_EFFORT_PARAMETER_RX.test(parameter.id),
      );
    }
    if (CURSOR_FAST_PARAMETER_RX.test(candidate.id)) {
      return !liveParameters.some((parameter) =>
        CURSOR_FAST_PARAMETER_RX.test(parameter.id),
      );
    }
    return !liveParameters.some((parameter) => parameter.id === candidate.id);
  });
  if (missingParameters.length === 0) return live;
  return { ...live, parameters: [...liveParameters, ...missingParameters] };
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

function cursorTurnUsage(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof usage[key] === "number" &&
    Number.isFinite(usage[key]) &&
    (usage[key] as number) >= 0
      ? (usage[key] as number)
      : undefined;
  const result: TurnUsage = {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    cacheReadTokens: number("cacheReadTokens"),
    cacheWriteTokens: number("cacheWriteTokens"),
    reasoningTokens: number("reasoningTokens"),
  };
  return Object.values(result).some((value) => value !== undefined)
    ? result
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeDelta(after: number, before: number): number {
  return Math.max(0, after - before);
}

/** Convert Cursor's cumulative, provider-billed agent usage into one Zeros
 * turn. Counter regressions can occur when the provider reconciles or resets a
 * local usage group; clamp those fields independently rather than reporting a
 * negative bill. chargedCents (not rawCostCents) is the amount the account was
 * actually charged, including discounts/plan inclusion. */
export function cursorAgentUsageDelta(
  before: CursorAgentUsage | undefined,
  after: CursorAgentUsage | undefined,
): TurnUsage | undefined {
  if (!before || !after) return undefined;
  const usage: TurnUsage = {
    inputTokens: nonNegativeDelta(
      after.usage.inputTokens,
      before.usage.inputTokens,
    ),
    outputTokens: nonNegativeDelta(
      after.usage.outputTokens,
      before.usage.outputTokens,
    ),
    cacheReadTokens: nonNegativeDelta(
      after.usage.cacheReadTokens,
      before.usage.cacheReadTokens,
    ),
    cacheWriteTokens: nonNegativeDelta(
      after.usage.cacheWriteTokens,
      before.usage.cacheWriteTokens,
    ),
    ...(after.usage.reasoningTokens !== undefined ||
    before.usage.reasoningTokens !== undefined
      ? {
          reasoningTokens: nonNegativeDelta(
            after.usage.reasoningTokens ?? 0,
            before.usage.reasoningTokens ?? 0,
          ),
        }
      : {}),
    ...(after.cost && before.cost
      ? {
          totalCostUsd:
            nonNegativeDelta(
              after.cost.chargedCents,
              before.cost.chargedCents,
            ) / 100,
        }
      : {}),
  };
  return Object.values(usage).some(
    (value) => typeof value === "number" && value > 0,
  )
    ? usage
    : undefined;
}

function mergeCursorTurnUsage(
  streamed: TurnUsage | undefined,
  billed: TurnUsage | undefined,
): TurnUsage | undefined {
  if (!streamed) return billed;
  if (!billed) return streamed;
  return {
    inputTokens: streamed.inputTokens ?? billed.inputTokens,
    outputTokens: streamed.outputTokens ?? billed.outputTokens,
    cacheReadTokens: streamed.cacheReadTokens ?? billed.cacheReadTokens,
    cacheWriteTokens: streamed.cacheWriteTokens ?? billed.cacheWriteTokens,
    reasoningTokens: streamed.reasoningTokens ?? billed.reasoningTokens,
    totalCostUsd: billed.totalCostUsd ?? streamed.totalCostUsd,
  };
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
 * only the common capabilities Zeros already knows how to render. */
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
    selectable:
      typeof item.selectable === "boolean"
        ? item.selectable
        : typeof item.supportsLocal === "boolean"
          ? item.supportsLocal
          : true,
    ...(effortParameters.length > 0 ? { effortLevels } : {}),
    ...(supportsFast || hasSpeedMetadata ? { supportsFast } : {}),
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

/** What we hand @cursor/sdk's `mcpServers` — structurally a Cursor
 *  McpServerConfig (the SDK infers stdio from `command`, http from `url`; the
 *  `type` field is optional). */
type CursorMcpConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };
/** The SDK's on-disk SQLite store. The ONLY surface that exposes a run's
 *  terminal `error` (= the persisted `errorCode`), which `run.wait()` hides.
 *  Opened lazily per cwd and reused; defaults its state root to the same
 *  location the SDK writes to (getDefaultSdkStateRoot(cwd)), so reads see the
 *  rows the agent's own runs wrote. */
export interface CursorLocalRunDoc {
  status?: string;
  error?: string | null;
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
   *  contained host. Resolving a workspace (rules, skills, MCP, ignore
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

/** Select the SDK's ripgrep executable from already-qualified deployment
 * configuration. Packaged Zeros stages one binary for ZSR and Cursor; the
 * compiled engine cannot resolve the source package, so ignoring that staged
 * path produced a burst of "Ripgrep path not configured" errors per session. */
export function cursorRipgrepPathFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = env.CURSOR_RIPGREP_PATH?.trim();
  if (explicit) return explicit;
  const staged = env.ZEROS_ZSR_RIPGREP_PATH?.trim();
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

interface Session {
  /** Zeros-owned live execution route; deliberately not the SDK agent id. */
  zerosSessionId: string;
  cwd: string;
  apiKey: string;
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
  /** Set by cancel() so the prompt loop can distinguish a user-requested
   *  abort (benign — keep the translator's `cancelled` stop reason) from a
   *  genuine mid-stream failure (which must surface as an AgentFailure, not
   *  a silent empty turn). Reset at the start of each prompt. */
  cancelRequested: boolean;
  /** Session env + MCP registry, kept so ensureAutoReview() can rebuild the
   *  agent (Agent.resume) with the SAME sandbox/MCP wiring when the user
   *  toggles into/out of Auto mode — autoReview is create-time only. */
  env?: Record<string, string>;
  mcpServers?: McpServerRegistration[];
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
}

interface CursorModelState {
  fingerprint: string | null;
  discoveredModelIds: Set<string> | null;
  discoveredModels: Map<string, CursorModelListItem>;
  discoveredModelAliases: Map<string, string>;
  deniedModels: Set<string>;
  discovery: Promise<void> | null;
}

function createCursorModelState(fingerprint: string | null): CursorModelState {
  return {
    fingerprint,
    discoveredModelIds: null,
    discoveredModels: new Map(),
    discoveredModelAliases: new Map(),
    deniedModels: new Set(),
    discovery: null,
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
    configuration: {
      readProvenance: async (opts) =>
        configurationProvenanceFor("cursor", {
          protectedTerritory: Boolean(opts.territory),
          suppressUnsafeSources: Boolean(
            opts.territory && !opts.executionBoundary,
          ),
        }),
    },
  } satisfies import("../../types").AgentCapabilityPorts;
  private readonly ctx: AgentAdapterContext;
  private readonly sessions = new Map<string, Session>();
  private cachedInitialize: InitializeResponse | null = null;
  /** The most recently activated account feeds initialize metadata and new
   * admissions. Existing sessions retain the state object captured for their
   * own API key. */
  private modelState = createCursorModelState(null);
  constructor(ctx: AgentAdapterContext) {
    this.ctx = ctx;
  }

  async initialize(): Promise<InitializeResponse> {
    if (!this.cachedInitialize) {
      this.cachedInitialize = {
        protocolVersion: 1,
        agentInfo: { name: "Cursor Agent", version: "sdk" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true, // SDKImage — base64 or url
            audio: false,
            embeddedContext: false,
          },
        },
        // Model pill writes CURSOR_MODEL; newSession reads it. modelsDynamic
        // tells the gateway to re-read initialize after a real contained
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
    return advertiseAgentCapabilities(this, this.cachedInitialize);
  }

  /** Pull the account's model catalog once and cache it: validates model
   *  picks (resolveValidModelId) and feeds the picker via
   *  cachedInitialize._meta.models. Best-effort — failures leave the bundled
   *  catalog in place. */
  private async activateModelState(apiKey: string): Promise<CursorModelState> {
    const fingerprint = await cursorModelStateFingerprint(
      apiKey,
      CURSOR_MODEL_STATE_FINGERPRINT_SALT,
    );
    if (this.modelState.fingerprint === fingerprint) return this.modelState;
    this.modelState = createCursorModelState(fingerprint);
    if (this.cachedInitialize?._meta) {
      const meta = { ...this.cachedInitialize._meta };
      delete meta.models;
      this.cachedInitialize = { ...this.cachedInitialize, _meta: meta };
    }
    return this.modelState;
  }

  private async discoverModels(
    apiKey: string,
    state: CursorModelState,
    sessionSdk?: CursorSdkModule,
  ): Promise<void> {
    if (state.discovery) return state.discovery;
    state.discovery = (async () => {
      try {
        const sdk = sessionSdk ?? (await loadSdk());
        if (!sdk.Cursor?.models?.list) return;
        const list = await sdk.Cursor.models.list({ apiKey });
        const ids = new Set<string>();
        const records = new Map<string, CursorModelListItem>();
        const aliases = new Map<string, string>();
        const models: AdvertisedModel[] = [];
        for (const m of list ?? []) {
          const advertised = cursorAdvertisedModel(m);
          if (!advertised) continue;
          const id = advertised.value;
          records.set(id, m);
          models.push(advertised);
          if (advertised.selectable) ids.add(id);
          for (const alias of advertised.aliases ?? []) {
            aliases.set(alias, id);
            if (advertised.selectable) ids.add(alias);
          }
        }
        if (models.length === 0) return;
        state.discoveredModelIds = ids;
        state.discoveredModels = records;
        state.discoveredModelAliases = aliases;
        models.sort((a, b) => a.label.localeCompare(b.label));
        if (this.modelState !== state) return;
        // Direct adapter tests and one-shot consumers may call newSession
        // before initialize. Materialize the base snapshot here so discovery
        // is never lost merely because call order differed from the gateway's.
        if (!this.cachedInitialize) await this.initialize();
        const meta = this.cachedInitialize?._meta ?? {};
        this.cachedInitialize = {
          ...(this.cachedInitialize as InitializeResponse),
          _meta: { ...meta, models },
        };
      } catch (err) {
        // Reset the guard so a later session can retry the catalog pull.
        state.discovery = null;
        this.ctx.emit.onAgentStderr(
          AGENT_ID,
          `[cursor-sdk] model discovery failed: ${String(err)}`,
        );
      }
    })();
    return state.discovery;
  }

  private modelSelection(
    modelId: string,
    state: CursorModelState = this.modelState,
    env?: Record<string, string>,
  ): CursorModelSelection {
    const id = state.discoveredModelAliases.get(modelId) ?? modelId;
    // Live presence is authoritative, including explicit empty parameters.
    // The curated wire fills only cold/rejected or field-level unknowns,
    // keeping the user's Grok effort/Fast choice on create/resume/send without
    // a network wait while explicit live empty/false answers still win.
    const model = cursorModelWireWithCuratedFallback(
      id,
      state.discoveredModels.get(id),
    );
    return cursorModelSelection(
      id,
      model,
      env?.ZEROS_THINKING_EFFORT,
      env?.ZEROS_FAST_MODE === "1",
    );
  }

  /** Start catalog discovery without putting it on the session critical path.
   *
   * Discovery is a real network round-trip — and under ZSR it is the FIRST one
   * this session's contained host makes, so it also pays the host's cold Node
   * start, the SDK require, and the proxy's first CONNECT. It used to be awaited
   * outright before `Agent.create`, bounded only by the host's 30 s control-request
   * timeout: on a slow or wedged network that is 30 s of "Cursor is stuck" before
   * a single byte of the user's prompt moves.
   *
   * The catalog is an OPTIMIZATION, not a correctness input: `resolveModel`
   * validates against it when present and passes the user's pick through
   * untouched when it is not (`resolveValidModelId(base, undefined)`), and a
   * genuinely unavailable model still surfaces the provider's own "Cannot use
   * this model" error. Let discovery finish in the background and let the next
   * session (and the model picker, via `modelsDynamic`) enjoy the result. Even
   * a bounded wait visibly serialized two independent provider requests for a
   * cold account. */
  private async startModelDiscoveryForSession(
    apiKey: string,
    sessionSdk: CursorSdkModule,
  ): Promise<CursorModelState> {
    const state = await this.activateModelState(apiKey);
    const discovery = this.discoverModels(apiKey, state, sessionSdk);
    // discoverModels classifies and reports failures itself. Keep a terminal
    // sink anyway so future refactors cannot turn this deliberately detached
    // optimization into an unhandled rejection.
    void discovery.catch(() => undefined);
    // Yield one microtask only. A catalog already cached by the SDK can enrich
    // this very session (aliases/default params included), while a real network
    // request cannot serialize Agent.create even for one timer tick.
    await Promise.resolve();
    return state;
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
        "a contained Cursor host requires a complete environment",
      );
    }
    const env = { ...opts.env };
    if (process.env.CURSOR_RIPGREP_PATH && !env.CURSOR_RIPGREP_PATH) {
      env.CURSOR_RIPGREP_PATH = process.env.CURSOR_RIPGREP_PATH;
    }
    // Every shipped local and cloud boundary is host parity. Cursor therefore
    // writes the durable per-workspace store directly; generation-private
    // overlays are retained only as a boot-recovery format for older builds.
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
   *  A cold contained turn spends its time on work that has nothing to do with
   *  the message: a serial staircase of fresh connections to the Cursor backend
   *  (repeated API-key exchanges, server config, feature gates) plus the
   *  workspace scan — measured at 21.8s to first token, ~72% of it network,
   *  against ~4s uncontained. Meanwhile the host sits idle for ~9s between boot
   *  and the prompt while admission, model discovery and `Agent.create` finish.
   *  This fills that window.
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
      const sessionMcp = this.mcpServers(opts.mcpServers, opts.env);
      void Promise.resolve(
        sdk.platform.prewarm({
          apiKey,
          cwd: opts.cwd,
          local: this.buildLocalOpts(opts.cwd, opts.env, autoReview),
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
   *  ensureAutoReview() reconciles the agent lazily at prompt time — correct,
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
        ...(session.env ? { env: session.env } : {}),
        ...(session.mcpServers ? { mcpServers: session.mcpServers } : {}),
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
  ): string {
    // Env-var names are Zeros conventions (mirror EFFORT_ENV_VAR /
    // FAST_MODE_ENV_VAR in model-catalog.ts, which is renderer-side and must not
    // be imported into the engine). The Claude/Codex adapters read the same
    // literals. envForChatSettings emits ZEROS_FAST_MODE only when ON ("1").
    const effort = env?.ZEROS_THINKING_EFFORT;
    const fast = env?.ZEROS_FAST_MODE === "1";
    const requested = envModel?.trim();
    // Cursor SDK 1.0.31 exposes Auto as canonical `default` plus alias `auto`.
    // Discovery canonicalizes the alias, while a cold selection stays intact
    // for the SDK's own model-list validator to canonicalize. Only an absent
    // selection takes the concrete Composer fallback.
    const liveRequested =
      requested && state.discoveredModelIds?.has(requested)
        ? (state.discoveredModelAliases.get(requested) ?? requested)
        : undefined;
    const base = liveRequested ?? resolveCursorModelId(envModel);
    // Apply the reasoning swap before catalog validation. The curated Grok
    // base is the level-free `grok-4.5`, which is NOT a live id itself:
    // validating it first would fall back to Composer before the effort
    // suffix could ever apply. applyCursorReasoning only ever returns ids
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

  /** Pick a confirmed-good local model different from `failed` (and not
   *  already denied, and present in the account's catalog when known). null
   *  when there's nothing else worth trying. */
  private pickRetryModel(
    failed: string,
    state: CursorModelState = this.modelState,
  ): string | null {
    for (const m of LOCAL_RETRY_MODELS) {
      if (m === failed || state.deniedModels.has(m)) continue;
      if (!state.discoveredModelIds || state.discoveredModelIds.has(m))
        return m;
    }
    return null;
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

  /** Recover the REAL terminal error the SDK persisted to its local store but
   *  `run.wait()` deliberately drops (errorCode). Returns a non-empty reason,
   *  or null when nothing recoverable. Best-effort — any failure → null. */
  private async readRunError(
    session: Session,
    runId: string | undefined,
  ): Promise<string | null> {
    if (!runId) return null;
    try {
      const store = await this.openStore(session);
      if (!store) return null;
      const doc = await store.runs.get({
        agentId: session.agent.agentId,
        runId,
      });
      const detail = doc?.error ?? doc?.result ?? null;
      return typeof detail === "string" && detail.trim().length > 0
        ? detail.trim()
        : null;
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
    const apiKey = this.resolveApiKey(opts.env);
    const runtime = await this.createSessionRuntime(opts);
    // Fire-and-forget, and BEFORE the awaits below on purpose: the whole point
    // is to overlap the workspace/backend warm-up with model discovery and
    // `Agent.create` rather than serialize behind them.
    this.prewarmWorkspace(runtime.sdk, apiKey, opts);
    // Discover the account's catalog (cached, once per process) so the model
    // is validated BEFORE create/resume — otherwise a stale id (e.g. the old
    // `composer-2-fast` default, or a persisted pick) throws "Cannot use this
    // model: <id>". resolveModel falls back to a known-good model when the
    // selection isn't offered by this account.
    const modelState = await this.startModelDiscoveryForSession(
      apiKey,
      runtime.sdk,
    );
    const modelId = this.resolveModel(
      opts.env?.CURSOR_MODEL,
      opts.env,
      modelState,
    );
    const sdk = runtime.sdk;
    let agent: SdkAgent;
    try {
      const sessionMcp = this.mcpServers(opts.mcpServers, opts.env);
      agent = await sdk.Agent.create({
        apiKey,
        model: this.modelSelection(modelId, modelState, opts.env),
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
          autoReviewFor(CURSOR_DEFAULT_MODE),
        ),
        mode: sdkModeFor(CURSOR_DEFAULT_MODE),
        ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
      });
    } catch (err) {
      await this.finalizeRejectedSessionRuntime(runtime);
      throw this.classify(err, "newSession");
    }

    const executionId = opts.executionId ?? randomUUID();
    const session: Session = {
      zerosSessionId: executionId,
      cwd: opts.cwd,
      apiKey,
      modelState,
      modelId,
      modeId: CURSOR_DEFAULT_MODE,
      agent,
      sdk,
      ...(runtime.dispose ? { disposeRuntime: runtime.dispose } : {}),
      ...(runtime.providerHome ? { providerHome: runtime.providerHome } : {}),
      activeRun: null,
      cancelRequested: false,
      env: opts.env,
      mcpServers: opts.mcpServers,
      appliedAutoReview: autoReviewFor(CURSOR_DEFAULT_MODE),
      prewarmedAutoReview: new Set([autoReviewFor(CURSOR_DEFAULT_MODE)]),
    };
    this.sessions.set(executionId, session);

    return {
      session: {
        executionId,
        sessionId: executionId,
        providerBinding: providerBindingForResume("cursor", agent.agentId),
        modes: {
          currentModeId: CURSOR_DEFAULT_MODE,
          availableModes: CURSOR_SDK_MODES,
        },
      } as never,
      initialize: await this.initialize(),
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
    const apiKey = this.resolveApiKey(opts.env);
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
    // Same overlap as newSession: a reopened chat pays the identical cold
    // workspace/backend cost on its first turn, so warm it while the catalog
    // and `Agent.resume` are still in flight.
    this.prewarmWorkspace(runtime.sdk, apiKey, opts);
    // Discover the account's catalog (cached, once per process) so the model
    // is validated BEFORE create/resume — otherwise a stale id (e.g. the old
    // `composer-2-fast` default, or a persisted pick) throws "Cannot use this
    // model: <id>". resolveModel falls back to a known-good model when the
    // selection isn't offered by this account.
    const modelState = await this.startModelDiscoveryForSession(
      apiKey,
      runtime.sdk,
    );
    const modelId = this.resolveModel(
      opts.env?.CURSOR_MODEL,
      opts.env,
      modelState,
    );
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
      sessionMcp = this.mcpServers(opts.mcpServers, opts.env);
      agent = await sdk.Agent.resume(providerResumeId, {
        apiKey,
        // Bind the resolved model on resume too. `Agent.resume` reconstructs
        // the agent from Cursor's local SQLite store, which may hold NO
        // persisted model (a cross-worktree id, a rotated cache, or a
        // pre-SDK cursor-agent CLI id). Without an explicit model the
        // resumed agent's internal `_model` is undefined and the next
        // `send()` throws "Local SDK agents require an explicit `model`" —
        // the exact error users hit on every reopened chat. `resume` takes a
        // Partial<AgentOptions>, which accepts `model`.
        model: this.modelSelection(modelId, modelState, opts.env),
        // Pin cwd here too — a resumed agent's executor roots at `local.cwd`,
        // and resuming a chat in a different worktree MUST retarget it (else
        // shells run wherever the agent was first created, or fall back to the
        // host's process.cwd()). See resolveHostCwd in host-client.ts.
        cwd: opts.cwd,
        local: this.buildLocalOpts(
          opts.cwd,
          opts.env,
          autoReviewFor(CURSOR_DEFAULT_MODE),
        ),
        ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
      });
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
        agent = await sdk.Agent.create({
          apiKey,
          model: this.modelSelection(modelId, modelState, opts.env),
          // Same cwd pinning as the primary create — the fresh fallback agent
          // must also root at the worktree, never the host's process.cwd().
          cwd: opts.cwd,
          local: this.buildLocalOpts(
            opts.cwd,
            opts.env,
            autoReviewFor(CURSOR_DEFAULT_MODE),
          ),
          mode: sdkModeFor(CURSOR_DEFAULT_MODE),
          ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
        });
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
      modelState,
      modelId,
      modeId: CURSOR_DEFAULT_MODE,
      agent,
      sdk,
      ...(runtime.dispose ? { disposeRuntime: runtime.dispose } : {}),
      ...(runtime.providerHome ? { providerHome: runtime.providerHome } : {}),
      activeRun: null,
      cancelRequested: false,
      env: opts.env,
      mcpServers: opts.mcpServers,
      appliedAutoReview: autoReviewFor(CURSOR_DEFAULT_MODE),
      prewarmedAutoReview: new Set([autoReviewFor(CURSOR_DEFAULT_MODE)]),
    });
    return {
      executionId,
      providerBinding: providerBindingForResume("cursor", agent.agentId),
      modes: {
        currentModeId: CURSOR_DEFAULT_MODE,
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
  }): Promise<{ stopReason: StopReason; response: PromptResponse }> {
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

    const message = buildUserMessage(opts.prompt);
    session.cancelRequested = false;

    // Reconcile the Auto-review classifier before sending. autoReview is a
    // CREATE-TIME @cursor/sdk option, so a mid-chat switch into/out of "Auto"
    // only takes effect after the agent is rebuilt — do it lazily here so
    // toggling modes without sending costs nothing and A→B→A settles to one.
    await this.ensureAutoReview(session);
    const usageBefore = await readCursorAgentUsage(session.agent);
    const idempotencyKey = cursorTurnIdempotencyKey(
      session.agent.agentId,
      opts.turnId,
    );

    // A Cursor LOCAL run can terminate `status:"error"` with NOTHING useful in
    // run.wait() — the SDK persists the real reason to its local SQLite store
    // as `errorCode` but wait()'s RunResult deliberately drops it. So the only
    // way to tell the user WHY (auth / plan / model / network) is to read it
    // back from the store (readRunError). And when the reason is model gating
    // — a model the account/plan can't run locally, e.g. a "Max Mode" model;
    // composer-2.5 can hit this — we denylist it and retry ONCE with a
    // confirmed-good model (composer-2) so the turn still completes.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const lastAttempt = attempt >= MAX_ATTEMPTS;
      // attempt 1 honours the chat's pick (minus anything already denied this
      // session); attempt 2 forces a confirmed-good fallback.
      const modelId =
        attempt === 1
          ? this.resolveModel(
              session.env?.CURSOR_MODEL ?? session.modelId,
              session.env,
              session.modelState,
            )
          : (this.pickRetryModel(session.modelId, session.modelState) ??
            session.modelId);

      // Fresh translator per attempt so a retried run doesn't inherit the
      // failed run's partial state. A model-gated run errors before emitting
      // assistant text, so the retry won't duplicate visible content.
      const translator = new CursorSdkTranslator({
        sessionId: opts.sessionId,
        emit: (n) => this.ctx.emit.onSessionUpdate(AGENT_ID, n),
        onUnknown: () => {
          /* tolerate unknown message types */
        },
        // Cursor runs subagents as a black box (no live stream, empty
        // conversationSteps in local mode) — their real tool calls live in the
        // on-disk transcript. Inject readers so the translator can lift them
        // into the SubagentCard. Scoped to this session's cwd (the project the
        // transcripts are filed under). Called both on a live poll timer (below)
        // and at flush — so NO logging here (it would spam every poll); the
        // translator logs once per subagent at discover/flush.
        loadSubagentTranscript: (subagentAgentId) =>
          loadSubagentTranscript(session.cwd, subagentAgentId, {
            ...(session.providerHome ? { home: session.providerHome } : {}),
          }),
        loadSubagentTranscriptByPath: (path) =>
          loadSubagentTranscriptByPath(path),
        // The agentId isn't on the running-leg task args — Cursor only reveals
        // it in the task RESULT at completion, and often omits the prompt from
        // the streamed args too. So to stream a subagent's tools LIVE we locate
        // its transcript by prompt-match when available, else by the most-
        // recently-written transcript that appeared since the task started
        // (sinceMs), excluding ones already claimed by another running task.
        discoverSubagentAgentId: (promptText, claimed, sinceMs) =>
          findSubagentByPrompt(session.cwd, promptText, claimed, {
            sinceMs,
            ...(session.providerHome ? { home: session.providerHome } : {}),
          }),
        onLog: (m) =>
          this.ctx.emit.onAgentStderr(AGENT_ID, `${m} (cwd=${session.cwd})`),
      });

      // Verification breadcrumb, mirroring the Claude and Codex adapters: one
      // line per turn echoing what was actually sent. Cursor had none, so a
      // turn's model/mode could only be inferred from the renderer's telemetry.
      if (isDevRuntime()) {
        console.info(
          `[cursor-sdk] turn: model=${modelId} mode=${session.modeId} ` +
            `attempt=${attempt}/${MAX_ATTEMPTS}`,
        );
      }
      // Time to the turn's first MODEL OUTPUT, measured end-to-end (host bridge
      // included) rather than inside the host. Deliberately not the first
      // streamed item: the SDK acknowledges a run with `request`/`status`
      // frames within ~10ms of send, and a contained host has been measured
      // delivering those on time and then taking 77s to produce a first token
      // (against ~4s for later turns in the same host). Reported whenever it is
      // slow, into the engine log the user already has, next to the
      // [cursor-host] attribution lines that say what was blocking.
      const turnStartedAt = Date.now();
      let sawModelOutput = false;
      let callbackUsage: TurnUsage | undefined;

      let run: SdkRun;
      try {
        // Always pass the model on `send` (not just at create/resume): the SDK
        // resolves a run's model as `sendOptions.model ?? agent._model`, and a
        // resumed agent's `_model` can be undefined → "Local SDK agents require
        // an explicit `model`". `local.force` expires any wedged prior run so
        // it can't collide with this one.
        run = await session.agent.send(message, {
          // Auto & Full access both run as sdk "agent"; they differ only by the
          // (create-time) autoReview already baked in via ensureAutoReview().
          mode: sdkModeFor(session.modeId),
          model: this.modelSelection(modelId, session.modelState, session.env),
          local: { force: true },
          // The engine-owned turn id survives renderer reconnect/resend. Hash
          // it before crossing the harness boundary so provider logs never
          // receive Zeros' durable identity verbatim. A model-gate fallback is
          // a distinct provider attempt and gets a deterministic suffix.
          idempotencyKey:
            attempt === 1
              ? idempotencyKey
              : `${idempotencyKey}-retry-${attempt}`,
          onDelta: ({ update }) => {
            if (isRecord(update) && update.type === "turn-ended") {
              callbackUsage = cursorTurnUsage(update.usage);
            }
            translator.feedDelta(update);
          },
          onStep: ({ step }) => translator.feedStep(step),
        });
      } catch (err) {
        throw this.classify(err, "prompt");
      }
      session.activeRun = run;
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

      // Poll active subagents' transcripts on a timer so their tool calls stream
      // LIVE during the run (Cursor doesn't push subagent internals through the
      // stream — they're only on disk, written tool-by-tool). The translator
      // dedupes across polls (toolsEmitted) and flushSubagents() emits the tail
      // + report once the run ends. ~1.2s balances liveness vs file churn.
      const SUBAGENT_POLL_MS = 1200;
      const pollTimer = setInterval(() => {
        try {
          translator.pollSubagents();
        } catch {
          /* best-effort live update — flush is the authority */
        }
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
            streamedUsage = cursorTurnUsage(sdkMessage.usage);
          }
          translator.feed(msg);
        }
        waitResult = await run.wait();
      } catch (err) {
        streamError = err;
      } finally {
        clearInterval(pollTimer);
        session.activeRun = null;
        // The stream has drained — every subagent transcript Cursor wrote is now
        // flushed, so emit each subagent's remaining tool calls + narration +
        // report (the tail beyond what the live poll already streamed).
        translator.flushSubagents();
      }

      // User-requested cancel — benign, end the turn cleanly.
      if (session.cancelRequested) {
        const stopReason = translator.stopReason;
        const billedUsage = cursorAgentUsageDelta(
          usageBefore,
          await readCursorAgentUsage(session.agent),
        );
        const usage = mergeCursorTurnUsage(
          cursorTurnUsage(waitResult?.usage) ?? callbackUsage ?? streamedUsage,
          billedUsage,
        );
        return {
          stopReason,
          response: {
            stopReason,
            effectiveModel: waitResult?.model?.id ?? modelId,
            ...(usage ? { usage } : {}),
          } as PromptResponse,
        };
      }

      const runStatus =
        typeof waitResult?.status === "string"
          ? waitResult.status.toLowerCase()
          : null;
      const runErrored = runStatus === "error" || runStatus === "expired";

      // Success.
      if (streamError == null && !runErrored && !translator.sawError) {
        // Cursor occasionally completes a run with a populated final result
        // but no assistant event in the stream. Returning a clean empty turn
        // makes a delivered first/second message look permanently queued even
        // though the provider answered. Use wait()'s authoritative result only
        // when no visible assistant text was emitted, so the normal streaming
        // path is never duplicated.
        if (
          !translator.sawAssistantText &&
          typeof waitResult?.result === "string" &&
          waitResult.result.trim().length > 0
        ) {
          translator.feed({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: waitResult.result }],
            },
          });
        }
        const stopReason = translator.stopReason;
        const billedUsage = cursorAgentUsageDelta(
          usageBefore,
          await readCursorAgentUsage(session.agent),
        );
        const usage = mergeCursorTurnUsage(
          cursorTurnUsage(waitResult?.usage) ?? callbackUsage ?? streamedUsage,
          billedUsage,
        );
        return {
          stopReason,
          response: {
            stopReason,
            effectiveModel: waitResult?.model?.id ?? modelId,
            ...(usage ? { usage } : {}),
          } as PromptResponse,
        };
      }

      // Failure — recover the REAL reason. A thrown stream error already
      // carries its message; otherwise prefer the in-band ERROR message, then
      // the store's persisted errorCode (the actual reason wait() hid).
      const recovered = streamError
        ? streamError instanceof Error
          ? streamError.message
          : String(streamError)
        : (translator.errorDetail ??
          (await this.readRunError(session, run.id)));

      // Model gated for this account → denylist it and retry with a
      // confirmed-good model so the user's turn still completes.
      if (
        !lastAttempt &&
        streamError == null &&
        typeof recovered === "string" &&
        isCursorModelGatedError(recovered) &&
        this.pickRetryModel(modelId, session.modelState)
      ) {
        session.modelState.deniedModels.add(modelId);
        this.ctx.emit.onAgentStderr(
          AGENT_ID,
          `[cursor-sdk] model "${modelId}" can't run locally on this ` +
            `account (${recovered.slice(0, 160)}); retrying with ` +
            `${this.pickRetryModel(modelId, session.modelState)}.`,
        );
        continue;
      }

      const detail =
        recovered ??
        `Cursor run ended in "${runStatus ?? "error"}" with no detail. The ` +
          `local Cursor runtime needs a valid Cursor API key on a plan that ` +
          `allows SDK agents and outbound HTTP/2 to Cursor — check Settings → ` +
          `Providers → Cursor, your plan, and any VPN/proxy, then try again.`;
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] turn failed: ${detail}`,
      );
      const failure = classifyCursorSdkError(
        streamError ?? new Error(detail),
        "prompt",
      );
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
            message: "Connection lost — reconnecting…",
          },
        });
      }
      throw failure;
    }

    // Unreachable: every loop iteration returns or throws.
    return {
      stopReason: "end_turn" as StopReason,
      response: {} as never,
    };
  }

  async cancel(opts: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (session) session.cancelRequested = true;
    try {
      await session?.activeRun?.cancel();
    } catch {
      /* best effort */
    }
  }

  async setMode(opts: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    // Cheap: just record the pick. Ask↔Full access is a per-send `mode` change;
    // toggling Auto flips the DESIRED autoReview, reconciled lazily by
    // ensureAutoReview() on the next prompt (autoReview is create-time only).
    if (
      opts.modeId === "agent" ||
      opts.modeId === "plan" ||
      opts.modeId === "auto"
    ) {
      session.modeId = opts.modeId;
      // Still cheap — fire-and-forget — but it starts the workspace build that
      // reconcile will otherwise do inside the user's next send.
      this.prewarmForDesiredMode(session);
    }
  }

  /** Cursor accepts a model on every `agent.send`, so a composer model change
   * does not require replacing the SDK agent or losing its conversation. */
  async setModel(opts: { sessionId: string; model: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    const model = opts.model.trim();
    if (!session || !model) return;
    session.env = { ...(session.env ?? {}), CURSOR_MODEL: model };
    session.modelId = this.resolveModel(model, session.env, session.modelState);
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
    session.env = { ...carried, ...opts.env };
    session.modelId = this.resolveModel(
      session.env.CURSOR_MODEL,
      session.env,
      session.modelState,
    );
  }

  /** Rebuild the agent (Agent.resume) when the mode's desired autoReview no
   *  longer matches what's baked into the live agent — the only way to change
   *  the create-time classifier gate for an in-flight chat. Resumes the SAME
   *  session id (conversation preserved), re-applying cwd/sandbox/MCP. On
   *  failure it keeps the existing agent and leaves appliedAutoReview stale so
   *  the next prompt retries — never fails the turn over a gate toggle. */
  private async ensureAutoReview(session: Session): Promise<void> {
    const want = autoReviewFor(session.modeId);
    if (want === session.appliedAutoReview) return;
    try {
      const sdk = session.sdk;
      const sessionMcp = this.mcpServers(session.mcpServers, session.env);
      session.agent = await sdk.Agent.resume(session.agent.agentId, {
        apiKey: session.apiKey,
        model: this.modelSelection(
          session.modelId,
          session.modelState,
          session.env,
        ),
        cwd: session.cwd,
        local: this.buildLocalOpts(session.cwd, session.env, want),
        ...(sessionMcp ? { mcpServers: sessionMcp } : {}),
      });
      session.appliedAutoReview = want;
    } catch (err) {
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] Auto-review rebuild (autoReview=${want}) failed; ` +
          `keeping current agent: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Mark the teardown as deliberate BEFORE cancelling the run so an in-flight
    // prompt (which still holds this session reference) ends via the clean
    // cancel branch instead of throwing AGENT_PROMPT_FAILED. Matters when a
    // session is superseded mid-turn (one-live-session-per-chat teardown in the
    // engine) — mirrors the claude/codex deliberate-teardown semantics.
    session.cancelRequested = true;
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
   *  (401/403/AuthenticationError); anything else (network, SDK shape
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
      const e = err as { status?: unknown; name?: unknown; message?: unknown };
      const status = typeof e.status === "number" ? e.status : undefined;
      const name = typeof e.name === "string" ? e.name : "";
      const message = err instanceof Error ? err.message : String(err);
      const rejected =
        status === 401 ||
        status === 403 ||
        /AuthenticationError/i.test(name) ||
        /auth|unauthor|401|forbidden|403|invalid.*key/i.test(message);
      return rejected
        ? { ok: false, error: "Cursor rejected this API key." }
        : { ok: null };
    } finally {
      if (runtime?.dispose) {
        await this.finalizeSessionRuntime(runtime);
      }
    }
  }

  /** Background one-shot text generation (the AI chat-title call): a
   *  throwaway `Agent.create` → `send` → `run.wait()`, whose `.result` IS
   *  the assistant's final text — no translator, no stream consumers. The
   *  system instruction is prepended to the message text (the SDK has no
   *  separate system-prompt param). Runs in "plan" (the SDK's read-only
   *  mode) — the user's raw prompt is forwarded verbatim, and a background
   *  call must never be able to edit files or fire MCP tools (mirrors the
   *  Claude allowedTools:[] / Codex read-only-sandbox one-shots). NOTE:
   *  each call counts as one request against the user's Cursor plan — the
   *  caller decides that trade-off. */
  async generateText(opts: {
    model: string;
    systemPrompt: string;
    prompt: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    executionBoundary?: PreparedBoundary;
  }): Promise<string> {
    const apiKey = this.resolveApiKey(opts.env);
    const cwd = this.ctx.projectRoot;
    const runtime = await this.createSessionRuntime({
      cwd,
      env: opts.env,
      executionBoundary: opts.executionBoundary,
    });
    const sdk = runtime.sdk;
    const modelState = await this.startModelDiscoveryForSession(apiKey, sdk);
    // Validate the pick against discovered ids like a real send would —
    // an unknown id falls back to the account's best composer.
    const modelId = this.resolveModel(opts.model, opts.env, modelState);
    let agent: SdkAgent | null = null;
    // The throwaway agent is never registered in this.sessions, so the
    // session-teardown paths can't reach it — close it here on every exit
    // (success, error, timeout) or each title call leaks a local agent.
    try {
      agent = await sdk.Agent.create({
        apiKey,
        model: this.modelSelection(modelId, modelState, opts.env),
        cwd,
        local: this.buildLocalOpts(cwd, opts.env),
        mode: "plan",
      });
      const run = await agent.send(
        { text: `${opts.systemPrompt}\n\n${opts.prompt}` },
        {
          mode: "plan",
          model: this.modelSelection(modelId, modelState, opts.env),
          local: { force: true },
        },
      );
      const waitResult = await Promise.race([
        run.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("title turn timeout")),
            opts.timeoutMs ?? 30_000,
          ),
        ),
      ]);
      return typeof waitResult?.result === "string" ? waitResult.result : "";
    } finally {
      try {
        agent?.close?.();
      } catch {
        /* ignore */
      }
      await runtime.dispose?.().catch(() => undefined);
    }
  }

  // ── helpers ─────────────────────────────────────────────

  private resolveApiKey(env?: Record<string, string>): string {
    const key =
      env?.CURSOR_API_KEY?.trim() || process.env.CURSOR_API_KEY?.trim();
    if (!key) {
      throw new AgentFailureError({
        kind: "auth-required",
        message:
          "Cursor SDK needs an API key. Add one in Settings → Providers → Cursor (CURSOR_API_KEY).",
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
    env?: Record<string, string>,
    autoReview = false,
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
      // Load the user's EXISTING Cursor settings layers from disk — their
      // ~/.cursor/mcp.json + project .cursor/mcp.json MCP servers, repo rules,
      // team/MDM/plugin layers. Without this the @cursor/sdk loads ONLY the
      // servers we pass inline ("Without local.settingSources, only inline
      // servers are loaded" — cursor.com/docs/sdk/typescript), so anything the
      // user already configured in Cursor would silently NOT apply inside
      // Zeros. Mirrors the Claude adapter's settingSources:["user","project",
      // "local"]. Zeros' own injected mcpServers still win on name collision.
      settingSources: ["user", "project", "team", "mdm", "plugins"],
    };
    if (env?.CURSOR_SANDBOX === "1") {
      local.sandboxOptions = { enabled: true };
    }
    return local;
  }

  /** Render the MCP registry into @cursor/sdk's shape. `override` is the
   *  gateway-resolved per-session registry (user + repo + workspace layers,
   *  RCE-gated); undefined → the global ctx.mcpServers. */
  private mcpServers(
    override?: McpServerRegistration[],
    env: Readonly<Record<string, string | undefined>> = {},
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
              ...(s.args ? { args: s.args } : {}),
              ...(s.env ? { env: s.env } : {}),
            }
          : { url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
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

/** Pure error classifier for the Cursor SDK adapter (exported for unit
 *  testing). Order matters:
 *
 *  1. A missing / foreign agent — @cursor/sdk's "Agent <uuid> not found"
 *     on Agent.resume — is the SDK's equivalent of Codex's "no rollout
 *     found". Classify it as `session-expired`, a RECOVERABLE kind, so
 *     the renderer silently rebuilds + replays the on-disk history rather
 *     than surfacing a hard "Agent error" toast (the bug users hit on
 *     every worktree / legacy-chat reopen). The shared
 *     SESSION_EXPIRED_KEYWORDS regex (adapters/shared/session-expiry.ts) owns the wording
 *     match and is parity-tested against the renderer-side fallback.
 *  2. Rate limits → `rate-limited` with retry-later guidance (never an
 *     immediate auto-replay that would amplify the 429).
 *  3. Auth errors → `auth-required` so the panel flips to the Sign-in chip.
 *  4. Everything else → `protocol-error`. */
export function classifyCursorSdkError(
  err: unknown,
  stage: "newSession" | "loadSession" | "prompt",
): AgentFailureError {
  const message = err instanceof Error ? err.message : String(err);
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
  if (SESSION_EXPIRED_KEYWORDS.test(message)) {
    return new AgentFailureError({
      kind: "session-expired",
      message:
        stage === "loadSession"
          ? `cursor-sdk loadSession failed: ${message}. Start a fresh chat to continue.`
          : `cursor-sdk ${stage} failed: ${message}`,
      stage,
      agentId: AGENT_ID,
    });
  }
  // Prefer the SDK's typed throttle signal before message-based network
  // classification. A RateLimitError can legitimately mention a timed-out
  // backoff/request; replaying it as a transient disconnect would amplify the
  // provider's 429. Duck-type because this unstable SDK surface crosses the
  // Node-host boundary as a reconstructed Error.
  const e = (err !== null && typeof err === "object" ? err : {}) as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    constructor?: { name?: string };
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  const ctorName =
    (typeof e.name === "string" ? e.name : "") || e.constructor?.name || "";
  const isRateLimited =
    status === 429 ||
    /RateLimitError/i.test(ctorName) ||
    /\b(?:429|rate[\s_-]*limit(?:ed)?|too many requests|resource exhausted)\b/i.test(
      message,
    );
  if (isRateLimited) {
    return new AgentFailureError({
      kind: "rate-limited",
      message:
        `cursor-sdk ${stage} was rate-limited by Cursor. The current send ` +
        `stopped without an automatic replay. (${message})`,
      stage,
      agentId: AGENT_ID,
      advice: "Cursor is rate-limiting requests. Try again shortly.",
    });
  }
  const isAuth =
    status === 401 ||
    status === 403 ||
    /AuthenticationError/i.test(ctorName) ||
    /auth|unauthor|401|api[\s_-]?key|forbidden|403/i.test(message);
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
  if (TLS_CERT_RX.test(message)) {
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
  // Plain network reachability errors — frequently transient. Mark as
  // transport-closed (a RECOVERABLE kind) so the renderer silently retries
  // once instead of surfacing a hard toast for a momentary blip.
  if (NETWORK_ERR_RX.test(message)) {
    return new AgentFailureError({
      kind: "transport-closed",
      message:
        `cursor-sdk ${stage} failed: network error reaching Cursor ` +
        `(${message}). Check your connection and try again.`,
      stage,
      agentId: AGENT_ID,
    });
  }
  // Auth failures get ACTIONABLE copy. Cursor's raw error says "If you are
  // logged in, try logging out and back in" — cursor-agent CLI advice that's
  // meaningless inside Zeros (there is no login; auth is the API key we send).
  // Reaching here means a key WAS sent (a missing key throws earlier in
  // resolveApiKey with "add one in Settings") and Cursor's backend rejected
  // it — so say that, and say where to fix it. Raw message kept for debugging.
  return new AgentFailureError({
    kind: isAuth ? "auth-required" : "protocol-error",
    message: isAuth
      ? `cursor-sdk ${stage} failed: Cursor rejected the API key Zeros sent ` +
        `— it may be revoked, expired, or over its usage limit. Re-check it ` +
        `in Settings → Providers → Cursor (create a fresh key at ` +
        `cursor.com/dashboard → API Keys if needed), then send again. ` +
        `(Cursor's error: ${message})`
      : `cursor-sdk ${stage} failed: ${message}`,
    stage,
    agentId: AGENT_ID,
  });
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
