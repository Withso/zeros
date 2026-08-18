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
// Streaming granularity is unknown from types alone (deltas vs whole
// messages), so text/thought chunks coalesce by a synthesized per-turn
// messageId — correct for both cases.
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

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
  text?: string;
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
  /** Locates a RUNNING subagent's transcript by matching the prompt we sent
   *  against the on-disk transcripts' opening user message, excluding agentIds
   *  already `claimed` by other live tasks. This is how live streaming works at
   *  all: Cursor only reveals the subagent agentId in the task RESULT (at
   *  completion), so during the run the prompt is the only key. Returns the
   *  matched agentId or null. */
  discoverSubagentAgentId?: (
    promptText: string,
    claimed: ReadonlySet<string>,
    sinceMs?: number,
  ) => string | null;
  /** Optional diagnostic sink (adapter → onAgentStderr). One line per subagent
   *  at flush so a path/timing miss is visible without spamming on every poll. */
  onLog?: (message: string) => void;
}

export class CursorSdkTranslator {
  private readonly sessionId: string;
  private readonly emit: Emit;
  private readonly onUnknown?: (event: unknown) => void;

  private readonly turnPrefix = randomUUID();
  /** SDK call_id (or assistant tool_use block id) → Zeros toolCallId. */
  private readonly toolCallIds = new Map<string, string>();
  /** Ids we've already opened an in_progress card for (so the assistant
   *  block + the tool_call message don't double-emit a start). */
  private readonly opened = new Set<string>();
  /** task call_id → the subagent's agentId (carried on the task tool args),
   *  captured when the task opens so we can locate its transcript on
   *  completion (the completed message may not echo args). */
  private readonly subagentAgentIds = new Map<string, string>();
  /** Live subagents, keyed by task call_id. `toolsEmitted` is how many of the
   *  child's tool calls we've already streamed (so each poll emits only the
   *  NEW ones); narration + report are emitted once, at flush. Stays until
   *  flushSubagents() clears it. */
  private readonly subagents = new Map<
    string,
    {
      toolCallId: string;
      agentId?: string;
      /** Prompt we sent the subagent — the key for locating its on-disk
       *  transcript while the run is LIVE (the agentId isn't known until the
       *  task result lands at completion). */
      promptText?: string;
      /** Exact transcript path from the task result (`value.transcriptPath`),
       *  preferred over slug-based resolution at flush. */
      transcriptPath?: string;
      /** When the task's running leg arrived (Date.now()). Scopes live
       *  discovery to transcripts written since the task started, so we never
       *  claim a prior turn's still-recent subagent file. */
      startedMs?: number;
      toolsEmitted: number;
      /** The agentId whose transcript `toolsEmitted` was counted against (the
       *  source the live poll streamed from). If flush later resolves a
       *  DIFFERENT source — the authoritative `transcriptPath` correcting a
       *  wrong live guess for a concurrent subagent — the count no longer
       *  applies and the skip resets to 0 so no leading tools are dropped. */
      streamedAgentId?: string;
      result?: unknown;
    }
  >();
  private readonly loadSubagentTranscript?: (
    subagentAgentId: string,
  ) => ParsedSubagentTranscript | null;
  private readonly loadSubagentTranscriptByPath?: (
    path: string,
  ) => ParsedSubagentTranscript | null;
  private readonly discoverSubagentAgentId?: (
    promptText: string,
    claimed: ReadonlySet<string>,
    sinceMs?: number,
  ) => string | null;
  private readonly onLog?: (message: string) => void;

  private hasSeenTerminal = false;
  private hasSeenError = false;
  private hasSeenAssistantText = false;
  private errorMessage: string | null = null;
  private lastStopReason: StopReason = "end_turn";

