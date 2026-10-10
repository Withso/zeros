// Actual native cgroup IO with explicit fake filesystem metadata; no kernel controls are mutated.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  directories: new Map<string, { uid: number; ino: number }>(),
  controls: new Map<string, { uid: number; value: string }>(),
  descriptors: new Map<number, { path: string; offset: number }>(),
  nextFd: 3000, writes: [] as Array<[string, string]>,
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const missing = () => { throw Object.assign(new Error("missing fixture kernel entry"), { code: "ENOENT" }); };
  const metadata = (file: string, options?: { bigint?: boolean }) => {
    const directory = state.directories.get(file), control = state.controls.get(file);
    if (!directory && !control) return missing();
    const number = (n: number) => options?.bigint ? BigInt(n) : n;
    return { uid: number((directory ?? control)!.uid), gid: number((directory ?? control)!.uid),
      ino: number(directory?.ino ?? 900), dev: number(1), mode: number(directory ? 0o755 : 0o644), nlink: number(1),
      isDirectory: () => !!directory, isFile: () => !!control, isSymbolicLink: () => false };
  };
  return { ...fs,
    realpathSync: (file: string) => file,
    statfsSync: () => ({ type: 0x63677270 }),
    lstatSync: metadata,
    openSync: (file: string) => {
      if (!state.controls.has(file) && !state.directories.has(file)) return missing();
      const fd = ++state.nextFd; state.descriptors.set(fd, { path: file, offset: 0 }); return fd;
    },
    fstatSync: (fd: number) => metadata(state.descriptors.get(fd)!.path),
    closeSync: (fd: number) => state.descriptors.delete(fd),
    readSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
      const entry = state.descriptors.get(fd)!, source = Buffer.from(state.controls.get(entry.path)!.value);
      const count = source.copy(buffer, offset, entry.offset, Math.min(source.length, entry.offset + length));
      entry.offset += count; return count;
    },
    writeSync: (fd: number, value: string) => {
      const file = state.descriptors.get(fd)!.path; state.writes.push([file, value]);
      if (file.endsWith("/cgroup.kill")) for (const [key, control] of state.controls)
        if (key.endsWith("/cgroup.events")) control.value = "populated 0\nfrozen 0\n";
      return Buffer.byteLength(value);
    },
    readdirSync: (directory: string) => [...state.directories.keys()]
      .filter(file => file.startsWith(directory + "/") && !file.slice(directory.length + 1).includes("/"))
      .map(file => ({ name: file.slice(directory.length + 1), isDirectory: () => true })),
    rmdirSync: (directory: string) => { state.directories.delete(directory); },
  };
});
import { CloudEngineCgroup, CloudRuntimeCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { CloudResidentWorkload, captureCloudLegacyResident } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const runtime = testCloudRuntime(), common = `${runtime.cgroupRoot}/engine-runtime`;
const hostId = "12345678-1234-4234-8234-123456789abc";
const organizationId = "22345678-1234-4234-8234-123456789abc";
const workspaceId = "32345678-1234-4234-8234-123456789abc";
beforeEach(() => {
  state.directories.clear(); state.controls.clear(); state.descriptors.clear(); state.writes.length = 0;
  for (const [index, file] of ["/", "/sys", "/sys/fs", "/sys/fs/cgroup", "/sys/fs/cgroup/system.slice", runtime.cgroupRoot, common].entries())
    state.directories.set(file, { uid: file === common ? 10003 : 0, ino: index + 1 });
  state.controls.set(`${common}/cgroup.kill`, { uid: 0, value: "" });
  state.controls.set(`${common}/cgroup.events`, { uid: 0, value: "populated 1\nfrozen 0\n" });
  vi.spyOn(process, "getuid").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());
function sibling(owner: number) {
  state.directories.set(`${common}/new-sibling`, { uid: 10003, ino: 20 });
  // Linux cgroup_add_file creates control nodes using current_fsuid/fsgid.
  state.controls.set(`${common}/new-sibling/cgroup.events`, { uid: owner, value: "populated 1\nfrozen 0\n" });
}
it("control: root-created descendant metadata can be pruned after whole-tree kill", async () => {
  sibling(0);
  await expect(new CloudRuntimeCgroup({ runtime }).retire()).resolves.toMatchObject({ populated: 0, pruned: true });
  expect(state.directories.has(common)).toBe(false);
});
it("prunes legitimate delegated-user-created sibling metadata after whole-tree kill", async () => {
  sibling(10003);
  try { await expect(new CloudRuntimeCgroup({ runtime }).retire()).resolves.toMatchObject({ populated: 0, pruned: true }); }
  finally { expect(state.writes).toContainEqual([`${common}/cgroup.kill`, "1"]); }
});
function legacy() {
  const directory = `${runtime.cgroupRoot}/engine-workload-${hostId}`;
  state.directories.set(directory, { uid: 0, ino: 31 });
  const resident = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId,
    readBirth: () => ({ pid: 7001, startToken: "9001", parentPid: 17 }) });
  resident.scope = new CloudEngineCgroup({ runtime, directory });
  Object.assign(resident, { child: Object.assign(new EventEmitter(), { pid: 7001, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), unref() {} }),
    ownerBirth: { pid: 7001, startToken: "9001" }, authority: { organizationId, workspaceId,
      engineId: "42345678-1234-4234-8234-123456789abc", generation: 2, fence: 3 } });
  return resident;
}
it("captures the genuine root-owned dedicated legacy leaf through its actual native identity reader", () => {
  const resident = legacy();
  const captured = captureCloudLegacyResident(resident);
  expect(captured.source.scope).toEqual({ directory: resident.scope.directory, dev: "1", ino: "31" });
  expect(state.writes).toEqual([]);
});
it("control: modern shared-pool controller still cannot become a dedicated legacy proof", () => {
  const resident = legacy();
  resident.scope = new CloudEngineCgroup({ runtime, kind: "workload", instanceId: hostId });
  expect(() => captureCloudLegacyResident(resident)).toThrow("legacy_resident_control_refused");
  expect(state.writes).toEqual([]);
});

