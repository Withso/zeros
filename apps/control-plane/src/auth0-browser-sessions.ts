import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type pg from "pg";
import { withSystemTx } from "./db.js";
import { rateLimit } from "./ratelimit.js";
import { clientAddress } from "./client-address.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const capability = z.string().regex(/^(?:z0d_)?[A-Za-z0-9_-]{43}$/);
const dataSchema = z.object({
  sub: z.string().min(1).max(512), email: z.string().min(3).max(254), name: z.string().max(500).nullable(),
  accessToken: z.string().min(1).max(32_768), refreshToken: z.string().min(1).max(32_768).nullable(),
  verifiedAt: z.number().finite().nonnegative().optional(),
});
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), sessionId: opaque, data: dataSchema, issuedAt: z.number().int().positive() }),
  z.object({ action: z.literal("read"), sessionId: capability }),
  z.object({ action: z.literal("begin"), sessionId: capability, revision: z.number().int().positive() }),
  z.object({ action: z.literal("commit"), sessionId: capability, lease: opaque, data: dataSchema }),
  z.object({ action: z.literal("release"), sessionId: capability, lease: opaque, terminal: z.boolean() }),
  z.object({ action: z.literal("revoke"), sessionId: capability, all: z.boolean().optional() }),
  z.object({ action: z.literal("ticket"), sessionId: opaque, ticket: opaque, challenge: opaque }),
  z.object({ action: z.literal("redeem"), sessionId: opaque, challenge: opaque }),
]);
export type Auth0SessionData = z.infer<typeof dataSchema>;
type Command = z.infer<typeof requestSchema>;
type Row = { credential_hash: Buffer; sealed_data: string | null; provider_sub: string; revision: string;
  expires_at: Date; refresh_lease_hash: Buffer | null; refresh_deadline_at: Date | null; revoked_at: Date | null; browser_revoked_at: Date | null };
export type Auth0SessionResult = { status: "terminal"; revokedAll?: boolean } | {
  status: "active" | "busy" | "lease"; data: Auth0SessionData; revision: number; expiresAt: number; lease?: string; desktopCredential?: string;
};
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LEASE_MS = 30_000;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Only the Pages server can call this service. Token payloads are encrypted
 * at rest and bound to the opaque session's digest. A lease is never reissued
 * after an ambiguous timeout: reusing a rotated refresh token is unsafe. */
