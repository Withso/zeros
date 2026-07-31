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

import { randomUUID } from "node:crypto";

import { AgentFailureError } from "../../types";
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
  RequestPermissionResponse,
  SessionMode,
  StopReason,
} from "../../types";
import { CursorSdkTranslator } from "./translator";
import {
  loadSubagentTranscript,
  loadSubagentTranscriptByPath,
  findSubagentByPrompt,
} from "./subagent-transcript";
import {
  getCursorHostModule,
  CURSOR_HOST_EXITED_CODE,
  CURSOR_HOST_CRASH_LOOP_CODE,
  CURSOR_HOST_CRASH_LOOP_ADVICE,
} from "./host/host-client";

const AGENT_ID = "cursor";
/** Cursor LOCAL SDK agents (we always run `local: { cwd }`) require an
 *  EXPLICIT, concrete model — the cloud auto-select ids ("auto" / "default")
 *  are rejected with "Local SDK agents require an explicit `model`". So when
 *  no concrete model is selected we substitute a real one.
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
/** Non-concrete ids the local SDK can't run — mapped to DEFAULT_MODEL. */
const AUTO_SELECT_IDS = new Set(["", "auto", "default"]);
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

/** Resolve a concrete Cursor model id, never an auto-select placeholder. */
export function resolveCursorModelId(envModel: string | undefined): string {
  const m = envModel?.trim();
  if (!m || AUTO_SELECT_IDS.has(m.toLowerCase())) return DEFAULT_MODEL;
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

/** Cursor bakes reasoning depth + speed into the MODEL ID itself (e.g.
 *  `<base>-thinking-high`, `<base>-fast`) — @cursor/sdk exposes no separate
 *  reasoning/effort field on `Agent.create`, unlike Claude (fastMode) or Codex
 *  (service_tier). So the composer's Effort/Fast pills for a Cursor model can
 *  only take effect by SWAPPING to a concrete variant id the account offers.
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
  const level = eff === "low" || eff === "medium" || eff === "high" ? eff : "";
  // §3.6 R1 — RE-TARGET a level-suffixed base when the user explicitly picked
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
  // §3.6 R1 — id-completion for a curated LEVEL-FREE base that isn't a live
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
    | { status?: string; result?: string; errorCode?: string; error?: string }
    | undefined
  >;
  cancel(): Promise<void>;
}
export interface SdkAgent {
  readonly agentId: string;
  send(message: unknown, options?: unknown): Promise<SdkRun>;
  close?(): void;
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
      list(
        opts?: Record<string, unknown>,
      ): Promise<Array<{ id?: string; displayName?: string }>>;
    };
  };
  /** The on-disk local agent store — the SAME one the host hands @cursor/sdk
   *  for the agent's own runs (JSONL; see cursor-host.cjs). We open it to
   *  recover a run's real terminal `error` after wait() reports a detail-less
   *  failure. Optional so the bundle tolerates a host without the op. */
  LocalAgentStore?: {
    open(opts: {
      workspaceRef: string;
      stateRoot?: string;
    }): Promise<CursorLocalStore>;
  };
}

/** The SDK's file-ignore / codebase-search service needs a ripgrep binary
 *  and reads its path from CURSOR_RIPGREP_PATH (it does NOT bundle one — the
 *  Phase-3 probe showed "Ripgrep path not configured" without this). We
 *  resolve it from the optional `@vscode/ripgrep` dep via a variable
 *  specifier so tsc doesn't hard-require the package; if it's absent the
 *  ignore-mapping degrades but the agent still runs (non-fatal). */
async function ensureRipgrep(): Promise<void> {
  if (process.env.CURSOR_RIPGREP_PATH) return;
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
      return m as unknown as CursorSdkModule;
    })();
  }
  return sdkPromise;
}

interface Session {
  zerosSessionId: string; // == SDK agentId
  cwd: string;
  apiKey: string;
  modelId: string;
  modeId: CursorSdkModeId;
  agent: SdkAgent;
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
}

