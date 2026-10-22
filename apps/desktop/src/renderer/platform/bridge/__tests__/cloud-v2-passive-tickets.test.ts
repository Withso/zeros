import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: "running",
  connect: vi.fn(async () => ({ url: "wss://api.example.test/v2/cloud/workspaces/w/bridge",
    protocols: ["zeros.cloud.v2", "ticket.fixture"], expiresAt: new Date(Date.now() + 60_000).toISOString() })),
  clients: [] as Array<{ refresh?: () => Promise<unknown> }>,
}));
vi.mock("../../cloud-v2", () => ({ connectCloudV2Workspace: mocks.connect }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  acceptCloudEngineWorkspace: vi.fn(),
  cloudCatalogGeneration: () => 1,
  cloudWorkspaceDocument: () => ({ status: mocks.status }),
}));
vi.mock("../ws-client", () => ({
  RuntimeClient: class {
    status = "connecting";
    constructor(_target: unknown, options: { refreshCloudConnectionTarget?: () => Promise<unknown> }) {
      mocks.clients.push({ refresh: options.refreshCloudConnectionTarget });
    }
    connect() { return Promise.resolve(); }
    onStatusChange() { return () => {}; }
    dispose() {}
  },
}));

import { openCloudV2Runtime } from "../open-cloud-v2-runtime";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };

async function openThenCancel(options: { wake?: boolean }) {
  const controller = new AbortController();
  const opening = openCloudV2Runtime(target, { ...options, signal: controller.signal });
  await vi.waitFor(() => expect(mocks.clients).toHaveLength(1));
  return { controller, opening, refresh: mocks.clients[0]!.refresh! };
}

describe("cloud v2 connection tickets", () => {
  it("wakes only for an explicit open; passive opens and every reconnect leave a stopped VM stopped", async () => {
    for (const wake of [true, undefined]) {
      mocks.connect.mockClear(); mocks.clients.length = 0;
      const { controller, opening, refresh } = await openThenCancel(wake ? { wake } : {});
      expect(mocks.connect).toHaveBeenLastCalledWith(target, { wake: wake === true });
      // A laptop wake, network drop or control-plane deploy reconnects with a
      // fresh ticket; that must not restart a VM that idled to a stop.
      await refresh();
      expect(mocks.connect).toHaveBeenLastCalledWith(target, { wake: false });
      controller.abort();
      await expect(opening).rejects.toThrow("cancelled");
    }
  });
});
