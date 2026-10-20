import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { reserveLocalCloudCommandWriter } from "./commands.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { retireCloudAgentBootSources } from "./agent-boot-credentials.js";
import * as mutations from "./agent-credential-mutations.js";
import type { CloudAgentBootScope } from "./agent-boot-contract.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud connection recovery from an unreachable boot without provider material", () => {
  let pool: pg.Pool, workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let service: DatabaseCloudAgentCredentialService, scope: CloudAgentBootScope;
  let credentialId: string, cursorId: string, bindingId: string;
  const tx = <T>(fn: Parameters<typeof withSystemTx<T>>[1]) => withSystemTx(pool, fn);
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudAgentCredentialService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } });
    credentialId = randomUUID(); cursorId = randomUUID();
    for (const [provider, id, model] of [["codex", credentialId, "gpt-5.4"], ["cursor", cursorId, "auto"]] as const) {
      await service.put({ credentialId: id, ownerUserId: workspace.userId, organizationId: workspace.organizationId,
        operationId: randomUUID(), expectedRevision: 0, displayName: "Synthetic account",
        material: { kind: `${provider}-api-key`, apiKey: `synthetic-${provider}-reconnect-key` } });
      await service.setOrganizationConnection(workspace.userId, workspace.organizationId, provider,
        { expectedRevision: 0, credentialId: id, credentialRevision: 1, models: [model], consent: "zeros-managed" });
    }
    scope = await tx(async client => {
      const bootId = (await client.query<{runtime_boot_id: string}>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1",
        [workspace.engineInstanceId])).rows[0]!.runtime_boot_id;
      const writerEpoch = await reserveLocalCloudCommandWriter(client, { organizationId: workspace.organizationId,
        workspaceId: workspace.workspaceId, generation: 1, engineInstanceId: workspace.engineInstanceId,
        heartbeatToken: workspace.heartbeatToken }, bootId, workspace.userId, 1);
      bindingId = (await client.query<{id: string}>(`INSERT INTO cloud_agent_boot_bindings(workspace_id,org_id,generation,engine_instance_id,
        boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,1,$3,$4,$5,$6,1) RETURNING id`,
      [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId])).rows[0]!.id;
      await client.query("UPDATE cloud_agent_boot_bindings SET credentials_initialized=true WHERE id=$1", [bindingId]);
      return { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, generation: 1,
        engineInstanceId: workspace.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 };
    });
    // The boot has a real, immutable delivery for another provider. It never
    // received Codex, which was unavailable when this original boot initialized.
    await tx(client => mutations.recordCloudAgentBootCredentialDelivery(client, scope, { provider: "cursor", credentialId: cursorId }));
  });
  const selection = (provider: "codex" | "cursor" = "codex") => ({ expectedRevision: 1,
    credentialId: provider === "codex" ? credentialId : cursorId, credentialRevision: 1,
    models: [provider === "codex" ? "gpt-5.4" : "auto"], consent: "zeros-managed" });
  const select = (provider: "codex" | "cursor" = "codex") =>
    service.setOrganizationConnection(workspace.userId, workspace.organizationId, provider, selection(provider));
  const read = () => service.organizationConnections(workspace.userId, workspace.organizationId);
  const revoke = () => pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1", [scope.engineInstanceId]);
  const rows = () => pool.query(`SELECT id,state,decision,target,source_snapshot,expires_at,created_at,fence_epoch
    FROM cloud_agent_credential_mutations ORDER BY fence_epoch`);
  async function elapsed(provider: "codex" | "cursor" = "codex") {
    await pool.query("ALTER TABLE cloud_agent_credential_mutations ALTER COLUMN created_at SET DEFAULT now()-interval '6 minutes', ALTER COLUMN expires_at SET DEFAULT now()-interval '1 minute'");
    try { await expect(select(provider)).rejects.toMatchObject({ status: 503, code: "cloud_agent_credential_busy" }); }
    finally { await pool.query("ALTER TABLE cloud_agent_credential_mutations ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN expires_at SET DEFAULT now()+interval '5 minutes'"); }
    return (await rows()).rows.at(-1)!;
  }
  async function retire() {
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,
      idempotency_key,request_sha256,state,completed_at) VALUES($1,$2,$3,1,$4,'stop',$5,$6,'succeeded',now())`,
    [id, workspace.workspaceId, workspace.organizationId, workspace.userId, randomUUID(), randomBytes(32)]);
    await tx(client => retireCloudAgentBootSources(client, scope, { kind: "provider-lifecycle", intentId: id }));
  }
  async function exchange(acknowledgements: unknown[] = []) {
    const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = scope;
    return tx(client => mutations.exchangeCloudAgentCredentialControls(client,
      { ...scope, heartbeatToken: workspace.heartbeatToken, workosEnabled: false },
      { ...reference, version: 1, mode: "boot-owner-v1", acknowledgements }));
  }
  const ack = (control: mutations.CloudAgentCredentialControlRequest, phase: "fenced" | "released") => ({
    ...scope, version: 1, mutationId: control.mutationId, controlRequestId: control.controlRequestId,
    fenceEpoch: control.fenceEpoch, controlRevision: phase === "fenced" ? 1 : 2, phase,
    mutationFenced: phase !== "released", startsFenced: phase !== "released", desiredCacheRevision: null,
    readyCacheRevision: 1, proofId: null, activity: { complete: true, foreground: 0, reservedLaunches: 0,
      background: 0, idleHosts: 0, scopes: [] },
  });

  it("does not add an impossible pause for a revoked initialized boot that never received this provider", async () => {
    await revoke();
    await expect(select()).resolves.toEqual({ revision: 2, replayed: false });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_credential_controls")).rows[0]!.n).toBe(0);
    expect((await pool.query("SELECT retired_at FROM cloud_agent_boot_bindings WHERE id=$1", [bindingId])).rows[0]!.retired_at).toBeNull();
    expect((await pool.query("SELECT provider,retired_proof_id FROM cloud_agent_boot_source_deliveries WHERE binding_id=$1", [bindingId])).rows)
      .toEqual([{ provider: "cursor", retired_proof_id: null }]);
  });

  it("recovers an already cancelling no-delivery publication without rewriting its original fences", async () => {
    const original = await elapsed();
    await expect(select()).rejects.toMatchObject({ status: 503 });
    const controls = (await pool.query("SELECT * FROM cloud_agent_credential_controls ORDER BY id")).rows;
    expect((await rows()).rows[0]).toMatchObject({ state: "cancelling", decision: "expire" });
    await revoke();
    await expect(select()).resolves.toEqual({ revision: 2, replayed: false });
    const current = (await rows()).rows.find(row => row.id === original.id);
    expect(current).toEqual({ ...original, state: "expired", decision: "expire" });
    expect((await pool.query("SELECT * FROM cloud_agent_credential_controls WHERE mutation_id=$1 ORDER BY id", [original.id])).rows).toEqual(controls);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_credential_source_retirements")).rows[0]!.n).toBe(0);
    await expect(select()).resolves.toEqual({ revision: 2, replayed: true });
  });

  it.each(["live", "elapsed-lease"])("still waits for an exact native pause from a %s boot without deliveries", async state => {
    if (state === "elapsed-lease") await pool.query(`UPDATE cloud_workspace_engine_instances SET
      registered_at=now()-interval '2 minutes',last_heartbeat_at=now()-interval '2 minutes',
      lease_expires_at=now()-interval '1 minute' WHERE id=$1`, [scope.engineInstanceId]);
    await expect(select()).rejects.toMatchObject({ status: 503 });
    expect((await rows()).rows[0]).toMatchObject({ state: "preparing", decision: null });
  });

  it("keeps a revoked boot with any delivery for this provider blocked, even for a different credential", async () => {
    await tx(client => mutations.recordCloudAgentBootCredentialDelivery(client, scope, { provider: "codex", credentialId }));
    const replacement = await service.put({ credentialId: randomUUID(), ownerUserId: workspace.userId, organizationId: workspace.organizationId,
      operationId: randomUUID(), expectedRevision: 0, displayName: "Replacement account",
      material: { kind: "codex-api-key", apiKey: "synthetic-replacement-reconnect-key" } });
    await revoke();
    await expect(service.setOrganizationConnection(workspace.userId, workspace.organizationId, "codex",
      { ...selection(), credentialId: replacement.credential.id })).rejects.toMatchObject({ status: 503 });
    expect((await rows()).rows[0]).toMatchObject({ state: "preparing", decision: null });
  });

  it("requires the original live release before closing an elapsed publication", async () => {
    await elapsed();
    await expect(select()).rejects.toMatchObject({ status: 503 });
    const release = (await exchange()).controls.find(control => control.operation === "release")!;
    await expect(exchange([{ ...ack(release, "released"), bootId: randomUUID() }])).rejects.toMatchObject({ status: 403 });
    await expect(select()).rejects.toMatchObject({ status: 503 });
    await exchange([ack(release, "released")]);
    await expect(select()).rejects.toMatchObject({ status: 503 });
    const pause = (await exchange()).controls.find(control => control.operation === "pause-starts")!;
    await exchange([ack(pause, "fenced")]);
    await expect(select()).resolves.toEqual({ revision: 2, replayed: false });
  });

  it("does not reinterpret a missing original boot as proof that it received no provider material", async () => {
    await elapsed();
    await pool.query("DELETE FROM cloud_agent_boot_bindings WHERE id=$1", [bindingId]);
    await expect(select()).rejects.toMatchObject({ status: 503 });
    expect((await rows()).rows[0]).toMatchObject({ state: "cancelling", decision: "expire" });
  });

  it("does not apply the connection-only exclusion to explicit credential replacement", async () => {
    await revoke();
    await expect(service.put({ credentialId, ownerUserId: workspace.userId, operationId: randomUUID(), expectedRevision: 1,
      displayName: "Explicit replacement", material: { kind: "codex-api-key", apiKey: "synthetic-explicit-reconnect-key" } }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("refuses contradictory ready material even when the delivery ledger has no matching row", async () => {
    await pool.query(`INSERT INTO cloud_agent_boot_credentials(binding_id,provider,metadata,key_version,nonce,ciphertext,auth_tag)
      VALUES($1,'codex',$2,1,$3,$4,$5)`, [bindingId, { status: "ready", provider: "codex" },
    randomBytes(12), randomBytes(32), randomBytes(16)]);
    await revoke();
    await expect(select()).rejects.toMatchObject({ status: 503 });
  });

  it("keeps a control whose original boot identity differs from the surviving binding pending", async () => {
    await elapsed();
    const control = (await pool.query("SELECT * FROM cloud_agent_credential_controls WHERE operation='pause-starts'")).rows[0]!;
    const request = { ...control.request, controlRequestId: randomUUID(), bootId: randomUUID() };
    await pool.query(`INSERT INTO cloud_agent_credential_controls(id,mutation_id,binding_id,operation,attempt,request,request_sha256)
      VALUES($1,$2,$3,'pause-starts',2,$4,$5)`, [request.controlRequestId, control.mutation_id, bindingId, request, randomBytes(32)]);
    await revoke();
    await expect(select()).rejects.toMatchObject({ status: 503 });
    expect((await rows()).rows[0]).toMatchObject({ state: "cancelling", decision: "expire" });
  });

  it("waits for a first delivery transaction before deciding a revoked boot received no material", async () => {
    let enter!: (pid: number) => void, release!: () => void;
    const entered = new Promise<number>(resolve => { enter = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const delivery = tx(async client => {
      await mutations.recordCloudAgentBootCredentialDelivery(client, scope, { provider: "codex", credentialId });
      enter((await client.query<{pid: number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      await barrier;
    });
    const blocker = await entered;
    await revoke();
    let finished = false;
    const selecting = select().then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
    let blocked = false;
    try {
      const deadline = Date.now() + 2_000;
      while (!finished && Date.now() < deadline) {
        blocked = (await pool.query(`SELECT 1 FROM pg_stat_activity activity WHERE activity.datname=current_database()
          AND $1=ANY(pg_blocking_pids(activity.pid))`, [blocker])).rowCount !== 0;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await delivery; }
    expect(await selecting).toMatchObject({ error: { status: 503, code: "cloud_agent_credential_busy" } });
    expect((await rows()).rows[0]).toMatchObject({ state: "preparing", decision: null });
  });

  it("finishes a prepared selection after revocation without clearing unrelated provider material", async () => {
    await expect(select()).rejects.toMatchObject({ status: 503 });
    await pool.query("INSERT INTO cloud_agent_boot_credentials(binding_id,provider,metadata) VALUES($1,'cursor',$2)",
      [bindingId, { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_expired" }]);
    const before = (await pool.query("SELECT * FROM cloud_agent_boot_credentials WHERE binding_id=$1", [bindingId])).rows;
    await revoke();
    await expect(select()).resolves.toEqual({ revision: 2, replayed: false });
    expect((await rows()).rows[0]).toMatchObject({ state: "published", decision: "publish" });
    expect((await pool.query("SELECT * FROM cloud_agent_boot_credentials WHERE binding_id=$1", [bindingId])).rows).toEqual(before);
  });

  it("progresses an abandoned provider publication on Settings read using its retained positive retirement", async () => {
    const original = await elapsed("cursor");
    await retire();
    const before = (await pool.query("SELECT provider,credential_id,revision FROM cloud_agent_organization_connections ORDER BY provider")).rows;
    await read();
    expect((await rows()).rows[0]).toEqual({ ...original, state: "expired", decision: "expire" });
    expect((await pool.query("SELECT provider,credential_id,revision FROM cloud_agent_organization_connections ORDER BY provider")).rows).toEqual(before);
    expect((await pool.query("SELECT operation,acknowledgement FROM cloud_agent_credential_controls ORDER BY operation")).rows)
      .toEqual([{ operation: "pause-starts", acknowledgement: null }, { operation: "release", acknowledgement: null }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_credential_source_retirements")).rows[0]!.n).toBe(2);
  });

  it("limits Settings expiry reconciliation to sixteen original operations per read", async () => {
    const original = await elapsed("cursor");
    await pool.query("ALTER TABLE cloud_agent_credential_mutations ALTER COLUMN created_at SET DEFAULT now()-interval '6 minutes', ALTER COLUMN expires_at SET DEFAULT now()-interval '1 minute'");
    try {
      for (let index = 1; index < 17; index++) await tx(client =>
        mutations.prepareCloudAgentCredentialPublication(client, workspace.userId, randomUUID(), original.target));
    } finally { await pool.query("ALTER TABLE cloud_agent_credential_mutations ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN expires_at SET DEFAULT now()+interval '5 minutes'"); }
    await retire();
    await read();
    expect((await rows()).rows.filter(row => row.state === "expired")).toHaveLength(16);
    expect((await rows()).rows.filter(row => row.state === "preparing")).toHaveLength(1);
    await read();
    expect((await rows()).rows.filter(row => row.state === "expired")).toHaveLength(17);
  });

  it("does not progress the original owner's publication from a foreign account or organization read", async () => {
    const original = await elapsed();
    await revoke();
    const other = await seedReadyCloudWorkspace(pool);
    await expect(service.organizationConnections(other.userId, workspace.organizationId)).rejects.toMatchObject({ status: 404 });
    await service.organizationConnections(other.userId, other.organizationId);
    expect((await rows()).rows[0]).toEqual(original);
    await read();
    expect((await rows()).rows[0]).toEqual({ ...original, state: "expired", decision: "expire" });
  });
});
