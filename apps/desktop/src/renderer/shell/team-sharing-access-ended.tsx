import { useSyncExternalStore } from "react";
import { Lock } from "lucide-react";
import { EmptyState } from "../shared/ui/layout/empty-state";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { subscribeWorkspaceAccessEnded, workspaceAccessEnded } from "../platform/team-sharing-registry";

/** Team sharing phase 3 (3A): THIS account lost access to the open workspace (D3: exact account, organization and workspace). */
export function useWorkspaceAccessEnded(folder: string | null | undefined): boolean {
  const target = parseCloudWorkspaceKey(folder);
  // The registry reads the CURRENT account session on every render (an account switch re-renders the app).
  const read = () => !!target && workspaceAccessEnded(target);
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
