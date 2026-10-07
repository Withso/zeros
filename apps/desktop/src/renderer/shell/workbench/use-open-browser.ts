import { useCallback } from "react";

import {
  useActiveWorkbenchTabId,
  useWorkbenchTabs,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "@/renderer/state/store";
import type { Action } from "@/renderer/state/workspace-store";
import { workbenchScopeForFolder } from "@/renderer/state/workspace-store";
import { isLoopbackUrl } from "./tabs/localhost-url";
import { workspacePreviewAvailable } from "../../platform/cloud-workspace-access";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { hasCloudWorkspaceAccountAccess, useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import type { BrowserPreviewSource } from "./tab-model";
import type { ExecutionBoundaryPortsSnapshot } from "@zeros/protocol/containment";
import { cloudWorkspaceCanEdit } from "../../state/use-cloud-workspace-can-edit";
import {
  canonicalBrowsableHttpUrl,
  createBrowserTab,
  defaultScopeFor,
  type WorkbenchTab,
} from "./tab-model";

export interface BrowserOpenOptions {
  url?: string;
  title?: string;
  previewSource?: BrowserPreviewSource;
}

/** Resolve a browser-open intent without I/O. Exact URLs reuse their mounted
 * page; a shortcut with no URL reveals the active or most-recent Browser,
 * allocating a blank tab only when the workspace has none. */
export function planBrowserOpen(
  tabs: WorkbenchTab[],
  activeId: string | null,
  options?: BrowserOpenOptions,
): Extract<Action, { type: "ADD_WORKBENCH_TAB" | "ACTIVATE_WORKBENCH_TAB" }> | null {
  if (options?.url !== undefined) {
    const url = canonicalBrowsableHttpUrl(options.url);
    if (!url) return null;
    const existing = tabs.find(
      (tab) => tab.type === "browser" && tab.url === url && JSON.stringify(tab.previewSource) === JSON.stringify(options.previewSource),
    );
    if (existing) {
      return { type: "ACTIVATE_WORKBENCH_TAB", id: existing.id };
    }
    return {
      type: "ADD_WORKBENCH_TAB",
      tab: createBrowserTab({ url, title: options.title, previewSource: options.previewSource }),
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

/** A retained chat must never open its preview in a different workspace. */
export function useOpenChatPreviewInWorkbench(): (cwd: string | undefined, url: string, agent?: { chatId: string; executionId?: string; ports?: ExecutionBoundaryPortsSnapshot }) => boolean {
  const cloudPreviews = useCloudWorkspaceAccountAccess();
  return useCallback((cwd, url, agent) => {
    if (!cwd || !isLoopbackUrl(url)) return false;
    const cloud = isCloudWorkspace(cwd);
    // Consume cloud-local URLs even when unavailable; the OS must never open
    // them against a coincidental listener on this Mac.
    if (!workspacePreviewAvailable(cwd) || (cloud && (!cloudPreviews || !hasCloudWorkspaceAccountAccess(parseCloudWorkspaceKey(cwd)?.organizationId) || !cloudWorkspaceCanEdit(cwd)))) return cloud;
    let previewSource: BrowserPreviewSource | undefined;
    if (cloud) {
      const parsed = new URL(url);
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      const listener = agent?.ports?.ports.find(candidate => candidate.port === port);
      if (!agent?.executionId || !listener) return true;
      previewSource = { chatId: agent.chatId, port, executionId: agent.executionId, portId: listener.id };
    }
    const scope = workbenchScopeForFolder(cwd);
    const state = useWorkspaceStore.getState();
    const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
    const action = planBrowserOpen(current.tabs, current.activeId, { url, previewSource });
    if (!action) return false;
    state.dispatch({ ...action, scope });
    return true;
  }, [cloudPreviews]);
}
