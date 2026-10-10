import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudLegacyResidentControl } from "../cloud-workspace-validation/sandbox/cloud-resident-control.mjs";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { ResidentLegacyControlClient } from "../../apps/desktop/src/engine/pty/resident-client";
import { residentLegacyRetirementReceiptMatchesRequest } from "../../apps/desktop/src/engine/pty/resident-protocol";

function fixture(modern = false, maxRequests = 16) {
  const tree = cloudRuntimeFixture();
  const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
  const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
  const authority = { organizationId, workspaceId, engineId: randomUUID(), generation: 2, fence: 9,
    token: randomBytes(32).toString("base64url") };
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null,
    signalCode: null as string | null, stdin: new PassThrough(), stdout: new PassThrough(), unref: vi.fn() });
  child.stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0); });
  let present = true, populated = true, inode = "21", birth = "123";
  const directory = `${runtime.cgroupRoot}/${modern ? "engine-runtime/" : ""}engine-workload-${hostId}`;
  const io = { exists: vi.fn(() => present), identity: vi.fn(() => {
    if (!present) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { directory, dev: "0", ino: inode };
  }), write: vi.fn((_directory: string, name: string) => { if (name === "cgroup.kill") populated = false; }),
  read: vi.fn(() => `populated ${populated ? 1 : 0}\nfrozen 0`), remove: vi.fn(() => { present = false; }),
  children: vi.fn(() => []) };
  const resident = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId,
    readBirth: () => ({ pid: child.pid, startToken: birth, parentPid: 17 }), removeServices: vi.fn() });
  resident.scope = new CloudEngineCgroup({ runtime, directory, io });
  Object.assign(resident, { child, ownerBirth: { pid: child.pid, startToken: birth }, healthy: true,
    authority: { organizationId, workspaceId, engineId: authority.engineId, generation: authority.generation, fence: authority.fence },
    fence: authority.fence });
  let current: { resident: CloudResidentWorkload; authority: typeof authority } | null = { resident, authority };
  const assertEngine = vi.fn((value: typeof authority) => {
    if (JSON.stringify(value) !== JSON.stringify(authority)) throw new Error("engine authority changed");
  });
  const clearResident = vi.fn((original: CloudResidentWorkload) => {
    if (current?.resident !== original) throw new Error("resident replaced");
    current = null;
  });
  const serialize = vi.fn(async (operation: () => Promise<unknown>) => operation());
  const control = new CloudLegacyResidentControl({ current: () => current, assertEngine, clearResident, serialize, maxRequests });
  const request = { version: 1 as const, operation: "retire-legacy-resident" as const, requestId: randomUUID(), hostId, authority };
  return { tree, runtime, control, request, resident, child, io, assertEngine, clearResident, directory,
    changeInode: () => { inode = "22"; }, changeBirth: () => { birth = "124"; },
    replace: () => { current = { resident: new CloudResidentWorkload({ runtime, hostId: randomUUID(), organizationId, workspaceId }), authority }; },
  };
}

