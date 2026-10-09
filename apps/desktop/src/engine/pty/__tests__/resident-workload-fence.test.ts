import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentPtyClient } from "../resident-client";
import { ResidentTerminalService } from "../resident-service";
import { ResidentWorkloadFenceRequestSchema, ResidentWorkloadFenceStatusSchema } from "../resident-protocol";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 1, fence: 2, token: randomBytes(32).toString("base64url") };
  const visible = { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
    engineId: authority.engineId, generation: authority.generation, fence: authority.fence };
  const fence = { version: 1 as const, requestId: randomUUID(), mode: "preserve" as const };
  const client = new ResidentPtyClient({ socketPath: "/unused", authority });
  const request = vi.spyOn(client as unknown as { request(value: unknown): Promise<unknown> }, "request").mockResolvedValue({
    ...fence, authority: visible, scope: "owner-process-groups", phase: "fenced",
  });
  return { authority, visible, fence, client, request };
}
async function serviceFixture() {
  const f = fixture(), service = new ResidentTerminalService({ hostId: randomUUID(), socketPath: "/unused", authority: f.authority });
  const client = service["client"];
  vi.spyOn(client, "connect").mockResolvedValue(); vi.spyOn(client, "list").mockResolvedValue([]);
  vi.spyOn(client, "isConnected").mockReturnValue(true); await service.connect();
  const raw = vi.spyOn(client as unknown as { request(value: { op: string; fence: typeof f.fence }): Promise<unknown> }, "request")
    .mockImplementation(async value => ({ ...value.fence, authority: f.visible, scope: "owner-process-groups",
      phase: value.op === "fence-workloads" ? "fenced" : value.op === "join-workloads" ? "joined"
        : value.op === "drain-workloads" ? "drained" : "released" }));
  return { ...f, service, owner: client, raw };
}

describe("strict original resident lifecycle ticket wire", () => {
  it("keeps preserve and full drain requests distinct with closed correlated status", () => {
    const f = fixture();
    expect(ResidentWorkloadFenceRequestSchema.parse(f.fence)).toEqual(f.fence);
    expect(ResidentWorkloadFenceRequestSchema.safeParse({ ...f.fence, mode: "empty" }).success).toBe(false);
    expect(ResidentWorkloadFenceStatusSchema.safeParse({ ...f.fence, authority: f.visible, scope: "owner-process-groups", phase: "drained" }).success).toBe(false);
    expect(ResidentWorkloadFenceStatusSchema.safeParse({ ...f.fence, authority: f.visible, scope: "owner-process-groups", phase: "joined", pids: [] }).success).toBe(false);
  });

  it("sends the exact operation and immutable body and rejects a conflicting authority or phase", async () => {
    const f = fixture();
    expect(await f.client.fenceWorkloads(f.fence)).toMatchObject({ ...f.fence, phase: "fenced" });
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ op: "fence-workloads", fence: f.fence });
    f.request.mockResolvedValue({ ...f.fence, authority: { ...f.visible, fence: 3 }, scope: "owner-process-groups", phase: "joined" });
    await expect(f.client.joinPendingWorkloads(f.fence)).rejects.toThrow("request_rejected");
    f.request.mockResolvedValue({ ...f.fence, authority: f.visible, scope: "owner-process-groups", phase: "fenced" });
    await expect(f.client.joinPendingWorkloads(f.fence)).rejects.toThrow("request_rejected");
  });

  it("closes local admission synchronously before the original remote fence ACK", async () => {
    const f = await serviceFixture();
    let finish!: (value: unknown) => void;
    f.raw.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const fence = f.service.fenceWorkloads("preserve");
    await expect(f.service.create({ sessionId: "late", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
    finish({ ...fence, authority: f.visible, scope: "owner-process-groups", phase: "fenced" });
    await f.service.joinPendingWorkloads(fence);
    await f.service.resumeWorkloads(fence);
    expect(f.raw.mock.calls.map(([value]) => value.op)).toEqual(["fence-workloads", "join-workloads", "resume-workloads"]);
  });

  it("rechecks queued input after the original cursor await", async () => {
    const f = await serviceFixture();
    let cursor!: (value: number) => void;
    vi.spyOn(f.owner, "cursor").mockImplementation(() => new Promise(resolve => { cursor = resolve; }));
    const write = vi.spyOn(f.owner, "write").mockResolvedValue("applied");
    const writing = f.service.write("original-shell", "late input", null);
    const refused = expect(writing).rejects.toThrow("host_unavailable");
    await expect.poll(() => typeof cursor).toBe("function");
    const fence = f.service.fenceWorkloads("preserve"); cursor(0); await refused;
    expect(write).not.toHaveBeenCalled();
    await f.service.joinPendingWorkloads(fence); await f.service.resumeWorkloads(fence);
  });

  it("cannot release a copied, unjoined or another service's ticket", async () => {
    const f = await serviceFixture(), fence = f.service.fenceWorkloads("preserve");
    await expect(f.service.resumeWorkloads({ ...fence })).rejects.toThrow("request_rejected");
    await expect(f.service.resumeWorkloads(fence)).rejects.toThrow("request_rejected");
    const other = await serviceFixture();
    await expect(other.service.joinPendingWorkloads(fence)).rejects.toThrow("request_rejected");
    await f.service.joinPendingWorkloads(fence); await f.service.resumeWorkloads(fence);
  });

  it("reconciles a lost release ACK with the exact same operation/body without opening an overlap fence", async () => {
    const f = await serviceFixture();
    const idle = f.service.fenceWorkloads("drain"), seal = f.service.fenceWorkloads("drain");
    await f.service.drainWorkloads(idle);
    const implementation = f.raw.getMockImplementation()!;
    let lost = true;
    f.raw.mockImplementation(async value => {
      if (value.op === "resume-workloads" && lost) { lost = false; throw new Error("unknown ACK"); }
      return implementation(value);
    });
    await expect(f.service.resumeWorkloads(idle)).rejects.toThrow("unknown ACK");
    await f.service.resumeWorkloads(idle);
    await expect(f.service.create({ sessionId: "still-fenced", cwd: "/tmp", cols: 80, rows: 24, env: {} })).rejects.toThrow("host_unavailable");
    const release = f.raw.mock.calls.filter(([value]) => value.op === "resume-workloads");
    expect(release).toHaveLength(2); expect(release[0]).toEqual(release[1]);
    await f.service.drainWorkloads(seal); await f.service.resumeWorkloads(seal);
  });
});
