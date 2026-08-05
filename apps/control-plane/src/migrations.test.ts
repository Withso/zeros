// ──────────────────────────────────────────────────────────
// The migration ladder, actually executed.
//
// `check:control-plane-migrations` proves the ladder is append-only, but it never
// runs a line of SQL. This file does — and it exists because migration 0006
// (a destructive, irreversible rename of every tenant table) reached review
// having never executed anywhere but a developer's laptop: CI had no Postgres,
// so the whole DB suite self-skipped.
//
// What makes this worth more than "does it apply to an empty database":
// production is never empty. `runMigrations` runs at service BOOT
// (index.ts awaits it before serve()), so a migration that throws on real data
// is not a failed deploy — it is a crash-loop with no control plane. The
// upgrade-path test below is the one that models that.
//
// Runs only when TEST_DATABASE_URL points at a THROWAWAY Postgres — every test
// drops the public schema. CI provides one (preflight.yml `control-plane` job);
// locally:
//   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=t postgres:16
//   TEST_DATABASE_URL=postgres://postgres:t@localhost:5433/postgres pnpm test
// ──────────────────────────────────────────────────────────

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** Same filter + order migrate.ts uses, so the tests see the real ladder. */
const LADDER = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

d("migration ladder", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** A blank database. `CASCADE` also takes the RLS policies with the tables;
   *  the cluster-wide `zeros_app` role survives, which 0004 tolerates. */
  const reset = () =>
    pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

  /** Apply the first `count` migrations exactly the way migrate.ts does —
   *  including recording them — so a later runMigrations() picks up cleanly
   *  from that point instead of re-running what's already there. This is how
   *  we reconstruct "a database at yesterday's revision". */
  const applyThrough = async (count: number) => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of LADDER.slice(0, count)) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await pool.query("BEGIN");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
    }
  };

  const ledger = async () =>
    (
      await pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      )
    ).rows.map((r) => r.name);

  beforeEach(reset);

  it("applies cleanly to an empty database (the fresh-install path)", async () => {
    const ran = await runMigrations(pool);
    expect(ran).toEqual(LADDER);
    expect(await ledger()).toEqual(LADDER);
  });

  it("is idempotent — a redeploy re-runs nothing", async () => {
    await runMigrations(pool);
    // Railway restarts the container on every deploy, health-check retry, and
    // crash. Each one calls runMigrations again against the same database.
    expect(await runMigrations(pool)).toEqual([]);
    expect(await runMigrations(pool)).toEqual([]);
    expect(await ledger()).toEqual(LADDER);
  });

  it("applies the NEWEST migration to a database at the previous revision", async () => {
    // The actual production upgrade path, and the one a fresh-install test
    // cannot see: DDL that is fine against an empty schema can still fail
    // against the schema the previous migration left behind. Generic over the
    // ladder, so it keeps testing whatever the newest migration is.
    await applyThrough(LADDER.length - 1);
    const ran = await runMigrations(pool);
    expect(ran).toEqual([LADDER[LADDER.length - 1]]);
  });

  it("replays from every intermediate revision", async () => {
    // A deployment can be at ANY prior revision (a long-lived staging box, a
    // restored backup, a rollback). Every suffix of the ladder must apply to
    // the state its prefix leaves.
    for (let k = 0; k < LADDER.length; k++) {
      await reset();
      await applyThrough(k);
      const ran = await runMigrations(pool);
      expect(ran, `applying from revision ${k}`).toEqual(LADDER.slice(k));
    }
  });
});

