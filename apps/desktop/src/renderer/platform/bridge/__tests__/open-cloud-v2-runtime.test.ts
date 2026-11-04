import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: "stopped",
  operation: "",
  connect: vi.fn(async () => { throw new Error("connect should not run"); }),
}));
vi.mock("../../cloud-v2", () => ({ connectCloudV2Workspace: mocks.connect }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  acceptCloudEngineWorkspace: vi.fn(),
  cloudCatalogGeneration: () => 1,
  cloudWorkspaceOwnerGeneration: () => 1,
  cloudWorkspaceStopVersion: () => 0,
  subscribeCloudWorkspaces: () => () => {},
  cloudWorkspaceDocument: () => ({ status: mocks.status, capabilities: { canWrite: true }, deletedAt: null }),
  canReadCloudWorkspace: () => !["deleting", "deleted"].includes(mocks.status),
  cloudWorkspaceLifecycleTask: (_target: unknown, operation: string) => mocks.operation === operation ? new Promise(() => {}) : undefined,
}));

import { openCloudV2Runtime } from "../open-cloud-v2-runtime";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
beforeEach(() => { mocks.status = "stopped"; mocks.operation = ""; mocks.connect.mockClear(); });

describe("opening a cloud v2 workspace", () => {
  it("never starts a stopped VM for a passive warm-up; an explicit open asks for a ticket", async () => {
    await expect(openCloudV2Runtime(target)).rejects.toThrow("stopped");
    expect(mocks.connect).not.toHaveBeenCalled();
    await expect(openCloudV2Runtime(target, { wake: true })).rejects.toThrow("connect should not run");
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
  it.each(["stopping", "archiving", "archived", "deleting", "deleted", "failed", "error"])("never acquires a wake ticket for a %s workspace", async status => {
    mocks.status = status;
    await expect(openCloudV2Runtime(target, { wake: true })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(["stop", "archive", "delete"])("does not acquire a wake ticket before the pending %s response updates the catalog", async operation => {
    mocks.status = "ready"; mocks.operation = operation;
    await expect(openCloudV2Runtime(target, { wake: true })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("checks cancellation before asking the control plane to start the VM", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(openCloudV2Runtime(target, { wake: true, signal: controller.signal })).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
