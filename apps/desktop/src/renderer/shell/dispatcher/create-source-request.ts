// ──────────────────────────────────────────────────────────
// Create-from-source request — a one-shot "open the source picker" intent
// ──────────────────────────────────────────────────────────
//
// A repository's "Create from…" action routes to Create for that repository
// AND asks its source picker to open. The route and project publish through
// OPEN_CREATE_PAGE; this module carries only the ephemeral picker intent, which
// is dialog state and therefore never persisted. The Create page consumes it
// once the requested repository is selected, or drops it when the page shows
// a different (or removed) repository.

import { useSyncExternalStore } from "react";

export interface CreateFromSourceRequest {
  /** Stable project id the picker should open for. */
  projectId: string;
  /** Monotonic identity, so a repeated request re-opens the picker. */
  id: number;
}

let current: CreateFromSourceRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the Create page to open its source picker for `projectId`. Publish it
 * immediately before the navigation that shows that project. */
export function requestCreateFromSource(projectId: string): void {
  if (!projectId) return;
  current = { projectId, id: ++nextId };
  emit();
}

/** Settle one request. A newer request is left untouched. */
export function consumeCreateFromSourceRequest(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

export function peekCreateFromSourceRequest(): CreateFromSourceRequest | null {
  return current;
}

export function useCreateFromSourceRequest(): CreateFromSourceRequest | null {
  return useSyncExternalStore(
    subscribe,
    peekCreateFromSourceRequest,
    () => null,
  );
}

/** What the Create page should do with a pending request right now. It waits
 * while the routed repository is still being selected; it opens only when the
 * selection is the requested repository; anything else is a stale request. */
export function resolveCreateFromSourceRequest(args: {
  request: CreateFromSourceRequest;
  routedProjectId: string | null | undefined;
  selectedProjectId: string | null;
  projectIds: readonly string[];
  sourceAvailable: boolean;
}): "open" | "wait" | "drop" {
  const { request } = args;
  if (!args.projectIds.includes(request.projectId)) return "drop";
  if (args.routedProjectId !== request.projectId) return "drop";
  if (args.selectedProjectId !== request.projectId) return "wait";
  return args.sourceAvailable ? "open" : "drop";
}

/** Test-only reset for the module singleton. */
export function resetCreateFromSourceRequestForTests(): void {
  current = null;
  nextId = 0;
  listeners.clear();
}
