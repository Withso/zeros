import type { TurnInfo } from "@/renderer/platform/turns";
import { isCloudWorkspace } from "@/renderer/platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "@/renderer/state/store";
import { workbenchScopeForFolder } from "@/renderer/state/workspace-store";
import { peekLiveWorkspaceUnion } from "@/renderer/state/use-projects";
import { findWorkspaceForFolder } from "@/renderer/state/workspace-resolution";
import { isLocalMainWorkspace } from "@/renderer/state/local-main-workspace";
import { createChangesTab, defaultScopeFor } from "./tab-model";
import { setChangesScope } from "./tabs/changes-filter-store";
import { writeChangesSections } from "./tabs/changes-snapshot-cache";
import { isWorkbenchEditorDirty } from "./tabs/code-editor/editor-state";
import { prefetchWorkspaceFileDiff } from "../workspace-file-data-cache";

function destination(turn: TurnInfo) {
  if (!turn.folder || !turn.files.length) return null;
  const workspace = findWorkspaceForFolder(turn.folder,
    [...peekLiveWorkspaceUnion()].sort((a, b) => b.path.length - a.path.length));
  const workspaceId = workspace && isLocalMainWorkspace(workspace)
    ? workspace.repoRoot
    : turn.workspaceId ?? workspace?.id ?? turn.folder;
  const identity = { chatId: turn.chatId, turnId: turn.turnId };
  return { workspaceId, baseBranch: workspace?.baseBranch ?? "main",
    history: { kind: "turn-range" as const, from: identity, to: identity },
    scope: workbenchScopeForFolder(turn.folder) };
}

/** Explicit historical identity, even when this is currently the latest turn.
 * Navigation never waits for a Git read or borrows the active owner's scope. */
export function openTurnChanges(turn: TurnInfo): void {
  const target = destination(turn);
  if (!target) return;
  const state = useWorkspaceStore.getState();
  const current = state.workbenchByScope[target.scope] ?? defaultScopeFor(target.scope);
  const tab = current.tabs.find((item) => item.type === "changes");
  writeChangesSections(target.workspaceId, target.history, [{
    kind: "committed", title: null,
    files: turn.files.map((file) => ({ ...file, patch: "", binary: false, committed: true })),
  }], target.baseBranch);
  setChangesScope(target.workspaceId, target.history);
  const updates = {
    filePath: turn.files[0].path, diff: true, diffScope: "history" as const,
    diffHistory: target.history, diffSha: undefined, turnChatId: undefined, turnId: undefined,
    discardable: false, isNewFile: false, viewerMode: undefined, changesRequestedFile: undefined,
  };
  if (tab) state.dispatch({ type: "OPEN_WORKBENCH_TAB", scope: target.scope, id: tab.id,
    updates: isWorkbenchEditorDirty(tab.id) ? undefined : updates });
  else state.dispatch({ type: "ADD_WORKBENCH_TAB", scope: target.scope, tab: { ...createChangesTab(), ...updates } });
}

export function warmTurnChanges(turn: TurnInfo): void {
  // Passive transcript intent must not wake a sleeping VM. The explicit Review
  // action uses the normal cloud workbench connection and loading behavior.
  if (isCloudWorkspace(turn.folder)) return;
  const target = destination(turn);
  if (target) prefetchWorkspaceFileDiff({ workspaceId: target.workspaceId, path: turn.files[0].path,
    diffScope: "history", diffHistory: target.history });
}
