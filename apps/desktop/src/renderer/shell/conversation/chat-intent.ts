import { startTransition } from "react";
import { create } from "zustand";

const useChatIntentStore = create<{ chatId: string | null }>(() => ({
  chatId: null,
}));

/** Ask the retained chat deck to build one likely destination at transition
 * priority. Session hydration is started separately by the caller; an inactive
 * ChatBody never spawns/resumes an agent process merely because it was hovered. */
export function prepareChatView(
  chatId: string | null | undefined,
): void {
  if (!chatId || useChatIntentStore.getState().chatId === chatId) return;
  startTransition(() => useChatIntentStore.setState({ chatId }));
}

/** Release intent priority after the cold transcript has hydrated. The view
 * remains in the bounded MRU deck, but its heavy session subscription can now
 * park until it is actually shown. */
export function finishPreparedChatView(chatId: string): void {
  if (useChatIntentStore.getState().chatId !== chatId) return;
  useChatIntentStore.setState({ chatId: null });
}

export function usePreparedChatId(): string | null {
  return useChatIntentStore((state) => state.chatId);
}
