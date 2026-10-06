import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

describe("resident workload launcher ownership", () => {
  it("keeps engine authority off argv and drains the workload scope after a host crash", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null,
        signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), unref: vi.fn() });
      const spawnProcess = vi.fn(() => child);
      const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
      const host = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId, spawnProcess });
      const retire = vi.spyOn(host.scope, "retire").mockResolvedValue(undefined);
      let acknowledge = true;
      child.stdin.on("data", chunk => {
        const request = JSON.parse(String(chunk));
        if (acknowledge) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\n"));
      });
      await host.start("synthetic-runtime-identity");
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
      acknowledge = false;
      const pending = host.witness(); const rejected = expect(pending).rejects.toThrow(/unavailable/);
      child.exitCode = 125; child.emit("exit", 125);
      await rejected;
      await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
      await host.stop();
      expect(retire).toHaveBeenCalledOnce();
      expect(child.stdin.destroyed).toBe(true);
    } finally { tree.dispose(); }
  });
});
