// "Setup failed" on a sidebar row reports one event: the repository's setup
// command exited with an error. It goes away once the user has seen it (the
// Setup tab was on screen) or the workspace moved on (an agent started working,
// or another status took its place), and comes back only when setup fails
// again. The engine keeps setupState "failed" until setup passes, so the
// acknowledgement lives here, keyed by workspace id, and is dropped as soon as
// setup leaves "failed" so the next failure shows. Persisted so a relaunch does
// not resurrect a failure the user already dealt with.

import { useSyncExternalStore } from "react";

import { getSetting, setSetting } from "../platform/settings";

const KEY = "setup-failure-acknowledged-v1";
export const SETUP_FAILURE_ACKNOWLEDGED_LIMIT = 256;
const MAX_ID_LENGTH = 512;
const EMPTY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> | null = null;

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;

function current(): ReadonlySet<string> {
  if (snapshot) return snapshot;
  const stored = getSetting<unknown>(KEY, []);
  const ids = Array.isArray(stored) ? stored.filter(validId) : [];
  snapshot = ids.length ? new Set(ids.slice(-SETUP_FAILURE_ACKNOWLEDGED_LIMIT)) : EMPTY;
  return snapshot;
}

function write(next: readonly string[]): void {
  const bounded = next.slice(-SETUP_FAILURE_ACKNOWLEDGED_LIMIT);
  snapshot = bounded.length ? new Set(bounded) : EMPTY;
  setSetting(KEY, bounded);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setupFailureAcknowledged(workspaceId: string): boolean {
  return current().has(workspaceId);
}

export function acknowledgeSetupFailure(workspaceId: string): void {
  if (!validId(workspaceId) || current().has(workspaceId)) return;
  write([...current(), workspaceId]);
}

/** Setup left "failed" (it is running again, passed or stopped), so a later
 *  failure is news again. */
export function forgetSetupFailureAcknowledgement(workspaceId: string): void {
  if (!current().has(workspaceId)) return;
  write([...current()].filter((id) => id !== workspaceId));
}

/** Whether the row still reports its setup failure. */
export function setupFailureShown(
  workspace: { id: string; setupState?: string | null },
  acknowledged: boolean,
): boolean {
  return workspace.setupState === "failed" && !acknowledged;
}

/** Reconcile acknowledgements with what the workspaces and their chats now
 *  say: an acknowledgement outlives the failure it answered, and a running
 *  agent or any other status acknowledges a failure on its own. */
export function reconcileSetupFailureAcknowledgements(
  workspaces: readonly { id: string; setupState?: string | null }[],
  movedOn: (workspaceId: string) => boolean,
): void {
  const acknowledged = current();
  let next: string[] | null = null;
  for (const workspace of workspaces) {
    const has = acknowledged.has(workspace.id);
    if (workspace.setupState !== "failed") {
      if (has) (next ??= [...acknowledged]).splice(next.indexOf(workspace.id), 1);
    } else if (!has && movedOn(workspace.id)) {
      (next ??= [...acknowledged]).push(workspace.id);
    }
  }
  if (next) write(next);
}

export function useSetupFailureAcknowledged(workspaceId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current().has(workspaceId),
    () => false,
  );
}

/** Every acknowledged id, for list-level readers that need one subscription. */
export function useSetupFailureAcknowledgements(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}

export function resetSetupFailureAcknowledgementsForTests(): void {
  snapshot = null;
  listeners.clear();
}
