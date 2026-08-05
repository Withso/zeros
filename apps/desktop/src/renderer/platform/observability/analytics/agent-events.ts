// ──────────────────────────────────────────────────────────
// Agent analytics events
// ──────────────────────────────────────────────────────────
//
// Thin, typed wrappers around capture() for the agent-reliability
// funnel. Emitted from the renderer's sessions layer, which already
// receives everything over the bridge (failure kind + stage are
// preserved on the wire). Metadata only — agent id, failure kind,
// stage, stop reason, model NAME, token counts, cost. Never prompts,
// completions, file paths, or error text.
//
// These power the per-agent reliability dashboard: success vs failure
// by kind × stage, turn latency, and (where the agent reports it)
// token/cost trends.
// ──────────────────────────────────────────────────────────

import { capture, captureException } from "./posthog";
import type { AgentFailure } from "../../bridge/failure";

// Per-session bookkeeping so agent_session_ended can report duration and
// turn count without persisting timestamps on the store slot. Keyed by
// chatId; created on start, bumped per completed turn, read + cleared on
// end. Bounded by the chat-tab cap, so it can't grow unbounded.
const sessionMeta = new Map<
  string,
  { startedAt: number; promptCount: number }
>();

// Per-chat TTFT bookkeeping. A turn ARMS this when its prompt is sent; the
// first streamed chunk DISARMS it (emitting agent_first_response with the
// elapsed time), so exactly one event fires per turn. A turn that never
// streams is overwritten by the next turn's arm or cleared on session end —
// bounded by the chat-tab cap, so it can't grow unbounded.
const ttftPending = new Map<string, { agentId: string; startedAt: number }>();

/** A new agent session was successfully created. */
export function trackAgentSessionStarted(
  agentId: string,
  chatId: string,
): void {
  sessionMeta.set(chatId, { startedAt: Date.now(), promptCount: 0 });
  capture("agent_session_started", { agent_id: agentId });
}

/** A prompt turn was just dispatched — ARM time-to-first-token tracking so the
 *  turn's first streamed chunk emits agent_first_response. Call at the moment
 *  the prompt RPC goes out (the user-perceived turn start). Overwrites any
 *  prior arm for this chat (e.g. an earlier turn that never streamed). */
export function trackAgentTurnStarted(agentId: string, chatId: string): void {
  ttftPending.set(chatId, { agentId, startedAt: Date.now() });
}

/** The first streamed output of the current turn arrived (assistant text,
 *  reasoning, or a tool call — whichever lands first). Emits agent_first_response
 *  with the time-to-first-token, then DISARMS so only one fires per turn.
 *  No-op when TTFT isn't armed for this chat (a later chunk in the same turn,
 *  or a session-load replay with no in-flight turn). `firstKind` is metadata
 *  describing which signal arrived first — never content. */
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

/** A prompt turn completed successfully. Usage fields are best-effort:
 *  Claude reports tokens + cost, Codex reports tokens only, others may
 *  report neither (their engine translators don't surface usage yet). */
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
    agent_id: args.agentId,
    stop_reason: args.stopReason,
    duration_ms: args.durationMs,
    model: args.model ?? undefined,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cost_usd: args.costUsd,
  });
}

/** An agent session ended — chat closed, reset, or the agent process was
 *  disposed. Reports session-level duration + turn count (the back half of
 *  the activation funnel). `outcome` is "error" when the session ended on a
 *  failure, else "completed". Metadata only. */
export function trackAgentSessionEnded(args: {
  agentId: string;
  chatId: string;
  outcome: "completed" | "error";
}): void {
  const meta = sessionMeta.get(args.chatId);
  sessionMeta.delete(args.chatId);
  ttftPending.delete(args.chatId);
  capture("agent_session_ended", {
    agent_id: args.agentId,
    outcome: args.outcome,
    duration_ms: meta ? Date.now() - meta.startedAt : undefined,
    prompt_count: meta?.promptCount,
  });
}

/** A workspace became active — opened from the sidebar or freshly created.
 *  Metadata only: whether it's a real git worktree (vs the synthetic
 *  "Local main" row) and the workspace status enum. NEVER path/branch/slug. */
export function trackWorkspaceOpened(args: {
  isWorktree: boolean;
  status?: string;
}): void {
  capture("workspace_opened", {
    is_worktree: args.isWorktree,
    status: args.status,
  });
}

/** A git / GitHub operation was invoked from the UI. Metadata only: the
 *  operation type, whether it succeeded, and — on failure — a classified
 *  `error_kind` (the engine's structured GitError `code`, a fixed enum that
 *  carries no message/branch/diff/path). NEVER raw error text. */
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
  /** The caught error (failure path only) — classified to a safe enum, never
   *  sent raw. */
  error?: unknown;
}): void {
  capture("git_op", {
    op: args.op,
    outcome: args.outcome,
    error_kind: args.outcome === "error" ? gitErrorKind(args.error) : undefined,
  });
}

