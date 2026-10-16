import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isDatabaseUnavailable } from "./db.js";
import {
  claimJobs,
  completeJob,
  DEFAULT_JOB_BACKOFF,
  DEFAULT_JOB_LEASE_MS,
  extendJobLease,
  failJob,
  isValidJobKind,
  isValidJobOwner,
  JOB_NOTIFICATION_CHANNEL,
  JobError,
  jobRetryDelayMs,
  releaseJobs,
  type ClaimedJob,
  type JobErrorCode,
  type JobQueueObserver,
} from "./job-queue.js";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "./postgres-notifications.js";

export type JobHandler = {
  kind: string;
  /** Must honor `signal`: it aborts on timeout, lease loss and shutdown. */
  handle(job: ClaimedJob, context: { signal: AbortSignal }): Promise<void>;
  leaseMs?: number;
  timeoutMs?: number;
  backoff?: { baseMs: number; maxMs: number };
};

export type JobRunnerOptions = {
  pool: pg.Pool;
  /** Dedicated LISTEN pool. Without it the runner relies on its poll alone. */
  listenerPool?: pg.Pool;
  handlers: readonly JobHandler[];
  concurrency?: number;
  /** Fallback poll for lost notifications and expired leases. */
  pollIntervalMs?: number;
  drainTimeoutMs?: number;
  ownerId?: string;
  logger?: Pick<Console, "warn">;
  observe?: JobQueueObserver;
  random?: () => number;
};

const DEFAULT_POLL_INTERVAL_MS = 45_000;
// Due rows held by another worker's in-flight claim become leases within
// milliseconds; retry once a second rather than spinning on them.
const CONTENDED_RETRY_MS = 1_000;
const CLAIM_ERROR_RETRY_MS = 5_000;

type ActiveJob = {
  job: ClaimedJob;
  controller: AbortController;
  released: boolean;
  done: Promise<void>;
};

type Outcome = { ok: true } | { ok: false; code: JobErrorCode; retryable: boolean; retryAfterMs: number | null };

