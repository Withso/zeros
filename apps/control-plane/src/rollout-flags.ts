import type pg from "pg";
import { withSystemStatement } from "./db.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "./postgres-notifications.js";
import { SqlFragment, sql } from "./sql-fragment.js";

export const ROLLOUT_FLAG_CHANNEL = "zeros_cloud_rollout_flags";

/** What a flag reads as while this process cannot prove its snapshot is
 * current (no LISTEN session, or the last reload failed):
 * - `retain`: the last loaded value, still corrected by the safety refresh.
 *   For flags whose old and new paths are both safe, where flapping between
 *   them on a database blip would cost more than a late flip.
 * - `off`: forced off. For flags that relax a database check, so a missed
 *   "disable" can never keep the relaxed path running. */
export type RolloutFlagFeedLossBehavior = "retain" | "off";

type RolloutFlagDefinition = {
  whileFeedUnavailable: RolloutFlagFeedLossBehavior;
  summary: string;
  /** Flags that must also be on for the same organization; without every
   * one of them (transitively) this flag reads off, so a consumer that
   * checks only this flag cannot run without its dependencies. */
  requires?: readonly string[];
};

/** Known flag names. Rows for unknown names are ignored, so another branch
 * may enable a flag before this code knows it. Every flag defaults to off. */
export const ROLLOUT_FLAGS = {
  authority_cache_shadow: { whileFeedUnavailable: "retain", summary: "Evaluate the engine authority cache beside SQL and count mismatches" },
  authority_cache_enforce: { whileFeedUnavailable: "off", summary: "Serve engine authority from the cache" },
  capabilities: { whileFeedUnavailable: "retain", summary: "Issue and advertise S1 capabilities" },
  // An uplink cannot complete the S2 handshake without capability keys and
  // epochs: advertising or accepting it without `capabilities` would loop
  // engines at auth.sync, so the dependency reads the flag off instead.
  realtime_uplink: { whileFeedUnavailable: "retain", summary: "Accept S2 VM uplinks", requires: ["capabilities"] },
  device_stream: { whileFeedUnavailable: "retain", summary: "Serve the S3 device stream" },
  credential_push: { whileFeedUnavailable: "retain", summary: "Push credential-control revisions over the uplink" },
  relay_over_uplink: { whileFeedUnavailable: "retain", summary: "Relay client sessions over the uplink" },
  presence_in_memory: { whileFeedUnavailable: "retain", summary: "Keep presence and engine liveness in memory" },
  runtime_connect: { whileFeedUnavailable: "retain", summary: "Serve S3 runtime connect and capability renewal", requires: ["capabilities"] },
  capability_actor_sessions: { whileFeedUnavailable: "off", summary: "Use signed capability expiry for actor sessions",
    requires: ["capabilities", "runtime_connect", "realtime_uplink"] },
  // Enable only once every control-plane service runs the heartbeat that
  // never shortens a lease: an older one would cut a 36-minute uplink lease
  // back to 90 s while the engine skips its periodic heartbeat.
  engine_lease_over_uplink: { whileFeedUnavailable: "retain", summary: "Renew the engine lease over the uplink (lease.v1)", requires: ["realtime_uplink"] },
  checkpoint_push: { whileFeedUnavailable: "retain", summary: "Push checkpoint requests over the uplink (checkpoint.v1)", requires: ["realtime_uplink"] },
  // The engine still proves idleness before any checkpoint, and unknown
  // activity or a lost uplink never stops a workspace (decision G).
  cp_idle_stop: { whileFeedUnavailable: "retain", summary: "Decide idle stops in the control plane from uplink activity (idle.v1)", requires: ["realtime_uplink"] },
  // Off, turns.v1 is never negotiated: the engine keeps its journal and
  // sends it once an uplink negotiates it. No other path reads it.
  turn_journal: { whileFeedUnavailable: "retain", summary: "Deliver the engine turn journal over the uplink (turns.v1)", requires: ["realtime_uplink"] },
  detached_turns: { whileFeedUnavailable: "off", summary: "Enroll exact owner-funded accepted work",
    requires: ["capabilities", "realtime_uplink", "credential_push", "turn_journal"] },
} as const satisfies Record<string, RolloutFlagDefinition>;

export type RolloutFlagName = keyof typeof ROLLOUT_FLAGS;

/** The flag is on in `set` and every transitive `requires` is too. While
 * the feed is not current, a flag (or any dependency) whose feed-loss
 * behavior is "off" reads off, so a dependent flag never outlives the
 * dependency it requires. */
export function flagEffective(set: ReadonlySet<string> | undefined, flag: string, feedCurrent = true,
  definitions: Readonly<Record<string, RolloutFlagDefinition>> = ROLLOUT_FLAGS, seen: ReadonlySet<string> = new Set()): boolean {
  if (!set?.has(flag)) return false;
  const definition: RolloutFlagDefinition | undefined = definitions[flag];
  if (!definition || (!feedCurrent && definition.whileFeedUnavailable === "off")) return false;
  for (const dependency of definition.requires ?? []) {
    if (seen.has(dependency)) continue;
    if (!flagEffective(set, dependency, feedCurrent, definitions, new Set(seen).add(flag))) return false;
  }
  return true;
}

