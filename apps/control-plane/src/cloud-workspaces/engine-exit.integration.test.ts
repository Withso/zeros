import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { DatabaseUplinkLeaseStore } from "../realtime/uplink-lease.js";
import { createCloudWorkspaceInternalRoutes } from "./internal-routes.js";
import { DatabaseCloudWorkspaceSetupMaterialService } from "./setup-materials.js";
import { seedReadyCloudWorkspace, seedSupportedCloudWorkspaceGeneration, withCloudFixtureOwnerTx, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { runtimeWitness } from "./runtime-test-fixtures.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { runDueLifecycleJobs } from "./lifecycle-job-test-utils.js";
import { stopUnavailableCloudEngine } from "./engine-health.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const origin = "https://control.example.test";
const endpoint = "/internal/v1/cloud-workspaces/engine/exited";
const bridgeToken = `zwb_${"B".repeat(43)}`;
suite("supervisor engine exit withdrawal", () => {
  let pool: pg.Pool;
  let f: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudWorkspaceSetupMaterialService;
  let report: Record<string, unknown>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    f = await seedReadyCloudWorkspace(pool);
    await pool.query(`INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state)
      VALUES($1::uuid,$2,$1::text,'active')`, [f.organizationId, `org_${f.organizationId}`]);
    const engine = (await pool.query(`UPDATE cloud_workspace_engine_instances
      SET bridge_token_hash=$2,lease_expires_at=clock_timestamp()+interval '36 minutes' WHERE id=$1
      RETURNING setup_run_id,setup_execution_fence,runtime_id,runtime_boot_id,runtime_supervisor_session_id`,
    [f.engineInstanceId, createHash("sha256").update(bridgeToken).digest()])).rows[0];
    report = { version: 1, audience: "zeros-cloud-engine-exit-v1", reportId: randomUUID(), reason: "unexpected_exit",
      organizationId: f.organizationId, workspaceId: f.workspaceId, generation: 1, engineInstanceId: f.engineInstanceId,
      setupRunId: engine.setup_run_id, executionFence: Number(engine.setup_execution_fence), runtimeId: engine.runtime_id,
      bootId: engine.runtime_boot_id, supervisorSessionId: engine.runtime_supervisor_session_id };
    service = new DatabaseCloudWorkspaceSetupMaterialService({ pool,
      setupAudience: `${origin}/internal/v1/cloud-workspaces/setup/admission`,
      engineRegistrationAudience: `${origin}/internal/v1/cloud-workspaces/engine/register`,
      engineHeartbeatAudience: `${origin}/internal/v1/cloud-workspaces/engine/heartbeat`,
      engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, enginePort: 39_393,
      setupSecretKeyV1: Buffer.alloc(32, 1).toString("base64url"),
      github: { mint: async () => { throw new Error("unused fixture credential"); }, revoke: async () => {} },
      accountIdentityProvider: "workos", accountAuth: { jwksUrl: "https://identity.example.test/jwks",
        audience: "https://api.example.test", issuers: ["https://identity.example.test/"], contract: "zeros-access-v1", clientId: "client_fixture" },
    });
  });
  const send = async (body = report, token = bridgeToken) => createCloudWorkspaceInternalRoutes(service).request(`${origin}${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const workspace = async () => (await pool.query("SELECT status,desired_state,authority_epoch,last_error_code FROM cloud_workspaces WHERE id=$1", [f.workspaceId])).rows[0];
  const engine = async () => (await pool.query("SELECT state,revoked_at,lease_expires_at FROM cloud_workspace_engine_instances WHERE id=$1", [f.engineInstanceId])).rows[0];
  async function pending(operation: "stop" | "archive" | "delete", reason = `before_${operation}`) {
    return withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      const id = randomUUID();
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,affects_workspace)
        VALUES($1::uuid,$2,1,$3,$4,$5,$1::text,$6,true)`, [id, f.workspaceId, f.organizationId, f.userId, operation, Buffer.alloc(32)]);
      const checkpoint = await enqueueWorkspaceCheckpointRequest(tx, { workspaceId: f.workspaceId, organizationId: f.organizationId,
        generation: 1, requestedBy: f.userId, lifecycleIntentId: id, reason: reason as "before_stop", idempotencyKey: `exit-test.${id}` });
      return { id, requestId: checkpoint.id };
    });
  }
  async function tick() {
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='engine-exit-fixture',last_observed_at=NULL WHERE workspace_id=$1", [f.workspaceId]);
    let state: CloudProviderResource["state"] = "running";
    const resource = (): CloudProviderResource => ({ workspaceId: f.workspaceId, generation: 1,
      resourceId: "engine-exit-fixture", state, target: null, metadata: {} });
    const provider = { name: "boat", inspect: vi.fn(async () => resource()), find: vi.fn(async () => [resource()]),
      stop: vi.fn(async () => { state = "stopped"; return resource(); }), create: vi.fn(), start: vi.fn(), archive: vi.fn(), delete: vi.fn() };
    const reconciler = new CloudWorkspaceReconciler({ pool, provider: provider as unknown as CloudWorkspaceProvider, intervalMs: 1000 });
    expect(await runDueLifecycleJobs(pool, reconciler, ["lifecycle"])).toBeGreaterThan(0);
    return provider;
  }
  async function lockWorkspace() {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { release: async () => { await client.query("COMMIT"); client.release(); },
      waiting: async (count: number) => {
        const deadline = performance.now() + 3_000;
        while (performance.now() < deadline) {
          // A second caller can queue behind the first caller's organization
          // lock. Count that dependency too, while holding only the workspace
          // lock so the observed first contender really is first to mutate it.
          const blocked = await pool.query(`WITH RECURSIVE blocked(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
            UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))
              WHERE activity.datname=current_database()) SELECT count(*)::int AS n FROM blocked`, [pid]);
          if (blocked.rows[0].n >= count) return;
        }
        throw new Error("Fixture did not reach the held workspace lock");
      } };
  }
  async function orderedRace(first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const lock = await lockWorkspace();
    const settle = (flight: Promise<unknown>) => flight.then(value => ({ value }), (error: unknown) => ({ error }));
    const flights = [settle(first())];
    try {
      await lock.waiting(1);
      flights.push(settle(second()));
      await lock.waiting(2);
    } finally {
      await lock.release();
      // Always drain operations, including a failed fixture assertion, before
      // the next test resets the database.
      await Promise.all(flights);
    }
    return Promise.all(flights);
  }
  async function checkpointCommit(requestId: string) {
    const scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken };
    const objects = new Map<string, Buffer>();
    const blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url"),
      objectStore: { async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key, value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; } } });
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from("{}") });
    const file = await blobs.put({ ...scope, bytes: Buffer.from("preserved") });
    const content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const appended = await content.append({ ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "work.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 9 }] });
    return () => content.commitCheckpoint({ ...scope, requestId, idempotencyKey: randomUUID(), contentRevision: appended.revision,
      reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: 9, integritySha256: manifest.plaintextSha256 });
  }
  it("retires a reported dead engine and admits Stop while its 36-minute lease is live", async () => {
    const providerBefore = (await pool.query("SELECT * FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [f.workspaceId])).rows;
    const billingBefore = (await pool.query("SELECT * FROM workspace_billing_epochs WHERE workspace_id=$1", [f.workspaceId])).rows;
    expect(await stopUnavailableCloudEngine(pool, null)).toBe(false);
    expect((await send()).status).toBe(200);
    expect(await workspace()).toMatchObject({ status: "stopping", desired_state: "stopped", last_error_code: "engine_exited" });
    expect(await engine()).toMatchObject({ state: "revoked", revoked_at: expect.any(Date) });
    expect((await engine()).lease_expires_at.getTime()).toBeGreaterThan(Date.now() + 35 * 60_000);
    expect((await pool.query("SELECT * FROM cloud_workspace_provider_bindings WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual(providerBefore);
    expect((await pool.query("SELECT * FROM workspace_billing_epochs WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual(billingBefore);
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_deletion_jobs WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
    const provider = await tick();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(await workspace()).toMatchObject({ status: "stopped", desired_state: "stopped" });
  });
  it("a lost exit ACK creates one stop and one authority transition", async () => {
    const before = await workspace();
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(Number((await workspace()).authority_epoch)).toBe(Number(before.authority_epoch) + 1);
    expect((await pool.query("SELECT operation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ operation: "stop" }]);
    const incidents = (await pool.query("SELECT terminal_cause FROM cloud_workspace_diagnostic_incidents WHERE workspace_id=$1", [f.workspaceId])).rows;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].terminal_cause.code).toBe("engine_exited");
  });
  it.each(["organizationId", "workspaceId", "engineInstanceId", "setupRunId", "executionFence", "generation", "runtimeId", "bootId", "supervisorSessionId"])(
    "a foreign %s cannot retire the current runtime", async key => {
      const value = typeof report[key] === "number" ? Number(report[key]) + 1 : key === "runtimeId" ? `r1-${"f".repeat(64)}` : randomUUID();
      expect((await send({ ...report, [key]: value })).status).toBe(403);
      expect(await workspace()).toMatchObject({ status: "ready", desired_state: "running" });
      expect((await engine()).state).toBe("ready");
    });
  it("refuses a foreign token and unrecognized report fields", async () => {
    expect((await send(report, `zwb_${"X".repeat(43)}`)).status).toBe(403);
    expect((await send({ ...report, stopped: true })).status).toBe(422);
    expect((await engine()).state).toBe("ready");
  });
  it.each(["stop", "archive"] as const)("closes a waiting %s as unsealed without inventing a checkpoint", async operation => {
    const intent = await pending(operation);
    expect((await send()).status).toBe(200);
    expect((await pool.query("SELECT id,state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ id: intent.id, state: "queued" }]);
    expect((await pool.query("SELECT state,error_code,checkpoint_id FROM workspace_checkpoint_requests WHERE id=$1", [intent.requestId])).rows[0])
      .toEqual({ state: "cancelled", error_code: "stop_unsealed", checkpoint_id: null });
    expect((await pool.query("SELECT subject->>'reason' AS reason FROM audit_log WHERE action='cloud_workspace.stop_unsealed' AND org_id=$1", [f.organizationId])).rows)
      .toEqual([{ reason: "authority_closed" }]);
  });
  it("an unsealed delete preserves data and only stops compute", async () => {
    const intent = await pending("delete");
    expect((await send()).status).toBe(200);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intent.id])).rows[0])
      .toEqual({ state: "failed", error_code: "engine_exited" });
    const provider = await tick();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.delete).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(1);
  });
  it("preserves an already dispatched lifecycle operation", async () => {
    const intent = await pending("delete");
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',attempt_count=1,lease_owner='fixture',lease_expires_at=now()+interval '1 minute' WHERE id=$1", [intent.id]);
    const before = await workspace();
    expect((await send()).status).toBe(200);
    expect(await workspace()).toEqual(before);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ state: "dispatching" }]);
  });
  it("preserves an accepted delete that requires no final capture", async () => {
    const intent = await pending("delete");
    await pool.query("DELETE FROM workspace_checkpoint_requests WHERE id=$1", [intent.requestId]);
    await pool.query("UPDATE cloud_workspaces SET desired_state='deleted',status='deleting' WHERE id=$1", [f.workspaceId]);
    const before = await workspace();
    expect((await send()).status).toBe(200);
    expect(await workspace()).toEqual(before);
    expect((await pool.query("SELECT id,operation,state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows)
      .toEqual([{ id: intent.id, operation: "delete", state: "queued" }]);
  });
  it("withdraws only the old engine when a same-generation replacement is live", async () => {
    const replacement = randomUUID(), grant = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_endpoint_grants SELECT (jsonb_populate_record(NULL::cloud_workspace_endpoint_grants,
        to_jsonb(original)||jsonb_build_object('id',$2::text,'token_hash',$3::bytea))).*
        FROM cloud_workspace_endpoint_grants original WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`,
      [f.engineInstanceId, grant, randomBytes(32)]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances
        (id,workspace_id,generation,org_id,account_user_id,setup_run_id,setup_execution_fence,registration_grant_id,protocol_version,
         state,bridge_token_hash,heartbeat_token_hash,registered_at,last_heartbeat_at,lease_expires_at,
         runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
         runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
        SELECT $2,workspace_id,generation,org_id,account_user_id,setup_run_id,setup_execution_fence,$3,protocol_version,
          state,$4,$5,registered_at,last_heartbeat_at,lease_expires_at,
          runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
          runtime_installer_receipt_sha256,runtime_boot_id,$6 FROM cloud_workspace_engine_instances WHERE id=$1`,
      [f.engineInstanceId, replacement, grant, randomBytes(32), randomBytes(32), randomUUID()]);
    });
    const before = await workspace();
    expect((await send()).status).toBe(200);
    expect(await workspace()).toEqual(before);
    expect((await engine()).state).toBe("revoked");
    expect((await pool.query("SELECT state,revoked_at FROM cloud_workspace_engine_instances WHERE id=$1", [replacement])).rows[0])
      .toEqual({ state: "ready", revoked_at: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
  });
  it("withdrawal refuses subsequent heartbeat and uplink renewal without shortening the lease", async () => {
    expect((await send()).status).toBe(200);
    const original = (await engine()).lease_expires_at;
    await expect(service.heartbeat({ workspaceId: f.workspaceId, organizationId: f.organizationId,
      generation: 1, engineInstanceId: f.engineInstanceId, token: f.heartbeatToken })).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
    const lease = new DatabaseUplinkLeaseStore({ pool, workosEnabled: false });
    expect(await lease.renew({ workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, bootId: String(report.bootId) }, f.heartbeatToken)).toEqual({ ok: false, reason: "authority" });
    expect((await engine()).lease_expires_at).toEqual(original);
  });
  it.each(["heartbeat-first", "exit-first", "uplink-first", "exit-before-uplink"] as const)(
    "serializes renewal and exit without reviving the engine (%s)", async order => {
      const lease = new DatabaseUplinkLeaseStore({ pool, workosEnabled: false });
      const renew = order.includes("uplink") ? () => lease.renew({ workspaceId: f.workspaceId, organizationId: f.organizationId,
        generation: 1, engineInstanceId: f.engineInstanceId, bootId: String(report.bootId) }, f.heartbeatToken)
        : () => service.heartbeat({ workspaceId: f.workspaceId, organizationId: f.organizationId,
          generation: 1, engineInstanceId: f.engineInstanceId, token: f.heartbeatToken });
      const exitFirst = order.startsWith("exit");
      const results = await orderedRace(exitFirst ? send : renew, exitFirst ? renew : send);
      const renewal = results[exitFirst ? 1 : 0];
      if (!exitFirst) expect(renewal).toHaveProperty(order.includes("uplink") ? "value.ok" : "value.leaseExpiresAtMs",
        order.includes("uplink") ? true : expect.any(Number));
      else if (order.includes("uplink")) expect(renewal).toEqual({ value: { ok: false, reason: "authority" } });
      else expect(renewal).toHaveProperty("error.code", "engine_heartbeat_rejected");
      expect((await engine()).state).toBe("revoked");
      expect(await workspace()).toMatchObject({ desired_state: "stopped" });
    });
  it.each(["checkpoint-first", "exit-first"] as const)("orders final capture and exit by their workspace lock (%s)", async order => {
    const intent = await pending("stop");
    const commit = await checkpointCommit(intent.requestId);
    const results = await orderedRace(order === "checkpoint-first" ? commit : send, order === "checkpoint-first" ? send : commit);
    const checkpoint = (await pool.query("SELECT state,error_code,checkpoint_id FROM workspace_checkpoint_requests WHERE id=$1", [intent.requestId])).rows[0];
    if (order === "checkpoint-first") {
      expect(results[0]).toHaveProperty("value.checkpointId");
      expect(checkpoint).toMatchObject({ state: "succeeded", error_code: null, checkpoint_id: expect.any(String) });
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action='cloud_workspace.stop_unsealed'", [f.organizationId])).rows[0].n).toBe(0);
    } else {
      expect(results[1]).toHaveProperty("error");
      expect(checkpoint).toEqual({ state: "cancelled", error_code: "stop_unsealed", checkpoint_id: null });
    }
    expect((await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows).toEqual([{ id: intent.id }]);
  });
  it("an unsealed rebuild fails its original operation and only admits a safe source Stop", async () => {
    const intent = await pending("stop", "before_rebuild");
    const transitionId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await seedSupportedCloudWorkspaceGeneration(tx, { workspaceId: f.workspaceId, organizationId: f.organizationId, ownerUserId: f.userId, generation: 2 });
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions
        (id,workspace_id,org_id,requested_by,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id)
        VALUES($1,$2,$3,$4,'upgrade',1,1,2,'draining',$5)`, [transitionId, f.workspaceId, f.organizationId, f.userId, intent.id]);
      await tx.query("UPDATE cloud_workspace_lifecycle_intents SET generation_transition_id=$2,affects_workspace=false WHERE id=$1", [intent.id, transitionId]);
    });
    expect((await send()).status).toBe(200);
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_generation_transitions WHERE id=$1", [transitionId])).rows[0])
      .toEqual({ state: "cancelled", error_code: "engine_exited" });
    expect((await pool.query("SELECT state,error_code FROM cloud_workspace_lifecycle_intents WHERE id=$1", [intent.id])).rows[0])
      .toEqual({ state: "failed", error_code: "engine_exited" });
    const provider = await tick();
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });
  it("retires an old generation without changing a selected successor", async () => {
    await withCloudFixtureOwnerTx(pool, tx => seedSupportedCloudWorkspaceGeneration(tx, {
      workspaceId: f.workspaceId, organizationId: f.organizationId, ownerUserId: f.userId, generation: 2 }));
    await pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [f.workspaceId]);
    const before = await workspace();
    expect((await send()).status).toBe(200);
    expect(await workspace()).toEqual(before);
    expect((await engine()).state).toBe("revoked");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
  });
  it.each([false, true])("a starting engine can enroll only before its supervisor withdraws (exit=%s)", async withdraw => {
    const registrationToken = `zws_${"R".repeat(43)}`;
    await pool.query(`UPDATE cloud_workspace_engine_instances SET state='starting',registered_at=NULL,last_heartbeat_at=NULL,
      heartbeat_token_hash=NULL,lease_expires_at=NULL WHERE id=$1`, [f.engineInstanceId]);
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [f.workspaceId]);
    await pool.query(`UPDATE cloud_workspace_endpoint_grants SET consumed_at=NULL,token_hash=$2,audience=$3,
      authority_epoch=(SELECT authority_epoch FROM cloud_workspaces WHERE id=$4)
      WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`,
    [f.engineInstanceId, createHash("sha256").update(registrationToken).digest(), `${origin}/internal/v1/cloud-workspaces/engine/register`, f.workspaceId]);
    if (withdraw) expect((await send()).status).toBe(200);
    const enrolling = service.registerEngine({ token: registrationToken, workspaceId: f.workspaceId, organizationId: f.organizationId,
      generation: 1, setupRunId: String(report.setupRunId), executionFence: Number(report.executionFence), engineInstanceId: f.engineInstanceId,
      protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, actorProtocolVersion: 2, agentCustomizationVersion: 3,
      agentRuntime: { profile: "zeros-cloud-worker-v4", runtimeId: runtimeWitness.runtimeId, manifestSha256: runtimeWitness.manifestSha256,
        baseCompatibilityId: runtimeWitness.baseCompatibilityId, installerReceiptSha256: runtimeWitness.installerReceiptSha256,
        bootId: runtimeWitness.bootId, supervisorSessionId: runtimeWitness.supervisorSessionId } });
    if (withdraw) {
      await expect(enrolling).rejects.toMatchObject({ code: "engine_registration_rejected" });
      expect((await engine()).state).toBe("revoked");
    } else await expect(enrolling).resolves.toHaveProperty("durableRecordConnected", true);
  });
});
