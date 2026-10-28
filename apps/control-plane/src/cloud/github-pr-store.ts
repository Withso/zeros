import type pg from "pg";
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
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

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
  ): Promise<CloudGithubPrContext> {
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
      }>(
        `SELECT w.id,w.org_id,w.creator_user_id,w.repository,w.branch,w.base_branch,w.worker_boot_id,
        row_to_json(g.*) AS metadata FROM cloud_v2_workspaces w
        LEFT JOIN cloud_v2_github_workspaces g ON g.workspace_id=w.id
        WHERE w.id=$1 AND w.creator_user_id=$2 AND w.state NOT IN ('deleting','deleted') AND ${CLOUD_V2_LIVE_ACCESS}
        ${lock ? "FOR UPDATE OF w" : ""}`,
        [workspaceId, userId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(404, "not_found", "Cloud workspace not found.");
    const g = row.metadata,
      observed = !!g?.checkout_boot_id;
    return {
      workspaceId: row.id,
      organizationId: row.org_id,
      creatorUserId: row.creator_user_id,
      repository: g?.canonical_repository ?? row.repository,
      repositoryId: g?.repository_id == null ? null : String(g.repository_id),
      branch: observed ? g!.branch : row.branch,
      baseBranch: g?.base_branch ?? row.base_branch,
      headSha: g?.head_sha ?? null,
      revision: `${row.worker_boot_id ?? "stopped"}:${g?.checkout_revision ?? "0"}`,
    };
  }

  context(workspaceId: string, userId: string): Promise<CloudGithubPrContext> {
    return withSystemTx(this.pool, (tx) =>
      this.readContext(tx, workspaceId, userId),
    );
  }

  private async assertContext(
    tx: Tx,
    expected: CloudGithubPrContext,
  ): Promise<CloudGithubPrContext> {
    const live = await this.readContext(
      tx,
      expected.workspaceId,
      expected.creatorUserId,
      true,
    );
    if (
      live.revision !== expected.revision ||
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
  ): Promise<void> {
    return withSystemTx(this.pool, async (tx) => {
      await observation?.assertCurrent(tx);
      const current = await this.assertContext(tx, context);
      if (current.repositoryId && current.repositoryId !== identity.repositoryId)
        throw new HttpError(409, "github_repository_changed", "The saved GitHub repository identity changed.");
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
    });
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
        await tx.query<{ id: string; worker_boot_id: string | null }>(
          `SELECT w.id,w.worker_boot_id FROM cloud_v2_workspaces w
        WHERE w.worker_token_hash=$1 AND w.state IN ('running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} FOR UPDATE OF w`,
          [hashCloudV2Token(token)],
        )
      ).rows[0];
      if (!row || row.worker_boot_id !== bootId) throw unauthorized();
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

  recordPr(
    context: CloudGithubPrContext,
    pr: CloudGithubPullRequest | null,
    generation: string,
  ): Promise<void> {
    return withSystemTx(this.pool, async (tx) => {
      await this.assertContext(tx, context);
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
    });
  }

  async documents(
    workspaces: readonly CloudV2Workspace[],
    generations: ReadonlyMap<string, string> = new Map(),
  ): Promise<CloudGithubWorkspaceDocument[]> {
    if (!workspaces.length) return [];
    const rows = await withSystemTx(this.pool, (tx) =>
      tx.query<Metadata>(
        "SELECT * FROM cloud_v2_github_workspaces WHERE workspace_id=ANY($1::uuid[])",
        [workspaces.map((row) => row.id)],
      ),
    );
    const metadata = new Map(rows.rows.map((row) => [row.workspace_id, row]));
    return workspaces.map((workspace) => {
      const row = metadata.get(workspace.id),
        current =
          row?.pr_connection_generation === generations.get(workspace.id);
      return {
        ...workspace,
        repository: row?.canonical_repository ?? workspace.repository,
        checkoutPath: `/home/user/${workspace.repository}`,
        updatedAt:
          row && row.updated_at.getTime() > Date.parse(workspace.updatedAt)
            ? row.updated_at.toISOString()
            : workspace.updatedAt,
        ...(row?.repository_id && row.checkout_boot_id
          ? {
              github: {
                repositoryId: String(row.repository_id),
                branch: row.branch,
                baseBranch: row.base_branch ?? workspace.baseBranch,
                headSha: row.head_sha,
                prNumber: current ? row.pr_number : null,
                prState: current ? row.pr_state : null,
                prUrl: current ? row.pr_url : null,
              },
            }
          : {}),
      };
    });
  }
}
