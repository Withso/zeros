import { useSyncExternalStore } from "react";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { Badge } from "../../shared/ui/primitives/badge";
import { useInternalFeatureActive } from "./internal-features";

export function CloudComputerAdminBadge({ folder }: { folder: string }) {
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const target = parseCloudWorkspaceKey(folder);
  const snapshot = () =>
    authorized && target
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
