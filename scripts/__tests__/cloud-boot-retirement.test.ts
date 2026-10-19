import { expect, it, vi } from "vitest";
import { common } from "./cloud-boot-admission-fixture";
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

// Pinned kernel objects: an open fd continues to point at its original inode
// after pathname replacement. No host kernel controls are read or changed.
function fixture() {
  type Entry = { ino: number; uid: number; gid: number; directory: boolean; mode: number; value: string };
  const entries = new Map<string, Entry>(), fds = new Map<number, { entry: Entry; file: string }>();
  let next = 20, now = 0;
  const add = (file: string, directory: boolean, value = "", owner = 0) => entries.set(file, { ino: entries.size + 1,
    uid: owner, gid: owner, directory, mode: directory ? 0o755 : 0o644, value });
  for (const file of ["/", "/sys", "/sys/fs", "/sys/fs/cgroup", "/sys/fs/cgroup/system.slice", common.slice(0, -15), common]) add(file, true, "", file === common ? 10003 : 0);
  add(`${common}/cgroup.kill`, false); add(`${common}/cgroup.events`, false, "populated 1\nfrozen 0\n");
  const original = { directory: common, dev: "1", ino: String(entries.get(common)!.ino) };
  const stat = (entry: Entry) => ({ uid: entry.uid, gid: entry.gid, mode: entry.mode, dev: 1, ino: entry.ino, nlink: 1,
    isFile: () => !entry.directory, isDirectory: () => entry.directory, isSymbolicLink: () => false });
  const resolve = (file: string) => {
    const match = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(file);
    if (!match) return { file, entry: entries.get(file) };
    const pinned = fds.get(Number(match[1]))!;
    return match[2] ? { file: pinned.file + match[2], entry: entries.get(pinned.file + match[2]) } : pinned;
  };
  const io = { lstatSync: (file: string) => { const e = resolve(file).entry; if (!e) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return stat(e); },
    realpathSync: (file: string) => file, statfsSync: () => ({ type: 0x63677270 }),
    openSync: (file: string) => { const found = resolve(file); if (!found.entry) throw new Error("missing"); fds.set(++next, { file: found.file, entry: found.entry }); return next; },
    fstatSync: (fd: number) => stat(fds.get(fd)!.entry), closeSync: (fd: number) => fds.delete(fd),
    readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number) => Buffer.from(fds.get(fd)!.entry.value).copy(bytes, offset, position, position + length),
    writeSync: vi.fn((fd: number, value: string) => {
      fds.get(fd)!.entry.value += value;
      entries.get(`${common}/cgroup.events`)!.value = "populated 0\nfrozen 0\n"; return Buffer.byteLength(value);
    }),
    readdirSync: () => [], rmdirSync: vi.fn((file: string) => { entries.delete(resolve(file).file); }) };
  const scope = new CloudEngineCgroup({ runtime: testCloudRuntime(), instanceId: "12345678-1234-4234-8234-123456789abc" });
  return { scope, io, entries, fds, original, options: { io, requireRoot: () => {}, now: () => now, pause: async (ms: number) => { now += ms; } } };
}
async function pin(f: ReturnType<typeof fixture>) {
  expect(f.scope.pinBootRetirement, "boot cleanup must capture original custody before I/O").toBeTypeOf("function");
  const module = await import("../cloud-workspace-validation/sandbox/cloud-boot-retirement.mjs");
  return module.pinCloudBootRetirement(f.original, f.options);
}
it("pins the original cgroup controls before any probe and proves empty/pruned before release", async () => {
  const f = fixture(), owner = await pin(f);
  expect(f.fds.size).toBeGreaterThan(0); expect(f.io.writeSync).not.toHaveBeenCalled();
  await expect(owner.retire()).resolves.toEqual({ ...f.original, populated: 0, pruned: true });
  owner.close(); expect(f.fds.size).toBe(0); expect(f.io.writeSync).toHaveBeenCalledOnce();
});
it("refuses a replaced original path before signaling, even with an open old descriptor", async () => {
  const f = fixture(), owner = await pin(f);
  f.entries.set(common, { ...f.entries.get(common)!, ino: 999 });
  await expect(owner.retire()).rejects.toThrow(); expect(f.io.writeSync).not.toHaveBeenCalled(); expect(f.io.rmdirSync).not.toHaveBeenCalled();
});
it("a control pathname race cannot redirect the already-open kill descriptor", async () => {
  const f = fixture(), owner = await pin(f), old = f.entries.get(`${common}/cgroup.kill`)!;
  const replacement = { ...old, ino: 999, value: "" }; f.entries.set(`${common}/cgroup.kill`, replacement);
  await owner.retire(); expect(replacement.value).toBe(""); expect(old.value).toBe("1"); owner.close();
});
it("unknown population retains original custody and refuses pruning", async () => {
  const f = fixture(), owner = await pin(f);
  f.io.writeSync.mockImplementation((_fd, value) => Buffer.byteLength(value));
  f.entries.get(`${common}/cgroup.events`)!.value = "unknown";
  await expect(owner.retire()).rejects.toThrow(); expect(f.fds.size).toBeGreaterThan(0); expect(f.io.rmdirSync).not.toHaveBeenCalled();
});
it("a replacement during the population wait cannot be pruned by the original owner", async () => {
  const f = fixture();
  f.io.writeSync.mockImplementation((_fd, value) => Buffer.byteLength(value));
  f.options.pause = async () => {
    f.entries.get(`${common}/cgroup.events`)!.value = "populated 0\nfrozen 0\n";
    f.entries.set(common, { ...f.entries.get(common)!, ino: 999 });
  };
  const owner = await pin(f);
  await expect(owner.retire()).rejects.toThrow();
  expect(f.io.rmdirSync).not.toHaveBeenCalled(); expect(f.fds.size).toBeGreaterThan(0);
  expect(() => owner.close()).toThrow();
});
