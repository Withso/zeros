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

  const archived = { state: "archived", stoppedAt: new Date("2026-11-18T12:50:11.033Z") };
  const check = (inspected: { state: string; stoppedAt?: Date | null } | Error = archived, mode: "observe" | "on" = "on") => new ProviderStopCheck({
    mode, store: f.cp.store, schedule: () => {},
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
  const stops = async () => (await pool.query(`SELECT trigger,mode,provider_state,rewake FROM cloud_v2_provider_stops WHERE workspace_id=$1 ORDER BY detected_at`, [f.workspace.id])).rows;

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
    expect(await stops()).toEqual([{ trigger: "dial", mode: "on", provider_state: "archived", rewake: true }]);
    // The existing wake path takes it from here, with the waiting message's sender as the initiator.
    await f.cp.store.prompts.wakePending();
    expect((await workspace()).state).toBe("starting");
  });

  it("keeps a stopped workspace with nothing waiting stopped", async () => {
    expect(await check().check(await binding(), "wake_check")).toBe("stopped");
    expect((await workspace()).state).toBe("stopped");
    expect(await stops()).toEqual([{ trigger: "wake_check", mode: "on", provider_state: "archived", rewake: false }]);
  });

  it("treats a sandbox that is gone like an archived one, and does nothing while Boat says it runs or cannot answer", async () => {
    for (const inspected of [{ state: "running" }, new CloudProviderError("provider_unavailable", "Boat unavailable", true), { state: "archiving" }]) {
      expect(["running", "unknown"]).toContain(await check(inspected).check(await binding(), "dial"));
      expect((await workspace()).state).toBe("running");
    }
    expect(await check(new CloudProviderError("provider_not_found", "gone", false)).check(await binding(), "dial")).toBe("stopped");
    expect(await stops()).toEqual([{ trigger: "dial", mode: "on", provider_state: "missing", rewake: false }]);
  });

  it("only records in observe mode", async () => {
    const before = await workspace();
    expect(await check(archived, "observe").check(await binding(), "suspect")).toBe("observed");
    expect(await workspace()).toEqual(before);
    expect(await stops()).toEqual([{ trigger: "suspect", mode: "observe", provider_state: "archived", rewake: false }]);
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
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_v2_provider_stops (workspace_id,sandbox_id,stop_generation,trigger,mode,provider_state,rewake)
      SELECT $1,'bx_fixture1234',0,'dial','on','archived',true FROM generate_series(1,2)`, [f.workspace.id]));
    const waiting = f.prompt();
    expect((await f.send(waiting)).status).toBe(201);
    expect(await check().check(await binding(), "dial")).toBe("stopped");
    expect(await prompts()).toEqual({ [waiting.userMessageId]: { state: "queued", wake: false } });
    await f.cp.store.prompts.wakePending();
    expect((await workspace()).state).toBe("stopped");
  });

  it("asks Boat about one boot at most once per backoff step", async () => {
    const inspect = vi.fn(async () => ({ state: "running" }));
    let now = 0;
    const throttled = new ProviderStopCheck({ mode: "on", store: f.cp.store, compute: { inspect }, now: () => now, schedule: () => {} });
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
});
