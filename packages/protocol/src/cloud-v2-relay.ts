// Cloud workspace v2 relay contract.
//
// The Mac app speaks ordinary bridge frames (./messages) to the control plane,
// which forwards them verbatim to the workspace worker on its Boat VM. This file
// defines only the envelope between the control plane and the worker, plus the
// capabilities the shared UI reads to hide tabs a cloud workspace does not offer.
// The control plane mirrors these schemas (it deploys independently, on zod 3).
import { z } from "zod";
import { CloudWorkspaceEnvironmentSchema } from "./cloud-workspace-environment";
export * from "./cloud-workspace-environment";
export * from "./cloud-runtime-update";
export * from "./cloud-workspace-resources";
import { MAX_BRIDGE_FRAME_BYTES } from "./schemas";
import { CloudV2ChatEditAckSchema, CloudV2PromptCounterSchema, CloudV2PromptIdSchema, CloudV2PromptStateSchema } from "./cloud-v2-prompts";
import { RepositorySetupPathSchema } from "./repository-setup";
export { RepositorySetupPathSchema, REPOSITORY_SETUP_MAX_BYTES } from "./repository-setup";
export { CloudFailureSchema, CloudProviderFailureSchema, CloudMcpFailureSchema, cloudFailureMessage } from "./cloud-failure";
export type { CloudFailure, CloudProviderFailure, CloudMcpFailure } from "./cloud-failure";

export const CLOUD_V2_RELAY_PROTOCOL = 2;
export const CLOUD_V2_WORKER_PORT = 41783;
export const CLOUD_V2_WORKER_BRIDGE_PATH = "/v2/worker/bridge";
export const CLOUD_V2_WORKER_BRIDGE_PROTOCOL = "zeros.cloud.v2.worker";
export const CLOUD_V2_MAX_FRAME_BYTES = MAX_BRIDGE_FRAME_BYTES;
/** Rows per history frame; larger backfills are split by the sender. */
export const CLOUD_V2_MAX_HISTORY_ROWS = 500;

export const CloudV2AgentSchema = z.enum(["codex", "claude", "cursor"]);
export type CloudV2Agent = z.infer<typeof CloudV2AgentSchema>;

/** What the shared UI may show. Cloud v2 never offers Design, the browser or
 * simulators; the UI gates those tabs on this object, not on placement. */
export const CloudV2CapabilitiesSchema = z.object({
  design: z.literal(false),
  browser: z.literal(false),
  simulators: z.literal(false),
  terminal: z.boolean(),
  files: z.boolean(),
  git: z.boolean(),
  agents: z.array(CloudV2AgentSchema).max(3),
  promptOutbox: z.literal(1).optional(),
  githubPullRequests: z.literal(1).optional(),
  /** Configuration delivery is sent only after a worker advertises this version. */
  mcp: z.literal(1).optional(),
}).strict();
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

const clientId = z.uuid();

// ── Team sharing phase 2, slice B (team-sharing-2-wire.md "Slice B shapes") ──
/** Worker feature: leases, contexts and per-person execution. Only an activated workspace's capable boot uses it. */
export const ACTING_USER_FEATURE = "acting-user-v1";
/** A decimal bigint string, 1..9223372036854775806, never a JSON number. */
const GENERATION = /^[1-9][0-9]{0,18}$/;
// The regex is checked again inside the refine: zod still runs a refine after a failed regex, and BigInt() throws on non-digits.
export const CloudV2GenerationSchema = z.string().regex(GENERATION)
  .refine(value => GENERATION.test(value) && BigInt(value) <= 9223372036854775806n, "Generation out of range");
/** Why a context ended (renew refusals and revoke-context pushes). */
export const CloudV2ContextReasonSchema = z.enum(["completed", "cancelled", "access_revoked", "actor_changed", "expired", "worker_changed", "client_closed"]);
export type CloudV2ContextReason = z.infer<typeof CloudV2ContextReasonSchema>;
/** One bridge frame, opaque to the relay. Both ends parse it with ./schemas. */
const frame = z.unknown();