function classify(error: unknown): Outcome {
  if (error instanceof JobError) return { ok: false, code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  if (isDatabaseUnavailable(error)) return { ok: false, code: "database_unavailable", retryable: true, retryAfterMs: null };
  return { ok: false, code: "handler_failed", retryable: true, retryAfterMs: null };
}

/** Claims and runs registered job kinds with bounded concurrency. Wake-ups
 * come from commit-bound NOTIFY hints, the runner's own completions and a
 * slow jittered fallback poll; there is no sub-second polling. */
export class JobRunner {
  private readonly pool: pg.Pool;
  private readonly handlers: ReadonlyMap<string, Required<Pick<JobHandler, "leaseMs" | "timeoutMs" | "backoff">> & JobHandler>;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly drainTimeoutMs: number;
  private readonly ownerId: string;
  private readonly logger: Pick<Console, "warn">;
  private readonly observe: JobQueueObserver | undefined;
  private readonly random: () => number;
  private readonly listenerPool: pg.Pool | undefined;
  private readonly active = new Map<string, ActiveJob>();
  private listener: PostgresNotificationSubscription | undefined;
  private started = false;
  private stopping = false;
  private stopped: Promise<void> | undefined;
  private wanted = false;
  private saturated = false;
  private pumping: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pollAt = Infinity;
  private workAt = Infinity;

  constructor(options: JobRunnerOptions) {
    this.pool = options.pool;
    this.listenerPool = options.listenerPool;
    this.concurrency = options.concurrency ?? 4;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
    this.ownerId = options.ownerId ?? `control-plane:${randomUUID()}`;
    this.logger = options.logger ?? console;
    this.observe = options.observe;
    this.random = options.random ?? Math.random;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32 ||
      !Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1_000 || this.pollIntervalMs > 300_000 ||
      !Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 0 || this.drainTimeoutMs > 120_000 ||
      !isValidJobOwner(this.ownerId)) {
      throw new Error("job_runner_options_invalid");
    }
    const handlers = new Map<string, Required<Pick<JobHandler, "leaseMs" | "timeoutMs" | "backoff">> & JobHandler>();
    for (const handler of options.handlers) {
      const leaseMs = handler.leaseMs ?? DEFAULT_JOB_LEASE_MS;
      const timeoutMs = handler.timeoutMs ?? 5 * 60_000;
      const backoff = handler.backoff ?? DEFAULT_JOB_BACKOFF;
      if (!isValidJobKind(handler.kind) || handlers.has(handler.kind) ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 3_600_000 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 ||
        !Number.isSafeInteger(backoff.baseMs) || backoff.baseMs < 1 ||
        !Number.isSafeInteger(backoff.maxMs) || backoff.maxMs < backoff.baseMs || backoff.maxMs > 24 * 60 * 60_000) {
        throw new Error("job_handler_invalid");
      }
      handlers.set(handler.kind, { ...handler, leaseMs, timeoutMs, backoff });
    }
    if (!handlers.size) throw new Error("job_handlers_required");
    this.handlers = handlers;
  }

  get inFlight(): number { return this.active.size; }

  start(): () => Promise<void> {
    if (this.started) return () => this.stop();
    this.started = true;
    this.pollAt = Date.now() + this.jitteredPollMs();
    if (this.listenerPool) {
      this.listener = postgresNotificationSubscription(this.listenerPool, {
        channels: [JOB_NOTIFICATION_CHANNEL],
        onNotification: notice => { if (notice.payload === "") this.notify(); },
        // Every (re)subscription re-reads the queue: hints sent while the
        // session was down are lost, durable rows are not.
        onReady: () => this.notify(),
        onUnavailable: () => this.logger.warn("[jobs] notifications unavailable; polling remains enabled"),
      });
      void this.listener.start().catch(() => {});
    }
    this.notify();
    return () => this.stop();
  }

  /** A hint that work may be due. Coalesces while a claim is in flight. */
  notify(): void {
    if (!this.started || this.stopping) return;
    this.wanted = true;
    if (this.pumping) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      // A hint can land after the loop's last check but before this settles.
      if (this.wanted) this.notify();
    });
  }

  stop(): Promise<void> {
    this.stopped ??= this.shutdown();
    return this.stopped;
  }

  private jitteredPollMs(): number {
    return Math.round(this.pollIntervalMs * (0.75 + 0.25 * Math.min(1, Math.max(0, this.random()))));
  }

  private async pump(): Promise<void> {
    while (this.wanted && !this.stopping) {
      this.wanted = false;
      const free = this.concurrency - this.active.size;
      if (free <= 0) { this.saturated = true; return; }
      let claimed: Awaited<ReturnType<typeof claimJobs>>;
      try {
        claimed = await claimJobs(this.pool, {
          owner: this.ownerId,
          kinds: [...this.handlers.values()].map(handler => ({ kind: handler.kind, leaseMs: handler.leaseMs })),
          limit: free,
        }, this.observe);
      } catch {
        this.logger.warn("[jobs] claim failed; will retry");
        this.arm(CLAIM_ERROR_RETRY_MS);
        return;
      }
      if (claimed.expired) this.logger.warn(`[jobs] ${claimed.expired} job(s) failed after their final lease expired`);
      for (const job of claimed.jobs) this.execute(job);
      if (claimed.jobs.length + claimed.expired >= free) {
        this.wanted = true;
      } else if (claimed.nextDueInMs !== null) {
        this.arm(claimed.nextDueInMs > 0 ? claimed.nextDueInMs : CONTENDED_RETRY_MS);
      } else {
        this.arm(null);
      }
    }
  }

  /** Arm the single timer for the earlier of a known due time and the poll. */
  private arm(delayMs: number | null): void {
    if (this.stopping) return;
    if (delayMs !== null) this.workAt = Math.min(this.workAt, Date.now() + Math.max(0, delayMs));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const now = Date.now();
      if (now >= this.pollAt) this.pollAt = now + this.jitteredPollMs();
      this.workAt = Infinity;
      this.notify();
    }, Math.max(0, Math.min(this.workAt, this.pollAt) - Date.now()));
    this.timer.unref();
  }

  private execute(job: ClaimedJob): void {
    const handler = this.handlers.get(job.kind)!;
    const controller = new AbortController();
    const entry: ActiveJob = { job, controller, released: false, done: Promise.resolve() };
    this.active.set(job.id, entry);
    entry.done = this.run(handler, entry).catch(() => {
      this.logger.warn(`[jobs] ${job.kind} settlement failed; the lease will expire`);
    }).finally(() => {
      this.active.delete(job.id);
      if (this.saturated) { this.saturated = false; this.notify(); }
    });
  }

  private async run(handler: JobHandler & { leaseMs: number; timeoutMs: number; backoff: { baseMs: number; maxMs: number } }, entry: ActiveJob): Promise<void> {
    const { job, controller } = entry;
    let lost = false, timedOut = false;
    const extension = setInterval(() => {
      void extendJobLease(this.pool, job, handler.leaseMs, this.observe).then(held => {
        if (!held && !controller.signal.aborted) { lost = true; controller.abort(); }
      }, () => {
        // A missed extension is tolerable until the lease actually expires;
        // completion then reports a lost lease and the job runs again.
      });
    }, Math.floor(handler.leaseMs / 2));
    extension.unref();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, handler.timeoutMs);
    timeout.unref();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("job_aborted")), { once: true });
    });
    aborted.catch(() => {});
    let outcome: Outcome;
    try {
      // A handler that ignores its signal must not hold a concurrency slot or
      // a lease past its deadline; its late result is discarded.
      await Promise.race([handler.handle(job, { signal: controller.signal }), aborted]);
      outcome = { ok: true };
    } catch (error) {
      outcome = classify(error);
    } finally {
      clearInterval(extension);
      clearTimeout(timeout);
    }
    if (lost || entry.released) return;
    if (timedOut) outcome = { ok: false, code: "handler_timeout", retryable: true, retryAfterMs: null };
    if (outcome.ok) {
      if (await completeJob(this.pool, job, this.observe) === "requeued") this.notify();
      return;
    }
    const delayMs = Math.max(jobRetryDelayMs(job.attempts, handler.backoff, this.random), outcome.retryAfterMs ?? 0);
    const result = await failJob(this.pool, job, { code: outcome.code, retryable: outcome.retryable, delayMs }, this.observe);
    if (result === "retrying") this.arm(delayMs);
    else if (result === "failed") this.logger.warn(`[jobs] ${job.kind} failed terminally: ${outcome.code}`);
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.listener?.stop();
    await this.pumping;
    const pending = [...this.active.values()];
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(pending.map(entry => entry.done)).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.drainTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (drained) return;
    const unfinished = [...this.active.values()];
    for (const entry of unfinished) { entry.released = true; entry.controller.abort(); }
    try {
      for (let index = 0; index < unfinished.length; index += 100) {
        await releaseJobs(this.pool, unfinished.slice(index, index + 100).map(entry => entry.job), this.observe);
      }
    } catch {
      this.logger.warn("[jobs] lease release failed at shutdown; leases will expire");
    }
    await Promise.allSettled(unfinished.map(entry => entry.done));
  }
}
