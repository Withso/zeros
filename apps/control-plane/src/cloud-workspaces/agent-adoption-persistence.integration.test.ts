import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, withCloudFixturePurgeTx } from "./test-fixtures.js";
import { reserveLocalCloudCommandWriter } from "./commands.js";
import { eraseCloudWorkspaceCollaborationIdentity } from "./actors.js";
import type { CloudAgentBootScope } from "./agent-boot-contract.js";
import type { CloudAgentCredentialKeys } from "./agent-credential-envelope.js";
import { allocateCloudAgentAdoptionId, rewrapCloudAgentAdoptionKeys } from "./agent-boot-credentials.js";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const access = { kind: "codex-chatgpt" as const, accountId: "synthetic-account-A", accessToken: "synthetic-provider-access-A", expiresAt: 1893456000 };
suite("database-owned scoped credential adoption", () => {
  let pool: pg.Pool, workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, scope: CloudAgentBootScope;
  let roots: Record<number, string>, old: CloudAgentCredentialKeys;
  const recordScope = (selected: typeof workspace) => withSystemTx(pool, async tx => {
    const bootId = (await tx.query<{ boot_id: string }>("SELECT runtime_boot_id AS boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [selected.engineInstanceId])).rows[0]!.boot_id;
    const engine = { organizationId: selected.organizationId, workspaceId: selected.workspaceId,
      generation: 1, engineInstanceId: selected.engineInstanceId, heartbeatToken: selected.heartbeatToken };
    const writerEpoch = await reserveLocalCloudCommandWriter(tx, engine, bootId, selected.userId, 1);
    const admitted = { ...engine, bootId, writerEpoch, fundingOwnerUserId: selected.userId, fundingOwnerEpoch: 1 };
    await tx.query(`INSERT INTO cloud_agent_boot_bindings
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`, [selected.workspaceId, selected.organizationId, selected.engineInstanceId, bootId, writerEpoch, selected.userId]);
    const { heartbeatToken: _, ...publicScope } = admitted;
    return publicScope;
  });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); workspace = await seedReadyCloudWorkspace(pool);
    roots = { 1: randomBytes(32).toString("base64url"), 2: randomBytes(32).toString("base64url") };
    old = { currentKeyVersion: 1, keys: roots };
    scope = await recordScope(workspace);
  });
  const allocate = (material: unknown = access, selected = scope, keys = old) =>
    withSystemTx(pool, tx => allocateCloudAgentAdoptionId(tx, selected, material, keys));
  const rewrap = (keys: CloudAgentCredentialKeys) => withSystemTx(pool, tx => rewrapCloudAgentAdoptionKeys(tx, keys));
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM cloud_agent_adoption_keys) AS keys,
    (SELECT count(*)::int FROM cloud_agent_adoptions) AS mappings`)).rows[0];
  const backendPid = async (tx: pg.PoolClient) =>
    (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const waitUntilBlocked = async (waitingPid: number, blockerPid: number) => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const { rows } = await pool.query<{ blocked: boolean }>(
        "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked", [waitingPid, blockerPid]);
      if (rows[0]?.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Allocator did not reach the expected PostgreSQL lock");
  };

  it("allocates one opaque mapping transactionally across concurrent same-account calls", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => allocate()));
    expect(new Set(ids).size).toBe(1); expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
  it("keeps same-account token rotation silent and preserves A-B-A identity", async () => {
    const a = await allocate();
    expect(await allocate({ ...access, accessToken: "synthetic-provider-access-rotated", expiresAt: 1893466000 })).toBe(a);
    const b = await allocate({ ...access, accountId: "synthetic-account-B" });
    expect(b).not.toBe(a); expect(await allocate()).toBe(a);
    expect(await counts()).toEqual({ keys: 1, mappings: 2 });
  });
  it("distinguishes API-key adoption and provider/kind scope", async () => {
    const account = await allocate(), api = { kind: "codex-api-key", apiKey: "synthetic-provider-key-A" };
    const a = await allocate(api); expect(a).not.toBe(account);
    expect(await allocate({ ...api, apiKey: "synthetic-provider-key-B" })).not.toBe(a);
    expect(await allocate(api)).toBe(a); expect(await counts()).toEqual({ keys: 2, mappings: 3 });
  });
  it("rewraps unavailable prior identities before dropping the old root without reminting", async () => {
    const a = await allocate(); await allocate({ ...access, accountId: "synthetic-account-B" });
    expect(await rewrap({ currentKeyVersion: 2, keys: roots })).toBe(1);
    expect(await allocate(access, scope, { currentKeyVersion: 2, keys: { 2: roots[2]! } })).toBe(a);
    expect(await rewrap({ currentKeyVersion: 2, keys: { 2: roots[2]! } })).toBe(0);
    expect((await pool.query("SELECT key_version::int FROM cloud_agent_adoption_keys")).rows).toEqual([{ key_version: 2 }]);
    expect(await counts()).toEqual({ keys: 1, mappings: 2 });
  });
  it("fences a stale wrapping-root writer after committed rotation", async () => {
    await allocate(); await rewrap({ currentKeyVersion: 2, keys: roots });
    await expect(allocate({ ...access, accountId: "synthetic-account-late" }, scope, old)).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
  it("rolls back incomplete rewrap and refuses missing keys without reminting", async () => {
    const a = await allocate();
    await expect(rewrap({ currentKeyVersion: 2, keys: { 2: roots[2]! } })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect((await pool.query("SELECT current_key_version::int FROM cloud_agent_adoption_key_policy")).rows).toEqual([{ current_key_version: 1 }]);
    expect(await allocate()).toBe(a); expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
  it.each(["organizationId", "workspaceId", "bootId", "writerEpoch", "fundingOwnerUserId"] as const)(
    "rejects an unrecorded %s instead of allocating a cross-scope identity", async field => {
      await expect(allocate(access, { ...scope, [field]: randomUUID() })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
      expect(await counts()).toEqual({ keys: 0, mappings: 0 });
    });
  it("does not allocate after genuine recorded engine retirement", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [scope.engineInstanceId]);
    await expect(allocate()).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(await counts()).toEqual({ keys: 0, mappings: 0 });
  });
  it("bounds mappings without evicting a referenced unavailable identity", async () => {
    const a = await allocate();
    await pool.query(`INSERT INTO cloud_agent_adoptions(key_id,fingerprint)
      SELECT key.id,digest('synthetic-unavailable-'||index::text,'sha256')
      FROM cloud_agent_adoption_keys key CROSS JOIN generate_series(1,255) index`);
    expect(await allocate()).toBe(a);
    await expect(allocate({ ...access, accountId: "synthetic-over-capacity" })).rejects.toMatchObject({ code: "cloud_validation_execution_limit" });
    expect(await counts()).toEqual({ keys: 1, mappings: 256 });
    await expect(pool.query(`INSERT INTO cloud_agent_adoptions(key_id,fingerprint)
      SELECT id,digest('synthetic-direct-overflow','sha256') FROM cloud_agent_adoption_keys`)).rejects.toMatchObject({ code: "23514" });
  });
  it("does not expose scoped fingerprints or wrapping keys in user transactions", async () => {
    await allocate();
    const rows = await withUserTx(pool, workspace.userId, async tx => [
      await tx.query("SELECT * FROM cloud_agent_adoption_keys"), await tx.query("SELECT * FROM cloud_agent_adoptions"), await tx.query("SELECT * FROM cloud_agent_adoption_key_policy"),
    ]);
    expect(rows.map(result => result.rowCount)).toEqual([0, 0, 0]);
    const stored = await pool.query("SELECT * FROM cloud_agent_adoptions");
    expect(JSON.stringify(stored.rows)).not.toContain(access.accountId); expect(JSON.stringify(stored.rows)).not.toContain(access.accessToken);
  });
  it("refuses unknown or private identity material before allocating", async () => {
    for (const material of [{ ...access, accountId: "" }, { ...access, refreshToken: "synthetic-private-refresh" }])
      await expect(allocate(material)).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(await counts()).toEqual({ keys: 0, mappings: 0 });
  });
  it("refuses an ordinary key deletion rather than reminting a referenced identity", async () => {
    const a=await allocate();
    await expect(pool.query("DELETE FROM cloud_agent_adoption_keys")).rejects.toMatchObject({code:"23514"});
    expect(await allocate()).toBe(a); expect(await counts()).toEqual({keys:1,mappings:1});
  });
  it("refuses an ordinary mapping deletion instead of silently reassigning A", async () => {
    const a=await allocate();
    await expect(pool.query("DELETE FROM cloud_agent_adoptions WHERE id=$1",[a]).then(()=>true)).rejects.toMatchObject({code:"23514"});
    expect(await allocate()).toBe(a);
  });
  it("refuses an ordinary mapping rewrite instead of silently reassigning A", async () => {
    const a=await allocate();
    await expect(pool.query("UPDATE cloud_agent_adoptions SET id=$2 WHERE id=$1",[a,randomUUID()]).then(()=>true)).rejects.toMatchObject({code:"23514"});
    expect(await allocate()).toBe(a);
  });
  it("refuses a persisted wrapping-policy downgrade after committed rotation", async () => {
    await allocate(); await rewrap({currentKeyVersion:2,keys:roots});
    await expect(pool.query("UPDATE cloud_agent_adoption_key_policy SET current_key_version=1").then(()=>true)).rejects.toMatchObject({code:"23514"});
    expect((await pool.query("SELECT current_key_version::int FROM cloud_agent_adoption_key_policy")).rows).toEqual([{current_key_version:2}]);
  });
  it("does not remint a transplanted scoped wrapping envelope", async () => {
    await allocate(); await allocate({kind:"codex-api-key",apiKey:"synthetic-provider-key-A"});
    await pool.query(`UPDATE cloud_agent_adoption_keys target SET nonce=source.nonce,ciphertext=source.ciphertext,auth_tag=source.auth_tag
      FROM cloud_agent_adoption_keys source WHERE target.kind='codex-chatgpt' AND source.kind='codex-api-key'`);
    await expect(allocate()).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    expect(await counts()).toEqual({keys:2,mappings:2});
  });
  it("fences an old-root allocation already waiting behind an in-flight rotation", async () => {
    await allocate();
    let unlock!: () => void, entered!: () => void, started!: () => void;
    let rotatingPid!: number, waitingPid!: number;
    const barrier = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const submitted = new Promise<void>(resolve => { started = resolve; });
    const rotating = withSystemTx(pool, async tx => {
      rotatingPid = await backendPid(tx);
      const count = await rewrapCloudAgentAdoptionKeys(tx, { currentKeyVersion: 2, keys: roots });
      entered(); await release; return count;
    });
    void rotating.catch(() => {}); await barrier;
    const stale = withSystemTx(pool, async tx => {
      waitingPid = await backendPid(tx); started();
      return allocateCloudAgentAdoptionId(tx, scope, { ...access, accountId: "synthetic-waiting-account" }, old);
    });
    void stale.catch(() => {}); await submitted;
    try { await waitUntilBlocked(waitingPid, rotatingPid); }
    finally { unlock(); }
    await expect(rotating).resolves.toBe(1);
    await expect(stale).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
  it("does not correlate the same account across two real workspace bindings", async () => {
    const a = await allocate();
    const otherWorkspace = await seedReadyCloudWorkspace(pool, { ownerUserId: workspace.userId });
    const otherScope = await recordScope(otherWorkspace);
    expect(await allocate(access, otherScope)).not.toBe(a);
    expect(await allocate()).toBe(a);
    expect(await counts()).toEqual({ keys: 2, mappings: 2 });
  });
  it("purges wrapping keys and mappings through actual workspace lifecycle deletion", async () => {
    const a = await allocate();
    await withCloudFixturePurgeTx(pool, { organizationId: workspace.organizationId, userId: workspace.userId }, async tx => {
      await tx.query("DELETE FROM cloud_workspace_computer_sources WHERE workspace_id=$1", [workspace.workspaceId]);
      await tx.query("DELETE FROM cloud_workspaces WHERE id=$1", [workspace.workspaceId]);
    });
    expect(await counts()).toEqual({ keys: 0, mappings: 0 });
    await expect(allocate()).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    const replacement = await seedReadyCloudWorkspace(pool, { ownerUserId: workspace.userId });
    expect(await allocate(access, await recordScope(replacement))).not.toBe(a);
    expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
  it("purges an anonymized funding account through the real collaboration hook without late recreation", async () => {
    await allocate();
    await withSystemTx(pool, tx => eraseCloudWorkspaceCollaborationIdentity(tx, workspace.userId));
    expect(await counts()).toEqual({ keys: 0, mappings: 0 });
    expect((await pool.query("SELECT id FROM users WHERE id=$1", [workspace.userId])).rowCount).toBe(1);
    await expect(allocate()).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });
  it("rejects an allocator waiting behind a committed account purge", async () => {
    await allocate();
    let unlock!: () => void, entered!: () => void, started!: () => void;
    let purgingPid!: number, waitingPid!: number;
    const barrier = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const submitted = new Promise<void>(resolve => { started = resolve; });
    const purging = withSystemTx(pool, async tx => {
      purgingPid = await backendPid(tx);
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [workspace.userId]);
      await eraseCloudWorkspaceCollaborationIdentity(tx, workspace.userId);
      entered(); await release;
    });
    void purging.catch(() => {}); await barrier;
    const stale = withSystemTx(pool, async tx => {
      waitingPid = await backendPid(tx); started();
      return allocateCloudAgentAdoptionId(tx, scope, access, old);
    });
    void stale.catch(() => {}); await submitted;
    try { await waitUntilBlocked(waitingPid, purgingPid); }
    finally { unlock(); }
    await purging;
    await expect(stale).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(await counts()).toEqual({ keys: 0, mappings: 0 });
  });
  it("does not retire an account or lose its identity when purge rolls back", async () => {
    const a = await allocate();
    await expect(withSystemTx(pool, async tx => {
      await eraseCloudWorkspaceCollaborationIdentity(tx, workspace.userId);
      throw new Error("synthetic transaction rollback");
    })).rejects.toThrow("synthetic transaction rollback");
    expect(await allocate()).toBe(a);
    expect(await counts()).toEqual({ keys: 1, mappings: 1 });
  });
});
