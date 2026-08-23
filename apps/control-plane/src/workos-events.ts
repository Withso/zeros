import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import { withSystemTx, type Tx } from "./db.js";

const EventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const MAX_WEBHOOK_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_MS = 3 * 60 * 1_000;
const LIFECYCLE_EVENTS = new Set(["user.updated", "user.deleted"]);
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
    // The provider deletion already ends the account. Remove every local
    // opaque browser credential for this subject in the same transaction so a
    // cached sealed session cannot keep the web shell looking signed in.
    await tx.query(
      `DELETE FROM workos_browser_sessions WHERE provider_sub = $1`,
      [event.user.id],
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

function signatureValid(
  rawBody: Buffer,
  header: string,
  secret: string,
  now: number,
): boolean {
  const match = /^t=(\d+)\s*,\s*v1=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_MS
  ) {
    return false;
  }
  const supplied = Buffer.from(match[2]!, "hex");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

async function boundedBody(request: Request): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(part.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

function safeAvatar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function lifecycleEvent(value: unknown): WorkOSIdentityEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !EventIdSchema.safeParse(raw.id).success ||
    (raw.event !== "user.updated" && raw.event !== "user.deleted") ||
    typeof raw.created_at !== "string" ||
    !Number.isFinite(Date.parse(raw.created_at)) ||
    !raw.data ||
    typeof raw.data !== "object"
  ) {
    return null;
  }
  const user = raw.data as Record<string, unknown>;
  const candidate = {
    eventId: raw.id,
    eventType: raw.event,
    createdAt: raw.created_at,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.email_verified,
      name: typeof user.name === "string" ? user.name : null,
      profilePictureUrl: safeAvatar(user.profile_picture_url),
    },
  };
  const parsed = WorkOSIdentityEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function createWorkOSIdentityEventRoutes(
  pool: pg.Pool,
  webhookSecret: string,
  options: {
    now?: () => number;
    apply?: (
      event: WorkOSIdentityEvent,
    ) => Promise<{ status: WorkOSIdentityEventStatus }>;
  } = {},
): Hono {
  const app = new Hono();
  app.post("/auth/workos-webhook", async (c) => {
    const body = await boundedBody(c.req.raw);
    if (!body) return json({ error: "body_too_large" }, 413);
    if (
      !signatureValid(
        body,
        c.req.header("workos-signature") ?? "",
        webhookSecret,
        (options.now ?? Date.now)(),
      )
    ) {
      return json({ error: "invalid_signature" }, 401);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      return json({ error: "invalid_event" }, 400);
    }
    const eventName =
      raw && typeof raw === "object" && "event" in raw
        ? (raw as { event?: unknown }).event
        : null;
    if (typeof eventName === "string" && !LIFECYCLE_EVENTS.has(eventName)) {
      return json({ accepted: true, ignored: true }, 202);
    }
    const event = lifecycleEvent(raw);
    if (!event) return json({ error: "invalid_event" }, 400);
    const result = await (
      options.apply ?? ((input) => applyWorkOSIdentityEvent(pool, input))
    )(event);
    return json({ accepted: true, status: result.status }, 202);
  });
  return app;
}
