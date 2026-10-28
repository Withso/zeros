import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import type { CloudV2Workspace } from "./store.js";

export class CloudGithubSourceIdentities {
  constructor(private readonly pool: pg.Pool) {}
  async targets(
    workspace: CloudV2Workspace,
    sources: readonly string[],
  ): Promise<readonly { repository: string; repositoryId: string }[]> {
    const { rows } = await withSystemTx(this.pool, (tx) =>
      tx.query<{ source_repository: string; repository_id: string }>(
        `SELECT s.source_repository,s.repository_id::text FROM cloud_v2_github_sources s JOIN cloud_v2_workspaces w ON w.id=s.workspace_id
       WHERE w.id=$1 AND w.org_id=$2 AND w.creator_user_id=$3 AND w.state NOT IN ('deleted','deleting')`,
        [workspace.id, workspace.organizationId, workspace.creatorUserId],
      ),
    );
    const ids = new Map(
      rows.map((row) => [row.source_repository, row.repository_id]),
    );
    if (
      !sources.length ||
      sources.some((source) => !ids.has(source.toLowerCase()))
    )
      throw new HttpError(
        409,
        "cloud_source_review_required",
        "This older workspace needs its original repository identities verified. Its files have been retained.",
      );
    return sources.map((repository) => ({
      repository,
      repositoryId: ids.get(repository.toLowerCase())!,
    }));
  }
  async primary(workspace: CloudV2Workspace) {
    return (await this.targets(workspace, [workspace.repository]))[0]!;
  }
}
