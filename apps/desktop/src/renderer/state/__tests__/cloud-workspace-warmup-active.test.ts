import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ active: null as string | null, doc: { status: "ready", deletedAt: null } as Record<string, unknown> | undefined }));
vi.mock("../store", () => ({
  useWorkspaceStore: { getState: () => ({}) },
  selectActiveFolder: () => mocks.active,
}));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => mocks.doc,
  canReadCloudWorkspace: (doc: unknown) => doc !== undefined,
}));
const bridge = vi.hoisted(() => ({ warmWorkspace: vi.fn(async () => {}), warmHistoryWorkspace: vi.fn(async () => {}) }));
vi.mock("../../platform/bridge/workspace-runtime-client", () => ({ WorkspaceRuntimeClient: class {} }));
vi.mock("../../platform/bridge/active-bridge", async () => {
  const { WorkspaceRuntimeClient } = await import("../../platform/bridge/workspace-runtime-client");
  return { getActiveBridge: () => Object.assign(Object.create(WorkspaceRuntimeClient.prototype), bridge) };
});

import { warmCloudWorkspaceDestination } from "../cloud-workspace-warmup";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

const a = cloudWorkspaceKey({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });
const b = cloudWorkspaceKey({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333" });

// Launch census F: hover and restored-tab intent opened speculative connections (POST connect) for workspaces the
// person was not in. Only the active workspace connects ahead of a click; others warm their history read.
describe("intent warm-up connects only the active workspace", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.active = a; mocks.doc = { status: "ready", deletedAt: null }; });
  it("a running non-active workspace warms history only", async () => {
    await warmCloudWorkspaceDestination(b, true);
    expect(bridge.warmWorkspace).not.toHaveBeenCalled();
    expect(bridge.warmHistoryWorkspace).toHaveBeenCalledOnce();
  });
  it("the active running workspace still connects ahead of the click", async () => {
    await warmCloudWorkspaceDestination(a, true);
    await warmCloudWorkspaceDestination(a);
    expect(bridge.warmWorkspace).toHaveBeenCalledTimes(2);
  });
});
