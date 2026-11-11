import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, type AuthedUser } from "./auth.js";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { createSecurityEventRoutes, PostgresSecurityEventBroker } from "./security-events.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("security event stream token lifetime through the router and PostgreSQL", () => {
  let pool: pg.Pool, app: Hono, user: AuthedUser, broker: PostgresSecurityEventBroker;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 10_000 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const suffix = randomUUID(), now = Math.floor(Date.now()/1000);
    user = await ensureUser(pool, { provider: "workos", providerSubject: `user_stream_${suffix}`, email: `stream-${suffix}@example.test`, displayName: "Stream",
      session: { id: `session_${suffix}`, clientKind: "desktop", authTime: now, tokenExpiresAt: now+300 } });
    await pool.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at,provider_session_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '5 minutes',now()+interval '1 day')`, [user.authentication.sessionId, user.identity.subject, user.id]);
    broker = new PostgresSecurityEventBroker(pool);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createSecurityEventRoutes(pool, broker));
  });
  afterEach(async () => { await broker.stop(); vi.restoreAllMocks(); });

  it("does not call an expired access token a revoked session after a held database await", async () => {
    const holder = await pool.connect(), controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(1936024437,1702258030) /*lock_purpose='security-event-publish'*/");
      user.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+4;
      const response = await app.request("/v1/auth/events", { signal: controller.signal });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      expect(text).toContain("event: ready\n");
      await vi.waitFor(async () => {
        const blocked = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%pg_advisory_xact_lock(1936024437, 1702258030)%'`);
        expect(blocked.rowCount).toBe(1);
      });
      await vi.waitFor(async () => {
        expect((await pool.query("SELECT clock_timestamp() >= to_timestamp($1) AS expired", [user.authentication.tokenExpiresAt])).rows[0].expired).toBe(true);
      }, { timeout: 6000 });
      await holder.query("COMMIT");
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
      expect(text).not.toContain("event: session.revoked");
      expect(text).not.toContain("authentication_changed");
      user.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+300;
      expect((await app.request("/v1/auth/snapshot")).status).toBe(200);
    } finally { controller.abort(); await holder.query("ROLLBACK"); holder.release(); await reader?.cancel(); }
  }, 10_000);

  it("ends an idle stream before token expiry so a fresh-token reconnect succeeds", async () => {
    user.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+4;
    const controller = new AbortController();
    try {
      const response = await app.request("/v1/auth/events", { signal: controller.signal });
      const text = await response.text();
      expect(text).toContain("event: ready\n");
      expect(text).not.toContain("event: session.revoked");
      expect(Date.now()/1000).toBeLessThan(user.authentication.tokenExpiresAt);
      user.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+300;
      const reconnected = await app.request("/v1/auth/events", { signal: controller.signal });
      const reader = reconnected.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready\n");
      await reader.cancel();
    } finally { controller.abort(); }
  }, 10_000);

  it("still sends the exact durable session revocation and closes before the token expires", async () => {
    const holder = await pool.connect(), controller = new AbortController(), decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await holder.query("BEGIN");
      // Publish after the event commits; an earlier scan may legitimately send the fallback revocation.
      await holder.query("SELECT pg_advisory_xact_lock(1936024437,1702258030) /*lock_purpose='security-event-publish'*/");
      const response = await app.request("/v1/auth/events", { signal: controller.signal });
      reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toContain("event: ready\n");
      await withSystemTx(pool, async tx => {
        await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [user.authentication.sessionId]);
        await tx.query("INSERT INTO security_events(kind,user_id,provider_session_id) VALUES('session.revoked',$1,$2)", [user.id, user.authentication.sessionId]);
      });
      await holder.query("COMMIT");
      let text = "";
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
      expect(text).toContain("event: session.revoked\n");
      const data = text.split("\n").find(line => line.startsWith("data: ") && line.includes('"kind":"session.revoked"'));
      expect(data).toBeDefined();
      expect(JSON.parse(data!.slice(6))).toMatchObject({ kind: "session.revoked", sequence: expect.any(Number) });
    } finally { controller.abort(); await holder.query("ROLLBACK"); holder.release(); await reader?.cancel(); }
  });
});
