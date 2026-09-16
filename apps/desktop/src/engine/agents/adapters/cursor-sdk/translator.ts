// ──────────────────────────────────────────────────────────
// @cursor/sdk SDKMessage → SessionNotification translator
// ──────────────────────────────────────────────────────────
//
// The SDK streams typed `SDKMessage` objects from `run.stream()`; this maps
// them onto Zeros' canonical SessionUpdate vocabulary the engine owns, so
// the renderer is unchanged.
//
// The SDK's tool shape (`{ call_id, name, status, args, result }`) is
// cleaner than the CLI's (`{ tool_call: { <name>: {...} } }`), so the
// tool-kind / merge-key / todo / subagent helpers port directly. Tool
// NAMES are assumed to match the CLI's `*ToolCall` vocabulary; unknown
// names degrade to a generic "other" card (confirm + extend via the
// spike / dogfood).
//
// Text/thought chunks share an id within one uninterrupted segment. A new
// tool or a change of role starts another segment so final replies retain
// their position after working narration in the shared exact-id reducer.
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import { CursorTextReconciliation } from "./text-reconciliation";

import type {
  ContentBlock,
  SessionNotification,
  StopReason,
} from "../../types";
import { agentIdFromTranscriptPath } from "./subagent-transcript";
import type {
  NormalizedSubagentStep,
  ParsedSubagentTranscript,
} from "./subagent-transcript";
import {
  cursorToolResultContent,
  cursorToolResultValue,
  cursorToolStatus,
  unreportedToolOutput,
} from "./tool-result";
import type { CursorToolStatus } from "./tool-result";

type SubagentToolStep = Extract<NormalizedSubagentStep, { type: "tool" }>;
interface SubagentState {
  toolCallId: string;
  agentId?: string;
  transcriptPath?: string;
  result?: unknown;
  hasTranscript?: boolean;
  /** Source + native ID (ordinal only for old records without IDs). Retained
   * until flush so later results update the original row instead of duplicating it. */
  tools: Map<string, { toolCallId: string; step: SubagentToolStep }>;
  text?: Map<string, { messageId: string; text: string }>;
}

type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "list"
  | "web_search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "subagent"
  | "task"
  | "mcp"
  | "question"
  | "other";

type Emit = (notification: SessionNotification) => void;

/** Minimal structural views of the SDKMessage variants we consume. Kept
 *  local (not imported from @cursor/sdk) so the engine bundle never hard-
 *  depends on the SDK's type exports — the runtime feeds plain objects. */
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
}
interface TextBlock {
  type: "text";
  text: string;
}
interface SdkMsg {
  type: string;
  subtype?: string;
  call_id?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
  text?: string;
  thinking_duration_ms?: number;
  message?: { role?: string; content?: Array<TextBlock | ToolUseBlock> };
}

export interface CursorSdkTranslatorOptions {
  sessionId: string;
  emit: Emit;
  onUnknown?: (event: unknown) => void;
  /** Reads a finished Cursor subagent's on-disk transcript by its agentId
   *  (injected by the adapter, which owns the cwd + fs). Cursor doesn't stream
   *  subagent internals and leaves `conversationSteps` empty in local mode, so
   *  this transcript is the real source of the child's tool calls. Returns
   *  null when the file is absent/unreadable (→ conversationSteps fallback). */
  loadSubagentTranscript?: (
    subagentAgentId: string,
  ) => ParsedSubagentTranscript | null;
  /** Reads a subagent transcript at an EXACT path — used when the task result
   *  hands us `value.transcriptPath` (the SDK's own pointer, more reliable than
   *  reconstructing it from the cwd slug). */
  loadSubagentTranscriptByPath?: (
    path: string,
  ) => ParsedSubagentTranscript | null;
  /** Optional diagnostic sink (adapter → onAgentStderr). One line per subagent
   *  at flush so a path/timing miss is visible without spamming on every poll. */
  onLog?: (message: string) => void;
}

export class CursorSdkTranslator {
  private readonly sessionId: string;
  private readonly emit: Emit;
  private readonly onUnknown?: (event: unknown) => void;

  private readonly turnPrefix = randomUUID();
  private messageSequence = 0;
  private activeText: { role: "text" | "thought"; id: string } | undefined;
  /** SDK call_id (or assistant tool_use block id) → Zeros toolCallId. */
  private readonly toolCallIds = new Map<string, string>();
  /** Ids we've already opened an in_progress card for (so the assistant
   *  block + the tool_call message don't double-emit a start). */
  private readonly opened = new Set<string>();
  private readonly toolRecords = new Map<string, {
    name: string;
    status: CursorToolStatus | "in_progress";
    rawOutput?: unknown;
    snapshot?: string;
  }>();
  /** task call_id → the subagent's agentId (carried on the task tool args),
   *  captured when the task opens so we can locate its transcript on
   *  completion (the completed message may not echo args). */
  private readonly subagentAgentIds = new Map<string, string>();
  /** Per-task state is discarded after the final transcript read. */
  private readonly subagents = new Map<string, SubagentState>();
  private subagentsFlushed = false;
  private readonly loadSubagentTranscript?: (
    subagentAgentId: string,
  ) => ParsedSubagentTranscript | null;
  private readonly loadSubagentTranscriptByPath?: (
    path: string,
  ) => ParsedSubagentTranscript | null;
  private readonly onLog?: (message: string) => void;

  private hasSeenTerminal = false;
  private hasSeenError = false;
  private hasSeenAssistantText = false;
  private readonly text = new CursorTextReconciliation((update) => this.emit({ sessionId: this.sessionId, update }));
  private readonly seenSteps = new WeakSet<object>();
  private readonly unboundToolSteps: Array<{ callId: string; key: string; inputKey: string }> = [];
  private readonly toolStepClaims = new Set<string>();
  private readonly toolStepKeys = new Map<string, string>();
  private readonly toolStepInputs = new Map<string, string>();
  private readonly anonymousToolIds = new Set<string>();
  private readonly deferredToolSteps: Array<{ key: string; message: SdkMsg }> = [];
  private runIdentity: { agentId: string; runId?: string } | undefined;
  private errorMessage: string | null = null;
  private lastStopReason: StopReason = "end_turn";

