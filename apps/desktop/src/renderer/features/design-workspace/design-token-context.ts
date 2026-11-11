// PURPOSE: The token catalog the inspector's pills and pickers read, for the
// exact workspace and frame it shows. Fields outside an inspector (the theme
// editor, the canvas background) see an empty catalog and offer no tokens.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  EMPTY_DESIGN_TOKEN_CATALOG,
  designTokenCatalog,
  type DesignTokenCatalog,
} from "./design-token-catalog";
import { designThemeView, effectiveDesignTheme } from "./design-themes";
import { designWorkspaceSnapshotCache } from "./state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";

export const DesignTokenCatalogContext = createContext<DesignTokenCatalog>(
  EMPTY_DESIGN_TOKEN_CATALOG,
);

export function useDesignTokens(): DesignTokenCatalog {
  return useContext(DesignTokenCatalogContext);
}

/** Detach for the inspector's selection: each layer keeps the value its
 * token resolves to there. Null outside an inspector. */
export const DesignTokenDetachContext = createContext<
  ((properties: readonly string[]) => void) | null
>(null);

export function useDesignTokenDetach(): ((properties: readonly string[]) => void) | null {
  return useContext(DesignTokenDetachContext);
}

/** The tokens one frame resolves, from the workspace's confirmed snapshot,
 * for the theme frames show. Keeps its identity while its contents match. */
export function useDesignFrameTokenCatalog(
  workspaceId: string | null | undefined,
  frameFile: string | null | undefined,
): DesignTokenCatalog {
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceId
        ? designWorkspaceSnapshotCache.subscribe(workspaceId, listener)
        : () => {},
    [workspaceId],
  );
  // Each part keeps its identity across publications that change other
  // frames, so reading them separately keeps the memoized inspector still.
  const readTokens = useCallback(
    () => (workspaceId ? peek(workspaceId)?.tokens : undefined),
    [workspaceId],
  );
  const readSources = useCallback(
    () => (workspaceId ? peek(workspaceId)?.styleSources : undefined),
    [workspaceId],
  );
  const readThemes = useCallback(
    () => (workspaceId ? peek(workspaceId)?.themes : undefined),
    [workspaceId],
  );
  const readChoices = useCallback(
    () => (workspaceId ? peek(workspaceId)?.frameStyleSources : undefined),
    [workspaceId],
  );
  const manual = useSyncExternalStore(subscribe, readTokens, readTokens);
  const sources = useSyncExternalStore(subscribe, readSources, readSources);
  const themes = useSyncExternalStore(subscribe, readThemes, readThemes);
  const choices = useSyncExternalStore(subscribe, readChoices, readChoices);
  const activeTheme = useDesignWorkspaceUiStore((state) =>
    workspaceId ? (state.byWorkspace[workspaceId]?.activeTheme ?? null) : null,
  );
  const previous = useRef<DesignTokenCatalog>(EMPTY_DESIGN_TOKEN_CATALOG);
  const sourceIds = frameFile ? choices?.[frameFile] : undefined;
  return useMemo(() => {
    if (!manual && !sources) return EMPTY_DESIGN_TOKEN_CATALOG;
    const catalog = designTokenCatalog({
      manual: manual ?? [],
      sources: sources ?? [],
      themes,
      theme: effectiveDesignTheme(activeTheme, designThemeView(themes).baseId),
      sourceIds,
    });
    if (catalog.key === previous.current.key) return previous.current;
    previous.current = catalog.tokens.length > 0 ? catalog : EMPTY_DESIGN_TOKEN_CATALOG;
    return previous.current;
  }, [activeTheme, manual, sources, themes, sourceIds]);
}

function peek(workspaceId: string) {
  return designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
}
