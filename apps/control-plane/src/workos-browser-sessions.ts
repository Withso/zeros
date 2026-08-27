import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";

import { withSystemTx, type Tx } from "./db.js";
import type {
  WorkOSBrowserProvider,
  WorkOSExchange,
} from "./workos-provider.js";

export const WORKOS_FLOW_COOKIE = "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE = "__Host-zeros_session";
export const WORKOS_FLOW_TTL_S = 10 * 60;
export const WORKOS_SESSION_TTL_S = 30 * 24 * 60 * 60;

const REFRESH_SKEW_MS = 30_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
export type WorkOSFlowRecord = {
  codeVerifier: string;
  returnPath: string;
  redirectUri: string;
  expiresAt: number;
};

export type WorkOSSessionRecord = {
  sealedSession: string;
  providerSessionId: string;
  providerSubject: string;
  email: string;
  displayName: string | null;
  accessTokenExpiresAt: number;
  expiresAt: number;
  revision: number;
  updatedAt: number;
};

export interface LockedWorkOSSession {
  record: WorkOSSessionRecord | null;
  replace(record: WorkOSSessionRecord): Promise<void>;
  delete(): Promise<void>;
}

export interface WorkOSBrowserSessionRepository {
  createFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    record: WorkOSFlowRecord,
  ): Promise<void>;
  claimFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    now: number,
  ): Promise<WorkOSFlowRecord | null>;
  promoteFlow(
    credentialHash: Buffer,
    record: WorkOSSessionRecord,
  ): Promise<boolean>;
  deleteFlow(credentialHash: Buffer): Promise<void>;
  readSession(credentialHash: Buffer): Promise<WorkOSSessionRecord | null>;
  withLockedSession<T>(
    credentialHash: Buffer,
    operation: (session: LockedWorkOSSession) => Promise<T>,
  ): Promise<T>;
}

type SessionRow = {
  sealed_session: string;
  provider_session_id: string;
  provider_sub: string;
  email: string;
  display_name: string | null;
  access_token_expires_at: Date;
  expires_at: Date;
  revision: string | number;
  updated_at: Date;
};

function sessionFromRow(row: SessionRow): WorkOSSessionRecord {
  return {
    sealedSession: row.sealed_session,
    providerSessionId: row.provider_session_id,
    providerSubject: row.provider_sub,
    email: row.email,
    displayName: row.display_name,
    accessTokenExpiresAt: row.access_token_expires_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    revision: Number(row.revision),
    updatedAt: row.updated_at.getTime(),
  };
}

async function replaceSession(
  tx: Tx,
  credentialHash: Buffer,
  record: WorkOSSessionRecord,
): Promise<void> {
  await tx.query(
    `UPDATE workos_browser_sessions
     SET kind = 'session', oauth_state_hash = NULL, pkce_verifier = NULL,
         return_path = NULL, redirect_uri = NULL, claimed_at = NULL,
         sealed_session = $2, provider_session_id = $3, provider_sub = $4,
         email = $5, display_name = $6,
         access_token_expires_at = to_timestamp($7 / 1000.0),
         expires_at = to_timestamp($8 / 1000.0), revision = $9,
         updated_at = to_timestamp($10 / 1000.0)
     WHERE credential_hash = $1`,
    [
      credentialHash,
      record.sealedSession,
      record.providerSessionId,
      record.providerSubject,
      record.email,
      record.displayName,
      record.accessTokenExpiresAt,
      record.expiresAt,
      record.revision,
      record.updatedAt,
    ],
  );
}

