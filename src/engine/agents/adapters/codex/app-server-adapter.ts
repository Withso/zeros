// ──────────────────────────────────────────────────────────
// Codex app-server adapter — AgentAdapter implementation (B2).
// ──────────────────────────────────────────────────────────
//
// One bespoke adapter (not StreamJsonAdapter) per
// docs/archive/codex-app-server-migration-2026-05-24.md §B2.
// Per-session lifecycle:
//
//   newSession  → boot runtime → thread/start → register translator
//                 + approval handler → emit modes.
//   loadSession → boot runtime → thread/resume → same downstream.
//   prompt      → buildUserInput (incl. image materialization)
//                 → runtime.runTurn (with per-turn mode overrides).
//   cancel      → runtime.interruptTurn for EVERY live turn (parent +
//                 collab subagent threads; turn/interrupt is per-thread).
//   setMode     → stash composite mode; applied on next turn (no respawn).
//   respond     → map Zeros RequestPermissionResponse → method-specific
//                 codex approval response → runtime.respondToPermission.
//   dispose     → drain pending approvals (cancel), kill runtimes,
//                 clean per-session image dir.
//
// What B1 left as warn/throw is now real (B2+B3+B4 — all shipped):
//   - image attachments (localImage parts, base64 → tempfile)
//   - MCP injection (via `-c mcp_servers.<name>.…` at spawn)
//   - thread/resume + loadSession
//   - approval round-trip (permissionId map + decision routing)
//   - account/* notifications captured on session state (B4.0)
//   - auth-required / session-expired AgentFailureError classification
//
// Vs the deleted legacy spec.ts:
//   - Session-private MCP override config TOML is gone — overrides
//     are passed at spawn time via `-c mcp_servers.<name>.…`, not
//     per-turn — so `~/.codex/config.toml` semantics change. Per-
//     session state for MCP is implicit in the child's lifecycle.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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
  QuestionAnswer,
  QuestionRequest,
  QuestionResponse,
  QuestionSpec,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionNotification,
  StopReason,
} from "../../types";
import { AgentFailureError } from "../../types";
import { PERMISSION_RESPONSE_TIMEOUT_MS } from "../shared/constants";
import { isDevRuntime } from "../../../runtime";

import {
  bootCodexAppServerRuntime,
  type CodexApprovalMethod,
  type CodexApprovalPolicy,
  type CodexApprovalRequest,
  type CodexAppServerHandle,
  type CodexMcpElicitationRequest,
  type CodexMcpElicitationResponse,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  type CodexThreadStartParams,
  type CodexUserInput,
  type CodexUserInputRequest,
} from "./app-server";
import { CodexAppServerTranslator } from "./app-server-translator";
import { listCodexSessions } from "./history";
import { ensureSessionDir, removeSessionDir } from "../../session-paths";
import { mergeCommands } from "@zeros/core/builtin-commands";
import { buildQuestionStamp } from "@zeros/core/agent-messages";
import type {
  AdvertisedModel,
  AvailableCommand,
} from "@zeros/core/agent-events";
import type { AccountDetails } from "@zeros/core/messages";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { GetAccountParams } from "./generated/v2/GetAccountParams";

const AGENT_ID = "codex";
const CLIENT_INFO = { name: "Zeros", version: "0.0.5", title: "Zeros Mac App" };

/** How long after a cancel() an orphan turn (one that starts with no prompt
 *  in flight) is still interrupted on sight. Covers codex's trigger-turn
 *  wake: a child finishing around the interrupt starts a fresh parent turn
 *  AFTER the cancelled prompt already settled. Long enough for the child's
 *  graceful abort + mailbox delivery; short enough to never touch a
 *  human-initiated follow-up (which also sets turnActive). */
const POST_CANCEL_INTERRUPT_MS = 15_000;

/** How long drainCollabTurns lingers after the last tracked turn completes,
 *  waiting for codex's trigger_turn mailbox wake (the fresh parent turn that
 *  delivers a finished child's report). Local scheduling — sub-second in
 *  practice; 1.5s is a comfortable margin that only collab turns ever pay. */
const COLLAB_GRACE_MS = 1_500;

const CODEX_MODES: SessionMode[] = [
  {
    id: "ask",
    name: "Ask First",
    description: "Prompt before every tool call (sandbox: workspace-write).",
  },
  {
    id: "auto-edit",
    name: "Auto-Edit",
    description: "Auto-approve workspace edits; ask for risky ops.",
  },
  {
    id: "full-access",
    name: "Full Access",
    description: "Auto-approve everything (danger-full-access).",
  },
  {
    id: "read-only",
    name: "Read-Only",
    description: "Plan only; no edits or commands.",
  },
] as never;

export type CodexModeId = "ask" | "auto-edit" | "full-access" | "read-only";

/** Per-pending-approval state. Keyed by Zeros permissionId so
 *  respondToPermission can route the user's decision back to the
 *  right runtime AND know which method-specific response shape to
 *  build. */
export interface PendingApproval {
  runtime: CodexAppServerHandle;
  method: CodexApprovalMethod;
  /** Raw codex params — kept for diagnostics if mapping fails. */
  params: Record<string, unknown>;
}

interface PendingMcpApproval {
  runtime: CodexAppServerHandle;
}

interface CodexSession {
  zerosSessionId: string;
  cwd: string;
  env?: Record<string, string>;
  cliBinary?: string;
  runtime: CodexAppServerHandle;
  translator: CodexAppServerTranslator;
  /** Codex threadId — captured from thread/start (new) or thread/resume (load). */
  threadId: string;
  /** The thread's resolved model (thread/start `model`; best-effort on
   *  resume). Fallback for turn/start's collaborationMode.settings.model when
   *  the composer supplies no per-turn model — Settings.model is REQUIRED and
   *  takes precedence over the top-level model, so it must never be wrong. */
  threadModel: string | null;
  /** Composite mode applied as turn/start overrides. */
  modeId: CodexModeId;
  /** Most recent in-flight turn id, for interruptTurn(). */
  activeTurnId: string | null;
  /** EVERY in-flight turn in this session's app-server child, keyed
   *  threadId → turnId. The parent thread is one entry; codex collab
   *  subagents (spawn_agent / wait) run as SIBLING THREADS inside the
   *  same child and stream their own turn/item notifications over this
   *  connection. cancel() sweeps this map — interrupting only the
   *  parent turn left subagent turns running, so tool calls kept
   *  streaming after the UI showed STOPPED BY USER. */
  activeTurns: Map<string, string>;
  /** A collab SUBAGENT thread (any thread ≠ the session's parent thread)
   *  surfaced during the current prompt. Reset per prompt(). Drives
   *  drainCollabTurns' entry: `activeTurns.size > 0` alone misses the
   *  window where the child finished a beat BEFORE the parent's runTurn
   *  resolved — the trigger_turn wake is still coming, so the grace
   *  phase must run for any turn that had collab activity at all. */
  sawCollabTurns: boolean;
  cancelRequested: boolean;
  /** Wall-clock deadline (ms epoch; 0 = inactive) after a cancel() during
   *  which a turn that starts while NO prompt is in flight is interrupted
   *  on sight. Codex delivers a finishing child agent's completion message
   *  with trigger_turn=true, which STARTS A FRESH PARENT TURN even after
   *  the parent was interrupted (codex-rs tasks/mod.rs
   *  maybe_start_turn_for_pending_work) — without this window that orphan
   *  turn streams into the chat after STOPPED BY USER. */
  postCancelInterruptUntil: number;
  /** permissionId → pending state (the adapter is the owner of these
   *  ids; the runtime tracks its own JSON-RPC-side promise map by the
   *  same id). */
  pendingApprovals: Map<string, PendingApproval>;
  /** MCP tool-call approvals share the renderer's permission surface, but
   *  answer a different app-server request/response protocol. */
  pendingMcpApprovals: Map<string, PendingMcpApproval>;
  /** Only Zeros-minted managed registrations may use Auto-Edit's first-party
   *  auto-accept path. User/repository MCP config can never populate this. */
  trustedMcpServers: Set<string>;
  /** questionId → pending blocking-question state (runtime + the request we
   *  built, for answer reshaping + dismiss). Twin of pendingApprovals. */
  pendingQuestions: Map<
    string,
    { runtime: CodexAppServerHandle; request: QuestionRequest }
  >;
  /** itemId → the file paths of a fileChange item, captured as items stream.
   *  A fileChange APPROVAL request carries only the itemId (its params have
   *  no changes[]), so to show WHICH / HOW MANY files a patch touches we
   *  correlate the approval back to the streamed item's changes here. One
   *  Codex patch can span several files in a single gate. */
  fileEditPathsByItemId: Map<string, string[]>;
  /** Latest auth state from `account/updated` notifications. We capture
   *  it so the gateway's listAgents probe and any UI surface can reflect
   *  reality without re-running `codex login status`. null until the
   *  server fires the first event (post-initialized + post-login). */
  authMode: string | null;
  planType: string | null;
  /** Latest rate-limit snapshot from `account/rateLimits/updated`. Raw
   *  shape kept opaque — a future usage UI can unpack it. Stored as a
   *  per-session value rather than a global because thread/turn-level
   *  policies can lift session-scoped overrides off the latest snapshot. */
  latestRateLimits: unknown | null;
  /** True between `prompt()` start and settle. Lets the runtime-exit
   *  handler tell a mid-turn crash (owned by the in-flight prompt()'s
   *  recoverable retry) from an idle crash (broadcast so the chat shows
   *  reconnecting). */
  turnActive: boolean;
  /** Flips false the moment the `codex app-server` child exits. Checked at
   *  `prompt()` entry so a send that lands after the child died self-heals
   *  (throw recoverable transport-closed → the renderer rebuilds) instead
   *  of writing turn/start to a dead JSON-RPC client (a hard failure). */
  runtimeAlive: boolean;
  /** Set by the exit handler when the child dies DURING the active turn.
   *  prompt() reads it to throw a recoverable transport-closed (the
   *  renderer auto-rebuilds + resends — no manual "send again") instead of
   *  the generic protocol-error that stranded the user before. */
  childExitedMidTurn: boolean;
}

export class CodexAppServerAdapter implements AgentAdapter {
  readonly agentId = AGENT_ID;
  /** Zeros' first-turn instruction rides the app-server's NATIVE channel
   *  (`thread/start|resume.developerInstructions`) instead of an in-band
   *  <system_instruction> first user turn — it survives compaction and never
   *  masquerades as user speech. The gateway sees this flag, passes
   *  `systemInstruction` to newSession/loadSession, and skips its prepend.
   *  developerInstructions (NOT baseInstructions — that would REPLACE Codex's
   *  entire built-in system prompt) layers on top of the stock persona. */
  readonly nativeSystemInstruction = true;

  private readonly ctx: AgentAdapterContext;
  private readonly sessions = new Map<string, CodexSession>();
  /** Zeros session ids being torn down intentionally — so the resulting
   *  app-server child exit doesn't broadcast an agent-wide death. One
   *  `codex app-server` child runs per session, but onAgentExit is
   *  agent-wide + broadcast, so an intentional teardown is tracked here
   *  to suppress it. */
  private readonly disposing = new Set<string>();
  /** Memoized InitializeResponse — built once, then replaced in place when
   *  model/list discovery (discoverModels) populates `_meta.models`. The
   *  gateway re-polls initialize (modelsDynamic) until that lands. */
  private cachedInitialize: InitializeResponse | null = null;
  /** model/list runs once per process — the account's catalog is stable for
   *  the app's lifetime, so we don't re-query it per session. */
  private modelsDiscovered = false;

