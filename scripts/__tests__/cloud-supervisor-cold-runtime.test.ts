// Composition regression for ROOT-COLD-DIR1. Ownership is explicit fake filesystem IO; no root path or native controller is mutated.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: new Map<string, { uid: number; gid: number; mode: number; kind: string; ino?: number }>(),
  descriptors: new Map<number, { file: string; entry: { uid: number; gid: number; mode: number; kind: string; ino?: number } }>(), nextFd: 3000, nextIno: 10, startToken: "700010",
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const metadataEntry = (entry: { uid: number; gid: number; mode: number; kind: string; ino?: number } | undefined) => {
    if (!entry) throw Object.assign(new Error("missing fixture entry"), { code: "ENOENT" });
    entry.ino ??= ++state.nextIno;
    return { ...entry, dev: 1, nlink: 1, isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink", isFile: () => entry.kind === "file", isSocket: () => entry.kind === "socket" };
  };
  const metadata = (file: string) => metadataEntry(state.entries.get(file));
  return { ...fs,
    realpathSync: (file: string) => file,
    lstatSync: metadata,
    existsSync: (file: string) => state.entries.has(file),
    mkdirSync: (file: string, options: { mode: number; recursive?: boolean }) => {
      if (state.entries.has(file)) {
        if (options.recursive) return;
        throw Object.assign(new Error("existing fixture entry"), { code: "EEXIST" });
      }
      state.entries.set(file, { uid: 0, gid: 0, mode: options.mode, kind: "directory" });
    },
    openSync: (file: string, flags: number, mode: number) => {
      if (!state.entries.has(file)) {
        if (!(flags & fs.constants.O_CREAT)) throw Object.assign(new Error("missing fixture entry"), { code: "ENOENT" });
        state.entries.set(file, { uid: 0, gid: 0, mode, kind: "file" });
      }
      const fd = ++state.nextFd; state.descriptors.set(fd, { file, entry: state.entries.get(file)! }); return fd;
    },
    fstatSync: (fd: number) => metadataEntry(state.descriptors.get(fd)?.entry),
    chmodSync: (file: string, mode: number) => { state.entries.get(file)!.mode = mode; },
    fchmodSync: (fd: number, mode: number) => { state.descriptors.get(fd)!.entry.mode = mode; },
    fchownSync: (fd: number, uid: number, gid: number) => { Object.assign(state.descriptors.get(fd)!.entry, { uid, gid }); },
    closeSync: (fd: number) => { state.descriptors.delete(fd); },
    unlinkSync: (file: string) => { state.entries.delete(file); },
  };
});
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, spawnSync: (file: string) => {
    if (file !== "/usr/bin/flock") throw new Error("unexpected fixture process");
    return { status: 0, signal: null };
  } };
});
import { CloudWorkerSupervisor } from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";
import { CloudLegacyResidentControl } from "../cloud-workspace-validation/sandbox/cloud-resident-control.mjs";
import { cloudHostRuntimeProfile, ensureCloudHostRuntimeDirectory } from "../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const runtimeDirectory = "/run/zeros/engine";
const profile = () => cloudHostRuntimeProfile({ version: 4, profile: "zeros-cloud-worker-v4", backend: "cloud-worker", uid: 10001, gid: 10001 });
beforeEach(() => {
  state.entries.clear(); state.descriptors.clear(); state.startToken = "700010";
  for (const file of ["/", "/run", "/run/zeros"]) state.entries.set(file, { uid: 0, gid: 0, mode: 0o700, kind: "directory" });
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.spyOn(CloudLegacyResidentControl.prototype, "listen").mockResolvedValue(undefined);
  vi.spyOn(CloudWorkerSupervisor.prototype, "listen").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
it("control: setup alone creates its required non-root runtime directory", () => {
  expect(() => ensureCloudHostRuntimeDirectory(profile())).not.toThrow();
  expect(state.entries.get(runtimeDirectory)).toMatchObject({ uid: 10003, gid: 10003, mode: 0o700 });
});
it("cold supervisor startup leaves the runtime directory usable by original setup", async () => {
  const supervisor = new CloudWorkerSupervisor({ runtime: testCloudRuntime(), engineScope: { retire: async () => {} }, readBirth: pid => ({ pid, parentPid: 1, startToken: state.startToken }) });
  try {
    await supervisor.start();
    expect(() => ensureCloudHostRuntimeDirectory(profile())).not.toThrow();
    expect(state.entries.get(runtimeDirectory)).toMatchObject({ uid: 10003, gid: 10003, mode: 0o700 });
  } finally { await supervisor.stop(); }
});
it("control: a previously prepared runtime directory survives listener startup", async () => {
  ensureCloudHostRuntimeDirectory(profile());
  const supervisor = new CloudWorkerSupervisor({ runtime: testCloudRuntime(), engineScope: { retire: async () => {} }, readBirth: pid => ({ pid, parentPid: 1, startToken: state.startToken }) });
  try { await supervisor.start(); expect(() => ensureCloudHostRuntimeDirectory(profile())).not.toThrow(); }
  finally { await supervisor.stop(); }
});
it("control: setup still refuses a foreign preexisting directory", () => {
  state.entries.set(runtimeDirectory, { uid: 10001, gid: 10001, mode: 0o700, kind: "directory" });
  expect(() => ensureCloudHostRuntimeDirectory(profile())).toThrow("Cloud runtime directory is unsafe");
});

it.each([
  { uid: 0, gid: 0, mode: 0o700, kind: "directory" },
  { uid: 10001, gid: 10001, mode: 0o700, kind: "directory" },
  { uid: 10003, gid: 10001, mode: 0o700, kind: "directory" },
  { uid: 10003, gid: 10003, mode: 0o770, kind: "directory" },
  { uid: 10003, gid: 10003, mode: 0o700, kind: "symlink" },
])("cold supervisor refuses a preexisting runtime directory with $uid/$gid/$mode/$kind", async entry => {
  state.entries.set(runtimeDirectory, entry);
  const supervisor = new CloudWorkerSupervisor({ runtime: testCloudRuntime(), engineScope: { retire: async () => {} }, readBirth: pid => ({ pid, parentPid: 1, startToken: state.startToken }) });
  await expect(supervisor.start()).rejects.toThrow(/unsafe/);
  expect(CloudWorkerSupervisor.prototype.listen).not.toHaveBeenCalled();
  expect(state.entries.get(runtimeDirectory)).toEqual(entry);
});

it.each(["unstarted", "closed-fd", "replaced-inode", "foreign-owner", "wrong-mode", "root-birth", "stopped"])("stale recovery lock refuses %s", async mutation => {
  const supervisor = new CloudWorkerSupervisor({ runtime: testCloudRuntime(), engineScope: { retire: async () => {} },
    readBirth: pid => ({ pid, parentPid: 1, startToken: state.startToken }) });
  const assertLock = supervisor.legacyResidentControlOptions().assertListenerLock;
  if (mutation === "unstarted") { expect(() => assertLock()).toThrow(/lock/); return; }
  await supervisor.start();
  try {
    expect(() => assertLock()).not.toThrow();
    const lockPath = `${supervisor.socketPath}.lock`;
    if (mutation === "closed-fd") state.descriptors.delete(supervisor.lock!);
    if (mutation === "replaced-inode") state.entries.set(lockPath, { uid: 0, gid: 0, mode: 0o600, kind: "file", ino: 9000 });
    if (mutation === "foreign-owner") state.entries.get(lockPath)!.uid = 10003;
    if (mutation === "wrong-mode") state.entries.get(lockPath)!.mode = 0o660;
    if (mutation === "root-birth") state.startToken = "700011";
    if (mutation === "stopped") await supervisor.stop();
    expect(() => assertLock()).toThrow(/lock/);
  } finally { await supervisor.stop(); }
});
