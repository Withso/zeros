import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** One callable request per capability the worker may announce. A new capability must add its probe here. */
const PROBES: Record<string, { op: string; params: Record<string, unknown> }> = {
  "workspace-resources-v1": { op: "workspace.resources", params: {} },
  "workspace-resources-watch-v1": { op: "workspace.resources", params: { watch: false } },
  "workspace-sync-v1": { op: "sync.snapshot", params: {} },
  "sync-batch-v1": { op: "sync.readBatch", params: { paths: [] } },
  "sync-have-v2": { op: "sync.bootstrap", params: { have: [] } },
  "code-review-v1": { op: "codeReview.list", params: {} },
};

// G's dev-VM run found setup-events-v1 announced while workspace.setupInfo answered CLOUD_V2_UNSUPPORTED:
// a capability is announced only when its request path answers.
it("every capability on ENGINE_READY has a request path the worker answers", async () => {
  const f = await repositoryFixture();
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {}, drivers: {}, workspaceServices: { watch: false } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace: f.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const ready = relay.bridge("ENGINE_READY").find(entry => entry.clientId === CLIENT_A)!.frame as { capabilities?: string[] };
  const advertised = ready.capabilities ?? [];
  expect(advertised.length).toBeGreaterThan(0);
  for (const capability of advertised) {
    const probe = PROBES[capability];
    expect(probe, `add a probe for ${capability}`).toBeDefined();
    const frame = browserFrame("WORKSPACE_REQUEST", { op: probe!.op, params: probe!.params });
    await relay.request(CLIENT_A, frame);
    const reply = relay.response(frame.id) as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }> | undefined;
    expect(reply, `${capability}: ${probe!.op} got no reply`).toBeDefined();
    expect(reply!.type === "WORKSPACE_ERROR" ? reply!.code : "answered", `${capability}: ${probe!.op}`).not.toBe("CLOUD_V2_UNSUPPORTED");
  }
});
