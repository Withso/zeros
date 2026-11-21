import type pg from "pg";
import { workspaceCheckoutPath, workspaceRootPath } from "./workspace-layout.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudGithubPullRequest } from "./github-api.js";
import {
  CloudGithubCheckoutSchema,
  type CloudGithubCheckout,
} from "./github-pr-contract.js";
import type { CloudGithubPrContext } from "./github-pr-service.js";
import type { CloudGithubRepositoryIdentity } from "./github-http.js";
import type { CloudGithubWorkspaceDocument } from "./routes.js";
import type { CloudV2Workspace } from "./store.js";
import { hashCloudV2Token } from "./tokens.js";
import { CLOUD_V2_LIVE_ACCESS, cloudV2ActorAccess } from "./workspace-access.js";

type Metadata = {
  workspace_id: string;
  repository_id: string | null;
  canonical_repository: string | null;
  repository_aliases: string[];
  checkout_boot_id: string | null;
  checkout_sequence: string;
  checkout_revision: string;
  branch: string | null;
  base_branch: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_state: "draft" | "ready" | "merged" | "closed" | null;
  pr_url: string | null;
  pr_connection_generation: string | null;
  updated_at: Date;
};
const changed = () =>
  new HttpError(
    409,
    "github_authorization_changed",
    "The workspace changed. Refresh before continuing.",
  );
const unauthorized = () =>
  new HttpError(401, "worker_boot_changed", "Worker authorization changed.");

/** One durable record per checkout. Worker reports can update branch metadata,
 * but only a verified GitHub API response can bind repository identity. */
export class CloudGithubPrStore {
  constructor(private readonly pool: pg.Pool) {}

