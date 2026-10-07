import { useSyncExternalStore } from "react";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { Badge } from "../../shared/ui/primitives/badge";

export function CloudComputerAdminBadge({ folder }: { folder: string }) {
  const target = parseCloudWorkspaceKey(folder);
  const snapshot = () =>
    target
      ? cloudWorkspaceDocument(target)?.adminWorkspace?.creatorUserId
      : undefined;
  const creator = useSyncExternalStore(
    subscribeCloudWorkspaces,
    snapshot,
    snapshot,
  );
  return creator ? (
    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 font-normal">
      Admin
    </Badge>
  ) : null;
}
