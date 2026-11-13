import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PUSH_SIGNALS_FEATURE } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { FakeRelay, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

it("R1: advertises push-signals-v1 and switches the transport only while the control plane accepts pushSignals", async () => {
  expect(CLOUD_WORKER_FEATURES.split(",")).toContain(PUSH_SIGNALS_FEATURE);
  const directory = await mkdtemp(join(tmpdir(), "zeros-push-signals-"));
  const relay = Object.assign(new FakeRelay(), { setPushSignals: vi.fn() });
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: {} });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive(config);
  expect(relay.setPushSignals).not.toHaveBeenCalled();
  await relay.receive({ ...config, pushSignals: 1 });
  expect(relay.setPushSignals).toHaveBeenLastCalledWith(true);
  await relay.receive(config);
  expect(relay.setPushSignals).toHaveBeenLastCalledWith(false);
});

it("R1: the FIRST negotiated configuration already gives the prompt inbox the 60 s long poll and the runtime updater its 15 min check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-push-signals-first-"));
  const waits: number[] = [];
  const relay = Object.assign(new FakeRelay(), {
    setPushSignals: vi.fn(),
    promptRequest: vi.fn(async (op: string, body: unknown, signal?: AbortSignal) => {
      if (op !== "pull") return { ok: true };
      const waitMs = (body as { waitMs: number }).waitMs; waits.push(waitMs);
      if (waitMs === 0) return { prompts: [], stops: [] };
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }),
    runtimeUpdate: vi.fn(async () => ({ status: "current" as const })),
  });
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: {},
    runtimePermit: { arm: () => {}, revoke: () => {} } as never });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive({ ...config, pushSignals: 1, promptOutbox: 1, runtimeUpdate: 1 });
  await vi.waitFor(() => expect(waits.filter(wait => wait > 0)).toHaveLength(1));
  expect(waits.filter(wait => wait > 0)).toEqual([60_000]);
  expect((worker as unknown as { runtimeUpdater: { checkMs: number } }).runtimeUpdater.checkMs).toBe(15 * 60_000);
});

it("R1 N−1: an older control plane that refuses the 60 s pull (400) gets 25 s pulls for a bounded time, with no other downgrade", async () => {
  const { PromptInbox, PUSH_POLL_FALLBACK_MS } = await import("../prompt-inbox");
  const waits: number[] = [];
  let refuse = true;
  const store = { onChange: () => () => {}, outboxEntries: () => [] } as never;
  const agents = { setOutboxDispatch: () => {} } as never;
  const inbox = new PromptInbox(store, agents, async (op, body, signal) => {
    if (op !== "pull") return {};
    const waitMs = (body as { waitMs: number }).waitMs; waits.push(waitMs);
    if (waitMs > 25_000 && refuse) throw Object.assign(new Error("invalid_request"), { status: 400 });
    if (waitMs === 0) return { prompts: [], stops: [] };
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    inbox.pushSignals = true;
    inbox.start();
    // The immediate first pull, one refused 60 s pull, then 25 s pulls (no hot loop, no authority change).
    await vi.waitFor(() => expect(waits.slice(0, 3)).toEqual([0, 60_000, 25_000]), { timeout: 5_000 });
    expect(PUSH_POLL_FALLBACK_MS).toBe(15 * 60_000);
    refuse = false;
    inbox.hint();
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(5));
    expect(waits.filter(wait => wait > 0).at(-1)).toBe(25_000);
    // After the bound it offers 60 s again; a control plane that accepts it keeps it.
    vi.setSystemTime(Date.now() + PUSH_POLL_FALLBACK_MS + 1);
    const before = waits.length;
    inbox.hint();
    await vi.waitFor(() => expect(waits.slice(before).filter(wait => wait > 0)).toContain(60_000));
    expect(inbox.pushSignals).toBe(true);
  } finally { await inbox.dispose(); vi.useRealTimers(); }
});

it("R1 live gate: the first configuration completes within seconds while a negotiated 60 s pull is held open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-push-signals-held-"));
  let held = 0;
  const relay = Object.assign(new FakeRelay(), {
    setPushSignals: vi.fn(),
    promptRequest: vi.fn(async (op: string, body: unknown, signal?: AbortSignal) => {
      if (op !== "pull") return { ok: true };
      if ((body as { waitMs: number }).waitMs === 0) return { prompts: [], stops: [] };
      held++;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }),
    runtimeUpdate: vi.fn(async () => ({ status: "current" as const })),
  });
  const timings: string[] = [];
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: {},
    runtimePermit: { arm: () => {}, revoke: () => {} } as never, onTiming: record => { timings.push(JSON.stringify(record)); } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  const started = Date.now();
  await relay.receive({ ...config, pushSignals: 1, promptOutbox: 1, runtimeUpdate: 1 });
  expect(Date.now() - started).toBeLessThan(5_000);
  // A second configuration (the relay's dial carries one) is not queued behind the held pull either.
  await vi.waitFor(() => expect(held).toBe(1));
  const again = Date.now();
  await relay.receive({ ...config, pushSignals: 1, promptOutbox: 1, runtimeUpdate: 1, loginRevision: "1" });
  expect(Date.now() - again).toBeLessThan(5_000);
}, 15_000);
