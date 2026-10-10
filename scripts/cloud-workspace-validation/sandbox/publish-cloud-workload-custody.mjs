import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, statfsSync, openSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "/etc/zeros/cloud-workload-custody.json";
export const CLOUD_ROOT_CUSTODY_DIRECTORY = "/run/zeros/workload-custody";
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const treePattern = /^\/sys\/fs\/cgroup\/(?:[A-Za-z0-9_.@-]+\/)*zeros-host\.service\/engine-runtime$/;
const keys = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...names].sort().join("\0");
const positive = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const device = value => value === "0" || positive(value);
const pid = value => Number.isSafeInteger(value) && value >= 2 && value <= 2147483647;
const fail = () => { throw new Error("Cloud workload original custody publication was refused"); };

export function cloudRootProcessBirth(pidValue, source) {
  if (!pid(pidValue) || typeof source !== "string" || source.length > 8192 || !source.startsWith(`${pidValue} (`)) fail();
  const end = source.lastIndexOf(") ");
  const fields = source.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || ["Z", "X"].includes(fields[0]) || !positive(fields[19]) || !/^(0|[1-9][0-9]{0,9})$/.test(fields[1])) fail();
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid > 2147483647) fail();
  return { pid: pidValue, parentPid, startToken: fields[19] };
}

function validateContext(value) {
  if (!keys(value, ["version", "episode", "runtime", "scope", "owner"]) || value.version !== 1 ||
      !new RegExp(`^${uuid}$`).test(value.episode) || !keys(value.runtime, ["runtimeId", "bootId", "supervisorSessionId"]) ||
      !/^r1-[a-f0-9]{64}$/.test(value.runtime.runtimeId) || !new RegExp(`^${uuid}$`).test(value.runtime.bootId) ||
      !new RegExp(`^${uuid}$`).test(value.runtime.supervisorSessionId) || !keys(value.scope, ["directory", "dev", "ino"]) ||
      typeof value.scope.directory !== "string" || !new RegExp(`^engine-(?:workload-)?${uuid}$`).test(path.basename(value.scope.directory)) ||
      !treePattern.test(path.dirname(value.scope.directory)) || !device(value.scope.dev) || !positive(value.scope.ino) ||
      !keys(value.owner, ["pid", "startToken"]) || !pid(value.owner.pid) || !positive(value.owner.startToken)) fail();
}

function processIds(source, required) {
  if (typeof source !== "string" || source.length > 65536) fail();
  for (const name of ["Uid", "Gid"]) {
    const rows = source.split("\n").filter(row => row.startsWith(`${name}:`));
    const values = rows.length === 1 && new RegExp(`^${name}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$`).exec(rows[0]);
    if (!values || values.slice(1).some(value => value !== String(required))) fail();
  }
}

/** A tentative root record is usable only with the original current kernel
 * chain, birth, placement and inode checks. File existence never exempts a PID. */
