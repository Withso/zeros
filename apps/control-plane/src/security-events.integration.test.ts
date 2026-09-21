import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { getSecuritySnapshot, listSecurityEvents, publishPendingSecurityEvents } from "./security-events.js";

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

  it("stops organization replay after session revocation while retaining the exact terminal notification", async () => {
    const suffix=randomUUID(),now=Math.floor(Date.now()/1000);
    const user=await ensureUser(pool,{provider:"workos",providerSubject:`user_stream_${suffix}`,email:`stream-${suffix}@example.test`,displayName:"Stream",
      session:{id:`session_${suffix}`,clientKind:"desktop",authTime:now,tokenExpiresAt:now+300}});
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES ($1,$2,$3,'desktop',now()+interval '5 minutes')",
      [user.authentication.sessionId,user.identity.subject,user.id]);
    const org=(await pool.query("SELECT id FROM organizations WHERE created_by=$1 AND is_personal",[user.id])).rows[0].id;
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[user.authentication.sessionId]);
    await pool.query("INSERT INTO security_events(kind,user_id,provider_session_id) VALUES ('session.revoked',$1,$2)",[user.id,user.authentication.sessionId]);
    await pool.query("INSERT INTO security_events(kind,org_id,payload) VALUES ('organization.data_changed',$1,'{\"private\":true}')",[org]);
    const events=await listSecurityEvents(pool,user,0);
    expect(events.map(event=>event.kind)).toEqual(['session.revoked']);
    expect(events.some(event=>event.payload.private)).toBe(false);
  });

  it("does not replay tenant data to expired or superseded identities", async () => {
    const suffix=randomUUID();
    const user=await ensureUser(pool,{provider:"workos",providerSubject:`user_expired_${suffix}`,email:`expired-${suffix}@example.test`,displayName:"Expired"});
    const org=(await pool.query("SELECT id FROM organizations WHERE created_by=$1 AND is_personal",[user.id])).rows[0].id;
    await pool.query("INSERT INTO security_events(kind,org_id) VALUES ('organization.data_changed',$1)",[org]);
    const expired={...user,authentication:{...user.authentication,tokenExpiresAt:Math.floor(Date.now()/1000)-1}};
    expect(await listSecurityEvents(pool,expired,0)).toEqual([]);
    await pool.query("UPDATE user_identities SET status='superseded' WHERE user_id=$1",[user.id]);
    expect(await listSecurityEvents(pool,user,0)).toEqual([]);
  });

  it("cannot skip an earlier event when independent writers try to commit in reverse order", async () => {
    const user = await ensureUser(pool, {
      provider: "workos", providerSubject: `user_order_${randomUUID()}`,
      email: `order-${randomUUID()}@example.com`, displayName: "Order fixture",
    });
    const first = await pool.connect();
    const second = await pool.connect();
    let secondCommitted = false;
    let secondWrite: Promise<unknown> | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const { rows: [backend] } = await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await first.query("INSERT INTO security_events (kind, user_id, payload) VALUES ('account.authorization_changed', $1, '{\"writer\":\"first\"}')", [user.id]);
      secondWrite = second.query("INSERT INTO security_events (kind, user_id, payload) VALUES ('account.authorization_changed', $1, '{\"writer\":\"second\"}')", [user.id])
        .then(() => second.query("COMMIT"))
        .then(() => { secondCommitted = true; });
      // Observe a real lock wait or a completed second commit, not a sleep
      // which could accidentally pass because the network was slow.
      await vi.waitFor(async () => {
        const state = await pool.query<{ wait_event_type: string | null }>("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [backend!.pid]);
        expect(secondCommitted || state.rows[0]?.wait_event_type === "Lock").toBe(true);
      });
      const early = await listSecurityEvents(pool, user, 0);
      const cursor = early.at(-1)?.sequence ?? 0;
      await first.query("COMMIT");
      await secondWrite;
      const later = await listSecurityEvents(pool, user, cursor);
      expect([...early, ...later].map((event) => event.payload.writer).sort()).toEqual(["first", "second"]);
      expect(later[0]!.sequence).toBeGreaterThan(cursor);
    } finally {
      await first.query("ROLLBACK");
      await secondWrite?.catch(() => {});
      await second.query("ROLLBACK");
      first.release(); second.release();
    }
  });

  it("never advances the snapshot cursor past a concurrent authorization change it did not read", async () => {
    const suffix = randomUUID();
    const user = await ensureUser(pool, {
      provider: "workos", providerSubject: `user_snapshot_${suffix}`,
      email: `snapshot-${suffix}@example.com`, displayName: "Snapshot fixture",
    });
    let concurrentSequence = 0;
    const snapshotPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("ORDER BY o.is_personal")) {
            const changed = await pool.query<{ sequence: string }>(
              `INSERT INTO security_events (kind, user_id, account_revision)
               VALUES ('account.authorization_changed', $1, 2) RETURNING sequence`,
              [user.id],
            );
            await publishPendingSecurityEvents(pool);
            const published = await pool.query("SELECT delivery_sequence FROM security_events WHERE sequence = $1", [changed.rows[0]!.sequence]);
            concurrentSequence = Number(published.rows[0].delivery_sequence);
          }
          return result;
        },
        release: (discard?: boolean) => client.release(discard),
      };
      },
    } as unknown as pg.Pool;
    const snapshot = await getSecuritySnapshot(snapshotPool, user);
    expect(concurrentSequence).toBeGreaterThan(0);
    expect(snapshot.cursor).toBeLessThan(concurrentSequence);
    expect(await listSecurityEvents(pool, user, snapshot.cursor)).toEqual(
      expect.arrayContaining([expect.objectContaining({ sequence: concurrentSequence })]),
    );
  });

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

  it("replays a session revocation only to the exact session, not sibling devices", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const now = Math.floor(Date.now() / 1_000);
    const currentSessionId = `session_current_${suffix}`;
    const siblingSessionId = `session_sibling_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_sessions_${suffix}`,
      email: `session-events-${suffix}@example.com`,
      displayName: "Session Event User",
      session: {
        id: currentSessionId,
        clientKind: "desktop",
        authTime: now,
        tokenExpiresAt: now + 300,
      },
    });
    await pool.query(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind,
         last_token_expires_at
       ) VALUES
         ($1, $3, $4, 'desktop', now() + interval '5 minutes'),
         ($2, $3, $4, 'web', now() + interval '5 minutes')`,
      [currentSessionId, siblingSessionId, user.identity.subject, user.id],
    );
    const revoked = await pool.query<{ sequence: string | number }>(
      `INSERT INTO security_events (
         kind, user_id, provider_session_id, payload
       ) VALUES (
         'session.revoked', $1, $2,
         '{"reason":"workos_session_revoked"}'::jsonb
       ) RETURNING sequence`,
      [user.id, siblingSessionId],
    );

    expect(await listSecurityEvents(pool, user, 0)).toEqual([]);

    const siblingUser = {
      ...user,
      authentication: {
        ...user.authentication,
        sessionId: siblingSessionId,
        clientKind: "web" as const,
      },
    };
    const siblingEvents = await listSecurityEvents(pool, siblingUser, 0);
    expect(siblingEvents).toHaveLength(1);
    expect(siblingEvents[0]).toMatchObject({
      sequence: Number(revoked.rows[0]!.sequence),
      kind: "session.revoked",
      payload: { reason: "workos_session_revoked" },
    });
  });
});