// ── Per-migration data-preservation ──────────────────────
//
// Only migrations that TRANSFORM existing rows need one of these; most just add
// a table or column and the generic tests above cover them. 0006 renames every
// tenant table, moves a foreign key, and rewrites audit_log — so it gets one.
d("0006 org→team preserves existing data", () => {
  let pool: pg.Pool;
  const TEAM = "aaaaaaaa-0000-0000-0000-000000000001";
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const MEMBER = "22222222-2222-2222-2222-222222222222";
  const SUBTEAM = "bbbbbbbb-0000-0000-0000-000000000002";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Bring the database to the pre-rename revision (0005).
    for (const file of LADDER.filter((f) => f < "0006")) {
      await pool.query("BEGIN");
      await pool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
    }
    // Seed the org-era shape: a real org, two members, a NESTED sub-team, an
    // invitation pointing at that sub-team, settings, billing, and audit rows
    // in both the org.* and sub-team team.* namespaces.
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1,'owner@example.com'), ($2,'mate@example.com')`,
      [OWNER, MEMBER],
    );
    await pool.query(
      `INSERT INTO organizations (id, slug, name, logo, created_by)
       VALUES ($1,'acme','Acme','data:image/png;base64,iVBORw0KGgo=',$2)`,
      [TEAM, OWNER],
    );
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1,$2,'owner'), ($1,$3,'member')`,
      [TEAM, OWNER, MEMBER],
    );
    await pool.query(
      `INSERT INTO teams (id, org_id, name, is_default)
       VALUES ('bbbbbbbb-0000-0000-0000-000000000001',$1,'Personal',true), ($2,$1,'Design',false)`,
      [TEAM, SUBTEAM],
    );
    await pool.query(
      `INSERT INTO invitations (org_id, email, token_hash, invited_by, team_id)
       VALUES ($1,'new@example.com','\\x00112233'::bytea,$2,$3)`,
      [TEAM, OWNER, SUBTEAM],
    );
    await pool.query(
      `INSERT INTO org_settings (org_id, scope, doc)
       VALUES ($1,'*','{"git":{"base_branch":"main"}}'::jsonb)`,
      [TEAM],
    );
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_id, action)
       VALUES ($1,$2,'org.created'), ($1,$2,'org.renamed'),
              ($1,$2,'team.created'), ($1,$2,'member.invited')`,
      [TEAM, OWNER],
    );
    await pool.query(
      `INSERT INTO billing_customers (org_id, stripe_customer_id) VALUES ($1,'cus_123')`,
      [TEAM],
    );

    await runMigrations(pool); // ← 0006
  });
  afterAll(async () => {
    await pool.end();
  });

  it("carries the org across as the team, identity and all", async () => {
    const { rows } = await pool.query(
      `SELECT id, slug, name, logo, created_by FROM teams`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: TEAM, slug: "acme", name: "Acme", created_by: OWNER });
    expect(rows[0].logo).toContain("data:image/png");
  });

  it("keeps every membership and its role", async () => {
    // ORDER BY user_id, not role: `role` is the team_role ENUM, which sorts by
    // declaration order (owner, admin, member) rather than alphabetically.
    const { rows } = await pool.query(
      `SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY user_id`,
      [TEAM],
    );
    expect(rows).toEqual([
      { user_id: OWNER, role: "owner" },
      { user_id: MEMBER, role: "member" },
    ]);
  });

  it("re-points invitations at the TENANT ROOT, not the deleted sub-team", async () => {
    // The subtle one. `invitations` had BOTH org_id and a sub-team team_id;
    // after the rename only one team_id survives and it must be the org's.
    // Getting this backwards would silently invite people into a dead row.
    const { rows } = await pool.query(`SELECT email, team_id FROM invitations`);
    expect(rows).toEqual([{ email: "new@example.com", team_id: TEAM }]);
  });

  it("separates the retired sub-team history from the tenant history", async () => {
    const { rows } = await pool.query<{ action: string; n: string }>(
      `SELECT action, count(*) n FROM audit_log GROUP BY action ORDER BY action`,
    );
    // org.created/org.renamed become team.*; the sub-team's own team.created
    // moves to subteam.* so the two never merge under one name.
    expect(rows.map((r) => r.action)).toEqual([
      "member.invited",
      "subteam.created",
      "team.created",
      "team.renamed",
    ]);
  });

  it("carries settings and billing over on the renamed key", async () => {
    const settings = await pool.query(`SELECT team_id, doc FROM team_settings`);
    expect(settings.rows[0]).toMatchObject({ team_id: TEAM });
    expect(settings.rows[0].doc).toEqual({ git: { base_branch: "main" } });
    const billing = await pool.query(`SELECT team_id FROM billing_customers`);
    expect(billing.rows[0]).toEqual({ team_id: TEAM });
  });

  it("leaves no org_* identifier anywhere in the schema", async () => {
    const { rows } = await pool.query<{ leftover: string }>(`
      SELECT 'table '  || table_name AS leftover FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%org%'
      UNION ALL
      SELECT 'column ' || table_name || '.' || column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%org%'
      UNION ALL
      SELECT 'index '  || indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE '%org%'
      UNION ALL
      SELECT 'policy ' || policyname FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE '%org%'
      UNION ALL
      SELECT 'function ' || proname FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%org%'
    `);
    expect(rows.map((r) => r.leftover)).toEqual([]);
  });

  it("still enforces tenant isolation under the unprivileged app role", async () => {
    // The migration recreates the SECURITY DEFINER helper every policy keys
    // on. If that recreate were wrong, RLS would fail OPEN and every team
    // would see every other team's rows — silently, since nothing errors.
    const asUser = async (userId: string, sql: string) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE zeros_app");
        await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        const r = await c.query(sql);
        await c.query("COMMIT");
        return r.rows[0];
      } finally {
        c.release();
      }
    };
    const STRANGER = "99999999-9999-9999-9999-999999999999";

    expect(await asUser(OWNER, "SELECT count(*)::int n FROM teams")).toEqual({ n: 1 });
    expect(await asUser(STRANGER, "SELECT count(*)::int n FROM teams")).toEqual({ n: 0 });
    expect(await asUser(STRANGER, "SELECT count(*)::int n FROM team_settings")).toEqual({ n: 0 });
    expect(await asUser(STRANGER, "SELECT count(*)::int n FROM audit_log")).toEqual({ n: 0 });
  });
});
