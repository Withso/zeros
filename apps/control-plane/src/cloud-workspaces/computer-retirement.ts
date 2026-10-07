import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudComputerOrganization } from "./computer-identity.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { ensureWorkspaceDeletionJob } from "./workspace-deletion-job.js";
import { CLOUD_WORKSPACE_V2_REQUIRED } from "./supported-generation.js";
import { createComputerRetirementDriver } from "./computer-retirement-boat.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest();
export type RetiredComputerImage = {
  id: string;
  org_id: string;
  account_scope: string;
  snapshot_name: string;
  snapshot_id: string | null;
  state: string;
  created_at: Date;
  builder_id: string | null;
  verifier_id: string | null;
  builder_dispatched_at: Date | null;
  verifier_dispatched_at: Date | null;
  builder_deleted: boolean;
  verifier_deleted: boolean;
  builder_deletion_operation: string | null;
  verifier_deletion_operation: string | null;
  capture_dispatched_at: Date | null;
  snapshot_deletion_requested_at: Date | null;
};
export type RetiredComputerSnapshot = {
  name: string;
  id: string | null;
  source: string;
  ready: boolean;
  failed?: boolean;
};
/** Deliberately has no allocation, command, install, capture or publication port. */
export interface ComputerRetirementDriver {
  snapshot(
    image: RetiredComputerImage,
  ): Promise<RetiredComputerSnapshot | null>;
  removeSandbox(
    id: string,
    operation: string | null,
    persist: (operation: string) => Promise<void>,
  ): Promise<boolean>;
  removeSnapshot(
    image: RetiredComputerImage,
    persist: () => Promise<void>,
  ): Promise<boolean>;
  releaseAdmission(
    image: RetiredComputerImage,
    proof: { computeDeleted: boolean; snapshotDeleted: boolean },
  ): Promise<void>;
}
/** Called under the Computer organization lock. Enrollment can proceed while
 * historical disposable resources retire; this never creates a v2 build. */
