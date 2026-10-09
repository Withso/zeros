import * as fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { hasCloudEngineUserNamespace, isCloudDeploymentOwner, isCloudRuntimeCgroupRoot } from "./cloud-runtime-root.mjs";

const CGROUP2 = 0x63677270;
const PROJECTION = "/etc/zeros/cloud-workload-custody.json";
const MAX_BYTES = 65536, MAX_MEMBERS = 4096, MAX_GROUPS = 4096;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const decimal = value => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const token = value => decimal(value) && value !== "0";
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const unavailable = () => Object.assign(new Error("Cloud workload custody is not ready"), { code: "cloud_containment_environment_not_ready" });
const inside = (directory, common) => directory === common || directory.startsWith(`${common}/`);
const canonical = directory => typeof directory === "string" && directory.length <= 4096 &&
  !directory.includes("\0") && path.isAbsolute(directory) && path.resolve(directory) === directory;

function boundedRead(descriptor, maximum = MAX_BYTES) {
  const buffer = Buffer.alloc(maximum + 1); let size = 0;
  while (size < buffer.length) {
    const count = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
    if (!count) break;
    size += count;
  }
  if (size > maximum) throw unavailable();
  return buffer.toString("utf8", 0, size);
}
function openControl(directory, name, write = false) {
  if (!canonical(directory) || !/^(?:cgroup\.(?:procs|threads|subtree_control|events)|cpu\.(?:max|weight)|memory\.(?:max|oom\.group)|pids\.max)$/.test(name)) throw unavailable();
  const descriptor = fs.openSync(`${directory}/${name}`, fs.constants.O_NOFOLLOW |
    (write ? fs.constants.O_WRONLY : fs.constants.O_RDONLY));
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || fs.statfsSync(`/proc/self/fd/${descriptor}`).type !== CGROUP2) throw unavailable();
    return descriptor;
  } catch { fs.closeSync(descriptor); throw unavailable(); }
}
function directoryIdentity(directory) {
  if (!canonical(directory) || fs.realpathSync(directory) !== directory) throw unavailable();
  const metadata = fs.lstatSync(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.statfsSync(directory).type !== CGROUP2) throw unavailable();
  return { dev: String(metadata.dev), ino: String(metadata.ino), uid: Number(metadata.uid), mode: Number(metadata.mode), filesystem: CGROUP2 };
}
function kernelMembership(source) {
  if (typeof source !== "string" || source.length > 4096) throw unavailable();
  const match = /^0::(\/[^\0\n]*)\n?$/.exec(source);
  const directory = match && `/sys/fs/cgroup${match[1] === "/" ? "" : match[1]}`;
  if (!canonical(directory)) throw unavailable();
  return directory;
}
function readProc(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return boundedRead(descriptor); } finally { fs.closeSync(descriptor); }
}
function readProcess(pid) {
  try {
    const source = readProc(`/proc/${pid}/stat`);
    const end = source.lastIndexOf(")"), fields = source.slice(end + 1).trim().split(/\s+/);
    const numbers = [fields[1], fields[2], fields[3], fields[4], fields[5]].map(Number);
    if (source.length > MAX_BYTES || end < 0 || !source.startsWith(`${pid} (`) ||
      !numbers.every(Number.isSafeInteger) || numbers.slice(0, 3).some(value => value < 0) ||
      !token(fields[19]) || !/^[A-Z]$/.test(fields[0] ?? "")) throw unavailable();
    const status = readProc(`/proc/${pid}/status`);
    const uidRows = status.split("\n").filter(line => line.startsWith("Uid:"));
    const uid = uidRows.length === 1 && /^Uid:\s+(\d+)\s+\d+\s+\d+\s+\d+\s*$/.exec(uidRows[0]);
    if (status.length > MAX_BYTES || !uid || !Number.isSafeInteger(Number(uid[1]))) throw unavailable();
    let executable = null;
    try {
      const image = fs.statSync(`/proc/${pid}/exe`, { bigint: true });
      if (image.isFile()) executable = { dev: String(image.dev), ino: String(image.ino) };
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
    return { pid, parent: numbers[0], group: numbers[1], session: numbers[2], tty: numbers[3], foreground: numbers[4],
      startToken: fields[19], state: fields[0], directory: kernelMembership(readProc(`/proc/${pid}/cgroup`)),
      uid: Number(uid[1]), executable };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error?.code)) return null;
    throw unavailable();
  }
}

