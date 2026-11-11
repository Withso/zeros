/** Main -> renderer: every workspace this Mac mirrors, with its state. */
export const WORKSPACE_SYNC_STATUS_EVENT = "workspace-sync:status";

/** Off is the absence of a status. Paused: the workspace is asleep. */
export interface WorkspaceSyncStatus {
  workspaceId: string;
  state: "syncing" | "in_sync" | "paused" | "error";
  /** Files still to write in this cycle. */
  files?: number;
  /** A closed code: too_many_files, too_many_bytes, update_required, folder_*, write_failed. */
  reason?: string;
  /** Paths not mirrored (skipped by the cloud or refused here). */
  problems: number;
  /** 12.z: This Mac's own folder, for the popup's path field; main adds it, never the server. */
  folder?: string;
}