  constructor(opts: CursorSdkTranslatorOptions) {
    this.sessionId = opts.sessionId;
    this.emit = opts.emit;
    this.onUnknown = opts.onUnknown;
    this.loadSubagentTranscript = opts.loadSubagentTranscript;
    this.loadSubagentTranscriptByPath = opts.loadSubagentTranscriptByPath;
    this.onLog = opts.onLog;
  }

  get sawTerminal(): boolean {
    return this.hasSeenTerminal;
  }
  /** True once an in-band `status:'ERROR'|'EXPIRED'` message has been seen.
   *  The adapter throws a classified failure when this is set (unless the
   *  user cancelled), so a failed turn never reports as a clean end_turn. */
  get sawError(): boolean {
    return this.hasSeenError;
  }
  /** Whether this turn emitted any visible assistant text. Cursor's stream can
   *  occasionally finish without an assistant event even though wait().result
   *  contains the complete final answer; the adapter uses this to apply that
   *  result only as a non-duplicating fallback. */
  get sawAssistantText(): boolean {
    return this.hasSeenAssistantText;
  }
  /** Error detail from the in-band ERROR/EXPIRED status message
   *  (SDKStatusMessage.message), when the CLI provided one — so the adapter
   *  surfaces the real reason instead of a generic "run error", and
   *  classifyCursorSdkError can route auth/rate-limit/expired correctly. */
  get errorDetail(): string | null {
    return this.errorMessage;
  }
  private terminalErrorCode: string | undefined;
  get terminalFailure(): { message?: string; code?: string } | null {
    return this.errorMessage || this.terminalErrorCode
      ? { message: this.errorMessage ?? undefined, code: this.terminalErrorCode }
      : null;
  }
  get stopReason(): StopReason {
    return this.lastStopReason;
  }

  bindRunIdentity(agentId: string, runId: string | undefined): void {
    this.runIdentity = { agentId, runId };
  }

  acceptsMessage(raw: unknown): boolean {
    if (!isObj(raw) || !this.runIdentity) return true;
    return (typeof raw.agent_id !== "string" || raw.agent_id === this.runIdentity.agentId) &&
      (!this.runIdentity.runId || typeof raw.run_id !== "string" || raw.run_id === this.runIdentity.runId);
  }

  feed(raw: unknown): void {
    if (!this.acceptsMessage(raw)) return;
    if (!isObj(raw) || typeof raw.type !== "string") {
      this.onUnknown?.(raw);
      return;
    }
    const msg = raw as unknown as SdkMsg;
    switch (msg.type) {
      case "system":
        // init — nothing to surface (model/tools captured by the adapter).
        break;
      case "user":
        // Echo of our own prompt — Zeros already renders it locally.
        break;
      case "assistant":
        this.onAssistant(msg);
        break;
      case "tool_call":
        this.bindToolStep(msg);
        this.onToolCall(msg);
        break;
      case "thinking":
        this.onThinking(msg);
        break;
      case "status":
        this.onStatus(msg);
        break;
      case "task":
        // Subagent/task progress — no canonical surface yet; ignore so it
        // doesn't render as a raw "unknown" card. (Subagent bodies arrive
        // via tool_call(taskToolCall) results.)
        break;
      case "request":
        // Interactive approval request through the permission round trip.
        break;
      default:
        this.onUnknown?.(raw);
    }
  }

