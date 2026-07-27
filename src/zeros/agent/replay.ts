// ──────────────────────────────────────────────────────────
// replay — synthesize a "previous_conversation" preamble
// ──────────────────────────────────────────────────────────
//
// Phase B2 (2026-05-07) of the chat resume rebuild. When the silent
// fresh-start fallback fires (Codex "no rollout found" / Claude
// "session not found" / etc., per docs/research/09), the agent gets a
// new sessionId but has zero in-memory context from the prior chat.
// `synthesizeReplayPrompt` produces a compact context preamble that
// gets prepended to the user's pending prompt so the agent can
// continue the conversation without amnesia.
//
// What's included:
//   - User text messages (their prompts)
//   - Assistant final text replies (skipping tool calls + thinking —
//     they're verbose and don't carry portable context. Replaying tool
//     outputs across a session boundary creates more confusion than
//     value: the agent didn't actually run those tools this time.)
//   - System messages (rare; usually session-init notes — skip them
//     too. A previously-injected replay notice is intentionally NOT
//     re-replayed to avoid recursive nesting on a second rebuild.)
//
// What's NOT included:
//   - Tool calls (verbose, vendor-specific, not portable)
//   - Thinking / reasoning blocks (private to the prior session)
//   - Empty or whitespace-only messages (no signal)
//   - The active user prompt that triggered the rebuild (added by
//     the caller after this preamble)
//
// Token budget:
//   - Hard caps prevent a 200-message chat from blasting 50k tokens
//     of replay. We take the most recent N messages (`MAX_MESSAGES`)
//     and char-cap the total (`MAX_CHARS`) — older messages drop first.
//   - For typical 20-30 message chats, the full transcript fits.
//   - The caller should still expect a one-time ~5-15k token spend on
//     the rare resume-after-cleanup case.
//
// ──────────────────────────────────────────────────────────

import type {
  AgentMessage,
  AgentTextMessage,
} from "./use-agent-session";

/** Cap on how many user/assistant text messages we'll include in the
 *  replay. 60 = ~30 turns of back-and-forth — enough context for the
 *  agent to follow the thread without overflowing the context window
 *  on big-model + big-tool runs. Older messages drop. */
const MAX_MESSAGES = 60;

/** Total char budget for the replay body (excluding XML wrappers).
 *  16k chars ≈ 4k tokens — a manageable one-time cost. Older messages
 *  drop until the body fits. */
const MAX_CHARS = 16_000;

/** Per-message char clamp so a single ~30k-char paste in the prior
 *  chat doesn't dominate the replay budget. Truncated with an ellipsis. */
const PER_MESSAGE_CHARS = 2_000;

export interface ReplayResult {
  /** The XML-framed preamble. Empty string when there's nothing
   *  worth replaying (no eligible messages, all empty). The caller
   *  should check this and skip the replay step in that case. */
  text: string;
  /** Number of source messages that contributed to the preamble. The
   *  caller surfaces this in the synthetic system notice ("Replayed
   *  N prior messages"). 0 when text is empty. */
  messageCount: number;
  /** Whether messages were dropped because of the caps. Lets the
   *  caller surface "(earlier messages omitted)" if they want. */
  truncated: boolean;
}

/** Pure: produce the replay preamble for a list of prior messages.
 *  Works on the canonical AgentMessage[] from sessions-store, so the
 *  caller can pass `slot.messages` directly. */
