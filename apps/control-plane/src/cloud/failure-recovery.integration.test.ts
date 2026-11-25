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

  const fail = (patch: { error_code?: string | null; boat_sandbox_id?: string | null; active_at?: "now" | null; checkpoint_object?: string | null } = {}) =>
    pool.query(`UPDATE cloud_v2_workspaces SET state='failed', error_code=$2, boat_sandbox_id=$3, active_at=CASE WHEN $4::boolean THEN now() ELSE NULL END,
      checkpoint_object=$5, checkpoint_key=CASE WHEN $5::text IS NULL THEN NULL ELSE '{"sealed":"fixture"}'::jsonb END,
      checkpoint_sha256=CASE WHEN $5::text IS NULL THEN NULL ELSE repeat('a', 64) END, checkpoint_bytes=CASE WHEN $5::text IS NULL THEN NULL ELSE 100 END,
      checkpoint_saved_at=CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, attempts=3, next_attempt_at=now() WHERE id=$1`, [f.workspaceId, patch.error_code === undefined ? "worker_boot_timeout" : patch.error_code,
      patch.boat_sandbox_id === undefined ? "bx_fixture1" : patch.boat_sandbox_id, patch.active_at !== null, patch.checkpoint_object ?? null]);
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

  it("refuses what trying again cannot fix, a create that never ran, and anything not failed, changing nothing", async () => {
    for (const patch of [{ error_code: "sandbox_missing" }, { error_code: "github_access_required" }, { error_code: "checkpoint_restore_failed" },
      { active_at: null }, { boat_sandbox_id: null }] as const) {
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

  it("is the Creator's alone", async () => {
    await fail();
    const before = await row();
    expect((await recover(f.other.id)).status).toBe(404);
    expect(await row()).toEqual(before);
  });
});
