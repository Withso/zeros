import type { CloudWorkspaceLink } from "@zeros/protocol/cloud-workspace-link";
import { isFeatureEnabled } from "../config/release-channel";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { cloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { ControlPlaneError } from "../features/team/control-plane";
import { getActiveOrganizationSnapshot, getTeamStoreState } from "../features/team/team-store";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { toast } from "../shared/ui/primitives/elements";
import {
  canReadCloudWorkspace,
  getCloudWorkspaceRows,
  refreshCloudWorkspace,
} from "../state/cloud-workspace-catalog";
import type { WorkspaceNavigationTarget } from "./prefetch-workspace-surface";

const NOT_FOUND = "That cloud workspace couldn't be found.";
const FAILED = "Couldn't open that cloud workspace. Try again in a moment.";

/** Opens a zeros://cloud-workspace link from the web workspace page: an exact
 * read as the signed-in account (the control plane answers only the creator),
 * then the switcher's organization change and the sidebar's open. A stopped
 * workspace wakes and an archived one opens read-only, as from the sidebar. */
export async function navigateCloudWorkspaceLink(
  link: CloudWorkspaceLink,
  options: {
    openWorkspace: (workspace: WorkspaceNavigationTarget) => void;
    current: () => boolean;
    beforeCommit: () => void;
  },
): Promise<void> {
  const { current } = options;
  if (!isFeatureEnabled("cloud-workspaces")) {
    toast.info("Cloud workspaces aren't available in this version of Zeros.");
    return;
  }
  const me = getTeamStoreState().me;
  if (!me) {
    toast.error(FAILED);
    return;
  }
  // Only an organization in the switcher can become active.
  const organization = (me.organizations ?? me.teams ?? []).find(
    (candidate) => candidate.id === link.organizationId,
  );
  if (!organization || organization.isPersonal) {
    toast.info(NOT_FOUND);
    return;
  }
  const name = organization.name.trim() || "this organization";
  if (!cloudWorkspaceAccountAccess(me, organization.id)) {
    toast.info(`Cloud workspaces aren't available in ${name}.`);
    return;
  }
  const target = { organizationId: link.organizationId, workspaceId: link.workspaceId };
  let doc;
  try {
    doc = await refreshCloudWorkspace(target);
  } catch (error) {
    if (!current()) return;
    if (error instanceof ControlPlaneError && error.status === 404) toast.info(NOT_FOUND);
    else toast.error(FAILED);
    return;
  }
  if (!current()) return;
  if (!canReadCloudWorkspace(doc)) {
    toast.info(NOT_FOUND);
    return;
  }
  options.beforeCommit();
  try {
    setActiveOrganizationSelection(organization.id, false);
    if (getActiveOrganizationSnapshot()?.id !== organization.id) {
      toast.info(`Select ${name} to open this link.`);
      return;
    }
    const key = cloudWorkspaceKey(target);
    options.openWorkspace(
      getCloudWorkspaceRows().find((row) => row.path === key) ?? { path: key, repoRoot: key },
    );
  } catch {
    toast.error(FAILED);
  }
}
