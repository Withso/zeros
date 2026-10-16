import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { createCloudWorkspaceManagementRoutes } from "./management-routes.js";
import { CloudWorkspaceDeletionRetirementSchema } from "./deletion-retirement-contract.js";
import { copyGenerationPins } from "./generation-pins.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { CloudProviderError } from "./provider.js";
import { requestCloudWorkspaceDeletion } from "./routes.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const RESOURCE = "bx_23456789";
const OPERATION = `bdop_${"a".repeat(32)}`;
const DELETE_KEY = "fixture-original-delete";

suite("authenticated compute retirement during storage deletion", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let actorId: string;
  let app: Hono;
  let requestedAt: string;
  let intentId: string;
  let observe: ReturnType<typeof vi.fn>;
  let resolve: ReturnType<typeof vi.fn>;
  let providerConnectionId: string;
  let storageMiB: number;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 500 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    actorId = fixture.userId;
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$2 WHERE workspace_id=$1", [fixture.workspaceId, RESOURCE]);
    const accepted = await withSystemTx(pool, tx => requestCloudWorkspaceDeletion(tx, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId, idempotencyKey: DELETE_KEY, discardUncheckpointed: true,
    }));
    intentId = accepted.intent.id;
    requestedAt = (await pool.query("SELECT created_at FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intentId])).rows[0].created_at.toISOString();
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopped' WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,deletion_requested_at,deletion_operation_id)
      VALUES('boat','retirement-test',$1,1,$2,'create-receipt',repeat('a',64),$3,$4,$5)`,
    [fixture.workspaceId, fixture.organizationId, RESOURCE, requestedAt, OPERATION]);
    observe = vi.fn(async () => ({
      workspaceId: fixture.workspaceId, generation: 1, resourceId: RESOURCE,
      deletionOperationId: OPERATION, stage: "waiting_for_uploads", requestedAt,
      expectedBy: new Date(Date.parse(requestedAt) + 6 * 3600_000).toISOString(),
      observedAt: new Date().toISOString(),
    }));
    const generation = (await pool.query("SELECT provider_connection_id,storage_mib FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
    providerConnectionId = generation.provider_connection_id;
    storageMiB = generation.storage_mib;
    resolve = vi.fn(async () => ({ provider: { name: "boat", observeDeletionRetirement: observe },
      connectionId: generation.provider_connection_id, connectionVersion: 1, credentialSource: "hosted" }));
    const providerResolver = { resolve };
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: actorId } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceManagementRoutes(pool, {} as CloudWorkspaceBackendConfig, {
      workosEnabled: false, ...{ providerResolver },
    }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
  });

  function read(body: unknown = { generation: 1, deleteIdempotencyKey: DELETE_KEY }, workspaceId = fixture.workspaceId, signal?: AbortSignal) {
    return app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${workspaceId}/deletion-retirement`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
  }

  async function generation(number: number, resourceId?: string) {
    await withSystemTx(pool, async tx => {
      await copyGenerationPins(tx, { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
        sourceGeneration: 1, targetGeneration: number, actorUserId: fixture.userId, providerConnectionId,
        providerConnectionVersion: 1, qualificationMode: "full" });
      if (resourceId) {
        await tx.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider,provider_resource_id,observed_state)
          VALUES($1,$2,$3,'boat',$4,'stopped')`, [fixture.workspaceId, number, fixture.organizationId, resourceId]);
        await tx.query(`INSERT INTO cloud_workspace_provider_operations
          (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,deletion_requested_at,deletion_operation_id)
          VALUES('boat','retirement-test',$1,$2,$3,$4,repeat('b',64),$5,$6,$7)`,
        [fixture.workspaceId, number, fixture.organizationId, `create-${number}`, resourceId, requestedAt, `bdop_${"b".repeat(32)}`]);
      }
    });
  }

  function providerBarrier() {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = observe.getMockImplementation()!;
    observe.mockImplementationOnce(async (...args: unknown[]) => { entered(); await held; return original(...args); });
    return { reached, release };
  }

  async function physicallyDelete() {
    await pool.query("UPDATE cloud_workspace_provider_operations SET deleted_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleted',deletion_verified_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [intentId]);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
  }

  function deletionWorker() {
    const objects = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"), workosEnabled: false });
    return new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "retirement-proof-fixture", maxAttempts: 1 });
  }

  it("observes an accepted exact delete without releasing storage or claiming physical erasure", async () => {
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT row_to_json(w) FROM cloud_workspaces w WHERE id=$1) AS workspace,
      (SELECT row_to_json(j) FROM workspace_deletion_jobs j WHERE workspace_id=$1) AS job,
      (SELECT row_to_json(b) FROM cloud_workspace_provider_bindings b WHERE workspace_id=$1) AS binding,
      (SELECT row_to_json(o) FROM cloud_workspace_provider_operations o WHERE workspace_id=$1) AS operation,
      (SELECT storage_mib FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1) AS storage`, [fixture.workspaceId])).rows[0];
    const before = await snapshot();
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const document = await response.json();
    expect(CloudWorkspaceDeletionRetirementSchema.safeParse(document).success).toBe(true);
    expect(document).toMatchObject({
      version: 1, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      ownerUserId: fixture.userId, createdBy: fixture.userId, createdAt: new Date(before.workspace.created_at).toISOString(),
      currentGeneration: 1, deleteIntentId: intentId,
      deleteIdempotencyKey: DELETE_KEY, requestedAt, status: "compute_retired_storage_pending",
      deletionConfirmed: false, admissionFenced: true, computeSettled: true, accessRetired: true,
      generations: [{ generation: 1, status: "compute_retired_storage_pending", storageStage: "waiting_for_uploads",
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), requestedAt,
        reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: before.storage } }],
    });
    expect(await snapshot()).toEqual(before);
    expect(resolve).toHaveBeenCalledWith({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1, purpose: "cleanup" });
    expect(observe).toHaveBeenCalledTimes(1);
    await deletionWorker().runOnce();
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("waiting_for_provider");
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].data_deleted_at).toBeNull();
  });

  it("refuses a wrong key, generation, foreign workspace or actor before provider I/O", async () => {
    expect((await read({ generation: 1, deleteIdempotencyKey: "not-the-delete-key" })).status).toBe(409);
    expect((await read({ generation: 2, deleteIdempotencyKey: DELETE_KEY })).status).toBe(409);
    expect((await read(undefined, randomUUID())).status).toBe(404);
    actorId = randomUUID();
    expect((await read()).status).toBe(404);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, "1", null, undefined])("rejects invalid generation %j and forged extra proof fields", async generation => {
    expect((await read({ generation, deleteIdempotencyKey: DELETE_KEY })).status).toBe(422);
    expect((await read({ generation: 1, deleteIdempotencyKey: DELETE_KEY, admissionFenced: true })).status).toBe(422);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown", "failed"])("refuses a %s binding before remote I/O", async state => {
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state=$2 WHERE workspace_id=$1", [fixture.workspaceId, state]);
    const response = await read();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "cloud_workspace_retirement_unconfirmed" } });
    expect(observe).not.toHaveBeenCalled();
  });

  it("uses fresh deletion-only evidence when the durable binding still says deleting", async () => {
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='deleting' WHERE workspace_id=$1", [fixture.workspaceId]);
    expect((await read()).status).toBe(200);
    expect((await pool.query("SELECT observed_state FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].observed_state).toBe("deleting");
  });

  it("keeps an unsettled compute lease and failed cleanup outside the positive contract", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,
      provider,provider_resource_id,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state)
      VALUES($1,$2,$3,1,1,$4,$5,'boat',$6,'retirement-policy',3600,1,1,60,'funding')`,
    [id, fixture.workspaceId, fixture.organizationId, fixture.userId, intentId, RESOURCE]);
    expect((await read()).status).toBe(409);
    await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=now() WHERE id=$1", [id]);
    await pool.query("UPDATE workspace_deletion_jobs SET state='failed',error_code='synthetic_cleanup_failed',completed_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    expect((await read()).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("requires engine and endpoint authority retirement without substituting lease expiry", async () => {
    // Reconstruct an incompletely retired historical binding without bypassing
    // the database's setup-execution fence. An expired lease is not revocation.
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded'
      WHERE id=(SELECT setup_run_id FROM cloud_workspace_engine_instances WHERE id=$1)`, [fixture.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query(`UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL,
      last_heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute' WHERE id=$1`, [fixture.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_endpoint_grants SET revoked_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    expect((await read()).status).toBe(409);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_endpoint_grants SET revoked_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    expect((await read()).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not omit an unbound generation beyond the current one", async () => {
    await generation(2);
    expect((await read()).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("accounts for all generations, including a retired candidate beyond current", async () => {
    await generation(2, "bx_3456789a");
    const original = observe.getMockImplementation()!;
    observe.mockImplementation(async (resourceId: string) => ({ ...await original(),
      ...(resourceId === RESOURCE ? {} : { generation: 2, resourceId, deletionOperationId: `bdop_${"b".repeat(32)}` }) }));
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentGeneration: 1,
      generations: [{ generation: 1 }, { generation: 2 }], reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 2 * storageMiB } });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("accounts for a never-allocated candidate only with closed creation and verified absence", async () => {
    await generation(3);
    await pool.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,generation,org_id,provider,observed_state)
      VALUES($1,3,$2,'boat','deleted')`, [fixture.workspaceId, fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked)
      VALUES('boat','retirement-test',$1,3,$2,'never-dispatched',repeat('c',64),true)`, [fixture.workspaceId, fixture.organizationId]);
    expect((await read()).status).toBe(409);
    await pool.query("UPDATE cloud_workspace_provider_operations SET create_closed_at=now() WHERE workspace_id=$1 AND generation=3", [fixture.workspaceId]);
    expect((await read()).status).toBe(409);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET deletion_verified_at=now() WHERE workspace_id=$1 AND generation=3", [fixture.workspaceId]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentGeneration: 1, deletionConfirmed: false,
      generations: [{ generation: 1, status: "compute_retired_storage_pending" },
        { generation: 3, status: "physically_deleted", storageStage: "completed", reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } }],
      reserved: { storageMiB } });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider connection mismatch before reading a foreign account", async () => {
    const original = resolve.getMockImplementation()!;
    resolve.mockImplementationOnce(async () => ({ ...await original(), connectionId: randomUUID() }));
    expect((await read()).status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it("rechecks the exact generation after a held provider response", async () => {
    const barrier = providerBarrier();
    const reading = read();
    await barrier.reached;
    try {
      await generation(2, "bx_3456789a");
      await pool.query("UPDATE cloud_workspaces SET current_generation=2,version=version+1 WHERE id=$1", [fixture.workspaceId]);
    } finally { barrier.release(); }
    expect((await reading).status).toBe(409);
  });

  it("releases every DB connection over provider waits and refuses a late renamed snapshot", async () => {
    const barrier = providerBarrier();
    const reading = read();
    await barrier.reached;
    try {
      const first = await pool.connect();
      try {
        const second = await pool.connect();
        try { await second.query("UPDATE cloud_workspaces SET display_name='renamed-after-observation',version=version+1 WHERE id=$1", [fixture.workspaceId]); }
        finally { second.release(); }
      } finally { first.release(); }
    } finally { barrier.release(); }
    expect((await reading).status).toBe(409);
  });

  it("rechecks the actor after a held provider response", async () => {
    const barrier = providerBarrier();
    const reading = read();
    await barrier.reached;
    try { await pool.query("UPDATE users SET auth_status='suspended',auth_revision=auth_revision+1 WHERE id=$1", [fixture.userId]); }
    finally { barrier.release(); }
    expect((await reading).status).toBe(404);
  });

  it("refuses a physical-completion race instead of publishing the earlier pending observation", async () => {
    const barrier = providerBarrier();
    const reading = read();
    await barrier.reached;
    try { await physicallyDelete(); }
    finally { barrier.release(); }
    expect((await reading).status).toBe(409);
  });

  it("does not publish a positive observation after the caller cancels a held provider read", async () => {
    const controller = new AbortController(), barrier = providerBarrier();
    const reading = read(undefined, fixture.workspaceId, controller.signal);
    await barrier.reached;
    controller.abort(); barrier.release();
    expect((await reading).status).toBe(409);
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("waiting_for_provider");
  });

  it("returns a closed refusal for remote errors and mismatched or stale evidence", async () => {
    observe.mockRejectedValueOnce(new CloudProviderError("provider_request_failed", "raw provider body is private", true));
    const unavailable = await read();
    expect(unavailable.status).toBe(409);
    expect(JSON.stringify(await unavailable.json())).not.toContain("raw provider");
    const original = observe.getMockImplementation()!;
    for (const altered of [{ workspaceId: randomUUID() }, { generation: 2 }, { resourceId: "bx_3456789a" },
      { deletionOperationId: `bdop_${"b".repeat(32)}` }, { observedAt: "2020-01-01T00:00:00.000Z" }]) {
      observe.mockImplementationOnce(async () => ({ ...await original(), ...altered }));
      expect((await read()).status).toBe(409);
    }
  });

  it("requires physical and D1 completion, then repeats original identity after actual content purge", async () => {
    const pending = await (await read()).json();
    await physicallyDelete();
    expect((await read()).status).toBe(409);
    await deletionWorker().runOnce();
    const job = (await pool.query("SELECT state,error_code FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    expect(job).toEqual({ state: "succeeded", error_code: null });
    expect((await pool.query("SELECT 1 FROM cloud_workspace_engine_instances WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
    observe.mockClear();
    const response = await read();
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document).toMatchObject({ createdBy: pending.createdBy, createdAt: pending.createdAt, name: pending.name,
      status: "physically_deleted", deletionConfirmed: true, deleteIntentId: intentId, requestedAt,
      generations: [{ generation: 1, status: "physically_deleted", storageStage: "completed", expectedBy: null,
        receiptSha256: pending.generations[0].receiptSha256, reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } }],
      reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } });
    expect(CloudWorkspaceDeletionRetirementSchema.safeParse(document).success).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect((await read(undefined, randomUUID())).status).toBe(404);
  });
});
