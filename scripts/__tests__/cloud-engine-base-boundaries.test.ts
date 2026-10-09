import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as adoption from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

// Exact runtime paths with explicit fake ownership. Files, bytes and inodes
// are real temporary entries; no physical root directory is changed.
let root: string;
const owners = new Map<string, { uid: number; gid: number }>();
const fds = new Map<number, string>();
const moves: Array<[string, string]> = [];
const hostPath = (file: string) => path.join(root, file);
const owned = (stat: fs.Stats, file: string) => Object.assign(stat, owners.get(file) ?? { uid: 0, gid: 0 });
const io = {
  ...fs,
  existsSync: (file: string) => fs.existsSync(hostPath(file)),
  realpathSync: (file: string) => fs.realpathSync(hostPath(file)).slice(root.length) || "/",
  lstatSync: (file: string) => owned(fs.lstatSync(hostPath(file)), file),
  readdirSync: (file: string) => fs.readdirSync(hostPath(file)),
  mkdirSync: (file: string, options: fs.MakeDirectoryOptions) => fs.mkdirSync(hostPath(file), options),
  openSync: (file: string, flags: number) => { const fd = fs.openSync(hostPath(file), flags); fds.set(fd, file); return fd; },
  fstatSync: (fd: number) => owned(fs.fstatSync(fd), fds.get(fd)!),
  closeSync: (fd: number) => { fds.delete(fd); fs.closeSync(fd); },
  fchownSync: vi.fn((fd: number, uid: number, gid: number) => { owners.set(fds.get(fd)!, { uid, gid }); }),
  lchownSync: vi.fn((file: string, uid: number, gid: number) => { owners.set(file, { uid, gid }); }),
  renameSync: (source: string, target: string) => {
    if (fs.lstatSync(hostPath(source)).isDirectory()) throw new Error("Boat HOME migration must not rename a directory");
    fs.renameSync(hostPath(source), hostPath(target));
    owners.set(target, owners.get(source)!); owners.delete(source); moves.push([source, target]);
  },
};
const agent = "/srv/zeros/home/agent", capture = "/srv/zeros/home/capture";
const currentAgent = "/srv/zeros/home/engine", currentCapture = "/srv/zeros/home/engine-capture";
const fixed = [agent, capture, "/srv/zeros/files/.zeros-setup", "/srv/zeros/log", "/srv/zeros/managed-settings"];
function directory(file: string, uid: number, gid: number, mode: number) {
  fs.mkdirSync(hostPath(file), { recursive: true }); fs.chmodSync(hostPath(file), mode); owners.set(file, { uid, gid });
}
function file(name: string, uid: number, gid: number, mode = 0o600) {
  fs.writeFileSync(hostPath(name), "preserved private state\n", { mode }); owners.set(name, { uid, gid });
}
function observation() {
  return Object.fromEntries(fixed.map(name => {
    const stat = io.lstatSync(name); return [name, { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }];
  }));
}
function assertOriginalBase() {
  const raw = execFileSync("python3", ["-B", path.resolve("scripts/__tests__/fixtures/cloud-engine-base-reader.py")], {
    input: JSON.stringify(observation()), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(JSON.parse(raw)).toEqual({ requirePersistence: true, coldCreate: true });
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-base-boundaries-")));
  owners.clear(); fds.clear(); moves.length = 0; io.fchownSync.mockClear(); io.lchownSync.mockClear();
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  directory("/", 0, 0, 0o755);
  for (const name of ["/srv", "/srv/zeros", "/srv/zeros/files", "/srv/zeros/home"]) directory(name, 0, 0, 0o755);
  directory(agent, 10001, 10001, 0o755); directory(capture, 10002, 10002, 0o700);
  directory("/srv/zeros/files/.zeros-setup", 0, 10001, 0o710);
  directory("/srv/zeros/log", 0, 10001, 0o750); file("/srv/zeros/log/engine.log", 0, 10001, 0o640);
  directory("/srv/zeros/managed-settings", 0, 10001, 0o750);
  file("/srv/zeros/managed-settings/settings.managed.toml", 0, 10001, 0o640);
  directory(`${agent}/.claude`, 10001, 10001, 0o700);
  file(`${agent}/.claude/conversation.json`, 10001, 10001);
  file(`${capture}/preferences`, 10002, 10002);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("control: the original frozen parent identities pass continuing and cold persistence", () => assertOriginalBase());
it("preserves the fixed parent groups instead of rewriting the frozen base persistence contract", () => {
  const before = observation();
  adoption.adoptCloudEngineRuntimeGroups(io);
  expect(observation()).toEqual(before);
  expect(io.fchownSync).not.toHaveBeenCalled();
  assertOriginalBase();
});
it("moves HOME files into current runtime sources with the original roots and file inodes intact", () => {
  const roots = fixed.map(name => ({ name, stat: io.lstatSync(name) }));
  const source = `${agent}/.claude/conversation.json`, before = io.lstatSync(source);
  adoption.adoptCloudEngineHomes(io);
  expect(io.lstatSync(`${currentAgent}/.claude/conversation.json`)).toMatchObject({
    uid: 10003, gid: 10003, ino: before.ino, dev: before.dev, mode: before.mode,
  });
  expect(fs.readFileSync(hostPath(`${currentAgent}/.claude/conversation.json`), "utf8")).toBe("preserved private state\n");
  expect(io.lstatSync(currentAgent)).toMatchObject({ uid: 10003, gid: 10003 });
  expect(io.lstatSync(currentCapture)).toMatchObject({ uid: 10003, gid: 10003 });
  for (const { name, stat } of roots) expect(io.lstatSync(name)).toMatchObject({ uid: stat.uid, gid: stat.gid, ino: stat.ino, mode: stat.mode });
  expect(io.readdirSync(`${agent}/.claude`)).toEqual([]);
  const count = moves.length; adoption.adoptCloudEngineHomes(io); expect(moves).toHaveLength(count);
  assertOriginalBase();
});
it("keeps symlink text and outside files intact without following the migrated link", () => {
  const outside = "/srv/zeros/private";
  file(outside, 0, 0);
  const link = `${agent}/external`;
  fs.symlinkSync(outside, hostPath(link)); owners.set(link, { uid: 10001, gid: 10001 });
  const before = io.lstatSync(link);
  adoption.adoptCloudEngineHomes(io);
  expect(fs.readlinkSync(hostPath(`${currentAgent}/external`))).toBe(outside);
  expect(io.lstatSync(`${currentAgent}/external`)).toMatchObject({ ino: before.ino, uid: 10003, gid: 10003 });
  expect(io.lstatSync(outside)).toMatchObject({ uid: 0, gid: 0 });
  expect(io.readdirSync(agent)).not.toContain("external");
  assertOriginalBase();
});
it("resumes an interrupted file migration without moving directories or overwriting current state", () => {
  const interrupted = { ...io, renameSync: (source: string, target: string) => {
    if (moves.length === 1) throw Object.assign(new Error("interrupted move"), { code: "EIO" });
    io.renameSync(source, target);
  } };
  expect(() => adoption.adoptCloudEngineHomes(interrupted)).toThrow(/interrupted/);
  expect(moves).toHaveLength(1);
  const moved = moves[0][1], first = io.lstatSync(moved);
  adoption.adoptCloudEngineHomes(io);
  expect(moves).toHaveLength(2);
  expect(io.lstatSync(moved)).toMatchObject({ ino: first.ino, mode: first.mode });
  expect(fs.readFileSync(hostPath(`${currentAgent}/.claude/conversation.json`), "utf8")).toBe("preserved private state\n");
  expect(fs.readFileSync(hostPath(`${currentCapture}/preferences`), "utf8")).toBe("preserved private state\n");
  assertOriginalBase();
});
it.each(["foreign-file", "hardlink", "target-collision", "foreign-target"])("refuses %s before moving any legacy HOME state", failure => {
  if (failure === "foreign-file") owners.set(`${agent}/.claude/conversation.json`, { uid: 10004, gid: 10004 });
  if (failure === "hardlink") fs.linkSync(hostPath(`${capture}/preferences`), hostPath(`${capture}/duplicate`));
  if (failure === "target-collision" || failure === "foreign-target") {
    directory(currentAgent, failure === "foreign-target" ? 10004 : 10003, failure === "foreign-target" ? 10004 : 10003, 0o755);
    if (failure === "target-collision") { directory(`${currentAgent}/.claude`, 10003, 10003, 0o700); file(`${currentAgent}/.claude/conversation.json`, 10003, 10003); }
  }
  expect(() => adoption.adoptCloudEngineHomes(io)).toThrow(/ownership/);
  expect(moves).toEqual([]); expect(io.fchownSync).not.toHaveBeenCalled();
  assertOriginalBase();
});
