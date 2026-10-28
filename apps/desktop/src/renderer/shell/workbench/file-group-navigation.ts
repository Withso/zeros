import { useWorkspaceStore } from "@/renderer/state/store";
import { workbenchScopeForFolder } from "@/renderer/state/workspace-store";
import { createFilesTab, defaultScopeFor } from "./tab-model";
import { filePillPath } from "./file-pill-navigation";
import { normalizeFileGroup, type FileGroup } from "./file-group";

export function openFileGroup(
  cwd: string | null | undefined,
  input: FileGroup,
): void {
  const group = normalizeFileGroup(input);
  if (
    !cwd ||
    !group ||
    group.files.some((file) => !filePillPath(cwd, file.path))
  )
    return;
  const state = useWorkspaceStore.getState(),
    scope = workbenchScopeForFolder(cwd);
  const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
  const existing = current.tabs.find(
    (tab) => tab.type === "files" && tab.fileGroup?.id === group.id,
  );
  if (existing) {
    const filePath = group.files.some((file) => file.path === existing.filePath)
      ? existing.filePath
      : group.files[0].path;
    state.dispatch({
      type: "OPEN_WORKBENCH_TAB",
      id: existing.id,
      scope,
      updates: { fileGroup: group, filePath, title: group.name, diff: false },
    });
  } else {
    state.dispatch({
      type: "ADD_WORKBENCH_TAB",
      scope,
      tab: {
        ...createFilesTab(group.files[0].path),
        title: group.name,
        fileGroup: group,
        fileTreeVisible: false,
      },
    });
  }
}
