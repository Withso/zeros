import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudWorkspaceProvisioningProfile } from "../config.js";
import { BoatCreateRejectedError, type BoatApiClient } from "./boat-client.js";
import type { CloudProviderCreateInput } from "./provider.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const attestation = z.object({
  qualified: z.literal(true),
  profile: z.literal("zeros-cloud-worker-v3"),
  setupQualification: z.object({ secure: z.literal(true) }),
  metadata: z.object({
    buildSha256: sha,
    build: z.object({
      source: z.object({ commit: z.string(), contractSha256: sha }),
      imageContractSha256: sha,
    }),
  }),
});
export class ComputerImageError extends Error {
  constructor(readonly code: string) {
    super("Cloud Computer image operation failed");
  }
}
export function computerImageFailure(error: unknown): string {
  return error instanceof ComputerImageError
    ? error.code
    : "image_build_failed";
}
export function assertComputerImageAttestation(
  value: unknown,
  build: string,
  commit: string,
) {
  const parsed = attestation.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.metadata.buildSha256 !== build ||
    parsed.data.metadata.build.source.commit !== commit
  )
    throw new ComputerImageError("image_attestation_failed");
  return {
    sourceContract: parsed.data.metadata.build.source.contractSha256,
    imageContract: parsed.data.metadata.build.imageContractSha256,
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}
export function availableComputerImageSlots(
  inventory: string[],
  reservations: string[],
) {
  return Math.max(0, 10 - new Set([...inventory, ...reservations]).size);
}
export type ComputerImage = {
  id: string;
  org_id: string;
  account_scope: string;
  snapshot_name: string;
  snapshot_id: string | null;
  image_ref: string | null;
  base_image_ref: string;
  base_source_commit: string;
  recipe_sha256: string;
  build_sha256: string | null;
  source_contract: string | null;
  image_contract: string | null;
  profile: CloudWorkspaceProvisioningProfile;
  state: string;
  builder_id: string | null;
  verifier_id: string | null;
  capture_dispatched_at: Date | null;
  created_at: Date;
  attested_at: Date | null;
  builder_dispatched_at: Date | null;
  verifier_dispatched_at: Date | null;
  builder_deletion_operation: string | null;
  verifier_deletion_operation: string | null;
  builder_deleted: boolean;
  verifier_deleted: boolean;
  snapshot_deletion_requested_at: Date | null;
};
export type ComputerSnapshot = {
  name: string;
  id: string | null;
  source: string;
  ready: boolean;
  failed?: boolean;
};
/** A separate provider port: no workspace admission, repositories, credentials,
 * engine registration, setup grants, or user environments exist in this role. */
export interface ComputerImageDriver {
  inventory(): Promise<ComputerSnapshot[]>;
  create(image: ComputerImage, role: "builder" | "verifier", beforeDispatch: () => Promise<void>): Promise<string>;
  ready(id: string): Promise<boolean>;
  install(
    image: ComputerImage,
    recipe: { installScript: string; timeoutSeconds: number },
  ): Promise<boolean>;
  sanitize(image: ComputerImage): Promise<{ buildSha256: string }>;
  capture(image: ComputerImage): Promise<void>;
  snapshot(image: ComputerImage): Promise<ComputerSnapshot | null>;
  attest(image: ComputerImage): Promise<unknown | null>;
  removeSandbox(
    id: string,
    operation: string | null,
    persist: (operation: string) => Promise<void>,
  ): Promise<boolean>;
  removeSnapshot(
    image: ComputerImage,
    persist: () => Promise<void>,
  ): Promise<boolean>;
}

/** Pin before using/promoting a configured base. Pins survive rolling deploys
 * and rollback; there is intentionally no runtime unpin or lease expiration. */
