import { openZerosDb } from "./index";
import { nextRev } from "./sync";

export interface ConversationContext {
  generation: number;
  replayPending: boolean;
}

/** Kept out of ordinary chat upserts: only the engine can retire or acknowledge
 * native context. Generation also fences completions from before another reset. */
export function getConversationContext(chatId: string): ConversationContext | null {
  const row = openZerosDb().prepare(
    "SELECT context_generation, context_replay_pending FROM chats WHERE id = ?",
  ).get(chatId) as { context_generation: number; context_replay_pending: number } | undefined;
  return row ? { generation: row.context_generation, replayPending: row.context_replay_pending === 1 } : null;
}

/** Call in the same transaction as the transcript mutation. Old native
 * conversations remain at the provider but can no longer be resumed by this chat. */
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
