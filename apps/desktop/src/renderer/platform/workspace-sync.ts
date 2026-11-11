import { useSyncExternalStore } from "react";
import { WORKSPACE_SYNC_STATUS_EVENT, type WorkspaceSyncStatus } from "../../../shared/workspace-sync";
import { isElectron, nativeInvoke, nativeListen } from "./runtime";

/** Order 3: this Mac's sync statuses, as main publishes them. The renderer
 * never sees a folder path; main owns the folder, the files and the panel. */
let statuses: readonly WorkspaceSyncStatus[] = [];
const listeners = new Set<() => void>();
let started: Promise<() => void> | null = null;
// Anything but a list is no statuses: an older main, a harness or a failed read answers nothing.
const accept = (next: unknown) => { statuses = Array.isArray(next) ? next as WorkspaceSyncStatus[] : []; for (const listener of listeners) listener(); };
export const workspaceSyncStatusFor = (workspaceId: string | null): WorkspaceSyncStatus | null =>
  (workspaceId ? statuses.find(status => status.workspaceId === workspaceId) : undefined) ?? null;

export function startWorkspaceSyncStatus(): () => void {
  if (!isElectron()) return () => {};
  started ??= nativeListen<unknown>(WORKSPACE_SYNC_STATUS_EVENT, accept).then(stop => {
    void nativeInvoke<unknown>("workspace_sync_statuses").then(accept, () => {});
    return stop;
  });
  return () => { void started?.then(stop => stop()); started = null; };
}

export function useWorkspaceSyncStatus(workspaceId: string | null): WorkspaceSyncStatus | null {
  const read = () => workspaceSyncStatusFor(workspaceId);
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read);
}

export type ChooseSyncResult = { ok: true } | { ok: false; reason: string };
export const chooseWorkspaceSyncFolder = (workspaceId: string) => nativeInvoke<ChooseSyncResult>("workspace_sync_choose", { workspaceId });
export const stopWorkspaceSync = (workspaceId: string) => nativeInvoke<boolean>("workspace_sync_stop", { workspaceId });
/** 12.z: the switch on, in ~/zeros/cloud-sync/<repository>/<workspace> (main builds and checks the folder). */
export const enableWorkspaceSync = (workspaceId: string, labels: { repository: string; workspace: string }) =>
  nativeInvoke<ChooseSyncResult>("workspace_sync_enable", { workspaceId, ...labels });
export const revealWorkspaceSyncFolder = (workspaceId: string) => nativeInvoke<boolean>("workspace_sync_reveal", { workspaceId });
/** 12.z: another of this person's Macs should (not) sync this workspace. */
export const setWorkspaceSyncWanted = (workspaceId: string, deviceId: string, wanted: boolean) =>
  nativeInvoke<{ ok: boolean; reason?: string }>("workspace_sync_set_wanted", { workspaceId, deviceId, wanted });
export const openWorkspaceSyncTerminal = (workspaceId: string) => nativeInvoke<boolean>("workspace_sync_open_terminal", { workspaceId });

/** The popup's words for a status (Off is no status). */
export function workspaceSyncLabel(status: WorkspaceSyncStatus): string {
  if (status.state === "syncing") return status.files ? `Syncing (${status.files} ${status.files === 1 ? "file" : "files"})` : "Syncing";
  if (status.state === "in_sync") {
    // Files are in step; a clone that could not update says so (Git LFS is not handled in v1).
    const git = status.reason === "git_missing" ? " · Git not installed" : status.reason === "git_failed" ? " · Git history pending" : "";
    return `${status.problems ? `In sync · ${status.problems} not mirrored` : "In sync"}${git}`;
  }
  // Running but not reachable is not asleep: its own words while main retries (with a growing wait).
  if (status.state === "paused") return status.reason === "unreachable" ? "Can't reach the workspace, retrying" : "Paused (workspace asleep)";
  return `Error (${SYNC_REASONS[status.reason ?? ""] ?? "sync failed"})`;
}
const SYNC_REASONS: Record<string, string> = {
  too_many_files: "more than 200,000 files", too_many_bytes: "more than 5 GB", update_required: "restart the workspace to update it",
  folder_not_directory: "folder missing", folder_not_empty: "folder not empty", folder_other_workspace: "folder belongs to another workspace",
  folder_unsafe_root: "folder not usable", write_failed: "could not write files", not_connected: "connect this Mac",
  unreachable: "can't reach the workspace",
};
/** Why a chosen folder was refused, for a toast. */
export const SYNC_CHOOSE_ERRORS: Record<string, string> = {
  not_empty: "Choose an empty folder, or this workspace's earlier sync folder.", other_workspace: "That folder syncs another workspace.",
  not_directory: "That folder is not available.", unsafe_root: "That folder can't be used for sync.", unavailable: "Sync isn't available in this version.",
  failed: "Couldn't start sync. Try again.",
};
export function resetWorkspaceSyncForTests(next: readonly WorkspaceSyncStatus[] = []): void { accept(next); }
