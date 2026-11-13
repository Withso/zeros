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
