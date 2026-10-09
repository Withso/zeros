import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adoptCloudEngineTree, adoptCloudEngineRuntimeGroups } from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

let root: string;
const owners = new Map<string, { uid: number; gid: number }>();
const fds = new Map<number, string>();
const ownership = (stat: fs.Stats, file: string) => Object.assign(stat, owners.get(file) ?? { uid: 0, gid: 0 });
const io = {
  ...fs,
  lstatSync: (file: string) => ownership(fs.lstatSync(file), file),
  openSync: (file: string, flags: number) => { const fd = fs.openSync(file, flags); fds.set(fd, file); return fd; },
  fstatSync: (fd: number) => ownership(fs.fstatSync(fd), fds.get(fd)!),
  closeSync: (fd: number) => { fds.delete(fd); fs.closeSync(fd); },
  fchownSync: vi.fn((fd: number, uid: number, gid: number) => { owners.set(fds.get(fd)!, { uid, gid }); }),
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-adopt-state-")));
  owners.clear(); fds.clear(); io.fchownSync.mockClear();
  vi.spyOn(process, "geteuid").mockReturnValue(0);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function leaf(name: string, uid = 10001, mode = 0o600) {
  const file = path.join(root, name); fs.writeFileSync(file, "immutable test bytes\n", { mode });
  owners.set(file, { uid, gid: uid }); return file;
}
it("adopts legacy mutable ownership once while preserving bytes, inode, mode and external symlinks", () => {
  owners.set(root, { uid: 10001, gid: 10001 });
  const file = leaf("session", 10002), before = fs.statSync(file);
  const outside = leaf("trusted", 0); fs.symlinkSync(outside, path.join(root, "link"));
  adoptCloudEngineTree(root, io);
  expect(owners.get(root)).toEqual({ uid: 10003, gid: 10003 });
  expect(owners.get(file)).toEqual({ uid: 10003, gid: 10003 });
  expect(owners.get(outside)).toEqual({ uid: 0, gid: 0 });
  expect(fs.readFileSync(file, "utf8")).toBe("immutable test bytes\n");
  expect(fs.statSync(file)).toMatchObject({ ino: before.ino, mode: before.mode, size: before.size });
  const count = io.fchownSync.mock.calls.length; adoptCloudEngineTree(root, io);
  expect(io.fchownSync).toHaveBeenCalledTimes(count);
});
it.each([10004, 12345])("rejects foreign ownership %s before changing any preceding legacy file", uid => {
  leaf("a"); leaf("z", uid);
  expect(() => adoptCloudEngineTree(root, io)).toThrow(/ownership/);
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("refuses hardlinked files, non-root caller and a symlink root", () => {
  const file = leaf("original"); fs.linkSync(file, path.join(root, "hardlink"));
  expect(() => adoptCloudEngineTree(root, io)).toThrow(/ownership/);
  expect(io.fchownSync).not.toHaveBeenCalled(); fs.unlinkSync(path.join(root, "hardlink"));
  if (typeof process.geteuid !== "function") throw new Error("Test requires process.geteuid");
  vi.mocked(process.geteuid).mockReturnValue(10003);
  expect(() => adoptCloudEngineTree(root, io)).toThrow(/root/);
  vi.mocked(process.geteuid).mockReturnValue(0);
  fs.symlinkSync(root, path.join(root, "alias"));
  expect(() => adoptCloudEngineTree(path.join(root, "alias"), io)).toThrow(/ownership/);
});
it("refuses a replaced or reowned descriptor before changing it", () => {
  const file = leaf("original");
  const racing = { ...io, fstatSync: (fd: number) => Object.assign(io.fstatSync(fd), { uid: 12345 }) };
  expect(() => adoptCloudEngineTree(root, racing)).toThrow(/ownership/);
  expect(owners.get(file)).toEqual({ uid: 10001, gid: 10001 });
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("validates the fixed base traversal groups without changing root ownership, group or mode", () => {
  const names = ["/srv/zeros/files/.zeros-setup", "/srv/zeros/managed-settings", "/srv/zeros/log"];
  const controls = new Map(names.map((name, i) => [name, { uid: 0, gid: 10001, mode: i === 0 ? 0o710 : 0o750 }]));
  const descriptors = new Map<number, string>(); let nextFd = 20;
  const metadata = (file: string) => {
    const entry = controls.get(file);
    if (!entry) throw Object.assign(new Error("missing fixture entry"), { code: "ENOENT" });
    return { ...entry, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
      ino: names.indexOf(file) + 1, dev: 1, nlink: 1 };
  };
  const groups = {
    existsSync: (file: string) => controls.has(file), realpathSync: (file: string) => file,
    lstatSync: metadata, openSync: (file: string) => { descriptors.set(++nextFd, file); return nextFd; },
    fstatSync: (fd: number) => metadata(descriptors.get(fd)!), closeSync: vi.fn(),
    fchownSync: vi.fn((fd: number, uid: number, gid: number) => Object.assign(controls.get(descriptors.get(fd)!)!, { uid, gid })),
  };
  adoptCloudEngineRuntimeGroups(groups);
  for (const name of names) expect(controls.get(name)).toEqual({ uid: 0, gid: 10001, mode: name.endsWith(".zeros-setup") ? 0o710 : 0o750 });
  const count = groups.fchownSync.mock.calls.length; adoptCloudEngineRuntimeGroups(groups);
  expect(groups.fchownSync).toHaveBeenCalledTimes(count);
});