  private async readContext(
    tx: Tx,
    workspaceId: string,
    userId: string,
    lock = false,
    repository?: string,
  ): Promise<CloudGithubPrContext> {
    if (repository) {
      const other = await this.readOtherContext(tx, workspaceId, userId, lock, repository);
      if (other) return other;
    }
    const row = (
      await tx.query<{
        id: string;
        org_id: string;
        creator_user_id: string;
        repository: string;
        branch: string;
        base_branch: string;
        worker_boot_id: string | null;
        metadata: Metadata | null;
        execution_mode: string;
        authority_revision: string;
      }>(
        `SELECT w.id,w.org_id,w.creator_user_id,w.repository,w.branch,w.base_branch,w.worker_boot_id,
        w.execution_mode,concat_ws(':',w.access_epoch,w.stop_generation,u.auth_revision,m.authorization_revision,o.authorization_revision) AS authority_revision,
        row_to_json(g.*) AS metadata FROM cloud_v2_workspaces w
        JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2 JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id
        LEFT JOIN cloud_v2_github_workspaces g ON g.workspace_id=w.id
        WHERE w.id=$1 AND ${cloudV2ActorAccess("$2")} AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}
        ${lock ? "FOR UPDATE OF w" : ""}`,
        [workspaceId, userId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(404, "not_found", "Cloud workspace not found.");
    const g = row.metadata,
      observed = !!g?.checkout_boot_id;
    // A named repository that is neither a later one nor the first is refused, never served as the first.
    if (repository !== undefined && ![row.repository, g?.canonical_repository].some(name => name?.toLowerCase() === repository.toLowerCase()))
      throw new HttpError(404, "not_found", "This repository is not part of this workspace.");
    return {
      workspaceId: row.id,
      organizationId: row.org_id,
      creatorUserId: row.creator_user_id,
      ...(row.execution_mode === "active" ? { actorUserId: userId, authorityRevision: row.authority_revision } : {}),
      repository: g?.canonical_repository ?? row.repository,
      repositoryId: g?.repository_id == null ? null : String(g.repository_id),
      repositoryBound: g?.repository_id != null && !!g.canonical_repository,
      branch: observed ? g!.branch : row.branch,
      baseBranch: g?.base_branch ?? row.base_branch,
      headSha: g?.head_sha ?? null,
      revision: `${row.worker_boot_id ?? "stopped"}:${g?.checkout_revision ?? "0"}`,
    };
  }

  /** A repository after the first of a workspace of several, by its name or its current
   * GitHub name (GitHub compares names case-insensitively; names are ASCII by schema);
   * null otherwise, and readContext then accepts only the first's own name. */
  private async readOtherContext(tx: Tx, workspaceId: string, userId: string, lock: boolean, repository: string): Promise<CloudGithubPrContext | null> {
    const row = (await tx.query<{ id: string; org_id: string; creator_user_id: string; worker_boot_id: string | null; execution_mode: string;
      authority_revision: string; position: number; repository: string; repository_id: string; branch: string; base_branch: string; metadata: Metadata | null }>(
      `SELECT w.id,w.org_id,w.creator_user_id,w.worker_boot_id,w.execution_mode,
        concat_ws(':',w.access_epoch,w.stop_generation,u.auth_revision,m.authorization_revision,o.authorization_revision) AS authority_revision,
        r.position,r.repository,coalesce(r.repository_id,s.repository_id)::text AS repository_id,r.branch,r.base_branch,row_to_json(g.*) AS metadata
      FROM cloud_v2_workspaces w
      JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=$2 JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id
      JOIN cloud_v2_workspace_repositories r ON r.workspace_id=w.id
      LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(r.repository)
      LEFT JOIN cloud_v2_github_workspace_repositories g ON g.workspace_id=w.id AND g.repository_id=coalesce(r.repository_id,s.repository_id)
      WHERE w.id=$1 AND ${cloudV2ActorAccess("$2")} AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}
        AND r.position > 0 AND (lower(r.repository)=lower($3) OR lower(g.canonical_repository)=lower($3))
      ORDER BY r.position LIMIT 1
      ${lock ? "FOR UPDATE OF w" : ""}`, [workspaceId, userId, repository])).rows[0];
    if (!row) return null;
    if (!row.repository_id) throw new HttpError(409, "github_repository_changed", "The saved GitHub repository identity changed.");
    const g = row.metadata, observed = !!g?.checkout_boot_id;
    return {
      workspaceId: row.id, organizationId: row.org_id, creatorUserId: row.creator_user_id,
      ...(row.execution_mode === "active" ? { actorUserId: userId, authorityRevision: row.authority_revision } : {}),
      other: { repository: row.repository, repositoryId: row.repository_id },
      repository: g?.canonical_repository ?? row.repository, repositoryId: row.repository_id, repositoryBound: true,
      branch: observed ? g!.branch : row.branch, baseBranch: g?.base_branch ?? row.base_branch, headSha: g?.head_sha ?? null,
      revision: `${row.worker_boot_id ?? "stopped"}:${g?.checkout_revision ?? "0"}`,
    };
  }

  /** `repository`: one of a workspace of several's repositories; the first without one. */
  context(workspaceId: string, userId: string, tx?: Tx, repository?: string): Promise<CloudGithubPrContext> {
    if (tx) return this.readContext(tx, workspaceId, userId, false, repository);
    return withSystemTx(this.pool, (tx) =>
      this.readContext(tx, workspaceId, userId, false, repository),
    );
  }

  private async assertContext(
    tx: Tx,
    expected: CloudGithubPrContext,
  ): Promise<CloudGithubPrContext> {
    const live = await this.readContext(
      tx,
      expected.workspaceId,
      expected.actorUserId ?? expected.creatorUserId,
      true,
      expected.other?.repository,
    );
    if (
      live.revision !== expected.revision || live.actorUserId !== expected.actorUserId || live.authorityRevision !== expected.authorityRevision ||
      live.branch !== expected.branch ||
      live.baseBranch !== expected.baseBranch ||
      live.organizationId !== expected.organizationId
    )
      throw changed();
    return live;
  }

  repository(
    context: CloudGithubPrContext,
    identity: Pick<CloudGithubRepositoryIdentity, "repositoryId" | "repository">,
    observation?: { at: Date; assertCurrent(tx: Tx): Promise<void> },
    transaction?: Tx,
  ): Promise<void> {
    const write = async (tx: Tx) => {
      await observation?.assertCurrent(tx);
      const current = await this.assertContext(tx, context);
      if (current.repositoryId && current.repositoryId !== identity.repositoryId)
        throw new HttpError(409, "github_repository_changed", "The saved GitHub repository identity changed.");
      if (current.other) {
        // A repository after the first: its identity was verified at create; only its current name is kept.
        await tx.query(`INSERT INTO cloud_v2_github_workspace_repositories(workspace_id,repository_id,canonical_repository) VALUES($1,$2,$3)
          ON CONFLICT(workspace_id,repository_id) DO UPDATE SET canonical_repository=EXCLUDED.canonical_repository,
            updated_at=CASE WHEN cloud_v2_github_workspace_repositories.canonical_repository IS DISTINCT FROM EXCLUDED.canonical_repository
              THEN clock_timestamp() ELSE cloud_v2_github_workspace_repositories.updated_at END`,
          [context.workspaceId, identity.repositoryId, identity.repository]);
        return;
      }
      const result = await tx.query(
        `INSERT INTO cloud_v2_github_workspaces(workspace_id,repository_id,canonical_repository,repository_observed_at)
        VALUES($1,$2,$3,coalesce($4::timestamptz,clock_timestamp())) ON CONFLICT(workspace_id) DO UPDATE SET repository_id=EXCLUDED.repository_id,
          canonical_repository=EXCLUDED.canonical_repository,
          repository_observed_at=EXCLUDED.repository_observed_at,
          repository_aliases=ARRAY(SELECT DISTINCT alias FROM unnest(cloud_v2_github_workspaces.repository_aliases ||
            ARRAY[cloud_v2_github_workspaces.canonical_repository,EXCLUDED.canonical_repository]) alias WHERE alias IS NOT NULL ORDER BY alias LIMIT 100),
          updated_at=CASE WHEN cloud_v2_github_workspaces.canonical_repository IS DISTINCT FROM EXCLUDED.canonical_repository
            THEN clock_timestamp() ELSE cloud_v2_github_workspaces.updated_at END
        WHERE (cloud_v2_github_workspaces.repository_id IS NULL OR cloud_v2_github_workspaces.repository_id=EXCLUDED.repository_id)
          AND (cloud_v2_github_workspaces.repository_observed_at IS NULL OR cloud_v2_github_workspaces.repository_observed_at<EXCLUDED.repository_observed_at)
        RETURNING workspace_id`,
        [context.workspaceId, identity.repositoryId, identity.repository, observation?.at ?? null],
      );
      if (result.rowCount && current.repository !== identity.repository) {
        await tx.query(
          "UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1",
          [context.workspaceId],
        );
        await tx.query("SELECT pg_notify('zeros_cloud_v2_logins',$1)", [
          JSON.stringify({
            organizationId: context.organizationId,
            ownerUserId: context.creatorUserId,
          }),
        ]);
      }
    };
    return transaction ? write(transaction) : withSystemTx(this.pool, write);
  }

  async aliases(workspace: CloudV2Workspace): Promise<string[]> {
    const { rows } = await withSystemTx(this.pool, (tx) =>
      tx.query<Pick<Metadata, "repository_aliases" | "canonical_repository">>(
        "SELECT repository_aliases,canonical_repository FROM cloud_v2_github_workspaces WHERE workspace_id=$1",
        [workspace.id],
      ),
    );
    return [
      ...new Set([
        workspace.repository,
        ...(rows[0]?.repository_aliases ?? []),
        ...(rows[0]?.canonical_repository
          ? [rows[0].canonical_repository]
          : []),
      ]),
    ];
  }

  checkout(
    token: string,
    bootId: string,
    value: CloudGithubCheckout,
  ): Promise<void> {
    const input = CloudGithubCheckoutSchema.parse(value);
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{ id: string; worker_boot_id: string | null; repository: string }>(
          `SELECT w.id,w.worker_boot_id,w.repository FROM cloud_v2_workspaces w
        WHERE w.worker_token_hash=$1 AND w.state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE OF w`,
          [hashCloudV2Token(token)],
        )
      ).rows[0];
      if (!row || row.worker_boot_id !== bootId) throw unauthorized();
      // The worker reports a repository after the first by its configured name, exactly;
      // the first's own name is the same report as one without a name.
      if (input.repository !== undefined && input.repository !== row.repository) {
        await this.checkoutOther(tx, row.id, bootId, input);
        return;
      }
      const previous = (
        await tx.query<Metadata>(
          "SELECT * FROM cloud_v2_github_workspaces WHERE workspace_id=$1",
          [row.id],
        )
      ).rows[0];
      const same =
        previous?.branch === input.branch &&
        previous?.base_branch === input.baseBranch &&
        previous?.head_sha === input.headSha;
      if (
        previous?.checkout_boot_id === bootId &&
        input.sequence <= Number(previous.checkout_sequence)
      ) {
        if (input.sequence === Number(previous.checkout_sequence) && !same)
          throw new HttpError(
            409,
            "github_checkout_conflict",
            "Checkout report sequence was already used.",
          );
        return;
      }
      await tx.query(
        `INSERT INTO cloud_v2_github_workspaces(workspace_id,checkout_boot_id,checkout_sequence,checkout_revision,branch,base_branch,head_sha)
        VALUES($1,$2,$3,1,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET checkout_boot_id=EXCLUDED.checkout_boot_id,
          checkout_sequence=EXCLUDED.checkout_sequence,
          checkout_revision=cloud_v2_github_workspaces.checkout_revision+CASE WHEN $7 THEN 0 ELSE 1 END,
          branch=EXCLUDED.branch,base_branch=EXCLUDED.base_branch,head_sha=EXCLUDED.head_sha,
          pr_number=CASE WHEN $8 THEN cloud_v2_github_workspaces.pr_number END,
          pr_state=CASE WHEN $8 THEN cloud_v2_github_workspaces.pr_state END,
          pr_url=CASE WHEN $8 THEN cloud_v2_github_workspaces.pr_url END,
          pr_connection_generation=CASE WHEN $8 THEN cloud_v2_github_workspaces.pr_connection_generation END,
          updated_at=CASE WHEN $7 THEN cloud_v2_github_workspaces.updated_at ELSE clock_timestamp() END`,
        [
          row.id,
          bootId,
          input.sequence,
          input.branch,
          input.baseBranch,
          input.headSha,
          same && previous?.checkout_boot_id === bootId,
          previous?.branch === input.branch &&
            previous?.base_branch === input.baseBranch,
        ],
      );
    });
  }

