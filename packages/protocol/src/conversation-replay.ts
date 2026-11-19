// Replay restores text context after a provider starts a new session instead of resuming the old one.

import type { AgentMessage, AgentTextMessage } from "./agent-messages";

/** Additive handshake capability. Older engines still need renderer replay. */
export const CONVERSATION_REPLAY_CAPABILITY = "conversation.contextReplay.v1";

const CONTINUATION = "Continue from where the previous conversation left off. The user's next message follows.";

/** Recognize only the generated preamble used by older renderers, so a Local
 * engine can replace their possibly stale context with its own retained rows. */
export function isConversationReplayPreamble(text: string): boolean {
  return (text.startsWith("<previous_conversation>\n") || text.startsWith("<previous_conversation_summary>\n")) &&
    (text.includes("</previous_conversation>\n") || text.includes("</previous_conversation_summary>\n")) &&
    text.endsWith(CONTINUATION);
}

const MAX_MESSAGES = 60;

/** Only framed turns count toward this budget; the first over-budget turn and all later turns are dropped. */
const MAX_CHARS = 16_000;

/** Clamp each turn so one large paste cannot consume the whole turn budget. */
const PER_MESSAGE_CHARS = 2_000;

export interface ReplayResult {
  text: string;
  /** Counts replayed turns, not the separate summary. */
  messageCount: number;
  /** Reports omitted turns, not per-turn clipping. */
  truncated: boolean;
}

export function synthesizeReplayPrompt(messages: AgentMessage[]): ReplayResult {
  // Never replay unsent or redacted text.
  const textOnly = messages.filter((m): m is AgentTextMessage => {
    if (m.kind !== "text") return false;
    if (m.role !== "user" && m.role !== "agent") return false;
    if (m.redacted || m.queued) return false;
    return m.text.trim().length > 0;
  });

  if (textOnly.length === 0) {
    return { text: "", messageCount: 0, truncated: false };
  }

  // Use the latest agent summary in place of earlier turns; replaying both duplicates the compacted history.
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

  const truncatedByCount = eligibleForReplay.length > MAX_MESSAGES;
  const window = truncatedByCount
    ? eligibleForReplay.slice(eligibleForReplay.length - MAX_MESSAGES)
    : eligibleForReplay;

  // Role tags distinguish conversation turns from the continuation instruction.
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

  if (parts.length === 0 && !summaryText) {
    return { text: "", messageCount: 0, truncated: false };
  }

  const truncated = truncatedByCount || charBudgetExceeded;
  const omittedNote = truncated
    ? `(Older messages omitted to fit context budget. Resume from the most recent exchange.)\n`
    : "";

  const summaryBlock = summaryText
    ? [
        `<previous_conversation_summary>`,
        summaryText,
        `</previous_conversation_summary>`,
      ].join("\n")
    : "";

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
    CONTINUATION,
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
