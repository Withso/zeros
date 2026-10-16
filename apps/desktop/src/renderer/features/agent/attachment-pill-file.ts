import { useCallback, useEffect, useSyncExternalStore } from "react";
import { KeyedAsyncCache } from "@/renderer/shared/lib/keyed-async-cache";
import { loadWorkspaceFileRead } from "@/renderer/shell/workspace-file-data-cache";
import { attachmentOwner } from "./attachment-owner";
import {
  agentAttachmentPathCandidates,
  readAgentAttachmentFile,
} from "./attachment-file-reader";

interface SavedAttachmentFile {
  cwd: string;
  diskPath: string;
  attachmentId?: string;
}

const savedPaths = new KeyedAsyncCache<string>(128);
const keyFor = ({ cwd, diskPath, attachmentId }: SavedAttachmentFile) =>
  JSON.stringify([
    attachmentOwner(cwd),
    cwd.replace(/\/+$/, ""),
    diskPath,
    attachmentId,
  ]);

/** Restored pills can predate a context-folder migration. Resolve the stable
 * record before enabling navigation, sharing the same bounded file reads that
 * the preview and destination viewer consume. This never writes or wakes a VM. */
export function loadAttachmentPillFile(
  query: SavedAttachmentFile,
): Promise<string> {
  return savedPaths.load(
    keyFor(query),
    async () => {
      const result = await readAgentAttachmentFile(query, (cwd, path) =>
        loadWorkspaceFileRead({ cwd, path }, { maxAgeMs: 15_000 }).catch(
          () => null,
        ),
      );
      // A missing file still opens its exact path and the viewer's normal error
      // state. Never guess a different file from its basename.
      return result && result.kind !== "error" ? result.path : query.diskPath;
    },
    { maxAgeMs: 15_000 },
  );
}

export function useAttachmentPillFile({
  cwd,
  diskPath,
  attachmentId,
  enabled,
}: {
  cwd?: string | null;
  diskPath?: string;
  attachmentId?: string;
  enabled: boolean;
}): { path: string | undefined; resolving: boolean } {
  const needsResolution =
    !!cwd &&
    !!diskPath &&
    agentAttachmentPathCandidates({ diskPath, attachmentId }).length > 1;
  const key = needsResolution
    ? keyFor({ cwd: cwd!, diskPath: diskPath!, attachmentId })
    : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled && key ? savedPaths.subscribe(key, listener) : () => {},
    [enabled, key],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    useCallback(() => (key ? savedPaths.getSnapshot(key) : null), [key]),
    () => null,
  );
  useEffect(() => {
    if (!enabled || !needsResolution || !cwd || !diskPath) return;
    void loadAttachmentPillFile({ cwd, diskPath, attachmentId }).catch(
      () => {},
    );
  }, [enabled, needsResolution, cwd, diskPath, attachmentId, key]);
  return {
    path: snapshot?.data ?? diskPath,
    resolving: enabled && needsResolution && !!snapshot?.loading,
  };
}
