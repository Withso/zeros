import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemStatement, withSystemTx, withUserTx } from "./db.js";
import { requestTiming, type RequestDatabaseCost } from "./request-timing.js";
import { sql } from "./sql-fragment.js";
import {
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueJobStandalone,
  extendJobLease,
  failJob,
  JOB_NOTIFICATION_CHANNEL,
  JobError,
  purgeFailedJobs,
  releaseJobs,
  type ClaimedJob,
  type JobQueueCost,
} from "./job-queue.js";
import { JobRunner, type JobHandler } from "./job-runner.js";
import { resetMigratedTestDatabase } from "./test-database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
const KIND = "test_kind";
const policy = [{ kind: KIND, leaseMs: 60_000 }];

type Counter = { roundTrips: number; statements: number };
/** Counts what actually crosses the wire on every client of `pool`. Queue SQL
 * has no semicolons inside literals, so splitting on them counts statements. */
function countingPool(max = 2): { pool: pg.Pool; counter: Counter; reset(): void } {
  const counter: Counter = { roundTrips: 0, statements: 0 };
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  pool.on("connect", client => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
      counter.roundTrips += 1;
      counter.statements += text.split(";").filter(part => part.trim()).length;
      return original(...args);
    };
  });
  return { pool, counter, reset() { counter.roundTrips = 0; counter.statements = 0; } };
}

async function row(pool: pg.Pool, id: string) {
  return (await pool.query("SELECT * FROM control_plane_jobs WHERE id=$1", [id])).rows[0];
}

