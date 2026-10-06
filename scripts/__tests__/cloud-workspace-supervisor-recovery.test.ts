import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureCloudWorkerSupervisor } from "../cloud-workspace-validation/sandbox/ensure-cloud-worker-supervisor.mjs";
import {createCloudRuntimeResolver} from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import {cloudRuntimeFixture} from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import {
  CloudWorkerSupervisor,
  parseCloudWorkerSupervisorRequest,
  CLOUD_WORKER_SUPERVISOR_AUDIENCE,
} from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

describe("cloud runtime activation", () => {
  function fixture() {
    const tree = cloudRuntimeFixture();
    const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
    const active = { ...tree.descriptor, runtimeId: `r1-${"d".repeat(64)}`,
      root: `/opt/zeros-infra/r1-${"d".repeat(64)}`, manifestSha256: "d".repeat(64),
      supervisorSessionId: "32345678-1234-4234-8234-123456789abc" };
    const verifySelectedRuntime = vi.fn(() => active);
    const retire = vi.fn(async () => {});
    const supervisor = new CloudWorkerSupervisor({ runtime, verifySelectedRuntime, engineScope: { retire } });
    return { tree, runtime, active, verifySelectedRuntime, retire, supervisor };
  }

  it("accepts only an exact root activation request, never an arbitrary launcher", () => {
    const f = fixture();
    try {
      const request = { version: 1, audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "select-runtime", session: `zsp_${"S".repeat(43)}`, active: f.active };
      expect(parseCloudWorkerSupervisorRequest(request)).toEqual(request);
      for (const invalid of [ { ...request, command: "/tmp/launcher" },
        { ...request, active: { ...f.active, root: "/tmp/runtime" } },
        { ...request, session: "stale" } ]) expect(parseCloudWorkerSupervisorRequest(invalid)).toBeNull();
    } finally { f.tree.dispose(); }
  });

  it("keeps the resident controller identity while selecting the new engine", async () => {
    const f = fixture();
    try {
      const prepared = await f.supervisor.apply({ operation: "prepare" });
      expect(await f.supervisor.apply({ operation: "select-runtime", session: prepared.session,
        active: f.active })).toMatchObject({ outcome: "selected" });
      expect(f.verifySelectedRuntime).toHaveBeenCalledWith(f.active);
      expect(f.retire).toHaveBeenCalledOnce();
      expect(f.supervisor.runtime).toBe(f.runtime);
      expect(f.supervisor.launcher).toBe(`${f.active.root}/bin/start-engine.sh`);
      expect(await f.supervisor.apply({ operation: "update-status" })).toMatchObject({
        outcome: "ready", controller: f.tree.descriptor, selected: f.active,
      });
    } finally { f.tree.dispose(); }
  });

  it("rejects a stale session or live child before verification", async () => {
    const f = fixture();
    try {
      const prepared = await f.supervisor.apply({ operation: "prepare" });
      expect(await f.supervisor.apply({ operation: "select-runtime", session: "stale",
        active: f.active })).toMatchObject({ outcome: "rejected" });
      f.supervisor.child = { exitCode: null, signalCode: null };
      expect(await f.supervisor.apply({ operation: "select-runtime", session: prepared.session,
        active: f.active })).toMatchObject({ outcome: "rejected" });
      expect(f.verifySelectedRuntime).not.toHaveBeenCalled();
    } finally { f.tree.dispose(); }
  });

  it.each([
    ["baseCompatibilityId", `bc1-${"e".repeat(64)}`],
    ["bootId", "42345678-1234-4234-8234-123456789abc"],
    ["cgroupRoot", "/sys/fs/cgroup/other.slice/zeros-host.service"],
  ])("rejects a forged matching request when the verified %s differs", async (key, value) => {
    const f = fixture();
    try {
      const prepared = await f.supervisor.apply({ operation: "prepare" });
      f.verifySelectedRuntime.mockReturnValue({ ...f.active, [key]: value });
      expect(f.active[key]).toBe(f.runtime[key]);
      expect(await f.supervisor.apply({ operation: "select-runtime", session: prepared.session,
        active: f.active })).toMatchObject({ outcome: "rejected" });
      expect(f.verifySelectedRuntime).toHaveBeenCalledWith(f.active);
      expect(f.supervisor.selectedRuntime).toEqual(f.tree.descriptor);
      expect(f.supervisor.launcher).toBe(f.runtime.startEngine);
    } finally { f.tree.dispose(); }
  });

  it("retains the old launch selection on verification failure and rejects legacy hosts", async () => {
    const f = fixture();
    try {
      const prepared = await f.supervisor.apply({ operation: "prepare" });
      f.verifySelectedRuntime.mockImplementation(() => { throw new Error("verification failed"); });
      await expect(f.supervisor.apply({ operation: "select-runtime", session: prepared.session,
        active: f.active })).rejects.toThrow("verification failed");
      expect(f.supervisor.launcher).toBe(f.runtime.startEngine);
      const legacy = new CloudWorkerSupervisor();
      expect(await legacy.apply({ operation: "update-status" })).toMatchObject({ outcome: "rejected" });
    } finally { f.tree.dispose(); }
  });
});

describe("cloud broker resume and ownership", () => {
  it("requires systemd ownership on v4 even when a broker is already healthy",async()=>{
    const tree=cloudRuntimeFixture();
    try {
      const runtime=createCloudRuntimeResolver({filesystem:tree.filesystem}).resolve();
      const launch=vi.fn(),probe=vi.fn(async()=>true);
      await expect(ensureCloudWorkerSupervisor({runtime,launch,probe})).rejects.toThrow(/systemd/);
      expect(launch).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();
    } finally {tree.dispose();}
  });
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
