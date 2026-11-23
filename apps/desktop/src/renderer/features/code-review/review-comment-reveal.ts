import { useSyncExternalStore } from "react";

/** One pending "show this comment" request from a composer pill or the
 *  Overview list. The Changes diff consumes it once the file is on screen. */
export interface ReviewCommentReveal {
  id: number;
  /** The Changes owner (workspace id) the request was opened in; another
   *  owner's diff never takes it, even for the same path. */
  owner: string;
  path: string;
  side: "old" | "new";
  line: number;
  at: number;
}

/** A request older than this was not followed by its file opening (the
 *  workspace changed, or the file left the comparison); drop it. */
const REVEAL_TTL_MS = 15_000;
let pending: ReviewCommentReveal | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

export function requestReviewCommentReveal(
  target: Omit<ReviewCommentReveal, "id" | "at">,
  now = Date.now(),
): void {
  pending = { ...target, id: ++sequence, at: now };
  for (const listener of listeners) listener();
}

export function consumeReviewCommentReveal(id: number): void {
  if (pending?.id !== id) return;
  pending = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live request, or null once it has expired. */
export function currentReviewCommentReveal(
  now = Date.now(),
): ReviewCommentReveal | null {
  return pending && now - pending.at <= REVEAL_TTL_MS ? pending : null;
}

export function useReviewCommentReveal(
  active: boolean,
): ReviewCommentReveal | null {
  const value = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
  return active && value && Date.now() - value.at <= REVEAL_TTL_MS ? value : null;
}
