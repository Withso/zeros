import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adoptCloudEngineTree, adoptCloudEngineRuntimeGroups, adoptCloudEngineState } from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

const retired = vi.hoisted(() => vi.fn());
vi.mock("../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs", () => ({
  CloudDelegatedCgroups: class { assertRetired() { retired(); } },
}));

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
  owners.clear(); fds.clear(); io.fchownSync.mockClear(); retired.mockReset();
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function leaf(name: string, uid = 10001, mode = 0o600) {
  const file = path.join(root, name); fs.writeFileSync(file, "immutable test bytes\n", { mode });
  owners.set(file, { uid, gid: uid }); return file;
}
it("adopts legacy mutable ownership once while preserving bytes, inode, mode and external symlinks", () => {
  owners.set(root, { uid: 10001, gid: 10001 });
  const file = leaf("session", 10002);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    const outside = leaf("trusted", 0); fs.symlinkSync(outside, path.join(root, "link"));
    adoptCloudEngineTree(root, io);
    expect(owners.get(root)).toEqual({ uid: 10003, gid: 10003 });
    expect(owners.get(file)).toEqual({ uid: 10003, gid: 10003 });
    expect(owners.get(outside)).toEqual({ uid: 0, gid: 0 });
    expect(fs.readFileSync(descriptor, "utf8")).toBe("immutable test bytes\n");
    expect(fs.fstatSync(descriptor)).toMatchObject({ ino: before.ino, mode: before.mode, size: before.size });
    const count = io.fchownSync.mock.calls.length; adoptCloudEngineTree(root, io);
    expect(io.fchownSync).toHaveBeenCalledTimes(count);
    const final = fs.fstatSync(descriptor);
    expect(final).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(fs.lstatSync(file)).toMatchObject({ dev: final.dev, ino: final.ino });
  } finally { fs.closeSync(descriptor); }
});
it.each([10004, 12345])("leaves unrelated foreign ownership %s untouched while adopting safe legacy files", uid => {
  const safe = leaf("a"), foreign = leaf("z", uid);
  expect(() => adoptCloudEngineTree(root, io)).not.toThrow();
  expect(owners.get(safe)).toEqual({ uid: 10003, gid: 10003 });
  expect(owners.get(foreign)).toEqual({ uid, gid: uid });
});
it("adopts setgid checkout directories and every safe legacy child without dropping mode bits", () => {
  const directory = path.join(root, "group-cache"); fs.mkdirSync(directory); fs.chmodSync(directory, 0o2755);
  owners.set(directory, { uid: 10001, gid: 10001 });
  const file = leaf("group-cache/session");
  adoptCloudEngineTree(root, io);
  expect(owners.get(directory)).toEqual({ uid: 10003, gid: 10003 });
  expect(owners.get(file)).toEqual({ uid: 10003, gid: 10003 });
  expect(fs.lstatSync(directory).mode & 0o7777).toBe(0o2755);
});
it("never traverses or chowns a foreign checkout subtree or a mixed foreign group", () => {
  const directory = path.join(root, "foreign"); fs.mkdirSync(directory);
  owners.set(directory, { uid: 12345, gid: 12345 });
  const child = leaf("foreign/legacy"), mixed = leaf("mixed");
  owners.set(mixed, { uid: 10001, gid: 12345 });
  const observed = { ...io, readdirSync: vi.fn((file: string) => fs.readdirSync(file)) };
  expect(() => adoptCloudEngineTree(root, observed)).not.toThrow();
  expect(observed.readdirSync).not.toHaveBeenCalledWith(directory);
  expect(owners.get(child)).toEqual({ uid: 10001, gid: 10001 });
  expect(owners.get(mixed)).toEqual({ uid: 10001, gid: 12345 });
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("keeps earlier per-entry progress after a later descriptor race and can retry it", () => {
  const first = leaf("z"), later = leaf("a");
  const racing = { ...io, fstatSync: (fd: number) => {
    const stat = io.fstatSync(fd);
    return fds.get(fd) === later ? Object.assign(stat, { uid: 12345 }) : stat;
  } };
  expect(() => adoptCloudEngineTree(root, racing)).toThrow(/ownership/);
  expect(owners.get(first)).toEqual({ uid: 10003, gid: 10003 });
  expect(owners.get(later)).toEqual({ uid: 10001, gid: 10001 });
  expect(fds.size).toBe(0);
  adoptCloudEngineTree(root, io);
  expect(owners.get(later)).toEqual({ uid: 10003, gid: 10003 });
});
it("still refuses a foreign checkout root before touching its contents", () => {
  owners.set(root, { uid: 12345, gid: 12345 }); leaf("safe");
  expect(() => adoptCloudEngineTree(root, io)).toThrow(/ownership/);
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("leaves legacy hardlinks untouched and refuses a non-root caller or a symlink root", () => {
  const file = leaf("original"); fs.linkSync(file, path.join(root, "hardlink"));
  expect(() => adoptCloudEngineTree(root, io)).not.toThrow();
  expect(owners.get(file)).toEqual({ uid: 10001, gid: 10001 });
  expect(io.fchownSync).not.toHaveBeenCalled(); fs.unlinkSync(path.join(root, "hardlink"));
  if (typeof process.geteuid !== "function") throw new Error("Test requires process.geteuid");
  vi.mocked(process.geteuid).mockReturnValue(10003);
  expect(() => adoptCloudEngineTree(root, io)).toThrow(/root/);
  vi.mocked(process.geteuid).mockReturnValue(0);
  fs.symlinkSync(root, path.join(root, "alias"));
  expect(() => adoptCloudEngineTree(path.join(root, "alias"), io)).toThrow(/ownership/);
});
it.each([10001, 10003])("skips unsafe artifacts owned by %s while adopting safe legacy files", async uid => {
  owners.set(root, { uid: 10003, gid: 10003 });
  const safe = leaf("session");
  const binary = leaf("esbuild", uid); fs.linkSync(binary, path.join(root, "esbuild-link"));
  owners.set(path.join(root, "esbuild-link"), { uid, gid: uid });
  const special = leaf("special", uid); fs.chmodSync(special, 0o6755);
  const fifo = path.join(root, "fifo"); execFileSync("mkfifo", [fifo]); owners.set(fifo, { uid, gid: uid });
  const socket = path.join(root, "socket"), server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  owners.set(socket, { uid, gid: uid });
  try {
    expect(() => adoptCloudEngineTree(root, io)).not.toThrow();
    expect(owners.get(safe)).toEqual({ uid: 10003, gid: 10003 });
    for (const file of [binary, special, fifo, socket]) expect(owners.get(file)).toEqual({ uid, gid: uid });
    expect(fs.lstatSync(binary).nlink).toBe(2);
    expect(fs.lstatSync(special).mode & 0o7777).toBe(0o6755);
    expect(fds.size).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it("does not impose an entry cap on unrelated current-owner dependency files", () => {
  const original = io.lstatSync(root);
  const dependencyIo = { ...io,
    realpathSync: (file: string) => file,
    lstatSync: (file: string) => file === root ? original : {
      ...original, uid: 10003, gid: 10003, mode: 0o100644, nlink: 1,
      isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
    },
    readdirSync: () => Array.from({ length: 250001 }, (_, i) => `dependency-${i}`),
  };
  expect(() => adoptCloudEngineTree(root, dependencyIo)).not.toThrow();
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("does not chown a file that acquires an external hardlink after its inventory read", () => {
  leaf("original");
  const racing = { ...io, fstatSync: (fd: number) => Object.assign(io.fstatSync(fd), { nlink: 2 }) };
  expect(() => adoptCloudEngineTree(root, racing)).toThrow(/ownership/);
  expect(io.fchownSync).not.toHaveBeenCalled();
  expect(fds.size).toBe(0);
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

const marker = "/srv/zeros/.zeros-engine-ownership-v1.json";
function stateFixture() {
  const host = (file: string) => path.join(root, file);
  const directory = (file: string, uid = 0, mode = 0o755) => {
    fs.mkdirSync(host(file), { recursive: true, mode }); fs.chmodSync(host(file), mode);
    owners.set(file, { uid, gid: uid });
  };
  const file = (name: string, uid: number, content = "preserved state\n") => {
    fs.writeFileSync(host(name), content, { mode: 0o600 }); owners.set(name, { uid, gid: uid });
  };
  for (const name of ["/", "/srv", "/srv/zeros", "/srv/zeros/home", "/srv/zeros/files"]) directory(name);
  directory("/srv/zeros/home/agent", 10001); file("/srv/zeros/home/agent/session", 10001);
  directory("/srv/zeros/home/capture", 10002, 0o700); file("/srv/zeros/home/capture/state", 10002);
  directory("/srv/zeros/files/workspace", 10001); file("/srv/zeros/files/workspace/session", 10001);
  const stateIo = { ...io,
    lstatSync: (name: string) => ownership(fs.lstatSync(host(name)), name),
    realpathSync: (name: string) => fs.realpathSync(host(name)).slice(root.length) || "/",
    readdirSync: vi.fn((name: string) => fs.readdirSync(host(name))),
    mkdirSync: (name: string, options: fs.MakeDirectoryOptions) => {
      fs.mkdirSync(host(name), options);
      const parent = path.dirname(name), stat = ownership(fs.lstatSync(host(parent)), parent);
      owners.set(name, { uid: 0, gid: stat.mode & 0o2000 ? stat.gid : 0 });
    },
    openSync: (name: string, flags: number, mode?: fs.Mode) => {
      const descriptor = fs.openSync(host(name), flags, mode); fds.set(descriptor, name); return descriptor;
    },
    renameSync: (source: string, target: string) => {
      fs.renameSync(host(source), host(target));
      if (owners.has(source)) { owners.set(target, owners.get(source)!); owners.delete(source); }
    },
    unlinkSync: (name: string) => { fs.unlinkSync(host(name)); owners.delete(name); },
  };
  return { host, directory, file, io: stateIo, runtime: { profile: "v4" } };
}
it("completes legacy HOME migration around hardlinks, stale endpoints, special files and setgid directories", async () => {
  const fixture = stateFixture(), agent = "/srv/zeros/home/agent";
  const hardlink = `${agent}/tool`, otherLink = "/srv/zeros/files/workspace/tool";
  fixture.file(hardlink, 10001); fs.linkSync(fixture.host(hardlink), fixture.host(otherLink));
  owners.set(otherLink, { uid: 10001, gid: 10001 });
  const special = `${agent}/special`; fixture.file(special, 10001); fs.chmodSync(fixture.host(special), 0o6755);
  const fifo = `${agent}/fifo`; execFileSync("mkfifo", [fixture.host(fifo)]); owners.set(fifo, { uid: 10001, gid: 10001 });
  const socket = `${agent}/socket`, server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(fixture.host(socket), resolve); });
  owners.set(socket, { uid: 10001, gid: 10001 });
  const directory = `${agent}/cache`; fixture.directory(directory, 10001, 0o2755);
  fixture.directory(`${directory}/nested`, 10001); fixture.file(`${directory}/nested/safe`, 10001);
  const originals = new Map([hardlink, special, fifo, socket].map(file => [file, fixture.io.lstatSync(file)]));
  try {
    expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).not.toThrow();
    expect(fs.existsSync(fixture.host(marker))).toBe(true);
    for (const [file, stat] of originals) expect(fixture.io.lstatSync(file)).toMatchObject({
      dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink,
    });
    expect(fixture.io.lstatSync("/srv/zeros/home/engine/cache")).toMatchObject({ uid: 10003, gid: 10003 });
    expect(fixture.io.lstatSync("/srv/zeros/home/engine/cache").mode & 0o7777).toBe(0o2755);
    expect(fixture.io.lstatSync("/srv/zeros/home/engine/cache/nested/safe")).toMatchObject({ uid: 10003, gid: 10003 });
    expect(fixture.io.lstatSync("/srv/zeros/home/engine/session")).toMatchObject({ uid: 10003, gid: 10003 });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"unsupportedEntries":2');
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"specialModeEntries":1');
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"hardlinkedEntries":1');
    expect(fds.size).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it("does not cap a legacy HOME with more than 250000 unrelated cache entries", () => {
  const fixture = stateFixture(), agent = "/srv/zeros/home/agent";
  const template = fixture.io.lstatSync(`${agent}/session`);
  const many = { ...fixture.io,
    readdirSync: (file: string) => file === agent ? ["session", ...Array.from({ length: 250001 }, (_, i) => `cached-${i}`)] : fixture.io.readdirSync(file),
    lstatSync: (file: string) => file.startsWith(`${agent}/cached-`) ? Object.assign(Object.create(Object.getPrototypeOf(template)), template, { nlink: 2 }) : fixture.io.lstatSync(file),
  };
  expect(() => adoptCloudEngineState(fixture.runtime, many)).not.toThrow();
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
  expect(fixture.io.lstatSync("/srv/zeros/home/engine/session")).toMatchObject({ uid: 10003, gid: 10003 });
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"hardlinkedEntries":250001');
});
it("moves and adopts every safe entry in a legacy HOME larger than 250000 entries", () => {
  const fixture = stateFixture(), agent = "/srv/zeros/home/agent", engine = "/srv/zeros/home/engine";
  const source = `${agent}/cache`, target = `${engine}/cache`, count = 250001;
  fixture.directory(source, 10001);
  const template = fixture.io.lstatSync(`${agent}/session`), locations = new Uint8Array(count);
  const descriptors = new Map<number, number>(), parents = new Set([agent, engine, source, target]);
  const parentStats = new Map<string, fs.Stats>(); let nextDescriptor = 1000000, moved = 0, adopted = 0;
  const entry = (file: string) => {
    for (const [prefix, destination] of [[`${source}/entry-`, false], [`${target}/entry-`, true]] as const) {
      if (file.startsWith(prefix)) return { index: Number(file.slice(prefix.length)), destination };
    }
    return null;
  };
  const absent = () => { throw Object.assign(new Error("missing virtual entry"), { code: "ENOENT" }); };
  const metadata = (index: number) => Object.assign(Object.create(Object.getPrototypeOf(template)), template, {
    ino: 2000000000 + index, uid: locations[index] === 2 ? 10003 : 10001,
    gid: locations[index] === 2 ? 10003 : 10001, nlink: 1,
  }) as fs.Stats;
  const many = { ...fixture.io,
    lstatSync: (file: string) => {
      const item = entry(file);
      if (item) return Boolean(locations[item.index]) === item.destination ? metadata(item.index) : absent();
      if (parentStats.has(file)) return parentStats.get(file)!;
      const stat = fixture.io.lstatSync(file);
      if (parents.has(file) && (file === agent || file === source || (stat.uid === 10003 && (stat.mode & 0o7777) === 0o755))) parentStats.set(file, stat);
      return stat;
    },
    realpathSync: (file: string) => entry(file) || parents.has(file) ? file : fixture.io.realpathSync(file),
    readdirSync: (file: string) => file === source ? Array.from({ length: count }, (_, i) => `entry-${i}`) : fixture.io.readdirSync(file),
    renameSync: (from: string, to: string) => {
      const item = entry(from);
      if (!item) return fixture.io.renameSync(from, to);
      const destination = entry(to);
      if (!destination?.destination || destination.index !== item.index || locations[item.index] !== 0) throw new Error("invalid virtual move");
      locations[item.index] = 1; moved++;
    },
    openSync: (file: string, flags: number, mode?: fs.Mode) => {
      const item = entry(file);
      if (!item) return fixture.io.openSync(file, flags, mode);
      const descriptor = nextDescriptor++; descriptors.set(descriptor, item.index); return descriptor;
    },
    fstatSync: (fd: number) => descriptors.has(fd) ? metadata(descriptors.get(fd)!) : fixture.io.fstatSync(fd),
    fchownSync: (fd: number, uid: number, gid: number) => {
      const index = descriptors.get(fd);
      if (index === undefined) return fixture.io.fchownSync(fd, uid, gid);
      if (uid !== 10003 || gid !== 10003) throw new Error("invalid virtual adoption");
      locations[index] = 2; adopted++;
    },
    closeSync: (fd: number) => { if (!descriptors.delete(fd)) fixture.io.closeSync(fd); },
  };
  adoptCloudEngineState(fixture.runtime, many);
  expect(moved).toBe(count); expect(adopted).toBe(count);
  expect(locations.every(location => location === 2)).toBe(true);
  expect(many.lstatSync(`${target}/entry-0`)).toMatchObject({ uid: 10003, gid: 10003, ino: 2000000000 });
  expect(many.lstatSync(`${target}/entry-${count - 1}`)).toMatchObject({ uid: 10003, gid: 10003, ino: 2000000000 + count - 1 });
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
  expect(console.warn).not.toHaveBeenCalled();
  expect(descriptors.size).toBe(0); expect(fds.size).toBe(0);
}, 60000);
it("migrates safe HOME descendants deeper than 128 levels while preserving the path bound", () => {
  const fixture = stateFixture(); let directory = "/srv/zeros/home/agent";
  for (let i = 0; i < 130; i++) { directory += "/d"; fixture.directory(directory, 10001); }
  fixture.file(`${directory}/safe`, 10001);
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).not.toThrow();
  const target = directory.replace("/home/agent", "/home/engine");
  expect(fixture.io.lstatSync(`${target}/safe`)).toMatchObject({ uid: 10003, gid: 10003 });
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
});
it("leaves foreign HOME entries and whole subtrees untouched and still writes completion", () => {
  const fixture = stateFixture(), agent = "/srv/zeros/home/agent";
  fixture.file(`${agent}/foreign-file`, 12345);
  fixture.directory(`${agent}/foreign-tree`, 12345); fixture.file(`${agent}/foreign-tree/legacy`, 10001);
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).not.toThrow();
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
  expect(fixture.io.readdirSync).not.toHaveBeenCalledWith(`${agent}/foreign-tree`);
  expect(fixture.io.lstatSync(`${agent}/foreign-file`)).toMatchObject({ uid: 12345, gid: 12345 });
  expect(fixture.io.lstatSync(`${agent}/foreign-tree/legacy`)).toMatchObject({ uid: 10001, gid: 10001 });
  expect(fixture.io.lstatSync("/srv/zeros/home/engine/session")).toMatchObject({ uid: 10003, gid: 10003 });
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"foreignEntries":2');
  expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('"foreignSubtrees":1');
});
it.each(["owner", "mode", "collision", "foreign-target"])("still refuses a HOME %s integrity violation without publishing completion", failure => {
  const fixture = stateFixture(), agent = "/srv/zeros/home/agent", target = "/srv/zeros/home/engine";
  if (failure === "owner") owners.set(agent, { uid: 12345, gid: 12345 });
  if (failure === "mode") fs.chmodSync(fixture.host(agent), 0o777);
  if (failure === "collision" || failure === "foreign-target") {
    fixture.directory(target, failure === "foreign-target" ? 12345 : 10003);
    if (failure === "collision") fixture.file(`${target}/session`, 10003);
  }
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).toThrow(/ownership/);
  expect(fs.existsSync(fixture.host(marker))).toBe(false);
  expect(io.fchownSync).not.toHaveBeenCalled();
  expect(fds.size).toBe(0);
});
it("refuses a HOME realpath mismatch before moving state or publishing completion", () => {
  const fixture = stateFixture(), source = "/srv/zeros/home/agent/session";
  const replaced = { ...fixture.io, realpathSync: (file: string) => file === source ? "/foreign/session" : fixture.io.realpathSync(file) };
  expect(() => adoptCloudEngineState(fixture.runtime, replaced)).toThrow(/ownership/);
  expect(fs.existsSync(fixture.host(source))).toBe(true);
  expect(fs.existsSync(fixture.host(marker))).toBe(false);
  expect(io.fchownSync).not.toHaveBeenCalled();
});
it("durably completes adoption once and avoids checkout or HOME walks on the next wake", () => {
  const fixture = stateFixture();
  adoptCloudEngineState(fixture.runtime, fixture.io);
  const first = fixture.io.lstatSync(marker);
  expect(first).toMatchObject({ uid: 0, gid: 0, nlink: 1 });
  expect(first.mode & 0o7777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(fixture.host(marker), "utf8"))).toEqual({ version: 1, uid: 10003, gid: 10003 });
  fixture.directory("/srv/zeros/files/workspace/node_modules", 10003);
  fixture.file("/srv/zeros/files/workspace/node_modules/esbuild", 10003);
  fs.linkSync(fixture.host("/srv/zeros/files/workspace/node_modules/esbuild"), fixture.host("/srv/zeros/files/workspace/esbuild"));
  fixture.io.readdirSync.mockClear(); const count = io.fchownSync.mock.calls.length;
  adoptCloudEngineState(fixture.runtime, fixture.io);
  expect(fixture.io.readdirSync).not.toHaveBeenCalled();
  expect(io.fchownSync).toHaveBeenCalledTimes(count);
  expect(fixture.io.lstatSync(marker)).toMatchObject({ dev: first.dev, ino: first.ino, mode: first.mode });
  expect(retired).toHaveBeenCalledTimes(2);
  retired.mockImplementationOnce(() => { throw new Error("original scope not retired"); });
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).toThrow(/not retired/);
  expect(fds.size).toBe(0);
});
it("publishes no completion marker after an interrupted sync and retries without losing migrated state", () => {
  const fixture = stateFixture();
  let interrupted = true;
  const failing = { ...fixture.io, fsyncSync: (fd: number) => {
    if (interrupted) { interrupted = false; throw new Error("interrupted sync"); }
    fs.fsyncSync(fd);
  } };
  expect(() => adoptCloudEngineState(fixture.runtime, failing)).toThrow(/interrupted/);
  expect(fs.existsSync(fixture.host(marker))).toBe(false);
  expect(fds.size).toBe(0);
  adoptCloudEngineState(fixture.runtime, fixture.io);
  expect(fs.readFileSync(fixture.host("/srv/zeros/home/engine/session"), "utf8")).toBe("preserved state\n");
  expect(fs.readFileSync(fixture.host("/srv/zeros/home/engine-capture/state"), "utf8")).toBe("preserved state\n");
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
  expect(fds.size).toBe(0);
});
it("accepts already migrated HOME artifacts before its first completion marker", () => {
  const fixture = stateFixture();
  fs.unlinkSync(fixture.host("/srv/zeros/home/agent/session"));
  fs.unlinkSync(fixture.host("/srv/zeros/home/capture/state"));
  fixture.directory("/srv/zeros/home/engine", 10003);
  fixture.directory("/srv/zeros/home/engine-capture", 10003, 0o700);
  const binary = "/srv/zeros/home/engine/tool";
  fixture.file(binary, 10003);
  fs.linkSync(fixture.host(binary), fixture.host("/srv/zeros/home/engine/tool-link"));
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).not.toThrow();
  expect(owners.get(binary)).toEqual({ uid: 10003, gid: 10003 });
  expect(fs.lstatSync(fixture.host(binary)).nlink).toBe(2);
  expect(fs.existsSync(fixture.host(marker))).toBe(true);
});
it("does not publish completion when the creation descriptor contains an incomplete write", () => {
  const fixture = stateFixture();
  const shortWrite = { ...fixture.io, writeFileSync: (fd: number, body: string) => fs.writeFileSync(fd, body.slice(0, 5)) };
  expect(() => adoptCloudEngineState(fixture.runtime, shortWrite)).toThrow(/ownership/);
  expect(fs.existsSync(fixture.host(marker))).toBe(false);
  expect(fds.size).toBe(0);
});
it("refuses a same-byte completion replacement after opening the original read descriptor", () => {
  const fixture = stateFixture(); adoptCloudEngineState(fixture.runtime, fixture.io);
  io.fchownSync.mockClear();
  const racing = { ...fixture.io, readFileSync: (fd: number, encoding: "utf8") => {
    const body = fs.readFileSync(fd, encoding);
    fs.renameSync(fixture.host(marker), fixture.host(`${marker}.original`));
    fs.writeFileSync(fixture.host(marker), body, { mode: 0o600 });
    return body;
  } };
  expect(() => adoptCloudEngineState(fixture.runtime, racing)).toThrow(/ownership/);
  expect(io.fchownSync).not.toHaveBeenCalled();
  expect(fds.size).toBe(0);
});
it("retains the original created inode through publication rather than accepting its replacement", () => {
  const fixture = stateFixture();
  const racing = { ...fixture.io, renameSync: (source: string, target: string) => {
    fixture.io.renameSync(source, target);
    if (target === marker) {
      fs.renameSync(fixture.host(marker), fixture.host(`${marker}.original`));
      fs.writeFileSync(fixture.host(marker), '{"version":1,"uid":10003,"gid":10003}\n', { mode: 0o600 });
    }
  } };
  expect(() => adoptCloudEngineState(fixture.runtime, racing)).toThrow(/ownership/);
  expect(fds.size).toBe(0);
});
it.each(["foreign-owner", "symlink", "hardlink", "malformed", "writable"])("does not trust a %s completion marker", failure => {
  const fixture = stateFixture();
  const body = '{"version":1,"uid":10003,"gid":10003}\n';
  if (failure === "symlink") {
    fixture.file("/srv/zeros/other", 0, body); fs.symlinkSync(fixture.host("/srv/zeros/other"), fixture.host(marker));
  } else {
    fixture.file(marker, failure === "foreign-owner" ? 10003 : 0, failure === "malformed" ? "{}" : body);
    if (failure === "hardlink") fs.linkSync(fixture.host(marker), fixture.host("/srv/zeros/other"));
    if (failure === "writable") fs.chmodSync(fixture.host(marker), 0o666);
  }
  fixture.io.readdirSync.mockClear();
  expect(() => adoptCloudEngineState(fixture.runtime, fixture.io)).toThrow(/ownership/);
  expect(fixture.io.readdirSync).not.toHaveBeenCalled();
  expect(io.fchownSync).not.toHaveBeenCalled();
  expect(fds.size).toBe(0);
});