export function cloudRootControllerBirth(record, expected, io) {
  if (!keys(record, ["version", "episode", "runtime", "scope", "common", "workload", "owner", "monitor", "birth"])) fail();
  const context = { version: record.version, episode: record.episode, runtime: record.runtime, scope: record.scope, owner: record.owner };
  validateContext(context);
  for (const name of ["runtimeId", "bootId", "supervisorSessionId"]) if (record.runtime[name] !== expected.runtime?.[name]) fail();
  if (record.scope.directory !== expected.scope?.directory || record.scope.dev !== expected.scope.dev || record.scope.ino !== expected.scope.ino ||
      record.owner.pid !== expected.owner?.pid || record.owner.startToken !== expected.owner.startToken ||
      expected.episode !== undefined && record.episode !== expected.episode ||
      !keys(record.monitor, ["pid", "startToken"]) || !pid(record.monitor.pid) || !positive(record.monitor.startToken) ||
      !keys(record.birth, ["kind", "pid", "startToken"]) || !pid(record.birth.pid) || !positive(record.birth.startToken) ||
      record.birth.kind !== (path.basename(record.scope.directory).startsWith("engine-workload-") ? "resident" : "engine") ||
      new Set([record.owner.pid, record.monitor.pid, record.birth.pid]).size !== 3) fail();
  for (const identity of [record.common, record.workload, record.scope]) {
    if (!keys(identity, ["directory", "dev", "ino"]) || !device(identity.dev) || !positive(identity.ino)) fail();
    const actual = io.identity(identity.directory);
    if (!actual || actual.directory !== identity.directory || actual.dev !== identity.dev || actual.ino !== identity.ino) fail();
  }
  if (record.common.directory !== path.dirname(record.scope.directory) || record.workload.directory !== `${record.common.directory}/engine-workload-shared/workload`) fail();
  const hostMembership = `0::${path.dirname(record.common.directory).slice("/sys/fs/cgroup".length)}/host`;
  const captured = [];
  const read = (identity, required, membership) => {
    const actual = io.process(identity.pid);
    if (!actual) fail();
    const birth = cloudRootProcessBirth(identity.pid, actual.source);
    if (birth.startToken !== identity.startToken || actual.membership.trim() !== membership) fail();
    processIds(actual.status, required);
    captured.push({ identity, required, membership, parentPid: birth.parentPid });
    return birth;
  };
  const child = read(record.birth, 10003, `0::${record.scope.directory.slice("/sys/fs/cgroup".length)}`);
  if (child.parentPid !== record.monitor.pid) fail();
  let current = read(record.monitor, 0, hostMembership);
  const seen = new Set([record.birth.pid, record.monitor.pid]);
  for (let count = 0; current.parentPid !== record.owner.pid; count++) {
    if (count >= 8 || !pid(current.parentPid) || seen.has(current.parentPid)) fail();
    seen.add(current.parentPid);
    const actual = io.process(current.parentPid);
    if (!actual) fail();
    const birth = cloudRootProcessBirth(current.parentPid, actual.source);
    current = read({ pid: birth.pid, startToken: birth.startToken }, 0, hostMembership);
  }
  read(record.owner, 0, hostMembership);
  // Recheck births/placement after reading the complete chain. Current direct
  // children remain unreaped by their original outside root monitors.
  for (const prior of captured) {
    const actual = io.process(prior.identity.pid);
    if (!actual) fail();
    const birth = cloudRootProcessBirth(prior.identity.pid, actual.source);
    if (birth.startToken !== prior.identity.startToken || birth.parentPid !== prior.parentPid || actual.membership.trim() !== prior.membership) fail();
    processIds(actual.status, prior.required);
  }
  return Object.freeze({ ...record.birth });
}

function physical(file, maximum, mode) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.gid !== 0 || metadata.nlink !== 1 || metadata.size > maximum ||
        (metadata.mode & 0o7777) !== mode || realpathSync(file) !== file) fail();
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

function kernel(file, maximum = 65536) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (statfsSync(`/proc/self/fd/${descriptor}`).type !== 0x9fa0 || !fstatSync(descriptor).isFile()) fail();
    const bytes = Buffer.alloc(maximum + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(descriptor, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    if (size > maximum) fail();
    return bytes.toString("utf8", 0, size);
  } finally { closeSync(descriptor); }
}

const rootIo = {
  identity(directory) {
    const value = statSync(directory, { bigint: true });
    if (!value.isDirectory() || value.uid !== 10003n || value.gid !== 10003n || realpathSync(directory) !== directory || statfsSync(directory).type !== 0x63677270) fail();
    return { directory, dev: String(value.dev), ino: String(value.ino) };
  },
  process(pidValue) { return { source: kernel(`/proc/${pidValue}/stat`, 8192), status: kernel(`/proc/${pidValue}/status`), membership: kernel(`/proc/${pidValue}/cgroup`, 8192) }; },
};