  /** Native incremental lifecycle. Completed steps and stream mirrors are
   * reconciled individually within this run; a callback never disables a
   * whole category of later stream events. */
  feedDelta(raw: unknown): void {
    if (!isObj(raw) || typeof raw.type !== "string") {
      this.onUnknown?.(raw);
      return;
    }
    switch (raw.type) {
      case "text-delta": {
        if (typeof raw.text !== "string" || raw.text.length === 0) return;
        this.hasSeenAssistantText = true;
        this.text.delta(this.messageIdFor("text"), "text", raw.text);
        return;
      }
      case "thinking-delta": {
        if (typeof raw.text !== "string" || raw.text.length === 0) return;
        this.text.delta(this.messageIdFor("thought"), "thought", raw.text);
        return;
      }
      case "thinking-completed": {
        const duration = finiteNonNegative(raw.thinkingDurationMs);
        if (duration === undefined) return;
        this.text.thinkingDuration(duration, "delta");
        return;
      }
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed": {
        if (typeof raw.callId !== "string" || !isObj(raw.toolCall)) return;
        const tool = raw.toolCall;
        if (typeof tool.type !== "string") return;
        const message: SdkMsg = {
          type: "tool_call",
          call_id: raw.callId,
          name: tool.type,
          status:
            raw.type === "tool-call-completed"
              ? isFailureResult(tool.result, tool.type)
                ? "error"
                : "completed"
              : "running",
          args: tool.args,
          result: tool.result,
        };
        this.bindToolStep(message);
        this.onToolCall(message, raw.type === "partial-tool-call");
        if (raw.type === "partial-tool-call") {
          const toolCallId = this.toolCallIds.get(raw.callId);
          if (toolCallId && this.toolRecords.get(raw.callId)?.status === "in_progress") {
            this.emit({
              sessionId: this.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "in_progress",
                rawInput: safeToolInput(tool.type, tool.args, false),
              },
            });
          }
        }
        return;
      }
      // turn-ended is consumed by the adapter for usage; step/summary/shell
      // lifecycle remains informational until Zeros has a common consumer.
      default:
        return;
    }
  }

  /** A completed step reconciles its partial callback/stream record. Tool
   * steps without native ids bind once their corresponding native call arrives. */
  feedStep(raw: unknown): void {
    if (!isObj(raw) || typeof raw.type !== "string") {
      this.onUnknown?.(raw);
      return;
    }
    if (this.seenSteps.has(raw)) return;
    this.seenSteps.add(raw);
    if (raw.type === "assistantMessage" || raw.type === "thinkingMessage") {
      const value = isObj(raw.message) ? raw.message : null;
      if (typeof value?.text !== "string") return;
      const role = raw.type === "assistantMessage" ? "text" : "thought";
      if (role === "text" && value.text) this.hasSeenAssistantText = true;
      this.text.step(this.messageIdFor(role), role, value.text, role === "thought" ? finiteNonNegative(value.thinkingDurationMs) : undefined);
      return;
    }
    if (raw.type === "toolCall" && isObj(raw.message)) {
      const tool = raw.message;
      if (typeof tool.type !== "string") return;
      const status = isFailureResult(tool.result, tool.type) ? "error" : "completed";
      const key = toolMirrorKey(tool.type, tool.args, tool.result, status);
      const inputKey = toolMirrorKey(tool.type, tool.args, undefined, "running");
      const isSubagent = mapToolKind(tool.type) === "task";
      const matches = [...this.toolStepKeys].filter(([id, value]) =>
        !this.anonymousToolIds.has(id) && !this.toolStepClaims.has(id) &&
        (isSubagent
          ? matchesCompletedSubagent(this.subagents.get(id), tool.result)
          : value === key || (this.toolRecords.get(id)?.status === "in_progress" && this.toolStepInputs.get(id) === inputKey)));
      const message: SdkMsg = { type: "tool_call", name: tool.type,
        status: cursorToolStatus(tool.type, tool.result) === "pending" ? "pending" : status,
        args: tool.args, result: tool.result };
      if (isSubagent && matches.length === 0 && [...this.subagents].some(([id, entry]) =>
        this.toolStepClaims.has(id) && matchesCompletedSubagent(entry, tool.result))) return;
      if (matches.length > 1 || (isSubagent && matches.length === 0)) {
        // Parallel identical calls are ambiguous until a native completion
        // arrives. A child callback must also wait when only one matching
        // prompt is visible: another child's native start may arrive later.
        const pending = isSubagent ? this.deferredToolSteps.find((entry) =>
          sameSubagentResult(entry.message.result, tool.result)) : undefined;
        if (pending) {
          pending.key = key;
          pending.message = message;
        } else {
          this.deferredToolSteps.push({ key, message });
        }
        return;
      }
      const callId = matches.length === 1 ? matches[0][0] : `step-${randomUUID()}`;
      this.toolStepClaims.add(callId);
      if (matches.length !== 1) {
        this.anonymousToolIds.add(callId);
        this.unboundToolSteps.push({ callId, key, inputKey });
      }
      this.onToolCall({ ...message, call_id: callId });
    }
  }

  /** Bind one anonymous completed-step row to its later native completion.
   * The match is consumed once; another identical native call remains distinct. */
  private bindToolStep(msg: SdkMsg): void {
    if (!msg.call_id) return;
    const key = toolMirrorKey(msg.name ?? "tool", msg.args, msg.result,
      msg.status === "error" || isFailureResult(msg.result, msg.name) ? "error" : "completed");
    const isSubagent = mapToolKind(msg.name ?? this.toolRecords.get(msg.call_id)?.name ?? "tool") === "task";
    this.toolStepKeys.set(msg.call_id, key);
    if (msg.args !== undefined) this.toolStepInputs.set(msg.call_id, toolMirrorKey(msg.name ?? "tool", msg.args, undefined, "running"));
    const deferred = msg.status === "running" ? -1 : this.deferredToolSteps.findIndex((entry) =>
      isSubagent ? sameSubagentResult(entry.message.result, msg.result) : entry.key === key);
    if (deferred >= 0) {
      this.deferredToolSteps.splice(deferred, 1);
      if (isSubagent) {
        // Replayed callback snapshots can precede the native completion too.
        for (let i = this.deferredToolSteps.length - 1; i >= 0; i--) {
          if (sameSubagentResult(this.deferredToolSteps[i].message.result, msg.result))
            this.deferredToolSteps.splice(i, 1);
        }
      }
      this.toolStepClaims.add(msg.call_id);
    }
    if (this.toolCallIds.has(msg.call_id)) return;
    if (isSubagent && msg.status === "running") return;
    const index = this.unboundToolSteps.findIndex((entry) => msg.status === "running" ? entry.inputKey === this.toolStepInputs.get(msg.call_id!) : entry.key === key);
    if (index < 0) return;
    const previousId = this.unboundToolSteps.splice(index, 1)[0].callId;
    const id = this.toolCallIds.get(previousId);
    const record = this.toolRecords.get(previousId);
    if (!id || !record) return;
    this.toolCallIds.set(msg.call_id, id);
    this.toolRecords.set(msg.call_id, record);
    this.toolRecords.delete(previousId);
    this.toolStepClaims.add(msg.call_id);
    this.opened.add(msg.call_id);
    this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: id, nativeToolCallId: msg.call_id } });
    const child = this.subagents.get(previousId);
    if (child) { this.subagents.set(msg.call_id, child); this.subagents.delete(previousId); }
  }

  recoverFinalAnswer(result: unknown): void {
    if (typeof result !== "string" || !result.trim()) return;
    this.activeText = undefined;
    this.text.final(this.messageIdFor("text"), result);
    this.hasSeenAssistantText = true;
  }

  private onThinking(msg: SdkMsg): void {
    const text = typeof msg.text === "string" ? msg.text : "";
    const duration = finiteNonNegative(msg.thinking_duration_ms);
    if (!text && duration === undefined) return;
    if (!text) {
      if (duration !== undefined) this.text.thinkingDuration(duration, "stream");
      return;
    }
    this.text.stream(this.messageIdFor("thought"), "thought", text, duration);
  }

  private onAssistant(msg: SdkMsg): void {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        this.hasSeenAssistantText = true;
        this.text.stream(this.messageIdFor("text"), "text", block.text);
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        this.bindToolStep({ type: "tool_call", call_id: block.id, name: block.name, args: block.input, status: "running" });
        this.openToolCard(block.id, block.name, block.input);
      }
    }
  }

  private onToolCall(msg: SdkMsg, partialArgs = false): void {
    const callId = typeof msg.call_id === "string" ? msg.call_id : null;
    if (!callId) return;
    const previous = this.toolRecords.get(callId);
    const name = typeof msg.name === "string" ? msg.name : previous?.name ?? "tool";
    const args = msg.args ?? null;
    const result = msg.result;
    const rawInput = safeToolInput(name, args, msg.truncated?.args === true);
    const presentation = safeToolResult(
      name,
      result,
      msg.truncated?.result === true,
    );

    // The subagent's agentId rides on the task tool args — capture it now (the
    // completed message may not echo args) so we can find its transcript later.
    if (
      mapToolKind(name) === "task" &&
      !partialArgs && !msg.truncated?.args &&
      previous?.status !== "completed" && previous?.status !== "failed" &&
      isObj(args) &&
      typeof args.agentId === "string" &&
      args.agentId
    ) {
      this.subagentAgentIds.set(callId, args.agentId);
    }

    if (msg.status === "running") {
      if (previous?.status === "completed" || previous?.status === "failed") return;
      this.openToolCard(callId, name, args);
      // A native child ID permits live checkpoints. Prompt/recency hints do
      // not prove ownership, including within the same parent conversation.
      if (mapToolKind(name) === "task" && !this.subagentsFlushed) {
        const toolCallId = this.toolCallIds.get(callId);
        if (toolCallId && !this.subagents.has(callId)) {
          this.subagents.set(callId, {
            toolCallId,
            agentId: this.subagentAgentIds.get(callId),
            tools: new Map(),
          });
        } else {
          const entry = this.subagents.get(callId);
          const nativeAgentId = this.subagentAgentIds.get(callId);
          if (entry && nativeAgentId) entry.agentId = nativeAgentId;
        }
      }
      return;
    }

    // completed | error
    const status = msg.status === "error"
      ? "failed"
      : cursorToolStatus(name, result, msg.status === "completed");
    if ((previous?.status === "failed" && status !== "failed") ||
        (previous?.status === "completed" && status === "pending")) return;
    const snapshot = createHash("sha256").update(stableMirrorJson({ name, status, rawInput, ...presentation })).digest("hex");
    if (previous?.snapshot === snapshot) return;
    this.toolRecords.set(callId, { name, status, rawOutput: presentation.rawOutput, snapshot });
    this.opened.add(callId);

    // A Cursor `task` (subagent) finished. Its tool calls are streamed live by
    // pollSubagents() from checkpoints, including narration. Reconcile the
    // final report at flushSubagents() after the run ends, when the file is
    // fully flushed — reading at completion can race Cursor's write. Here we
    // just record the result + agentId on the live entry.
    const isSubagent = mapToolKind(name) === "task";

    const existing = this.toolCallIds.get(callId);
    if (existing) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: existing,
          ...(!this.anonymousToolIds.has(callId) ? { nativeToolCallId: callId } : {}),
          status,
          rawInput,
          rawOutput: presentation.rawOutput,
          ...(presentation.content ? { content: presentation.content } : {}),
        },
      });
      if (isSubagent) this.markSubagentDone(existing, callId, result);
      this.subagentAgentIds.delete(callId);
      return;
    }
    // No prior "running" — emit a one-shot completed card.
    this.activeText = undefined;
    this.text.boundary();
    const toolCallId = this.ensureToolCallId(callId);
    const mergeKey = computeMergeKey(name, args);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        ...(!this.anonymousToolIds.has(callId) ? { nativeToolCallId: callId } : {}),
        title: describeTool(name, args),
        kind: mapToolKind(name),
        status,
        rawInput,
        rawOutput: presentation.rawOutput,
        ...(presentation.content ? { content: presentation.content } : {}),
        ...(mergeKey ? { mergeKey } : {}),
      },
    });
    if (isSubagent) this.markSubagentDone(toolCallId, callId, result);
    this.subagentAgentIds.delete(callId);
  }

  /** Record a finished subagent's result, agentId, and transcriptPath on its
   *  live entry (creating one if the task had no running leg), so
   *  flushSubagents() can emit the tail tool calls + narration + report. The
   *  Cursor task success result carries `value.{agentId,transcriptPath,
   *  finalMessage,toolCallCount}` — the most reliable source for all three. */
  private markSubagentDone(
    toolCallId: string,
    callId: string,
    result: unknown,
  ): void {
    if (this.subagentsFlushed) return;
    const value = readTaskResultValue(result);
    const agentId =
      (value && typeof value.agentId === "string" ? value.agentId : undefined) ??
      this.subagentAgentIds.get(callId);
    const transcriptPath =
      value && typeof value.transcriptPath === "string"
        ? value.transcriptPath
        : undefined;
    const entry = this.subagents.get(callId);
    if (entry) {
      entry.result = result;
      // Only native task args/results can establish child ownership. A child
      // without these identities has not emitted any provisional rows.
      if (agentId) entry.agentId = agentId;
      if (transcriptPath) entry.transcriptPath = transcriptPath;
    } else {
      this.subagents.set(callId, {
        toolCallId,
        agentId,
        transcriptPath,
        tools: new Map(),
        result,
      });
    }
  }

  /** Reconcile native child checkpoints while the parent run is live. Prose,
   * thoughts and tools keep source order and identity across repeated polls. */
  pollSubagents(): void {
    if (this.subagentsFlushed) return;
    for (const entry of this.subagents.values()) {
      const parsed = this.resolveSubagentFor(entry, false);
      if (!parsed) continue;
      this.syncSubagentTranscript(entry, parsed);
    }
  }

  /** Finalize every subagent once the run has ended: reconcile the final
   * checkpoint and report without duplicating live text/tools. Clears the map. */
  flushSubagents(): void {
    if (this.subagentsFlushed) return;
    for (const { message } of this.deferredToolSteps.splice(0)) {
      const callId = `step-${randomUUID()}`;
      this.anonymousToolIds.add(callId);
      this.onToolCall({ ...message, call_id: callId });
    }
    for (const entry of this.subagents.values()) {
      const sub = this.resolveSubagentFor(entry);
      if (sub) {
        // Reconcile every result, including calls whose start was already
        // streamed. Source identity prevents cross-transcript ID collisions.
        const toolOrdinal = this.syncSubagentTranscript(entry, sub);
        const finalText = sub.finalText || extractResultText(entry.result);
        if (finalText) this.emitSubagentReport(entry.toolCallId, finalText);
        this.onLog?.(
          `[cursor-sdk] subagent ${entry.agentId ?? "?"}: ${toolOrdinal} tools, ${finalText.length}c report`,
        );
      } else {
        const finalText = extractResultText(entry.result);
        if (finalText) this.emitSubagentReport(entry.toolCallId, finalText);
        this.onLog?.(
          `[cursor-sdk] subagent ${entry.agentId ?? "?"}: no transcript/steps (check cwd-path / timing)`,
        );
      }
      // No result in the final snapshot is not evidence of success. Include
      // the same marker for a missing/unreadable final file after live polls.
      for (const { toolCallId, step } of entry.tools.values()) {
        if (step.status !== "pending") continue;
        this.emit({ sessionId: this.sessionId, update: {
          sessionUpdate: "tool_call_update", toolCallId, status: "pending",
          rawOutput: unreportedToolOutput(step.rawOutput),
        } });
      }
    }
    this.subagents.clear();
    this.subagentsFlushed = true;
    // This is the adapter's final read on completion, cancellation, or EOF.
    // Keep unresolved root tools honest too, including a task whose own result
    // never arrived. Completed IDs remain correlated for duplicate late frames.
    for (const [callId, record] of this.toolRecords) {
      if (record.status !== "pending" && record.status !== "in_progress") continue;
      if (isObj(record.rawOutput) && record.rawOutput._zerosToolCompletion === "unreported") continue;
      const toolCallId = this.toolCallIds.get(callId);
      if (!toolCallId) continue;
      record.status = "pending";
      record.rawOutput = unreportedToolOutput(record.rawOutput);
      this.emit({ sessionId: this.sessionId, update: {
        sessionUpdate: "tool_call_update", toolCallId, status: "pending", rawOutput: record.rawOutput,
      } });
    }
  }

  private syncSubagentTool(
    entry: SubagentState,
    sourceAgentId: string | undefined,
    ordinal: number,
    step: SubagentToolStep,
  ): void {
    const key = JSON.stringify([
      sourceAgentId === undefined ? "conversation" : `transcript:${sourceAgentId}`,
      step.nativeToolCallId ? `id:${step.nativeToolCallId}` : `ordinal:${ordinal}`,
    ]);
    const previous = entry.tools.get(key);
    if (previous) {
      // A partial file read must not regress a terminal result or discard its
      // output. Retried native operations have their own tool IDs.
      if ((step.status === "pending" && previous.step.status !== "pending") ||
          (previous.step.status === "failed" && step.status !== "failed")) return;
      if (stableMirrorJson(previous.step) === stableMirrorJson(step)) return;
      previous.step = step;
      this.emit({ sessionId: this.sessionId, update: {
        sessionUpdate: "tool_call_update", toolCallId: previous.toolCallId,
        title: step.title, kind: step.toolKind as ToolKind,
        status: step.status, rawInput: step.rawInput, rawOutput: step.rawOutput,
        ...(step.content ? { content: step.content } : {}),
      } });
      return;
    }
    const toolCallId = randomUUID();
    entry.tools.set(key, { toolCallId, step });
    this.emit({ sessionId: this.sessionId, update: {
      sessionUpdate: "tool_call", toolCallId, parentToolId: entry.toolCallId,
      nativeToolCallId: step.nativeToolCallId,
      title: step.title, kind: step.toolKind as ToolKind,
      status: step.status, rawInput: step.rawInput, rawOutput: step.rawOutput,
      ...(step.content ? { content: step.content } : {}),
    } });
  }

  private syncSubagentTranscript(
    entry: SubagentState,
    sub: ParsedSubagentTranscript & { sourceAgentId?: string },
  ): number {
    if (sub.sourceAgentId !== undefined) entry.hasTranscript = true;
    const timeline = sub.timeline ?? sub.steps.map((step, index) => ({ identity: `step:${index}`, step }));
    let toolOrdinal = 0;
    for (const { identity, step } of timeline) {
      if (step.type === "tool") {
        this.syncSubagentTool(entry, sub.sourceAgentId, toolOrdinal++, step);
        continue;
      }
      const key = JSON.stringify([sub.sourceAgentId ?? "conversation", identity, step.type]);
      const text = entry.text ??= new Map();
      const previous = text.get(key);
      if (!previous && !step.text) continue;
      if (previous?.text === step.text) continue;
      const messageId = previous?.messageId ?? randomUUID();
      text.set(key, { messageId, text: step.text });
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: step.type === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId,
          parentToolId: entry.toolCallId,
          content: { type: "text", text: step.text },
          ...(previous ? { textMode: "replace" as const } : {}),
        },
      });
    }
    return toolOrdinal;
  }

  /** Resolve a subagent's internals + final report. Prefers the on-disk
   *  transcript (the reliable source — Cursor leaves the result's
   *  conversationSteps empty in local mode): first by the exact `transcriptPath`
   *  the result handed us, or by agentId when no path was supplied. Uncaptured
   *  final transcripts can fall back to the result's conversationSteps. */
  private resolveSubagentFor(entry: {
    agentId?: string;
    transcriptPath?: string;
    result?: unknown;
    hasTranscript?: boolean;
  }, allowResultFallback = true): (ParsedSubagentTranscript & { sourceAgentId?: string }) | null {
    if (this.loadSubagentTranscriptByPath && entry.transcriptPath) {
      const t = this.loadSubagentTranscriptByPath(entry.transcriptPath);
      if (t && (t.steps.length > 0 || t.finalText || t.timeline?.length))
        return {
          ...t,
          sourceAgentId: agentIdFromTranscriptPath(entry.transcriptPath),
        };
    }
    if (!entry.transcriptPath && this.loadSubagentTranscript && entry.agentId) {
      const t = this.loadSubagentTranscript(entry.agentId);
      if (t && (t.steps.length > 0 || t.finalText || t.timeline?.length))
        return { ...t, sourceAgentId: encodeURIComponent(entry.agentId).replace(/%/g, "_") };
    }
    // Result steps are a final fallback, not a second source alongside a
    // late or previously captured file. Retain captured rows if it disappears.
    return allowResultFallback && !entry.hasTranscript ? extractSubagentResult(entry.result) : null;
  }

  /** Emit the subagent's concluding report as the parent card's answer. */
  private emitSubagentReport(toolCallId: string, text: string): void {
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [
          { type: "content", content: { type: "text", text } as ContentBlock },
        ],
      },
    });
  }

  private onStatus(msg: SdkMsg): void {
    switch (msg.status) {
      case "FINISHED":
        this.hasSeenTerminal = true;
        this.lastStopReason = "end_turn";
        break;
      case "CANCELLED":
        this.hasSeenTerminal = true;
        this.lastStopReason = "cancelled";
        break;
      case "ERROR":
      case "EXPIRED": {
        this.hasSeenTerminal = true;
        this.hasSeenError = true;
        const native = msg as unknown as { code?: unknown; error?: { code?: unknown; message?: unknown } };
        const code = native.error?.code ?? native.code;
        this.terminalErrorCode = typeof code === "string" ? code : msg.status === "EXPIRED" ? "session_expired" : undefined;
        // SDKStatusMessage carries a `message` string with the real reason
        // (auth, rate limit, expired session …). SdkMsg.message is typed as
        // the assistant-message object, so read the status string via cast.
        const detail = native.error?.message ?? (msg as unknown as { message?: unknown }).message;
        if (typeof detail === "string" && detail.length > 0) {
          this.errorMessage = detail;
        }
        // stopReason is moot — the adapter throws a classified failure when
        // sawError is set — but keep a sane terminal for any caller that
        // reads it without checking sawError.
        this.lastStopReason = "end_turn";
        break;
      }
      // CREATING / RUNNING — in-flight, no terminal.
    }
  }

  // ── helpers ─────────────────────────────────────────────

  private messageIdFor(role: "text" | "thought"): string {
    if (this.activeText?.role !== role) {
      this.activeText = {
        role,
        id: `${this.turnPrefix}-${role}-${this.messageSequence++}`,
      };
    }
    return this.activeText.id;
  }

  private openToolCard(
    callId: string,
    name: string | undefined,
    input: unknown,
  ): void {
    if (this.opened.has(callId)) return;
    this.opened.add(callId);
    this.activeText = undefined;
    this.text.boundary();
    const toolName = name ?? "tool";
    this.toolRecords.set(callId, { name: toolName, status: "in_progress" });
    const toolCallId = this.ensureToolCallId(callId);
    const mergeKey = computeMergeKey(toolName, input);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        nativeToolCallId: callId,
        title: describeTool(toolName, input),
        kind: mapToolKind(toolName),
        status: "in_progress",
        rawInput: safeToolInput(toolName, input ?? null, false),
        ...(mergeKey ? { mergeKey } : {}),
      },
    });
  }

  private ensureToolCallId(callId: string): string {
    const cached = this.toolCallIds.get(callId);
    if (cached) return cached;
    const id = randomUUID();
    this.toolCallIds.set(callId, id);
    return id;
  }
}