export function synthesizeReplayPrompt(
  messages: AgentMessage[],
): ReplayResult {
  // Filter to text-only user/assistant messages with content. Skip
  // tool calls, thinking, system meta-notices, redacted thoughts.
  const textOnly = messages.filter((m): m is AgentTextMessage => {
    if (m.kind !== "text") return false;
    if (m.role !== "user" && m.role !== "agent") return false;
    if (m.redacted) return false;
    return m.text.trim().length > 0;
  });

  if (textOnly.length === 0) {
    return { text: "", messageCount: 0, truncated: false };
  }

  // Phase D1 (2026-05-07): if the chat has been summarized at any
  // point, the latest summary boundary is the "true start" of the
  // replay. Everything before the summary is folded into the summary
  // text itself (frame as <previous_conversation_summary>) — replaying
  // raw history before the boundary would double-count those tokens.
  //
  // Search back-to-front for the latest summaryBoundary on an agent
  // message. The summary text comes FIRST in the synthesized prompt
  // (so the model sees the compacted history before the live tail);
  // post-summary messages render as normal <user>/<assistant> pairs.
  let summaryText: string | null = null;
  let postSummaryStart = 0;
  for (let i = textOnly.length - 1; i >= 0; i--) {
    const m = textOnly[i];
    if (m.role === "agent" && m.summaryBoundary) {
      summaryText = m.text;
      postSummaryStart = i + 1;
      break;
    }
  }
  const eligibleForReplay = textOnly.slice(postSummaryStart);

  // Take the most recent MAX_MESSAGES from the eligible window; older
  // ones drop. Build forward (oldest-first within the kept window)
  // so the chronological flow is preserved for the agent's reasoning.
  const truncatedByCount = eligibleForReplay.length > MAX_MESSAGES;
  const window = truncatedByCount
    ? eligibleForReplay.slice(eligibleForReplay.length - MAX_MESSAGES)
    : eligibleForReplay;

  // Render each message with a per-message clamp + role tag. We use
  // <user>/<assistant> XML tags rather than "User: ..." / "Assistant: ..."
  // prose because every modern LLM treats these tags as turn boundaries
  // without further prompting (Anthropic, OpenAI, Google all document
  // this pattern in their prompt-engineering guides).
  const parts: string[] = [];
  let charCount = 0;
  let charBudgetExceeded = false;
  for (const m of window) {
    const tag = m.role === "user" ? "user" : "assistant";
    const clamped =
      m.text.length > PER_MESSAGE_CHARS
        ? m.text.slice(0, PER_MESSAGE_CHARS) + "…"
        : m.text;
    const piece = `<${tag}>${clamped}</${tag}>`;
    if (charCount + piece.length > MAX_CHARS) {
      charBudgetExceeded = true;
      break;
    }
    parts.push(piece);
    charCount += piece.length + 1; // +1 for the join newline
  }

  // Empty post-summary tail is fine when a summary IS present — we
  // still want to send the summary as context. Only bail when both
  // are empty.
  if (parts.length === 0 && !summaryText) {
    return { text: "", messageCount: 0, truncated: false };
  }

  const truncated = truncatedByCount || charBudgetExceeded;
  const omittedNote = truncated
    ? `(Older messages omitted to fit context budget. Resume from the most recent exchange.)\n`
    : "";

  // Phase D1: if a summary is in scope, prepend it as a separate
  // <previous_conversation_summary> block. This frames the compacted
  // history before the live tail. The model sees: summary first,
  // then any post-summary turns.
  const summaryBlock = summaryText
    ? [
        `<previous_conversation_summary>`,
        summaryText,
        `</previous_conversation_summary>`,
      ].join("\n")
    : "";

  // The wrapper text is deliberately terse. We don't tell the agent
  // "this is a replay because the rollout was deleted" — that's UX
  // implementation detail the model doesn't need. We just frame the
  // history and ask it to continue.
  const conversationBlock =
    parts.length > 0
      ? [
          `<previous_conversation>`,
          omittedNote.trim(),
          parts.join("\n"),
          `</previous_conversation>`,
        ]
          .filter((line) => line !== "")
          .join("\n")
      : "";

  const text = [
    summaryBlock,
    conversationBlock,
    ``,
    `Continue from where the previous conversation left off. The user's next message follows.`,
    ``,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    text,
    messageCount: parts.length,
    truncated,
  };
}