export function readCloudRootControllerRecord(expected) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0 || !expected?.scope?.directory) fail();
  const directory = lstatSync(CLOUD_ROOT_CUSTODY_DIRECTORY);
  if (!directory.isDirectory() || directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o7777) !== 0o700 ||
      realpathSync(CLOUD_ROOT_CUSTODY_DIRECTORY) !== CLOUD_ROOT_CUSTODY_DIRECTORY) fail();
  const leaf = path.basename(expected.scope.directory);
  if (!new RegExp(`^engine-(?:workload-)?${uuid}$`).test(leaf)) fail();
  const record = JSON.parse(physical(`${CLOUD_ROOT_CUSTODY_DIRECTORY}/${leaf}.json`, 16384, 0o600));
  cloudRootControllerBirth(record, expected, rootIo);
  return structuredClone(record);
}

export function readCloudRootProcessBirth(pidValue) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0 || !pid(pidValue)) fail();
  const actual = rootIo.process(pidValue);
  processIds(actual.status, 0);
  return cloudRootProcessBirth(pidValue, actual.source);
}

function publishRecord(record) {
  const file = `${CLOUD_ROOT_CUSTODY_DIRECTORY}/${path.basename(record.scope.directory)}.json`;
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, JSON.stringify(record)); fchownSync(descriptor, 0, 0); fchmodSync(descriptor, 0o600); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}

function validateSeed(value) {
  if (!keys(value, ["version", "common", "workload", "infrastructure", "cpuSplit"]) || value.version !== 1 ||
      !keys(value.common, ["directory", "dev", "ino"]) || !treePattern.test(value.common.directory) || value.common.directory.length > 4096 ||
      !device(value.common.dev) || !positive(value.common.ino) || !keys(value.workload, ["directory", "dev", "ino"]) ||
      value.workload.directory !== `${value.common.directory}/engine-workload-shared/workload` ||
      !device(value.workload.dev) || !positive(value.workload.ino) || !Array.isArray(value.infrastructure) || value.infrastructure.length >= 16) fail();
  const seen = new Set();
  for (const birth of value.infrastructure) {
    if (!keys(birth, ["kind", "pid", "startToken"]) || !["engine", "resident"].includes(birth.kind) ||
        !pid(birth.pid) || !positive(birth.startToken) || seen.has(birth.pid)) fail();
    seen.add(birth.pid);
  }
  const split = value.cpuSplit;
  if (!keys(split, ["engine", "workload"]) || !keys(split.engine, ["cpuMax", "cpuWeight"]) ||
      split.engine.cpuMax !== "max 100000" || split.engine.cpuWeight !== 100 ||
      !keys(split.workload, ["controllers", "cpuWeight", "cap"]) || split.workload.cpuWeight !== 100 ||
      !Array.isArray(split.workload.controllers) || split.workload.controllers.join(",") !== "cpu") fail();
  const cap = split.workload.cap;
  if (cap?.kind === "applied") {
    if (!keys(cap, ["kind", "effectiveCpus", "cpuMax"]) || !Number.isInteger(cap.effectiveCpus) || cap.effectiveCpus < 1 || cap.effectiveCpus > 65536 ||
        !/^[1-9][0-9]{0,18} 100000$/.test(cap.cpuMax)) fail();
  } else if (!keys(cap, ["kind", "cpuMax", "diagnostic"]) || cap.kind !== "skipped" || cap.cpuMax !== "max 100000" ||
      !["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"].includes(cap.diagnostic)) fail();
}

/** Called only by the pinned root publisher for its parent's unreaped direct
 * fork. This data is presentation until root custody and the RO file are
 * independently checked; it never grants PID or native execution authority. */