// ── shared helpers (ported from cursor/translator.ts) ─────

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function toolMirrorKey(
  name: string,
  args: unknown,
  result: unknown,
  status: "running" | "completed" | "error",
): string {
  return createHash("sha256").update(`${name.replace(/ToolCall$/i, "").toLowerCase()}\0${status}\0${stableMirrorJson(args)}\0${stableMirrorJson(result)}`).digest("hex");
}

function stableMirrorJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, current: unknown) => {
        if (typeof current !== "object" || current === null) return current;
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
        if (Array.isArray(current)) return current;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(current).sort()) {
          sorted[key] = (current as Record<string, unknown>)[key];
        }
        return sorted;
      }) ?? "undefined"
    );
  } catch {
    return String(value);
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

const MAX_INLINE_CURSOR_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;

function pathBasename(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const clean = value.replace(/[\\/]+$/, "");
  const pieces = clean.split(/[\\/]/);
  return pieces[pieces.length - 1] || undefined;
}

function imageMimeType(fileName: string | undefined): string {
  const extension = fileName?.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
}

function safeInlineBase64(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_INLINE_CURSOR_IMAGE_BASE64_CHARS ||
    value.length % 4 !== 0
  ) {
    return undefined;
  }
  // Validate the alphabet without decoding/copying a multi-megabyte payload.
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? value : undefined;
}

