// PURPOSE: The color token catalog the inspector's color pickers offer. The
// inspector provides it for the exact workspace it shows; pickers outside an
// inspector (the theme editor, canvas background) see none and keep Custom.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  designColorTokenGroups,
  designColorTokenGroupsKey,
  type DesignColorTokenGroup,
} from "./design-color-tokens";
import { designThemeView, effectiveDesignTheme } from "./design-themes";
import { designWorkspaceSnapshotCache } from "./state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";

const NO_GROUPS: readonly DesignColorTokenGroup[] = [];

export const DesignColorTokensContext =
  createContext<readonly DesignColorTokenGroup[]>(NO_GROUPS);

export function useDesignColorTokens(): readonly DesignColorTokenGroup[] {
  return useContext(DesignColorTokensContext);
}

/** Color tokens from the exact workspace's confirmed snapshot, for the theme
 * frames show. The array keeps its identity while its contents are equal. */
export function useDesignColorTokenGroups(
  workspaceId: string | null | undefined,
): readonly DesignColorTokenGroup[] {
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceId
        ? designWorkspaceSnapshotCache.subscribe(workspaceId, listener)
        : () => {},
    [workspaceId],
  );
  // Each catalog keeps its identity across publications that change other
  // frames, so reading them separately keeps the memoized inspector still.
  const readTokens = useCallback(
    () => (workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.tokens : undefined),
    [workspaceId],
  );
  const readSources = useCallback(
    () => (workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.styleSources : undefined),
    [workspaceId],
  );
  const readThemes = useCallback(
    () => (workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.themes : undefined),
    [workspaceId],
  );
  const manual = useSyncExternalStore(subscribe, readTokens, readTokens);
  const sources = useSyncExternalStore(subscribe, readSources, readSources);
  const themes = useSyncExternalStore(subscribe, readThemes, readThemes);
  const activeTheme = useDesignWorkspaceUiStore((state) =>
    workspaceId ? (state.byWorkspace[workspaceId]?.activeTheme ?? null) : null,
  );
  const previous = useRef<{ key: string; groups: readonly DesignColorTokenGroup[] }>({
    key: "",
    groups: NO_GROUPS,
  });
  return useMemo(() => {
    if (!manual && !sources) return NO_GROUPS;
    const groups = designColorTokenGroups({
      manual: manual ?? [],
      sources: sources ?? [],
      theme: effectiveDesignTheme(activeTheme, designThemeView(themes).baseId),
    });
    const key = designColorTokenGroupsKey(groups);
    if (key === previous.current.key) return previous.current.groups;
    const next = groups.length > 0 ? groups : NO_GROUPS;
    previous.current = { key, groups: next };
    return next;
  }, [activeTheme, manual, sources, themes]);
}