export function cloudWorkloadCustodyBirth(seed, child) {
  validateSeed(seed);
  if (!pid(child?.pid) || !pid(child.parentPid) || typeof child.source !== "string" || child.source.length > 8192 ||
      typeof child.scope !== "string" || !child.scope.startsWith(`${seed.common.directory}/`)) fail();
  const leaf = child.scope.slice(seed.common.directory.length + 1);
  const kind = new RegExp(`^engine-${uuid}$`).test(leaf) ? "engine" :
    new RegExp(`^engine-workload-${uuid}$`).test(leaf) ? "resident" : null;
  if (!kind || !child.source.startsWith(`${child.pid} (`)) fail();
  const end = child.source.lastIndexOf(") ");
  const fields = child.source.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || ["Z", "X"].includes(fields[0]) || fields[1] !== String(child.parentPid) || !positive(fields[19])) fail();
  const birth = { kind, pid: child.pid, startToken: fields[19] };
  if (seed.infrastructure.some(prior => prior.pid === child.pid)) fail();
  return { ...structuredClone(seed), infrastructure: [...structuredClone(seed.infrastructure), birth] };
}

/** Reading the seed through this descriptor left its offset at the old end.
 * Write from byte zero: an offset write after truncation leaves a NUL hole
 * that every later custody reader refuses. */
export function replaceCloudCustodyDocument(descriptor, encoded) {
  const bytes = Buffer.from(encoded);
  ftruncateSync(descriptor, 0);
  for (let written = 0; written < bytes.length;) {
    const count = writeSync(descriptor, bytes, written, bytes.length - written, written);
    if (!(count > 0)) fail();
    written += count;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0 || args.length !== 2 || !/^[1-9][0-9]{0,9}$/.test(args[1])) fail();
  const originalPid = Number(args[1]);
  const descriptor = openSync(FILE, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.gid !== 0 || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o444 ||
        metadata.size > 16384 || realpathSync(FILE) !== FILE) fail();
    const seed = JSON.parse(readFileSync(descriptor, "utf8"));
    validateSeed(seed);
    for (const identity of [seed.common, seed.workload]) {
      const actual = statSync(identity.directory, { bigint: true });
      if (realpathSync(identity.directory) !== identity.directory || !actual.isDirectory() || actual.uid !== 10003n ||
          String(actual.dev) !== identity.dev || String(actual.ino) !== identity.ino || statfsSync(identity.directory).type !== 0x63677270) fail();
    }
    const result = cloudWorkloadCustodyBirth(seed, { pid: originalPid, parentPid: process.ppid, scope: args[0], source: readFileSync(`/proc/${originalPid}/stat`, "utf8") });
    const controlDirectory = lstatSync(CLOUD_ROOT_CUSTODY_DIRECTORY);
    if (!controlDirectory.isDirectory() || controlDirectory.uid !== 0 || controlDirectory.gid !== 0 || (controlDirectory.mode & 0o7777) !== 0o700 || realpathSync(CLOUD_ROOT_CUSTODY_DIRECTORY) !== CLOUD_ROOT_CUSTODY_DIRECTORY) fail();
    const context = JSON.parse(physical(`${CLOUD_ROOT_CUSTODY_DIRECTORY}/${path.basename(args[0])}.launch.json`, 8192, 0o444));
    validateContext(context);
    if (context.scope.directory !== args[0] || context.runtime.runtimeId !== path.basename(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))))) fail();
    const identity = rootIo.identity(args[0]);
    if (identity.dev !== context.scope.dev || identity.ino !== context.scope.ino) fail();
    const monitor = cloudRootProcessBirth(process.ppid, kernel(`/proc/${process.ppid}/stat`, 8192));
    publishRecord({ ...context, common: seed.common, workload: seed.workload, monitor: { pid: monitor.pid, startToken: monitor.startToken }, birth: result.infrastructure.at(-1) });
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 16384) fail();
    replaceCloudCustodyDocument(descriptor, encoded);
  } finally { closeSync(descriptor); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { process.stderr.write("cloud workload original custody publication refused\n"); process.exitCode = 125; }
}