  constructor(ctx: AgentAdapterContext) {
    this.ctx = ctx;
  }

  async initialize(): Promise<InitializeResponse> {
    return this.initializeResponse();
  }

  /** Memoized InitializeResponse so model/list discovery can populate
   *  `_meta.models` on a stable object that the gateway re-poll re-reads. */
  private initializeResponse(): InitializeResponse {
    if (!this.cachedInitialize) {
      this.cachedInitialize = buildInitializeResponse();
    }
    return this.cachedInitialize;
  }

  /** Pull Codex's live model catalog (+ per-model reasoning-effort ladder) from
   *  the booted app-server via `model/list`, and surface it on the cached
   *  InitializeResponse `_meta.models` — replacing the bundled-catalog fallback
   *  with the account's REAL models. Best-effort + once per process (the catalog
   *  is account-stable). The Codex ReasoningEffort vocabulary
   *  (none|minimal|low|medium|high|xhigh) is passed through verbatim, in the
   *  server's intended order; the renderer coerces it to its ChatEffort set
   *  (dropping none/minimal). `supportsFast` is set only when a "fast" service
   *  tier is advertised — otherwise left unset so the renderer's gpt-5*
   *  heuristic stands (never a regression). */
  private async discoverModels(session: CodexSession): Promise<void> {
    if (this.modelsDiscovered) return;
    try {
      const resp = await session.runtime.request<{
        data?: Array<{
          id?: string;
          displayName?: string;
          hidden?: boolean;
          supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
          serviceTiers?: Array<{ id?: string }>;
          additionalSpeedTiers?: string[];
        }>;
      }>("model/list", { includeHidden: false }, { timeoutMs: 5_000 });
      const models: AdvertisedModel[] = [];
      for (const m of resp?.data ?? []) {
        if (!m?.id || m.hidden) continue;
        const effortLevels = (m.supportedReasoningEfforts ?? [])
          .map((e) => e.reasoningEffort)
          .filter((e): e is string => typeof e === "string");
        const hasFast =
          (m.serviceTiers ?? []).some((t) => t.id === "fast") ||
          (m.additionalSpeedTiers ?? []).includes("fast");
        models.push({
          value: m.id,
          label: m.displayName || m.id,
          effortLevels,
          ...(hasFast ? { supportsFast: true } : {}),
        });
      }
      if (models.length > 0) {
        this.modelsDiscovered = true;
        const base = this.initializeResponse();
        const meta = (base._meta ?? {}) as Record<string, unknown>;
        this.cachedInitialize = { ...base, _meta: { ...meta, models } };
      }
    } catch {
      /* best-effort — the bundled-catalog fallback still applies */
    }
  }

  async newSession(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }> {
    const { session } = await this.bootSession({
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      mcpServers: opts.mcpServers,
      systemInstruction: opts.systemInstruction,
      kind: "new",
    });
    // Surface Codex's real model catalog (+ effort ladder) onto the cached
    // initialize BEFORE returning, so the session's picker reflects the live
    // models immediately (not the bundled fallback). Once-per-process + bounded
    // by model/list's own timeout; never throws.
    await this.discoverModels(session);
    return {
      // Canonical SessionModeState is { currentModeId, availableModes } — the
      // renderer reads resp.session.modes.availableModes. The old `available`
      // field (+ `as never` casts that hid the mismatch from tsc) left the
      // codex mode pill empty on every new session.
      session: {
        sessionId: session.zerosSessionId,
        modes: {
          currentModeId: session.modeId,
          availableModes: CODEX_MODES,
        },
      },
      initialize: this.initializeResponse(),
    };
  }

  async loadSession(opts: {
    sessionId: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
  }): Promise<LoadSessionResponse> {
    // Resume against codex's stored thread. The sessionId we get IS the codex
    // thread id (set by listSessions, persisted by the UI), and we key the live
    // runtime + session dir on it. If the SAME thread is already open in another
    // live chat, a second boot would overwrite the map entry (leaking the first
    // runtime) and share the session dir (disposing one rm's it out from under
    // the other, including in-flight prompt image attachments). Tear down the
    // prior live session first so the newest open wins cleanly instead of
    // corrupting both.
    if (this.sessions.has(opts.sessionId)) {
      await this.disposeSession(opts.sessionId);
    }
    const { session, resumedFresh } = await this.bootSession({
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      mcpServers: opts.mcpServers,
      systemInstruction: opts.systemInstruction,
      kind: "resume",
      resumeThreadId: opts.sessionId,
      zerosSessionId: opts.sessionId, // key live runtime + dir on the codex thread id
    });
    // Populate the live model catalog for resumed chats too. Fire-and-forget:
    // loadSession returns no initialize, so the gateway re-poll (modelsDynamic)
    // surfaces `_meta.models` once discovery completes.
    void this.discoverModels(session);
    // Canonical LoadSessionResponse is the TOP-LEVEL { modes, models } (the
    // engine wraps this into AGENT_SESSION_LOADED.response, which the renderer
    // reads as resp.response.modes.availableModes on resume). The old
    // response/session wrapper + `available` field left the mode pill empty on
    // every resumed codex chat.
    return {
      sessionId: session.zerosSessionId,
      modes: {
        currentModeId: session.modeId,
        availableModes: CODEX_MODES,
      },
      resumedFresh,
    };
  }

  async listSessions(opts: {
    cwd?: string;
    cursor?: string | null;
  }): Promise<ListSessionsResponse> {
    return listCodexSessions({ cwd: opts.cwd });
  }

  async prompt(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: StopReason; response: PromptResponse }> {
    // A prompt can race a session teardown: the engine supersedes a chat's
    // prior session when a rebuild creates a new one (index.ts), so an
    // AGENT_PROMPT still addressed to the OLD sessionId lands here after the
    // session was disposed. Surface a RECOVERABLE failure (not the hard
    // "unknown codex session" Error → protocol-error → red "Agent error"
    // toast that strands the composer) so the renderer rebuilds + resends.
    const session = this.sessions.get(opts.sessionId);
    if (!session) throw codexDisconnectedFailure();

    // Self-heal a send that lands after the app-server child already died
    // (an idle crash, or the narrow window right after a turn completed):
    // the JSON-RPC client is closed, so turn/start would hard-fail. Surface
    // a RECOVERABLE transport-closed instead → the renderer rebuilds the
    // session (reboots the child, resumes the thread) and resends the prompt.
    if (!session.runtimeAlive) throw codexDisconnectedFailure();

    session.translator.startTurn();
    session.activeTurnId = null;
    session.sawCollabTurns = false;
    session.cancelRequested = false;
    // A new prompt supersedes the previous Stop — close the orphan-turn
    // interrupt window so it can't touch this turn's (sub)agents after
    // this prompt settles.
    session.postCancelInterruptUntil = 0;

    const input = await this.buildUserInput(session, opts.prompt);
    const { approvalPolicy, sandboxPolicy } = modePolicyFor(session.modeId);

    // 2026-05-28: per-turn model + reasoning effort. The composer's
    // ModelPill / EffortPill write to chat.model / chat.effort which
    // flow through envForChat → session.env at session creation. The
    // app-server supports overriding both per-turn via turn/start
    // (`model` + `effort`) — without this wiring, picking "High" in
    // the effort pill did nothing once a session was alive, and only
    // the model written into OPENAI_MODEL at spawn time was used. A
    // session respawn fixed model but not effort.
    const model = session.env?.OPENAI_MODEL?.trim() || undefined;
    const effort = mapEffortFromEnv(session.env?.ZEROS_THINKING_EFFORT);
    const fast = session.env?.ZEROS_FAST_MODE === "1";
    // Verification breadcrumb: one line per turn echoing the composer knobs
    // sent to the app-server. Tail the engine log and confirm it flips as you
    // toggle the composer (effort / Fast). See the Claude adapter's mirror.
    // Dev-only — gated behind ZEROS_DEV so it doesn't spam a release log.
    if (isDevRuntime()) {
      console.info(
        `[codex] turn: model=${model ?? "(default)"} effort=${effort ?? "(default)"} ` +
          `serviceTier=${fast ? "fast" : "(default)"}`,
      );
    }

    // A turn is now in flight. handleRuntimeExit reads `turnActive` to route
    // a child crash during this window as a mid-turn recovery (suppress the
    // broadcast; the throw below drives the rebuild) rather than an idle
    // reconnecting flip. `childExitedMidTurn` is reset per turn.
    session.turnActive = true;
    session.childExitedMidTurn = false;
    try {
      // Collaboration mode (EXPERIMENTAL): codex only allows the
      // request_user_input tool in PLAN mode, or in DEFAULT mode with our
      // features.default_mode_request_user_input override — and app-server
      // threads do NOT run in Default mode unless the client sets it (the
      // "request_user_input is unavailable in this mode" refusal, field
      // report 2026-07-04). Settings.model is REQUIRED and takes precedence
      // over the top-level model, so it carries the same per-turn override
      // (or the thread's resolved model); when neither is known the mode is
      // omitted rather than risk flipping the thread onto a wrong model.
      // developer_instructions:null = "use the built-in instructions for the
      // selected mode" (which teach the model when to ask questions).
      const collabModel = model ?? session.threadModel ?? undefined;
      const result = await session.runtime.runTurn(
        {
          threadId: session.threadId,
          input,
          approvalPolicy,
          sandboxPolicy,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // ZEROS_FAST_MODE → Codex "fast" service tier (priority inference, GPT-5.x).
          ...(fast ? { serviceTier: "fast" } : {}),
          ...(collabModel
            ? {
                collaborationMode: {
                  mode: "default" as const,
                  settings: {
                    model: collabModel,
                    reasoning_effort: effort ?? null,
                    developer_instructions: null,
                  },
                },
              }
            : {}),
        },
        {
          // `runTurn` resolves only after `turn/completed` arrives, but
          // the turnId is known from the `turn/start` ack — capture it
          // synchronously so `cancel()` has a target for the in-flight
          // turn (otherwise interruptTurn has nothing to call). This
          // also lets the UI's activeTurnId tracking reflect reality
          // during the streaming window.
          onTurnStarted: (turnId) => {
            session.activeTurnId = turnId;
            // Stop clicked while turn/start's ack was in flight — the
            // cancel() sweep ran against an empty target set, so this
            // turn would run to completion (while the eventual
            // stopReason claimed "cancelled"). Interrupt it the moment
            // its id exists.
            if (session.cancelRequested) {
              void session.runtime.interruptTurn(session.threadId, turnId);
            }
          },
        },
      );
      session.activeTurnId = null;
      // The app-server child died mid-turn — runTurn resolves "failed" from
      // the runtime's proc.exited handler (which also set childExitedMidTurn
      // via handleRuntimeExit). Surface a RECOVERABLE transport-closed, not
      // the generic protocol-error below: the renderer then auto-rebuilds +
      // resends (no manual "send again"), and its duplicate-turn guard skips
      // the resend if this turn already streamed output. Checked before the
      // auth/quota branch — a dead process is unambiguous.
      if (result.status === "failed" && session.childExitedMidTurn) {
        throw codexDisconnectedFailure();
      }
      // A failed turn RESOLVES (it doesn't throw), so the auth/quota
      // classifier in the catch below never sees a mid-turn
      // unauthorized / usageLimitExceeded — it would surface only as a
      // chat bubble while the green dot stayed green. Promote it to a real
      // auth-required failure here so the gateway's runtime auth
      // invalidation flips the dot.
      const authQuota = session.translator.authQuotaFailure;
      if (authQuota) {
        throw new AgentFailureError({
          kind: "auth-required",
          message: `Codex: ${authQuota}. Open Settings → Providers to sign in / check your plan.`,
          stage: "prompt",
          agentId: AGENT_ID,
        });
      }
      // A non-auth/quota failed turn (mid-turn server/network error, turn
      // timeout, proc exit) RESOLVES with status "failed" rather than throwing,
      // so without this it returns as a clean/ready turn (translator default
      // stopReason is end_turn; the renderer then marks AGENT_PROMPT_COMPLETE
      // "ready"). Editing mapStopReason is a no-op — the gateway discards the
      // top-level stopReason and codex sets response:{}. Promote it to a real
      // failure so the chat reflects it; the translator already emitted the
      // detailed ⚠ error bubble. Auth/quota and stale-thread are handled above /
      // in the catch, so this is the generic-failure case only.
      if (result.status === "failed") {
        throw new AgentFailureError({
          kind: "protocol-error",
          message: "Codex turn failed.",
          stage: "prompt",
          agentId: AGENT_ID,
        });
      }
      // Collab subagents outlive the PARENT turn: codex ends the parent's
      // turn the moment its own tail message is done, while spawned agent
      // threads keep running and keep streaming items into this session.
      // Resolving here made the whole UI settle — footer with timer/menu, no
      // Stop button, no shimmer, no workspace spinner — while a subagent was
      // demonstrably still working (field report 2026-07-04). Hold the prompt
      // open until every tracked (thread, turn) drains, plus a grace window
      // for codex's trigger_turn mailbox wake (the fresh parent turn that
      // delivers the child's report and writes the final summary). Skipped
      // after Stop: cancel() already swept the map and the post-cancel window
      // interrupts any trigger_turn wake.
      // `sawCollabTurns` (not `activeTurns.size`) is the entry condition: a
      // child that finished a beat BEFORE this resolve leaves the map empty,
      // but its trigger_turn wake is still coming — the grace phase inside
      // the drain is what catches it.
      if (!session.cancelRequested && session.sawCollabTurns) {
        await this.drainCollabTurns(session);
      }
      // Phase 2.5 — surface this turn's token usage (Codex reports tokens,
      // no cost over the app-server protocol) for LLM analytics.
      const turnUsage = session.translator.turnUsage;
      const stopReason = session.cancelRequested
        ? "cancelled"
        : mapStopReason(result.status, session.translator.stopReason);
      // stopReason rides INSIDE the response too: the gateway returns only
      // the inner response (it discards the outer field), so omitting it here
      // left the engine persisting a NULL stop reason for every Codex turn —
      // the §3.6 R5 footer pills and the turn row's status both read it.
      return {
        stopReason,
        response: {
          stopReason,
          ...(turnUsage ? { usage: turnUsage } : {}),
        } as PromptResponse,
      };
    } catch (err) {
      session.activeTurnId = null;
      // The child exited during this turn — but early enough that runTurn
      // REJECTED (the turn/start RPC was cut off by the client close) rather
      // than resolving "failed". Surface the same recoverable transport-closed
      // so the renderer auto-rebuilds + resends instead of a hard "client
      // closed" protocol-error. (childExitedMidTurn is only set when the child
      // actually died mid-turn, so this never false-positives.)
      if (session.childExitedMidTurn) throw codexDisconnectedFailure();
      // Classify the error so the renderer can route on `failure.kind`
      // instead of regex-matching the message. Without this, codex's
      // mid-turn "no rollout" / "thread not found" responses bubble up
      // as plain Errors → the renderer falls back to its narrower
      // bridge-side regex → mis-classifies as "protocol-error" → the
      // user sees a hard "Agent error" toast instead of the muted
      // session-expired self-heal path. classifyThreadFailure returns
      // the raw err unchanged when no pattern matches, so non-codex
      // failures (network, etc.) keep their original message.
      throw classifyThreadFailure(err, "prompt");
    } finally {
      // The turn has settled (completed, failed, or threw) — a subsequent
      // child exit is now an idle crash, not a mid-turn one.
      session.turnActive = false;
      session.cancelRequested = false;
    }
  }

