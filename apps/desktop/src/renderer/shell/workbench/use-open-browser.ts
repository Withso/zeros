import { useCallback } from "react";

import {
  useActiveWorkbenchTabId,
  useWorkbenchTabs,
  useWorkspaceDispatch,
} from "@/renderer/state/store";
import type { Action } from "@/renderer/state/workspace-store";
import { requestWorkbenchVisible } from "../workbench-visibility-controller";
import {
  canonicalBrowsableHttpUrl,
  createBrowserTab,
  type WorkbenchTab,
} from "./tab-model";

export interface BrowserOpenOptions {
  url?: string;
  title?: string;
}

export interface BrowserSessionOpenEvent {
  taskId: string;
  url: string;
  title?: string;
  /** False for background metadata updates so navigation/title events cannot
   * steal focus after the user has left the Browser tab. */
  activate?: boolean;
}

export function shouldRevealBrowserSession(input: {
  activeChat: boolean;
  hasTaskTab: boolean;
  url: string;
  status: "working" | "awaiting-confirmation" | "ready" | "closed";
  tool?: string;
}): boolean {
  return (
    input.activeChat &&
    !input.hasTaskTab &&
    input.status !== "closed" &&
    canonicalBrowsableHttpUrl(input.url) !== null
  );
}

/** Project a main-process browser lifecycle event into exact task-owned
 * Workbench state. The renderer never guesses from URL: two tasks may visit the
 * same page without sharing cookies, history, or native WebContents. */
export function planBrowserSessionOpen(
  tabs: WorkbenchTab[],
  event: BrowserSessionOpenEvent,
): Action[] {
  const taskId = event.taskId.trim();
  const url = canonicalBrowsableHttpUrl(event.url);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId) || !url) return [];
  const title = event.title?.trim().slice(0, 512) || "Browser";
  const existing = tabs.find(
    (tab) => tab.type === "browser" && tab.browserSessionId === taskId,
  );
  if (!existing) {
    return [
      {
        type: "ADD_WORKBENCH_TAB",
        tab: createBrowserTab({ url, title, browserSessionId: taskId }),
        ...(event.activate === false ? { activate: false } : {}),
      },
    ];
  }
  const actions: Action[] = [
    {
      type: "UPDATE_WORKBENCH_TAB",
      id: existing.id,
      updates: { url, title },
    },
  ];
  if (event.activate !== false) {
    actions.push({ type: "ACTIVATE_WORKBENCH_TAB", id: existing.id });
  }
  return actions;
}

/** Resolve a browser-open intent without I/O. Exact URLs reuse their mounted
 * iframe; a shortcut with no URL reveals the active or most-recent Browser,
 * allocating a blank tab only when the workspace has none. */
export function planBrowserOpen(
  tabs: WorkbenchTab[],
  activeId: string | null,
  options?: BrowserOpenOptions,
): Action | null {
  if (options && options.url !== undefined) {
    const url = canonicalBrowsableHttpUrl(options.url);
    if (!url) return null;
    const existing = tabs.find(
      (tab) => tab.type === "browser" && tab.url === url,
    );
    if (existing) {
      return { type: "ACTIVATE_WORKBENCH_TAB", id: existing.id };
    }
    return {
      type: "ADD_WORKBENCH_TAB",
      tab: createBrowserTab({ url, title: options.title }),
    };
  }

  const active = tabs.find(
    (tab) => tab.id === activeId && tab.type === "browser",
  );
  const recent = [...tabs].reverse().find((tab) => tab.type === "browser");
  const target = active ?? recent;
  if (target) return { type: "ACTIVATE_WORKBENCH_TAB", id: target.id };
  return { type: "ADD_WORKBENCH_TAB", tab: createBrowserTab() };
}

/** Open/focus a Browser in the active workspace. Returns false only when a URL
 * fails the browser trust boundary, letting callers preserve their fallback. */
export function useOpenBrowserInWorkbench(): (
  options?: BrowserOpenOptions,
) => boolean {
  const tabs = useWorkbenchTabs();
  const activeId = useActiveWorkbenchTabId();
  const dispatch = useWorkspaceDispatch();
  return useCallback(
    (options?: BrowserOpenOptions) => {
      const action = planBrowserOpen(tabs, activeId, options);
      if (!action) return false;
      dispatch(action);
      requestWorkbenchVisible();
      return true;
    },
    [activeId, dispatch, tabs],
  );
}
