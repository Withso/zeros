// The rehearsal's reads through its own liveDatabase as a read role that is neither a superuser nor a table's owner
// (pg_read_all_data, RLS on), on the migrated schema: app.system is set by its own statement before the read, so a row
// that exists is seen. The single-statement wrapper it replaces (a CTE that sets app.system, the read beside it) let the
// planner read first with the policy closed: 0 rows for a row that exists (Alpha, run 485395f0, copy_machine missing).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../../test-database.js";
import type { StageContext } from "./contract.js";
import { liveDatabase, type DatabaseClient } from "./live.js";
import { sharedBaseFacts } from "./rehearsal-cli.js";
import { newState } from "./state.js";
import { copyMachines, recordRunBases } from "./steps.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const OLD_WRAPPER = (text: string) => `WITH cfg AS MATERIALIZED (SELECT set_config('app.system','on',true) AS v)
          SELECT x.* FROM cfg CROSS JOIN LATERAL (${text}) x WHERE cfg.v = 'on'`;

d("rehearsal reads as the read role (integration)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zr_rehearsal_reader') THEN CREATE ROLE zr_rehearsal_reader NOLOGIN IN ROLE pg_read_all_data; END IF; END $$");
  });
  afterAll(() => pool.end());
  beforeEach(() => resetMigratedTestDatabase(pool));

  /** liveDatabase over a PlanetScale fake, its connection the read role (SET ROLE: RLS applies, as on Alpha). */
  const reader = () => liveDatabase({ organization: "o", database: "alpha", tokenId: "t", token: "t", roleName: kind => `r-${kind}-${randomUUID()}`,
    planetScale: async (method, path) => path === "/databases/alpha" ? { status: 200, body: { default_branch: "main" } }
      : method === "POST" ? { status: 201, body: { id: "role", name: "n", username: "u", password: "p", access_host_url: "h.example" } }
      : { status: method === "DELETE" ? 204 : 404, body: null },
    client: (): DatabaseClient => {
      const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      return { connect: async () => { await client.connect(); await client.query("SET ROLE zr_rehearsal_reader"); },
        query: (text, values) => client.query(text, values as unknown[]), end: () => client.end() };
    }, sleep: async () => {} });

  async function seed() {
    const user = randomUUID(), org = randomUUID(), project = randomUUID(), build = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, true, false)",
      [org, `org-${org}`, user]);
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, source_targets, source_policy_version,
        base_only, base_shared, automatic, snapshot_id, started_at, finished_at)
      VALUES ($1, $2, 1, '{"repositories":[]}', 'succeeded', NULL, 'manual', '[]', 2, true, true, true, $3, clock_timestamp(), clock_timestamp())`,
      [build, org, `zeros-alpha-base-a218125eb26c@${build}`]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1, $2, $3)", [org, build, `zeros-alpha-base-a218125eb26c@${build}`]);
    await pool.query("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1, $2, 'zr-485395f0-one', 'personal', $3, $3)",
      [project, org, user]);
    await pool.query(`INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, created_by, computer_build_id, built_from_base, machine_id)
      VALUES (gen_random_uuid(), $1, $2, 1, 'ready', gen_random_uuid()::text, $3, $4, $5, 'bx_copy0001')`, [org, project, user, build, `snapshot:zeros-alpha-base-a218125eb26c@${build}`]);
    return { user, org, project, build };
  }

  it("sees rows that exist, by primary key and by an indexed uuid column, which the old single-statement wrapper could hide", async () => {
    const { org, project, build } = await seed();
    const database = reader();
    try {
      // The statements that read nothing on Alpha (copyMachines, the computer by organization), and the run's base record.
      const state = newState(randomUUID(), org, new Date(Date.now() - 3_600_000), "personal");
      const ctx = { ports: { database }, state, start: () => {}, save: async () => {} } as unknown as StageContext;
      expect(await copyMachines(ctx, project)).toEqual(["bx_copy0001"]);
      expect(await database.read("SELECT org_id::text AS org FROM cloud_v2_computers WHERE org_id = $1::uuid", [org])).toEqual([{ org }]);
      expect(await database.read("SELECT id::text AS id FROM cloud_v2_computer_builds WHERE id = $1::uuid", [build])).toEqual([{ id: build }]);
      expect(await recordRunBases(ctx)).toEqual([build]);
      expect((await sharedBaseFacts(database, null, async () => true))).toMatchObject({ table: true,
        perName: [{ name: "zeros-alpha-base-a218125eb26c", organizations: 1 }], ownBases: 0 });
      // As the read role without app.system, nothing: the policy is what the set_config statement opens.
      const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query("SET ROLE zr_rehearsal_reader");
        await client.query("BEGIN READ ONLY");
        expect((await client.query("SELECT machine_id FROM cloud_v2_ready_copies WHERE project_id = $1::uuid", [project])).rows).toEqual([]);
        // The old wrapper, on the plan an index scan takes (Alpha's tables are large enough to use one): the policy is still
        // closed when the row is read.
        await client.query("SET LOCAL enable_seqscan = off");
        const old = (await client.query(OLD_WRAPPER("SELECT machine_id FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND machine_id IS NOT NULL"), [project])).rows;
        await client.query("ROLLBACK");
        expect(old).toEqual([]);
      } finally { await client.end(); }
    } finally { await database.close(); }
  });
});