  /** Inject a user message into the RUNNING turn via `turn/steer`. The
   *  app-server folds the input into the active turn (the model sees it at
   *  its next inference step); the in-flight prompt()'s `turn/completed`
   *  covers the steered input, so no turn bookkeeping changes here. Throws
   *  when no turn is active (`expectedTurnId` is a server-side precondition
   *  too — a completed-in-flight race fails the RPC rather than mis-routing
   *  the message into a later turn). */
  async steer(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) throw codexDisconnectedFailure();
    if (!session.runtimeAlive) throw codexDisconnectedFailure();
    const turnId = session.activeTurnId;
    if (!session.turnActive || !turnId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "no turn is in flight to steer",
        stage: "prompt",
        agentId: AGENT_ID,
      });
    }
    const input = await this.buildUserInput(session, opts.prompt);
    await session.runtime.request("turn/steer", {
      threadId: session.threadId,
      input,
      expectedTurnId: turnId,
    });
  }

  /** Run a REAL context compaction (§3.5 Task A): `thread/compact/start`.
   *  Triggered by `/compact` in a Codex chat and the context gauge's
   *  "Compact now" — replacing the old behavior where the literal text went
   *  to the model and it ROLE-PLAYED a summary while the real window stayed
   *  full. Fire-and-acknowledge: codex streams the compaction as a
   *  `contextCompaction` item (the two-state "Compacting.." → "Context
   *  compacted" row) and re-reports usage via `thread/tokenUsage/updated`,
   *  so no bookkeeping happens here. */
  async compactContext(opts: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) throw codexDisconnectedFailure();
    if (!session.runtimeAlive) throw codexDisconnectedFailure();
    // User-initiated → the contextCompaction item this triggers renders as
    // a STANDALONE transcript row (rawInput.trigger "manual"), not inside
    // the previous turn's working group (user spec 2026-07-12).
    session.translator.expectManualCompaction();
    try {
      await session.runtime.request("thread/compact/start", {
        threadId: session.threadId,
      });
    } catch (err) {
      // A rejected RPC produces no item — disarm so a later AUTO
      // compaction isn't mislabeled as user-initiated.
      session.translator.disarmManualCompaction();
      throw err;
    }
  }

  /** Wait for every tracked (thread, turn) to complete — the collab
   *  subagent threads still running after the parent turn resolved. Two
   *  phases, looped:
   *    1. Drain: poll until `activeTurns` empties. Entries leave via
   *       turn/completed (wireTurnTracking) or handleRuntimeExit's clear
   *       (child crash), so a dead child can't strand the wait.
   *    2. Grace: codex delivers a finished child's report by TRIGGERING a
   *       fresh parent turn (trigger_turn mailbox wake) — it starts a beat
   *       AFTER the child's turn completes, so an empty map isn't yet
   *       quiescent. Linger COLLAB_GRACE_MS; if a new turn appears, drain
   *       again (chains: parent → child → parent summary → another child).
   *  Only ever entered when the map is non-empty at parent settle (plain
   *  single-thread turns pay zero added latency). A Stop during the wait
   *  exits promptly: cancel() sweeps the map with interrupts (drain ends)
   *  and the grace phase bails on cancelRequested — the post-cancel window
   *  owns any late trigger_turn wake. */
  private async drainCollabTurns(session: CodexSession): Promise<void> {
    const POLL_MS = 100;
    // After a Stop, the sweep's interrupts should complete every turn within
    // moments — if one never does (codex wedged), bail so the user's Stop
    // still lands instead of stranding the chat in "streaming" forever.
    const CANCEL_BAIL_MS = 5_000;
    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms));
    let cancelSeenAt = 0;
    for (;;) {
      while (session.activeTurns.size > 0) {
        if (!session.runtimeAlive) return;
        if (session.cancelRequested) {
          if (cancelSeenAt === 0) cancelSeenAt = Date.now();
          else if (Date.now() - cancelSeenAt > CANCEL_BAIL_MS) return;
        }
        await sleep(POLL_MS);
      }
      const graceDeadline = Date.now() + COLLAB_GRACE_MS;
      while (session.activeTurns.size === 0) {
        if (!session.runtimeAlive || session.cancelRequested) return;
        if (Date.now() >= graceDeadline) return;
        await sleep(POLL_MS);
      }
    }
  }

  async cancel(opts: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    session.cancelRequested = true;
    session.postCancelInterruptUntil = Date.now() + POST_CANCEL_INTERRUPT_MS;
    // Sweep EVERY live turn, not just the parent's. turn/interrupt is
    // per-(thread, turn), and collab subagent threads keep running —
    // streaming tool calls into the timeline — if only the parent turn
    // is interrupted (codex-rs Op::Interrupt aborts a single thread's
    // task; upstream openai/codex#23292, #19197). wireTurnTracking
    // catches any turn that starts after this sweep.
    const targets = new Map(session.activeTurns);
    if (session.activeTurnId) {
      targets.set(session.threadId, session.activeTurnId);
    }
    await Promise.all(
      [...targets].map(([threadId, turnId]) =>
        session.runtime.interruptTurn(threadId, turnId),
      ),
    );
  }

  /** Change a live session's model without rebuilding it. runTurn reads
   *  `session.env.OPENAI_MODEL` fresh on EVERY turn (see prompt()), so
   *  rewriting the env is all it takes — the next turn carries the new model.
   *  Without this the renderer had to force-respawn the whole app-server
   *  session on every model pick just to re-seed spawn env. */
  async setModel(opts: { sessionId: string; model: string }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    const model = opts.model.trim();
    if (!session || !model) return;
    session.env = { ...(session.env ?? {}), OPENAI_MODEL: model };
  }

  /** Live config update (effort / fast / model / add-dirs). Same mechanism as
   *  setModel: the per-turn knobs are read off `session.env` at turn/start, so
   *  swapping the env in place is a complete live apply — no respawn.
   *
   *  `opts.env` is the composer's CURRENT snapshot (envForChat), which encodes
   *  Fast and the extra dirs BY OMISSION (absent = off/none). A plain merge
   *  can't delete a key, so a stale "on" value would survive a toggle-OFF —
   *  drop those by-omission keys from the prior env first, then let the
   *  incoming snapshot win. Creation-time keys the snapshot does not carry
   *  (OPENAI_* / provider auth from deriveProviderEnv) are preserved. */
  async updateConfig(opts: {
    sessionId: string;
    env: Record<string, string>;
  }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session) return;
    const carried = { ...(session.env ?? {}) };
    delete carried.ZEROS_FAST_MODE;
    delete carried.ZEROS_ADDITIONAL_DIRS;
    session.env = { ...carried, ...opts.env };
  }

  async setMode(opts: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.requireSession(opts.sessionId);
    if (
      opts.modeId === "ask" ||
      opts.modeId === "auto-edit" ||
      opts.modeId === "full-access" ||
      opts.modeId === "read-only"
    ) {
      session.modeId = opts.modeId;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: session.zerosSessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: opts.modeId,
        } as never,
      });
    }
  }

  respondToPermission(opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void {
    // Find which session owns this permissionId — the linear scan is
    // bounded by active chats (single digits); the per-session Map
    // keeps the lookup itself O(1).
    for (const session of this.sessions.values()) {
      const pending = session.pendingApprovals.get(opts.permissionId);
      if (!pending) continue;
      session.pendingApprovals.delete(opts.permissionId);
      const codexResponse = mapResponseToCodexDecision(pending, opts.response);
      pending.runtime.respondToPermission(opts.permissionId, codexResponse);
      return;
    }
    for (const session of this.sessions.values()) {
      const pending = session.pendingMcpApprovals.get(opts.permissionId);
      if (!pending) continue;
      session.pendingMcpApprovals.delete(opts.permissionId);
      pending.runtime.respondToMcpElicitation(
        opts.permissionId,
        mapResponseToMcpElicitation(opts.response),
      );
      return;
    }
    // Unknown permissionId — already responded or session was disposed.
    // No throw; the gateway pipeline tolerates this.
    console.log(
      `[codex-app-server] respondToPermission: unknown id ${opts.permissionId}`,
    );
  }

  respondToQuestion(opts: {
    questionId: string;
    response: QuestionResponse;
    nativeRequestId?: string;
  }): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingQuestions.get(opts.questionId);
      if (!pending) continue;
      session.pendingQuestions.delete(opts.questionId);
      const codexResponse = mapQuestionAnswerToCodex(
        pending.request,
        opts.response,
      );
      pending.runtime.respondToUserInput(opts.questionId, codexResponse);
      this.settleQuestionRecord(
        session,
        opts.questionId,
        pending.request,
        opts.response.outcome,
      );
      return true;
    }
    // Vendor-id fallback — a reconnect re-raised the same ask under a fresh
    // questionId while the renderer deduped and kept the original id.
    if (opts.nativeRequestId) {
      for (const session of this.sessions.values()) {
        for (const [qid, pending] of session.pendingQuestions) {
          if (pending.request.nativeRequestId !== opts.nativeRequestId)
            continue;
          session.pendingQuestions.delete(qid);
          const codexResponse = mapQuestionAnswerToCodex(
            pending.request,
            opts.response,
          );
          pending.runtime.respondToUserInput(qid, codexResponse);
          this.settleQuestionRecord(
            session,
            qid,
            pending.request,
            opts.response.outcome,
          );
          return true;
        }
      }
    }
    // The "user answered and the agent kept loading" signature — surface it
    // on the agent stderr log (user-visible), not just the engine console.
    this.ctx.emit.onAgentStderr(
      this.agentId,
      `[zeros] respondToQuestion: no pending question ${opts.questionId} (native ${opts.nativeRequestId ?? "-"}) — answer dropped (already settled or session rebuilt)`,
    );
    return false;
  }

  // ── account ───────────────────────────────────────────

  /** Read the signed-in Codex account via the app-server's `account/read`
   *  RPC. Prefers a live session's runtime; otherwise boots a short-lived
   *  one and disposes it. Best-effort — returns null on any failure or for
   *  non-ChatGPT (API-key) auth, so the panel shows "—". */
  async getAccountInfo(): Promise<AccountDetails | null> {
    // Fast path: reuse a live session's runtime — no extra boot.
    for (const s of this.sessions.values()) {
      const acct = await this.readAccount(s.runtime).catch(() => null);
      if (acct) return acct;
      break;
    }
    // No live runtime → boot a throwaway just to read the account. Spawns a
    // `codex app-server` child; disposed in finally even if the race below
    // times out. Verify on a Mac with codex signed in (not in the sandbox).
    const boot = bootCodexAppServerRuntime({
      cwd: this.ctx.projectRoot,
      clientInfo: CLIENT_INFO,
      mcpServers: [],
      logTag: "codex-app-server:account",
    });
    try {
      const runtime = await Promise.race([
        boot,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("boot timeout")), 10_000),
        ),
      ]);
      return await this.readAccount(runtime);
    } catch {
      return null;
    } finally {
      // Dispose whatever booted — even if the race above timed out waiting.
      void boot.then((h) => h.dispose()).catch(() => {});
    }
  }

  /** Background one-shot text generation (the AI chat-title call). Boots a
   *  throwaway app-server (same pattern as getAccountInfo), runs ONE
   *  read-only never-approve turn on a fresh thread, accumulates the
   *  agentMessage text from `item/completed`, and disposes. The system
   *  instruction is prepended to the input text — the app-server protocol
   *  has no per-turn system-prompt field. */
  async generateText(opts: {
    model: string;
    systemPrompt: string;
    prompt: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<string> {
    const boot = bootCodexAppServerRuntime({
      cwd: this.ctx.projectRoot,
      clientInfo: CLIENT_INFO,
      mcpServers: [],
      logTag: "codex-app-server:title",
      ...(opts.env ? { env: opts.env } : {}),
    });
    try {
      const runtime = await Promise.race([
        boot,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("boot timeout")), 10_000),
        ),
      ]);
      const { approvalPolicy, sandboxMode, sandboxPolicy } =
        modePolicyFor("read-only");
      // Raced like boot/runTurn: a server that boots but wedges on
      // thread/start must not suspend this call forever (the finally below
      // only runs once the try block settles — an unraced hang would leak
      // the throwaway app-server process for the life of the engine).
      const { threadId } = await Promise.race([
        runtime.startThread({
          cwd: this.ctx.projectRoot,
          model: opts.model,
          approvalPolicy,
          sandbox: sandboxMode,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("title thread-start timeout")),
            10_000,
          ),
        ),
      ]);
      let text = "";
      const off = runtime.onNotification("item/completed", (params) => {
        const item = (params as { item?: { type?: string; text?: string } })
          ?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          text += item.text;
        }
      });
      try {
        await Promise.race([
          runtime.runTurn({
            threadId,
            input: [
              {
                type: "text",
                text: `${opts.systemPrompt}\n\n${opts.prompt}`,
                text_elements: [],
              },
            ],
            model: opts.model,
            approvalPolicy,
            sandboxPolicy,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("title turn timeout")),
              opts.timeoutMs ?? 30_000,
            ),
          ),
        ]);
      } finally {
        off();
      }
      return text;
    } finally {
      // Dispose whatever booted — even if a race above timed out waiting.
      void boot.then((h) => h.dispose()).catch(() => {});
    }
  }

  /** One `account/read` round-trip → AccountDetails (null for non-ChatGPT
   *  auth). `planType` is sent raw; the renderer title-cases it. */
  private async readAccount(
    runtime: CodexAppServerHandle,
  ): Promise<AccountDetails | null> {
    const resp = await runtime.request<GetAccountResponse>(
      "account/read",
      { refreshToken: false } satisfies GetAccountParams,
      { timeoutMs: 5_000 },
    );
    const account = resp?.account;
    if (!account || account.type !== "chatgpt") return null;
    return {
      provider: "OpenAI",
      plan: account.planType || undefined,
      email: account.email || undefined,
    };
  }

  /** Tear down ONE codex session — its `codex app-server` child + session
   *  dir. Called by the gateway on chat-tab close so closed Codex chats
   *  don't keep an app-server child alive until app quit. */
  async disposeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.pendingApprovals.clear();
    s.pendingMcpApprovals.clear();
    s.pendingQuestions.clear();
    this.disposing.add(sessionId);
    try {
      await s.runtime.dispose().catch(() => {});
      await removeSessionDir(s.zerosSessionId).catch(() => {});
    } finally {
      // Keep the suppression alive briefly past dispose() in case the child's
      // exit event lands a tick later, then release the marker.
      const t = setTimeout(() => this.disposing.delete(sessionId), 2000);
      t.unref?.();
    }
  }

  async dispose(): Promise<void> {
    const all = Array.from(this.sessions.values());
    for (const s of all) this.disposing.add(s.zerosSessionId);
    this.sessions.clear();
    await Promise.allSettled(
      all.map(async (s) => {
        // Drain pending approvals on this session's pendingApprovals
        // map before disposing the runtime. The runtime's own dispose
        // also auto-cancels its in-flight approval promises, so this
        // is belt-and-braces — but it keeps the adapter map clean.
        s.pendingApprovals.clear();
        s.pendingMcpApprovals.clear();
        s.pendingQuestions.clear();
        await s.runtime.dispose();
        // Best-effort session dir removal.
        await removeSessionDir(s.zerosSessionId).catch(() => {});
      }),
    );
  }

  // ── Internal ─────────────────────────────────────────────

  private requireSession(sessionId: string): CodexSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown codex session: ${sessionId}`);
    return s;
  }

  /** Shared boot path for `newSession` and `loadSession`. */
  private async bootSession(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    /** Per-session MCP registry (gateway-resolved for this cwd); undefined →
     *  the global ctx.mcpServers. */
    mcpServers?: McpServerRegistration[];
    /** Zeros' first-turn instruction body → `developerInstructions` on
     *  thread/start AND thread/resume (see `nativeSystemInstruction`). */
    systemInstruction?: string;
    kind: "new" | "resume";
    /** Required when kind === "resume". */
    resumeThreadId?: string;
    /** When kind === "resume", caller may want the Zeros sessionId to
     *  match the codex thread id (so the UI's persistent key resolves
     *  through listSessions). For kind === "new", a fresh UUID. */
    zerosSessionId?: string;
  }): Promise<{ session: CodexSession; resumedFresh: boolean }> {
    // The boot tag needs an id before thread/start returns, but it is NOT the
    // public resume handle. Codex's returned threadId is the only id that can
    // be resumed after this adapter process exits.
    const bootSessionId = opts.zerosSessionId ?? randomUUID();

    // Always boot in "ask". The UI's mode pill is the canonical setter;
    // env-driven overrides would race the pill's persisted value, so
    // they're rejected.
    const initialMode: CodexModeId = "ask";

    // Boot the runtime first; we pass an onApprovalRequest closure that
    // will mutate `session.pendingApprovals` once the session object
    // exists. Two-phase init: we forward-declare the session ref and
    // assign it on the next line.
    // eslint-disable-next-line prefer-const -- assigned after runtime boot; closures above capture the live ref.
    let session!: CodexSession;
    let runtime: CodexAppServerHandle;
    const sessionMcpServers = opts.mcpServers ?? this.ctx.mcpServers;
    const trustedMcpServers = new Set(
      sessionMcpServers
        .filter((server) => server.trusted === true)
        .map((server) => server.name),
    );
    try {
      runtime = await bootCodexAppServerRuntime({
        cwd: opts.cwd,
        env: opts.env,
        cliBinary: opts.cliBinary,
        clientInfo: CLIENT_INFO,
        mcpServers: sessionMcpServers,
        logTag: `codex-app-server:${bootSessionId.slice(0, 8)}`,
        onApprovalRequest: (request) =>
          this.handleApprovalRequest(session, request),
        onUserInputRequest: (request) =>
          this.handleUserInputRequest(session, request),
        onUserInputSettled: (questionId) =>
          this.handleUserInputSettled(session, questionId),
        onMcpElicitationRequest: (request) =>
          this.handleMcpElicitationRequest(session, request),
        onMcpElicitationSettled: (elicitationId) =>
          this.handleMcpElicitationSettled(session, elicitationId),
        onStderr: (line) => {
          this.ctx.emit.onAgentStderr(this.agentId, line);
        },
        // `session` is forward-declared and assigned just below, so the
        // closure captures it by reference — the exit handler resolves the
        // live object even though it's undefined at spawn time (a crash
        // during boot; handled inside).
        onExit: (code, signal) => this.handleRuntimeExit(session, code, signal),
      });
    } catch (err) {
      // Initialize-time failures with auth-flavoured messages should
      // surface as the canonical auth-required AgentFailure so the
      // gateway flips the green dot + the UI shows the "sign in"
      // banner — same surface the legacy adapter routes through.
      throw classifyBootFailure(
        err,
        opts.kind === "resume" ? "loadSession" : "newSession",
      );
    }

    let threadId: string;
    let threadModel: string | null = null;
    // True when a `kind:"resume"` could not load the rollout and fell through to
    // a fresh thread below — the gateway re-injects the first-turn
    // <system_instruction> in that case (the fresh thread has no history).
    let resumedFresh = false;
    try {
      if (opts.kind === "resume" && opts.resumeThreadId) {
        try {
          // Pass the CURRENT cwd as a resume override. thread/resume loads
          // the thread from disk by id and otherwise keeps the rollout's
          // ORIGINAL directory — so resuming a chat in a different worktree
          // would silently edit the wrong tree. ThreadResumeParams.cwd
          // overrides it to where the user actually is now.
          // developerInstructions rides along so a resumed thread keeps (or,
          // for pre-native sessions, gains) the workspace orientation on the
          // proper channel.
          const result = await runtime.resumeThread({
            threadId: opts.resumeThreadId,
            cwd: opts.cwd,
            ...(opts.systemInstruction
              ? { developerInstructions: opts.systemInstruction }
              : {}),
          });
          threadId = result.threadId;
          threadModel = result.model ?? null;
        } catch (resumeErr) {
          // 2026-05-28: when codex says "no rollout for this thread"
          // (typically because the previous turn/start failed and no
          // rollout was ever persisted), don't strand the user on a
          // dead chat. Fall through to thread/start so they keep
          // working — the renderer-side transcript still shows their
          // history, only the codex-side rollout is fresh. Any error
          // shape OTHER than session-expired (auth, network, etc.)
          // still surfaces normally.
          const classified = classifyThreadFailure(resumeErr, "loadSession");
          const isStaleRollout =
            classified instanceof AgentFailureError &&
            classified.failure.kind === "session-expired";
          if (!isStaleRollout) throw classified;
          console.warn(
            `[codex-app-server] thread/resume found no rollout for ` +
              `${opts.resumeThreadId}; auto-starting a fresh thread`,
          );
          const fresh = await runtime.startThread(
            buildThreadStartParams(
              opts.cwd,
              opts.env,
              initialMode,
              opts.systemInstruction,
            ),
          );
          threadId = fresh.threadId;
          threadModel = fresh.model ?? null;
          resumedFresh = true;
        }
      } else {
        const result = await runtime.startThread(
          buildThreadStartParams(
            opts.cwd,
            opts.env,
            initialMode,
            opts.systemInstruction,
          ),
        );
        threadId = result.threadId;
        threadModel = result.model ?? null;
      }
    } catch (err) {
      await runtime.dispose();
      // thread/resume against a rollout codex has cleaned up surfaces
      // as a "no rollout found"-shaped error. Classify so the UI's
      // session-expired pill renders instead of a generic alert. The
      // resume → start fallback above absorbs the common case, so by
      // the time we reach here the error is non-recoverable.
      throw classifyThreadFailure(
        err,
        opts.kind === "resume" ? "loadSession" : "newSession",
      );
    }

    // Canonicalize every live/public session to Codex's persisted rollout id.
    // For a new chat this prevents the renderer from storing an unresumable
    // local UUID. For a stale legacy resume, thread/start's replacement id is
    // returned to the gateway so routing + the chat row migrate in one pass.
    const zerosSessionId = threadId;
    try {
      await ensureSessionDir(zerosSessionId);
    } catch (err) {
      await runtime.dispose();
      throw classifyThreadFailure(
        err,
        opts.kind === "resume" ? "loadSession" : "newSession",
      );
    }

    const translator = new CodexAppServerTranslator({
      sessionId: zerosSessionId,
      emit: (notification: SessionNotification) =>
        this.ctx.emit.onSessionUpdate(this.agentId, notification),
      onUnknown: (method, _params) => {
        console.log(`[codex-app-server] unknown notification: ${method}`);
      },
    });

    this.wireRuntimeToTranslator(runtime, translator);

    session = {
      zerosSessionId,
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      runtime,
      translator,
      threadId,
      threadModel,
      modeId: initialMode,
      activeTurnId: null,
      activeTurns: new Map(),
      sawCollabTurns: false,
      cancelRequested: false,
      postCancelInterruptUntil: 0,
      pendingApprovals: new Map(),
      pendingMcpApprovals: new Map(),
      trustedMcpServers,
      pendingQuestions: new Map(),
      fileEditPathsByItemId: new Map(),
      authMode: null,
      planType: null,
      latestRateLimits: null,
      turnActive: false,
      runtimeAlive: true,
      childExitedMidTurn: false,
    };
    this.sessions.set(zerosSessionId, session);

    this.wireTurnTracking(session, runtime);
    this.wireFileChangeCapture(session, runtime);
    this.wireAccountListeners(session, runtime);

    // Slash-command discovery. Codex is a bespoke (non-stream-json)
    // adapter, so it doesn't inherit the shared first-prompt discovery
    // hook. We pull from two sources and merge them:
    //   - file-based custom prompts ($CODEX_HOME/prompts → /promptname),
    //   - the app-server's `skills/list` RPC.
    // The renderer unions the result with Codex's curated built-in commands.
    // Re-run on `skills/changed` so a skill added/removed mid-session
    // reflects live. Fire-and-forget: a scan/RPC failure never blocks boot.
    // Codex registers its bundled (system-scope) skills — the namespaced ones
    // like `browser:…` / `documents:…`, compiled into the binary, NOT on disk —
    // asynchronously AFTER init, so the first skills/list often returns only the
    // user skills (~/.codex/skills). Re-poll a few times early (bounded) so the
    // full set lands within seconds instead of whenever skills/changed
    // eventually fires. Each call re-emits (replace); a stale timer firing after
    // teardown is harmless — the RPC rejects and is caught in refreshCommands.
    for (const delayMs of [0, 1500, 4000, 9000]) {
      if (delayMs === 0) void this.refreshCommands(session);
      else setTimeout(() => void this.refreshCommands(session), delayMs);
    }
    runtime.onNotification("skills/changed", () => {
      void this.refreshCommands(session);
    });

    return { session, resumedFresh };
  }

  /** The `codex app-server` child for a session exited. Three cases:
   *
   *   1. Boot crash (`session` still undefined) — bootSession's own
   *      try/catch surfaces + classifies the failure; broadcasting an
   *      agent-wide exit here would wrongly flip sibling chats, so no-op.
   *   2. Mid-turn crash (`turnActive`) — the in-flight prompt() sees
   *      runTurn resolve "failed", reads `childExitedMidTurn`, and throws a
   *      recoverable transport-closed so the renderer rebuilds + resends
   *      automatically. Don't broadcast — prompt() owns this chat's recovery.
   *   3. Idle crash — broadcast a SESSION-SCOPED exit so only THIS chat
   *      flips to reconnecting (one child per session; the old agent-wide
   *      signal flipped every open Codex chat). The next send revives it.
   *
   *  Either way the session stays in the map (so a late respondToPermission
   *  no-ops rather than hard-errors); chat-tab close / dispose evicts it. */
  private handleRuntimeExit(
    session: CodexSession | undefined,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Case 1 — crash before the session object was assigned (during boot).
    if (!session) return;

    session.runtimeAlive = false;
    // Clear lifecycle state tied to the dead runtime:
    //   - activeTurnId → a later cancel() would interrupt a dead turn id.
    //   - pendingApprovals → respondToPermission would look OK but the
    //     codex side is gone.
    session.activeTurnId = null;
    session.activeTurns.clear();
    session.pendingApprovals.clear();
    session.pendingMcpApprovals.clear();
    session.pendingQuestions.clear();
    session.fileEditPathsByItemId.clear();

    // Case 2 — mid-turn crash. The in-flight prompt() recovers.
    if (session.turnActive) {
      session.childExitedMidTurn = true;
      return;
    }

    // Intentional teardown (chat-tab close / adapter dispose) already tore
    // the child down on purpose — don't announce it as a crash.
    if (this.disposing.has(session.zerosSessionId)) return;

    // Case 3 — idle crash. Scope the reconnecting flip to this one chat.
    this.ctx.emit.onAgentExit(
      this.agentId,
      code,
      signal,
      session.zerosSessionId,
    );
  }

  /** Re-discover Codex slash commands — file-based custom prompts merged
   *  with the app-server's skills/list — and emit available_commands_update.
   *  Best-effort: a failure on either source degrades to the other (and the
   *  renderer still shows the curated built-in floor). */
  private async refreshCommands(session: CodexSession): Promise<void> {
    try {
      const { discoverCommands } = await import("../shared/discovery");
      const [fileCmds, skillCmds] = await Promise.all([
        discoverCommands({ agentId: this.agentId, cwd: session.cwd }),
        this.discoverSkills(session),
      ]);
      // Custom prompts win over skills on a name clash (prompts are the
      // explicit /command convention).
      const commands = mergeCommands(skillCmds, fileCmds);
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: session.zerosSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: commands,
        },
      });
    } catch (err) {
      console.warn(
        `[codex-app-server] slash-command discovery failed: ${String(err)}`,
      );
    }
  }

  /** Query the app-server's `skills/list` for the session's cwd. Returns []
   *  on any error (older app-servers may not implement it) so discovery
   *  degrades to file-based prompts + curated built-ins. */
  private async discoverSkills(
    session: CodexSession,
  ): Promise<AvailableCommand[]> {
    try {
      const resp = await session.runtime.request<{
        data?: Array<{
          skills?: Array<{
            name?: string;
            description?: string;
            shortDescription?: string;
            enabled?: boolean;
          }>;
        }>;
      }>(
        "skills/list",
        // forceReload bypasses a stale boot-time cache so a re-poll picks up the
        // bundled skills the moment the app-server has registered them.
        { cwds: [session.cwd], forceReload: true },
        { timeoutMs: 8_000 },
      );
      const out: AvailableCommand[] = [];
      const seen = new Set<string>();
      for (const entry of resp?.data ?? []) {
        for (const s of entry?.skills ?? []) {
          if (!s?.name || s.enabled === false || seen.has(s.name)) continue;
          seen.add(s.name);
          out.push({
            name: s.name,
            description: s.description ?? s.shortDescription ?? "",
            // From the `skills/list` RPC → definitionally a skill (file-based
            // custom prompts and the curated floor are commands). Drives the
            // picker's Skills tab + badge.
            kind: "skill",
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Subscribe to the codex app-server's structured auth + rate-limit
   *  notifications. The translator deliberately swallows these so they
   *  don't appear as chat bubbles; the adapter is the right home for
   *  the captured state because that's where the gateway-facing
   *  emit / failure handles live. */
  private wireAccountListeners(
    session: CodexSession,
    runtime: CodexAppServerHandle,
  ): void {
    runtime.onNotification("account/updated", (params) => {
      const p = (params ?? {}) as {
        authMode?: string | null;
        planType?: string | null;
      };
      const prevAuthMode = session.authMode;
      session.authMode = p.authMode ?? null;
      session.planType = p.planType ?? null;
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex-app-server:${session.zerosSessionId.slice(0, 8)}] account.updated authMode=${session.authMode} plan=${session.planType}`,
      );
      // Auth was good, now it's null/expired — the session is alive but
      // the next turn will fail. Surfacing via stderr lets the gateway's
      // listAgents probe / settings panel re-poll. A future polish is
      // to emit a typed bridge event so the UI's auth banner flips
      // without waiting for the next listAgents tick.
      if (prevAuthMode && !session.authMode) {
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[codex-app-server] auth dropped — user needs to re-run \`codex login\``,
        );
      }
    });

    runtime.onNotification("account/rateLimits/updated", (params) => {
      session.latestRateLimits = params ?? null;
      // No bridge fan-out yet — the legacy adapter didn't have one
      // either. nimbalyst built a UsageService around this; we'll
      // follow suit when the UI has a usage surface to render into.
    });

    runtime.onNotification("account/login/completed", (_params) => {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex-app-server:${session.zerosSessionId.slice(0, 8)}] account.login.completed`,
      );
    });
  }

  /** Maintain `session.activeTurns` (threadId → in-flight turnId) from the
   *  child's turn/item notifications. One app-server child per session, so
   *  every notification on this runtime belongs to this session — including
   *  turns on collab SUBAGENT threads, which cancel()'s sweep must interrupt
   *  alongside the parent's. item/started is tracked too (it carries
   *  {threadId, turnId}) as a belt-and-braces for any subagent turn whose
   *  turn/started we didn't see — subagent items demonstrably stream (they
   *  render in the timeline), so this path always has the live pairs. */
  private wireTurnTracking(
    session: CodexSession,
    runtime: CodexAppServerHandle,
  ): void {
    const track = (threadId: unknown, turnId: unknown): void => {
      if (typeof threadId !== "string" || typeof turnId !== "string") return;
      if (threadId !== session.threadId) session.sawCollabTurns = true;
      const known = session.activeTurns.get(threadId) === turnId;
      if (!known) session.activeTurns.set(threadId, turnId);
      if (known) return;
      // Interrupt a NEW turn on sight in two windows:
      //   - cancelRequested: Stop was clicked and this turn wasn't in the
      //     sweep — either the parent turn was still being born (cancel
      //     raced the turn/start ack, so cancel() had no turnId to target)
      //     or codex scheduled a subagent turn after the sweep.
      //   - postCancelInterruptUntil with no prompt in flight: a child
      //     finishing right around the interrupt re-triggers a FRESH parent
      //     turn (trigger_turn mailbox delivery) after cancelRequested was
      //     already reset. `turnActive` exempts a user's genuinely new
      //     prompt inside the window.
      const orphanAfterCancel =
        !session.turnActive && Date.now() < session.postCancelInterruptUntil;
      if (session.cancelRequested || orphanAfterCancel) {
        void runtime.interruptTurn(threadId, turnId);
      }
    };
    runtime.onNotification("turn/started", (params) => {
      const p = params as { threadId?: string; turn?: { id?: string } };
      track(p?.threadId, p?.turn?.id);
    });
    runtime.onNotification("item/started", (params) => {
      const p = params as { threadId?: string; turnId?: string };
      track(p?.threadId, p?.turnId);
    });
    runtime.onNotification("turn/completed", (params) => {
      const p = params as { threadId?: string };
      if (typeof p?.threadId === "string") {
        session.activeTurns.delete(p.threadId);
      }
    });
  }

  /** Cache each fileChange item's file paths by itemId as it streams, so a
   *  later fileChange APPROVAL — whose params carry only the itemId, never
   *  the changes[] — can show which / how many files the patch touches. A
   *  single Codex patch can span several files in one gate; item/started
   *  fires before the approval, so the list is present by approval time. */
  private wireFileChangeCapture(
    session: CodexSession,
    runtime: CodexAppServerHandle,
  ): void {
    const capture = (params: unknown): void => {
      const item = (params as { item?: { type?: string; id?: string } })?.item;
      if (!item || item.type !== "fileChange" || typeof item.id !== "string") {
        return;
      }
      const paths = fileChangePaths(item);
      // Only overwrite when we actually parsed paths — a later empty update
      // must not erase a good list captured on item/started.
      if (paths.length > 0) session.fileEditPathsByItemId.set(item.id, paths);
    };
    runtime.onNotification("item/started", capture);
    runtime.onNotification("item/completed", capture);
  }

  /** Codex sent an approval request — record it, map params, emit to
   *  the gateway. The decision flows back via respondToPermission. */
  private handleApprovalRequest(
    session: CodexSession,
    request: CodexApprovalRequest,
  ): void {
    session.pendingApprovals.set(request.permissionId, {
      runtime: session.runtime,
      method: request.method,
      params: request.params,
    });
    const canonical = mapApprovalToCanonical(session, request);
    this.ctx.emit.onPermissionRequest(
      this.agentId,
      request.permissionId,
      canonical,
    );
  }

  /** Codex forwards MCP tool approvals through its elicitation request. Honor
   *  the active Zeros mode here instead of letting `approvalPolicy:"never"`
   *  reject them before the client sees them:
   *    - Full Access accepts;
   *    - Auto-Edit accepts only Zeros-minted trusted servers;
   *    - Ask surfaces the normal permission card;
   *    - Read-Only declines writes.
   *  Real/unknown MCP forms have no safe canonical UI mapping yet, so they are
   *  cancelled immediately rather than hanging or accidentally consenting. */
  private handleMcpElicitationRequest(
    session: CodexSession,
    request: CodexMcpElicitationRequest,
  ): void {
    const params = request.params as unknown as Record<string, unknown>;
    const meta = recordField(params, "_meta") ?? {};
    if (stringField(meta, "codex_approval_kind") !== "mcp_tool_call") {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex] Unsupported MCP elicitation from ${stringField(params, "serverName") ?? "unknown server"}; cancelled safely.`,
      );
      session.runtime.respondToMcpElicitation(
        request.elicitationId,
        mcpElicitationDecision("cancel"),
      );
      return;
    }

    const serverName = stringField(params, "serverName") ?? "unknown";
    if (session.modeId === "full-access") {
      session.runtime.respondToMcpElicitation(
        request.elicitationId,
        mcpElicitationDecision("accept"),
      );
      return;
    }
    if (session.modeId === "read-only") {
      session.runtime.respondToMcpElicitation(
        request.elicitationId,
        mcpElicitationDecision("decline"),
      );
      return;
    }
    if (
      session.modeId === "auto-edit" &&
      session.trustedMcpServers.has(serverName)
    ) {
      session.runtime.respondToMcpElicitation(
        request.elicitationId,
        mcpElicitationDecision("accept"),
      );
      return;
    }

    session.pendingMcpApprovals.set(request.elicitationId, {
      runtime: session.runtime,
    });
    this.ctx.emit.onPermissionRequest(
      this.agentId,
      request.elicitationId,
      mapMcpApprovalToCanonical(session, request),
    );
  }

  private handleMcpElicitationSettled(
    session: CodexSession | undefined,
    elicitationId: string,
  ): void {
    session?.pendingMcpApprovals?.delete(elicitationId);
  }

  /** A blocking user-input question (item/tool/requestUserInput). Twin of
   *  handleApprovalRequest — the answer flows back via respondToQuestion. */
  private handleUserInputRequest(
    session: CodexSession,
    request: CodexUserInputRequest,
  ): void {
    const canonical = mapUserInputToQuestion(
      session.zerosSessionId,
      request.questionId,
      request.params,
    );
    session.translator.emitUserInputToolCall(request.params);
    session.pendingQuestions.set(request.questionId, {
      runtime: session.runtime,
      request: canonical,
    });
    this.ctx.emit.onQuestionRequest(
      this.agentId,
      request.questionId,
      canonical,
    );
  }

  /** A user-input question settled inside the runtime WITHOUT a
   *  respondToQuestion (the response timeout answered codex empty). Evict the
   *  pending entry and tell the renderer to drop the parked card. */
  private handleUserInputSettled(
    session: CodexSession,
    questionId: string,
  ): void {
    const pending = session?.pendingQuestions?.get(questionId);
    if (!pending || !session.pendingQuestions.delete(questionId)) return;
    this.settleQuestionRecord(session, questionId, pending.request, {
      outcome: "dismissed",
    });
  }

  /** Post-settle bookkeeping shared by every settle path (answer, vendor-id
   *  fallback answer, timeout): stamp the engine transcript AND emit the
   *  settled echo. The echo is the renderer's DELIVERY RECEIPT — omitting it
   *  on the answer path made the answer-ack watchdog cancel perfectly
   *  healthy Codex turns 10s after every answer (field report 2026-07-04). */
  private settleQuestionRecord(
    session: CodexSession,
    questionId: string,
    request: QuestionRequest,
    outcome: QuestionResponse["outcome"],
  ): void {
    this.stampQuestionRecord(session, request, outcome);
    try {
      this.ctx.emit.onQuestionSettled?.(
        this.agentId,
        questionId,
        session.zerosSessionId,
        outcome,
      );
    } catch (err) {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[zeros] question settle emit failed for ${questionId}: ${String(err)}`,
      );
    }
  }

  /** Durable resolution record: stamp the ENGINE-persisted transcript by
   *  emitting a synthetic tool_call_update carrying the question's outcome
   *  (rawOutput.zerosQuestion). The renderer's optimistic stamp lives only
   *  in memory and is wiped by the next engine-window reconcile / reload;
   *  this makes ANSWERED / SKIPPED authoritative everywhere. Addressed by
   *  the translator's MINTED id (tool_call_update matches on toolCallId);
   *  best-effort — a question whose tool item never streamed has no row to
   *  stamp. */
  private stampQuestionRecord(
    session: CodexSession,
    request: QuestionRequest,
    outcome: QuestionResponse["outcome"],
  ): void {
    try {
      const mintedId = request.toolCallId
        ? session.translator.toolCallIdFor(request.toolCallId)
        : undefined;
      if (!mintedId) return;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: session.zerosSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: mintedId,
          status: "completed",
          rawOutput: { zerosQuestion: buildQuestionStamp(request, outcome) },
        },
      } as never);
    } catch {
      /* best-effort — the settle itself already succeeded */
    }
  }

  private wireRuntimeToTranslator(
    runtime: CodexAppServerHandle,
    translator: CodexAppServerTranslator,
  ): void {
    const methods = [
      "thread/started",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/completed",
      "turn/diff/updated",
      "turn/plan/updated",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/plan/delta",
      "item/commandExecution/outputDelta",
      "item/commandExecution/terminalInteraction",
      "item/fileChange/outputDelta",
      "item/fileChange/patchUpdated",
      "process/outputDelta",
      "command/exec/outputDelta",
      "error",
      "warning",
      "deprecationNotice",
      "configWarning",
      "guardianWarning",
      "account/updated",
      "account/rateLimits/updated",
      "account/login/completed",
    ];
    for (const m of methods) {
      runtime.onNotification(m, (params) => translator.handle(m, params));
    }
  }

  /** Materialise base64 image blocks to per-session tempfiles and
   *  build the codex `UserInput` array. We don't unlink the temp files
   *  immediately because codex may still be reading them when this
   *  resolves (rare back-to-back prompts). The session dir is removed
   *  in dispose. */
  private async buildUserInput(
    session: CodexSession,
    blocks: ContentBlock[],
  ): Promise<CodexUserInput[]> {
    const out: CodexUserInput[] = [];
    let imagesDir: string | null = null;
    let imageIndex = 0;

    for (const b of blocks) {
      const block = b as unknown as {
        type?: string;
        text?: string;
        data?: string;
        mimeType?: string;
        uri?: string;
      };

      if (block.type === "text" && typeof block.text === "string") {
        out.push({ type: "text", text: block.text, text_elements: [] });
        continue;
      }

      if (block.type === "resource_link" && typeof block.uri === "string") {
        out.push({
          type: "text",
          text: `@${block.uri.replace(/^file:\/\//, "")}`,
          text_elements: [],
        });
        continue;
      }

      if (block.type === "image" && typeof block.data === "string") {
        if (!imagesDir) {
          const { env } = await ensureSessionDir(session.zerosSessionId);
          imagesDir = path.join(env, "codex", "images");
          await fsp.mkdir(imagesDir, { recursive: true });
        }
        // Map mime → extension. Codex's local-image ingestion accepts
        // jpeg/png/webp/gif at minimum; .bin is a graceful fallback so
        // codex returns an explicit reject rather than us silently
        // dropping the block.
        const ext = mimeToExt(block.mimeType);
        const filePath = path.join(
          imagesDir,
          `${Date.now()}-${imageIndex++}.${ext}`,
        );
        try {
          await fsp.writeFile(filePath, Buffer.from(block.data, "base64"));
          out.push({ type: "localImage", path: filePath });
        } catch (err) {
          // Don't fail the whole prompt over one bad image — log and skip.
          console.warn(
            `[codex-app-server] image materialise failed (${filePath}): ${String(err)}`,
          );
        }
        continue;
      }

      // Audio / embedded resource / unknown — drop silently for now.
      // The InitializeResponse capability matrix already advertises
      // image=true / audio=false, so the UI won't have passed audio
      // unless something is misconfigured.
    }

    if (out.length === 0) {
      out.push({ type: "text", text: "", text_elements: [] });
    }
    return out;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function buildInitializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1 as never,
    agentInfo: { name: "Codex", version: "app-server" } as never,
    agentCapabilities: {
      loadSession: { enabled: true } as never,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      } as never,
      mcpCapabilities: { http: true, sse: false } as never,
      sessionCapabilities: { list: {} } as never,
      // Mid-turn steering: steer() sends `turn/steer` against the active
      // turn id. Drives the queued-card "Send now" action.
      steering: true,
    } as never,
    authMethods: [
      {
        id: "terminal",
        name: "Sign in via Terminal",
        description: "Open Terminal.app and run `codex login`.",
      },
    ] as never,
    // The chosen model is carried via OPENAI_MODEL (replaces the bundled
    // catalog's modelEnvVars map). `modelsDynamic` makes the gateway re-poll
    // initialize until model/list discovery fills `_meta.models` post-boot.
    _meta: { modelEnvVar: "OPENAI_MODEL", modelsDynamic: true },
  };
}

