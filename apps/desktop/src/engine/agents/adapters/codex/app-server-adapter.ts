// ──────────────────────────────────────────────────────────
// Codex app-server adapter — AgentAdapter implementation.
// ──────────────────────────────────────────────────────────
//
// One bespoke adapter (not StreamJsonAdapter). Per-session lifecycle:
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
// Implemented capabilities:
//   - image attachments (localImage parts, base64 → tempfile)
//   - MCP injection (via `-c mcp_servers.<name>.…` at spawn)
//   - thread/resume + loadSession
//   - approval round-trip (permissionId map + decision routing)
//   - account/* notifications captured on session state
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
import {
  coerceProviderBinding,
  providerBindingForResume,
  type ProviderBinding,
} from "@zeros/protocol/identities";

import type {
  AgentAdapter,
  AgentBrowserUse,
  AgentCapabilityPorts,
  AgentAdapterContext,
  AgentFilesystemTerritory,
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
import { hasKernelExecutionBoundary } from "../../containment/status";
import { advertiseAgentCapabilities } from "../../capabilities";
import { PERMISSION_RESPONSE_TIMEOUT_MS } from "../shared/constants";
import { FirstTokenLatency } from "../shared/first-token-latency";
import {
  answerMcpElicitation,
  buildMcpElicitationQuestion,
  deliveredQuestionOutcome,
  isMcpElicitationResponse,
  mcpElicitationAuditInput,
  type McpElicitationAnswer,
  type McpElicitationRequestLike,
} from "../shared/mcp-elicitation";
import { isDevRuntime } from "../../../runtime";
import {
  codexPromptRequestsBrowserSkill,
  codexBrowserThreadConfig,
  codexNativeBrowserUnavailableReason,
  injectCodexBrowserSkillInput,
  mergeCodexNativeBrowserMcp,
  resolveCodexNativeBrowserRuntime,
  type CodexNativeBrowserSkill,
} from "./browser-tools";
import {
  registerCodexBrowserUseSession,
  settleCodexBrowserUseTurn,
} from "../../../browser/browser-tool-client";
import { resolveCodexBinary } from "./binary-resolver";

import {
  bootCodexAppServerRuntime,
  type CodexApprovalMethod,
  type CodexApprovalPolicy,
  type CodexApprovalRequest,
  type CodexAppServerHandle,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  type CodexThreadStartParams,
  type CodexUserInput,
  type CodexUserInputRequest,
} from "./app-server";
import { CodexAppServerTranslator } from "./app-server-translator";
import { listCodexSessions } from "./history";
import {
  ensureSessionDir,
  removeSessionDir,
  writeSessionMeta,
} from "../../session-paths";
import { mergeCommands } from "@zeros/protocol/builtin-commands";
import { buildQuestionStamp } from "@zeros/protocol/agent-messages";
import { canonicalBrowserOriginGrantKey } from "@zeros/protocol/browser-tools";
import type {
  AgentConfigurationProvenance,
  AgentGoal,
  AgentMemorySettings,
  AgentProviderQuota,
  AdvertisedModel,
  AvailableCommand,
  BackgroundTask,
  PermissionOption,
} from "@zeros/protocol/agent-events";
import type { AccountDetails } from "@zeros/protocol/messages";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { GetAccountParams } from "./generated/v2/GetAccountParams";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot";
import type { ThreadClosedNotification } from "./generated/v2/ThreadClosedNotification";
import type { ThreadDeletedNotification } from "./generated/v2/ThreadDeletedNotification";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse";
import type { ThreadBackgroundTerminalsTerminateResponse } from "./generated/v2/ThreadBackgroundTerminalsTerminateResponse";
import type { ThreadGoal } from "./generated/v2/ThreadGoal";
import type { ThreadGoalGetResponse } from "./generated/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetResponse } from "./generated/v2/ThreadGoalSetResponse";
import type { ItemGuardianApprovalReviewCompletedNotification } from "./generated/v2/ItemGuardianApprovalReviewCompletedNotification";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import {
  codexBackgroundTaskId,
  collectBackgroundTerminals,
  collectLoadedDescendantThreadIds,
  MAX_CODEX_BACKGROUND_TERMINALS,
  MAX_CODEX_BACKGROUND_THREADS,
  reconcileBackgroundTerminals,
} from "./background-terminals";
import {
  mergeCodexRateLimitSnapshot,
  normalizeCodexQuota,
  provenanceFromCodexLayers,
  type CodexRateLimitSnapshotLike,
} from "../../provider-diagnostics";
import type { PreparedBoundary } from "../../containment/types";

const AGENT_ID = "codex";
const BACKGROUND_LIST_CONCURRENCY = 8;
const BACKGROUND_TERMINAL_POLL_MS = 5_000;
const MAX_GUARDIAN_DENIED_ACTIONS = 10;
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

/** Fail-closed response used whenever lifecycle teardown abandons a parked
 * approval without a user choice. */
const CANCELLED_PERMISSION_RESPONSE = {
  outcome: { outcome: "cancelled" },
} as RequestPermissionResponse;

/** The explicit grant used by Codex's "Approve for me" mode. The adapter
 * resolves native approval RPCs itself in that mode, so the renderer never
 * shows a card whose only intended action is approval. */
const AUTO_APPROVE_PERMISSION_RESPONSE = {
  outcome: { outcome: "selected", optionId: "accept" },
} as RequestPermissionResponse;

/** Methods safe to settle without a user card in `auto-edit`. Sandbox
 * escalations (`item/permissions/requestApproval` — network / arbitrary
 * filesystem paths) stay on the normal renderer gate so Approve for me keeps
 * the workspace sandbox. */
const AUTO_EDIT_AUTO_APPROVE_METHODS = new Set<CodexApprovalMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export function autoEditCanAutoApprove(
  request: Pick<CodexApprovalRequest, "method" | "params">,
): boolean {
  if (!AUTO_EDIT_AUTO_APPROVE_METHODS.has(request.method)) return false;
  if (request.method !== "item/commandExecution/requestApproval") return true;
  const available = request.params.availableDecisions;
  // Newer app-server builds can constrain a command gate to policy-amendment
  // decisions. Auto-edit means "approve this operation", not "silently write
  // a persistent policy". If the server supplied an explicit list, auto-settle
  // only when the plain one-shot accept is actually offered.
  return !Array.isArray(available) || available.includes("accept");
}

/** `/review` is a harness command, not a Zeros prompt convention. Recognize
 * only the bare, attachment-free command so ordinary prose and custom review
 * requests keep flowing through the normal turn path. */
export function isCodexWorkingTreeReviewPrompt(
  prompt: ContentBlock[],
): boolean {
  return (
    prompt.length === 1 &&
    prompt[0]?.type === "text" &&
    prompt[0].text.trim() === "/review"
  );
}

const CODEX_MODES: SessionMode[] = [
  {
    id: "ask",
    name: "Ask First",
    description: "Prompt before every tool call (sandbox: workspace-write).",
  },
  {
    id: "auto-edit",
    name: "Auto-Edit",
    description:
      "Approve requested operations automatically while keeping the workspace sandbox.",
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

/** Resolve the renderer's persisted permission posture (plus legacy/native
 * spellings) before thread/start. AGENT_SET_MODE remains the live update path,
 * but seeding from env closes the create/resume window in which the first turn
 * previously ran in `ask` regardless of what the user selected. Unknown values
 * fail safe to Ask First. */
export function codexModeFromEnv(
  env: Record<string, string> | undefined,
): CodexModeId {
  switch (env?.ZEROS_PERMISSION_MODE?.trim().toLowerCase()) {
    case "plan":
    case "plan-only":
    case "read-only":
      return "read-only";
    case "auto":
    case "auto-edit":
      return "auto-edit";
    case "danger":
    case "full":
    case "full-access":
      return "full-access";
    case "tool-approval":
    case "ask":
    default:
      return "ask";
  }
}

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

export interface CodexSession {
  zerosSessionId: string;
  cwd: string;
  env?: Record<string, string>;
  cliBinary?: string;
  territory?: AgentFilesystemTerritory;
  /** Authoritative outer execution boundary. Codex keeps its normal per-mode
   * sandbox/approval posture; an active kernel backend subtracts Design. */
  executionBoundary?: PreparedBoundary;
  runtime: CodexAppServerHandle;
  translator: CodexAppServerTranslator;
  /** Codex threadId — captured from thread/start (new) or thread/resume (load). */
  threadId: string;
  /** Codex session-tree identity. Forked threads retain this root id; it is
   * descriptive provider scope and never a Zeros execution route. */
  providerSessionId: string;
  /** Conversation-owned native IAB host registered to this exact app-server
   * thread. Null when Browser use is disabled or the official runtime/host
   * could not be registered; never contains a tool definition or callback. */
  browserSessionId: string | null;
  /** Exact skill entry resolved from the same verified OpenAI Browser plugin
   * that supplied node_repl. Passing this as app-server UserInput avoids
   * asking the model to reconstruct a versioned plugin-cache path. */
  browserSkill: CodexNativeBrowserSkill | null;
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
  /** questionId → pending blocking-question state (runtime + the request we
   *  built, for answer reshaping + dismiss). Twin of pendingApprovals. */
  pendingQuestions: Map<
    string,
    {
      runtime: CodexAppServerHandle;
      request: QuestionRequest;
      native: CodexUserInputRequest;
    }
  >;
  /** Official Browser origin grants scoped to their native turn. The only
   * normalized pair is apex/www, so arbitrary subdomains remain gated. */
  browserOriginGrantsByTurn: Map<string, Map<string, string>>;
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
  /** Latest sparse-merged native rate-limit snapshot. */
  latestRateLimits: CodexRateLimitSnapshotLike | null;
  /** Set after an authoritative signed-out account update. It fences sparse
   * rate-limit events and an already-in-flight initial read from resurrecting
   * the previous account's quota after logout. */
  quotaUpdatesSuppressed: boolean;
  /** True between `prompt()` start and settle. Lets the runtime-exit
   *  handler tell a mid-turn crash (owned by the in-flight prompt()'s
   *  recoverable retry) from an idle crash (broadcast so the chat shows
   *  reconnecting). */
  turnActive: boolean;
  /** Time-to-first-token for this thread's turns. `turn/started` acknowledges
   *  within milliseconds of `turn/start`, so the settled duration alone could
   *  never say whether a slow turn was slow to BEGIN or slow to finish. */
  firstToken: FirstTokenLatency;
  /** No turn on this app-server child has produced output yet. */
  sawFirstTurnOutput: boolean;
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
  /** Parent plus bounded loaded descendant threads whose detached terminals
   * belong to this exact Zeros execution. */
  backgroundThreadIds: Set<string>;
  /** Last confirmed replace snapshot and the private native routing index. */
  backgroundTasks: Map<string, BackgroundTask>;
  backgroundTaskTargets: Map<string, { threadId: string; processId: string }>;
  /** Coalesces rapid repeated Stop gestures for one exact task. */
  backgroundStopOperations: Map<string, Promise<void>>;
  backgroundWaiting: boolean;
  /** Latest-wins invalidation for overlapping list/terminate refreshes. */
  backgroundRefreshEpoch: number;
  /** One self-scheduling revalidation while native terminal rows are visible. */
  backgroundPollTimer: NodeJS.Timeout | null;
  /** Bounded engine-only raw events. The renderer receives only opaque ids and
   * sanitized review metadata, never a command, cwd, argv, or policy payload. */
  guardianDeniedActions: Map<
    string,
    ItemGuardianApprovalReviewCompletedNotification
  >;
  guardianRetryByReviewId: Map<string, string>;
  guardianRetryOperations: Map<string, Promise<void>>;
  /** Invalidates an older in-flight `thread/goal/get` after any confirmed
   * mutation or native goal notification. */
  goalSnapshotEpoch: number;
}

export class CodexAppServerAdapter implements AgentAdapter {
  readonly agentId = AGENT_ID;
  readonly capabilityPorts = {
    browser: { nativeSession: true },
    account: {
      readQuota: (opts) => this.readProviderQuota(opts),
    },
    configuration: {
      readProvenance: (opts) => this.readConfigurationProvenance(opts),
    },
    memory: {
      readSettings: (opts) => this.readMemorySettings(opts),
      updateSettings: (opts) => this.updateMemorySettings(opts),
      reset: (opts) => this.resetMemory(opts),
    },
    goal: {
      get: (opts) => this.getGoal(opts),
      set: (opts) => this.setGoal(opts),
      clear: (opts) => this.clearGoal(opts),
    },
    safety: {
      retryDeniedAction: (opts) => this.retryDeniedAction(opts),
    },
  } satisfies AgentCapabilityPorts;
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
  /** Last confirmed account snapshot shared across live runtimes and one-shot
   * settings reads. Rolling notifications merge into this value. */
  private latestRateLimitSnapshot: CodexRateLimitSnapshotLike | null = null;
  /** Invalidates in-flight account reads when an authoritative logout clears
   * account-scoped quota state. */
  private quotaSnapshotEpoch = 0;
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

  private async withMemoryRuntime<T>(
    opts: {
      cwd: string;
      env?: Record<string, string>;
      cliBinary?: string;
      executionBoundary?: PreparedBoundary;
    },
    operation: (runtime: CodexAppServerHandle) => Promise<T>,
  ): Promise<T> {
    const runtime = await bootCodexAppServerRuntime({
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      clientInfo: CLIENT_INFO,
      executionBoundary: opts.executionBoundary,
      mcpServers: [],
      logTag: "codex-app-server:memory",
      onStderr: (line) => this.ctx.emit.onAgentStderr(this.agentId, line),
    });
    try {
      return await operation(runtime);
    } finally {
      await runtime.dispose();
    }
  }

  async readConfigurationProvenance(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentConfigurationProvenance> {
    return this.withMemoryRuntime(opts, async (runtime) => {
      const response = await runtime.requestTyped<
        "config/read",
        { layers: unknown }
      >("config/read", { includeLayers: true });
      return provenanceFromCodexLayers(
        response.layers,
        Boolean(opts.territory),
      );
    });
  }

  private async readProviderRateLimitSnapshot(
    runtime: CodexAppServerHandle,
  ): Promise<RateLimitSnapshot & CodexRateLimitSnapshotLike> {
    const response = await runtime.requestTyped<
      "account/rateLimits/read",
      GetAccountRateLimitsResponse
    >("account/rateLimits/read", undefined);
    return response.rateLimits as RateLimitSnapshot &
      CodexRateLimitSnapshotLike;
  }

  async readProviderQuota(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentProviderQuota | null> {
    return this.withMemoryRuntime(opts, async (runtime) =>
      normalizeCodexQuota(await this.readProviderRateLimitSnapshot(runtime)),
    );
  }

  private async readMemorySettingsFromRuntime(
    runtime: CodexAppServerHandle,
  ): Promise<{ settings: AgentMemorySettings; userVersion: string | null }> {
    const response = await runtime.requestTyped<
      "config/read",
      {
        config: unknown;
        layers: Array<{ name: { type?: string }; version: string }> | null;
      }
    >("config/read", { includeLayers: true });
    const config =
      response.config && typeof response.config === "object"
        ? (response.config as Record<string, unknown>)
        : {};
    const features =
      config.features && typeof config.features === "object"
        ? (config.features as Record<string, unknown>)
        : {};
    const memories =
      config.memories && typeof config.memories === "object"
        ? (config.memories as Record<string, unknown>)
        : {};
    return {
      settings: {
        providerId: AGENT_ID,
        // Codex local memories are opt-in. Missing config must remain off.
        localMemoriesEnabled: features.memories === true,
        // The native key is negative; expose a positive product setting.
        toolAssistedGenerationEnabled:
          memories.disable_on_external_context !== true,
        canReset: true,
      },
      userVersion:
        response.layers?.find((layer) => layer.name.type === "user")?.version ??
        null,
    };
  }

  async readMemorySettings(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentMemorySettings> {
    return this.withMemoryRuntime(
      opts,
      async (runtime) =>
        (await this.readMemorySettingsFromRuntime(runtime)).settings,
    );
  }

  async updateMemorySettings(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
    settings: Partial<
      Pick<
        AgentMemorySettings,
        "localMemoriesEnabled" | "toolAssistedGenerationEnabled"
      >
    >;
  }): Promise<AgentMemorySettings> {
    const updated = await this.withMemoryRuntime(opts, async (runtime) => {
      const write = async (): Promise<AgentMemorySettings> => {
        const current = await this.readMemorySettingsFromRuntime(runtime);
        const edits = [
          ...(opts.settings.localMemoriesEnabled === undefined
            ? []
            : [
                {
                  keyPath: "features.memories",
                  value: opts.settings.localMemoriesEnabled,
                  mergeStrategy: "upsert" as const,
                },
              ]),
          ...(opts.settings.toolAssistedGenerationEnabled === undefined
            ? []
            : [
                {
                  keyPath: "memories.disable_on_external_context",
                  value: !opts.settings.toolAssistedGenerationEnabled,
                  mergeStrategy: "upsert" as const,
                },
              ]),
        ];
        await runtime.requestTyped("config/batchWrite", {
          edits,
          expectedVersion: current.userVersion,
          reloadUserConfig: true,
        });
        return (await this.readMemorySettingsFromRuntime(runtime)).settings;
      };

      try {
        return await write();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/(?:version|conflict|stale)/i.test(message)) throw error;
        // User config changed between read and write. Re-read and retry the
        // same idempotent boolean edits once; never loop over external writes.
        return write();
      }
    });

    if (opts.settings.localMemoriesEnabled !== undefined) {
      const mode = updated.localMemoriesEnabled ? "enabled" : "disabled";
      const live = Array.from(this.sessions.values()).filter(
        (session) => session.runtimeAlive,
      );
      const results = await Promise.allSettled(
        live.map((session) =>
          session.runtime.requestTyped("thread/memoryMode/set", {
            threadId: session.threadId,
            mode,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          this.ctx.emit.onAgentStderr(
            this.agentId,
            `[codex-app-server] Failed to synchronize memory mode on a live thread: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          );
        }
      }
    }
    return updated;
  }

  async resetMemory(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<void> {
    await this.withMemoryRuntime(opts, (runtime) =>
      runtime.requestTyped("memory/reset", undefined),
    );
  }

  async getGoal(opts: { sessionId: string }): Promise<AgentGoal | null> {
    const session = this.requireSession(opts.sessionId);
    const response = await session.runtime.requestTyped<
      "thread/goal/get",
      ThreadGoalGetResponse
    >("thread/goal/get", { threadId: session.threadId });
    return response.goal ? canonicalGoal(response.goal) : null;
  }

  async setGoal(opts: {
    sessionId: string;
    update: {
      objective?: string;
      status?: AgentGoal["status"];
      tokenBudget?: number | null;
    };
  }): Promise<AgentGoal> {
    const session = this.requireSession(opts.sessionId);
    const response = await session.runtime.requestTyped<
      "thread/goal/set",
      ThreadGoalSetResponse
    >("thread/goal/set", {
      threadId: session.threadId,
      ...opts.update,
    });
    session.goalSnapshotEpoch += 1;
    return canonicalGoal(response.goal);
  }

  async clearGoal(opts: { sessionId: string }): Promise<void> {
    const session = this.requireSession(opts.sessionId);
    await session.runtime.requestTyped("thread/goal/clear", {
      threadId: session.threadId,
    });
    session.goalSnapshotEpoch += 1;
  }

  async retryDeniedAction(opts: {
    sessionId: string;
    retryId: string;
  }): Promise<void> {
    const session = this.requireSession(opts.sessionId);
    const inFlight = session.guardianRetryOperations.get(opts.retryId);
    if (inFlight) return inFlight;
    const event = session.guardianDeniedActions.get(opts.retryId);
    if (!event) {
      throw new Error("This denied action is no longer available to retry.");
    }
    const operation = session.runtime
      .requestTyped("thread/approveGuardianDeniedAction", {
        threadId: session.threadId,
        event: event as unknown as JsonValue,
      })
      .then(() => {
        session.guardianDeniedActions.delete(opts.retryId);
        session.guardianRetryByReviewId.delete(event.reviewId);
        session.translator.markSafetyReviewRetried(opts.retryId);
      })
      .finally(() => {
        session.guardianRetryOperations.delete(opts.retryId);
      });
    session.guardianRetryOperations.set(opts.retryId, operation);
    return operation;
  }

  async initialize(): Promise<InitializeResponse> {
    return advertiseAgentCapabilities(this, this.initializeResponse());
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
   *  ladder is normalized into Zeros' existing composer tokens in the
   *  server's intended order (`ultra` → `ultracode`; none/minimal dropped).
   *
   *  Both capabilities follow the AdvertisedModel contract: a field the
   *  response actually CARRIES is authoritative for this account/runtime even
   *  when it answers "none" (an empty ladder, no fast tier), while a field the
   *  response OMITS is left unset so the renderer keeps its bundled fallback.
   *  Collapsing those two cases would let an older/leaner `model/list` payload
   *  silently strip the effort and Fast controls off every model. */
  private async discoverModels(session: CodexSession): Promise<void> {
    if (this.modelsDiscovered) return;
    try {
      const resp = await session.runtime.requestTyped<
        "model/list",
        {
          data?: Array<{
            id?: string;
            displayName?: string;
            hidden?: boolean;
            supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
            serviceTiers?: Array<{ id?: string }>;
            additionalSpeedTiers?: string[];
          }>;
        }
      >("model/list", { includeHidden: false }, { timeoutMs: 5_000 });
      const models: AdvertisedModel[] = [];
      for (const m of resp?.data ?? []) {
        if (!m?.id || m.hidden) continue;
        // An advertised ladder that maps to nothing (Codex offered only
        // none/minimal, which Zeros' composer has no token for) stays an
        // explicit [] — there is genuinely no effort the user could pick that
        // this model accepts.
        const effortLevels = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts
              .map((e) => e.reasoningEffort)
              .map(mapCodexAdvertisedEffort)
              .filter((e): e is string => typeof e === "string")
          : undefined;
        // Either tier field answers the Fast question; only their joint absence
        // means the response never addressed it.
        const serviceTiers = Array.isArray(m.serviceTiers)
          ? m.serviceTiers
          : undefined;
        const speedTiers = Array.isArray(m.additionalSpeedTiers)
          ? m.additionalSpeedTiers
          : undefined;
        const supportsFast =
          serviceTiers || speedTiers
            ? (serviceTiers ?? []).some((t) => t?.id === "fast") ||
              (speedTiers ?? []).includes("fast")
            : undefined;
        models.push({
          value: m.id,
          label: m.displayName || m.id,
          ...(effortLevels !== undefined ? { effortLevels } : {}),
          ...(supportsFast !== undefined ? { supportsFast } : {}),
        });
      }
      if (models.length > 0) {
        this.modelsDiscovered = true;
        const base = this.initializeResponse();
        const meta = base._meta ?? {};
        this.cachedInitialize = { ...base, _meta: { ...meta, models } };
      }
    } catch {
      /* best-effort — the bundled-catalog fallback still applies */
    }
  }

  async newSession(opts: {
    executionId?: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    browserUse?: AgentBrowserUse;
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }> {
    const { session } = await this.bootSession({
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      mcpServers: opts.mcpServers,
      browserUse: opts.browserUse,
      systemInstruction: opts.systemInstruction,
      territory: opts.territory,
      executionBoundary: opts.executionBoundary,
      kind: "new",
      zerosSessionId: opts.executionId,
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
        executionId: session.zerosSessionId,
        sessionId: session.zerosSessionId,
        providerBinding: providerBindingForResume("codex", session.threadId, {
          scopeId: session.providerSessionId,
        }),
        modes: {
          currentModeId: session.modeId,
          availableModes: CODEX_MODES,
        },
      },
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
    browserUse?: AgentBrowserUse;
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<LoadSessionResponse> {
    // Resume the provider thread into a separately-minted Zeros execution. The
    // native thread id never keys the live runtime or its attachment directory.
    const executionId = opts.executionId ?? opts.sessionId ?? randomUUID();
    const resumeThreadId = opts.providerBinding?.resumeId ?? opts.sessionId;
    if (!resumeThreadId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "loadSession",
        message: "Codex resume requires a provider thread binding.",
      });
    }
    if (this.sessions.has(executionId)) {
      await this.disposeSession(executionId);
    }
    const { session, resumedFresh } = await this.bootSession({
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      mcpServers: opts.mcpServers,
      browserUse: opts.browserUse,
      systemInstruction: opts.systemInstruction,
      territory: opts.territory,
      executionBoundary: opts.executionBoundary,
      kind: "resume",
      resumeThreadId,
      zerosSessionId: executionId,
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
      executionId,
      providerBinding: providerBindingForResume("codex", session.threadId, {
        scopeId: session.providerSessionId,
      }),
      modes: {
        currentModeId: session.modeId,
        availableModes: CODEX_MODES,
      },
      resumedFresh,
    };
  }

  /** Fork a Codex thread into another opaque provider binding. Zeros creates
   * and owns the destination conversation separately; this method neither
   * creates a Zeros execution nor projects Codex title/pin/archive/git state.
   * A live source runtime is reused when available, otherwise a bounded
   * short-lived app-server performs the single typed RPC. */
  async forkProviderBinding(opts: {
    providerBinding: ProviderBinding;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<{ providerBinding: ProviderBinding }> {
    const source = coerceProviderBinding(opts.providerBinding);
    if (!source || source.providerId !== AGENT_ID || source.kind !== "native") {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "forkSession",
        agentId: AGENT_ID,
        message: "Codex fork requires a native Codex thread binding.",
      });
    }

    // A live source runtime may have been admitted with a different cwd,
    // binary, MCP registry, or filesystem authority. Never reuse it for a
    // territory-bound fork; boot the exact, already-qualified target runtime
    // and keep the fork RPC turnless instead.
    const liveSource =
      opts.executionBoundary || opts.territory
        ? undefined
        : Array.from(this.sessions.values()).find(
            (candidate) =>
              candidate.runtimeAlive && candidate.threadId === source.resumeId,
          );
    let runtime = liveSource?.runtime;
    let ownsRuntime = false;
    if (!runtime) {
      try {
        runtime = await bootCodexAppServerRuntime({
          cwd: opts.cwd,
          env: opts.env,
          cliBinary: opts.cliBinary,
          clientInfo: CLIENT_INFO,
          executionBoundary: opts.executionBoundary,
          mcpServers:
            opts.territory && !opts.executionBoundary
              ? []
              : (opts.mcpServers ?? this.ctx.mcpServers),
          logTag: `codex-app-server:fork:${source.resumeId.slice(0, 8)}`,
          onStderr: (line) => this.ctx.emit.onAgentStderr(this.agentId, line),
        });
        ownsRuntime = true;
      } catch (err) {
        throw classifyBootFailure(err, "forkSession");
      }
    }

    try {
      const response = await runtime.requestTyped<
        "thread/fork",
        ThreadForkResponse
      >("thread/fork", {
        threadId: source.resumeId,
        cwd: opts.cwd,
        ...(opts.systemInstruction
          ? { developerInstructions: opts.systemInstruction }
          : {}),
        ephemeral: false,
        // Zeros needs only the new opaque reference. Do not transfer a large
        // turn payload or let a copied goal start hidden provider work before
        // the destination conversation is opened through the common resume.
        excludeTurns: true,
        deferGoalContinuation: true,
      });
      const thread = response?.thread;
      if (
        !thread?.id ||
        !thread.sessionId ||
        thread.id === source.resumeId ||
        thread.forkedFromId !== source.resumeId ||
        thread.ephemeral
      ) {
        throw new AgentFailureError({
          kind: "protocol-error",
          stage: "forkSession",
          agentId: AGENT_ID,
          message: "Codex returned an invalid durable thread fork.",
        });
      }
      return {
        providerBinding: providerBindingForResume(AGENT_ID, thread.id, {
          // Read the provider scope from the response; fork lineage is not
          // inferred from the source binding.
          scopeId: thread.sessionId,
        }),
      };
    } catch (err) {
      throw classifyThreadFailure(err, "forkSession");
    } finally {
      if (ownsRuntime) {
        await runtime.dispose().catch((err) => {
          console.warn(
            `[codex-app-server] failed to dispose short-lived fork runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
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

    const nativeWorkingTreeReview = isCodexWorkingTreeReviewPrompt(opts.prompt);
    let input: CodexUserInput[] = [];
    if (!nativeWorkingTreeReview) {
      input = await this.buildUserInput(session, opts.prompt);
      if (
        session.browserSessionId &&
        session.browserSkill &&
        codexPromptRequestsBrowserSkill(input)
      ) {
        input = injectCodexBrowserSkillInput(input, session.browserSkill);
      }
    }
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
    const effort = mapCodexEffortFromEnv(session.env?.ZEROS_THINKING_EFFORT);
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
    // Clock starts at the handoff to the app-server, so the number reported
    // is the provider's wait rather than our own dispatch above it.
    session.firstToken.beginTurn();
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
      // Both turn/start and inline review/start acknowledge a live turn and
      // settle through turn/completed. Capture the id immediately so the
      // existing Stop path can interrupt either one, including the ack race.
      const turnOptions = {
        onTurnStarted: (turnId: string) => {
          session.activeTurnId = turnId;
          if (session.cancelRequested) {
            void session.runtime.interruptTurn(session.threadId, turnId);
          }
        },
      };
      const result = nativeWorkingTreeReview
        ? await (async () => {
            // review/start has no per-turn model controls. Synchronize the
            // thread first so the live composer selection remains authoritative
            // for native review just as it is for turn/start.
            await session.runtime.requestTyped("thread/settings/update", {
              threadId: session.threadId,
              model: model ?? session.threadModel ?? null,
              effort: effort ?? null,
              serviceTier: fast ? "fast" : null,
            });
            if (model) session.threadModel = model;
            return session.runtime.runReview(
              {
                threadId: session.threadId,
                target: { type: "uncommittedChanges" },
                delivery: "inline",
              },
              turnOptions,
            );
          })()
        : await session.runtime.runTurn(
            {
              threadId: session.threadId,
              input,
              approvalPolicy,
              ...codexTurnAuthority(
                sandboxPolicy,
                codexAdditionalWritableRoots(session.env, session.cwd),
              ),
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
            turnOptions,
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
      const rateLimit = session.translator.rateLimitFailure;
      if (rateLimit) {
        throw new AgentFailureError({
          kind: "rate-limited",
          message: `Codex: ${rateLimit}.`,
          stage: "prompt",
          agentId: AGENT_ID,
          advice:
            "Codex is rate-limiting requests. Wait for the provider reset, then try again.",
        });
      }
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
      // demonstrably still working. Hold the prompt
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
      // Surface this turn's token usage (Codex reports tokens,
      // no cost over the app-server protocol) for LLM analytics.
      const turnUsage = session.translator.turnUsage;
      const stopReason = session.cancelRequested
        ? "cancelled"
        : mapStopReason(result.status, session.translator.stopReason);
      const effectiveModel = model ?? session.threadModel ?? undefined;
      // stopReason rides INSIDE the response too: the gateway returns only
      // the inner response (it discards the outer field), so omitting it here
      // left the engine persisting a NULL stop reason for every Codex turn —
      // the footer pills and the turn row's status both read it.
      return {
        stopReason,
        response: {
          stopReason,
          ...(effectiveModel ? { effectiveModel } : {}),
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
      // A turn that produced nothing must not hand its pending measurement to
      // whichever turn runs next.
      session.firstToken.endTurn();
      session.cancelRequested = false;
      // A completed/failed turn cannot still service one of its approval
      // or question resolvers. Fail closed and receipt every straggler before
      // a later turn can enqueue behind a dead renderer card.
      this.drainPendingApprovals(session, session.runtimeAlive);
      this.drainPendingQuestions(session, session.runtimeAlive);
      // IAB intentionally does not send the optional browser-client
      // `turnEnded` event. A timed-out/reset node_repl batch can also skip
      // tabs.finalize(), so app-server turn settlement is the authoritative
      // fallback that restores the exact retained page to normal user control.
      await this.settleNativeBrowserTurn(session);
    }
  }

  private async settleNativeBrowserTurn(session: CodexSession): Promise<void> {
    if (!session.browserSessionId) return;
    try {
      await settleCodexBrowserUseTurn({
        browserSessionId: session.browserSessionId,
        nativeSessionId: session.threadId,
      });
    } catch (error) {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex-app-server] Native Browser handoff failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
    let input = await this.buildUserInput(session, opts.prompt);
    if (
      session.browserSessionId &&
      session.browserSkill &&
      codexPromptRequestsBrowserSkill(input)
    ) {
      input = injectCodexBrowserSkillInput(input, session.browserSkill);
    }
    await session.runtime.requestTyped("turn/steer", {
      threadId: session.threadId,
      input,
      expectedTurnId: turnId,
    });
  }

  /** Run a real context compaction through `thread/compact/start`.
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
    // the previous turn's working group.
    session.translator.expectManualCompaction();
    try {
      await session.runtime.requestTyped("thread/compact/start", {
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
    // Release approval RPCs as part of Stop itself. Interrupting the turn does
    // not guarantee the app-server will settle every server→client request.
    this.drainPendingApprovals(session, session.runtimeAlive);
    this.drainPendingQuestions(session, session.runtimeAlive);
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

  /** Stop exactly one session-owned Codex background terminal. The renderer's
   * opaque task id is resolved through the latest authoritative snapshot; it
   * is never forwarded or parsed as a native process id. */
  async stopBackgroundTask(opts: {
    sessionId: string;
    taskId: string;
  }): Promise<void> {
    const session = this.sessions.get(opts.sessionId);
    if (!session || !session.runtimeAlive) {
      throw new AgentFailureError({
        kind: "transport-closed",
        message: "Codex background work is no longer connected.",
        stage: "stopBackgroundTask",
        agentId: AGENT_ID,
      });
    }
    const ongoing = session.backgroundStopOperations.get(opts.taskId);
    if (ongoing) return ongoing;
    const target = session.backgroundTaskTargets.get(opts.taskId);
    if (!target) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "That Codex background task is no longer active.",
        stage: "stopBackgroundTask",
        agentId: AGENT_ID,
      });
    }
    const operation = (async (): Promise<void> => {
      try {
        await session.runtime.requestTyped<
          "thread/backgroundTerminals/terminate",
          ThreadBackgroundTerminalsTerminateResponse
        >(
          "thread/backgroundTerminals/terminate",
          {
            threadId: target.threadId,
            processId: target.processId,
          },
          { timeoutMs: 5_000 },
        );
      } catch (error) {
        throw new AgentFailureError({
          kind: "protocol-error",
          message: `Codex could not stop the background task: ${
            error instanceof Error ? error.message : String(error)
          }`,
          stage: "stopBackgroundTask",
          agentId: AGENT_ID,
        });
      }
      if (
        !session.runtimeAlive ||
        this.sessions.get(session.zerosSessionId) !== session
      ) {
        return;
      }

      // Invalidate any list that began before termination, remove the row on
      // the terminate acknowledgement, then revalidate. A false `terminated`
      // response is an idempotent already-gone race; the fresh list can restore
      // the row if it truly remains live.
      session.backgroundRefreshEpoch += 1;
      const next = new Map(session.backgroundTasks);
      next.delete(opts.taskId);
      session.backgroundTasks = next;
      session.backgroundTaskTargets.delete(opts.taskId);
      this.emitBackgroundTasks(session);
      void this.refreshBackgroundTasks(session);
    })();
    session.backgroundStopOperations.set(opts.taskId, operation);
    try {
      await operation;
    } finally {
      if (session.backgroundStopOperations.get(opts.taskId) === operation) {
        session.backgroundStopOperations.delete(opts.taskId);
      }
    }
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
    delete carried.ZEROS_THINKING_EFFORT;
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
      if (
        this.settlePendingApproval(session, opts.permissionId, opts.response)
      ) {
        return;
      }
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
      if (
        this.settlePendingQuestion(
          session,
          opts.questionId,
          opts.response.outcome,
          opts.response,
        )
      ) {
        return true;
      }
    }
    // Vendor-id fallback — a reconnect re-raised the same ask under a fresh
    // questionId while the renderer deduped and kept the original id.
    if (opts.nativeRequestId) {
      for (const session of this.sessions.values()) {
        for (const [qid, pending] of session.pendingQuestions) {
          if (pending.request.nativeRequestId !== opts.nativeRequestId) {
            continue;
          }
          this.settlePendingQuestion(
            session,
            qid,
            opts.response.outcome,
            opts.response,
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

  /** Resolve and receipt one adapter-owned question exactly once. Passing no
   * response means the app-server already retired its JSON-RPC resolver (for
   * example via serverRequest/resolved or process exit), so only local state
   * and transcript/UI receipts are settled. */
  private settlePendingQuestion(
    session: CodexSession,
    questionId: string,
    outcome: QuestionResponse["outcome"],
    response?: QuestionResponse,
  ): boolean {
    const pending = session.pendingQuestions.get(questionId);
    if (!pending || !session.pendingQuestions.delete(questionId)) return false;
    // The MCP mapper fails closed: a submitted value that does not satisfy the
    // requested schema is delivered as `cancel`, not as an answer. Receipt what
    // reached the server, not what the user intended, so the timeline can never
    // read ANSWERED over a request the server was told to drop.
    let delivered = outcome;
    try {
      if (response) {
        const mapped = mapCodexQuestionAnswer(
          pending.native,
          pending.request,
          response,
        );
        if (isMcpElicitationResponse(mapped.response)) {
          delivered = deliveredQuestionOutcome(outcome, mapped.response);
          // Only a fail-closed `cancel` is a surprise. Picking a Decline row
          // is an intentional refusal and reads correctly on its own.
          if (delivered !== outcome && mapped.response.action === "cancel") {
            this.warnAnswerRejected(pending.request);
          }
          if (mapped.response.action === "accept") {
            this.rememberBrowserOriginGrant(session, pending.native);
          }
        }
        pending.runtime.respondToUserInput(questionId, mapped.response);
      }
    } finally {
      this.settleQuestionRecord(
        session,
        questionId,
        pending.request,
        delivered,
      );
    }
    return true;
  }

  /** A silently converted submit is the one failure the card cannot show on
   * its own — it is already gone by the time the mapper runs. */
  private warnAnswerRejected(request: QuestionRequest): void {
    this.ctx.emit.onAgentStderr(
      this.agentId,
      `[zeros] MCP request ${request.nativeRequestId}: the submitted answer does not satisfy the requested schema — the request was cancelled and nothing was sent to the server`,
    );
  }

  // ── account ───────────────────────────────────────────

  /** Read the signed-in Codex account via the app-server's `account/read`
   *  RPC. Prefers a live session's runtime; otherwise boots a short-lived
   *  one and disposes it. Best-effort — returns null on any failure or for
   *  non-ChatGPT (API-key) auth, so the panel shows "—". */
  async getAccountInfo(opts?: {
    liveOnly?: boolean;
    env?: Record<string, string>;
    executionBoundary?: PreparedBoundary;
  }): Promise<AccountDetails | null> {
    // Fast path: reuse a live session's runtime — no extra boot.
    for (const s of this.sessions.values()) {
      const acct = await this.readAccount(s.runtime).catch(() => null);
      if (acct) return acct;
      break;
    }
    if (opts?.liveOnly) return null;
    // No live runtime → boot a throwaway just to read the account. Spawns a
    // `codex app-server` child; disposed in finally even if the race below
    // times out. Verify on a Mac with codex signed in (not in the sandbox).
    const boot = bootCodexAppServerRuntime({
      cwd: this.ctx.projectRoot,
      clientInfo: CLIENT_INFO,
      mcpServers: [],
      logTag: "codex-app-server:account",
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.executionBoundary
        ? { executionBoundary: opts.executionBoundary }
        : {}),
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
    executionBoundary?: PreparedBoundary;
  }): Promise<string> {
    const boot = bootCodexAppServerRuntime({
      cwd: this.ctx.projectRoot,
      clientInfo: CLIENT_INFO,
      mcpServers: [],
      logTag: "codex-app-server:title",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.executionBoundary
        ? { executionBoundary: opts.executionBoundary }
        : {}),
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
    const resp = await runtime.requestTyped<"account/read", GetAccountResponse>(
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
    this.clearBackgroundTaskPoll(s);
    this.drainPendingApprovals(s, s.runtimeAlive);
    this.drainPendingQuestions(s, s.runtimeAlive);
    this.disposing.add(sessionId);
    // Drop the session BEFORE the teardown attempt, so a failure reports itself
    // without pinning an un-retryable state. The runtime memoizes its dispose
    // promise (a retry would re-await the same hung process-group stop) and the
    // gateway has already cleared its routing, so keeping the entry would only
    // leave a forgotten session that a late runtime exit could still drive —
    // while making the workspace permanently unarchivable for this process.
    this.sessions.delete(sessionId);
    try {
      let disposeFailed = false;
      let disposeError: unknown;
      try {
        // Codex is the one adapter that owns an explicit process-group stop
        // (stdio-process stop() SIGTERMs, escalates to SIGKILL, then awaits the
        // real exit), so a rejection here genuinely means a child may still be
        // alive in the worktree. Surface it: ordinary tab close stays
        // best-effort in the gateway, archive/delete passes failClosed and
        // aborts. A retry then proceeds — the child has already been SIGKILLed
        // and there is no further escalation available.
        await s.runtime.dispose();
      } catch (err) {
        disposeFailed = true;
        disposeError = err;
      }
      await this.settleNativeBrowserTurn(s);
      await removeSessionDir(s.zerosSessionId).catch(() => {});
      if (disposeFailed) throw disposeError;
    } finally {
      // Keep the suppression alive briefly past dispose() in case the child's
      // exit event lands a tick later, then release the marker.
      const t = setTimeout(() => this.disposing.delete(sessionId), 2000);
      t.unref?.();
    }
  }

  async dispose(): Promise<void> {
    const all = Array.from(this.sessions.values());
    for (const s of all) {
      this.disposing.add(s.zerosSessionId);
      this.clearBackgroundTaskPoll(s);
    }
    this.sessions.clear();
    await Promise.allSettled(
      all.map(async (s) => {
        // Drain pending approvals on this session's pendingApprovals
        // map before disposing the runtime. The runtime's own dispose
        // also auto-cancels its in-flight approval promises, so this
        // is belt-and-braces — but it keeps the adapter map clean.
        this.drainPendingApprovals(s, s.runtimeAlive);
        this.drainPendingQuestions(s, s.runtimeAlive);
        try {
          await s.runtime.dispose();
        } finally {
          await this.settleNativeBrowserTurn(s);
          // Best-effort session dir removal.
          await removeSessionDir(s.zerosSessionId).catch(() => {});
        }
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
    /** Official app-server Browser plugin bound to Zeros' native IAB host. */
    browserUse?: AgentBrowserUse;
    /** Zeros' first-turn instruction body → `developerInstructions` on
     *  thread/start AND thread/resume (see `nativeSystemInstruction`). */
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
    kind: "new" | "resume";
    /** Required when kind === "resume". */
    resumeThreadId?: string;
    /** When kind === "resume", caller may want the Zeros sessionId to
     *  match the codex thread id (so the UI's persistent key resolves
     *  through listSessions). For kind === "new", a fresh UUID. */
    zerosSessionId?: string;
  }): Promise<{ session: CodexSession; resumedFresh: boolean }> {
    const zerosSessionId = opts.zerosSessionId ?? randomUUID();
    try {
      await ensureSessionDir(zerosSessionId);
      await writeSessionMeta(zerosSessionId, {
        agentId: this.agentId,
        cwd: opts.cwd,
        pid: process.pid,
        createdAt: Date.now(),
      });
    } catch (err) {
      await removeSessionDir(zerosSessionId).catch(() => {});
      throw err;
    }

    // Seed thread/start from the same persisted posture the renderer will
    // reconcile over AGENT_SET_MODE. This makes the first turn truthful even
    // when it is dispatched immediately after session creation.
    const initialMode = codexModeFromEnv(opts.env);
    // Boot the runtime first; we pass an onApprovalRequest closure that
    // will mutate `session.pendingApprovals` once the session object
    // exists. Two-phase init: we forward-declare the session ref and
    // assign it on the next line.
    // eslint-disable-next-line prefer-const -- assigned after runtime boot; closures above capture the live ref.
    let session!: CodexSession;
    let runtime: CodexAppServerHandle;
    let effectiveBrowserUse = opts.browserUse;
    let nativeBrowserSkill: CodexNativeBrowserSkill | null = null;
    let mcpServers = opts.mcpServers ?? this.ctx.mcpServers;
    if (opts.browserUse?.kind === "codex-app-server") {
      const containmentReason = codexNativeBrowserUnavailableReason({
        contained: hasKernelExecutionBoundary(opts.executionBoundary),
      });
      if (containmentReason) {
        effectiveBrowserUse = undefined;
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[codex-app-server] ${containmentReason}. Codex will continue without Browser for this thread.`,
        );
      } else {
        let nativeBrowser: Awaited<
          ReturnType<typeof resolveCodexNativeBrowserRuntime>
        > = null;
        try {
          const codexBinary = await resolveCodexBinary({
            override: opts.cliBinary,
          });
          nativeBrowser = await resolveCodexNativeBrowserRuntime({
            codexCliPath: codexBinary.path,
            codexHome: opts.env?.CODEX_HOME,
          });
        } catch (error) {
          // Browser is an optional per-thread capability. A stale plugin cache
          // must not strand the whole Codex conversation after its session
          // directory has already been created.
          effectiveBrowserUse = undefined;
          this.ctx.emit.onAgentStderr(
            this.agentId,
            `[codex-app-server] Official Browser runtime discovery failed: ${
              error instanceof Error ? error.message : String(error)
            }. Codex will continue without Browser for this thread.`,
          );
        }
        if (nativeBrowser) {
          mcpServers = mergeCodexNativeBrowserMcp(mcpServers, nativeBrowser);
          nativeBrowserSkill = nativeBrowser.browserSkill;
        } else if (effectiveBrowserUse) {
          effectiveBrowserUse = undefined;
          this.ctx.emit.onAgentStderr(
            this.agentId,
            "[codex-app-server] Official Browser runtime unavailable: install or update ChatGPT/Codex Desktop so browser@openai-bundled and its node_repl runtime are present. Zeros browser tools will not be substituted.",
          );
        }
      }
    }
    try {
      runtime = await bootCodexAppServerRuntime({
        cwd: opts.cwd,
        env: opts.env,
        cliBinary: opts.cliBinary,
        clientInfo: CLIENT_INFO,
        executionBoundary: opts.executionBoundary,
        mcpServers,
        logTag: `codex-app-server:${zerosSessionId.slice(0, 8)}`,
        onApprovalRequest: (request) =>
          this.handleApprovalRequest(session, request),
        onApprovalSettled: (permissionId) =>
          this.handleApprovalSettled(session, permissionId),
        onUserInputRequest: (request) =>
          this.handleUserInputRequest(session, request),
        onUserInputSettled: (questionId) =>
          this.handleUserInputSettled(session, questionId),
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
      await removeSessionDir(zerosSessionId).catch(() => {});
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
    let providerSessionId: string;
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
            // Enable the official bundled Browser plugin only when this thread
            // has a conversation-owned native IAB host. Code sessions keep
            // Codex's normal provider capabilities regardless of whether a
            // Design directory is recognized in the worktree.
            config: codexBrowserThreadConfig(
              effectiveBrowserUse?.kind === "codex-app-server",
            ),
            ...(opts.systemInstruction
              ? { developerInstructions: opts.systemInstruction }
              : {}),
          });
          threadId = result.threadId;
          providerSessionId = result.providerSessionId ?? result.threadId;
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
              effectiveBrowserUse,
            ),
          );
          threadId = fresh.threadId;
          providerSessionId = fresh.providerSessionId ?? fresh.threadId;
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
            effectiveBrowserUse,
          ),
        );
        threadId = result.threadId;
        providerSessionId = result.providerSessionId ?? result.threadId;
        threadModel = result.model ?? null;
      }
    } catch (err) {
      const runtimeFailure = await withRuntimeDisposeFailure(runtime, err);
      await removeSessionDir(zerosSessionId).catch(() => {});
      // thread/resume against a rollout codex has cleaned up surfaces
      // as a "no rollout found"-shaped error. Classify so the UI's
      // session-expired pill renders instead of a generic alert. The
      // resume → start fallback above absorbs the common case, so by
      // the time we reach here the error is non-recoverable.
      throw classifyThreadFailure(
        runtimeFailure,
        opts.kind === "resume" ? "loadSession" : "newSession",
      );
    }

    let registeredBrowserSessionId: string | null = null;
    if (effectiveBrowserUse?.kind === "codex-app-server") {
      try {
        const registered = await registerCodexBrowserUseSession({
          browserSessionId: effectiveBrowserUse.browserSessionId,
          nativeSessionId: threadId,
        });
        if (!registered) {
          this.ctx.emit.onAgentStderr(
            this.agentId,
            "[codex-app-server] Native Browser Use host registration was rejected; Browser will be unavailable for this thread.",
          );
        } else {
          registeredBrowserSessionId = effectiveBrowserUse.browserSessionId;
        }
      } catch (error) {
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[codex-app-server] Native Browser Use host registration failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const translator = new CodexAppServerTranslator({
      sessionId: zerosSessionId,
      emit: (notification: SessionNotification) =>
        this.ctx.emit.onSessionUpdate(this.agentId, notification),
      onUnknown: (method, _params) => {
        console.log(`[codex-app-server] unknown notification: ${method}`);
      },
    });

    this.wireRuntimeToTranslator(runtime, translator, {
      threadId,
      zerosSessionId,
    });

    session = {
      zerosSessionId,
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary,
      territory: opts.territory,
      executionBoundary: opts.executionBoundary,
      runtime,
      translator,
      threadId,
      providerSessionId,
      browserSessionId: registeredBrowserSessionId,
      browserSkill: registeredBrowserSessionId ? nativeBrowserSkill : null,
      threadModel,
      modeId: initialMode,
      activeTurnId: null,
      activeTurns: new Map(),
      sawCollabTurns: false,
      cancelRequested: false,
      postCancelInterruptUntil: 0,
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      browserOriginGrantsByTurn: new Map(),
      fileEditPathsByItemId: new Map(),
      authMode: null,
      planType: null,
      latestRateLimits: null,
      quotaUpdatesSuppressed: false,
      turnActive: false,
      firstToken: new FirstTokenLatency("codex"),
      sawFirstTurnOutput: false,
      runtimeAlive: true,
      childExitedMidTurn: false,
      backgroundThreadIds: new Set([threadId]),
      backgroundTasks: new Map(),
      backgroundTaskTargets: new Map(),
      backgroundStopOperations: new Map(),
      backgroundWaiting: false,
      backgroundRefreshEpoch: 0,
      backgroundPollTimer: null,
      guardianDeniedActions: new Map(),
      guardianRetryByReviewId: new Map(),
      guardianRetryOperations: new Map(),
      goalSnapshotEpoch: 0,
    };
    this.sessions.set(zerosSessionId, session);

    // Goal state is keyed server state. Publish the exact native snapshot once
    // the route is registered; a failed read keeps the renderer's last
    // confirmed snapshot rather than inventing an empty goal.
    const goalSnapshotEpoch = session.goalSnapshotEpoch;
    void this.getGoal({ sessionId: zerosSessionId })
      .then((goal) => {
        if (
          this.sessions.get(zerosSessionId) !== session ||
          session.goalSnapshotEpoch !== goalSnapshotEpoch
        ) {
          return;
        }
        this.ctx.emit.onSessionUpdate(this.agentId, {
          sessionId: zerosSessionId,
          update: { sessionUpdate: "goal_update", goal },
        });
      })
      .catch((error) => {
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[codex-app-server] Goal snapshot failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    // Provider deletion owns only the opaque provider reference. Codex
    // archive, unarchive, close, name, and pin state are intentionally not
    // subscribed: Zeros remains authoritative for conversation lifecycle and
    // product metadata.
    const onThreadDeleted = (deleted: ThreadDeletedNotification) => {
      if (this.sessions.get(session.zerosSessionId) !== session) return;
      this.forgetBackgroundThread(session, deleted.threadId);
      if (deleted.threadId !== session.threadId) return;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: session.zerosSessionId,
        update: {
          sessionUpdate: "provider_binding_detached",
          providerBinding: providerBindingForResume(
            AGENT_ID,
            session.threadId,
            { scopeId: session.providerSessionId },
          ),
          reason: "provider_deleted",
        },
      });
    };
    const onThreadClosed = (closed: ThreadClosedNotification) => {
      if (this.sessions.get(session.zerosSessionId) !== session) return;
      this.forgetBackgroundThread(session, closed.threadId);
    };
    if (typeof runtime.onNotificationTyped === "function") {
      runtime.onNotificationTyped("thread/deleted", onThreadDeleted);
      runtime.onNotificationTyped("thread/closed", onThreadClosed);
    } else {
      // Compatibility for old embedded/test handles; shipping app-server
      // runtimes always expose the generated typed subscription.
      runtime.onNotification("thread/deleted", (raw) =>
        onThreadDeleted(raw as ThreadDeletedNotification),
      );
      runtime.onNotification("thread/closed", (raw) =>
        onThreadClosed(raw as ThreadClosedNotification),
      );
    }

    this.wireTurnTracking(session, runtime);
    this.wireFileChangeCapture(session, runtime);
    this.wireAccountListeners(session, runtime);
    // A resumed Codex thread may already own detached terminals, including on
    // loaded collaboration descendants that predate this runtime connection.
    // New threads remain query-free until a turn actually settles.
    if (opts.kind === "resume") {
      void this.refreshBackgroundTasks(session, true);
    }
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
   *  Mid-turn state stays until prompt recovery settles it. For an idle exit,
   *  the engine's session-scoped exit handler retires the route and calls the
   *  gateway disposal path, which evicts this dead adapter state before the
   *  next send resumes the durable thread into a fresh execution. */
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
    session.backgroundStopOperations.clear();
    session.backgroundRefreshEpoch += 1;
    this.clearBackgroundTaskPoll(session);
    if (session.backgroundTasks.size > 0 || session.backgroundWaiting) {
      session.backgroundTasks = new Map();
      session.backgroundTaskTargets = new Map();
      this.emitBackgroundTasks(session);
    }
    // The runtime is already dead, so only drop local resolver handles and
    // emit their receipts; there is no JSON-RPC peer left to answer.
    this.drainPendingApprovals(session, false);
    this.drainPendingQuestions(session, false);
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
      const resp = await session.runtime.requestTyped<
        "skills/list",
        {
          data?: Array<{
            skills?: Array<{
              name?: string;
              description?: string;
              shortDescription?: string;
              enabled?: boolean;
            }>;
          }>;
        }
      >(
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
      session.quotaUpdatesSuppressed = !session.authMode;
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex-app-server:${session.zerosSessionId.slice(0, 8)}] account.updated authMode=${session.authMode} plan=${session.planType}`,
      );
      // Auth was good, now it's null/expired — the session is alive but
      // the next turn will fail. Surfacing via stderr lets the gateway's
      // listAgents probe / settings panel re-poll. A future polish is
      // to emit a typed bridge event so the UI's auth banner flips
      // without waiting for the next listAgents tick.
      if (!session.authMode) {
        // Quotas belong to the signed-in account. Keeping the previous plan's
        // snapshot visible after logout is both misleading and a cross-account
        // data leak if another account is connected next. Invalidate even when
        // no snapshot was published yet: the signed-out event can race the
        // initial read, and a replacement login can unsuppress notifications
        // before that old request resolves.
        this.quotaSnapshotEpoch += 1;
        this.latestRateLimitSnapshot = null;
        for (const active of this.sessions.values()) {
          active.latestRateLimits = null;
          active.quotaUpdatesSuppressed = true;
        }
        this.ctx.emit.onProviderQuotaUpdated?.(this.agentId, null);
      }
      if (prevAuthMode && !session.authMode) {
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[codex-app-server] auth dropped — user needs to re-run \`codex login\``,
        );
      }
    });

    runtime.onNotification("account/rateLimits/updated", (params) => {
      if (session.quotaUpdatesSuppressed) return;
      const incoming = (params as { rateLimits?: RateLimitSnapshot } | null)
        ?.rateLimits;
      if (!incoming) return;
      const merged = mergeCodexRateLimitSnapshot(
        this.latestRateLimitSnapshot,
        incoming as RateLimitSnapshot & CodexRateLimitSnapshotLike,
      );
      this.latestRateLimitSnapshot = merged;
      session.latestRateLimits = merged;
      this.ctx.emit.onProviderQuotaUpdated?.(
        this.agentId,
        normalizeCodexQuota(merged),
      );
    });

    runtime.onNotification("account/login/completed", (_params) => {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[codex-app-server:${session.zerosSessionId.slice(0, 8)}] account.login.completed`,
      );
    });

    // Seed the rolling-notification merge with an authoritative snapshot.
    // Best-effort: quota is a settings diagnostic and must never delay or fail
    // conversation admission.
    const quotaReadEpoch = this.quotaSnapshotEpoch;
    void this.readProviderRateLimitSnapshot(runtime)
      .then((snapshot) => {
        if (
          session.quotaUpdatesSuppressed ||
          this.sessions.get(session.zerosSessionId) !== session ||
          quotaReadEpoch !== this.quotaSnapshotEpoch
        ) {
          return;
        }
        this.latestRateLimitSnapshot = snapshot;
        session.latestRateLimits = snapshot;
        this.ctx.emit.onProviderQuotaUpdated?.(
          this.agentId,
          normalizeCodexQuota(snapshot),
        );
      })
      .catch(() => undefined);
  }

  private emitBackgroundTasks(session: CodexSession): void {
    const waiting =
      session.backgroundTasks.size > 0 && session.activeTurns.size === 0;
    session.backgroundWaiting = waiting;
    this.ctx.emit.onSessionUpdate(this.agentId, {
      sessionId: session.zerosSessionId,
      update: {
        sessionUpdate: "background_tasks_update",
        tasks: [...session.backgroundTasks.values()],
        waiting,
      },
    });
  }

  private clearBackgroundTaskPoll(session: CodexSession): void {
    if (!session.backgroundPollTimer) return;
    clearTimeout(session.backgroundPollTimer);
    session.backgroundPollTimer = null;
  }

  /** The app-server has no terminal-exit notification. Revalidate only while
   * a row is visible so naturally completed commands disappear without
   * polling ordinary foreground commands or idle sessions. Self-scheduling
   * (instead of setInterval) guarantees a slow list cannot overlap itself. */
  private scheduleBackgroundTaskPoll(session: CodexSession): void {
    if (
      session.backgroundPollTimer ||
      session.backgroundTasks.size === 0 ||
      !session.runtimeAlive ||
      this.sessions.get(session.zerosSessionId) !== session
    ) {
      return;
    }
    session.backgroundPollTimer = setTimeout(() => {
      session.backgroundPollTimer = null;
      void this.refreshBackgroundTasks(session);
    }, BACKGROUND_TERMINAL_POLL_MS);
    session.backgroundPollTimer.unref?.();
  }

  /** A closed/deleted loaded thread cannot retain a running app-server
   * terminal. Remove its private route and visible row immediately; otherwise
   * a later list against the now-unloaded child can fail forever while the
   * last confirmed snapshot keeps a ghost task alive. */
  private forgetBackgroundThread(
    session: CodexSession,
    threadId: string,
  ): void {
    if (!session.backgroundThreadIds.has(threadId)) return;
    session.backgroundRefreshEpoch += 1;
    this.clearBackgroundTaskPoll(session);
    if (threadId === session.threadId) {
      session.backgroundThreadIds = new Set([session.threadId]);
      session.backgroundTasks = new Map();
      session.backgroundTaskTargets = new Map();
      this.emitBackgroundTasks(session);
      return;
    }

    session.backgroundThreadIds.delete(threadId);
    const nextTasks = new Map(session.backgroundTasks);
    const nextTargets = new Map(session.backgroundTaskTargets);
    let changed = false;
    for (const [taskId, target] of session.backgroundTaskTargets) {
      if (target.threadId !== threadId) continue;
      nextTargets.delete(taskId);
      changed = nextTasks.delete(taskId) || changed;
    }
    session.backgroundTaskTargets = nextTargets;
    if (!changed) {
      this.scheduleBackgroundTaskPoll(session);
      return;
    }
    session.backgroundTasks = nextTasks;
    this.emitBackgroundTasks(session);
    this.scheduleBackgroundTaskPoll(session);
  }

  /** Revalidate every known exact-thread list as one replace snapshot. A
   * partial failure retains the last confirmed whole-session snapshot; a
   * monotonic epoch prevents an older list from resurrecting a task after its
   * terminate acknowledgement. */
  private async refreshBackgroundTasks(
    session: CodexSession,
    discoverLoadedDescendants = false,
  ): Promise<void> {
    if (
      !session.runtimeAlive ||
      this.sessions.get(session.zerosSessionId) !== session
    ) {
      return;
    }
    this.clearBackgroundTaskPoll(session);
    const epoch = ++session.backgroundRefreshEpoch;
    const runtime = session.runtime;
    try {
      if (discoverLoadedDescendants) {
        const descendants = await collectLoadedDescendantThreadIds(
          (method, params, requestOpts) =>
            runtime.request(method, params, requestOpts),
          session.threadId,
        );
        if (
          !session.runtimeAlive ||
          this.sessions.get(session.zerosSessionId) !== session
        ) {
          return;
        }
        for (const threadId of descendants) {
          if (
            session.backgroundThreadIds.size >= MAX_CODEX_BACKGROUND_THREADS
          ) {
            break;
          }
          session.backgroundThreadIds.add(threadId);
        }
        // A lifecycle invalidation can race discovery after the newer refresh
        // already captured its thread-id set. Preserve the discovered owners
        // and run one non-discovery revalidation so the child cannot stay
        // invisible until another turn happens to settle.
        if (epoch !== session.backgroundRefreshEpoch) {
          void this.refreshBackgroundTasks(session);
          return;
        }
      }

      const threadIds = [...session.backgroundThreadIds].slice(
        0,
        MAX_CODEX_BACKGROUND_THREADS,
      );
      const nextTasks = new Map<string, BackgroundTask>();
      const nextTargets = new Map<
        string,
        { threadId: string; processId: string }
      >();
      const now = Date.now();
      // A resumed multi-agent tree can contain up to the explicit 100-thread
      // bound. Keep local JSON-RPC fan-out bounded instead of dumping every
      // list request into one app-server event-loop turn. Stop walking once the
      // whole-session row budget is full: the per-thread collector is also
      // capped, so intermediate memory is bounded by one eight-thread batch.
      for (
        let index = 0;
        index < threadIds.length;
        index += BACKGROUND_LIST_CONCURRENCY
      ) {
        const batch = threadIds.slice(
          index,
          index + BACKGROUND_LIST_CONCURRENCY,
        );
        const snapshots = await Promise.all(
          batch.map(async (threadId) => ({
            threadId,
            terminals: await collectBackgroundTerminals(
              (method, params, requestOpts) =>
                runtime.request(method, params, requestOpts),
              threadId,
            ),
          })),
        );
        if (epoch !== session.backgroundRefreshEpoch) return;
        for (const { threadId, terminals } of snapshots) {
          const reconciled = reconcileBackgroundTerminals(
            session.backgroundTasks,
            terminals,
            now,
            (terminal) =>
              codexBackgroundTaskId(
                session.zerosSessionId,
                threadId,
                terminal.processId,
              ),
          );
          for (const [taskId, task] of reconciled.active) {
            if (nextTasks.size >= MAX_CODEX_BACKGROUND_TERMINALS) break;
            nextTasks.set(taskId, task);
          }
          for (const terminal of terminals) {
            if (!terminal.processId) continue;
            const taskId = codexBackgroundTaskId(
              session.zerosSessionId,
              threadId,
              terminal.processId,
            );
            if (!nextTasks.has(taskId)) continue;
            nextTargets.set(taskId, {
              threadId,
              processId: terminal.processId,
            });
          }
          if (nextTasks.size >= MAX_CODEX_BACKGROUND_TERMINALS) break;
        }
        if (nextTasks.size >= MAX_CODEX_BACKGROUND_TERMINALS) break;
      }
      if (
        epoch !== session.backgroundRefreshEpoch ||
        !session.runtimeAlive ||
        this.sessions.get(session.zerosSessionId) !== session
      ) {
        return;
      }

      const waiting = nextTasks.size > 0 && session.activeTurns.size === 0;
      const unchanged =
        waiting === session.backgroundWaiting &&
        nextTasks.size === session.backgroundTasks.size &&
        [...nextTasks].every(
          ([taskId, task]) => session.backgroundTasks.get(taskId) === task,
        );
      session.backgroundTasks = nextTasks;
      session.backgroundTaskTargets = nextTargets;
      if (!unchanged) this.emitBackgroundTasks(session);
      this.scheduleBackgroundTaskPoll(session);
    } catch (error) {
      // Listing is keyed server state. A failed revalidation keeps the last
      // exact-session snapshot instead of blanking the card or guessing that
      // every process exited.
      if (epoch !== session.backgroundRefreshEpoch) return;
      console.warn(
        `[codex-app-server:${session.zerosSessionId.slice(0, 8)}] background terminal refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleBackgroundTaskPoll(session);
    }
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
      if (
        session.backgroundThreadIds.has(threadId) ||
        session.backgroundThreadIds.size < MAX_CODEX_BACKGROUND_THREADS
      ) {
        session.backgroundThreadIds.add(threadId);
      }
      if (threadId !== session.threadId) session.sawCollabTurns = true;
      const known = session.activeTurns.get(threadId) === turnId;
      if (!known) session.activeTurns.set(threadId, turnId);
      if (!known && session.backgroundWaiting) {
        this.emitBackgroundTasks(session);
      }
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
        void this.refreshBackgroundTasks(session);
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
    // Approve for me auto-settles in-sandbox tool gates only. Permission-profile
    // escalations (network / out-of-workspace paths) still require a user card.
    if (session.modeId === "auto-edit" && autoEditCanAutoApprove(request)) {
      let approved = false;
      try {
        const response = mapResponseToCodexDecision(
          {
            runtime: session.runtime,
            method: request.method,
            params: request.params,
          },
          AUTO_APPROVE_PERMISSION_RESPONSE,
        );
        session.runtime.respondToPermission(request.permissionId, response);
        approved = true;
      } catch {
        // Fall through to the normal renderer gate if the native response
        // shape changes. A failed auto-approval must never silently run or
        // strand the turn.
        this.ctx.emit.onAgentStderr(
          this.agentId,
          "[zeros] Codex auto-approval failed; requesting user approval",
        );
      }
      if (approved) {
        // Forward a metadata-only settled gate so the renderer can correlate
        // the auto decision with the active prompt in logs/PostHog. The marker
        // makes this observational: it never renders a card or responds twice.
        try {
          this.ctx.emit.onPermissionRequest(
            this.agentId,
            request.permissionId,
            {
              ...mapApprovalToCanonical(session, request),
              autoResolution: "allow_once",
            },
          );
          this.ctx.emit.onPermissionSettled?.(
            this.agentId,
            request.permissionId,
            session.zerosSessionId,
          );
        } catch {
          this.ctx.emit.onAgentStderr(
            this.agentId,
            "[zeros] Codex auto-approval telemetry emit failed",
          );
        }
        console.info(
          `[codex] auto-approved ${request.method} in mode=auto-edit`,
        );
        return;
      }
    }
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

  /** An approval settled inside the runtime WITHOUT a respondToPermission (its
   *  response timeout, or dispose's cancel-all sweep, auto-cancelled the codex
   *  side). Twin of handleUserInputSettled: evict the pending entry and emit the
   *  settled echo so the renderer drops the parked card and the engine stops
   *  replaying it to a reloaded renderer as a gate whose resolver is already
   *  gone. No response argument — the codex side is already answered. */
  private handleApprovalSettled(
    session: CodexSession | undefined,
    permissionId: string,
  ): void {
    if (!session) return;
    this.settlePendingApproval(session, permissionId);
  }

  /** Settle one adapter-owned approval exactly once. When `response` is
   *  present, this path also resolves the live app-server JSON-RPC request;
   *  runtime-owned settlement callbacks omit it because that resolver is
   *  already gone. Deleting before either side effect makes re-entrant or
   *  duplicate lifecycle notifications harmless. */
  private settlePendingApproval(
    session: CodexSession,
    permissionId: string,
    response?: RequestPermissionResponse,
  ): boolean {
    const pending = session.pendingApprovals.get(permissionId);
    if (!pending || !session.pendingApprovals.delete(permissionId)) {
      return false;
    }
    try {
      if (response) {
        const codexResponse = mapResponseToCodexDecision(pending, response);
        pending.runtime.respondToPermission(permissionId, codexResponse);
      }
    } finally {
      try {
        this.ctx.emit.onPermissionSettled?.(
          this.agentId,
          permissionId,
          session.zerosSessionId,
        );
      } catch (err) {
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[zeros] permission settle emit failed for ${permissionId}: ${String(err)}`,
        );
      }
    }
    return true;
  }

  /** Drain a stable snapshot because responding can synchronously advance the
   *  Codex turn and mutate the pending map. */
  private drainPendingApprovals(
    session: CodexSession,
    resolveRuntime: boolean,
  ): void {
    for (const permissionId of [...session.pendingApprovals.keys()]) {
      try {
        this.settlePendingApproval(
          session,
          permissionId,
          resolveRuntime ? CANCELLED_PERMISSION_RESPONSE : undefined,
        );
      } catch (err) {
        // One malformed resolver must not keep the rest of the queue alive.
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[zeros] permission drain failed for ${permissionId}: ${String(err)}`,
        );
      }
    }
  }

  /** Drain a stable snapshot because answering one parked request can advance
   * the Codex turn and synchronously settle another. Stop, turn completion,
   * and disposal all use the method-specific safe dismissal response. */
  private drainPendingQuestions(
    session: CodexSession,
    resolveRuntime: boolean,
  ): void {
    const outcome = { outcome: "dismissed" } as const;
    for (const questionId of [...session.pendingQuestions.keys()]) {
      try {
        this.settlePendingQuestion(
          session,
          questionId,
          outcome,
          resolveRuntime ? { outcome } : undefined,
        );
      } catch (err) {
        // One malformed/native-future request must not keep the remainder of
        // the queue alive during a terminal lifecycle transition.
        this.ctx.emit.onAgentStderr(
          this.agentId,
          `[zeros] question drain failed for ${questionId}: ${String(err)}`,
        );
      }
    }
  }

  /** A blocking user-input question (item/tool/requestUserInput). Twin of
   *  handleApprovalRequest — the answer flows back via respondToQuestion. */
  private handleUserInputRequest(
    session: CodexSession,
    request: CodexUserInputRequest,
  ): void {
    if (this.autoAcceptRedirectBrowserOrigin(session, request)) return;
    const canonical = mapCodexQuestionToCanonical(
      session.zerosSessionId,
      request,
    );
    if (request.method === "item/tool/requestUserInput") {
      session.translator.emitUserInputToolCall(request.params);
    } else {
      session.translator.emitBlockingQuestionToolCall(
        canonical.toolCallId,
        "MCP input requested",
        mcpElicitationAuditInput(request.params as McpElicitationRequestLike),
      );
    }
    session.pendingQuestions.set(request.questionId, {
      runtime: session.runtime,
      request: canonical,
      native: request,
    });
    this.ctx.emit.onQuestionRequest(
      this.agentId,
      request.questionId,
      canonical,
    );
  }

  private autoAcceptRedirectBrowserOrigin(
    session: CodexSession,
    request: CodexUserInputRequest,
  ): boolean {
    const identity = browserOriginRequestIdentity(request);
    if (!identity) return false;
    const grants = session.browserOriginGrantsByTurn.get(identity.turnId);
    // "Allow" is provider-native Allow once. Reuse it only for the one common
    // canonical redirect where the destination differs solely by a leading
    // `www.`. An exact repeat must remain gated, and arbitrary subdomains have
    // distinct keys.
    const explicitlyGrantedOrigin = grants?.get(identity.key);
    const explicitlyGrantedExactOrigin = normalizedBrowserApprovalOrigin(
      explicitlyGrantedOrigin,
    );
    const requestedExactOrigin = normalizedBrowserApprovalOrigin(
      identity.origin,
    );
    if (
      !explicitlyGrantedOrigin ||
      !explicitlyGrantedExactOrigin ||
      explicitlyGrantedExactOrigin === requestedExactOrigin
    ) {
      return false;
    }
    session.runtime.respondToUserInput(request.questionId, {
      action: "accept",
      content: null,
      _meta: null,
    });
    return true;
  }

  private rememberBrowserOriginGrant(
    session: CodexSession,
    request: CodexUserInputRequest,
  ): void {
    const identity = browserOriginRequestIdentity(request);
    if (!identity) return;
    let grants = session.browserOriginGrantsByTurn.get(identity.turnId);
    if (!grants) {
      grants = new Map();
      session.browserOriginGrantsByTurn.set(identity.turnId, grants);
    }
    grants.set(identity.key, identity.origin);
    while (session.browserOriginGrantsByTurn.size > 2) {
      const oldest = session.browserOriginGrantsByTurn.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      session.browserOriginGrantsByTurn.delete(oldest);
    }
  }

  /** A user-input question settled inside the runtime WITHOUT a
   *  respondToQuestion (the response timeout answered codex empty). Evict the
   *  pending entry and tell the renderer to drop the parked card. */
  private handleUserInputSettled(
    session: CodexSession,
    questionId: string,
  ): void {
    this.settlePendingQuestion(session, questionId, { outcome: "dismissed" });
  }

  /** Post-settle bookkeeping shared by every settle path (answer, vendor-id
   *  fallback answer, timeout): stamp the engine transcript AND emit the
   *  settled echo. The echo is the renderer's DELIVERY RECEIPT — omitting it
   *  on the answer path makes the answer-ack watchdog cancel healthy Codex
   *  turns 10 seconds after every answer. */
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

  /** One line per slow turn, on the same stderr channel and in the same shape
   *  as the Claude adapter and the Cursor host, so the three providers can be
   *  compared without translating between three formats. No-op once the turn
   *  has reported, and for any turn that started talking promptly. */
  private reportFirstOutput(zerosSessionId: string): void {
    const session = this.sessions.get(zerosSessionId);
    if (!session?.firstToken.awaitingFirstOutput) return;
    const line = session.firstToken.firstOutput({
      cold: !session.sawFirstTurnOutput,
      model:
        session.env?.OPENAI_MODEL?.trim() || session.threadModel || undefined,
    });
    session.sawFirstTurnOutput = true;
    if (line) console.info(line);
  }

  private wireRuntimeToTranslator(
    runtime: CodexAppServerHandle,
    translator: CodexAppServerTranslator,
    owner: { threadId: string; zerosSessionId: string },
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
      "externalAgentConfig/import/progress",
      "externalAgentConfig/import/completed",
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
    // First model output of the turn. `turn/started` and the thread-status
    // frames acknowledge within milliseconds of `turn/start` even when the
    // model takes seconds to say anything, so the measurement keys on the
    // notifications that carry actual model output: a reasoning or message
    // delta, or the first item (a tool call) starting.
    const FIRST_OUTPUT_METHODS = new Set([
      "item/started",
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
    ]);
    for (const m of methods) {
      runtime.onNotification(m, (params) => {
        if (FIRST_OUTPUT_METHODS.has(m)) {
          this.reportFirstOutput(owner.zerosSessionId);
        }
        translator.handle(m, params);
      });
    }
    for (const method of [
      "item/mcpToolCall/progress",
      "hook/started",
      "hook/completed",
      "model/rerouted",
      "model/verification",
      "model/safetyBuffering/updated",
      "autoApprovalReview/strictReviewRequired",
    ] as const) {
      runtime.onNotification(method, (params) => {
        if ((params as { threadId?: unknown }).threadId !== owner.threadId) {
          return;
        }
        translator.handle(method, params);
      });
    }
    for (const method of [
      "mcpServer/oauthLogin/completed",
      "mcpServer/startupStatus/updated",
    ] as const) {
      runtime.onNotification(method, (params) => {
        const threadId = (params as { threadId?: unknown }).threadId;
        if (
          threadId !== null &&
          threadId !== undefined &&
          threadId !== owner.threadId
        ) {
          return;
        }
        translator.handle(method, params);
      });
    }
    // Codex may autonomously raise the thread to native `ultra`. Keep the ONE
    // existing composer effort picker truthful by persisting that provider
    // state into the exact parent chat. Child/collaboration thread settings
    // are intentionally ignored — they do not own the composer's setting.
    runtime.onNotification("thread/settings/updated", (params) => {
      const effort = codexEffortFromThreadSettings(params, owner.threadId);
      if (!effort) return;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: owner.zerosSessionId,
        update: { sessionUpdate: "current_effort_update", effort },
      });
    });
    runtime.onNotification("thread/goal/updated", (rawParams) => {
      const params = rawParams as {
        threadId: string;
        goal: ThreadGoal;
      };
      if (params.threadId !== owner.threadId) return;
      const session = this.sessions.get(owner.zerosSessionId);
      if (session) session.goalSnapshotEpoch += 1;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: owner.zerosSessionId,
        update: {
          sessionUpdate: "goal_update",
          goal: canonicalGoal(params.goal),
        },
      });
    });
    runtime.onNotification("thread/goal/cleared", (rawParams) => {
      const params = rawParams as { threadId: string };
      if (params.threadId !== owner.threadId) return;
      const session = this.sessions.get(owner.zerosSessionId);
      if (session) session.goalSnapshotEpoch += 1;
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: owner.zerosSessionId,
        update: { sessionUpdate: "goal_update", goal: null },
      });
    });
    for (const method of [
      "thread/environment/connected",
      "thread/environment/disconnected",
    ] as const) {
      runtime.onNotification(method, (params) => {
        if ((params as { threadId?: unknown }).threadId !== owner.threadId) {
          return;
        }
        translator.handle(method, params);
      });
    }
    runtime.onNotification("item/autoApprovalReview/started", (params) => {
      if ((params as { threadId?: unknown }).threadId !== owner.threadId) {
        return;
      }
      translator.handle("item/autoApprovalReview/started", params);
    });
    runtime.onNotification("item/autoApprovalReview/completed", (rawParams) => {
      const params =
        rawParams as ItemGuardianApprovalReviewCompletedNotification;
      if (params.threadId !== owner.threadId) return;
      const session = this.sessions.get(owner.zerosSessionId);
      let retryId: string | undefined;
      if (
        session &&
        params.review.status === "denied" &&
        params.decisionSource === "agent"
      ) {
        retryId = session.guardianRetryByReviewId.get(params.reviewId);
        if (retryId && !session.guardianDeniedActions.has(retryId)) {
          session.guardianRetryByReviewId.delete(params.reviewId);
          retryId = undefined;
        }
        retryId ??= randomUUID();
        // Replayed completed notifications update the existing engine-only
        // authority in place. Only a genuinely new authority consumes cache
        // capacity; otherwise a provider replay at the bound could revoke an
        // unrelated, still-valid renderer affordance.
        if (!session.guardianDeniedActions.has(retryId)) {
          while (
            session.guardianDeniedActions.size >= MAX_GUARDIAN_DENIED_ACTIONS
          ) {
            const oldest = session.guardianDeniedActions.keys().next().value;
            if (typeof oldest !== "string") break;
            const evicted = session.guardianDeniedActions.get(oldest);
            session.translator.revokeSafetyReviewRetry(oldest);
            session.guardianDeniedActions.delete(oldest);
            if (evicted) {
              session.guardianRetryByReviewId.delete(evicted.reviewId);
            }
          }
        }
        session.guardianDeniedActions.set(retryId, params);
        session.guardianRetryByReviewId.set(params.reviewId, retryId);
      }
      translator.handle("item/autoApprovalReview/completed", {
        ...params,
        ...(retryId ? { zerosRetryId: retryId } : {}),
      });
    });
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

function canonicalGoal(goal: ThreadGoal): AgentGoal {
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function buildInitializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: "Codex", version: "app-server" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      },
      // Mid-turn steering: steer() sends `turn/steer` against the active
      // turn id. Drives the queued-card "Send now" action.
      steering: true,
    },
    authMethods: [
      {
        type: "terminal",
        id: "terminal",
        name: "Sign in via Terminal",
        description: "Open Terminal.app and run `codex login`.",
      },
    ],
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
  browserUse?: AgentBrowserUse,
): CodexThreadStartParams {
  const model = env?.OPENAI_MODEL;
  const { approvalPolicy, sandboxMode } = modePolicyFor(modeId);
  return {
    cwd,
    sandbox: sandboxMode,
    // App-server applies this only to the Zeros-owned thread. When enabled,
    // Codex loads its official bundled Browser plugin and talks to the native
    // IAB pipe hosted by Electron. There is deliberately no `zeros_browser`
    // dynamic namespace or MCP fallback.
    config: codexBrowserThreadConfig(browserUse?.kind === "codex-app-server"),
    ...(model ? { model } : {}),
    ...(systemInstruction ? { developerInstructions: systemInstruction } : {}),
    approvalPolicy,
  };
}

/** Preserve the exact normal Codex mode on the native Code path. Design-agent
 * isolation is selected before the adapter starts and does not alter Codex's
 * ordinary per-mode sandbox contract for Code sessions. */
export function codexTurnAuthority(
  sandboxPolicy: CodexSandboxPolicy,
  additionalWritableRoots: readonly string[] = [],
): { sandboxPolicy: CodexSandboxPolicy } {
  return {
    sandboxPolicy:
      sandboxPolicy.type === "workspaceWrite" &&
      additionalWritableRoots.length > 0
        ? {
            ...sandboxPolicy,
            writableRoots: [
              ...new Set([
                ...sandboxPolicy.writableRoots,
                ...additionalWritableRoots,
              ]),
            ],
          }
        : sandboxPolicy,
  };
}

type CodexPathApi = Pick<
  typeof path,
  "isAbsolute" | "relative" | "resolve" | "sep"
>;

function parsedAbsoluteDirectories(
  raw: string | undefined,
  pathApi: CodexPathApi,
): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const roots = new Map<string, string>();
    for (const entry of parsed) {
      if (typeof entry !== "string" || !pathApi.isAbsolute(entry.trim())) {
        continue;
      }
      const root = pathApi.resolve(entry.trim());
      const key = pathApi.sep === "\\" ? root.toLowerCase() : root;
      if (!roots.has(key)) roots.set(key, root);
    }
    return [...roots.values()];
  } catch {
    return [];
  }
}

/** Exact user-authorized `/add-dir` roots for Codex's ordinary per-turn
 * workspace-write sandbox. */
export function codexAdditionalWritableRoots(
  env: Readonly<Record<string, string>> | undefined,
  cwd: string,
  pathApi: CodexPathApi = path,
): string[] {
  const workspace = pathApi.resolve(cwd);
  return parsedAbsoluteDirectories(env?.ZEROS_ADDITIONAL_DIRS, pathApi).filter(
    (root) => root !== workspace,
  );
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
        approvalPolicy: "never",
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
 *  ReasoningEffort is intentionally open in the current generated protocol
 *  (`ReasoningEffort.ts` is just `string`), so a wrong token is NOT a compile
 *  error — it comes back at runtime as `turn/start: Invalid request: unknown
 *  variant`, i.e. every send fails. So each Zeros tier must map onto a token
 *  Codex really has:
 *    • `ultra`  — the native proactive multi-agent tier (`ultracode` → this).
 *    • `max`    — native on current Codex models (including GPT-5.6), and must
 *                 remain distinct from `xhigh` so a provider settings echo
 *                 cannot rewrite the user's Max selection as Extra High.
 *  Unknown / empty values stay unset so Codex picks its own default
 *  (typically "medium"). */
export function mapCodexEffortFromEnv(
  value: string | undefined,
):
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | undefined {
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
    case "max":
      return "max";
    case "ultracode":
    case "ultra":
      return "ultra";
    default:
      return undefined;
  }
}

/** Codex protocol token → the already-shipping composer effort vocabulary. */
export function mapCodexAdvertisedEffort(
  value: string | undefined,
): string | undefined {
  switch (value?.trim().toLowerCase()) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultracode":
      return value.trim().toLowerCase();
    case "ultra":
      return "ultracode";
    default:
      return undefined;
  }
}

/** Safely read a thread/settings/updated frame and reject child-thread drift. */
export function codexEffortFromThreadSettings(
  params: unknown,
  parentThreadId: string,
): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const frame = params as {
    threadId?: unknown;
    threadSettings?: { effort?: unknown } | null;
  };
  if (frame.threadId !== parentThreadId) return null;
  return typeof frame.threadSettings?.effort === "string"
    ? (mapCodexAdvertisedEffort(frame.threadSettings.effort) ?? null)
    : null;
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

function browserOriginRequestIdentity(
  request: CodexUserInputRequest,
): { turnId: string; key: string; origin: string } | null {
  if (request.method !== "mcpServer/elicitation/request") return null;
  const params = request.params as McpElicitationRequestLike;
  const meta =
    params._meta &&
    typeof params._meta === "object" &&
    !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : null;
  if (
    meta?.codex_approval_kind !== "mcp_tool_call" ||
    meta.tool_title !== "Access browser origin"
  ) {
    return null;
  }
  const turnId = typeof params.turnId === "string" ? params.turnId : "";
  const display = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display
    : [];
  const originRow = display.find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).name === "origin",
  ) as Record<string, unknown> | undefined;
  const origin = typeof originRow?.value === "string" ? originRow.value : "";
  const key = canonicalBrowserOriginGrantKey(origin);
  return turnId && key ? { turnId, key, origin } : null;
}

function normalizedBrowserApprovalOrigin(
  value: string | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

// ── blocking server questions → canonical QuestionRequest ──

/** Route Codex-native questions and MCP elicitation through the same canonical
 * card while retaining their distinct response schemas. */
export function mapCodexQuestionToCanonical(
  sessionId: string,
  request: CodexUserInputRequest,
): QuestionRequest {
  if (request.method === "mcpServer/elicitation/request") {
    const params = request.params as McpElicitationRequestLike;
    const nativeRequestId =
      (typeof params.elicitationId === "string" && params.elicitationId) ||
      request.rpcRequestId;
    return buildMcpElicitationQuestion({
      sessionId,
      questionId: request.questionId,
      nativeRequestId,
      toolCallId: `mcp-elicitation:${nativeRequestId}`,
      request: params,
      expiresAt:
        request.expiresAt ?? Date.now() + PERMISSION_RESPONSE_TIMEOUT_MS,
    });
  }
  return mapUserInputToQuestion(
    sessionId,
    request.questionId,
    request.rpcRequestId,
    request.params,
    request.expiresAt,
  );
}

/** Convert a Codex ToolRequestUserInputParams into the canonical QuestionRequest.
 *  Codex specifics: option `id` == `label` (the answer is a label array, so the
 *  labels ARE the ids); Codex currently has no generated multiSelect field, so
 *  option questions default to single-select unless a future boolean appears;
 *  `options: null` → a pure free-text question; `isOther`/`isSecret` map to the
 *  free-text row + masking. */
function mapUserInputToQuestion(
  sessionId: string,
  questionId: string,
  rpcRequestId: string,
  params: Record<string, unknown>,
  expiresAt?: number,
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
    nativeRequestId: itemId ?? rpcRequestId,
    toolCallId: itemId,
    source: "native_rpc",
    blocking: true,
    // app-server.ts owns the resolver timer and forwards its exact deadline.
    // The fallback covers synthetic/older test requests only.
    expiresAt: expiresAt ?? Date.now() + PERMISSION_RESPONSE_TIMEOUT_MS,
    questions,
  };
}

/** Canonical QuestionResponse → Codex ToolRequestUserInputResponse
 *  ({ answers: { [questionId]: { answers: string[] } } }). Since option id ==
 *  label, selectedOptionIds ARE the labels; free-text is appended last. On
 *  dismiss/decline we send empty arrays for every question id because Codex
 *  has no cancel variant. (Only MCP cards expose decline as a distinct action.) */
function mapNativeQuestionAnswerToCodex(
  request: QuestionRequest,
  response: QuestionResponse,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (response.outcome.outcome !== "answered") {
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

/** Canonical response → the originating Codex server-request response. URL
 * elicitations additionally return an out-of-band browser action which the
 * adapter executes only after explicit acceptance. */
export function mapCodexQuestionAnswer(
  native: CodexUserInputRequest,
  request: QuestionRequest,
  response: QuestionResponse,
):
  | McpElicitationAnswer
  | { response: ReturnType<typeof mapNativeQuestionAnswerToCodex> } {
  if (native.method === "mcpServer/elicitation/request") {
    return answerMcpElicitation(
      native.params as McpElicitationRequestLike,
      response,
    );
  }
  return { response: mapNativeQuestionAnswerToCodex(request, response) };
}

// ── Approval params → canonical RequestPermissionRequest ─────

interface NativeCommandChoice {
  option: PermissionOption;
  decision: unknown;
}

const BASE_COMMAND_DECISIONS = {
  accept: { name: "Approve once", kind: "allow_once" },
  acceptForSession: {
    name: "Approve for session",
    kind: "allow_always",
  },
  decline: { name: "Decline", kind: "reject_once" },
  cancel: { name: "Cancel", kind: "reject_always" },
} as const;

/** Convert one app-server `availableDecisions` entry into a stable renderer
 * choice. Object decisions are referenced by their position rather than
 * serialized into the option id; the response mapper indexes back into the
 * adapter-owned params, so renderer input can never manufacture a policy. */
function nativeCommandChoice(
  decision: unknown,
  index: number,
): NativeCommandChoice | null {
  if (typeof decision === "string" && decision in BASE_COMMAND_DECISIONS) {
    const spec =
      BASE_COMMAND_DECISIONS[decision as keyof typeof BASE_COMMAND_DECISIONS];
    return {
      option: { optionId: decision, name: spec.name, kind: spec.kind },
      decision,
    };
  }

  const record = asRecord(decision);
  const exec = asRecord(record?.acceptWithExecpolicyAmendment);
  const execPolicy = exec?.execpolicy_amendment;
  if (
    Array.isArray(execPolicy) &&
    execPolicy.length > 0 &&
    execPolicy.every((part) => typeof part === "string")
  ) {
    return {
      option: {
        optionId: `acceptWithExecpolicyAmendment:${index}`,
        name: "Approve and remember command rule",
        kind: "allow_always",
      },
      decision,
    };
  }

  const network = asRecord(record?.applyNetworkPolicyAmendment);
  const amendment = asRecord(network?.network_policy_amendment);
  const host = stringField(amendment ?? {}, "host")?.trim();
  const action = amendment?.action;
  if (host && (action === "allow" || action === "deny")) {
    return {
      option: {
        optionId: `applyNetworkPolicyAmendment:${index}`,
        name:
          action === "allow"
            ? `Approve and allow ${host}`
            : `Deny and block ${host}`,
        kind: action === "allow" ? "allow_always" : "reject_always",
      },
      decision,
    };
  }
  return null;
}

function nativeCommandChoices(
  params: Record<string, unknown>,
): NativeCommandChoice[] | null {
  const available = params.availableDecisions;
  if (!Array.isArray(available)) return null;
  const choices: NativeCommandChoice[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < available.length; index += 1) {
    const choice = nativeCommandChoice(available[index], index);
    if (!choice || seenIds.has(choice.option.optionId)) continue;
    seenIds.add(choice.option.optionId);
    choices.push(choice);
  }
  return choices;
}

function commandApprovalContext(params: Record<string, unknown>): string[] {
  const items: string[] = [];
  const networkContext = asRecord(params.networkApprovalContext);
  const host = stringField(networkContext ?? {}, "host")?.trim();
  const protocol = stringField(networkContext ?? {}, "protocol")?.trim();
  if (host) {
    items.push(`Network · ${protocol ? `${protocol}://` : ""}${host}`);
  }

  const additional = asRecord(params.additionalPermissions);
  const network = asRecord(additional?.network);
  if (network?.enabled === true) items.push("Extra network access");
  const fileSystem = asRecord(additional?.fileSystem);
  for (const [label, value] of [
    ["Read", fileSystem?.read],
    ["Write", fileSystem?.write],
  ] as const) {
    if (!Array.isArray(value)) continue;
    for (const pathValue of value) {
      if (typeof pathValue === "string" && pathValue.trim()) {
        items.push(`${label} · ${pathValue}`);
      }
    }
  }
  if (Array.isArray(fileSystem?.entries)) {
    for (const entryValue of fileSystem.entries) {
      const entry = asRecord(entryValue);
      const access = stringField(entry ?? {}, "access");
      const pathSpec = asRecord(entry?.path);
      const pathValue =
        stringField(pathSpec ?? {}, "path") ??
        stringField(pathSpec ?? {}, "pattern") ??
        stringField(pathSpec ?? {}, "value");
      if (access && pathValue) items.push(`${access} · ${pathValue}`);
    }
  }
  // The full, unabridged request remains in rawInput. Keep the prominent pill
  // row bounded when a sandbox asks for a large path set.
  return items.slice(0, 6);
}

/** Convert a codex approval request into the canonical Zeros shape the
 *  gateway broadcasts to the renderer. Command approvals honor the exact
 *  ordered `availableDecisions` list when app-server supplies one, including
 *  exec-policy and network-policy amendment objects. */
export function mapApprovalToCanonical(
  session: CodexSession,
  request: CodexApprovalRequest,
): RequestPermissionRequest {
  const params = request.params;
  const itemId =
    stringField(params, "itemId") ??
    stringField(params, "callId") ??
    randomUUID();
  const reason = stringField(params, "reason");
  const command = commandField(params, "command");
  const cwd = stringField(params, "cwd");

  let title: string;
  let kind: "execute" | "edit" | "switch_mode";
  let rawInput: unknown;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      title = command ? `Run: ${truncate(command, 60)}` : "Run shell command";
      kind = "execute";
      rawInput = {
        command,
        cwd,
        reason,
        networkApprovalContext: params.networkApprovalContext,
        additionalPermissions: params.additionalPermissions,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
        availableDecisions: params.availableDecisions,
      };
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
    case "applyPatchApproval": {
      const fileChanges = asRecord(params.fileChanges);
      const filePaths = fileChanges ? Object.keys(fileChanges) : [];
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

  const nativeChoices =
    request.method === "item/commandExecution/requestApproval"
      ? nativeCommandChoices(params)
      : null;
  const options =
    nativeChoices === null
      ? [
          { optionId: "accept", name: "Approve", kind: "allow_once" },
          {
            optionId: "acceptForSession",
            name: "Approve for session",
            kind: "allow_always",
          },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
          { optionId: "cancel", name: "Cancel", kind: "reject_always" },
        ]
      : nativeChoices.length > 0
        ? nativeChoices.map((choice) => choice.option)
        : [
            {
              optionId: "cancel",
              name: "Cancel unsupported approval",
              kind: "reject_always",
            },
          ];
  const contextItems =
    request.method === "item/commandExecution/requestApproval"
      ? commandApprovalContext(params)
      : [];

  return {
    sessionId: session.zerosSessionId as never,
    toolCall: {
      toolCallId: itemId,
      title,
      kind: kind as never,
      status: "pending" as never,
      rawInput,
    } as never,
    options,
    // Codex persists its own session/policy decisions. A Zeros-side policy is
    // broader (tool title/kind matching) and could auto-select the wrong native
    // amendment on a later request, so provider-ordered gates stay
    // provider-owned. That reasoning is specific to `availableDecisions`:
    // plain edit/permission gates carry no amendments, and disabling local
    // policies for them would quietly stop honoring "don't ask again" rules
    // users already saved.
    ...(nativeChoices !== null
      ? { useOptionNames: true, allowLocalPolicies: false }
      : {}),
    ...(contextItems.length > 0 ? { contextItems } : {}),
  } as never;
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
    case "item/commandExecution/requestApproval": {
      const choices = nativeCommandChoices(params);
      if (choices !== null) {
        const selected = choices.find(
          (choice) => choice.option.optionId === optionId,
        );
        return { decision: selected?.decision ?? "cancel" };
      }
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
      // When the user accepts, grant exactly what the
      // agent asked for in `params.permissions` (RequestPermissionProfile
      // shape) — NOT a blanket enable-everything. The codex agent
      // requests the minimum permissions it needs for the next step;
      // mirroring the request keeps the principle-of-least-privilege
      // semantics even without a granular picker UI.
      //
      // A future granular picker would replace this mirror with a
      // custom grant payload riding on the wire (the RequestPermissionResponse
      // shape doesn't currently carry grant fields).
      if (optionId !== "accept" && optionId !== "acceptForSession") {
        return defaultMethodResponse(method, "decline");
      }
      const requested = asRecord(params.permissions);
      const requestedNetwork = asRecord(requested?.network);
      const requestedFileSystem = asRecord(requested?.fileSystem);
      return {
        permissions: {
          // Mirror the complete provider-authored profile, including the
          // entry-based filesystem vocabulary added alongside legacy
          // read/write arrays. The renderer never supplies these fields, so it
          // cannot widen the request. Missing/malformed branches grant nothing.
          network: requestedNetwork
            ? { ...requestedNetwork }
            : { enabled: false },
          fileSystem: requestedFileSystem
            ? { ...requestedFileSystem }
            : { read: [], write: [] },
        },
        scope: optionId === "acceptForSession" ? "session" : "turn",
      };
    }
    case "execCommandApproval":
    case "applyPatchApproval": {
      let decision: unknown;
      switch (optionId) {
        case "accept":
          decision = "approved";
          break;
        case "acceptForSession":
          decision = "approved_for_session";
          break;
        case "decline":
          decision = {
            denied: { rejection: "User declined this action." },
          };
          break;
        case "cancel":
        default:
          decision = "abort";
          break;
      }
      return { decision };
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
    case "execCommandApproval":
    case "applyPatchApproval":
      return decision === "cancel"
        ? { decision: "abort" }
        : {
            decision: {
              denied: { rejection: "User declined this action." },
            },
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

function commandField(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
const RATE_LIMIT_RX =
  /\b(?:429|rate[\s_-]*limit(?:ed|_error)?|too many requests|resource exhausted|usage limit exceeded|server overloaded)\b/i;

function codexRateLimitFailure(
  message: string,
  stage: "newSession" | "loadSession" | "forkSession" | "prompt",
): AgentFailureError {
  return new AgentFailureError({
    kind: "rate-limited",
    message: `Codex rate limit: ${message}`,
    stage,
    agentId: AGENT_ID,
    advice:
      "Codex is rate-limiting requests. Wait for the provider reset, then try again.",
  });
}

// Patterns that indicate codex no longer has the rollout/thread we're
// trying to talk to. Broadened from the original "no rollout found"
// regex because the runtime's wording has
// shifted across versions (e.g. "no longer has a rollout" surfaces
// in 0.131+ vs the older "no rollout found"). The wider net keeps
// the auto-recover-by-falling-back-to-startThread path firing on the
// new wording so the user doesn't see a hard "Session expired" toast.
// IMPORTANT: keep in sync with SESSION_EXPIRED_KEYWORDS in
// shared/session-expiry.ts and SESSION_EXPIRED_RX in
// apps/desktop/src/renderer/platform/bridge/failure.ts — same fixture strings must classify
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

async function withRuntimeDisposeFailure(
  runtime: CodexAppServerHandle,
  original: unknown,
): Promise<unknown> {
  try {
    await runtime.dispose();
    return original;
  } catch (disposeError) {
    return new AggregateError(
      [original, disposeError],
      "Codex startup failed and its process group did not stop cleanly",
    );
  }
}

function classifyBootFailure(
  err: unknown,
  stage: "newSession" | "loadSession" | "forkSession",
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (RATE_LIMIT_RX.test(message)) {
    return codexRateLimitFailure(message, stage);
  }
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
  stage: "newSession" | "loadSession" | "forkSession" | "prompt",
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (RATE_LIMIT_RX.test(message)) {
    return codexRateLimitFailure(message, stage);
  }
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
