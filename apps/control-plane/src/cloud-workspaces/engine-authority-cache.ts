import { timingSafeEqual } from "node:crypto";
import type pg from "pg";

import { withSystemTx } from "../db.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "../postgres-notifications.js";
import { ROLLOUT_FLAGS_OFF, type RolloutFlagReader } from "../rollout-flags.js";

export const AUTHORITY_CACHE_CHANNEL = "zeros_cloud_authority_cache";

/** One engine authority subject. `workosEnabled` is process configuration but
 * changes the SQL predicate, so it is part of the key. */
export type EngineAuthorityKey = {
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  workosEnabled: boolean;
};

/** Committed authority facts for one key, read outside any caller
 * transaction. Only rows for which the SQL authority function returned a live,
 * unfenced engine are cached; every negative answer is left to SQL. */
export type EngineAuthorityEntry = {
  authorityEpoch: number;
  accountUserId: string;
  heartbeatTokenHash: Buffer;
  revoked: boolean;
  setupEnrolled: boolean;
  runtimeReady: boolean;
  leaseExpiresAtMs: number;
  /** Registered boot identity, projected for uplink boot binding (S2). */
  runtimeBootId: string | null;
  /** Earliest lease, funding, credential or entitlement deadline, capped by
   * the cache TTL. The entry is unusable from this instant. */
  deadlineMs: number;
};

/** `assert` mirrors assertCurrentCloudEngineAuthority, `read` mirrors
 * readCurrentCloudEngineAuthority. */
export type EngineAuthorityMode = { kind: "assert"; transitionRecordSync?: boolean } | { kind: "read" };

export type EngineAuthorityDecision =
  | { allowed: false }
  | { allowed: true; authorityEpoch: number; accountUserId: string; leaseExpiresAtMs: number; runtimeBootId: string | null;
      /** The cached entry's deadline; a SQL observation carries none. */
      deadlineMs?: number };

const DENIED: EngineAuthorityDecision = Object.freeze({ allowed: false });

export function decideEngineAuthority(
  entry: EngineAuthorityEntry | undefined,
  tokenHash: Buffer,
  mode: EngineAuthorityMode,
  nowMs: number,
): EngineAuthorityDecision {
  if (!entry || nowMs >= entry.deadlineMs || nowMs >= entry.leaseExpiresAtMs) return DENIED;
  if (entry.heartbeatTokenHash.length !== tokenHash.length || !timingSafeEqual(entry.heartbeatTokenHash, tokenHash)) return DENIED;
  const enrolled = entry.setupEnrolled || entry.runtimeReady ||
    (mode.kind === "assert" && mode.transitionRecordSync === true);
  if (!enrolled || (mode.kind === "read" && entry.revoked)) return DENIED;
  return { allowed: true, authorityEpoch: entry.authorityEpoch, accountUserId: entry.accountUserId,
    leaseExpiresAtMs: entry.leaseExpiresAtMs, runtimeBootId: entry.runtimeBootId, deadlineMs: entry.deadlineMs };
}

function sameDecision(left: EngineAuthorityDecision, right: EngineAuthorityDecision): boolean {
  if (!left.allowed || !right.allowed) return left.allowed === right.allowed;
  return left.authorityEpoch === right.authorityEpoch && left.accountUserId === right.accountUserId;
}

export type EngineAuthorityCacheStats = {
  /** Shadow comparisons whose cached and SQL decisions agreed. */
  agree: number;
  /** Shadow comparisons with no usable entry (absent, expired or not loaded). */
  miss: number;
  /** Comparisons skipped because the invalidation feed was not current. */
  unavailable: number;
  /** Disagreements resolved by an invalidation that arrived before the
   * settle check. */
  converged: number;
  /** Disagreements where a fresh committed read matched the cache: the caller's
   * transaction saw its own uncommitted writes or an in-flight commit. */
  transient: number;
  /** A stale entry that no invalidation removed: the cache allowed what
   * committed SQL denies. The enforcement gate requires zero. */
  mismatchCacheAllows: number;
  /** The cache denied what committed SQL allows. */
  mismatchCacheDenies: number;
  /** Settle checks that could not complete (load failure or capacity). */
  verifySkipped: number;
  enforcedHits: number;
  loads: number;
  loadsDiscarded: number;
  loadFailures: number;
  invalidations: number;
  flushes: number;
  entries: number;
};

type Handlers = { onNotification: (payload: string) => void; onReady: () => void; onUnavailable: () => void };
type Subscribe = (handlers: Handlers) => PostgresNotificationSubscription;
type Load = (key: EngineAuthorityKey, maxTtlMs: number) => Promise<EngineAuthorityEntry | null>;

