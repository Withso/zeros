import {randomBytes, randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {ResidentPtyClient} from "../resident-client";
import {ResidentTerminalService} from "../resident-service";
import type {ResidentWorkloadCensusRequest} from "../resident-protocol";

function fixture() {
  const authority = {organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 1, fence: 2, token: randomBytes(32).toString("base64url")};
  const census: ResidentWorkloadCensusRequest = {version: 1, requestId: randomUUID(), censusSha256: "a".repeat(64),
    common: {directory: "/sys/fs/cgroup/zeros/engine-runtime", dev: "29", ino: "303"}};
  const visibleAuthority = {organizationId: authority.organizationId, workspaceId: authority.workspaceId,
    engineId: authority.engineId, generation: authority.generation, fence: authority.fence};
  const reply = {...census, authority: visibleAuthority, owner: {pid: 100, startToken: "90"},
    complete: true, pendingLaunches: 0, failedRetirements: 0, quietTerminals: []};
  const client = new ResidentPtyClient({socketPath: "/unused", authority});
  const request = vi.spyOn(client as unknown as {request(value: unknown): Promise<unknown>}, "request").mockResolvedValue(reply);
  return {authority, census, reply, client, request};
}

async function attachedService() {
  const f = fixture();
  const service = new ResidentTerminalService({hostId: randomUUID(), socketPath: "/unused", authority: f.authority});
  const owner = service["client"];
  vi.spyOn(owner, "connect").mockResolvedValue();
  vi.spyOn(owner, "isConnected").mockReturnValue(true);
  vi.spyOn(owner, "list").mockResolvedValue([]);
  await service.connect();
  return {...f, service, owner};
}

describe("resident owner classification transport", () => {
  it("sends only the exact typed census and returns strict detached facts", async () => {
    const f = fixture();
    const result = await f.client.classifyWorkloads(f.census);
    expect(f.request).toHaveBeenCalledExactlyOnceWith({op: "classify-workloads", census: f.census});
    expect(result).toEqual(f.reply);
    expect(result).not.toBe(f.reply);
    expect(result.authority).not.toHaveProperty("token");
  });
  it.each(["request", "census", "authority", "tree", "extra"])("rejects a conflicting %s response", async field => {
    const f = fixture();
    const changed = field === "request" ? {...f.reply, requestId: randomUUID()}
      : field === "census" ? {...f.reply, censusSha256: "b".repeat(64)}
      : field === "authority" ? {...f.reply, authority: {...f.reply.authority, fence: 3}}
      : field === "tree" ? {...f.reply, common: {...f.reply.common, ino: "304"}}
      : {...f.reply, processIds: [100]};
    f.request.mockResolvedValue(changed);
    await expect(f.client.classifyWorkloads(f.census)).rejects.toThrow("request_rejected");
  });
  it("rejects malformed input before any authenticated request", async () => {
    const f = fixture();
    await expect(f.client.classifyWorkloads({...f.census, censusSha256: "foreign"})).rejects.toThrow("request_rejected");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("captures the census identity before an async reply", async () => {
    const f = fixture();
    let finish!: () => void;
    f.request.mockImplementation(() => new Promise(resolve => {finish = () => resolve(f.reply);}));
    const supplied = {...f.census, common: {...f.census.common}};
    const reading = f.client.classifyWorkloads(supplied);
    supplied.requestId = randomUUID(); supplied.common.ino = "304";
    finish();
    expect(await reading).toEqual(f.reply);
  });
  it("keeps an incomplete correlated owner response explicitly incomplete", async () => {
    const f = fixture();
    f.request.mockResolvedValue({...f.reply, complete: false, pendingLaunches: 1});
    expect(await f.client.classifyWorkloads(f.census)).toMatchObject({complete: false, pendingLaunches: 1});
  });
  it("rejects a service reply after the original attachment retires", async () => {
    const f = await attachedService(), {service, owner} = f;
    let finish!: () => void;
    vi.spyOn(owner, "classifyWorkloads").mockImplementation(() => new Promise(resolve => {finish = () => resolve(f.reply);}));
    const reading = service.classifyWorkloads(f.census);
    const rejected = expect(reading).rejects.toThrow("host_unavailable");
    service.disconnect(); finish(); await rejected;
  });
  it("rejects a classification when an original resident operation starts during the reply", async () => {
    const f = await attachedService();
    let finish!: () => void, resized!: () => void;
    vi.spyOn(f.owner, "classifyWorkloads").mockImplementation(() => new Promise(resolve => {finish = () => resolve(f.reply);}));
    vi.spyOn(f.owner, "resize").mockImplementation(() => new Promise(resolve => {resized = resolve;}));
    const reading = f.service.classifyWorkloads(f.census);
    const rejected = expect(reading).rejects.toThrow("host_unavailable");
    const operation = f.service.resize("original-session", 80, 24);
    finish(); await rejected; resized(); await operation; f.service.disconnect();
  });
  it("does not request a quiet classification during a pending original operation", async () => {
    const f = await attachedService();
    let resized!: () => void;
    const classify = vi.spyOn(f.owner, "classifyWorkloads").mockResolvedValue(f.reply);
    vi.spyOn(f.owner, "resize").mockImplementation(() => new Promise(resolve => {resized = resolve;}));
    const operation = f.service.resize("original-session", 80, 24);
    await expect(f.service.classifyWorkloads(f.census)).rejects.toThrow("host_unavailable");
    expect(classify).not.toHaveBeenCalled(); resized(); await operation; f.service.disconnect();
  });
});
