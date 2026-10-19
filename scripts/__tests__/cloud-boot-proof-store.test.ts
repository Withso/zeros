import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cloudBootProofStore } from "../cloud-workspace-validation/sandbox/cloud-boot-proof.mjs";

const fixtures: string[] = [], proof = "/run/zeros/cloud-worker-admission.json";
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-boot-proof-"))); fixtures.push(root);
  const physical = (file: string) => root + file;
  fs.mkdirSync(physical("/run/zeros"), { recursive: true, mode: 0o700 });
  const fds = new Map<number, string>(), overrides = new Map<string, object>();
  const metadata = (stat: fs.Stats, file: string) => Object.assign(stat, { uid: 0, gid: 0 }, overrides.get(file));
  const io = {
    lstatSync: (file: string) => metadata(fs.lstatSync(physical(file)), file),
    realpathSync: (file: string) => fs.realpathSync(physical(file)).slice(root.length) || "/",
    openSync: (file: string, flags: number, mode?: number) => { const fd = fs.openSync(physical(file), flags, mode); fds.set(fd, file); return fd; },
    fstatSync: (fd: number) => metadata(fs.fstatSync(fd), fds.get(fd)!), closeSync: (fd: number) => { fds.delete(fd); fs.closeSync(fd); },
    fchownSync: () => {}, fchmodSync: fs.fchmodSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, readSync: fs.readSync,
    rmSync: (file: string, options: fs.RmOptions) => fs.rmSync(physical(file), options),
    renameSync: (from: string, to: string) => fs.renameSync(physical(from), physical(to)),
  };
  const store = cloudBootProofStore(io);
  const remains = () => fs.readdirSync(physical("/run/zeros"));
  return { store, root, io, physical, remains, fds, overrides };
}
it("atomically publishes a bounded 0400 single-link proof and gives only one consumer its bytes", async () => {
  const f = fixture(); f.store.publish({ version: 3, fixture: true });
  const stat = fs.statSync(f.physical(proof)); expect(stat.mode & 0o7777).toBe(0o400); expect(stat.nlink).toBe(1);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = f.store.consume(async value => { await held; return value; });
  await expect(f.store.consume(value => value)).rejects.toThrow();
  release(); await expect(first).resolves.toEqual({ version: 3, fixture: true });
  expect(f.remains()).toEqual([]); expect(f.fds.size).toBe(0);
});
it.each(["uid", "gid", "mode", "hardlink", "symlink", "oversize", "duplicate", "utf8", "validation"])("spends unsafe %s bytes before refusing them", async fault => {
  const f = fixture(); f.store.publish({ version: 3 });
  if (fault === "uid" || fault === "gid") {
    const rename = f.io.renameSync;
    f.io.renameSync = (from, to) => { rename(from, to); f.overrides.set(to, { [fault]: 10003 }); };
  }
  if (fault === "mode") fs.chmodSync(f.physical(proof), 0o644);
  if (fault === "hardlink") fs.linkSync(f.physical(proof), f.physical("/run/zeros/alias"));
  if (fault === "symlink") {
    fs.renameSync(f.physical(proof), f.physical("/run/zeros/alias")); fs.symlinkSync("alias", f.physical(proof));
  }
  if (["oversize", "duplicate", "utf8"].includes(fault)) {
    fs.unlinkSync(f.physical(proof));
    const bytes = fault === "oversize" ? Buffer.alloc(16385, 0x20) : fault === "duplicate" ? Buffer.from('{"version":3,"v\\u0065rsion":3}') : Buffer.from([123, 34, 0xff, 34, 58, 49, 125]);
    fs.writeFileSync(f.physical(proof), bytes, { mode: 0o400 });
  }
  await expect(f.store.consume(() => { if (fault === "validation") throw new Error("scope mismatch"); })).rejects.toThrow();
  expect(fs.existsSync(f.physical(proof))).toBe(false); expect(f.remains().filter(name => name.endsWith(".consumed"))).toEqual([]);
  expect(f.fds.size).toBe(0);
});
it("rejects excessive publication without leaving a partial proof", () => {
  const f = fixture(); expect(() => f.store.publish({ payload: "x".repeat(16384) })).toThrow(); expect(f.remains()).toEqual([]);
});
it("refuses an original descriptor/path inode mismatch and still spends the claim", async () => {
  const f = fixture(); f.store.publish({ version: 3 });
  const opened = f.io.openSync;
  f.io.openSync = (file, flags, mode) => {
    const fd = opened(file, flags, mode);
    if (file.endsWith(".consumed")) { fs.unlinkSync(f.physical(file)); fs.writeFileSync(f.physical(file), '{"version":3}', { mode: 0o400 }); }
    return fd;
  };
  await expect(f.store.consume(value => value)).rejects.toThrow(); expect(f.remains()).toEqual([]); expect(f.fds.size).toBe(0);
});
