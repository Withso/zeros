import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

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
