import { openZerosDb } from "./index";
import { nextRev } from "./sync";

export interface ConversationContext {
  generation: number;
  replayPending: boolean;
}

/** Ordinary chat upserts leave native context alone; the generation prevents a stale replay from acknowledging a later reset. */
export function getConversationContext(chatId: string): ConversationContext | null {
  const row = openZerosDb().prepare(
    "SELECT context_generation, context_replay_pending FROM chats WHERE id = ?",
  ).get(chatId) as { context_generation: number; context_replay_pending: number } | undefined;
  return row ? { generation: row.context_generation, replayPending: row.context_replay_pending === 1 } : null;
}

/** Reset native context in the same transaction as the transcript mutation. */
export function resetConversationContext(chatId: string): void {
  openZerosDb().prepare(`
    UPDATE chats SET context_generation = context_generation + 1,
      context_replay_pending = 1, session_id = NULL,
      provider_binding = NULL, provider_metadata = NULL, rev = ?
    WHERE id = ?
  `).run(nextRev(), chatId);
}

export function acknowledgeConversationContext(chatId: string, generation: number): void {
  openZerosDb().prepare(`
    UPDATE chats SET context_replay_pending = 0
    WHERE id = ? AND context_generation = ?
  `).run(chatId, generation);
}
