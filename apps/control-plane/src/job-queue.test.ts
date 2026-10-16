import { describe, expect, it } from "vitest";
import pg from "pg";
import { claimJobs, completeJob, enqueueJob, JobError, jobRetryDelayMs } from "./job-queue.js";
import { JobRunner } from "./job-runner.js";
import { withSystemStatement, type Tx } from "./db.js";
import { sql, SqlFragment } from "./sql-fragment.js";

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
    await expect(completeJob(unusedPool, lease)).rejects.toThrow("sql_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "worker", kinds: [{ kind: "Bad-Kind", leaseMs: 60_000 }], limit: 1 }))
      .rejects.toThrow("sql_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "it's", kinds: [{ kind: "ok", leaseMs: 60_000 }], limit: 1 }))
      .rejects.toThrow("sql_literal_invalid");
    await expect(claimJobs(unusedPool, { owner: "worker", kinds: [{ kind: "ok", leaseMs: 60_000 }], limit: 0 }))
      .rejects.toThrow("sql_integer_invalid");
  });

  it("accepts only statement fragments built from template text and validated literals", async () => {
    await expect(withSystemStatement(unusedPool, "SELECT 1" as never)).rejects.toThrow("system_statement_fragment_required");
    await expect(withSystemStatement(unusedPool, { text: "SELECT 1" } as never)).rejects.toThrow("system_statement_fragment_required");
    await expect(withSystemStatement(unusedPool, sql`SELECT 1; DROP TABLE users`)).rejects.toThrow("system_statement_must_be_single");
    expect(() => sql`SELECT ${"1; DROP TABLE users" as never}`).toThrow("sql_fragment_invalid");
    expect(() => sql(["SELECT 1"] as unknown as TemplateStringsArray)).toThrow("sql_fragment_invalid");
    expect(() => SqlFragment.text("it's", /.*/)).toThrow("sql_literal_invalid");
    expect(() => SqlFragment.text("a\\b", /.*/)).toThrow("sql_literal_invalid");
    expect(() => SqlFragment.uuid("x' OR true --")).toThrow("sql_literal_invalid");
    expect(() => SqlFragment.integer(1.5, 0, 10)).toThrow("sql_integer_invalid");
    // A negative literal after a minus sign must not become a `--` comment.
    expect(sql`now() -${SqlFragment.integer(-5, -10, 10)}`.text).toBe("now() -(-5)");
    expect(sql`a = ${SqlFragment.text("worker-1", /^[a-z0-9-]+$/)} AND ${SqlFragment.boolean(true)}`.text)
      .toBe("a = 'worker-1' AND true");
  });

  it("rejects NUL and ill-formed UTF-16 in payloads and dedupe keys before any SQL runs", async () => {
    const tx = { query: async () => { throw new Error("unreachable"); } } as unknown as Tx;
    const base = { kind: "test_kind", dedupeKey: "key" };
    for (const payload of [{ name: "a\u0000b" }, { name: "\uD800" }, { list: ["ok", "\uDC00x"] }, { ["k\u0000"]: 1 }, { ["\uD83D"]: 1 }]) {
      await expect(enqueueJob(tx, { ...base, payload })).rejects.toThrow("job_payload_invalid");
    }
    for (const dedupeKey of ["a\u0000b", "workspace:\uD800", "\uDFFF"]) {
      await expect(enqueueJob(tx, { ...base, dedupeKey })).rejects.toThrow("job_dedupe_key_invalid");
    }
    // A well-formed surrogate pair is ordinary text.
    await expect(enqueueJob(tx, { ...base, dedupeKey: "emoji:\uD83D\uDE00", payload: { name: "\uD83D\uDE00" } }))
      .rejects.toThrow("unreachable");
  });

  it("screens payload keys, payload strings and dedupe keys for credentials", async () => {
    const tx = { query: async () => { throw new Error("unreachable"); } } as unknown as Tx;
    const base = { kind: "test_kind", dedupeKey: "key" };
    for (const key of ["apiKey", "api_key", "accessKey", "ACCESS_KEY", "signingKey", "sessionId", "session", "authHeader",
      "auth", "oauthCode", "jwt", "idJwt", "signature", "sentryDsn", "dsn", "clientSecret", "refreshToken", "passwd"]) {
      await expect(enqueueJob(tx, { ...base, payload: { [key]: "x" } }), key).rejects.toThrow("job_payload_secret_key");
    }
    for (const key of ["authorId", "workspaceId", "keyboardLayout", "dedupeKey", "generation", "author_name"]) {
      await expect(enqueueJob(tx, { ...base, payload: { [key]: "x" } }), key).rejects.toThrow("unreachable");
    }
    // Built at run time so the repository's own secret scan has nothing to flag.
    const credentialShaped = [
      `Bearer ${"a".repeat(24)}`,
      `${"ey"}J${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
      `${"gh"}p_${"a".repeat(36)}`,
      `${"AK"}IA${"A".repeat(16)}`,
      `-----${"BEGIN"} PRIVATE KEY-----`,
      `postgres://user:${"p".repeat(8)}@db.example/zeros`,
      "token=abc123",
    ];
    for (const value of credentialShaped) {
      await expect(enqueueJob(tx, { ...base, payload: { note: value } }), value).rejects.toThrow("job_payload_secret_value");
      await expect(enqueueJob(tx, { ...base, dedupeKey: `workspace:${value}` }), value).rejects.toThrow("job_dedupe_key_secret");
    }
    for (const dedupeKey of ["workspace:2b9c1f9e-4f7a-4bde-9c43-1e8f2a6c9d10", "lease:42", "provider:hetzner", "task-1234567890abcdef"]) {
      await expect(enqueueJob(tx, { ...base, dedupeKey }), dedupeKey).rejects.toThrow("unreachable");
    }
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
    await expect(enqueueJob(tx, { ...base, dedupeKey: "x".repeat(201) })).rejects.toThrow("job_dedupe_key_invalid");
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