export class CursorSdkAdapter implements AgentAdapter {
  readonly agentId = AGENT_ID;
  private readonly ctx: AgentAdapterContext;
  private readonly sessions = new Map<string, Session>();
  private cachedInitialize: InitializeResponse | null = null;
  /** The account's live model catalog (ids) from Cursor.models.list(). null
   *  until discovered — used to validate model picks and populate the picker. */
  private discoveredModelIds: Set<string> | null = null;
  /** Once-per-process discovery guard. */
  private modelDiscovery: Promise<void> | null = null;
  /** Models the local RunSSE backend has rejected as unrunnable for THIS
   *  account at runtime (Max-Mode/plan gating) — distinct from the catalog
   *  check, which can't predict it. resolveModel skips these so a denied
   *  default (e.g. composer-2.5 on a gated plan) isn't re-tried every turn. */
  private readonly deniedModels = new Set<string>();
  /** Lazily-opened SDK SQLite stores, one per cwd, reused across turns and
   *  disposed on adapter dispose. Used only to recover a run's real terminal
   *  error after wait() reports a detail-less failure. */
  private readonly storeByCwd = new Map<
    string,
    Promise<CursorLocalStore | null>
  >();

  constructor(ctx: AgentAdapterContext) {
    this.ctx = ctx;
  }

  async initialize(): Promise<InitializeResponse> {
    if (this.cachedInitialize) {
      // Kick a background discovery if an API key is available but we
      // haven't pulled the catalog yet — so the picker can populate via the
      // gateway's modelsDynamic re-poll even before the first session.
      const key = process.env.CURSOR_API_KEY?.trim();
      if (key && !this.discoveredModelIds) void this.discoverModels(key);
      return this.cachedInitialize;
    }
    this.cachedInitialize = {
      protocolVersion: 1 as never,
      agentInfo: { name: "Cursor Agent", version: "sdk" } as never,
      agentCapabilities: {
        loadSession: { enabled: true },
        promptCapabilities: {
          image: true, // SDKImage — base64 or url
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {} },
      } as never,
      // Model pill writes CURSOR_MODEL; newSession reads it. modelsDynamic
      // tells the gateway to re-read initialize until `models` is populated
      // by discoverModels() — so the picker reflects the user's real Cursor
      // catalog instead of the bundled fallback.
      _meta: { modelEnvVar: "CURSOR_MODEL", modelsDynamic: true },
      authMethods: [
        {
          id: "api_key",
          name: "Cursor API key",
          description:
            "Paste a Cursor API key (Dashboard → API Keys). Injected as CURSOR_API_KEY; bills to your Cursor plan.",
        },
      ] as never,
    } as InitializeResponse;
    const key = process.env.CURSOR_API_KEY?.trim();
    if (key) void this.discoverModels(key);
    return this.cachedInitialize;
  }

  /** Pull the account's model catalog once and cache it: validates model
   *  picks (resolveValidModelId) and feeds the picker via
   *  cachedInitialize._meta.models. Best-effort — failures leave the bundled
   *  catalog in place. */
  private async discoverModels(apiKey: string): Promise<void> {
    if (this.modelDiscovery) return this.modelDiscovery;
    this.modelDiscovery = (async () => {
      try {
        const sdk = await loadSdk();
        if (!sdk.Cursor?.models?.list) return;
        const list = await sdk.Cursor.models.list({ apiKey });
        const ids = new Set<string>();
        const models: Array<{ value: string; label: string }> = [];
        for (const m of list ?? []) {
          const id = typeof m.id === "string" ? m.id : null;
          if (!id || AUTO_SELECT_IDS.has(id.toLowerCase())) continue;
          ids.add(id);
          models.push({
            value: id,
            label: typeof m.displayName === "string" ? m.displayName : id,
          });
        }
        if (ids.size === 0) return;
        this.discoveredModelIds = ids;
        models.sort((a, b) => a.label.localeCompare(b.label));
        if (this.cachedInitialize) {
          const meta = (this.cachedInitialize._meta ?? {}) as Record<
            string,
            unknown
          >;
          this.cachedInitialize = {
            ...this.cachedInitialize,
            _meta: { ...meta, models },
          };
        }
      } catch (err) {
        // Reset the guard so a later session can retry the catalog pull.
        this.modelDiscovery = null;
        this.ctx.emit.onAgentStderr(
          AGENT_ID,
          `[cursor-sdk] model discovery failed: ${String(err)}`,
        );
      }
    })();
    return this.modelDiscovery;
  }

