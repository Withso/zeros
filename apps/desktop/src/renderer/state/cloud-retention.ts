// Retention S3 in the app: Keep, from a cloud workspace's menu (on, it is never archived for inactivity), and
// the line each archived cloud workspace carries. Keep shows the server's answer only (no optimistic flip); a
// refusal says the server's sentence and rereads the row.
import { useSyncExternalStore } from "react";
import { ControlPlaneError } from "../features/team/control-plane";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspace-contract";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { setCloudWorkspaceKeep } from "../platform/cloud-workspaces";
import { toast } from "../shared/ui/primitives/elements";
import { cloudArchiveLine } from "../features/settings/cloud-retention-copy";
import { acceptCloudWorkspaceDocument, cloudWorkspaceDocument, refreshCloudWorkspace, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";

/** The document a folder's Keep item reads: only a cloud workspace from a server that runs retention, not
 * archived, and not read-only for this person (a team-sharing reader). The server still decides. */
export function cloudKeepDocument(folder: string | null | undefined): CloudWorkspaceDocument | null {
  const target = folder ? parseCloudWorkspaceKey(folder) : null;
  const doc = target ? cloudWorkspaceDocument(target) : undefined;
  // archiveReason exists only while archived: also covers an archive still stopping its machine.
  if (!doc?.retention || doc.status === "archived" || doc.retention.archiveReason || doc.sharing?.readOnly === true) return null;
  return doc;
}

export function useCloudKeepDocument(folder: string | null | undefined): CloudWorkspaceDocument | null {
  const read = () => cloudKeepDocument(folder);
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}

export async function setCloudWorkspaceKept(target: CloudWorkspaceTarget, keep: boolean): Promise<void> {
  try {
    acceptCloudWorkspaceDocument(await setCloudWorkspaceKeep(target, keep));
  } catch (error) {
    const failure = error instanceof ControlPlaneError ? error : null;
    if (failure?.code === "keep_refused_archived") toast.error(failure.message);
    else if (failure?.code === "workspace_deleting") toast.error("This workspace is being deleted.");
    else if (failure?.status === 429) toast.error("Too many changes to Keep.", { description: "Try again in a minute." });
    else if (failure?.status !== 404) toast.error(keep ? "Couldn't keep this workspace." : "Couldn't stop keeping this workspace.", { description: "Try again." });
    // The row may be stale (archived, deleted, or its server no longer runs retention): read it again.
    await refreshCloudWorkspace(target).catch(() => undefined);
  }
}

/** An archived cloud workspace's line (why, what opening it brings back, and when what goes), or null: a Local
 * workspace, one not archived, or a server without retention. A string, so the snapshot stays stable. */
export function cloudArchiveLineFor(folder: string | null | undefined, now = Date.now()): string | null {
  const target = folder ? parseCloudWorkspaceKey(folder) : null;
  const doc = target ? cloudWorkspaceDocument(target) : undefined;
  return doc ? cloudArchiveLine(doc.retention, doc.status === "archived" || !!doc.retention?.archiveReason, now) : null;
}

export function useCloudArchiveLine(folder: string | null | undefined): string | null {
  const read = () => cloudArchiveLineFor(folder);
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}