/** Native IO never reads argv/env and never obtains a root-open write FD. */
export const nativeCloudWorkloadIO = Object.freeze({
  identity() {
    if (!hasCloudEngineUserNamespace(4)) throw unavailable();
    return { pid: process.pid, uid: process.getuid(), gid: process.getgid(), euid: process.geteuid(), egid: process.getegid() };
  },
  projection() {
    if (fs.realpathSync(PROJECTION) !== PROJECTION) throw unavailable();
    for (let current = PROJECTION; ; current = path.dirname(current)) {
      const metadata = fs.lstatSync(current);
      if (metadata.isSymbolicLink() || !isCloudDeploymentOwner(current, metadata.uid) || metadata.mode & 0o022 ||
        (current === PROJECTION ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())) throw unavailable();
      if (current === "/") break;
    }
    const descriptor = fs.openSync(PROJECTION, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor), linked = fs.lstatSync(PROJECTION);
      if (opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size < 2 || opened.size > MAX_BYTES) throw unavailable();
      return boundedRead(descriptor);
    } finally { fs.closeSync(descriptor); }
  },
  directory: directoryIdentity,
  control(directory, name) {
    const descriptor = openControl(directory, name);
    try {
      const metadata = fs.fstatSync(descriptor, { bigint: true });
      return { dev: String(metadata.dev), ino: String(metadata.ino), uid: Number(metadata.uid), mode: Number(metadata.mode), filesystem: CGROUP2 };
    } finally { fs.closeSync(descriptor); }
  },
  read(directory, name) {
    const descriptor = openControl(directory, name);
    try { return boundedRead(descriptor); } finally { fs.closeSync(descriptor); }
  },
  children(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
  },
  process: readProcess,
  writeSelf(directory) {
    // The descriptor is opened with THIS non-root process's credentials.
    // Linux checks destination/common-ancestor permission, not target UID.
    const descriptor = openControl(directory, "cgroup.procs", true);
    try {
      const metadata = fs.fstatSync(descriptor);
      if (metadata.uid !== 10003 || metadata.mode & 0o022 || fs.writeSync(descriptor, "0") !== 1) throw unavailable();
    } finally { fs.closeSync(descriptor); }
  },
});

