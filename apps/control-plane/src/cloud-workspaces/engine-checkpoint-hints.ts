import { createHash } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { postgresNotificationSubscription } from "../postgres-notifications.js";

/** A stop, restart or archive queues a durable checkpoint request that the
 * engine otherwise sees only on its next heartbeat. An engine may hold one
 * short wait here; it ends as soon as such a request is queued, and the engine
 * then heartbeats at once. The answer is only a timing hint: the directive is
 * still delivered, fenced and acknowledged through the heartbeat. */
export const CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL = "zeros_cloud_checkpoint_request";
export const CLOUD_ENGINE_CHECKPOINT_HINT_AUDIENCE = "zeros-cloud-workspace-engine-checkpoint-hint-v1" as const;
/** Held well inside the engine's request timeout and ordinary proxy limits. */
export const CLOUD_ENGINE_CHECKPOINT_HINT_WAIT_MS = 25_000;
// Without the notification fast path a waiter still rechecks this often.
const RECHECK_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEARTBEAT_TOKEN = /^zwh_[A-Za-z0-9_-]{43}$/;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,9}$/;

export const checkpointHintKey = (workspaceId: string, generation: number) => `${workspaceId.toLowerCase()}:${generation}`;

/** Hint requests admitted per egress address each minute: twice the steady
 * re-wait rate of 300 engines behind one address. */
export function engineCheckpointHintRequestsPerMinute(): number {
  return 2 * Math.ceil((300 * 60_000) / CLOUD_ENGINE_CHECKPOINT_HINT_WAIT_MS);
}

export class CloudEngineCheckpointHintRejected extends Error {
  readonly code = "engine_checkpoint_hint_rejected";
  constructor() { super("Cloud engine checkpoint hint was rejected"); }
}

export type CloudEngineCheckpointHintInput = {
  token: string; workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
};

export class CloudEngineCheckpointHints {
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;
  private readonly now: () => number;
  private readonly waitMs: number;
  constructor(private readonly pool: pg.Pool, options: { now?: () => number; waitMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.waitMs = options.waitMs ?? CLOUD_ENGINE_CHECKPOINT_HINT_WAIT_MS;
  }

  notify(key: string) {
    if (!KEY.test(key)) return;
    for (const wake of this.waiters.get(key) ?? []) wake();
  }
  /** Commits before a (re)connected listener became active may have been missed. */
  notifyAll() {
    for (const set of this.waiters.values()) for (const wake of set) wake();
  }
  /** Shutdown answers every held and later wait at once, so a draining server
   * never waits out the hint window before its forced exit. */
  close() {
    this.closed = true;
    this.notifyAll();
  }

  /** Resolves `pending: true` once an undelivered request is queued for this
   * exact live engine's generation, or `false` when the wait ends. */
  async wait(input: CloudEngineCheckpointHintInput, signal: AbortSignal) {
    if (!HEARTBEAT_TOKEN.test(input.token) || !UUID.test(input.workspaceId) || !UUID.test(input.organizationId) ||
        !UUID.test(input.engineInstanceId) || !Number.isSafeInteger(input.generation) || input.generation < 1)
      throw new CloudEngineCheckpointHintRejected();
    if (this.closed) return hint(false);
    const key = checkpointHintKey(input.workspaceId, input.generation);
    let woken = false;
    let wake: (() => void) | undefined;
    const subscriber = () => { woken = true; wake?.(); };
    const set = this.waiters.get(key) ?? new Set();
    set.add(subscriber);
    this.waiters.set(key, set);
    try {
      const deadline = this.now() + this.waitMs;
      for (;;) {
        // Cleared before the read: a notification during it re-reads at once.
        woken = false;
        if (await this.pending(input)) return hint(true);
        const remaining = deadline - this.now();
        if (remaining <= 0 || signal.aborted || this.closed) return hint(false);
        if (woken) continue;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); wake = undefined; resolve(); };
          const timer = setTimeout(done, Math.min(remaining, RECHECK_MS));
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
        if (this.closed) return hint(false);
      }
    } finally {
      set.delete(subscriber);
      if (!set.size) this.waiters.delete(key);
    }
  }

  /** Read-only: no lease renewal and no workspace lock. The token must belong
   * to the exact ready, unrevoked engine whose lease is still live. */
  private async pending(input: CloudEngineCheckpointHintInput): Promise<boolean> {
    const row = await withSystemTx(this.pool, async tx => (await tx.query<{ pending: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM workspace_checkpoint_requests request
          WHERE request.workspace_id=ei.workspace_id AND request.org_id=ei.org_id AND request.generation=ei.generation
            AND request.state='queued' AND request.deadline_at>now()) AS pending
       FROM cloud_workspace_engine_instances ei
       WHERE ei.id=$1 AND ei.workspace_id=$2 AND ei.generation=$3 AND ei.org_id=$4 AND ei.heartbeat_token_hash=$5
         AND ei.state='ready' AND ei.revoked_at IS NULL AND ei.lease_expires_at>clock_timestamp()`,
      [input.engineInstanceId, input.workspaceId, input.generation, input.organizationId,
        createHash("sha256").update(input.token, "utf8").digest()])).rows[0]);
    if (!row) throw new CloudEngineCheckpointHintRejected();
    return row.pending;
  }
}

const hint = (pending: boolean) => ({ version: 1 as const, audience: CLOUD_ENGINE_CHECKPOINT_HINT_AUDIENCE, pending });

/** Share the process's dedicated LISTEN session. Waiters retain their periodic
 * recheck while this fast path is down, and re-read after every reconnect. */
export function startCloudEngineCheckpointHintNotifications(
  pool: pg.Pool,
  hints: Pick<CloudEngineCheckpointHints, "notify" | "notifyAll">,
  logger: Pick<Console, "warn"> = console,
): () => Promise<void> {
  const listener = postgresNotificationSubscription(pool, {
    channels: [CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL],
    onNotification: notice => hints.notify(notice.payload ?? ""),
    onReady: () => hints.notifyAll(),
    onUnavailable: () => logger.warn("[cloud-workspace] checkpoint hint notifications unavailable; engines keep their heartbeat cadence"),
  });
  void listener.start().catch(() => {});
  return () => listener.stop();
}
