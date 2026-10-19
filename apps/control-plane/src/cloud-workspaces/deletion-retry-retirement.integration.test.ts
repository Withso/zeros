import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { manageCloudWorkspaceDeletion, validateCloudWorkspaceDeletionRequest } from "../manage-cloud-workspace-deletion.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudWorkspaceCheckpointRequestWorker } from "./checkpoint-requests.js";
import { createCloudWorkspaceManagementRoutes } from "./management-routes.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { commitFinalSaveFixture } from "./final-save-test-fixtures.js";

// Ordinary request/expiry/retirement services, synthetic
// PostgreSQL and provider receipts only. No live fixture or provider calls.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const RESOURCE = "bx_23456789";
const OPERATION = `bdop_${"a".repeat(32)}`;
const FIRST_KEY = "failed-final-checkpoint-delete";
const RETRY_KEY = "stopped-fresh-delete-retry";

suite("failed final checkpoint followed by a stopped delete retry", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let firstIntentId: string;
  let app: Hono;
  let observe: ReturnType<typeof vi.fn>;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [fixture.workspaceId, RESOURCE]);
    const first = await requestDelete(FIRST_KEY);
    firstIntentId = first.intent.id;
    expect(first.intent.state).toBe("queued");
    const checkpoint = (await pool.query("SELECT id,reason,state FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [firstIntentId])).rows;
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0]).toMatchObject({ reason: "before_delete", state: "queued" });
    await pool.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '6 minutes',deadline_at=now()-interval '1 second' WHERE id=$1", [checkpoint[0].id]);
    expect(await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce()).toBe(1);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0])
      .toEqual({ state: "queued", error_code: null });

    // Retain the historical failed-key/retry controls, with a genuinely saved
    // source before the later observed Stop. Today's expiry itself cannot fail
    // the accepted action or authorize this retirement. Once exact proof is
    // present, seed the old terminal history these compatibility reads cover.
    const savedStop = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,
      operation,idempotency_key,request_sha256) VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`,
    [savedStop,fixture.workspaceId,fixture.organizationId,fixture.userId]);
    await commitFinalSaveFixture(pool, { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken },
    { intentId: savedStop, userId: fixture.userId, reason: "before_stop" });
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [savedStop]);
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='failed',error_code='checkpoint_deadline_exceeded',
      completed_at=now() WHERE id=$1`, [firstIntentId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped',version=version+1 WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='archived' WHERE workspace_id=$1", [fixture.workspaceId]);

    const generation = (await pool.query("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
    observe = vi.fn(async () => ({ workspaceId: fixture.workspaceId, generation: 1, resourceId: RESOURCE,
      deletionOperationId: OPERATION, stage: "waiting_for_uploads", requestedAt: new Date().toISOString(),
      expectedBy: new Date(Date.now() + 6 * 3600_000).toISOString(), observedAt: new Date().toISOString() }));
    const resolve = vi.fn(async () => ({ provider: { name: "boat", observeDeletionRetirement: observe },
      connectionId: generation.provider_connection_id, connectionVersion: 1, credentialSource: "hosted" }));
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceManagementRoutes(pool, {} as CloudWorkspaceBackendConfig,
      { workosEnabled: false, providerResolver: { resolve } }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
  });

  function requestDelete(key: string) {
    return withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId, idempotencyKey: key,
    }));
  }

  function read(key: string) {
    return app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/deletion-retirement`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1, deleteIdempotencyKey: key }),
    });
  }

  async function freshAcceptedDeleteWithSyntheticProviderRetirement() {
    const retry = await requestDelete(RETRY_KEY);
    expect(retry.replayed).toBe(false);
    expect(retry.intent.state).toBe("queued");
    expect(retry.intent.id).not.toBe(firstIntentId);
    expect(retry.workspace).toMatchObject({ status: "deleting", desired_state: "deleted", current_generation: 1 });
    expect((await pool.query("SELECT count(*)::int AS count FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [retry.intent.id])).rows[0].count).toBe(0);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,deletion_requested_at,deletion_operation_id)
      VALUES('boat','retry-retirement-test',$1,1,$2,$3,repeat('a',64),$4,now(),$5)`,
    [fixture.workspaceId, fixture.organizationId, randomUUID(), RESOURCE, OPERATION]);
    return retry;
  }

  it("replays the original failed key without inventing another delete or checkpoint", async () => {
    const result = await requestDelete(FIRST_KEY);
    expect(result.replayed).toBe(true);
    expect(result.intent).toMatchObject({ id: firstIntentId, state: "failed" });
    expect((await pool.query("SELECT count(*)::int AS count FROM workspace_checkpoint_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe(2);
    const response = await read(FIRST_KEY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "cloud_workspace_retirement_unconfirmed" } });
    expect(observe).not.toHaveBeenCalled();
  });

  it("binds an ordinary fresh delete to its own retirement receipt after stopped retry", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0])
      .toEqual({ state: "failed", error_code: "checkpoint_deadline_exceeded" });
    const job = (await pool.query("SELECT idempotency_key,state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    expect.soft(job).toMatchObject({ idempotency_key: `lifecycle.${retry.intent.id}`, state: "waiting_for_provider" });
    const response = await read(RETRY_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleteIntentId: retry.intent.id, deleteIdempotencyKey: RETRY_KEY,
      status: "compute_retired_storage_pending", deletionConfirmed: false });
  });

  it("does not let an immutable historical failure permanently veto a later exact retirement", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    // Isolate the independent historical-failure predicate. This is a test
    // fixture adjustment only, never a proposed database recovery procedure.
    await pool.query("UPDATE workspace_deletion_jobs SET idempotency_key=$2 WHERE workspace_id=$1", [fixture.workspaceId, `lifecycle.${retry.intent.id}`]);
    const response = await read(RETRY_KEY);
    expect(response.status).toBe(200);
    expect(observe).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0])
      .toEqual({ state: "failed", error_code: "checkpoint_deadline_exceeded" });
  });

  it("isolates both refusal predicates with a synthetic positive control", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    // Counterfactual fixture only: proves the other exact identity, authority
    // and provider checks pass. Never rewrite historical live failures.
    await pool.query("UPDATE workspace_deletion_jobs SET idempotency_key=$2 WHERE workspace_id=$1", [fixture.workspaceId, `lifecycle.${retry.intent.id}`]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded' WHERE id=$1", [firstIntentId]);
    const response = await read(RETRY_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleteIntentId: retry.intent.id, deleteIdempotencyKey: RETRY_KEY,
      status: "compute_retired_storage_pending", deletionConfirmed: false });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("does not let an older failed replay reset a successor's failed cleanup job", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    // Isolate replay from the fresh-request linkage regression above.
    await pool.query(`UPDATE workspace_deletion_jobs SET idempotency_key=$2,state='failed',
      error_code='synthetic_cleanup_failed',attempt_count=3,completed_at=now() WHERE workspace_id=$1`,
    [fixture.workspaceId, `lifecycle.${retry.intent.id}`]);
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    const replay = await requestDelete(FIRST_KEY);
    expect(replay.replayed).toBe(true);
    expect(replay.intent).toMatchObject({ id: firstIntentId, state: "failed" });
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0])
      .toEqual(before);
    expect((await read(RETRY_KEY)).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps old-key replay inert after an accepted successor and permits the exact current replay", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    expect((await read(RETRY_KEY)).status).toBe(200);
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    const old = await requestDelete(FIRST_KEY);
    expect(old).toMatchObject({ replayed: true, intent: { id: firstIntentId, state: "failed" } });
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0])
      .toEqual(before);
    expect((await read(FIRST_KEY)).status).toBe(409);
    expect((await requestDelete(RETRY_KEY)).intent.id).toBe(retry.intent.id);
    expect((await read(RETRY_KEY)).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",
      [fixture.workspaceId])).rows[0].count).toBe(2);
  });

  it("retains the existing failed-job retry only for its exact current accepted intent", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    expect((await read(RETRY_KEY)).status).toBe(200);
    await pool.query(`UPDATE workspace_deletion_jobs SET state='failed',error_code='synthetic_cleanup_failed',
      attempt_count=3,completed_at=now() WHERE workspace_id=$1`, [fixture.workspaceId]);
    expect((await requestDelete(RETRY_KEY)).replayed).toBe(true);
    expect((await pool.query("SELECT idempotency_key,state,error_code,attempt_count,completed_at FROM workspace_deletion_jobs WHERE workspace_id=$1",
      [fixture.workspaceId])).rows[0]).toEqual({ idempotency_key: `lifecycle.${retry.intent.id}`,
      state: "waiting_for_provider", error_code: null, attempt_count: 0, completed_at: null });
    expect((await read(RETRY_KEY)).status).toBe(200);
  });

  it("still refuses a failure of the selected current delete before provider I/O", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    expect((await read(RETRY_KEY)).status).toBe(200);
    observe.mockClear();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',error_code='provider_unavailable',completed_at=now() WHERE id=$1",
      [retry.intent.id]);
    expect((await read(RETRY_KEY)).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(["queued", "dispatching", "observing", "succeeded"] as const)(
    "adopts an already accepted pre-deploy successor on its exact %s replay", async (state) => {
      const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
      // The old producer retained the original failed key even after it
      // accepted a successor. Model that persisted shape without rewriting
      // either immutable request or inventing another recovery key.
      await pool.query(`UPDATE workspace_deletion_jobs SET idempotency_key=$2,state='deleting_objects',
        attempt_count=2,lease_owner='synthetic-worker',lease_expires_at=now()+interval '1 minute'
        WHERE workspace_id=$1`, [fixture.workspaceId, `lifecycle.${firstIntentId}`]);
      // Seed the old persisted job before live dispatch custody. A new erasure
      // claim while a provider dispatch is held must still be refused.
      await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state=$2::cloud_workspace_intent_state,
        completed_at=CASE WHEN $2::text='succeeded' THEN now() ELSE NULL END WHERE id=$1`, [retry.intent.id, state]);
      const original = (await pool.query("SELECT * FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0];
      const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
      const replay = await requestDelete(RETRY_KEY);
      expect(replay).toMatchObject({ replayed: true, intent: { id: retry.intent.id, state } });
      expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0])
        .toMatchObject({ ...before, idempotency_key: `lifecycle.${retry.intent.id}`, updated_at: expect.any(Date) });
      expect((await pool.query("SELECT * FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0]).toEqual(original);
      expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",
        [fixture.workspaceId])).rows[0].count).toBe(2);
      expect((await read(RETRY_KEY)).status).toBe(200);
    },
  );

  it("does not adopt an ambiguous pre-deploy binding with another accepted delete", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching' WHERE id=$1", [retry.intent.id]);
    await requestDelete("another-pre-deploy-successor");
    await pool.query("UPDATE workspace_deletion_jobs SET idempotency_key=$2 WHERE workspace_id=$1",
      [fixture.workspaceId, `lifecycle.${firstIntentId}`]);
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    expect((await requestDelete(RETRY_KEY)).replayed).toBe(true);
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0]).toEqual(before);
    expect((await read(RETRY_KEY)).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(["failed", "superseded"] as const)("does not adopt a %s pre-deploy successor", async (state) => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state=$2,completed_at=now() WHERE id=$1", [retry.intent.id, state]);
    await pool.query("UPDATE workspace_deletion_jobs SET idempotency_key=$2 WHERE workspace_id=$1",
      [fixture.workspaceId, `lifecycle.${firstIntentId}`]);
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    expect((await requestDelete(RETRY_KEY)).replayed).toBe(true);
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0]).toEqual(before);
    expect((await read(RETRY_KEY)).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not rewind a failed newer binding to an older successful request", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [firstIntentId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='failed',completed_at=now() WHERE id=$1", [retry.intent.id]);
    const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    expect((await requestDelete(FIRST_KEY)).replayed).toBe(true);
    expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0]).toEqual(before);
  });

  it.each(["waiting_for_provider", "deleting_objects", "succeeded", "failed"] as const)(
    "reconciles the original operator replay after deletion without restarting its %s job", async (state) => {
      const approvalId = randomUUID();
      const slug = (await pool.query("SELECT slug::text FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
      const input = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "alpha", execute: false,
        organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
        workspaceIds: fixture.workspaceId, approvalId, reason: "Retry a stopped synthetic workspace deletion" };
      const plan = await manageCloudWorkspaceDeletion(pool, validateCloudWorkspaceDeletionRequest(input));
      const execution = validateCloudWorkspaceDeletionRequest({ ...input, execute: true, approval: plan.approval! });
      const accepted = await manageCloudWorkspaceDeletion(pool, execution);
      const successor = accepted.workspaces[0]!.intentId!;
      await pool.query(`UPDATE workspace_deletion_jobs SET idempotency_key=$2,state=$3,
        error_code=CASE WHEN $3='failed' THEN 'synthetic_record_failure' ELSE NULL END,
        completed_at=CASE WHEN $3 IN ('succeeded','failed') THEN now() ELSE NULL END,
        attempt_count=3 WHERE workspace_id=$1`, [fixture.workspaceId, `lifecycle.${firstIntentId}`, state]);
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [successor]);
      await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
      const before = (await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
      const original = (await pool.query("SELECT * FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0];
      const counts = (await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE org_id=$1", [fixture.organizationId])).rows[0];
      expect((await manageCloudWorkspaceDeletion(pool, execution)).state).toBe("replayed");
      expect((await pool.query("SELECT * FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0])
        .toMatchObject({ ...before, idempotency_key: `lifecycle.${successor}`, updated_at: expect.any(Date) });
      expect((await pool.query("SELECT * FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0]).toEqual(original);
      expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE org_id=$1", [fixture.organizationId])).rows[0]).toEqual(counts);
      expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='delete'",
        [fixture.workspaceId])).rows[0].count).toBe(2);
    },
  );

  it("rejects an earlier retirement response when a new delete replaces it during provider I/O", async () => {
    const retry = await freshAcceptedDeleteWithSyntheticProviderRetirement();
    let successorId: string | undefined;
    observe.mockImplementationOnce(async () => {
      successorId = (await requestDelete("newer-delete-during-retirement-read")).intent.id;
      return { workspaceId: fixture.workspaceId, generation: 1, resourceId: RESOURCE,
        deletionOperationId: OPERATION, stage: "waiting_for_uploads", requestedAt: new Date().toISOString(),
        expectedBy: new Date(Date.now() + 6 * 3600_000).toISOString(), observedAt: new Date().toISOString() };
    });
    expect((await read(RETRY_KEY)).status).toBe(409);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(successorId).toBeDefined();
    expect(successorId).not.toBe(retry.intent.id);
    expect((await read("newer-delete-during-retirement-read")).status).toBe(200);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [firstIntentId])).rows[0])
      .toEqual({ state: "failed", error_code: "checkpoint_deadline_exceeded" });
  });
});