export class Auth0BrowserSessionAuthority {
  private readonly encryptionKey: Buffer;
  constructor(private readonly pool: pg.Pool, key: string, private readonly now = Date.now) {
    if (!/^[a-f\d]{64}$/i.test(key)) throw new Error("Invalid Auth0 session authority key");
    this.encryptionKey = digest(`zeros-auth0-session-encryption-v1:${key}`);
  }
  private seal(data: Auth0SessionData, hash: Buffer): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(hash);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
  }
  private open(sealed: string, hash: Buffer): Auth0SessionData {
    const bytes = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, bytes.subarray(0, 12));
    decipher.setAAD(hash); decipher.setAuthTag(bytes.subarray(12, 28));
    return dataSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")));
  }

  async execute(input: Command): Promise<Auth0SessionResult> {
    const command = requestSchema.parse(input);
    const credentialHash = digest(command.sessionId);
    return withSystemTx(this.pool, async tx => {
      let now = this.now();
      let hash: Buffer = credentialHash;
      const desktop = command.sessionId.startsWith("z0d_");
      if (desktop) {
        const device = (await tx.query<{ source_hash: Buffer }>(`SELECT source_hash FROM auth0_desktop_sessions
          WHERE credential_hash=$1`, [credentialHash])).rows[0];
        if (!device) return { status: "terminal" };
        hash = device.source_hash;
      }
      if (command.action === "redeem") {
        const ticket = (await tx.query<{ source_hash: Buffer }>(`SELECT source_hash FROM auth0_handoff_tickets
          WHERE ticket_hash=$1 AND challenge=$2 AND expires_at>$3`, [credentialHash, command.challenge, new Date(now)])).rows[0];
        if (!ticket) return { status: "terminal" };
        hash = ticket.source_hash;
      }
      if (command.action === "create" || (command.action === "revoke" && command.all)) {
        const subject = command.action === "create" ? command.data.sub :
          (await tx.query<{ provider_sub: string }>("SELECT provider_sub FROM auth0_browser_sessions WHERE credential_hash=$1", [hash])).rows[0]?.provider_sub;
        if (!subject) return { status: "terminal" };
        // Serialize account-wide revocation with new session publication. A
        // row lock cannot cover a session which has not been inserted yet.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 17)) /*lock_purpose='auth0-session-authority'*/", [`auth0-session:${subject}`]);
        now = this.now();
      }
      if (command.action === "create") {
        const cutoff = (await tx.query<{ revoked_before: Date }>(
          "SELECT revoked_before FROM auth0_session_revocations WHERE provider_sub=$1", [command.data.sub])).rows[0];
        if (command.issuedAt * 1000 > now + 300_000 || (cutoff && command.issuedAt * 1000 <= cutoff.revoked_before.getTime()))
          return { status: "terminal" };
        // Bounded cleanup removes expired token material even if its owner
        // never revisits the session; tombstones still fence stale writers.
        await tx.query(`WITH expired AS (SELECT credential_hash FROM auth0_browser_sessions
          WHERE expires_at<$1 AND sealed_data IS NOT NULL LIMIT 100 FOR UPDATE SKIP LOCKED)
          UPDATE auth0_browser_sessions s SET sealed_data=NULL,revoked_at=COALESCE(s.revoked_at,$1),
          refresh_lease_hash=NULL,refresh_deadline_at=NULL FROM expired e WHERE s.credential_hash=e.credential_hash`, [new Date(now)]);
        const data = { ...command.data, verifiedAt: now };
        const inserted = await tx.query(`INSERT INTO auth0_browser_sessions(credential_hash,sealed_data,provider_sub,expires_at)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision`, [hash, this.seal(data, hash), data.sub, new Date(now + TTL_MS)]);
        return inserted.rowCount ? { status: "active", data, revision: 1, expiresAt: now + TTL_MS } : { status: "terminal" };
      }
      if (command.action === "revoke" && command.all) {
        // Account-wide revocations take the complete ordered lock set before
        // any individual row, so simultaneous revocations cannot deadlock.
        await tx.query(`SELECT credential_hash FROM auth0_browser_sessions WHERE provider_sub=(
          SELECT provider_sub FROM auth0_browser_sessions WHERE credential_hash=$1) ORDER BY credential_hash FOR UPDATE`, [hash]);
      }
      const row = (await tx.query<Row>("SELECT * FROM auth0_browser_sessions WHERE credential_hash=$1 FOR UPDATE", [hash])).rows[0];
      now = this.now();
      const revoke = async () => {
        await tx.query(`UPDATE auth0_browser_sessions SET revoked_at=COALESCE(revoked_at,$2),sealed_data=NULL,
          refresh_lease_hash=NULL,refresh_deadline_at=NULL WHERE credential_hash=$1`, [hash, new Date(now)]);
        return { status: "terminal" as const };
      };
      if (!row) return { status: "terminal" };
      if (row.revoked_at || row.expires_at.getTime() <= now ||
        (row.refresh_deadline_at && row.refresh_deadline_at.getTime() <= now)) return revoke();
      // Recheck the device after locking its grant, fencing a concurrent revoke.
      const callerRevoked = desktop
        ? !(await tx.query(`SELECT 1 FROM auth0_desktop_sessions WHERE credential_hash=$1 AND revoked_at IS NULL AND expires_at>$2`, [credentialHash, new Date(now)])).rowCount
        : !!row.browser_revoked_at;
      // An already admitted refresh can persist its rotated grant for remaining
      // devices after its caller logs out. It never returns a bearer to that caller.
      if (callerRevoked && command.action !== "commit" && command.action !== "release") return { status: "terminal" };
      if (command.action === "revoke") {
        if (command.all) {
          await tx.query(`UPDATE auth0_browser_sessions SET revoked_at=$2,browser_revoked_at=$2,sealed_data=NULL,
            refresh_lease_hash=NULL,refresh_deadline_at=NULL WHERE provider_sub=$1 AND revoked_at IS NULL`, [row.provider_sub, new Date(now)]);
          await tx.query(`INSERT INTO auth0_session_revocations(provider_sub,revoked_before) VALUES($1,$2)
            ON CONFLICT(provider_sub) DO UPDATE SET revoked_before=GREATEST(auth0_session_revocations.revoked_before,EXCLUDED.revoked_before)`, [row.provider_sub, new Date(now)]);
          return { status: "terminal", revokedAll: true };
        }
        if (desktop) await tx.query("UPDATE auth0_desktop_sessions SET revoked_at=$2 WHERE credential_hash=$1", [credentialHash, new Date(now)]);
        else {
          await tx.query("UPDATE auth0_browser_sessions SET browser_revoked_at=$2 WHERE credential_hash=$1", [hash, new Date(now)]);
          await tx.query("DELETE FROM auth0_handoff_tickets WHERE source_hash=$1", [hash]);
        }
        const liveDevices = await tx.query("SELECT 1 FROM auth0_desktop_sessions WHERE source_hash=$1 AND revoked_at IS NULL AND expires_at>$2 LIMIT 1", [hash, new Date(now)]);
        if ((!desktop || row.browser_revoked_at) && !liveDevices.rowCount) return revoke();
        return { status: "terminal" };
      }
      if (!row.sealed_data) return revoke();
      let data: Auth0SessionData;
      try { data = this.open(row.sealed_data, hash); } catch { return revoke(); }
      const revision = Number(row.revision);
      const expiresAt = row.expires_at.getTime();
      const active = (): Auth0SessionResult => ({ status: "active", data, revision, expiresAt });
      const busy = (): Auth0SessionResult => ({ status: "busy", data: { ...data, accessToken: "", refreshToken: null }, revision, expiresAt });
      if (command.action === "ticket") {
        if (row.refresh_lease_hash) return busy();
        await tx.query("DELETE FROM auth0_handoff_tickets WHERE source_hash=$1 AND expires_at<=$2", [hash, new Date(now)]);
        if ((await tx.query("SELECT 1 FROM auth0_handoff_tickets WHERE source_hash=$1 LIMIT 5", [hash])).rowCount === 5) return busy();
        const inserted = await tx.query(`INSERT INTO auth0_handoff_tickets(ticket_hash,source_hash,challenge,expires_at)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [digest(command.ticket), hash, command.challenge, new Date(Math.min(expiresAt, now + 90_000))]);
        return inserted.rowCount ? active() : { status: "terminal" };
      }
      if (command.action === "redeem") {
        if (row.refresh_lease_hash) return busy();
        if ((await tx.query("SELECT 1 FROM auth0_desktop_sessions WHERE source_hash=$1 AND revoked_at IS NULL AND expires_at>$2 LIMIT 32", [hash, new Date(now)])).rowCount === 32) return busy();
        const consumed = await tx.query(`DELETE FROM auth0_handoff_tickets WHERE ticket_hash=$1 AND source_hash=$2 AND challenge=$3 AND expires_at>$4 RETURNING ticket_hash`,
          [credentialHash, hash, command.challenge, new Date(now)]);
        if (!consumed.rowCount) return { status: "terminal" };
        const desktopCredential = `z0d_${randomBytes(32).toString("base64url")}`;
        await tx.query(`INSERT INTO auth0_desktop_sessions(credential_hash,source_hash,expires_at) VALUES($1,$2,$3)`, [digest(desktopCredential), hash, row.expires_at]);
        return { status: "active", data, revision, expiresAt, desktopCredential };
      }
      if (command.action === "read") return row.refresh_lease_hash ? busy() : active();
      if (command.action === "begin") {
        if (row.refresh_lease_hash) return busy();
        if (command.revision !== revision) return active();
        const lease = randomBytes(32).toString("base64url");
        await tx.query(`UPDATE auth0_browser_sessions SET refresh_lease_hash=$2,refresh_deadline_at=$3 WHERE credential_hash=$1`,
          [hash, digest(lease), new Date(now + LEASE_MS)]);
        return { status: "lease", data, revision, expiresAt, lease };
      }
      if (!row.refresh_lease_hash || !timingSafeEqual(row.refresh_lease_hash, digest(command.lease))) return { status: "terminal" };
      if (command.action === "release") {
        if (command.terminal) return revoke();
        await tx.query(`UPDATE auth0_browser_sessions SET refresh_lease_hash=NULL,refresh_deadline_at=NULL WHERE credential_hash=$1`, [hash]);
        return callerRevoked ? { status: "terminal" } : active();
      }
      if (command.data.sub !== data.sub || command.data.email !== data.email || command.data.name !== data.name)
        return revoke();
      const updated = { ...command.data, verifiedAt: now };
      await tx.query(`UPDATE auth0_browser_sessions SET sealed_data=$2,revision=revision+1,refresh_lease_hash=NULL,refresh_deadline_at=NULL
        WHERE credential_hash=$1`, [hash, this.seal(updated, hash)]);
      return callerRevoked ? { status: "terminal" } : { status: "active", data: updated, revision: revision + 1, expiresAt };
    });
  }
}

/** Global sign-out denies already-issued Auth0 bearers as well as refresh
 * capabilities. A JWT without an issue time cannot bypass a revocation. */
export function auth0TokenIsRevoked(pool: pg.Pool, subject: string, issuedAt: number | undefined): Promise<boolean> {
  return withSystemTx(pool, async tx => {
    const row = (await tx.query<{ revoked_before: Date }>("SELECT revoked_before FROM auth0_session_revocations WHERE provider_sub=$1", [subject])).rows[0];
    return !!row && (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || issuedAt * 1000 <= row.revoked_before.getTime());
  });
}

export function createAuth0BrowserSessionRoutes(authority: Auth0BrowserSessionAuthority, serviceKey: string) {
  const app = new Hono();
  const route = "/auth/compat/session";
  app.use(route, async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); await next(); });
  app.use(route, bodyLimit({ maxSize: 128 * 1024 }));
  const unauthenticated = rateLimit("auth0-session-preauth", 30, 60_000, c => clientAddress(name => c.req.header(name)));
  const expected = digest(`Bearer ${serviceKey}`);
  app.use(route, async (c, next) => {
    if (!timingSafeEqual(digest(c.req.header("authorization") ?? ""), expected))
      return unauthenticated(c, async () => { c.res = c.json({ error: "unauthorized" }, 401); });
    await next();
  });
  app.post(route, async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad_request" }, 400); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    return c.json(await authority.execute(parsed.data));
  });
  return app;
}