export async function retireLegacyComputerBuilds(
  tx: Tx,
  organizationId?: string,
) {
  await tx.query(
    `UPDATE cloud_computer_builds SET state='cancelled',completed_at=coalesce(completed_at,now()),
    error_code=$2,cleanup_state='requested' WHERE state='building' AND ($1::uuid IS NULL OR org_id=$1)`,
    [organizationId ?? null, CLOUD_WORKSPACE_V2_REQUIRED],
  );
}
async function referenced(tx: Tx, image: RetiredComputerImage) {
  return (
    (
      await tx.query(
        `SELECT 1 FROM cloud_computers WHERE active_image_id=$1 OR previous_image_id=$1
    UNION ALL SELECT 1 FROM cloud_workspace_generations WHERE computer_image_id=$1 OR split_part(image_ref,'@',1)=$2
    UNION ALL SELECT 1 FROM cloud_computer_images WHERE split_part(base_image_ref,'@',1)=$2 AND state<>'retired'
    UNION ALL SELECT 1 FROM cloud_computer_image_base_references WHERE account_scope=$3 AND snapshot_name=$4 LIMIT 1`,
        [
          image.id,
          `boat:${image.snapshot_name}`,
          image.account_scope,
          image.snapshot_name,
        ],
      )
    ).rowCount !== 0
  );
}
export class ComputerImageRetirementWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly account: string,
    private readonly driver: ComputerRetirementDriver,
    private readonly protectedImageRefs: readonly string[] = [],
  ) {}
  async tick() {
    await withSystemTx(this.pool, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,62172))",
        [this.account],
      );
      for (const ref of this.protectedImageRefs) {
        const name = /^boat:([a-z0-9-]+)@sha256:[a-f0-9]{64}$/.exec(ref)?.[1];
        if (!name) throw new Error("Invalid protected Computer base");
        await tx.query(
          `INSERT INTO cloud_computer_image_base_references(account_scope,snapshot_name,image_ref)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [this.account, name, ref],
        );
      }
    });
    const ids = await withSystemTx(this.pool, (tx) =>
      tx.query<{ id: string }>(
        `WITH candidates AS (
      SELECT build.id FROM cloud_computer_builds build JOIN cloud_computer_images image USING(id)
      WHERE image.account_scope=$1 AND (image.state<>'retired' OR build.cleanup_state<>'complete')
      ORDER BY build.last_checked_at,build.id LIMIT 16 FOR UPDATE OF build SKIP LOCKED)
      UPDATE cloud_computer_builds build SET last_checked_at=clock_timestamp() FROM candidates
      WHERE build.id=candidates.id RETURNING build.id`,
        [this.account],
      ),
    );
    for (const { id } of ids.rows) await this.retire(id);
  }
  private update(id: string, fields: Partial<RetiredComputerImage>) {
    const entries = Object.entries(fields);
    return withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE cloud_computer_images SET
      ${entries.map(([key], index) => `${key}=$${index + 2}`).join(",")},updated_at=now() WHERE id=$1 AND account_scope=$${entries.length + 2}`,
        [id, ...entries.map(([, value]) => value), this.account],
      ),
    );
  }
  private async uncertain(
    image: RetiredComputerImage,
    role: "builder" | "verifier",
  ) {
    const attempts = await withSystemTx(this.pool, (tx) =>
      tx.query<{ state: string }>(
        "SELECT state FROM cloud_computer_image_create_attempts WHERE image_id=$1 AND role=$2",
        [image.id, role],
      ),
    );
    return (
      attempts.rows.some((row) => row.state === "dispatched") ||
      (!attempts.rowCount && image[`${role}_dispatched_at`] !== null)
    );
  }
  private async retire(id: string) {
    const lock = await this.pool.connect();
    let locked = false;
    try {
      locked = (
        await lock.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,62173)) AS locked",
          [id],
        )
      ).rows[0]!.locked;
      if (!locked) return;
      const image = await withSystemTx(this.pool, async (tx) => {
        const image = (
          await tx.query<RetiredComputerImage>(
            "SELECT * FROM cloud_computer_images WHERE id=$1 AND account_scope=$2",
            [id, this.account],
          )
        ).rows[0];
        if (image) {
          await lockCloudComputerOrganization(tx, image.org_id);
          await retireLegacyComputerBuilds(tx, image.org_id);
        }
        return image;
      });
      if (!image) return;
      let complete = true,
        captureSettled =
          !image.capture_dispatched_at || image.snapshot_id !== null;
      if (!captureSettled) {
        try {
          const captured = await this.driver.snapshot(image);
          if (
            captured &&
            captured.name === image.snapshot_name &&
            captured.source === image.builder_id &&
            captured.id &&
            (captured.ready || captured.failed)
          ) {
            await this.update(id, { snapshot_id: captured.id });
            image.snapshot_id = captured.id;
            captureSettled = true;
          }
        } catch {
          /* Capture uncertainty retains the builder; other known VMs can retire. */
        }
      }
      for (const role of ["builder", "verifier"] as const) {
        try {
          const resource = image[`${role}_id`];
          if (!resource) {
            if (await this.uncertain(image, role)) complete = false;
            continue;
          }
          if (image[`${role}_deleted`]) continue;
          if (role === "builder" && !captureSettled) {
            complete = false;
            continue;
          }
          if (
            await this.driver.removeSandbox(
              resource,
              image[`${role}_deletion_operation`],
              (operation) =>
                this.update(id, {
                  [`${role}_deletion_operation`]: operation,
                }).then(() => {}),
            )
          ) {
            await this.update(id, { [`${role}_deleted`]: true });
            image[`${role}_deleted`] = true;
          } else complete = false;
        } catch {
          complete = false;
        }
      }
      complete = complete && captureSettled;
      let retained = false,
        snapshotDeleted =
          image.state === "retired" ||
          (!image.capture_dispatched_at && image.snapshot_id === null);
      if (complete) {
        // This session lock serializes references/base promotion and deletion;
        // no database transaction remains open across a provider await.
        await lock.query(
          "SELECT pg_advisory_lock(hashtextextended($1,62172))",
          [this.account],
        );
        try {
          retained = await withSystemTx(this.pool, async (tx) => {
            // Generation binding takes a share lock and requires attested.
            // Mark retirement while holding the row lock so a new reference
            // cannot be admitted after the final reference check.
            await tx.query(
              "SELECT id FROM cloud_computer_images WHERE id=$1 AND account_scope=$2 FOR UPDATE",
              [id, this.account],
            );
            if (await referenced(tx, image)) return true;
            await tx.query(
              "UPDATE cloud_computer_images SET state='retiring',updated_at=now() WHERE id=$1 AND state<>'retired'",
              [id],
            );
            return false;
          });
          if (!retained && !snapshotDeleted) {
            snapshotDeleted = await this.driver.removeSnapshot(image, () =>
              this.update(id, {
                snapshot_deletion_requested_at: new Date(),
              }).then(() => {}),
            );
            complete = snapshotDeleted;
          }
          if (complete) {
            await this.driver.releaseAdmission(image, {
              computeDeleted: true,
              snapshotDeleted: !retained && snapshotDeleted,
            });
            if (!retained) await this.update(id, { state: "retired" });
          }
        } finally {
          await lock.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,62172))",
            [this.account],
          );
        }
      }
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_builds SET cleanup_state=$2 WHERE id=$1",
          [id, complete ? "complete" : "requested"],
        ),
      );
    } catch {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
          [id],
        ),
      );
    } finally {
      if (locked)
        await lock.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,62173))",
          [id],
        );
      lock.release();
    }
  }
}
/** This worker only retires explicitly-created disposable build workspaces.
 * All provider deletion stays in the existing receipt-verified reconciler. */
