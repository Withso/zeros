import { beforeEach, expect, it, vi } from "vitest";

// The catalog polls a starting workspace every 2 s, and not at all while the
// window is hidden. In the Alpha app the worker answered 4.3 s after Start,
// but Running showed only ~25 s later, at the next refresh the window allowed.
const mocks = vi.hoisted(() => ({
  status: "waking",
  refresh: vi.fn(async () => ({})),
  connect: vi.fn(async () => ({ url: "wss://relay.example.test/v2", protocols: ["zeros.cloud.v2"], expiresAt: new Date(Date.now() + 60_000).toISOString() })),
}));
vi.mock("../../cloud-v2", () => ({ connectCloudV2Workspace: mocks.connect }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  acceptCloudEngineWorkspace: vi.fn(),
  cloudCatalogGeneration: () => 1,
  cloudWorkspaceOwnerGeneration: () => 1,
  cloudWorkspaceStopVersion: () => 0,
  subscribeCloudWorkspaces: () => () => {},
  cloudWorkspaceDocument: () => ({ status: mocks.status, capabilities: { canWrite: true }, deletedAt: null, error: null }),
  canReadCloudWorkspace: () => true,
  cloudWorkspaceLifecycleTask: () => undefined,
  isCloudWorkspaceLifecyclePending: (doc: { status: string; error: unknown } | undefined) =>
    !!doc && !doc.error && ["stopping", "waking", "provisioning", "setting_up"].includes(doc.status),
  refreshCloudWorkspace: mocks.refresh,
}));
vi.mock("../ws-client", () => ({
  RuntimeClient: class {
    status = "connected"; lastRejection = undefined;
    connect() { return Promise.resolve(); }
    onStatusChange() { return () => {}; }
    dispose() {}
  },
}));
vi.mock("../workspace-bridge", () => ({
  bridgeWorkspaceList: async () => [{ id: "22222222-2222-4222-8222-222222222222", path: "/home/user/o/r" }],
}));

import { openCloudV2Runtime } from "../open-cloud-v2-runtime";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
beforeEach(() => { mocks.refresh.mockClear(); mocks.connect.mockClear(); });

it.each(["waking", "provisioning"])("confirms a %s workspace as soon as its worker answers", async status => {
  mocks.status = status;
  const peer = await openCloudV2Runtime(target, { wake: true });
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(target);
  peer.release();
});

it("does not re-read a workspace the catalog already shows as running", async () => {
  mocks.status = "ready";
  const peer = await openCloudV2Runtime(target, { wake: true });
  expect(mocks.refresh).not.toHaveBeenCalled();
  peer.release();
});