function withTruncation(value: unknown, truncated: boolean): unknown {
  if (!truncated) return value;
  if (isObj(value)) {
    return {
      ...value,
      zerosTransport: { truncated: true },
    };
  }
  return {
    value,
    zerosTransport: { truncated: true },
  };
}

function safeToolInput(
  name: string,
  args: unknown,
  truncated: boolean,
): unknown {
  const lower = name.toLowerCase();
  if (lower === "generateimage" && isObj(args)) {
    return withTruncation(
      {
        ...(typeof args.description === "string"
          ? { description: args.description }
          : {}),
        ...(pathBasename(args.filePath)
          ? { fileName: pathBasename(args.filePath) }
          : {}),
      },
      truncated,
    );
  }
  return withTruncation(args, truncated);
}

function safeToolResult(
  name: string,
  result: unknown,
  truncated: boolean,
): {
  rawOutput: unknown;
  content?: Array<{ type: "content"; content: ContentBlock }>;
} {
  const lower = name.toLowerCase();
  if (lower === "generateimage" && isObj(result)) {
    const value = isObj(result.value) ? result.value : null;
    if (result.status === "success" && value) {
      const fileName = pathBasename(value.filePath);
      const imageData = safeInlineBase64(value.imageData);
      const rawOutput = withTruncation(
        {
          status: "success",
          value: {
            ...(fileName ? { fileName } : {}),
            ...(imageData === undefined && typeof value.imageData === "string"
              ? { imageOmitted: "invalid_or_too_large" }
              : {}),
          },
        },
        truncated,
      );
      return {
        rawOutput,
        ...(imageData
          ? {
              content: [
                {
                  type: "content" as const,
                  content: {
                    type: "image",
                    data: imageData,
                    mimeType: imageMimeType(fileName),
                  } as ContentBlock,
                },
              ],
            }
          : {}),
      };
    }
    return { rawOutput: withTruncation(result, truncated) };
  }
  if (lower === "recordscreen" && isObj(result)) {
    const value = isObj(result.value) ? result.value : null;
    if (result.status === "success" && value) {
      return {
        rawOutput: withTruncation(
          {
            status: "success",
            value: {
              ...(pathBasename(value.path)
                ? { fileName: pathBasename(value.path) }
                : {}),
              ...(typeof value.recordingDurationMs === "number"
                ? { recordingDurationMs: value.recordingDurationMs }
                : {}),
              ...(typeof value.wasPriorRecordingCancelled === "boolean"
                ? {
                    wasPriorRecordingCancelled:
                      value.wasPriorRecordingCancelled,
                  }
                : {}),
            },
          },
          truncated,
        ),
      };
    }
    return { rawOutput: withTruncation(result, truncated) };
  }
  return {
    rawOutput: withTruncation(result, truncated),
    content: cursorToolResultContent(result),
  };
}

