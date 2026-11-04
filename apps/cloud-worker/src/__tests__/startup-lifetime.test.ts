import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { McpGateway } from "../mcp/gateway";
import { WorkspaceService } from "../workspace/service";
import { CheckoutWatch } from "../workspace/watch";
import { WorkerCodeReview } from "../workspace/code-review";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

afterEach(() => vi.restoreAllMocks());
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const refresh = () => ({ mayFastForward: false, start: vi.fn(async () => {}), touch: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });

it.each([false, true])("unwinds failed initial services before accepting a corrected configuration (review=%s)", async review => {
  const fixture = await repositoryFixture(), relay = new FakeRelay(), firstRefresh = refresh(), secondRefresh = refresh();
  const open = vi.spyOn(WorkspaceService, "open"), close = vi.spyOn(WorkspaceService.prototype, "dispose"), watches = vi.spyOn(CheckoutWatch.prototype, "dispose");
  const gateways = vi.spyOn(McpGateway.prototype, "dispose");
  const reviewClose = vi.spyOn(WorkerCodeReview.prototype, "close");
  const reviewConfig = review ? { codeReview: { userId: CLIENT_A } } : {};
  const prepare = vi.fn().mockResolvedValueOnce({ createdBranch: false, refresh: firstRefresh }).mockResolvedValue({ createdBranch: false, refresh: secondRefresh });
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    prepareCheckout: prepare, drivers: {} });
  worker.start();
  try {
    await expect(relay.receive({ ...config, ...reviewConfig, workspace: fixture.scope.workspace, agents: {},
      mcpServers: [{ id: randomUUID(), name: "invalid-endpoint", transport: "http", url: "ftp://example.invalid/" }] }))
      .rejects.toThrow("Invalid MCP endpoint");
    expect(close).toHaveBeenCalledOnce();
    expect(watches).toHaveBeenCalledOnce();
    expect(gateways).toHaveBeenCalledOnce();
    expect(reviewClose).toHaveBeenCalledOnce();
    expect(firstRefresh.dispose).toHaveBeenCalledOnce();
    expect(firstRefresh.start).not.toHaveBeenCalled();
    await relay.receive({ ...config, ...reviewConfig, workspace: fixture.scope.workspace, agents: {}, mcpServers: [] });
    expect(open).toHaveBeenCalledTimes(2);
    expect(secondRefresh.start).toHaveBeenCalledOnce();
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    await relay.request(CLIENT_A, request);
    expect(relay.response(request.id)?.type).toBe("WORKSPACE_RESPONSE");
    if (review) {
      const list = browserFrame("WORKSPACE_REQUEST", { op: "codeReview.list", params: { workspaceId: fixture.scope.workspace.id } });
      await relay.request(CLIENT_A, list);
      expect(relay.response(list.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { threads: [] } });
    }
  } finally { await worker.dispose(); }
});

it.each(["stop", "dispose"])("does not publish initial services after %s wins a held required setup", async boundary => {
  const fixture = await repositoryFixture(), relay = new FakeRelay(), entering = gate(), held = gate(), checkout = refresh();
  const configure = McpGateway.prototype.configure;
  vi.spyOn(McpGateway.prototype, "configure").mockImplementation(async function (this: McpGateway, servers, revision) {
    await configure.call(this, servers, revision); entering.resolve(); await held.promise;
  });
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => ({ createdBranch: true, refresh: checkout }), drivers: {} });
  worker.start();
  const configuring = relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {} });
  const opening = relay.receive({ t: "open", clientId: CLIENT_A });
  const admitted = Promise.allSettled([configuring, opening]);
  let finishing: Promise<void> | undefined;
  try {
    await entering.promise;
    finishing = boundary === "stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    const settled = Promise.allSettled([finishing]);
    held.resolve(); await admitted;
    expect((await settled)[0].status).toBe("fulfilled");
    expect(relay.bridge("ENGINE_READY")).toEqual([]);
    expect(checkout.start).not.toHaveBeenCalled();
    expect(checkout.dispose).toHaveBeenCalledOnce();
    if (boundary === "stop") expect(relay.frames.some(frame => frame.t === "stop-ack")).toBe(true);
  } finally { held.resolve(); await admitted; await finishing?.catch(() => {}); await worker.dispose(); }
});