/** The same row Local persists from `applyUpdate` (engine db/messages). */
export const CloudV2MessageRowSchema = z.object({
  msgId: z.string().min(1).max(256),
  kind: z.string().max(64),
  payload: z.string().max(1_000_000),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type CloudV2MessageRow = z.infer<typeof CloudV2MessageRowSchema>;

/** A chat row as `chats.list` returns it; validated by its readers. */
const chatRow = z.object({ id: z.string().min(1).max(256) }).loose();

/** A transcript cut retires older delivery bubbles, not their receipts. */
export const CloudV2HistoryStateSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  beforeEpoch: CloudV2PromptCounterSchema.refine(value => !/[^0-9]/.test(value)).optional(),
}).strict();
export type CloudV2HistoryState = z.infer<typeof CloudV2HistoryStateSchema>;

/** Durable mirror so the app can read history while the VM sleeps. */
export const CloudV2HistoryFrameSchema = z.object({
    t: z.literal("history"),
    chats: z.array(chatRow).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    chatDeletions: z.array(z.string().min(1).max(256)).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    messages: z.object({
      chatId: z.string().min(1).max(256),
      rows: z.array(CloudV2MessageRowSchema).max(CLOUD_V2_MAX_HISTORY_ROWS),
      replace: z.literal(true).optional(),
      historyState: CloudV2HistoryStateSchema.optional(),
    }).strict().refine(value => !value.historyState || value.replace === true, "History state requires replacement").optional(),
    /** chat-edit-v1 only: edits whose chat rows this same batch carries. */
    chatEditAcks: z.array(CloudV2ChatEditAckSchema).max(128).optional(),
  }).strict();

/** setup-status-v1: `POST /v2/cloud/worker/setup` body, and the workspace
 * document's top-level `setup`. Times are epoch milliseconds. No path, script
 * or log crosses the wire. */
export const CLOUD_V2_SETUP_STATES = ["running", "succeeded", "failed", "interrupted"] as const;
export const CloudV2SetupStatusSchema = z.object({
  state: z.enum(CLOUD_V2_SETUP_STATES),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  reason: z.enum(["timed_out", "script_refused", "source_changed"]).optional(),
}).strict();
export type CloudV2SetupStatus = z.infer<typeof CloudV2SetupStatusSchema>;

/** The workspace document's top-level `agentCost`: the running total of turns
 * whose mirrored prompt row carried `turnSummary.usage.totalCostUsd`. */
export const CloudV2AgentCostSchema = z.object({ totalUsd: z.number().nonnegative().finite(), estimated: z.boolean() }).strict();
export type CloudV2AgentCost = z.infer<typeof CloudV2AgentCostSchema>;

export const CloudV2WorkerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
    workerVersion: z.string().min(1).max(64),
    capabilities: CloudV2CapabilitiesSchema,
  }).strict(),
  /** `"*"` reaches every attached app connection. */
  z.object({ t: z.literal("frame"), clientId: z.union([clientId, z.literal("*")]), frame }).strict(),
  CloudV2HistoryFrameSchema,
  /** Idle means no running agent turn or recent terminal activity. */
  z.object({ t: z.literal("idle"), idle: z.boolean() }).strict(),
  /** Negotiated worker-push-v1 only; the socket supplies workspace authority. */
  z.object({ t: z.literal("activity"), id: z.uuid(), idle: z.boolean() }).strict(),
  z.object({ t: z.literal("request"), id: z.uuid(), kind: z.literal("github-token"), purpose: z.enum(["git", "gh"]).optional(), failedTokenSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional(),
    /** Team sharing slice B (activated acting-user-v1 only): the execution context whose person's credential is asked for. */
    contextId: z.uuid().optional() }).strict(),
  z.object({ t: z.literal("stop-ack"), id: z.uuid() }).strict(),
]);
export type CloudV2WorkerFrame = z.infer<typeof CloudV2WorkerFrameSchema>;