  /** A checkout report for a repository after the first, into its own row. Any
   * other name (another workspace's, a case variant, one never configured) is
   * refused before anything is written. */
  private async checkoutOther(tx: Tx, workspaceId: string, bootId: string, input: CloudGithubCheckout): Promise<void> {
    const target = (await tx.query<{ repository: string; repository_id: string | null }>(
      `SELECT r.repository, coalesce(r.repository_id, s.repository_id)::text AS repository_id FROM cloud_v2_workspace_repositories r
       LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
       WHERE r.workspace_id=$1 AND r.position > 0 AND r.repository=$2`, [workspaceId, input.repository])).rows[0];
    if (!target?.repository_id) throw new HttpError(404, "not_found", "This repository is not part of this workspace.");
    const previous = (await tx.query<Metadata>("SELECT * FROM cloud_v2_github_workspace_repositories WHERE workspace_id=$1 AND repository_id=$2 FOR UPDATE",
      [workspaceId, target.repository_id])).rows[0];
    const same = previous?.branch === input.branch && previous?.base_branch === input.baseBranch && previous?.head_sha === input.headSha;
    if (previous?.checkout_boot_id === bootId && input.sequence <= Number(previous.checkout_sequence)) {
      if (input.sequence === Number(previous.checkout_sequence) && !same)
        throw new HttpError(409, "github_checkout_conflict", "Checkout report sequence was already used.");
      return;
    }
    const keep = same && previous?.checkout_boot_id === bootId, keepPr = previous?.branch === input.branch && previous?.base_branch === input.baseBranch;
    await tx.query(`INSERT INTO cloud_v2_github_workspace_repositories(workspace_id,repository_id,canonical_repository,checkout_boot_id,checkout_sequence,checkout_revision,
        branch,base_branch,head_sha) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)
      ON CONFLICT(workspace_id,repository_id) DO UPDATE SET checkout_boot_id=EXCLUDED.checkout_boot_id, checkout_sequence=EXCLUDED.checkout_sequence,
        checkout_revision=cloud_v2_github_workspace_repositories.checkout_revision+CASE WHEN $9 THEN 0 ELSE 1 END,
        branch=EXCLUDED.branch, base_branch=EXCLUDED.base_branch, head_sha=EXCLUDED.head_sha,
        pr_number=CASE WHEN $10 THEN cloud_v2_github_workspace_repositories.pr_number END,
        pr_state=CASE WHEN $10 THEN cloud_v2_github_workspace_repositories.pr_state END,
        pr_url=CASE WHEN $10 THEN cloud_v2_github_workspace_repositories.pr_url END,
        pr_connection_generation=CASE WHEN $10 THEN cloud_v2_github_workspace_repositories.pr_connection_generation END,
        updated_at=CASE WHEN $9 THEN cloud_v2_github_workspace_repositories.updated_at ELSE clock_timestamp() END`,
      [workspaceId, target.repository_id, previous?.canonical_repository ?? target.repository, bootId, input.sequence, input.branch, input.baseBranch,
        input.headSha, keep, keepPr]);
  }