// Exported for unit tests — see __tests__/app-server-adapter-params.test.ts.
export function buildThreadStartParams(
  cwd: string,
  env: Record<string, string> | undefined,
  modeId: CodexModeId,
  /** Zeros' first-turn instruction body → the thread's developerInstructions
   *  (the native channel — layers on Codex's built-in system prompt; never
   *  baseInstructions, which would REPLACE it). */
  systemInstruction?: string,
): CodexThreadStartParams {
  const model = env?.OPENAI_MODEL;
  const { approvalPolicy, sandboxMode } = modePolicyFor(modeId);
  return {
    cwd,
    ...(model ? { model } : {}),
    ...(systemInstruction ? { developerInstructions: systemInstruction } : {}),
    approvalPolicy,
    sandbox: sandboxMode,
  };
}

export interface CodexModePolicy {
  approvalPolicy: CodexApprovalPolicy;
  /** Simple kebab-case mode string for `thread/start.sandbox`. The Rust
   *  `SandboxMode` enum is externally-tagged with no payload — must
   *  serialize as a plain string, never a tagged object. */
  sandboxMode: CodexSandboxMode;
  /** Full per-turn policy for `turn/start.sandboxPolicy`. The Rust
   *  `SandboxPolicy` enum is internally-tagged on `type`, with
   *  kebab-case variant names and snake_case field names. */
  sandboxPolicy: CodexSandboxPolicy;
}

