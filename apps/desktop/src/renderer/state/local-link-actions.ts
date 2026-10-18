import { formatLocalLink } from "@zeros/protocol/local-orchestration";
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
      formatLocalLink(scheme, chatId ? "chat" : "workspace", id),
    );
    if (copied) toast.success("Link copied.");
    else
      toast.error("Couldn't write to the clipboard — focus the app and retry.");
  } catch {
    if (allowed())
      toast.error("Couldn't copy the link. Try again in a moment.");
  }
}