export function isRolloutFlagName(value: unknown): value is RolloutFlagName {
  return typeof value === "string" && Object.hasOwn(ROLLOUT_FLAGS, value);
}

export interface RolloutFlagReader {
  /** Memory only; never touches the database. */
  enabled(orgId: string, flag: RolloutFlagName): boolean;
  /** Memory only; true when any organization has the flag on. */
  anyEnabled(flag: RolloutFlagName): boolean;
}

export const ROLLOUT_FLAGS_OFF: RolloutFlagReader = Object.freeze({ enabled: () => false, anyEnabled: () => false });

type Row = { org_id: string; flag: string };
type Subscribe = (handlers: {
  onNotification: () => void;
  onReady: () => void;
  onUnavailable: () => void;
}) => PostgresNotificationSubscription;

export type RolloutFlagSnapshotOptions = {
  /** Query pool for reloads. */
  pool?: pg.Pool;
  /** Dedicated LISTEN pool shared with the other notification consumers. */
  listenerPool?: pg.Pool;
  /** Slow safety refresh; corrects a lost notification. */
  refreshMs?: number;
  maxRows?: number;
  logger?: Pick<Console, "warn" | "info">;
  /** Backoff schedule for retrying a failed reload; each entry is capped
   * below `refreshMs`. Defaults to 1, 2, 4, 8, 15 and 30 s. */
  retryDelaysMs?: readonly number[];
  /** A reload that a hint is waiting on marks the snapshot not current after
   * this long, so a hung read cannot keep a relaxing flag on. Default 2 s. */
  hintedReloadStaleMs?: number;
  load?: (limit: number) => Promise<readonly Row[]>;
  subscribe?: Subscribe;
};

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const DEFAULT_HINTED_RELOAD_STALE_MS = 2_000;

/** In-process snapshot of enabled flags. Reloads the whole (small) table on
 * every NOTIFY hint, on every LISTEN (re)connect and on a slow timer. A
 * reload that overlaps a hint is followed by another reload, so a read that
 * began before a commit can never be the last one applied. */
export class RolloutFlagSnapshot implements RolloutFlagReader {
  private values = new Map<string, ReadonlySet<RolloutFlagName>>();
  private listening = false;
  private listenEpoch = 0;
  private current = false;
  private failedLoads = 0;
  private reloading: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryAttempt = 0;
  private staleTimer: NodeJS.Timeout | undefined;
  private subscription: PostgresNotificationSubscription | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly refreshMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly hintedReloadStaleMs: number;
  private readonly maxRows: number;
  private readonly logger: Pick<Console, "warn" | "info">;
  private readonly load: (limit: number) => Promise<readonly Row[]>;
  private readonly subscribe: Subscribe;

  constructor(options: RolloutFlagSnapshotOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.logger = options.logger ?? console;
    this.retryDelaysMs = (options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS)
      .map(delay => Math.max(1, Math.min(delay, Math.floor(this.refreshMs / 2))));
    this.hintedReloadStaleMs = options.hintedReloadStaleMs ?? DEFAULT_HINTED_RELOAD_STALE_MS;
    const pool = options.pool;
    this.load = options.load ?? (async limit => {
      if (!pool) throw new Error("rollout_flag_pool_missing");
      // Unknown names are filtered in SQL so rows written by a newer branch
      // cannot consume this process's row bound.
      const known = SqlFragment.list(Object.keys(ROLLOUT_FLAGS).map(name => SqlFragment.text(name, /^[a-z][a-z0-9_]{0,62}$/)));
      return (await withSystemStatement<Row>(pool, sql`SELECT org_id::text AS org_id, flag
        FROM cloud_rollout_flags WHERE enabled AND flag IN (${known})
        ORDER BY org_id, flag LIMIT ${SqlFragment.integer(limit, 1, 1_000_000)}`)).rows;
    });
    const listenerPool = options.listenerPool;
    this.subscribe = options.subscribe ?? (handlers => {
      if (!listenerPool) throw new Error("rollout_flag_listener_pool_missing");
      return postgresNotificationSubscription(listenerPool, {
        channels: [ROLLOUT_FLAG_CHANNEL],
        onNotification: () => handlers.onNotification(),
        onReady: handlers.onReady,
        onUnavailable: handlers.onUnavailable,
      });
    });
  }