  recordPr(
    context: CloudGithubPrContext,
    pr: CloudGithubPullRequest | null,
    generation: string,
    transaction?: Tx,
  ): Promise<void> {
    const write = async (tx: Tx) => {
      await this.assertContext(tx, context);
      if (context.other) {
        await tx.query(`INSERT INTO cloud_v2_github_workspace_repositories(workspace_id,repository_id,canonical_repository,pr_number,pr_state,pr_url,pr_connection_generation)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,repository_id) DO UPDATE SET pr_number=EXCLUDED.pr_number,pr_state=EXCLUDED.pr_state,
            pr_url=EXCLUDED.pr_url,pr_connection_generation=EXCLUDED.pr_connection_generation,updated_at=clock_timestamp()
          WHERE (cloud_v2_github_workspace_repositories.pr_number,cloud_v2_github_workspace_repositories.pr_state,cloud_v2_github_workspace_repositories.pr_url,
            cloud_v2_github_workspace_repositories.pr_connection_generation) IS DISTINCT FROM (EXCLUDED.pr_number,EXCLUDED.pr_state,EXCLUDED.pr_url,EXCLUDED.pr_connection_generation)`,
          [context.workspaceId, context.other.repositoryId, context.repository, pr?.number ?? null, pr?.state ?? null, pr?.url ?? null, generation]);
        return;
      }
      await tx.query(
        `UPDATE cloud_v2_github_workspaces SET pr_number=$2,pr_state=$3,pr_url=$4,pr_connection_generation=$5,
        updated_at=clock_timestamp() WHERE workspace_id=$1
        AND (pr_number,pr_state,pr_url,pr_connection_generation) IS DISTINCT FROM ($2::integer,$3::text,$4::text,$5::text)`,
        [
          context.workspaceId,
          pr?.number ?? null,
          pr?.state ?? null,
          pr?.url ?? null,
          generation,
        ],
      );
    };
    return transaction ? write(transaction) : withSystemTx(this.pool, write);
  }

