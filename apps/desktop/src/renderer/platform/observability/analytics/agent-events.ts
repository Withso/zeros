
import { capture, captureException } from "./posthog";
import type { AgentFailure } from "../../bridge/failure";
import { logEvent } from "../logging/renderer-log";

const sessionMeta = new Map<
  string,
  { startedAt: number; promptCount: number }
>();

const ttftPending = new Map<string, { agentId: string; startedAt: number }>();
/** Correlates an approval response with the currently-running prompt without
 * sending the durable chat/session id to analytics. */
const activePromptIds = new Map<string, string>();
/** The send finally and terminal push can both finish the same prompt after adoption. */
const finishedPromptIds = new Map<string, number>();
const FINISHED_PROMPT_ID_CAP = 200;

/** Do not accept arbitrary underscore-bearing identifiers; only allow the explicit enum values below. */
const SAFE_METADATA_TOKEN = /^[a-z0-9][a-z0-9.:+-]{0,79}$/i;
const SAFE_UNDERSCORE_TOKENS = new Set([
  "allow_once",
  "allow_always",
  "allow_always_project",
  "reject_once",
  "reject_always",
  "selected_unknown",
  "auto_allow_once",
  "auto_allow_always",
  "auto_allow_always_project",
  "auto_reject_once",
  "auto_reject_always",
  "policy_allow_once",
  "policy_allow_always",
  "policy_allow_always_project",
  "policy_reject_once",
  "policy_reject_always",
  "native_dialog",
  "end_turn",
  "max_tokens",
  "tool_use",
  "auth_required",
]);

/** Coarsen off-format adapter strings to custom instead of sending or fingerprinting them. */
function safeMetadataToken(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (SAFE_UNDERSCORE_TOKENS.has(trimmed)) return trimmed;
  if (SAFE_METADATA_TOKEN.test(trimmed)) return trimmed;
  return "custom";
}

