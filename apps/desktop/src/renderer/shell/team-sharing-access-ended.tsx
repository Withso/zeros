import { useSyncExternalStore } from "react";
import { Lock } from "lucide-react";
import { EmptyState } from "../shared/ui/layout/empty-state";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { subscribeWorkspaceAccessEnded, workspaceAccessEnded } from "../platform/team-sharing-registry";

/** Team sharing phase 3 (3A): this person lost access to the open workspace. */
export function useWorkspaceAccessEnded(folder: string | null | undefined): boolean {
  const workspaceId = parseCloudWorkspaceKey(folder)?.workspaceId;
  const read = () => !!workspaceId && workspaceAccessEnded(workspaceId);
  return useSyncExternalStore(subscribeWorkspaceAccessEnded, read, read);
}

/** In place of the workspace's chats and tools. Drafts stay on this Mac, and so do any synced files. */
export function TeamSharingAccessEnded({ name }: { name: string }) {
  return (
    <EmptyState icon={Lock} title={`You no longer have access to ${name}`} role="status" data-team-sharing-access-ended="">
      Its chats, terminals and sync are closed for you. Your drafts stay on this Mac.
    </EmptyState>
  );
}
