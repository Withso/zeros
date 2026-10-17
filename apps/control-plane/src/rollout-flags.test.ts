import { describe, expect, it, vi } from "vitest";
import { ROLLOUT_FLAGS, ROLLOUT_FLAGS_OFF, RolloutFlagSnapshot, flagEffective, isRolloutFlagName } from "./rollout-flags.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Handlers = { onNotification: () => void; onReady: () => void; onUnavailable: () => void };

function harness(initial: Array<{ org_id: string; flag: string }> = []) {
  let rows = initial;
  let handlers!: Handlers;
  const pending: Array<{ resolve: () => void; rows: typeof rows }> = [];
  let manual = false;
  const load = vi.fn(async () => {
    if (!manual) return rows;
    const snapshot = rows;
    await new Promise<void>(resolve => pending.push({ resolve, rows: snapshot }));
    return snapshot;
  });
  const subscription = { start: vi.fn(async () => {}), healthy: vi.fn(() => true), stop: vi.fn(async () => {}) };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const snapshot = new RolloutFlagSnapshot({
    load, logger, refreshMs: 3_600_000,
    // Test-fast knobs; production defaults are 1–30 s backoff and 2 s staleness.
    retryDelaysMs: [20, 40, 80], hintedReloadStaleMs: 25,
    subscribe: value => { handlers = value; return subscription; },
  });
  return {
    snapshot, load, logger, subscription,
    get handlers() { return handlers; },
    set rows(value: typeof rows) { rows = value; },
    hold() { manual = true; },
    release() { const next = pending.shift(); next?.resolve(); return next; },
  };
}

