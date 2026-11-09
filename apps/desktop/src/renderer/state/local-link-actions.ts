import {
  LOCAL_WORKSPACE_LINK_OWNER,
  formatLocalLink,
  formatWorkspaceLink,
  isWorkspaceNumber,
  type LocalLinkScheme,
} from "@zeros/protocol/local-orchestration";
import {
  useAgentControlFeatureActive,
  isAgentControlFeatureActive,
} from "../features/settings/agent-control-rollout";
import {
  useActiveOrganization,
  getActiveOrganizationIdSnapshot,
  getOrganizationStoreGeneration,
} from "../features/team/team-store";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { requestProjectList } from "../platform/bridge/workspace-bridge";
import type { Workspace } from "../platform/git";
import { resolveLocalLinkScheme } from "../platform/local-links";
import { copyToClipboardWithFallback } from "../shared/lib/clipboard";
import { toast } from "../shared/ui/primitives/elements";
import {
  isPersonalLocalLinkWorkspace,
  localLinkWorkspaceId,
} from "./local-link-scope";

export function useCanCopyLocalLink(workspace: Workspace | null): boolean {
  const enabled = useAgentControlFeatureActive("localOrchestration");
  const organization = useActiveOrganization();
  return (
    enabled &&
    (!organization || organization.isPersonal) &&
    getActiveOrganizationIdSnapshot() == null &&
    isPersonalLocalLinkWorkspace(workspace) &&
    getActiveBridge()?.executionIdentity.kind !== "cloud"
  );
}

/** A numbered workspace's link is `<scheme>://local/w/<n>`, and a chat in it
 * adds `?session=<chat id>`. A repository folder has no number and keeps its
 * `workspace/folder:<project>` and `chat/<id>` links. */
export function localLinkFor(
  scheme: LocalLinkScheme,
  workspace: Workspace,
  workspaceOrChatId: string,
  chatId?: string,
): string {
  if (workspace.id.startsWith("ws_") && isWorkspaceNumber(workspace.number))
    return formatWorkspaceLink(
      scheme,
      { owner: LOCAL_WORKSPACE_LINK_OWNER, number: workspace.number },
      chatId ?? null,
    );
  return formatLocalLink(scheme, chatId ? "chat" : "workspace", workspaceOrChatId);
}

export async function copyLocalLink(
  workspace: Workspace,
  chatId?: string,
): Promise<void> {
  const bridge = getActiveBridge();
  const generation = getOrganizationStoreGeneration();
  const allowed = () =>
    getActiveBridge() === bridge &&
    bridge?.executionIdentity.kind !== "cloud" &&
    getOrganizationStoreGeneration() === generation &&
    getActiveOrganizationIdSnapshot() == null &&
    isAgentControlFeatureActive("localOrchestration") &&
    isPersonalLocalLinkWorkspace(workspace);
  if (!allowed()) return;
  try {
    const scheme = await resolveLocalLinkScheme();
    let id = chatId ?? localLinkWorkspaceId(workspace, []);
    if (!id && bridge)
      id = localLinkWorkspaceId(workspace, await requestProjectList(bridge));
    if (!allowed()) return;
    if (!id) {
      toast.error("Couldn't find that workspace. Try again in a moment.");
      return;
    }
    const copied = await copyToClipboardWithFallback(
      localLinkFor(scheme, workspace, id, chatId),
    );
    if (copied) toast.success("Link copied.");
    else
      toast.error("Couldn't write to the clipboard — focus the app and retry.");
  } catch {
    if (allowed())
      toast.error("Couldn't copy the link. Try again in a moment.");
  }
}
