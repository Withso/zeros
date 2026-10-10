import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentTerminalService } from "../resident-service";
import { ResidentLegacyControlClient } from "../resident-client";
import { ResidentPtyError, type ResidentLegacyRetirementReceipt } from "../resident-protocol";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(), generation: 2,
    fence: 5, token: randomBytes(32).toString("base64url") };
  const hostId = randomUUID(), runtime = { runtimeId: `r1-${"a".repeat(64)}`, bootId: randomUUID(),
    supervisorSessionId: randomUUID(), cgroupRoot: "/sys/fs/cgroup/zeros-cloud-engine" };
  const service = new ResidentTerminalService({ hostId, socketPath: "/unused", authority, legacyControl: { runtime } });
  const client = service["client"];
  vi.spyOn(client, "connect").mockResolvedValue(); vi.spyOn(client, "isConnected").mockReturnValue(true);
  const list = vi.spyOn(client, "list").mockResolvedValue([]);
  await service.connect();
  const inspect = vi.spyOn(client, "inspectWorkloads").mockRejectedValue(new ResidentPtyError("request_rejected"));
  const receipt = (requestId: string): ResidentLegacyRetirementReceipt => ({ version: 1, operation: "retire-legacy-resident", requestId,
    source: { hostId, authority: { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
      runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
      scope: { directory: `${runtime.cgroupRoot}/engine-workload-${hostId}`, dev: "29", ino: "301" } },
    phase: "retired", proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required" });
  const root = vi.spyOn(ResidentLegacyControlClient.prototype, "retire").mockImplementation(async id => receipt(id));
  return { service, client, list, inspect, root, receipt };
}

describe("original legacy resident retirement consumer", () => {
  it("uses legacy metadata only to select an explicit root effect, never as idle proof", async () => {
    const f = await fixture();
    expect(await f.service.readLegacyRetirementCandidate()).toBe(true);
    expect(await f.service.inspectWorkloads()).toBe(true);
    expect(f.root).not.toHaveBeenCalled();
    const receipt = await f.service.retireLegacyWorkloads();
    expect(f.service.legacyRetirementReceipt).toEqual(receipt);
    expect(f.service.requiresFreshView()).toBe(true); expect(f.service.busy()).toBe(false);
    await expect(f.service.connect()).rejects.toThrow("host_unavailable");
    await expect(f.service.create({ sessionId: "replacement", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
  });

  it.each([true, false])("retains legacy exited=%s rows as busy until the actual whole-leaf receipt", async exited => {
    const f = await fixture();
    f.list.mockResolvedValue([{ sessionId: "old", pid: 123, cwd: "/tmp", cols: 80, rows: 24, createdAt: 1,
      exited, actorUserId: null, registryWorkspaceId: null, environmentOwnerId: null, brokerId: null,
      githubShared: false, lastInputAtMs: 0 }]);
    expect(await f.service.readLegacyRetirementCandidate()).toBe(exited);
    expect(await f.service.inspectWorkloads()).toBe(true); expect(f.root).not.toHaveBeenCalled();
  });

  it("does not turn modern incomplete or failed inspection into dedicated-leaf retirement eligibility", async () => {
    const f = await fixture();
    for (const view of [{ version: 1 as const, complete: true, busy: false }, { version: 1 as const, complete: false, busy: true }]) {
      f.inspect.mockResolvedValue(view); expect(await f.service.readLegacyRetirementCandidate()).toBe(false);
    }
    f.inspect.mockRejectedValue(new ResidentPtyError("host_unavailable"));
    expect(await f.service.readLegacyRetirementCandidate()).toBe(false); expect(f.root).not.toHaveBeenCalled();
  });

  it("refuses a stale candidate after an original operation completes during its list await", async () => {
    const f = await fixture(); let finish!: () => void;
    f.list.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    const candidate = f.service.readLegacyRetirementCandidate();
    await expect.poll(() => typeof finish).toBe("function");
    vi.spyOn(f.client, "resize").mockResolvedValue(); await f.service.resize("original", 80, 24);
    finish(); expect(await candidate).toBe(false); expect(f.root).not.toHaveBeenCalled();
  });

  it("retains the exact original request across unknown ACK and blocks every new entry", async () => {
    const f = await fixture();
    f.root.mockRejectedValueOnce(new ResidentPtyError("host_unavailable"));
    await expect(f.service.retireLegacyWorkloads()).rejects.toThrow("host_unavailable");
    expect(f.service.legacyRetirementReceipt).toBeNull(); expect(f.service.busy()).toBe(true);
    expect(f.service.requiresFreshView()).toBe(true);
    await expect(f.service.write("original", "input", null)).rejects.toThrow("host_unavailable");
    await expect(f.service.resize("original", 80, 24)).rejects.toThrow("host_unavailable");
    const result = await f.service.retireLegacyWorkloads();
    expect(f.root.mock.calls[1]![0]).toBe(f.root.mock.calls[0]![0]);
    expect(result).toEqual(f.receipt(f.root.mock.calls[0]![0])); expect(f.service.busy()).toBe(false);
    expect(await f.service.retireLegacyWorkloads()).toEqual(result); expect(f.root).toHaveBeenCalledTimes(2);
  });

  it("retains a pending original root flight even after the old host transport closes", async () => {
    const f = await fixture(); let finish!: () => void;
    f.root.mockImplementation(id => new Promise(resolve => { finish = () => resolve(f.receipt(id)); }));
    const retiring = f.service.retireLegacyWorkloads();
    await expect.poll(() => typeof finish).toBe("function");
    expect(f.service.busy()).toBe(true); vi.mocked(f.client.isConnected).mockReturnValue(false);
    finish(); await retiring;
    expect(f.service.legacyRetirementReceipt).not.toBeNull(); expect(f.service.busy()).toBe(false);
  });

  it("never installs a late receipt into a replaced/disconnected original attachment", async () => {
    const f = await fixture(); let finish!: () => void;
    f.root.mockImplementation(id => new Promise(resolve => { finish = () => resolve(f.receipt(id)); }));
    const retiring = f.service.retireLegacyWorkloads(), rejected = expect(retiring).rejects.toThrow("host_unavailable");
    await expect.poll(() => typeof finish).toBe("function"); f.service.disconnect(); finish(); await rejected;
    expect(f.service.legacyRetirementReceipt).toBeNull(); expect(f.service.requiresFreshView()).toBe(true);
  });

  it("does not accept a modern shared-leaf receipt through an internal callback", async () => {
    const f = await fixture();
    f.root.mockImplementation(async id => { const result = f.receipt(id);
      return { ...result, source: { ...result.source, scope: { ...result.source.scope,
        directory: result.source.scope.directory.replace("/engine-workload-", "/engine-runtime/engine-workload-") } } }; });
    await expect(f.service.retireLegacyWorkloads()).rejects.toThrow("host_unavailable");
    expect(f.service.legacyRetirementReceipt).toBeNull(); expect(f.service.busy()).toBe(true);
  });
});
