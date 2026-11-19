
import type { Workspace } from "../git";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "./cloud-workspace-key";
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
  const cloud = parseCloudWorkspaceKey(cwd);
  if (cloud) return cloudWorkspaceKey(cloud);
  const cached = workspaceIdForCwd(cwd, lookupFor(bridge).rows);
  if (cached) return cached;
  const fresh = await refillBridgeWorkspaces(bridge);
  return workspaceIdForCwd(cwd, fresh);
}

/** The env vault fallback needs the main checkout's root, not the linked worktree root. */
export async function resolveBridgeRepoRootForCwd(
  bridge: RuntimeClient,
  cwd: string | null | undefined,
): Promise<string | null> {
  const cached = repoRootForCwd(cwd, lookupFor(bridge).rows);
  if (cached) return cached;
  const fresh = await refillBridgeWorkspaces(bridge);
  return repoRootForCwd(cwd, fresh);
}
