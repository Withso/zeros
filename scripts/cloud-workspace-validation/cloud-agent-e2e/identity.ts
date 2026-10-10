import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync } from "node:fs";
import type { CloudActiveRuntime } from "../../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { HarnessFailure } from "./assertions";
import { assertPrivatePidNamespace } from "./fixture-scope";
import { FIXTURE_ENGINE_ID_MAP, requireFixtureEngineIdentity, type FixtureEngineIdentity } from "./projection";
import { installedHarnessPaths, type InstalledCgroupIdentity } from "./runtime-contract";
type ProcessIdentity = { pid: number; executable: string; uidMap: string; gidMap: string; status: string; stat: string; cgroup?: string };
export type RuntimeEngineIdentity = FixtureEngineIdentity & { readonly pid: number; readonly startTimeTicks: number };
const missing = () => new HarnessFailure("engine_identity_missing");
function exactMap(value: string): boolean {
  const rows = value.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  return JSON.stringify(rows) === JSON.stringify(FIXTURE_ENGINE_ID_MAP);
}
function field(status: string, name: string): string | undefined {
  const values = status.split("\n").filter(line => line.startsWith(`${name}:`));
  return values.length === 1 ? values[0].slice(name.length + 1).trim() : undefined;
}
export type InstalledRootIdentity = Readonly<{ pid: number; startTimeTicks: number; executable: string;
  uid: number; gid: number; euid: number; egid: number; mountNamespace: string; pidNamespace: string;
  procFilesystemType: number; cgroupFilesystemType: number; cgroup: string;
  service: InstalledCgroupIdentity; host: InstalledCgroupIdentity }>;

/** Installed mode runs in the test VM's real proc/cgroup view. It never grants
 * the private SOURCE namespace exemption or derives root custody from a PID. */
