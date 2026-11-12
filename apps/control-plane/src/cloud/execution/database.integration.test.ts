import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "../../db.js";
import { SYSTEM_DATABASE_CONTEXT, USER_DATABASE_CONTEXT } from "../../db-context.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const evidence = (value: unknown) => {
  const line = JSON.stringify(value);
  console.info("[execution database proof]", line);
  if (process.env.CLOUD_EXECUTION_PROOF_PATH) appendFileSync(process.env.CLOUD_EXECUTION_PROOF_PATH, `${line}\n`);
};
database("execution migration roles, erasure and zero-context cost", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.cp.loginChanges.stop(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const client = async () => {
    await f.activate(); expect((await f.hello()).status).toBe(200);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    return f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!);
  };
  it("preserves released auth, prompt, lifecycle and security-event SQL as zeros_app/system", async () => {
    await withSystemTx(pool, async tx => {
      expect((await tx.query("SELECT current_user,app_is_system() AS system")).rows[0]).toEqual({ current_user: "zeros_app", system: true });
      const sid = `session_${randomUUID()}`;
      await tx.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
        VALUES('workos',$1,$2,$3,'desktop',now()+interval '5 minutes') ON CONFLICT(provider,provider_session_id) DO NOTHING`, [sid, f.viewer.identity.subject, f.viewer.id]);
      await tx.query(`UPDATE auth_sessions SET user_id=coalesce(user_id,$2),client_kind=CASE WHEN client_kind='unknown' THEN 'desktop' ELSE client_kind END,
        last_token_expires_at=greatest(last_token_expires_at,now()+interval '10 minutes'),last_seen_at=now() WHERE provider_session_id=$1 AND status='active'`, [sid, f.viewer.id]);
      await tx.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at,last_provider_event_at)
        VALUES($1,$2,$3,'unknown','active',now()+interval '1 day',now()) ON CONFLICT(provider,provider_session_id) DO UPDATE
        SET provider_session_expires_at=EXCLUDED.provider_session_expires_at,last_provider_event_at=EXCLUDED.last_provider_event_at WHERE auth_sessions.status='active'`, [sid, f.viewer.identity.subject, f.viewer.id]);
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'old-chat')", [f.workspace.id]);
      await tx.query("UPDATE cloud_v2_prompt_chats SET epoch=epoch+1,next_sequence=next_sequence+1 WHERE workspace_id=$1", [f.workspace.id]);
      await tx.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1,updated_at=clock_timestamp() WHERE id=$1", [f.workspace.id]);
      await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now(),revocation_reason='account_deletion_scheduled' WHERE user_id=$1 AND status='active'", [f.viewer.id]);
      await tx.query("INSERT INTO security_events(kind,user_id,provider_session_id) VALUES('session.revoked',$1,$2)", [f.viewer.id, sid]);
      await tx.query("DELETE FROM auth_sessions WHERE provider_session_id=$1", [sid]);
      expect((await tx.query("SELECT execution_mode FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].execution_mode).toBe("legacy");
      expect((await tx.query("SELECT 1 FROM cloud_v2_execution_contexts")).rowCount).toBe(0);
    });
    expect((await withUserTx(pool, f.viewer.id, tx => tx.query("UPDATE auth_sessions SET status='revoked' WHERE user_id=$1", [f.viewer.id]))).rowCount).toBe(0);
    expect((await withUserTx(pool, f.viewer.id, tx => tx.query("SELECT 1 FROM cloud_v2_execution_contexts"))).rowCount).toBe(0);
  });

  it.each([false, true])("does not break a non-system session writer and still refuses the filtered context at use time (N-1=%s)", async old => {
    const handle = await client(), current = await f.cp.execution.clients.current(f.workspace.id, handle.contextId);
    const tx = await pool.connect();
    try {
      // Auth sessions currently have only a system policy. A rollback-only
      // session policy exercises an invoker whose context UPDATE is RLS-filtered.
      await tx.query("BEGIN");
      await tx.query("CREATE POLICY execution_test_session_writer ON auth_sessions USING (true) WITH CHECK (true)");
      await tx.query("SET LOCAL ROLE zeros_app");
      await tx.query(old ? "SELECT set_config('app.user_id',$1,true)" : USER_DATABASE_CONTEXT, [f.viewer.id]);
      expect((await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId])).rowCount).toBe(1);
      await tx.query(SYSTEM_DATABASE_CONTEXT);
      expect((await tx.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [handle.contextId])).rows[0].state).toBe("active");
      await expect(f.cp.execution.assertContext(tx, current.context, current.proof)).rejects.toMatchObject({ code: "actor_changed" });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("keeps an erased person's cleanup barrier and rejects cross-workspace context links", async () => {
    await f.login(f.viewer); await f.activate(); expect((await f.hello()).status).toBe(200);
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await pool.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'foreign')", [f.own.id]);
    await expect(pool.query("UPDATE cloud_v2_prompt_chats SET active_context_id=$2 WHERE workspace_id=$1 AND chat_id='foreign'", [f.own.id, turn.begun.contextId]))
      .rejects.toMatchObject({ code: "23503" });
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.own.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [f.viewer.id]);
    expect((await pool.query("SELECT user_id,state,material,environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0])
      .toEqual({ user_id: null, state: "revoked", material: null, environment_version_id: null });
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_tokens WHERE context_id=$1", [turn.begun.contextId])).rowCount).toBe(0);
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id]);
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts")).rowCount).toBe(0);
  });

  const historical = async () => {
    await pool.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,access_epoch,stop_generation,worker_boot_id,
      worker_token_hash,authority,source_fingerprint,expires_at,state,retired_at)
      SELECT gen_random_uuid(),$1,$2,$3,'client',gen_random_uuid(),0,0,gen_random_uuid(),decode(repeat('ab',32),'hex'),'{}',repeat('a',64),now(),'retired',now()
      FROM generate_series(1,5000)`, [f.workspace.id, f.organizationId, f.creator.id]);
    await pool.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'old-chat')", [f.workspace.id]);
    await pool.query(`INSERT INTO cloud_v2_prompt_outbox(workspace_id,user_message_id,chat_id,creator_user_id,sequence,epoch,access_epoch,payload_hash,payload_bytes,receipt,state,terminal_at)
      SELECT $1,'old-'||n,'old-chat',$2,n,0,0,repeat('a',64),0,'{}','completed',now() FROM generate_series(1,5000) n`, [f.workspace.id, f.creator.id]);
    await pool.query("ANALYZE cloud_v2_execution_contexts"); await pool.query("ANALYZE cloud_v2_prompt_outbox");
  };
  it("uses indexed zero-row paths for empty authority and pending-outbox revocations", async () => {
    await historical();
    const cases: Array<[string, string, unknown[]]> = [
      ["workspace", "workspace_id=$1 AND state='active'", [f.workspace.id]],
      ["session", "user_id=$1 AND provider_session_id=$2 AND state='active' AND kind IN ('client','terminal')", [f.viewer.id, f.viewer.authentication.sessionId]],
      ["account/security/member", "user_id=$1 AND state='active' AND (org_id=$2 OR $2::uuid IS NULL)", [f.viewer.id, f.organizationId]],
      ["organization", "org_id=$1 AND state='active'", [f.organizationId]],
      ["credential", "credential_id=$1 AND state='active'", [randomUUID()]],
      ["entitlement", "org_id IN (SELECT org_id FROM organization_members WHERE user_id=$1) AND state='active' AND organization_member_on_hold(org_id,user_id,10,5)", [f.viewer.id]],
      ["source", "user_id=$1 AND org_id=$2 AND state='active' AND source_fingerprint=$3 AND EXISTS(SELECT 1 FROM cloud_v2_github_sources s WHERE s.workspace_id=cloud_v2_execution_contexts.workspace_id AND s.repository_id=42)", [f.viewer.id, f.organizationId, "a".repeat(64)]],
    ];
    const indexes = (plan: any): string[] => [...(plan["Index Name"] ? [plan["Index Name"]] : []), ...(plan.Plans ?? []).flatMap(indexes)];
    await withSystemTx(pool, async tx => {
      for (const [name, predicate, values] of cases) {
        const plan = (await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) WITH target AS MATERIALIZED (
          SELECT id FROM cloud_v2_execution_contexts WHERE ${predicate} ORDER BY id FOR UPDATE
        ) UPDATE cloud_v2_execution_contexts SET state='revoked' WHERE id IN (SELECT id FROM target)`, values)).rows[0]["QUERY PLAN"][0];
        expect(plan.Plan["Actual Rows"]).toBe(0);
        expect(indexes(plan.Plan).some(name => name.startsWith("cloud_execution_") && !name.includes("retirement"))).toBe(true);
        evidence({ path: name, indexes: indexes(plan.Plan), milliseconds: plan["Execution Time"], rows: plan.Plan["Actual Rows"] });
      }
      const plan = (await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) INSERT INTO cloud_v2_execution_invalidations(workspace_id,user_id)
        SELECT DISTINCT p.workspace_id,NULL::uuid FROM cloud_v2_prompt_outbox p JOIN cloud_v2_workspaces w ON w.id=p.workspace_id
        WHERE w.execution_mode='active' AND w.org_id=$1 AND p.state IN ('queued','inboxed','dispatching','accepted')`, [f.organizationId])).rows[0]["QUERY PLAN"][0];
      expect(plan.Plan["Actual Rows"]).toBe(0);
      expect(indexes(plan.Plan).some(name => name === "cloud_v2_prompts_pending" || name === "cloud_execution_pending_sender")).toBe(true);
      evidence({ path: "organization-outbox", indexes: indexes(plan.Plan), milliseconds: plan["Execution Time"], rows: 0 });
    });
  });

  // Setup and eight rollback-only 1,000-row samples share this case's budget.
  it("measures ordinary session and security writes before/after the new triggers with no active contexts", async () => {
    await historical();
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status)
      SELECT 'workos','cost-'||n,$1,$2,'desktop','active' FROM generate_series(1,1000) n`, [f.viewer.identity.subject, f.viewer.id]);
    const costs: Record<string, number[]> = {};
    const measure = async (name: string, enabled: boolean, table: string, trigger: string, write: (tx: Tx) => Promise<unknown>) => {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        if (!enabled) await tx.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        await tx.query("SET LOCAL ROLE zeros_app"); await tx.query("SELECT set_config('app.system','on',true)");
        const start = performance.now(); await write(tx); const elapsed = performance.now() - start;
        (costs[name] ??= []).push(Number(elapsed.toFixed(3)));
      } finally { await tx.query("ROLLBACK"); tx.release(); }
    };
    for (const enabled of [false, true, false, true]) {
      await measure(enabled ? "security_after" : "security_before", enabled, "security_events", "execution_security_fence", tx => tx.query(
        "INSERT INTO security_events(kind,user_id,account_revision) SELECT 'account.authorization_changed',$1,1 FROM generate_series(1,1000)", [f.viewer.id]));
      await measure(enabled ? "sessions_after" : "sessions_before", enabled, "auth_sessions", "execution_session_fence", tx => tx.query(
        "UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id LIKE 'cost-%'"));
    }
    expect((await pool.query("SELECT 1 FROM cloud_v2_execution_contexts WHERE state='active'")).rowCount).toBe(0);
    evidence({ millisecondsPer1000: costs });
  }, 15_000);
});
