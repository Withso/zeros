import { useCallback, useLayoutEffect } from "react";
import { getActiveOrganizationSnapshot } from "../features/team/team-store";
import { filterRowsForOrganization } from "../features/team/organization-capabilities";
import type { OrganizationSummary } from "../features/team/control-plane";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { canReadCloudWorkspace, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument } from "./cloud-workspace-catalog";
import { getOrganizationDestination, rememberOrganizationDestination } from "./organization-destination-cache";
import { loadProjects, normalizeProjectRoot } from "./projects-store";
import { selectChatToRestoreForFolder, selectLiveFolder, useWorkspaceStore, type WorkspaceState } from "./store";
import { peekLiveWorkspaceUnion, peekWorkspacesFor } from "./use-projects";
import { findProjectForFolder, findWorkspaceForFolder } from "./workspace-resolution";

/** Only already-known presentation can restore a destination; this never reads
 * the bridge or arms the explicit workspace-open wake intent. */
function knownDestination(organization: OrganizationSummary, folder: string): { repoRoot: string; validationPending: boolean } | null {
  if (isCloudWorkspace(folder)) {
    const target = parseCloudWorkspaceKey(folder);
    return target?.organizationId === organization.id && canReadCloudWorkspace(cloudWorkspaceDocument(target))
      ? { repoRoot: folder, validationPending: !cloudWorkspaceCatalogConfirmed() } : null;
  }
  const projects = loadProjects();
  const project = findProjectForFolder(folder, projects);
  const workspace = findWorkspaceForFolder(folder, filterRowsForOrganization(peekLiveWorkspaceUnion(), organization));
  if (workspace && workspace.archivedAt === null && workspace.present !== false &&
    (!project || normalizeProjectRoot(project.repoRoot) === normalizeProjectRoot(workspace.repoRoot))) {
    return { repoRoot: workspace.repoRoot, validationPending: peekWorkspacesFor(workspace.repoSlug) === undefined };
  }
  return organization.isPersonal && project && normalizeProjectRoot(folder) === normalizeProjectRoot(project.repoRoot)
    ? { repoRoot: project.repoRoot, validationPending: false } : null;
}

function remember(state: WorkspaceState, organization = getActiveOrganizationSnapshot()): void {
  if (state.activePage !== "workspace") return;
  const folder = selectLiveFolder(state);
  if (folder && organization && knownDestination(organization, folder))
    rememberOrganizationDestination(organization.id, folder, state.activeChatId);
}

/** Observe real navigation, including chat tabs, deep links and Dashboard opens. */
export function observeOrganizationDestination(): () => void {
  remember(useWorkspaceStore.getState());
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.activePage !== previous.activePage || state.activeChatId !== previous.activeChatId ||
      selectLiveFolder(state) !== selectLiveFolder(previous)) remember(state);
  });
}

export function restoreOrganizationDestination(previousOrganization?: OrganizationSummary | null): void {
  // A cold open may have become readable since its last navigation. The
  // switcher's callback still holds the outgoing owner from that render.
  if (previousOrganization) remember(useWorkspaceStore.getState(), previousOrganization);
  const organization = getActiveOrganizationSnapshot();
  const saved = organization ? getOrganizationDestination(organization.id) : null;
  const target = organization && saved ? knownDestination(organization, saved.folder) : null;
  const state = useWorkspaceStore.getState();
  if (!saved || !target) {
    state.dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    return;
  }
  const chatId = state.chats.some(chat => chat.id === saved.chatId && chat.folder === saved.folder && !chat.archived)
    ? saved.chatId : selectChatToRestoreForFolder(state, saved.folder);
  state.dispatch({ type: "OPEN_WORKSPACE", folder: saved.folder, repoRoot: target.repoRoot, chatId,
    validationPending: target.validationPending, chatHydrationPending: !chatId && isCloudWorkspace(saved.folder) });
}

export function useOrganizationDestination(organization: OrganizationSummary | null): () => void {
  useLayoutEffect(observeOrganizationDestination, []);
  return useCallback(() => restoreOrganizationDestination(organization), [organization]);
}
