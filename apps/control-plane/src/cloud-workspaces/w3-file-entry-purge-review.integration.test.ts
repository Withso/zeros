import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { confirmWorkspaceDeletion, seedWorkspaceDeletionGraph } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import {
  seedCanonicalCloudWorkspaceAuthority,
  seedCanonicalWorkspaceSettingsVersion,
  seedSupportedCloudWorkspaceGeneration,
  withCloudFixtureOwnerTx,
} from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type DeletionFixture = Awaited<ReturnType<typeof seedWorkspaceDeletionGraph>>;
type FileScope = Pick<DeletionFixture, "workspaceId" | "organizationId" | "blobId">;

suite("independent file projection purge boundaries", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  // 0037 detached this mutable projection from its revision FK. Seed both
  // live and tombstoned paths; a content-head cascade cannot erase either.
  async function seedEntries(scope: FileScope) {
    await pool.query(`INSERT INTO workspace_file_entries(workspace_id,org_id,normalized_path,revision,
      entry_type,mode,blob_id,content_sha256,size_bytes)
      SELECT $1,$2,'private/file.txt',1,'file',33188,id,plaintext_sha256,plaintext_bytes
      FROM workspace_blobs WHERE id=$3 AND org_id=$2`, [scope.workspaceId, scope.organizationId, scope.blobId]);
    await pool.query(`INSERT INTO workspace_file_entries(workspace_id,org_id,normalized_path,revision,tombstoned_at)
      VALUES($1,$2,'private/deleted.txt',1,clock_timestamp())`, [scope.workspaceId, scope.organizationId]);
    await pool.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
      VALUES($1,$2,$3::uuid,'file_entry',($3::uuid)::text||':private/file.txt')`, [scope.blobId, scope.organizationId, scope.workspaceId]);
    expect(await entries(scope)).toHaveLength(2);
  }

  async function entries(scope: Pick<FileScope, "workspaceId" | "organizationId">) {
    return (await pool.query(`SELECT to_jsonb(entry) AS entry FROM workspace_file_entries entry
      WHERE workspace_id=$1 AND org_id=$2 ORDER BY normalized_path`, [scope.workspaceId, scope.organizationId])).rows;
  }

  async function sibling(fixture: DeletionFixture): Promise<FileScope> {
    const workspaceId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces(id,org_id,team_id,created_by,owner_user_id,assignee_user_id,
        display_name,repository_id,repository_forge,repository_owner,repository_name,repository_revision)
        SELECT $2,org_id,team_id,created_by,owner_user_id,assignee_user_id,'File scope sibling',repository_id,
          repository_forge,repository_owner,repository_name,repository_revision FROM cloud_workspaces WHERE id=$1`,
      [fixture.workspaceId, workspaceId]);
      const input = { workspaceId, organizationId: fixture.organizationId, ownerUserId: fixture.userId };
      await seedCanonicalCloudWorkspaceAuthority(tx, input);
      await seedSupportedCloudWorkspaceGeneration(tx, input);
      await seedCanonicalWorkspaceSettingsVersion(tx, { ...input, generation: 1, createdBy: fixture.userId,
        effectiveDocument: { schemaVersion: 1, values: {} } });
      await tx.query(`INSERT INTO workspace_content_heads(workspace_id,org_id,current_revision,durable_revision)
        VALUES($1,$2,1,1)`, [workspaceId, fixture.organizationId]);
    });
    return { workspaceId, organizationId: fixture.organizationId, blobId: fixture.blobId };
  }

  async function preparePurge() {
    const fixture = await seedWorkspaceDeletionGraph(pool, false);
    await seedEntries(fixture);
    await confirmWorkspaceDeletion(pool, fixture);
    const leaseOwner = "w3-file-purge-review";
    const worker = new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: leaseOwner });
    const id = randomUUID();
    await pool.query(`INSERT INTO workspace_deletion_jobs(id,workspace_id,org_id,requested_by,idempotency_key)
      VALUES($1,$2,$3,$4,'w3-file-purge-review')`, [id, fixture.workspaceId, fixture.organizationId, fixture.userId]);
    for (let step = 0; step < 3; step++) expect(await worker.processDeletionOnce()).toBe(true);
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE id=$1", [id])).rows[0].state)
      .toBe("deleting_records");
    await pool.query(`UPDATE workspace_deletion_jobs SET lease_owner=$2,
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, [id, leaseOwner]);
    return { fixture, worker, job: { id, workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      state: "deleting_records" as const, leaseOwner, attemptCount: 0 } };
  }

  it("erases live and tombstoned target paths while preserving same-org and foreign-org projections", async () => {
    const fixture = await seedWorkspaceDeletionGraph(pool, false);
    const sameOrg = await sibling(fixture);
    const foreign = await seedWorkspaceDeletionGraph(pool, false);
    for (const scope of [fixture, sameOrg, foreign]) await seedEntries(scope);
    const siblingBefore = await entries(sameOrg), foreignBefore = await entries(foreign);
    const billingBefore = (await pool.query("SELECT * FROM workspace_billing_epochs WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    await confirmWorkspaceDeletion(pool, fixture);
    await new CloudWorkspaceOperationsWorker(pool, fixture.objects, { workerId: "w3-file-scope-review" }).runOnce();
    expect((await pool.query(`SELECT job.state,workspace.data_deleted_at IS NOT NULL AS erased
      FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id
      WHERE workspace.id=$1`, [fixture.workspaceId])).rows[0]).toEqual({ state: "succeeded", erased: true });
    expect(await entries(sameOrg)).toEqual(siblingBefore);
    expect(await entries(foreign)).toEqual(foreignBefore);
    expect((await pool.query("SELECT * FROM workspace_billing_epochs WHERE workspace_id=$1", [fixture.workspaceId])).rows)
      .toEqual(billingBefore);
    expect(await entries(fixture), "deleted workspace must retain no file path or blob descriptor").toEqual([]);
  });

  it.each(["expired", "wrong-org", "wrong-workspace", "pending-blob", "unverified-provider"] as const)(
    "keeps exact file projection bytes when purge authority is %s", async kind => {
      const { fixture, worker, job } = await preparePurge();
      const before = await entries(fixture);
      if (kind === "expired") await pool.query(`UPDATE workspace_deletion_jobs
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
      if (kind === "wrong-org") job.organizationId = randomUUID();
      if (kind === "wrong-workspace") job.workspaceId = randomUUID();
      if (kind === "pending-blob") await pool.query("UPDATE workspace_deletion_blob_targets SET completed_at=NULL WHERE job_id=$1", [job.id]);
      if (kind === "unverified-provider") await pool.query(`UPDATE cloud_workspace_provider_bindings
        SET deletion_verified_at=NULL WHERE workspace_id=$1`, [fixture.workspaceId]);
      if (kind === "pending-blob") await expect(worker["purgeDeletionRecords"](job))
        .rejects.toThrow("workspace_deletion_objects_incomplete");
      else if (kind === "unverified-provider") await expect(worker["purgeDeletionRecords"](job))
        .rejects.toThrow("workspace_deletion_purge_not_authorized");
      else await worker["purgeDeletionRecords"](job);
      expect(await entries(fixture)).toEqual(before);
      expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
        .toEqual({ data_deleted_at: null });
    },
  );

  it("restores deleted file rows when the final lease check fails after the purge statement", async () => {
    const { fixture, worker, job } = await preparePurge();
    const before = await entries(fixture);
    // The nontransactional sequence proves that DELETE really ran before
    // rollback; retained rows alone would also pass when DELETE is missing.
    await pool.query(`CREATE SEQUENCE w3_file_purge_observed;
      GRANT USAGE,SELECT ON SEQUENCE w3_file_purge_observed TO zeros_app;
      CREATE FUNCTION observe_w3_file_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM nextval('w3_file_purge_observed'); RETURN OLD; END $$;
      CREATE TRIGGER observe_w3_file_purge AFTER DELETE ON workspace_file_entries
        FOR EACH ROW EXECUTE FUNCTION observe_w3_file_purge();
      CREATE FUNCTION expire_w3_file_purge_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        UPDATE workspace_deletion_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
          WHERE workspace_id=NEW.id AND org_id=NEW.org_id;
        RETURN NEW; END $$;
      CREATE TRIGGER expire_w3_file_purge_lease AFTER UPDATE OF data_deleted_at ON cloud_workspaces
        FOR EACH ROW WHEN (NEW.data_deleted_at IS NOT NULL) EXECUTE FUNCTION expire_w3_file_purge_lease();`);
    await expect(worker["purgeDeletionRecords"](job)).rejects.toThrow("workspace_deletion_lease_lost");
    expect(await entries(fixture)).toEqual(before);
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ data_deleted_at: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_outbox WHERE workspace_id=$1 AND event_type='workspace.data_deleted'", [fixture.workspaceId])).rows[0].n)
      .toBe(0);
    expect((await pool.query("SELECT last_value::int AS n,is_called FROM w3_file_purge_observed")).rows[0],
      "both file rows must actually have been deleted before transaction rollback").toEqual({ n: 2, is_called: true });
  });
});
