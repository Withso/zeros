import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../migrate.js";
import {
  DatabaseCloudWorkspaceBlobService,
  MemoryCloudWorkspaceObjectStore,
} from "./object-store.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace production operations", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  function blobs(store = new MemoryCloudWorkspaceObjectStore()) {
    return {
      store,
      service: new DatabaseCloudWorkspaceBlobService({
        pool,
        objectStore: store,
        encryptionKeyV1: randomBytes(32).toString("base64url"),
        workosEnabled: false,
      }),
    };
  }

  it("expires export capabilities atomically and releases their checkpoint/object pins", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const { service } = blobs();
    const manifest = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("{}", "utf8"),
    });
    const checkpointId = randomUUID();
    const exportId = randomUUID();
    const digest = randomBytes(32);
    await pool.query(
      `INSERT INTO workspace_content_heads (
         workspace_id, org_id, current_revision, durable_revision
       ) VALUES ($1, $2, 1, 1)`,
      [fixture.workspaceId, fixture.organizationId],
    );
    await pool.query(
      `INSERT INTO workspace_content_revisions (
         workspace_id, org_id, revision, parent_revision, authority_epoch,
         generation, engine_instance_id, idempotency_key, request_sha256,
         changed_entry_count
       ) VALUES ($1, $2, 1, 0, 1, 1, $3, 'operations-content-1', $4, 0)`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        fixture.engineInstanceId,
        digest,
      ],
    );
    await pool.query(
      `INSERT INTO workspace_checkpoints (
         id, workspace_id, org_id, idempotency_key, request_sha256,
         content_revision, record_revision, authority_epoch, generation,
         reason, manifest_blob_id, inclusion_policy, file_count, total_bytes,
         state, integrity_sha256, durable_at
       ) VALUES (
         $3, $1, $2, 'operations-checkpoint-1', $4, 1, 0, 1, 1,
         'periodic', $5, '{}', 0, 0, 'durable', $4, now()
       )`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        checkpointId,
        digest,
        manifest.id,
      ],
    );
    await pool.query(
      `UPDATE workspace_content_heads SET current_checkpoint_id = $2
       WHERE workspace_id = $1`,
      [fixture.workspaceId, checkpointId],
    );
    await pool.query(
      `INSERT INTO workspace_exports (
         id, org_id, workspace_id, requested_by, checkpoint_id,
         record_revision, content_revision, include_chats, idempotency_key,
         request_sha256, state, export_blob_id, available_at, expires_at,
         completed_at
       ) VALUES (
         $3, $2, $1, $4, $5, 0, 1, false, 'operations-export-1', $6,
         'available', $7, now() - interval '2 days', now() - interval '1 day',
         now() - interval '2 days'
       )`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        exportId,
        fixture.userId,
        checkpointId,
        digest,
        manifest.id,
      ],
    );
    await pool.query(
      `INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       ) VALUES
         ($3, $2, $1, 'checkpoint_manifest', $4::text),
         ($3, $2, $1, 'export', $5::text)`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        manifest.id,
        checkpointId,
        exportId,
      ],
    );
    const worker = new CloudWorkspaceOperationsWorker(pool, service, {
      workerId: "operations-export-test",
    });

    await expect(worker.expireExportOnce()).resolves.toBe(true);
    expect(
      (
        await pool.query(
          `SELECT state, checkpoint_id FROM workspace_exports WHERE id = $1`,
          [exportId],
        )
      ).rows[0],
    ).toEqual({ state: "expired", checkpoint_id: null });
    expect(
      (
        await pool.query(
          `SELECT reference_kind FROM workspace_blob_references
           WHERE reference_id = $1`,
          [exportId],
        )
      ).rows,
    ).toEqual([]);
  });

  it("compacts an expired record prefix while retaining the exact current projection", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const { service } = blobs();
    const oldBatch = randomUUID();
    const currentBatch = randomUUID();
    const digest = randomBytes(32);
    await pool.query(
      `INSERT INTO workspace_retention_policies (
         workspace_id, org_id, record_event_days, content_event_days,
         checkpoint_days, export_days
       ) VALUES ($1, $2, 1, 90, 90, 7)`,
      [fixture.workspaceId, fixture.organizationId],
    );
    await pool.query(
      `INSERT INTO workspace_record_heads (
         workspace_id, org_id, current_revision, last_durable_at
       ) VALUES ($1, $2, 2, now())`,
      [fixture.workspaceId, fixture.organizationId],
    );
    await pool.query(
      `INSERT INTO workspace_record_batches (
         id, workspace_id, org_id, engine_instance_id, authority_epoch,
         idempotency_key, request_sha256, first_revision, last_revision,
         event_count, created_at
       ) VALUES
         ($3, $1, $2, $5, 1, 'operations-record-old', $6, 1, 1, 1,
          now() - interval '2 days'),
         ($4, $1, $2, $5, 1, 'operations-record-current', $6, 2, 2, 1,
          now())`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        oldBatch,
        currentBatch,
        fixture.engineInstanceId,
        digest,
      ],
    );
    await pool.query(
      `INSERT INTO workspace_record_events (
         workspace_id, org_id, revision, batch_id, entity_kind, entity_id,
         operation, document, occurred_at, created_at
       ) VALUES
         ($1, $2, 1, $3, 'metadata', 'old', 'upsert', '{"value":1}',
          now() - interval '2 days', now() - interval '2 days'),
         ($1, $2, 2, $4, 'metadata', 'current', 'upsert', '{"value":2}',
          now(), now())`,
      [fixture.workspaceId, fixture.organizationId, oldBatch, currentBatch],
    );
    await pool.query(
      `INSERT INTO workspace_record_entities (
         workspace_id, org_id, entity_kind, entity_id, revision,
         schema_version, document
       ) VALUES ($1, $2, 'metadata', 'current', 2, 1, '{"value":2}')`,
      [fixture.workspaceId, fixture.organizationId],
    );
    const worker = new CloudWorkspaceOperationsWorker(pool, service, {
      workerId: "operations-retention-test",
    });

    await expect(worker.applyRetentionOnce()).resolves.toBe(true);
    expect(
      (
        await pool.query(
          `SELECT revision FROM workspace_record_events
           WHERE workspace_id = $1 ORDER BY revision`,
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([{ revision: "2" }]);
    expect(
      (
        await pool.query(
          `SELECT minimum_retained_revision FROM workspace_record_heads
           WHERE workspace_id = $1`,
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({ minimum_retained_revision: "1" });
    expect(
      (
        await pool.query(
          `SELECT entity_id, document FROM workspace_record_entities
           WHERE workspace_id = $1`,
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([{ entity_id: "current", document: { value: 2 } }]);
  });

  it("waits for legal/provider deletion proof, then erases data and preserves the billing tombstone", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const { service, store } = blobs();
    const artifact = await service.put({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      bytes: Buffer.from("private transcript", "utf8"),
    });
    await pool.query(
      `INSERT INTO workspace_retention_policies (
         workspace_id, org_id, legal_hold
       ) VALUES ($1, $2, true)`,
      [fixture.workspaceId, fixture.organizationId],
    );
    await pool.query(
      `INSERT INTO workspace_blob_references (
         blob_id, org_id, workspace_id, reference_kind, reference_id
       ) VALUES ($3, $2, $1, 'transcript_artifact', 'private-transcript')`,
      [fixture.workspaceId, fixture.organizationId, artifact.id],
    );
    await pool.query(
      `UPDATE cloud_workspaces
       SET status = 'deleted', desired_state = 'deleted', deleted_at = now()
       WHERE id = $1`,
      [fixture.workspaceId],
    );
    await pool.query(
      `UPDATE cloud_workspace_provider_bindings
       SET observed_state = 'deleted', deletion_verified_at = NULL
       WHERE workspace_id = $1`,
      [fixture.workspaceId],
    );
    const worker = new CloudWorkspaceOperationsWorker(pool, service, {
      workerId: "operations-deletion-test",
      deletionBatchSize: 10,
    });

    await expect(worker.processDeletionOnce()).resolves.toBe(false);
    expect(
      (
        await pool.query(
          `SELECT state FROM workspace_deletion_jobs WHERE workspace_id = $1`,
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({ state: "waiting_for_provider" });

    await pool.query(
      `UPDATE workspace_retention_policies SET legal_hold = false
       WHERE workspace_id = $1`,
      [fixture.workspaceId],
    );
    await pool.query(
      `UPDATE cloud_workspace_provider_bindings SET deletion_verified_at = now()
       WHERE workspace_id = $1`,
      [fixture.workspaceId],
    );
    for (let step = 0; step < 6; step += 1) {
      await worker.processDeletionOnce();
    }
    expect(
      (
        await pool.query(
          `SELECT workspace.data_deleted_at IS NOT NULL AS erased,
                  job.state, job.completed_at IS NOT NULL AS completed
           FROM cloud_workspaces workspace
           JOIN workspace_deletion_jobs job ON job.workspace_id = workspace.id
           WHERE workspace.id = $1`,
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({ erased: true, state: "succeeded", completed: true });
    expect(
      (
        await pool.query(
          `SELECT
             (SELECT count(*) FROM cloud_workspace_setup_specs
               WHERE workspace_id = $1)::integer AS setup_specs,
             (SELECT count(*) FROM workspace_blob_references
               WHERE workspace_id = $1)::integer AS blob_references,
             (SELECT count(*) FROM cloud_workspace_generations
               WHERE workspace_id = $1)::integer AS generations,
             (SELECT count(*) FROM workspace_billing_epochs
               WHERE workspace_id = $1)::integer AS billing_epochs`,
          [fixture.workspaceId],
        )
      ).rows[0],
    ).toEqual({
      setup_specs: 0,
      blob_references: 0,
      generations: 1,
      billing_epochs: 1,
    });
    expect(
      await store.get(
        (
          await pool.query<{ object_key: string }>(
            `SELECT object_key FROM workspace_blobs WHERE id = $1`,
            [artifact.id],
          )
        ).rows[0]!.object_key,
      ),
    ).toBeNull();
  });
});
