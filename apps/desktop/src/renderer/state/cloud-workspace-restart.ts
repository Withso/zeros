import { hasCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { cloudWorkspaceKey, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import {
  canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument,
  cloudWorkspaceLifecycleTask, manageCloudWorkspace, waitForCloudWorkspaceLifecycle,
} from "./cloud-workspace-catalog";
import { publishCloudWorkspaceRestartPhase } from "./cloud-workspace-restart-status";
import { wakeCloudWorkspace } from "./cloud-workspace-wake";
import { clearWorkbenchConnectionFailure, reconnectWorkbenchWorkspace, recordWorkbenchConnectionFailure } from "./workbench-availability";

export function cloudWorkspaceRestartVisible(folder: string, workspace: CloudWorkspaceDocument | undefined): boolean {
  const target = parseCloudWorkspaceKey(folder);
  return !!target && workspace?.placement === "cloud" &&
    workspace.id === target.workspaceId && workspace.organizationId === target.organizationId &&
    canReadCloudWorkspace(workspace) && !["archiving", "archived"].includes(workspace.status);
}

const flights = new Map<string, Promise<void>>();

/** Explicit Stop (final checkpoint), then a fresh explicit wake and normal
 * admission. Reuses catalog idempotency and readiness; never persists intent. */
export function restartCloudWorkspace(workspace: CloudWorkspaceTarget | string): Promise<void> {
  const folder = typeof workspace === "string" ? workspace : cloudWorkspaceKey(workspace);
  const target = parseCloudWorkspaceKey(folder);
  const initial = target ? cloudWorkspaceDocument(target) : undefined;
  if (!target || !cloudWorkspaceRestartVisible(folder, initial))
    return Promise.reject(new Error("This cloud workspace cannot be restarted"));
  if (!hasCloudWorkspaceAccountAccess(target.organizationId) || !initial!.capabilities.canWrite)
    return Promise.reject(new Error("Workspace run access is required to restart it"));
  const owner = cloudWorkspaceKey(target);
  const account = cloudCatalogGeneration();
  const key = `${account}:${owner}`;
  const pending = flights.get(key);
  if (pending) return pending;
  if (flights.size >= 128) return Promise.reject(new Error("Too many workspace restarts"));
  let generation = initial!.generation.number;
  const assertCurrent = () => {
    if (account !== cloudCatalogGeneration()) throw new Error("Cloud account changed while restarting");
    const current = cloudWorkspaceDocument(target);
    if (!cloudWorkspaceRestartVisible(owner, current) || current!.generation.number !== generation)
      throw new Error("Cloud workspace generation or access changed while restarting");
    if (!hasCloudWorkspaceAccountAccess(target.organizationId) || !current!.capabilities.canWrite)
      throw new Error("Workspace run access changed while restarting");
    return current!;
  };
  const phase = (next: Parameters<typeof publishCloudWorkspaceRestartPhase>[2]) =>
    publishCloudWorkspaceRestartPhase(owner, account, next);
  phase("stopping");
  const task = Promise.resolve().then(async () => {
    let current = assertCurrent();
    const stop = cloudWorkspaceLifecycleTask(target, "stop");
    const waking = !stop && (cloudWorkspaceLifecycleTask(target, "wake") ||
      ["waking", "starting", "provisioning", "setting_up"].includes(current.status));
    if (!waking) {
      if (current.status !== "stopped") {
        await (current.status === "stopping" && !stop
          ? waitForCloudWorkspaceLifecycle(target, "stop", current)
          : manageCloudWorkspace(target, "stop", true));
        current = assertCurrent();
      }
      if (current.status !== "stopped") throw new Error("Cloud workspace has not finished stopping");
      phase("stopped");
    }
    // IW2's explicit-Stop revision must be captured here, after the final
    // checkpoint. This wake is a new explicit action, never an older input wake.
    phase("waking");
    const ready = await wakeCloudWorkspace(target, assertCurrent());
    // Wake owns forward replacements (and server rollback) within this user
    // intent. Normal admission must use the generation it confirmed ready.
    generation = ready.generation.number;
    assertCurrent();
    phase("connecting");
    await reconnectWorkbenchWorkspace(owner);
    assertCurrent();
    clearWorkbenchConnectionFailure(owner);
  }).catch(error => {
    phase(null);
    // One shared action reports once through the normal visible-banner / hidden-
    // toast rule. Account/access retirement must not notify a replacement owner.
    if (account === cloudCatalogGeneration() && cloudWorkspaceRestartVisible(owner, cloudWorkspaceDocument(target)))
      recordWorkbenchConnectionFailure(owner, error, "restart");
    throw error;
  }).finally(() => {
    if (flights.get(key) === task) flights.delete(key);
    phase(null);
  });
  flights.set(key, task);
  return task;
}