export async function protectComputerImageBases(tx: Tx, account: string, refs: readonly string[]) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,62172))", [account]);
  for (const ref of refs) {
    const name = /^boat:([a-z0-9-]+)@sha256:[a-f0-9]{64}$/.exec(ref)?.[1];
    if (!name) throw new ComputerImageError("image_base_invalid");
    await tx.query(`INSERT INTO cloud_computer_image_base_references(account_scope,snapshot_name,image_ref)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [account, name, ref]);
  }
}

async function computerImageReferenced(tx: Tx, image: ComputerImage) {
  return (await tx.query(`SELECT 1 FROM cloud_computers WHERE active_image_id=$1 OR previous_image_id=$1
    UNION ALL SELECT 1 FROM cloud_workspace_generations
      WHERE computer_image_id=$1 OR split_part(image_ref,'@',1)=$2
    UNION ALL SELECT 1 FROM cloud_computer_images
      WHERE split_part(base_image_ref,'@',1)=$2 AND state<>'retired'
    UNION ALL SELECT 1 FROM cloud_computer_image_base_references
      WHERE account_scope=$3 AND snapshot_name=$4 LIMIT 1`,
    [image.id, `boat:${image.snapshot_name}`, image.account_scope, image.snapshot_name])).rowCount !== 0;
}

export async function reserveComputerImageSlot(
  tx: Tx,
  account: string,
  driver: ComputerImageDriver,
) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,62172))", [
    account,
  ]);
  const inventory = await driver.inventory();
  const reservations = (
    await tx.query<{ snapshot_name: string }>(
      "SELECT snapshot_name FROM cloud_computer_images WHERE account_scope=$1 AND state<>'retired'",
      [account],
    )
  ).rows;
  if (
    availableComputerImageSlots(
      inventory.map((row) => row.name),
      reservations.map((row) => row.snapshot_name),
    ) < 1
  )
    throw new HttpError(
      409,
      "cloud_computer_snapshot_limit",
      "All ten image slots are in use or reserved. Retire an unreferenced image before building.",
    );
}

/** Always require fresh exact-image agent qualification. Runtime attestation
 * alone is not evidence for stored credentials/native provider execution. The
 * runtime role cannot write this operator-owned qualification table. */
export async function assertComputerImageQualified(
  tx: Tx,
  image: ComputerImage,
) {
  const required = await tx.query<{
    credential_kind: string;
    runtime_contract_sha256: string;
    profile: string;
  }>(
    `SELECT credential_kind,runtime_contract_sha256,profile FROM cloud_agent_runtime_qualifications
     WHERE provider='boat' AND image_ref=$1 AND enabled`,
    [image.base_image_ref],
  );
  if (!required.rowCount)
    throw new HttpError(
      409,
      "cloud_computer_qualification_required",
      "The base image has no current agent qualification.",
    );
  const exact = await tx.query<{
    credential_kind: string;
    runtime_contract_sha256: string;
    profile: string;
  }>(
    `SELECT credential_kind,runtime_contract_sha256,profile FROM cloud_agent_runtime_qualifications
     WHERE provider='boat' AND image_ref=$1 AND enabled AND qualified_at >= $2`,
    [image.image_ref, image.attested_at],
  );
  if (
    required.rows.some(
      (base) =>
        !exact.rows.some(
          (row) =>
            row.credential_kind === base.credential_kind &&
            row.runtime_contract_sha256 === base.runtime_contract_sha256 &&
            row.profile === base.profile,
        ),
    )
  )
    throw new HttpError(
      409,
      "cloud_computer_qualification_required",
      "This exact image needs fresh agent qualification before activation.",
    );
}

/** Called in create preflight and again under the organization admission lock.
 * A changed selection aborts admission; already accepted generations stay pinned. */
export async function resolveComputerImage(
  tx: Tx,
  org: string,
  base: CloudWorkspaceProvisioningProfile,
) {
  if (base.provider !== "boat") return base;
  // Admission can run before this deployment's first worker tick. Register a
  // managed configured base before it can become a generation or child image.
  const configured = (await tx.query<ComputerImage>(
    "SELECT * FROM cloud_computer_images WHERE image_ref=$1", [base.imageRef])).rows[0];
  if (configured) await protectComputerImageBases(tx, configured.account_scope, [base.imageRef]);
  const image = (
    await tx.query<ComputerImage & { selection_matches: boolean }>(
      `SELECT image.*,
    (computer.active_version=build.version AND profile.current_version=build.version) AS selection_matches FROM cloud_computers computer
    JOIN cloud_computer_images image ON image.id=computer.active_image_id AND image.org_id=computer.org_id
    JOIN cloud_computer_builds build ON build.id=image.id
    JOIN environment_profiles profile ON profile.id=computer.profile_id AND profile.is_default
    WHERE computer.org_id=$1 FOR SHARE OF image`,
      [org],
    )
  ).rows[0];
  if (!image) return base;
  if (
    !image.selection_matches ||
    image.state !== "attested" ||
    image.base_image_ref !== base.imageRef
  )
    throw new HttpError(
      409,
      "cloud_computer_base_changed",
      "Rebuild Cloud Computer for the current base image before creating a workspace.",
    );
  await assertComputerImageQualified(tx, image);
  return { ...image.profile, imageRef: image.image_ref! };
}

export async function resolveComputerSnapshot(
  pool: pg.Pool,
  account: string,
  client: BoatApiClient,
  input: CloudProviderCreateInput,
) {
  const name = /^boat:([a-z0-9-]+)@sha256:[a-f0-9]{64}$/.exec(
    input.imageRef,
  )?.[1];
  if (!name) throw new ComputerImageError("image_snapshot_identity_mismatch");
  if (!name.startsWith("zeros-org-")) return name;
  const image = await withSystemTx(
    pool,
    async (tx) =>
      (
        await tx.query<ComputerImage>(
          `SELECT image.* FROM cloud_workspace_generations generation
    JOIN cloud_computer_images image ON image.id=generation.computer_image_id AND image.org_id=generation.org_id
    WHERE generation.workspace_id=$1 AND generation.generation=$2 AND generation.image_ref=$3 AND image.image_ref=$3
      AND image.account_scope=$4 AND image.state='attested'`,
          [input.workspaceId, input.generation, input.imageRef, account],
        )
      ).rows[0],
  );
  if (!image) throw new ComputerImageError("image_snapshot_identity_mismatch");
  const result = await client.request(`/named-snapshots/${name}`);
  const snapshot = result.snapshot as Record<string, unknown> | undefined;
  if (
    snapshot?.name !== name ||
    snapshot.snapshotId !== image.snapshot_id ||
    snapshot.sourceSandboxId !== image.builder_id ||
    snapshot.status !== "ready"
  )
    throw new ComputerImageError("image_snapshot_identity_mismatch");
  return name;
}

export class ComputerImageWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly account: string,
    private readonly driver: ComputerImageDriver,
    private readonly protectedImageRefs: readonly string[] = [],
  ) {}
  async tick() {
    await withSystemTx(this.pool, tx => protectComputerImageBases(tx, this.account, this.protectedImageRefs));
    const ids = await withSystemTx(this.pool, (tx) =>
      tx.query<{ id: string }>(
        `SELECT image.id FROM cloud_computer_images image JOIN cloud_computer_builds build ON build.id=image.id
       WHERE image.account_scope=$1 AND (image.state NOT IN ('attested','retired') OR build.cleanup_state<>'complete')
       ORDER BY image.updated_at,image.id LIMIT 16`,
        [this.account],
      ),
    );
    for (const { id } of ids.rows) await this.reconcile(id);
    await this.retire();
  }
  private async read(id: string) {
    return withSystemTx(
      this.pool,
      async (tx) =>
        (
          await tx.query<
            ComputerImage & {
              build_state: string;
              expired: boolean;
              document: {
                values: {
                  cloudComputer: {
                    installScript: string;
                    timeoutSeconds: number;
                  };
                };
              };
            }
          >(
            `SELECT image.*,build.state AS build_state,build.deadline_at<=clock_timestamp() AS expired,version.document
      FROM cloud_computer_images image JOIN cloud_computer_builds build ON build.id=image.id
      JOIN environment_profile_versions version ON version.profile_id=build.profile_id AND version.version=build.version
      WHERE image.id=$1 AND image.account_scope=$2`,
            [id, this.account],
          )
        ).rows[0],
    );
  }
  private async update(
    id: string,
    fields: Partial<ComputerImage> & {
      error_code?: string;
      attestation_sha256?: string;
    },
  ) {
    const entries = Object.entries(fields);
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE cloud_computer_images SET ${entries.map(([key], i) => `${key}=$${i + 2}`).join(",")},updated_at=now() WHERE id=$1`,
        [id, ...entries.map(([, v]) => v)],
      ),
    );
  }
  private async reconcile(id: string) {
    // Session lock across provider awaits; no open transaction/row locks during
    // installation. A crashed process releases the lock; durable phases fence retries.
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,62173)) AS locked",
          [id],
        )
      ).rows[0]!.locked;
      if (!locked) return;
      const image = await this.read(id);
      if (!image) return;
      if (
        (image.expired || image.build_state === "cancelled") &&
        !["attested", "failed", "cancelled", "retiring", "retired"].includes(
          image.state,
        )
      ) {
        await this.fail(
          image,
          image.build_state === "cancelled" ? "cancelled" : "failed",
          image.expired ? "build_timed_out" : "build_cancelled",
        );
        return;
      }
      switch (image.state) {
        case "reserved":
          await this.update(id, { state: "creating" });
          break;
        case "creating": {
          const builder =
            image.builder_id ?? (await this.create(image, "builder"));
          if (await this.driver.ready(builder))
            await this.update(id, { state: "installing" });
          break;
        }
        case "installing":
          if (
            await this.driver.install(
              image,
              image.document.values.cloudComputer,
            )
          )
            await this.update(id, { state: "sanitizing" });
          break;
        case "sanitizing": {
          const proof = await this.driver.sanitize(image);
          if (!sha.safeParse(proof.buildSha256).success)
            throw new ComputerImageError("image_sanitation_failed");
          await this.update(id, {
            build_sha256: proof.buildSha256,
            image_ref: `boat:${image.snapshot_name}@sha256:${proof.buildSha256}`,
            state: "capturing",
          });
          break;
        }
        case "capturing": {
          let snapshot = await this.driver.snapshot(image);
          if (!snapshot && !image.capture_dispatched_at) {
            // Refresh sanitation immediately before capture; bind the same bytes.
            const proof = await this.driver.sanitize(image);
            if (proof.buildSha256 !== image.build_sha256)
              throw new ComputerImageError("image_sanitation_failed");
            const current = await this.read(id);
            if (current?.build_state !== "building" || current.expired) return;
            await this.update(id, { capture_dispatched_at: new Date() });
            await this.driver.capture(image);
            snapshot = await this.driver.snapshot(image);
          }
          // A lost capture reply is reconciled by exact name + builder identity;
          // never dispatch a second capture after an ambiguous outcome.
          if (
            snapshot &&
            (snapshot.name !== image.snapshot_name ||
              snapshot.source !== image.builder_id)
          )
            throw new ComputerImageError("image_snapshot_identity_mismatch");
          if (snapshot?.failed)
            throw new ComputerImageError("image_capture_failed");
          if (snapshot?.ready && snapshot.id)
            await this.update(id, {
              snapshot_id: snapshot.id,
              state: "verifying",
            });
          break;
        }
        case "verifying": {
          if (!image.verifier_id) {
            await this.create(image, "verifier");
            break;
          }
          if (!(await this.driver.ready(image.verifier_id))) break;
          const report = await this.driver.attest(image);
          if (report === null) break;
          const proof = assertComputerImageAttestation(
            report,
            image.build_sha256!,
            image.base_source_commit,
          );
          await withSystemTx(this.pool, async (tx) => {
            const valid = await tx.query(
              "SELECT id FROM cloud_computer_builds WHERE id=$1 AND state='building' AND deadline_at>clock_timestamp() FOR UPDATE",
              [id],
            );
            if (!valid.rowCount) return;
            await tx.query(
              `UPDATE cloud_computer_images SET state='attested',source_contract=$2,image_contract=$3,
              attestation_sha256=$4,attested_at=now(),updated_at=now() WHERE id=$1`,
              [id, proof.sourceContract, proof.imageContract, proof.sha256],
            );
            await tx.query(
              "UPDATE cloud_computer_builds SET state='succeeded',completed_at=now() WHERE id=$1",
              [id],
            );
          });
          break;
        }
        case "attested":
        case "failed":
        case "cancelled":
        case "retiring":
        case "retired":
          await this.cleanup(image);
          break;
      }
    } catch (error) {
      const image = await this.read(id);
      // Captures/creates can have an unknown outcome. Keep their reservation and
      // identity, reconcile/clean them up on the next pass, never free on timeout.
      if (image && !["attested", "retiring", "retired"].includes(image.state))
        await this.fail(image, "failed", computerImageFailure(error));
    } finally {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,62173))",
          [id],
        );
      client.release();
    }
  }
  private async create(image: ComputerImage, role: "builder" | "verifier") {
    let attempt: string | undefined;
    try {
      const id = await this.driver.create(image, role, async () => {
        attempt = randomUUID();
        await withSystemTx(this.pool, async tx => {
          // Upgrade an older worker's timestamp-only dispatch before adding a
          // replay. A later certified refusal cannot erase that uncertainty.
          await tx.query(`INSERT INTO cloud_computer_image_create_attempts(id,image_id,role,state)
            SELECT $1,id,$3,'dispatched' FROM cloud_computer_images
            WHERE id=$2 AND ${role}_dispatched_at IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM cloud_computer_image_create_attempts WHERE image_id=$2 AND role=$3)`,
            [randomUUID(), image.id, role]);
          await tx.query(`INSERT INTO cloud_computer_image_create_attempts(id,image_id,role,state)
            VALUES($1,$2,$3,'dispatched')`, [attempt, image.id, role]);
          await tx.query(`UPDATE cloud_computer_images SET ${role}_dispatched_at=coalesce(${role}_dispatched_at,now())
            WHERE id=$1`, [image.id]);
        });
      });
      await withSystemTx(this.pool, async tx => {
        await tx.query(`UPDATE cloud_computer_images SET ${role}_id=$2,updated_at=now() WHERE id=$1`, [image.id, id]);
        // Every replay uses the same idempotency key. An identity resolves all
        // uncertain dispatches for that role, but a refusal resolves only itself.
        await tx.query(`UPDATE cloud_computer_image_create_attempts SET state='confirmed'
          WHERE image_id=$1 AND role=$2 AND state='dispatched'`, [image.id, role]);
      });
      return id;
    } catch (error) {
      if (attempt && error instanceof BoatCreateRejectedError)
        await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_computer_image_create_attempts
          SET state='rejected',rejection_code=$2 WHERE id=$1 AND state='dispatched'`, [attempt, error.createRejectionCode]));
      throw error;
    }
  }
  private async uncertainCreate(image: ComputerImage, role: "builder" | "verifier") {
    const attempts = await withSystemTx(this.pool, tx => tx.query<{ state: string }>(
      "SELECT state FROM cloud_computer_image_create_attempts WHERE image_id=$1 AND role=$2", [image.id, role]));
    // Timestamp-only records from an interrupted older worker are conservative.
    return attempts.rows.some(row => row.state === "dispatched") ||
      (attempts.rowCount === 0 && image[`${role}_dispatched_at`] !== null);
  }
  private async fail(
    image: ComputerImage,
    state: "failed" | "cancelled",
    code: string,
  ) {
    await this.update(image.id, { state, error_code: code });
    await withSystemTx(this.pool, (tx) =>
      tx.query(
        `UPDATE cloud_computer_builds SET state=CASE WHEN state='cancelled' THEN state ELSE $2 END,
      error_code=$3,completed_at=coalesce(completed_at,now()) WHERE id=$1`,
        [image.id, state, code],
      ),
    );
  }
  private async cleanup(image: ComputerImage) {
    let complete = true;
    let captureSettled = !image.capture_dispatched_at || image.snapshot_id !== null;
    if (!captureSettled) {
      try {
        const captured = await this.driver.snapshot(image);
        if (captured && (captured.name !== image.snapshot_name || captured.source !== image.builder_id))
          throw new ComputerImageError("image_snapshot_identity_mismatch");
        if (captured && (captured.failed || (captured.ready && captured.id))) {
          await this.update(image.id, { snapshot_id: captured.id });
          image.snapshot_id = captured.id;
          captureSettled = true;
        }
      } catch { /* Keep this capture reserved; still clean independent VMs. */ }
    }
    for (const role of ["builder", "verifier"] as const) {
      try {
        let id = image[`${role}_id`];
        if (!id && await this.uncertainCreate(image, role)) {
          id = await this.create(image, role);
          image[`${role}_id`] = id;
        }
        if (id && !image[`${role}_deleted`]) {
          // A pending capture still owns its builder disk.
          if (role === "builder" && !captureSettled) { complete = false; continue; }
          if (await this.driver.removeSandbox(id, image[`${role}_deletion_operation`],
            operation => this.update(image.id, { [`${role}_deletion_operation`]: operation }))) {
            await this.update(image.id, { [`${role}_deleted`]: true });
            image[`${role}_deleted`] = true;
          } else complete = false;
        }
      } catch {
        // A blocked replay/deletion cannot abandon another known allocation.
        complete = false;
      }
    }
    complete = complete && captureSettled;
    if (complete && image.state !== "attested" && image.state !== "retired" && image.capture_dispatched_at) {
      // The same account lock serializes base promotion, reservations and the
      // provider delete. No transaction stays open across provider awaits.
      const lock = await this.pool.connect();
      try {
        await lock.query("SELECT pg_advisory_lock(hashtextextended($1,62172))", [this.account]);
        if (await withSystemTx(this.pool, tx => computerImageReferenced(tx, image))) return;
        complete = await this.driver.removeSnapshot(image, () =>
          this.update(image.id, { snapshot_deletion_requested_at: new Date() }));
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,62172))", [this.account]);
        lock.release();
      }
    }
    await withSystemTx(this.pool, async tx => {
      if (complete && image.state !== "attested")
        await tx.query("UPDATE cloud_computer_images SET state='retired',updated_at=now() WHERE id=$1", [image.id]);
      await tx.query("UPDATE cloud_computer_builds SET cleanup_state=$2 WHERE id=$1",
        [image.id, complete ? "complete" : "requested"]);
    });
  }
  async retire() {
    // Reference counts are derived from durable owners, including archived and
    // stopped generations. Do not garbage-collect base/release names, ever.
    await withSystemTx(this.pool, async (tx) => {
      await protectComputerImageBases(tx, this.account, this.protectedImageRefs);
      const rows = (
        await tx.query<ComputerImage>(
          `SELECT image.* FROM cloud_computer_images image
        WHERE account_scope=$1 AND state='attested' AND created_at<now()-interval '7 days'
        ORDER BY created_at FOR UPDATE SKIP LOCKED`,
          [this.account],
        )
      ).rows;
      for (const image of rows) {
        if (!(await computerImageReferenced(tx, image)))
          await tx.query(
            "UPDATE cloud_computer_images SET state='retiring',updated_at=now() WHERE id=$1",
            [image.id],
          );
      }
    });
  }
}
