import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import { z } from "zod";

import { withSystemTx, type Tx } from "./db.js";

const EventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const AvatarSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  })
  .nullable();

const WorkOSIdentityEventSchema = z.object({
  eventId: EventIdSchema,
  eventType: z.enum(["user.updated", "user.deleted"]),
  createdAt: z.string().datetime({ offset: true }),
  user: z.object({
    id: EventIdSchema,
    email: z.string().trim().toLowerCase().email().max(254),
    emailVerified: z.boolean(),
    name: z.string().max(500).nullable(),
    profilePictureUrl: AvatarSchema,
  }),
});

export type WorkOSIdentityEvent = z.infer<typeof WorkOSIdentityEventSchema>;
export type WorkOSIdentityEventStatus =
  | "applied"
  | "duplicate"
  | "unlinked"
  | "email_conflict"
  | "ignored_unverified"
  | "ignored_deleted"
  | "stale";

export function brokerSecretMatches(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function finishEvent(
  tx: Tx,
  eventId: string,
  status: Exclude<WorkOSIdentityEventStatus, "duplicate">,
  userId: string | null,
): Promise<{ status: WorkOSIdentityEventStatus }> {
  await tx.query(
    `UPDATE identity_provider_events
     SET status = $2, user_id = $3, processed_at = now()
     WHERE event_id = $1`,
    [eventId, status, userId],
  );
  return { status };
}

async function applyInTransaction(
  tx: Tx,
  event: WorkOSIdentityEvent,
): Promise<{ status: WorkOSIdentityEventStatus }> {
  const inserted = await tx.query(
    `INSERT INTO identity_provider_events (
       event_id, event_type, event_created_at, provider_sub, email,
       email_verified, display_name, avatar_url, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.eventId,
      event.eventType,
      event.createdAt,
      event.user.id,
      event.user.email,
      event.user.emailVerified,
      event.user.name,
      event.user.profilePictureUrl,
    ],
  );
  if (!inserted.rows[0]) return { status: "duplicate" };

  // WorkOS may deliver multiple events for one User concurrently. Serialize
  // only this provider subject, not the whole lifecycle consumer.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 2))`, [
    `workos-event:${event.user.id}`,
  ]);
  const linked = await tx.query<{
    user_id: string;
    deleted_at: Date | null;
  }>(
    `SELECT ui.user_id, u.deleted_at
     FROM user_identities ui
     JOIN users u ON u.id = ui.user_id
     WHERE ui.provider = 'workos' AND ui.provider_sub = $1
     FOR UPDATE OF u`,
    [event.user.id],
  );
  const account = linked.rows[0];
  if (!account) return finishEvent(tx, event.eventId, "unlinked", null);

  if (event.eventType === "user.deleted") {
    await tx.query(
      `UPDATE users SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
      [account.user_id],
    );
    return finishEvent(tx, event.eventId, "applied", account.user_id);
  }
  if (account.deleted_at) {
    return finishEvent(tx, event.eventId, "ignored_deleted", account.user_id);
  }
  if (!event.user.emailVerified) {
    return finishEvent(
      tx,
      event.eventId,
      "ignored_unverified",
      account.user_id,
    );
  }

  const newer = await tx.query(
    `SELECT 1 FROM identity_provider_events
     WHERE provider = 'workos' AND provider_sub = $1
       AND event_id <> $2 AND event_created_at > $3
       AND status <> 'received'
     LIMIT 1`,
    [event.user.id, event.eventId, event.createdAt],
  );
  if (newer.rows[0]) {
    return finishEvent(tx, event.eventId, "stale", account.user_id);
  }

  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 3))`, [
    `workos-email:${event.user.email}`,
  ]);
  const collision = await tx.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1`,
    [event.user.email, account.user_id],
  );
  if (collision.rows[0]) {
    // Profile presentation can still move forward; ownership/email cannot.
    await tx.query(
      `UPDATE users SET display_name = $2, avatar_url = $3
       WHERE id = $1 AND deleted_at IS NULL`,
      [account.user_id, event.user.name, event.user.profilePictureUrl],
    );
    return finishEvent(tx, event.eventId, "email_conflict", account.user_id);
  }

  await tx.query(
    `UPDATE users
     SET email = $2, display_name = $3, avatar_url = $4
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      account.user_id,
      event.user.email,
      event.user.name,
      event.user.profilePictureUrl,
    ],
  );
  return finishEvent(tx, event.eventId, "applied", account.user_id);
}

export async function applyWorkOSIdentityEvent(
  pool: pg.Pool,
  input: WorkOSIdentityEvent,
): Promise<{ status: WorkOSIdentityEventStatus }> {
  const event = WorkOSIdentityEventSchema.parse(input);
  return withSystemTx(pool, (tx) => applyInTransaction(tx, event));
}

export function createWorkOSIdentityEventRoutes(
  pool: pg.Pool,
  brokerSecret: string,
): Hono {
  const app = new Hono();
  const path = "/internal/auth/workos/events";

  app.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (
      !brokerSecretMatches(
        brokerSecret,
        c.req.header("x-zeros-auth-broker") ?? "",
      )
    ) {
      return c.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        401,
      );
    }
    await next();
  });
  app.use(path, bodyLimit({ maxSize: 64 * 1024 }));
  app.post(path, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = WorkOSIdentityEventSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: { code: "invalid_event", message: "Invalid lifecycle event" } },
        422,
      );
    }
    const result = await applyWorkOSIdentityEvent(pool, parsed.data);
    return c.json({ ok: true, status: result.status });
  });
  return app;
}
