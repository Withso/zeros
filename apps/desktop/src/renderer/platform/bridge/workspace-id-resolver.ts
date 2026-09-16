// ──────────────────────────────────────────────────────────
// Bridge workspace-id resolver
// ──────────────────────────────────────────────────────────
//
// Renderer state commonly carries a cwd path because the desktop engine can
// trust local paths. Cloud clients, however, must send the engine's opaque
// workspace id. Keep a small bridge-backed workspace list so callers can map
// the primary checkout to `local-main` and managed worktree paths to their ids
// before dispatching workspace/agent requests.
// ──────────────────────────────────────────────────────────

import type { Workspace } from "../git";
import { runtimeExecutionKey, type RuntimeClient } from "./ws-client";
import { requestWorkspaceList } from "./workspace-bridge";
import {
  repoRootForCwd,
  workspaceIdForCwd,
  folderIsWithinRoot,
} from "../../state/workspace-resolution";

interface WorkspaceLookup {
  key: string;
  rows: Workspace[];
  pending: Promise<Workspace[]> | null;
}
const lookups = new WeakMap<RuntimeClient, WorkspaceLookup>();
function lookupFor(bridge: RuntimeClient): WorkspaceLookup {
  const key = bridge.executionIdentity
    ? runtimeExecutionKey(bridge.executionIdentity)
    : "local:sidecar";
  let lookup = lookups.get(bridge);
  if (!lookup || lookup.key !== key) {
    lookup = { key, rows: [], pending: null };
    lookups.set(bridge, lookup);
  }
  return lookup;
}

/** Synchronous ownership from the exact runtime's confirmed workspace rows. */
export function cachedBridgeWorkspaceRootForCwd(
  bridge: RuntimeClient,
  cwd: string,
): string | null {
  return (
    lookupFor(bridge)
      .rows.flatMap((row) => [row.path, row.repoRoot])
      .filter((root): root is string => !!root && folderIsWithinRoot(cwd, root))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

export async function refillBridgeWorkspaces(
  bridge: RuntimeClient,
): Promise<Workspace[]> {
  const lookup = lookupFor(bridge);
  if (!lookup.pending) {
    lookup.pending = requestWorkspaceList(bridge)
      .then((workspaces) => {
        lookup.rows = workspaces;
        return workspaces;
      })
      .finally(() => {
        lookup.pending = null;
      });
  }
  return lookup.pending;
}

export async function resolveBridgeWorkspaceIdForCwd(
  bridge: RuntimeClient,
  cwd: string | null | undefined,
): Promise<string | null> {
  const cached = workspaceIdForCwd(cwd, lookupFor(bridge).rows);
  if (cached) return cached;
  const fresh = await refillBridgeWorkspaces(bridge);
  return workspaceIdForCwd(cwd, fresh);
}

/** The MAIN-checkout repo root owning a cwd, via the bridge workspace list —
 *  the env-vault courier's fallback when the renderer projects cache can't
 *  place the cwd. Null when no workspace owns it. */
export async function resolveBridgeRepoRootForCwd(
  bridge: RuntimeClient,
  cwd: string | null | undefined,
): Promise<string | null> {
  const cached = repoRootForCwd(cwd, lookupFor(bridge).rows);
  if (cached) return cached;
  const fresh = await refillBridgeWorkspaces(bridge);
  return repoRootForCwd(cwd, fresh);
}
