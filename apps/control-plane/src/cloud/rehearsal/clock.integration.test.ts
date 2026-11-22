// shiftClock against the migrated schema: its statements run, it moves exactly the run's own rows and their wake
// records, and it refuses anything else without changing a row.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { shiftClock } from "./clock.js";
import { RehearsalFailure, type Database, type Query } from "./contract.js";
import { newState } from "./state.js";
import { rlsSafe } from "./live.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("rehearsal shiftClock (integration)", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
  afterAll(() => pool.end());
  beforeEach(() => resetMigratedTestDatabase(pool));

  /** The live adapter's shape over the test pool. */
  const database = (): Database => ({
    async read(text, values) { return (await pool.query(text, values as unknown[])).rows; },
    async transaction(work) {
      const client = await pool.connect();
      const query: Query = async (text, values) => { const result = await client.query(text, values as unknown[]); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; };
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.system','on',true)");
        const result = await work(query);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async close() { /* the pool is the suite's */ },
  });

  async function fixture() {
    const user = randomUUID(), org = randomUUID(), other = randomUUID(), build = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    for (const id of [org, other]) {
      await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)", [id, `org-${id}`, user]);
      await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [id, user]);
    }
    await pool.query("INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, source_policy_version, snapshot_id) VALUES ($1,$2,1,'{\"repositories\":[]}','succeeded',$3,2,'zeros-base')", [build, org, user]);
    const state = newState(randomUUID(), org, new Date());
    const workspace = async (name: string, organization = org) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, computer_build_id,
        stopped_at, active_at, archived_at) VALUES ($1,$2,$3,$4,'withso/zeros-dev-fixture','b','main','stopped',$5,
        '2026-11-01T00:00:00.123456Z','2026-10-31T00:00:00Z',NULL)`, [id, organization, user, name, organization === org ? build : null]);
      return id;
    };
    return { state, user, other, workspace };
  }
  const row = async (id: string) => (await pool.query("SELECT stopped_at, active_at, archived_at, updated_at FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];

  it("moves every set retention stamp and the wake records of the run's own workspaces by exactly the shift", async () => {
    const { state, workspace } = await fixture();
    const mine = await workspace(`${state.prefix}w`), untouched = await workspace(`${state.prefix}x`);
    state.created.workspaces.push(mine, untouched);
    await pool.query("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind, started_at, finished_at, outcome) VALUES ($1,$2,'wake','2026-11-02T00:00:00Z','2026-11-02T00:05:00Z','stopped')",
      [mine, randomUUID()]);
    const before = await row(mine), other = await row(untouched);
    expect(await shiftClock(database(), state, [mine], 10.6)).toEqual({ workspaces: 1, wakes: 1 });
    const after = await row(mine), seconds = Math.round(10.6 * 86_400);
    expect(before.stopped_at.getTime() - after.stopped_at.getTime()).toBe(seconds * 1000);
    expect(before.active_at.getTime() - after.active_at.getTime()).toBe(seconds * 1000);
    expect(after.archived_at).toBeNull();
    // Microseconds survive the shift: the read-back compares them exactly.
    expect((await pool.query("SELECT to_char(stopped_at AT TIME ZONE 'UTC', 'US') AS us FROM cloud_v2_workspaces WHERE id=$1", [mine])).rows[0].us).toBe("123456");
    const wake = (await pool.query("SELECT started_at FROM cloud_v2_maintenance_wakes WHERE workspace_id=$1", [mine])).rows[0];
    expect(new Date("2026-11-02T00:00:00Z").getTime() - wake.started_at.getTime()).toBe(seconds * 1000);
    expect(await row(untouched)).toEqual(other);
    expect(state.shifts).toBe(1);
  });

  it("refuses an unprefixed row, another organization's, a deleted one, and too many, changing nothing", async () => {
    const { state, other, workspace } = await fixture();
    const plain = await workspace("not-the-run"), foreign = await workspace(`${state.prefix}f`, other), gone = await workspace(`${state.prefix}g`);
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [gone]);
    const mine = await workspace(`${state.prefix}w`);
    state.created.workspaces.push(plain, foreign, gone, mine);
    const snapshot = await pool.query("SELECT id, stopped_at FROM cloud_v2_workspaces ORDER BY id");
    for (const ids of [[plain], [foreign], [gone], [mine, plain]])
      await expect(shiftClock(database(), state, ids, 1)).rejects.toMatchObject({ code: "refused" });
    await expect(shiftClock(database(), state, [mine, mine, mine, mine, mine], 1)).rejects.toBeInstanceOf(RehearsalFailure);
    await expect(shiftClock(database(), state, [randomUUID()], 1)).rejects.toMatchObject({ code: "not_this_run" });
    expect((await pool.query("SELECT id, stopped_at FROM cloud_v2_workspaces ORDER BY id")).rows).toEqual(snapshot.rows);
    expect(state.shifts).toBe(0);
  });

  it("the read role's RLS-safe form sees system-only rows that a plain read as pg_read_all_data does not", async () => {
    const { state, user } = await fixture();
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, created_by) VALUES ($1,$2,$3,'organization',$4)", [randomUUID(), state.organizationId, `${state.prefix}p`, user]);
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zr_rehearsal_reader') THEN CREATE ROLE zr_rehearsal_reader NOLOGIN IN ROLE pg_read_all_data; END IF; END $$");
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE zr_rehearsal_reader");
      const text = "SELECT count(*)::int AS projects FROM cloud_projects WHERE left(name, length($1)) = $1";
      expect((await client.query(text, [state.prefix])).rows[0].projects).toBe(0);
      expect((await client.query(rlsSafe(text), [state.prefix])).rows[0].projects).toBe(1);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
});
