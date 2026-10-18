import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "./db.js";
import type { WorkOSDesktopProvider } from "./workos-provider.js";
import type { JobHandler } from "./job-runner.js";
import { enqueueJob, JobError } from "./job-queue.js";

export type SourceSessionIdentity = { rowId: string; userId: string; accountRevision: number };
/** Evidence for enrollment, never execution authority. The enrollment
 * transaction must recheck the active account/source and this exact version. */
export type AuthSessionProviderProof = Readonly<SourceSessionIdentity & {
  proofVersion: number; expiresAtMs: number; observedAtMs: number;
}>;
export class ProviderSessionProofUnavailable extends Error {
  readonly code = "provider_session_proof_unavailable";
  constructor() { super("Provider session proof is unavailable"); }
}

const SOURCE = z.object({ rowId: z.string().uuid(), userId: z.string().uuid(), accountRevision: z.number().int().positive().safe() }).strict();
const EXPIRY_JOB = z.object({ rowId: z.string().uuid(), proofVersion: z.number().int().positive().safe(),
  expiresAtMs: z.number().int().positive().max(253402300799999) }).strict();
const TIMESTAMP = z.string().datetime({ offset: true });
const KIND = "auth_session_expire";
const LOOKUP_MS = 5_000;
const PROOF_MS = 10_000;
const MAX_ENTRIES = 256;

type SourceRow = {
  id: string; user_id: string; provider_sub: string; provider_session_id: string; identity_id: string;
  provider_session_expires_at: Date | null; last_provider_event_at: Date | null;
  provider_session_proof_version: string; provider_session_proved_at: Date | null; db_now: Date;
};
type CachedProof = { proof: AuthSessionProviderProof; fingerprint: string; monotonicStart: number };
type ProofResult = { proof: AuthSessionProviderProof } | { error: unknown };
type ProofWaiter = (result: ProofResult) => void;
type Flight = { controller: AbortController; promise: Promise<AuthSessionProviderProof>; waiters: Set<ProofWaiter>; settled: boolean };

function unavailable(): never { throw new ProviderSessionProofUnavailable(); }
function live(signal?: AbortSignal): void { if (signal?.aborted) unavailable(); }
function fingerprint(row: SourceRow): string {
  return JSON.stringify([row.id, row.user_id, row.provider_sub, row.provider_session_id, row.identity_id,
    row.provider_session_expires_at, row.last_provider_event_at, row.provider_session_proof_version, row.provider_session_proved_at]);
}

async function readSource(tx: Tx, input: SourceSessionIdentity, lock = false): Promise<SourceRow> {
  if (lock) {
    // Account/identity before source, like account lifecycle writes. No provider
    // I/O occurs under any of these locks. Revocation always wins a late read.
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [input.userId]);
    await tx.query("SELECT id FROM user_identities WHERE user_id=$1 AND provider='workos' FOR SHARE", [input.userId]);
    await tx.query("SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE", [input.rowId]);
  }
  const result = await tx.query<SourceRow>(`SELECT source.id, source.user_id, source.provider_sub, source.provider_session_id,
    source.provider_session_expires_at, source.last_provider_event_at, source.provider_session_proof_version,
    source.provider_session_proved_at, identity.id AS identity_id, clock_timestamp() AS db_now
    FROM auth_sessions source JOIN users account ON account.id=source.user_id
    JOIN user_identities identity ON identity.provider='workos' AND identity.provider_sub=source.provider_sub
      AND identity.user_id=account.id AND identity.status='active'
    WHERE source.id=$1 AND source.provider='workos' AND source.user_id=$2
      AND source.status='active' AND source.revoked_at IS NULL
      AND account.auth_status='active' AND account.deleted_at IS NULL AND account.auth_revision=$3`,
  [input.rowId, input.userId, input.accountRevision]);
  return result.rows[0] ?? unavailable();
}

/** Only a future enrollment caller constructs/uses this service. It has no
 * timer or provider reads while dormant, and is never a continuation fallback. */
export class AuthSessionProofService {
  private readonly cache = new Map<string, CachedProof>();
  private readonly flights = new Map<string, Flight>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly maxEntries: number;
  private disposed = false;

  constructor(private readonly pool: pg.Pool, private readonly provider: Pick<WorkOSDesktopProvider, "listSessions">,
    options: { now?: () => number; monotonicNow?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ENTRIES)
      throw new Error("provider_session_proof_options_invalid");
  }

