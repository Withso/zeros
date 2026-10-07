import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../service";
import { WorkspaceResourceUsageSampler } from "../resource-usage";
import { closeState, setStateRootForTesting } from "../../git";

const identity = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7, engineInstanceId: "33333333-3333-4333-8333-333333333333",
};
const sample = { version: 1 as const, ...identity, sampledAt: "2026-10-07T10:00:00Z",
  cpu: { cores: 2, usedPercent: null },
  memory: { totalBytes: null, availableBytes: null, usedBytes: null, usedPercent: null },
  disk: { totalBytes: null, availableBytes: null, usedBytes: null, usedPercent: null } };
describe("cloud-only admitted resource usage service", () => {
  let root: string, service: WorkspaceService, authorized: boolean;
  const params = { workspaceId: LOCAL_MAIN_WORKSPACE_ID, generation: 7, engineInstanceId: identity.engineInstanceId };
  const options = () => ({ remote: true, cloudWorker: true,
    cloudActorIdentity: { userId: identity.workspaceId, deviceId: identity.organizationId },
    cloudFileActor: { role: "viewer" as const, authorized: () => authorized } });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-resource-usage-"));
    setStateRootForTesting(path.join(root, "state")); authorized = true;
    service = new WorkspaceService(root, { primaryDesignWorkspace: true, cloudResourceUsageIdentity: () => identity });
    vi.spyOn(WorkspaceResourceUsageSampler.prototype, "sample").mockResolvedValue(sample);
  });
  afterEach(() => { closeState(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  it("serves a viewer only the authoritative primary volume and advertises the read", async () => {
    expect(await service.handle("workspace.resourceUsage", params, options())).toEqual(sample);
    expect(WorkspaceResourceUsageSampler.prototype.sample).toHaveBeenCalledWith(identity, root);
    expect(service.remoteReadable("workspace.resourceUsage")).toBe(true);
  });
  it("denies Local owners, organization Local placement, paired hosts and foreign identities", async () => {
    const local = new WorkspaceService(root);
    for (const target of [local, service])
      await expect(target.handle("workspace.resourceUsage", params)).rejects.toThrow();
    await expect(service.handle("workspace.resourceUsage", params, { remote: true })).rejects.toThrow();
    for (const change of [{ workspaceId: "foreign" }, { generation: 8 }, { engineInstanceId: identity.workspaceId }, { cwd: "/host" }])
      await expect(service.handle("workspace.resourceUsage", { ...params, ...change }, options())).rejects.toThrow();
    expect(WorkspaceResourceUsageSampler.prototype.sample).not.toHaveBeenCalled();
  });
  it("withdraws a sample if authority is revoked during observation", async () => {
    vi.mocked(WorkspaceResourceUsageSampler.prototype.sample).mockImplementation(async () => { authorized = false; return sample; });
    await expect(service.handle("workspace.resourceUsage", params, options())).rejects.toThrow();
  });
});
