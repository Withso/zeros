import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { getSecuritySnapshot, listSecurityEvents } from "./security-events.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("security snapshot and durable targeted replay", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("returns current revisions and only events scoped to the account, session, or a visible organization", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const now = Math.floor(Date.now() / 1_000);
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${suffix}`,
      email: `events-${suffix}@example.com`,
      displayName: "Event User",
      session: {
        id: `session_${suffix}`,
        clientKind: "desktop",
        authTime: now,
        tokenExpiresAt: now + 300,
      },
    });
    // ensureUser is an exported bootstrap helper; middleware registration is
    // deliberately explicit in this lower-level integration fixture.
    await pool.query(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind,
         last_token_expires_at
       ) VALUES ($1, $2, $3, 'desktop', now() + interval '5 minutes')`,
      [user.authentication.sessionId, user.identity.subject, user.id],
    );
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations WHERE created_by = $1 AND is_personal`,
      [user.id],
    );
    const stranger = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_stranger_${suffix}`,
      email: `stranger-${suffix}@example.com`,
      displayName: "Stranger",
    });
    const visible = await pool.query<{ sequence: string | number }>(
      `INSERT INTO security_events (
         kind, user_id, org_id, account_revision,
         authorization_revision, payload
       ) VALUES (
         'organization.authorization_changed', $1, $2, 1, 2,
         '{"reason":"role_changed"}'::jsonb
       ) RETURNING sequence`,
      [user.id, personal.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO security_events (kind, user_id, account_revision)
       VALUES ('account.revoked', $1, 2)`,
      [stranger.id],
    );

    const snapshot = await getSecuritySnapshot(pool, user);
    expect(snapshot.account).toMatchObject({
      id: user.id,
      status: "active",
      revision: 1,
    });
    expect(snapshot.session).toEqual({
      id: user.authentication.sessionId,
      status: "active",
    });
    expect(snapshot.organizations).toHaveLength(1);
    expect(snapshot.cursor).toBeGreaterThanOrEqual(
      Number(visible.rows[0]!.sequence),
    );

    const events = await listSecurityEvents(pool, user, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: Number(visible.rows[0]!.sequence),
      kind: "organization.authorization_changed",
      organizationId: personal.rows[0]!.id,
      payload: { reason: "role_changed" },
    });
  });
});
