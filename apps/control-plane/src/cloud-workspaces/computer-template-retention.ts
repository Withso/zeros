import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { BOAT_RESOURCE_ID_PATTERN, type BoatApiClient } from "./boat-client.js";
import type { BuilderVmOperation } from "./cloud-builder-vm-store.js";
import { lockCloudComputerOrganization } from "./computer.js";
import { CloudProviderError } from "./provider.js";

export const COMPUTER_TEMPLATE_RETENTION_CHANNEL =
  "cloud_computer_template_retention";
export const COMPUTER_TEMPLATE_READY_HISTORY = 10;

/** The deletion-only subset of B7's BuilderVmOperationStore. The journal is
 * already scoped to a stable provider account, never to a credential version. */
export interface ComputerTemplateDeletionJournal {
  find(
    operationKey: string,
    tx?: Tx,
  ): Promise<Pick<
    BuilderVmOperation,
    | "operation_key"
    | "purpose"
    | "state"
    | "sandbox_id"
    | "deletion_operation_id"
    | "create_closed_at"
  > | null>;
  state(operationKey: string, state: "deleting" | "deleted"): Promise<void>;
  deletion(operationKey: string, operationId: string): Promise<void>;
}
type Operation = NonNullable<
  Awaited<ReturnType<ComputerTemplateDeletionJournal["find"]>>
>;
type Template = {
  build_id: string;
  org_id: string;
  state: "ready" | "retiring";
  provider_resource_id: string;
  account_scope: string;
  billing_org: string;
  worker_fence: string;
};
type Claim = Template & { operationKey: string };
const operationKey = (buildId: string) => `computer-build:${buildId}`;
const deletionReceipt = z.object({
  id: z.string().regex(/^bdop_[a-f0-9]{32}$/),
  kind: z.literal("sandbox"),
  targetId: z.string().regex(BOAT_RESOURCE_ID_PATTERN),
});
const notFound = (error: unknown) =>
  error instanceof CloudProviderError && error.code === "provider_not_found";

export function computerTemplateKeepSet(input: {
  active: string | null;
  previous: string | null;
  referenced: readonly string[];
  newestReady: readonly string[];
}): Set<string> {
  return new Set([
    ...[input.active, input.previous].filter((id): id is string => id !== null),
    ...input.referenced,
    ...input.newestReady.slice(0, COMPUTER_TEMPLATE_READY_HISTORY),
  ]);
}

/** The caller holds the organization row. Serialize with build preparation,
 * then require positive deletion or a closed unallocated create for every
 * account's builder journal before erasing its build/template identities. */
export async function computerTemplateCleanupPending(
  tx: Tx,
  org: string,
  journal?: Pick<ComputerTemplateDeletionJournal, "find">,
): Promise<boolean> {
  await lockCloudComputerOrganization(tx, org);
  const templates = await tx.query<{
    build_id: string;
    provider_resource_id: string | null;
    account_scope: string | null;
  }>(
    `SELECT build.id AS build_id,template.provider_resource_id,template.account_scope
     FROM cloud_computer_v2_builds build LEFT JOIN cloud_computer_templates template
       ON template.build_id=build.id AND template.org_id=build.org_id
     WHERE build.org_id=$1 ORDER BY build.id FOR UPDATE OF build`,
    [org],
  );
  for (const template of templates.rows) {
    const key = operationKey(template.build_id);
    const rows: Array<Operation & { account_scope?: string }> = journal
      ? [await journal.find(key, tx)].filter(
          (row): row is Operation => row !== null,
        )
      : (
          await tx.query<Operation & { account_scope: string }>(
            "SELECT * FROM cloud_builder_vm_operations WHERE operation_key=$1 FOR UPDATE",
            [key],
          )
        ).rows;
    if (
      rows.some(
        (row) =>
          row.operation_key !== key ||
          row.purpose !== "computer-build" ||
          (row.sandbox_id ? row.state !== "deleted" : !row.create_closed_at),
      )
    )
      return true;
    if (
      template.provider_resource_id &&
      !rows.some(
        (row) =>
          row.sandbox_id === template.provider_resource_id &&
          (row.account_scope === undefined ||
            row.account_scope === template.account_scope),
      )
    )
      return true;
    if (template.account_scope && !rows.length) return true;
  }
  return false;
}