/** Resolve Zeros' permissions modes onto the two distinct sandbox
 *  surfaces Codex exposes:
 *    - `thread/start.sandbox` takes a SandboxMode STRING (kebab-case
 *      — `codex-rs/app-server-protocol/v2/shared.rs`).
 *    - `turn/start.sandboxPolicy` takes a SandboxPolicy OBJECT
 *      (internally-tagged, **camelCase** variant + field names —
 *      `codex-rs/app-server-protocol/v2/permissions.rs`).
 *  Both must be derived from the same logical intent so the thread
 *  the user sees in the UI matches what runs on disk.
 *
 *  2026-05-28 (second pass): the original camelCase shape was
 *  correct for SandboxPolicy — an earlier guess re-cast everything
 *  to kebab-case to match the legacy `codex-rs/protocol` SandboxPolicy
 *  enum (different module! also kebab-case, also wrong for v2). The
 *  v2 app-server wraps that core enum with camelCase serde attrs, so
 *  sending kebab-case failed with `turn/start: Invalid request:
 *  unknown variant 'workspace-write', expected one of
 *  'dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite'`.
 */
export function modePolicyFor(modeId: CodexModeId): CodexModePolicy {
  switch (modeId) {
    case "ask":
      return {
        // "untrusted" = codex prompts before any non-trivially-safe command
        // — the actual "Ask First" contract. The previous "on-request" only
        // asked when the MODEL chose to escalate, which made ask and
        // auto-edit behave identically.
        approvalPolicy: "untrusted",
        sandboxMode: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "auto-edit":
      return {
        // codex deprecated "on-failure" (warning in every turn, 2026-07-04);
        // "on-request" is the replacement it names for interactive runs and
        // matches the codex CLI's own "Auto" preset (workspace-write +
        // on-request): sandboxed work runs freely, escalations ask.
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "full-access":
      return {
        // `never` also auto-rejects MCP elicitations before this client can
        // answer them, producing the misleading "user rejected MCP tool call"
        // error. Keep every other approval category non-interactive while
        // allowing MCP requests through to the explicit policy below.
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: false,
            mcp_elicitations: true,
          },
        },
        sandboxMode: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    case "read-only":
      return {
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
  }
}

/** Translate Zeros' ChatEffort wire value (set in
 *  ZEROS_THINKING_EFFORT by `envForChatSettings`) onto the Codex
 *  app-server's `turn/start.effort` enum.
 *
 *  The generated ReasoningEffort enum is
 *  none | minimal | low | medium | high | xhigh — so "xhigh" is now
 *  passed through natively (it used to be clamped to "high" when Codex
 *  capped there). Unknown / empty values stay unset so Codex picks its
 *  own default (typically "medium"). */
function mapEffortFromEnv(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  switch (value?.trim().toLowerCase()) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    // Zeros-only levels: Codex's enum tops out at "xhigh" (no max/ultracode),
    // so clamp both down to "xhigh" — its highest reasoning tier.
    case "max":
    case "ultracode":
      return "xhigh";
    default:
      return undefined;
  }
}

function mapStopReason(
  runtimeStatus: "completed" | "failed" | "cancelled",
  translatorReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled",
): StopReason {
  if (runtimeStatus === "cancelled") return "cancelled";
  if (runtimeStatus === "failed") {
    return translatorReason === "end_turn" ? "end_turn" : translatorReason;
  }
  return translatorReason;
}

function mimeToExt(mime: string | undefined): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

// ── requestUserInput params → canonical QuestionRequest ─────

/** Convert a Codex ToolRequestUserInputParams into the canonical QuestionRequest.
 *  Codex specifics: option `id` == `label` (the answer is a label array, so the
 *  labels ARE the ids); Codex currently has no generated multiSelect field, so
 *  option questions default to single-select unless a future boolean appears;
 *  `options: null` → a pure free-text question; `isOther`/`isSecret` map to the
 *  free-text row + masking. */
function mapUserInputToQuestion(
  sessionId: string,
  questionId: string,
  params: Record<string, unknown>,
): QuestionRequest {
  const rawQuestions = Array.isArray(params?.questions)
    ? (params.questions as Array<Record<string, unknown>>)
    : [];
  const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
  const questions: QuestionSpec[] = rawQuestions.map((q, qi) => {
    const options = Array.isArray(q?.options)
      ? (q.options as Array<Record<string, unknown>>).map((o) => {
          const label =
            typeof o?.label === "string" ? o.label : String(o?.label ?? "");
          return {
            id: label, // MUST equal label — the Codex answer is a label array
            label,
            description:
              typeof o?.description === "string" ? o.description : undefined,
          };
        })
      : [];
    return {
      id: typeof q?.id === "string" ? q.id : `q${qi}`,
      prompt: typeof q?.question === "string" ? q.question : "",
      header: typeof q?.header === "string" ? q.header : undefined,
      multiSelect: typeof q?.multiSelect === "boolean" ? q.multiSelect : false,
      options,
      // isOther adds the free-text row ALONGSIDE options; a null/absent
      // options list IS a pure free-text ask, so it must get the row too —
      // otherwise the card renders no input at all and can never be
      // submitted (only dismissed).
      allowOther: q?.isOther === true || options.length === 0,
      secret: q?.isSecret === true,
    };
  });
  return {
    sessionId: sessionId as never,
    questionId,
    nativeRequestId: itemId ?? questionId,
    toolCallId: itemId,
    source: "native_rpc",
    blocking: true,
    // app-server.ts armed its auto-skip timer (APPROVAL_TIMEOUT_MS = the same
    // shared constant) synchronously before forwarding this request, so
    // "now + timeout" matches the empty-answer settle within milliseconds.
    expiresAt: Date.now() + PERMISSION_RESPONSE_TIMEOUT_MS,
    questions,
  };
}

/** Canonical QuestionResponse → Codex ToolRequestUserInputResponse
 *  ({ answers: { [questionId]: { answers: string[] } } }). Since option id ==
 *  label, selectedOptionIds ARE the labels; free-text is appended last. On
 *  dismiss we send empty arrays for every question id (Codex has no cancel
 *  variant — documented in the plan §4.3). */
function mapQuestionAnswerToCodex(
  request: QuestionRequest,
  response: QuestionResponse,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (response.outcome.outcome === "dismissed") {
    for (const q of request.questions) answers[q.id] = { answers: [] };
    return { answers };
  }
  const byId = new Map<string, QuestionAnswer>();
  for (const a of response.outcome.answers) byId.set(a.questionId, a);
  for (const q of request.questions) {
    const a = byId.get(q.id);
    const vals = [...(a?.selectedOptionIds ?? [])];
    if (a?.freeText) vals.push(a.freeText);
    answers[q.id] = { answers: vals };
  }
  return { answers };
}

// ── Approval params → canonical RequestPermissionRequest ─────

/** Convert a codex approval request into the canonical Zeros shape the
 *  gateway broadcasts to the renderer. The option set is identical
 *  across methods (we always offer the same 4 choices); the renderer
 *  decides how to render them. */
export function mapApprovalToCanonical(
  session: CodexSession,
  request: CodexApprovalRequest,
): RequestPermissionRequest {
  const params = request.params;
  const itemId = stringField(params, "itemId") ?? randomUUID();
  const reason = stringField(params, "reason");
  const command = stringField(params, "command");
  const cwd = stringField(params, "cwd");

  let title: string;
  let kind: "execute" | "edit" | "switch_mode";
  let rawInput: unknown;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      title = command ? `Run: ${truncate(command, 60)}` : "Run shell command";
      kind = "execute";
      rawInput = { command, cwd, reason };
      break;
    case "item/fileChange/requestApproval": {
      // Correlate back to the streamed item to surface the file list — the
      // approval params themselves have no changes[]. One patch may touch
      // several files; the card shows a count for >1, the single path for 1.
      const filePaths = session.fileEditPathsByItemId.get(itemId) ?? [];
      title = "Apply file changes";
      kind = "edit";
      rawInput = {
        reason,
        grantRoot: stringField(params, "grantRoot"),
        ...(filePaths.length > 0 ? { filePaths } : {}),
      };
      break;
    }
    case "item/permissions/requestApproval":
      title = reason ? `Permission: ${reason}` : "Expand permissions";
      kind = "switch_mode";
      rawInput = { permissions: params.permissions, reason };
      break;
  }

  return {
    sessionId: session.zerosSessionId as never,
    toolCall: {
      toolCallId: itemId,
      title,
      kind: kind as never,
      status: "pending" as never,
      rawInput,
    } as never,
    options: [
      { optionId: "accept", name: "Approve", kind: "allow_once" },
      {
        optionId: "acceptForSession",
        name: "Approve for session",
        kind: "allow_always",
      },
      { optionId: "decline", name: "Decline", kind: "reject_once" },
      { optionId: "cancel", name: "Cancel", kind: "reject_always" },
    ] as never,
  } as never;
}