  /** Resolves after the first reload attempt; never rejects. Flags read
   * their feed-loss value until LISTEN and a later reload both succeed. */
  start(): Promise<void> {
    if (this.subscription || this.stopped) return this.reloading ?? Promise.resolve();
    this.subscription = this.subscribe({
      onNotification: () => { void this.reload(); },
      onReady: () => { this.listening = true; this.listenEpoch += 1; void this.reload(); },
      onUnavailable: () => { this.listening = false; this.listenEpoch += 1; this.setCurrent(false); },
    });
    void this.subscription.start().catch(() => {});
    this.timer = setInterval(() => { void this.reload(); }, this.refreshMs);
    this.timer.unref();
    return this.reload();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.retryTimer);
    clearTimeout(this.staleTimer);
    this.retryTimer = this.staleTimer = undefined;
    this.listening = false;
    this.setCurrent(false);
    // A stopped snapshot reads exactly like ROLLOUT_FLAGS_OFF, retain or not.
    this.values = new Map();
    await this.subscription?.stop();
    await this.reloading;
  }

  enabled(orgId: string, flag: RolloutFlagName): boolean {
    const definition: RolloutFlagDefinition | undefined = ROLLOUT_FLAGS[flag];
    if (!definition) return false;
    if (!this.current && definition.whileFeedUnavailable === "off") return false;
    // Rows are keyed by the canonical lowercase uuid text; callers may carry
    // the id from a route parameter or claim in another casing.
    return flagEffective(this.values.get(orgId.toLowerCase()), flag, this.current);
  }

  /** True when the snapshot was loaded after the current LISTEN session
   * started, so every later change will arrive as a hint. */
  feedCurrent(): boolean { return this.current; }

  /** Positive fresh proof for the shared detached-work observation. A
   * reload's completion by itself can represent a caught read failure. */
  async observeAuthority(): Promise<boolean> {
    const failures = this.failedLoads;
    await this.reload();
    return !this.stopped && this.current && failures === this.failedLoads;
  }

  /** True when any organization has the flag on. Process-level mount gates
   * use this; per-organization admission still checks `enabled(orgId, …)`. */
  anyEnabled(flag: RolloutFlagName): boolean {
    const definition: RolloutFlagDefinition | undefined = ROLLOUT_FLAGS[flag];
    if (!definition) return false;
    if (!this.current && definition.whileFeedUnavailable === "off") return false;
    for (const flags of this.values.values()) if (flagEffective(flags, flag, this.current)) return true;
    return false;
  }

  /** Called after any change to what `enabled` may return. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  reload(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reloading) {
      this.again = true;
      // A change hint is waiting on a read that has not finished. If the read
      // outlives the staleness deadline, drop the current mark so a relaxing
      // flag (authority_cache_enforce) cannot stay on for the whole query
      // deadline; the rerun after the read repairs it.
      this.staleTimer ??= setTimeout(() => {
        this.staleTimer = undefined;
        if (this.reloading) this.setCurrent(false);
      }, this.hintedReloadStaleMs);
      this.staleTimer.unref?.();
      return this.reloading;
    }
    this.reloading = this.run().finally(() => {
      this.reloading = undefined;
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    });
    return this.reloading;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelaysMs[Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)]!;
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reload();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
      const epoch = this.listenEpoch, listening = this.listening;
      let rows: readonly Row[];
      try {
        rows = await this.load(this.maxRows + 1);
      } catch {
        this.failedLoads += 1;
        this.logger.warn("[rollout-flags] reload failed; retrying with backoff before the safety refresh");
        this.setCurrent(false);
        this.scheduleRetry();
        continue;
      }
      if (this.stopped) return;
      this.retryAttempt = 0;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      // A hint arrived while this read ran: the read may predate that commit,
      // so discard it and let the loop read again instead of applying it.
      if (this.again) continue;
      const knownRows = rows.filter(row => isRolloutFlagName(row.flag));
      if (knownRows.length > this.maxRows) this.logger.warn("[rollout-flags] enabled flag rows exceed the bound; extra rows are ignored");
      const next = new Map<string, Set<RolloutFlagName>>();
      for (const row of knownRows.slice(0, this.maxRows)) {
        if (!isRolloutFlagName(row.flag)) continue;
        let flags = next.get(row.org_id);
        if (!flags) next.set(row.org_id, flags = new Set());
        flags.add(row.flag);
      }
      const changed = !sameValues(this.values, next);
      this.values = next;
      const wasCurrent = this.current;
      this.current = listening && this.listening && epoch === this.listenEpoch;
      if (changed || wasCurrent !== this.current) this.emit();
    } while (this.again && !this.stopped);
  }

  private setCurrent(value: boolean): void {
    if (this.current === value) return;
    this.current = value;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { this.logger.warn("[rollout-flags] change listener failed"); }
    }
  }
}

function sameValues(left: ReadonlyMap<string, ReadonlySet<string>>, right: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (left.size !== right.size) return false;
  for (const [org, flags] of left) {
    const other = right.get(org);
    if (!other || other.size !== flags.size) return false;
    for (const flag of flags) if (!other.has(flag)) return false;
  }
  return true;
}
