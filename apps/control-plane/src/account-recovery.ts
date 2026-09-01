import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { audit } from "./audit.js";
import { withSystemTx } from "./db.js";

const RecoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const OPERATOR_REAUTH_SECONDS = 5 * 60;
const RecoveryReviewSchema = z.object({
  supportCaseReference: z
    .string()
    .trim()
    .min(6)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/#-]*$/),
  ownershipVerification: z.literal("confirmed_out_of_band"),
});
type RecoveryReview = z.infer<typeof RecoveryReviewSchema>;

function requireFreshOperator(operator: AuthedUser): void {
  // `support_admin` remains readable for already-persisted installations, but
  // Zeros grants new standing authority only to platform owners. Developers
  // perform sensitive operations through exact-request grants in Ops.
  if (
    operator.staffRole !== "platform_owner" &&
    operator.staffRole !== "support_admin"
  ) {
    throw new HttpError(404, "not_found", "Not found");
  }
  const authTime = operator.authentication.authTime;
  const now = Date.now() / 1_000;
  if (
    operator.identity.provider !== "workos" ||
    authTime === null ||
    authTime > now + 60 ||
    now - authTime > OPERATOR_REAUTH_SECONDS
  ) {
    throw new HttpError(
      401,
      "reauthentication_required",
      "Sign in again before reviewing account recovery.",
    );
  }
}

