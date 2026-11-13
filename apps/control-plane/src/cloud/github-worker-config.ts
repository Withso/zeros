import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { readGithubGitAuthor } from "../github-git-author.js";
import type { CloudGithubConnections } from "./github-connections.js";
import type { CloudGithubPrStore } from "./github-pr-store.js";
import type { CloudGithubPrContext } from "./github-pr-service.js";
import { CloudSourceTargetSchema } from "./source-authority.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_V2_LIVE_ACCESS, requireWorkspaceCreator } from "./workspace-access.js";

type SourceRow = {
  repository: string; state: CloudV2Workspace["state"]; worker_boot_id: string | null;
  access_epoch: string; login_revision: string; source: string; source_count: number; repository_id: string | null;
  repository_aliases: string[] | null;
};
type Snapshot = {
  context: CloudGithubPrContext; bootId: string | null; state: CloudV2Workspace["state"]; sources: string;
  accessEpoch: string; loginRevision: string; primary: SourceRow; aliases: string[];
};
const changed = () => new HttpError(409, "github_authorization_changed", "Worker configuration authority changed. Try again.");

export function createCloudGithubWorkerConfig(deps: {
  pool: pg.Pool; connections: CloudGithubConnections; metadata: CloudGithubPrStore;
}) {
  return async (workspace: CloudV2Workspace) => {
    requireWorkspaceCreator(workspace);
    const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
    const read = async (tx: Tx, expected?: Snapshot): Promise<Snapshot> => {
      const context = await deps.metadata.context(workspace.id, workspace.creatorUserId, tx);
      const { rows } = await tx.query<SourceRow>(`SELECT w.repository,w.state,w.worker_boot_id,w.access_epoch::text,w.login_revision::text,
          src.name AS source,cardinality(w.source_repositories) AS source_count,s.repository_id::text,g.repository_aliases
        FROM cloud_v2_workspaces w CROSS JOIN LATERAL unnest(w.source_repositories) src(name)
        LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(src.name)
        LEFT JOIN cloud_v2_github_workspaces g ON g.workspace_id=w.id
        WHERE w.id=$1 AND w.org_id=$2 AND w.creator_user_id=$3 AND w.state NOT IN ('deleted','deleting') AND ${CLOUD_V2_LIVE_ACCESS}
        LIMIT 101`, [workspace.id, scope.organizationId, scope.userId]);
      const primary = rows.find(row => row.source.toLowerCase() === row.repository.toLowerCase());
      if (!primary || rows.length > 100 || rows.length !== primary.source_count || rows.some(row =>
        !CloudSourceTargetSchema.safeParse({ repository: row.source, repositoryId: row.repository_id }).success))
        throw new HttpError(409, "cloud_source_review_required", "This workspace needs its original repository identities verified.");
      if (primary.repository !== workspace.repository || primary.state !== workspace.state ||
          context.repositoryId && context.repositoryId !== primary.repository_id) throw changed();
      const current: Snapshot = { context, primary, accessEpoch: primary.access_epoch, loginRevision: primary.login_revision,
        bootId: primary.worker_boot_id, state: primary.state,
        sources: JSON.stringify(rows.map(row => [row.source.toLowerCase(), row.repository_id]).sort()),
        aliases: [...new Set([workspace.repository, ...(primary.repository_aliases ?? []), context.repository])],
      };
      if (expected && (current.sources !== expected.sources || current.bootId !== expected.bootId || current.state !== expected.state ||
          current.accessEpoch !== expected.accessEpoch || current.loginRevision !== expected.loginRevision ||
          current.context.authorityRevision !== expected.context.authorityRevision ||
          current.context.repository !== expected.context.repository || current.context.repositoryId !== expected.context.repositoryId ||
          current.context.revision !== expected.context.revision || current.context.branch !== expected.context.branch ||
          current.context.baseBranch !== expected.context.baseBranch)) throw changed();
      return current;
    };
    const initial = await withSystemTx(deps.pool, tx => read(tx));
    return {
      repositoryBinding: { repositoryId: initial.primary.repository_id!, repository: initial.context.repository,
        previousRepositories: initial.aliases },
      loginRevision: initial.loginRevision,
      // Last config phase: fence the intervening login, environment and tool
      // reads without asking GitHub for authority over local work.
      gitIdentity: () => withSystemTx(deps.pool, async tx => {
        const selected = await deps.connections.store.selectedIdentity(scope, tx);
        const identity = selected ? await readGithubGitAuthor(tx, scope.userId, selected.identity) : null;
        await selected?.assertCurrent();
        await read(tx, initial);
        return identity;
      }),
    };
  };
}
