import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { bootClean, procDeps, type BootCleanDeps, type ProcIdentity } from "../boot-clean";

const UID = 1000, SELF = 500, BOOT = 10_000;
const p = (pid: number, ppid: number, start: number, extra: Partial<ProcIdentity> = {}): ProcIdentity =>
  ({ pid, ppid, uid: UID, start, comm: "node", cmdline: "", cgroup: "0::/system.slice/zeros-worker.service", ...extra });

function fake(processes: ProcIdentity[], options: Partial<BootCleanDeps> & { stubborn?: number[]; groupPids?: number[] } = {}) {
  const table = new Map(processes.map(process => [process.pid, process]));
  const signals: Array<[number, string]> = [];
  let erased = false, clock = 0;
  const deps: BootCleanDeps = {
    self: SELF, uid: UID, deadlineMs: 200, termMs: 50, intervalMs: 10,
    pids: async () => [...table.keys()], identity: async pid => table.get(pid),
    cgroupProcs: async () => options.groupPids ?? [...table.values()].filter(process => process.cgroup.includes("zeros-worker")).map(process => process.pid),
    kill: (pid, signal) => { signals.push([pid, signal]); if (!options.stubborn?.includes(pid)) table.delete(pid); },
    erase: async () => { erased = true; }, now: () => clock, sleep: async ms => { clock += ms; },
    ...options,
  };
  return { deps, signals, table, erased: () => erased };
}

const base = () => [
  p(1, 0, 1, { uid: 0, comm: "systemd", cgroup: "0::/init.scope" }),
  p(400, 1, BOOT - 5, { comm: "sh" }),                               // this worker's launcher
  p(SELF, 400, BOOT),                                                 // this worker
  p(600, 1, 50, { comm: "systemd", cmdline: "/lib/systemd/systemd\0--user\0", cgroup: "0::/user.slice/user-1000.slice/user@1000.service/init.scope" }),
  p(601, 600, 51, { comm: "(sd-pam)", cgroup: "0::/user.slice/user-1000.slice/user@1000.service/init.scope" }),
  p(700, 1, 60, { uid: 0, comm: "sshd", cgroup: "0::/system.slice/ssh.service" }),
  p(701, 700, 61, { uid: 0, comm: "sshd", cgroup: "0::/user.slice/user-1000.slice/session-3.scope" }),
  p(702, 701, 62, { comm: "bash", cgroup: "0::/user.slice/user-1000.slice/session-3.scope" }),
];

it("ends every pre-boot process of the VM user whatever its environment, keeping only this worker and provable infrastructure", async () => {
  const f = fake([...base(),
    p(800, 1, 100, { comm: "sleep" }),                                 // an old agent's env -i child, reparented to init
    p(801, 1, 101, { comm: "systemd", cmdline: "systemd --user" }),   // a fake manager in the worker's group
    p(802, 1, 102, { comm: "bash", cgroup: "0::/user.slice/user-1000.slice/session-9.scope" }),   // session scope without sshd
    p(900, SELF, BOOT + 5, { comm: "git" }),                           // this boot's own helper
    p(950, 1, 103, { uid: 33, comm: "nginx", cgroup: "0::/system.slice/nginx.service" }),   // another user's service
  ]);
  expect(await bootClean(f.deps)).toBe(0);
  expect(new Set(f.signals.map(([pid]) => pid))).toEqual(new Set([800, 801, 802]));
  expect(f.signals.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid).sort()).toEqual([800, 801, 802]);
  for (const kept of [1, 400, SELF, 600, 601, 700, 701, 702, 900, 950]) expect(f.table.has(kept)).toBe(true);
  expect(f.erased()).toBe(true);
});

it("counts what will not die, a shared or missing cgroup, a foreign pre-boot process in the worker's group and a failed erase", async () => {
  const stubborn = fake([...base(), p(800, 1, 100)], { stubborn: [800] });
  expect(await bootClean(stubborn.deps)).toBe(1);
  expect(stubborn.signals.filter(([, signal]) => signal === "SIGKILL").length).toBeGreaterThan(0);
  const shared = fake(base().map(process => process.pid === SELF ? { ...process, cgroup: "0::/" } : process));
  expect(await bootClean(shared.deps)).toBe(1);
  const foreign = fake([...base(), p(810, 1, 100, { uid: 0, comm: "agent" })], { groupPids: [SELF, 810], kill: () => {} });
  expect(await bootClean(foreign.deps)).toBe(1);
  const erase = fake(base(), { erase: async () => { throw new Error("busy"); } });
  expect(await bootClean(erase.deps)).toBe(1);
  const unreadable = fake(base(), { identity: async pid => { if (pid === 702) throw Object.assign(new Error("denied"), { code: "EACCES" }); return base().find(process => process.pid === pid); } });
  expect(await bootClean(unreadable.deps)).toBe(1);
});

it.skipIf(process.platform !== "linux")("kills a real env -i orphan that outlived its parent, by identity, not by environment", async () => {
  const orphan = Number(execFileSync("/bin/sh", ["-c", "env -i /bin/sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  const real = procDeps(async () => {});
  const identity = (await real.identity(orphan))!;
  expect(identity.ppid).not.toBe(process.pid);
  // Only the orphan and this process are in scope; "this boot" starts just after the orphan did.
  const self = (await real.identity(process.pid))!;
  const deps: BootCleanDeps = { ...real, deadlineMs: 3_000, termMs: 1_000, pids: async () => [process.pid, orphan],
    identity: async pid => { const value = await real.identity(pid); return value && pid === process.pid ? { ...value, start: identity.start + 1, ppid: 0, cgroup: "0::/test" } : value; },
    cgroupProcs: async () => [process.pid] };
  void self;
  expect(await bootClean(deps)).toBe(0);
  expect(await real.identity(orphan)).toBeUndefined();
});

it("names why a boot is unproven: survivors, a root or missing cgroup, an unreadable process, a failed erase", async () => {
  const classes = async (deps: BootCleanDeps) => { const noted: string[] = []; const count = await bootClean({ ...deps, note: refusal => noted.push(refusal) }); return { count, noted }; };
  expect(await classes(fake([...base(), p(800, 1, 100)], { stubborn: [800] }).deps)).toEqual({ count: 1, noted: ["survivors"] });
  expect((await classes(fake(base().map(process => process.pid === SELF ? { ...process, cgroup: "0::/" } : process)).deps)).noted).toEqual(["cgroup_root"]);
  expect((await classes(fake(base().map(process => process.pid === SELF ? { ...process, cgroup: "12:pids:/system.slice/zeros-worker.service" } : process)).deps)).noted).toEqual(["cgroup_unavailable"]);
  expect((await classes(fake(base(), { cgroupProcs: async () => { throw new Error("hybrid"); } }).deps)).noted).toEqual(["cgroup_unreadable"]);
  expect((await classes(fake(base(), { erase: async () => { throw new Error("busy"); } }).deps)).noted).toEqual(["contexts_erase_failed"]);
  expect((await classes(fake(base(), { identity: async pid => { if (pid === 702) throw Object.assign(new Error("denied"), { code: "EACCES" }); return base().find(process => process.pid === pid); } }).deps)).noted).toEqual(["proc_unreadable"]);
  expect(await classes(fake(base()).deps)).toEqual({ count: 0, noted: [] });
});
