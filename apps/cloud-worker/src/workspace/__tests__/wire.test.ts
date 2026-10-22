import { afterEach, expect, it } from "vitest";
import { CloudWorker } from "../../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "./repository-fixture";
import { brokerRequest } from "../../credentials/client";

const workers: CloudWorker[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.dispose(); });

it("serves the shared UI's workspace/files/Git requests over ordinary relay frames", async () => {
  const { root, scope, state } = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    workspaceServices: { watch: false, lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) } }); workers.push(worker);
  worker.start(); await relay.receive({ ...config, workspace: scope.workspace }); await relay.receive({ t: "open", clientId: CLIENT_A });
  const list = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} }); await relay.request(CLIENT_A, list);
  expect(relay.response(list.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { workspaces: [{ id: scope.workspace.id, path: root, branch: "workspace/fixture" }] } });
  for (const [op, params, result] of [
    ["file.read", { path: `${root}/readme.txt` }, { kind: "text", path: "readme.txt", content: "initial\n" }],
    ["git.changeCounts", {}, { all: 0, uncommitted: 0, staged: 0, unstaged: 0 }],
  ] as const) {
    const request = browserFrame("WORKSPACE_REQUEST", { op, params: { workspaceId: scope.workspace.id, ...params } });
    await relay.request(CLIENT_A, request); expect(relay.response(request.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result });
  }
});

it("recovers from a failed first config when a later replacement can prepare the checkout", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(); let attempts = 0;
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {
    if (++attempts === 1) throw new Error("Fixture unavailable");
  } }); workers.push(worker); worker.start();
  // The HTTP carrier needs the failure to schedule another configuration read.
  await expect(relay.receive({ ...config, workspace: scope.workspace })).rejects.toThrow("Fixture unavailable");
  await relay.receive({ ...config, workspace: scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  expect(attempts).toBe(2); expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
});

it("answers broker replies while the first private checkout is waiting on its token", async () => {
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay(); let prepared = false;
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async (_workspace, environment) => {
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    const result = await brokerRequest(environment.GH_ZEROS_BROKER_SOCKET!, "token");
    expect(result.token).toBe("fixture-checkout-token"); prepared = true;
  } }); workers.push(worker); worker.start();
  const configuring = relay.receive({ ...config, workspace: scope.workspace });
  await expect.poll(() => relay.frames.some(frame => frame.t === "request"), { timeout: 1000 }).toBe(true);
  const request = relay.frames.find(frame => frame.t === "request")!;
  if (request.t !== "request") throw new Error("Missing token request");
  await relay.receive({ t: "reply", id: request.id, token: "fixture-checkout-token", expiresAt: Date.now() + 120_000 });
  await configuring; expect(prepared).toBe(true);
  await relay.receive({ t: "open", clientId: CLIENT_A }); expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
});
