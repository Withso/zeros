// ──────────────────────────────────────────────────────────
// Agent message model + the pure SessionNotification → message folder
// ──────────────────────────────────────────────────────────
//
// Moved out of src/zeros/agent/use-agent-session.tsx into @zeros/core so BOTH
// the renderer (live coalescing) AND the engine (persist-on-emit, Phase 2b) run
// the SAME reducer — no duplication, no drift. Pure TS (no React). The engine
// folds streaming chunks into AgentMessages with applyUpdate() and upserts them
// to the unified Zeros DB as it streams (it's the source — works even for a
// cloud agent whose client is disconnected). use-agent-session.tsx re-exports
// this so every existing import site keeps resolving unchanged.
// ──────────────────────────────────────────────────────────

import type {
  ModeSwitchUpdate,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "./agent-events";

export type AgentMessageRole = "user" | "agent" | "thought" | "system";

export interface AgentTextMessage {
  id: string;
  kind: "text";
  role: AgentMessageRole;
  text: string;
  createdAt: number;
  /** Engine-side message id from the SessionNotification chunk. Used
   *  to coalesce streaming chunks of the SAME message; differs across
   *  turns, so without this every turn's agent reply would merge into
   *  one growing bubble (the symptom that surfaced after we fixed the
   *  Codex stdin hang and turns started actually completing). */
  messageId?: string;
  /** Roadmap §2.4.8 — true for `role: "thought"` messages whose
   *  content the model encrypted (Anthropic `redacted_thinking`
   *  blocks). Renderer shows a distinct "redacted" badge with no
   *  expandable body. Other roles ignore this field. */
  redacted?: boolean;
  /** Roadmap §2.4.7 — text emitted by a subagent (Claude `Task` /
   *  `Agent` tool) carries the parent Task's toolCallId. The renderer
   *  routes it inside the SubagentCard rather than the top-level
   *  timeline. See same field on AgentToolMessage. */
  parentToolId?: string;
  /** Phase D1 (2026-05-07) — true for the agent message that holds
   *  the user-triggered summary text. The renderer styles this with
   *  a "── Summary ──" divider so the user can see where the chat's
   *  context was compacted. The replay synthesizer (Phase B2) uses
   *  this as a boundary: only messages AT or AFTER the latest
   *  summary boundary are replayed; everything before is implicitly
   *  represented by the summary text itself. */
  summaryBoundary?: boolean;
  /** Phase B2 (2026-05-07) — marks the synthetic system message
   *  inserted when the agent's session expired and we silently
   *  rebuilt + replayed prior messages. The renderer draws a thin
   *  "── Continuing session ──" divider in the timeline INSTEAD of
   *  a bubble. `text` carries the divider label so copy stays
   *  pluggable per locale / future iteration. */
  resumeBoundary?: boolean;
  /** Phase D2 (2026-05-07) iter 4 — attachments stamped on the user
   *  message at send time so the timeline bubble can render the
   *  same chip row the user saw in the composer. Persisted to
   *  SQLite via the normal payload flow. For images, `thumbnailUri`
   *  is a data: URL (Claude's vision path) or a file:// URL pointing
   *  at the saved bytes (non-vision agents). For text files, the
   *  body itself is too large to keep on every message — only the
   *  filename + mime is stored. */
  attachments?: AgentTextMessageAttachment[];
  /** 2026-06-08 — ordered content of a user message: text interleaved with
   *  inline mention + attachment pills, exactly as composed (the TipTap
   *  composer serializes these). When present the bubble renders them inline;
   *  otherwise it falls back to `text` + the `attachments` chip row (pre-editor
   *  messages). Persisted to SQLite via the normal payload flow. */
  segments?: MessageContentSegment[];
  /** A user message that was typed while a turn was already in flight and
   *  is WAITING in the send queue (it hasn't been dispatched yet). The
   *  renderer shows it greyed with a "Queued" affordance + a remove control;
   *  it is NEVER persisted (it becomes a normal message once it flushes).
   *  See sendQueueRef in sessions-provider. */
  queued?: boolean;
  /** Only meaningful on a `queued` bubble: whether inline edit is offered.
   *  False when the queued send's WIRE text diverges from its display text
   *  (an @-mention/import expansion happened) — editing in place would
   *  collapse the two and silently strip the expansion, so we hide Edit and
   *  leave Remove + retype. Transient; never persisted (queued bubbles are
   *  excluded from the SQLite write entirely). */
  queuedEditable?: boolean;
  /** A user message injected into an already-running provider turn. The
   *  message remains its own visual prompt segment, but this field points to the
   *  opening user message whose persisted turn row owns duration, status,
   *  authored files, and reset semantics. */
  steeredTurnId?: string;
  /** 2026-07-19 (PR status island) — set on a user message that Zeros sent
   *  AUTOMATICALLY on the user's behalf (Create PR / Resolve / Commit & Push /
   *  Update branch buttons). Carries the action kind (e.g. `create-pr`).
   *  The renderer paints these bubbles in the brown "sent by Zeros" treatment
   *  with the action's icon and offers Copy only (no Edit — the wire text is a
   *  generated brief the short label can't round-trip). Persisted with the
   *  payload so reopened chats keep the treatment. */
  autoAction?: string;
}

export interface AgentTextMessageAttachment {
  name: string;
  mimeType: string;
  kind: "image" | "text";
  /** Data URL (data:<mime>;base64,...) or file:// URL for the
   *  thumbnail. Only populated for images. */
  thumbnailUri?: string;
  /** Cwd-relative path on disk (when the image was saved for a
   *  non-vision agent). Lets the renderer offer a "Open in
   *  Finder" affordance later. */
  diskPath?: string;
}

/** One ordered piece of a user message — text, an inline file/folder/
 *  selection mention pill, or an inline image/text attachment pill — used to
 *  render a sent bubble exactly as it was composed. */
export type MessageContentSegment =
  | { type: "text"; text: string }
  | {
      type: "mention";
      label: string;
      path: string;
      kind: "file" | "folder" | "selection";
    }
  | {
      type: "attachment";
      name: string;
      mimeType: string;
      kind: "image" | "text";
      /** data: URL for an image thumbnail (images only). */
      thumbnailUri?: string;
    };

export interface AgentToolMessage {
  id: string;
  kind: "tool";
  toolCallId: string;
  /** The vendor's own id for this call (Claude tool_use id, Codex itemId) —
   *  see ToolCall.nativeToolCallId. Blocking-question requests reference the
   *  native id, so renderers match `toolCallId` OR this when correlating. */
  nativeToolCallId?: string;
  title: string;
  toolKind: string | undefined;
  status: "pending" | "in_progress" | "completed" | "failed";
  content?: ToolCall["content"];
  locations?: ToolCall["locations"];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Optional grouping key (Stage 4.2). Tool calls sharing a mergeKey
   *  collapse at render time — the most recent renders, predecessors
   *  surface as "+N more" history under it. The store keeps every
   *  message; shadowing is a render-time concern only. */
  mergeKey?: string;
  /** Roadmap §2.4.7 — when a subagent (Claude `Task`/`Agent` tool)
   *  is in flight, the child events the subagent emits carry the parent
   *  Task's toolCallId here. The renderer hides children from the
   *  top-level timeline and shows them indented inside the parent
   *  SubagentCard's expanded body. */
  parentToolId?: string;
  createdAt: number;
  updatedAt: number;
}

// ──────────────────────────────────────────────────────────
// Canonical message kinds (declared in Stage 1A.8 — emitted
// in later Phase 1 stages when the matching renderers ship)
// ──────────────────────────────────────────────────────────
//
// These extend the AgentMessage union with semantically-distinct
// variants the renderer can specialise on. Today applyUpdate folds
// every event into AgentTextMessage or AgentToolMessage; per the
// Phase 1 roadmap (§2.4) Stages 3–4 will route specific events
// here so the registry can dispatch to purpose-built cards
// (ThinkingBlock, PlanPanel, QuestionCard,
// SubagentCard, ErrorNotice). The contract lives here so the
// renderer registry's `unknown` fallback catches anything we
// haven't handled yet — drift never silently disappears.

/** Streaming reasoning content from the agent. Replaces the
 *  AgentTextMessage(role="thought") indirection — Stage 4 promotes
 *  agent_thought_chunk events here so the ThinkingBlock renderer
 *  can show duration / token-count / collapse-by-default semantics
 *  separate from regular agent text. */
export interface AgentThinkingMessage {
  id: string;
  kind: "thinking";
  text: string;
  createdAt: number;
  messageId?: string;
  /** Total elapsed thinking time when this chunk arrived; populated
   *  on the final chunk for the duration badge. */
  durationMs?: number;
  /** True for agents that emit `redacted_thinking` content blocks
   *  (Anthropic). Renderer shows a stub. */
  redacted?: boolean;
}

/** Clarifying question awaiting a user reply. Two flavours:
 *  - native_tool: the agent emitted a structured ask-tool call
 *    (Claude AskUserQuestion). The agent process is blocked;
 *    reply via `tool_result`.
 *  - inferred: the agent's turn ended with what looks like a
 *    question (heuristic). Reply is a normal next-turn user prompt. */
export interface AgentQuestionMessage {
  id: string;
  kind: "question";
  source: "native_dialog" | "native_rpc" | "native_tool" | "inferred_from_text";
  /** The originating tool-call id, so the durable record can co-locate/dedupe
   *  with the timeline tool card. */
  toolCallId?: string;
  /** UI resolver key — matches the in-flight QuestionRequest.questionId. */
  questionId?: string;
  /** Vendor correlation id for replay dedup (see QuestionRequest). */
  nativeRequestId?: string;
  questions: AgentQuestionField[];
  /** True iff the agent process is paused awaiting reply. */
  blocking: boolean;
  createdAt: number;
}

export interface AgentQuestionField {
  /** Per-question id (matches the in-flight QuestionSpec.id). */
  id: string;
  prompt: string;
  /** Short label (≤16 chars per the native tool specs). Optional. */
  header?: string;
  inputType: "choice" | "multi_choice" | "text" | "yesno";
  options?: Array<{
    id: string;
    label: string;
    description?: string;
    preview?: string;
  }>;
  placeholder?: string;
  /** Render the free-text "Other" / "Type something…" row. */
  allowOther?: boolean;
  /** Masked input (Codex isSecret); value never logged. */
  secret?: boolean;
  /** undefined until the user submits; then the read-only answered state. The
   *  per-field answer replaces the old message-level `answer` so a reload shows
   *  the answered form, not a blank one. */
  answer?: { selectedOptionIds: string[]; freeText?: string };
}

/** Banner marking a mode switch in the timeline. Phase / Permission
 *  / Tier are the three orthogonal axes (see roadmap §2.4.13).
 *  Triggered by user toggle, by the agent autonomously (Claude
 *  ExitPlanMode), or by adapter-emitted current_mode_update
 *  notifications. */
export interface AgentModeSwitchMessage {
  id: string;
  kind: "mode_switch";
  axis: "phase" | "permission" | "tier";
  from: string;
  to: string;
  source: "user" | "agent";
  /** Plan content from Claude's ExitPlanMode tool, or rationale
   *  from an agent-emitted mode switch. Optional. */
  reason?: string;
  /** True for Claude's ExitPlanMode (a permission-gated switch).
   *  Renderer shows the approve/reject UI inline. */
  requiresApproval?: boolean;
  createdAt: number;
}

/** Boundary marker for a subagent block (Claude Task).
 *  The matching tool call still appears as AgentToolMessage; this
 *  message anchors the start/end of the nested transcript so the
 *  renderer can indent or fold it as one unit. */
export interface AgentSubagentMessage {
  id: string;
  kind: "subagent";
  marker: "start" | "end";
  subagentId: string;
  /** Parent tool-call id linking this subagent to its trigger. */
  parentToolId: string;
  description?: string;
  /** Set on the "end" marker — renderer collapses to a one-line
   *  "Subagent X · summary" card when present. */
  summary?: string;
  createdAt: number;
}

/** Free-standing error notice — distinct from a tool that failed
 *  (which surfaces on AgentToolMessage.status). Used for adapter-
 *  level errors (Codex API rejections, transport hiccups, etc.)
 *  that don't belong inside a tool card. */
export interface AgentErrorNoticeMessage {
  id: string;
  kind: "error_notice";
  severity: "warning" | "error";
  message: string;
  /** When recoverable, renderer shows a "retry" affordance. */
  recoverable: boolean;
  /** Adapter-side error code for click-through to docs. */
  code?: string;
  createdAt: number;
}

export type AgentMessage =
  | AgentTextMessage
  | AgentToolMessage
  | AgentThinkingMessage
  | AgentQuestionMessage
  | AgentModeSwitchMessage
  | AgentSubagentMessage
  | AgentErrorNoticeMessage;


// ──────────────────────────────────────────────────────────
// Question resolution stamps (the ANSWERED / SKIPPED record)
// ──────────────────────────────────────────────────────────

/** Durable resolution record stamped onto a question tool message's
 *  rawOutput (key `zerosQuestion`). Drives the transcript card's
 *  ANSWERED / SKIPPED states after the interactive composer card is gone.
 *  Written by BOTH sides: the renderer stamps optimistically on submit, and
 *  the adapters emit a synthetic tool_call_update carrying it on settle so
 *  the ENGINE-persisted transcript is stamped too (reload / window-reconcile
 *  / cross-device all keep the record). */
export interface QuestionRecordStamp {
  outcome: "answered" | "skipped";
  /** One-line flat summary of the answers (answered only). */
  summary?: string;
  /** Per-question answers so the expanded record can pair each question with
   *  what the user picked/typed (answered only). */
  answers?: Array<{ prompt: string; value: string }>;
}

/** Build the durable stamp for a settled question from its request + outcome.
 *  Option ids are mapped back to labels; free-text rides along verbatim. */
export function buildQuestionStamp(
  request: import("./agent-events").QuestionRequest,
  outcome: import("./agent-events").QuestionOutcome,
): QuestionRecordStamp {
  if (outcome.outcome !== "answered") return { outcome: "skipped" };
  const byId = new Map(outcome.answers.map((a) => [a.questionId, a]));
  const answers = request.questions.map((q) => {
    const a = byId.get(q.id);
    const labels = (a?.selectedOptionIds ?? []).map(
      (id) => q.options.find((o) => o.id === id)?.label ?? id,
    );
    if (a?.freeText) labels.push(a.freeText);
    return { prompt: q.prompt, value: labels.join(", ") || "(no answer)" };
  });
  return {
    outcome: "answered",
    summary: answers.map((a) => a.value).join(" · "),
    answers,
  };
}

/** Read a stamp back off a tool message's rawOutput. Null when the question
 *  hasn't been stamped (still awaiting, or a pre-stamp legacy record). */
export function readQuestionStamp(
  rawOutput: unknown,
): QuestionRecordStamp | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const stamp = (rawOutput as Record<string, unknown>).zerosQuestion;
  if (!stamp || typeof stamp !== "object") return null;
  const outcome = (stamp as Record<string, unknown>).outcome;
  if (outcome !== "answered" && outcome !== "skipped") return null;
  return stamp as unknown as QuestionRecordStamp;
}

