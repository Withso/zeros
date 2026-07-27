import { startTransition } from "react";
import { create } from "zustand";

const useChatIntentStore = create<{ chatId: string | null }>(() => ({
  chatId: null,
}));

/** Ask the retained chat deck to build one likely destination at transition
 * priority. Session hydration is started separately by the caller; an inactive
 * ChatBody never spawns/resumes an agent process merely because it was hovered. */
export function prepareColumn2ChatView(
  chatId: string | null | undefined,
): void {
  if (!chatId || useChatIntentStore.getState().chatId === chatId) return;
  startTransition(() => useChatIntentStore.setState({ chatId }));
}

/** Release intent priority after the cold transcript has hydrated. The view
 * remains in the bounded MRU deck, but its heavy session subscription can now
 * park until it is actually shown. */
export function finishPreparedColumn2ChatView(chatId: string): void {
  if (useChatIntentStore.getState().chatId !== chatId) return;
  useChatIntentStore.setState({ chatId: null });
}

export function usePreparedColumn2ChatId(): string | null {
  return useChatIntentStore((state) => state.chatId);
}