function isFailureResult(result: unknown, name = "tool"): boolean {
  return cursorToolStatus(name, result) === "failed";
}

function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  // The Cursor task success result carries the report in `value.finalMessage`
  // (with a short `value.resultSuffix`). Prefer those before older shapes.
  const value = readTaskResultValue(result);
  if (value) {
    const fromValue: unknown[] = [
      value.finalMessage,
      value.resultSuffix,
      value.text,
      value.result,
      value.output,
      value.message,
      value.content,
    ];
    for (const c of fromValue) {
      if (typeof c === "string" && c.trim().length > 0) return c;
    }
  }
  if (!isObj(result)) return "";
  const success = isObj(result.success) ? result.success : null;
  const candidates: unknown[] = [
    success?.text,
    success?.result,
    success?.output,
    success?.message,
    success?.content,
    result.text,
    result.result,
    result.output,
    result.message,
    result.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return "";
}

/** The Cursor task success result's `value` payload, tolerating the two
 *  serialized shapes seen across the SDK/host boundary:
 *    { status:"success", value:{ agentId, finalMessage, transcriptPath, … } }
 *    { result:{ case:"success", value:{ … } } }   (protobuf oneof, un-flattened)
 *  Returns null when there's no recognizable value object. */
function readTaskResultValue(result: unknown): Record<string, unknown> | null {
  if (!isObj(result)) return null;
  if (isObj(result.value)) return result.value;
  if (isObj(result.result) && isObj(result.result.value))
    return result.result.value;
  return null;
}

