import { randomUUID } from "node:crypto";
import type pg from "pg";

import { withSystemTx } from "./db.js";

export type SecurityNotificationTemplate =
  | "account_identity_disabled"
  | "account_recovered"
  | "sessions_revoked"
  | "organization_access_revoked"
  | "account_deletion_scheduled"
  | "account_deletion_restored"
  | "account_deletion_completed"
  | "organization_deletion_scheduled"
  | "organization_deletion_restored"
  | "organization_deletion_completed";

export type SecurityNotificationDelivery = {
  id: string;
  destinationEmail: string;
  template: SecurityNotificationTemplate;
  subject: string;
  html: string;
  clientReference: string;
};

export type SecurityNotificationSender = (
  delivery: SecurityNotificationDelivery,
) => Promise<void>;

const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DELETION_CODE_RE = /^ZD-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const MAX_ATTEMPTS = 12;

export class SecurityNotificationDeliveryError extends Error {
  readonly code: string;

  constructor(code: string, readonly retryable: boolean) {
    const safeCode =
      code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "unknown";
    super(safeCode);
    this.name = "SecurityNotificationDeliveryError";
    this.code = safeCode;
  }
}

function securityEmailHtml(
  title: string,
  paragraphs: readonly string[],
  recoveryCode?: string,
): string {
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1b22;line-height:1.6;max-width:560px;margin:0 auto;padding:32px 20px">
  <h2 style="margin:0 0 16px;font-size:20px">${title}</h2>
  ${paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${paragraph}</p>`).join("\n  ")}
  ${recoveryCode ? `<p style="margin:20px 0;padding:14px;border:1px solid #d4d4d8;border-radius:8px"><b>Recovery code:</b> <code>${recoveryCode}</code></p>` : ""}
  <p style="margin:24px 0 0;color:#6b7280;font-size:13px">If you did not expect this change, contact <a href="mailto:hello@zeros.build">hello@zeros.build</a>.</p>
</body></html>`;
}

/** Render only fixed application-authored copy. Outbox payload is metadata, not
 * a template language; the sole reflected value is the validated public
 * recovery locator. */
export function securityNotificationContent(
  template: SecurityNotificationTemplate,
  payload: Record<string, unknown>,
): { subject: string; html: string } {
  const deletionCodeCandidate = payload.recovery_code;
  const deletionCode =
    typeof deletionCodeCandidate === "string" &&
    DELETION_CODE_RE.test(deletionCodeCandidate)
      ? deletionCodeCandidate
      : undefined;
  switch (template) {
    case "account_identity_disabled":
      return {
        subject: "Your Zeros sign-in identity was disabled",
        html: securityEmailHtml("Your Zeros sign-in identity was disabled", [
          "Zeros received a verified identity-deletion event from WorkOS. We ended active Zeros sessions and removed collaborative organization access.",
          "Your product data remains protected. A recreated identity is never linked to it by email alone.",
        ]),
      };
    case "account_recovered": {
      const candidate = payload.recovery_code;
      const recoveryCode =
        typeof candidate === "string" && RECOVERY_CODE_RE.test(candidate)
          ? candidate
          : undefined;
      return {
        subject: "Your Zeros account sign-in was recovered",
        html: securityEmailHtml(
          "Your Zeros account sign-in was recovered",
          [
            "A Zeros operator completed the reviewed identity-recovery process for your account.",
            "Collaborative organization memberships were not restored automatically. An organization administrator must grant them again when appropriate.",
          ],
          recoveryCode,
        ),
      };
    }
    case "sessions_revoked":
      return {
        subject: "Your Zeros sessions were signed out",
        html: securityEmailHtml("Your Zeros sessions were signed out", [
          "All active Zeros sessions for your account were revoked.",
          "You can sign in again with WorkOS Hosted AuthKit if this was expected.",
        ]),
      };
    case "organization_access_revoked":
      return {
        subject: "Your Zeros organization access changed",
        html: securityEmailHtml("Your Zeros organization access changed", [
          "Your access to a collaborative Zeros organization was removed.",
          "Local Personal workspaces are unaffected.",
        ]),
      };
    case "account_deletion_scheduled":
      return {
        subject: "Your Zeros account is scheduled for deletion",
        html: securityEmailHtml(
          "Your Zeros account is scheduled for deletion",
          [
            "Access was revoked immediately. Your Zeros cloud account data is retained in a recoverable state for 30 days.",
            "Sign in again and choose Restore account before the grace period ends if you change your mind. Local Personal workspaces on your devices are unaffected.",
          ],
          deletionCode,
        ),
      };
    case "account_deletion_restored":
      return {
        subject: "Your Zeros account was restored",
        html: securityEmailHtml("Your Zeros account was restored", [
          "The pending deletion was cancelled after a recent WorkOS authentication.",
          "Your Zeros cloud account and eligible organization data are active again. Previously revoked sessions remain signed out for safety.",
        ]),
      };
    case "account_deletion_completed":
      return {
        subject: "Your Zeros account deletion is complete",
        html: securityEmailHtml("Your Zeros account deletion is complete", [
          "The 30-day recovery period ended and Zeros completed provider and product-data erasure under the deletion policy.",
          "Local Personal workspaces on devices you control were never uploaded or removed by this process.",
        ]),
      };
    case "organization_deletion_scheduled":
      return {
        subject: "A Zeros organization is scheduled for deletion",
        html: securityEmailHtml(
          "A Zeros organization is scheduled for deletion",
          [
            "Organization access was revoked immediately. The organization remains recoverable by an owner for 30 days.",
            "WorkOS organization deletion and final product-data erasure will begin only after the recovery period ends.",
          ],
          deletionCode,
        ),
      };
    case "organization_deletion_restored":
      return {
        subject: "A Zeros organization was restored",
        html: securityEmailHtml("A Zeros organization was restored", [
          "An organization owner cancelled the pending deletion within the 30-day recovery period.",
          "Membership and organization data are available again. Previously issued cloud endpoint grants remain revoked and will be replaced when needed.",
        ]),
      };
    case "organization_deletion_completed":
      return {
        subject: "A Zeros organization deletion is complete",
        html: securityEmailHtml(
          "A Zeros organization deletion is complete",
          [
            "The 30-day recovery period ended and provider plus product-data deletion completed.",
          ],
        ),
      };
  }
}

type ClaimedNotification = {
  id: string;
  destinationEmail: string;
  template: SecurityNotificationTemplate;
  payload: Record<string, unknown>;
  attemptCount: number;
};

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt, 10));
}

