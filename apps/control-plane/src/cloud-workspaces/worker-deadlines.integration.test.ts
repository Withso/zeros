import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { readCloudWorkerNextDelay } from "./worker-deadlines.js";
import { readLifecycleDeadlines } from "./lifecycle-deadlines.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
d("worker deadline projections", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  function within(delay: number | null | undefined, milliseconds: number) {
    expect(delay).toBeGreaterThan(milliseconds - 1_000);
    expect(delay).toBeLessThanOrEqual(milliseconds);
  }

  it("tracks access issuance, expiry and revocation leases without arming terminal grants", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    expect(await readCloudWorkerNextDelay(pool, "access")).toBeNull();
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_client_access_grants
      (id,workspace_id,generation,org_id,account_user_id,kind,provider_resource_id,idempotency_key,request_sha256,requested_expires_at)
      VALUES($1::uuid,$2,1,$3,$4,'ssh','fixture-resource',$1::text,$5,now()+interval '10 minutes')`,
    [id, f.workspaceId, f.organizationId, f.userId, randomBytes(32)]);
    within(await readCloudWorkerNextDelay(pool, "access"), 120_000);
    await pool.query(`UPDATE cloud_workspace_client_access_grants SET state='active',token_hash=$2,
      issued_at=now(),expires_at=now()+interval '30 seconds' WHERE id=$1`, [id, randomBytes(32)]);
    within(await readCloudWorkerNextDelay(pool, "access"), 30_000);
    await pool.query(`UPDATE cloud_workspace_client_access_grants SET state='revocation_pending',next_revocation_at=now(),
      revocation_lease_owner='another-worker',revocation_lease_expires_at=now()+interval '45 seconds' WHERE id=$1`, [id]);
    within(await readCloudWorkerNextDelay(pool, "access"), 45_000);
    await pool.query("UPDATE cloud_workspace_client_access_grants SET revocation_lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await readCloudWorkerNextDelay(pool, "access")).toBeLessThanOrEqual(0);
    await pool.query("UPDATE cloud_workspace_client_access_grants SET state='revoked',revoked_at=now() WHERE id=$1", [id]);
    expect(await readCloudWorkerNextDelay(pool, "access")).toBeNull();
  });

  it("wakes invitation expiry and window closure before a later delivery retry, respecting a sender's lease", async () => {
    const f = await seedReadyCloudWorkspace(pool), id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_invitations
      (id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,inviter_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,'viewer',$6,$7,now()+interval '2 hours')`,
    [id, f.workspaceId, f.organizationId, randomBytes(32), randomBytes(32), f.userId, "a".repeat(64)]);
    await pool.query(`INSERT INTO cloud_workspace_invitation_deliveries
      (invitation_id,key_version,nonce,ciphertext,auth_tag,next_attempt_at,first_attempt_at)
      VALUES($1,1,$2,$3,$4,now()+interval '10 minutes',now()-interval '22 hours 59 minutes')`,
    [id, randomBytes(12), randomBytes(10), randomBytes(16)]);
    within(await readCloudWorkerNextDelay(pool, "invitations"), 60_000);
    await pool.query("UPDATE cloud_workspace_invitations SET expires_at=now()+interval '20 seconds' WHERE id=$1", [id]);
    within(await readCloudWorkerNextDelay(pool, "invitations"), 20_000);
    await pool.query("UPDATE cloud_workspace_invitations SET revoked_at=now() WHERE id=$1", [id]);
    expect(await readCloudWorkerNextDelay(pool, "invitations")).toBeLessThanOrEqual(0);
    await pool.query(`UPDATE cloud_workspace_invitation_deliveries SET state='sending',lease_id=$2,
      lease_expires_at=now()+interval '45 seconds' WHERE invitation_id=$1`, [id, randomUUID()]);
    within(await readCloudWorkerNextDelay(pool, "invitations"), 45_000);
  });

  it("tracks a fork deadline while its checkpoint is pending, then wakes a failed checkpoint immediately", async () => {
    const f = await seedReadyCloudWorkspace(pool), forkId = randomUUID(), requestId = randomUUID();
    await pool.query(`INSERT INTO workspace_fork_intents
      (id,org_id,requested_by,operation,source_cloud_workspace_id,target_local_workspace_id,source_revision,idempotency_key,request_sha256,deadline_at)
      VALUES($1::uuid,$2,$3,'cloud_to_local',$4,$5,0,$1::text,$6,now()+interval '10 minutes')`,
    [forkId, f.organizationId, f.userId, f.workspaceId, randomUUID(), randomBytes(32)]);
    await pool.query(`INSERT INTO workspace_checkpoint_requests
      (id,workspace_id,generation,org_id,requested_by,reason,idempotency_key,fork_intent_id,deadline_at)
      VALUES($1::uuid,$2,1,$3,$4,'before_fork',$1::text,$5,now()+interval '30 seconds')`,
    [requestId, f.workspaceId, f.organizationId, f.userId, forkId]);
    within(await readCloudWorkerNextDelay(pool, "forks"), 600_000);
    within(await readCloudWorkerNextDelay(pool, "checkpoints"), 30_000);
    await pool.query("UPDATE workspace_checkpoint_requests SET state='failed',completed_at=now() WHERE id=$1", [requestId]);
    expect(await readCloudWorkerNextDelay(pool, "forks")).toBeLessThanOrEqual(0);
    expect(await readCloudWorkerNextDelay(pool, "checkpoints")).toBeNull();
  });

  it("keeps engine expiry independent of the quiet fallback and discovers renewal and revocation on re-read", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '10 seconds' WHERE id=$1", [f.engineInstanceId]);
    within((await readLifecycleDeadlines(pool, null, 60_000)).engineHealth, 10_000);
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1", [f.engineInstanceId]);
    within((await readLifecycleDeadlines(pool, null, 60_000)).engineHealth, 90_000);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [f.engineInstanceId]);
    expect((await readLifecycleDeadlines(pool, null, 60_000)).engineHealth).toBeLessThanOrEqual(0);
    await pool.query("UPDATE cloud_workspaces SET desired_state='stopped',status='stopped' WHERE id=$1", [f.workspaceId]);
    expect((await readLifecycleDeadlines(pool, null, 60_000)).engineHealth).toBeUndefined();
  });

  it("does not run deletion claims before provider proof or while a legal hold remains", async () => {
    const f = await seedReadyCloudWorkspace(pool);
    await pool.query(`INSERT INTO workspace_retention_policies(workspace_id,org_id,last_applied_at)
      VALUES($1,$2,now())`, [f.workspaceId, f.organizationId]);
    await pool.query("UPDATE cloud_workspaces SET desired_state='deleted',status='deleted',deleted_at=now() WHERE id=$1", [f.workspaceId]);
    await pool.query(`INSERT INTO workspace_deletion_jobs(workspace_id,org_id,requested_by,idempotency_key)
      VALUES($1,$2,$3,'deadline-fixture')`, [f.workspaceId, f.organizationId, f.userId]);
    within(await readCloudWorkerNextDelay(pool, "operations"), 60_000);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now() WHERE workspace_id=$1", [f.workspaceId]);
    expect(await readCloudWorkerNextDelay(pool, "operations")).toBeLessThanOrEqual(0);
    await pool.query("UPDATE workspace_retention_policies SET legal_hold=true WHERE workspace_id=$1", [f.workspaceId]);
    within(await readCloudWorkerNextDelay(pool, "operations"), 60_000);
  });
});
