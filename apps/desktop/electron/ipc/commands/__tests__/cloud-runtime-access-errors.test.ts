import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceAccessClientError } from "../../../cloud-workspace-access-client";

const mocks = vi.hoisted(() => ({ openRuntime: vi.fn(), refreshRuntime: vi.fn() }));
vi.mock("../../../cloud-workspace-access-runtime", () => ({ getCloudWorkspaceAccessBroker: () => mocks }));
import { cloudWorkspaceRuntimeOpen, cloudWorkspaceRuntimeRefresh } from "../cloud-workspace-access";

const args = { organizationId: "org", workspaceId: "workspace", runtimeId: "runtime", generation: 1, authorityEpoch: 1, engineInstanceId: "engine", connectionSequence: 1 };
describe("cloud runtime IPC failure envelopes", () => {
  it.each([cloudWorkspaceRuntimeOpen, cloudWorkspaceRuntimeRefresh])("keeps a closed 409 supersession code across Electron serialization", async command => {
    mocks.openRuntime.mockRejectedValue(new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "private-admission-detail"));
    mocks.refreshRuntime.mockRejectedValue(new CloudWorkspaceAccessClientError(409, "cloud_workspace_access_superseded", "private-admission-detail"));
    const result = await command(args, {} as never);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ type: "cloud_runtime_access_error", status: 409, code: "cloud_workspace_access_superseded" });
  });
});