function mapMcpApprovalToCanonical(
  session: CodexSession,
  request: CodexMcpElicitationRequest,
): RequestPermissionRequest {
  const params = request.params as unknown as Record<string, unknown>;
  const meta = recordField(params, "_meta") ?? {};
  const serverName = stringField(params, "serverName") ?? "unknown";
  const toolTitle = stringField(meta, "tool_title") ?? "MCP tool";
  const toolDescription = stringField(meta, "tool_description");
  const message = stringField(params, "message");
  const toolParams = recordField(meta, "tool_params") ?? {};

  const persistRaw = meta.persist;
  const persist = new Set(
    (Array.isArray(persistRaw) ? persistRaw : [persistRaw]).filter(
      (value): value is string => typeof value === "string",
    ),
  );
  const options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }> = [{ optionId: "accept", name: "Approve", kind: "allow_once" }];
  if (persist.has("session")) {
    options.push({
      optionId: "acceptForSession",
      name: "Approve for session",
      kind: "allow_always",
    });
  }
  if (persist.has("always")) {
    options.push({
      optionId: "acceptAlways",
      name: "Always approve",
      kind: "allow_always",
    });
  }
  options.push(
    { optionId: "decline", name: "Decline", kind: "reject_once" },
    { optionId: "cancel", name: "Cancel", kind: "reject_always" },
  );

  return {
    sessionId: session.zerosSessionId as never,
    toolCall: {
      toolCallId: request.elicitationId,
      title: `${serverName}: ${toolTitle}`,
      kind: (session.trustedMcpServers.has(serverName)
        ? "edit"
        : "execute") as never,
      status: "pending" as never,
      rawInput: {
        ...toolParams,
        server: serverName,
        tool: toolTitle,
        ...(toolDescription ? { description: toolDescription } : {}),
        ...(message ? { reason: message } : {}),
      },
    } as never,
    options: options as never,
  } as never;
}

