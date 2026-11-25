import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localCommandsFixture, type LocalCommandsFixture } from "./local-commands/test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("recovering a failed cloud workspace", () => {
  let pool: pg.Pool, f: LocalCommandsFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await localCommandsFixture(pool); });
  afterEach(async () => { await f.signals.close(); });

  const fail = (patch: { error_code?: string | null; boat_sandbox_id?: string | null; running_at?: "now" | null; checkpoint_object?: string | null } = {}) =>
    pool.query(`UPDATE cloud_v2_workspaces SET state='failed', error_code=$2, boat_sandbox_id=$3, active_at=now(), running_at=CASE WHEN $4::boolean THEN now() ELSE NULL END,
      checkpoint_object=$5, checkpoint_key=CASE WHEN $5::text IS NULL THEN NULL ELSE '{"sealed":"fixture"}'::jsonb END,
      checkpoint_sha256=CASE WHEN $5::text IS NULL THEN NULL ELSE repeat('a', 64) END, checkpoint_bytes=CASE WHEN $5::text IS NULL THEN NULL ELSE 100 END,
      checkpoint_saved_at=CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, attempts=3, next_attempt_at=now() WHERE id=$1`, [f.workspaceId, patch.error_code === undefined ? "worker_boot_timeout" : patch.error_code,
      patch.boat_sandbox_id === undefined ? "bx_fixture1" : patch.boat_sandbox_id, patch.running_at !== null, patch.checkpoint_object ?? null]);
  const row = async () => (await pool.query(`SELECT state, error_code, attempts, next_attempt_at, stop_generation::text AS gen,
    restart_stop_generation::text AS restart FROM cloud_v2_workspaces WHERE id=$1`, [f.workspaceId])).rows[0];
  const recover = (actor = f.owner.id) => f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}/recover`, "POST", {}, { "x-test-actor": actor });

  it("marks only a recoverable failed workspace's document", async () => {
    await fail();
    expect((await (await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}`)).json()).workspace).toMatchObject({ state: "failed", recoverable: true });
    await fail({ error_code: "sandbox_missing" });
    expect((await (await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}`)).json()).workspace).not.toHaveProperty("recoverable");
  });

  it("starts it as an ordinary start would, in the same stop generation", async () => {
    await fail();
    const before = await row();
    const response = await recover();
    expect(response.status).toBe(202);
    const body = await response.json();
    // The first failure stays until a boot reaches running (default-create.integration.test.ts). The generation is the
    // one whose scrub, checkpoint and restore the start still has to honour.
    expect(await row()).toEqual({ state: "starting", error_code: "worker_boot_timeout", attempts: 0, next_attempt_at: null, gen: before.gen, restart: null });
    expect(body.workspace).toMatchObject({ state: "starting" });
    expect(body.workspace).not.toHaveProperty("recoverable");
  });

  it("recovers a failed restore from its backup when the machine is gone, without a stop that could allocate one", async () => {
    await fail({ error_code: "checkpoint_restore_failed", boat_sandbox_id: null, checkpoint_object: `cloud-v2/checkpoints/${f.workspaceId}/${randomUUID()}.zck` });
    await pool.query(`UPDATE cloud_v2_workspaces SET restore_pending=true, restore_attempt=gen_random_uuid(),
      restore_create=jsonb_build_object('from', null, 'name', 'zeros-restore', 'env', '{}'::jsonb, 'requestedAt', clock_timestamp()),
      checkpoint_stop_generation=stop_generation WHERE id=$1`, [f.workspaceId]);
    const before = await row();
    expect((await recover()).status).toBe(202);
    const after = await pool.query("SELECT state, restore_pending, stop_generation::text AS gen, checkpoint_stop_generation::text AS saved FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId]);
    // Still the checkpoint's own generation, so the restore is not taken for an earlier backup (lost work).
    expect(after.rows[0]).toEqual({ state: "starting", restore_pending: true, gen: before.gen, saved: before.gen });
  });

  it("keeps what was sent during a Stop that failed when the heal gives the run its ordinary stop", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping', boat_sandbox_id='bx_fixture1', running_at=now() WHERE id=$1", [f.workspaceId]);
    const sent = f.prompt();
    expect((await f.submit(sent)).status).toBeLessThan(300);
    await pool.query("UPDATE cloud_v2_workspaces SET state='failed', error_code='provider_request_failed', updated_at=now() - interval '11 minutes' WHERE id=$1", [f.workspaceId]);
    const [candidate] = await f.store.healCandidates(new Date(Date.now() - 10 * 60_000), 4);
    expect(candidate).toMatchObject({ ran: true, interruptedStop: false });
    expect(await f.store.healFailed(candidate!, "stopping")).toBe(true);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].state).toBe("stopping");
    const message = (await pool.query("SELECT state, wake_after_stop FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
      [f.workspaceId, sent.userMessageId])).rows[0];
    expect(message).toEqual({ state: "queued", wake_after_stop: true });
  });

  it("records when an accepted hello brings the workspace into running", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='starting', running_at=NULL WHERE id=$1", [f.workspaceId]);
    const token = await f.store.rotateWorkerToken(f.workspaceId);
    await f.store.acceptWorkerHello(token, randomUUID());
    const after = (await pool.query("SELECT state, running_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0];
    expect(after.state).toBe("running");
    expect(after.running_at).toEqual(expect.any(Date));
  });

  it("backfills when a workspace ran under row security, from a completed stop or a finished setup, never from activity or a hello alone", async () => {
    const migration = readFileSync(new URL("../../migrations/0273_cloud_v2_running_at.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf("SELECT set_config('app.system','on',true)"),
      migration.indexOf("set_config('app.cloud_execution_protocol','',true);") + "set_config('app.cloud_execution_protocol','',true);".length);
    expect(backfill.length).toBeGreaterThan(100);
    const role = `heal_backfill_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; GRANT zeros_app TO ${role}`);
    const seed = (patch: string) => pool.query(`UPDATE cloud_v2_workspaces SET running_at=NULL, ${patch} WHERE id=$1`, [f.workspaceId]);
    const backfilled = async () => {
      const client = await pool.connect();
      try { await client.query(`BEGIN; SET LOCAL ROLE ${role}`); await client.query(backfill); await client.query("COMMIT"); }
      finally { client.release(); }
      return (await pool.query("SELECT running_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].running_at !== null;
    };
    try {
      await seed("state='failed', error_code='live_connection_unavailable', stopped_at=now(), active_at=now()");
      expect(await backfilled()).toBe(true);
      await seed("state='failed', error_code='worker_boot_timeout', stopped_at=NULL, active_at=now(), setup_status=NULL");
      expect(await backfilled()).toBe(false);
      await seed(`state='failed', setup_status='{"state":"succeeded","exitCode":0,"startedAt":1,"finishedAt":2}'::jsonb`);
      expect(await backfilled()).toBe(true);
      // A hello binds its boot before configuration finishes: not proof the workspace reached running.
      await seed(`state='failed', error_code='worker_boot_timeout', setup_status=NULL, worker_boot_id=gen_random_uuid()`);
      expect(await backfilled()).toBe(false);
      // A shared workspace is visible to the app role only with the execution protocol marker as well.
      await seed(`state='failed', worker_boot_id=NULL, setup_status='{"state":"succeeded","exitCode":0,"startedAt":1,"finishedAt":2}'::jsonb, execution_mode='active'`);
      expect(await backfilled()).toBe(true);
    } finally {
      await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });

  it("keeps what was sent during a Stop that failed when that Stop is finished in its own generation", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopping', boat_sandbox_id='bx_fixture1', running_at=now() WHERE id=$1", [f.workspaceId]);
    const sent = f.prompt();
    expect((await f.submit(sent)).status).toBeLessThan(300);
    await pool.query("UPDATE cloud_v2_workspaces SET state='failed', error_code='provider_request_failed', updated_at=now() - interval '11 minutes' WHERE id=$1", [f.workspaceId]);
    const [candidate] = await f.store.healCandidates(new Date(Date.now() - 10 * 60_000), 4);
    expect(await f.store.healFailed({ ...candidate!, interruptedStop: true }, "stopping")).toBe(true);
    const message = (await pool.query("SELECT state, wake_after_stop FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
      [f.workspaceId, sent.userMessageId])).rows[0];
    expect(message).toEqual({ state: "queued", wake_after_stop: true });
  });

  it("refuses what trying again cannot fix, a create that never ran, and anything not failed, changing nothing", async () => {
    for (const patch of [{ error_code: "sandbox_missing" }, { error_code: "github_access_required" }, { error_code: "checkpoint_restore_failed" },
      { running_at: null }, { boat_sandbox_id: null }] as const) {
      await fail(patch);
      const before = await row(), response = await recover();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "workspace_not_recoverable" } });
      expect(await row()).toEqual(before);
    }
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped', error_code=NULL WHERE id=$1", [f.workspaceId]);
    expect((await recover()).status).toBe(409);
    expect((await row()).state).toBe("stopped");
  });

  it("tells a wake breaker whether any workspace entered running since it opened", async () => {
    const opened = new Date(Date.now() - 30 * 60_000);
    await pool.query("UPDATE cloud_v2_workspaces SET running_at = CASE WHEN running_at > $1 THEN $1 - interval '1 hour' ELSE running_at END", [opened]);
    expect(await f.store.wakeSucceededSince(opened)).toBe(false);
    // Entered running since, but no longer running: read only from running rows, so not counted.
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped', running_at=now() WHERE id=$1", [f.workspaceId]);
    expect(await f.store.wakeSucceededSince(opened)).toBe(false);
    await pool.query("UPDATE cloud_v2_workspaces SET state='running', boat_sandbox_id=coalesce(boat_sandbox_id,'bx_fixture1'), running_at=now() WHERE id=$1", [f.workspaceId]);
    expect(await f.store.wakeSucceededSince(opened)).toBe(true);
  });

  it("is the Creator's alone", async () => {
    await fail();
    const before = await row();
    expect((await recover(f.other.id)).status).toBe(404);
    expect(await row()).toEqual(before);
  });
});
