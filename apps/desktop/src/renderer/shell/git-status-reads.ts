import {
  gitStatus,
  gitChangeCounts,
  type StatusResult,
  type ChangeCounts,
} from "../platform/git";
import {
  isCloudWorkspace,
  parseCloudScopedId,
} from "../platform/bridge/cloud-workspace-key";
import { LatestGenerationFlight } from "../shared/lib/latest-generation-flight";
import { registerReviewCacheForget } from "../features/code-review/review-cache-forget";

const statusRequests = new LatestGenerationFlight<StatusResult>();
const countRequests = new LatestGenerationFlight<ChangeCounts>();
const owners = new Set<{ workspaceId: string; folder: string }>();

registerReviewCacheForget((ownsFolder) => {
  for (const owner of owners) {
    if (!ownsFolder(owner.folder)) continue;
    statusRequests.forget(owner.workspaceId);
    countRequests.forget(owner.workspaceId);
    owners.delete(owner);
  }
});

/** Changes, the PR row and Summary share one native observation per refresh
 * generation. Local gets the optional base comparison; cloud keeps its wire
 * request and worker behavior unchanged. No settled data lives in this layer. */
export function statusForGeneration(
  workspaceId: string,
  generation: number,
  cwd: string,
): Promise<StatusResult> {
  const owner = { workspaceId, folder: cwd };
  owners.add(owner);
  const cloud =
    isCloudWorkspace(cwd) ||
    isCloudWorkspace(workspaceId) ||
    !!parseCloudScopedId(workspaceId);
  const request = statusRequests.run(workspaceId, generation, () =>
    cloud
      ? gitStatus(workspaceId)
      : gitStatus(workspaceId, { includeSummary: true }),
  );
  const release = () => {
    owners.delete(owner);
  };
  void request.then(release, release);
  return request;
}

export function changeCountsForGeneration(
  workspaceId: string,
  generation: number,
): Promise<ChangeCounts> {
  return countRequests.run(workspaceId, generation, () =>
    gitChangeCounts(workspaceId),
  );
}