describe("root original dedicated legacy resident control (explicit fake kernel IO)", () => {
  it("commits exact positive leaf/launcher proof before clearing and replays lost ACK without another kill", async () => {
    const f = fixture();
    try {
      const receipt = await f.control.request(f.request);
      expect(receipt).toEqual({ version: 1, operation: f.request.operation, requestId: f.request.requestId,
        source: { hostId: f.request.hostId, authority: f.resident.authority,
          runtime: { runtimeId: f.runtime.runtimeId, bootId: f.runtime.bootId, supervisorSessionId: f.runtime.supervisorSessionId },
          scope: { directory: f.directory, dev: "0", ino: "21" } },
        phase: "retired", proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required" });
      expect(JSON.stringify(receipt)).not.toContain(f.request.authority.token);
      expect(f.child.exitCode).toBe(0); expect(f.io.remove).toHaveBeenCalledOnce();
      expect(f.clearResident.mock.invocationCallOrder[0]).toBeGreaterThan(f.io.remove.mock.invocationCallOrder[0]!);
      f.replace();
      expect(await f.control.request(f.request)).toEqual(receipt);
      expect(f.io.write).toHaveBeenCalledOnce(); expect(f.clearResident).toHaveBeenCalledOnce();
      expect(Object.isFrozen(receipt)).toBe(true);
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it("refuses modern controller leaf emptiness as shared-pool PTY proof", async () => {
    const f = fixture(true);
    try {
      await expect(f.control.request(f.request)).rejects.toThrow("legacy_resident_control_refused");
      expect(f.io.write).not.toHaveBeenCalled(); expect(f.clearResident).not.toHaveBeenCalled();
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it("authenticates the issued private token, exact operation and body before any effect", async () => {
    const f = fixture();
    try {
      for (const request of [ { ...f.request, authority: { ...f.request.authority, token: randomBytes(32).toString("base64url") } },
        { ...f.request, operation: "retire-shared-pool" }, { ...f.request, pid: f.child.pid },
        { ...f.request, hostId: randomUUID() } ]) {
        await expect(f.control.request(request)).rejects.toThrow("legacy_resident_control_refused");
      }
      expect(f.io.write).not.toHaveBeenCalled(); expect(f.clearResident).not.toHaveBeenCalled();
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it.each(["inode", "birth", "engine"])("refuses %s replacement across authorization await", async change => {
    const f = fixture();
    try {
      f.assertEngine.mockImplementationOnce(() => {
        if (change === "inode") f.changeInode();
        if (change === "birth") f.changeBirth();
        if (change === "engine") f.replace();
      });
      await expect(f.control.request(f.request)).rejects.toThrow("legacy_resident_control_refused");
      expect(f.io.write).not.toHaveBeenCalled(); expect(f.clearResident).not.toHaveBeenCalled();
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it("retains failed proof and never clears a resident on an unknown retirement result", async () => {
    const f = fixture();
    try {
      f.io.write.mockImplementation(() => { throw new Error("kernel kill failed"); });
      await expect(f.control.request(f.request)).rejects.toThrow("legacy_resident_retirement_failed");
      expect(f.clearResident).not.toHaveBeenCalled();
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it("rejects changed same-ID body and bounded overflow without clearing a successor", async () => {
    const f = fixture(false, 1);
    try {
      await f.control.request(f.request);
      await expect(f.control.request({ ...f.request, authority: { ...f.request.authority, fence: 10 } })).rejects.toThrow("legacy_resident_control_refused");
      f.replace();
      await expect(f.control.request({ ...f.request, requestId: randomUUID() })).rejects.toThrow("legacy_resident_control_refused");
      expect(f.clearResident).toHaveBeenCalledOnce();
    } finally { await f.control.close(); f.tree.dispose(); }
  });

  it("round-trips the actual paired strict client over a root-owned Unix listener", async () => {
    const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), "zeros-root-control-"));
    try {
      const socketPath = path.join(directory, "root.sock"); await f.control.listen({ socketPath });
      const client = new ResidentLegacyControlClient({ socketPath, hostId: f.request.hostId,
        authority: f.request.authority, runtime: f.runtime });
      const result = await client.retire(f.request.requestId);
      expect(residentLegacyRetirementReceiptMatchesRequest(result, f.request, f.runtime)).toBe(true);
      expect(f.clearResident).toHaveBeenCalledOnce();
      expect(await client.retire(f.request.requestId)).toEqual(result);
      expect(f.io.write).toHaveBeenCalledOnce();
    } finally { await f.control.close(); f.tree.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it("joins an original root flight after socket loss and never repeats its physical effects", async () => {
    const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), "zeros-root-control-"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.assertEngine.mockImplementationOnce(async () => { await gate; });
    try {
      const socketPath = path.join(directory, "root.sock"); await f.control.listen({ socketPath });
      const socket = net.createConnection(socketPath); socket.on("error", () => {});
      await new Promise<void>(resolve => socket.once("connect", resolve));
      socket.write(JSON.stringify(f.request) + "\n");
      await expect.poll(() => f.assertEngine.mock.calls.length).toBe(1);
      socket.destroy();
      let closed = false;
      const closing = f.control.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false); expect(f.clearResident).not.toHaveBeenCalled();
      release(); await closing;
      expect(f.clearResident).toHaveBeenCalledOnce(); expect(f.io.write).toHaveBeenCalledOnce();
    } finally { release(); await f.control.close(); f.tree.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it("uses a bounded retirement response deadline after the separate frame-read deadline", async () => {
    const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), "zeros-root-control-"));
    const timeouts = vi.spyOn(net.Socket.prototype, "setTimeout");
    try {
      const socketPath = path.join(directory, "root.sock"); await f.control.listen({ socketPath });
      const client = new ResidentLegacyControlClient({ socketPath, hostId: f.request.hostId,
        authority: f.request.authority, runtime: f.runtime });
      await client.retire(f.request.requestId);
      expect(timeouts).toHaveBeenCalledWith(30_000, expect.any(Function));
      expect(timeouts).toHaveBeenCalledWith(5_000, expect.any(Function));
    } finally { timeouts.mockRestore(); await f.control.close(); f.tree.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
