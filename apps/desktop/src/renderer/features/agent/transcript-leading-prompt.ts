import type { AgentMessage, AgentTextMessage } from "./use-agent-session";

// ──────────────────────────────────────────────────────────
// Leading prompt — the opening prompt of a turn the window starts inside
// ──────────────────────────────────────────────────────────
//
// A resident transcript is a contiguous tail window: `messages[0]` is the
// older-page cursor. One long autonomous turn (hours of tool calls) can be
// longer than that window, so its opening prompt sits outside it and the turn
// renders with no prompt bubble. The engine reports that opening beside the
// window and the slot keeps it here, outside `messages`, so paging cursors,
// caps and equality checks keep their meaning. It never becomes a paging
// cursor or an edit baseline. A confirmed resident window can also use it to
// revalidate an explicit retry; a provisional cache copy cannot.
// ──────────────────────────────────────────────────────────

export function isUserPromptRow(
  message: AgentMessage | null | undefined,
): message is AgentTextMessage {
  return message?.kind === "text" && message.role === "user";
}

/** The message list the turn grouper should see. A still-valid leading prompt
 * is prepended only while the window starts inside its turn. */
export function presentLeadingPrompt(
  messages: AgentMessage[],
  leading: AgentTextMessage | null | undefined,
): AgentMessage[] {
  if (!leading || messages.length === 0 || isUserPromptRow(messages[0])) {
    return messages;
  }
  if (messages.some((message) => message.id === leading.id)) return messages;
  return [leading, ...messages];
}

/** The opening prompt of the turn the first kept row belongs to, after
 * `dropped` rows left the front of the window. A steer is followed back to its
 * owner; a steer whose owner is unknown still beats a headless turn. */
function leadingPromptAfterTrim(
  dropped: readonly AgentMessage[],
  previous: AgentTextMessage | null,
): AgentTextMessage | null {
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const message = dropped[index];
    if (!isUserPromptRow(message)) continue;
    const owner = message.steeredTurnId;
    if (!owner) return message;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const candidate = dropped[earlier];
      if (isUserPromptRow(candidate) && candidate.id === owner) return candidate;
    }
    return previous?.id === owner ? previous : message;
  }
  return previous;
}

/** Newest `max` messages, retaining the opening prompt of the turn the cut
 * lands in. Returns the input reference when nothing is trimmed. */
export function capMessagesKeepingLeadingPrompt(
  messages: AgentMessage[],
  max: number,
  previous: AgentTextMessage | null | undefined,
): { messages: AgentMessage[]; leadingPrompt: AgentTextMessage | null } {
  if (messages.length <= max) {
    return {
      messages,
      leadingPrompt: isUserPromptRow(messages[0]) ? null : (previous ?? null),
    };
  }
  const kept = messages.slice(-max);
  const leadingPrompt = isUserPromptRow(kept[0])
    ? null
    : leadingPromptAfterTrim(messages.slice(0, messages.length - max), previous ?? null);
  return { messages: kept, leadingPrompt };
}

/** The leading prompt after `previousMessages` became `nextMessages`.
 *
 * - `proposed` is an explicit value from a window read; `undefined` (or the
 *   unchanged previous value) means "derive it".
 * - Same front: unchanged. Front trimmed: follow the dropped rows. Older rows
 *   prepended: unchanged unless the page reached a prompt (then the opening is
 *   in-line, or the new top turn's own prompt is unknown). Wholesale
 *   replacement without a proposal: unknown. */
export function settleLeadingPrompt(
  previousMessages: readonly AgentMessage[],
  previous: AgentTextMessage | null | undefined,
  nextMessages: readonly AgentMessage[],
  proposed: AgentTextMessage | null | undefined,
): AgentTextMessage | null {
  const first = nextMessages[0];
  if (!first || isUserPromptRow(first)) return null;
  const prior = previous ?? null;
  if (proposed !== undefined && proposed !== prior) {
    return isUserPromptRow(proposed) &&
      !nextMessages.some((message) => message.id === proposed.id)
      ? proposed
      : null;
  }
  if (previousMessages[0]?.id === first.id) return prior;
  const trimmed = previousMessages.findIndex((message) => message.id === first.id);
  if (trimmed > 0) {
    return leadingPromptAfterTrim(previousMessages.slice(0, trimmed), prior);
  }
  const oldFirst = previousMessages[0];
  const prepended = oldFirst ? nextMessages.findIndex((message) => message.id === oldFirst.id) : -1;
  if (prepended > 0) {
    return nextMessages.slice(0, prepended).some(isUserPromptRow) ? null : prior;
  }
  return null;
}
