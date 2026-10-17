import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";

/** A device session lives while the device keeps reconnecting; each issue
 * slides it. The CP session it is bound to is re-read on every consume. */
export const DEVICE_SESSION_TTL_MS = 24 * 60 * 60_000;
/** S3: a stream ticket is single-use and valid 60 s. */
export const DEVICE_STREAM_TICKET_TTL_MS = 60_000;
/** Unexpired device sessions retained per account; older ones are dropped. */
export const MAX_DEVICE_SESSIONS_PER_ACCOUNT = 20;
const TICKET = /^zds_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DeviceSessionPrincipal = Readonly<{
  deviceSessionId: string;
  accountUserId: string;
  deviceId: string;
  /** The provider session behind the CP session; null for a legacy token. */
  providerSessionId: string | null;
}>;

export type IssuedDeviceSession = { deviceSessionId: string; ticket: string; ticketExpiresAt: Date; reused: boolean };

function ticketDigest(ticket: string): Buffer {
  return createHash("sha256").update(ticket, "utf8").digest();
}

/** Issues a fresh ticket inside the caller's transaction, after its device
 * proof was consumed in the same transaction. `reuseId` keeps the same device
 * session when it belongs to the same account, CP session and device and has
 * not expired; any outstanding ticket of that session is replaced. */
export async function issueDeviceSession(tx: Tx, input: {
  accountUserId: string; deviceId: string; providerSessionId: string | null; reuseId: string | null;
}): Promise<IssuedDeviceSession> {
  const ticket = `zds_${randomBytes(32).toString("base64url")}`;
  const digest = ticketDigest(ticket);
  await tx.query("DELETE FROM cloud_device_sessions WHERE user_id=$1 AND expires_at<=clock_timestamp()", [input.accountUserId]);
  if (input.reuseId !== null && UUID.test(input.reuseId)) {
    const reused = (await tx.query<{ id: string; ticket_expires_at: Date }>(
      `UPDATE cloud_device_sessions SET ticket_hash=$5, ticket_expires_at=clock_timestamp() + $6 * interval '1 millisecond',
         ticket_consumed_at=NULL, expires_at=clock_timestamp() + $7 * interval '1 millisecond'
       WHERE id=$1 AND user_id=$2 AND device_id=$3 AND provider_session_id IS NOT DISTINCT FROM $4
         AND expires_at>clock_timestamp()
       RETURNING id, ticket_expires_at`,
      [input.reuseId, input.accountUserId, input.deviceId, input.providerSessionId, digest,
        DEVICE_STREAM_TICKET_TTL_MS, DEVICE_SESSION_TTL_MS])).rows[0];
    if (reused) return { deviceSessionId: reused.id, ticket, ticketExpiresAt: reused.ticket_expires_at, reused: true };
  }
  const created = (await tx.query<{ id: string; ticket_expires_at: Date }>(
    `INSERT INTO cloud_device_sessions(id, user_id, device_id, provider_session_id, ticket_hash, ticket_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + $6 * interval '1 millisecond', clock_timestamp() + $7 * interval '1 millisecond')
     RETURNING id, ticket_expires_at`,
    [randomUUID(), input.accountUserId, input.deviceId, input.providerSessionId, digest,
      DEVICE_STREAM_TICKET_TTL_MS, DEVICE_SESSION_TTL_MS])).rows[0]!;
  await tx.query(
    `DELETE FROM cloud_device_sessions WHERE id IN (
       SELECT id FROM cloud_device_sessions WHERE user_id=$1 ORDER BY expires_at DESC, id OFFSET $2)`,
    [input.accountUserId, MAX_DEVICE_SESSIONS_PER_ACCOUNT]);
  return { deviceSessionId: created.id, ticket, ticketExpiresAt: created.ticket_expires_at, reused: false };
}

const ACCOUNT_ACTIVE = `EXISTS (SELECT 1 FROM users account WHERE account.id = ds.user_id
    AND account.auth_status = 'active' AND account.deleted_at IS NULL)`;
const DEVICE_TRUSTED = `EXISTS (SELECT 1 FROM devices device WHERE device.id = ds.device_id AND device.user_id = ds.user_id
    AND device.trust_state = 'trusted' AND device.revoked_at IS NULL)`;
const SESSION_ACTIVE = `(ds.provider_session_id IS NULL OR EXISTS (SELECT 1 FROM auth_sessions session
    WHERE session.provider = 'workos' AND session.provider_session_id = ds.provider_session_id
      AND session.user_id = ds.user_id AND session.status = 'active' AND session.revoked_at IS NULL
      AND (session.provider_session_expires_at IS NULL OR session.provider_session_expires_at > now())))`;

