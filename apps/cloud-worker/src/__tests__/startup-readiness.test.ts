import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { commandRunner } from "../workspace/commands";

it("reports completed workspace stages while remote repair and watcher startup still fence readiness", async () => {
  const fixture = await repositoryFixture(), run = commandRunner(fixture.root);
  await fixture.git("remote", "add", "origin", "https://github.com/fixture/repo.git");
  let remoteEntered!: () => void, releaseRemote!: () => void, watchEntered!: () => void, releaseWatch!: () => void;
  const remoteObserved = new Promise<void>(resolve => { remoteEntered = resolve; });
  const remoteHeld = new Promise<void>(resolve => { releaseRemote = resolve; });
  const watchObserved = new Promise<void>(resolve => { watchEntered = resolve; });
  const watchHeld = new Promise<void>(resolve => { releaseWatch = resolve; });
  const reportTiming = vi.fn(), relay = Object.assign(new FakeRelay(), { reportTiming });
  const phases = () => reportTiming.mock.calls.map(([record]) => record.phase).filter(phase => phase.startsWith("worker_workspace_"));
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { run: async (program, args, options) => {
      if (args.includes("--git-common-dir")) { remoteEntered(); await remoteHeld; }
      if (args[0] === "ls-files") { watchEntered(); await watchHeld; }
      return run(program, args, options);
    } }, prepareCheckout: async () => {}, drivers: {} });
  worker.start();
  const configuring = relay.receive({ ...config, workspace: { ...fixture.scope.workspace,
    github: { repositoryId: "42", repository: "fixture/repo", previousRepositories: [] } }, agents: {} });
  const opening = relay.receive({ t: "open", clientId: CLIENT_A });
  try {
    await remoteObserved;
    expect(phases()).toEqual(["worker_workspace_state", "worker_workspace_metadata"]);
    expect(relay.bridge("ENGINE_READY")).toHaveLength(0);
    releaseRemote(); await watchObserved;
    expect(phases()).toEqual(["worker_workspace_state", "worker_workspace_metadata", "worker_workspace_remote", "worker_workspace_poll"]);
    expect(relay.bridge("ENGINE_READY")).toHaveLength(0);
    releaseWatch(); await Promise.all([configuring, opening]);
    expect(phases()).toEqual(["worker_workspace_state", "worker_workspace_metadata", "worker_workspace_remote", "worker_workspace_poll", "worker_workspace_watch"]);
    expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
    for (const [record] of reportTiming.mock.calls) {
      expect(Object.keys(record).sort()).toEqual(["durationMs", "phase"]);
      expect(Number.isSafeInteger(record.durationMs)).toBe(true);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.durationMs).toBeLessThanOrEqual(3_600_000);
    }
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    await relay.request(CLIENT_A, request);
    expect(relay.response(request.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { workspaces: [expect.objectContaining({ branch: "workspace/fixture" })] } });
  } finally {
    releaseRemote(); releaseWatch(); await Promise.allSettled([configuring, opening]); await worker.dispose();
  }
});

it("serves initial workspace reads while the unrelated checkout metadata report is held", async () => {
  const fixture = await repositoryFixture();
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const relay = Object.assign(new FakeRelay(), { reportGithubCheckout: async () => { entered(); await held; } });
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => {}, drivers: {} });
  worker.start();
  const configuring = relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {}, githubPullRequests: 1 });
  let opening: Promise<void> | undefined, reading: Promise<void> | undefined;
  try {
    await observed;
    opening = relay.receive({ t: "open", clientId: CLIENT_A });
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    reading = relay.request(CLIENT_A, request);
    await expect.poll(() => relay.response(request.id)?.type, { timeout: 1500 }).toBe("WORKSPACE_RESPONSE");
  } finally {
    release(); await Promise.allSettled([configuring, opening, reading]); await worker.dispose();
  }
});

it("recovers from a rejected first MCP snapshot when the next configuration is corrected", async () => {
  const fixture = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => {}, drivers: {} });
  worker.start();
  try {
    await expect(relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {},
      mcpServers: [{ id: randomUUID(), name: "invalid-endpoint", transport: "http", url: "ftp://example.invalid/" }] }))
      .rejects.toThrow("Invalid MCP endpoint");
    await expect(relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {}, loginRevision: "1", mcpServers: [] })).resolves.toBeUndefined();
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    await relay.request(CLIENT_A, request);
    expect(relay.response(request.id)?.type).toBe("WORKSPACE_RESPONSE");
  } finally { await worker.dispose(); }
});