export function requireInstalledRootIdentity(value: InstalledRootIdentity, active: CloudActiveRuntime,
  previous?: InstalledRootIdentity): InstalledRootIdentity {
  try {
    const paths = installedHarnessPaths(active);
    const cgroupIdentity = (identity: InstalledCgroupIdentity, directory: string) => identity?.directory === directory &&
      Object.keys(identity).sort().join(",") === "dev,directory,ino" &&
      /^(0|[1-9][0-9]{0,19})$/.test(identity.dev) && /^[1-9][0-9]{0,19}$/.test(identity.ino) &&
      BigInt(identity.dev) <= (1n << 64n) - 1n && BigInt(identity.ino) <= (1n << 64n) - 1n;
    if (![value.uid, value.euid, value.gid, value.egid].every(id => id === 0) ||
      !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.startTimeTicks) || value.startTimeTicks <= 0 ||
      value.executable !== `${active.root}/bin/node` || value.procFilesystemType !== 0x9fa0 || value.cgroupFilesystemType !== 0x63677270 ||
      !/^mnt:\[[0-9]{1,20}\]$/.test(value.mountNamespace) || !/^pid:\[[0-9]{1,20}\]$/.test(value.pidNamespace) ||
      value.cgroup.trim() !== `0::${paths.host.slice("/sys/fs/cgroup".length)}` ||
      !cgroupIdentity(value.service, paths.service) || !cgroupIdentity(value.host, paths.host)) throw new Error();
    const observed = Object.freeze({ pid: value.pid, startTimeTicks: value.startTimeTicks, executable: value.executable,
      uid: value.uid, gid: value.gid, euid: value.euid, egid: value.egid, mountNamespace: value.mountNamespace,
      pidNamespace: value.pidNamespace, procFilesystemType: value.procFilesystemType, cgroupFilesystemType: value.cgroupFilesystemType,
      cgroup: value.cgroup, service: Object.freeze({ ...value.service }), host: Object.freeze({ ...value.host }) });
    if (previous && JSON.stringify(observed) !== JSON.stringify(previous)) throw new Error();
    return observed;
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

/** The spawned private operator inherits the original root view and /host.
 * Its fresh birth is captured once, then final messages must retain it. */
export function requireInstalledHarnessChildRoot(value: InstalledRootIdentity, active: CloudActiveRuntime,
  parent: InstalledRootIdentity, childPid: number, previous?: InstalledRootIdentity): InstalledRootIdentity {
  try {
    const original = requireInstalledRootIdentity(parent, active), child = requireInstalledRootIdentity(value, active, previous);
    if (child.pid !== childPid || child.pid === original.pid || child.startTimeTicks < original.startTimeTicks ||
      child.mountNamespace !== original.mountNamespace || child.pidNamespace !== original.pidNamespace ||
      JSON.stringify(child.service) !== JSON.stringify(original.service) || JSON.stringify(child.host) !== JSON.stringify(original.host)) throw new Error();
    return child;
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

function directoryIdentity(directory: string, uid: number): InstalledCgroupIdentity {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid) || stat.gid !== BigInt(uid) ||
    realpathSync(directory) !== directory || stat.ino <= 0n) throw missing();
  return Object.freeze({ directory, dev: String(stat.dev), ino: String(stat.ino) });
}
export function observedInstalledCgroupIdentity(directory: string): InstalledCgroupIdentity {
  const common = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime";
  if (directory !== common && !directory.startsWith(`${common}/`)) throw missing();
  return directoryIdentity(directory, 10003);
}

export function observedInstalledRootIdentity(active: CloudActiveRuntime, previous?: InstalledRootIdentity): InstalledRootIdentity {
  try {
    const paths = installedHarnessPaths(active);
    const stat = readFileSync("/proc/self/stat", "utf8"), status = readFileSync("/proc/self/status", "utf8");
    const before = processBirth({ pid: process.pid, executable: process.execPath, uidMap: "", gidMap: "", status, stat });
    if (!before) throw missing();
    const observed = requireInstalledRootIdentity({ pid: process.pid, startTimeTicks: before.startTimeTicks,
      executable: readlinkSync("/proc/self/exe"), uid: process.getuid!(), gid: process.getgid!(), euid: process.geteuid!(), egid: process.getegid!(),
      mountNamespace: readlinkSync("/proc/self/ns/mnt"), pidNamespace: readlinkSync("/proc/self/ns/pid"),
      procFilesystemType: statfsSync("/proc").type, cgroupFilesystemType: statfsSync(paths.service).type,
      cgroup: readFileSync("/proc/self/cgroup", "utf8"), service: directoryIdentity(paths.service, 0), host: directoryIdentity(paths.host, 0) }, active, previous);
    const after = processBirth({ pid: process.pid, executable: process.execPath, uidMap: "", gidMap: "", status,
      stat: readFileSync("/proc/self/stat", "utf8") });
    if (!after || before.parent !== after.parent || before.startTimeTicks !== after.startTimeTicks) throw missing();
    return observed;
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}
/** Observe only an already-owned direct operator child, with original birth
 * rechecks before any signal. No proc argv or environment is read. */
export function observedInstalledHarnessChildRoot(active: CloudActiveRuntime, parent: InstalledRootIdentity,
  childPid: number, previous?: InstalledRootIdentity): InstalledRootIdentity {
  try {
    observedInstalledRootIdentity(active, parent);
    if (!Number.isSafeInteger(childPid) || childPid <= 1) throw missing();
    const prefix = `/proc/${childPid}`, status = readFileSync(`${prefix}/status`, "utf8"), stat = readFileSync(`${prefix}/stat`, "utf8");
    const birth = processBirth({ pid: childPid, executable: "", uidMap: "", gidMap: "", status, stat });
    if (!birth || birth.parent !== parent.pid || !["Uid", "Gid"].every(name => field(status, name)?.split(/\s+/).join(",") === "0,0,0,0")) throw missing();
    const paths = installedHarnessPaths(active);
    const observed = requireInstalledHarnessChildRoot({ pid: childPid, startTimeTicks: birth.startTimeTicks,
      executable: readlinkSync(`${prefix}/exe`), uid: 0, gid: 0, euid: 0, egid: 0,
      mountNamespace: readlinkSync(`${prefix}/ns/mnt`), pidNamespace: readlinkSync(`${prefix}/ns/pid`),
      procFilesystemType: statfsSync("/proc").type, cgroupFilesystemType: statfsSync(paths.service).type,
      cgroup: readFileSync(`${prefix}/cgroup`, "utf8"), service: directoryIdentity(paths.service, 0), host: directoryIdentity(paths.host, 0) }, active, parent, childPid, previous);
    const after = processBirth({ pid: childPid, executable: "", uidMap: "", gidMap: "", status: readFileSync(`${prefix}/status`, "utf8"),
      stat: readFileSync(`${prefix}/stat`, "utf8") });
    if (!after || after.parent !== birth.parent || after.startTimeTicks !== birth.startTimeTicks) throw missing();
    observedInstalledRootIdentity(active, parent);
    return observed;
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}
function processBirth(sample: ProcessIdentity): { parent: number; startTimeTicks: number } | undefined {
  const stat = /^(\d+) \(.*\) ([A-Za-z]) (.*)$/s.exec(sample.stat.trim());
  if (!stat || Number(stat[1]) !== sample.pid) return;
  const rest = stat[3].trim().split(/\s+/);
  if (rest.length < 19 || rest.some(value => !/^-?\d+$/.test(value))) return;
  const parent = Number(rest[0]), startTimeTicks = Number(rest[18]);
  if (!Number.isSafeInteger(parent) || parent < 0 || !Number.isSafeInteger(startTimeTicks) || startTimeTicks <= 0 ||
    field(sample.status, "PPid") !== String(parent)) return;
  return { parent, startTimeTicks };
}
function engineProtection(sample: ProcessIdentity): FixtureEngineIdentity | undefined {
  if (!exactMap(sample.uidMap) || !exactMap(sample.gidMap) || !["Uid", "Gid"].every(name => {
    const ids = field(sample.status, name)?.split(/\s+/);
    return ids?.length === 4 && ids.every(id => id === "10003");
  }) || !["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(name => /^0{16}$/.test(field(sample.status, name) ?? "")) ||
    field(sample.status, "NoNewPrivs") !== "1" || field(sample.status, "Seccomp") !== "2") return;
  return requireFixtureEngineIdentity({ identityObserved: true, engineUid: 10003, engineGid: 10003,
    uidMap: FIXTURE_ENGINE_ID_MAP, gidMap: FIXTURE_ENGINE_ID_MAP,
    capabilities: { inheritable: 0, permitted: 0, effective: 0, bounding: 0, ambient: 0 }, noNewPrivileges: true, seccomp: 2 });
}
/** Only selects this private fixture's original engine for its graceful signal.
 * Product workload retirement uses the owned registry's independent proof. */
export function selectRuntimeEngineIdentity(samples: readonly ProcessIdentity[], root: string, launcherPid: number,
  previous?: RuntimeEngineIdentity): RuntimeEngineIdentity {
  if (!/^\/opt\/zeros-infra\/r1-[a-f0-9]{64}$/.test(root)) throw new HarnessFailure("fixture_contract_invalid");
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 1 || samples.length > 4096) throw missing();
  const processes = new Map<number, { sample: ProcessIdentity; parent: number; startTimeTicks: number }>();
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.pid) || sample.pid <= 1) continue;
    if (processes.has(sample.pid)) throw missing();
    const birth = processBirth(sample);
    if (birth) processes.set(sample.pid, { sample, ...birth });
  }
  const candidates = [...processes.values()].flatMap(record => {
    if (record.sample.executable !== `${root}/bin/node`) return [];
    const protection = engineProtection(record.sample);
    return protection ? [{ ...record, protection }] : [];
  });
  // An invalid engine ancestor must make observation fail, never promote its
  // correctly protected Node child into a replacement engine.
  const runtimeNodes = new Set([...processes.values()].filter(record => record.sample.executable === `${root}/bin/node`)
    .map(record => record.sample.pid));
  const matches = candidates.filter(record => {
    const seen = new Set<number>();
    let cursor = record.sample.pid;
    for (let depth = 0; depth < 256; depth++) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      if (cursor !== record.sample.pid && runtimeNodes.has(cursor)) return false;
      if (cursor === launcherPid) return true;
      const parent = processes.get(cursor)?.parent;
      if (parent === undefined || parent <= 1) return false;
      cursor = parent;
    }
    return false;
  });
  if (matches.length !== 1) throw missing();
  const match = matches[0];
  if (previous && (previous.pid !== match.sample.pid || previous.startTimeTicks !== match.startTimeTicks)) throw missing();
  return Object.freeze({ ...match.protection, pid: match.sample.pid, startTimeTicks: match.startTimeTicks });
}
export function selectRuntimeEngineProcess(samples: readonly ProcessIdentity[], root: string, launcherPid: number): number {
  return selectRuntimeEngineIdentity(samples, root, launcherPid).pid;
}
export function selectInstalledRuntimeEngineIdentity(samples: readonly ProcessIdentity[], active: CloudActiveRuntime,
  original: InstalledRootIdentity, launcherPid: number, control: string, previous?: RuntimeEngineIdentity): RuntimeEngineIdentity {
  try {
    requireInstalledRootIdentity(original, active);
    const prefix = `${installedHarnessPaths(active).common}/engine-`;
    if (!control.startsWith(prefix) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(control.slice(prefix.length))) throw missing();
    const root = samples.find(sample => sample.pid === original.pid), birth = root && processBirth(root);
    if (!root || !birth || birth.startTimeTicks !== original.startTimeTicks || root.executable !== original.executable ||
      root.cgroup?.trim() !== original.cgroup.trim() || !["Uid", "Gid"].every(name => field(root.status, name)?.split(/\s+/).join(",") === "0,0,0,0")) throw missing();
    const observed = selectRuntimeEngineIdentity(samples, active.root, launcherPid, previous);
    if (samples.find(sample => sample.pid === observed.pid)?.cgroup?.trim() !== `0::${control.slice("/sys/fs/cgroup".length)}`) throw missing();
    return observed;
  } catch { throw missing(); }
}

