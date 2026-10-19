import * as actualFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", fds: new Set<number>() }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const physical = (file: string) => file.startsWith("/proc/") ? file : state.root + file;
  const rootMetadata = (stat: import("node:fs").Stats) => Object.assign(stat, { uid: 0, gid: 0 });
  return { ...fs,
    lstatSync: (file: string) => rootMetadata(fs.lstatSync(physical(file))),
    realpathSync: (file: string) => fs.realpathSync(physical(file)).slice(state.root.length) || "/",
    openSync: (file: string, flags: number, mode?: number) => {
      const fd = fs.openSync(physical(file), flags, mode); state.fds.add(fd); return fd;
    },
    fstatSync: (fd: number) => rootMetadata(fs.fstatSync(fd)),
    closeSync: (fd: number) => { state.fds.delete(fd); fs.closeSync(fd); },
  };
});
import { withCloudBootLocks } from "../cloud-workspace-validation/sandbox/cloud-boot-locks.mjs";
let fs: typeof actualFs;
beforeEach(async () => {
  fs = await vi.importActual<typeof actualFs>("node:fs");
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-boot-locks-")));
  fs.mkdirSync(`${state.root}/run/zeros`, { recursive: true, mode: 0o700 });
  for (const name of ["getuid", "geteuid", "getgid"] as const) vi.spyOn(process, name).mockReturnValue(0);
});
afterEach(() => {
  for (const fd of state.fds) fs.closeSync(fd); state.fds.clear();
  fs.rmSync(state.root, { recursive: true, force: true }); vi.restoreAllMocks();
});
const contenders = () => ["setup", "engine"].map(name => spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "73", `${state.root}/run/zeros/${name}.lock`, "/usr/bin/true"], { timeout: 5000 }).status);

it.skipIf(process.platform !== "linux")("holds both genuine original kernel flocks and releases only after the operation", async () => {
  await withCloudBootLocks(async locks => { locks.assertCurrent(); expect(contenders()).toEqual([73, 73]); });
  expect(contenders()).toEqual([0, 0]); expect(state.fds.size).toBe(0);
});
it.skipIf(process.platform !== "linux")("an inherited setup fd must actually hold its original flock", async () => {
  const fd = fs.openSync(`${state.root}/run/zeros/setup.lock`, "wx+", 0o600);
  try {
    await expect(withCloudBootLocks(async () => {}, { setupLockFd: fd })).rejects.toThrow();
    expect(spawnSync("/usr/bin/flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000 }).status).toBe(0);
    await withCloudBootLocks(async locks => { locks.assertCurrent(); expect(contenders()).toEqual([73, 73]); }, { setupLockFd: fd });
    expect(contenders()).toEqual([73, 0]);
  } finally { fs.closeSync(fd); }
});
it.skipIf(process.platform !== "linux")("a replaced original setup inode cannot authorize continuation", async () => {
  await expect(withCloudBootLocks(async locks => {
    fs.renameSync(`${state.root}/run/zeros/setup.lock`, `${state.root}/run/zeros/prior.lock`);
    fs.writeFileSync(`${state.root}/run/zeros/setup.lock`, "", { mode: 0o600 });
    expect(locks.assertCurrent).toThrow();
  })).rejects.toThrow();
});
it.skipIf(process.platform !== "linux")("consumes under a caller's original setup-then-engine locks without releasing its launch custody", async () => {
  const fds = ["setup", "engine"].map(name => fs.openSync(`${state.root}/run/zeros/${name}.lock`, "wx+", 0o600));
  try {
    for (const fd of fds) expect(spawnSync("/usr/bin/flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000 }).status).toBe(0);
    await withCloudBootLocks(async locks => {
      locks.assertCurrent(); expect(contenders()).toEqual([73, 73]);
      expect([locks.setupLockFd, locks.engineLockFd]).toEqual(fds);
    }, { setupLockFd: fds[0], engineLockFd: fds[1] });
    expect(contenders()).toEqual([73, 73]);
    await expect(withCloudBootLocks(async () => {}, { engineLockFd: fds[1] })).rejects.toThrow();
  } finally { for (const fd of fds) fs.closeSync(fd); }
  expect(contenders()).toEqual([0, 0]);
});
