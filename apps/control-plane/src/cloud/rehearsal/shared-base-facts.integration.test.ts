// The rehearsal's reads of the shared base and the run's bases against the migrated schema (0267, 0268): the --plan
// precondition reads the real table, in the live read role's RLS-safe form, and the run's base record finds only
// automatic bases made after the run started.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../../test-database.js";
import type { Database, StageContext } from "./contract.js";
import { rlsSafe } from "./live.js";
import { sharedBaseFacts } from "./rehearsal-cli.js";
import { newState } from "./state.js";
import { recordRunBases } from "./steps.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const RUNTIME = "1a2b3c4d5e6f".padEnd(64, "0"), OLDER = "0123456789ab".padEnd(64, "0");

d("rehearsal shared base reads (integration)", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
  afterAll(() => pool.end());
  beforeEach(() => resetMigratedTestDatabase(pool));
  // As the live read role runs them: app.system set in a materialized CTE.
  const reads = { read: async (text: string, values?: unknown[]) => (await pool.query(rlsSafe(text), values as unknown[])).rows };
  const base = (name: string, runtime: string, state: string) => pool.query(
    `INSERT INTO cloud_v2_shared_bases (name, channel, runtime_sha256, state, ready_at) VALUES ($1, 'alpha', $2, $3, CASE WHEN $3 = 'ready' THEN clock_timestamp() END)`,
    [name, runtime, state]);

  it("reports the pinned runtime's shared base, whether Boat has it, and organizations per shared base", async () => {
    expect(await sharedBaseFacts(reads, RUNTIME, async () => true)).toEqual({ table: true, pinned: null, atBoat: null, perName: [], ownBases: 0 });
    await base(`zeros-alpha-base-${OLDER.slice(0, 12)}`, OLDER, "ready");
    await base(`zeros-alpha-base-${RUNTIME.slice(0, 12)}`, RUNTIME, "building");
    expect(await sharedBaseFacts(reads, RUNTIME, async () => false)).toMatchObject({ pinned: { name: `zeros-alpha-base-${RUNTIME.slice(0, 12)}`, state: "building" }, atBoat: false });
    await pool.query("UPDATE cloud_v2_shared_bases SET state = 'ready', ready_at = clock_timestamp() WHERE runtime_sha256 = $1", [RUNTIME]);
    // One organization on the shared base, one on its own.
    const user = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    for (const [org, snapshot] of [[randomUUID(), `zeros-alpha-base-${RUNTIME.slice(0, 12)}@${randomUUID()}`], [randomUUID(), "zeros-alpha-own-v1"]] as const) {
      await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
        [org, `org-${org}`, user]);
      await pool.query("INSERT INTO cloud_v2_computers (org_id, snapshot_name) VALUES ($1, $2)", [org, snapshot]);
    }
    expect(await sharedBaseFacts(reads, RUNTIME, async name => name === `zeros-alpha-base-${RUNTIME.slice(0, 12)}`)).toEqual({ table: true,
      pinned: { name: `zeros-alpha-base-${RUNTIME.slice(0, 12)}`, state: "ready" }, atBoat: true,
      perName: [{ name: `zeros-alpha-base-${RUNTIME.slice(0, 12)}`, organizations: 1 }], ownBases: 1 });
  });

  it("records only automatic bases its organization made after the run started", async () => {
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)",
      [org, `org-${org}`, user]);
    const insert = (automatic: boolean, createdAgo: string) => pool.query(
      `INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, source_targets, source_policy_version, base_only, automatic, created_at)
       VALUES (gen_random_uuid(), $1, (SELECT coalesce(max(version), 0) + 1 FROM cloud_v2_computer_builds WHERE org_id = $1), '{"repositories":[]}', 'queued',
         $2, 'manual', '[]', 2, true, $3, clock_timestamp() - $4::interval) RETURNING id`, [org, automatic ? null : user, automatic, createdAgo]);
    await insert(true, "2 hours");
    const state = newState(randomUUID(), org, new Date(Date.now() - 60 * 60_000), "personal");
    await insert(false, "1 minute");
    const ours = (await insert(true, "1 minute")).rows[0]!.id as string;
    let starts = 0;
    const database: Database = { read: reads.read, transaction: async () => { throw new Error("no writes"); }, close: async () => {} };
    const ctx = { ports: { database }, state, start: () => { starts++; }, save: async () => {} } as unknown as StageContext;
    expect(await recordRunBases(ctx)).toEqual([ours]);
    expect(starts).toBe(1);
    expect(await recordRunBases(ctx)).toEqual([ours]);
    expect(starts).toBe(1);
  });
});
