import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentLegacyControlClient } from "../resident-client";
import { ResidentLegacyRetirementRequestSchema, ResidentLegacyRetirementReceiptSchema,
  residentLegacyRetirementReceiptMatchesRequest } from "../resident-protocol";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

function source() {
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 2, fence: 5, token: randomBytes(32).toString("base64url") };
  const runtime = { runtimeId: `r1-${"a".repeat(64)}`, bootId: randomUUID(), supervisorSessionId: randomUUID(),
    cgroupRoot: "/sys/fs/cgroup/zeros-cloud-engine" };
  const request = { version: 1 as const, operation: "retire-legacy-resident" as const,
    requestId: randomUUID(), hostId: randomUUID(), authority };
  const receipt = { version: 1 as const, operation: request.operation, requestId: request.requestId,
    source: { hostId: request.hostId, authority: { organizationId: authority.organizationId,
      workspaceId: authority.workspaceId, engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
      runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
      scope: { directory: `${runtime.cgroupRoot}/engine-workload-${request.hostId}`, dev: "29", ino: "301" } },
    phase: "retired" as const, proof: { kind: "dedicated-resident-cgroup" as const, populated: 0 as const },
    replacement: "fresh-view-required" as const };
  return { authority, runtime, request, receipt };
}

async function server(handle: (body: unknown, socket: net.Socket) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-resident-root-")), socketPath = path.join(directory, "root.sock");
  const sockets = new Set<net.Socket>();
  const instance = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8"); let bytes = "";
    socket.on("data", chunk => { bytes += chunk; const end = bytes.indexOf("\n");
      if (end >= 0) handle(JSON.parse(bytes.slice(0, end)), socket); });
  });
  await new Promise<void>((resolve, reject) => { instance.once("error", reject); instance.listen(socketPath, resolve); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => instance.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return socketPath;
}

describe("private dedicated legacy resident control contract", () => {
  it("bounds the immutable operation and matches only original source provenance", () => {
    const f = source();
    expect(ResidentLegacyRetirementRequestSchema.parse(f.request)).toEqual(f.request);
    expect(ResidentLegacyRetirementReceiptSchema.parse(f.receipt)).toEqual(f.receipt);
    expect(residentLegacyRetirementReceiptMatchesRequest(f.receipt, f.request, f.runtime)).toBe(true);
    for (const changed of [{ ...f.request, pid: 17 }, { ...f.request, operation: "kill-shared-workload" },
      { ...f.request, authority: { ...f.authority, directory: f.runtime.cgroupRoot } }])
      expect(ResidentLegacyRetirementRequestSchema.safeParse(changed).success).toBe(false);
    for (const changed of [{ ...f.receipt, requestId: randomUUID() },
      { ...f.receipt, source: { ...f.receipt.source, hostId: randomUUID() } },
      { ...f.receipt, source: { ...f.receipt.source, authority: { ...f.receipt.source.authority, fence: 6 } } },
      { ...f.receipt, source: { ...f.receipt.source, runtime: { ...f.receipt.source.runtime, bootId: randomUUID() } } },
      { ...f.receipt, source: { ...f.receipt.source, scope: { ...f.receipt.source.scope,
        directory: `${f.runtime.cgroupRoot}/engine-runtime/engine-workload-${f.request.hostId}` } } },
      { ...f.receipt, proof: { kind: "owner-process-groups", populated: 0 } },
      { ...f.receipt, proof: { kind: "dedicated-resident-cgroup", populated: 1 } },
      { ...f.receipt, replacement: { pid: 21 } }, { ...f.receipt, token: f.authority.token }])
      expect(residentLegacyRetirementReceiptMatchesRequest(changed, f.request, f.runtime)).toBe(false);
  });

  it("sends only the frozen original body and accepts a bounded exact root receipt", async () => {
    const f = source(); let supplied: unknown;
    const socketPath = await server((body, socket) => { supplied = body; socket.end(JSON.stringify({ result: f.receipt }) + "\n"); });
    const client = new ResidentLegacyControlClient({ socketPath, hostId: f.request.hostId, authority: f.authority, runtime: f.runtime });
    const result = await client.retire(f.request.requestId);
    expect(supplied).toEqual(f.request); expect(result).toEqual(f.receipt);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.source.scope)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.authority.token);
  });

  it.each(["unmatched", "extra-frame", "overflow", "error", "closed"])("refuses %s response without substituting emptiness", async kind => {
    const f = source();
    const socketPath = await server((_body, socket) => {
      if (kind === "closed") { socket.destroy(); return; }
      if (kind === "error") { socket.end(JSON.stringify({ error: { code: "legacy_resident_retirement_failed" } }) + "\n"); return; }
      if (kind === "overflow") { socket.end("x".repeat(4097) + "\n"); return; }
      const result = kind === "unmatched" ? { ...f.receipt, requestId: randomUUID() } : f.receipt;
      socket.end(JSON.stringify({ result }) + "\n" + (kind === "extra-frame" ? "{}\n" : ""));
    });
    const client = new ResidentLegacyControlClient({ socketPath, hostId: f.request.hostId, authority: f.authority, runtime: f.runtime });
    await expect(client.retire(f.request.requestId)).rejects.toThrow("host_unavailable");
  });

  it("rejects malformed request identity before opening a root socket", async () => {
    const f = source();
    const client = new ResidentLegacyControlClient({ socketPath: "/unused", hostId: f.request.hostId, authority: f.authority, runtime: f.runtime });
    await expect(client.retire("invalid")).rejects.toThrow("request_rejected");
  });
});