d("durable job queue", () => {
  let pool: pg.Pool;
  const runners: JobRunner[] = [];
  const extraPools: pg.Pool[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: databaseUrl, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map(runner => runner.stop()));
    await Promise.all(extraPools.splice(0).map(extra => extra.end()));
  });
  const extra = (options: pg.PoolConfig = {}) => {
    const created = new pg.Pool({ connectionString: databaseUrl, max: 2, ...options });
    extraPools.push(created);
    return created;
  };
  const runner = (options: Partial<ConstructorParameters<typeof JobRunner>[0]> & { handlers: JobHandler[] }) => {
    const created = new JobRunner({ pool, pollIntervalMs: 60_000, ...options });
    runners.push(created);
    return created;
  };
  const claimOne = async (owner = "worker-a", leaseMs = 60_000): Promise<ClaimedJob> => {
    const { jobs } = await claimJobs(pool, { owner, kinds: [{ kind: KIND, leaseMs }], limit: 1 });
    expect(jobs).toHaveLength(1);
    return jobs[0]!;
  };

  it("keeps the table system-only under forced RLS and the unprivileged role", async () => {
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "rls" });
    const catalog = await pool.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='control_plane_jobs'::regclass");
    expect(catalog.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privileges = await pool.query(`SELECT
      has_table_privilege('zeros_app','control_plane_jobs','SELECT,INSERT,UPDATE,DELETE') AS dml,
      has_table_privilege('zeros_app','control_plane_jobs','TRUNCATE') AS truncate`);
    expect(privileges.rows[0]).toEqual({ dml: true, truncate: false });
    const visible = await withUserTx(pool, randomUUID(), tx => tx.query("SELECT count(*)::integer AS count FROM control_plane_jobs"));
    expect(visible.rows[0].count).toBe(0);
    await expect(withUserTx(pool, randomUUID(), tx =>
      tx.query("INSERT INTO control_plane_jobs(kind,dedupe_key) VALUES ('test_kind','user')"))).rejects.toMatchObject({ code: "42501" });
    const app = extra({ options: "-c role=zeros_app" });
    expect((await app.query("SELECT count(*)::integer AS count FROM control_plane_jobs")).rows[0].count).toBe(0);
    expect((await withSystemTx(pool, tx => tx.query("SELECT count(*)::integer AS count FROM control_plane_jobs"))).rows[0].count).toBe(1);
  });

  it("enqueues idempotently: one active job per kind and key, earliest run wins", async () => {
    const later = new Date(Date.now() + 60 * 60_000);
    const first = await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "ws-1", payload: { workspace: 1 }, runAt: later });
    expect(first.outcome).toBe("inserted");
    expect(await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "ws-1", payload: { workspace: 1 }, runAt: later }))
      .toEqual({ outcome: "unchanged", id: null });
    expect(await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "ws-1", payload: { workspace: 1 },
      runAt: new Date(later.getTime() + 60_000) })).toEqual({ outcome: "unchanged", id: null });
    const earlier = new Date(Date.now() + 5 * 60_000);
    expect(await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "ws-1", payload: { workspace: 1 }, runAt: earlier }))
      .toEqual({ outcome: "updated", id: first.id });
    expect((await row(pool, first.id!)).run_at.getTime()).toBe(earlier.getTime());
    expect(await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "ws-1", payload: { workspace: 2 }, runAt: later }))
      .toEqual({ outcome: "updated", id: first.id });
    expect(await row(pool, first.id!)).toMatchObject({ payload: { workspace: 2 }, run_at: earlier, attempts: 0 });
    const otherKind = await enqueueJobStandalone(pool, { kind: "other_kind", dedupeKey: "ws-1" });
    expect(otherKind.outcome).toBe("inserted");
    // Concurrent enqueues of one key still converge on a single active row.
    await Promise.all(Array.from({ length: 8 }, () => enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "burst" })));
    expect((await pool.query("SELECT count(*)::integer AS count FROM control_plane_jobs WHERE dedupe_key='burst'")).rows[0].count).toBe(1);
    // A transactional enqueue rolls back with its caller.
    await expect(withSystemTx(pool, async tx => {
      await enqueueJob(tx, { kind: KIND, dedupeKey: "rolled-back" });
      throw new Error("domain write failed");
    })).rejects.toThrow("domain write failed");
    expect((await pool.query("SELECT count(*)::integer AS count FROM control_plane_jobs WHERE dedupe_key='rolled-back'")).rows[0].count).toBe(0);
  });

  it("reruns a job once more when it is re-enqueued during a run", async () => {
    const queued = await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "rerun", payload: { revision: 1 } });
    const job = await claimOne();
    expect(job).toMatchObject({ id: queued.id, attempts: 1, payload: { revision: 1 } });
    expect((await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "rerun", payload: { revision: 2 } })).outcome).toBe("updated");
    expect(await completeJob(pool, job)).toBe("requeued");
    expect(await row(pool, job.id)).toMatchObject({ state: "queued", attempts: 0, lease_token: null, rerun_at: null });
    const again = await claimOne();
    expect(again).toMatchObject({ id: job.id, attempts: 1, payload: { revision: 2 } });
    expect(await completeJob(pool, again)).toBe("deleted");
    expect(await row(pool, job.id)).toBeUndefined();
    // A terminal failure does not block a new job for the same key.
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "rerun", maxAttempts: 1 });
    const final = await claimOne();
    expect(await failJob(pool, final, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("failed");
    expect((await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "rerun" })).outcome).toBe("inserted");
  });

  it("keeps a rerun request that commits while completion waits for the row", async () => {
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "race", maxAttempts: 1 });
    const job = await claimOne();
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      await enqueueJob(writer, { kind: KIND, dedupeKey: "race", payload: { revision: 2 } });
      const completion = completeJob(pool, job);
      await vi.waitFor(async () => expect((await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%control_plane_jobs%'")).rowCount).toBe(1),
      { timeout: 2_000, interval: 10 });
      await writer.query("COMMIT");
      expect(await completion).toBe("requeued");
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      writer.release();
    }
    // The same request survives a final failed attempt as a fresh job.
    const again = await claimOne();
    expect(again).toMatchObject({ attempts: 1, payload: { revision: 2 } });
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "race", payload: { revision: 3 } });
    expect(await failJob(pool, again, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("retrying");
    expect(await row(pool, again.id)).toMatchObject({ state: "queued", attempts: 0, payload: { revision: 3 } });
  });

  it("never lets two concurrent workers claim the same job", async () => {
    await pool.query(`INSERT INTO control_plane_jobs(kind,dedupe_key,run_at)
      SELECT 'test_kind','job-'||n, now()-interval '1 minute' FROM generate_series(1,300) n`);
    // A third session holds row locks on five due jobs: SKIP LOCKED must pass
    // over them rather than wait or claim them.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const held = (await holder.query<{ id: string }>(
        "SELECT id FROM control_plane_jobs ORDER BY run_at,id LIMIT 5 FOR UPDATE")).rows.map(entry => entry.id);
      const workers = [extra(), extra()];
      const claimed: string[][] = [[], []];
      await Promise.all(workers.map(async (worker, index) => {
        for (;;) {
          const { jobs } = await claimJobs(worker, { owner: `worker-${index}`, kinds: policy, limit: 7 });
          if (!jobs.length) return;
          claimed[index]!.push(...jobs.map(job => job.id));
        }
      }));
      const all = claimed.flat();
      expect(new Set(all).size).toBe(all.length);
      expect(all).toHaveLength(295);
      expect(all.filter(id => held.includes(id))).toEqual([]);
      expect(claimed[0]!.length).toBeGreaterThan(0);
      expect(claimed[1]!.length).toBeGreaterThan(0);
      const owners = await pool.query("SELECT lease_owner, count(*)::integer AS count FROM control_plane_jobs WHERE state='running' GROUP BY 1 ORDER BY 1");
      expect(owners.rows).toEqual([
        { lease_owner: "worker-0", count: claimed[0]!.length },
        { lease_owner: "worker-1", count: claimed[1]!.length },
      ]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("reclaims an expired lease, fences the previous holder and fails a final expired attempt", async () => {
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "lease", maxAttempts: 2 });
    const first = await claimOne("worker-a");
    expect((await claimJobs(pool, { owner: "worker-b", kinds: policy, limit: 5 })).jobs).toEqual([]);
    await pool.query("UPDATE control_plane_jobs SET locked_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    const second = await claimOne("worker-b");
    expect(second).toMatchObject({ id: first.id, attempts: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await row(pool, first.id)).toMatchObject({ lease_owner: "worker-b", last_error_code: "lease_expired" });
    expect(await extendJobLease(pool, first, 60_000)).toBe(false);
    expect(await completeJob(pool, first)).toBe("lost");
    expect(await failJob(pool, first, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("lost");
    await pool.query("UPDATE control_plane_jobs SET locked_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    const exhausted = await claimJobs(pool, { owner: "worker-c", kinds: policy, limit: 5 });
    expect(exhausted).toMatchObject({ jobs: [], expired: 1, nextDueInMs: null });
    expect(await row(pool, first.id)).toMatchObject({ state: "failed", attempts: 2, last_error_code: "lease_expired", lease_token: null });
    expect(await completeJob(pool, second)).toBe("lost");
  });

  it("retries with backoff and records only closed error codes until the terminal failure", async () => {
    const { id } = await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "retry", maxAttempts: 3 });
    const attempt1 = await claimOne();
    const before = Date.now();
    expect(await failJob(pool, attempt1, { code: "provider_unavailable", retryable: true, delayMs: 5_000 })).toBe("retrying");
    const retried = await row(pool, id!);
    expect(retried).toMatchObject({ state: "queued", attempts: 1, last_error_code: "provider_unavailable", lease_token: null });
    expect(retried.run_at.getTime()).toBeGreaterThanOrEqual(before + 4_000);
    const pending = await claimJobs(pool, { owner: "worker-a", kinds: policy, limit: 1 });
    expect(pending.jobs).toEqual([]);
    expect(pending.nextDueInMs).toBeGreaterThan(3_000);
    expect(pending.nextDueInMs).toBeLessThanOrEqual(5_000);
    await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE id=$1", [id]);
    const attempt2 = await claimOne();
    expect(attempt2.attempts).toBe(2);
    expect(await failJob(pool, attempt2, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("retrying");
    const attempt3 = await claimOne();
    expect(await failJob(pool, attempt3, { code: "handler_timeout", retryable: true, delayMs: 0 })).toBe("failed");
    const failed = await row(pool, id!);
    expect(failed).toMatchObject({ state: "failed", attempts: 3, last_error_code: "handler_timeout" });
    expect(failed.finished_at).toBeInstanceOf(Date);
    expect((await claimJobs(pool, { owner: "worker-a", kinds: policy, limit: 1 })).jobs).toEqual([]);
    // Non-retryable failures are terminal on the first attempt.
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "fatal" });
    expect(await failJob(pool, await claimOne(), { code: "invalid_payload", retryable: false, delayMs: 0 })).toBe("failed");
    await expect(pool.query("UPDATE control_plane_jobs SET last_error_code='connection refused at 10.0.0.1'"))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE control_plane_jobs SET finished_at=now()-interval '2 days' WHERE state='failed'");
    expect(await purgeFailedJobs(pool, { olderThanMs: 24 * 60 * 60_000, limit: 10 })).toBe(2);
  });

  it("runs handlers from the registry and turns thrown errors into closed codes", async () => {
    const random = () => 0;
    const seen: string[] = [];
    runner({ random, handlers: [
      { kind: KIND, handle: async job => { seen.push(job.dedupeKey); } },
      { kind: "rate_limited", backoff: { baseMs: 1_000, maxMs: 1_000 }, handle: async () => {
        throw new JobError("provider_rate_limited", { retryAfterMs: 30_000 });
      } },
      { kind: "leaky", handle: async () => { throw new Error("secret detail /home/user"); } },
    ] }).start();
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "a" });
    await enqueueJobStandalone(pool, { kind: "rate_limited", dedupeKey: "b" });
    await enqueueJobStandalone(pool, { kind: "leaky", dedupeKey: "c" });
    await enqueueJobStandalone(pool, { kind: "unregistered", dedupeKey: "d" });
    const runnerWithoutListener = runners[0]!;
    runnerWithoutListener.notify();
    await vi.waitFor(async () => {
      const rows = (await pool.query("SELECT kind,state,attempts,last_error_code,run_at FROM control_plane_jobs ORDER BY kind")).rows;
      expect(rows.map(entry => [entry.kind, entry.state, entry.attempts, entry.last_error_code])).toEqual([
        ["leaky", "queued", 1, "handler_failed"],
        ["rate_limited", "queued", 1, "provider_rate_limited"],
        ["unregistered", "queued", 0, null],
      ]);
    }, { timeout: 3_000, interval: 25 });
    expect(seen).toEqual(["a"]);
    const limited = (await pool.query("SELECT run_at - updated_at AS delay FROM control_plane_jobs WHERE kind='rate_limited'")).rows[0];
    expect(limited.delay.seconds).toBeGreaterThanOrEqual(29);
  });

  it("bounds concurrency and claims again as slots free", async () => {
    let running = 0, peak = 0, done = 0;
    let releaseFirst!: () => void;
    const firstWave = new Promise<void>(resolve => { releaseFirst = resolve; });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const instance = runner({ concurrency: 3, handlers: [{ kind: KIND, handle: async job => {
        running += 1; peak = Math.max(peak, running);
        if (running === 3) releaseFirst();
        await firstWave;
        if (job.dedupeKey === "c-12") await holder.query("SELECT id FROM control_plane_jobs WHERE id=$1 FOR UPDATE", [job.id]);
        running -= 1; done += 1;
      } }] });
      await pool.query(`INSERT INTO control_plane_jobs(kind,dedupe_key) SELECT 'test_kind','c-'||n FROM generate_series(1,12) n`);
      instance.start();
      await vi.waitFor(() => expect(done).toBe(12), { timeout: 5_000, interval: 20 });
      expect(peak).toBe(3);
      expect(instance.inFlight).toBeGreaterThan(0);
      const draining = instance.stop();
      await holder.query("COMMIT");
      await draining;
      expect(done).toBe(12);
      expect(running).toBe(0);
      expect(instance.inFlight).toBe(0);
      expect((await pool.query("SELECT count(*)::integer AS count FROM control_plane_jobs")).rows[0].count).toBe(0);
    } finally {
      try {
        await holder.query("ROLLBACK");
      } finally {
        holder.release(true);
      }
    }
  });

  it("wakes on NOTIFY rather than the poll", async () => {
    const listenerPool = extra({ max: 1, application_name: "job-queue-listener-test" });
    const started = new Map<string, number>();
    const instance = runner({ listenerPool, handlers: [{ kind: KIND, handle: async job => { started.set(job.dedupeKey, performance.now()); } }] });
    instance.start();
    await vi.waitFor(async () => {
      const listening = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name='job-queue-listener-test' AND query LIKE 'LISTEN%'");
      expect(listening.rowCount).toBe(1);
    }, { timeout: 3_000, interval: 20 });
    // The 60 s poll cannot run within these waits, so every run proves a hint
    // (or the subscription flush) woke the runner. Latency is reported only.
    const latencies: number[] = [];
    for (let index = 0; index < 10; index++) {
      const key = `notify-${index}`;
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: key });
      const committed = performance.now();
      await vi.waitFor(() => expect(started.has(key)).toBe(true), { timeout: 10_000, interval: 2 });
      latencies.push(started.get(key)! - committed);
    }
    latencies.sort((left, right) => left - right);
    console.info(`[job-queue] NOTIFY commit-to-handler latency ms: median=${latencies[5]!.toFixed(1)} max=${latencies[9]!.toFixed(1)}`);
  });

  it("sends hints only when a job becomes due or a queued job's run_at changes", async () => {
    const hints = await pool.connect();
    const notices: string[] = [];
    try {
      hints.on("notification", notice => { if (notice.channel === JOB_NOTIFICATION_CHANNEL) notices.push(notice.payload ?? ""); });
      await hints.query(`LISTEN ${JOB_NOTIFICATION_CHANNEL}`);
      const expectNotices = async (expected: string[]) => {
        // Hints are delivered in commit order, so a later marker bounds the wait.
        await pool.query("SELECT pg_notify($1, 'marker')", [JOB_NOTIFICATION_CHANNEL]);
        await vi.waitFor(() => expect(notices.at(-1)).toBe("marker"), { timeout: 3_000, interval: 5 });
        expect(notices.splice(0)).toEqual([...expected, "marker"]);
      };
      const future = new Date(Date.now() + 60 * 60_000);
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "quiet", runAt: future });
      await expectNotices([""]);
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "quiet", runAt: future });
      await expectNotices([]);
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "quiet", runAt: new Date(future.getTime() - 60_000) });
      await expectNotices([""]);
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "work", maxAttempts: 5 });
      await expectNotices([""]);
      const first = await claimOne();
      await extendJobLease(pool, first, 60_000);
      await expectNotices([]);
      // A retry with backoff is armed by the failing runner and found by
      // others' polls; it must not wake every replica now.
      expect(await failJob(pool, first, { code: "handler_failed", retryable: true, delayMs: 60_000 })).toBe("retrying");
      await expectNotices([]);
      await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE id=$1", [first.id]);
      await expectNotices([""]);
      const second = await claimOne();
      expect(await failJob(pool, second, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("retrying");
      await expectNotices([""]);
      const third = await claimOne();
      await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "work", payload: { revision: 2 } });
      await expectNotices([]);
      expect(await completeJob(pool, third)).toBe("requeued");
      await expectNotices([""]);
      const fourth = await claimOne();
      expect(await releaseJobs(pool, [fourth])).toBe(1);
      await expectNotices([""]);
      expect(await completeJob(pool, await claimOne())).toBe("deleted");
      await expectNotices([]);
    } finally {
      await hints.query("UNLISTEN *");
      hints.release();
    }
  });

  it("falls back to the slow poll when a notification is lost", async () => {
    const listenerPool = extra({ max: 1, application_name: "job-queue-listener-lost" });
    let ran = false;
    const claims: number[] = [];
    const instance = runner({ listenerPool, pollIntervalMs: 1_000, random: () => 1,
      observe: cost => { if (cost.operation === "claim") claims.push(performance.now()); },
      handlers: [{ kind: KIND, handle: async () => { ran = true; } }] });
    const startedAt = performance.now();
    instance.start();
    await vi.waitFor(async () => expect((await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name='job-queue-listener-lost' AND query LIKE 'LISTEN%'")).rowCount).toBe(1),
    { timeout: 3_000, interval: 20 });
    // Wait for the first poll, long after the subscription flush, so that the
    // poll is the only remaining way to find the job.
    await vi.waitFor(() => expect(claims.some(at => at - startedAt >= 990)).toBe(true), { timeout: 5_000, interval: 10 });
    const claimsBefore = claims.length;
    // Commit a due job without firing its trigger, as if the hint were lost.
    const silent = await pool.connect();
    try {
      await silent.query("SET session_replication_role = replica");
      await silent.query("INSERT INTO control_plane_jobs(kind,dedupe_key) VALUES ('test_kind','lost-hint')");
    } finally {
      await silent.query("RESET session_replication_role");
      silent.release();
    }
    await vi.waitFor(() => expect(ran).toBe(true), { timeout: 5_000, interval: 20 });
    // No timing floor on the claim that finds the job: replica mode already
    // guarantees no hint fired, and the poll timer is armed independently of
    // the insert, so a poll that was already due may legitimately claim the
    // job immediately after it commits. The waitFor above is the assertion —
    // with the hint lost, only the poll can run the job, and five seconds is
    // five poll intervals. An absolute floor only measures timer phase and
    // flakes whenever the gate above resolves on a late hint claim (for
    // example a slow LISTEN subscription) instead of on the first poll.
    expect(claims.length).toBeGreaterThan(claimsBefore);
  });

  it("re-reads the queue when the LISTEN session is lost and restored", async () => {
    const listenerPool = extra({ max: 1, application_name: "job-queue-listener-drop" });
    let ran = false;
    const warn = vi.fn();
    const instance = runner({ listenerPool, logger: { warn }, handlers: [{ kind: KIND, handle: async () => { ran = true; } }] });
    instance.start();
    const listening = async () => (await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name='job-queue-listener-drop' AND query LIKE 'LISTEN%'")).rows;
    await vi.waitFor(async () => expect(await listening()).toHaveLength(1), { timeout: 3_000, interval: 20 });
    const [{ pid }] = await listening() as [{ pid: number }];
    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[jobs] notifications unavailable; polling remains enabled"),
      { timeout: 3_000, interval: 5 });
    // Nobody listens now, so this hint is lost. Only the resubscription flush
    // and the 60 s poll can find the job; the flush must win.
    expect(await listening()).toHaveLength(0);
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "during-gap" });
    await vi.waitFor(() => expect(ran).toBe(true), { timeout: 4_000, interval: 20 });
    await vi.waitFor(async () => expect(await listening()).toHaveLength(1), { timeout: 3_000, interval: 20 });
  });

  it("starts a fresh job at the requested rerun time when a final attempt fails", async () => {
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "terminal-rerun", maxAttempts: 1 });
    const job = await claimOne();
    const later = new Date(Date.now() + 60 * 60_000);
    expect((await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "terminal-rerun", runAt: later })).outcome).toBe("updated");
    expect(await failJob(pool, job, { code: "handler_failed", retryable: true, delayMs: 0 })).toBe("retrying");
    expect(await row(pool, job.id)).toMatchObject({ state: "queued", attempts: 0, rerun_at: null, run_at: later });
    // A due rerun request is not delayed by the failed run's backoff.
    await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE id=$1", [job.id]);
    const again = await claimOne();
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "terminal-rerun" });
    expect(await failJob(pool, again, { code: "invalid_payload", retryable: false, delayMs: 60 * 60_000 })).toBe("retrying");
    expect((await row(pool, job.id)).run_at.getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it("leaves a single-connection pool clean after a failed system statement", async () => {
    const single = extra({ max: 1 });
    const pid = (await single.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await expect(withSystemStatement(single, sql`SELECT 1 / 0`)).rejects.toMatchObject({ code: "22012" });
    const state = (await single.query(`SELECT pg_backend_pid() AS pid, current_user = session_user AS login_role,
      current_setting('app.system', true) AS system, now() = statement_timestamp() AS fresh_transaction`)).rows[0];
    expect(state).toMatchObject({ pid, login_role: true, fresh_transaction: true });
    expect([null, ""]).toContain(state.system);
    expect((await withSystemStatement<{ one: number }>(single, sql`SELECT 1 AS one`)).rows).toEqual([{ one: 1 }]);
    expect(single.totalCount).toBe(1);
  });

  it("reports a system statement to the request cost observer as one transaction", async () => {
    const observed = createPool(databaseUrl!, { maxConnections: 2 });
    extraPools.push(observed);
    const summaries: RequestDatabaseCost[] = [];
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: Number.POSITIVE_INFINITY, databasePool: observed,
      costObserver: summary => { summaries.push(summary); } }));
    app.post("/claim", async c => c.json(await claimJobs(observed, { owner: "worker-a", kinds: policy, limit: 1 })));
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "observed" });
    const response = await app.request("/claim", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).jobs).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ queriesStarted: 1, queriesCompleted: 1, sqlStatements: 5, transactions: 1,
      commits: 1, rollbacks: 0, sqlWriteStatements: 1, uncheckedClientCheckouts: 0 });
  });

  it("drains in-flight work on shutdown and releases leases a handler does not give up", async () => {
    let release!: () => void;
    const finished: string[] = [];
    const instance = runner({ drainTimeoutMs: 2_000, handlers: [{ kind: KIND, handle: async job => {
      await new Promise<void>(resolve => { release = resolve; });
      finished.push(job.dedupeKey);
    } }] });
    instance.start();
    const { id } = await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "drain" });
    instance.notify();
    await vi.waitFor(() => expect(instance.inFlight).toBe(1), { timeout: 2_000, interval: 10 });
    const stopping = instance.stop();
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "after-stop" });
    release();
    await stopping;
    expect(finished).toEqual(["drain"]);
    expect(await row(pool, id!)).toBeUndefined();
    expect((await pool.query("SELECT state FROM control_plane_jobs WHERE dedupe_key='after-stop'")).rows).toEqual([{ state: "queued" }]);

    let signalled = false;
    const stubborn = runner({ drainTimeoutMs: 100, handlers: [{ kind: KIND, handle: async (_job, { signal }) => {
      signal.addEventListener("abort", () => { signalled = true; }, { once: true });
      await new Promise(() => {});
    } }] });
    stubborn.start();
    await vi.waitFor(() => expect(stubborn.inFlight).toBe(1), { timeout: 2_000, interval: 10 });
    await stubborn.stop();
    expect(signalled).toBe(true);
    expect(stubborn.inFlight).toBe(0);
    expect((await pool.query("SELECT state,attempts,lease_token,lease_owner FROM control_plane_jobs WHERE dedupe_key='after-stop'")).rows)
      .toEqual([{ state: "queued", attempts: 0, lease_token: null, lease_owner: null }]);
  });

  it("costs exactly one round trip and five statements per claim, complete, fail, extend and release", async () => {
    const counting = countingPool();
    extraPools.push(counting.pool);
    const costs: JobQueueCost[] = [];
    const observe = (cost: JobQueueCost) => costs.push(cost);
    const measure = async (action: () => Promise<unknown>) => {
      counting.reset();
      costs.length = 0;
      await action();
      expect(costs).toHaveLength(1);
      expect({ roundTrips: costs[0]!.roundTrips, statements: costs[0]!.statements }).toEqual(counting.counter);
      return { ...counting.counter };
    };
    expect(await measure(() => enqueueJobStandalone(counting.pool, { kind: KIND, dedupeKey: "cost-1" }, observe)))
      .toEqual({ roundTrips: 3, statements: 5 });
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "cost-2" });
    let jobs: ClaimedJob[] = [];
    expect(await measure(async () => {
      jobs = (await claimJobs(counting.pool, { owner: "worker-a", kinds: policy, limit: 10 }, observe)).jobs;
    })).toEqual({ roundTrips: 1, statements: 5 });
    expect(jobs).toHaveLength(2);
    expect(await measure(() => claimJobs(counting.pool, { owner: "worker-a", kinds: policy, limit: 10 }, observe)))
      .toEqual({ roundTrips: 1, statements: 5 });
    expect(await measure(() => extendJobLease(counting.pool, jobs[0]!, 60_000, observe))).toEqual({ roundTrips: 1, statements: 5 });
    expect(await measure(() => completeJob(counting.pool, jobs[0]!, observe))).toEqual({ roundTrips: 1, statements: 5 });
    expect(await measure(() => failJob(counting.pool, jobs[1]!, { code: "handler_failed", retryable: true, delayMs: 0 }, observe)))
      .toEqual({ roundTrips: 1, statements: 5 });
    const reclaimed = await claimOne();
    expect(await measure(() => releaseJobs(counting.pool, [reclaimed], observe))).toEqual({ roundTrips: 1, statements: 5 });
    expect(await measure(() => purgeFailedJobs(counting.pool, { olderThanMs: 60_000, limit: 10 }, observe)))
      .toEqual({ roundTrips: 1, statements: 5 });
    // A transactional enqueue adds one statement to its caller's transaction.
    counting.reset();
    costs.length = 0;
    await withSystemTx(counting.pool, tx => enqueueJob(tx, { kind: KIND, dedupeKey: "cost-tx" }, observe));
    expect(costs.map(cost => [cost.roundTrips, cost.statements])).toEqual([[1, 1]]);
    expect(counting.counter).toEqual({ roundTrips: 3, statements: 5 });
  });

  it("processes one notified job in exactly two round trips: claim and complete", async () => {
    const counting = countingPool();
    extraPools.push(counting.pool);
    const listenerPool = extra({ max: 1, application_name: "job-queue-cost-listener" });
    const costs: JobQueueCost[] = [];
    let ran = 0;
    const instance = new JobRunner({ pool: counting.pool, listenerPool, pollIntervalMs: 60_000, observe: cost => costs.push(cost),
      handlers: [{ kind: KIND, handle: async () => { ran += 1; } }] });
    runners.push(instance);
    instance.start();
    await vi.waitFor(async () => expect((await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name='job-queue-cost-listener' AND query LIKE 'LISTEN%'")).rowCount).toBe(1),
    { timeout: 3_000, interval: 20 });
    await new Promise(resolve => setTimeout(resolve, 100));
    costs.length = 0;
    counting.reset();
    await enqueueJobStandalone(pool, { kind: KIND, dedupeKey: "budget" });
    await vi.waitFor(() => expect(ran).toBe(1), { timeout: 1_000, interval: 5 });
    await vi.waitFor(() => expect(costs.map(cost => cost.operation)).toEqual(["claim", "complete"]), { timeout: 1_000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(costs.map(cost => cost.operation)).toEqual(["claim", "complete"]);
    expect(counting.counter).toEqual({ roundTrips: 2, statements: 10 });
  });
});
