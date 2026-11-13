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
