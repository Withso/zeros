import { getActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "@/renderer/platform/bridge/cloud-workspace-key";
import { relativeWorkspaceFilePath } from "@/renderer/platform/workspace-file-path";
import { useWorkspaceStore } from "@/renderer/state/store";
import { workbenchScopeForFolder } from "@/renderer/state/workspace-store";
import { peekLiveWorkspaceUnion } from "@/renderer/state/use-projects";
import { findWorkspaceForFolder } from "@/renderer/state/workspace-resolution";
import { isLocalMainWorkspace } from "@/renderer/state/local-main-workspace";
import {
  prefetchWorkspaceFileRead,
  prefetchWorkspaceFileDiff,
} from "../workspace-file-data-cache";
import { buildDirectFileOpenAction } from "./direct-file-open";
import {
  createChangesTab,
  defaultScopeFor,
  type WorkbenchTab,
} from "./tab-model";
import { setChangesScope } from "./tabs/changes-filter-store";
import {
  changesSnapshotKey,
  readChangesSections,
} from "./tabs/changes-snapshot-cache";
import { isWorkbenchEditorDirty } from "./tabs/code-editor/editor-state";
import { findRequestedChange } from "./tabs/changes-selection";
import type { Action } from "@/renderer/state/workspace-store";

export type FilePillDestination = "file" | "changes";

export function filePillPath(
  cwd: string | null | undefined,
  path: string,
): string | null {
  if (!cwd) return null;
  const bridge = getActiveBridge();
  return bridge instanceof WorkspaceRuntimeClient
    ? bridge.fileReferencePath(cwd, path)
    : relativeWorkspaceFilePath(cwd, path);
}

function changesQuery(
  cwd: string,
  path: string,
): { workspaceId: string; path: string; baseBranch: string } {
  // The live union spans repositories. A separately registered nested owner
  // wins over its parent, independent of catalog order.
  const workspace = findWorkspaceForFolder(
    cwd,
    [...peekLiveWorkspaceUnion()].sort((a, b) => b.path.length - a.path.length),
  );
  const baseBranch = workspace?.baseBranch ?? "main";
  const cloud = parseCloudWorkspaceKey(cwd);
  if (cloud)
    return {
      workspaceId: cloudWorkspaceKey(cloud),
      path: cloud.relativePath ? `${cloud.relativePath}/${path}` : path,
      baseBranch,
    };
  const root =
    workspace && isLocalMainWorkspace(workspace)
      ? workspace.repoRoot
      : (workspace?.path ?? cwd);
  return {
    workspaceId:
      workspace && !isLocalMainWorkspace(workspace) ? workspace.id : root,
    path:
      relativeWorkspaceFilePath(root, `${cwd.replace(/\/+$/, "")}/${path}`) ??
      path,
    baseBranch,
  };
}

/** A confirmed Branch list can route a clean/ignored file immediately. A cold
 * list keeps the explicit Changes request until that surface resolves it. */
function filePillChangesQuery(
  cwd: string,
  path: string,
  destination: FilePillDestination,
) {
  if (destination !== "changes") return null;
  const query = changesQuery(cwd, path);
  const sections = readChangesSections(
    changesSnapshotKey(query.workspaceId, { kind: "all" }, query.baseBranch),
  );
  if (!sections) return query;
  const file = findRequestedChange(
    sections.flatMap((section) => section.files),
    query.path,
  );
  return file ? { ...query, path: file.path } : null;
}

/** Exact saved/tool paths need no filesystem search or read before navigation.
 * The existing viewer owns missing-file and unavailable-workspace states. */
export function buildFilePillOpenAction(
  tabs: WorkbenchTab[],
  path: string,
  scope: string,
  destination: FilePillDestination = "file",
  activeId?: string | null,
): Action {
  if (destination === "changes") {
    const tab = tabs.find((item) => item.type === "changes");
    const updates = {
      filePath: path,
      diff: true,
      diffScope: "all" as const,
      diffSha: undefined,
      diffHistory: undefined,
      turnChatId: undefined,
      turnId: undefined,
      discardable: false,
      isNewFile: false,
      viewerMode: undefined,
      changesPresentation: "single" as const,
      changesRequestedFile: path,
    };
    if (tab && (!isWorkbenchEditorDirty(tab.id) || tab.filePath === path))
      return { type: "OPEN_WORKBENCH_TAB", id: tab.id, scope, updates };
    if (!tab)
      return {
        type: "ADD_WORKBENCH_TAB",
        scope,
        tab: { ...createChangesTab(), ...updates },
      };
    // A legacy Changes editor may still hold a draft. Keep it mounted and
    // open the requested diff separately instead of replacing that draft.
  }
  const action = buildDirectFileOpenAction(tabs, path, {
    scope,
    preferredExistingTabId: activeId,
    literalPath: true,
  });
  const intent = {
    diff: destination === "changes",
    diffScope: "all" as const,
    diffSha: undefined,
    diffHistory: undefined,
    turnChatId: undefined,
    turnId: undefined,
    discardable: false,
    isNewFile: false,
    viewerMode: undefined,
  };
  if (action.type === "ACTIVATE_WORKBENCH_TAB")
    return {
      type: "OPEN_WORKBENCH_TAB",
      id: action.id,
      scope,
      updates: intent,
    };
  if (action.type === "OPEN_WORKBENCH_TAB")
    return { ...action, updates: { ...action.updates, ...intent } };
  if (action.type === "ADD_WORKBENCH_TAB")
    return { ...action, tab: { ...action.tab, ...intent } };
  return action;
}

export function openFilePill(
  cwd: string | null | undefined,
  rawPath: string,
  destination: FilePillDestination = "file",
): void {
  const path = filePillPath(cwd, rawPath);
  if (!cwd || !path) return;
  const scope = workbenchScopeForFolder(cwd);
  const state = useWorkspaceStore.getState();
  const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
  const candidate = filePillChangesQuery(cwd, path, destination);
  const changes = current.tabs.find((tab) => tab.type === "changes");
  // A legacy Changes draft owns its current path and comparison. Open the
  // other tool's source using the chat-relative path, never the Git-relative
  // path that a separate Files tab would otherwise append to this cwd again.
  const query =
    candidate &&
    changes &&
    isWorkbenchEditorDirty(changes.id) &&
    changes.filePath !== candidate.path
      ? null
      : candidate;
  if (query) setChangesScope(query.workspaceId, { kind: "all" });
  state.dispatch(
    buildFilePillOpenAction(
      current.tabs,
      query?.path ?? path,
      scope,
      query ? "changes" : "file",
      current.activeId,
    ),
  );
}

export function warmFilePill(
  cwd: string | null | undefined,
  rawPath: string,
  destination: FilePillDestination = "file",
): void {
  const path = filePillPath(cwd, rawPath);
  if (!cwd || !path) return;
  const query = filePillChangesQuery(cwd, path, destination);
  if (query) prefetchWorkspaceFileDiff({ ...query, diffScope: "all" });
  // A cold Changes request may resolve to Files. Warm that exact source on
  // intent too, without adding I/O to the click or searching a Git file list.
  prefetchWorkspaceFileRead(cwd, path);
}