export function observedInstalledRuntimeEngineIdentity(active: CloudActiveRuntime, original: InstalledRootIdentity,
  launcherPid: number, control: string, previous?: RuntimeEngineIdentity): RuntimeEngineIdentity {
  observedInstalledRootIdentity(active, original);
  const observed = selectInstalledRuntimeEngineIdentity(observeProcesses(true), active, original, launcherPid, control, previous);
  observedInstalledRootIdentity(active, original);
  return observed;
}
function observeProcesses(cgroups = false): ProcessIdentity[] {
  const names = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  if (names.length > 4096) throw missing();
  const samples: ProcessIdentity[] = [];
  for (const name of names) {
    const pid = Number(name); if (pid <= 1) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const sample = { pid, executable: readlinkSync(`/proc/${pid}/exe`), uidMap: readFileSync(`/proc/${pid}/uid_map`, "utf8"),
        gidMap: readFileSync(`/proc/${pid}/gid_map`, "utf8"), status: readFileSync(`/proc/${pid}/status`, "utf8"), stat,
        ...(cgroups ? { cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8") } : {}) };
      const before = processBirth(sample), after = processBirth({ ...sample, stat: readFileSync(`/proc/${pid}/stat`, "utf8") });
      if (!before || !after || before.parent !== after.parent || before.startTimeTicks !== after.startTimeTicks) throw missing();
      samples.push(sample);
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw missing(); }
  }
  return samples;
}
/** Read only fixed proc identity files, exclusively in this fixture PID domain.
 * No command lines or environments are opened. */
export function observedRuntimeEngineIdentity(root: string, outerPidNamespace: string, launcherPid: number,
  previous?: RuntimeEngineIdentity): RuntimeEngineIdentity {
  assertPrivatePidNamespace(outerPidNamespace, readlinkSync("/proc/self/ns/pid"), process.pid);
  return selectRuntimeEngineIdentity(observeProcesses(), root, launcherPid, previous);
}
