import { useCallback } from "react";

import { useAgentSessions } from "../features/agent/sessions-hooks";
import { spawnDefaultChatForWorkspace } from "./spawn-default-chat";
import {
  selectChatToRestoreForFolder,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "./store";
import {
  prefetchWorkspaceSurface,
  type WorkspaceNavigationTarget,
} from "../shell/prefetch-workspace-surface";
import { prepareChatView } from "../shell/conversation/chat-intent";
import { resolveWorkspacePresentationKind } from "./workspace-resolution";
import {
  isInternalFeatureActive,
  useInternalFeatureActive,
} from "../features/settings/internal-features";

/** Open a workspace: switch to the workspace view and land on the chat the user
 *  last had there (else any chat at that path, else auto-spawn the starred
 *  agent's default chat). Mirrors repository panel's handleSelectWorkspace but ALSO flips
 *  activePage back to "workspace" — required when opening from a full-window page
 *  like the Dashboard, where the 3-column workspace view isn't mounted. */
export function useOpenWorkspace(): (
  workspace: WorkspaceNavigationTarget,
) => void {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const designWorkspacesActive =
    useInternalFeatureActive("designWorkspaces");
  return useCallback(
    (workspace: WorkspaceNavigationTarget) => {
      const presentationKind = resolveWorkspacePresentationKind({
        confirmedKind: workspace.kind,
        folder: workspace.path,
      });
      if (
        presentationKind === "design" &&
        (!designWorkspacesActive ||
          !isInternalFeatureActive("designWorkspaces"))
      ) {
        return;
      }
      // Pointer/focus intent normally starts these reads earlier; repeat here
      // for keyboard/programmatic navigation. Both paths dedupe by exact key.
      prefetchWorkspaceSurface(workspace);
      if (presentationKind === "design") {
        // A previous build may have persisted coding chats for this path.
        // Keep those rows dormant and publish the design destination without a
        // chat identity so opening it can never resume the coding harness.
        dispatch({
          type: "OPEN_WORKSPACE",
          folder: workspace.path,
          repoRoot: workspace.repoRoot,
          chatId: null,
          validationPending: workspace.validationPending,
        });
        return;
      }
      // Last-viewed chat there (validated), else the most-recent live one.
      const fallbackId = selectChatToRestoreForFolder(
        useWorkspaceStore.getState(),
        workspace.path,
      );
      if (fallbackId) {
        void sessions.hydrateChat(fallbackId);
        prepareChatView(fallbackId);
      }
      // Route + target become visible in one external-store snapshot. When no
      // chat exists yet, clearing the prior id and setting the new folder in
      // this same commit prevents old transcript/chrome from leaking through.
      dispatch({
        type: "OPEN_WORKSPACE",
        folder: workspace.path,
        repoRoot: workspace.repoRoot,
        chatId: fallbackId,
        validationPending: workspace.validationPending,
      });
      if (fallbackId) {
        return;
      }
      // A cold remembered target is visible immediately, but creating a chat
      // mutates durable data. Wait for its exact repository list to confirm the
      // worktree; Conversation pane's selection keeper spawns after resolution succeeds.
      if (workspace.validationPending) return;
      void spawnDefaultChatForWorkspace({
        folder: workspace.path,
        sessions,
        dispatch,
      });
    },
    [designWorkspacesActive, dispatch, sessions],
  );
}
