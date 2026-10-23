import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: "stopped",
  connect: vi.fn(async () => { throw new Error("connect should not run"); }),
}));
vi.mock("../../cloud-v2", () => ({ connectCloudV2Workspace: mocks.connect }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  acceptCloudEngineWorkspace: vi.fn(),
  cloudCatalogGeneration: () => 1,
  cloudWorkspaceDocument: () => ({ status: mocks.status }),
}));

import { openCloudV2Runtime } from "../open-cloud-v2-runtime";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };

describe("opening a cloud v2 workspace", () => {
  it("never starts a stopped VM for a passive warm-up; an explicit open asks for a ticket", async () => {
    await expect(openCloudV2Runtime(target)).rejects.toThrow("stopped");
    expect(mocks.connect).not.toHaveBeenCalled();
    await expect(openCloudV2Runtime(target, { wake: true })).rejects.toThrow("connect should not run");
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
});
