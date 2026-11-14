import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudExecutionContexts } from "./store.js";
import { CloudExecutionMaintenance } from "./maintenance.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(delays: Array<number | null> = []) {
  const query = vi.fn(async (text: string) => ({ rows: text.includes(" AS delay ") ? [{ delay: delays.shift() ?? null }] : [], rowCount: 0 }));
  const client = { query, release: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  return { query, maintenance: new CloudExecutionMaintenance({ pool } as unknown as CloudExecutionContexts) };
}

it("makes no execution maintenance queries between sixty-second fallbacks when no context is active", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const { query, maintenance } = fixture(), stop = maintenance.start(vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(0);
    const initial = query.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).toHaveBeenCalledTimes(initial);
    await vi.advanceTimersByTimeAsync(1);
    expect(query.mock.calls.length).toBeGreaterThan(initial);
  } finally { await stop(); }
});

it("still reconciles the next context deadline before the fallback", async () => {
  const { query, maintenance } = fixture([250]), stop = maintenance.start(vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(0);
    const initial = query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(249);
    expect(query).toHaveBeenCalledTimes(initial);
    await vi.advanceTimersByTimeAsync(1);
    expect(query.mock.calls.length).toBeGreaterThan(initial);
  } finally { await stop(); }
});

it("does not leave maintenance queries scheduled after shutdown", async () => {
  const { query, maintenance } = fixture(), stop = maintenance.start(vi.fn());
  await vi.advanceTimersByTimeAsync(0); await stop();
  const initial = query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(query).toHaveBeenCalledTimes(initial);
});
