import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureCloudWorkerSupervisor } from "../cloud-workspace-validation/sandbox/ensure-cloud-worker-supervisor.mjs";
import {
  CloudWorkerSupervisor,
  parseCloudWorkerSupervisorRequest,
  CLOUD_WORKER_SUPERVISOR_AUDIENCE,
} from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

describe("cloud broker resume and ownership", () => {
  it("leaves a healthy broker and its admitted work running", async () => {
    const launch = vi.fn();
    await ensureCloudWorkerSupervisor({ probe: async () => true, launch });
    expect(launch).not.toHaveBeenCalled();
  });
  it("starts only one candidate and waits for positive readiness after cold resume", async () => {
    const launch = vi.fn();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await ensureCloudWorkerSupervisor({ probe, launch, wait: async () => {} });
    expect(launch).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it("bounds an uncertain startup without launching repeated candidates", async () => {
    const launch = vi.fn();
    await expect(
      ensureCloudWorkerSupervisor({
        probe: async () => false,
        launch,
        wait: async () => {},
      }),
    ).rejects.toThrow(/unconfirmed/);
    expect(launch).toHaveBeenCalledOnce();
  });
  it("answers a read-only readiness probe without retiring the current engine", async () => {
    const supervisor = new CloudWorkerSupervisor();
    supervisor.session = "retained-session";
    expect(
      parseCloudWorkerSupervisorRequest({
        version: 1,
        audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "status",
      }),
    ).toEqual({
      version: 1,
      audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
      operation: "status",
    });
    await expect(
      supervisor.apply({ operation: "status" }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(supervisor.session).toBe("retained-session");
  });

  const rootAvailable =
    process.platform === "linux" &&
    spawnSync("sudo", ["-n", "/usr/bin/true"]).status === 0;
  it.skipIf(!rootAvailable)(
    "refuses a second broker without unlinking the live endpoint and allows a clean restart",
    () => {
      const module = pathToFileURL(
        resolve(
          "scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs",
        ),
      ).href;
      const source = `
      import {mkdtempSync,lstatSync,rmSync} from 'node:fs';
      import {CloudWorkerSupervisor} from ${JSON.stringify(module)};
      const directory=mkdtempSync('/tmp/zeros-broker-lock-');
      const socketPath=directory+'/broker.sock';
      const first=new CloudWorkerSupervisor({socketPath});
      const second=new CloudWorkerSupervisor({socketPath});
      try {
        await first.start(); const inode=lstatSync(socketPath).ino;
        let rejected=false; try {await second.start();} catch {rejected=true;}
        if (!rejected || lstatSync(socketPath).ino!==inode) throw new Error('live broker endpoint replaced');
        await first.stop();
        const recovered=new CloudWorkerSupervisor({socketPath});
        await recovered.start(); await recovered.stop();
      } finally { await first.stop(); await second.stop(); rmSync(directory,{recursive:true,force:true}); }
    `;
      const result = spawnSync(
        "sudo",
        ["-n", process.execPath, "--input-type=module", "-e", source],
        { encoding: "utf8", timeout: 10000 },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});
