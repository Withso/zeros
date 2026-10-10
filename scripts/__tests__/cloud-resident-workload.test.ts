import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

describe("resident workload launcher ownership", () => {
  it("retires the original controller if its birth cannot be read after spawn", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const child = Object.assign(new ChildProcess(), { pid: 12345, exitCode: 125,
        signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), unref: vi.fn() });
      const removeServices = vi.fn();
      const host = new CloudResidentWorkload({ runtime, hostId: randomUUID(),
        organizationId: randomUUID(), workspaceId: randomUUID(), spawnProcess: () => child,
        removeServices, readBirth: () => { throw new Error("original birth unavailable"); } });
      const retire = vi.spyOn(host.scope, "retire").mockResolvedValue(undefined);
      await expect(host.start("synthetic-runtime-identity")).rejects.toThrow("original birth unavailable");
      expect(retire).toHaveBeenCalledOnce();
      expect(removeServices).toHaveBeenCalledOnce();
      expect(child.stdin.destroyed).toBe(true);
      expect(() => host.rootCustody()).toThrow(/unavailable/);
    } finally { tree.dispose(); }
  });
  it("keeps engine authority off argv and drains the workload scope after a host crash", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const child = Object.assign(new ChildProcess(), { pid: 12345, exitCode: null as number | null,
        signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), unref: vi.fn() });
      const spawnProcess = vi.fn(() => child);
      const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
      const removeServices = vi.fn();
      const originalOwner = { pid: 12345, parentPid: 17, startToken: "123" };
      const scope = { directory: `${runtime.cgroupRoot}/engine-runtime/engine-workload-${hostId}`, dev: "0", ino: "21" };
      const rootRecord = { version: 1, episode: randomUUID(), runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId }, scope,
        owner: { pid: originalOwner.pid, startToken: originalOwner.startToken }, birth: { kind: "resident", pid: 23456, startToken: "234" } };
      const readCustody = vi.fn(() => rootRecord), readBirth = vi.fn(() => originalOwner);
      const host = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId, spawnProcess, removeServices, readCustody, readBirth });
      vi.spyOn(host.scope, "currentIdentity", "get").mockReturnValue(scope);
      const retire = vi.spyOn(host.scope, "retire").mockResolvedValue(undefined);
      let acknowledge = true;
      child.stdin.on("data", chunk => {
        const request = JSON.parse(String(chunk));
        if (acknowledge) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\n"));
      });
      await host.start("synthetic-runtime-identity");
      expect(readBirth).toHaveBeenCalledExactlyOnceWith(child.pid);
      expect(host.rootCustody()).toEqual(rootRecord);
      expect(readCustody).toHaveBeenCalledWith(expect.objectContaining({ owner: rootRecord.owner, scope }));
      const authority = { organizationId, workspaceId, engineId: randomUUID(), generation: 1,
        fence: 1, token: randomBytes(32).toString("base64url") };
      await host.enroll(authority);
      const call = spawnProcess.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(call[1]).toEqual([`${runtime.libRoot}/cloud-engine-launcher.mjs`, "--resident"]);
      expect(Object.keys(call[2].env).sort()).toEqual(["HOME", "LANG", "PATH", "ZEROS_CLOUD_RUNTIME_B64", "ZEROS_RESIDENT_HOST_ID"]);
      expect(Object.hasOwn(await host.witness(), "token")).toBe(false);
      await expect(host.enroll({ ...authority, workspaceId: randomUUID(), fence: 2 })).rejects.toThrow(/authority/);
      await host.detach({ hostId, engineId: authority.engineId, fence: 1 });
      expect((await host.witness()).fence).toBe(2);
      readCustody.mockImplementationOnce(() => { throw new Error("original resident replaced"); });
      expect(() => host.rootCustody()).toThrow(/replaced/);
      acknowledge = false;
      const pending = host.witness(); const rejected = expect(pending).rejects.toThrow(/unavailable/);
      child.exitCode = 125; child.emit("exit", 125);
      await rejected;
      await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
      await host.stop();
      expect(retire).toHaveBeenCalledOnce();
      expect(removeServices).toHaveBeenCalledExactlyOnceWith(hostId);
      expect(removeServices.mock.invocationCallOrder[0]).toBeGreaterThan(retire.mock.invocationCallOrder[0]!);
      expect(child.stdin.destroyed).toBe(true);
    } finally { tree.dispose(); }
  });
});
