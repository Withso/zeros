// A project workspace's repositories as its worker is configured with them.
import type { Tx } from "../db.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_V2_HOME_PATH, workspaceCheckoutPath } from "./workspace-layout.js";

export type WorkerRepositoryConfig = {
  repository: string; checkoutPath: string; branch: string; baseBranch: string; baseCommit?: string;
  github?: { repositoryId: string; repository: string; previousRepositories: string[] };
  setup?: string; setupScript?: string;
};
type Row = { position: number; repository: string; repository_id: string | null; folder: string | null; branch: string; base_branch: string;
  base_commit: string | null; setup: string | null; setup_script: string | null };

/** Each repository's checkout, branch and GitHub identity, and, unless the
 * workspace started from its project's ready copy (whose build already ran
 * them), each repository's setup from the project. A workspace made before
 * projects has none of this: its worker configuration is unchanged. */
export async function workerRepositories(tx: Tx, workspace: CloudV2Workspace, options: { forked: boolean }):
  Promise<{ root?: string; repositories?: WorkerRepositoryConfig[]; firstSetup?: { setup?: string; setupScript?: string } }> {
  if (!workspace.projectId || !workspace.checkoutFolder) return {};
  const { rows } = await tx.query<Row>(`SELECT r.position, r.repository, coalesce(r.repository_id, s.repository_id)::text AS repository_id, r.folder,
      r.branch, r.base_branch, r.base_commit, p.setup, p.setup_script
    FROM cloud_v2_workspace_repositories r
    LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
    LEFT JOIN cloud_project_repositories p ON p.project_id=$2 AND p.repository_id=coalesce(r.repository_id, s.repository_id)::text
    WHERE r.workspace_id=$1 ORDER BY r.position`, [workspace.id, workspace.projectId]);
  const setupOf = (row: Row) => options.forked ? {} : { ...(row.setup ? { setup: row.setup } : {}), ...(row.setup_script ? { setupScript: row.setup_script } : {}) };
  const first = rows[0];
  if (!workspace.folder || rows.length < 2) return first ? { firstSetup: setupOf(first) } : {};
  return {
    root: `${CLOUD_V2_HOME_PATH}/${workspace.folder}`,
    firstSetup: setupOf(first!),
    repositories: rows.map((row, index) => ({
      repository: index === 0 ? workspace.repository : row.repository,
      checkoutPath: index === 0 ? workspaceCheckoutPath(workspace) : `${CLOUD_V2_HOME_PATH}/${workspace.folder}/${row.folder}`,
      branch: index === 0 ? workspace.branch : row.branch, baseBranch: index === 0 ? workspace.baseBranch : row.base_branch,
      ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
      ...(row.repository_id && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(row.repository)
        ? { github: { repositoryId: row.repository_id, repository: row.repository, previousRepositories: [row.repository] } } : {}),
      ...setupOf(row),
    })),
  };
}

/** The repositories after the first, as the direct clone path prepares them:
 * each with its verified identity and its folder inside the project folder. */
export async function otherRepositories(tx: Tx, workspace: CloudV2Workspace): Promise<{ repository: string; repositoryId: string; checkoutFolder: string; baseBranch: string }[]> {
  if (!workspace.projectId || !workspace.folder) return [];
  const { rows } = await tx.query<{ repository: string; repository_id: string; folder: string; base_branch: string }>(`SELECT r.repository, s.repository_id::text, r.folder, r.base_branch
    FROM cloud_v2_workspace_repositories r JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
    WHERE r.workspace_id=$1 AND r.position > 0 AND r.folder IS NOT NULL ORDER BY r.position`, [workspace.id]);
  return rows.map(row => ({ repository: row.repository, repositoryId: row.repository_id, checkoutFolder: `${workspace.folder}/${row.folder}`, baseBranch: row.base_branch }));
}