// ──────────────────────────────────────────────────────────
// Fold a SessionNotification into the running message list
// ──────────────────────────────────────────────────────────

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** tool_call_update rawOutput merge. An update's rawOutput normally REPLACES
 *  the message's — but a question tool message carries the durable
 *  resolution record (`zerosQuestion`, see QuestionRecordStamp) and the
 *  vendor's tool_result lands MILLISECONDS around it, in either order:
 *    stamp → tool_result   (renderer's optimistic stamp, then vendor output)
 *    tool_result → stamp   (adapter's synthetic stamp update lands late)
 *  A wholesale replace would wipe one side, so the stamp is carried from
 *  whichever side has it (next wins on conflict) and a stamp-ONLY update
 *  overlays the existing output instead of erasing it. */
function mergeRawOutput(prev: unknown, next: unknown): unknown {
  if (next === undefined || next === null) return prev;
  const prevStamp = isPlainObject(prev) ? prev.zerosQuestion : undefined;
  const nextStamp = isPlainObject(next) ? next.zerosQuestion : undefined;
  const stamp = nextStamp ?? prevStamp;
  if (stamp === undefined) return next;
  // Stamp-only update (the adapter's synthetic settle record) → overlay onto
  // the existing output rather than replacing it.
  if (
    isPlainObject(next) &&
    Object.keys(next).length === 1 &&
    nextStamp !== undefined &&
    isPlainObject(prev)
  ) {
    return { ...prev, zerosQuestion: stamp };
  }
  if (isPlainObject(next)) {
    return { ...next, zerosQuestion: stamp };
  }
  // Non-object vendor output (a bare string/array) — keep it under `output`
  // so neither the vendor result nor the stamp is lost.
  return { output: next, zerosQuestion: stamp };
}

export function applyUpdate(
  messages: AgentMessage[],
  notification: SessionNotification,
): AgentMessage[] {
  const upd = notification.update;
  switch (upd.sessionUpdate) {
    case "user_message_chunk": {
      // Speculative dedup. sendPrompt() adds the user's bubble locally
      // before the AGENT_PROMPT round-trip so the UI updates instantly.
      // Some agents then echo the prompt back as a user record, which the
      // translator turns into user_message_chunk — without dedup, this
      // lands as a SECOND identical bubble. Claude / Codex / Cursor are
      // all subject to the same race depending on schema. The check: the
      // most recent message is a user text
      // bubble with no engine messageId yet (i.e. the speculative one
      // we just added). Adopt the engine's messageId on it instead of
      // creating a new bubble. Replay-from-disk is unaffected — there
      // the messages array fills *only* via translator events, so the
      // last-message check fails (or it has a messageId already from
      // a prior replayed turn). New messages from the user side never
      // race with replay because replay runs to completion before the
      // first live prompt.
      const last = messages[messages.length - 1];
      const incomingId =
        typeof upd.messageId === "string" ? upd.messageId : undefined;
      if (
        last &&
        last.kind === "text" &&
        last.role === "user" &&
        last.messageId === undefined &&
        incomingId !== undefined
      ) {
        const adopted: AgentTextMessage = {
          ...(last as AgentTextMessage),
          messageId: incomingId,
        };
        return [...messages.slice(0, -1), adopted];
      }
      return appendText(messages, "user", upd.content, incomingId);
    }
    case "agent_message_chunk":
      // `messageId` is `string | null | undefined`.
      // Treat null the same as undefined — both mean "no engine id yet",
      // which falls through to role-only coalescing in appendText.
      return appendText(
        messages,
        "agent",
        upd.content,
        upd.messageId ?? undefined,
        undefined,
        upd.parentToolId ?? undefined,
      );
    case "agent_thought_chunk":
      return appendText(
        messages,
        "thought",
        upd.content,
        upd.messageId ?? undefined,
        upd.redacted ?? undefined,
        upd.parentToolId ?? undefined,
      );
    case "tool_call": {
      const tc = upd as unknown as ToolCall & { sessionUpdate: "tool_call" };
      const msg: AgentToolMessage = {
        id: `tool-${tc.toolCallId}`,
        kind: "tool",
        toolCallId: tc.toolCallId,
        nativeToolCallId: tc.nativeToolCallId ?? undefined,
        title: tc.title ?? tc.toolCallId,
        toolKind: tc.kind ?? undefined,
        status: tc.status ?? "pending",
        content: tc.content ?? undefined,
        locations: tc.locations ?? undefined,
        rawInput: tc.rawInput,
        rawOutput: tc.rawOutput,
        mergeKey: tc.mergeKey ?? undefined,
        parentToolId: tc.parentToolId ?? undefined,
        // Replay carries the original event time via `at`; live turns omit
        // it so we stamp now. Keeps resumed-chat durations accurate.
        createdAt: typeof tc.at === "number" ? tc.at : Date.now(),
        updatedAt: typeof tc.at === "number" ? tc.at : Date.now(),
      };
      return [...messages, msg];
    }
    case "tool_call_update": {
      const upd2 = upd as unknown as ToolCallUpdate & {
        sessionUpdate: "tool_call_update";
      };
      return messages.map((m) => {
        if (m.kind !== "tool" || m.toolCallId !== upd2.toolCallId) return m;
        return {
          ...m,
          status: upd2.status ?? m.status,
          title: upd2.title ?? m.title,
          toolKind: upd2.kind ?? m.toolKind,
          content: upd2.content ?? m.content,
          locations: upd2.locations ?? m.locations,
          rawInput: upd2.rawInput ?? m.rawInput,
          rawOutput: mergeRawOutput(m.rawOutput, upd2.rawOutput),
          mergeKey: upd2.mergeKey ?? m.mergeKey,
          updatedAt: typeof upd2.at === "number" ? upd2.at : Date.now(),
        };
      });
    }
    // Mode / commands updates are handled at the provider level
    // (they change session slots other than `messages`), so skip here.
    case "current_mode_update":
    case "available_commands_update":
      return messages;
    case "mode_switch": {
      // Stage 4.4 — append a banner message to the timeline. Distinct
      // from current_mode_update (which patches session.currentModeId);
      // the banner is what the user sees as a transcript record.
      const m = upd as unknown as ModeSwitchUpdate;
      const at = typeof m.at === "number" ? m.at : Date.now();
      const banner: AgentModeSwitchMessage = {
        id: `mode-${at}-${m.to}`,
        kind: "mode_switch",
        axis: m.axis,
        from: m.from ?? "",
        to: m.to,
        source: m.source,
        reason: m.reason,
        createdAt: at,
      };
      return [...messages, banner];
    }
    case "error_notice": {
      // One compact timeline row per adapter-level notice (transient retry,
      // transport warning, API rejection). Keyed by noticeId so a replayed
      // stream folds onto the same row instead of duplicating.
      const n = upd as unknown as import("./agent-events").ErrorNoticeUpdate;
      if (!n.noticeId || !n.message) return messages;
      const id = `notice-${n.noticeId}`;
      if (messages.some((m) => m.id === id)) return messages;
      const notice: AgentErrorNoticeMessage = {
        id,
        kind: "error_notice",
        severity: n.severity === "error" ? "error" : "warning",
        message: n.message,
        recoverable: n.recoverable === true,
        code: n.code,
        createdAt: typeof n.at === "number" ? n.at : Date.now(),
      };
      return [...messages, notice];
    }
    default:
      return messages;
  }
}

function appendText(
  messages: AgentMessage[],
  role: AgentMessageRole,
  content: { type?: string; text?: string } | undefined,
  messageId: string | undefined,
  redacted?: boolean,
  parentToolId?: string,
): AgentMessage[] {
  if (!content || content.type !== "text" || typeof content.text !== "string") {
    return messages;
  }
  const chunkText = content.text;

  // Coalesce into the trailing text message ONLY if it's from the same
  // role AND carries the same engine-side messageId. Without the id
  // check, two consecutive turns' agent replies would merge into one
  // growing bubble. With it, streaming deltas of one message still
  // coalesce (the streaming use case), but a fresh message starts
  // a new bubble (the new-turn use case).
  //
  // If either side has no messageId we fall back to the role-only
  // merge — preserves the streaming behavior for adapters that
  // don't (yet) emit messageIds.
  const last = messages[messages.length - 1];
  if (
    last &&
    last.kind === "text" &&
    last.role === role &&
    sameMessageId(last.messageId, messageId)
  ) {
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        text: last.text + chunkText,
        // Once a message has been flagged redacted (any block in it),
        // keep the flag set — Anthropic interleaves redacted/plain
        // blocks within a single thinking message and we want the
        // composite to render as redacted.
        ...(redacted ? { redacted: true } : {}),
      },
    ];
  }

  return [
    ...messages,
    {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "text",
      role,
      text: chunkText,
      createdAt: Date.now(),
      messageId,
      ...(redacted ? { redacted: true } : {}),
      ...(parentToolId ? { parentToolId } : {}),
    },
  ];
}

function sameMessageId(a: string | undefined, b: string | undefined): boolean {
  // Both undefined → coalesce (legacy behavior). Both set + equal → coalesce.
  // One set, one not → DON'T coalesce (treat as separate messages, since
  // the engine started identifying messages mid-conversation).
  if (a === undefined && b === undefined) return true;
  return a === b;
}
