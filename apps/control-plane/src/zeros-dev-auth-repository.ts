import type pg from "pg";
import { audit } from "./audit.js";
import type { AuthTokenClaims } from "./auth-token-contract.js";
import { withSystemTx, type Tx } from "./db.js";
import { enqueueWorkOSCommand } from "./workos-command-outbox.js";
import { workOSProviderErasureFenceStatus } from "./workos-provider-locks.js";
import type { ZerosDevAuthAttempt } from "./zeros-dev-auth.js";
import { ZerosDevAuthError, type ZerosDevAuthConfig } from "./zeros-dev-auth-config.js";

export interface ZerosDevAuthRepository {
  begin(identity: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, sourceHash: string, session?: ZerosDevSessionOperation): Promise<void>;
  commit(identity: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, claims: AuthTokenClaims, operation?: "refresh"): Promise<void>;
  revoke(identity: ZerosDevAuthConfig, sessionId: string, request?: ZerosDevAuthAttempt): Promise<void>;
  finish(identity: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, result: ZerosDevAuthOutcome): Promise<void>;
}
export type ZerosDevSessionOperation = { sessionId: string; operation: "refresh" | "revoke" };

export type ZerosDevAuthOutcome = {
  outcome: "denied" | "unavailable" | "unknown_issuance";
  cleanup: "not_needed" | "retired" | "pending" | "unknown";
};

async function boundedTransaction(tx: Tx): Promise<void> {
  await tx.query("SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '500ms'");
}

/** Existing rows only: no JIT signup, account linking, membership changes,
 * staff grants, or entitlement/funding seed on the test login path. */
async function assertPinnedIdentity(tx: Tx, pin: ZerosDevAuthConfig): Promise<void> {
  const result = await tx.query(
    `SELECT account.id
       FROM users account
       JOIN user_identities identity ON identity.user_id = account.id
       JOIN organization_members member ON member.user_id = account.id
       JOIN organizations organization ON organization.id = member.org_id
      WHERE account.id = $1 AND account.email = $2 AND account.staff_role IS NULL
        AND account.auth_status = 'active' AND account.deleted_at IS NULL
        AND identity.provider = 'workos' AND identity.provider_sub = $3
        AND identity.status = 'active' AND identity.email_verified_at IS NOT NULL
        AND member.org_id = $4 AND NOT organization.is_personal
        AND organization.deleted_at IS NULL AND organization.lifecycle_status = 'active'
      FOR SHARE OF account, identity, member, organization`,
    [pin.accountId, pin.email, pin.subject, pin.organizationId],
  );
  if (result.rowCount !== 1 || await workOSProviderErasureFenceStatus(tx, [{ kind: "user", id: pin.subject }]) !== "unfenced")
    throw new ZerosDevAuthError("denied");
}

async function assertIssuedSession(tx: Tx, pin: ZerosDevAuthConfig, session: ZerosDevSessionOperation): Promise<void> {
  const found = await tx.query(
    `SELECT session.provider_session_id FROM auth_sessions session
      WHERE session.provider = 'workos' AND session.provider_session_id = $1
        AND session.provider_sub = $2 AND session.user_id = $3 AND session.client_kind = 'web'
        AND (session.status = 'active' OR $5::boolean)
        AND EXISTS (SELECT 1 FROM audit_log issued
                     WHERE issued.org_id = $4 AND issued.actor_id = $3
                       AND issued.action = 'zeros_dev.auth_session_issued'
                       AND issued.subject->>'sessionId' = $1 AND issued.subject->>'clientKind' = 'web')
      FOR UPDATE OF session`,
    [session.sessionId, pin.subject, pin.accountId, pin.organizationId, session.operation === "revoke"],
  );
  if (found.rowCount !== 1) throw new ZerosDevAuthError("denied");
}

