import { HttpError } from "../authz.js";
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

const refused = (error: unknown): error is HttpError => error instanceof HttpError && [403, 404].includes(error.status);

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
        if (!refused(error)) throw error;
        if (index === named) return { errorCode: "cloud_source_access_denied" };
      }
    }
    const baseCommit = await head!;
    if (baseCommit === null) return { errorCode: "repository_branch_not_found" };
    try {
      return await deps.resolve(workspace.id, { sourceRepositoryId: target!.repositoryId, readableRepositoryIds: readable, baseCommit })
        ? { baseCommit } : { skipped: true };
    } catch (error) {
      // The member left, lost Pro or was held, or the Computer changed.
      if (error instanceof HttpError && error.status !== 503 && error.status !== 429) return { errorCode: error.code };
      throw error;
    }
  };
}