function validateIdentity(io) {
  const identity = io.identity();
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 2 || identity.pid > 2147483647 ||
    [identity.uid, identity.euid, identity.gid, identity.egid].some(value => value !== 10003)) throw unavailable();
  return identity;
}
function validateDirectory(io, expected) {
  if (!exact(expected, ["directory", "dev", "ino"]) || !canonical(expected.directory) || !decimal(expected.dev) || !token(expected.ino)) throw unavailable();
  const actual = io.directory(expected.directory);
  if (!sameInode(actual, expected) || actual.filesystem !== CGROUP2 || actual.uid !== 10003 || actual.mode & 0o022) throw unavailable();
}
function validateMigration(io, directory) {
  for (const name of ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]) {
    const control = io.control(directory, name);
    if (control.filesystem !== CGROUP2 || control.uid !== 10003 || control.mode & 0o022) throw unavailable();
  }
}
function validateLimit(io, directory, name) {
  const control = io.control(directory, name);
  if (control.filesystem !== CGROUP2 || ![0, 65534].includes(control.uid) || control.mode & 0o022) throw unavailable();
  const value = io.read(directory, name).trim();
  if (name === "cpu.weight" ? value !== "100" : name === "cpu.max" ? !/^(?:max|[1-9][0-9]{0,18}) [1-9][0-9]{0,18}$/.test(value) :
    !/^[1-9][0-9]{0,18}$/.test(value)) throw unavailable();
}
function projection(root, io, requireController) {
  const identity = validateIdentity(io);
  if (!isCloudRuntimeCgroupRoot(root)) throw unavailable();
  const source = io.projection();
  if (typeof source !== "string" || source.length > MAX_BYTES) throw unavailable();
  const value = JSON.parse(source);
  if (!exact(value, ["version", "common", "workload", "infrastructure", "cpuSplit"]) || value.version !== 1 ||
    value.common?.directory !== `${root}/engine-runtime` || value.workload?.directory !== `${root}/engine-runtime/engine-workload-shared/workload` ||
    !Array.isArray(value.infrastructure) || !value.infrastructure.length || value.infrastructure.length > 16 ||
    !exact(value.cpuSplit, ["engine", "workload"])) throw unavailable();
  validateDirectory(io, value.common); validateDirectory(io, value.workload);
  validateMigration(io, value.common.directory); validateMigration(io, value.workload.directory);
  if (io.read(value.common.directory, "cgroup.subtree_control").trim() !== "cpu") throw unavailable();
  for (const name of ["cpu.max", "memory.max", "pids.max", "memory.oom.group"]) validateLimit(io, value.common.directory, name);
  validateLimit(io, value.workload.directory, "cpu.max");
  validateLimit(io, value.workload.directory, "cpu.weight");
  const births = new Set(), pids = new Set();
  const infrastructure = value.infrastructure.map(birth => {
    if (!exact(birth, ["kind", "pid", "startToken"]) || !["engine", "resident"].includes(birth.kind) ||
      !Number.isSafeInteger(birth.pid) || birth.pid < 2 || birth.pid > 2147483647 || !token(birth.startToken) ||
      births.has(`${birth.pid}:${birth.startToken}`) || pids.has(birth.pid)) throw unavailable();
    births.add(`${birth.pid}:${birth.startToken}`); pids.add(birth.pid);
    const current = io.process(birth.pid);
    const prefix = birth.kind === "engine" ? "engine-" : "engine-workload-";
    const controlDirectory = current?.startToken === birth.startToken && current.uid === 10003 &&
      path.dirname(current.directory) === value.common.directory &&
      new RegExp(`^${prefix}${UUID}$`).test(path.basename(current.directory)) ? current.directory : null;
    if (controlDirectory) validateLimit(io, controlDirectory, "cpu.weight");
    const control = controlDirectory ? io.directory(controlDirectory) : null;
    const controlIdentity = control ? Object.freeze({ directory: controlDirectory, dev: control.dev, ino: control.ino }) : null;
    return Object.freeze({ ...birth, controlDirectory, controlIdentity });
  });
  if (requireController && !infrastructure.some(birth => birth.pid === identity.pid && birth.controlDirectory)) throw unavailable();
  return Object.freeze({ version: 1, common: Object.freeze({ ...value.common }), workload: Object.freeze({ ...value.workload }),
    infrastructure: Object.freeze(infrastructure), cpuSplit: value.cpuSplit });
}

/** Controller activation requires its exact root-projected birth. */
export function loadCloudWorkloadCustody(root, io = nativeCloudWorkloadIO) {
  try { return projection(root, io, true); } catch { throw unavailable(); }
}
export function cloudWorkloadEntryDescriptor(custody) {
  return Object.freeze({ version: 1, common: custody.common, workload: custody.workload });
}

/** Before target exec: self migration only, with unprivileged opener creds. */
export function enterCloudWorkload(entry, io = nativeCloudWorkloadIO) {
  try {
    const identity = validateIdentity(io);
    const root = entry?.common?.directory?.slice(0, -"/engine-runtime".length);
    const current = projection(root, io, false);
    if (entry?.version !== 1 || !sameInode(entry.common, current.common) || !sameInode(entry.workload, current.workload) ||
      entry.common.directory !== current.common.directory || entry.workload.directory !== current.workload.directory) throw unavailable();
    const before = io.process(identity.pid);
    if (!before || before.uid !== 10003 || !inside(before.directory, current.common.directory)) throw unavailable();
    io.writeSelf(current.workload.directory);
    const after = io.process(identity.pid);
    if (!after || after.startToken !== before.startToken || after.directory !== current.workload.directory || after.uid !== 10003) throw unavailable();
    validateDirectory(io, current.common); validateDirectory(io, current.workload);
  } catch { throw unavailable(); }
}