/** Classify a caught git error into a safe enum for analytics. Reuses the
 *  engine's structured GitError `code` (serialized across the bridge via
 *  GitError.toJSON → a plain object with `code`). Returns "unknown" for any
 *  non-GitError. The code is a fixed enum, so it carries no paths/content. */
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

// Agent failure KINDS that are NOT codebase bugs — environmental, user-
// correctable, or self-healing. Tracked as `agent_failed` (observability — the
// reliability funnel) but NOT raised as exceptions, so they never open an
// issue. Everything else (protocol-error, spawn failures, unknown kinds) is a
// fix-worthy fault that SHOULD reach the tracker. Keep in step with isRecoverable()
// + auth handling in ../bridge/failure.ts.
const NON_BUG_AGENT_FAILURE_KINDS = new Set<string>([
  "auth-required",
  "session-expired",
  "timeout",
  "transport-closed",
  "rate-limited",
  "cancelled",
]);

/** Reduce a failure's technical message to a short, stable, non-PII hash.
 *  The UI shows simplified copy ("Cursor Agent: Agent error") and the raw
 *  detail lives only in engine/console logs — this hash keeps field failures
 *  DISTINGUISHABLE in PostHog (two different faults behind the same
 *  kind:stage get different hashes; recurrences of one fault group together)
 *  without ever shipping the message text (which can carry paths).
 *  Volatile fragments (paths, ids, pids, ports, durations) are normalized
 *  away first so the same fault hashes identically across occurrences. */
function failureMessageHash(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const normalized = message
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s'"()]*/gi, "<path>") // abs/rel paths
    .replace(/[0-9a-f]{8,}/gi, "<id>") // uuids / long hex ids
    .replace(/\d+/g, "#") // pids, ports, counts, ms
    .replace(/\s+/g, " ")
    .trim();
  // FNV-1a 32-bit — cheap, deterministic, no crypto import needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** An agent operation failed. `stage` (newSession / loadSession / prompt / …)
 *  is the "where" and `kind` is the "why" — together they are the locks.
 *  `message` (when present) is hashed — never sent raw — so simplified UI
 *  copy doesn't reduce diagnosability in the field.
 *
 *  Two lanes — this is the "capture all agent errors, but only real bugs become
 *  tracked issues" optimization:
 *   • EVERY failure → `agent_failed` event (cheap, observability/funnel).
 *   • Only a fix-worthy fault (kind not in NON_BUG_AGENT_FAILURE_KINDS) → ALSO
 *     an exception → error tracking → the issue-tracker bridge. */
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
    // Built from enums + the message HASH only — no user content, so no
    // scrubbing needed. `name` carries the kind so error tracking groups into
    // one issue per fault kind → one tracked issue per kind, not per occurrence.
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

/** Map a model name to an OpenRouter-style provider slug so PostHog can
 *  look up pricing and AUTO-COMPUTE cost from tokens. PostHog matches on
 *  `$ai_provider` + `$ai_model`, so the provider must be the real LLM
 *  vendor ("openai" / "anthropic" / …) — NOT the Zeros agent id.
 *  Returns undefined for unknown models (PostHog then can't price it). */
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

/** Emit PostHog's native `$ai_generation` event so the built-in LLM
 *  Analytics dashboards (cost / tokens / latency by model & provider)
 *  populate. We send the real `$ai_provider` (inferred from the model)
 *  so PostHog auto-computes cost from its pricing DB for agents that
 *  don't report cost (Codex/Cursor); when we DO have a reported
 *  cost (Claude) we pass it and PostHog uses it directly.
 *  `agent_id` is a separate property for per-agent breakdowns;
 *  `$ai_trace_id` groups a session's turns. Skipped when there's
 *  nothing to chart. Metadata only — no prompt/response content. */
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
}): void {
  const hasUsage =
    args.inputTokens != null ||
    args.outputTokens != null ||
    args.costUsd != null;
  if (!args.model && !hasUsage) return;
  capture("$ai_generation", {
    $ai_model: args.model ?? undefined,
    $ai_provider: args.provider ?? inferProvider(args.model),
    $ai_trace_id: args.traceId ?? undefined,
    $ai_latency: args.latencyMs / 1000, // PostHog expects seconds
    $ai_input_tokens: args.inputTokens,
    $ai_output_tokens: args.outputTokens,
    $ai_cache_read_input_tokens: args.cacheReadTokens,
    $ai_cache_creation_input_tokens: args.cacheWriteTokens,
    $ai_reasoning_tokens: args.reasoningTokens,
    // Omitted when undefined → PostHog auto-computes from provider+model+tokens.
    $ai_total_cost_usd: args.costUsd,
    agent_id: args.agentId,
  });
}
