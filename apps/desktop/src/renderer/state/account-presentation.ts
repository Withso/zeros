import type { AuthUser } from "../features/auth/auth-store";
import { CONTROL_PLANE_URL } from "../features/team/control-plane";
import { clearTeamStore, restoreOrganizationPresentation } from "../features/team/team-store";
import { accountPresentationOwner, bindAccountPresentationOwner } from "../platform/account-presentation-cache";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import { clearCloudGithub } from "../platform/cloud-github";
import { useSessionsStore } from "../features/agent/sessions-store";
import { selectActiveFolder, useWorkspaceStore } from "./store";
import { workspaceListFilterProjectId } from "./workspace-list-filter";
import { canReadCloudWorkspace, clearCloudWorkspaceCatalog, getCloudWorkspaceDocuments, restoreCloudWorkspaceCatalog, subscribeCloudWorkspaces, subscribeCloudWorkspaceRows } from "./cloud-workspace-catalog";
import { clearCloudAgentRegistry } from "../features/agent/workspace-agent-registry";
import { loadCloudCatalogPresentation, persistCloudCatalogPresentation } from "./cloud-catalog-cache";
import { completeCloudChatCacheRestore, loadCloudChatCache, pruneCloudChatCache, setCloudChatCacheOwner } from "./cloud-chat-cache";
import { pruneOrganizationDestinations } from "./organization-destination-cache";
import { folderIsWithinRoot } from "./workspace-resolution";
import { cloudTranscriptCache, isCloudTranscriptChat } from "./local-transcript-cache";
import { nativeCloudChatCache, retireLegacyCloudTranscriptStore, subscribeCloudChatCacheAccessLoss } from "../platform/cloud-chat-cache";
import { retireCloudTranscriptSummaries, retainCloudTranscriptSummaries } from "../features/agent/chat-transcript-summaries-cache";

let offCatalog: (() => void) | undefined;

/** Runs above AuthGate, before identity publication. Token refresh is allowed
 * to fail offline; only main's identity removal/replacement retires account UI. */
export function installAccountPresentationIdentity(user: AuthUser | null): void {
  const owner = user && CONTROL_PLANE_URL ? accountPresentationOwner(CONTROL_PLANE_URL, user.accountId ?? user.sub) : null;
  const previousOwner = nativeCloudChatCache.owner, previousEpoch = nativeCloudChatCache.epoch;
  nativeCloudChatCache.bindOwner(owner, user?.sessionId);
  const replacement = owner !== null && previousOwner === owner && previousEpoch !== nativeCloudChatCache.epoch;
  const binding = bindAccountPresentationOwner(owner), retire = binding.retire || replacement;
  void retireLegacyCloudTranscriptStore();
  if (!binding.changed && !replacement) return;
  retireCloudTranscriptSummaries();
  cloudTranscriptCache.bindOwner(owner, retire);
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
  // Paint cached cloud chats at once (Conductor renders its chat list from its local database), but only for
  // workspaces this account's restored catalog still holds; the live catalog and each chats.list then revalidate.
  const restoredDocuments = new Set(getCloudWorkspaceDocuments().filter(canReadCloudWorkspace).map(doc => cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id })));
  state.dispatch({ type: "MERGE_CHATS", chats: loadCloudChatCache().filter(chat => restoredDocuments.has(chat.folder)) });
  completeCloudChatCacheRestore(owner);
  // Begin disk I/O during stored-identity bootstrap, before token refresh or
  // VM admission. ChatView consumes the memory hit or shares the pending read.
  const boot = useWorkspaceStore.getState();
  const active = boot.chats.find(chat => chat.id === boot.activeChatId);
  let protectedChat: string | null = null;
  const protectActive = () => {
    const state = useWorkspaceStore.getState();
    const chat = state.activePage === "workspace" ? state.chats.find(row => row.id === state.activeChatId && row.kind !== "terminal") : undefined;
    const scope = chat && isCloudTranscriptChat(chat.id, chat.folder) ? parseCloudScopedId(chat.id) : null;
    const next = scope && cloudWorkspaceKey(scope) === chat?.folder ? chat.id : null;
    if (next === protectedChat) return;
    protectedChat = next;
    void nativeCloudChatCache.protect(next && scope ? { organizationId: scope.organizationId, workspaceId: scope.workspaceId, chatId: scope.id } : null);
  };
  protectActive();
  const offActive = useWorkspaceStore.subscribe((state, before) => {
    if (state.activeChatId !== before.activeChatId || state.activePage !== before.activePage || state.chats !== before.chats) protectActive();
  });
  const epoch = nativeCloudChatCache.epoch;
  const offAccess = subscribeCloudChatCacheAccessLoss((lostOwner, target, scope) => {
    if (lostOwner !== owner || nativeCloudChatCache.owner !== owner || nativeCloudChatCache.epoch !== epoch) return;
    const folder = cloudWorkspaceKey(target), id = cloudScopedId(target, target.chatId);
    const removed = (chatId: string, cwd?: string | null) => cwd === folder && (scope === "workspace" || chatId === id);
    cloudTranscriptCache.retain((chatId, cwd) => !removed(chatId, cwd));
    const sessions = useSessionsStore.getState();
    for (const [chatId, slot] of Object.entries(sessions.sessions)) if (slot.transcriptPresentation && removed(chatId, slot.cwd))
      sessions.patchSession(chatId, { messages: [], leadingPrompt: null, transcriptPresentation: null, hasTranscript: false,
        transcriptContentSignatures: undefined, transcriptHistoryState: undefined });
  });
  if (active && !active.archived && active.kind !== "terminal") cloudTranscriptCache.prefetch([active.id]);
  const offDocuments = subscribeCloudWorkspaces(() => persistCloudCatalogPresentation(
    owner, getCloudWorkspaceDocuments().filter(canReadCloudWorkspace), selectActiveFolder(useWorkspaceStore.getState()),
  ));
  const offRows = subscribeCloudWorkspaceRows(change => {
    pruneCloudChatCache(change.removedWorkspaceIds);
    if (change.removedWorkspaceIds.length) cloudTranscriptCache.retain((_chatId, folder) =>
      !change.removedWorkspaceIds.includes(folder));
    if (change.removedWorkspaceIds.length) retainCloudTranscriptSummaries(() => false,
      folder => change.removedWorkspaceIds.includes(folder), true);
    if (change.removedWorkspaceIds.length) pruneOrganizationDestinations(destination =>
      change.removedWorkspaceIds.some(folder => folderIsWithinRoot(destination.folder, folder)));
  });
  offCatalog = () => { offDocuments(); offRows(); offActive(); offAccess(); };
}