/** Completed callbacks have no call_id. Only a shared native child identity
 * can join one to a native completion; prompt/argument equality is insufficient. */
function sameSubagentResult(left: unknown, right: unknown): boolean {
  const a = readTaskResultValue(left);
  const b = readTaskResultValue(right);
  if (!a || !b) return false;
  let shared = false;
  for (const field of ["agentId", "transcriptPath"] as const) {
    const av = a[field];
    const bv = b[field];
    if (typeof av !== "string" || !av || typeof bv !== "string" || !bv) continue;
    if (av !== bv) return false;
    shared = true;
  }
  return shared;
}

function matchesCompletedSubagent(entry: SubagentState | undefined, result: unknown): boolean {
  // A later metadata-only result must not erase the native ownership already
  // recorded for this call. Pending calls still cannot claim callbacks.
  return !!entry && entry.result !== undefined && sameSubagentResult({ value: entry }, result);
}

/** Final fallback for runtimes that supply conversationSteps instead of a
 *  readable native file. Use only when no file rows have already been emitted. */
function extractSubagentResult(
  result: unknown,
): { steps: NormalizedSubagentStep[]; finalText: string } | null {
  if (!isObj(result)) return null;
  const value = cursorToolResultValue(result);
  const raw =
    value && Array.isArray(value.conversationSteps)
      ? value.conversationSteps
      : [];
  // The subagent's answer = its trailing assistant message (mirrors a turn's
  // trailing-text-is-the-answer boundary). Held back from the children so it
  // renders once, as the card's result.
  let finalIdx = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    const s = raw[i];
    if (isObj(s) && s.type === "toolCall") break;
    if (isObj(s) && s.type === "assistantMessage") {
      finalIdx = i;
      break;
    }
  }
  const steps: NormalizedSubagentStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i === finalIdx) continue;
    const s = raw[i];
    if (!isObj(s)) continue;
    if (s.type === "assistantMessage") {
      const text = readStepText(s.message);
      if (text) steps.push({ type: "text", text });
    } else if (s.type === "thinkingMessage") {
      const text = readStepText(s.message);
      if (text) steps.push({ type: "thought", text });
    } else if (s.type === "toolCall") {
      const tc = mapConversationToolCall(s.message);
      if (tc && isObj(s.message)) {
        const presentation = safeToolResult(String(s.message.type), s.message.result, false);
        steps.push({
          type: "tool",
          toolKind: tc.kind,
          title: tc.title,
          status: tc.status,
          rawInput: tc.rawInput,
          rawOutput: presentation.rawOutput,
          ...(presentation.content ?? tc.content ? { content: presentation.content ?? tc.content } : {}),
        });
      }
    }
  }
  let finalText =
    finalIdx >= 0
      ? readStepText((raw[finalIdx] as { message?: unknown }).message)
      : "";
  if (!finalText && value && typeof value.resultSuffix === "string") {
    finalText = value.resultSuffix;
  }
  if (steps.length === 0 && !finalText) return null;
  return { steps, finalText };
}

/** Text of an `assistantMessage` / `thinkingMessage` conversation step
 *  (`{ message: { text } }`). */
function readStepText(message: unknown): string {
  if (isObj(message) && typeof message.text === "string") return message.text;
  return "";
}

/** Map one Cursor subagent `toolCall` conversation step (`{ type, args,
 *  result }`, discriminated on the inner tool `type`) onto a Zeros tool card.
 *  Field names follow @cursor/sdk's ConversationStep tool variants. Unknown
 *  tool types degrade to a generic `other` row rather than being dropped. */
