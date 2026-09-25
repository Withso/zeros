import { useCallback } from "react";
import type { Workspace } from "../platform/git";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import { useWorkspaceStore, selectChatToRestoreForFolder } from "./store";
import { workspaceIsReadOnly } from "./workspace-history";
import { workspaceOwnsFolder } from "./archive-actions";
import { prefetchWorkspaceRecovery } from "./workspace-recovery-cache";

/** Pointer/focus intent warms only persisted history and recovery metadata. */
export function useWarmWorkspaceHistory(): (workspace: Workspace) => void {
  const sessions = useAgentSessions();
  return useCallback(
    (workspace: Workspace) => {
      if (!workspaceIsReadOnly(workspace)) return;
      prefetchWorkspaceRecovery(workspace);
      const state = useWorkspaceStore.getState();
      const chatId =
        selectChatToRestoreForFolder(state, workspace.path) ??
        state.chats.find(
          (chat) =>
            chat.kind !== "terminal" &&
            workspaceOwnsFolder(workspace, chat.folder),
        )?.id;
      if (chatId) void sessions.hydrateChat(chatId).catch(() => {});
    },
    [sessions],
  );
}
