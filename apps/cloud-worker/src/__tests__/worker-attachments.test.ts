import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

const workers: CloudWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose();
  vi.restoreAllMocks();
});
async function fixture() {
  const files = await repositoryFixture();
  const relay = new FakeRelay(), intervals = vi.spyOn(globalThis, "setInterval");
  const worker = new CloudWorker({ directory: files.state, transport: relay, prepareCheckout: async () => {}, drivers: {},
    workspaceServices: { watch: false, lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) } });
  workers.push(worker);
  worker.start();
  const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 55_000)![0] as () => void;
  await relay.receive({ ...config, workspace: files.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const params = { attachmentId: "large", filename: "clip.mp4", mimeType: "video/mp4", uploadId: "upload", totalBytes: 500_000_000, offset: 0, base64: "AQID" };
  async function write(extra: Record<string, unknown> = {}) {
    const request = browserFrame("WORKSPACE_REQUEST", { op: "attachment.write", params: { ...params, ...extra } });
    await relay.request(CLIENT_A, request);
    return relay.response(request.id);
  }
  return { ...files, relay, worker, heartbeat, write };
}

it("keeps a large background upload busy across activity heartbeats and returns idle after abort", async () => {
  const { relay, heartbeat, write } = await fixture();
  expect(await write()).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { pending: true, bytes: 3 } });
  const busy = () => relay.frames.filter(frame => frame.t === "idle" && !frame.idle).length;
  expect(busy()).toBe(1);
  heartbeat();
  await expect.poll(busy).toBe(2);
  await write({ abort: true, base64: "" });
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
});

it("retires private partial files before acknowledging workspace Stop", async () => {
  const { state, root, relay, write } = await fixture();
  expect(await write()).toMatchObject({ type: "WORKSPACE_RESPONSE" });
  expect(await readdir(join(state, "attachment-uploads"))).toHaveLength(1);
  const stop = { t: "stop", id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" };
  await relay.receive(stop);
  expect(relay.frames).toContainEqual({ t: "stop-ack", id: stop.id });
  expect(await readdir(join(state, "attachment-uploads"))).toEqual([]);
  expect(await readdir(root)).not.toContain(".context");
});

it("does not publish idle when another upload starts while persistence drains", async () => {
  const { relay, write } = await fixture();
  await write();
  let release!: () => void, draining = false;
  vi.spyOn(SessionStore.prototype, "flush").mockImplementationOnce(() => {
    draining = true;
    return new Promise<void>(resolve => { release = resolve; });
  });
  const aborting = write({ abort: true, base64: "" });
  await expect.poll(() => draining).toBe(true);
  await write({ uploadId: "second" });
  release();
  await aborting;
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
});
