import { useCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { APP_BASE_URL, cloudWorkspacePageUrl } from "../features/team/organization-links";
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

/** Copies the web page, not the desktop link: it opens on any device, offers
 * Open in Zeros, and the control plane shows it only to the creator. */
export async function copyCloudWorkspaceLink(workspace: Workspace): Promise<void> {
  const target = cloudTarget(workspace);
  if (!target) return;
  const copied = await copyToClipboardWithFallback(
    cloudWorkspacePageUrl(APP_BASE_URL, target.workspaceId),
  );
  if (copied) toast.success("Link copied.");
  else toast.error("Couldn't write to the clipboard — focus the app and retry.");
}
