import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "./auth.js";
import { withUserTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { AuthSessionProofService, authSessionExpiryHandler, repairAuthSessionExpiryJobs } from "./auth-session-proof.js";
import { claimJobs, completeJob } from "./job-queue.js";
import { ingestWorkOSManagementEvent } from "./workos-sync-events.js";
import type { WorkOSDesktopProvider } from "./workos-provider.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const KIND = "auth_session_expire";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

d("finite source-session proof", () => {
  let pool: pg.Pool;
  const services: AuthSessionProofService[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

  async function fixture() {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_${suffix}`, sessionId = `session_${suffix}`;
    const user = await ensureUser(pool, { provider: "workos", providerSubject: subject,
      email: `proof-${suffix}@example.com`, displayName: "Proof User" });
    const row = await pool.query<{ id: string }>(`INSERT INTO auth_sessions
      (provider_session_id, provider_sub, user_id, client_kind, last_token_expires_at)
      VALUES ($1, $2, $3, 'desktop', now() + interval '5 minutes') RETURNING id`,
    [sessionId, subject, user.id]);
    const input = { rowId: row.rows[0]!.id, userId: user.id, accountRevision: user.accountRevision };
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const record = { id: sessionId, userId: subject, status: "active", createdAt: new Date().toISOString(), expiresAt };
    const page = () => ({ data: [record], listMetadata: { after: null } });
    const list = vi.fn<WorkOSDesktopProvider["listSessions"]>(async () => page());
    const make = (options: ConstructorParameters<typeof AuthSessionProofService>[2] = {}) => {
      const service = new AuthSessionProofService(pool, { listSessions: list }, options);
      services.push(service);
      return service;
    };
    const rowState = async () => (await pool.query(`SELECT * FROM auth_sessions WHERE id = $1`, [input.rowId])).rows[0];
    const jobs = async () => (await pool.query(`SELECT * FROM control_plane_jobs WHERE kind = $1`, [KIND])).rows;
    return { subject, sessionId, user, input, record, page, list, make, rowState, jobs };
  }

  it("stores finite proof and its versioned expiry job atomically with no provider material", async () => {
    const f = await fixture();
    const proof = await f.make().prove(f.input);
    expect(proof).toMatchObject({ ...f.input, proofVersion: 1, expiresAtMs: Date.parse(f.record.expiresAt) });
    expect(await f.rowState()).toMatchObject({ status: "active", provider_session_proof_version: "1",
      provider_session_expires_at: new Date(f.record.expiresAt) });
    expect(await f.jobs()).toMatchObject([{ payload: { rowId: f.input.rowId, proofVersion: 1,
      expiresAtMs: Date.parse(f.record.expiresAt) }, run_at: new Date(f.record.expiresAt) }]);
    expect(JSON.stringify((await f.jobs())[0].payload)).not.toContain(f.sessionId);
    expect(JSON.stringify((await f.jobs())[0].payload)).not.toContain(f.subject);
  });

  it.each([undefined, null, "", "invalid", "infinity", "2026-02-30T00:00:00Z", "2000-01-01T00:00:00Z"])(
    "missing_provider_expiry_cannot_enroll (%s)", async expiry => {
      const f = await fixture();
      f.list.mockResolvedValue({ data: [{ ...f.record, expiresAt: expiry }], listMetadata: { after: null } });
      await expect(f.make().prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
      expect(await f.jobs()).toHaveLength(0);
    });

  it.each(["wrong user", "revoked", "expired", "missing session"])("refuses %s provider evidence", async fault => {
    const f = await fixture();
    f.list.mockResolvedValue({ data: [{ ...f.record,
      ...(fault === "wrong user" ? { userId: "user_other" } : {}),
      ...(fault === "missing session" ? { id: "session_other" } : {}),
      ...(["revoked", "expired"].includes(fault) ? { status: fault } : {}),
    }], listMetadata: { after: null } });
    await expect(f.make().prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
    expect(await f.jobs()).toHaveLength(0);
  });

  it("two_chats_share_one_lookup_and_dormant_sessions_make_none", async () => {
    const f = await fixture(), response = deferred<ReturnType<typeof f.page>>(), service = f.make();
    await fixture(); // Another dormant source must not be enumerated.
    expect(f.list).not.toHaveBeenCalled();
    f.list.mockReturnValue(response.promise);
    const first = service.prove(f.input), second = service.prove(f.input);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    response.resolve(f.page());
    const proofs = await Promise.all([first, second]);
    expect(proofs[0]).toEqual(proofs[1]);
    expect(await f.jobs()).toHaveLength(1);
    expect(f.list).toHaveBeenCalledWith(f.subject, expect.objectContaining({ limit: 100, signal: expect.any(AbortSignal) }));
  });

  it("bounds positive cache age from observation start rather than response completion", async () => {
    const f = await fixture();
    let clock = Date.now();
    const start = clock, service = f.make({ now: () => clock, monotonicNow: () => clock });
    f.list.mockImplementationOnce(async () => { clock += 4_000; return f.page(); });
    const first = await service.prove(f.input);
    clock = start + 9_999;
    expect(await service.prove(f.input)).toEqual(first);
    expect(f.list).toHaveBeenCalledOnce();
    clock = start + 10_000;
    expect((await service.prove(f.input)).proofVersion).toBe(2);
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("bounds queued expiry work across repeated fresh observations", async () => {
    const f = await fixture();
    let clock = Date.now();
    const service = f.make({ now: () => clock, monotonicNow: () => clock });
    for (let index = 0; index < 4; index++) {
      await service.prove(f.input);
      clock += 11_000;
    }
    expect(await f.jobs()).toMatchObject([{ payload: { proofVersion: 4 } }]);
    expect(await f.jobs()).toHaveLength(1);
  });

  it("bounds cache entries and refuses excess concurrent source lookups", async () => {
    const f = await fixture(), other = await fixture(), service = f.make({ maxEntries: 1 });
    f.list.mockImplementation(async subject => subject === f.subject ? f.page() : other.page());
    await service.prove(f.input);
    await service.prove(other.input);
    await service.prove(f.input);
    expect(f.list).toHaveBeenCalledTimes(3);

    const pending = deferred<ReturnType<typeof f.page>>(), secondService = f.make({ maxEntries: 1 });
    f.list.mockClear().mockReturnValue(pending.promise);
    const inFlight = secondService.prove(f.input).catch(error => error);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    await expect(secondService.prove(other.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
    secondService.dispose();
    expect((await inFlight).code).toBe("provider_session_proof_unavailable");
    pending.resolve(f.page());
  });

  it("does not hold a database connection while awaiting the provider", async () => {
    const f = await fixture(), single = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    try {
      const service = new AuthSessionProofService(single, { listSessions: async () => {
        await single.query("SELECT 1");
        return f.page();
      } });
      services.push(service);
      await expect(service.prove(f.input)).resolves.toMatchObject({ proofVersion: 1 });
    } finally { await single.end(); }
  });

  it("a backward wall clock cannot extend a cached observation", async () => {
    const f = await fixture();
    let wall = Date.now(), monotonic = 100;
    const service = f.make({ now: () => wall, monotonicNow: () => monotonic });
    await service.prove(f.input);
    wall -= 1000;
    monotonic += 500;
    await service.prove(f.input);
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("rolls back proof storage if durable enqueue fails", async () => {
    const f = await fixture();
    await pool.query(`ALTER TABLE control_plane_jobs ADD CONSTRAINT test_refuse_proof CHECK(kind <> 'auth_session_expire')`);
    try {
      await expect(f.make().prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
      expect(await f.rowState()).toMatchObject({ provider_session_proof_version: "0", provider_session_proved_at: null,
        provider_session_expires_at: null });
    } finally { await pool.query("ALTER TABLE control_plane_jobs DROP CONSTRAINT test_refuse_proof"); }
  });

  it("refuses an incomplete bounded search after four pages", async () => {
    const f = await fixture();
    f.list.mockImplementation(async (_subject, options) => ({
      data: Array.from({ length: 100 }, (_, index) => ({ ...f.record, id: `session_other_${index}` })),
      listMetadata: { after: `${options.after ?? "page"}_next` },
    }));
    await expect(f.make().prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(await f.jobs()).toHaveLength(0);
  });

  it("cancels a five-second lookup even when the provider never settles", async () => {
    const f = await fixture();
    let signal: AbortSignal | undefined;
    const entered = deferred<void>();
    f.list.mockImplementation((_subject, options) => {
      signal = options.signal; entered.resolve(); return new Promise(() => {});
    });
    // Keep PostgreSQL and the test runner on real time. Advance only the
    // provider deadline after the real lookup has started, proving both
    // sides of the production 5 s bound without racing Vitest's 5 s budget.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = f.make().prove(f.input).catch(error => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ code: "provider_session_proof_unavailable" });
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
    expect(await f.jobs()).toHaveLength(0);
  });

  it("one cancelled waiter cannot cancel another; all cancelled waiters prevent late persistence", async () => {
    const f = await fixture(), response = deferred<ReturnType<typeof f.page>>(), service = f.make();
    f.list.mockReturnValue(response.promise);
    const cancelled = new AbortController();
    const first = service.prove(f.input, cancelled.signal).catch(error => error), second = service.prove(f.input);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    cancelled.abort();
    expect((await first).code).toBe("provider_session_proof_unavailable");
    expect(f.list.mock.calls[0]![1].signal?.aborted).toBe(false);
    response.resolve(f.page());
    await expect(second).resolves.toMatchObject({ proofVersion: 1 });

    const another = await fixture(), pending = deferred<ReturnType<typeof another.page>>(), controller = new AbortController();
    another.list.mockReturnValue(pending.promise);
    const result = another.make().prove(another.input, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(another.list).toHaveBeenCalledOnce());
    controller.abort();
    expect((await result).code).toBe("provider_session_proof_unavailable");
    pending.resolve(another.page());
    await new Promise(resolve => setImmediate(resolve));
    expect((await another.rowState()).provider_session_proof_version).toBe("0");
  });

  it.each(["source revoke", "account revision", "identity revoke", "source replacement"])(
    "late_workos_proof_cannot_resurrect_revoked_source (%s)", async change => {
      const f = await fixture(), response = deferred<ReturnType<typeof f.page>>();
      f.list.mockReturnValue(response.promise);
      const result = f.make().prove(f.input).catch(error => error);
      await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
      if (change === "source revoke") await pool.query(`UPDATE auth_sessions SET status='revoked', revoked_at=now() WHERE id=$1`, [f.input.rowId]);
      if (change === "account revision") await pool.query(`UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1`, [f.user.id]);
      if (change === "identity revoke") await pool.query(`UPDATE user_identities SET status='revoked' WHERE provider_sub=$1`, [f.subject]);
      if (change === "source replacement") await pool.query(`UPDATE auth_sessions SET id=$2 WHERE id=$1`, [f.input.rowId, randomUUID()]);
      response.resolve(f.page());
      expect((await result).code).toBe("provider_session_proof_unavailable");
      expect(await f.jobs()).toHaveLength(0);
    });

  it("a cached positive result cannot bypass a later source or account revocation", async () => {
    const f = await fixture(), service = f.make();
    await service.prove(f.input);
    await pool.query(`UPDATE auth_sessions SET status='revoked', revoked_at=now() WHERE id=$1`, [f.input.rowId]);
    await expect(service.prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
    expect(f.list).toHaveBeenCalledOnce();
  });

  it("bounds retained waiter callbacks during cancellation churn", async () => {
    const f = await fixture(), response = deferred<ReturnType<typeof f.page>>(), service = f.make();
    f.list.mockReturnValue(response.promise);
    const keeper = service.prove(f.input);
    await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
    // A pending Promise retains each .then reaction until it settles. Unlike
    // abort listeners, these reactions cannot be individually removed.
    const flights = (service as unknown as { flights: Map<string, { promise: Promise<unknown> }> }).flights;
    const pending = [...flights.values()][0]!.promise;
    const attached = vi.spyOn(pending, "then");
    for (let index = 0; index < 1024; index++) {
      const cancellation = new AbortController();
      const waiter = service.prove(f.input, cancellation.signal).catch(error => error);
      cancellation.abort();
      await waiter;
    }
    const retainedReactions = attached.mock.calls.length;
    response.resolve(f.page());
    await keeper;
    expect(retainedReactions).toBeLessThanOrEqual(256);
  });

  it("source metadata stays system-only under RLS", async () => {
    const f = await fixture();
    await f.make().prove(f.input);
    const visible = await withUserTx(pool, f.user.id, tx => tx.query("SELECT id FROM auth_sessions"));
    expect(visible.rows).toHaveLength(0);
    await expect(withUserTx(pool, f.user.id, tx => tx.query(`UPDATE auth_sessions SET
      provider_session_proof_version=99 WHERE id=$1 RETURNING id`, [f.input.rowId]))).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects missing or unbounded persisted proof deadlines", async () => {
    const f = await fixture();
    for (const expiry of [null, "infinity", "-infinity"])
      await expect(pool.query(`UPDATE auth_sessions SET provider_session_proof_version=1,
        provider_session_expires_at=$2 WHERE id=$1`, [f.input.rowId, expiry])).rejects.toMatchObject({ code: "23514" });
    expect((await f.rowState()).provider_session_proof_version).toBe("0");
  });

  it("replacing a queued deadline leaves a previously claimed job fenced and completable", async () => {
    const f = await fixture();
    let clock = Date.now();
    const service = f.make({ now: () => clock, monotonicNow: () => clock });
    await service.prove(f.input);
    await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE kind=$1", [KIND]);
    const claimed = await claimJobs(pool, { owner: "proof-test", kinds: [{ kind: KIND, leaseMs: 60_000 }], limit: 1 });
    const old = claimed.jobs[0]!;
    clock += 11_000;
    await service.prove(f.input);
    expect((await f.jobs()).map(job => job.state).sort()).toEqual(["queued", "running"]);
    await authSessionExpiryHandler(pool).handle(old, { signal: new AbortController().signal });
    expect(await completeJob(pool, old)).toBe("deleted");
    expect(await f.jobs()).toMatchObject([{ state: "queued", payload: { proofVersion: 2 } }]);
    expect((await f.rowState()).status).toBe("active");
  });

  it("stale_expiry_job_cannot_revoke_extended_proof", async () => {
    const f = await fixture();
    let clock = Date.now();
    const service = f.make({ now: () => clock, monotonicNow: () => clock });
    await service.prove(f.input);
    const oldJob = (await f.jobs())[0];
    // Make the old deadline genuinely due, without a wall-clock sleep. The
    // subsequent positive lookup must still beat this stale delivery.
    const past = new Date(Date.now() - 1000);
    await pool.query("UPDATE auth_sessions SET provider_session_expires_at=$2 WHERE id=$1", [f.input.rowId, past]);
    oldJob.payload.expiresAtMs = past.getTime();
    clock += 11_000;
    f.record.expiresAt = new Date(Date.parse(f.record.expiresAt) + 60_000).toISOString();
    await service.prove(f.input);
    await authSessionExpiryHandler(pool).handle(oldJob, { signal: new AbortController().signal });
    expect((await f.rowState()).status).toBe("active");
    expect((await f.rowState()).provider_session_proof_version).toBe("2");
    expect((await pool.query("SELECT * FROM security_events WHERE kind='session.revoked'")).rows).toHaveLength(0);
  });

  it("a due expiry revokes only that source and publishes one S1 event across retries", async () => {
    const f = await fixture(), sibling = `session_sibling_${randomUUID()}`;
    await pool.query(`INSERT INTO auth_sessions(provider_session_id, provider_sub, user_id)
      VALUES($1,$2,$3)`, [sibling, f.subject, f.user.id]);
    await f.make().prove(f.input);
    const expiry = new Date(Date.now() - 1000);
    await pool.query(`UPDATE auth_sessions SET provider_session_expires_at=$2 WHERE id=$1`, [f.input.rowId, expiry]);
    const payload = { rowId: f.input.rowId, proofVersion: 1, expiresAtMs: expiry.getTime() };
    const handler = authSessionExpiryHandler(pool);
    const job = { ...(await f.jobs())[0], payload };
    await handler.handle(job, { signal: new AbortController().signal });
    await handler.handle(job, { signal: new AbortController().signal });
    expect((await f.rowState()).status).toBe("expired");
    expect((await pool.query("SELECT status FROM auth_sessions WHERE provider_session_id=$1", [sibling])).rows[0].status).toBe("active");
    expect((await pool.query(`SELECT provider_session_id, user_id, payload FROM security_events
      WHERE kind='session.revoked'`)).rows).toEqual([{ provider_session_id: f.sessionId, user_id: f.user.id,
      payload: { reason: "provider_session_expired" } }]);
    await expect(f.make().prove(f.input)).rejects.toMatchObject({ code: "provider_session_proof_unavailable" });
  });

  it("expiry revocation and its S1 event commit together", async () => {
    const f = await fixture();
    await f.make().prove(f.input);
    const past = new Date(Date.now() - 1000), job = (await f.jobs())[0];
    await pool.query("UPDATE auth_sessions SET provider_session_expires_at=$2 WHERE id=$1", [f.input.rowId, past]);
    job.payload.expiresAtMs = past.getTime();
    await pool.query(`ALTER TABLE security_events ADD CONSTRAINT test_refuse_expiry CHECK(kind <> 'session.revoked')`);
    try {
      await expect(authSessionExpiryHandler(pool).handle(job, { signal: new AbortController().signal })).rejects.toBeDefined();
      expect((await f.rowState()).status).toBe("active");
    } finally { await pool.query("ALTER TABLE security_events DROP CONSTRAINT test_refuse_expiry"); }
    await authSessionExpiryHandler(pool).handle(job, { signal: new AbortController().signal });
    expect((await f.rowState()).status).toBe("expired");
  });

  it("an early delivery reschedules the original expiry through real queue completion", async () => {
    const f = await fixture();
    await f.make().prove(f.input);
    await pool.query("UPDATE control_plane_jobs SET run_at=now() WHERE kind=$1", [KIND]);
    const claimed = await claimJobs(pool, { owner: "proof-test", kinds: [{ kind: KIND, leaseMs: 60_000 }], limit: 1 });
    expect(claimed.jobs).toHaveLength(1);
    const job = claimed.jobs[0]!;
    await authSessionExpiryHandler(pool).handle(job, { signal: new AbortController().signal });
    await completeJob(pool, job);
    expect(await f.jobs()).toMatchObject([{ state: "queued", run_at: new Date(f.record.expiresAt) }]);
    expect((await f.rowState()).status).toBe("active");
  });

  it("a malformed job cannot revoke an otherwise matching source", async () => {
    const f = await fixture();
    await f.make().prove(f.input);
    const job = (await f.jobs())[0];
    job.payload.extra = "not part of the closed contract";
    await expect(authSessionExpiryHandler(pool).handle(job, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "invalid_payload", retryable: false });
    expect((await f.rowState()).status).toBe("active");
  });

  it("repairs a missing versioned job after restart without enumerating dormant sessions", async () => {
    const f = await fixture();
    await fixture();
    await f.make().prove(f.input);
    await pool.query("DELETE FROM control_plane_jobs WHERE kind=$1", [KIND]);
    expect(await repairAuthSessionExpiryJobs(pool)).toBe(1);
    expect(await repairAuthSessionExpiryJobs(pool)).toBe(0);
    expect(await f.jobs()).toHaveLength(1);
    expect(f.list).toHaveBeenCalledOnce();
  });

  it("explicit webhook expiry changes invalidate old jobs; omitted expiry retains finite proof", async () => {
    const f = await fixture();
    await f.make().prove(f.input);
    const event = (expiresAt?: string) => ({ id: `event_${randomUUID()}`, event: "session.created",
      createdAt: new Date().toISOString(), data: { id: f.sessionId, userId: f.subject,
        updatedAt: new Date().toISOString(), ...(expiresAt ? { expiresAt } : {}) } });
    await ingestWorkOSManagementEvent(pool, event(), "webhook");
    expect((await f.rowState()).provider_session_proof_version).toBe("1");
    expect((await f.rowState()).provider_session_expires_at).toEqual(new Date(f.record.expiresAt));
    const earlier = new Date(Date.now() + 10_000).toISOString();
    await ingestWorkOSManagementEvent(pool, event(earlier), "webhook");
    expect(await f.rowState()).toMatchObject({ provider_session_proof_version: "2",
      provider_session_proved_at: null, provider_session_expires_at: new Date(earlier) });
    expect((await f.jobs()).some(job => job.payload.proofVersion === 2 && job.payload.expiresAtMs === Date.parse(earlier))).toBe(true);
  });
});
