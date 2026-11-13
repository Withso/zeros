import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
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

async function seeded(chats = 5) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-cold-wake-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const relay = new FakeRelay();
  const first = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: {} });
  first.start(); await relay.receive({ ...config, historyReplacement: 1 });
  const store = (first as unknown as { store: SessionStore }).store;
  for (let i = 0; i < chats; i++) await store.upsert({ id: `chat-${i}`, folder: config.workspace.checkoutPath, agentId: "codex", createdAt: 1 + i });
  await first.dispose();
  return directory;
}
const historyChats = (relay: FakeRelay) => relay.frames.filter(frame => frame.t === "history" && frame.chats).flatMap(frame => (frame as { chats: Array<{ id: string }> }).chats.map(chat => chat.id));

it("a reconfigure during the background backfill neither starts a second backfill nor reports idle early", async () => {
  const directory = await seeded();
  const relay = new SlowHistoryRelay();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: {} });
  cleanups.push(async () => { const releasing = setInterval(() => relay.release(), 5); try { await worker.dispose(); } finally { clearInterval(releasing); } });
  worker.start();
  void relay.receive({ ...config, historyReplacement: 1 });
  await expect.poll(() => relay.held.length, { timeout: 3_000 }).toBeGreaterThan(0);
  // A new login revision reconfigures while the first backfill is still held: configure returns, nothing re-sends.
  const started = Date.now();
  await relay.receive({ ...config, historyReplacement: 1, loginRevision: "1" });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(relay.frames.some(frame => frame.t === "idle")).toBe(false);
  for (let i = 0; i < 100 && (relay.history < 5 || relay.held.length); i++) { relay.release(); await new Promise(resolve => setTimeout(resolve, 10)); }
  await expect.poll(() => relay.frames.some(frame => frame.t === "idle")).toBe(true);
  // Each saved chat was backfilled exactly once.
  const sent = historyChats(relay);
  expect(sent.filter(id => id.startsWith("chat-")).sort()).toEqual(["chat-0", "chat-1", "chat-2", "chat-3", "chat-4"]);
}, 15_000);

it("a storage failure in the background flush surfaces through onError and does not fail later configures", async () => {
  const directory = await seeded(1);
  const relay = new FakeRelay(), errors: string[] = [];
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: {}, onError: code => errors.push(code) });
  cleanups.push(() => worker.dispose());
  const flush = vi.spyOn(SessionStore.prototype, "flush");
  worker.start();
  flush.mockRejectedValueOnce(new Error("disk full"));
  await relay.receive({ ...config, historyReplacement: 1 });
  await expect.poll(() => errors).toContain("storage");
  expect(relay.frames.some(frame => frame.t === "idle")).toBe(false);
  // The next configuration applies normally and its idle report goes through.
  await relay.receive({ ...config, historyReplacement: 1, loginRevision: "1" });
  await expect.poll(() => relay.frames.some(frame => frame.t === "idle")).toBe(true);
  await relay.receive({ t: "open", clientId: CLIENT_A });
  await expect.poll(() => relay.frames.some(frame => frame.t === "frame" && (frame.frame as { type?: string }).type === "ENGINE_READY")).toBe(true);
  flush.mockRestore();
}, 15_000);
