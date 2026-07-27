// Integration tests — run only when TEST_DATABASE_URL points at a throwaway
// Postgres (they migrate + write). Skipped otherwise, so `pnpm test` stays
// green with no database around.
//
//   docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=t postgres:16
//   TEST_DATABASE_URL=postgres://postgres:t@localhost:5433/postgres pnpm test

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runMigrations } from "./migrate.js";
import { ensureUser } from "./auth.js";
import { withSystemTx, withUserTx } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("schema + signup transaction", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  const signup = async (displayName: string | null = null) => {
    const sub = randomUUID();
    return ensureUser(pool, {
      provider: "auth0",
      providerSub: sub,
      email: `t-${sub}@example.com`,
      displayName,
    });
  };

  /** Mirror POST /v1/teams' bootstrap (team + owner membership).
   *  System context like the route itself: user-context RLS can't insert a
   *  brand-new team (ON CONFLICT/RETURNING apply USING to the new row) — the
   *  2026-07-22 review C1 finding that moved the route to withSystemTx. */
  const createTeam = async (ownerId: string, name: string, logo: string | null = null) =>
    withSystemTx(pool, async (tx) => {
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (slug, name, logo, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, name, logo, ownerId],
      );
      const teamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [teamId, ownerId],
      );
      return teamId;
    });

  it("signup provisions the user + identity only — NO team is auto-created", async () => {
    const { id } = await signup("Test User");
    const again = await signup(); // a different identity → a different user
    expect(again.id).not.toBe(id);

    const teams = await pool.query(`SELECT 1 FROM teams WHERE created_by = $1`, [id]);
    expect(teams.rowCount).toBe(0);
    const memberships = await pool.query(
      `SELECT 1 FROM team_members WHERE user_id = $1`,
      [id],
    );
    expect(memberships.rowCount).toBe(0);
  });

  describe("staff_role (0007)", () => {
    it("defaults to null and is picked up by the very next request once granted", async () => {
      const sub = randomUUID();
      const u = {
        provider: "auth0",
        providerSub: sub,
        email: `t-${sub}@example.com`,
        displayName: "Staffer",
      };
      // A fresh signup is never staff — the correct default for every row.
      const before = await ensureUser(pool, u);
      expect(before.staffRole).toBeNull();

      // Granting is a DBA/migration-owner UPDATE, the only sanctioned path.
      await pool.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [
        before.id,
      ]);

      // ensureUser runs on EVERY authenticated request, so the role is visible
      // on the next call with no token to wait out. Same in reverse: this is
      // what makes revocation instant.
      const after = await ensureUser(pool, u);
      expect(after.staffRole).toBe("developer");

      await pool.query(`UPDATE users SET staff_role = NULL WHERE id = $1`, [before.id]);
      expect((await ensureUser(pool, u)).staffRole).toBeNull();
    });

    it("cannot be self-granted: zeros_app holds no UPDATE privilege on the column", async () => {
      const { id } = await signup();

      // users_rw deliberately allows a user to UPDATE THEIR OWN row
      // (WITH CHECK … OR id = app_current_user()), which is what makes profile
      // edits work. So RLS alone would let anyone promote themselves the moment
      // staff_role landed on the table. 0007's column-level GRANT is the actual
      // boundary — assert it, because a future migration re-widening the grant
      // would otherwise be a silent privilege escalation.
      await expect(
        withUserTx(pool, id, (tx) =>
          tx.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [id]),
        ),
      ).rejects.toThrow(/permission denied/i);

      // System context runs as the SAME zeros_app role, so it is refused too —
      // no application code path can grant staff, deliberately.
      await expect(
        withSystemTx(pool, (tx) =>
          tx.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [id]),
        ),
      ).rejects.toThrow(/permission denied/i);

      const check = await pool.query<{ staff_role: string | null }>(
        `SELECT staff_role FROM users WHERE id = $1`,
        [id],
      );
      expect(check.rows[0]!.staff_role).toBeNull();
    });

    it("still allows the profile columns ensureUser actually writes", async () => {
      const { id } = await signup();
      // The mirror in ensureUser updates email + display_name; narrowing the
      // grant must not have broken it (that would 500 every request).
      await expect(
        withSystemTx(pool, (tx) =>
          tx.query(
            `UPDATE users SET email = $2, display_name = $3 WHERE id = $1`,
            [id, `moved-${randomUUID()}@example.com`, "Renamed"],
          ),
        ),
      ).resolves.toBeDefined();
    });

    it("stays readable — the app gates the Internal tab on it", async () => {
      const { id } = await signup();
      await pool.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [id]);
      const { rows } = await withUserTx(pool, id, (tx) =>
        tx.query<{ staff_role: string | null }>(
          `SELECT staff_role FROM users WHERE id = $1`,
          [id],
        ),
      );
      expect(rows[0]!.staff_role).toBe("developer");
    });
  });

  it("signup is idempotent for the same identity", async () => {
    const sub = randomUUID();
    const u = {
      provider: "auth0",
      providerSub: sub,
      email: `t-${sub}@example.com`,
      displayName: "Twice",
    };
    const first = await ensureUser(pool, u);
    const second = await ensureUser(pool, u);
    expect(second.id).toBe(first.id);
    const users = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [first.id]);
    expect(users.rowCount).toBe(1);
  });

  it("stores and returns the team logo data URL", async () => {
    const { id } = await signup();
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const teamId = await createTeam(id, "Logoful", logo);
    const back = await pool.query<{ logo: string | null }>(
      `SELECT logo FROM teams WHERE id = $1`,
      [teamId],
    );
    expect(back.rows[0]!.logo).toBe(logo);
  });

  it("an owner can soft-delete any team, and its invites stop resolving", async () => {
    const { id } = await signup();
    const teamId = await createTeam(id, "Doomed");
    const tokenHash = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO invitations (team_id, email, token_hash, invited_by)
         VALUES ($1, 'x@example.com', $2, $3)`,
        [teamId, tokenHash, id],
      ),
    );

    await pool.query(`UPDATE teams SET deleted_at = now() WHERE id = $1`, [teamId]);

    // The accept path's join must refuse invites into a deleted team.
    const inv = await pool.query(
      `SELECT i.id FROM invitations i
       JOIN teams t ON t.id = i.team_id AND t.deleted_at IS NULL
       WHERE i.token_hash = $1
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [tokenHash],
    );
    expect(inv.rowCount).toBe(0);
  });

  it("self-leave succeeds under USER-context RLS (audit before the membership delete)", async () => {
    // Replays the DELETE /members/:user handler's exact statement ORDER in
    // the member's own RLS context. The order is load-bearing: once the
    // actor's membership row is gone, app_user_team_ids() drops the team, so
    // an audit INSERT after the delete violates its WITH CHECK — the
    // 2026-07-22 review C2 finding.
    const { id: owner } = await signup();
    const { id: member } = await signup();
    const teamId = await createTeam(owner, "LeaveCo");
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [teamId, member],
      ),
    );

    await withUserTx(pool, member, async (tx) => {
      await tx.query(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [teamId, member],
      );
      await tx.query(
        `INSERT INTO audit_log (team_id, actor_id, action, subject) VALUES ($1, $2, 'member.left', '{}')`,
        [teamId, member],
      );
      await tx.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        member,
      ]);
    });

    const membership = await pool.query(
      `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, member],
    );
    expect(membership.rowCount).toBe(0);
    const auditRows = await pool.query(
      `SELECT 1 FROM audit_log WHERE team_id = $1 AND actor_id = $2 AND action = 'member.left'`,
      [teamId, member],
    );
    expect(auditRows.rowCount).toBe(1);
  });

  it("serializes concurrent owner departures so a team can never reach zero owners", async () => {
    // Two owners, both leave at once. The team-row lock in assertNotLastOwner
    // must serialize them: exactly one succeeds, the other hits last_owner.
    const { id: o1 } = await signup();
    const { id: o2 } = await signup();
    const teamId = await createTeam(o1, "Shared");
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [teamId, o2],
    );

    // Mirror the delete handler's owner-departure logic in two parallel txns.
    const leave = (leaver: string) =>
      withSystemTx(pool, async (tx) => {
        await tx.query(
          `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
          [teamId, leaver],
        );
        await tx.query(`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM team_members WHERE team_id = $1 AND role = 'owner'`,
          [teamId],
        );
        if (Number(rows[0]!.n) <= 1) throw new Error("last_owner");
        await tx.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
          teamId,
          leaver,
        ]);
      });

    const results = await Promise.allSettled([leave(o1), leave(o2)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1); // exactly one left; the other was blocked
    const owners = await pool.query(
      `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'owner'`,
      [teamId],
    );
    expect(owners.rows[0].n).toBe(1); // never zero
  });

  it("keeps one pending invite per email", async () => {
    const { id } = await signup();
    const teamId = await createTeam(id, "Invariants");

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO invitations (team_id, email, token_hash, invited_by)
         VALUES ($1, 'x@example.com', $2, $3)`,
        [teamId, Buffer.from(randomUUID().replaceAll("-", ""), "hex"), id],
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO invitations (team_id, email, token_hash, invited_by)
           VALUES ($1, 'x@example.com', $2, $3)`,
          [teamId, Buffer.from(randomUUID().replaceAll("-", ""), "hex"), id],
        ),
      ),
    ).rejects.toThrow(/one_pending_invite|duplicate key/);
  });

  it("leaves ONE flat Team level after 0006 — no org_* names, no sub-teams", async () => {
    // The old two-level model is gone. Three things must all hold, and the
    // third is the one a partial rename would break: `invitations.team_id`
    // has to point at the TENANT ROOT now, not at a surviving sub-team.
    const orgish = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('organizations', 'organization_members', 'org_settings', 'org_secrets')`,
    );
    expect(orgish.rowCount).toBe(0);

    const orgCols = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'org_id'`,
    );
    expect(orgCols.rowCount).toBe(0);

    const fk = await pool.query<{ referenced: string }>(
      `SELECT confrelid::regclass::text AS referenced
       FROM pg_constraint
       WHERE conrelid = 'invitations'::regclass AND contype = 'f'
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                             WHERE attrelid = 'invitations'::regclass
                               AND attname = 'team_id')]`,
    );
    expect(fk.rows[0]?.referenced).toBe("teams");
  });
});
