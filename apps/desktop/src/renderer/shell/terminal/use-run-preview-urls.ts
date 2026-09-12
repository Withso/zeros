import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { runSessionId, type RunAction } from "@zeros/protocol/run-actions";
import { workspaceRunLog } from "../../platform/git";
import { bindPtyWriter } from "./terminal-store";
import { runPreviewCache, type RunPreviewTarget } from "./run-preview-cache";
import { type RunStatusMap } from "./use-run-status";

/** One controller subscription serves main, docked, and sidebar buttons.
 * Inactive workspaces detach streams and reads; returning revalidates logs
 * while the last confirmed address remains immediately available. */
export function useRunPreviewUrls(
  workspaceId: string | null,
  folderKey: string,
  actions: RunAction[],
  statuses: RunStatusMap,
  active: boolean,
) {
  const identities = JSON.stringify(
    actions
      .filter((action) => statuses[action.id]?.state === "running")
      .map((action) => [action.id, statuses[action.id].startedAt ?? null]),
  );
  const targets = useMemo(
    () =>
      workspaceId
        ? (JSON.parse(identities) as Array<[string, number | null]>).map(
            ([actionId, startedAt]) => ({
              actionId,
              target: {
                workspaceId,
                folderKey,
                sessionId: runSessionId(folderKey, actionId),
                startedAt,
              } satisfies RunPreviewTarget,
            }),
          )
        : [],
    [workspaceId, folderKey, identities],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? runPreviewCache.subscribe(listener) : () => {},
    [active],
  );
  const version = useSyncExternalStore(
    subscribe,
    runPreviewCache.getVersion,
    runPreviewCache.getVersion,
  );
  useEffect(() => {
    if (!active) return;
    const cleanup = targets.map(({ target }) =>
      bindPtyWriter(target.sessionId, (data) =>
        runPreviewCache.append(target, data),
      ),
    );
    for (const { target } of targets)
      void runPreviewCache.warm(target, () =>
        workspaceRunLog({
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
        }),
      );
    return () => {
      for (const off of cleanup) off();
      for (const { target } of targets) runPreviewCache.invalidate(target);
    };
  }, [active, targets]);
  return useMemo(
    () =>
      Object.fromEntries(
        targets.map(({ actionId, target }) => [
          actionId,
          runPreviewCache.peek(target),
        ]),
      ),
    // `version` tracks the external values read by cache.peek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, version],
  );
}