it("owns watchers when opening the workspace fails after watch startup", async () => {
  const fixture = await repositoryFixture(), start = CheckoutWatch.prototype.start;
  const watchers: CheckoutWatch[] = [];
  const close = vi.spyOn(CheckoutWatch.prototype, "dispose");
  vi.spyOn(CheckoutWatch.prototype, "start").mockImplementation(async function (this: CheckoutWatch) {
    watchers.push(this);
    await start.call(this); throw new Error("watch admission failed");
  });
  try {
    await expect(WorkspaceService.open(fixture.scope, fixture.state)).rejects.toThrow("watch admission failed");
    expect(close).toHaveBeenCalledOnce();
  } finally { await Promise.all(watchers.map(watcher => watcher.dispose())); }
});

it("retains first-checkout setup admission across a corrected initial configuration", async () => {
  const fixture = await repositoryFixture(), relay = new FakeRelay(), setup = vi.fn(async () => 0);
  const prepare = vi.fn().mockResolvedValueOnce({ createdBranch: true }).mockResolvedValue({ createdBranch: false });
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: prepare, setupRunner: setup, drivers: {} });
  const snapshot = { ...config, workspace: { ...fixture.scope.workspace, setup: "fixture setup" }, agents: {} };
  worker.start();
  try {
    await expect(relay.receive({ ...snapshot,
      mcpServers: [{ id: randomUUID(), name: "invalid-endpoint", transport: "http", url: "ftp://example.invalid/" }] }))
      .rejects.toThrow("Invalid MCP endpoint");
    await relay.receive({ ...snapshot, loginRevision: "1", mcpServers: [] });
    await expect.poll(() => setup.mock.calls.length).toBe(1);
    await relay.receive({ ...snapshot, loginRevision: "2", mcpServers: [] });
    expect(setup).toHaveBeenCalledOnce();
  } finally { await worker.dispose(); }
});

it("keeps one boot report sequence across failed initial services", async () => {
  const fixture = await repositoryFixture(), reported = gate();
  const reports: Array<{ sequence: number; branch: string | null }> = [];
  const relay = Object.assign(new FakeRelay(), { reportGithubCheckout: async (value: { sequence: number; branch: string | null }) => {
    reports.push(value); reported.resolve();
  } });
  const configure = McpGateway.prototype.configure;
  vi.spyOn(McpGateway.prototype, "configure").mockImplementation(async function (this: McpGateway, servers, revision) {
    if (servers.some(server => server.name === "invalid-endpoint")) await reported.promise;
    await configure.call(this, servers, revision);
  });
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => {}, drivers: {} });
  const snapshot = { ...config, workspace: fixture.scope.workspace, agents: {}, githubPullRequests: 1 as const };
  worker.start();
  try {
    await expect(relay.receive({ ...snapshot,
      mcpServers: [{ id: randomUUID(), name: "invalid-endpoint", transport: "http", url: "ftp://example.invalid/" }] }))
      .rejects.toThrow("Invalid MCP endpoint");
    await fixture.git("switch", "-c", "topic/corrected");
    await relay.receive({ ...snapshot, loginRevision: "1", mcpServers: [] });
    await worker.flush();
    expect(reports.map(({ sequence, branch }) => ({ sequence, branch }))).toEqual([
      { sequence: 1, branch: "workspace/fixture" }, { sequence: 2, branch: "topic/corrected" },
    ]);
  } finally { await worker.dispose(); }
});

it("acknowledges Stop after initial configuration failed and owned cleanup completed", async () => {
  const fixture = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => {}, drivers: {} });
  worker.start();
  try {
    await expect(relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {},
      mcpServers: [{ id: randomUUID(), name: "invalid-endpoint", transport: "http", url: "ftp://example.invalid/" }] }))
      .rejects.toThrow("Invalid MCP endpoint");
    const id = randomUUID();
    await expect(relay.receive({ t: "stop", id })).resolves.toBeUndefined();
    expect(relay.frames).toContainEqual({ t: "stop-ack", id });
    expect(relay.bridge("ENGINE_READY")).toEqual([]);
  } finally { await worker.dispose(); }
});
