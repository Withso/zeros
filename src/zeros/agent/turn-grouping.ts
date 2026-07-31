// ──────────────────────────────────────────────────────────
// turn-grouping — flat message list → turns (pure, no React)
// ──────────────────────────────────────────────────────────
//
// Phase 1 §2.5.1: every event between two consecutive user prompts forms a
// "turn". A turn starts on every text message with role:"user"; everything
// else (assistant text, thinking, tool calls) belongs to the most recent
// turn's `events`. Messages arriving before any user prompt land in a
// "system turn" with `userPrompt: null` (rare; agent warm-up).
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
  /** All non-user-prompt messages that belong to this turn,
   *  in their arrival order. Includes assistant text, thinking,
   *  tool calls, and any other AgentMessage variants. */
  events: AgentMessage[];
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
      if (current) turns.push(current);
      current = { userPrompt: m, events: [] };
    } else {
      if (!current) {
        // Leading event before any user prompt — rare
        current = { userPrompt: null, events: [] };
      }
      current.events.push(m);
    }
  }
  if (current) turns.push(current);
  return turns;
}
