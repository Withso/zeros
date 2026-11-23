import { useCallback, useSyncExternalStore } from "react";
import { registerPrWorkspaceCacheForget } from "@/renderer/shell/pr/pr-cache-forget";

/** Comments a person hid from the Overview list, per workspace and pull
 *  request. Hiding is a local view preference; GitHub is never told. */
const MAX_HIDDEN = 500;
const EMPTY: ReadonlySet<string> = new Set();
const cache = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();

const PREFIX = "zeros.review.hidden-comments.";

function storageKey(owner: string, prNumber: number): string {
  return `${PREFIX}${JSON.stringify([owner, prNumber])}`;
}

/** A deleted workspace's hidden comments can never be shown again. */
export function forgetHiddenReviewComments(owner: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const [stored] = JSON.parse(key.slice(PREFIX.length)) as [unknown];
        if (stored === owner) keys.push(key);
      } catch {
        // Not ours to interpret.
      }
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
      cache.delete(key);
      for (const listener of listeners.get(key) ?? []) listener();
    }
  } catch {
    // Storage unavailable: nothing was persisted.
  }
}
registerPrWorkspaceCacheForget(forgetHiddenReviewComments);

function read(key: string): ReadonlySet<string> {
  const cached = cache.get(key);
  if (cached) return cached;
  let value: ReadonlySet<string> = EMPTY;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (Array.isArray(parsed))
      value = new Set(
        parsed.filter((entry): entry is string => typeof entry === "string").slice(-MAX_HIDDEN),
      );
  } catch {
    value = EMPTY;
  }
  cache.set(key, value);
  return value;
}

export function setReviewCommentHidden(
  owner: string,
  prNumber: number,
  commentKey: string,
  hidden: boolean,
): void {
  const key = storageKey(owner, prNumber);
  const next = new Set(read(key));
  if (hidden === next.has(commentKey)) return;
  if (hidden) next.add(commentKey);
  else next.delete(commentKey);
  // Oldest entries go first once the bound is reached.
  const bounded = new Set([...next].slice(-MAX_HIDDEN));
  cache.set(key, bounded);
  try {
    if (bounded.size) window.localStorage.setItem(key, JSON.stringify([...bounded]));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage is a convenience; the row stays hidden for this session.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useHiddenReviewComments(
  owner: string,
  prNumber: number,
): ReadonlySet<string> {
  const key = storageKey(owner, prNumber);
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    [key],
  );
  const snapshot = useCallback(() => read(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
