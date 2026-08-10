import { useEffect } from "react";

import { useSessionsStore } from "../agent/sessions-store";
import { nativeListen } from "../../platform/runtime";
import { useWorkspaceStore } from "../../state/store";
import {
  selectWorkbench,
  workbenchScopeForFolder,
  type Action,
} from "../../state/workspace-store";
import { requestWorkbenchVisible } from "../../shell/workbench-visibility-controller";
import {
  planBrowserSessionOpen,
  shouldRevealBrowserSession,
} from "../../shell/workbench/use-open-browser";
import { userBrowserTabId } from "../../shell/workbench/tabs/browser-surface-routing";
import {
  publishBrowserSessionActivity,
  type BrowserSessionActivity,
} from "./browser-session-activity-store";

export type BrowserSessionStateEvent = BrowserSessionActivity;

/** Main-process browser events arrive independently of React's render tree.
 * Attribute each one through the durable session-to-chat index, then publish
 * the Browser tab route and native-session identity in one reducer transition.
 * Background tasks update their own scoped tabs without stealing the visible
 * workspace; the currently active task reveals its Browser on the first open. */
export function BrowserSessionController() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void nativeListen<BrowserSessionStateEvent>(
      "browser-session-state",
      (event) => {
        if (
          !event ||
          typeof event.taskId !== "string" ||
          typeof event.url !== "string"
        ) {
          return;
        }
        publishBrowserSessionActivity(event);
        // Shared Chrome is already a visible native Chrome tab. Do not create
        // an iframe lookalike in the workbench—the two pages would not share
        // authentication or document state.
        if (
          event.provider === "shared-chrome" ||
          event.provider === "managed-cloud" ||
          event.provider === "system-computer-use"
        ) {
          return;
        }
        const userTabId = userBrowserTabId(event.taskId);
        if (userTabId) {
          // Ordinary public-site tabs also use the native browser surface. Its
          // durable tab id is the session key, so redirects, link navigation,
          // and title changes can be persisted without attributing the page to
          // an agent chat or stealing the visible workspace.
          if (event.status !== "closed") {
            const workspace = useWorkspaceStore.getState();
            for (const [scope, workbench] of Object.entries(
              workspace.workbenchByScope,
            )) {
              const tab = workbench.tabs.find(
                (candidate) =>
                  candidate.type === "browser" && candidate.id === userTabId,
              );
              if (!tab) continue;
              useWorkspaceStore.getState().dispatch({
                type: "UPDATE_WORKBENCH_TAB",
                id: userTabId,
                scope,
                updates: {
                  ...(event.url ? { url: event.url } : {}),
                  ...(event.title ? { title: event.title } : {}),
                },
              });
              break;
            }
          }
          return;
        }
        const sessionState = useSessionsStore.getState();
        const chatId = sessionState.sessionToChatId[event.taskId];
        if (!chatId) return;

        const workspace = useWorkspaceStore.getState();
        const chat = workspace.chats.find(
          (candidate) => candidate.id === chatId,
        );
        if (!chat) return;
        const scope = workbenchScopeForFolder(chat.folder || null);
        const scopedTabs =
          workspace.workbenchByScope[scope]?.tabs ??
          (workspace.activeChatId === chatId
            ? selectWorkbench(workspace).tabs
            : []);

        if (event.status === "closed") {
          const tab = scopedTabs.find(
            (candidate) =>
              candidate.type === "browser" &&
              candidate.browserSessionId === event.taskId,
          );
          if (tab) {
            useWorkspaceStore.getState().dispatch({
              type: "UPDATE_WORKBENCH_TAB",
              id: tab.id,
              scope,
              updates: { browserSessionId: undefined },
            });
          }
          return;
        }

        const hasTaskTab = scopedTabs.some(
          (candidate) =>
            candidate.type === "browser" &&
            candidate.browserSessionId === event.taskId,
        );
        const shouldReveal = shouldRevealBrowserSession({
          activeChat: workspace.activeChatId === chatId,
          hasTaskTab,
          url: event.url,
          status: event.status,
          tool: event.tool,
        });
        const actions = planBrowserSessionOpen(scopedTabs, {
          taskId: event.taskId,
          url: event.url,
          title: event.title,
          activate: shouldReveal,
        });
        for (const action of actions) {
          useWorkspaceStore.getState().dispatch(withScope(action, scope));
        }
        if (shouldReveal && actions.length > 0) requestWorkbenchVisible();
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}

function withScope(action: Action, scope: string): Action {
  if (
    action.type === "ADD_WORKBENCH_TAB" ||
    action.type === "ACTIVATE_WORKBENCH_TAB" ||
    action.type === "UPDATE_WORKBENCH_TAB"
  ) {
    return { ...action, scope };
  }
  return action;
}
