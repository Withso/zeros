import type { AuthUser } from "../features/auth/auth-store";
import { CONTROL_PLANE_URL } from "../features/team/control-plane";
import { clearTeamStore, restoreOrganizationPresentation } from "../features/team/team-store";
import { accountPresentationOwner, bindAccountPresentationOwner } from "../platform/account-presentation-cache";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { clearCloudGithub } from "../platform/cloud-github";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { useSessionsStore } from "../features/agent/sessions-store";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import { workspaceListFilterProjectId } from "./workspace-list-filter";
import { canReadCloudWorkspace, clearCloudWorkspaceCatalog, getCloudWorkspaceDocuments, restoreCloudWorkspaceCatalog, subscribeCloudWorkspaces, subscribeCloudWorkspaceRows } from "./cloud-workspace-catalog";
import { loadCloudCatalogPresentation, persistCloudCatalogPresentation } from "./cloud-catalog-cache";
import { completeCloudChatCacheRestore, loadCloudChatCache, pruneCloudChatCache, setCloudChatCacheOwner } from "./cloud-chat-cache";
import { pruneOrganizationDestinations } from "./organization-destination-cache";
import { folderIsWithinRoot } from "./workspace-resolution";

let offCatalog: (() => void) | undefined;

/** Runs above AuthGate, before identity publication. Token refresh is allowed
 * to fail offline; only main's identity removal/replacement retires account UI. */
export function installAccountPresentationIdentity(user: AuthUser | null): void {
  const owner = user && CONTROL_PLANE_URL ? accountPresentationOwner(CONTROL_PLANE_URL, user.accountId ?? user.sub) : null;
  const { changed, retire } = bindAccountPresentationOwner(owner);
  if (!changed) return;
  offCatalog?.();
  offCatalog = undefined;
  setCloudChatCacheOwner(null);
  const state = useWorkspaceStore.getState();
  const folders = new Set([
    ...state.chats.map(chat => chat.folder),
    ...Object.keys(state.activeChatByFolder),
    ...Object.keys(state.workbenchByScope),
    ...Object.keys(state.workspaceActivityByFolder),
    ...Object.values(state.lastWorkspaceByRepoRoot),
    state.lastWorkspaceFolder,
    state.pendingWorkspaceValidationFolder,
    state.pendingChatHydrationFolder,
    selectActiveFolder(state),
  ].filter((folder): folder is string => !!folder && isCloudWorkspace(folder)));
  for (const chat of state.chats) if (isCloudWorkspace(chat.folder)) useSessionsStore.getState().removeSession(chat.id);
  if (retire) {
    pruneOrganizationDestinations(destination => isCloudWorkspace(destination.folder));
    state.dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders: [...folders] });
    // Repository selection can outlive both its folder and the catalog on disk.
    const projectIds = new Set([
      state.activeRepoId, state.createWorkspaceProjectId,
      workspaceListFilterProjectId(state.workspaceListFilter),
      ...Object.keys(state.repoPageViewByProject),
    ]);
    for (const projectId of projectIds) if (projectId?.startsWith("cloud-repository:"))
      state.dispatch({ type: "REMOVE_REPO_UI_STATE", projectId, repoRoot: "" });
  } else state.dispatch({ type: "REVALIDATE_CLOUD_CHATS" });
  const bridge = getActiveBridge();
  if (bridge instanceof WorkspaceRuntimeClient) bridge.clearCloudConnections();
  clearCloudWorkspaceCatalog();
  clearCloudAgentRegistry();
  clearCloudGithub();
  clearTeamStore({ resetSelection: retire });
  if (!owner) return;
  restoreOrganizationPresentation();
  restoreCloudWorkspaceCatalog(loadCloudCatalogPresentation(owner));
  setCloudChatCacheOwner(owner);
  state.dispatch({ type: "MERGE_CHATS", chats: loadCloudChatCache() });
  completeCloudChatCacheRestore(owner);
  const offDocuments = subscribeCloudWorkspaces(() => persistCloudCatalogPresentation(
    owner, getCloudWorkspaceDocuments().filter(canReadCloudWorkspace), selectActiveFolder(useWorkspaceStore.getState()),
  ));
  const offRows = subscribeCloudWorkspaceRows(change => {
    pruneCloudChatCache(change.removedWorkspaceIds);
    if (change.removedWorkspaceIds.length) pruneOrganizationDestinations(destination =>
      change.removedWorkspaceIds.some(folder => folderIsWithinRoot(destination.folder, folder)));
  });
  offCatalog = () => { offDocuments(); offRows(); };
}