  constructor(opts: CursorSdkTranslatorOptions) {
    this.sessionId = opts.sessionId;
    this.emit = opts.emit;
    this.onUnknown = opts.onUnknown;
    this.loadSubagentTranscript = opts.loadSubagentTranscript;
    this.loadSubagentTranscriptByPath = opts.loadSubagentTranscriptByPath;
    this.discoverSubagentAgentId = opts.discoverSubagentAgentId;
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
  get stopReason(): StopReason {
    return this.lastStopReason;
  }

  feed(raw: unknown): void {
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

  private onThinking(msg: SdkMsg): void {
    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text) return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text } as ContentBlock,
        messageId: `${this.turnPrefix}-thought`,
      },
    });
  }

  private onAssistant(msg: SdkMsg): void {
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        this.hasSeenAssistantText = true;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text } as ContentBlock,
            messageId: `${this.turnPrefix}-text`,
          },
        });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        // Initial announcement — open an in_progress card if the
        // dedicated tool_call message hasn't already.
        this.openToolCard(block.id, block.name, block.input);
      }
    }
  }

  private onToolCall(msg: SdkMsg): void {
    const callId = typeof msg.call_id === "string" ? msg.call_id : null;
    const name = typeof msg.name === "string" ? msg.name : "tool";
    if (!callId) return;
    const args = msg.args ?? null;
    const result = msg.result;

    // The subagent's agentId rides on the task tool args — capture it now (the
    // completed message may not echo args) so we can find its transcript later.
    if (
      mapToolKind(name) === "task" &&
      isObj(args) &&
      typeof args.agentId === "string" &&
      args.agentId
    ) {
      this.subagentAgentIds.set(callId, args.agentId);
    }

    if (msg.status === "running") {
      this.openToolCard(callId, name, args);
      // Register a live subagent so pollSubagents() can stream its tool calls
      // from the on-disk transcript AS THEY HAPPEN during the run. The agentId
      // is almost never on the running-leg args (Cursor assigns it internally
      // and only echoes it in the task RESULT at completion), so we stash the
      // PROMPT — pollSubagents() matches it to the on-disk transcript to learn
      // the agentId while the run is still live.
      if (mapToolKind(name) === "task") {
        const toolCallId = this.toolCallIds.get(callId);
        if (toolCallId && !this.subagents.has(callId)) {
          this.subagents.set(callId, {
            toolCallId,
            agentId: this.subagentAgentIds.get(callId),
            promptText: readTaskPrompt(args),
            startedMs: Date.now(),
            toolsEmitted: 0,
          });
        } else {
          // Cursor may stream tool args incrementally (partial-tool-call), so a
          // later running message can carry the prompt the first one lacked —
          // backfill it so prompt-based discovery still fires.
          const entry = this.subagents.get(callId);
          if (entry && !entry.promptText)
            entry.promptText = readTaskPrompt(args);
        }
      }
      return;
    }

    // completed | error
    const failed = msg.status === "error" || isFailureResult(result);

    // A Cursor `task` (subagent) finished. Its tool calls are streamed live by
    // pollSubagents() (from the transcript) and the narration + report are
    // emitted at flushSubagents() (after the run ends, when the file is fully
    // flushed — reading the report at completion races Cursor's write). Here we
    // just record the result + agentId on the live entry. (Codex has no
    // subagent tool — see the per-adapter audit.)
    const isSubagent = mapToolKind(name) === "task";

    const existing = this.toolCallIds.get(callId);
    if (existing) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: existing,
          status: failed ? "failed" : "completed",
          rawOutput: result,
        },
      });
      if (isSubagent) this.markSubagentDone(existing, callId, result);
      this.toolCallIds.delete(callId);
      this.opened.delete(callId);
      this.subagentAgentIds.delete(callId);
      return;
    }
    // No prior "running" — emit a one-shot completed card.
    const toolCallId = this.ensureToolCallId(callId);
    const mergeKey = computeMergeKey(name, args);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: describeTool(name, args),
        kind: mapToolKind(name),
        status: failed ? "failed" : "completed",
        rawInput: args,
        rawOutput: result,
        ...(mergeKey ? { mergeKey } : {}),
      },
    });
    if (isSubagent) this.markSubagentDone(toolCallId, callId, result);
    this.toolCallIds.delete(callId);
    this.opened.delete(callId);
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
    const value = readTaskResultValue(result);
    const agentId =
      this.subagentAgentIds.get(callId) ??
      (value && typeof value.agentId === "string" ? value.agentId : undefined);
    const transcriptPath =
      value && typeof value.transcriptPath === "string"
        ? value.transcriptPath
        : undefined;
    const entry = this.subagents.get(callId);
    if (entry) {
      entry.result = result;
      // The completion's agentId/transcriptPath are AUTHORITATIVE — prefer them
      // over any live guess. Recency-based discovery (a promptless subagent)
      // can resolve entry.agentId to the wrong transcript; the task result
      // names the real one, so overwrite rather than keep the guess.
      if (agentId) entry.agentId = agentId;
      if (transcriptPath) entry.transcriptPath = transcriptPath;
    } else {
      this.subagents.set(callId, {
        toolCallId,
        agentId,
        transcriptPath,
        toolsEmitted: 0,
        result,
      });
    }
  }

  /** Stream NEW subagent tool calls from the on-disk transcript — called on a
   *  timer by the adapter while the run is live, so the child's reads/greps/etc.
   *  appear AS THEY HAPPEN. Only tool calls are streamed live (the transcript
   *  grows tool-by-tool); narration + the report are held for flushSubagents()
   *  (they only stabilize at the end). `toolsEmitted` dedupes across polls. */
  pollSubagents(): void {
    // Discovery pass — learn the agentId of any still-running subagent by
    // matching the prompt we sent against the on-disk transcripts. Without
    // this, an entry with no agentId (the normal case — Cursor only reveals it
    // at completion) is invisible to the stream pass below and NOTHING shows
    // until flush. This is the fix for "the subagent's tools only appear after
    // it's done".
    if (this.discoverSubagentAgentId) {
      const claimed = new Set<string>();
      for (const e of this.subagents.values())
        if (e.agentId) claimed.add(e.agentId);
      for (const entry of this.subagents.values()) {
        // Discover even when promptText is empty: Cursor frequently omits the
        // prompt on the streamed running-leg `task` args (args stream via
        // partial-tool-call), so requiring it would skip discovery and stream
        // nothing live. findSubagentByPrompt falls back to the most-recently-
        // active transcript written since the task started.
        if (entry.agentId) continue;
        const found = this.discoverSubagentAgentId(
          entry.promptText ?? "",
          claimed,
          entry.startedMs,
        );
        if (found) {
          entry.agentId = found;
          claimed.add(found);
          this.onLog?.(
            `[cursor-sdk] live discover → subagent ${found} (prompt=${entry.promptText ? "matched" : "by-recency"})`,
          );
        }
      }
    }
    if (!this.loadSubagentTranscript) return;
    for (const entry of this.subagents.values()) {
      if (!entry.agentId) continue;
      // If the source changed since we last streamed (a corrected agentId), the
      // prior count was for a different file — restart from 0 for the new one.
      if (
        entry.streamedAgentId !== undefined &&
        entry.streamedAgentId !== entry.agentId
      ) {
        entry.toolsEmitted = 0;
      }
      const parsed = this.loadSubagentTranscript(entry.agentId);
      if (!parsed) continue;
      entry.streamedAgentId = entry.agentId;
      const tools = parsed.steps.filter((s) => s.type === "tool");
      if (tools.length > entry.toolsEmitted) {
        for (let i = entry.toolsEmitted; i < tools.length; i++)
          this.emitStep(entry.toolCallId, tools[i]);
        // Diagnostic: a mid-run growth here means Cursor IS writing the
        // transcript incrementally (live works). If this never fires during a
        // run and only flush reports the tools, Cursor wrote the file at
        // completion (live is impossible — an SDK limit).
        this.onLog?.(
          `[cursor-sdk] live poll: subagent ${entry.agentId} → ${tools.length} tools so far`,
        );
        entry.toolsEmitted = tools.length;
      }
    }
  }

  /** Finalize every subagent once the run has ended (transcript fully flushed):
   *  emit any tool calls not yet streamed live, the in-between narration, and
   *  the report as the card's answer. Clears the live map. */
  flushSubagents(): void {
    for (const entry of this.subagents.values()) {
      const sub = this.resolveSubagentFor(entry);
      if (sub) {
        // `toolsEmitted` counts tools already streamed live from
        // `streamedAgentId`. It's a valid skip ONLY if flush resolved the SAME
        // source; if the authoritative transcriptPath pointed at a different
        // file (a wrong live guess for a concurrent subagent), re-emit from 0
        // so the correct transcript's leading tools aren't dropped.
        const sameSource =
          entry.streamedAgentId === undefined ||
          sub.sourceAgentId === undefined ||
          sub.sourceAgentId === entry.streamedAgentId;
        const skip = sameSource ? entry.toolsEmitted : 0;
        // Walk steps IN ORDER, skipping the leading tool calls already streamed
        // live (by tool-ordinal) so narration + late tools land in place.
        let toolOrdinal = 0;
        for (const s of sub.steps) {
          if (s.type === "tool") {
            if (toolOrdinal >= skip) this.emitStep(entry.toolCallId, s);
            toolOrdinal++;
          } else {
            this.emitStep(entry.toolCallId, s);
          }
        }
        entry.toolsEmitted = toolOrdinal;
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
    }
    this.subagents.clear();
  }

  /** Resolve a subagent's internals + final report. Prefers the on-disk
   *  transcript (the reliable source — Cursor leaves the result's
   *  conversationSteps empty in local mode): first by the exact `transcriptPath`
   *  the result handed us, then by agentId, finally falling back to the
   *  result's conversationSteps. Returns null when nothing yields. */
  private resolveSubagentFor(entry: {
    agentId?: string;
    transcriptPath?: string;
    result?: unknown;
  }): {
    steps: NormalizedSubagentStep[];
    finalText: string;
    sourceAgentId?: string;
  } | null {
    if (this.loadSubagentTranscriptByPath && entry.transcriptPath) {
      const t = this.loadSubagentTranscriptByPath(entry.transcriptPath);
      if (t && (t.steps.length > 0 || t.finalText))
        return {
          ...t,
          sourceAgentId: agentIdFromTranscriptPath(entry.transcriptPath),
        };
    }
    if (this.loadSubagentTranscript && entry.agentId) {
      const t = this.loadSubagentTranscript(entry.agentId);
      if (t && (t.steps.length > 0 || t.finalText))
        return { ...t, sourceAgentId: entry.agentId };
    }
    return extractSubagentResult(entry.result);
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

  /** Emit one normalized subagent step (tool call / thinking / narration) as a
   *  parentToolId-tagged child, nested inside the parent task's SubagentCard. */
  private emitStep(parentToolId: string, step: NormalizedSubagentStep): void {
    if (step.type === "text") {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: step.text } as ContentBlock,
          messageId: randomUUID(),
          parentToolId,
        },
      });
    } else if (step.type === "thought") {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: step.text } as ContentBlock,
          messageId: randomUUID(),
          parentToolId,
        },
      });
    } else {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: randomUUID(),
          parentToolId,
          title: step.title,
          kind: step.toolKind as ToolKind,
          status: step.status,
          rawInput: step.rawInput,
          ...(step.content ? { content: step.content } : {}),
        },
      });
    }
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
        // SDKStatusMessage carries a `message` string with the real reason
        // (auth, rate limit, expired session …). SdkMsg.message is typed as
        // the assistant-message object, so read the status string via cast.
        const detail = (msg as unknown as { message?: unknown }).message;
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

  private openToolCard(
    callId: string,
    name: string | undefined,
    input: unknown,
  ): void {
    if (this.opened.has(callId)) return;
    this.opened.add(callId);
    const toolName = name ?? "tool";
    const toolCallId = this.ensureToolCallId(callId);
    const mergeKey = computeMergeKey(toolName, input);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: describeTool(toolName, input),
        kind: mapToolKind(toolName),
        status: "in_progress",
        rawInput: input ?? null,
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

function isFailureResult(result: unknown): boolean {
  if (!isObj(result)) return false;
  return "error" in result;
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

/** The prompt sent to a subagent (`task` args `prompt`/`task`) — the key for
 *  locating its on-disk transcript while the run is live. */
function readTaskPrompt(args: unknown): string | undefined {
  if (!isObj(args)) return undefined;
  const p = args.prompt ?? args.task;
  return typeof p === "string" && p.trim().length > 0 ? p : undefined;
}

/** Fallback parse of a Cursor subagent (`task`) completion's
 *  `value.conversationSteps` into the SAME normalized step shape the transcript
 *  reader produces. Empty in local mode (the transcript is the real source),
 *  but kept for cloud/background runs that do populate it. The success result
 *  is `{ status:"success", value:{ conversationSteps?, resultSuffix?, … } }`
 *  (see @cursor/sdk TaskSuccessSchema). Returns null when there's nothing to
 *  show, letting the caller fall back to extractResultText. */
function extractSubagentResult(
  result: unknown,
): { steps: NormalizedSubagentStep[]; finalText: string } | null {
  if (!isObj(result)) return null;
  const value = isObj(result.value) ? result.value : null;
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
      if (tc)
        steps.push({
          type: "tool",
          toolKind: tc.kind,
          title: tc.title,
          status: tc.status,
          rawInput: tc.rawInput,
          ...(tc.content ? { content: tc.content } : {}),
        });
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
  status: "completed" | "failed";
  rawInput: unknown;
  content?: Array<{ type: "content"; content: ContentBlock }>;
} | null {
  if (!isObj(message) || typeof message.type !== "string") return null;
  const args = isObj(message.args) ? message.args : {};
  const result = message.result;
  const value = isObj(result) && isObj(result.value) ? result.value : null;
  const errored = isObj(result) && result.status === "error";
  const done: "completed" | "failed" = errored ? "failed" : "completed";
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

  switch (message.type) {
    case "shell": {
      const command = str(args.command);
      const exitCode =
        value && typeof value.exitCode === "number" ? value.exitCode : null;
      const out = value
        ? [str(value.stdout), str(value.stderr)].filter(Boolean).join("\n")
        : "";
      return {
        title: `Running ${truncate(command || "shell command", 60)}`,
        kind: "execute",
        status:
          errored || (exitCode !== null && exitCode !== 0)
            ? "failed"
            : "completed",
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
  if (/read/.test(n)) return `Reading ${a.path ?? "file"}`;
  if (/(edit|write)/.test(n)) return `Editing ${a.path ?? "file"}`;
  if (/(shell|bash|exec|run|terminal)/.test(n))
    return `Running ${typeof a.command === "string" ? truncate(a.command, 60) : "shell command"}`;
  if (/grep/.test(n))
    return `Grep ${truncate(String(a.pattern ?? a.query ?? ""), 40)}`;
  if (/glob/.test(n)) return `Searching for ${a.pattern ?? "files"}`;
  if (/^(todo|updatetodos)/i.test(name)) return "Updating plan";
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
