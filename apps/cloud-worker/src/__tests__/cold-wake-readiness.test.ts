import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import type { SessionStore } from "../sessions/session-store";
import { CLIENT_A, FakeRelay, config } from "./worker-fixtures";

// Dev-VM live gate (inherited): after a cold wake under 40 ms/query, worker_configure took 59-60 s because its closing
// idle report awaited the full history backfill, and the first client's ENGINE_READY waited on configure, so the
// app's handshake closed 1013. Readiness must not wait for the backfill; the backfill still completes.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** History frames are held until released, as a slow control-plane ingest would hold them. */
class SlowHistoryRelay extends FakeRelay {
  held: Array<() => void> = [];
  history = 0;
  override async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    if (frame.t === "history") {
      await new Promise<void>(resolve => this.held.push(resolve));
      this.history++;
    }
    return super.send(frame);
  }
  release(): void { for (const resolve of this.held.splice(0)) resolve(); }
}

it("a cold wake sends the first client ENGINE_READY without waiting for the history backfill, which then completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-cold-wake-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configured = { ...config, historyReplacement: 1 };
  // A previous boot left chats with history on disk.
  const first = new CloudWorker({ directory, homeDirectory: directory, transport: new FakeRelay(), prepareCheckout: async () => {}, drivers: {} });
  const firstRelay = (first as unknown as { options: { transport: FakeRelay } }).options.transport;
  first.start(); await firstRelay.receive(configured);
  const store = (first as unknown as { store: SessionStore }).store;
  for (let i = 0; i < 5; i++) await store.upsert({ id: `chat-${i}`, folder: config.workspace.checkoutPath, agentId: "codex", createdAt: 1 + i });
  await first.dispose();

  const relay = new SlowHistoryRelay();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: {} });
  cleanups.push(async () => { const releasing = setInterval(() => relay.release(), 5); try { await worker.dispose(); } finally { clearInterval(releasing); } });
  worker.start();
  void relay.receive(configured);
  await expect.poll(() => relay.held.length, { timeout: 3_000 }).toBeGreaterThan(0);
  const opened = Date.now();
  void relay.receive({ t: "open", clientId: CLIENT_A });
  await expect.poll(() => relay.frames.some(frame => frame.t === "frame" && (frame.frame as { type?: string }).type === "ENGINE_READY"), { timeout: 3_000 }).toBe(true);
  expect(Date.now() - opened).toBeLessThan(2_000);
  expect(relay.history).toBe(0);
  // The backfill continues in the background once the control plane answers, and the idle report follows it.
  for (let i = 0; i < 50 && (relay.history < 5 || relay.held.length); i++) { relay.release(); await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(relay.history).toBeGreaterThanOrEqual(5);
  await expect.poll(() => relay.frames.some(frame => frame.t === "idle")).toBe(true);
}, 15_000);
