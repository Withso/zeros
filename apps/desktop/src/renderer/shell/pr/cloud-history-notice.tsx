import React, { useEffect, useRef } from "react";
import type { Workspace } from "../../platform/git";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { statusForGeneration } from "../workbench/tabs/changes-tab";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

const history = new KeyedAsyncCache<{ shallow: boolean; refreshKey: number }>(64);
registerPrWorkspaceCacheForget(id => {
  for (const key of history.keys()) if (JSON.parse(key)[0] === id) history.forget(key);
});

/** Shared Changes/Review chrome. Reuse their exact Git status flight and retain
 * the confirmed workspace snapshot while refreshing, including on failure. */
export function CloudHistoryNotice({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const id = workspace.placement === "cloud" ? workspace.id : null;
  const key = id ? JSON.stringify([id, workspace.path]) : null;
  const refreshKey = useGitRefreshKey(workspace.path, id, active && id !== null);
  const previous = useRef<{ key: string; refreshKey: number } | null>(null);
  useEffect(() => {
    if (!active || !key) return;
    const confirmed = history.peekSnapshot(key).data;
    if ((previous.current?.key === key && previous.current.refreshKey !== refreshKey) ||
      (confirmed && confirmed.refreshKey !== refreshKey)) history.invalidate(key);
    previous.current = { key, refreshKey };
  }, [active, key, refreshKey]);
  const { data } = useCachedRead(history, key, async requestedKey => {
    const [workspaceId, folder] = JSON.parse(requestedKey) as [string, string];
    const status = await statusForGeneration(workspaceId, refreshKey, folder);
    return { shallow: status.shallow === true, refreshKey };
  }, { enabled: active, maxAgeMs: 30_000 });
  if (!data?.shallow) return null;
  return (
    <div role="status" className="border-border1 bg-yellow-bg text-yellow-fg shrink-0 border-b px-3 py-2 text-xs">
      Shallow Git history: older commits and comparisons may be incomplete. Ask your agent to fetch full history.
    </div>
  );
}