it.each([10001, 10004])("refuses foreign sibling events owner %s after kill without claiming pruning", async uid => {
  sibling(uid);
  await expect(new CloudRuntimeCgroup({ runtime }).retire()).rejects.toThrow(/unsafe/);
  expect(state.directories.has(common)).toBe(true);
});
it("refuses delegated-user ownership on root limit writes", () => {
  const scope = new CloudEngineCgroup({ runtime, kind: "engine", instanceId: hostId });
  state.controls.set(`${common}/cpu.max`, { uid: 10003, value: "max 100000" });
  expect(() => scope.io.write(common, "cpu.max", "400000 100000")).toThrow(/unsafe/);
  expect(state.writes).toEqual([]);
});
it.each([10001, 10003, 10004])("refuses legacy direct scope owner %s", uid => {
  const resident = legacy();
  state.directories.get(resident.scope.directory)!.uid = uid;
  expect(() => captureCloudLegacyResident(resident)).toThrow(/unsafe/);
  expect(state.writes).toEqual([]);
});
it("keeps delegated common scope identity at exact10003 and protected host outside the identity port", () => {
  const scope = new CloudEngineCgroup({ runtime, kind: "engine", instanceId: hostId });
  expect(scope.io.identity(common)).toMatchObject({ directory: common, ino: "7" });
  state.directories.get(common)!.uid = 0;
  expect(() => scope.io.identity(common)).toThrow(/unsafe/);
  state.directories.set(`${runtime.cgroupRoot}/host`, { uid: 0, ino: 32 });
  expect(() => scope.io.identity(`${runtime.cgroupRoot}/host`)).toThrow(/unsafe/);
});