/** C5 must accept forks under this same org/head lock and require ready.
 * Retiring then durably withdraws fork/Activate admission. All
 * decisions use C1's org lock and completed build's monotonic worker fence;
 * provider I/O never holds a database transaction open. */
export class CloudComputerTemplateRetentionWorker {
  private ticking: Promise<number> | null = null;
  private stopping = false;
  private sweep = false;
  private readonly pending = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: {
      accountScope: string;
      billingOrg: string;
      journal: ComputerTemplateDeletionJournal;
      client: Pick<BoatApiClient, "request">;
      intervalMs?: number;
      logger?: Pick<Console, "warn">;
    },
  ) {}

  private async lock(tx: Tx, org: string): Promise<boolean> {
    if (
      !(
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [
          org,
        ])
      ).rowCount
    )
      return false;
    await lockCloudComputerOrganization(tx, org);
    return (
      (
        await tx.query(
          "SELECT org_id FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE",
          [org],
        )
      ).rowCount === 1
    );
  }

  private async keep(tx: Tx, org: string): Promise<Set<string>> {
    const head = (
      await tx.query<{
        active_build_id: string | null;
        previous_build_id: string | null;
        erasing: boolean;
      }>(
        `SELECT head.active_build_id,head.previous_build_id,
         (organization.lifecycle_status IN ('purging','provider_deleted') OR EXISTS (
           SELECT 1 FROM deletion_requests request WHERE request.id=organization.deletion_request_id
             AND request.state IN ('purging','provider_deleting')
         )) AS erasing
       FROM cloud_computer_v2_heads head JOIN organizations organization ON organization.id=head.org_id
       WHERE head.org_id=$1`,
        [org],
      )
    ).rows[0];
    if (!head) return new Set();
    // Retired/superseded generations can still be recovery sources. A delete
    // request alone is insufficient: keep every source until workspace/data
    // cleanup has actually reached its terminal state.
    const references = await tx.query<{ template_id: string }>(
      `SELECT DISTINCT source.template_id FROM cloud_workspace_computer_sources source
       JOIN cloud_workspaces workspace ON workspace.id=source.workspace_id AND workspace.org_id=source.org_id
       WHERE source.org_id=$1 AND (workspace.status<>'deleted' OR workspace.data_deleted_at IS NULL)`,
      [org],
    );
    const newest = head.erasing
      ? []
      : (
          await tx.query<{ build_id: string }>(
            `SELECT template.build_id FROM cloud_computer_templates template
       JOIN cloud_computer_v2_builds build ON build.id=template.build_id AND build.org_id=template.org_id
       WHERE template.org_id=$1 AND template.state='ready'
       ORDER BY build.version DESC LIMIT $2`,
            [org, COMPUTER_TEMPLATE_READY_HISTORY],
          )
        ).rows.map((row) => row.build_id);
    return computerTemplateKeepSet({
      active: head.erasing ? null : head.active_build_id,
      previous: head.erasing ? null : head.previous_build_id,
      referenced: references.rows.map((row) => row.template_id),
      newestReady: newest,
    });
  }

  private async template(
    tx: Tx,
    org: string,
    id: string,
  ): Promise<Template | null> {
    // Match C1's head -> build -> template row-lock order.
    await tx.query(
      "SELECT id FROM cloud_computer_v2_builds WHERE org_id=$1 AND id=$2 FOR UPDATE",
      [org, id],
    );
    return (
      (
        await tx.query<Template>(
          `SELECT template.*,build.worker_fence FROM cloud_computer_templates template
       JOIN cloud_computer_v2_builds build ON build.id=template.build_id AND build.org_id=template.org_id
       WHERE template.org_id=$1 AND template.build_id=$2 AND template.state IN ('ready','retiring')
       FOR UPDATE OF template`,
          [org, id],
        )
      ).rows[0] ?? null
    );
  }

  private owns(
    template: Template,
    operation: Operation | null,
  ): operation is Operation {
    return (
      template.account_scope === this.options.accountScope &&
      template.billing_org === this.options.billingOrg &&
      BOAT_RESOURCE_ID_PATTERN.test(template.provider_resource_id ?? "") &&
      operation?.operation_key === operationKey(template.build_id) &&
      operation.purpose === "computer-build" &&
      operation.sandbox_id === template.provider_resource_id &&
      ["archived", "deleting", "deleted"].includes(operation.state)
    );
  }

  private async claim(candidate: Template): Promise<Claim | null> {
    return withSystemTx(this.pool, async (tx) => {
      if (!(await this.lock(tx, candidate.org_id))) return null;
      const current = await this.template(
        tx,
        candidate.org_id,
        candidate.build_id,
      );
      if (
        !current ||
        (current.state === "ready" &&
          (await this.keep(tx, current.org_id)).has(current.build_id))
      )
        return null;
      if (
        current.provider_resource_id !== candidate.provider_resource_id ||
        current.account_scope !== candidate.account_scope ||
        current.billing_org !== candidate.billing_org
      )
        return null;
      const fence = (
        await tx.query<{ worker_fence: string }>(
          "UPDATE cloud_computer_v2_builds SET worker_fence=worker_fence+1 WHERE org_id=$1 AND id=$2 RETURNING worker_fence",
          [current.org_id, current.build_id],
        )
      ).rows[0]!.worker_fence;
      await tx.query(
        "UPDATE cloud_computer_templates SET state='retiring' WHERE org_id=$1 AND build_id=$2",
        [current.org_id, current.build_id],
      );
      return {
        ...current,
        state: "retiring",
        worker_fence: fence,
        operationKey: operationKey(current.build_id),
      };
    });
  }

  /** Final pre-dispatch check. A reference/head that won the claim race always
   * wins; once the delete intent exists, readiness must never be restored. */
  private async admitted(claim: Claim): Promise<Operation | null> {
    return withSystemTx(this.pool, async (tx) => {
      if (!(await this.lock(tx, claim.org_id))) return null;
      const current = await this.template(tx, claim.org_id, claim.build_id);
      if (
        !current ||
        current.state !== "retiring" ||
        current.worker_fence !== claim.worker_fence ||
        current.provider_resource_id !== claim.provider_resource_id
      )
        return null;
      const operation = await this.options.journal.find(claim.operationKey, tx);
      if (!this.owns(current, operation)) return null;
      if ((await this.keep(tx, claim.org_id)).has(claim.build_id)) {
        if (operation.state !== "deleting" && operation.state !== "deleted")
          await tx.query(
            "UPDATE cloud_computer_templates SET state='ready' WHERE org_id=$1 AND build_id=$2",
            [claim.org_id, claim.build_id],
          );
        return null;
      }
      return operation;
    });
  }

  private async remove(claim: Claim, operation: Operation): Promise<void> {
    if (operation.state === "deleted") return;
    await this.options.journal.state(claim.operationKey, "deleting");
    if (!operation.deletion_operation_id) {
      try {
        const result = await this.options.client.request(
          `/sandboxes/${claim.provider_resource_id}`,
          {
            method: "DELETE",
            confirmDelete: claim.provider_resource_id,
          },
        );
        const receipt = deletionReceipt.safeParse(result.operation);
        if (
          !receipt.success ||
          receipt.data.targetId !== claim.provider_resource_id
        )
          throw new Error("Template deletion receipt is unconfirmed");
        await this.options.journal.deletion(
          claim.operationKey,
          receipt.data.id,
        );
      } catch (error) {
        if (!notFound(error)) throw error;
        await this.options.journal.state(claim.operationKey, "deleted");
        return;
      }
    }
    // A receipt is durable, but a still-visible sandbox is not retired. ACD-7
    // needs logical deletion only: do not poll/track provider byte erasure.
    try {
      await this.options.client.request(
        `/sandboxes/${claim.provider_resource_id}`,
      );
      throw new Error("Template deletion is unconfirmed");
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    await this.options.journal.state(claim.operationKey, "deleted");
  }

  private async complete(claim: Claim): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      if (!(await this.lock(tx, claim.org_id))) return false;
      const current = await this.template(tx, claim.org_id, claim.build_id);
      if (
        !current ||
        current.state !== "retiring" ||
        current.worker_fence !== claim.worker_fence ||
        (await this.keep(tx, claim.org_id)).has(claim.build_id)
      )
        return false;
      const operation = await this.options.journal.find(claim.operationKey, tx);
      if (!this.owns(current, operation) || operation.state !== "deleted")
        return false;
      return (
        (
          await tx.query(
            `UPDATE cloud_computer_templates SET state='retired',retired_at=coalesce(retired_at,clock_timestamp())
         WHERE org_id=$1 AND build_id=$2 AND state='retiring'`,
            [claim.org_id, claim.build_id],
          )
        ).rowCount === 1
      );
    });
  }

  private async organization(org: string, afterVersion = "0"): Promise<number> {
    const candidates = await withSystemTx(this.pool, async (tx) => {
      const keep = await this.keep(tx, org);
      return (
        await tx.query<Template & { version: string }>(
          `SELECT template.*,build.worker_fence,build.version FROM cloud_computer_templates template
         JOIN cloud_computer_v2_builds build ON build.id=template.build_id AND build.org_id=template.org_id
         WHERE template.org_id=$1 AND template.account_scope=$2 AND template.billing_org=$3 AND build.version>$5::bigint
           AND (template.state='retiring' OR (template.state='ready' AND NOT template.build_id=ANY($4::uuid[])))
         ORDER BY build.version LIMIT 50`,
          [
            org,
            this.options.accountScope,
            this.options.billingOrg,
            [...keep],
            afterVersion,
          ],
        )
      ).rows;
    });
    let retired = 0;
    for (const candidate of candidates) {
      if (this.stopping) break;
      try {
        if (
          !this.owns(
            candidate,
            await this.options.journal.find(operationKey(candidate.build_id)),
          )
        )
          continue;
        const claim = await this.claim(candidate);
        if (!claim) continue;
        // Journal reads can outlive a claim (including after process restart).
        // The final transaction independently checks its fence and keep-set.
        if (
          !this.owns(claim, await this.options.journal.find(claim.operationKey))
        )
          continue;
        const operation = await this.admitted(claim);
        if (!operation) continue;
        await this.remove(claim, operation);
        if (await this.complete(claim)) retired++;
      } catch {
        (this.options.logger ?? console).warn(
          "[computer-template-retention] cleanup unconfirmed; will retry",
        );
      }
    }
    // Advance past every candidate, including unconfirmed cleanup. The next
    // sweep starts at zero so unresolved journals remain retryable.
    if (!this.stopping && candidates.length === 50)
      retired += await this.organization(org, candidates.at(-1)!.version);
    return retired;
  }

  async tick(organizationId?: string): Promise<number> {
    if (this.stopping) return 0;
    if (organizationId)
      this.pending.add(z.string().uuid().parse(organizationId));
    else this.sweep = true;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      let retired = 0;
      while (this.sweep || this.pending.size) {
        const orgs = [...this.pending];
        this.pending.clear();
        if (this.sweep) {
          this.sweep = false;
          orgs.push(
            ...(
              await withSystemTx(this.pool, (tx) =>
                tx.query<{ org_id: string }>(
                  `SELECT DISTINCT org_id FROM cloud_computer_templates WHERE state IN ('ready','retiring')
             AND account_scope=$1 AND billing_org=$2`,
                  [this.options.accountScope, this.options.billingOrg],
                ),
              )
            ).rows.map((row) => row.org_id),
          );
        }
        for (const org of new Set(orgs))
          if (!this.stopping) retired += await this.organization(org);
      }
      return retired;
    })();
    try {
      return await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  start(listenerPool: pg.Pool = this.pool): () => Promise<void> {
    const run = (org?: string) => {
      void this.tick(org).catch(() =>
        (this.options.logger ?? console).warn(
          "[computer-template-retention] sweep failed; will retry",
        ),
      );
    };
    const timer = setInterval(() => run(), this.options.intervalMs ?? 60_000);
    timer.unref();
    const listener = listenerPool
      .connect()
      .then(async (client) => {
        const onNotification = (notice: pg.Notification) => {
          if (
            notice.channel === COMPUTER_TEMPLATE_RETENTION_CHANNEL &&
            z.string().uuid().safeParse(notice.payload).success
          )
            run(notice.payload);
        };
        const onError = () =>
          (this.options.logger ?? console).warn(
            "[computer-template-retention] notifications unavailable; periodic sweep remains enabled",
          );
        client.on("notification", onNotification);
        client.on("error", onError);
        try {
          await client.query(`LISTEN ${COMPUTER_TEMPLATE_RETENTION_CHANNEL}`);
        } catch {
          onError();
        }
        return async () => {
          client.removeListener("notification", onNotification);
          client.removeListener("error", onError);
          await client
            .query(`UNLISTEN ${COMPUTER_TEMPLATE_RETENTION_CHANNEL}`)
            .catch(() => undefined);
          client.release(true);
        };
      })
      .catch(() => async () => undefined);
    run();
    return async () => {
      this.stopping = true;
      clearInterval(timer);
      await (
        await listener
      )();
      await this.ticking;
    };
  }
}
