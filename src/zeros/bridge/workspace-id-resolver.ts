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

import type { Workspace } from "../../native/git";
import type { RuntimeClient } from "./ws-client";
import { requestWorkspaceList } from "./workspace-bridge";
import {
  repoRootForCwd,
  workspaceIdForCwd,
} from "../store/workspace-resolution";

let cachedBridgeWorkspaces: Workspace[] = [];
let inflightBridgeWorkspaces: Promise<Workspace[]> | null = null;

export async function refillBridgeWorkspaces(
  bridge: RuntimeClient,
): Promise<Workspace[]> {
  if (!inflightBridgeWorkspaces) {
    inflightBridgeWorkspaces = requestWorkspaceList(bridge)
      .then((workspaces) => {
        cachedBridgeWorkspaces = workspaces;
        return workspaces;
      })
      .finally(() => {
        inflightBridgeWorkspaces = null;
      });
  }
  return inflightBridgeWorkspaces;
}

export async function resolveBridgeWorkspaceIdForCwd(
  bridge: RuntimeClient,
  cwd: string | null | undefined,
): Promise<string | null> {
  const cached = workspaceIdForCwd(cwd, cachedBridgeWorkspaces);
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
  const cached = repoRootForCwd(cwd, cachedBridgeWorkspaces);
  if (cached) return cached;
  const fresh = await refillBridgeWorkspaces(bridge);
  return repoRootForCwd(cwd, fresh);
}
