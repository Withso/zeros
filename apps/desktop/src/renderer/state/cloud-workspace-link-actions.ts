import { isCloudWorkspacePageOwner } from "@zeros/protocol/cloud-workspace-link";
import { isWorkspaceNumber } from "@zeros/protocol/local-orchestration";
import { useCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import {
  APP_BASE_URL,
  cloudWorkspacePageUrl,
  numberedCloudWorkspacePageUrl,
} from "../features/team/organization-links";
import { getTeamStoreState } from "../features/team/team-store";
import {
  parseCloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../platform/bridge/cloud-workspace-key";
import type { Workspace } from "../platform/git";
import { copyToClipboardWithFallback } from "../shared/lib/clipboard";
import { toast } from "../shared/ui/primitives/elements";

function cloudTarget(workspace: Pick<Workspace, "path"> | null): CloudWorkspaceTarget | null {
  try {
    const target = workspace ? parseCloudWorkspaceKey(workspace.path) : null;
    return target && target.relativePath === "" ? target : null;
  } catch {
    return null;
  }
}

export function useCanCopyCloudWorkspaceLink(workspace: Workspace | null): boolean {
  const target = cloudTarget(workspace);
  const access = useCloudWorkspaceAccountAccess(target?.organizationId);
  return target !== null && access;
}

/** The organization's slug, the owner segment of its workspaces' pages. */
function organizationSlug(organizationId: string): string | null {
  const me = getTeamStoreState().me;
  const slug = (me?.organizations ?? me?.teams ?? []).find(
    (organization) => organization.id === organizationId && !organization.isPersonal,
  )?.slug?.toLowerCase();
  return isCloudWorkspacePageOwner(slug) ? slug : null;
}

/** `<app>/<organization slug>/w/<n>`, or the id page while the number or the
 * organization's slug is not known yet (an older control plane). */
export function cloudWorkspaceShareUrl(
  workspace: Pick<Workspace, "number">,
  target: { organizationId: string; workspaceId: string },
): string {
  const owner = organizationSlug(target.organizationId);
  return owner && isWorkspaceNumber(workspace.number)
    ? numberedCloudWorkspacePageUrl(APP_BASE_URL, { owner, number: workspace.number })
    : cloudWorkspacePageUrl(APP_BASE_URL, target.workspaceId);
}

/** Copies the web page, not the desktop link: it opens on any device, offers
 * Open in Zeros, and the control plane shows it only to the creator. */
export async function copyCloudWorkspaceLink(workspace: Workspace): Promise<void> {
  const target = cloudTarget(workspace);
  if (!target) return;
  const copied = await copyToClipboardWithFallback(
    cloudWorkspaceShareUrl(workspace, target),
  );
  if (copied) toast.success("Link copied.");
  else toast.error("Couldn't write to the clipboard — focus the app and retry.");
}
