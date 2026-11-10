import { useSyncExternalStore } from "react";
import { isCloudWorkspacePageOwner } from "@zeros/protocol/cloud-workspace-link";
import { isWorkspaceLinkSession, isWorkspaceNumber } from "@zeros/protocol/local-orchestration";
import { useCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import {
  APP_BASE_URL,
  cloudWorkspacePageUrl,
  numberedCloudWorkspacePageUrl,
} from "../features/team/organization-links";
import { getTeamStoreState, subscribeOrganizationSnapshots } from "../features/team/team-store";
import {
  parseCloudScopedId,
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

type AccountSnapshot = ReturnType<typeof getTeamStoreState>["me"];
const readAccount = (): AccountSnapshot => getTeamStoreState().me;

/** The organization's ID (slug), the owner segment of its workspaces' pages. */
function organizationSlug(organizationId: string, me: AccountSnapshot = getTeamStoreState().me): string | null {
  const slug = (me?.organizations ?? me?.teams ?? []).find(
    (organization) => organization.id === organizationId && !organization.isPersonal,
  )?.slug?.toLowerCase();
  return isCloudWorkspacePageOwner(slug) ? slug : null;
}

/** The chat's own id when it is a chat of this cloud workspace. */
function cloudChatSession(target: CloudWorkspaceTarget, chatId: string): string | null {
  let scoped;
  try {
    scoped = parseCloudScopedId(chatId);
  } catch {
    return null;
  }
  return scoped &&
    scoped.organizationId === target.organizationId &&
    scoped.workspaceId === target.workspaceId &&
    isWorkspaceLinkSession(scoped.id)
    ? scoped.id
    : null;
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

/** `<app>/<organization slug>/w/<n>?session=<chat id>`. A chat link needs the
 * workspace's number and its organization's ID; there is no id-page form. */
export function cloudChatShareUrl(
  workspace: Pick<Workspace, "number">,
  target: CloudWorkspaceTarget,
  chatId: string,
): string | null {
  const owner = organizationSlug(target.organizationId);
  const session = cloudChatSession(target, chatId);
  return owner && session && isWorkspaceNumber(workspace.number)
    ? numberedCloudWorkspacePageUrl(APP_BASE_URL, { owner, number: workspace.number }, session)
    : null;
}

/** A cloud chat tab offers Copy link once its workspace has a number and its
 * organization's ID is known. */
export function useCanCopyCloudChatLink(workspace: Workspace | null): boolean {
  const canCopy = useCanCopyCloudWorkspaceLink(workspace);
  const me = useSyncExternalStore(subscribeOrganizationSnapshots, readAccount, readAccount);
  const target = cloudTarget(workspace);
  return canCopy && target !== null && isWorkspaceNumber(workspace?.number) &&
    organizationSlug(target.organizationId, me) !== null;
}

export function isCloudChatOfWorkspace(workspace: Workspace | null, chatId: string): boolean {
  const target = cloudTarget(workspace);
  return target !== null && cloudChatSession(target, chatId) !== null;
}

/** Copies the chat's web page: it opens Zeros at this chat, which the control
 * plane shows only to the workspace's creator. */
export async function copyCloudChatLink(workspace: Workspace, chatId: string): Promise<void> {
  const target = cloudTarget(workspace);
  const url = target ? cloudChatShareUrl(workspace, target, chatId) : null;
  if (!url) {
    toast.error("Couldn't copy the link. Try again in a moment.");
    return;
  }
  if (await copyToClipboardWithFallback(url)) toast.success("Link copied.");
  else toast.error("Couldn't write to the clipboard — focus the app and retry.");
}

/** Copies the web page, not the desktop link: it opens on any device, opens
 * Zeros, and the control plane shows it only to the creator. */
export async function copyCloudWorkspaceLink(workspace: Workspace): Promise<void> {
  const target = cloudTarget(workspace);
  if (!target) return;
  const copied = await copyToClipboardWithFallback(
    cloudWorkspaceShareUrl(workspace, target),
  );
  if (copied) toast.success("Link copied.");
  else toast.error("Couldn't write to the clipboard — focus the app and retry.");
}