function deliveryFailure(error: unknown): SecurityNotificationDeliveryError {
  if (error instanceof SecurityNotificationDeliveryError) return error;
  const name = error instanceof Error ? error.name : "unknown";
  return new SecurityNotificationDeliveryError(name, true);
}

export class SecurityNotificationProcessor {
  private readonly workerId: string;
  private readonly logger: Pick<Console, "error">;

  constructor(
    private readonly pool: pg.Pool,
    private readonly send: SecurityNotificationSender,
    options: { workerId?: string; logger?: Pick<Console, "error"> } = {},
  ) {
    this.workerId = options.workerId ?? `security-email:${randomUUID()}`;
    this.logger = options.logger ?? console;
  }

  private claim(): Promise<ClaimedNotification | null> {
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        id: string;
        destination_email: string;
        template: SecurityNotificationTemplate;
        payload: Record<string, unknown>;
        attempt_count: number;
      }>(
        `WITH candidate AS (
           SELECT id
           FROM security_notification_outbox
           WHERE (
             state = 'queued' AND next_attempt_at <= now()
           ) OR (
             state = 'sending' AND lease_expires_at <= now()
           )
           ORDER BY next_attempt_at, created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE security_notification_outbox notification
         SET state = 'sending', attempt_count = attempt_count + 1,
             lease_owner = $1,
             lease_expires_at = now() + interval '60 seconds',
             last_error_code = NULL
         FROM candidate
         WHERE notification.id = candidate.id
         RETURNING notification.id, notification.destination_email,
                   notification.template, notification.payload,
                   notification.attempt_count`,
        [this.workerId],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            destinationEmail: row.destination_email,
            template: row.template,
            payload: row.payload,
            attemptCount: row.attempt_count,
          }
        : null;
    });
  }

  private async deliver(notification: ClaimedNotification): Promise<void> {
    const content = securityNotificationContent(
      notification.template,
      notification.payload,
    );
    try {
      await this.send({
        id: notification.id,
        destinationEmail: notification.destinationEmail,
        template: notification.template,
        subject: content.subject,
        html: content.html,
        clientReference: `zeros-security:${notification.id}`,
      });
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE security_notification_outbox
           SET state = 'sent', sent_at = now(), lease_owner = NULL,
               lease_expires_at = NULL, last_error_code = NULL
           WHERE id = $1 AND state = 'sending' AND lease_owner = $2`,
          [notification.id, this.workerId],
        ),
      );
    } catch (error) {
      const failure = deliveryFailure(error);
      const retry = failure.retryable && notification.attemptCount < MAX_ATTEMPTS;
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE security_notification_outbox
           SET state = $3::security_notification_state,
               next_attempt_at = CASE
                 WHEN $3 = 'queued' THEN now() + ($4::bigint * interval '1 millisecond')
                 ELSE next_attempt_at
               END,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = $5
           WHERE id = $1 AND state = 'sending' AND lease_owner = $2`,
          [
            notification.id,
            this.workerId,
            retry ? "queued" : "dead",
            retryDelayMs(notification.attemptCount),
            failure.code,
          ],
        ),
      );
      if (!retry) {
        this.logger.error(
          `[security-email] dead notification=${notification.id} code=${failure.code}`,
        );
      }
    }
  }

  async tick(limit = 20): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    let processed = 0;
    while (processed < boundedLimit) {
      const notification = await this.claim();
      if (!notification) break;
      await this.deliver(notification);
      processed += 1;
    }
    return processed;
  }
}
