import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLOUD_WORKSPACE_RESOURCES_WATCH_CAPABILITY } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { CLIENT_A, CLIENT_B, FakeRelay, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-resources-watch-"));
  let samples = 0;
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: {}, resourcesPushMs: 20,
    workspaceServices: { watch: false, resources: { sample: async () => ({ cpu: { percent: ++samples }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 } }) as never } } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive(config);
  await relay.receive({ t: "open", clientId: CLIENT_A });
  await relay.receive({ t: "open", clientId: CLIENT_B });
  const pushes = (clientId: string) => relay.bridge("WORKSPACE_RESOURCES").filter(entry => entry.clientId === clientId);
  return { relay, pushes };
}

it("R1: a watching client gets the first sample as the reply, then pushed samples; watch:false and close stop them", async () => {
  const f = await setup();
  const ready = f.relay.bridge("ENGINE_READY").find(entry => entry.clientId === CLIENT_A)!.frame as { capabilities?: string[] };
  expect(ready.capabilities).toContain(CLOUD_WORKSPACE_RESOURCES_WATCH_CAPABILITY);
  const watch = browserFrame("WORKSPACE_REQUEST", { op: "workspace.resources", params: { watch: true } });
  await f.relay.request(CLIENT_A, watch);
  expect(f.relay.response(watch.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: { cpu: { percent: 1 } } });
  await until(() => f.pushes(CLIENT_A).length >= 2);
  expect(f.pushes(CLIENT_A)[0]!.frame).toMatchObject({ type: "WORKSPACE_RESOURCES", result: { cpu: { percent: expect.any(Number) } } });
  expect(f.pushes(CLIENT_B)).toHaveLength(0);
  const stop = browserFrame("WORKSPACE_REQUEST", { op: "workspace.resources", params: { watch: false } });
  await f.relay.request(CLIENT_A, stop);
  const stopped = f.pushes(CLIENT_A).length;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.pushes(CLIENT_A)).toHaveLength(stopped);
  await f.relay.request(CLIENT_B, browserFrame("WORKSPACE_REQUEST", { op: "workspace.resources", params: { watch: true } }));
  await until(() => f.pushes(CLIENT_B).length >= 1);
  await f.relay.receive({ t: "close", clientId: CLIENT_B });
  const closed = f.pushes(CLIENT_B).length;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.pushes(CLIENT_B)).toHaveLength(closed);
});

it("R1: an ordinary resources request (no watch) is answered once and starts nothing", async () => {
  const f = await setup();
  const once = browserFrame("WORKSPACE_REQUEST", { op: "workspace.resources", params: {} });
  await f.relay.request(CLIENT_A, once);
  expect(f.relay.response(once.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", op: "workspace.resources" });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.pushes(CLIENT_A)).toHaveLength(0);
});