describe("rollout flag snapshot", () => {
  it("registers the initial flags and defaults every organization to off", async () => {
    expect(Object.keys(ROLLOUT_FLAGS).sort()).toEqual([
      "authority_cache_enforce", "authority_cache_shadow", "capabilities", "credential_push",
      "device_stream", "presence_in_memory", "realtime_uplink", "relay_over_uplink", "runtime_connect",
    ]);
    expect(isRolloutFlagName("capabilities")).toBe(true);
    expect(isRolloutFlagName("toString")).toBe(false);
    expect(ROLLOUT_FLAGS_OFF.enabled(ORG, "capabilities")).toBe(false);
    const h = harness();
    await h.snapshot.start();
    h.handlers.onReady();
    await h.snapshot.reload();
    for (const flag of Object.keys(ROLLOUT_FLAGS)) expect(h.snapshot.enabled(ORG, flag as never)).toBe(false);
    await h.snapshot.stop();
  });

  it("applies enabled rows per organization, ignores unknown names and reloads on a hint", async () => {
    const h = harness([{ org_id: ORG, flag: "capabilities" }, { org_id: ORG, flag: "from_another_branch" }]);
    await h.snapshot.start();
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(true);
    expect(h.snapshot.enabled(OTHER, "capabilities")).toBe(false);
    const changed = vi.fn();
    h.snapshot.onChange(changed);
    h.rows = [{ org_id: OTHER, flag: "capabilities" }];
    h.handlers.onNotification();
    await vi.waitFor(() => expect(h.snapshot.enabled(OTHER, "capabilities")).toBe(true));
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(false);
    expect(changed).toHaveBeenCalled();
    await h.snapshot.stop();
  });

  it("forces relaxing flags off until a reload follows a live LISTEN session", async () => {
    const h = harness([{ org_id: ORG, flag: "authority_cache_enforce" }, { org_id: ORG, flag: "authority_cache_shadow" }]);
    await h.snapshot.start();
    // Loaded, but not yet listening: a change could be missed.
    expect(h.snapshot.feedCurrent()).toBe(false);
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    expect(h.snapshot.enabled(ORG, "authority_cache_shadow")).toBe(true);
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.feedCurrent()).toBe(true));
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true);
    h.handlers.onUnavailable();
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    expect(h.snapshot.enabled(ORG, "authority_cache_shadow")).toBe(true);
    // A safety refresh while the listener is down does not restore it.
    await h.snapshot.reload();
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true));
    await h.snapshot.stop();
  });

  it("never lets a reload that started before a hint be the last one applied", async () => {
    const h = harness([{ org_id: ORG, flag: "capabilities" }]);
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.feedCurrent()).toBe(true));
    h.hold();
    const first = h.snapshot.reload();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(3));
    // The operator disables the flag after the in-flight read took its snapshot.
    h.rows = [];
    h.handlers.onNotification();
    h.release();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(4));
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(true);
    h.release();
    await first;
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(false);
    await h.snapshot.stop();
  });

  it("keeps retained values but drops relaxing flags when a reload fails, without logging the error", async () => {
    const h = harness([{ org_id: ORG, flag: "capabilities" }, { org_id: ORG, flag: "authority_cache_enforce" }]);
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true));
    h.load.mockRejectedValueOnce(new Error("password=hunter2 connection refused"));
    await h.snapshot.reload();
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(true);
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain("hunter2");
    await h.snapshot.reload();
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true);
    await h.snapshot.stop();
  });

  it("bounds the rows it applies", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ org_id: `0000000${index}-0000-4000-8000-000000000000`, flag: "capabilities" }));
    const logger = { warn: vi.fn(), info: vi.fn() };
    const load = vi.fn(async (limit: number) => rows.slice(0, limit));
    const snapshot = new RolloutFlagSnapshot({
      load, logger, maxRows: 2,
      subscribe: () => ({ start: async () => {}, healthy: () => true, stop: async () => {} }),
    });
    await snapshot.start();
    expect(load).toHaveBeenCalledWith(3);
    expect(snapshot.enabled(rows[1]!.org_id, "capabilities")).toBe(true);
    expect(snapshot.enabled(rows[2]!.org_id, "capabilities")).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    await snapshot.stop();
  });

  it("reads the same flag for any org id casing (review SHOULD-3)", async () => {
    const letters = "aaaaaaaa-1111-4111-8111-111111111111";
    const h = harness([{ org_id: letters, flag: "capabilities" }]);
    await h.snapshot.start();
    expect(h.snapshot.enabled(letters.toUpperCase(), "capabilities")).toBe(true);
    expect(h.snapshot.enabled(letters, "capabilities")).toBe(true);
    await h.snapshot.stop();
  });

  it("retries a failed reload with backoff instead of waiting for the safety refresh (review SHOULD-1)", async () => {
    const h = harness([{ org_id: ORG, flag: "authority_cache_enforce" }]);
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true));
    // Record the current mark at every emission: the failed reload drops it
    // and the backoff retry, not the 60 s safety refresh, restores it.
    const seen: boolean[] = [];
    h.snapshot.onChange(() => seen.push(h.snapshot.feedCurrent()));
    h.load.mockRejectedValueOnce(new Error("pool saturated"));
    h.handlers.onNotification();
    const calls = h.load.mock.calls.length;
    await vi.waitFor(() => {
      expect(h.load.mock.calls.length).toBeGreaterThan(calls);
      expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true);
    }, { timeout: 2_000 });
    expect(seen).toContain(false);
    expect(seen[seen.length - 1]).toBe(true);
    await h.snapshot.stop();
  });

  it("drops the current mark when a hinted reload stays pending (review SHOULD-2)", async () => {
    const h = harness([{ org_id: ORG, flag: "authority_cache_enforce" }, { org_id: ORG, flag: "capabilities" }]);
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true));
    h.hold();
    const pending = h.snapshot.reload();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(3));
    h.handlers.onNotification();
    // The disable hint is still waiting on a hung load past the stale
    // deadline: relaxing flags drop off, retained flags keep their value.
    await vi.waitFor(() => expect(h.snapshot.feedCurrent()).toBe(false), { timeout: 2_000 });
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(true);
    h.release();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(4));
    h.release();
    await pending;
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true);
    await h.snapshot.stop();
  });

  it("never applies a read that a hint invalidated while it ran", async () => {
    const h = harness([]); // the flag is off; the hung read will capture an enable
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.feedCurrent()).toBe(true));
    h.rows = [{ org_id: ORG, flag: "capabilities" }];
    h.hold();
    const pending = h.snapshot.reload(); // this read sees the enable…
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(3));
    h.rows = []; // …but the disable commits while it is in flight
    h.handlers.onNotification();
    h.release();
    // The pre-hint read is discarded instead of applied: the flag never
    // flips on. The follow-up load (still manual) reads the disable.
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(4));
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(false);
    h.release();
    await pending;
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(false);
    await h.snapshot.stop();
  });

  it("does not count unknown flag names against the row bound (review NIT-5)", async () => {
    const rows = [
      { org_id: "00000000-0000-4000-8000-000000000001", flag: "zz_future" },
      { org_id: "00000000-0000-4000-8000-000000000002", flag: "zz_future" },
      { org_id: ORG, flag: "capabilities" },
    ];
    const logger = { warn: vi.fn(), info: vi.fn() };
    const load = vi.fn(async () => rows);
    const snapshot = new RolloutFlagSnapshot({
      load, logger, maxRows: 2,
      subscribe: () => ({ start: async () => {}, healthy: () => true, stop: async () => {} }),
    });
    await snapshot.start();
    expect(snapshot.enabled(ORG, "capabilities")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    await snapshot.stop();
  });

  // C's advertisement and admission check only realtime_uplink; without the
  // dependency an engine dials and fails at auth.sync (review SHOULD-3).
  it("reads realtime_uplink off until capabilities is on for the same org (review SHOULD-3)", async () => {
    const h = harness([{ org_id: ORG, flag: "realtime_uplink" }]);
    await h.snapshot.start();
    expect(h.snapshot.enabled(ORG, "realtime_uplink")).toBe(false);
    expect(h.snapshot.anyEnabled("realtime_uplink")).toBe(false);
    h.rows = [{ org_id: ORG, flag: "realtime_uplink" }, { org_id: ORG, flag: "capabilities" }];
    await h.snapshot.reload();
    expect(h.snapshot.enabled(ORG, "realtime_uplink")).toBe(true);
    expect(h.snapshot.anyEnabled("realtime_uplink")).toBe(true);
    // A second org with only the dependency still reads off.
    expect(h.snapshot.enabled("22222222-2222-4222-8222-222222222222", "realtime_uplink")).toBe(false);
    await h.snapshot.stop();
  });

  it("reads all-off after stop, including retained flags (review NIT-11)", async () => {
    const h = harness([{ org_id: ORG, flag: "capabilities" }, { org_id: ORG, flag: "authority_cache_enforce" }]);
    await h.snapshot.start();
    h.handlers.onReady();
    await vi.waitFor(() => expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(true));
    await h.snapshot.stop();
    expect(h.snapshot.enabled(ORG, "capabilities")).toBe(false);
    expect(h.snapshot.enabled(ORG, "authority_cache_enforce")).toBe(false);
    expect(h.snapshot.feedCurrent()).toBe(false);
  });
});

describe("flagEffective", () => {
  const definitions = {
    base: { whileFeedUnavailable: "off", summary: "Dependency that turns off on feed loss" },
    dependent: { whileFeedUnavailable: "retain", summary: "Retained flag that requires base", requires: ["base"] },
  } as const;
  it("turns a retained flag off with a dependency whose feed-loss state is off", () => {
    const set = new Set(["base", "dependent"]);
    expect(flagEffective(set, "dependent", true, definitions)).toBe(true);
    expect(flagEffective(set, "dependent", false, definitions)).toBe(false);
    expect(flagEffective(new Set(["dependent"]), "dependent", true, definitions)).toBe(false);
  });
});
