import { describe, expect, it } from "vitest";
import pg from "pg";
import { claimJobs, completeJob, enqueueJob, JobError, jobRetryDelayMs } from "./job-queue.js";
import { JobRunner } from "./job-runner.js";
import { withSystemStatement, type Tx } from "./db.js";

// No connection is ever opened: validation rejects before any acquire.
const unusedPool = new pg.Pool({ connectionString: "postgres://invalid.invalid:1/none", max: 1 });

describe("job queue validation", () => {
  it("doubles the backoff ceiling per attempt with equal jitter and a cap", () => {
    const policy = { baseMs: 1_000, maxMs: 10_000 };
    expect([1, 2, 3, 4, 5, 9].map(attempt => jobRetryDelayMs(attempt, policy, () => 0)))
      .toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect([1, 2, 3, 4, 5, 9].map(attempt => jobRetryDelayMs(attempt, policy, () => 1)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(jobRetryDelayMs(1_000, policy, () => 0.5)).toBe(7_500);
  });

  it("refuses unvalidated values before building a one-round-trip batch", async () => {
    const lease = { id: "00000000-0000-4000-8000-000000000000", leaseToken: "x' OR true --" };
    await expect(completeJob(unusedPool, lease)).rejects.toThrow("job_queue_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "worker", kinds: [{ kind: "Bad-Kind", leaseMs: 60_000 }], limit: 1 }))
      .rejects.toThrow("job_queue_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "it's", kinds: [{ kind: "ok", leaseMs: 60_000 }], limit: 1 }))
      .rejects.toThrow("job_queue_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "worker", kinds: [{ kind: "ok", leaseMs: 60_000 }], limit: 0 }))
      .rejects.toThrow("job_queue_integer_invalid");
    await expect(withSystemStatement(unusedPool, "SELECT 1; DROP TABLE users")).rejects.toThrow("system_statement_must_be_single");
  });

  it("rejects payloads that look like credentials, are too large or are not plain JSON", async () => {
    const tx = { query: async () => { throw new Error("unreachable"); } } as unknown as Tx;
    const base = { kind: "test_kind", dedupeKey: "key" };
    await expect(enqueueJob(tx, { ...base, payload: { nested: { apiToken: "x" } } })).rejects.toThrow("job_payload_secret_key");
    await expect(enqueueJob(tx, { ...base, payload: { blob: "x".repeat(5_000) } })).rejects.toThrow("job_payload_too_large");
    await expect(enqueueJob(tx, { ...base, payload: { at: new Date() as never } })).rejects.toThrow("job_payload_invalid");
    await expect(enqueueJob(tx, { ...base, dedupeKey: "" })).rejects.toThrow("job_dedupe_key_invalid");
    await expect(enqueueJob(tx, { ...base, workspaceId: "not-a-uuid" })).rejects.toThrow("job_scope_invalid");
    await expect(enqueueJob(tx, { ...base, maxAttempts: 0 })).rejects.toThrow("job_queue_integer_invalid");
  });

  it("accepts only closed error codes", () => {
    expect(new JobError("provider_rate_limited", { retryAfterMs: 2_000 })).toMatchObject({ retryable: true, retryAfterMs: 2_000 });
    expect(() => new JobError("raw failure text" as never)).toThrow("job_error_code_invalid");
  });

  it("validates runner bounds and refuses a sub-second poll", () => {
    const handler = { kind: "test_kind", handle: async () => {} };
    expect(() => new JobRunner({ pool: unusedPool, handlers: [handler], pollIntervalMs: 999 })).toThrow("job_runner_options_invalid");
    expect(() => new JobRunner({ pool: unusedPool, handlers: [handler], concurrency: 0 })).toThrow("job_runner_options_invalid");
    expect(() => new JobRunner({ pool: unusedPool, handlers: [handler, handler] })).toThrow("job_handler_invalid");
    expect(() => new JobRunner({ pool: unusedPool, handlers: [] })).toThrow("job_handlers_required");
  });
});
