import { HttpError } from "../authz.js";
import { isGithubTemporary } from "../github-availability.js";
import type { CloudSourceTarget } from "./source-authority.js";
import type { CloudV2InstalledRepository, CloudV2Workspace } from "./store.js";

/** errorCode fails the create; skipped means the row stopped being a pending
 * creating row meanwhile (deleted, stopped or resolved by another step). */
export type PendingSourceOutcome = { baseCommit: string | null } | { errorCode: string } | { skipped: true };

export type PendingSourceDeps = {
  activeComputer(organizationId: string): Promise<{ buildId: string; repositories: readonly CloudV2InstalledRepository[] } | null>;
  authorizeBuildRepository(organizationId: string, userId: string, buildId: string, repository: string,
    options: { fresh?: boolean; renew?: boolean }): Promise<CloudSourceTarget>;
  remoteHead(organizationId: string, userId: string, target: CloudSourceTarget, branch: string): Promise<string | null>;
  resolve(id: string, input: { sourceRepositoryId: string; readableRepositoryIds: readonly string[]; baseCommit: string | null }): Promise<boolean>;
};

const refused = (error: HttpError) => error.status === 403 || error.status === 404;
/** A definite answer fails the create at once, as it fails a synchronous
 * create's request. Outages, rate limits, a connection that changed mid-check
 * and unexpected errors return null and are left to the lifecycle's retries. */
function definite(error: unknown): HttpError | null {
  if (!(error instanceof HttpError) || error.status >= 500 || error.status === 429 || error.code === "github_authorization_changed") return null;
  return isGithubTemporary(error) ? null : error;
}

/** The checks a synchronous create makes before its insert, in the same
 * order and as the creator, run by the lifecycle before any VM exists.
 * Temporary GitHub failures throw, so the lifecycle retries them. */
export function createPendingSourceResolver(deps: PendingSourceDeps) {
  return async (workspace: CloudV2Workspace): Promise<PendingSourceOutcome> => {
    const { organizationId, creatorUserId: userId } = workspace;
    const computer = await deps.activeComputer(organizationId);
    if (!computer || computer.buildId !== workspace.computerBuildId) return { errorCode: "cloud_computer_changed" };
    const requested = (entry: CloudV2InstalledRepository) => entry.repository.toLowerCase() === workspace.repository.toLowerCase();
    const named = computer.repositories.findIndex(requested);
    if (named < 0) return { errorCode: "repository_not_installed" };
    // One verification per creator at a time, and a denial invalidates the
    // ones queued behind it: the requested repository first, then the rest
    // in order. Only its branch read overlaps them.
    const order = [named, ...[...computer.repositories.keys()].filter(index => index !== named)];
    const readable: string[] = [];
    let target: CloudSourceTarget | undefined, head: Promise<string | null> | undefined;
    for (const index of order) {
      const entry = computer.repositories[index]!;
      try {
        const resolved = await deps.authorizeBuildRepository(organizationId, userId, computer.buildId, entry.repository,
          index === named ? { renew: true } : { fresh: true });
        readable.push(resolved.repositoryId);
        if (index === named) {
          target = resolved;
          head = deps.remoteHead(organizationId, userId, resolved, workspace.baseBranch);
          head.catch(() => {});
        }
      } catch (error) {
        const answer = definite(error);
        if (!answer) throw error;
        // Another repository the creator can't read only narrows the scope.
        if (!refused(answer)) return { errorCode: answer.code };
        if (index === named) return { errorCode: "cloud_source_access_denied" };
      }
    }
    let baseCommit: string | null;
    try { baseCommit = await head!; }
    catch (error) {
      const answer = definite(error);
      if (!answer) throw error;
      return { errorCode: refused(answer) ? "cloud_source_access_denied" : answer.code };
    }
    if (baseCommit === null) return { errorCode: "repository_branch_not_found" };
    try {
      return await deps.resolve(workspace.id, { sourceRepositoryId: target!.repositoryId, readableRepositoryIds: readable, baseCommit })
        ? { baseCommit } : { skipped: true };
    } catch (error) {
      // The member left, lost Pro or was held, or the Computer changed.
      const answer = definite(error);
      if (!answer) throw error;
      return { errorCode: answer.code };
    }
  };
}
