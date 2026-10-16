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

type RolloutFlagDefinition = { whileFeedUnavailable: RolloutFlagFeedLossBehavior; summary: string };

/** Known flag names. Rows for unknown names are ignored, so another branch
 * may enable a flag before this code knows it. Every flag defaults to off. */
export const ROLLOUT_FLAGS = {
  authority_cache_shadow: { whileFeedUnavailable: "retain", summary: "Evaluate the engine authority cache beside SQL and count mismatches" },
  authority_cache_enforce: { whileFeedUnavailable: "off", summary: "Serve engine authority from the cache" },
  capabilities: { whileFeedUnavailable: "retain", summary: "Issue and advertise S1 capabilities" },
  realtime_uplink: { whileFeedUnavailable: "retain", summary: "Accept S2 VM uplinks" },
  device_stream: { whileFeedUnavailable: "retain", summary: "Serve the S3 device stream" },
  credential_push: { whileFeedUnavailable: "retain", summary: "Push credential-control revisions over the uplink" },
  relay_over_uplink: { whileFeedUnavailable: "retain", summary: "Relay client sessions over the uplink" },
  presence_in_memory: { whileFeedUnavailable: "retain", summary: "Keep presence and engine liveness in memory" },
} as const satisfies Record<string, RolloutFlagDefinition>;

export type RolloutFlagName = keyof typeof ROLLOUT_FLAGS;

export function isRolloutFlagName(value: unknown): value is RolloutFlagName {
  return typeof value === "string" && Object.hasOwn(ROLLOUT_FLAGS, value);
}

export interface RolloutFlagReader {
  /** Memory only; never touches the database. */
  enabled(orgId: string, flag: RolloutFlagName): boolean;
}

export const ROLLOUT_FLAGS_OFF: RolloutFlagReader = Object.freeze({ enabled: () => false });

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
  load?: (limit: number) => Promise<readonly Row[]>;
  subscribe?: Subscribe;
};

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_MAX_ROWS = 10_000;

/** In-process snapshot of enabled flags. Reloads the whole (small) table on
 * every NOTIFY hint, on every LISTEN (re)connect and on a slow timer. A
 * reload that overlaps a hint is followed by another reload, so a read that
 * began before a commit can never be the last one applied. */
export class RolloutFlagSnapshot implements RolloutFlagReader {
  private values = new Map<string, ReadonlySet<RolloutFlagName>>();
  private listening = false;
  private listenEpoch = 0;
  private current = false;
  private reloading: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private subscription: PostgresNotificationSubscription | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly refreshMs: number;
  private readonly maxRows: number;
  private readonly logger: Pick<Console, "warn" | "info">;
  private readonly load: (limit: number) => Promise<readonly Row[]>;
  private readonly subscribe: Subscribe;

  constructor(options: RolloutFlagSnapshotOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.logger = options.logger ?? console;
    const pool = options.pool;
    this.load = options.load ?? (async limit => {
      if (!pool) throw new Error("rollout_flag_pool_missing");
      return (await withSystemStatement<Row>(pool, sql`SELECT org_id::text AS org_id, flag
        FROM cloud_rollout_flags WHERE enabled ORDER BY org_id, flag LIMIT ${SqlFragment.integer(limit, 1, 1_000_000)}`)).rows;
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
    this.listening = false;
    this.setCurrent(false);
    await this.subscription?.stop();
    await this.reloading;
  }

  enabled(orgId: string, flag: RolloutFlagName): boolean {
    const definition: RolloutFlagDefinition | undefined = ROLLOUT_FLAGS[flag];
    if (!definition) return false;
    if (!this.current && definition.whileFeedUnavailable === "off") return false;
    return this.values.get(orgId)?.has(flag) ?? false;
  }

  /** True when the snapshot was loaded after the current LISTEN session
   * started, so every later change will arrive as a hint. */
  feedCurrent(): boolean { return this.current; }

  /** True when any organization has the flag on. Process-level mount gates
   * use this; per-organization admission still checks `enabled(orgId, …)`. */
  anyEnabled(flag: RolloutFlagName): boolean {
    const definition: RolloutFlagDefinition | undefined = ROLLOUT_FLAGS[flag];
    if (!definition) return false;
    if (!this.current && definition.whileFeedUnavailable === "off") return false;
    for (const flags of this.values.values()) if (flags.has(flag)) return true;
    return false;
  }

  /** Called after any change to what `enabled` may return. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  reload(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reloading) { this.again = true; return this.reloading; }
    this.reloading = this.run().finally(() => { this.reloading = undefined; });
    return this.reloading;
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
      const epoch = this.listenEpoch, listening = this.listening;
      let rows: readonly Row[];
      try {
        rows = await this.load(this.maxRows + 1);
      } catch {
        this.logger.warn("[rollout-flags] reload failed; feed-loss values apply until the next reload");
        this.setCurrent(false);
        continue;
      }
      if (this.stopped) return;
      if (rows.length > this.maxRows) this.logger.warn("[rollout-flags] enabled flag rows exceed the bound; extra rows are ignored");
      const next = new Map<string, Set<RolloutFlagName>>();
      for (const row of rows.slice(0, this.maxRows)) {
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
