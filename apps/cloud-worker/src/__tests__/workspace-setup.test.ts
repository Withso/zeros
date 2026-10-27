import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import type { SetupRunner } from "../workspace/setup";
import type { CheckoutResult } from "../workspace/checkout";
import type { WorkspaceServiceOptions } from "../workspace/service";
import { CLIENT_A, WORKSPACE_ID, FakeRelay, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function fixture(runner: SetupRunner, options: {
  directory?: string; createdBranch?: boolean; setup?: string; restored?: boolean; refresh?: CheckoutResult["refresh"]; services?: WorkspaceServiceOptions;
} = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "zeros-workspace-setup-"));
  if (!options.directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  if (options.restored) await writeFile(join(directory, "restored-from-checkpoint"), "");
  const relay = new FakeRelay(), onError = vi.fn();
  const worker = new CloudWorker({ directory, transport: relay, drivers: {}, onError, setupRunner: runner, workspaceServices: options.services,
    prepareCheckout: async () => ({ createdBranch: options.createdBranch ?? true, refresh: options.refresh }) });
  cleanups.push(() => worker.dispose());
  const configuration = { ...config, workspace: { ...config.workspace, setup: options.setup ?? "pnpm install" } };
  const statusPath = join(directory, "workspace-setup", `${WORKSPACE_ID}.json`);
  const status = async () => JSON.parse(await readFile(statusPath, "utf8"));
  worker.start(); await relay.receive(configuration); await relay.receive({ t: "open", clientId: CLIENT_A });
  return { directory, relay, worker, onError, configuration, status, statusPath,
    idle: () => relay.frames.filter(frame => frame.t === "idle").at(-1) };
}

