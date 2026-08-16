import { useCallback } from "react";

import {
  useActiveWorkbenchTabId,
  useWorkbenchTabs,
  useWorkspaceDispatch,
} from "@/renderer/state/store";
import type { Action } from "@/renderer/state/workspace-store";
import {
  canonicalBrowsableHttpUrl,
  createBrowserTab,
  type WorkbenchTab,
} from "./tab-model";

export interface BrowserOpenOptions {
  url?: string;
  title?: string;
}

/** Resolve a browser-open intent without I/O. Exact URLs reuse their mounted
 * page; a shortcut with no URL reveals the active or most-recent Browser,
 * allocating a blank tab only when the workspace has none. */
export function planBrowserOpen(
  tabs: WorkbenchTab[],
  activeId: string | null,
  options?: BrowserOpenOptions,
): Action | null {
  if (options?.url !== undefined) {
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
 * fails the browser trust boundary, allowing callers to preserve a fallback. */
export function useOpenBrowserInWorkbench(
  onReveal?: () => void,
): (options?: BrowserOpenOptions) => boolean {
  const tabs = useWorkbenchTabs();
  const activeId = useActiveWorkbenchTabId();
  const dispatch = useWorkspaceDispatch();
  return useCallback(
    (options?: BrowserOpenOptions) => {
      const action = planBrowserOpen(tabs, activeId, options);
      if (!action) return false;
      dispatch(action);
      onReveal?.();
      return true;
    },
    [activeId, dispatch, onReveal, tabs],
  );
}