export class DatabaseZerosDevAuthRepository implements ZerosDevAuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  async begin(pin: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, sourceHash: string, session?: ZerosDevSessionOperation): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await boundedTransaction(tx);
      // This very low-volume anonymous endpoint has one database-wide budget.
      // A process restart or second API replica cannot evade its rate limit.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('zeros-dev-auth-rate-v1', 0)) /*lock_purpose='zeros-dev-auth-rate'*/");
      await assertPinnedIdentity(tx, pin);
      if (session) await assertIssuedSession(tx, pin, session);
      const result = await tx.query<{ total: string; source: string; repeated: boolean }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE subject->>'source' = $2)::text AS source,
                EXISTS (SELECT 1 FROM audit_log prior
                         WHERE prior.org_id = $1 AND prior.action = 'zeros_dev.auth_attempt'
                           AND prior.subject->>'requestId' = $3) AS repeated
           FROM audit_log WHERE org_id = $1 AND action = 'zeros_dev.auth_attempt'
             AND created_at > now() - interval '1 minute'`,
        [pin.organizationId, sourceHash, request.requestId],
      );
      const budget = result.rows[0]!;
      if (Number(budget.total) >= 20 || Number(budget.source) >= 5) throw new ZerosDevAuthError("rate_limited");
      // Never repeat an unknown password-grant outcome under one request ID.
      if (budget.repeated) throw new ZerosDevAuthError("denied");
      await audit(tx, pin.organizationId, pin.accountId, "zeros_dev.auth_attempt", {
        requestId: request.requestId, source: sourceHash, deviceId: request.device.id, deviceIntent: request.device.intent,
        ...(session ? { operation: session.operation, sessionId: session.sessionId } : {}),
      });
    });
  }

  async commit(pin: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, claims: AuthTokenClaims, operation?: "refresh"): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await boundedTransaction(tx);
      await assertPinnedIdentity(tx, pin);
      if (claims.clientKind !== "web" || claims.providerSubject !== pin.subject || claims.email !== pin.email || !claims.emailVerified)
        throw new ZerosDevAuthError("denied");
      if (operation) await assertIssuedSession(tx, pin, { sessionId: claims.sessionId, operation });
      const session = operation ? await tx.query(
        `UPDATE auth_sessions SET last_token_expires_at = to_timestamp($4)
          WHERE provider = 'workos' AND provider_session_id = $1 AND provider_sub = $2 AND user_id = $3
            AND status = 'active' AND client_kind = 'web' RETURNING provider_session_id`,
        [claims.sessionId, pin.subject, pin.accountId, claims.expiresAt],
      ) : await tx.query(
        `INSERT INTO auth_sessions (provider, provider_session_id, provider_sub, user_id, client_kind, last_token_expires_at)
         VALUES ('workos', $1, $2, $3, 'web', to_timestamp($4))
         ON CONFLICT (provider, provider_session_id) DO NOTHING RETURNING provider_session_id`,
        [claims.sessionId, pin.subject, pin.accountId, claims.expiresAt],
      );
      if (session.rowCount !== 1) throw new ZerosDevAuthError("denied");
      await audit(tx, pin.organizationId, pin.accountId, operation ? "zeros_dev.auth_session_refreshed" : "zeros_dev.auth_session_issued", {
        requestId: request.requestId, deviceId: request.device.id, deviceIntent: request.device.intent,
        sessionId: claims.sessionId, clientKind: claims.clientKind, authenticationMethod: "Password",
      });
    });
  }

  async revoke(pin: ZerosDevAuthConfig, sessionId: string, request?: ZerosDevAuthAttempt): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await boundedTransaction(tx);
      if (request) await assertIssuedSession(tx, pin, { sessionId, operation: "revoke" });
      await tx.query(
        `INSERT INTO auth_sessions (provider, provider_session_id, provider_sub, user_id, client_kind,
           status, revoked_at, revocation_reason)
         VALUES ('workos', $1, $2, $3, 'unknown', 'revoked', now(), 'zeros_dev_login_withheld')
         ON CONFLICT (provider, provider_session_id) DO UPDATE
           SET status = 'revoked', revoked_at = COALESCE(auth_sessions.revoked_at, now()),
               revocation_reason = 'zeros_dev_login_withheld'`,
        [sessionId, pin.subject, pin.accountId],
      );
      await enqueueWorkOSCommand(tx, { operation: "session.revoke", idempotencyKey: `zeros-dev.revoke.${sessionId}`,
        aggregateKey: `zeros-dev.session.${sessionId}`, aggregateRevision: 1, userId: pin.accountId,
        providerObjectId: sessionId, payload: { sessionId } });
      if (request) await audit(tx, pin.organizationId, pin.accountId, "zeros_dev.auth_session_revoked", { requestId: request.requestId, sessionId });
    });
  }

  async finish(pin: ZerosDevAuthConfig, request: ZerosDevAuthAttempt, result: ZerosDevAuthOutcome): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      await boundedTransaction(tx);
      await audit(tx, pin.organizationId, pin.accountId, "zeros_dev.auth_attempt_finished", {
        requestId: request.requestId, outcome: result.outcome, cleanup: result.cleanup,
      });
    });
  }
}