export type EngineAuthorityCacheOptions = {
  pool?: pg.Pool;
  listenerPool?: pg.Pool;
  flags?: RolloutFlagReader;
  load?: Load;
  subscribe?: Subscribe;
  now?: () => number;
  logger?: Pick<Console, "warn" | "info">;
  maxEntries?: number;
  maxTtlMs?: number;
  /** Wait for in-flight NOTIFY delivery before judging a disagreement. */
  settleMs?: number;
  maxConcurrentLoads?: number;
  maxPendingVerifications?: number;
  /** Periodic count-only summary; 0 disables it. */
  summaryMs?: number;
};

type Slot = { key: EngineAuthorityKey; entry: EngineAuthorityEntry };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INVALIDATION_MARKS = 50_000;

// Hints carry PostgreSQL's lowercase uuid text; callers may pass any case.
function normalize(key: EngineAuthorityKey): EngineAuthorityKey {
  return {
    workspaceId: key.workspaceId.toLowerCase(), organizationId: key.organizationId.toLowerCase(),
    generation: key.generation, engineInstanceId: key.engineInstanceId.toLowerCase(), workosEnabled: key.workosEnabled === true,
  };
}

function keyString(key: EngineAuthorityKey): string {
  return `${key.workspaceId}|${key.organizationId}|${key.generation}|${key.engineInstanceId}|${key.workosEnabled ? 1 : 0}`;
}

/** In-process engine authority cache keyed by workspace, organization,
 * generation and engine instance, carrying the authority epoch it loaded.
 *
 * Correctness rests on three rules:
 * - entries are trusted only while the LISTEN session that was established
 *   before they were loaded is still connected; losing it flushes everything;
 * - a load is discarded when any invalidation for its workspace, organization
 *   or any user arrives while it runs, so a read that began before a commit
 *   can never be stored after that commit's hint;
 * - an entry expires at the earliest deadline its SQL predicate depends on.
 *
 * The cache only ever answers "allowed"; a miss or a denial falls back to SQL. */
export class EngineAuthorityCache {
  private readonly slots = new Map<string, Slot>();
  private readonly byWorkspace = new Map<string, Set<string>>();
  private readonly byOrganization = new Map<string, Set<string>>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly marks = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly verifications = new Set<NodeJS.Timeout>();
  private sequence = 0;
  private flushedAt = 0;
  private listening = false;
  private listenEpoch = 0;
  private stopped = false;
  private subscription: PostgresNotificationSubscription | undefined;
  private summaryTimer: NodeJS.Timeout | undefined;
  private readonly counters: Omit<EngineAuthorityCacheStats, "entries"> = {
    agree: 0, miss: 0, unavailable: 0, converged: 0, transient: 0, mismatchCacheAllows: 0, mismatchCacheDenies: 0,
    verifySkipped: 0, enforcedHits: 0, loads: 0, loadsDiscarded: 0, loadFailures: 0, invalidations: 0, flushes: 0,
  };
  private readonly flags: RolloutFlagReader;
  private readonly load: Load;
  private readonly subscribe: Subscribe;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn" | "info">;
  private readonly maxEntries: number;
  private readonly maxTtlMs: number;
  private readonly settleMs: number;
  private readonly maxConcurrentLoads: number;
  private readonly maxPendingVerifications: number;
  private readonly summaryMs: number;

  constructor(options: EngineAuthorityCacheOptions) {
    this.flags = options.flags ?? ROLLOUT_FLAGS_OFF;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxTtlMs = options.maxTtlMs ?? 30_000;
    this.settleMs = options.settleMs ?? 2_000;
    this.maxConcurrentLoads = options.maxConcurrentLoads ?? 4;
    this.maxPendingVerifications = options.maxPendingVerifications ?? 64;
    this.summaryMs = options.summaryMs ?? 300_000;
    const pool = options.pool;
    this.load = options.load ?? ((key, maxTtlMs) => {
      if (!pool) return Promise.reject(new Error("authority_cache_pool_missing"));
      return loadEngineAuthorityEntry(pool, key, maxTtlMs);
    });
    const listenerPool = options.listenerPool;
    this.subscribe = options.subscribe ?? (handlers => {
      if (!listenerPool) throw new Error("authority_cache_listener_pool_missing");
      return postgresNotificationSubscription(listenerPool, {
        channels: [AUTHORITY_CACHE_CHANNEL],
        onNotification: notification => handlers.onNotification(notification.payload ?? ""),
        onReady: handlers.onReady,
        onUnavailable: handlers.onUnavailable,
      });
    });
  }