  prove(input: SourceSessionIdentity, signal?: AbortSignal): Promise<AuthSessionProviderProof> {
    const parsed = SOURCE.safeParse(input);
    if (this.disposed || signal?.aborted || !parsed.success)
      return Promise.reject(new ProviderSessionProofUnavailable());
    input = parsed.data;
    const key = JSON.stringify([input.rowId, input.userId, input.accountRevision]);
    let flight = this.flights.get(key);
    if (!flight) {
      if (this.flights.size >= this.maxEntries) return Promise.reject(new ProviderSessionProofUnavailable());
      const controller = new AbortController();
      flight = { controller, waiters: new Set(), settled: false, promise: this.resolve(key, input, controller.signal) };
      this.flights.set(key, flight);
      const owned = flight;
      const settled = (result: ProofResult) => {
        owned.settled = true;
        if (this.flights.get(key) === owned) this.flights.delete(key);
        for (const waiter of owned.waiters) waiter(result);
      };
      // One reaction per flight. A cancelled caller must be removable while
      // another caller keeps the shared lookup alive; Promise.then callbacks
      // cannot be detached and would accumulate despite the live-waiter cap.
      void flight.promise.then(proof => settled({ proof }), error => settled({ error }));
    }
    if (flight.waiters.size >= MAX_ENTRIES || flight.controller.signal.aborted)
      return Promise.reject(new ProviderSessionProofUnavailable());
    const owned = flight;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        owned.waiters.delete(waiter);
        if (owned.waiters.size === 0 && !owned.settled) owned.controller.abort();
        return true;
      };
      const cancel = () => { if (finish()) reject(new ProviderSessionProofUnavailable()); };
      const waiter: ProofWaiter = result => {
        if (!finish()) return;
        if (signal?.aborted) reject(new ProviderSessionProofUnavailable());
        else if ("error" in result) reject(result.error);
        else resolve(result.proof);
      };
      owned.waiters.add(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const flight of this.flights.values()) flight.controller.abort();
    this.cache.clear();
  }

  private fresh(value: CachedProof): boolean {
    const wallAge = this.now() - value.proof.observedAtMs, age = this.monotonicNow() - value.monotonicStart;
    return wallAge >= 0 && wallAge < PROOF_MS && age >= 0 && age < PROOF_MS && value.proof.expiresAtMs > this.now();
  }

  private async resolve(key: string, input: SourceSessionIdentity, signal: AbortSignal): Promise<AuthSessionProviderProof> {
    try {
      live(signal);
      const before = await withSystemTx(this.pool, tx => readSource(tx, input));
      live(signal);
      for (const [entry, value] of this.cache) if (!this.fresh(value)) this.cache.delete(entry);
      const cached = this.cache.get(key);
      if (cached && cached.fingerprint === fingerprint(before) && cached.proof.expiresAtMs > before.db_now.getTime()) return cached.proof;
      this.cache.delete(key);
      const observedAtMs = this.now(), monotonicStart = this.monotonicNow();
      const expiresAtMs = await this.lookup(before, signal);
      const version = Number(before.provider_session_proof_version) + 1;
      if (!Number.isSafeInteger(version)) unavailable();
      const proof: AuthSessionProviderProof = Object.freeze({ ...input, proofVersion: version, expiresAtMs, observedAtMs });
      const entry: CachedProof = { proof, monotonicStart, fingerprint: "" };
      await withSystemTx(this.pool, async tx => {
        const current = await readSource(tx, input, true);
        live(signal);
        if (!this.fresh(entry) || fingerprint(current) !== fingerprint(before) || expiresAtMs <= current.db_now.getTime()) unavailable();
        await tx.query(`UPDATE auth_sessions SET provider_session_expires_at=$2, provider_session_proved_at=$3,
          provider_session_proof_version=$4 WHERE id=$1`, [input.rowId, new Date(expiresAtMs), new Date(observedAtMs), version]);
        await enqueueAuthSessionExpiry(tx, { rowId: input.rowId, proofVersion: version, expiresAtMs });
        live(signal);
        if (!this.fresh(entry)) unavailable();
        entry.fingerprint = fingerprint({ ...current, provider_session_proof_version: String(version),
          provider_session_proved_at: new Date(observedAtMs), provider_session_expires_at: new Date(expiresAtMs) });
      });
      live(signal);
      if (!this.fresh(entry)) unavailable();
      while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, entry);
      return proof;
    } catch { unavailable(); }
  }

  private async lookup(source: SourceRow, caller: AbortSignal): Promise<number> {
    const deadline = new AbortController(), signal = AbortSignal.any([caller, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), LOOKUP_MS);
    const started = this.monotonicNow();
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new ProviderSessionProofUnavailable());
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      return await Promise.race([aborted, (async () => {
        const cursors = new Set<string>();
        let after: string | undefined;
        for (let page = 0; page < 4; page++) {
          live(signal);
          const result = await this.provider.listSessions(source.provider_sub, { limit: 100, ...(after ? { after } : {}), signal });
          live(signal);
          const age = this.monotonicNow() - started;
          if (age < 0 || age >= LOOKUP_MS || !Array.isArray(result?.data) || result.data.length > 100) unavailable();
          const matches = result.data.filter(session => session?.id === source.provider_session_id);
          if (matches.length > 1) unavailable();
          const match = matches[0];
          if (match) {
            if (match.userId !== source.provider_sub || match.status !== "active" || !TIMESTAMP.safeParse(match.expiresAt).success) unavailable();
            const expiry = Date.parse(match.expiresAt!);
            if (!Number.isSafeInteger(expiry) || expiry <= this.now() || expiry > 253402300799999) unavailable();
            return expiry;
          }
          const cursor = result.listMetadata?.after;
          if (typeof cursor !== "string" || !cursor.length || cursor.length > 512 || cursors.has(cursor)) unavailable();
          cursors.add(cursor);
          after = cursor;
        }
        return unavailable();
      })()]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
}