it("runs admitted setup in the checkout without delaying readiness, keeps it busy and bounds its private log", async () => {
  vi.stubEnv("CLOUD_V2_WORKER_TOKEN", "fixture-worker-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-provider-key");
  let finish!: (code: number) => void;
  const completed = new Promise<number>(resolve => { finish = resolve; });
  const runner = vi.fn<SetupRunner>(async (_file, _args, options) => {
    const status = JSON.parse(await readFile(join(dirname(options.env.GH_ZEROS_BROKER_SOCKET!), "workspace-setup", `${WORKSPACE_ID}.json`), "utf8"));
    expect(status.state).toBe("running");
    options.output(Buffer.alloc(300 * 1024, "x")); options.output(Buffer.from("discarded"));
    return completed;
  });
  // The fake can always finish during cleanup, even when an assertion fails.
  const f = await fixture(runner);
  cleanups.push(async () => { finish(0); });
  expect(f.relay.bridge("ENGINE_READY")).toHaveLength(1);
  expect(f.idle()).toEqual({ t: "idle", idle: false });
  await expect.poll(() => runner.mock.calls.length).toBe(1);
  const [file, args, options] = runner.mock.calls[0]!;
  expect(file).toBe("bash"); expect(args).toEqual(["-lc", "pnpm install"]);
  expect(options.cwd).toBe(config.workspace.checkoutPath);
  expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(options.env.GIT_ASKPASS).toBeDefined();
  expect(options.env).not.toHaveProperty("CLOUD_V2_WORKER_TOKEN");
  expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(await f.status()).toMatchObject({ workspaceId: WORKSPACE_ID, state: "running" });
  finish(0);
  await expect.poll(async () => (await f.status()).state).toBe("succeeded");
  await expect.poll(f.idle).toEqual({ t: "idle", idle: true });
  const logPath = join(f.directory, "workspace-setup", `${WORKSPACE_ID}.log`);
  expect((await readFile(logPath)).length).toBe(256 * 1024);
  for (const path of [logPath, f.statusPath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(f.onError).not.toHaveBeenCalled();
});

function heldRefresh(mayFastForward = true) {
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  return { mayFastForward, release, start: vi.fn(() => done), touch: vi.fn(async () => {}), dispose: vi.fn(async () => { release(); await done; }) };
}

it("reports ready while refresh is held, but runs setup after a possible fast-forward settles", async () => {
  const refresh = heldRefresh(), runner = vi.fn<SetupRunner>(async () => 0);
  const f = await fixture(runner, { refresh });
  expect(f.relay.bridge("ENGINE_READY")).toHaveLength(1);
  expect(refresh.start).toHaveBeenCalledOnce();
  await expect.poll(async () => (await f.status()).state).toBe("running");
  expect(runner).not.toHaveBeenCalled();
  expect(f.idle()).toEqual({ t: "idle", idle: false });
  refresh.release();
  await expect.poll(() => runner.mock.calls.length).toBe(1);
  expect(refresh.touch).toHaveBeenCalledOnce();
  await f.relay.receive(f.configuration);
  expect(refresh.start).toHaveBeenCalledOnce();
});

it("starts setup immediately when the checkout cannot be fast-forwarded", async () => {
  const refresh = heldRefresh(false), runner = vi.fn<SetupRunner>(async () => 0);
  const f = await fixture(runner, { refresh });
  await expect.poll(() => runner.mock.calls.length).toBe(1);
  expect(refresh.start).toHaveBeenCalledOnce();
  expect(refresh.touch).toHaveBeenCalledOnce();
  expect(f.relay.bridge("ENGINE_READY")).toHaveLength(1);
});

it.each(["stop", "dispose"] as const)("%s cancels pending refresh without launching deferred setup", async action => {
  const refresh = heldRefresh(), runner = vi.fn<SetupRunner>(async () => 0);
  const f = await fixture(runner, { refresh });
  await expect.poll(async () => (await f.status()).state).toBe("running");
  await (action === "stop" ? f.relay.receive({ t: "stop", id: randomUUID() }) : f.worker.dispose());
  expect(refresh.dispose).toHaveBeenCalledOnce();
  expect(runner).not.toHaveBeenCalled();
  expect((await f.status()).state).toBe("interrupted");
  if (action === "stop") expect(f.relay.frames.some(frame => frame.t === "stop-ack")).toBe(true);
});

it("admits restored-checkpoint setup on an existing branch and removes the marker after admission", async () => {
  const runner = vi.fn<SetupRunner>(async () => 0), f = await fixture(runner, { createdBranch: false, restored: true });
  await expect.poll(() => runner.mock.calls.length).toBe(1);
  await expect(stat(join(f.directory, "restored-from-checkpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  await f.relay.receive(f.configuration);
  await f.worker.dispose();
  // A crash after admission but before marker removal must still not repeat it.
  const next = await fixture(runner, { directory: f.directory, createdBranch: false, restored: true });
  await expect.poll(next.idle).toEqual({ t: "idle", idle: true });
  await expect(stat(join(f.directory, "restored-from-checkpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(runner).toHaveBeenCalledOnce();
});

it("keeps the restore marker when setup could not be durably admitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-restore-setup-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "workspace-setup"), "not a directory");
  const runner = vi.fn<SetupRunner>(async () => 0), f = await fixture(runner, { directory, createdBranch: false, restored: true });
  await expect.poll(() => f.onError.mock.calls.length).toBe(1);
  expect(f.onError).toHaveBeenCalledWith("storage");
  expect(runner).not.toHaveBeenCalled();
  expect((await stat(join(directory, "restored-from-checkpoint"))).isFile()).toBe(true);
});

it.each(["AGENT_PROMPT", "PTY_WRITE", "file.write"])("fences checkout before admitting %s", async operation => {
  const refresh = heldRefresh(), f = await fixture(async () => 0, { refresh, setup: "" });
  await f.relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "git.status", params: {} }));
  await f.relay.request(CLIENT_A, browserFrame("AGENT_LIST_AGENTS"));
  expect(refresh.touch).not.toHaveBeenCalled();
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  refresh.touch.mockImplementation(() => admitted);
  const frame = operation === "file.write" ? browserFrame("WORKSPACE_REQUEST", { op: operation, params: { path: "file.txt", content: "edited" } })
    : operation === "PTY_WRITE" ? browserFrame(operation, { sessionId: "fixture-shell", data: "echo test\n" })
      : browserFrame(operation, { agentId: "codex", sessionId: "fixture-session", prompt: [{ type: "text", text: "test" }] });
  let settled = false;
  const work = f.relay.request(CLIENT_A, frame).then(() => { settled = true; });
  await expect.poll(() => refresh.touch.mock.calls.length).toBe(1);
  expect(settled).toBe(false);
  release(); await work;
});

it.each(["git.stage", "git.changeTarget"])("fences %s while retaining passive Git reads", async op => {
  const refresh = heldRefresh(), run = vi.fn(async () => ({ stdout: "", code: 0 }));
  const f = await fixture(async () => 0, { refresh, setup: "", services: { run, watch: false } });
  await f.relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "git.status", params: {} }));
  expect(refresh.touch).not.toHaveBeenCalled(); run.mockClear();
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  refresh.touch.mockImplementation(() => admitted);
  const params = op === "git.stage" ? { paths: ["file.txt"] } : { newTarget: "other" };
  let settled = false;
  const work = f.relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op, params })).then(() => { settled = true; });
  await expect.poll(() => refresh.touch.mock.calls.length).toBe(1);
  expect(settled).toBe(false);
  expect(run).not.toHaveBeenCalled();
  release(); await work;
  expect(f.relay.bridge("WORKSPACE_RESPONSE").at(-1)?.frame).toMatchObject({ op });
});

