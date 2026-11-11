import { useSyncExternalStore } from "react";
import { Eye } from "lucide-react";
import { cn } from "../shared/ui/cn";
import { DOCK_CARD_CLS } from "../features/agent/composer-shell";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../state/cloud-workspace-catalog";
import { memberName, useOrganizationRoster } from "../state/organization-roster";

/** Team sharing: in place of the composer for a teammate's workspace. */
export function TeamSharingReadOnlyBar({ folder, surfaceActive }: { folder: string; surfaceActive: boolean }) {
  const target = parseCloudWorkspaceKey(folder);
  const read = () => (target ? cloudWorkspaceDocument(target)?.ownerUserId ?? null : null);
  const creator = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  const roster = useOrganizationRoster(target?.organizationId, surfaceActive);
  return (
    <div className="mx-auto w-full max-w-(--chat-column) shrink-0 px-7 pt-2 pb-4">
      <div className={cn(DOCK_CARD_CLS, "flex items-center gap-3 px-3.5 py-3")} role="status" data-team-sharing-read-only="">
        <Eye className="text-fg2 size-4 shrink-0" aria-hidden="true" />
        <p className="text-fg2 min-w-0 flex-1 text-sm">
          {`Read only. ${memberName(roster, creator)} runs this workspace.`}
        </p>
      </div>
    </div>
  );
}