export class CloudComputerRetirementWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly batchSize = 32,
    private readonly imageWorker?: ComputerImageRetirementWorker,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32)
      throw new Error("Invalid Cloud Computer reconciliation batch size");
  }
  async tick(): Promise<void> {
    await this.imageWorker?.tick();
    const candidates = await withSystemTx(this.pool, (tx) =>
      tx.query<{ id: string; org_id: string; workspace_id: string | null }>(
        // Claim fairly before provider/lifecycle reconciliation. Slow or failed
        // builds must not keep newer organizations outside the bounded batch.
        `WITH candidates AS (SELECT id FROM cloud_computer_builds
          WHERE (state='building' OR cleanup_state<>'complete')
            AND NOT EXISTS(SELECT 1 FROM cloud_computer_images image WHERE image.id=cloud_computer_builds.id)
          ORDER BY last_checked_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
          UPDATE cloud_computer_builds build SET last_checked_at=clock_timestamp()
          FROM candidates WHERE build.id=candidates.id RETURNING build.id,build.org_id,build.workspace_id`,
        [this.batchSize],
      ),
    );
    for (const candidate of candidates.rows) {
      try {
        await withSystemTx(this.pool, async (tx) => {
          // Match the normal lifecycle lock order: organization, workspace, then recipe/build.
          await tx.query(
            "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
            [candidate.org_id],
          );
          const workspace = candidate.workspace_id
            ? (
                await tx.query<{
                  status: string;
                  desired_state: string;
                  current_generation: number;
                  owner_user_id: string;
                }>(
                  "SELECT status,desired_state,current_generation,owner_user_id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",
                  [candidate.workspace_id],
                )
              ).rows[0]
            : null;
          await lockCloudComputerOrganization(tx, candidate.org_id);
          const build = (
            await tx.query<{
              state: string;
              cleanup_state: string;
            }>(
              "SELECT state,cleanup_state FROM cloud_computer_builds WHERE id=$1 FOR UPDATE",
              [candidate.id],
            )
          ).rows[0];
          if (!build) return;
          if (build.state === "building")
            await retireLegacyComputerBuilds(tx, candidate.org_id);
          if (!workspace || workspace.status === "deleted") {
            await tx.query(
              "UPDATE cloud_computer_builds SET cleanup_state='complete' WHERE id=$1",
              [candidate.id],
            );
            return;
          }
          if (workspace.desired_state === "deleted") {
            await tx.query(
              "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
              [candidate.id],
            );
            return;
          }
          await tx.query(
            "UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND affects_workspace AND state IN ('queued','observing')",
            [candidate.workspace_id],
          );
          const intentId = randomUUID();
          await tx.query(
            `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,$5,'delete',$6,$7)`,
            [
              intentId,
              candidate.workspace_id,
              workspace.current_generation,
              candidate.org_id,
              workspace.owner_user_id,
              `computer-build.${candidate.id}.delete`,
              digest({ build: candidate.id, operation: "delete" }),
            ],
          );
          await retireCloudWorkspaceRuntimeAccess(tx, {
            workspaceId: candidate.workspace_id!,
            organizationId: candidate.org_id,
            reason: "workspace_delete_requested",
          });
          await ensureWorkspaceDeletionJob(tx, {
            workspaceId: candidate.workspace_id!,
            organizationId: candidate.org_id,
            requestedBy: workspace.owner_user_id,
            lifecycleIntentId: intentId,
          });
          await tx.query(
            "UPDATE cloud_workspaces SET status='deleting',desired_state='deleted',version=version+1,authority_epoch=authority_epoch+1,updated_at=now() WHERE id=$1",
            [candidate.workspace_id],
          );
          await tx.query(
            "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
            [candidate.id],
          );
        });
      } catch {
        // The claim timestamp is already committed. Retry this build later,
        // but continue retiring the other organizations in this batch.
        console.warn("[cloud-computer] historical retirement pending");
      }
    }
  }
  start(): () => Promise<void> {
    let stopping = false,
      pending: Promise<void> | null = null;
    const tick = () => {
      if (stopping || pending) return;
      pending = this.tick()
        .catch(() => {
          console.warn("[cloud-computer] historical retirement pending");
        })
        .finally(() => {
          pending = null;
        });
    };
    const timer = setInterval(tick, 5000);
    timer.unref();
    tick();
    return async () => {
      stopping = true;
      clearInterval(timer);
      await pending;
    };
  }
}

export function createCloudComputerRetirementWorker(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig,
) {
  return new CloudComputerRetirementWorker(
    pool,
    32,
    config.boat
      ? new ComputerImageRetirementWorker(
          pool,
          config.boat.accountScope,
          createComputerRetirementDriver(config),
          [cloudWorkspaceProvisioningProfile(config, "boat").imageRef],
        )
      : undefined,
  );
}
