import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudComputerOrganization } from "./computer-identity.js";
import type { CloudComputerV2Repository } from "./computer-v2-contract.js";

export type TemplateAllocation = {
  build_id: string;
  org_id: string;
  state: string;
  build_state: string;
  base_image_id: string;
  builder_operation_key: string;
  builder_name: string;
  account_scope: string;
  billing_org: string;
  provider_resource_id: string | null;
  allocation_requested_at: Date;
  stopped_at: Date | null;
  cleanup_confirmed_at: Date | null;
  cleanup_fence: string;
};
const allocationSql = `SELECT template.*,build.state AS build_state,build.base_image_id
  FROM cloud_computer_templates template JOIN cloud_computer_v2_builds build ON build.id=template.build_id`;

/** No provider I/O in transactions. A failed/cancelled request remains a
 * capacity hold until positive stop/delete or closed non-allocation evidence
 * is recorded. C1 counts these same rows under its global advisory lock. */
export class ComputerTemplateJournal {
  constructor(
    private readonly pool: pg.Pool,
    private readonly accountScope: string,
    private readonly billingOrg: string,
  ) {}

  private async locked(tx: Tx, id: string): Promise<TemplateAllocation> {
    const scope = (
      await tx.query<{ org_id: string }>(
        "SELECT org_id FROM cloud_computer_v2_builds WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!scope) throw new Error("Computer builder unavailable");
    await lockCloudComputerOrganization(tx, scope.org_id);
    const row = (
      await tx.query<TemplateAllocation>(
        `${allocationSql} WHERE template.build_id=$1 FOR UPDATE OF build,template`,
        [id],
      )
    ).rows[0];
    if (
      !row ||
      !row.builder_operation_key ||
      row.account_scope !== this.accountScope ||
      row.billing_org !== this.billingOrg
    )
      throw new Error("Computer builder identity mismatch");
    return row;
  }
  async allocation(id: string): Promise<TemplateAllocation> {
    return withSystemTx(this.pool, (tx) => this.locked(tx, id));
  }
  async authority(id: string, fence: number) {
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{
          state: string;
          worker_fence: string;
          cancelled: boolean;
          expired: boolean;
        }>(
          `SELECT state,worker_fence,cancel_requested_at IS NOT NULL AS cancelled,deadline_at<=clock_timestamp() AS expired
         FROM cloud_computer_v2_builds WHERE id=$1`,
          [id],
        )
      ).rows[0];
      return {
        active: Boolean(
          row &&
          row.state === "running" &&
          Number(row.worker_fence) === fence &&
          !row.cancelled &&
          !row.expired,
        ),
        expired: row?.expired === true,
      };
    });
  }
  async recordVm(id: string, operationKey: string, sandboxId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sandboxId))
      throw new Error("Computer builder identity mismatch");
    return withSystemTx(this.pool, async (tx) => {
      const row = await this.locked(tx, id);
      if (
        operationKey !== row.builder_operation_key ||
        (row.provider_resource_id !== null &&
          row.provider_resource_id !== sandboxId)
      )
        throw new Error("Computer builder identity mismatch");
      await tx.query(
        "UPDATE cloud_computer_templates SET provider_resource_id=$2 WHERE build_id=$1",
        [id, sandboxId],
      );
    });
  }
  async recordDigest(
    id: string,
    fence: number,
    digest: string,
    kind: "protected" | "manifest",
  ) {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid computer manifest");
    await withSystemTx(this.pool, async (tx) => {
      await this.locked(tx, id);
      const active = await tx.query(
        `SELECT 1 FROM cloud_computer_v2_builds WHERE id=$1 AND state='running'
        AND worker_fence=$2 AND cancel_requested_at IS NULL AND deadline_at>clock_timestamp()`,
        [id, fence],
      );
      if (!active.rowCount) throw new Error("Computer build fenced");
      const column =
        kind === "protected" ? "protected_contract_digest" : "manifest_sha256";
      await tx.query(
        `UPDATE cloud_computer_templates SET ${column}=$2 WHERE build_id=$1`,
        [id, Buffer.from(digest, "hex")],
      );
    });
  }
  async recordStopped(id: string): Promise<string> {
    return withSystemTx(this.pool, async (tx) => {
      await this.locked(tx, id);
      return (
        await tx.query<{ stopped_at: Date }>(
          `UPDATE cloud_computer_templates SET stopped_at=coalesce(stopped_at,clock_timestamp())
        WHERE build_id=$1 RETURNING stopped_at`,
          [id],
        )
      ).rows[0]!.stopped_at.toISOString();
    });
  }
  async fenceExpired() {
    const candidates = await withSystemTx(
      this.pool,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `SELECT build.id FROM cloud_computer_v2_builds build JOIN cloud_computer_templates template ON template.build_id=build.id
       WHERE build.state='running' AND (build.deadline_at<=clock_timestamp() OR build.cancel_requested_at IS NOT NULL)
       AND template.account_scope=$1 AND template.billing_org=$2 AND template.builder_operation_key IS NOT NULL ORDER BY build.id LIMIT 32`,
            [this.accountScope, this.billingOrg],
          )
        ).rows,
    );
    for (const candidate of candidates)
      await withSystemTx(this.pool, async (tx) => {
        await this.locked(tx, candidate.id);
        const changed = await tx.query(
          `UPDATE cloud_computer_v2_builds SET
        state=CASE WHEN cancel_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        error_code=CASE WHEN cancel_requested_at IS NULL THEN 'build_timeout' ELSE NULL END,
        completed_at=clock_timestamp(),worker_fence=worker_fence+1
        WHERE id=$1 AND state='running' AND (deadline_at<=clock_timestamp() OR cancel_requested_at IS NOT NULL)`,
          [candidate.id],
        );
        if (changed.rowCount)
          await tx.query(
            "UPDATE cloud_computer_templates SET state='quarantined' WHERE build_id=$1 AND state='pending'",
            [candidate.id],
          );
      });
  }
  async claimCleanup(id?: string): Promise<TemplateAllocation | null> {
    return withSystemTx(this.pool, async (tx) => {
      const candidate = (
        await tx.query<{ build_id: string }>(
          `${allocationSql}
        WHERE build.state IN ('failed','cancelled','superseded') AND template.cleanup_confirmed_at IS NULL
        AND template.builder_operation_key IS NOT NULL AND template.account_scope=$1 AND template.billing_org=$2
        AND (template.cleanup_lease_until IS NULL OR template.cleanup_lease_until<=clock_timestamp())
        AND (template.cleanup_retry_at IS NULL OR template.cleanup_retry_at<=clock_timestamp())
        AND ($3::uuid IS NULL OR template.build_id=$3) ORDER BY build.completed_at,build.id LIMIT 1`,
          [this.accountScope, this.billingOrg, id ?? null],
        )
      ).rows[0];
      if (!candidate) return null;
      const row = await this.locked(tx, candidate.build_id);
      const claimed = (
        await tx.query<{ cleanup_fence: string }>(
          `UPDATE cloud_computer_templates SET
        state='quarantined',cleanup_fence=cleanup_fence+1,cleanup_lease_until=clock_timestamp()+interval '10 minutes'
        WHERE build_id=$1 AND cleanup_confirmed_at IS NULL
        AND (cleanup_lease_until IS NULL OR cleanup_lease_until<=clock_timestamp())
        RETURNING cleanup_fence`,
          [row.build_id],
        )
      ).rows[0];
      if (
        !claimed ||
        !["failed", "cancelled", "superseded"].includes(row.build_state)
      )
        return null;
      return { ...row, cleanup_fence: claimed.cleanup_fence };
    });
  }
  async cleanupResult(row: TemplateAllocation, confirmed: boolean) {
    await withSystemTx(this.pool, async (tx) => {
      await this.locked(tx, row.build_id);
      await tx.query(
        `UPDATE cloud_computer_templates SET cleanup_lease_until=NULL,
        cleanup_retry_at=CASE WHEN $3 THEN NULL ELSE clock_timestamp()+interval '30 seconds' END,
        cleanup_confirmed_at=CASE WHEN $3 THEN coalesce(cleanup_confirmed_at,clock_timestamp()) ELSE cleanup_confirmed_at END,
        retired_at=CASE WHEN $3 THEN coalesce(retired_at,clock_timestamp()) ELSE retired_at END,
        state=CASE WHEN $3 THEN 'retired' ELSE 'quarantined' END
        WHERE build_id=$1 AND cleanup_fence=$2 AND state<>'ready'`,
        [row.build_id, row.cleanup_fence, confirmed],
      );
    });
  }
  async repositoryInstallation(
    org: string,
    repository: CloudComputerV2Repository,
  ): Promise<number> {
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{ github_installation_id: string }>(
          `SELECT installation.github_installation_id
        FROM github_installations installation WHERE installation.id=$1 AND installation.app_variant='github.com'
          AND installation.suspended_at IS NULL AND lower(installation.account_login)=$2
          AND EXISTS(SELECT 1 FROM cloud_github_connections connection WHERE connection.org_id=$3 AND connection.installation_id=installation.id)`,
          [repository.installationId, repository.owner.toLowerCase(), org],
        )
      ).rows[0];
      const id = Number(row?.github_installation_id);
      if (!Number.isSafeInteger(id) || id < 1)
        throw new Error("Computer repository access denied");
      return id;
    });
  }
}