export class PostgresWorkOSBrowserSessionRepository implements WorkOSBrowserSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    record: WorkOSFlowRecord,
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      // Opportunistic bounded cleanup keeps abandoned flows/sessions from
      // accumulating without introducing a second Railway process.
      await tx.query(
        `WITH expired AS (
           SELECT credential_hash FROM workos_browser_sessions
           WHERE expires_at <= now() ORDER BY expires_at LIMIT 100
         )
         DELETE FROM workos_browser_sessions s USING expired e
         WHERE s.credential_hash = e.credential_hash`,
      );
      await tx.query(
        `INSERT INTO workos_browser_sessions (
           credential_hash, kind, oauth_state_hash, pkce_verifier,
           return_path, redirect_uri, expires_at
         ) VALUES ($1, 'flow', $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
        [
          credentialHash,
          stateHash,
          record.codeVerifier,
          record.returnPath,
          record.redirectUri,
          record.expiresAt,
        ],
      );
    });
  }

  async claimFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    now: number,
  ): Promise<WorkOSFlowRecord | null> {
    return withSystemTx(this.pool, async (tx) => {
      const claimed = await tx.query<{
        pkce_verifier: string;
        return_path: string;
        redirect_uri: string;
        expires_at: Date;
      }>(
        `UPDATE workos_browser_sessions
         SET claimed_at = to_timestamp($3 / 1000.0),
             updated_at = to_timestamp($3 / 1000.0)
         WHERE credential_hash = $1 AND kind = 'flow'
           AND oauth_state_hash = $2 AND claimed_at IS NULL
           AND expires_at > to_timestamp($3 / 1000.0)
         RETURNING pkce_verifier, return_path, redirect_uri, expires_at`,
        [credentialHash, stateHash, now],
      );
      const row = claimed.rows[0];
      return row
        ? {
            codeVerifier: row.pkce_verifier,
            returnPath: row.return_path,
            redirectUri: row.redirect_uri,
            expiresAt: row.expires_at.getTime(),
          }
        : null;
    });
  }

  async promoteFlow(
    credentialHash: Buffer,
    record: WorkOSSessionRecord,
  ): Promise<boolean> {
    return withSystemTx(this.pool, async (tx) => {
      const promoted = await tx.query(
        `UPDATE workos_browser_sessions
         SET kind = 'session', oauth_state_hash = NULL, pkce_verifier = NULL,
             return_path = NULL, redirect_uri = NULL, claimed_at = NULL,
             sealed_session = $2, provider_session_id = $3,
             provider_sub = $4, email = $5, display_name = $6,
             access_token_expires_at = to_timestamp($7 / 1000.0),
             expires_at = to_timestamp($8 / 1000.0), revision = $9,
             updated_at = to_timestamp($10 / 1000.0)
         WHERE credential_hash = $1 AND kind = 'flow'
           AND claimed_at IS NOT NULL`,
        [
          credentialHash,
          record.sealedSession,
          record.providerSessionId,
          record.providerSubject,
          record.email,
          record.displayName,
          record.accessTokenExpiresAt,
          record.expiresAt,
          record.revision,
          record.updatedAt,
        ],
      );
      return (promoted.rowCount ?? 0) === 1;
    });
  }

  async deleteFlow(credentialHash: Buffer): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `DELETE FROM workos_browser_sessions
         WHERE credential_hash = $1 AND kind = 'flow'`,
        [credentialHash],
      );
    });
  }

  async readSession(
    credentialHash: Buffer,
  ): Promise<WorkOSSessionRecord | null> {
    return withSystemTx(this.pool, async (tx) => {
      const selected = await tx.query<SessionRow>(
        `SELECT sealed_session, provider_session_id, provider_sub, email,
                display_name, access_token_expires_at, expires_at, revision,
                updated_at
         FROM workos_browser_sessions
         WHERE credential_hash = $1 AND kind = 'session'`,
        [credentialHash],
      );
      const row = selected.rows[0];
      return row ? sessionFromRow(row) : null;
    });
  }

  async withLockedSession<T>(
    credentialHash: Buffer,
    operation: (session: LockedWorkOSSession) => Promise<T>,
  ): Promise<T> {
    return withSystemTx(this.pool, async (tx) => {
      const lockKey = credentialHash.toString("hex");
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 4))`, [
        `workos-browser:${lockKey}`,
      ]);
      const selected = await tx.query<SessionRow>(
        `SELECT sealed_session, provider_session_id, provider_sub, email,
                display_name, access_token_expires_at, expires_at, revision,
                updated_at
         FROM workos_browser_sessions
         WHERE credential_hash = $1 AND kind = 'session'
         FOR UPDATE`,
        [credentialHash],
      );
      const row = selected.rows[0];
      return operation({
        record: row ? sessionFromRow(row) : null,
        replace: (record) => replaceSession(tx, credentialHash, record),
        delete: async () => {
          await tx.query(
            `DELETE FROM workos_browser_sessions WHERE credential_hash = $1`,
            [credentialHash],
          );
        },
      });
    });
  }
}

export type WorkOSSessionData = {
  sub: string;
  email: string;
  name: string | null;
  accessToken: string;
  refreshToken: null;
  verifiedAt: number;
};

