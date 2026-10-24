import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import type { SetupRunner } from "../workspace/setup";
import { CLIENT_A, WORKSPACE_ID, FakeRelay, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function fixture(runner: SetupRunner, options: { directory?: string; createdBranch?: boolean; setup?: string } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "zeros-workspace-setup-"));
  if (!options.directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const relay = new FakeRelay(), onError = vi.fn();
  const worker = new CloudWorker({ directory, transport: relay, drivers: {}, onError, setupRunner: runner,
    prepareCheckout: async () => ({ createdBranch: options.createdBranch ?? true }) });
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
