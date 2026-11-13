import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db.js";
import { SYSTEM_DATABASE_CONTEXT } from "../../db-context.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";
import { matchesExecutionSignature, type ExecutionSignatureBasis } from "./signatures.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const migration = readFileSync(new URL("../../../migrations/0247_cloud_membership_access.sql", import.meta.url), "utf8");
const prior = readFileSync(new URL("../../../migrations/0243_cloud_execution_person_authority.sql", import.meta.url), "utf8");
const initial = readFileSync(new URL("../../../migrations/0239_cloud_execution_contexts.sql", import.meta.url), "utf8");
const sourceTriggers = ["execution_source_fence", "execution_github_selection_fence", "execution_github_credential_fence"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function versionTwo(basis: ExecutionSignatureBasis) {
  const [workspace, organization, user, , account, member, incarnation, , role, repository, targets, connection] = basis.permission;
  const permissionSignature = hash([2, workspace, organization, user, account, member, incarnation, role, repository, targets, connection, basis.policy]);
  const personSignature = hash([permissionSignature, basis.accessEpoch, basis.stopGeneration]);
  return { signatureVersion: 2, permissionSignature, personSignature, signature: hash([personSignature, basis.bootId, basis.workerTokenHash]) };
}

database("0247 membership authority migration", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 15000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool); await f.cp.loginChanges.stop(); await f.activate(); await f.login();
    expect((await f.hello()).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const open = async () => {
    const issued = await f.cp.execution.clients.ticket(f.workspace.id, f.creator, false);
    const grant = await f.cp.store.consumeConnectTicket(issued.token, f.workspace.id);
    return f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!);
  };
  const capture = async (tx: pg.Pool | pg.PoolClient, contextId: string) => {
    await tx.query("UPDATE cloud_v2_execution_contexts SET authority=$2 WHERE id=$1", [contextId, { signatureVersion: 2, signature: "a".repeat(64) }]);
    return (await tx.query("SELECT authority->'legacyBasis' AS basis FROM cloud_v2_execution_contexts WHERE id=$1", [contextId])).rows[0].basis as ExecutionSignatureBasis;
  };

  it("backfills authentic live v2 inputs, preserves old hashes, and removes only the three GitHub cut triggers", async () => {
    const context = await open(), prompt = f.prompt();
    expect((await f.send(prompt)).status).toBe(201);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const old = versionTwo(await capture(client, context.contextId));
      const captureFunction = prior.match(/CREATE FUNCTION capture_cloud_execution_legacy_basis\(\)[\s\S]*?^\$\$;/m)![0];
      await client.query(captureFunction.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
      for (const trigger of sourceTriggers) await client.query(initial.match(new RegExp(`CREATE TRIGGER ${trigger} [\\s\\S]*?;`))![0]);
      const before = (await client.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows.map(row => row.tgname);
      await client.query("UPDATE cloud_v2_execution_contexts SET authority=$2,source_fingerprint=repeat('a',64) WHERE id=$1", [context.contextId, { signatureVersion: 2, signature: old.signature }]);
      const ticket = randomBytes(32);
      await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
        VALUES($1,$2,'connect',$3,clock_timestamp()+interval '1 minute',$4)`, [ticket, f.workspace.id, f.creator.id, { signatureVersion: 2, signature: old.personSignature }]);
      const intent = { signatureVersion: 2, permissionSignature: old.permissionSignature };
      await client.query("UPDATE cloud_v2_prompt_outbox SET execution_authority=$2 WHERE workspace_id=$1", [f.workspace.id, intent]);
      await client.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [f.workspace.id, intent]);
      expect((await client.query("SELECT authority ? 'legacyBasis' AS captured FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].captured).toBe(false);
      await client.query(migration);
      const after = (await client.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows.map(row => row.tgname);
      expect(before.filter(name => !after.includes(name)).sort()).toEqual([...sourceTriggers].sort());
      const authorities = [
        (await client.query("SELECT authority FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].authority,
        (await client.query("SELECT execution_authority AS authority FROM cloud_v2_tokens WHERE token_hash=$1", [ticket])).rows[0].authority,
        (await client.query("SELECT execution_authority AS authority FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows[0].authority,
        (await client.query("SELECT execution_intent_authority AS authority FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].authority,
      ];
      expect(authorities[0].signature).toBe(old.signature);
      expect(authorities[0].legacyBasis.workerTokenHash).toMatch(/^[a-f0-9]{64}$/);
      for (const value of authorities.slice(1)) expect(value.legacyBasis.workerTokenHash).toBeNull();
      await client.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]);
      await client.query("DELETE FROM cloud_github_credentials WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]);
      await client.query(SYSTEM_DATABASE_CONTEXT);
      const person = await f.cp.execution.deps.authority.snapshot(client as unknown as Tx, f.workspace.id, f.creator.id);
      const kinds = ["signature", "personSignature", "permissionSignature", "permissionSignature"] as const;
      for (let i = 0; i < authorities.length; i++) {
        const value = authorities[i], kind = kinds[i]!;
        const signature = kind === "permissionSignature" ? value.permissionSignature : value.signature;
        expect(matchesExecutionSignature(value, signature, person, kind)).toBe(true);
        expect(matchesExecutionSignature(value, "f".repeat(64), person, kind)).toBe(false);
      }
      expect((await client.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].state).toBe("active");
      await client.query("UPDATE cloud_v2_execution_contexts SET source_fingerprint=NULL WHERE id=$1", [context.contextId]);
      await client.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]);
      expect((await client.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].state).toBe("revoked");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("bounds the live v2 backfill and leaves v3 writes out of compatibility capture", async () => {
    const context = await open();
    expect((await pool.query("SELECT authority FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].authority)
      .toEqual({ signatureVersion: 3, signature: expect.any(String) });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE cloud_v2_tokens DISABLE TRIGGER execution_legacy_ticket_basis");
      await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,execution_authority)
        SELECT sha256(n::text::bytea),$1,'connect',$2,clock_timestamp()+interval '1 hour','{"signatureVersion":2,"signature":"old"}'
        FROM generate_series(1,10001) n`, [f.workspace.id, f.creator.id]);
      await client.query("SAVEPOINT guard");
      await expect(client.query(migration.match(/^DO \$\$[\s\S]*?^\$\$;/m)![0]))
        .rejects.toMatchObject({ code: "P0001", message: "cloud_execution_legacy_backfill_limit" });
      await client.query("ROLLBACK TO SAVEPOINT guard");
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE execution_authority ? 'legacyBasis'")).rows[0].n).toBe(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("renews a captured v2 context after disconnect without serializing its authority in product or worker replies", async () => {
    const context = await open();
    const old = versionTwo(await capture(pool, context.contextId));
    await pool.query("UPDATE cloud_v2_execution_contexts SET authority=$2 WHERE id=$1", [context.contextId, { signatureVersion: 2, signature: old.signature }]);
    const saved = (await pool.query("SELECT authority FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].authority;
    expect(saved.legacyBasis.workerTokenHash).toMatch(/^[a-f0-9]{64}$/);
    await pool.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]);
    const responses = [await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "GET", undefined, f.creator, { "X-Zeros-Team-Sharing": "1" }),
      await f.worker("config", undefined, { method: "GET" }), await f.worker("execution-leases/renew", { contextIds: [context.contextId] })];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(JSON.stringify(payload)).not.toMatch(/legacyBasis|workerTokenHash|execution_authority/);
      expect(JSON.stringify(payload)).not.toContain(saved.legacyBasis.workerTokenHash);
      if (payload.leases) expect(payload.leases[0]).toMatchObject({ contextId: context.contextId, expiresAt: expect.any(Number) });
    }
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [context.contextId])).rows[0].state).toBe("active");
  });
});