function population(source) {
  const lines = typeof source === "string" && source.length <= MAX_BYTES ? source.trim().split("\n").filter(line => line.startsWith("populated ")) : [];
  if (lines.length !== 1 || !/^populated [01]$/.test(lines[0])) throw unavailable();
  return lines[0] === "populated 1";
}
function scan(custody, io) {
  validateDirectory(io, custody.common); validateDirectory(io, custody.workload);
  const pending = [custody.common.directory], groups = [], seen = new Set(), owners = new Map(), members = [];
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > MAX_GROUPS) throw unavailable();
    const directory = pending[index];
    if (!inside(directory, custody.common.directory) || directory.split("/").length > 128) throw unavailable();
    const metadata = io.directory(directory);
    if (metadata.filesystem !== CGROUP2 || !decimal(metadata.dev) || !token(metadata.ino)) throw unavailable();
    const children = io.children(directory).sort();
    if (new Set(children).size !== children.length || children.some(name => typeof name !== "string" || !name ||
      name.length > 255 || [".", ".."].includes(name) || /[/\0]/.test(name))) throw unavailable();
    for (const name of children) pending.push(`${directory}/${name}`);
    const source = io.read(directory, "cgroup.procs");
    if (typeof source !== "string" || source.length > MAX_BYTES) throw unavailable();
    const pids = source.trim() ? source.trim().split("\n").map(line => {
      if (!/^[1-9][0-9]{0,9}$/.test(line) || Number(line) > 2147483647) throw unavailable();
      return Number(line);
    }) : [];
    const unique = [...new Set(pids)].sort((a, b) => a - b);
    for (const pid of unique) {
      if (seen.has(pid) || seen.size >= MAX_MEMBERS) throw unavailable();
      seen.add(pid); owners.set(pid, directory);
      const member = io.process(pid);
      if (!member || member.pid !== pid || member.directory !== directory || !token(member.startToken) ||
        ![member.parent, member.group, member.session, member.tty, member.foreground, member.uid].every(Number.isSafeInteger) ||
        !/^[A-Z]$/.test(member.state)) throw unavailable();
      members.push(member);
    }
    groups.push({ directory, dev: metadata.dev, ino: metadata.ino, children, pids: unique,
      populated: population(io.read(directory, "cgroup.events")) });
  }
  for (const group of groups) if (group.populated !== [...owners.values()].some(directory => inside(directory, group.directory))) throw unavailable();
  return { groups, members };
}
const censusIdentity = census => JSON.stringify({ groups: census.groups,
  births: census.members.map(member => [member.pid, member.startToken, member.directory]).sort((a, b) => a[0] - b[0]) });

/** Read-only ALL-tree census. Metadata never grants process signaling. */
export function inspectCloudWorkloadTree(custody, io = nativeCloudWorkloadIO) {
  try {
    const first = scan(custody, io), current = scan(custody, io);
    if (censusIdentity(first) !== censusIdentity(current)) throw unavailable();
    const infrastructurePids = [], workloadPids = [];
    for (const member of current.members) {
      const original = custody.infrastructure.find(birth => birth.pid === member.pid && birth.startToken === member.startToken &&
        birth.controlDirectory === member.directory && birth.controlIdentity &&
        current.groups.some(group => group.directory === member.directory && sameInode(group, birth.controlIdentity)) && member.uid === 10003);
      (original ? infrastructurePids : workloadPids).push(member.pid);
    }
    const censusSha256 = createHash("sha256").update(JSON.stringify({
      groups: current.groups,
      // Correlation describes the same kernel tree in every controller view,
      // independently of that view's immutable infrastructure exemptions.
      // Scheduling state changes during RPC waits; C3 rechecks it separately
      // on the final complete census before subtracting any quiet terminal.
      processes: [...current.members].sort((a, b) => a.pid - b.pid).map(member => Object.fromEntries(Object.entries(member).filter(([key]) => key !== "state"))),
    })).digest("hex");
    return { complete: true, populated: current.groups[0].populated, processes: current.members,
      workloadPids: workloadPids.sort((a, b) => a - b), infrastructurePids: infrastructurePids.sort((a, b) => a - b),
      common: custody.common, groups: current.groups.length, censusSha256 };
  } catch {
    return { complete: false, populated: true, processes: [], workloadPids: [], infrastructurePids: [], common: custody.common, groups: 0, censusSha256: null };
  }
}
