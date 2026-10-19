import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CloudRunnerNativeClient, verifyCloudRunnerManager } from "../cloud-runner-native";
import { cloudRunnerBaseSupported, cloudRunnerManagerEnvironment } from "../cloud-runner-manager.mjs";
import { cloudWorkloadKernelFixture, kernelProcess, identity, workload } from "./helpers/cloud-workload-kernel";
import type { CloudRunnerScope } from "../cloud-runner-contract";
import type { CloudWorkloadCustody } from "../cloud-workload-custody";

const boot = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const f = cloudWorkloadKernelFixture();
  const scope: Omit<CloudRunnerScope, "executionId"> = { version: 1, organizationId: boot, workspaceId: boot, generation: 1,
    engineInstanceId: boot, bootId: boot, writerEpoch: boot, runtimeId: `r1-${"a".repeat(64)}`,
    owner: { pid: 101, startToken: "1010" }, workload: { directory: workload, dev: "7", ino: "8" } };
  const group = `${workload}/runner-${boot}`, executable = { dev: "4", ino: "5" };
  f.groups.set(group, { identity: { ...identity("9"), dev: "7", mode: 0o700 }, pids: [] });
  const supervisor = { ...kernelProcess(301, workload), parent: 101 };
  const manager = { ...kernelProcess(302, `${group}/init.scope`), parent: 301, executable };
  for (const member of [supervisor, manager]) f.processes.set(member.pid, member);
  const proof = { version: 1 as const, launcher: { pid: 302, startToken: "3020" }, manager: { pid: 302, startToken: "3020" },
    group: { directory: group, dev: "7", ino: "9" }, executable };
  const expected = { scope, supervisor: { pid: 301, startToken: "3010" }, executable };
  return { ...f, scope, group, proof, expected, manager };
}
describe("private manager original kernel witness", () => {
  it("accepts the original launcher execed as manager with no process left in its cgroup root", () => {
    const f = fixture();
    expect(verifyCloudRunnerManager(f.proof, f.expected, f.io)).toEqual(f.proof);
    expect(f.groups.get(f.group)!.pids).toEqual([]);
    f.proof.launcher = { pid: 303, startToken: "3030" };
    expect(() => verifyCloudRunnerManager(f.proof, f.expected, f.io)).toThrow();
  });
  it("cross-checks the exact Host ancestry, manager executable and workload inode", () => {
    const f = fixture();
    expect(verifyCloudRunnerManager(f.proof, f.expected, f.io)).toEqual(f.proof);
  });
  it.each(["owner", "launcher", "pid-reuse", "parent", "binary", "foreign-cgroup", "replaced-cgroup", "permissions"])(
    "refuses %s evidence without accepting a self-reported hello", kind => {
      const f = fixture();
      if (kind === "owner") f.processes.set(301, { ...f.processes.get(301)!, parent: 102 });
      if (kind === "launcher") f.processes.set(302, { ...f.processes.get(302)!, startToken: "999" });
      if (kind === "pid-reuse") f.processes.set(302, { ...f.manager, startToken: "999" });
      if (kind === "parent") f.processes.set(302, { ...f.manager, parent: 101 });
      if (kind === "binary") f.processes.set(302, { ...f.manager, executable: { dev: "4", ino: "6" } });
      if (kind === "foreign-cgroup") f.processes.set(302, { ...f.manager, directory: "/sys/fs/cgroup/user.slice/init.scope" });
      if (kind === "replaced-cgroup") f.groups.get(f.group)!.identity = { ...f.groups.get(f.group)!.identity, ino: "10" };
      if (kind === "permissions") f.groups.get(f.group)!.identity = { ...f.groups.get(f.group)!.identity, mode: 0o755 };
      expect(() => verifyCloudRunnerManager(f.proof, f.expected, f.io)).toThrow("cloud_runner_native_unavailable");
    });
  it("contains no inherited credentials or ambient user unit/generator search", () => {
    const env = cloudRunnerManagerEnvironment("/tmp/zeros-runners-abcdef");
    expect(env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", USER: "zeros-engine", LOGNAME: "zeros-engine",
      XDG_RUNTIME_DIR: "/tmp/zeros-runners-abcdef", XDG_CONFIG_HOME: "/nonexistent", XDG_DATA_HOME: "/nonexistent",
      SYSTEMD_UNIT_PATH: "/usr/lib/zeros-runner", SYSTEMD_GENERATOR_PATH: "/usr/lib/zeros-runner/empty",
      SYSTEMD_ENVIRONMENT_GENERATOR_PATH: "/usr/lib/zeros-runner/empty", SYSTEMD_LOG_LEVEL: "err", SYSTEMD_LOG_TARGET: "null" });
    expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  });
  it("keeps absent old-base support legacy but rejects corrupt present support", () => {
    const content = JSON.stringify({ schema: "zeros.cloud-runner-base/v1", systemdMinimum: 254 });
    const fs = { openSync: vi.fn((_file: string, flags: number) => flags & constants.O_DIRECTORY ? 11 : 10), closeSync: vi.fn(),
      fstatSync: (fd: number) => ({ isFile: () => fd === 10, isDirectory: () => fd === 11, uid: 0,
        mode: fd === 10 ? 0o444 : 0o555, nlink: 1, size: Buffer.byteLength(content) }), readdirSync: () => [] as string[],
      realpathSync: (name: string) => name, readFileSync: vi.fn(() => content) };
    const absent = { ...fs, openSync: () => { throw Object.assign(new Error(), { code: "ENOENT" }); } };
    expect(cloudRunnerBaseSupported(absent)).toBe(false);
    expect(cloudRunnerBaseSupported(fs)).toBe(true);
    expect(fs.openSync).toHaveBeenCalledWith("/usr/lib/zeros-runner/support.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(fs.readFileSync).toHaveBeenCalledWith(10, "utf8");
    expect(fs.closeSync).toHaveBeenCalledWith(10);
    expect(() => cloudRunnerBaseSupported({ ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), uid: 10003 }) })).toThrow();
    expect(() => cloudRunnerBaseSupported({ ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), size: 1025 }) })).toThrow();
    expect(() => cloudRunnerBaseSupported({ ...fs, readdirSync: () => ["unexpected-generator"] })).toThrow();
    expect(() => cloudRunnerBaseSupported({ ...fs, readFileSync: () => '{"schema":"zeros.cloud-runner-base/v1","systemdMinimum":253}' })).toThrow();
  });
  it("keeps control IO owned until completion and rejects a late changed manager", async () => {
    const f = fixture();
    let settle!: (value: unknown) => void, live = true;
    const execute = vi.fn(() => new Promise(resolve => { settle = resolve; }));
    const client = new CloudRunnerNativeClient({ directory: "/tmp/zeros-runners-abcdef", scope: f.scope, proof: f.proof,
      custody: { assertLive() {} } as CloudWorkloadCustody,
      assertManager() { if (!live) throw new Error("lost manager"); }, execute });
    const intent = { version: 1 as const, attemptId: randomUUID(), scope: { ...f.scope, executionId: randomUUID() } };
    const inspection = client.inspect(intent), rejected = expect(inspection).rejects.toThrow();
    expect(client.pending).toBe(1);
    live = false; settle({ state: "running", proof: {} }); await rejected;
    expect(client.pending).toBe(0); expect(execute).toHaveBeenCalledOnce();
    await expect(client.inspect(intent)).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });
});
