import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../platform/settings";

const KEY = "repo-history-visible-v1";
const LIMIT = 256;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function read(): string[] {
  const stored = getSetting<unknown>(KEY, []);
  return Array.isArray(stored)
    ? Array.from(
        new Set(
          stored.filter(
            (id): id is string =>
              typeof id === "string" && id.length > 0 && id.length <= 512,
          ),
        ),
      ).slice(-LIMIT)
    : [];
}

export function repoHistoryVisible(projectId: string): boolean {
  return read().includes(projectId);
}

export function setRepoHistoryVisible(
  projectId: string,
  visible: boolean,
): void {
  if (!projectId || projectId.length > 512) return;
  const next = read().filter((id) => id !== projectId);
  if (visible) next.push(projectId);
  setSetting(KEY, next.slice(-LIMIT));
  for (const listener of listeners) listener();
}

export function forgetRepoHistoryPreference(projectId: string): void {
  setRepoHistoryVisible(projectId, false);
}

export function useRepoHistoryVisible(projectId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => repoHistoryVisible(projectId),
    () => false,
  );
}
