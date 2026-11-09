import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { WorkerCodeReview } from "../workspace/code-review";
import { CLIENT_A, FakeRelay, config } from "./worker-fixtures";

// On Alpha a Withso/zeros worker switched branches (0.97 s), then opened its
// review database (0.63 s). Both live outside the checkout, so they overlap.
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const files = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true }).catch(() => [])).map(String);

it("opens the session store and review database while Git switches branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-overlap-")); directories.push(directory);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: () => held, drivers: {} });
  try {
    worker.start();
    const configured = relay.receive({ ...config, agents: {}, codeReview: { userId: "33333333-3333-4333-8333-333333333333" } });
    await vi.waitFor(async () => expect((await files(directory)).some(name => name.endsWith("review.sqlite"))).toBe(true));
    expect((await files(directory)).some(name => name.startsWith("sessions"))).toBe(true);
    release(); await configured;
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await vi.waitFor(() => expect(relay.frames.some(frame => frame.t === "frame" && (frame.frame as { type?: string }).type === "ENGINE_READY")).toBe(true));
  } finally { release(); await worker.dispose(); }
});

it("still closes what it opened beside a checkout that fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-overlap-fail-")); directories.push(directory);
  const flush = vi.spyOn(SessionStore.prototype, "flush"), close = vi.spyOn(WorkerCodeReview.prototype, "close");
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory, transport: relay, drivers: {},
    prepareCheckout: async () => { await new Promise(resolve => setTimeout(resolve, 50)); throw new Error("checkout failed"); } });
  try {
    worker.start();
    await relay.receive({ ...config, agents: {}, codeReview: { userId: "33333333-3333-4333-8333-333333333333" } }).catch(() => undefined);
    await vi.waitFor(() => { expect(flush).toHaveBeenCalled(); expect(close).toHaveBeenCalled(); });
  } finally { await worker.dispose(); }
});