/** The payload deliberately contains only an internal row UUID and a versioned
 * deadline; provider identifiers/credentials never enter the generic queue. */
export async function enqueueAuthSessionExpiry(tx: Tx, payload: z.infer<typeof EXPIRY_JOB>): Promise<void> {
  const value = EXPIRY_JOB.parse(payload);
  await enqueueJob(tx, { kind: KIND, dedupeKey: `${value.rowId}:${value.proofVersion}`,
    payload: value, runAt: new Date(value.expiresAtMs), maxAttempts: 100 });
  // Versions advance one at a time. Bound queued work even when a frequently
  // used source is observed for weeks; a claimed older job retains its lease
  // and will fence itself against the source version when it runs.
  await tx.query(`DELETE FROM control_plane_jobs WHERE kind='auth_session_expire'
    AND dedupe_key=$1 AND state='queued'`, [`${value.rowId}:${value.proofVersion - 1}`]);
}

export function authSessionExpiryHandler(pool: pg.Pool): JobHandler {
  return { kind: KIND, leaseMs: 60_000, timeoutMs: 30_000, backoff: { baseMs: 1_000, maxMs: 60_000 },
    handle: async (job, { signal }) => {
      const parsed = EXPIRY_JOB.safeParse(job.payload);
      if (!parsed.success) throw new JobError("invalid_payload", { retryable: false });
      const expected = parsed.data;
      await withSystemTx(pool, async tx => {
        live(signal);
        // Event insertion takes a user FK lock. Acquire it before the source
        // lock so account erasure cannot deadlock on the opposite order.
        const owner = (await tx.query<{ user_id: string | null }>("SELECT user_id FROM auth_sessions WHERE id=$1", [expected.rowId])).rows[0];
        if (!owner) return;
        if (owner.user_id) await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [owner.user_id]);
        const row = (await tx.query<SourceRow & { status: string; due: boolean }>(`SELECT *,
          provider_session_expires_at <= clock_timestamp() AS due FROM auth_sessions WHERE id=$1 FOR UPDATE`, [expected.rowId])).rows[0];
        live(signal);
        if (!row || row.status !== "active" || Number(row.provider_session_proof_version) !== expected.proofVersion ||
            row.provider_session_expires_at?.getTime() !== expected.expiresAtMs) return;
        if (row.user_id !== owner.user_id) throw new JobError("precondition_failed");
        if (!row.due) { await enqueueAuthSessionExpiry(tx, expected); return; }
        await tx.query(`UPDATE auth_sessions SET status='expired', revoked_at=clock_timestamp(),
          revocation_reason='provider_session_expired' WHERE id=$1`, [expected.rowId]);
        await tx.query("DELETE FROM workos_browser_sessions WHERE provider_session_id=$1", [row.provider_session_id]);
        await tx.query(`INSERT INTO security_events(kind, user_id, provider_session_id, payload)
          VALUES ('session.revoked', $1, $2, '{"reason":"provider_session_expired"}'::jsonb)`, [row.user_id, row.provider_session_id]);
        live(signal);
      });
    },
  };
}

/** Bounded startup/hourly repair of missing work. Never calls the provider and
 * never touches a dormant version-zero session or an active job's backoff. */
export async function repairAuthSessionExpiryJobs(pool: pg.Pool): Promise<number> {
  return withSystemTx(pool, async tx => {
    const rows = await tx.query<SourceRow>(`SELECT source.* FROM auth_sessions source
      WHERE source.status='active' AND source.provider_session_proof_version > 0 AND NOT EXISTS (
        SELECT 1 FROM control_plane_jobs job WHERE job.kind='auth_session_expire'
          AND job.dedupe_key=source.id::text || ':' || source.provider_session_proof_version::text
          AND job.state IN ('queued', 'running'))
      ORDER BY source.provider_session_expires_at, source.id LIMIT 256 FOR UPDATE OF source SKIP LOCKED`);
    for (const row of rows.rows) await enqueueAuthSessionExpiry(tx, { rowId: row.id,
      proofVersion: Number(row.provider_session_proof_version), expiresAtMs: row.provider_session_expires_at!.getTime() });
    return rows.rowCount ?? 0;
  });
}