export type WorkOSSessionResult =
  | { status: "active"; data: WorkOSSessionData; revision: number }
  | {
      status: "transient";
      reason: string;
      retryAfter?: number;
      data: WorkOSSessionData;
      revision: number;
    }
  | { status: "terminal"; reason: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validExchange(exchange: WorkOSExchange, now: number): boolean {
  return (
    validString(exchange.sealedSession, 64 * 1_024) &&
    validString(exchange.sessionId, 512) &&
    validString(exchange.accessToken, 64 * 1_024) &&
    Number.isFinite(exchange.accessTokenExpiresAt) &&
    exchange.accessTokenExpiresAt > now &&
    validString(exchange.user.id, 512) &&
    validString(exchange.user.email, 254) &&
    (exchange.user.name === null ||
      (typeof exchange.user.name === "string" &&
        exchange.user.name.length <= 500))
  );
}

function dataFromExchange(
  exchange: WorkOSExchange,
  now: number,
): WorkOSSessionData {
  return {
    sub: exchange.user.id,
    email: exchange.user.email.toLowerCase(),
    name: exchange.user.name,
    accessToken: exchange.accessToken,
    refreshToken: null,
    verifiedAt: now,
  };
}

function transientData(record: WorkOSSessionRecord): WorkOSSessionData {
  return {
    sub: record.providerSubject,
    email: record.email,
    name: record.displayName,
    // No bearer is retained outside the sealed session. Pages checks the
    // transient status before it can forward this deliberately empty value.
    accessToken: "",
    refreshToken: null,
    verifiedAt: record.updatedAt,
  };
}

function sameSession(
  record: WorkOSSessionRecord,
  exchange: WorkOSExchange,
): boolean {
  return (
    record.providerSubject === exchange.user.id &&
    record.providerSessionId === exchange.sessionId
  );
}

export function safeWorkOSReturnPath(
  raw: string | null,
  origin: string,
): string {
  if (!raw) return "/";
  try {
    const expected = new URL(origin);
    const target = new URL(raw, expected);
    if (
      target.origin !== expected.origin ||
      target.username ||
      target.password
    ) {
      return "/";
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export class WorkOSBrowserSessions {
  constructor(
    private readonly repository: WorkOSBrowserSessionRepository,
    private readonly provider: WorkOSBrowserProvider,
    private readonly appOrigin: string,
    private readonly now: () => number = Date.now,
    private readonly token: () => string = randomToken,
  ) {}

  async start(options: {
    returnPath: string;
  }): Promise<{ credential: string; authorizationUrl: string }> {
    const credential = this.token();
    const state = this.token();
    const codeVerifier = this.token();
    if (
      !OPAQUE_ID.test(credential) ||
      !OPAQUE_ID.test(state) ||
      !OPAQUE_ID.test(codeVerifier)
    ) {
      throw new Error("Generated WorkOS credential has an invalid shape");
    }
    const redirectUri = `${this.appOrigin}/auth/callback`;
    const authorizationUrl = this.provider.authorizationUrl({
      state,
      codeChallenge: pkceChallenge(codeVerifier),
      redirectUri,
    });
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("WorkOS returned an unsafe authorization URL");
    }
    await this.repository.createFlow(digest(credential), digest(state), {
      codeVerifier,
      returnPath: safeWorkOSReturnPath(options.returnPath, this.appOrigin),
      redirectUri,
      expiresAt: this.now() + WORKOS_FLOW_TTL_S * 1_000,
    });
    return { credential, authorizationUrl: parsed.toString() };
  }

  async complete(options: {
    credential: string;
    code: string;
    state: string;
  }): Promise<
    { ok: true; returnPath: string } | { ok: false; reason: string }
  > {
    if (
      !OPAQUE_ID.test(options.credential) ||
      !validString(options.code, 8_192) ||
      !validString(options.state, 1_024)
    ) {
      return { ok: false, reason: "invalid_flow" };
    }
    const credentialHash = digest(options.credential);
    const flow = await this.repository.claimFlow(
      credentialHash,
      digest(options.state),
      this.now(),
    );
    if (!flow) return { ok: false, reason: "invalid_flow" };

    let exchange: WorkOSExchange;
    try {
      exchange = await this.provider.exchange({
        code: options.code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
    } catch {
      await this.repository.deleteFlow(credentialHash);
      return { ok: false, reason: "exchange_failed" };
    }
    const now = this.now();
    if (!validExchange(exchange, now)) {
      await this.repository.deleteFlow(credentialHash);
      return { ok: false, reason: "exchange_failed" };
    }
    if (exchange.user.emailVerified !== true) {
      await this.repository.deleteFlow(credentialHash);
      await this.provider.revokeSession(exchange.sessionId).catch(() => {});
      return { ok: false, reason: "email_unverified" };
    }
    const promoted = await this.repository.promoteFlow(credentialHash, {
      sealedSession: exchange.sealedSession,
      providerSessionId: exchange.sessionId,
      providerSubject: exchange.user.id,
      email: exchange.user.email.toLowerCase(),
      displayName: exchange.user.name,
      accessTokenExpiresAt: exchange.accessTokenExpiresAt,
      expiresAt: now + WORKOS_SESSION_TTL_S * 1_000,
      revision: 1,
      updatedAt: now,
    });
    if (!promoted) {
      await this.provider.revokeSession(exchange.sessionId).catch(() => {});
      return { ok: false, reason: "exchange_failed" };
    }
    return { ok: true, returnPath: flow.returnPath };
  }

  async cancel(credential: string): Promise<void> {
    if (OPAQUE_ID.test(credential)) {
      await this.repository.deleteFlow(digest(credential));
    }
  }

  async session(
    credential: string,
    options: { forceRefresh?: boolean; expectedRevision?: number } = {},
  ): Promise<WorkOSSessionResult> {
    if (!OPAQUE_ID.test(credential)) {
      return { status: "terminal", reason: "invalid_session" };
    }
    const credentialHash = digest(credential);
    if (options.forceRefresh !== true) {
      const snapshot = await this.repository.readSession(credentialHash);
      const now = this.now();
      if (
        snapshot &&
        snapshot.expiresAt > now &&
        snapshot.accessTokenExpiresAt > now + REFRESH_SKEW_MS
      ) {
        try {
          const restored = await this.provider.restore(snapshot.sealedSession);
          if (restored.status === "terminal") {
            // Do not let a stale read delete a seal that another replica has
            // already refreshed. Re-check under the same lock used by refresh.
            return this.repository.withLockedSession(
              credentialHash,
              async (locked) => {
                const current = locked.record;
                if (!current) return restored;
                if (
                  current.revision === snapshot.revision &&
                  current.sealedSession === snapshot.sealedSession
                ) {
                  await locked.delete();
                  return restored;
                }
                return {
                  status: "transient" as const,
                  reason: "session_changed",
                  data: transientData(current),
                  revision: current.revision,
                };
              },
            );
          }
          if (
            !validExchange(restored, now) ||
            restored.user.emailVerified !== true ||
            !sameSession(snapshot, restored)
          ) {
            return {
              status: "transient",
              reason: "verification_unavailable",
              data: transientData(snapshot),
              revision: snapshot.revision,
            };
          }
          return {
            status: "active",
            data: dataFromExchange(restored, now),
            revision: snapshot.revision,
          };
        } catch {
          return {
            status: "transient",
            reason: "verification_unavailable",
            data: transientData(snapshot),
            revision: snapshot.revision,
          };
        }
      }
    }
    return this.repository.withLockedSession(credentialHash, async (locked) => {
      const record = locked.record;
      if (!record) {
        return { status: "terminal", reason: "invalid_session" };
      }
      const now = this.now();
      if (record.expiresAt <= now) {
        await locked.delete();
        return { status: "terminal", reason: "session_expired" };
      }
      const anotherRequestRefreshed =
        options.forceRefresh === true &&
        options.expectedRevision !== undefined &&
        record.revision !== options.expectedRevision &&
        record.accessTokenExpiresAt > now + REFRESH_SKEW_MS;
      if (
        anotherRequestRefreshed ||
        (options.forceRefresh !== true &&
          record.accessTokenExpiresAt > now + REFRESH_SKEW_MS)
      ) {
        try {
          const restored = await this.provider.restore(record.sealedSession);
          if (restored.status === "terminal") {
            await locked.delete();
            return restored;
          }
          if (
            !validExchange(restored, now) ||
            restored.user.emailVerified !== true ||
            !sameSession(record, restored)
          ) {
            return {
              status: "transient",
              reason: "verification_unavailable",
              data: transientData(record),
              revision: record.revision,
            };
          }
          return {
            status: "active",
            data: dataFromExchange(restored, now),
            revision: record.revision,
          };
        } catch {
          return {
            status: "transient",
            reason: "verification_unavailable",
            data: transientData(record),
            revision: record.revision,
          };
        }
      }

      let refreshed;
      try {
        refreshed = await this.provider.refresh(record.sealedSession);
      } catch {
        return {
          status: "transient",
          reason: "unavailable",
          data: transientData(record),
          revision: record.revision,
        };
      }
      if (refreshed.status === "terminal") {
        await locked.delete();
        return refreshed;
      }
      if (refreshed.status === "transient") {
        let revision = record.revision;
        if (
          validString(refreshed.sealedSession, 64 * 1_024) &&
          refreshed.sealedSession !== record.sealedSession
        ) {
          revision += 1;
          await locked.replace({
            ...record,
            sealedSession: refreshed.sealedSession,
            revision,
            updatedAt: now,
          });
        }
        return {
          status: "transient",
          reason: refreshed.reason,
          ...(refreshed.retryAfter !== undefined
            ? { retryAfter: refreshed.retryAfter }
            : {}),
          data: transientData({ ...record, revision }),
          revision,
        };
      }
      if (
        !validExchange(refreshed, now) ||
        refreshed.user.emailVerified !== true ||
        refreshed.user.id !== record.providerSubject
      ) {
        return {
          status: "transient",
          reason: "invalid_response",
          data: transientData(record),
          revision: record.revision,
        };
      }
      const updated: WorkOSSessionRecord = {
        ...record,
        sealedSession: refreshed.sealedSession,
        providerSessionId: refreshed.sessionId,
        email: refreshed.user.email.toLowerCase(),
        displayName: refreshed.user.name,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        revision: record.revision + 1,
        updatedAt: now,
      };
      await locked.replace(updated);
      return {
        status: "active",
        data: dataFromExchange(refreshed, now),
        revision: updated.revision,
      };
    });
  }

  async logout(
    credential: string,
    returnTo: string,
  ): Promise<{ logoutUrl: string | null }> {
    if (!OPAQUE_ID.test(credential)) return { logoutUrl: null };
    const providerSessionId = await this.repository.withLockedSession(
      digest(credential),
      async (locked) => {
        const sessionId = locked.record?.providerSessionId ?? null;
        await locked.delete();
        return sessionId;
      },
    );
    if (!providerSessionId) return { logoutUrl: null };
    try {
      return {
        logoutUrl: this.provider.logoutUrl({
          sessionId: providerSessionId,
          returnTo,
        }),
      };
    } catch {
      return { logoutUrl: null };
    }
  }
}

function cookies(request: Request): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const segment of (request.headers.get("cookie") ?? "").split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const name = equals < 0 ? trimmed : trimmed.slice(0, equals);
    if (!parsed.has(name)) {
      parsed.set(name, equals < 0 ? "" : trimmed.slice(equals + 1));
    }
  }
  return parsed;
}

function hostCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure; HttpOnly`;
}

function expireCookie(name: string, domainWide = false): string {
  return `${name}=; ${domainWide ? "Domain=.zeros.build; " : ""}Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

function appendFlowCleanup(headers: Headers): void {
  headers.append("set-cookie", expireCookie(WORKOS_FLOW_COOKIE));
  for (const name of [
    "zeros_pkce_verifier",
    "zeros_oauth_state",
    "zeros_return_to",
  ]) {
    headers.append("set-cookie", expireCookie(name));
  }
}

function appendSessionCleanup(headers: Headers): void {
  headers.append("set-cookie", expireCookie(WORKOS_SESSION_COOKIE));
  headers.append("set-cookie", expireCookie("zeros_session"));
  headers.append("set-cookie", expireCookie("zeros_session", true));
}

function failureResponse(reason: string): Response {
  const descriptions: Record<string, string> = {
    missing_callback: "The sign-in link was missing required callback data.",
    invalid_flow:
      "This sign-in attempt expired, was already used, or did not match this browser.",
    email_unverified:
      "Verify your email address with the provider before continuing.",
    exchange_failed: "The sign-in service could not complete this attempt.",
    provider_error: "The identity provider did not complete this attempt.",
    unavailable: "The sign-in service is temporarily unavailable.",
  };
  const message = descriptions[reason] ?? descriptions.unavailable!;
  return new Response(
    `Sign-in didn't finish. ${message} Nothing was changed; please try again.`,
    {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function createWorkOSBrowserSessionRoutes(
  sessions: WorkOSBrowserSessions,
  appOrigin: string,
): Hono {
  const app = new Hono();

  app.get("/auth/start", async (c) => {
    const requestUrl = new URL(c.req.url);
    try {
      const started = await sessions.start({
        returnPath: safeWorkOSReturnPath(
          requestUrl.searchParams.get("return"),
          appOrigin,
        ),
      });
      const headers = new Headers({
        location: started.authorizationUrl,
        "cache-control": "no-store",
      });
      headers.append(
        "set-cookie",
        hostCookie(WORKOS_FLOW_COOKIE, started.credential, WORKOS_FLOW_TTL_S),
      );
      return new Response(null, { status: 303, headers });
    } catch {
      return failureResponse("unavailable");
    }
  });

  app.get("/auth/callback", async (c) => {
    const requestUrl = new URL(c.req.url);
    const credential = cookies(c.req.raw).get(WORKOS_FLOW_COOKIE) ?? "";
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const providerError =
      requestUrl.searchParams.get("error_description") ??
      requestUrl.searchParams.get("error");
    if (providerError || !code || !state || !OPAQUE_ID.test(credential)) {
      await sessions.cancel(credential).catch(() => {});
      const failed = failureResponse(
        providerError ? "provider_error" : "missing_callback",
      );
      appendFlowCleanup(failed.headers);
      return failed;
    }
    let result;
    try {
      result = await sessions.complete({ credential, code, state });
    } catch {
      result = { ok: false as const, reason: "unavailable" };
    }
    if (!result.ok) {
      const failed = failureResponse(result.reason);
      appendFlowCleanup(failed.headers);
      return failed;
    }
    const returnPath = safeWorkOSReturnPath(result.returnPath, appOrigin);
    const headers = new Headers({
      location: new URL(returnPath, `${appOrigin}/`).toString(),
      "cache-control": "no-store",
    });
    headers.append(
      "set-cookie",
      hostCookie(WORKOS_SESSION_COOKIE, credential, WORKOS_SESSION_TTL_S),
    );
    appendFlowCleanup(headers);
    headers.append("set-cookie", expireCookie("zeros_session"));
    headers.append("set-cookie", expireCookie("zeros_session", true));
    return new Response(null, { status: 303, headers });
  });

  app.get("/auth/browser/session", async (c) => {
    const credential = cookies(c.req.raw).get(WORKOS_SESSION_COOKIE) ?? "";
    const result = await sessions.session(credential);
    return json(result, result.status === "terminal" ? 401 : 200);
  });

  app.post("/auth/browser/refresh", async (c) => {
    const credential = cookies(c.req.raw).get(WORKOS_SESSION_COOKIE) ?? "";
    const rawRevision = c.req.header("x-zeros-session-revision") ?? "";
    const expectedRevision = /^\d{1,15}$/.test(rawRevision)
      ? Number(rawRevision)
      : undefined;
    const result = await sessions.session(credential, {
      forceRefresh: true,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    return json(result, result.status === "terminal" ? 401 : 200);
  });

  app.get("/auth/logout", async (c) => {
    const requestUrl = new URL(c.req.url);
    const returnPath = safeWorkOSReturnPath(
      requestUrl.searchParams.get("return"),
      appOrigin,
    );
    const returnTo = new URL(returnPath, `${appOrigin}/`).toString();
    const credential = cookies(c.req.raw).get(WORKOS_SESSION_COOKIE) ?? "";
    const result = await sessions
      .logout(credential, returnTo)
      .catch(() => ({ logoutUrl: null }));
    let location = returnTo;
    if (result.logoutUrl) {
      try {
        const logout = new URL(result.logoutUrl);
        if (logout.protocol === "https:") location = logout.toString();
      } catch {
        // The local credential is already gone; fall back to the safe return.
      }
    }
    const headers = new Headers({ location, "cache-control": "no-store" });
    appendSessionCleanup(headers);
    appendFlowCleanup(headers);
    return new Response(null, { status: 303, headers });
  });

  return app;
}