const proxy = z.object({ baseUrl: z.url(), token: z.string().min(16).max(4096), expiresAt: z.number().int() }).strict();
const secret = z.string().min(16).max(16384);
/** A commit identity (config, and phase 2 leases). */
export const CloudV2GitIdentitySchema = z.object({
  name: z.string().trim().min(1).max(256).refine(value => !/[<>\p{Cc}]/u.test(value)),
  email: z.string().regex(/^[1-9][0-9]{0,15}\+[A-Za-z0-9_.-]{1,100}@users\.noreply\.github\.com$/),
}).strict();
/** Agent logins by provider (config, and phase 2 turn leases with exactly one key). */
export const CloudV2AgentLoginsSchema = z.object({
  codex: proxy.optional(),
  claude: z.union([z.object({ oauthToken: secret }).strict(), z.object({ apiKey: secret }).strict()]).optional(),
  cursor: z.object({ apiKey: z.string().min(1).max(4096) }).strict().optional(),
}).strict();

const mcpValues = z.record(z.string().min(1).max(256), z.string().max(16384))
  .refine(value => Object.keys(value).length <= 128, "Too many MCP values");
const mcpIdentity = { id: z.uuid(), name: z.string().min(1).max(128) };
/** Private delivery only. These values must never enter history or diagnostics. */
export const RuntimeMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ ...mcpIdentity, transport: z.literal("stdio"), command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(128).optional(), cwd: z.string().max(4096).optional(),
    env: mcpValues.optional(), listen_url: z.string().min(1).max(4096).optional(),
  }).strict(),
  ...(["http", "sse"] as const).map(transport => z.object({ ...mcpIdentity, transport: z.literal(transport),
    url: z.string().min(1).max(4096), headers: mcpValues.optional(), auth: z.enum(["none", "header", "oauth"]).optional(),
    disabled_tools: z.array(z.string().min(1).max(256)).max(1024).optional(),
  }).strict()),
]);
export type RuntimeMcpServer = z.infer<typeof RuntimeMcpServerSchema>;

export const CloudV2ControlFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("push"), prompts: z.boolean() }).strict(),
  z.object({ t: z.literal("activity-reply"), id: z.uuid(), prompts: z.boolean(),
    loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    state: z.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"]),
  }).strict(),
  z.object({ t: z.literal("prompts") }).strict(),
  /** passive (Order 3): a syncing Mac; never activity, never in the census, sync reads only. */
  z.object({ t: z.literal("open"), clientId, passive: z.literal(true).optional(),
    /** The worker's own inbound bridge only: the syncing Mac's device id (never from the control plane). */
    device: z.string().uuid().optional(),
    /** Activated acting-user-v1 only: the CP-authored person and client context; a worker never trusts a client's claim. */
    userId: z.uuid().optional(), contextId: z.uuid().optional() }).strict(),
  /** Activated acting-user-v1 only: end that context now (a lost push is caught by renew or expiry). */
  z.object({ t: z.literal("revoke-context"), contextId: z.uuid(), reason: CloudV2ContextReasonSchema }).strict(),
  z.object({ t: z.literal("close"), clientId }).strict(),
  z.object({ t: z.literal("frame"), clientId, frame }).strict(),
  z.object({ t: z.literal("stop"), id: z.uuid() }).strict(),
  /** Sent after hello and again before any proxy token expires or a login
   * changes. HTTPS revision polling repairs a missed push. The control plane
   * owns proxy token refresh. */
  z.object({
    t: z.literal("config"),
    environment: CloudWorkspaceEnvironmentSchema.optional(),
    promptOutbox: z.literal(1).optional(),
    runtimeUpdate: z.literal(1).optional(),
    agentInteractions: z.literal(1).optional(),
    codeReview: z.object({
      userId: z.uuid(),
      userName: z.string().min(1).max(256).refine(value => !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value)).optional(),
    }).strict().optional(),
    historyReplacement: z.literal(1).optional(),
    gitIdentity: CloudV2GitIdentitySchema.nullable().optional(),
  githubPullRequests: z.literal(1).optional(),
    githubUserTokens: z.literal(1).optional(),
    /** local-commands-v1 workers only, while the organization allows local
     * commands (provisional until the control plane's design is final). */
    localCommands: z.literal(1).optional(),
    /** Wire v1.3: RunLocalCommand offers and sends `reason`. */
    localCommandReason: z.literal(1).optional(),
    /** notify-user-v1: NotifyUser on zeros_workspace (batch B1). */
    notifyUser: z.literal(1).optional(),
    loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    /** Activated team sharing: personal material comes only from leases (agents {}, gitIdentity null here). */
    actingUser: z.literal(1).optional(),
    /** The persisted create/start/restart/wake initiator's setup context (bootstrap lease). */
    bootstrapContextId: z.uuid().optional(),
    /** Sent only to workers advertising workspace-api-v1 whose workspace has
     * API access. The token is fixed for one VM run (create or wake until stop). */
    api: z.object({
      url: z.url({ protocol: /^https$/ }).max(2048),
      token: z.string().regex(/^zw2a_[A-Za-z0-9_-]{43}$/),
    }).strict().optional(),
    mcpServers: z.array(RuntimeMcpServerSchema).max(128).optional(),
    workspace: z.object({
      id: z.uuid(),
      organizationId: z.uuid(),
      checkoutPath: z.string().min(1).max(1024),
      repository: z.string().min(1).max(512),
      github: z.object({ repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/),
        repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
        previousRepositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)).max(102),
      }).strict().optional(),
      /** Created from the locally available baseCommit, else the on-disk baseBranch. */
      branch: z.string().min(1).max(255),
      baseBranch: z.string().min(1).max(255),
      /** Delivered only with checkout-v2; the base head recorded at creation. */
      baseCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
      /** Delivered only with workspace-setup-v1; runs once after a new checkout. */
      setup: z.string().max(8000).optional(),
      setupScript: RepositorySetupPathSchema.optional(),
    }).strict(),
    agents: CloudV2AgentLoginsSchema,
  }).strict(),
  z.object({ t: z.literal("reply"), id: z.uuid(), token: z.string().min(1).max(8192), expiresAt: z.number().int() }).strict(),
  z.object({ t: z.literal("refusal"), id: z.uuid(), code: z.string().min(1).max(64) }).strict(),
]);
export type CloudV2ControlFrame = z.infer<typeof CloudV2ControlFrameSchema>;