  async documents(
    workspaces: readonly CloudV2Workspace[],
    generations?: ReadonlyMap<string, string>,
    transaction?: Tx,
  ): Promise<CloudGithubWorkspaceDocument[]> {
    if (!workspaces.length) return [];
    const read = (tx: Tx) =>
      tx.query<Metadata>(
        "SELECT * FROM cloud_v2_github_workspaces WHERE workspace_id=ANY($1::uuid[])",
        [workspaces.map((row) => row.id)],
      );
    const several = workspaces.filter(workspace => workspace.folder).map(workspace => workspace.id);
    type Other = Metadata & { position: number; repository: string; folder: string | null; r_branch: string; r_base_branch: string; id: string | null };
    const readOthers = (tx: Tx) => tx.query<Other>(`SELECT g.*, r.workspace_id, r.position, r.repository, r.folder, r.branch AS r_branch,
        r.base_branch AS r_base_branch, coalesce(r.repository_id, s.repository_id)::text AS id
      FROM cloud_v2_workspace_repositories r
      LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=r.workspace_id AND s.source_repository=lower(r.repository)
      LEFT JOIN cloud_v2_github_workspace_repositories g ON g.workspace_id=r.workspace_id AND g.repository_id=coalesce(r.repository_id, s.repository_id)
      WHERE r.workspace_id=ANY($1::uuid[]) ORDER BY r.workspace_id, r.position`, [several]);
    const [rows, others] = await (transaction ? Promise.all([read(transaction), several.length ? readOthers(transaction) : null])
      : withSystemTx(this.pool, async tx => [await read(tx), several.length ? await readOthers(tx) : null] as const));
    const metadata = new Map(rows.rows.map((row) => [row.workspace_id, row]));
    const repositoriesOf = new Map<string, Other[]>();
    for (const row of others?.rows ?? []) repositoriesOf.set(row.workspace_id, [...repositoriesOf.get(row.workspace_id) ?? [], row]);
    return workspaces.map((workspace) => {
      const row = metadata.get(workspace.id),
        current =
          generations === undefined || row?.pr_connection_generation === generations.get(workspace.id);
      const github = row?.repository_id && row.checkout_boot_id ? {
        repositoryId: String(row.repository_id), branch: row.branch, baseBranch: row.base_branch ?? workspace.baseBranch, headSha: row.head_sha,
        prNumber: current ? row.pr_number : null, prState: current ? row.pr_state : null, prUrl: current ? row.pr_url : null } : undefined;
      const { checkoutFolder: _checkoutFolder, folder: _folder, ...shown } = workspace;
      const repositories = workspace.folder ? (repositoriesOf.get(workspace.id) ?? []).map((other, index) => {
        if (index === 0) return { repository: row?.canonical_repository ?? workspace.repository, checkoutPath: workspaceCheckoutPath(workspace),
          branch: workspace.branch, baseBranch: workspace.baseBranch, ...(github ? { github } : {}) };
        const otherCurrent = generations === undefined || other.pr_connection_generation === generations.get(workspace.id);
        return { repository: other.canonical_repository ?? other.repository, checkoutPath: `${workspaceRootPath(workspace)}/${other.folder}`,
          branch: other.r_branch, baseBranch: other.r_base_branch,
          ...(other.id && other.checkout_boot_id ? { github: { repositoryId: other.id, branch: other.branch, baseBranch: other.base_branch ?? other.r_base_branch,
            headSha: other.head_sha, prNumber: otherCurrent ? other.pr_number : null, prState: otherCurrent ? other.pr_state : null,
            prUrl: otherCurrent ? other.pr_url : null } } : {}) };
      }) : undefined;
      return {
        ...shown,
        repository: row?.canonical_repository ?? workspace.repository,
        checkoutPath: workspaceCheckoutPath(workspace),
        ...(workspace.folder && repositories && repositories.length > 1 ? { root: workspaceRootPath(workspace), repositories } : {}),
        updatedAt:
          row && row.updated_at.getTime() > Date.parse(workspace.updatedAt)
            ? row.updated_at.toISOString()
            : workspace.updatedAt,
        ...(github ? { github } : {}),
      };
    });
  }
}