function mcpElicitationDecision(
  action: "accept" | "decline" | "cancel",
  persist?: "session" | "always",
): CodexMcpElicitationResponse {
  return {
    action,
    content: null,
    _meta: persist ? { persist } : null,
  };
}

function mapResponseToMcpElicitation(
  response: RequestPermissionResponse,
): CodexMcpElicitationResponse {
  if (response.outcome.outcome === "cancelled") {
    return mcpElicitationDecision("cancel");
  }
  switch (response.outcome.optionId) {
    case "accept":
      return mcpElicitationDecision("accept");
    case "acceptForSession":
      return mcpElicitationDecision("accept", "session");
    case "acceptAlways":
      return mcpElicitationDecision("accept", "always");
    case "decline":
      return mcpElicitationDecision("decline");
    case "cancel":
    default:
      return mcpElicitationDecision("cancel");
  }
}

/** Convert a Zeros RequestPermissionResponse into the method-specific
 *  codex approval response shape. Receives the full PendingApproval so
 *  the permissions-request path can mirror the agent's *original*
 *  permission profile back as the grant (instead of a blanket
 *  enable-everything when the user clicks Approve). */
export function mapResponseToCodexDecision(
  pending: PendingApproval,
  response: RequestPermissionResponse,
): unknown {
  const { method, params } = pending;
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") {
    return defaultMethodResponse(method, "cancel");
  }
  // outcome.outcome === "selected"
  const optionId = (outcome as { optionId: string }).optionId;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      // Map optionId → CommandExecutionApprovalDecision /
      // FileChangeApprovalDecision string union. Both share the same
      // base set of string values.
      switch (optionId) {
        case "accept":
          return { decision: "accept" };
        case "acceptForSession":
          return { decision: "acceptForSession" };
        case "decline":
          return { decision: "decline" };
        case "cancel":
        default:
          return { decision: "cancel" };
      }
    }
    case "item/permissions/requestApproval": {
      // PermissionsRequestApprovalResponse = {permissions, scope, strictAutoReview?}
      //
      // B3 refinement: when the user accepts, grant exactly what the
      // agent asked for in `params.permissions` (RequestPermissionProfile
      // shape) — NOT a blanket enable-everything. The codex agent
      // requests the minimum permissions it needs for the next step;
      // mirroring the request keeps the principle-of-least-privilege
      // semantics even without a granular picker UI.
      //
      // A future granular picker would replace this mirror with a
      // custom grant payload riding on the wire (the RequestPermissionResponse
      // shape doesn't currently carry grant fields).
      if (optionId === "decline" || optionId === "cancel") {
        return defaultMethodResponse(method, "decline");
      }
      const requested = params.permissions as
        | {
            network?: { enabled?: boolean };
            fileSystem?: { read?: string[]; write?: string[] };
          }
        | undefined;
      return {
        permissions: {
          network: { enabled: requested?.network?.enabled ?? false },
          fileSystem: {
            read: requested?.fileSystem?.read ?? [],
            write: requested?.fileSystem?.write ?? [],
          },
        },
        scope: optionId === "acceptForSession" ? "session" : "turn",
      };
    }
  }
}

