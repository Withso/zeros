import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { commandRunner, type CommandRunner } from "../workspace/commands";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

const workers: CloudWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(wrap?: (run: CommandRunner) => CommandRunner) {
  const files = await repositoryFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
  const relay = new FakeRelay(), intervals = vi.spyOn(globalThis, "setInterval");
  const worker = new CloudWorker({ directory: files.state, transport: relay, prepareCheckout: async () => {}, drivers: {},
    workspaceServices: { watch: false, run: wrap?.(commandRunner(files.root)), lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) } });
  workers.push(worker);
  worker.start();
  const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 55_000)![0] as () => void;
  await relay.receive({ ...config, workspace: files.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const idle = () => relay.frames.filter(frame => frame.t === "idle").at(-1);
  async function op(op: string, params: Record<string, unknown> = {}) {
    const request = browserFrame("WORKSPACE_REQUEST", { op, params });
    await relay.request(CLIENT_A, request);
    return relay.response(request.id);
  }
  expect(idle()).toEqual({ t: "idle", idle: true });
  return { ...files, relay, worker, heartbeat, idle, op };
}

it("reports a Files save as activity before returning the successful write", async () => {
  const { root, op, idle } = await fixture();
  expect(await op("file.write", { path: "readme.txt", content: "saved draft\n" }))
    .toMatchObject({ type: "WORKSPACE_RESPONSE", result: { kind: "success" } });
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe("saved draft\n");
  expect(idle()).toEqual({ t: "idle", idle: false });
});

it.each([
  ["git.stage", { paths: ["readme.txt"] }],
  ["git.changeTarget", { newTarget: "main" }],
] as const)("reports explicit %s mutations, including metadata-only work", async (operation, params) => {
  const { op, idle } = await fixture();
  expect(await op(operation, params)).toMatchObject({ type: "WORKSPACE_RESPONSE" });
  expect(idle()).toEqual({ t: "idle", idle: false });
});

it("expires mutation activity after ten minutes and never extends it for passive reads or polls", async () => {
  const { op, relay, heartbeat, idle } = await fixture();
  await op("file.write", { path: "readme.txt", content: "saved\n" });
  expect(idle()).toEqual({ t: "idle", idle: false });
  vi.setSystemTime(new Date("2026-11-03T00:09:59Z"));
  heartbeat();
  await expect.poll(() => relay.frames.filter(frame => frame.t === "idle" && !frame.idle).length).toBe(2);
  await op("file.read", { path: "readme.txt" });
  await op("git.status");
  await op("workspace.get");
  await relay.request(CLIENT_A, browserFrame("PTY_LIST"));
  vi.setSystemTime(new Date("2026-11-03T00:10:00Z"));
  heartbeat();
  await expect.poll(idle).toEqual({ t: "idle", idle: true });
  const reports = relay.frames.filter(frame => frame.t === "idle").length;
  await op("file.read", { path: "readme.txt" });
  await op("git.status");
  heartbeat();
  expect(relay.frames.filter(frame => frame.t === "idle")).toHaveLength(reports);
});

it("keeps an in-flight Git mutation busy past ten minutes, then bounds activity from completion", async () => {
  let release!: () => void, entered = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const { op, heartbeat, idle } = await fixture(run => async (program, args, options) => {
    if (program === "git" && args[0] === "add") { entered = true; await hold; }
    return run(program, args, options);
  });
  const writing = op("git.stage", { paths: ["readme.txt"] });
  try {
    await expect.poll(() => entered).toBe(true);
    expect(idle()).toEqual({ t: "idle", idle: false });
    vi.setSystemTime(new Date("2026-11-03T00:11:00Z"));
    heartbeat();
    expect(idle()).toEqual({ t: "idle", idle: false });
  } finally { release(); await writing; }
  vi.setSystemTime(new Date("2026-11-03T00:21:00Z"));
  heartbeat();
  await expect.poll(idle).toEqual({ t: "idle", idle: true });
});

it("does not publish idle if a new file save arrives while history is flushing", async () => {
  const { op, heartbeat, idle } = await fixture();
  await op("file.write", { path: "readme.txt", content: "first\n" });
  expect(idle()).toEqual({ t: "idle", idle: false });
  let release!: () => void, entered = false;
  vi.spyOn(SessionStore.prototype, "flush").mockImplementationOnce(() => {
    entered = true;
    return new Promise<void>(resolve => { release = resolve; });
  });
  vi.setSystemTime(new Date("2026-11-03T00:10:00Z"));
  heartbeat();
  await expect.poll(() => entered).toBe(true);
  try { await op("file.write", { path: "readme.txt", content: "second\n" }); }
  finally { release(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(idle()).toEqual({ t: "idle", idle: false });
});
