import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetMigratedTestDatabase } from "../test-database.js";
import {
  DatabaseCloudWorkspaceBlobService,
  MemoryCloudWorkspaceObjectStore,
} from "./object-store.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";
import { DatabaseCloudWorkspaceEventService } from "./event-streams.js";

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
    await resetMigratedTestDatabase(pool);
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

  it.each(["commands", "events", "actions"] as const)(
    "purges %s before retiring engine records, preserving another workspace and the billing tombstone",
    async kind => {
      const fixture = await seedReadyCloudWorkspace(pool);
      const other = await seedReadyCloudWorkspace(pool);
      for (const f of [fixture, other]) {
        const scope = await seedRecordedCloudWorkspaceActor(pool, f, kind === "actions" ? { executionId: "execution" } : {});
        if (kind === "commands") {
          const commands = new DatabaseCloudWorkspaceCommandService({ pool });
          await commands.mutate(scope, { conversationId: "delete-fixture", operationId: randomUUID(), expectedRevision: 0,
            action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", modeRevision: 0,
              userMessageId: randomUUID(), prompt: [{ type: "text", text: "private command fixture" }] } } });
          await commands.claim(scope, "delete-fixture", "execution");
        } else if (kind === "events") {
          await new DatabaseCloudWorkspaceEventService({ pool }).request(scope, { kind: "append", batchId: randomUUID(),
            events: [{ sequence: 1, frame: { id: randomUUID(), source: "engine", timestamp: 0,
              type: "AGENT_SESSION_UPDATE", content: "private stream fixture",
              cloudStream: { streamId: f.engineInstanceId, sequence: 1 } } }] });
        } else {
          await new DatabaseCloudWorkspaceActionService({ pool }).request(scope, { kind: "begin", admissible: true,
            action: { operationId: randomUUID(), conversationId: "delete-fixture", executionId: "execution",
              kind: "permission", requestId: randomUUID(), payload: { response: { outcome: "cancelled" } } } });
        }
      }
      await pool.query(`UPDATE cloud_workspaces SET status='deleted', desired_state='deleted', deleted_at=now() WHERE id=$1`, [fixture.workspaceId]);
      await pool.query(`UPDATE cloud_workspace_provider_bindings SET observed_state='deleted', deletion_verified_at=now() WHERE workspace_id=$1`, [fixture.workspaceId]);
      await new CloudWorkspaceOperationsWorker(pool, blobs().service, { workerId: "operations-runtime-history-test" }).runOnce();
      expect((await pool.query(`SELECT job.state, workspace.data_deleted_at IS NOT NULL AS erased
        FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id
        WHERE workspace.id=$1`, [fixture.workspaceId])).rows[0]).toEqual({ state: "succeeded", erased: true });
      const tables = kind === "commands"
        ? ["cloud_workspace_conversation_controls", "cloud_workspace_commands", "cloud_workspace_command_operations"]
        : kind === "events" ? ["cloud_workspace_event_streams", "cloud_workspace_stream_events"] : ["cloud_workspace_action_receipts"];
      for (const table of tables) {
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0);
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [other.workspaceId])).rows[0].count).toBe(1);
      }
      expect((await pool.query(`SELECT count(*)::int AS count FROM workspace_billing_epochs WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(1);
      expect((await pool.query(`SELECT count(*)::int AS count FROM cloud_workspace_engine_instances WHERE workspace_id=$1`, [fixture.workspaceId])).rows[0].count).toBe(0);
    },
  );

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

  it("keeps tiered recovery points and every protected checkpoint, releasing native chunk references", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const shortPolicy = await seedReadyCloudWorkspace(pool);
    const { service } = blobs();
    const now = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.getTime();
    const minute = 60_000, hour = 60 * minute, day = 24 * hour;
    const hourStart = Math.floor(now / hour) * hour, dayStart = Math.floor(now / day) * day;
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
    type Point = { name: string; at: number; state?: "durable" | "invalid" };

    async function seed(workspaceFixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, points: Point[]) {
      const scope = { workspaceId: workspaceFixture.workspaceId, organizationId: workspaceFixture.organizationId, generation: 1,
        engineInstanceId: workspaceFixture.engineInstanceId, heartbeatToken: workspaceFixture.heartbeatToken };
      const manifest = await service.put({ ...scope, bytes: Buffer.from(`manifest:${workspaceFixture.workspaceId}`) });
      const chunk = await service.put({ ...scope, bytes: Buffer.from(`native chunk:${workspaceFixture.workspaceId}`) });
      await pool.query(
        `INSERT INTO workspace_content_heads (workspace_id, org_id, current_revision, durable_revision)
         VALUES ($1, $2, $3, $3)`, [workspaceFixture.workspaceId, workspaceFixture.organizationId, points.length]);
      await pool.query(
        `INSERT INTO workspace_content_revisions (
           workspace_id, org_id, revision, parent_revision, authority_epoch, generation,
           engine_instance_id, idempotency_key, request_sha256, changed_entry_count
         ) SELECT $1, $2, revision, revision - 1, 1, 1, $3, 'retention-revision-' || revision, $4, 1
           FROM generate_series(1, $5::integer) AS revision`,
        [workspaceFixture.workspaceId, workspaceFixture.organizationId, workspaceFixture.engineInstanceId, randomBytes(32), points.length]);
      const ids = new Map<string, string>();
      for (const [index, point] of points.entries()) {
        const id = randomUUID(), at = new Date(point.at), invalid = point.state === "invalid";
        ids.set(point.name, id);
        await pool.query(
          `INSERT INTO workspace_checkpoints (
             id, workspace_id, org_id, idempotency_key, request_sha256, content_revision,
             record_revision, authority_epoch, generation, reason, manifest_blob_id,
             inclusion_policy, file_count, total_bytes, state, integrity_sha256,
             created_at, durable_at, invalidated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 0, 1, 1, 'periodic', $7, '{}', 0, 0, $8, $5, $9, $10, $11)`,
          [id, workspaceFixture.workspaceId, workspaceFixture.organizationId, `retention-checkpoint-${index}`, randomBytes(32), index + 1,
            manifest.id, invalid ? "invalid" : "durable", at, invalid ? null : at, invalid ? at : null]);
        await pool.query(
          `INSERT INTO workspace_blob_references (blob_id, org_id, workspace_id, reference_kind, reference_id)
           VALUES ($1, $3, $4, 'checkpoint_manifest', $5), ($2, $3, $4, 'checkpoint_artifact', $5 || ':v2')`,
          [manifest.id, chunk.id, workspaceFixture.organizationId, workspaceFixture.workspaceId, id]);
      }
      return { ids, manifest };
    }

    const kept = [
      ...[5, 25, 45].map(minutesAgo => ({ name: `recent-${minutesAgo}`, at: now - minutesAgo * minute })),
      { name: "recent-invalid", at: now - 15 * minute, state: "invalid" as const },
      ...range(2, 22).map(hoursAgo => ({ name: `hour-${hoursAgo}-50`, at: hourStart - hoursAgo * hour + 50 * minute })),
      ...range(2, 12).map(daysAgo => ({ name: `day-${daysAgo}-20`, at: dayStart - daysAgo * day + 20 * hour })),
      { name: "legal-hold", at: dayStart - 20 * day + 2 * hour },
      { name: "retained-until", at: dayStart - 20 * day + 8 * hour },
      { name: "current", at: dayStart - 30 * day + 2 * hour },
      { name: "recovery", at: dayStart - 30 * day + 8 * hour },
      { name: "exported", at: dayStart - 31 * day + 2 * hour },
      { name: "recent-request", at: dayStart - 31 * day + 8 * hour },
      { name: "active-intent-request", at: dayStart - 32 * day + 2 * hour },
    ];
    const deleted = [
      ...range(2, 22).flatMap(hoursAgo => [10, 20].map(minutesAgo => ({ name: `hour-${hoursAgo}-${minutesAgo}`, at: hourStart - hoursAgo * hour + minutesAgo * minute }))),
      { name: "hour-3-invalid", at: hourStart - 3 * hour + 55 * minute, state: "invalid" as const },
      ...range(2, 12).flatMap(daysAgo => [2, 8].map(hourOfDay => ({ name: `day-${daysAgo}-${hourOfDay}`, at: dayStart - daysAgo * day + hourOfDay * hour }))),
      ...[15, 16, 40].flatMap(daysAgo => [2, 8, 20].map(hourOfDay => ({ name: `old-${daysAgo}-${hourOfDay}`, at: dayStart - daysAgo * day + hourOfDay * hour }))),
      { name: "released-request", at: dayStart - 5 * day + 2 * hour },
    ];
    const { ids, manifest } = await seed(fixture, [...kept, ...deleted]);
    const shortKept = [{ name: "recent", at: now - 10 * minute }, { name: "day-5-20", at: dayStart - 5 * day + 20 * hour }];
    const shortDeleted = [{ name: "day-5-2", at: dayStart - 5 * day + 2 * hour },
      ...[2, 20].map(hourOfDay => ({ name: `day-9-${hourOfDay}`, at: dayStart - 9 * day + hourOfDay * hour }))];
    const short = await seed(shortPolicy, [...shortKept, ...shortDeleted]);
    await pool.query(`INSERT INTO workspace_retention_policies (workspace_id, org_id, checkpoint_days) VALUES ($1, $2, 7)`,
      [shortPolicy.workspaceId, shortPolicy.organizationId]);
    await pool.query(`UPDATE workspace_content_heads SET current_checkpoint_id = $2 WHERE workspace_id = $1`,
      [shortPolicy.workspaceId, short.ids.get("recent")]);

    const id = (name: string) => ids.get(name)!;
    await pool.query(`UPDATE workspace_content_heads SET current_checkpoint_id = $2 WHERE workspace_id = $1`,
      [fixture.workspaceId, id("current")]);
    await pool.query(`UPDATE cloud_workspace_generations SET recovery_checkpoint_id = $2 WHERE workspace_id = $1`,
      [fixture.workspaceId, id("recovery")]);
    await pool.query(`UPDATE workspace_checkpoints SET legal_hold = true WHERE id = $1`, [id("legal-hold")]);
    await pool.query(`UPDATE workspace_checkpoints SET retention_until = now() + interval '1 day' WHERE id = $1`,
      [id("retained-until")]);
    await pool.query(
      `INSERT INTO workspace_exports (
         org_id, workspace_id, requested_by, checkpoint_id, record_revision, content_revision,
         idempotency_key, request_sha256, state, export_blob_id, available_at, expires_at, completed_at
       ) VALUES ($1, $2, $3, $4, 0, 1, 'retention-export', $5, 'available', $6,
         now() - interval '1 hour', now() + interval '1 day', now() - interval '1 hour')`,
      [fixture.organizationId, fixture.workspaceId, fixture.userId, id("exported"), randomBytes(32), manifest.id]);
    const intentId = randomUUID();
    await pool.query(
      `INSERT INTO cloud_workspace_lifecycle_intents (
         id, workspace_id, generation, org_id, requested_by, operation, idempotency_key, request_sha256
       ) VALUES ($1, $2, 1, $3, $4, 'stop', 'retention-active-intent', $5)`,
      [intentId, fixture.workspaceId, fixture.organizationId, fixture.userId, randomBytes(32)]);
    const request = async (name: string, completedHoursAgo: number, lifecycleIntentId: string | null = null) => pool.query(
      `INSERT INTO workspace_checkpoint_requests (
         workspace_id, generation, org_id, lifecycle_intent_id, reason, state, idempotency_key,
         checkpoint_id, deadline_at, created_at, completed_at
       ) VALUES ($1, 1, $2, $3, 'manual', 'succeeded', $4, $5,
         now() - ($6::integer * interval '1 hour') + interval '1 minute',
         now() - ($6::integer * interval '1 hour') - interval '1 minute',
         now() - ($6::integer * interval '1 hour'))`,
      [fixture.workspaceId, fixture.organizationId, lifecycleIntentId, `retention-request-${name}`, id(name), completedHoursAgo]);
    await request("recent-request", 2);
    await request("released-request", 72);
    await request("active-intent-request", 72, intentId);

    const worker = new CloudWorkspaceOperationsWorker(pool, service, { workerId: "operations-tiered-retention-test" });
    for (let pass = 0; pass < 4; pass += 1) await worker.applyRetentionOnce();

    const remaining = async (workspaceId: string, names: Map<string, string>) => {
      const rows = await pool.query<{ id: string }>(`SELECT id FROM workspace_checkpoints WHERE workspace_id = $1`, [workspaceId]);
      const byId = new Map([...names].map(([name, value]) => [value, name]));
      return rows.rows.map(row => byId.get(row.id)).sort();
    };
    expect(await remaining(fixture.workspaceId, ids)).toEqual(kept.map(point => point.name).sort());
    expect(await remaining(shortPolicy.workspaceId, short.ids)).toEqual(shortKept.map(point => point.name).sort());
    const references = await pool.query<{ reference_id: string }>(
      `SELECT reference_id FROM workspace_blob_references
       WHERE workspace_id = $1 AND reference_kind IN ('checkpoint_manifest', 'checkpoint_artifact')`,
      [fixture.workspaceId]);
    expect(references.rows.map(row => row.reference_id).sort()).toEqual(
      kept.flatMap(point => [id(point.name), `${id(point.name)}:v2`]).sort());
    expect((await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM workspace_checkpoint_requests WHERE workspace_id = $1 ORDER BY idempotency_key`,
      [fixture.workspaceId])).rows.map(row => row.idempotency_key)).toEqual([
      "retention-request-active-intent-request", "retention-request-recent-request"]);
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
         id, workspace_id, org_id, generation, engine_instance_id, authority_epoch,
         idempotency_key, request_sha256, first_revision, last_revision,
         event_count, created_at
       ) VALUES
         ($3, $1, $2, 1, $5, 1, 'operations-record-old', $6, 1, 1, 1,
          now() - interval '2 days'),
         ($4, $1, $2, 1, $5, 1, 'operations-record-current', $6, 2, 2, 1,
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

    await expect(worker.runOnce()).resolves.toMatchObject({ deletionSteps: 0 });
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
    await worker.runOnce();
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