export function defaultMethodResponse(
  method: CodexApprovalMethod,
  decision: "cancel" | "decline",
): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval":
      return {
        permissions: {
          network: { enabled: false },
          fileSystem: { read: [], write: [] },
        },
        scope: "turn",
      };
  }
}

function stringField(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

function recordField(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = params[key];
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pull the non-empty file paths off a streamed fileChange item's changes[]
 *  ({ path }[]). Lenient about shape — the item comes off the wire untyped.
 *  Exported for unit tests. */
export function fileChangePaths(item: unknown): string[] {
  const changes = (item as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const c of changes) {
    const p = (c as { path?: unknown } | null)?.path;
    if (typeof p === "string" && p.trim().length > 0) paths.push(p);
  }
  return paths;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ── Failure classification ──────────────────────────────────
//
// The gateway routes on AgentFailure.kind: "auth-required" flips the
// green dot and surfaces the sign-in banner; "session-expired" pins
// the chat composer with a recoverable "start fresh" affordance.
// Wrap initialize / thread errors so codex's app-server failure
// modes land on the same UI surfaces as the legacy adapter's.

const AUTH_HINT_RX =
  /\b(not\s+(?:logged|signed)\s*in|please\s+run\s*\/?login|sign[- ]in\s+required|api\s*key\s+(?:not|required|invalid)|refresh\s+token\s+(?:was\s+)?(?:already\s+used|expired|invalid)|access\s+token\s+(?:could\s+not\s+be\s+refreshed|expired|invalid)|log\s+out\s+and\s+sign\s+in|token[_\s-]invalidated|unauthori[sz]ed|401)\b/i;

// Patterns that indicate codex no longer has the rollout/thread we're
// trying to talk to. Broadened from the original "no rollout found"
// regex after t3code's CodexSessionRuntime — codex's wording has
// shifted across versions (e.g. "no longer has a rollout" surfaces
// in 0.131+ vs the older "no rollout found"). The wider net keeps
// the auto-recover-by-falling-back-to-startThread path firing on the
// new wording so the user doesn't see a hard "Session expired" toast.
// IMPORTANT: keep in sync with SESSION_EXPIRED_KEYWORDS in
// shared/session-expiry.ts and SESSION_EXPIRED_RX in
// src/zeros/bridge/failure.ts — same fixture strings must classify
// identically across engine and renderer.
// Exported for the regex-parity test in __tests__/app-server-adapter-failures.test.ts.
// The `agent … not found` / `no such agent` family is for @cursor/sdk
// (Agent.resume "Agent <uuid> not found"); codex never emits it but the
// three regexes must stay byte-for-byte parity-tested together.
export const STALE_THREAD_RX =
  /\b(?:no\s+rollout\s+(?:found|exists?|available)|no\s+longer\s+has\s+(?:a\s+)?rollout|lost\s+the\s+rollout|rollout\s+not\s+found|thread\s+(?:not\s+found|does\s+not\s+exist)|unknown\s+thread|missing\s+thread|no\s+such\s+thread|thread\/resume\s+failed|resume\s+failed|session\s+(?:not\s+found|does\s+not\s+exist|expired)|chat\s+(?:not\s+found|does\s+not\s+exist)|conversation\s+(?:not\s+found|expired)|no\s+conversation\s+found|agent\s+(?:\S+\s+){0,3}(?:not\s+found|does\s+not\s+exist|no\s+longer\s+exists)|no\s+such\s+agent)\b/i;

/** A session's `codex app-server` connection is gone: the child crashed
 *  (mid-turn or idle), or the session was superseded/disposed out from
 *  under a still-in-flight prompt. We classify all of these as
 *  `transport-closed` — a RECOVERABLE failure — so the renderer's
 *  sendPrompt retry rebuilds the session (reboots the child, resumes the
 *  thread) and re-sends automatically, instead of stranding the user on a
 *  hard error they must manually re-send. The "reconnecting" wording is
 *  deliberate: even if the structured `failure` were ever dropped on the
 *  wire (legacy back-compat), the renderer's message-regex fallback
 *  (TRANSPORT_RX) still classifies it as transport-closed. */
export function codexDisconnectedFailure(): AgentFailureError {
  return new AgentFailureError({
    kind: "transport-closed",
    message: "Codex disconnected — reconnecting…",
    stage: "prompt",
    agentId: AGENT_ID,
  });
}

function classifyBootFailure(
  err: unknown,
  stage: "newSession" | "loadSession",
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (AUTH_HINT_RX.test(message)) {
    return new AgentFailureError({
      kind: "auth-required",
      message: `Codex sign-in required: ${message}`,
      stage,
      agentId: AGENT_ID,
    });
  }
  // Surface unmodified so the upstream "boot failed" wrapper retains
  // its stderr-tail context.
  return err instanceof Error ? err : new Error(message);
}

/** Classify a codex error from the thread/turn lifecycle.
 *
 *  Returns AgentFailureError when the message matches our session-
 *  expired or auth-required signatures; otherwise the raw error is
 *  rethrown unchanged so callers can surface it without losing the
 *  original message.
 *
 *  The stage parameter is metadata for the renderer — the regex match
 *  is the actual classification signal. Earlier versions only matched
 *  STALE_THREAD_RX when `isResume` was true (assuming stale rollouts
 *  could only happen on resume), but codex can also surface "no
 *  rollout" mid-turn if a rollout was cleaned up between turns — the
 *  prompt path needs the same auto-classification or the renderer's
 *  session-expired self-heal never fires. */
// Exported for unit testing — see __tests__/app-server-adapter-failures.test.ts.
export function classifyThreadFailure(
  err: unknown,
  stage: "newSession" | "loadSession" | "prompt",
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (STALE_THREAD_RX.test(message)) {
    // Wording differs by stage so the renderer's chip / inline note
    // makes sense: load-time means the chat is being reopened cold;
    // prompt-time means an in-flight turn lost its rollout.
    const friendly =
      stage === "prompt"
        ? "Codex lost the rollout for this thread mid-turn. Reconnecting…"
        : "Codex no longer has a rollout for this thread. Start a fresh chat to continue.";
    return new AgentFailureError({
      kind: "session-expired",
      message: friendly,
      stage,
      agentId: AGENT_ID,
    });
  }
  if (AUTH_HINT_RX.test(message)) {
    return new AgentFailureError({
      kind: "auth-required",
      message: `Codex sign-in required: ${message}`,
      stage,
      agentId: AGENT_ID,
    });
  }
  return err instanceof Error ? err : new Error(message);
}