/** Whether a device session may still stream: the account is active, the
 * device trusted, the CP session (when bound) active, and the device session
 * unexpired. One predicate for consume and every later recheck. */
const LIVE = `ds.expires_at > clock_timestamp() AND ${ACCOUNT_ACTIVE} AND ${DEVICE_TRUSTED} AND ${SESSION_ACTIVE}`;

/** Whether a device session is live and was issued to this account, device
 * and CP session: what a runtime connection names so renewals can reach it. */
export async function deviceSessionLive(tx: Tx, input: {
  deviceSessionId: string; accountUserId: string; deviceId: string; providerSessionId: string | null;
}): Promise<boolean> {
  if (!UUID.test(input.deviceSessionId)) return false;
  const row = (await tx.query<{ live: boolean }>(
    `SELECT (${LIVE}) AS live FROM cloud_device_sessions ds
     WHERE ds.id = $1 AND ds.user_id = $2 AND ds.device_id = $3 AND ds.provider_session_id IS NOT DISTINCT FROM $4`,
    [input.deviceSessionId, input.accountUserId, input.deviceId, input.providerSessionId])).rows[0];
  return row?.live === true;
}

/** Why a device session may no longer stream, in the order it is checked;
 * maps onto the `capability.revoked` scope the stream sends before 4401. */
export type DeviceSessionState = "live" | "expired" | "account" | "device" | "session";

/** Ticket admission and authority rechecks for the realtime device stream. */
export interface DeviceSessionAuthority {
  /** Consumes a ticket exactly once. Null for a malformed, unknown, expired,
   * reused or no-longer-authorized ticket; the caller closes with 4401. */
  consume(ticket: unknown): Promise<DeviceSessionPrincipal | null>;
  /** The current state of each device session; unknown ids read "expired". */
  check(deviceSessionIds: readonly string[]): Promise<Map<string, DeviceSessionState>>;
}

export class DatabaseDeviceSessionAuthority implements DeviceSessionAuthority {
  constructor(private readonly pool: pg.Pool) {}

  async consume(ticket: unknown): Promise<DeviceSessionPrincipal | null> {
    if (typeof ticket !== "string" || !TICKET.test(ticket)) return null;
    const digest = ticketDigest(ticket);
    return withSystemTx(this.pool, async tx => {
      // The UPDATE commits the consume even when authority then fails, so a
      // ticket can never be tried twice. Row locking makes a concurrent
      // consume on another instance re-check ticket_consumed_at and miss.
      const row = (await tx.query<{ id: string; user_id: string; device_id: string; provider_session_id: string | null; live: boolean }>(
        `WITH consumed AS (
           UPDATE cloud_device_sessions SET ticket_consumed_at = clock_timestamp()
           WHERE ticket_hash = $1 AND ticket_consumed_at IS NULL AND ticket_expires_at > clock_timestamp()
             AND expires_at > clock_timestamp()
           RETURNING id, user_id, device_id, provider_session_id, expires_at)
         SELECT ds.id, ds.user_id, ds.device_id, ds.provider_session_id, (${LIVE}) AS live FROM consumed ds`,
        [digest])).rows[0];
      if (!row?.live) return null;
      return { deviceSessionId: row.id, accountUserId: row.user_id, deviceId: row.device_id, providerSessionId: row.provider_session_id };
    });
  }

  async check(deviceSessionIds: readonly string[]): Promise<Map<string, DeviceSessionState>> {
    const ids = [...new Set(deviceSessionIds)];
    const states = new Map<string, DeviceSessionState>(ids.map(id => [id, "expired"]));
    const valid = ids.filter(id => UUID.test(id));
    for (let offset = 0; offset < valid.length; offset += 1_000) {
      const rows = await withSystemTx(this.pool, tx => tx.query<{ id: string; state: DeviceSessionState }>(
        `SELECT ds.id, CASE WHEN ds.expires_at <= clock_timestamp() THEN 'expired'
           WHEN NOT ${ACCOUNT_ACTIVE} THEN 'account' WHEN NOT ${DEVICE_TRUSTED} THEN 'device'
           WHEN NOT ${SESSION_ACTIVE} THEN 'session' ELSE 'live' END AS state
         FROM cloud_device_sessions ds WHERE ds.id = ANY($1::uuid[])`,
        [valid.slice(offset, offset + 1_000)]));
      for (const row of rows.rows) states.set(row.id, row.state);
    }
    return states;
  }
}
