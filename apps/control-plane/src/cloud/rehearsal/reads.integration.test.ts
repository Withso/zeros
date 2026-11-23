// Every statement the rehearsal reads (the catalog, checked complete in rehearsal.test.ts) through its own liveDatabase
// as a pg_read_all_data role with RLS on (neither superuser nor table owner), on the migrated schema: each sees a row
// that exists. With app.system set any other way than by its own statement first, a row can read as none.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { REHEARSAL_READS, type ReadSeed } from "../__fixtures__/rehearsal-reads.js";
import { liveDatabase, type DatabaseClient } from "./live.js";
import { BACKUP_STATE } from "./stage-retention.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("every rehearsal read, as the read role (integration)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zr_rehearsal_reader') THEN CREATE ROLE zr_rehearsal_reader NOLOGIN IN ROLE pg_read_all_data; END IF; END $$");
  });
  afterAll(() => pool.end());
  beforeEach(() => resetMigratedTestDatabase(pool));

  const reader = () => liveDatabase({ organization: "o", database: "alpha", tokenId: "t", token: "t", roleName: kind => `r-${kind}-${randomUUID()}`,
    planetScale: async (method, path) => path === "/databases/alpha" ? { status: 200, body: { default_branch: "main" } }
      : method === "POST" ? { status: 201, body: { id: "role", name: "n", username: "u", password: "p", access_host_url: "h.example" } }
      : { status: method === "DELETE" ? 204 : 404, body: null },
    client: (): DatabaseClient => {
      const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      return { connect: async () => { await client.connect(); await client.query("SET ROLE zr_rehearsal_reader"); },
        query: (text, values) => client.query(text, values as unknown[]), end: () => client.end() };
    }, sleep: async () => {} });

  /** One of everything the rehearsal reads, as a run would leave it. */
  async function seed(): Promise<ReadSeed> {
    const s: ReadSeed = { user: randomUUID(), owner: randomUUID(), org: randomUUID(), project: randomUUID(), workspace: randomUUID(), other: randomUUID(),
      build: randomUUID(), startedAt: new Date(Date.now() - 3_600_000).toISOString(), prefix: "zr-0123abcd-", runtime: "1a2b3c4d5e6f".padEnd(64, "0"),
      probeSlug: `probe-${randomUUID().slice(0, 8)}` };
    const q = (text: string, values: unknown[] = []) => pool.query(text, values);
    await q("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U'), ($3, $4, 'Owner')", [s.user, `u-${s.user}@example.test`, s.owner, `o-${s.owner}@example.test`]);
    await q("UPDATE users SET staff_role = 'platform_owner' WHERE id = $1", [s.owner]);
    await q("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, true, false)", [s.org, `org-${s.org}`, s.user]);
    // The probe organization (not Personal: only it can be linked to WorkOS), which also holds a Computer on its own base.
    await q("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Other', $3, false, true)", [s.other, s.probeSlug, s.user]);
    await q("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [s.org, s.user]);
    await q("INSERT INTO workos_organization_links (organization_id, external_id, workos_organization_id) VALUES ($1, $2, 'org_fixture')", [s.other, s.other]);
    await q(`INSERT INTO account_entitlements (user_id, plan, status, source, cloud_workspaces_allowed, valid_from)
      VALUES ($1, 'pro', 'active', 'operator', true, clock_timestamp())`, [s.user]);
    await q(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, created_by, reason, source_targets, source_policy_version,
        base_only, base_shared, automatic, snapshot_id, snapshot_deleted_at, started_at, finished_at)
      VALUES ($1, $2, 1, '{"repositories":[]}', 'succeeded', NULL, 'manual', '[]', 2, true, true, true, $3, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [s.build, s.org, `zeros-alpha-base-${s.runtime.slice(0, 12)}@${s.build}`]);
    // Two organizations' computers: one on the shared base, one on its own.
    await q("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1, $2, $3)", [s.org, s.build, `zeros-alpha-base-${s.runtime.slice(0, 12)}@${s.build}`]);
    await q("INSERT INTO cloud_v2_computers (org_id, snapshot_name) VALUES ($1, 'zeros-alpha-own-v1')", [s.other]);
    await q(`INSERT INTO cloud_v2_shared_bases (name, channel, runtime_sha256, state, ready_at) VALUES ($1, 'alpha', $2, 'ready', clock_timestamp())`,
      [`zeros-alpha-base-${s.runtime.slice(0, 12)}`, s.runtime]);
    await q("INSERT INTO cloud_projects (id, org_id, name, level, owner_user_id, created_by) VALUES ($1, $2, $3, 'personal', $4, $4)", [s.project, s.org, `${s.prefix}one`, s.user]);
    const copy = randomUUID();
    await q(`INSERT INTO cloud_v2_ready_copies (id, org_id, project_id, generation, state, idempotency_key, created_by, computer_build_id, built_from_base, machine_id, result)
      VALUES ($1, $2, $3, 1, 'ready', gen_random_uuid()::text, $4, $5, $6, 'bx_copy0001', '[]'::jsonb)`,
      [copy, s.org, s.project, s.user, s.build, `snapshot:zeros-alpha-base-${s.runtime.slice(0, 12)}@${s.build}`]);
    await q(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, project_id, computer_build_id,
        waiting_for_base_at, backup_probe, archive_scrub, archive_scrubbed_at)
      VALUES ($1, $2, $3, $4, 'withso/zeros-dev-fixture', $5, 'main', 'stopped', $6, $7, clock_timestamp(), 'dirty', 'backup', clock_timestamp())`,
      [s.workspace, s.org, s.user, `${s.prefix}one-w`, `${s.prefix}one`, s.project, s.build]);
    await q("INSERT INTO cloud_v2_ready_copy_forks (workspace_id, org_id, copy_id, fork_key, completed_at) VALUES ($1, $2, $3, 'fork-1', clock_timestamp())",
      [s.workspace, s.org, copy]);
    await q("INSERT INTO cloud_v2_workspace_submodules (workspace_id, position, path, status, repository, repository_id, commit, git_dir, public) VALUES ($1, 0, 'vendor/hello', 'fetch', 'octocat/hello-world', '1296269', $2, $3, true)",
      [s.workspace, "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d", `modules/${"a".repeat(64)}`]);
    for (const kind of ["backup_fork", "wake"])
      await q("INSERT INTO cloud_v2_maintenance_wakes (workspace_id, attempt, kind, outcome) VALUES ($1, gen_random_uuid(), $2, 'stopped')", [s.workspace, kind]);
    return s;
  }

  it("sees a row that exists through each statement", async () => {
    const s = await seed();
    const database = reader();
    const blind: string[] = [];
    try {
      for (const entry of REHEARSAL_READS) {
        const rows = await database.read(entry.text, entry.values(s));
        if (!rows.length || (entry.sees && !entry.sees(rows))) blind.push(entry.name);
      }
    } finally { await database.close(); }
    expect(blind).toEqual([]);
    expect(REHEARSAL_READS.length).toBeGreaterThanOrEqual(28);
  });

  it("reads a backup fork's result from the workspace row: its maintenance-wakes row is never finished", async () => {
    const s = await seed();
    // As the product leaves it (store.ts beginCheckpointFork inserts the row; nothing finishes it), with this stop's backup saved.
    await pool.query("UPDATE cloud_v2_maintenance_wakes SET outcome = NULL, finished_at = NULL WHERE workspace_id = $1 AND kind = 'backup_fork'", [s.workspace]);
    await pool.query(`UPDATE cloud_v2_workspaces SET checkpoint_object = 'cloud-v2/checkpoints/' || id::text || '/' || gen_random_uuid()::text || '.zck',
      checkpoint_key = '{"v":1}'::jsonb, checkpoint_sha256 = repeat('a', 64), checkpoint_bytes = 4737,
      checkpoint_stop_generation = stop_generation, checkpoint_saved_at = clock_timestamp() WHERE id = $1`, [s.workspace]);
    const database = reader();
    try {
      expect(await database.read(BACKUP_STATE, [s.workspace])).toEqual([{ forks: 1, backed_up: true, fork_gone: true }]);
      // The statement the stage waited on before: it never sees this backup.
      expect(await database.read(`SELECT count(*)::int AS forks FROM cloud_v2_maintenance_wakes
        WHERE workspace_id = $1::uuid AND kind = 'backup_fork' AND outcome = 'stopped'`, [s.workspace])).toEqual([{ forks: 0 }]);
    } finally { await database.close(); }
  });
});
