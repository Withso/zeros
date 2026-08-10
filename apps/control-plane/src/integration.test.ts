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

  /** Mirror POST /v1/organizations' atomic bootstrap. */
  const createOrganization = async (
    ownerId: string,
    name: string,
    logo: string | null = null,
  ) =>
    withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, logo, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
          name,
          logo,
          ownerId,
        ],
      );
      const orgId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [orgId, ownerId],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [orgId, ownerId],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [team.rows[0]!.id, orgId, ownerId],
      );
      return orgId;
    });

  it("signup provisions exactly one permanent Personal organization and default team", async () => {
    const { id } = await signup("Test User");
    const again = await signup(); // a different identity → a different user
    expect(again.id).not.toBe(id);

    const organizations = await pool.query(
      `SELECT id, name, is_personal, cloud_workspaces_allowed
       FROM organizations WHERE created_by = $1`,
      [id],
    );
    expect(organizations.rows).toHaveLength(1);
    expect(organizations.rows[0]).toMatchObject({
      name: "Test User",
      is_personal: true,
      cloud_workspaces_allowed: false,
    });
    const memberships = await pool.query(
      `SELECT om.role AS organization_role, tm.role AS team_role
       FROM organization_members om
       JOIN teams t ON t.org_id = om.org_id AND t.is_default
       JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = om.user_id
       WHERE om.user_id = $1`,
      [id],
    );
    expect(memberships.rows).toEqual([
      { organization_role: "owner", team_role: "maintainer" },
    ]);
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
      await pool.query(
        `UPDATE users SET staff_role = 'developer' WHERE id = $1`,
        [before.id],
      );

      // ensureUser runs on EVERY authenticated request, so the role is visible
      // on the next call with no token to wait out. Same in reverse: this is
      // what makes revocation instant.
      const after = await ensureUser(pool, u);
      expect(after.staffRole).toBe("developer");

      await pool.query(`UPDATE users SET staff_role = NULL WHERE id = $1`, [
        before.id,
      ]);
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
          tx.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [
            id,
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);

      // System context runs as the SAME zeros_app role, so it is refused too —
      // no application code path can grant staff, deliberately.
      await expect(
        withSystemTx(pool, (tx) =>
          tx.query(`UPDATE users SET staff_role = 'developer' WHERE id = $1`, [
            id,
          ]),
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
      await pool.query(
        `UPDATE users SET staff_role = 'developer' WHERE id = $1`,
        [id],
      );
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
    const users = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [
      first.id,
    ]);
    expect(users.rowCount).toBe(1);
  });

  it("repairs an imported account when a legacy organization owns its preferred Personal slug", async () => {
    const { id: legacyOwner } = await signup();
    const userId = randomUUID();
    const sub = randomUUID();
    const email = `imported-${sub}@example.com`;
    const preferredSlug = `personal-${userId.replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Imported')`,
      [userId, email],
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub)
       VALUES ($1, 'auth0', $2)`,
      [userId, sub],
    );
    await pool.query(
      `INSERT INTO organizations (slug, name, created_by)
       VALUES ($1, 'Legacy slug squatter', $2)`,
      [preferredSlug, legacyOwner],
    );

    await expect(
      ensureUser(pool, {
        provider: "auth0",
        providerSub: sub,
        email,
        displayName: "Imported",
      }),
    ).resolves.toMatchObject({ id: userId });
    const personal = await pool.query<{ slug: string }>(
      `SELECT slug FROM organizations
       WHERE created_by = $1 AND is_personal AND deleted_at IS NULL`,
      [userId],
    );
    expect(personal.rows).toHaveLength(1);
    expect(personal.rows[0]!.slug).toMatch(
      new RegExp(`^${preferredSlug}-[0-9a-f]{32}$`),
    );
  });

  it("serializes concurrent first requests for the same identity", async () => {
    const sub = randomUUID();
    const input = {
      provider: "auth0",
      providerSub: sub,
      email: `parallel-${sub}@example.com`,
      displayName: "Parallel",
    };
    const [first, second] = await Promise.all([
      ensureUser(pool, input),
      ensureUser(pool, input),
    ]);
    expect(second.id).toBe(first.id);
    const result = await pool.query<{ users: number; personal: number }>(
      `SELECT
         count(DISTINCT u.id)::int AS users,
         count(DISTINCT o.id)::int AS personal
       FROM users u
       LEFT JOIN organizations o
         ON o.created_by = u.id AND o.is_personal AND o.deleted_at IS NULL
       WHERE u.email = $1`,
      [input.email],
    );
    expect(result.rows[0]).toEqual({ users: 1, personal: 1 });
  });

  it("stores and returns the organization logo data URL", async () => {
    const { id } = await signup();
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const orgId = await createOrganization(id, "Logoful", logo);
    const back = await pool.query<{ logo: string | null }>(
      `SELECT logo FROM organizations WHERE id = $1`,
      [orgId],
    );
    expect(back.rows[0]!.logo).toBe(logo);
  });

  it("a deleted organization's invites stop resolving", async () => {
    const { id } = await signup();
    const orgId = await createOrganization(id, "Doomed");
    const tokenHash = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO invitations (org_id, email, token_hash, invited_by)
         VALUES ($1, 'x@example.com', $2, $3)`,
        [orgId, tokenHash, id],
      ),
    );

    await pool.query(`UPDATE organizations SET deleted_at = now() WHERE id = $1`, [
      orgId,
    ]);

    // The accept path's join must refuse invites into a deleted team.
    const inv = await pool.query(
      `SELECT i.id FROM invitations i
       JOIN organizations o ON o.id = i.org_id AND o.deleted_at IS NULL
       WHERE i.token_hash = $1
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [tokenHash],
    );
    expect(inv.rowCount).toBe(0);
  });

  it("removes a soft-deleted organization from former members' RLS scope", async () => {
    const { id } = await signup();
    const orgId = await createOrganization(id, "Invisible");
    await pool.query(`UPDATE organizations SET deleted_at = now() WHERE id = $1`, [
      orgId,
    ]);

    const visible = await withUserTx(pool, id, (tx) =>
      tx.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]),
    );
    expect(visible.rowCount).toBe(0);
  });

  it("self-leave succeeds under USER-context RLS (audit before the membership delete)", async () => {
    // Replays the DELETE /members/:user handler's exact statement ORDER in
    // the member's own RLS context. The order is load-bearing: once the
    // actor's membership row is gone, app_user_org_ids() drops the org, so
    // an audit INSERT after the delete violates its WITH CHECK.
    const { id: owner } = await signup();
    const { id: member } = await signup();
    const orgId = await createOrganization(owner, "LeaveCo");
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [orgId, member],
      ),
    );

    await withUserTx(pool, member, async (tx) => {
      await tx.query(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
        [orgId, member],
      );
      await tx.query(
        `INSERT INTO audit_log (org_id, actor_id, action, subject)
         VALUES ($1, $2, 'member.left', '{}')`,
        [orgId, member],
      );
      await tx.query(
        `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
        [orgId, member],
      );
    });

    const membership = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, member],
    );
    expect(membership.rowCount).toBe(0);
    const auditRows = await pool.query(
      `SELECT 1 FROM audit_log WHERE org_id = $1 AND actor_id = $2 AND action = 'member.left'`,
      [orgId, member],
    );
    expect(auditRows.rowCount).toBe(1);
  });

  it("serializes concurrent owner departures so an organization can never reach zero owners", async () => {
    // Two owners, both leave at once. The organization-row lock
    // must serialize them: exactly one succeeds, the other hits last_owner.
    const { id: o1 } = await signup();
    const { id: o2 } = await signup();
    const orgId = await createOrganization(o1, "Shared");
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [orgId, o2],
    );

    // Mirror the delete handler's owner-departure logic in two parallel txns.
    const leave = (leaver: string) =>
      withSystemTx(pool, async (tx) => {
        await tx.query(
          `SELECT role FROM organization_members
           WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
          [orgId, leaver],
        );
        await tx.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [
          orgId,
        ]);
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM organization_members
           WHERE org_id = $1 AND role = 'owner'`,
          [orgId],
        );
        if (Number(rows[0]!.n) <= 1) throw new Error("last_owner");
        await tx.query(
          `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
          [orgId, leaver],
        );
      });

    const results = await Promise.allSettled([leave(o1), leave(o2)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1); // exactly one left; the other was blocked
    const owners = await pool.query(
      `SELECT count(*)::int AS n FROM organization_members
       WHERE org_id = $1 AND role = 'owner'`,
      [orgId],
    );
    expect(owners.rows[0].n).toBe(1); // never zero
  });

  it("keeps one pending invite per email", async () => {
    const { id } = await signup();
    const orgId = await createOrganization(id, "Invariants");

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO invitations (org_id, email, token_hash, invited_by)
         VALUES ($1, 'x@example.com', $2, $3)`,
        [orgId, Buffer.from(randomUUID().replaceAll("-", ""), "hex"), id],
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO invitations (org_id, email, token_hash, invited_by)
           VALUES ($1, 'x@example.com', $2, $3)`,
          [orgId, Buffer.from(randomUUID().replaceAll("-", ""), "hex"), id],
        ),
      ),
    ).rejects.toThrow(/one_pending_invite|duplicate key/);
  });

  it("keeps the Organization → default Team hierarchy explicit", async () => {
    const { id } = await signup();
    const orgId = await createOrganization(id, "Hierarchy");
    const result = await pool.query(
      `SELECT o.id AS organization_id, t.id AS team_id, t.is_default
       FROM organizations o JOIN teams t ON t.org_id = o.id
       WHERE o.id = $1`,
      [orgId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      organization_id: orgId,
      is_default: true,
    });
    expect(result.rows[0].team_id).not.toBe(orgId);
  });

  it("isolates personal GitHub installations while allowing one GitHub installation to be authorized by several users", async () => {
    const { id: userA } = await signup();
    const { id: userB } = await signup();
    const installationId = 987654321;

    await withSystemTx(pool, async (tx) => {
      for (const [owner, login] of [
        [userA, "account-a"],
        [userB, "account-b"],
      ] as const) {
        await tx.query(
          `INSERT INTO github_installations (
             github_installation_id, app_variant, owner_user_id,
             account_login, account_type, target_type, repository_count,
             all_repositories
           ) VALUES ($1, 'github.com', $2, $3, 'Organization',
                     'Organization', 3, false)`,
          [installationId, owner, login],
        );
      }
    });

    const visibleToA = await withUserTx(pool, userA, (tx) =>
      tx.query<{ account_login: string }>(
        `SELECT account_login FROM github_installations ORDER BY account_login`,
      ),
    );
    const visibleToB = await withUserTx(pool, userB, (tx) =>
      tx.query<{ account_login: string }>(
        `SELECT account_login FROM github_installations ORDER BY account_login`,
      ),
    );
    expect(visibleToA.rows).toEqual([{ account_login: "account-a" }]);
    expect(visibleToB.rows).toEqual([{ account_login: "account-b" }]);
  });

  it("makes GitHub OAuth handoffs single-owner under RLS", async () => {
    const { id: owner } = await signup();
    const { id: other } = await signup();
    const nonceHash = Buffer.alloc(32, 7);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO github_oauth_handoffs (
           nonce_hash, owner_user_id, app_variant, access_token_sealed,
           access_token_expires_at, refresh_token_sealed,
           refresh_token_expires_at, login, installations_complete,
           expires_at
         ) VALUES (
           $1, $2, 'github.com', '\\x00'::bytea,
           now() + interval '8 hours', '\\x01'::bytea,
           now() + interval '6 months', 'octocat', true,
           now() + interval '1 minute'
         )`,
        [nonceHash, owner],
      ),
    );

    const stolen = await withUserTx(pool, other, (tx) =>
      tx.query(
        `DELETE FROM github_oauth_handoffs
         WHERE nonce_hash = $1 RETURNING login`,
        [nonceHash],
      ),
    );
    expect(stolen.rowCount).toBe(0);

    const redeemed = await withUserTx(pool, owner, (tx) =>
      tx.query(
        `DELETE FROM github_oauth_handoffs
         WHERE nonce_hash = $1 RETURNING login`,
        [nonceHash],
      ),
    );
    expect(redeemed.rows).toEqual([{ login: "octocat" }]);
  });
});
