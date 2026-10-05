import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import {
  acceptCloudWorkspaceDocument,
  canReadCloudWorkspace,
  cloudProjectForFolder,
  cloudWorkspaceDocument,
  getCloudWorkspaceRows,
} from "../../state/cloud-workspace-catalog";
import { spawnPreparedDefaultChat } from "../../state/spawn-default-chat";
import { useWorkspaceStore } from "../../state/workspace-store";
import { warmCloudWorkspaceDestination } from "../../state/cloud-workspace-warmup";
import { getActiveOrganizationSnapshot } from "../team/team-store";
import {
  canConfigureCloudComputerV2AdminWorkspace,
  loadCloudComputerV2,
} from "./cloud-computer-v2-client";

export function openCloudComputerV2AdminWorkspace(
  key: string,
  workspace: CloudWorkspaceDocument,
): boolean {
  const [user, org] = JSON.parse(key) as [string, string];
  if (
    !canConfigureCloudComputerV2AdminWorkspace(key) ||
    getActiveOrganizationSnapshot()?.id !== org ||
    workspace.organizationId !== org ||
    workspace.adminWorkspace?.creatorUserId !== user ||
    !canReadCloudWorkspace(workspace)
  )
    return false;
  acceptCloudWorkspaceDocument(workspace);
  const folder = cloudWorkspaceKey({
    organizationId: org,
    workspaceId: workspace.id,
  });
  const project = cloudProjectForFolder(folder);
  if (!project) return false;
  // The existing action publishes route, workspace and the new conversation
  // together. Admission/history hydration follow normal workspace lifecycle.
  spawnPreparedDefaultChat({
    folder,
    repoRoot: project.repoRoot,
    dispatch: useWorkspaceStore.getState().dispatch,
  });
  return true;
}

export function warmCloudComputerV2AdminWorkspace(key: string) {
  if (!canConfigureCloudComputerV2AdminWorkspace(key)) return;
  const [user, org] = JSON.parse(key) as [string, string];
  if (getActiveOrganizationSnapshot()?.id !== org) return;
  void loadCloudComputerV2(key).catch(() => {});
  // Intent never calls the allocating endpoint. Warm only a confirmed,
  // creator-owned destination already in the normal workspace catalog.
  const candidates = getCloudWorkspaceRows().filter((row) => {
    const target = parseCloudWorkspaceKey(row.path);
    return (
      target?.organizationId === org &&
      cloudWorkspaceDocument(target)?.adminWorkspace?.creatorUserId === user
    );
  });
  const candidate = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (candidate)
    void warmCloudWorkspaceDestination(candidate.path, true).catch(() => {});
}
