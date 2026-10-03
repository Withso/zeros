import { useEffect } from "react";
import {
  getActiveBridge,
  onActiveBridgeChange,
  onActiveBridgeConnected,
} from "@/renderer/platform/bridge/active-bridge";
import {
  workspaceGitReviewClient,
  type GitReviewActionsClient,
} from "@/renderer/platform/git-review-actions";
import { useCachedRead } from "@/renderer/state/use-cached-read";
import {
  hunkReviewCache,
  hunkReviewCacheKey,
  hunkReviewTargetFromKey,
} from "./hunk-review-cache";
import {
  beginReviewCacheRequest,
  registerReviewCacheForget,
} from "./review-cache-forget";

const aliases = new Map<string, string>();
const connectionOwners = new Map<
  string,
  { users: number; dispose: () => void }
>();
registerReviewCacheForget((ownsFolder) => {
  for (const key of aliases.keys()) {
    if (ownsFolder(hunkReviewTargetFromKey(key).cwd)) aliases.delete(key);
  }
  for (const [cwd, owner] of connectionOwners) {
    if (!ownsFolder(cwd)) continue;
    owner.dispose();
    connectionOwners.delete(cwd);
  }
});
let started = false;
function startEvents(): void {
  if (started) return;
  started = true;
  let off: (() => void) | undefined;
  const attach = (bridge: ReturnType<typeof getActiveBridge>) => {
    off?.();
    off = bridge?.on("DB_CHANGED", (message) => {
      if (
        message.type !== "DB_CHANGED" ||
        !message.kinds.some(
          (kind) => kind === "workspaces" || String(kind) === "gitReview",
        )
      )
        return;
      const ids = message.workspaceIds;
      for (const key of hunkReviewCache.keys()) {
        const owner = hunkReviewTargetFromKey(key);
        if (
          owner.identity === workspaceGitReviewClient.identity &&
          (!ids?.length ||
            ids.includes(owner.cwd) ||
            ids.includes(aliases.get(key) ?? ""))
        )
          hunkReviewCache.invalidate(key);
      }
    });
  };
  attach(getActiveBridge());
  onActiveBridgeChange((bridge) => {
    hunkReviewCache.invalidateAll();
    attach(bridge);
  });
}
function retainConnection(cwd: string): () => void {
  let owner = connectionOwners.get(cwd);
  if (!owner) {
    owner = {
      users: 0,
      dispose: onActiveBridgeConnected((_client, info) => {
        if (info.initial) return;
        for (const key of hunkReviewCache.keys()) {
          const target = hunkReviewTargetFromKey(key);
          if (
            target.identity === workspaceGitReviewClient.identity &&
            target.cwd === cwd
          )
            hunkReviewCache.invalidate(key);
        }
      }, cwd),
    };
    connectionOwners.set(cwd, owner);
  }
  owner.users += 1;
  const owned = owner;
  return () => {
    if (--owned.users === 0) {
      owned.dispose();
      if (connectionOwners.get(cwd) === owned) connectionOwners.delete(cwd);
    }
  };
}

export function useHunkReviews(
  cwd: string,
  path: string,
  active: boolean,
  client: GitReviewActionsClient = workspaceGitReviewClient,
) {
  const key =
    cwd && path ? hunkReviewCacheKey(client.identity, cwd, path) : null;
  const snapshot = useCachedRead(
    hunkReviewCache,
    key,
    async (requestedKey) => {
      const target = hunkReviewTargetFromKey(requestedKey);
      if (target.identity !== client.identity)
        throw new Error("The review owner changed. Reopen this file.");
      const request = beginReviewCacheRequest(target.cwd);
      try {
        const result = await client.list(target.cwd, target.path);
        request.assertCurrent();
        aliases.set(requestedKey, result.workspaceId);
        const retained = new Set(hunkReviewCache.keys());
        for (const alias of aliases.keys())
          if (!retained.has(alias)) aliases.delete(alias);
        return result.decisions;
      } finally {
        request.finish();
      }
    },
    { enabled: active, maxAgeMs: 15_000 },
  );
  useEffect(() => {
    if (!active || !cwd || client !== workspaceGitReviewClient) return;
    startEvents();
    return retainConnection(cwd);
  }, [active, cwd, client]);
  return { ...snapshot, key };
}