  /** Resolve CURSOR_MODEL → a concrete id, then validate it against the
   *  account's live catalog (falling back to a known-good model). Applies the
   *  composer's Effort/Fast pills BEST-EFFORT by swapping to a reasoning variant
   *  id the account offers (see {@link applyCursorReasoning}) — a no-op when the
   *  variant isn't discoverable, so it can't break the spawn. If the resolved id
   *  was already rejected by the local backend this session (deniedModels), swap
   *  to a confirmed-good retry model so we don't re-send a model we know can't run. */
  private resolveModel(
    envModel: string | undefined,
    env?: Record<string, string>,
  ): string {
    // Env-var names are Zeros conventions (mirror EFFORT_ENV_VAR /
    // FAST_MODE_ENV_VAR in model-catalog.ts, which is renderer-side and must not
    // be imported into the engine). The Claude/Codex adapters read the same
    // literals. envForChatSettings emits ZEROS_FAST_MODE only when ON ("1").
    const effort = env?.ZEROS_THINKING_EFFORT;
    const fast = env?.ZEROS_FAST_MODE === "1";
    const base = resolveCursorModelId(envModel);
    // §3.6 R1 — reasoning swap BEFORE catalog validation. The curated Grok
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
      this.discoveredModelIds,
    );
    const resolved =
      swapped !== base
        ? swapped
        : applyCursorReasoning(
            resolveValidModelId(base, this.discoveredModelIds),
            effort,
            fast,
            this.discoveredModelIds,
          );
    if (!this.deniedModels.has(resolved)) return resolved;
    return this.pickRetryModel(resolved) ?? resolved;
  }

  /** Pick a confirmed-good local model different from `failed` (and not
   *  already denied, and present in the account's catalog when known). null
   *  when there's nothing else worth trying. */
  private pickRetryModel(failed: string): string | null {
    for (const m of LOCAL_RETRY_MODELS) {
      if (m === failed || this.deniedModels.has(m)) continue;
      if (!this.discoveredModelIds || this.discoveredModelIds.has(m)) return m;
    }
    return null;
  }

  /** Lazily open (and cache) the on-disk local agent store for a cwd. The store
   *  defaults its state root to the same place the SDK writes runs, so reads
   *  see the agent's own rows. Best-effort: null when unavailable. */
  private async openStore(cwd: string): Promise<CursorLocalStore | null> {
    let p = this.storeByCwd.get(cwd);
    if (!p) {
      p = (async () => {
        try {
          const sdk = await loadSdk();
          if (!sdk.LocalAgentStore?.open) return null;
          return await sdk.LocalAgentStore.open({ workspaceRef: cwd });
        } catch (err) {
          this.ctx.emit.onAgentStderr(
            AGENT_ID,
            `[cursor-sdk] local store open failed: ${String(err)}`,
          );
          return null;
        }
      })();
      this.storeByCwd.set(cwd, p);
    }
    return p;
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
      const store = await this.openStore(session.cwd);
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
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }> {
    const apiKey = this.resolveApiKey(opts.env);
    // Discover the account's catalog (cached, once per process) so the model
    // is validated BEFORE create/resume — otherwise a stale id (e.g. the old
    // `composer-2-fast` default, or a persisted pick) throws "Cannot use this
    // model: <id>". resolveModel falls back to a known-good model when the
    // selection isn't offered by this account.
    await this.discoverModels(apiKey);
    const modelId = this.resolveModel(opts.env?.CURSOR_MODEL, opts.env);
    const sdk = await loadSdk();
    const sessionMcp = this.mcpServers(opts.mcpServers);
    let agent: SdkAgent;
    try {
      agent = await sdk.Agent.create({
        apiKey,
        model: { id: modelId },
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
      throw this.classify(err, "newSession");
    }

    const session: Session = {
      zerosSessionId: agent.agentId,
      cwd: opts.cwd,
      apiKey,
      modelId,
      modeId: CURSOR_DEFAULT_MODE,
      agent,
      activeRun: null,
      cancelRequested: false,
      env: opts.env,
      mcpServers: opts.mcpServers,
      appliedAutoReview: autoReviewFor(CURSOR_DEFAULT_MODE),
    };
    this.sessions.set(agent.agentId, session);

    return {
      session: {
        sessionId: agent.agentId,
        modes: {
          currentModeId: CURSOR_DEFAULT_MODE,
          availableModes: CURSOR_SDK_MODES,
        },
      } as never,
      initialize: await this.initialize(),
    };
  }

  async loadSession(opts: {
    sessionId: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
  }): Promise<LoadSessionResponse> {
    const apiKey = this.resolveApiKey(opts.env);
    // Discover the account's catalog (cached, once per process) so the model
    // is validated BEFORE create/resume — otherwise a stale id (e.g. the old
    // `composer-2-fast` default, or a persisted pick) throws "Cannot use this
    // model: <id>". resolveModel falls back to a known-good model when the
    // selection isn't offered by this account.
    await this.discoverModels(apiKey);
    const modelId = this.resolveModel(opts.env?.CURSOR_MODEL, opts.env);
    const sdk = await loadSdk();
    // Per-session MCP registry (gateway-resolved for this cwd). `Agent.resume`
    // takes a Partial<AgentOptions>, which accepts `mcpServers` — so we re-inject
    // on resume too. Without this, a resumed chat kept whatever MCP set it was
    // first created with, so a server the user ADDED after the chat opened never
    // appeared until they started a brand-new chat.
    const sessionMcp = this.mcpServers(opts.mcpServers);
    let agent: SdkAgent;
    // True when resume failed and we seeded a FRESH agent below — the gateway
    // re-injects the first-turn <system_instruction> (the fresh agent has no
    // prior transcript carrying it).
    let resumedFresh = false;
    try {
      agent = await sdk.Agent.resume(opts.sessionId, {
        apiKey,
        // Bind the resolved model on resume too. `Agent.resume` reconstructs
        // the agent from Cursor's local SQLite store, which may hold NO
        // persisted model (a cross-worktree id, a rotated cache, or a
        // pre-SDK cursor-agent CLI id). Without an explicit model the
        // resumed agent's internal `_model` is undefined and the next
        // `send()` throws "Local SDK agents require an explicit `model`" —
        // the exact error users hit on every reopened chat. `resume` takes a
        // Partial<AgentOptions>, which accepts `model`.
        model: { id: modelId },
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
      if (failure.failure.kind !== "session-expired") throw failure;
      this.ctx.emit.onAgentStderr(
        AGENT_ID,
        `[cursor-sdk] resume of ${opts.sessionId} failed (${
          err instanceof Error ? err.message : String(err)
        }); starting a fresh agent in ${opts.cwd}.`,
      );
      try {
        agent = await sdk.Agent.create({
          apiKey,
          model: { id: modelId },
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
        throw this.classify(createErr, "loadSession");
      }
    }
    this.sessions.set(opts.sessionId, {
      zerosSessionId: opts.sessionId,
      cwd: opts.cwd,
      apiKey,
      modelId,
      modeId: CURSOR_DEFAULT_MODE,
      agent,
      activeRun: null,
      cancelRequested: false,
      env: opts.env,
      mcpServers: opts.mcpServers,
      appliedAutoReview: autoReviewFor(CURSOR_DEFAULT_MODE),
    });
    return {
      modes: {
        currentModeId: CURSOR_DEFAULT_MODE,
        availableModes: CURSOR_SDK_MODES,
      },
      resumedFresh,
    } as never;
  }

  async listSessions(opts: {
    cwd?: string;
    cursor?: string | null;
  }): Promise<ListSessionsResponse> {
    try {
      const sdk = await loadSdk();
      const res = await sdk.Agent.list({ runtime: "local", cwd: opts.cwd });
      const items = Array.isArray(res) ? res : (res.items ?? []);
      const sessions = items
        .map((it) => ({
          sessionId: String(it.agentId ?? it.id ?? ""),
          cwd: typeof it.cwd === "string" ? it.cwd : (opts.cwd ?? ""),
          title: typeof it.name === "string" ? it.name : undefined,
          updatedAt:
            typeof it.lastModified === "number"
              ? new Date(it.lastModified).toISOString()
              : undefined,
        }))
        .filter((s) => s.sessionId);
      return { sessions } as never;
    } catch {
      return { sessions: [] } as never;
    }
  }

  async prompt(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: StopReason; response: PromptResponse }> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `cursor-sdk: no live session ${opts.sessionId} (load it first)`,
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
          ? this.resolveModel(session.modelId)
          : (this.pickRetryModel(session.modelId) ?? session.modelId);

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
          loadSubagentTranscript(session.cwd, subagentAgentId),
        loadSubagentTranscriptByPath: (path) =>
          loadSubagentTranscriptByPath(path),
        // The agentId isn't on the running-leg task args — Cursor only reveals
        // it in the task RESULT at completion, and often omits the prompt from
        // the streamed args too. So to stream a subagent's tools LIVE we locate
        // its transcript by prompt-match when available, else by the most-
        // recently-written transcript that appeared since the task started
        // (sinceMs), excluding ones already claimed by another running task.
        discoverSubagentAgentId: (promptText, claimed, sinceMs) =>
          findSubagentByPrompt(session.cwd, promptText, claimed, { sinceMs }),
        onLog: (m) =>
          this.ctx.emit.onAgentStderr(AGENT_ID, `${m} (cwd=${session.cwd})`),
      });

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
          model: { id: modelId },
          local: { force: true },
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
      let waitResult: { status?: string; result?: string } | undefined;
      try {
        for await (const msg of run.stream()) translator.feed(msg);
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
        return { stopReason, response: { stopReason } as never };
      }

      const runStatus =
        typeof waitResult?.status === "string"
          ? waitResult.status.toLowerCase()
          : null;
      const runErrored = runStatus === "error" || runStatus === "expired";

      // Success.
      if (streamError == null && !runErrored && !translator.sawError) {
        const stopReason = translator.stopReason;
        return { stopReason, response: { stopReason } as never };
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
        this.pickRetryModel(modelId)
      ) {
        this.deniedModels.add(modelId);
        this.ctx.emit.onAgentStderr(
          AGENT_ID,
          `[cursor-sdk] model "${modelId}" can't run locally on this ` +
            `account (${recovered.slice(0, 160)}); retrying with ` +
            `${this.pickRetryModel(modelId)}.`,
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
    }
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
      const sdk = await loadSdk();
      const sessionMcp = this.mcpServers(session.mcpServers);
      session.agent = await sdk.Agent.resume(session.zerosSessionId, {
        apiKey: session.apiKey,
        model: { id: session.modelId },
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

  respondToPermission(_opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void {
    // Phase 3 — file-based preToolUse hook round-trip. No-op for now.
  }

  respondToQuestion(_opts: {
    questionId: string;
    response: import("../../types").QuestionResponse;
    nativeRequestId?: string;
  }): boolean {
    // No-op: the Cursor SDK exposes no host-answerable question channel, so
    // Cursor never raises a blocking QuestionRequest. Present for interface
    // parity; the gateway calls this optionally. Never the handler.
    return false;
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
    this.sessions.delete(sessionId);
    try {
      await session.activeRun?.cancel();
    } catch {
      /* best effort */
    }
    try {
      session.agent.close?.();
    } catch {
      /* ignore */
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.agent.close?.();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    // Close any SQLite stores we opened for error recovery.
    for (const p of this.storeByCwd.values()) {
      try {
        await (await p)?.dispose();
      } catch {
        /* ignore */
      }
    }
    this.storeByCwd.clear();
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
  ): Promise<{ ok: boolean | null; error?: string }> {
    try {
      const sdk = await loadSdk();
      if (!sdk.Cursor?.models?.list) return { ok: null };
      await sdk.Cursor.models.list({ apiKey });
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
      return rejected ? { ok: false, error: message } : { ok: null };
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
  }): Promise<string> {
    const apiKey = this.resolveApiKey(opts.env);
    const sdk = await loadSdk();
    // Validate the pick against discovered ids like a real send would —
    // an unknown id falls back to the account's best composer.
    const modelId = this.resolveModel(opts.model, opts.env);
    const cwd = this.ctx.projectRoot;
    const agent = await sdk.Agent.create({
      apiKey,
      model: { id: modelId },
      cwd,
      local: this.buildLocalOpts(cwd, opts.env),
      mode: "plan",
    });
    // The throwaway agent is never registered in this.sessions, so the
    // session-teardown paths can't reach it — close it here on every exit
    // (success, error, timeout) or each title call leaks a local agent.
    try {
      const run = await agent.send(
        { text: `${opts.systemPrompt}\n\n${opts.prompt}` },
        { mode: "plan", model: { id: modelId }, local: { force: true } },
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
        agent.close?.();
      } catch {
        /* ignore */
      }
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
    const local: Record<string, unknown> = {
      cwd,
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
  ): Record<string, CursorMcpConfig> | null {
    const list = override ?? this.ctx.mcpServers;
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
 *  2. Auth errors → `auth-required` so the panel flips to the Sign-in chip.
 *  3. Everything else → `protocol-error`. */
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
  // Prefer the SDK's typed error signals over fragile message-regex alone.
  // @cursor/sdk error classes carry an HTTP `.status` and distinct
  // constructor names (AuthenticationError 401/403, RateLimitError 429,
  // ConfigurationError 400/404). A real auth failure whose message doesn't
  // happen to contain our keywords would otherwise degrade to
  // protocol-error → a hard "Agent error" toast instead of the Sign-in
  // chip. We duck-type rather than import the classes so the SDK's
  // unstable type surface can't break our compile.
  const e = err as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    constructor?: { name?: string };
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  // Prefer `.name` (set on the instance by the SDK's error classes AND on errors
  // reconstructed across the Node-host boundary, where the minified
  // constructor.name is meaningless) before falling back to constructor.name.
  const ctorName =
    (typeof e.name === "string" ? e.name : "") || e.constructor?.name || "";
  const isAuth =
    status === 401 ||
    status === 403 ||
    /AuthenticationError/i.test(ctorName) ||
    /auth|unauthor|401|api[\s_-]?key|forbidden|403/i.test(message);
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
