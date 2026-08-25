import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runMigrations } from "./migrate.js";
import {
  PostgresWorkOSBrowserSessionRepository,
  WorkOSBrowserSessions,
} from "./workos-browser-sessions.js";
import type {
  WorkOSBrowserProvider,
  WorkOSExchange,
} from "./workos-provider.js";

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
      provider: "GoogleOAuth",
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
});
