import { useCallback, useId, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { isCloudUnavailable, workbenchSourcesFor } from "../shell/workbench/tab-status-model";
import { useDocumentActive } from "./use-document-active";

/** Settings and side columns use the same one-retry policy as workbench reads.
 * This only owns recovery/presentation: callers retain their exact-key cache,
 * connection admission and read errors (including action safety checks). */
export function useReadRecovery(
  key: string,
  {
    error,
    pending,
    hasContent,
    retry,
    connected,
    active = true,
    folder = "",
  }: {
    error: Error | null;
    pending: boolean;
    hasContent: boolean;
    retry: () => void | Promise<unknown>;
    connected: boolean;
    active?: boolean;
    folder?: string;
  },
) {
  const visible = useDocumentActive(active);
  const sources = useMemo(() => workbenchSourcesFor(`read:${key}`, folder), [key, folder]);
  const observed = useMemo(() => ({ error: null as Error | null }), [sources]);
  // Starting a retry clears the cache's error before it confirms new data.
  // Write/access guards must keep the known failure until that read settles.
  if (error || !pending) observed.error = error;
  const id = useId();
  // A callback already handed to a retired owner's retry must never invoke a
  // new destination's closure. Same-owner callbacks may use the newest read.
  const ownedRetry = useMemo(() => ({ owner: sources, current: undefined as (() => void | Promise<unknown>) | undefined }), [sources]);
  ownedRetry.current = retry;
  const retrySource = useCallback(() => ownedRetry.current?.(), [ownedRetry]);
  useLayoutEffect(() => {
    sources.update(id, {
      error, pending, hasContent, primary: true,
      active: visible, retry: retrySource, retryKey: key,
      retryAvailable: connected,
    });
  }, [sources, id, key, error, pending, hasContent, visible, connected, retrySource]);
  useLayoutEffect(() => () => sources.remove(id), [sources, id]);
  const status = useSyncExternalStore(sources.subscribe, sources.snapshot, sources.snapshot);
  return {
    // Transport availability is owned by the app/workspace. It must not be
    // duplicated as an unrelated settings, Git or provider read failure.
    // Workbench frames render unsupported capabilities as notices. Passive
    // surfaces have no frame to render that notice, so preserve the definitive
    // response instead of leaving a cold read pending forever. It is not retried.
    error: visible && connected
      ? isCloudUnavailable(error) ? error : status.failure as Error | null
      : null,
    readError: observed.error,
    pending: pending || status.pending,
  };
}