function safeCount(
  value: number | undefined,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

export interface AgentPromptStartedArgs {
  promptId: string;
  /** Local correlation only; never emitted. */
  chatId: string;
  agentId: string;
  requestedModel?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  nativeMode?: string | null;
  fastEnabled: boolean;
  contentBlockCount: number;
  imageAttachmentCount: number;
  textAttachmentCount: number;
  mentionFileCount: number;
  mentionFolderCount: number;
  mentionSelectionCount: number;
  additionalDirectoryCount: number;
  isAutoAction: boolean;
  autoActionKind?: string | null;
  protocolVersion?: number;
}

/** Share a metadata-only envelope with PostHog and app.jsonl; do not include chat IDs, prompt contents, paths, or environment values. */
export function trackAgentPromptStarted(args: AgentPromptStartedArgs): void {
  const promptId = safeMetadataToken(args.promptId) ?? "unknown";
  activePromptIds.set(args.chatId, promptId);
  const props = {
    prompt_id: promptId,
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
    requested_model: safeMetadataToken(args.requestedModel),
    effort: safeMetadataToken(args.effort),
    permission_mode: safeMetadataToken(args.permissionMode),
    native_mode: safeMetadataToken(args.nativeMode),
    fast_enabled: args.fastEnabled,
    content_block_count: safeCount(args.contentBlockCount, 10_000),
    image_attachment_count: safeCount(args.imageAttachmentCount, 10_000),
    text_attachment_count: safeCount(args.textAttachmentCount, 10_000),
    mention_file_count: safeCount(args.mentionFileCount, 10_000),
    mention_folder_count: safeCount(args.mentionFolderCount, 10_000),
    mention_selection_count: safeCount(args.mentionSelectionCount, 10_000),
    additional_directory_count: safeCount(
      args.additionalDirectoryCount,
      10_000,
    ),
    is_auto_action: args.isAutoAction,
    auto_action_kind: safeMetadataToken(args.autoActionKind),
    protocol_version: safeCount(args.protocolVersion, 1_000_000),
  };
  capture("agent_prompt_started", props);
  logEvent("agent_prompt_started", props, ["agent", "prompt"]);
}

/** Restore correlation after reload without emitting a second start event. */
export function adoptAgentPromptCorrelation(args: {
  chatId: string;
  promptId: string;
}): void {
  const promptId = safeMetadataToken(args.promptId);
  if (!promptId) return;
  activePromptIds.set(args.chatId, promptId);
}

/** An adopted prompt can finish without the original sendPrompt finally. */
export function peekAgentPromptId(chatId: string): string | undefined {
  return activePromptIds.get(chatId);
}

function markPromptFinishedOnce(promptId: string): boolean {
  if (finishedPromptIds.has(promptId)) return false;
  finishedPromptIds.set(promptId, Date.now());
  while (finishedPromptIds.size > FINISHED_PROMPT_ID_CAP) {
    const oldest = finishedPromptIds.keys().next().value;
    if (oldest === undefined) break;
    finishedPromptIds.delete(oldest);
  }
  return true;
}

export function trackAgentPromptFinished(args: {
  promptId: string;
  /** Local correlation only; never emitted. */
  chatId: string;
  agentId: string;
  outcome: "completed" | "cancelled" | "failed" | "interrupted";
  durationMs: number;
  retryCount: number;
  stopReason?: string | null;
  effectiveModel?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  failure?:
    | (Pick<AgentFailure, "kind" | "stage"> &
        Partial<Pick<AgentFailure, "message">>)
    | null;
}): void {
  const promptId = safeMetadataToken(args.promptId) ?? "unknown";
  if (activePromptIds.get(args.chatId) === promptId) {
    activePromptIds.delete(args.chatId);
  }
  if (!markPromptFinishedOnce(promptId)) return;
  const props = {
    prompt_id: promptId,
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
    outcome: args.outcome,
    duration_ms: safeCount(args.durationMs),
    retry_count: safeCount(args.retryCount, 100),
    stop_reason: safeMetadataToken(args.stopReason),
    effective_model: safeMetadataToken(args.effectiveModel),
    input_tokens: safeCount(args.inputTokens),
    output_tokens: safeCount(args.outputTokens),
    cache_read_tokens: safeCount(args.cacheReadTokens),
    cache_write_tokens: safeCount(args.cacheWriteTokens),
    reasoning_tokens: safeCount(args.reasoningTokens),
    cost_usd:
      args.costUsd != null && Number.isFinite(args.costUsd)
        ? Math.max(0, args.costUsd)
        : undefined,
    failure_kind: safeMetadataToken(args.failure?.kind),
    failure_stage: safeMetadataToken(args.failure?.stage),
    failure_message_hash: failureMessageHash(args.failure?.message),
  };
  capture("agent_prompt_finished", props);
  logEvent("agent_prompt_finished", props, ["agent", "prompt"]);
}

/** Record the approval category and outcome, not native command or file arguments. */
export function trackAgentPermissionDecided(args: {
  chatId: string;
  agentId: string;
  decision: string;
  toolKind?: string | null;
}): void {
  const props = {
    prompt_id: activePromptIds.get(args.chatId),
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
    decision: safeMetadataToken(args.decision) ?? "unknown",
    tool_kind: safeMetadataToken(args.toolKind),
  };
  capture("agent_permission_decided", props);
  logEvent("agent_permission_decided", props, ["agent", "permission"]);
}

/** Never send question copy or answers; only record outcome and counts. */
export function trackAgentQuestionAnswered(args: {
  chatId: string;
  agentId: string;
  outcome: "answered" | "declined" | "dismissed";
  source?: string | null;
  questionCount: number;
  blocking: boolean;
}): void {
  const props = {
    prompt_id: activePromptIds.get(args.chatId),
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
    outcome: args.outcome,
    source: safeMetadataToken(args.source),
    question_count: safeCount(args.questionCount, 100),
    blocking: args.blocking,
  };
  capture("agent_question_answered", props);
  logEvent("agent_question_answered", props, ["agent", "question"]);
}

export function trackAgentSessionStarted(
  agentId: string,
  chatId: string,
): void {
  sessionMeta.set(chatId, { startedAt: Date.now(), promptCount: 0 });
  capture("agent_session_started", { agent_id: agentId });
}

/** Arm immediately before sending the prompt RPC so latency starts with the user's turn. */
export function trackAgentTurnStarted(agentId: string, chatId: string): void {
  ttftPending.set(chatId, { agentId, startedAt: Date.now() });
}

/** Consume the first text, reasoning, or tool signal only for an armed turn; history replay alone must not count. */
export function trackAgentFirstResponse(
  chatId: string,
  firstKind: "message" | "thought" | "tool_call",
): void {
  const pending = ttftPending.get(chatId);
  if (!pending) return;
  ttftPending.delete(chatId);
  capture("agent_first_response", {
    agent_id: pending.agentId,
    latency_ms: Date.now() - pending.startedAt,
    first_kind: firstKind,
  });
}

/** Usage fields are best effort; not every adapter reports them. */
export function trackAgentPromptCompleted(args: {
  agentId: string;
  chatId?: string;
  stopReason?: string;
  durationMs: number;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}): void {
  if (args.chatId) {
    const meta = sessionMeta.get(args.chatId);
    if (meta) meta.promptCount += 1;
  }
  capture("agent_prompt_completed", {
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
    stop_reason: safeMetadataToken(args.stopReason),
    duration_ms: args.durationMs,
    model: safeMetadataToken(args.model),
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cost_usd: args.costUsd,
  });
}

export function trackAgentSessionEnded(args: {
  agentId: string;
  chatId: string;
  outcome: "completed" | "error";
}): void {
  const meta = sessionMeta.get(args.chatId);
  sessionMeta.delete(args.chatId);
  ttftPending.delete(args.chatId);
  const activePromptId = activePromptIds.get(args.chatId);
  activePromptIds.delete(args.chatId);
  if (activePromptId) finishedPromptIds.delete(activePromptId);
  capture("agent_session_ended", {
    agent_id: args.agentId,
    outcome: args.outcome,
    duration_ms: meta ? Date.now() - meta.startedAt : undefined,
    prompt_count: meta?.promptCount,
  });
}

/** Do not include workspace paths, branches, or slugs. */
export function trackWorkspaceOpened(args: {
  isWorktree: boolean;
  status?: string;
}): void {
  capture("workspace_opened", {
    is_worktree: args.isWorktree,
    status: args.status,
  });
}

/** Record only the classified Git error code, never its message, path, or diff. */
export function trackGitOp(args: {
  op:
    | "commit"
    | "push"
    | "pull"
    | "pull_and_push"
    | "fetch"
    | "rebase"
    | "stage"
    | "unstage"
    | "discard"
    | "stash"
    | "merge"
    | "checkout"
    | "branch_create"
    | "branch_rename"
    | "branch_delete"
    | "pr_create"
    | "pr_update"
    | "pr_merge"
    | "pr_mark_ready"
    | "workspace_create"
    | "workspace_archive"
    | "workspace_restore"
    | "workspace_delete";
  outcome: "ok" | "error";
  error?: unknown;
}): void {
  capture("git_op", {
    op: args.op,
    outcome: args.outcome,
    error_kind: args.outcome === "error" ? gitErrorKind(args.error) : undefined,
  });
}

/** IPC serializes GitError to a plain object; classify by its code rather than instanceof. */
function gitErrorKind(error: unknown): string {
  if (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "unknown";
}

// Keep user-correctable and recoverable faults out of the issue tracker, including the kinds handled by isRecoverable() in ../bridge/failure.
const NON_BUG_AGENT_FAILURE_KINDS = new Set<string>([
  "auth-required",
  "session-expired",
  "lifecycle-superseded",
  "timeout",
  "transport-closed",
  "rate-limited",
  "cancelled",
]);

/** Normalize volatile fragments before hashing so repeated failures group without exporting the raw message. */
function failureMessageHash(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const normalized = message
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s'"()]*/gi, "<path>") // abs/rel paths
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the hash stable so existing failure groups remain comparable.
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function trackAgentFailed(args: {
  agentId: string;
  failure: Pick<AgentFailure, "kind" | "stage"> &
    Partial<Pick<AgentFailure, "message">>;
}): void {
  const messageHash = failureMessageHash(args.failure.message);
  capture("agent_failed", {
    agent_id: args.agentId,
    failure_kind: args.failure.kind,
    stage: args.failure.stage,
    message_hash: messageHash,
  });
  if (!NON_BUG_AGENT_FAILURE_KINDS.has(args.failure.kind)) {
    // Put the failure kind in the exception name so error tracking groups matching faults.
    const err = new Error(
      `agent failure: ${args.failure.kind} @ ${args.failure.stage ?? "unknown"}`,
    );
    err.name = `AgentFault: ${args.failure.kind}`;
    captureException(err, {
      origin: "agent",
      area: "agent",
      severity: "major",
      handled: true,
      agent_id: args.agentId,
      failure_kind: args.failure.kind,
      stage: args.failure.stage,
      message_hash: messageHash,
    });
  }
}

/** PostHog pricing expects the model vendor, not the Zeros agent ID. */
function inferProvider(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (
    m.startsWith("gpt") ||
    /^o[1-4]\b/.test(m) ||
    m.startsWith("chatgpt") ||
    m.includes("codex")
  )
    return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("grok")) return "x-ai";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("llama")) return "meta-llama";
  if (m.includes("mistral") || m.includes("mixtral") || m.includes("magistral"))
    return "mistralai";
  if (m.includes("qwen")) return "qwen";
  if (m.includes("kimi")) return "moonshotai";
  return undefined;
}

/** Send only generation metadata; trace IDs group turns without sending prompts or responses. */
export function trackAiGeneration(args: {
  agentId: string;
  provider?: string | null;
  model?: string | null;
  traceId?: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  accountingVersion?: 1;
  costKind?: "estimated" | "reported";
}): void {
  const hasUsage =
    args.inputTokens != null ||
    args.outputTokens != null ||
    args.costUsd != null;
  if (!args.model && !hasUsage) return;
  const model = safeMetadataToken(args.model);
  capture("$ai_generation", {
    $ai_model: model,
    $ai_provider: safeMetadataToken(args.provider) ?? inferProvider(model),
    $ai_trace_id: safeMetadataToken(args.traceId),
    $ai_latency: args.latencyMs / 1000, // PostHog expects seconds
    $ai_input_tokens: args.inputTokens,
    $ai_cache_reporting_exclusive: args.accountingVersion === 1 ? false : undefined,
    $ai_output_tokens: args.outputTokens,
    $ai_cache_read_input_tokens: args.cacheReadTokens,
    $ai_cache_creation_input_tokens: args.cacheWriteTokens,
    $ai_reasoning_tokens: args.reasoningTokens,
    // Omitted when undefined → PostHog auto-computes from provider+model+tokens.
    $ai_total_cost_usd: args.costUsd,
    $ai_cost_passthrough: args.costUsd !== undefined ? true : undefined,
    agent_cost_source: args.costUsd !== undefined ? (args.costKind ?? "reported") : "unavailable",
    agent_id: safeMetadataToken(args.agentId) ?? "unknown",
  });
}

/** Usage snapshots are absolute: use the latest revision per turn, never sum revisions or emit another generation for a continuation. */
const usageRevisions = new Map<string, number>();
export function trackAgentTurnUsage(args: {
  executionId: string;
  turnId: string;
  agentId: string;
  usage: import("@zeros/protocol/agent-events").TurnUsage;
}): void {
  const revision = args.usage.revision;
  if (!Number.isSafeInteger(revision) || (revision ?? 0) < 1) return;
  const key = `${args.executionId}\0${args.turnId}`;
  if ((usageRevisions.get(key) ?? 0) >= revision!) return;
  usageRevisions.set(key, revision!);
  if (usageRevisions.size > 1024) usageRevisions.delete(usageRevisions.keys().next().value!);
  capture("agent_turn_usage_updated", {
    turn_id: safeMetadataToken(args.turnId),
    agent_id: safeMetadataToken(args.agentId),
    usage_revision: revision,
    input_tokens: safeCount(args.usage.inputTokens),
    output_tokens: safeCount(args.usage.outputTokens),
    cache_read_tokens: safeCount(args.usage.cacheReadTokens),
    cache_write_tokens: safeCount(args.usage.cacheWriteTokens),
    cost_usd: args.usage.totalCostUsd,
    cost_source: args.usage.totalCostUsd === undefined ? "unavailable" : args.usage.costKind,
  });
}
