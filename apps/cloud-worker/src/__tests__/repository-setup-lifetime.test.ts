import { randomUUID } from "node:crypto";
import { readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { McpGateway } from "../mcp/gateway";
import { RepositorySetupSource } from "../workspace/repository-setup";
import { WorkspaceSetup } from "../workspace/setup";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { config, FakeRelay } from "./worker-fixtures";

afterEach(() => vi.restoreAllMocks());
function held() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

it.each(["stop", "dispose"] as const)("%s fences a held script read before waiting for reconfiguration", async action => {
  const f = await repositoryFixture();
  await writeFile(join(f.root, "setup.sh"), "printf ran > setup-ran\n");
  await f.git("add", "setup.sh"); await f.git("commit", "-m", "fixture setup");
  const reading = held(), readReady = held(), configuring = held(), configReady = held();
  const read = RepositorySetupSource.read;
  let signal: AbortSignal | undefined;
  vi.spyOn(RepositorySetupSource, "read").mockImplementationOnce(async (...args) => {
    signal = args[3];
    const source = await read(...args);
    readReady.release(); await reading.promise;
    return source;
  });
  const relay = new FakeRelay(), runner = vi.fn(async () => 0);
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, drivers: {},
    workspaceServices: { watch: false }, setupRunner: runner, prepareCheckout: async () => ({ createdBranch: true }) });
  const configuration = { ...config, agents: {}, workspace: { ...f.scope.workspace, setupScript: "setup.sh" } };
  let refresh: Promise<void> | undefined, closing: Promise<void> | undefined;
  try {
    worker.start(); await relay.receive(configuration); await readReady.promise;
    vi.spyOn(McpGateway.prototype, "configure").mockImplementationOnce(async () => { configReady.release(); await configuring.promise; });
    refresh = relay.receive({ ...configuration, loginRevision: "1" }); await configReady.promise;
    closing = action === "stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    expect(signal?.aborted).toBe(true);
    reading.release();
    await expect.poll(async () => JSON.parse(await readFile(join(f.state, "workspace-setup", `${f.scope.workspace.id}.json`), "utf8")).state).toBe("interrupted");
    expect(runner).not.toHaveBeenCalled();
    expect(relay.frames.some(frame => frame.t === "stop-ack")).toBe(false);
    configuring.release(); await refresh; await closing;
    if (action === "stop") expect(relay.frames.some(frame => frame.t === "stop-ack")).toBe(true);
  } finally {
    reading.release(); configuring.release();
    await refresh?.catch(() => {}); await closing?.catch(() => {}); await worker.dispose();
  }
});

it.each(["stop", "dispose"] as const)("%s refuses native spawn after the final admission write settles", async action => {
  const f = await repositoryFixture();
  await writeFile(join(f.root, "setup.sh"), "printf ran > setup-ran\n");
  await f.git("add", "setup.sh"); await f.git("commit", "-m", "fixture setup");
  const writing = held(), admitted = held();
  const target = WorkspaceSetup.prototype as unknown as {
    persist(file: FileHandle, status: { state: string; source?: unknown }): Promise<void>;
  };
  const persist = target.persist;
  vi.spyOn(target, "persist").mockImplementation(async function (this: WorkspaceSetup, file, status) {
    await persist.call(this, file, status);
    if (status.state === "running" && status.source) { admitted.release(); await writing.promise; }
  });
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, drivers: {},
    workspaceServices: { watch: false }, prepareCheckout: async () => ({ createdBranch: true }) });
  let closing: Promise<void> | undefined;
  try {
    worker.start();
    await relay.receive({ ...config, agents: {}, workspace: { ...f.scope.workspace, setupScript: "setup.sh" } });
    await admitted.promise;
    const base = join(f.state, "workspace-setup", f.scope.workspace.id);
    expect(await readFile(`${base}.script`, "utf8")).toBe("printf ran > setup-ran\n");
    closing = action === "stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    expect(relay.frames.some(frame => frame.t === "stop-ack")).toBe(false);
    writing.release(); await closing;
    await expect(readFile(join(f.root, "setup-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(`${base}.json`, "utf8")).state).toBe("interrupted");
    if (action === "stop") expect(relay.frames.some(frame => frame.t === "stop-ack")).toBe(true);
  } finally { writing.release(); await closing?.catch(() => {}); await worker.dispose(); }
});
