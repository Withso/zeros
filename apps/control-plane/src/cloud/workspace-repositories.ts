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
  base_commit: string | null; setup: string | null; setup_script: string | null;
  /** C4: this repository's planned submodules (cloud_v2_workspace_submodules 'fetch' rows), parents first; null without any. */
  submodules: Omit<WorkerSubmodule, "position">[] | null };
/** One planned submodule as the worker gets it (workspace-submodules-v1). */
export type WorkerSubmodule = { position: number; path: string; repository: string; commit: string; gitDir: string; public?: true };

/** Each repository's checkout, branch and GitHub identity, and, unless the
 * workspace started from its project's ready copy (whose build already ran
 * them), each repository's setup from the project. A workspace made before
 * projects has none of this: its worker configuration is unchanged. */
export async function workerRepositories(tx: Tx, workspace: CloudV2Workspace, options: { forked: boolean }):
  Promise<{ root?: string; repositories?: WorkerRepositoryConfig[]; firstSetup?: { setup?: string; setupScript?: string }; submodules?: WorkerSubmodule[] }> {
  if (!workspace.projectId || !workspace.checkoutFolder) return {};
  // The submodules ride in this same statement: a workspace's hello costs no more for them (and a workspace with
  // none costs nothing at all). Only project workspaces have them.
  const { rows } = await tx.query<Row>(`SELECT r.position, r.repository, coalesce(r.repository_id, s.repository_id)::text AS repository_id, r.folder,
      r.branch, r.base_branch, r.base_commit, p.setup, p.setup_script,
      (SELECT jsonb_agg(jsonb_build_object('path', m.path, 'repository', m.repository, 'commit', m.commit, 'gitDir', m.git_dir, 'public', m.public)
          ORDER BY char_length(m.git_dir), m.path)
        FROM cloud_v2_workspace_submodules m WHERE m.workspace_id=r.workspace_id AND m.position=r.position AND m.status='fetch') AS submodules
    FROM cloud_v2_workspace_repositories r
    LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
    LEFT JOIN cloud_project_repositories p ON p.project_id=$2 AND p.repository_id=coalesce(r.repository_id, s.repository_id)::text
    WHERE r.workspace_id=$1 ORDER BY r.position`, [workspace.id, workspace.projectId]);
  const setupOf = (row: Row) => options.forked ? {} : { ...(row.setup ? { setup: row.setup } : {}), ...(row.setup_script ? { setupScript: row.setup_script } : {}) };
  const planned: WorkerSubmodule[] = rows.flatMap(row => (row.submodules ?? []).slice(0, 32).map(({ public: isPublic, ...entry }) =>
    ({ position: row.position, ...entry, ...(isPublic ? { public: true as const } : {}) })));
  const submodules = planned.length ? { submodules: planned } : {};
  const first = rows[0];
  if (!workspace.folder || rows.length < 2) return first ? { firstSetup: setupOf(first), ...submodules } : {};
  return {
    root: `${CLOUD_V2_HOME_PATH}/${workspace.folder}`,
    firstSetup: setupOf(first!), ...submodules,
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

/** The source a workspace's GitHub token is minted for: its first repository
 * without a name, else the named one, which must be one of the workspace's own
 * repositories and one of its sources (GitHub compares names case-insensitively;
 * names are ASCII by schema). Null for anything else, so a token request never
 * reaches another workspace's repository or a source outside its repositories. */
export async function workspaceTokenSource(tx: Tx, workspaceId: string, repository: string | null): Promise<{ repository: string; repositoryId: string } | null> {
  const { rows } = await tx.query<{ repository: string; repositoryId: string }>(`SELECT s.source_repository AS repository, s.repository_id::text AS "repositoryId"
    FROM cloud_v2_workspaces w JOIN cloud_v2_github_sources s ON s.workspace_id=w.id
    WHERE w.id=$1 AND s.source_repository=lower(coalesce($2::text, w.repository))
      AND ($2::text IS NULL OR lower($2::text)=lower(w.repository)
        OR EXISTS (SELECT 1 FROM cloud_v2_workspace_repositories r WHERE r.workspace_id=w.id AND lower(r.repository)=lower($2::text)))`,
    [workspaceId, repository]);
  return rows[0] ?? null;
}
