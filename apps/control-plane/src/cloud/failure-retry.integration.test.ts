import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloudV2RecoverableFailure, cloudV2RecoverableFailureSql } from "./failure-retry.js";
import { localCommandsFixture, type LocalCommandsFixture } from "./local-commands/test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("the recoverable-failure rule in SQL", () => {
  let pool: pg.Pool, f: LocalCommandsFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 5000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => { f = await localCommandsFixture(pool); });
  afterEach(async () => { await f.signals.close(); });

  const set = (id: string, row: { state?: string; error_code?: string | null; running_at?: boolean; boat_sandbox_id?: string | null; checkpoint?: boolean }) =>
    pool.query(`UPDATE cloud_v2_workspaces SET state=$2, error_code=$3, active_at=now(), running_at=CASE WHEN $4::boolean THEN now() - interval '1 day' ELSE NULL END,
      boat_sandbox_id=$5, checkpoint_object=CASE WHEN $6::boolean THEN 'cloud-v2/checkpoints/' || id || '/' || gen_random_uuid() || '.zck' ELSE NULL END,
      checkpoint_key=CASE WHEN $6::boolean THEN '{"sealed":"fixture"}'::jsonb ELSE NULL END, checkpoint_sha256=CASE WHEN $6::boolean THEN repeat('a', 64) ELSE NULL END,
      checkpoint_bytes=CASE WHEN $6::boolean THEN 100 ELSE NULL END, checkpoint_saved_at=CASE WHEN $6::boolean THEN now() ELSE NULL END,
      updated_at=now() - interval '1 hour' WHERE id=$1`,
    [id, row.state ?? "failed", row.error_code === undefined ? "worker_boot_timeout" : row.error_code, row.running_at ?? true,
      row.boat_sandbox_id === undefined ? "bx_fixture1" : row.boat_sandbox_id, row.checkpoint ?? false]);

  it("decides exactly as the classifier does", async () => {
    const cases = [{}, { running_at: false }, { boat_sandbox_id: null }, { boat_sandbox_id: null, checkpoint: true },
      { error_code: "checkpoint_restore_failed" }, { error_code: "checkpoint_restore_failed", checkpoint: true }, { error_code: "sandbox_missing" },
      { error_code: null }, { state: "stopped" }, { error_code: "live_connection_unavailable" }, { error_code: "provider_route_invalid", boat_sandbox_id: null }];
    for (const row of cases) {
      await set(f.workspaceId, row);
      const read = (await pool.query(`SELECT w.*, (${cloudV2RecoverableFailureSql("w")}) AS sql_recoverable FROM cloud_v2_workspaces w WHERE id=$1`, [f.workspaceId])).rows[0];
      expect({ row, recoverable: read.sql_recoverable }).toEqual({ row, recoverable: cloudV2RecoverableFailure(read) });
    }
  });

  it("lets a younger recoverable failure through when older failures that cannot be recovered fill a batch", async () => {
    const older: string[] = [];
    for (let i = 0; i < 4; i++) {
      const created = await f.store.createWorkspace({ id: randomUUID(), organizationId: f.organizationId, creatorUserId: f.owner.id, name: `Older ${i}`,
        repository: "example/project", branch: `older-${i}`, baseBranch: "main", computerBuildId: null });
      await set(created.id, { running_at: false, boat_sandbox_id: `bx_older${i}` });
      await pool.query("UPDATE cloud_v2_workspaces SET updated_at=now() - interval '2 hours' WHERE id=$1", [created.id]);
      older.push(created.id);
    }
    await set(f.workspaceId, {});
    const candidates = await f.store.healCandidates(new Date(Date.now() - 10 * 60_000), 4);
    expect(candidates.map(candidate => candidate.id)).toEqual([f.workspaceId]);
  });
});
