import {
  isCloudWorkspacePageOwner,
  type CloudWorkspaceLink,
  type OrganizationWorkspaceLink,
} from "@zeros/protocol/cloud-workspace-link";
import type { WorkspaceAddress } from "@zeros/protocol/local-orchestration";
import { isFeatureEnabled } from "../config/release-channel";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { cloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { ControlPlaneError } from "../features/team/control-plane";
import { getActiveOrganizationSnapshot, getTeamStoreState } from "../features/team/team-store";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../platform/bridge/cloud-workspace-key";
import { toast } from "../shared/ui/primitives/elements";
import { selectCloudChatWhenLoaded } from "../state/cloud-chat-link-selection";
import {
  canReadCloudWorkspace,
  cloudWorkspaceDocumentByNumber,
  getCloudWorkspaceRows,
  readCloudWorkspaceByNumber,
  refreshCloudWorkspace,
} from "../state/cloud-workspace-catalog";
import type { WorkspaceNavigationTarget } from "./prefetch-workspace-surface";

export type CloudNavigationLink = CloudWorkspaceLink | OrganizationWorkspaceLink;

const WORKSPACE_UNAVAILABLE = "You don't have access to that cloud workspace.";
const CHAT_UNAVAILABLE = "You don't have access to that chat.";
const FAILED = "Couldn't open that cloud workspace. Try again in a moment.";

/** Opens a cloud workspace link (or a chat in one) from the web workspace page
 * or a copied link: an exact read as the signed-in account (the control plane
 * answers only the creator), then the switcher's organization change and the
 * sidebar's open. A stopped workspace wakes and an archived one opens
 * read-only, as from the sidebar. An account without access sees an error. */
export async function navigateCloudWorkspaceLink(
  link: CloudNavigationLink,
  options: {
    openWorkspace: (workspace: WorkspaceNavigationTarget) => void;
    current: () => boolean;
    beforeCommit: () => void;
  },
): Promise<void> {
  const { current } = options;
  const session = link.kind === "chat" ? link.id : null;
  const unavailable = session ? CHAT_UNAVAILABLE : WORKSPACE_UNAVAILABLE;
  if (!isFeatureEnabled("cloud-workspaces")) {
    toast.info("Cloud workspaces aren't available in this version of Zeros.");
    return;
  }
  const me = getTeamStoreState().me;
  if (!me) {
    toast.error(FAILED);
    return;
  }
  // Only an organization in the switcher can become active. A numbered link
  // names it by its ID, which never changes.
  const organizations = me.organizations ?? me.teams ?? [];
  const organization = link.kind === "cloud-workspace"
    ? organizations.find((candidate) => candidate.id === link.organizationId)
    : isCloudWorkspacePageOwner(link.address.owner)
      ? organizations.find((candidate) =>
          !candidate.isPersonal && candidate.slug?.toLowerCase() === link.address.owner)
      : undefined;
  if (!organization || organization.isPersonal) {
    toast.error(unavailable);
    return;
  }
  const name = organization.name.trim() || "this organization";
  if (!cloudWorkspaceAccountAccess(me, organization.id)) {
    toast.error(`Cloud workspaces aren't available in ${name}.`);
    return;
  }
  let target: CloudWorkspaceTarget;
  try {
    target = link.kind === "cloud-workspace"
      ? { organizationId: link.organizationId, workspaceId: link.workspaceId }
      : await numberedTarget(organization.id, link.address);
  } catch (error) {
    if (!current()) return;
    if (error instanceof ControlPlaneError && (error.status === 404 || error.status === 403)) toast.error(unavailable);
    else if (error instanceof WrongOrganizationError) toast.error(unavailable);
    else toast.error(FAILED);
    return;
  }
  if (!current()) return;
  let doc;
  try {
    doc = await refreshCloudWorkspace(target);
  } catch (error) {
    if (!current()) return;
    if (error instanceof ControlPlaneError && error.status === 404) toast.error(unavailable);
    else toast.error(FAILED);
    return;
  }
  if (!current()) return;
  if (!canReadCloudWorkspace(doc)) {
    toast.error(unavailable);
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
    if (session) selectCloudChatWhenLoaded(key, cloudScopedId(target, session));
  } catch {
    toast.error(FAILED);
  }
}

class WrongOrganizationError extends Error {}

/** The loaded catalog answers first; otherwise the control plane resolves the
 * address for this account. */
async function numberedTarget(
  organizationId: string,
  address: WorkspaceAddress,
): Promise<CloudWorkspaceTarget> {
  const loaded = cloudWorkspaceDocumentByNumber(organizationId, address.number);
  if (loaded) return { organizationId, workspaceId: loaded.id };
  const doc = await readCloudWorkspaceByNumber(address);
  if (doc.organizationId !== organizationId || doc.number !== address.number)
    throw new WrongOrganizationError("Cloud workspace belongs to another organization");
  return { organizationId, workspaceId: doc.id };
}