it.each(["stop", "dispose"] as const)("%s cancels setup and waits for its exit before completing", async action => {
  let finish!: (code: number | null) => void, signal: AbortSignal | undefined;
  const completed = new Promise<number | null>(resolve => { finish = resolve; });
  const runner = vi.fn<SetupRunner>(async (_file, _args, options) => { signal = options.signal; return completed; });
  const f = await fixture(runner);
  cleanups.push(async () => { finish(null); });
  await expect.poll(() => runner.mock.calls.length).toBe(1);
  let settled = false;
  const stopped = (action === "stop" ? f.relay.receive({ t: "stop", id: randomUUID() }) : f.worker.dispose()).then(() => { settled = true; });
  await expect.poll(() => signal?.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(f.relay.frames.some(frame => frame.t === "stop-ack")).toBe(false);
  finish(null); await stopped;
  expect((await f.status()).state).toBe("interrupted");
  if (action === "stop") expect(f.relay.frames.some(frame => frame.t === "stop-ack")).toBe(true);
});

it("keeps a failed setup nonfatal and never reruns its admitted script on refresh or restart", async () => {
  const runner = vi.fn<SetupRunner>(async () => { throw new Error("private-command-detail"); });
  const first = await fixture(runner);
  await expect.poll(async () => (await first.status()).state).toBe("failed");
  await first.relay.receive(first.configuration);
  expect(first.relay.bridge("ENGINE_READY")).toHaveLength(1);
  expect(await readFile(first.statusPath, "utf8")).not.toContain("private-command-detail");
  await first.worker.dispose();
  const second = await fixture(runner, { directory: first.directory });
  await expect.poll(second.idle).toEqual({ t: "idle", idle: true });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(second.relay.bridge("ENGINE_READY")).toHaveLength(1);
});

it.each([{ createdBranch: false }, { setup: "" }])("skips setup when checkout does not admit it (%j)", async options => {
  const runner = vi.fn<SetupRunner>(async () => 0), f = await fixture(runner, options);
  await f.worker.flush();
  expect(runner).not.toHaveBeenCalled();
  expect(f.idle()).toEqual({ t: "idle", idle: true });
  await expect(stat(f.statusPath)).rejects.toMatchObject({ code: "ENOENT" });
});
