import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
import { CloudProviderError } from "./provider-error.js";
import { ProviderStopCheck } from "./provider-stop.js";
import type { CloudV2ProviderStopBinding } from "./store.js";

// Boat archived a resumed VM on its own (Alpha 2026-11-18, d84e98b8): the workspace stayed `running` and its waiting
// messages sat for 12 minutes. The provider stop finishes that stop and wakes for the waiting messages.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("Boat archived a running VM on its own", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(f.creator); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  afterAll(() => pool.end());

  // Boat's stop time just after our worker's latest activity, as in the incident.
  const archived = () => ({ state: "archived", stoppedAt: new Date() });
  const check = (inspected: { state: string; stoppedAt?: Date | null } | Error = archived(), mode: "observe" | "on" = "on") => new ProviderStopCheck({
    mode, store: f.cp.store, schedule: () => {}, wait: async () => {},
    compute: { inspect: vi.fn(async () => { if (inspected instanceof Error) throw inspected; return inspected; }) },
  });
  const binding = async (): Promise<CloudV2ProviderStopBinding> => {
    const row = (await pool.query(`SELECT boat_sandbox_id,worker_boot_id,encode(worker_token_hash,'hex') AS hash,access_epoch::text FROM cloud_v2_workspaces WHERE id=$1`,
      [f.workspace.id])).rows[0];
    return { workspaceId: f.workspace.id, sandboxId: row.boat_sandbox_id, bootId: row.worker_boot_id, workerTokenHash: row.hash, accessEpoch: row.access_epoch };
  };
  const workspace = async () => (await pool.query(`SELECT state,stop_generation::text,worker_boot_id,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1`, [f.workspace.id])).rows[0];
  const prompts = async () => Object.fromEntries((await pool.query(`SELECT user_message_id,state,wake_after_stop FROM cloud_v2_prompt_outbox WHERE workspace_id=$1`,
    [f.workspace.id])).rows.map(row => [row.user_message_id, { state: row.state, wake: row.wake_after_stop }]));
  const stops = async () => (await pool.query(`SELECT trigger,mode,provider_state,rewake,outcome FROM cloud_v2_provider_stops WHERE workspace_id=$1 ORDER BY detected_at`, [f.workspace.id])).rows;

  it("finishes the stop, interrupts the turn in flight and wakes once for the waiting message", async () => {
    const running = await f.dispatch(f.prompt());
    const waiting = f.prompt(randomUUID(), { chatId: "other" });
    expect((await f.send(waiting)).status).toBe(201);
    const before = await workspace();
    expect(await check().check(await binding(), "dial")).toBe("rewake");
    const after = await workspace();
    expect(after).toMatchObject({ state: "stopped", worker_boot_id: null, worker_token_hash: null });
    expect(BigInt(after.stop_generation)).toBe(BigInt(before.stop_generation) + 1n);
    expect(await prompts()).toEqual({ [running.input.userMessageId]: { state: "interrupted", wake: false }, [waiting.userMessageId]: { state: "queued", wake: true } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state<>'retired'`, [f.workspace.id])).rows[0].n).toBe(0);
    expect(await stops()).toEqual([{ trigger: "dial", mode: "on", provider_state: "archived", rewake: true, outcome: "rewake" }]);
    // The existing wake path takes it from here, with the waiting message's sender as the initiator.
    await f.cp.store.prompts.wakePending();
    expect((await workspace()).state).toBe("starting");
  });

  it("keeps a stopped workspace with nothing waiting stopped", async () => {
    expect(await check().check(await binding(), "wake_check")).toBe("stopped");
    expect((await workspace()).state).toBe("stopped");
    expect(await stops()).toEqual([{ trigger: "wake_check", mode: "on", provider_state: "archived", rewake: false, outcome: "stopped" }]);
  });

  const marker = async () => (await pool.query(`SELECT stop_generation::text,stop_archive_failed_generation::text AS failed FROM cloud_v2_workspaces WHERE id=$1`,
    [f.workspace.id])).rows[0];
  it("records a stop whose last snapshot attempt the provider reports failed, so it is never read as clean", async () => {
    expect(await check({ ...archived(), snapshotStatus: "failed" } as never).check(await binding(), "wake_check")).toBe("stopped");
    const after = await marker();
    expect(after.failed).toBe(after.stop_generation);
  });

  it("records nothing of a stop whose last snapshot attempt completed, or that the provider says nothing of", async () => {
    expect(await check({ ...archived(), snapshotStatus: "completed" } as never).check(await binding(), "wake_check")).toBe("stopped");
    expect((await marker()).failed).toBeNull();
  });

  it("treats a sandbox that is gone like an archived one, and does nothing while Boat says it runs or cannot answer", async () => {
    for (const inspected of [{ state: "running" }, new CloudProviderError("provider_unavailable", "Boat unavailable", true), { state: "archiving" }]) {
      expect(["running", "unknown"]).toContain(await check(inspected).check(await binding(), "dial"));
      expect((await workspace()).state).toBe("running");
    }
    expect(await check(new CloudProviderError("provider_not_found", "gone", false)).check(await binding(), "dial")).toBe("stopped");
    expect(await stops()).toEqual([{ trigger: "dial", mode: "on", provider_state: "missing", rewake: false, outcome: "stopped" }]);
  });

  it("only records in observe mode", async () => {
    const before = await workspace();
    let now = 0;
    // One Boat answer for both reads: the confirmation read must agree, including the stop time.
    const answer = archived();
    const observe = new ProviderStopCheck({ mode: "observe", store: f.cp.store, schedule: () => {}, wait: async () => {}, now: () => now,
      compute: { inspect: async () => answer } });
    expect(await observe.check(await binding(), "suspect")).toBe("observed");
    now += 3_600_000;
    expect(await observe.check(await binding(), "suspect")).toBe("observed");
    expect(await workspace()).toEqual(before);
    // One row per boot, not one per recheck.
    expect(await stops()).toEqual([{ trigger: "suspect", mode: "observe", provider_state: "archived", rewake: false, outcome: "observed" }]);
  });

  it("does nothing for another boot, a user's stop or a stopped workspace", async () => {
    const current = await binding();
    expect(await check().check({ ...current, bootId: randomUUID() }, "dial")).toBe("stale");
    expect(await check().check({ ...current, accessEpoch: String(BigInt(current.accessEpoch) + 1n) }, "dial")).toBe("stale");
    await f.cp.store.transition(f.workspace.id, ["running"], "stopping");
    expect(await check().check(current, "dial")).toBe("stale");
    expect((await workspace()).state).toBe("stopping");
    expect(await stops()).toEqual([]);
  });

  it("wakes automatically at most twice an hour, then keeps the messages for an explicit wake", async () => {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_v2_provider_stops (workspace_id,sandbox_id,worker_boot_id,stop_generation,trigger,mode,provider_state,rewake,outcome)
      SELECT $1,'bx_fixture1234',gen_random_uuid(),0,'dial','on','archived',true,'rewake' FROM generate_series(1,2)`, [f.workspace.id]));
    const waiting = f.prompt();
    expect((await f.send(waiting)).status).toBe(201);
    expect(await check().check(await binding(), "dial")).toBe("capped");
    expect(await prompts()).toEqual({ [waiting.userMessageId]: { state: "queued", wake: false } });
    await f.cp.store.prompts.wakePending();
    expect((await workspace()).state).toBe("stopped");
  });

  it("asks Boat about one boot at most once per backoff step", async () => {
    const inspect = vi.fn(async () => ({ state: "running" }));
    let now = 0;
    const throttled = new ProviderStopCheck({ mode: "on", store: f.cp.store, compute: { inspect }, now: () => now, schedule: () => {}, wait: async () => {} });
    const current = await binding();
    await throttled.check(current, "dial"); await throttled.check(current, "dial");
    expect(inspect).toHaveBeenCalledTimes(1);
    now += 15_000; await throttled.check(current, "dial");
    now += 15_000; await throttled.check(current, "dial");
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("finds running workspaces whose messages do not move, from the database alone", async () => {
    const waiting = f.prompt();
    expect((await f.send(waiting)).status).toBe(201);
    expect(await f.cp.store.providerStopSuspects()).toEqual([]);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_prompt_outbox SET updated_at=clock_timestamp()-interval '2 minutes',lease_until=NULL
      WHERE workspace_id=$1`, [f.workspace.id]));
    expect(await f.cp.store.providerStopSuspects()).toEqual([await binding()]);
  });

  it("refuses Boat's answer when it predates our resume or our worker was active after it", async () => {
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET lease_renewed_at=clock_timestamp() WHERE id=$1", [f.workspace.id]));
    expect(await check({ state: "archived", stoppedAt: new Date(Date.now() - 86_400_000) }).check(await binding(), "dial")).toBe("contradicted");
    expect(await check({ state: "archived", stoppedAt: null }).check(await binding(), "suspect")).toBe("contradicted");
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET lease_renewed_at=NULL,active_at=clock_timestamp() WHERE id=$1", [f.workspace.id]));
    expect(await check({ state: "archived", stoppedAt: new Date(Date.now() - 60_000) }).check(await binding(), "wake_check")).toBe("contradicted");
    expect((await workspace()).state).toBe("running");
    expect((await stops()).map(row => row.outcome)).toEqual(["contradicted"]);
  });

  it("does nothing unless a second read a few seconds later agrees", async () => {
    const answers = [archived(), { state: "running" }];
    const inspect = vi.fn(async () => answers.shift()!);
    const confirming = new ProviderStopCheck({ mode: "on", store: f.cp.store, compute: { inspect }, schedule: () => {}, wait: async () => {} });
    expect(await confirming.check(await binding(), "dial")).toBe("unknown");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect((await workspace()).state).toBe("running");
  });

  it("holds back stops while many are happening across workspaces", async () => {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_v2_provider_stops (workspace_id,sandbox_id,worker_boot_id,stop_generation,trigger,mode,provider_state,outcome)
      SELECT $1,'bx_fixture1234',gen_random_uuid(),0,'dial','on','archived','stopped' FROM generate_series(1,20)`, [f.workspace.id]));
    expect(await check().check(await binding(), "dial")).toBe("braked");
    expect((await workspace()).state).toBe("running");
  });

  it("re-checks an archiving VM a bounded number of times", async () => {
    const inspect = vi.fn(async () => ({ state: "archiving" }));
    const scheduled: (() => void)[] = [];
    const bounded = new ProviderStopCheck({ mode: "on", store: f.cp.store, compute: { inspect }, schedule: run => { scheduled.push(run); }, wait: async () => {} });
    await bounded.check(await binding(), "dial");
    for (let index = 0; index < 20 && scheduled.length; index += 1) { scheduled.shift()!(); await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(inspect.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("does not suspect a follow-up that waits behind a running turn", async () => {
    await f.dispatch(f.prompt());
    expect((await f.send(f.prompt())).status).toBe(201);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_prompt_outbox SET updated_at=clock_timestamp()-interval '10 minutes' WHERE workspace_id=$1`, [f.workspace.id]));
    expect(await f.cp.store.providerStopSuspects()).toEqual([]);
  });

  it("wakes only for messages whose sender still has access", async () => {
    await f.login(f.viewer);
    const removed = f.prompt(randomUUID(), { chatId: "viewer" }), kept = f.prompt(randomUUID(), { chatId: "creator" });
    expect((await f.send(removed, f.viewer)).status).toBe(201);
    expect((await f.send(kept, f.creator)).status).toBe(201);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    const current = await binding();
    if (current.bootId === null) return;
    expect(await check().check(current, "dial")).toBe("rewake");
    const rows = await prompts();
    expect(rows[kept.userMessageId]).toEqual({ state: "queued", wake: true });
    expect(rows[removed.userMessageId]?.wake ?? false).toBe(false);
    await f.cp.store.prompts.wakePending();
    expect((await pool.query("SELECT state,execution_initiator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ state: "starting", execution_initiator_user_id: f.creator.id });
  });
});
