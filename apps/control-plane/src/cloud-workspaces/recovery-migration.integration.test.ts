import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const migrations = new URL("../../migrations/", import.meta.url);

suite("recovery migration with populated FORCE RLS tables", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const client = await pool.connect();
    try {
      for (const name of (await fs.readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && name < "0113").sort()) {
        await client.query("BEGIN");
        await client.query(await fs.readFile(new URL(name, migrations), "utf8"));
        await client.query("COMMIT");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
  });

  async function finalCheckpoint(): Promise<string> {
    const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [fixture.engineInstanceId]);
    const objects = new Map<string, Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url"),
      objectStore: { async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key, value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; } } });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from("{}") });
    const file = await blobs.put({ ...scope, bytes: Buffer.from("durable") });
    const appended = await content.append({ ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "file.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 7 }] });
    const directive = (await new DatabaseCloudIdleStop(pool, false).request(scope, randomUUID()))!;
    // Pin this writer to the pre-0113 schema under test. Today's commit reader
    // includes 0171's exact-body receipt and cannot run against that cutoff.
    // Keep actual uploaded blobs/content, and seed the historical snapshot and
    // its references rather than adding future columns to the fixture.
    const checkpointId = randomUUID();
    await pool.query(`INSERT INTO workspace_checkpoints(id,workspace_id,org_id,idempotency_key,request_sha256,
      content_revision,record_revision,authority_epoch,generation,reason,manifest_blob_id,artifact_blob_id,
      inclusion_policy,file_count,total_bytes,state,integrity_sha256,created_by,durable_at)
      VALUES($1,$2,$3,$4,digest($4,'sha256'),$5,0,1,1,'before_stop',$6,NULL,'{}',1,7,'durable',$7,$8,now())`,
    [checkpointId,fixture.workspaceId,fixture.organizationId,directive.id,appended.revision,manifest.id,
      Buffer.from(manifest.plaintextSha256,"hex"),fixture.userId]);
    await pool.query(`INSERT INTO workspace_checkpoint_entries(checkpoint_id,workspace_id,org_id,normalized_path,
      operation,entry_type,mode,blob_id,content_sha256,size_bytes)
      SELECT $1,workspace_id,org_id,normalized_path,'upsert',entry_type,mode,blob_id,content_sha256,size_bytes
      FROM workspace_file_entries WHERE workspace_id=$2 AND org_id=$3`, [checkpointId,fixture.workspaceId,fixture.organizationId]);
    await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
      VALUES($1,$3,$4,'checkpoint_manifest',$5),($2,$3,$4,'checkpoint_file',$5)`,
    [manifest.id,file.id,fixture.organizationId,fixture.workspaceId,checkpointId]);
    await pool.query(`UPDATE workspace_blobs SET reference_count=reference_count+1 WHERE id=ANY($1::uuid[])`, [[manifest.id,file.id]]);
    await pool.query(`UPDATE workspace_content_heads SET current_checkpoint_id=$2,durable_revision=$3
      WHERE workspace_id=$1`, [fixture.workspaceId,checkpointId,appended.revision]);
    const completed = await pool.query<{ lifecycle_intent_id: string }>(`UPDATE workspace_checkpoint_requests
      SET state='succeeded', checkpoint_id=$2, completed_at=clock_timestamp(), error_code=NULL
      WHERE id=$1 AND workspace_id=$3 AND org_id=$4 AND generation=1 AND reason='before_stop'
        AND state IN ('queued','delivered') AND deadline_at>now()
      RETURNING lifecycle_intent_id`, [directive.id, checkpointId, fixture.workspaceId, fixture.organizationId]);
    expect(completed.rowCount).toBe(1);
    return completed.rows[0]!.lifecycle_intent_id;
  }

  async function migrateAsNonBypassOwner(systemContext = false): Promise<void> {
    const client = await pool.connect();
    const owner = (await client.query<{ name: string }>("SELECT current_user AS name")).rows[0]!.name;
    try {
      await client.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='w2_recovery_migration_owner') THEN
        CREATE ROLE w2_recovery_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
      await client.query("GRANT zeros_app TO w2_recovery_migration_owner WITH ADMIN OPTION");
      await client.query("GRANT USAGE,CREATE ON SCHEMA public TO w2_recovery_migration_owner");
      await client.query(`DO $$ DECLARE relation record; BEGIN
        FOR relation IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO w2_recovery_migration_owner',relation.tablename);
        END LOOP; END $$`);
      await client.query("ALTER FUNCTION cloud_workspace_engine_authority_current(uuid,uuid,integer,uuid,boolean,boolean) OWNER TO w2_recovery_migration_owner");
      await client.query("ALTER FUNCTION cloud_workspace_runtime_authority_live(uuid,integer,uuid,boolean) OWNER TO w2_recovery_migration_owner");
      await client.query("SET ROLE w2_recovery_migration_owner");
      expect((await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false });
      // Prove that table ownership does not expose the existing rows.
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_workspace_engine_instances")).rows[0].n).toBe(0);
      await client.query("BEGIN");
      if (systemContext) await client.query("SELECT set_config('app.system','on',true)");
      await client.query(await fs.readFile(new URL("0113_cloud_workspace_recovery.sql", migrations), "utf8"));
      await client.query("COMMIT");
      expect((await client.query("SELECT app_is_system() AS system")).rows[0].system).toBe(false);
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_workspace_engine_instances")).rows[0].n).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      await client.query("RESET ROLE");
      await client.query(`REASSIGN OWNED BY w2_recovery_migration_owner TO "${owner.replaceAll('"', '""')}"`);
      client.release();
    }
  }

  it("seeds the committed legacy checkpoint without requiring the later native-writer schema", async () => {
    expect((await pool.query("SELECT to_regclass('public.cloud_workspace_local_command_writers') AS native_writers")).rows[0])
      .toEqual({ native_writers: null });
    const drainId = await finalCheckpoint();
    expect((await pool.query(`SELECT request.state, request.completed_at, checkpoint.state AS checkpoint_state,
      checkpoint.reason, checkpoint.file_count,
      (SELECT count(*)::int FROM workspace_checkpoint_entries entry WHERE entry.checkpoint_id=checkpoint.id) AS entry_count
      FROM workspace_checkpoint_requests request JOIN workspace_checkpoints checkpoint ON checkpoint.id=request.checkpoint_id
      WHERE request.lifecycle_intent_id=$1`, [drainId])).rows)
      .toEqual([{ state: "succeeded", completed_at: expect.any(Date), checkpoint_state: "durable",
        reason: "before_stop", file_count: 1, entry_count: 1 }]);
    expect((await pool.query(`SELECT to_regclass('public.cloud_workspace_local_command_writers') AS native_writers,
      to_jsonb(engine) ? 'final_checkpoint_at' AS has_final_fence
      FROM cloud_workspace_engine_instances engine WHERE id=$1`, [fixture.engineInstanceId])).rows[0])
      .toEqual({ native_writers: null, has_final_fence: false });
  });

  it.each([false, true])("repairs final fences and old recovery rollbacks (caller supplies system context: %s)", async systemContext => {
    const drainId = await finalCheckpoint();
    await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,
      cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id)
      SELECT workspace_id,2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_generation_transitions(id,workspace_id,org_id,requested_by,operation,
      source_generation,template_generation,candidate_generation,state,drain_intent_id)
      VALUES(gen_random_uuid(),$1,$2,$3,'recover',1,1,2,'rolling_back',$4)`,
    [fixture.workspaceId, fixture.organizationId, fixture.userId, drainId]);

    await migrateAsNonBypassOwner(systemContext);

    const engine = (await pool.query("SELECT final_checkpoint_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0];
    expect.soft(engine.final_checkpoint_at).toBeInstanceOf(Date);
    expect.soft((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state)
      .toBe("rollback_failed");
    expect((await pool.query(`SELECT operation,affects_workspace,state FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND idempotency_key LIKE 'system:recovery-fence:%' ORDER BY operation::text`, [fixture.workspaceId])).rows)
      .toEqual([{ operation: "delete", affects_workspace: false, state: "queued" }, { operation: "stop", affects_workspace: false, state: "queued" }]);
  });

  it("repairs an already failed drain and its stranded wake as a non-bypass owner", async () => {
    const drainId = await finalCheckpoint();
    const wakeId = randomUUID();
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='failed',affects_workspace=false,completed_at=now(),
      error_code='provider_resource_failed' WHERE id=$1`, [drainId]);
    // Pre-0113 rows do not have the prerequisite column. The committed proof
    // still makes this wake subject to the database dispatch fence.
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1,$2,1,$3,$4,'wake',$5,$6)`, [wakeId, fixture.workspaceId, fixture.organizationId, fixture.userId, randomUUID(), Buffer.alloc(32)]);
    await pool.query("UPDATE cloud_workspaces SET status='waking' WHERE id=$1", [fixture.workspaceId]);

    await migrateAsNonBypassOwner();

    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [wakeId])).rows[0])
      .toEqual({ state: "failed", error_code: "workspace_drain_failed" });
    expect((await pool.query("SELECT status,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: "failed", last_error_code: "workspace_drain_failed" });
  });
});
