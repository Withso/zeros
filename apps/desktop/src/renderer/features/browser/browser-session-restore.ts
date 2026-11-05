import {
  isBrowserProductId,
  type BrowserSessionState,
} from "@zeros/protocol/browser-tools";

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { Workspace } from "../../platform/git";
import { nativeInvoke } from "../../platform/runtime";
import { useWorkspaceStore } from "../../state/store";
import { peekLiveWorkspaceUnion } from "../../state/use-projects";
import { workspaceIdForCwd } from "../../state/workspace-resolution";
import { validBrowserSessionState } from "./browser-session-routing";

export interface ConversationBrowserOwner {
  workspaceId: string;
  workspaceRoot: string;
}

/** The Local workspace that owns a conversation's browser, resolved the way an
 * agent spawn resolves its workspace, so main keys a page the agent will
 * acquire. Null for an unknown, cloud or archived owner: main then reuses only
 * a record it still holds for the conversation. */
export function conversationBrowserOwner(
  conversationId: string,
  chats: ReadonlyArray<{ id: string; folder: string }>,
  workspaces: readonly Workspace[],
): ConversationBrowserOwner | null {
  const folder = chats.find((chat) => chat.id === conversationId)?.folder;
  if (!folder || isCloudWorkspace(folder)) return null;
  const workspaceId = workspaceIdForCwd(folder, [...workspaces]);
  const workspace = workspaces.find((row) => row.id === workspaceId);
  if (
    !workspace ||
    workspace.placement === "cloud" ||
    workspace.archivedAt != null ||
    !isBrowserProductId(workspace.id) ||
    !workspace.path.startsWith("/")
  ) {
    return null;
  }
  return { workspaceId: workspace.id, workspaceRoot: workspace.path };
}

/** Reopen a conversation's page for its Browser tab after its native page was
 * closed. Main republishes a page it still holds, or opens `url` as the user. */
export async function restoreConversationBrowser(
  conversationId: string,
  url: string,
): Promise<BrowserSessionState> {
  const owner = conversationBrowserOwner(
    conversationId,
    useWorkspaceStore.getState().chats,
    peekLiveWorkspaceUnion(),
  );
  const state = await nativeInvoke<unknown>("browser_session_restore", {
    conversationId,
    url,
    ...(owner ? { owner } : {}),
  });
  if (
    !validBrowserSessionState(state) ||
    state.conversationId !== conversationId ||
    state.status === "closed"
  ) {
    throw new Error("The page could not be reopened.");
  }
  return state;
}

/** Whether any workbench scope still shows the conversation's Browser tab. */
export function conversationBrowserTabOpen(conversationId: string): boolean {
  return Object.values(useWorkspaceStore.getState().workbenchByScope).some(
    (scope) =>
      scope.tabs.some(
        (tab) =>
          tab.type === "browser" &&
          tab.browserConversationId === conversationId,
      ),
  );
}
