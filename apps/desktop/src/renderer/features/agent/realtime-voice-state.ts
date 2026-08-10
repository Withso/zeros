import { useSyncExternalStore } from "react";

import type {
  RealtimeAudioUpdate,
  RealtimeStatusUpdate,
} from "../../platform/bridge/agent-events";

export interface CodexRealtimeStatus {
  status: "idle" | "active" | "closed" | "error";
  threadId: string | null;
  realtimeSessionId?: string;
  message?: string;
}

const IDLE: CodexRealtimeStatus = { status: "idle", threadId: null };
const statuses = new Map<string, CodexRealtimeStatus>();
const statusListeners = new Map<string, Set<() => void>>();
const audioListeners = new Map<
  string,
  Set<(update: RealtimeAudioUpdate) => void>
>();

export function publishCodexRealtimeUpdate(
  chatId: string,
  update: RealtimeStatusUpdate | RealtimeAudioUpdate,
): void {
  if (update.sessionUpdate === "realtime_audio") {
    for (const listener of audioListeners.get(chatId) ?? []) listener(update);
    return;
  }
  statuses.set(chatId, {
    status: update.status,
    threadId: update.threadId,
    ...(update.realtimeSessionId
      ? { realtimeSessionId: update.realtimeSessionId }
      : {}),
    ...(update.message ? { message: update.message } : {}),
  });
  for (const listener of statusListeners.get(chatId) ?? []) listener();
}

export function realtimeStatusSnapshot(chatId: string): CodexRealtimeStatus {
  return statuses.get(chatId) ?? IDLE;
}

export function subscribeCodexRealtimeAudio(
  chatId: string,
  listener: (update: RealtimeAudioUpdate) => void,
): () => void {
  const listeners = audioListeners.get(chatId) ?? new Set();
  listeners.add(listener);
  audioListeners.set(chatId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) audioListeners.delete(chatId);
  };
}

export function clearCodexRealtimeState(chatId: string): void {
  statuses.delete(chatId);
  audioListeners.delete(chatId);
  for (const listener of statusListeners.get(chatId) ?? []) listener();
}

export function clearAllCodexRealtimeState(): void {
  const chatIds = [...statusListeners.keys()];
  statuses.clear();
  audioListeners.clear();
  for (const chatId of chatIds) {
    for (const listener of statusListeners.get(chatId) ?? []) listener();
  }
}

export function useCodexRealtimeStatus(chatId: string): CodexRealtimeStatus {
  return useSyncExternalStore(
    (listener) => {
      const listeners = statusListeners.get(chatId) ?? new Set();
      listeners.add(listener);
      statusListeners.set(chatId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) statusListeners.delete(chatId);
      };
    },
    () => realtimeStatusSnapshot(chatId),
    () => IDLE,
  );
}
