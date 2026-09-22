import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Workspace } from "../platform/git";
import type { Project } from "./projects-store";
import { withFolderWorkspaces } from "./local-main-workspace";
import { useWorkspaceStore } from "./workspace-store";

/** Shared presentation projection. Engine caches stay limited to managed rows
 * so synthetic folder ids never enter workspace lifecycle operations. */
export function useFolderWorkspaces(
  workspaces: Workspace[],
  projects: readonly Project[],
): Workspace[] {
  const openedPaths = useWorkspaceStore(
    useShallow((state) =>
      [
        ...new Set(
          [
            ...state.chats.map((chat) => chat.folder),
            ...Object.keys(state.workbenchByScope),
            ...Object.values(state.lastWorkspaceByRepoRoot),
            state.lastWorkspaceFolder,
          ].filter((folder): folder is string => !!folder),
        ),
      ].sort(),
    ),
  );
  const lastWorkspaceByRepoRoot = useWorkspaceStore(
    (state) => state.lastWorkspaceByRepoRoot,
  );
  const openedFolders = useMemo(() => new Set(openedPaths), [openedPaths]);
  return useMemo(
    () =>
      withFolderWorkspaces(
        projects,
        workspaces,
        openedFolders,
        lastWorkspaceByRepoRoot,
      ),
    [projects, workspaces, openedFolders, lastWorkspaceByRepoRoot],
  );
}
