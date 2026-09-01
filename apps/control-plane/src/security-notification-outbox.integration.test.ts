import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import {
  SecurityNotificationDeliveryError,
  SecurityNotificationProcessor,
  securityNotificationContent,
} from "./security-notification-outbox.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("security notification outbox", () => {
  let pool: pg.Pool;
  let userId: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID()}`,
      email: `security-${randomUUID()}@example.com`,
      displayName: "Security Recipient",
    });
    userId = user.id;
  });

  async function enqueue(
    template: "account_identity_disabled" | "account_recovered" =
      "account_identity_disabled",
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO security_notification_outbox (
         user_id, destination_email, template, payload
       ) VALUES ($1, 'recipient@example.com', $2, $3::jsonb)
       RETURNING id`,
      [
        userId,
        template,
        JSON.stringify(
          template === "account_recovered"
            ? { recovery_code: "ZR-ABCD-2345" }
            : { reason: "workos_user_deleted" },
        ),
      ],
    );
    return result.rows[0]!.id;
  }

  it("claims each message once across workers and publishes a deterministic reference", async () => {
    const id = await enqueue();
    const send = vi.fn(async () => ({
      providerMessageId: "resend-message-id",
    }));
    const first = new SecurityNotificationProcessor(pool, send, {
      workerId: "security:first",
    });
    const second = new SecurityNotificationProcessor(pool, send, {
      workerId: "security:second",
    });

    await Promise.all([first.tick(10), second.tick(10)]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        destinationEmail: "recipient@example.com",
        idempotencyKey: `zeros-security:${id}`,
      }),
    );
    const row = await pool.query(
      `SELECT state, attempt_count, sent_at IS NOT NULL AS sent,
              lease_owner, lease_expires_at, delivery_provider,
              provider_message_id
       FROM security_notification_outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      state: "sent",
      attempt_count: 1,
      sent: true,
      lease_owner: null,
      lease_expires_at: null,
      delivery_provider: "resend",
      provider_message_id: "resend-message-id",
    });
    await expect(
      pool.query(
        `UPDATE security_notification_outbox
         SET provider_message_id = 'rewritten-message-id'
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/provider message ID is immutable/i);
  });

  it("retries transient delivery and dead-letters a permanent refusal", async () => {
    const transientId = await enqueue();
    let unavailable = true;
    const transient = new SecurityNotificationProcessor(
      pool,
      async () => {
        if (unavailable) {
          throw new SecurityNotificationDeliveryError(
            "mail_unavailable",
            true,
          );
        }
        return { providerMessageId: "resend-retry-id" };
      },
      { workerId: "security:retry" },
    );
    expect(await transient.tick()).toBe(1);
    await pool.query(
      `UPDATE security_notification_outbox SET next_attempt_at = now()
       WHERE id = $1`,
      [transientId],
    );
    unavailable = false;
    expect(await transient.tick()).toBe(1);

    const permanentId = await enqueue("account_recovered");
    const permanent = new SecurityNotificationProcessor(
      pool,
      async () => {
        throw new SecurityNotificationDeliveryError("mail_rejected", false);
      },
      { workerId: "security:permanent" },
    );
    expect(await permanent.tick()).toBe(1);

    const rows = await pool.query(
      `SELECT id, state, attempt_count, last_error_code
       FROM security_notification_outbox
       WHERE id IN ($1, $2) ORDER BY id`,
      [transientId, permanentId],
    );
    expect(rows.rows).toEqual(
      [
        {
          id: transientId,
          state: "sent",
          attempt_count: 2,
          last_error_code: null,
        },
        {
          id: permanentId,
          state: "dead",
          attempt_count: 1,
          last_error_code: "mail_rejected",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  });

  it("never claims a legacy-provider row even if it is requeued", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO security_notification_outbox (
         user_id, destination_email, template, delivery_provider
       ) VALUES ($1, 'legacy@example.com', 'sessions_revoked',
                 'legacy_zeptomail')
       RETURNING id`,
      [userId],
    );
    const send = vi.fn(async () => ({ providerMessageId: "unexpected" }));
    const processor = new SecurityNotificationProcessor(pool, send, {
      workerId: "security:provider-boundary",
    });

    expect(await processor.tick()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          `SELECT state, attempt_count
           FROM security_notification_outbox WHERE id = $1`,
          [inserted.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({ state: "queued", attempt_count: 0 });
  });

  it("renders fixed security copy and never reflects arbitrary payload HTML", () => {
    const content = securityNotificationContent(
      "account_identity_disabled",
      { reason: "<img src=x onerror=alert(1)>" },
    );
    expect(content.subject).toMatch(/sign-in identity/i);
    expect(content.html).not.toContain("<img");
    expect(content.html).not.toContain("onerror");
    expect(content.html).toContain("hello@zeros.build");
  });
});