/** Worker-only HTTPS inputs. Bearer tokens scope them to one workspace; the
 * boot id fences a prior process after wake. History retries reuse sequence. */
export const CloudV2WorkerHelloSchema = z.object({
  protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/), bootId: z.uuid(),
}).strict();
export const CloudV2WorkerHistorySchema = CloudV2HistoryFrameSchema.extend({ bootId: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const CloudV2WorkerActivitySchema = z.object({ idle: z.boolean() }).strict();
export const CloudV2WorkerActivityReplySchema = z.object({
  loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  state: z.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"]),
}).strict();

/** Optional diagnostics travel on their own HTTPS endpoint, never in a strict
 * hello/history frame. No command, path, provider output or credential values. */
export const CloudV2WorkerTimingSchema = z.object({
  phase: z.enum(["worker_checkout", "worker_checkout_fetch", "worker_checkout_switch", "worker_session_store", "worker_services", "worker_configure",
    "worker_services_review", "worker_services_workspace", "worker_services_mcp", "worker_reconfigure", "worker_reconfigure_workspace", "worker_reconfigure_mcp", "worker_reconfigure_ready",
    "worker_workspace_state", "worker_workspace_metadata", "worker_workspace_remote", "worker_workspace_poll", "worker_workspace_watch"]),
  durationMs: z.number().int().nonnegative().max(3_600_000),
}).strict();
export type CloudV2WorkerTiming = z.infer<typeof CloudV2WorkerTimingSchema>;

// ── Team sharing phase 2, slice B: leases (team-sharing-2-wire.md "Slice B shapes") ──
const epochMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contextApi = z.object({ url: z.url({ protocol: /^https$/ }).max(2048), token: z.string().regex(/^zw2x_[A-Za-z0-9_-]{43}$/) }).strict();
/** The active parent turn's person, generation and user message. */
export const CloudV2ActorSchema = z.object({ userId: z.uuid(), generation: CloudV2GenerationSchema, userMessageId: CloudV2PromptIdSchema }).strict();
export type CloudV2Actor = z.infer<typeof CloudV2ActorSchema>;
/** prompts/begin reply: the legacy shape, or an activated dispatch with its actor and context. */
export const CloudV2BeginLegacyReplySchema = z.object({ state: CloudV2PromptStateSchema, dispatch: z.boolean() }).strict();
export const CloudV2BeginActiveReplySchema = z.object({
  dispatch: z.literal(true), state: CloudV2PromptStateSchema, actingUser: CloudV2ActorSchema, contextId: z.uuid(),
  mode: z.enum(["prompt", "steer"]), parentContextId: z.uuid().optional(),
}).strict().refine(value => value.mode === "steer" ? value.parentContextId === value.contextId : value.parentContextId === undefined,
  "A steer reuses its parent's context; a prompt has none");
/** Exactly one agent key: the active turn's. */
const oneAgent = CloudV2AgentLoginsSchema.refine(value => Object.keys(value).length === 1, "Exactly one agent");
export const CloudV2TurnLeaseRequestSchema = z.object({ chatId: CloudV2PromptIdSchema, userMessageId: CloudV2PromptIdSchema, dispatchId: z.uuid(),
  generation: CloudV2GenerationSchema, contextId: z.uuid() }).strict();
export const CloudV2TurnLeaseSchema = z.object({
  contextId: z.uuid(), userId: z.uuid(), generation: CloudV2GenerationSchema, expiresAt: epochMs, agents: oneAgent,
  gitIdentity: CloudV2GitIdentitySchema.nullable(), environment: CloudWorkspaceEnvironmentSchema.optional(),
  mcpServers: z.array(RuntimeMcpServerSchema).max(128).optional(), api: contextApi.optional(),
}).strict();
export type CloudV2TurnLease = z.infer<typeof CloudV2TurnLeaseSchema>;
export const CloudV2TerminalLeaseRequestSchema = z.object({ clientId: z.uuid(), terminalId: CloudV2PromptIdSchema, requestId: CloudV2PromptIdSchema }).strict();
export const CloudV2TerminalLeaseSchema = z.object({ contextId: z.uuid(), userId: z.uuid(), expiresAt: epochMs,
  gitIdentity: CloudV2GitIdentitySchema.nullable(), environment: CloudWorkspaceEnvironmentSchema.optional(), api: contextApi.optional() }).strict();
export type CloudV2TerminalLease = z.infer<typeof CloudV2TerminalLeaseSchema>;
/** The worker's real client mutations that need a person (closed list; git.repoBranchCatalog only with params.fetch === true). */
export const CLOUD_V2_CLIENT_OPERATIONS = ["git.prepareGithub", "git.stage", "git.unstage", "git.discard", "git.clean", "git.commit", "git.push",
  "git.pull", "git.rebase", "git.fetch", "git.stashSave", "git.stashPop", "git.stashApply", "git.stashDrop", "git.checkoutBranch", "git.createBranch",
  "git.renameBranch", "git.changeTarget", "git.merge", "git.cherryPick", "git.revert", "git.continue", "git.abort", "git.deleteBranch",
  "git.tagCreate", "git.tagDelete", "workspace.prepareGithub", "file.write", "attachment.write", "git.reset", "git.restore",
  "git.repoBranchCatalog", "codeReview.create", "codeReview.reply", "codeReview.setResolved", "turns.reset", "turns.undoReset",
  "messages.truncateFrom"] as const;
export const CloudV2ClientOperationSchema = z.enum(CLOUD_V2_CLIENT_OPERATIONS);
export const CloudV2ClientLeaseRequestSchema = z.object({ clientId: z.uuid(), requestId: CloudV2PromptIdSchema, operation: CloudV2ClientOperationSchema }).strict();
export const CloudV2ClientLeaseSchema = z.object({ contextId: z.uuid(), userId: z.uuid(), expiresAt: epochMs, gitIdentity: CloudV2GitIdentitySchema.nullable() }).strict();
export type CloudV2ClientLease = z.infer<typeof CloudV2ClientLeaseSchema>;
export const CloudV2BootstrapLeaseRequestSchema = z.object({ contextId: z.uuid() }).strict();
export const CloudV2BootstrapLeaseSchema = z.object({ contextId: z.uuid(), userId: z.uuid(), expiresAt: epochMs,
  gitIdentity: CloudV2GitIdentitySchema.nullable(), environment: CloudWorkspaceEnvironmentSchema.optional() }).strict();
export type CloudV2BootstrapLease = z.infer<typeof CloudV2BootstrapLeaseSchema>;
export const CloudV2RenewRequestSchema = z.object({ contextIds: z.array(z.uuid()).min(1).max(128) }).strict()
  .refine(value => new Set(value.contextIds).size === value.contextIds.length, "Unique context ids");
export const CloudV2RenewReplySchema = z.object({ leases: z.array(z.union([
  z.object({ contextId: z.uuid(), expiresAt: epochMs }).strict(),
  z.object({ contextId: z.uuid(), refused: CloudV2ContextReasonSchema }).strict(),
])).min(1).max(128) }).strict();
export type CloudV2RenewReply = z.infer<typeof CloudV2RenewReplySchema>;
export const CloudV2RetirementReasonSchema = z.enum(["outcome", "stop", "revoked", "generation_changed", "terminal_closed", "operation_done", "expired", "setup_done"]);
export const CloudV2RetiredRequestSchema = z.object({ retirementId: z.uuid(), reason: CloudV2RetirementReasonSchema,
  processes: z.number().int().min(0).max(2147483647) }).strict();
export const CloudV2RetiredReplySchema = z.object({ retired: z.literal(true) }).strict();
/** §7a: once per boot, before any begin or lease. The boot is the authenticated X-Zeros-Worker-Boot; processes 0 is the clean attestation. */
/** Why a boot's cleanup is unproven or refused: closed classes only, never paths or values. */
export const CLOUD_V2_BOOT_CLEAN_REFUSALS = ["proc_unreadable", "cgroup_unavailable", "cgroup_root", "cgroup_unreadable", "survivors", "contexts_erase_failed",
  "state_dir_linked", "state_dir_foreign", "checkout_linked", "checkout_foreign", "seed_journal_invalid", "seed_journal_incomplete",
  "seed_journal_outdated", "seed_target_modified", "seed_target_not_regular", "git_identity_linked", "git_identity_foreign", "git_identity_not_regular", "git_identity_changed",
  "terminal_dir_linked", "terminal_entry_foreign", "shm_linked", "restore_token_dir_invalid", "io_error"] as const;
export const CloudV2BootCleanRefusalSchema = z.enum(CLOUD_V2_BOOT_CLEAN_REFUSALS);
export type CloudV2BootCleanRefusal = z.infer<typeof CloudV2BootCleanRefusalSchema>;
export const CloudV2BootCleanRequestSchema = z.object({ retirementId: z.uuid(), processes: z.number().int().min(0).max(2147483647),
  /** Slice D (Q-D2): the phase-1 Creator material this boot removed; the control plane activates only on none/removed (missing = refused). */
  legacyMaterial: z.enum(["none", "removed", "refused"]).optional(),
  /** Each class that made the cleanup unproven or refused (diagnostics; present only when non-empty). */
  refusals: z.array(CloudV2BootCleanRefusalSchema).min(1).max(CLOUD_V2_BOOT_CLEAN_REFUSALS.length)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1]! < value), "Each class once, sorted").optional() }).strict()
  // Consistent with the result: a clean boot names no class. Classes stay optional otherwise (an older worker sends none).
  .refine(body => !(body.processes === 0 && (body.legacyMaterial === "none" || body.legacyMaterial === "removed") && body.refusals), "A clean boot names no class");
export const CloudV2BootCleanReplySchema = z.object({ retired: z.number().int().min(0) }).strict();
/** Context refusal codes (409/403/503 bodies {error:{code,message,agent?}}). */
export const CloudV2ContextErrorCodeSchema = z.enum(["actor_changed", "actor_busy", "worker_update_required", "workspace_stopping",
  "agent_login_required", "member_access_revoked", "agent_credentials_unavailable", "execution_not_retired"]);
