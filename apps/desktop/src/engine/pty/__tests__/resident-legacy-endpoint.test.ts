import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResidentLegacyControlClient } from "../resident-client";

const fixed = "/run/zeros/resident-control.sock";
const metadata = vi.hoisted(() => ({ uid: 0n, gid: 10003n, mode: 0o140620n, nlink: 1n,
  dev: 7n, ino: 29n, ctimeNs: 41n, socket: true, parentUid: 10003n, parentGid: 10003n, parentMode: 0o40700n, canonical: true }));
vi.mock("node:fs", async load => {
  const original = await load<typeof import("node:fs")>();
  return { ...original,
    lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
      if (args[0] === "/run/zeros/resident-control.sock") return { ...metadata, isSocket: () => metadata.socket };
      if (args[0] === "/run/zeros") return { uid: metadata.parentUid, gid: metadata.parentGid,
        mode: metadata.parentMode, dev: 7n, ino: 11n, isDirectory: () => true };
      return original.lstatSync(...args);
    },
    realpathSync: (...args: Parameters<typeof original.realpathSync>) => args[0] === "/run/zeros"
      ? metadata.canonical ? "/run/zeros" : "/foreign" : original.realpathSync(...args),
  };
});
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { Object.assign(metadata, { uid: 0n, gid: 10003n, mode: 0o140620n, nlink: 1n,
  dev: 7n, ino: 29n, ctimeNs: 41n, socket: true, parentUid: 10003n, parentGid: 10003n, parentMode: 0o40700n, canonical: true }); });
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(beforeReply?: () => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "zeros-root-endpoint-")), socketPath = path.join(directory, "root.sock");
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 2, fence: 5, token: randomBytes(32).toString("base64url") };
  const runtime = { runtimeId: `r1-${"a".repeat(64)}`, bootId: randomUUID(), supervisorSessionId: randomUUID(),
    cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" };
  const hostId = randomUUID(), requestId = randomUUID();
  const receipt = { version: 1, operation: "retire-legacy-resident", requestId,
    source: { hostId, authority: { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
    runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
    scope: { directory: `${runtime.cgroupRoot}/engine-workload-${hostId}`, dev: "7", ino: "31" } },
    phase: "retired", proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required" };
  const supplied: string[] = [], sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8"); socket.on("data", chunk => {
      supplied.push(String(chunk)); beforeReply?.(); socket.end(JSON.stringify({ result: receipt }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const connect = net.createConnection;
  const opens = vi.spyOn(net, "createConnection").mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe(fixed); return connect(socketPath);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  });
  const client = new ResidentLegacyControlClient({ hostId, authority, runtime });
  return { client, requestId, receipt, supplied, opens, open: () => connect(socketPath) };
}

describe("fixed legacy root endpoint (explicit fake ownership with actual Unix transport)", () => {
  it.each([0n, 65534n])("pins the original root socket with projected owner %s", async uid => {
    metadata.uid = uid;
    const f = await fixture();
    expect(await f.client.retire(f.requestId)).toEqual(f.receipt); expect(f.supplied).toHaveLength(1);
  });

  it.each(["uid", "gid", "mode", "type", "links", "parent", "alias"])("refuses %s before sending private authority", async change => {
    const f = await fixture();
    if (change === "uid") metadata.uid = 10003n;
    if (change === "gid") metadata.gid = 10001n;
    if (change === "mode") metadata.mode = 0o140666n;
    if (change === "type") metadata.socket = false;
    if (change === "links") metadata.nlink = 2n;
    if (change === "parent") metadata.parentUid = 10001n;
    if (change === "alias") metadata.canonical = false;
    await expect(f.client.retire(f.requestId)).rejects.toThrow("host_unavailable");
    expect(f.opens).not.toHaveBeenCalled(); expect(f.supplied).toHaveLength(0);
  });

  it("refuses original socket replacement across the connect await before token send", async () => {
    const f = await fixture();
    f.opens.mockImplementation((...args: unknown[]) => { expect(args[0]).toBe(fixed); const socket = f.open(); metadata.ino++; return socket; });
    await expect(f.client.retire(f.requestId)).rejects.toThrow("host_unavailable");
    expect(f.supplied).toHaveLength(0);
  });

  it("refuses a replaced root socket before accepting a schema-matched retirement receipt", async () => {
    const f = await fixture(() => { metadata.ctimeNs++; });
    await expect(f.client.retire(f.requestId)).rejects.toThrow("host_unavailable");
    expect(f.supplied).toHaveLength(1);
  });
});