export async function approveAccountRecovery(
  pool: pg.Pool,
  input: { operator: AuthedUser; publicCode: string },
  review: RecoveryReview,
): Promise<{ accountId: string; state: "consumed" }> {
  requireFreshOperator(input.operator);
  const publicCode = RecoveryCodeSchema.safeParse(input.publicCode);
  if (!publicCode.success) {
    throw new HttpError(404, "not_found", "Recovery request not found");
  }

  return withSystemTx(pool, async (tx) => {
    const found = await tx.query<{
      id: string;
      target_user_id: string;
      target_identity_id: string;
      candidate_provider_sub: string;
      candidate_email: string;
      state: "pending" | "approved" | "consumed" | "rejected" | "expired";
      expires_at: Date;
    }>(
      `SELECT id, target_user_id, target_identity_id,
              candidate_provider_sub, candidate_email, state, expires_at
       FROM account_recovery_requests
       WHERE public_code = $1
       FOR UPDATE`,
      [publicCode.data],
    );
    const recovery = found.rows[0];
    if (!recovery || recovery.state !== "pending") {
      throw new HttpError(404, "not_found", "Recovery request not found");
    }
    if (recovery.expires_at.getTime() <= Date.now()) {
      await tx.query(
        `UPDATE account_recovery_requests
         SET state = 'expired', reviewed_by = $2, reviewed_at = now()
         WHERE id = $1`,
        [recovery.id, input.operator.id],
      );
      throw new HttpError(409, "recovery_expired", "Recovery request expired");
    }

    const target = await tx.query<{
      email: string;
      auth_status: "identity_disabled" | "deletion_pending";
      identity_status: string;
      provider_sub: string;
    }>(
      `SELECT u.email, u.auth_status, ui.status AS identity_status,
              ui.provider_sub
       FROM users u
       JOIN user_identities ui ON ui.id = $2 AND ui.user_id = u.id
       WHERE u.id = $1
       FOR UPDATE OF u, ui`,
      [recovery.target_user_id, recovery.target_identity_id],
    );
    const account = target.rows[0];
    if (
      !account ||
      !["identity_disabled", "deletion_pending"].includes(
        account.auth_status,
      ) ||
      account.identity_status !== "provider_deleted" ||
      account.email.toLowerCase() !== recovery.candidate_email.toLowerCase()
    ) {
      throw new HttpError(
        409,
        "recovery_state_changed",
        "Account recovery state changed; review it again.",
      );
    }

    const collision = await tx.query(
      `SELECT 1 FROM user_identities
       WHERE provider = 'workos' AND provider_sub = $1
       LIMIT 1`,
      [recovery.candidate_provider_sub],
    );
    if (collision.rows[0]) {
      throw new HttpError(
        409,
        "recovery_state_changed",
        "Candidate identity is already linked.",
      );
    }

    const replacement = await tx.query<{ id: string }>(
      `INSERT INTO user_identities (
         user_id, provider, provider_sub, status, email_at_link,
         email_verified_at, linked_via
       ) VALUES ($1, 'workos', $2, 'active', $3, now(), 'operator_recovery')
       RETURNING id`,
      [
        recovery.target_user_id,
        recovery.candidate_provider_sub,
        recovery.candidate_email,
      ],
    );
    await tx.query(
      `UPDATE user_identities
       SET status = 'superseded',
           superseded_by_identity_id = $2,
           disabled_at = COALESCE(disabled_at, now())
       WHERE id = $1 AND status = 'provider_deleted'`,
      [recovery.target_identity_id, replacement.rows[0]!.id],
    );
    const deletionRemainsPending = account.auth_status === "deletion_pending";
    const reactivated = await tx.query<{ auth_revision: string | number }>(
      `UPDATE users
       SET auth_status = CASE
             WHEN auth_status = 'identity_disabled'
               THEN 'active'::account_auth_status
             ELSE auth_status
           END,
           auth_disabled_at = NULL,
           auth_status_changed_at = CASE
             WHEN auth_status = 'identity_disabled' THEN now()
             ELSE auth_status_changed_at
           END,
           auth_revision = auth_revision + 1
       WHERE id = $1 AND auth_status = $2::account_auth_status
       RETURNING auth_revision`,
      [recovery.target_user_id, account.auth_status],
    );
    if (!reactivated.rows[0]) {
      throw new HttpError(
        409,
        "recovery_state_changed",
        "Account recovery state changed; review it again.",
      );
    }
    if (deletionRemainsPending) {
      // Provider deletion invalidates every provider membership identifier,
      // but the 30-day deletion snapshot remains intact. Advance the desired
      // revision now so the customer's later, explicit account restore can
      // project these retained Zeros-managed memberships to the replacement
      // WorkOS identity without reusing stale provider objects.
      await tx.query(
        `UPDATE organization_members om
         SET workos_membership_id = NULL,
             workos_sync_revision = om.workos_sync_revision + 1
         FROM organizations o
         WHERE om.org_id = o.id AND om.user_id = $1
           AND NOT o.is_personal AND om.membership_source <> 'scim'`,
        [recovery.target_user_id],
      );
    }
    await tx.query(
      `UPDATE account_recovery_requests
       SET state = 'consumed', reviewed_by = $2, reviewed_at = now(),
           consumed_at = now(), support_case_reference = $3,
           ownership_verification_method = $4,
           ownership_verified_at = now()
       WHERE id = $1`,
      [
        recovery.id,
        input.operator.id,
        review.supportCaseReference,
        review.ownershipVerification,
      ],
    );
    await tx.query(
      `UPDATE account_recovery_requests
       SET state = 'rejected', reviewed_by = $2, reviewed_at = now(),
           rejection_reason = 'superseded_by_completed_recovery'
       WHERE target_user_id = $1 AND state = 'pending' AND id <> $3`,
      [recovery.target_user_id, input.operator.id, recovery.id],
    );
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, account_revision, payload
       ) VALUES (
         'account.authorization_changed', $1, $2,
         jsonb_build_object('reason', 'account_recovered')
       )`,
      [recovery.target_user_id, Number(reactivated.rows[0].auth_revision)],
    );
    await tx.query(
      `INSERT INTO security_notification_outbox (
         user_id, destination_email, template, payload
       ) VALUES (
         $1, $2, 'account_recovered', jsonb_build_object(
           'recovery_code', $3::text, 'reviewer_id', $4::uuid
         )
       )`,
      [
        recovery.target_user_id,
        account.email,
        publicCode.data,
        input.operator.id,
      ],
    );
    const personal = await tx.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal AND deleted_at IS NULL
       ORDER BY created_at, id LIMIT 1`,
      [recovery.target_user_id],
    );
    if (personal.rows[0]) {
      await audit(
        tx,
        personal.rows[0].id,
        input.operator.id,
        "account.identity_recovered",
        {
          account: recovery.target_user_id,
          recovery: recovery.id,
        },
      );
    }
    return { accountId: recovery.target_user_id, state: "consumed" as const };
  });
}

export function createAccountRecoveryRoutes(pool: pg.Pool): Hono {
  const app = new Hono();
  app.post("/v1/internal/account-recoveries/:code/approve", async (c) => {
    const review = RecoveryReviewSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!review.success) {
      throw new HttpError(422, "invalid_input", "Invalid recovery review");
    }
    const result = await approveAccountRecovery(
      pool,
      {
        operator: c.get("user"),
        publicCode: c.req.param("code"),
      },
      {
        supportCaseReference: review.data.supportCaseReference,
        ownershipVerification: review.data.ownershipVerification,
      },
    );
    return c.json(result);
  });
  return app;
}
