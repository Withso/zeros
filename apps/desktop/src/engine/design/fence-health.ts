import path from "node:path";

import { getWorkspaceByPath, setWorkspaceMeta } from "../git/state";

/** Historical health marker retained while ACL cleanup rolls through existing
 * workspaces. It contains no raw chmod output or file names: those can disclose
 * repo contents and belong in local logs, not durable/sync-adjacent metadata. */
export const DESIGN_FENCE_HEALTH_META_KEY = "design.fence.health.v1";

type DesignFenceHealth =
  | { schemaVersion: 1; state: "healthy"; checkedAt: number }
  | { schemaVersion: 1; state: "failed"; checkedAt: number };

export interface DesignFenceStartBlock {
  code: "DESIGN_FENCE_UNAVAILABLE" | "DESIGN_FENCE_STATE_INVALID";
  message: string;
  remediation: string;
}

function workspaceIdForPath(workspacePath: string): string | null {
  return getWorkspaceByPath(path.resolve(workspacePath))?.id ?? null;
}

function writeHealth(
  workspacePath: string,
  state: DesignFenceHealth["state"],
): void {
  const workspaceId = workspaceIdForPath(workspacePath);
  if (!workspaceId) return;
  const health: DesignFenceHealth = {
    schemaVersion: 1,
    state,
    checkedAt: Date.now(),
  };
  setWorkspaceMeta(
    workspaceId,
    DESIGN_FENCE_HEALTH_META_KEY,
    JSON.stringify(health),
  );
}

/** Record a legacy ACL cleanup failure for diagnostics/retry. */
export function recordDesignFenceFailure(
  workspacePath: string,
  _error: unknown,
): void {
  writeHealth(workspacePath, "failed");
}

/** Record that no historical ACL cleanup failure remains. */
export function clearDesignFenceFailure(workspacePath: string): void {
  writeHealth(workspacePath, "healthy");
}

/** Compatibility seam for health records written by ACL-fencing builds.
 *
 * Persistent ACLs were retired because they apply to the shared checkout and
 * therefore constrain unrelated same-user applications. They are not part of
 * Zeros' code-agent containment proof, so stale or malformed historical
 * records must never block an agent, terminal, setup, or run. Provider sandbox
 * admission and engine write authorization now own that decision. */
export function designFenceStartBlock(
  _workspaceId: string,
): DesignFenceStartBlock | null {
  return null;
}
