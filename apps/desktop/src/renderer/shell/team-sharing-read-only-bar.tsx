import { useSyncExternalStore } from "react";
import { Eye } from "lucide-react";
import { ComposerReplacementBar } from "./composer-replacement-bar";
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
    <ComposerReplacementBar
      icon={<Eye className="text-fg2 size-4 shrink-0" aria-hidden="true" />}
      message={`Read only. ${memberName(roster, creator)} runs this workspace.`}
      cardProps={{ "data-team-sharing-read-only": "" }}
    />
  );
}
