import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { ensureUser, resolveAuthenticatedUser } from "./auth.js";
import {
  createDeletionLifecycleRoutes,
  DeletionLifecycleProcessor,
} from "./deletion-lifecycle.js";
import { runMigrations } from "./migrate.js";
import {
  PostgresWorkOSBrowserSessionRepository,
  WorkOSBrowserSessions,
} from "./workos-browser-sessions.js";
import type {
  WorkOSBrowserProvider,
  WorkOSExchange,
} from "./workos-provider.js";
import {
  workOSProviderSubjectHash,
  workOSUserProviderLockKey,
} from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const START = 1_800_000_000_000;
const APP_ORIGIN = "https://app-alpha.zeros.build";

d("Postgres WorkOS browser sessions", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("hashes browser credentials and serializes refresh rotation across replicas", async () => {
    let now = START;
    let refreshes = 0;
    let current: WorkOSExchange = {
      sealedSession: `sealed-${randomUUID()}`,
      sessionId: `session_${randomUUID().replaceAll("-", "")}`,
      accessToken: "signed-access-token-1",
      accessTokenExpiresAt: START + 60_000,
      user: {
        id: `user_${randomUUID().replaceAll("-", "")}`,
        email: `browser-${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Railway Browser",
      },
    };
    const auth: WorkOSBrowserProvider = {
      authorizationUrl({ state }) {
        return `https://api.workos.test/authorize?state=${state}`;
      },
      async exchange() {
        return current;
      },
      async restore(sealedSession) {
        return { status: "active", ...current, sealedSession };
      },
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        current = {
          ...current,
          sealedSession: `sealed-${randomUUID()}`,
          accessToken: "signed-access-token-2",
          accessTokenExpiresAt: START + 10 * 60_000,
        };
        return { status: "active", ...current };
      },
      logoutUrl() {
        return "https://api.workos.test/logout";
      },
      async revokeSession() {},
    };
    const tokens = ["A".repeat(43), "B".repeat(43), "C".repeat(43)];
    let tokenIndex = 0;
    const sessions = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      auth,
      APP_ORIGIN,
      () => now,
      () => tokens[tokenIndex++]!,
    );

    const started = await sessions.start({
      returnPath: "/after",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const expectedHash = createHash("sha256")
      .update(started.credential)
      .digest("hex");
    const flow = await pool.query<{
      credential_hash: Buffer;
      oauth_state_hash: Buffer;
      pkce_verifier: string;
    }>(
      `SELECT credential_hash, oauth_state_hash, pkce_verifier
       FROM workos_browser_sessions`,
    );
    expect(flow.rows).toHaveLength(1);
    expect(flow.rows[0]!.credential_hash.toString("hex")).toBe(expectedHash);
    expect(flow.rows[0]!.oauth_state_hash.toString("hex")).toBe(
      createHash("sha256").update(state).digest("hex"),
    );
    expect(JSON.stringify(flow.rows[0])).not.toContain(started.credential);
    expect(JSON.stringify(flow.rows[0])).not.toContain(state);

    expect(
      await sessions.complete({
        credential: started.credential,
        code: "one-time-code",
        state,
      }),
    ).toEqual({ ok: true, returnPath: "/after" });
    const promoted = await pool.query<{
      kind: string;
      oauth_state_hash: Buffer | null;
      pkce_verifier: string | null;
      sealed_session: string;
      revision: string;
    }>(
      `SELECT kind, oauth_state_hash, pkce_verifier, sealed_session, revision
       FROM workos_browser_sessions`,
    );
    expect(promoted.rows[0]).toMatchObject({
      kind: "session",
      oauth_state_hash: null,
      pkce_verifier: null,
      sealed_session: current.sealedSession,
      revision: "1",
    });
    const accessTokenColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workos_browser_sessions'
         AND column_name = 'access_token'`,
    );
    expect(accessTokenColumn.rows).toHaveLength(0);

    now = START + 60_000;
    const firstReplica = sessions.session(started.credential);
    const secondReplica = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      auth,
      APP_ORIGIN,
      () => now,
      () => "D".repeat(43),
    ).session(started.credential);
    const results = await Promise.all([firstReplica, secondReplica]);
    expect(results.every((result) => result.status === "active")).toBe(true);
    expect(refreshes).toBe(1);
    const rotated = await pool.query<{ revision: string }>(
      `SELECT revision FROM workos_browser_sessions`,
    );
    expect(rotated.rows[0]?.revision).toBe("2");
  });

  it("locks and binds the resolved local account before promoting provider data", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const providerSubject = `user_callback_binding_${suffix}`;
    const email = `callback-binding-${suffix}@example.test`;
    const account = await ensureUser(pool, {
      provider: "workos",
      providerSubject,
      email,
      displayName: "Callback Binding",
    });
    const exchanged: WorkOSExchange = {
      sealedSession: `sealed-callback-binding-${suffix}`,
      sessionId: `session_callback_binding_${suffix}`,
      accessToken: `access-callback-binding-${suffix}`,
      accessTokenExpiresAt: Date.now() + 10 * 60_000,
      user: {
        id: providerSubject,
        email,
        emailVerified: true,
        name: "Callback Binding",
      },
    };
    const auth: WorkOSBrowserProvider = {
      authorizationUrl({ state }) {
        return `https://api.workos.test/authorize?state=${state}`;
      },
      async exchange() {
        return exchanged;
      },
      async restore() {
        return { status: "active", ...exchanged };
      },
      async refresh() {
        return { status: "active", ...exchanged };
      },
      logoutUrl() {
        return "https://api.workos.test/logout";
      },
      async revokeSession() {},
    };
    const sessions = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      auth,
      APP_ORIGIN,
      Date.now,
      () => randomBytes(32).toString("base64url"),
    );
    const started = await sessions.start({ returnPath: "/after-binding" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const blocker = await pool.connect();
    const accountLock = workOSUserProviderLockKey(account.id);
    await blocker.query(
      `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`,
      [accountLock],
    );
    let settled = false;
    const completion = sessions
      .complete({
        credential: started.credential,
        code: "callback-binding-code",
        state,
      })
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      await expect(
        pool.query(
          `SELECT kind, sealed_session
           FROM workos_browser_sessions
           WHERE credential_hash = $1`,
          [createHash("sha256").update(started.credential).digest()],
        ),
      ).resolves.toMatchObject({
        rows: [{ kind: "flow", sealed_session: null }],
      });
    } finally {
      await blocker.query(
        `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
        [accountLock],
      );
      blocker.release();
      await Promise.allSettled([completion]);
    }

    await expect(completion).resolves.toEqual({
      ok: true,
      returnPath: "/after-binding",
    });
    await expect(
      pool.query(
        `SELECT account_user_id, account_revision
         FROM workos_browser_sessions
         WHERE credential_hash = $1`,
        [createHash("sha256").update(started.credential).digest()],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          account_user_id: account.id,
          account_revision: String(account.accountRevision),
        },
      ],
    });
  });

  it("fences and erases a same-email promoted shell even without its account binding", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const originalSubject = `user_shell_target_${suffix}`;
    const candidateSubject = `user_shell_candidate_${suffix}`;
    const email = `promoted-shell-${suffix}@example.test`;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject: originalSubject,
      email,
      displayName: "Promoted Shell Target",
      session: {
        id: `session_shell_target_${suffix}`,
        clientKind: "web",
        authTime: nowSeconds,
        tokenExpiresAt: nowSeconds + 3_600,
      },
    });
    const lifecycle = new Hono();
    lifecycle.use("/v1/*", async (c, next) => {
      c.set("user", target);
      await next();
    });
    lifecycle.route("/", createDeletionLifecycleRoutes(pool));
    const scheduled = await lifecycle.request("/v1/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as { deletion: { id: string } };

    const providerSessionId = `session_shell_candidate_${suffix}`;
    const exchanged: WorkOSExchange = {
      sealedSession: `sealed-shell-candidate-${suffix}`,
      sessionId: providerSessionId,
      accessToken: `access-shell-candidate-${suffix}`,
      accessTokenExpiresAt: Date.now() + 10 * 60_000,
      user: {
        id: candidateSubject,
        email,
        emailVerified: true,
        name: "Promoted Shell Candidate",
      },
    };
    const auth: WorkOSBrowserProvider = {
      authorizationUrl({ state }) {
        return `https://api.workos.test/authorize?state=${state}`;
      },
      async exchange() {
        return exchanged;
      },
      async restore() {
        return { status: "active", ...exchanged };
      },
      async refresh() {
        return { status: "active", ...exchanged };
      },
      logoutUrl() {
        return "https://api.workos.test/logout";
      },
      async revokeSession() {},
    };
    const sessions = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      auth,
      APP_ORIGIN,
      Date.now,
      () => randomBytes(32).toString("base64url"),
    );
    const started = await sessions.start({ returnPath: "/recover" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(
      sessions.complete({
        credential: started.credential,
        code: "same-email-candidate-code",
        state,
      }),
    ).resolves.toEqual({ ok: true, returnPath: "/recover" });
    // Simulate a shell promoted by the pre-fix callback path, which retained
    // verified email/subject data but did not yet bind the local account.
    await pool.query(
      `UPDATE workos_browser_sessions
       SET account_user_id = NULL, account_revision = NULL
       WHERE provider_session_id = $1`,
      [providerSessionId],
    );

    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [target.id],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [body.deletion.id],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `promoted-shell-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    const command = await pool.query<{ purge_command_id: string }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [body.deletion.id],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 OR payload->>'deletionRequestId' = $2::text`,
      [command.rows[0]!.purge_command_id, body.deletion.id],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [body.deletion.id],
    );
    expect(await processor.tick(1)).toBe(1);

    await expect(
      resolveAuthenticatedUser(pool, {
        provider: "workos",
        providerSubject: candidateSubject,
        email,
        displayName: "Promoted Shell Candidate",
        session: {
          id: providerSessionId,
          clientKind: "web",
          authTime: nowSeconds,
          tokenExpiresAt: nowSeconds + 3_600,
        },
      }),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM workos_browser_sessions
            WHERE provider_session_id = $1 OR provider_sub = $2) AS sessions,
           (SELECT count(*)::int FROM workos_provider_erasure_fences
            WHERE provider = 'workos' AND subject_kind = 'user'
              AND subject_hash = $3) AS fences`,
        [
          providerSessionId,
          candidateSubject,
          workOSProviderSubjectHash({ kind: "user", id: candidateSubject }),
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ sessions: 0, fences: 1 }] });
  });

  it("rejects and erases an AuthKit callback that arrives after its account purge", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const providerSubject = `user_late_callback_${suffix}`;
    const email = `late-callback-${suffix}@example.test`;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const target = await ensureUser(pool, {
      provider: "workos",
      providerSubject,
      email,
      displayName: "Late Callback",
      session: {
        id: `session_late_callback_existing_${suffix}`,
        clientKind: "web",
        authTime: nowSeconds,
        tokenExpiresAt: nowSeconds + 3_600,
      },
    });

    let exchangeStarted!: () => void;
    const startedExchange = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const providerSessionId = `session_late_callback_new_${suffix}`;
    const revoked: string[] = [];
    const auth: WorkOSBrowserProvider = {
      authorizationUrl({ state }) {
        return `https://api.workos.test/authorize?state=${state}`;
      },
      async exchange() {
        exchangeStarted();
        await exchangeGate;
        return {
          sealedSession: `sealed-late-callback-${suffix}`,
          sessionId: providerSessionId,
          accessToken: `access-late-callback-${suffix}`,
          accessTokenExpiresAt: Date.now() + 10 * 60_000,
          user: {
            id: providerSubject,
            email,
            emailVerified: true,
            name: "Late Callback",
          },
        };
      },
      async restore() {
        return { status: "terminal", reason: "invalid_session" };
      },
      async refresh() {
        return { status: "terminal", reason: "invalid_session" };
      },
      logoutUrl() {
        return "https://api.workos.test/logout";
      },
      async revokeSession(sessionId) {
        revoked.push(sessionId);
      },
    };
    const token = () => randomBytes(32).toString("base64url");
    const sessions = new WorkOSBrowserSessions(
      new PostgresWorkOSBrowserSessionRepository(pool),
      auth,
      APP_ORIGIN,
      Date.now,
      token,
    );
    const started = await sessions.start({ returnPath: "/after-purge" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completion = sessions.complete({
      credential: started.credential,
      code: "late-authorization-code",
      state,
    });
    await startedExchange;

    const lifecycle = new Hono();
    lifecycle.use("/v1/*", async (c, next) => {
      c.set("user", target);
      await next();
    });
    lifecycle.route("/", createDeletionLifecycleRoutes(pool));
    const scheduled = await lifecycle.request("/v1/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as { deletion: { id: string } };
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [target.id],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [body.deletion.id],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: `late-callback-${suffix}`,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    const command = await pool.query<{ purge_command_id: string }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [body.deletion.id],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 OR payload->>'deletionRequestId' = $2::text`,
      [command.rows[0]!.purge_command_id, body.deletion.id],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [body.deletion.id],
    );
    expect(await processor.tick(1)).toBe(1);

    releaseExchange();
    await expect(completion).resolves.toEqual({
      ok: false,
      reason: "account_deleted",
    });
    expect(revoked).toEqual([providerSessionId]);
    const credentialHash = createHash("sha256")
      .update(started.credential)
      .digest();
    await expect(
      pool.query(
        `SELECT count(*)::int AS count
         FROM workos_browser_sessions
         WHERE credential_hash = $1 OR provider_session_id = $2
            OR provider_sub = $3`,
        [credentialHash, providerSessionId, providerSubject],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
