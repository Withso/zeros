import React, { useLayoutEffect, useMemo, useRef } from "react";
import type { Workspace } from "../../platform/git";
import {
  useWorkspaceStore,
  workbenchScopeForFolder,
} from "../../state/workspace-store";
import {
  useRetainedViewKeys,
  useStableRetainedViewOrder,
} from "../use-retained-view-keys";
import { DesignWorkbenchSurface } from "../../features/design-workspace/design-workbench-surface";

interface DesignTarget {
  workspace: Workspace;
  folder: string;
}

/** Keep two visited canvases without moving iframe DOM on A → B → A.
 * Removing an owner or replacing its checkout prunes the old surface. */
export function RetainedDesignDeck({
  workspace,
  folder,
  active,
}: {
  workspace: Workspace | null;
  folder: string | null;
  active: boolean;
}) {
  const scopes = useWorkspaceStore((state) => state.workbenchByScope);
  const retained = useRef(new Map<string, DesignTarget>());
  const current = useMemo(
    () => (workspace && folder ? { workspace, folder: workspace.path } : null),
    [workspace, folder],
  );
  const currentKey = current
    ? JSON.stringify([workspace!.id, workspace!.path])
    : null;
  const available = useMemo(
    () =>
      new Set([
        ...[...retained.current]
          .filter(
            ([, target]) =>
              scopes[workbenchScopeForFolder(target.folder)] &&
              (target.workspace.id !== workspace?.id ||
                target.workspace.path === workspace.path) &&
              (target.workspace.path !== workspace?.path ||
                target.workspace.id === workspace.id),
          )
          .map(([key]) => key),
        ...(currentKey ? [currentKey] : []),
      ]),
    [scopes, currentKey, workspace?.id, workspace?.path],
  );
  const keys = useRetainedViewKeys(active ? currentKey : null, 2, available);
  const order = useStableRetainedViewOrder(keys);
  useLayoutEffect(() => {
    if (active && current && currentKey)
      retained.current.set(currentKey, current);
    for (const key of retained.current.keys())
      if (!keys.includes(key)) retained.current.delete(key);
  }, [active, current, currentKey, keys]);
  return order.map((key) => {
    const target = key === currentKey ? current : retained.current.get(key);
    if (!target) return null;
    const visible = active && key === currentKey;
    return (
      <div
        key={key}
        data-design-retained-workspace={target.workspace.id}
        {...(!visible ? { inert: "", "data-zeros-resize-freeze": "" } : {})}
        aria-hidden={!visible}
        className={`absolute inset-0 flex min-h-0 min-w-0 overflow-hidden ${visible ? "pointer-events-auto visible" : "pointer-events-none invisible"}`}
      >
        <DesignWorkbenchSurface
          workspace={target.workspace}
          folder={target.folder}
          active={visible}
        />
      </div>
    );
  });
}