  start(): void {
    if (this.subscription || this.stopped) return;
    this.subscription = this.subscribe({
      onNotification: payload => this.invalidate(payload),
      onReady: () => { this.flush(); this.listening = true; this.listenEpoch += 1; },
      onUnavailable: () => { this.listening = false; this.listenEpoch += 1; this.flush(); },
    });
    void this.subscription.start().catch(() => {});
    if (this.summaryMs > 0) {
      this.summaryTimer = setInterval(() => this.summarize(), this.summaryMs);
      this.summaryTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.listening = false;
    clearInterval(this.summaryTimer);
    for (const timer of this.verifications) clearTimeout(timer);
    this.verifications.clear();
    this.flush();
    await this.subscription?.stop();
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** True while the invalidation feed is connected. */
  feedCurrent(): boolean { return this.listening && !this.stopped; }

  shadowing(organizationId: string): boolean {
    return this.flags.enabled(organizationId, "authority_cache_shadow") || this.flags.enabled(organizationId, "authority_cache_enforce");
  }

  /** The enforce flag reads `off` while the flag feed is lost; the cache
   * additionally requires its own invalidation feed. */
  enforcing(organizationId: string): boolean {
    return this.feedCurrent() && this.flags.enabled(organizationId, "authority_cache_enforce");
  }

  /** Memory only. `undefined` means no usable entry: the caller asks SQL. */
  lookup(key: EngineAuthorityKey, tokenHash: Buffer, mode: EngineAuthorityMode): EngineAuthorityDecision | undefined {
    if (!this.feedCurrent()) return undefined;
    const slot = this.usable(keyString(normalize(key)));
    if (!slot) return undefined;
    return decideEngineAuthority(slot.entry, tokenHash, mode, this.now());
  }

  /** Memory only: the generation and engine instance of the one usable,
   * unrevoked, enrolled entry for a workspace (S1 step 8 on `api` and
   * `realtime`). `undefined` when there is none or more than one, so the
   * caller asks SQL. A generation change invalidates the workspace, so a
   * usable entry is for the current generation. */
  placement(workspaceId: string, organizationId: string): { generation: number; engineInstanceId: string } | undefined {
    if (!this.feedCurrent()) return undefined;
    const now = this.now();
    let found: { generation: number; engineInstanceId: string } | undefined;
    for (const id of [...(this.byWorkspace.get(workspaceId.toLowerCase()) ?? [])]) {
      const slot = this.usable(id);
      if (!slot || slot.key.organizationId !== organizationId.toLowerCase() || slot.entry.revoked ||
          !(slot.entry.setupEnrolled || slot.entry.runtimeReady) || now >= slot.entry.deadlineMs) continue;
      if (found && (found.generation !== slot.key.generation || found.engineInstanceId !== slot.key.engineInstanceId)) return undefined;
      found = { generation: slot.key.generation, engineInstanceId: slot.key.engineInstanceId };
    }
    return found;
  }

  /** Records an enforced answer so shadow statistics stay comparable. */
  recordEnforcedHit(): void { this.counters.enforcedHits += 1; }

  /** Shadow comparison after SQL has decided. Never throws and never changes
   * the caller's outcome. Logs counts only, never keys, tokens or values. */
  observe(key: EngineAuthorityKey, tokenHash: Buffer, mode: EngineAuthorityMode, sql: EngineAuthorityDecision): void {
    try {
      if (!this.shadowing(key.organizationId)) return;
      if (!this.feedCurrent()) { this.counters.unavailable += 1; return; }
      key = normalize(key);
      const id = keyString(key);
      const slot = this.usable(id);
      if (!slot) {
        this.counters.miss += 1;
        if (sql.allowed) this.ensure(key);
        return;
      }
      const cached = decideEngineAuthority(slot.entry, tokenHash, mode, this.now());
      if (sameDecision(cached, sql)) { this.counters.agree += 1; return; }
      this.scheduleVerification(id, slot, tokenHash, mode, cached);
    } catch {
      this.logger.warn("[authority-cache] shadow comparison failed");
    }
  }

  /** Start a background load for a key if none is running. */
  ensure(key: EngineAuthorityKey): void {
    key = normalize(key);
    const id = keyString(key);
    if (this.stopped || !this.feedCurrent() || this.inflight.has(id)) return;
    if (this.inflight.size >= this.maxConcurrentLoads) return;
    const started = this.sequence, epoch = this.listenEpoch;
    this.counters.loads += 1;
    const run = this.load(key, this.maxTtlMs).then(entry => {
      if (!entry || this.stopped || epoch !== this.listenEpoch || !this.listening || this.invalidatedSince(key, entry, started)) {
        if (entry) this.counters.loadsDiscarded += 1;
        return;
      }
      if (entry.deadlineMs <= this.now()) return;
      this.store(id, { key, entry });
    }, () => { this.counters.loadFailures += 1; }).finally(() => {
      this.inflight.delete(id);
      if (!this.inflight.size) this.marks.clear();
    });
    this.inflight.set(id, run);
  }

  stats(): EngineAuthorityCacheStats { return { ...this.counters, entries: this.slots.size }; }

  private usable(id: string): Slot | undefined {
    const slot = this.slots.get(id);
    if (!slot) return undefined;
    const now = this.now();
    if (now >= slot.entry.deadlineMs || now >= slot.entry.leaseExpiresAtMs) { this.remove(id); return undefined; }
    return slot;
  }

  private scheduleVerification(id: string, slot: Slot, tokenHash: Buffer, mode: EngineAuthorityMode, cached: EngineAuthorityDecision): void {
    if (this.verifications.size >= this.maxPendingVerifications) { this.counters.verifySkipped += 1; return; }
    const timer = setTimeout(() => {
      this.verifications.delete(timer);
      if (this.stopped) return;
      if (this.slots.get(id) !== slot) { this.counters.converged += 1; return; }
      this.load(slot.key, this.maxTtlMs).then(fresh => {
        if (this.stopped) return;
        if (this.slots.get(id) !== slot) { this.counters.converged += 1; return; }
        const current = decideEngineAuthority(fresh ?? undefined, tokenHash, mode, this.now());
        if (sameDecision(current, cached)) { this.counters.transient += 1; return; }
        if (cached.allowed) this.counters.mismatchCacheAllows += 1;
        else this.counters.mismatchCacheDenies += 1;
        this.remove(id);
        this.logger.warn(`[authority-cache] shadow mismatch: cacheAllows=${this.counters.mismatchCacheAllows} cacheDenies=${this.counters.mismatchCacheDenies}`);
      }, () => { this.counters.verifySkipped += 1; });
    }, this.settleMs);
    timer.unref();
    this.verifications.add(timer);
  }

  private invalidatedSince(key: EngineAuthorityKey, entry: EngineAuthorityEntry, started: number): boolean {
    if (this.flushedAt > started) return true;
    return [`w:${key.workspaceId}`, `o:${key.organizationId}`, `u:${entry.accountUserId}`]
      .some(scope => (this.marks.get(scope) ?? 0) > started);
  }

  private invalidate(payload: string): void {
    this.counters.invalidations += 1;
    this.sequence += 1;
    const match = /^([wou]):(.+)$/.exec(payload);
    if (!match || !UUID.test(match[2]!)) { this.flush(); return; }
    const scope = match[1]!, id = match[2]!;
    if (this.inflight.size) {
      if (this.marks.size >= MAX_INVALIDATION_MARKS) { this.flush(); return; }
      this.marks.set(payload, this.sequence);
    }
    const index = scope === "w" ? this.byWorkspace : scope === "o" ? this.byOrganization : this.byUser;
    for (const entry of [...(index.get(id) ?? [])]) this.remove(entry);
  }

  private flush(): void {
    this.counters.flushes += 1;
    this.sequence += 1;
    this.flushedAt = this.sequence;
    this.marks.clear();
    this.slots.clear();
    this.byWorkspace.clear();
    this.byOrganization.clear();
    this.byUser.clear();
  }

  private store(id: string, slot: Slot): void {
    this.remove(id);
    while (this.slots.size >= this.maxEntries) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.slots.set(id, slot);
    index(this.byWorkspace, slot.key.workspaceId, id);
    index(this.byOrganization, slot.key.organizationId, id);
    index(this.byUser, slot.entry.accountUserId, id);
  }

  private remove(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    unindex(this.byWorkspace, slot.key.workspaceId, id);
    unindex(this.byOrganization, slot.key.organizationId, id);
    unindex(this.byUser, slot.entry.accountUserId, id);
  }

  private summarize(): void {
    const s = this.stats();
    if (!s.agree && !s.miss && !s.mismatchCacheAllows && !s.mismatchCacheDenies) return;
    this.logger.info(`[authority-cache] agree=${s.agree} miss=${s.miss} converged=${s.converged} transient=${s.transient} ` +
      `mismatchCacheAllows=${s.mismatchCacheAllows} mismatchCacheDenies=${s.mismatchCacheDenies} enforcedHits=${s.enforcedHits} entries=${s.entries}`);
  }
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(id);
}

function unindex(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (!set.size) map.delete(key);
}

/** Read the committed authority for one key in its own system transaction.
 * It calls cloud_workspace_engine_authority_snapshot, the predicate of
 * assertCurrentCloudEngineAuthority without its row locks (0152 pins the
 * derivation), so the cache cannot drift from the predicate and a load never
 * blocks a heartbeat. The deadline
 * covers every clock-bounded positive condition: the engine lease, compute
 * allocation and credit coverage, a delegated provider credential's
 * 300-second margin, and account and organization entitlement expiry. */
export async function loadEngineAuthorityEntry(pool: pg.Pool, key: EngineAuthorityKey, maxTtlMs: number): Promise<EngineAuthorityEntry | null> {
  const row = await withSystemTx(pool, async tx => (await tx.query<{
    authority_epoch: string; account_user_id: string; heartbeat_token_hash: Buffer | null; live: boolean; fenced: boolean;
    revoked: boolean; setup_enrolled: boolean; runtime_ready: boolean; lease_expires_at: Date; deadline: Date;
    runtime_boot_id: string | null;
  }>(`WITH authority AS MATERIALIZED (
      SELECT * FROM cloud_workspace_engine_authority_snapshot($1,$2,$3,$4,$5))
    SELECT authority.authority_epoch, authority.account_user_id, authority.heartbeat_token_hash, authority.live, authority.fenced,
      engine.revoked_at IS NOT NULL AS revoked, engine.setup_run_id IS NOT NULL AS setup_enrolled,
      EXISTS(SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
        JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
        WHERE enrollment.id=engine.runtime_transition_enrollment_id AND enrollment.consumed_at IS NOT NULL
          AND enrollment.revoked_at IS NULL AND enrollment.sequence=runtime.enrollment_sequence
          AND runtime.phase IN ('healthy','rolled_back')) AS runtime_ready,
      engine.lease_expires_at, engine.runtime_boot_id,
      least(engine.lease_expires_at, clock_timestamp()+make_interval(secs=>$6::double precision/1000),
        (SELECT min(least(lease.funded_until,lease.provider_expires_at)) FROM managed_compute_allocation_leases lease
          WHERE lease.workspace_id=$1 AND lease.org_id=$2 AND lease.state IN ('active','draining')
            AND lease.funded_until>clock_timestamp() AND lease.provider_expires_at>clock_timestamp()),
        (SELECT min(reservation.covered_until) FROM managed_compute_credit_reservations reservation
          WHERE reservation.workspace_id=$1 AND reservation.org_id=$2 AND reservation.state='open'
            AND reservation.covered_until>clock_timestamp()),
        (SELECT version.credential_expires_at-interval '300 seconds' FROM cloud_workspace_generations generation
          JOIN provider_connection_versions version ON version.connection_id=generation.provider_connection_id
            AND version.org_id=generation.org_id AND version.version=generation.provider_connection_version
          WHERE generation.workspace_id=$1 AND generation.generation=$3 AND version.credential_source<>'hosted'),
        (SELECT min(entitlement.valid_until) FROM account_entitlements entitlement
          WHERE entitlement.user_id=authority.account_user_id AND entitlement.valid_until>clock_timestamp()),
        (SELECT entitlement.valid_until FROM organization_entitlements entitlement
          WHERE entitlement.org_id=$2 AND entitlement.valid_until>clock_timestamp())) AS deadline
    FROM authority
    JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3`,
  [key.workspaceId, key.organizationId, key.generation, key.engineInstanceId, key.workosEnabled, maxTtlMs])).rows[0]);
  if (!row || row.live !== true || row.fenced !== false || !row.heartbeat_token_hash) return null;
  const authorityEpoch = Number(row.authority_epoch);
  const leaseExpiresAtMs = row.lease_expires_at.getTime(), deadlineMs = row.deadline.getTime();
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1 || !Number.isFinite(leaseExpiresAtMs) || !Number.isFinite(deadlineMs)) return null;
  return {
    authorityEpoch, accountUserId: row.account_user_id, heartbeatTokenHash: Buffer.from(row.heartbeat_token_hash),
    revoked: row.revoked, setupEnrolled: row.setup_enrolled, runtimeReady: row.runtime_ready, leaseExpiresAtMs, deadlineMs,
    runtimeBootId: row.runtime_boot_id,
  };
}

let installed: EngineAuthorityCache | undefined;

/** The api process installs one cache at boot; tests install their own. */
export function installEngineAuthorityCache(cache: EngineAuthorityCache | undefined): void { installed = cache; }

export function installedEngineAuthorityCache(): EngineAuthorityCache | undefined { return installed; }
