import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import type { AuthedUser } from "../auth.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAgentBootService, retireCloudAgentBootSources } from "./agent-boot-credentials.js";
import { CloudAgentBootCredentialResponseSchema, CloudAgentHistoryRecoveryResponseSchema,
  type CloudAgentBootCredentialResponse } from "./agent-boot-contract.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { canonicalCloudHistoryJson } from "./history-local-contract.js";
import { ensureCloudPilotUser, seedReadyCloudWorkspace, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { DatabaseCloudWorkspaceBlobService, MemoryCloudWorkspaceObjectStore } from "./object-store.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("CP-authorized unsealed history recovery", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let service: DatabaseCloudAgentBootService, source: CloudAgentBootCredentialResponse, ancestor: CloudAgentBootCredentialResponse;
  let ancestorSha256: string;
  const engine = () => ({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1,
    engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken });
  const request = () => { const { heartbeatToken: _token, ...scope } = engine(); return { ...scope, version: 1, mode: "boot-owner-v1" }; };
  const boot = async () => CloudAgentBootCredentialResponseSchema.parse(await service.execute(engine(), "bootstrap", request()));
  const activate = (bound: CloudAgentBootCredentialResponse, historyRecoveryId?: string) => service.execute(engine(), "activate", {
    ...request(), bootId: bound.bootId, writerEpoch: bound.writerEpoch, expectedCacheRevision: bound.cacheRevision,
    ...(historyRecoveryId ? { historyRecoveryId, historyRecoveryCustodySha256: "a".repeat(64) } : {}),
  });
  const recover = async (preparedCustody?: Array<{ writerEpoch: string; recoveryId: string }>) =>
    CloudAgentHistoryRecoveryResponseSchema.parse(await service.execute(engine(), "recover-history", {
      ...request(), ...(preparedCustody ? { preparedCustody } : {}),
    }));
  const rows = () => pool.query("SELECT * FROM cloud_agent_history_recoveries WHERE workspace_id=$1", [fixture.workspaceId]);

  // Positive source death comes from the same persisted lifecycle proof as the
  // reconciler; these are disposable relational fixtures, never provider calls.
  async function retire() {
    const intentId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,state,completed_at)
        VALUES($1,$2,1,$3,'stop',$4,$5,'succeeded',now())`,
      [intentId, fixture.workspaceId, fixture.organizationId, randomUUID(), randomBytes(32)]);
      await retireCloudAgentBootSources(tx, engine(), { kind: "provider-lifecycle", intentId });
      await tx.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    });
  }

  async function freshEngine(setup?: { id: string; fence: number }) {
    fixture = { ...fixture, heartbeatToken: `zwh_${randomBytes(32).toString("base64url")}` };
    const oldEngine = fixture.engineInstanceId, nextEngine = randomUUID(), grant = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_endpoint_grants
      (id,workspace_id,generation,org_id,account_user_id,purpose,audience,token_hash,account_revision,authorization_revision,
       expires_at,consumed_at,setup_run_id,setup_execution_fence)
      SELECT $2,workspace_id,generation,org_id,account_user_id,'setup','fixture',$3,1,1,
        now()+interval '10 minutes',now(),coalesce($4::uuid,setup_run_id),coalesce($5::bigint,setup_execution_fence)
      FROM cloud_workspace_engine_instances WHERE id=$1`, [oldEngine, grant, randomBytes(32), setup?.id ?? null, setup?.fence ?? null]);
    // Retain every runtime/installer attestation column; let the database
    // allocate its own monotonic enrollment_order for the new instance.
    const columns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cloud_workspace_engine_instances'
      AND column_name<>'enrollment_order' ORDER BY ordinal_position`)).rows.map(row => `"${row.column_name.replaceAll('"', '""')}"`).join(",");
    await pool.query(`INSERT INTO cloud_workspace_engine_instances (${columns})
      SELECT ${columns} FROM jsonb_populate_record(NULL::cloud_workspace_engine_instances,
        (SELECT to_jsonb(engine) || $2::jsonb FROM cloud_workspace_engine_instances engine WHERE id=$1))`,
    [oldEngine, JSON.stringify({ id: nextEngine, registration_grant_id: grant, state: "ready", revoked_at: null,
      ...(setup ? { setup_run_id: setup.id, setup_execution_fence: setup.fence } : {}),
      runtime_boot_id: randomUUID(), runtime_supervisor_session_id: randomUUID(), bridge_token_hash: `\\x${randomBytes(32).toString("hex")}`,
      heartbeat_token_hash: `\\x${createHash("sha256").update(fixture.heartbeatToken).digest("hex")}` })]);
    fixture = { ...fixture, engineInstanceId: nextEngine };
  }

  async function seal(bound: CloudAgentBootCredentialResponse) {
    const { organizationId, workspaceId, generation, engineInstanceId, bootId, writerEpoch, fundingOwnerUserId, fundingOwnerEpoch } = bound;
    const descriptor = { version: 1, scope: { organizationId, workspaceId, generation, engineInstanceId, bootId, writerEpoch,
      fundingOwnerUserId, fundingOwnerEpoch }, sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0,
    inventorySha256: "a".repeat(64) };
    const sha256 = createHash("sha256").update(canonicalCloudHistoryJson(descriptor)).digest("hex");
    await new DatabaseCloudWorkspaceCommandService({ pool }).seal(engine(), { ...descriptor, sha256 });
    return sha256;
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudAgentBootService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } }, false);
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    ancestor = await boot(); await activate(ancestor); ancestorSha256 = await seal(ancestor);
    await retire();
    // A new heartbeat is distinct even if the old engine is already retired.
    fixture = { ...fixture, heartbeatToken: `zwh_${randomBytes(32).toString("base64url")}` };
    await freshEngine(); source = await boot(); await activate(source); await retire();
    fixture = { ...fixture, heartbeatToken: `zwh_${randomBytes(32).toString("base64url")}` };
    await freshEngine();
  });

  it("prepares one exact target-bound recovery with an acknowledged ancestor, without publishing a writer or gap", async () => {
    const first = await recover(), again = await recover();
    expect(again).toEqual(first);
    expect(first).toMatchObject({ ...request(), code: "history_recovered_with_gap", coverage: "unknown",
      fundingOwnerUserId: fixture.userId, fundingOwnerEpoch: 1,
      predecessor: { writerEpoch: source.writerEpoch, engineInstanceId: source.engineInstanceId, bootId: source.bootId },
      checkpoint: { writerEpoch: ancestor.writerEpoch, sha256: ancestorSha256 }, mirroredSequence: 0 });
    expect((await rows()).rows).toMatchObject([{ activated_at: null, successor_writer_epoch: null }]);
    expect((await rows()).rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_local_command_writers WHERE state='active'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'")).rows[0].n).toBe(0);
  });

  it("recovers an unsealed source after archived drift completes its stop prerequisite", async () => {
    const first = await recover();
    source = await boot(); await activate(source, first.recoveryId);
    const binding = (await pool.query(`UPDATE cloud_workspace_provider_bindings
      SET last_observed_at=now()-interval '1 hour',next_drift_check_at=now()
      WHERE workspace_id=$1 AND generation=1 RETURNING provider_resource_id`, [fixture.workspaceId])).rows[0];
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1,
      resourceId: binding.provider_resource_id, state: "archived", target: null, metadata: {} };
    const unused = vi.fn(async (): Promise<never> => { throw new Error("Unexpected provider operation"); });
    const provider: CloudWorkspaceProvider = { name: "boat", inspect: async () => resource, find: async () => [resource],
      create: unused, delete: unused, archive: unused,
      stop: vi.fn(async () => resource), start: vi.fn(async () => { resource = { ...resource, state: "running" }; return resource; }),
      async *listManaged() { yield resource; } };
    const worker = new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1_000 });
    expect(await worker.reconcileDriftOnce()).toBe(true);
    expect((await pool.query("SELECT state FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [source.writerEpoch])).rows[0].state).toBe("active");
    expect(await worker.runOnce()).toBe(true);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.start).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state,seal,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [source.writerEpoch])).rows)
      .toEqual([{ state: "retired", seal: null, seal_ack: null }]);
    expect(await worker.runOnce()).toBe(true);
    expect(provider.start).toHaveBeenCalledOnce();
    const setup = (await pool.query(`UPDATE cloud_workspace_setup_runs SET state='running',claim_count=1,execution_fence=1,
        lease_owner='fixture',lease_expires_at=now()+interval '10 minutes',last_heartbeat_at=now(),started_at=now()
      WHERE workspace_id=$1 AND state='queued' RETURNING id,execution_fence::int AS fence`, [fixture.workspaceId])).rows[0];
    expect(setup).toBeDefined();
    await freshEngine(setup);
    const authorization = await recover(), successor = await boot();
    expect(authorization).toMatchObject({ code: "history_recovered_with_gap", coverage: "unknown",
      predecessor: { writerEpoch: source.writerEpoch }, checkpoint: { writerEpoch: ancestor.writerEpoch, sha256: ancestorSha256 } });
    await expect(activate(successor, authorization.recoveryId)).resolves.toMatchObject({ activated: true });
    expect((await pool.query(`SELECT subject FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'
      AND subject->>'recoveryId'=$1`, [authorization.recoveryId])).rows)
      .toEqual([{ subject: expect.objectContaining({ coverage: "unknown", writerEpoch: successor.writerEpoch }) }]);
    expect(unused).not.toHaveBeenCalled();
  });

  it("pins exact prepared custody with activation and rejects a changed hash on replay", async () => {
    const recovery = await recover(), bound = await boot(), custodySha256 = "a".repeat(64);
    const activation = { ...request(), bootId: bound.bootId, writerEpoch: bound.writerEpoch,
      expectedCacheRevision: bound.cacheRevision, historyRecoveryId: recovery.recoveryId,
      historyRecoveryCustodySha256: custodySha256 };
    await expect(service.execute(engine(), "activate", activation)).resolves.toMatchObject({ activated: true });
    expect((await rows()).rows[0]).toMatchObject({ custody_sha256: custodySha256 });
    await expect(service.execute(engine(), "activate", activation)).resolves.toMatchObject({ activated: true });
    await expect(service.execute(engine(), "activate", { ...activation, historyRecoveryCustodySha256: "b".repeat(64) }))
      .rejects.toMatchObject({ status: 403 });
    await expect(pool.query("UPDATE cloud_agent_history_recoveries SET custody_sha256=$2 WHERE id=$1", [recovery.recoveryId, "c".repeat(64)]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("reauthorizes the exact committed custody through four sequential unsealed recoveries", async () => {
    let previous: { recoveryId: string; custodySha256: string } | undefined;
    let predecessorWriter = source.writerEpoch;
    for (let cycle = 0; cycle < 4; cycle++) {
      const recovery = await recover(), bound = await boot(), custodySha256 = String(cycle + 1).repeat(64);
      expect(recovery.predecessor.writerEpoch).toBe(predecessorWriter);
      expect(recovery).toMatchObject(previous ? { predecessorRecovery: previous } : {});
      if (!previous) expect(recovery).not.toHaveProperty("predecessorRecovery");
      await service.execute(engine(), "activate", { ...request(), bootId: bound.bootId, writerEpoch: bound.writerEpoch,
        expectedCacheRevision: bound.cacheRevision, historyRecoveryId: recovery.recoveryId, historyRecoveryCustodySha256: custodySha256 });
      previous = { recoveryId: recovery.recoveryId, custodySha256 }; predecessorWriter = bound.writerEpoch;
      await retire(); await freshEngine();
    }
    expect((await rows()).rows.filter(row => row.activated_at)).toHaveLength(4);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'")).rows[0].n).toBe(4);
  });

  it("rejects an unsealed activation without recovery and commits exactly one gap with the successor", async () => {
    const bound = await boot();
    await expect(activate(bound)).rejects.toMatchObject({ status: 409, code: "cloud_history_recovery_required" });
    const authorization = await recover();
    await expect(activate(bound, randomUUID())).rejects.toMatchObject({ status: 403 });
    const activated = await activate(bound, authorization.recoveryId);
    expect(await activate(bound, authorization.recoveryId)).toEqual(activated);
    expect((await rows()).rows).toMatchObject([{ successor_writer_epoch: bound.writerEpoch, activated_at: expect.any(Date) }]);
    expect((await pool.query("SELECT subject FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'")).rows)
      .toEqual([{ subject: expect.objectContaining({ recoveryId: authorization.recoveryId, coverage: "unknown", writerEpoch: bound.writerEpoch }) }]);
  });

  it("does not authorize engine-selected older or foreign source identities", async () => {
    await expect(service.execute(engine(), "recover-history", { ...request(), writerEpoch: ancestor.writerEpoch })).rejects.toMatchObject({ status: 422 });
    await expect(service.execute(engine(), "recover-history", { ...request(), workspaceId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  });

  it("requires positive retirement, not a revoked engine or elapsed lease", async () => {
    const bound = await boot(); await pool.query("UPDATE cloud_workspaces SET agent_boot_id=agent_boot_id WHERE id=$1", [fixture.workspaceId]);
    // Temporarily publish a genuine active successor using the existing
    // fixture-only relational path. Recovery must never retire it itself.
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [bound.writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_boot_id=(SELECT id FROM cloud_agent_boot_bindings WHERE engine_instance_id=$2) WHERE id=$1",
      [fixture.workspaceId, bound.engineInstanceId]);
    await expect(recover()).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a prepared authorization across A-B-A funding transfer", async () => {
    const authorization = await recover(), bound = await boot();
    const user = await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `recovery_${randomUUID()}`,
      email: `recovery-${randomUUID()}@example.test`, displayName: "Recovery funding fixture" });
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, user.id]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [fixture.organizationId, user.id]);
    });
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [fixture.workspaceId, user.id]);
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [fixture.workspaceId, fixture.userId]);
    await expect(activate(bound, authorization.recoveryId)).rejects.toMatchObject({ status: 403 });
    expect((await rows()).rows[0].activated_at).toBeNull();
  });

  it("keeps recovery authority private under RLS and its scope immutable", async () => {
    const authorization = await recover();
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_agent_history_recoveries"))).rows).toEqual([]);
    await expect(pool.query("UPDATE cloud_agent_history_recoveries SET ancestor_seal_sha256=$2 WHERE id=$1",
      [authorization.recoveryId, "f".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back the successor, pointer and receipt if the gap audit cannot commit, then replays exactly once", async () => {
    const authorization = await recover(), bound = await boot();
    const pointer = (await pool.query("SELECT agent_boot_id FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows;
    await pool.query(`CREATE FUNCTION refuse_history_gap_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='cloud_workspace.history_recovered_with_gap' THEN RAISE EXCEPTION 'fixture_audit_failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER refuse_history_gap_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_history_gap_fixture();`);
    await expect(activate(bound, authorization.recoveryId)).rejects.toThrow("fixture_audit_failure");
    expect((await pool.query("SELECT agent_boot_id FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows).toEqual(pointer);
    expect((await rows()).rows).toMatchObject([{ activated_at: null, successor_writer_epoch: null }]);
    expect((await pool.query("SELECT state,activated_at FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [bound.writerEpoch])).rows)
      .toEqual([{ state: "reserved", activated_at: null }]);
    await pool.query("DROP TRIGGER refuse_history_gap_fixture ON audit_log");
    await activate(bound, authorization.recoveryId); await activate(bound, authorization.recoveryId);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'")).rows[0].n).toBe(1);
  });

  it.each(["source-replaced", "target-expired"] as const)("rejects activation when %s after authorization", async kind => {
    const authorization = await recover(), bound = await boot();
    if (kind === "source-replaced") await pool.query(`UPDATE cloud_workspaces SET agent_boot_id=
      (SELECT id FROM cloud_agent_boot_bindings WHERE engine_instance_id=$2) WHERE id=$1`, [fixture.workspaceId, ancestor.engineInstanceId]);
    else await pool.query(`UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp()-interval '2 seconds',
      lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [bound.engineInstanceId]);
    await expect(activate(bound, authorization.recoveryId)).rejects.toMatchObject(kind === "source-replaced"
      ? { status: 403 } : { name: "CloudWorkspaceEngineAuthorityError" });
    expect((await rows()).rows).toMatchObject([{ activated_at: null, successor_writer_epoch: null }]);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_workspace_local_command_writers WHERE state='active'")).rows[0].n).toBe(0);
  });

  it("authorizes exact positively retired prepared custody through repeated pre-activation crashes", async () => {
    const first = await recover(), prepared = await boot();
    await retire(); await freshEngine();
    const hint = { writerEpoch: prepared.writerEpoch, recoveryId: first.recoveryId };
    const second = await recover([hint]), next = await boot();
    expect(second.predecessor).toEqual(first.predecessor);
    expect(second.checkpoint).toEqual(first.checkpoint);
    expect(second.preparedCustody).toEqual([{ recoveryId: first.recoveryId,
      scope: expect.objectContaining({ writerEpoch: prepared.writerEpoch, engineInstanceId: prepared.engineInstanceId }),
      retiredAt: expect.any(String) }]);
    // Never-activated writer rows stay reserved; their positively retired
    // binding is custody proof, not a fabricated activated/retired writer.
    expect((await pool.query("SELECT state,activated_at FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1",
      [prepared.writerEpoch])).rows).toEqual([{ state: "reserved", activated_at: null }]);
    await retire(); await freshEngine();
    const third = await recover([hint, { writerEpoch: next.writerEpoch, recoveryId: second.recoveryId }]);
    expect(third.preparedCustody).toHaveLength(2);
    expect(third.predecessor).toEqual(first.predecessor);
    const current = await boot(); await activate(current, third.recoveryId);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap'")).rows[0].n).toBe(1);
  });

  it("cannot add or drop prepared custody when replaying an immutable authorization", async () => {
    const first = await recover(), prepared = await boot();
    await retire(); await freshEngine();
    const hints = [{ writerEpoch: prepared.writerEpoch, recoveryId: first.recoveryId }];
    const next = await recover(hints);
    await expect(recover()).rejects.toMatchObject({ status: 403 });
    await expect(recover([...hints, { writerEpoch: randomUUID(), recoveryId: randomUUID() }])).rejects.toMatchObject({ status: 403 });
    expect(await recover(hints)).toEqual(next);
    await expect(pool.query("UPDATE cloud_agent_history_recoveries SET prepared_custody='[]'::jsonb WHERE id=$1", [next.recoveryId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("purges prepared and activated recovery records through D1 while retaining the gap audit and a sibling workspace", async () => {
    const first = await recover(), prepared = await boot();
    await retire(); await freshEngine();
    const next = await recover([{ writerEpoch: prepared.writerEpoch, recoveryId: first.recoveryId }]), bound = await boot();
    await activate(bound, next.recoveryId);
    expect((await rows()).rowCount).toBe(2);
    const sibling = await seedReadyCloudWorkspace(pool);
    const audits = (await pool.query("SELECT id,subject FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap' ORDER BY id")).rows;
    const objects = new DatabaseCloudWorkspaceBlobService({ pool, objectStore: new MemoryCloudWorkspaceObjectStore(),
      encryptionKeyV1: randomBytes(32).toString("base64url"), workosEnabled: false });
    await confirmWorkspaceDeletion(pool, fixture);
    const logger = { error: vi.fn() };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "history-gap-purge-fixture", maxAttempts: 1, logger });
    await worker.runOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT job.state,workspace.data_deleted_at IS NOT NULL AS erased
      FROM workspace_deletion_jobs job JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id
      WHERE workspace.id=$1`, [fixture.workspaceId])).rows).toEqual([{ state: "succeeded", erased: true }]);
    expect((await rows()).rowCount).toBe(0);
    expect((await pool.query("SELECT id,subject FROM audit_log WHERE action='cloud_workspace.history_recovered_with_gap' ORDER BY id")).rows).toEqual(audits);
    expect((await pool.query("SELECT data_deleted_at FROM cloud_workspaces WHERE id=$1", [sibling.workspaceId])).rows).toEqual([{ data_deleted_at: null }]);
    expect((await pool.query("SELECT id FROM cloud_workspace_engine_instances WHERE id=$1", [sibling.engineInstanceId])).rowCount).toBe(1);
  });

  it.each(["only-revoked", "foreign-receipt", "activated", "funding-aba"] as const)(
    "rejects %s prepared custody and never allocates a recovery from a caller-selected source", async kind => {
      const first = await recover(), prepared = await boot();
      if (kind === "activated") await activate(prepared, first.recoveryId);
      if (kind === "only-revoked")
        await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [prepared.engineInstanceId]);
      else await retire();
      await freshEngine();
      if (kind === "funding-aba") {
        const owner = await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `recovery_${randomUUID()}`,
          email: `recovery-${randomUUID()}@example.test`, displayName: "Recovery funding fixture" });
        await withCloudFixtureOwnerTx(pool, async tx => {
          await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, owner.id]);
          await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [fixture.organizationId, owner.id]);
        });
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [fixture.workspaceId, owner.id]);
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [fixture.workspaceId, fixture.userId]);
      }
      await expect(recover([{ writerEpoch: prepared.writerEpoch,
        recoveryId: kind === "foreign-receipt" ? randomUUID() : first.recoveryId }])).rejects.toMatchObject({ status: 403 });
      expect((await pool.query("SELECT 1 FROM cloud_agent_history_recoveries WHERE engine_instance_id=$1", [fixture.engineInstanceId])).rows).toEqual([]);
    });
  it("projects only the activated nonsecret gap receipt through authorized detail and catalog reads", async () => {
    const app = new Hono();
    const user: AuthedUser = { id: fixture.userId, identity: { provider: "workos", subject: `workos|${fixture.userId}` },
      email: "history-gap@example.test", displayName: "History gap fixture", avatarUrl: null, accountRevision: 1,
      accountStatus: "active", authentication: { sessionId: null, clientKind: "legacy", authTime: null, tokenExpiresAt: null }, staffRole: null };
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, { workosEnabled: false }));
    const read = async () => {
      const detail = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`), catalog = await app.request("/v1/cloud-workspaces");
      expect(detail.status).toBe(200); expect(catalog.status).toBe(200);
      return [(await detail.json()).workspace,
        (await catalog.json()).workspaces.find((row: { id: string }) => row.id === fixture.workspaceId)];
    };
    const authorization = await recover(), bound = await boot();
    for (const doc of await read()) expect(doc).not.toHaveProperty("historyRecovery");
    await activate(bound, authorization.recoveryId);
    const expected = { recoveryId: authorization.recoveryId, code: "history_recovered_with_gap", coverage: "unknown",
      generation: bound.generation, engineInstanceId: bound.engineInstanceId, bootId: bound.bootId, writerEpoch: bound.writerEpoch,
      completedAt: expect.any(String) };
    for (const doc of await read()) expect(doc.historyRecovery).toEqual(expected);
    const before = (await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows;
    await read();
    expect((await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows).toEqual(before);
  });
});
