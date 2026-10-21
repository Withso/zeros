import { afterEach, expect, it } from "vitest";
import { CloudWorker } from "../../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "./repository-fixture";

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
  await relay.receive({ ...config, workspace: scope.workspace });
  await relay.receive({ ...config, workspace: scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  expect(attempts).toBe(2); expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
});
