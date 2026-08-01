// ──────────────────────────────────────────────────────────
// turn-grouping — flat message list → turns (pure, no React)
// ──────────────────────────────────────────────────────────
//
// Every user message starts a visual prompt segment; everything else
// (assistant text, thinking, tool calls) belongs to the most recent segment's
// `events`. A mid-turn steer is still a distinct segment, but points back to
// the opening prompt's provider turn so only the final segment owns its
// footer. Messages arriving before any user prompt land in a "system turn"
// with `userPrompt: null` (rare; agent warm-up).
//
// Extracted from turn-container.tsx (which imports React, the composer
// editor and the workspace store) so non-React consumers — the transcript
// formatter, unit tests — can group without dragging in the renderer tree.
// TurnContainer re-exports these, so existing importers are unaffected.
// ──────────────────────────────────────────────────────────

import type { AgentMessage, AgentTextMessage } from "./use-agent-session";

export interface Turn {
  /** The user prompt that started this turn. null only for the
   *  rare leading "system turn" — events arriving before the
   *  first user prompt (e.g. the agent's session-init system
   *  message). */
  userPrompt: AgentTextMessage | null;
  /** Persisted provider-turn id. Several visual segments can share this when
   *  the user steers an in-flight turn. null for a leading system segment. */
  recordedTurnId: string | null;
  /** Start time of the provider turn, retained across steer segments so the
   *  live footer timer does not restart when a steer bubble is promoted. */
  recordedStartedAt: number;
  /** True when this visual segment begins with a mid-turn steer. */
  isSteer: boolean;
  /** All non-user-prompt messages that belong to this turn,
   *  in their arrival order. Includes assistant text, thinking,
   *  tool calls, and any other AgentMessage variants. */
  events: AgentMessage[];
  /** All events belonging to the shared provider turn. This is the same array
   *  as `events` for ordinary turns and a combined stable-by-elements array on
   *  the final steer segment. Used by footer copy/duration fallbacks. */
  providerEvents: AgentMessage[];
}

/** Stable id for a turn — the user-prompt id, or a synthetic one
 *  derived from the first event when there's no prompt. Used as
 *  the React key on the container. */
export function turnKey(turn: Turn): string {
  if (turn.userPrompt) return `turn-${turn.userPrompt.id}`;
  if (turn.events.length > 0) return `turn-evt-${turn.events[0].id}`;
  return "turn-empty";
}

export function groupMessagesIntoTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.kind === "text" && m.resumeBoundary) {
      // Session-continuity notices are invisible by design (2026-07-06 user
      // spec: no resume/continuation UI, ever). Newer sessions no longer
      // emit them; this skip hides the ones persisted by older builds.
      continue;
    }
    if (m.kind === "text" && m.role === "user") {
      const steeredTurnId = m.steeredTurnId;
      const recordedStartedAt: number =
        steeredTurnId && current?.recordedTurnId === steeredTurnId
          ? current.recordedStartedAt
          : m.createdAt;
      if (current) turns.push(current);
      const events: AgentMessage[] = [];
      current = {
        userPrompt: m,
        recordedTurnId: steeredTurnId ?? m.id,
        recordedStartedAt,
        isSteer: steeredTurnId != null,
        events,
        providerEvents: events,
      };
    } else {
      if (!current) {
        // Leading event before any user prompt — rare
        const events: AgentMessage[] = [];
        current = {
          userPrompt: null,
          recordedTurnId: null,
          recordedStartedAt: m.createdAt,
          isSteer: false,
          events,
          providerEvents: events,
        };
      }
      current.events.push(m);
    }
  }
  if (current) turns.push(current);
  let providerStart = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (!isProviderTurnTail(turns, index)) continue;
    if (providerStart !== index) {
      turns[index].providerEvents = turns
        .slice(providerStart, index + 1)
        .flatMap((turn) => turn.events);
    }
    providerStart = index + 1;
  }
  return turns;
}

/** True only for the last visual segment belonging to a provider turn. The
 *  footer is authoritative provider state, so a steered turn renders it once
 *  after the final segment instead of once per user bubble. */
export function isProviderTurnTail(
  turns: readonly Turn[],
  index: number,
): boolean {
  const turnId = turns[index]?.recordedTurnId;
  return turnId == null || turns[index + 1]?.recordedTurnId !== turnId;
}

/** True for every visual prompt segment that belongs to the provider turn at
 * the tail of the transcript. A steer adds a new user bubble without starting
 * a new provider turn, so the earlier segment must remain live/expanded until
 * that shared turn settles. For the rare id-less system turn, only the visual
 * tail qualifies; two unrelated null owners must never merge. */
export function isTailProviderTurnSegment(
  turns: readonly Turn[],
  index: number,
): boolean {
  const tailIndex = turns.length - 1;
  if (index < 0 || index > tailIndex) return false;
  if (index === tailIndex) return true;
  const tailTurnId = turns[tailIndex]?.recordedTurnId;
  return tailTurnId != null && turns[index]?.recordedTurnId === tailTurnId;
}

/** Best-effort mixed-version fallback when an older engine acknowledges a
 *  steer without returning its provider turn id. Follow any prior steer back
 *  to its opening prompt so repeated steers keep one owner. */
export function activeProviderTurnId(
  messages: readonly AgentMessage[],
  excludedMessageId?: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.kind !== "text" ||
      message.role !== "user" ||
      message.queued ||
      message.id === excludedMessageId
    ) {
      continue;
    }
    return message.steeredTurnId ?? message.id;
  }
  return undefined;
}
