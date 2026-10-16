import { useCallback, useSyncExternalStore } from "react";
import {
  computerUseWaitText,
  readComputerUseState,
  type ComputerUseStateSnapshot,
} from "@zeros/protocol/computer-use-tools";

// Main owns who uses the computer and which chats wait. The renderer keeps
// only the latest snapshot so a tool row can say why its call is waiting.
let state: ComputerUseStateSnapshot | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Accept one snapshot from main. A malformed one is ignored. */
export function publishComputerUseState(value: unknown): boolean {
  const next = readComputerUseState(value);
  if (!next) return false;
  state = next;
  notify();
  return true;
}

export function clearComputerUseState(): void {
  if (!state) return;
  state = null;
  notify();
}

export function computerUseStateSnapshot(): ComputerUseStateSnapshot | null {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Why this chat's computer use call waits, or null when it does not. */
export function useComputerUseWaitText(
  conversationId: string | null | undefined,
): string | null {
  const getSnapshot = useCallback(
    () => (conversationId ? computerUseWaitText(state, conversationId) : null),
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
