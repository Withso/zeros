import { afterEach, expect, it } from "vitest";
import { CLOUD_WORKSPACE_RESOURCES_CAPABILITY, CloudWorkspaceResourcesSchema } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("advertises workspace resources on ENGINE_READY and samples them only when asked", async () => {
  const f = await repositoryFixture(), relay = new FakeRelay();
  let samples = 0;
  const sample = { cpu: { cores: 2, usedPercent: 5 }, memory: { totalBytes: 1024, usedPercent: 50 }, disk: { totalBytes: 2048, usedPercent: 25 }, sampledAt: 1 };
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, drivers: {}, prepareCheckout: async () => {},
    workspaceServices: { watch: false, resources: { sample: async () => { samples++; return sample; } } } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace: f.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const ready = relay.bridge("ENGINE_READY")[0]!.frame as { capabilities?: string[] };
  expect(ready.capabilities).toEqual([CLOUD_WORKSPACE_RESOURCES_CAPABILITY, "workspace-resources-watch-v1", "workspace-sync-v1", "sync-batch-v1", "sync-have-v2"]);
  expect(samples).toBe(0);
  const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.resources", params: {} });
  await relay.request(CLIENT_A, request); await worker.flush();
  const response = relay.response(request.id) as { type: string; result: unknown };
  expect(response.type).toBe("WORKSPACE_RESPONSE");
  expect(CloudWorkspaceResourcesSchema.parse(response.result)).toEqual(sample);
  expect(samples).toBe(1);
});
