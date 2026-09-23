import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
d("provider operation journal", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let store: DatabaseCloudProviderOperationStore;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 5 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    store = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-1",
    );
  });
  const input = () => ({
    workspaceId: fixture.workspaceId,
    generation: 1,
    idempotencyKey: randomUUID(),
    requestSha256: "a".repeat(64),
  });

  it("serializes competing create intents onto one original provider key", async () => {
    const first = input(),
      second = input();
    const records = await Promise.all([
      store.prepareCreate(first),
      store.prepareCreate(second),
    ]);
    expect(records[0]).toEqual(records[1]);
    await store.bindResource(first, "resource-1");
    const restarted = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-1",
    );
    expect(await restarted.find(first)).toMatchObject({
      idempotencyKey: records[0]!.idempotencyKey,
      resourceId: "resource-1",
    });
    await expect(
      restarted.prepareCreate({ ...first, requestSha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
  });

  it("cannot read or mutate a resource through a different provider account", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.bindResource(identity, "resource-1");
    const other = new DatabaseCloudProviderOperationStore(
      pool,
      "daytona",
      "qualified-account-2",
    );
    expect(await other.get("resource-1")).toBeNull();
    await expect(other.find(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    await expect(other.prepareCreate(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    await expect(other.beginDelete("resource-1")).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    const rows = await withUserTx(pool, fixture.userId, (tx) =>
      tx.query("SELECT * FROM cloud_workspace_provider_operations"),
    );
    expect(rows.rows).toEqual([]);
  });

  it("rejects unadmitted providers and allocations after a concurrent delete", async () => {
    const wrong = new DatabaseCloudProviderOperationStore(
      pool,
      "boat",
      "qualified-account-1",
    );
    await expect(wrong.prepareCreate(input())).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
    const identity = input();
    await store.prepareCreate(identity);
    await withSystemTx(pool, (tx) =>
      tx.query(
        "UPDATE cloud_workspaces SET desired_state = 'deleted', status = 'deleting' WHERE id = $1",
        [fixture.workspaceId],
      ),
    );
    await expect(store.prepareCreate(identity)).rejects.toMatchObject({
      code: "provider_operation_conflict",
    });
  });

  it("preserves immutable resource/deletion evidence and hides completed rows from sweeps", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.bindResource(identity, "resource-1");
    await expect(
      store.bindResource(identity, "resource-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(
      store.bindDeletion("resource-1", "operation-1"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await store.beginDelete("resource-1");
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query("DELETE FROM cloud_workspace_provider_operations"),
      ),
    ).rejects.toThrow("must be retained");
    await store.bindDeletion("resource-1", "operation-1");
    await expect(
      store.bindDeletion("resource-1", "operation-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(
      store.completeDeletion("resource-1", "operation-2"),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await store.completeDeletion("resource-1", "operation-1");
    await store.completeDeletion("resource-1", "operation-1");
    expect((await store.get("resource-1"))!.deletedAt).toBeInstanceOf(Date);
    const records = [];
    for await (const record of store.list()) records.push(record);
    expect(records).toEqual([]);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_workspace_provider_operations SET deleted_at = NULL",
        ),
      ),
    ).rejects.toThrow("immutable");
  });

  it("seals a rejected allocation across restart and prevents a delayed dispatch", async () => {
    const identity = input(), attemptId = randomUUID();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, attemptId);
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await store.recordCreateRejection(identity, attemptId, "trial_compute_limit_reached");
    const restarted = new DatabaseCloudProviderOperationStore(pool, "daytona", "qualified-account-1");
    expect(await restarted.closeUnallocatedCreate(identity)).toBe(true);
    expect(await restarted.find(identity)).toMatchObject({ createClosedAt: expect.any(Date), resourceId: null, deletedAt: null });
    await expect(restarted.beginCreateAttempt(identity, randomUUID())).rejects.toMatchObject({ code: "provider_generation_retired" });
    await expect(restarted.bindResource(identity, "late-resource")).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET create_closed_at=NULL"))).rejects.toThrow("immutable");
    await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_provider_operations"));
    expect((await withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_provider_create_attempts"))).rowCount).toBe(0);
  });

  it("retains uncertainty from earlier and concurrent dispatches", async () => {
    const identity = input(), unknown = randomUUID(), rejected = randomUUID();
    await store.prepareCreate(identity);
    await Promise.all([store.beginCreateAttempt(identity, unknown), store.beginCreateAttempt(identity, rejected)]);
    await store.recordCreateRejection(identity, rejected, "limit_reached");
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await store.bindResource(identity, "accepted-resource");
    expect((await store.find(identity))!.resourceId).toBe("accepted-resource");
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_provider_create_attempts"))).rejects.toThrow();
    await expect(withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_provider_operations"))).rejects.toThrow("must be retained");
  });

  it("does not infer no-allocation from legacy journals, even after a new rejection", async () => {
    const identity = input();
    // The migration defaults legacy/old-writer inserts to untracked.
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256)
      VALUES ('daytona','qualified-account-1',$1,1,$2,$3,$4)`,
    [fixture.workspaceId, fixture.organizationId, identity.idempotencyKey, identity.requestSha256]));
    await store.prepareCreate(identity);
    const attempt = randomUUID();
    await store.beginCreateAttempt(identity, attempt);
    await store.recordCreateRejection(identity, attempt, "trial_compute_limit_reached");
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET create_attempts_tracked=true"))).rejects.toThrow("immutable");
  });

  // The database owner (here the test superuser) records attestations; the
  // application role can only read them.
  // By default the attestation covers every dispatch and the journal's own creation.
  const attest = (identity: { workspaceId: string }, covers = `(SELECT greatest(
      (SELECT max(dispatched_at) FROM cloud_workspace_provider_create_attempts),
      (SELECT max(created_at) FROM cloud_workspace_provider_operations)))`) =>
    pool.query(`INSERT INTO cloud_workspace_provider_absence_attestations
      (provider,account_scope,workspace_id,generation,id,attested_by,database_principal,target_fingerprint,reason,
       provider_account,inventory_sha256,inventory_observed_at,inventory_resource_count,covers_dispatches_through)
      SELECT 'daytona','qualified-account-1',$1,1,$2,$3,'postgres','0123456789abcdef','Batch 7 regression attestation fixture',
        'fixture-account',$4,covers+interval '1 second',0,covers FROM (SELECT ${covers} AS covers) evidence`,
    [identity.workspaceId, randomUUID(), fixture.userId, Buffer.alloc(32)]);

  it("closes an attested journal whose uncertified dispatches the attestation covers", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, randomUUID());
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await attest(identity);
    expect(await store.closeUnallocatedCreate(identity)).toBe(true);
    await expect(store.beginCreateAttempt(identity, randomUUID())).rejects.toMatchObject({ code: "provider_generation_retired" });
  });

  it("does not cover a dispatch that follows the attested inventory", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, randomUUID());
    await attest(identity);
    await store.beginCreateAttempt(identity, randomUUID());
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
  });

  it("closes an untracked legacy journal only when attested", async () => {
    const identity = input();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256)
      VALUES ('daytona','qualified-account-1',$1,1,$2,$3,$4)`,
    [fixture.workspaceId, fixture.organizationId, identity.idempotencyKey, identity.requestSha256]));
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET create_closed_at=clock_timestamp()")))
      .rejects.toThrow("absence is not confirmed");
    await attest(identity);
    expect(await store.closeUnallocatedCreate(identity)).toBe(true);
  });

  it("keeps an attested generation open while a create or wake can still dispatch", async () => {
    const identity = input(), intent = randomUUID();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, randomUUID());
    await attest(identity);
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256)
      VALUES ($1,$2,1,$3,'wake',$5,$4)`, [intent, fixture.workspaceId, fixture.organizationId, Buffer.alloc(32), randomUUID()]));
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1", [intent]));
    expect(await store.closeUnallocatedCreate(identity)).toBe(true);
  });

  it("lets the application read attestations but never create or change them", async () => {
    const identity = input();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, randomUUID());
    await expect(withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_absence_attestations
      (provider,account_scope,workspace_id,generation,id,attested_by,database_principal,target_fingerprint,reason,
       provider_account,inventory_sha256,inventory_observed_at,inventory_resource_count,covers_dispatches_through)
      VALUES ('daytona','qualified-account-1',$1,1,$2,$3,'zeros_app','0123456789abcdef','self-issued attestation attempt','fixture-account',$4,now(),0,now()-interval '1 second')`,
    [fixture.workspaceId, randomUUID(), fixture.userId, Buffer.alloc(32)]))).rejects.toThrow(/permission denied/);
    await attest(identity);
    expect((await withSystemTx(pool, tx => tx.query("SELECT 1 FROM cloud_workspace_provider_absence_attestations"))).rowCount).toBe(1);
    await expect(pool.query("UPDATE cloud_workspace_provider_absence_attestations SET reason='rewritten attestation reason'")).rejects.toThrow("append-only");
    await expect(pool.query("DELETE FROM cloud_workspace_provider_absence_attestations")).rejects.toThrow("append-only");
    await expect(pool.query("TRUNCATE cloud_workspace_provider_absence_attestations")).rejects.toThrow("append-only");
    expect(await store.closeUnallocatedCreate(identity)).toBe(true);
    // The organization purge that consumes a closed journal also removes its attestation.
    await withSystemTx(pool, tx => tx.query("DELETE FROM cloud_workspace_provider_operations"));
    expect((await pool.query("SELECT 1 FROM cloud_workspace_provider_absence_attestations")).rowCount).toBe(0);
  });

  it("fences request identity and immutable rejection outcomes", async () => {
    const identity = input(), attempt = randomUUID();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity, attempt);
    await expect(store.beginCreateAttempt(identity, attempt)).rejects.toMatchObject({ code: "provider_operation_conflict" });
    const other = new DatabaseCloudProviderOperationStore(pool, "daytona", "qualified-account-2");
    await expect(other.recordCreateRejection(identity, attempt, "limit_reached")).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await expect(store.recordCreateRejection(identity, randomUUID(), "limit_reached")).rejects.toMatchObject({ code: "provider_operation_conflict" });
    await store.recordCreateRejection(identity, attempt, "limit_reached");
    await store.recordCreateRejection(identity, attempt, "limit_reached");
    await expect(store.recordCreateRejection(identity, attempt, "member_limit_reached")).rejects.toMatchObject({ code: "provider_operation_conflict" });
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_workspace_provider_create_attempts"))).rows).toEqual([]);
  });

  it("does not seal while a create or wake can still dispatch", async () => {
    const identity=input(), attempt=randomUUID(), intent=randomUUID();
    await store.prepareCreate(identity);
    await store.beginCreateAttempt(identity,attempt);
    await store.recordCreateRejection(identity,attempt,"limit_reached");
    await withSystemTx(pool,tx=>tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256)
      VALUES ($1,$2,1,$3,'wake',$5,$4)`,[intent,fixture.workspaceId,fixture.organizationId,Buffer.alloc(32),randomUUID()]));
    expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    await withSystemTx(pool,tx=>tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1",[intent]));
    expect(await store.closeUnallocatedCreate(identity)).toBe(true);
  });

  it("serializes sealing against a newly started dispatch", async () => {
    const identity=input();await store.prepareCreate(identity);
    const [seal,dispatch]=await Promise.allSettled([
      store.closeUnallocatedCreate(identity),store.beginCreateAttempt(identity,randomUUID()),
    ]);
    expect(seal.status).toBe("fulfilled");
    const row=await store.find(identity);
    if(row!.createClosedAt){
      expect(dispatch.status).toBe("rejected");
    }else{
      expect(dispatch.status).toBe("fulfilled");
      expect(seal).toMatchObject({value:false});
      expect(await store.closeUnallocatedCreate(identity)).toBe(false);
    }
  });

  it.each(["legacy","tracked"] as const)("fences mixed-version writers when the %s insert wins", async winner => {
    const identity=input(), legacyHash="b".repeat(64);
    let inserted!:()=>void, release!:()=>void;
    const insertedPromise=new Promise<void>(r=>{inserted=r;});
    const releasePromise=new Promise<void>(r=>{release=r;});
    const insert=async(tx:Tx,tracked:boolean)=>tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked)
      VALUES ('daytona','qualified-account-1',$1,1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [identity.workspaceId,fixture.organizationId,identity.idempotencyKey,tracked?identity.requestSha256:legacyHash,tracked]);
    const first=withSystemTx(pool,async tx=>{await insert(tx,winner==='tracked');inserted();await releasePromise;});
    await insertedPromise;
    const modern=store.prepareCreate({...identity,legacyRequestSha256:legacyHash});
    // This is the old writer's unchanged insert/read/compare boundary. The
    // comparison must fail BEFORE any provider I/O for a new tracked row.
    const old=withSystemTx(pool,async tx=>{
      await insert(tx,false);
      const row=(await tx.query<{request_sha256:string}>("SELECT request_sha256 FROM cloud_workspace_provider_operations WHERE workspace_id=$1",[identity.workspaceId])).rows[0]!;
      if(row.request_sha256!==legacyHash)throw Error("legacy digest conflict");
    });
    release();
    const results=await Promise.allSettled([first,modern,old]);
    expect(results[0].status).toBe("fulfilled");expect(results[1].status).toBe("fulfilled");
    expect(results[2].status).toBe(winner==='tracked'?"rejected":"fulfilled");
    expect((await store.find(identity))!.createAttemptsTracked).toBe(winner==='tracked');
    if(winner==='legacy'){
      const attempt=randomUUID();await store.beginCreateAttempt(identity,attempt);
      await store.recordCreateRejection(identity,attempt,"trial_compute_limit_reached");
      expect(await store.closeUnallocatedCreate(identity)).toBe(false);
      // A response from the old, untracked dispatch may arrive after that.
      expect((await store.bindResource(identity,"late-legacy-resource")).resourceId).toBe("late-legacy-resource");
    }
  });
});
