import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { gitFetch, type Workspace } from "../../platform/git";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { toast } from "../../shared/ui/primitives/elements";
import { useCachedRead } from "../../state/use-cached-read";
import { triggerGitRefresh, useGitRefreshKey } from "../use-git-refresh-key";
import { useWorkbenchStatusSource } from "../workbench/tab-status";
import { statusForGeneration } from "../workbench/tabs/changes-tab";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

const history = new KeyedAsyncCache<{ shallow: boolean; refreshKey: number }>(64);
const actions = new KeyedAsyncCache<{ busy: boolean; limited: boolean }>(64);
const flights = new Map<string, Promise<void>>();
const idle = { busy: false, limited: false };
const message = "Shallow Git history — older commits and comparisons may be incomplete.";
registerPrWorkspaceCacheForget(id => {
  for (const key of new Set([...history.keys(), ...actions.keys(), ...flights.keys()])) {
    if (JSON.parse(key)[0] !== id) continue;
    history.forget(key); actions.forget(key); flights.delete(key);
  }
});

function fetchFullHistory(key: string): Promise<void> {
  const pending = flights.get(key);
  if (pending) return pending;
  if (flights.size >= 16) {
    toast.error("Git history fetching is busy. Try again shortly.");
    return Promise.resolve();
  }
  const [workspaceId, folder] = JSON.parse(key) as [string, string];
  let limited = false;
  const flight = Promise.resolve().then(() => gitFetch({ workspaceId, unshallow: true }))
    .then(result => {
      if (flights.get(key) !== flight) return;
      limited = result.historyLimited === true;
      // Only a confirmed git.status clears the notice, never a fetch reply.
      triggerGitRefresh(folder);
      history.invalidate(key);
    }).catch(() => {
      if (flights.get(key) === flight) toast.error("Couldn't fetch full Git history. Try again.");
    }).finally(() => {
      if (flights.get(key) !== flight) return;
      flights.delete(key);
      actions.setData(key, { busy: false, limited });
    });
  flights.set(key, flight);
  actions.setData(key, { busy: true, limited: false });
  return flight;
}

/** Publishes a source into the tab's one banner slot; renders no second strip. */
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
  const load = useCallback(async (requestedKey: string) => {
    const [workspaceId, folder] = JSON.parse(requestedKey) as [string, string];
    const status = await statusForGeneration(workspaceId, refreshKey, folder);
    return { shallow: status.shallow === true, refreshKey };
  }, [refreshKey]);
  const read = useCachedRead(history, key, load, { enabled: active, maxAgeMs: 30_000 });
  const retry = useCallback(() => key && active ? history.load(key, () => load(key), { force: true }) : undefined, [key, active, load]);
  const action = useSyncExternalStore(
    useCallback(listener => key && active ? actions.subscribe(key, listener) : () => {}, [key, active]),
    useCallback(() => key ? actions.getSnapshot(key).data ?? idle : idle, [key]),
    () => idle,
  );
  const run = useCallback(() => key && active ? fetchFullHistory(key) : Promise.resolve(), [key, active]);
  const notice = useMemo(() => read.data?.shallow ? {
    tone: "neutral" as const,
    message: action.limited ? `${message} Fetch stopped at the 60-second or 256 MiB limit.` : message,
    action: { label: "Fetch full history", busyLabel: "Fetching…", busy: action.busy, run },
  } : undefined, [read.data?.shallow, action.limited, action.busy, run]);
  useWorkbenchStatusSource({ notice, active: active && id !== null, pending: read.loading || read.refreshing,
    error: read.error, retry }, key ?? undefined);
  return null;
}