function mapConversationToolCall(message: unknown): {
  title: string;
  kind: ToolKind;
  status: "pending" | "completed" | "failed";
  rawInput: unknown;
  content?: Array<{ type: "content"; content: ContentBlock }>;
} | null {
  if (!isObj(message) || typeof message.type !== "string") return null;
  const args = isObj(message.args) ? message.args : {};
  const result = message.result;
  const value = cursorToolResultValue(result);
  const done = cursorToolStatus(message.type, result);
  const body = (
    s: string | undefined,
  ): Array<{ type: "content"; content: ContentBlock }> | undefined =>
    s && s.trim().length > 0
      ? [
          {
            type: "content",
            content: { type: "text", text: s } as ContentBlock,
          },
        ]
      : undefined;

  switch (message.type.replace(/ToolCall$/, "")) {
    case "shell": {
      const command = str(args.command);
      const out = value
        ? [str(value.stdout), str(value.stderr)].filter(Boolean).join("\n")
        : "";
      return {
        title: `Running ${truncate(command || "shell command", 60)}`,
        kind: "execute",
        status: done,
        rawInput: { command },
        content: body(out),
      };
    }
    case "read":
      return {
        title: `Reading ${str(args.path)}`,
        kind: "read",
        status: done,
        rawInput: { path: str(args.path) },
        content: body(value ? str(value.content) : ""),
      };
    case "edit": {
      const path = str(args.path);
      const diff = value ? str(value.diffString) : "";
      return {
        title: `Editing ${path}`,
        kind: "edit",
        status: done,
        rawInput: diff ? { path, diff } : { path },
      };
    }
    case "write": {
      const path = str(args.path);
      return {
        title: `Writing ${path}`,
        kind: "edit",
        status: done,
        rawInput: { path, content: str(args.fileText) },
      };
    }
    case "delete":
      return {
        title: `Deleting ${str(args.path)}`,
        kind: "delete",
        status: done,
        rawInput: { path: str(args.path) },
      };
    case "glob":
      return {
        title: `Searching for ${str(args.globPattern) || "files"}`,
        kind: "search",
        status: done,
        rawInput: { pattern: str(args.globPattern) },
        content: body(
          value && Array.isArray(value.files) ? value.files.join("\n") : "",
        ),
      };
    case "grep":
      return {
        title: `Grep ${truncate(str(args.pattern), 40)}`,
        kind: "search",
        status: done,
        rawInput: {
          pattern: str(args.pattern),
          path: str(args.path),
          glob: str(args.glob),
        },
      };
    case "semSearch":
      return {
        title: `Search ${truncate(str(args.query), 40)}`,
        kind: "search",
        status: done,
        rawInput: { query: str(args.query) },
        content: body(value ? str(value.results) : ""),
      };
    case "ls":
      return {
        title: `List ${str(args.path)}`,
        kind: "list",
        status: done,
        rawInput: { path: str(args.path) },
      };
    case "mcp": {
      const tool = str(args.toolName) || str(args.providerIdentifier) || "tool";
      return {
        title: `MCP ${tool}`,
        kind: "mcp",
        status: done,
        rawInput: args,
      };
    }
    case "task": {
      // A nested subagent (subagent spawning a subagent). Render as a leaf
      // Agent row — we don't recurse into its own conversationSteps.
      return {
        title: `Subagent ${truncate(str(args.description) || str(args.prompt), 40)}`,
        kind: "subagent",
        status: done,
        rawInput: args,
      };
    }
    default:
      // readLints / generateImage / recordScreen / createPlan / updateTodos /
      // any future tool — surface a generic row rather than dropping it.
      return {
        title: humanizeToolType(message.type),
        kind: "other",
        status: done,
        rawInput: args,
      };
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "readLints" → "Read lints", "generateImage" → "Generate image". */
function humanizeToolType(type: string): string {
  const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Tool-kind mapping. Accepts both the Cursor `*ToolCall` vocabulary and
 *  plain names (`read`/`edit`/`write`/`shell`/`bash`/`grep`/`glob`) so we
 *  degrade gracefully if the SDK names tools differently than the CLI. */
function mapToolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/read/.test(n)) return "read";
  if (/(edit|write)/.test(n)) return "edit";
  if (/(shell|bash|exec|terminal|run)/.test(n)) return "execute";
  if (/(grep|glob|search|find)/.test(n)) return "search";
  if (/(web.?search)/.test(n)) return "web_search";
  if (/fetch/.test(n)) return "fetch";
  // Cursor's subagent spawn → the RAW task card (kind "task"), NOT the
  // Claude-style SubagentCard (kind "subagent").
  if (/^task/.test(n)) return "task";
  if (/mcp/.test(n)) return "mcp";
  return "other";
}

function describeTool(name: string, args: unknown): string {
  const a = isObj(args) ? args : {};
  const n = name.toLowerCase();
  if (n === "generateimage") return "Generating image";
  if (n === "createplan") return "Creating plan";
  if (n === "updatetodos") return "Updating todos";
  if (n === "recordscreen") {
    switch (a.mode) {
      case "START_RECORDING":
        return "Starting screen recording";
      case "DISCARD_RECORDING":
        return "Discarding screen recording";
      default:
        return "Saving screen recording";
    }
  }
  if (/read/.test(n)) return `Reading ${a.path ?? "file"}`;
  if (/(edit|write)/.test(n)) return `Editing ${a.path ?? "file"}`;
  if (/(shell|bash|exec|run|terminal)/.test(n))
    return `Running ${typeof a.command === "string" ? truncate(a.command, 60) : "shell command"}`;
  if (/grep/.test(n))
    return `Grep ${truncate(String(a.pattern ?? a.query ?? ""), 40)}`;
  if (/glob/.test(n)) return `Searching for ${a.pattern ?? "files"}`;
  if (/^todo/i.test(name)) return "Updating todos";
  if (/^task/.test(n))
    return `Subagent ${truncate(String(a.description ?? a.prompt ?? ""), 40)}`;
  return name;
}

function computeMergeKey(name: string, args: unknown): string | null {
  if (!/(edit|write)/i.test(name)) return null;
  const path = isObj(args) && typeof args.path === "string" ? args.path : null;
  return path ? `edit:${path}` : null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
