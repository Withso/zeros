import { useEffect, useState } from "react";
import { useGitRefreshKey } from "./use-git-refresh-key";
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
  workspaceFileListingFailure,
} from "./workspace-files-cache";

const EMPTY_FILES: string[] = [];

/** The shared cache deduplicates I/O; this mounted consumer fences delivery on
 * close, owner/workspace changes, retries and newer refresh generations. */
export function useCommandPaletteFiles(
  folder: string | null,
  enabled: boolean,
) {
  const refresh = useGitRefreshKey(folder, undefined, enabled);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState(() => ({
    folder,
    files: folder && enabled ? peekWorkspaceFiles(folder) : null,
    loading: enabled,
    error: false,
  }));
  useEffect(() => {
    if (!folder || !enabled) return;
    let current = true;
    const cached = peekWorkspaceFiles(folder);
    setState((previous) => ({
      folder,
      files: cached ?? (previous.folder === folder ? previous.files : null),
      loading: true,
      error: false,
    }));
    void loadWorkspaceFiles(folder).then(
      (files) => {
        if (current)
          setState({
            folder,
            files,
            loading: false,
            error: !!workspaceFileListingFailure(folder),
          });
      },
      () => {
        if (current)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: true,
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, folder, refresh, retry]);

  // Never render a prior destination while its replacement's effect is pending.
  const exact = enabled && state.folder === folder;
  const files = exact ? (state.files ?? EMPTY_FILES) : EMPTY_FILES;
  return {
    files,
    loading:
      !!folder && enabled && (!exact || state.loading) && files.length === 0,
    error: exact && state.error,
    retry: () => setRetry((value) => value + 1),
  };
}
