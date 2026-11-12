import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bootClean, procDeps, type BootCleanDeps, type ProcIdentity } from "../boot-clean";

const UID = 1000, SELF = 500, BOOT = 10_000;
const p = (pid: number, ppid: number, start: number, extra: Partial<ProcIdentity> = {}): ProcIdentity =>
  ({ pid, ppid, uid: UID, start, comm: "node", cmdline: "", cgroup: "0::/system.slice/zeros-worker.service", ...extra });

function fake(processes: ProcIdentity[], options: Partial<BootCleanDeps> & { stubborn?: number[]; groupPids?: number[]; zombies?: number[] } = {}) {
  const table = new Map(processes.map(process => [process.pid, process]));
  const signals: Array<[number, string]> = [];
  let erased = false, clock = 0;
  const deps: BootCleanDeps = {
    self: SELF, uid: UID, deadlineMs: 200, termMs: 50, intervalMs: 10,
    pids: async () => [...table.keys()], identity: async pid => table.get(pid), liveThreads: async () => 0,
    cgroupProcs: async () => options.groupPids ?? [...table.values()].filter(process => process.cgroup.includes("zeros-worker")).map(process => process.pid),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      // A zombie: dead, but its root-owned parent never reaps it, so /proc keeps the pid and start time.
      if (options.zombies?.includes(pid)) table.set(pid, { ...table.get(pid)!, state: "Z" });
      else if (!options.stubborn?.includes(pid)) table.delete(pid);
    },
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

it("counts a killed process that its parent never reaps (a zombie) as ended, and says so in the sweep summary", async () => {
  const summaries: unknown[] = [];
  // Boat's root provider agent ran a user command; killed, it stays a zombie until that agent waits for it.
  const f = fake([...base(), p(850, 1, 40, { uid: 0, comm: "boat-agent", cgroup: "0::/system.slice/boat.service" }), p(851, 850, 41, { comm: "bash" })],
    { zombies: [851], summary: value => summaries.push(value) });
  expect(await bootClean(f.deps)).toBe(0);
  expect(f.table.get(851)?.state).toBe("Z");
  expect(summaries).toEqual([{ targets: 1, zombies: 1, zombieLeadersWithThreads: 0, unreadable: 0, survivors: { worker_cgroup: 0, user_session: 0, provider_agent: 0, other: 0 }, comms: {} }]);
});

it("classes each survivor (worker cgroup, user session, provider agent, other) and names only allowlisted commands", async () => {
  const summaries: Array<{ survivors: Record<string, number>; comms: Record<string, number> }> = [];
  const f = fake([...base(),
    p(850, 1, 40, { uid: 0, comm: "boat-agent", cgroup: "0::/system.slice/boat.service" }), p(851, 850, 41, { comm: "bash", cgroup: "0::/system.slice/boat.service" }),
    p(860, 600, 42, { comm: "dbus-daemon", cgroup: "0::/user.slice/user-1000.slice/user@1000.service/dbus.service" }),
    p(870, 1, 43, { comm: "secret-miner", cgroup: "0::/system.slice/other.service" }),
  ], { stubborn: [851, 860, 870], summary: value => summaries.push(value as never) });
  expect(await bootClean(f.deps)).toBe(3);
  expect(summaries[0]!.survivors).toEqual({ worker_cgroup: 0, user_session: 1, provider_agent: 1, other: 1 });
  expect(summaries[0]!.comms).toEqual({ bash: 1, "dbus-daemon": 1, other: 1 });
});

it("reads each process's state from /proc", async () => {
  const self = await procDeps(async () => {}).identity(process.pid);
  expect(self?.state).toMatch(/^[RS]$/);
});

const hasPython = (() => { try { execFileSync("python3", ["-c", "import ctypes"], { stdio: "ignore" }); return true; } catch { return false; } })();
/** Only `pid` is in scope; this boot "starts" just after it. */
async function realScope(pid: number, summaries: unknown[] = []) {
  const real = procDeps(async () => {});
  const target = (await real.identity(pid))!;
  const deps: BootCleanDeps = { ...real, deadlineMs: 3_000, termMs: 500, pids: async () => [process.pid, pid],
    identity: async value => { const found = await real.identity(value); return found && value === process.pid ? { ...found, start: target.start + 1, ppid: 0, cgroup: "0::/test" } : found; },
    cgroupProcs: async () => [process.pid], summary: value => summaries.push(value) };
  return { real, deps };
}
const stateOf = (pid: number) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 2)[0]; } catch { return undefined; } };
const liveTask = (pid: number) => { try { return readdirSync(`/proc/${pid}/task`).some(task => !/^[ZX]/.test(readFileSync(`/proc/${pid}/task/${task}/stat`, "utf8").split(") ")[1] ?? "Z")); } catch { return false; } };
const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); return check(); };

it.skipIf(process.platform !== "linux" || !hasPython)("kills a process whose leader has exited but whose other thread still runs and ignores SIGTERM", async () => {
  // The main thread calls pthread_exit: /proc shows the leader as Z while a worker thread keeps running.
  const script = "import ctypes,signal,threading,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nthreading.Thread(target=lambda:[time.sleep(0.2) for _ in iter(int,1)],daemon=True).start()\ntime.sleep(0.1)\nctypes.CDLL(None).pthread_exit(None)\n";
  const pid = Number(execFileSync("/bin/sh", ["-c", `python3 -I -c '${script}' >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).trim());
  try {
    expect(await until(() => stateOf(pid) === "Z" && liveTask(pid))).toBe(true);
    const summaries: Array<{ zombieLeadersWithThreads: number }> = [];
    const { deps } = await realScope(pid, summaries);
    const unproven = await bootClean(deps);
    // Clean only if it is really gone: no thread of it may still run.
    expect(liveTask(pid)).toBe(false);
    expect(unproven).toBe(0);
    expect(summaries[0]!.zombieLeadersWithThreads).toBe(1);
  } finally { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
});

it.skipIf(process.platform !== "linux" || !hasPython)("still counts a true zombie (a killed child its live parent never reaps) as ended", async () => {
  // The parent is outside the sweep's scope and never waits; its killed child stays Z with no threads.
  const script = "import os,time\npid=os.fork()\nif pid==0:\n  time.sleep(60)\nelse:\n  print(pid,flush=True)\n  time.sleep(60)\n";
  const child = spawn("python3", ["-I", "-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const pid = Number(await new Promise<string>(resolve => child.stdout!.once("data", data => resolve(String(data).trim()))));
    const summaries: Array<{ zombies: number; zombieLeadersWithThreads: number }> = [];
    const { deps } = await realScope(pid, summaries);
    expect(await bootClean(deps)).toBe(0);
    expect(stateOf(pid)).toBe("Z");
    expect(summaries[0]).toMatchObject({ zombies: 1, zombieLeadersWithThreads: 0 });
  } finally { child.kill("SIGKILL"); }
});

it("sends SIGKILL to a zombie before dropping it, and keeps a zombie leader with a live thread as a survivor until it dies", async () => {
  const zombie = fake([...base(), p(850, 1, 40, { uid: 0, comm: "boat-agent", cgroup: "0::/system.slice/boat.service" }), p(851, 850, 41, { comm: "bash", cgroup: "0::/system.slice/boat.service" })],
    { zombies: [851] });
  expect(await bootClean(zombie.deps)).toBe(0);
  expect(zombie.signals).toContainEqual([851, "SIGKILL"]);
  const summaries: Array<{ zombieLeadersWithThreads: number }> = [];
  const threaded = fake([...base(), p(852, 1, 42, { comm: "python3", state: "Z", cgroup: "0::/system.slice/other.service" })],
    { stubborn: [852], liveThreads: async pid => pid === 852 ? 1 : 0, summary: value => summaries.push(value) });
  expect(await bootClean(threaded.deps)).toBe(1);
  expect(threaded.signals).toContainEqual([852, "SIGKILL"]);
  expect(summaries[0]!.zombieLeadersWithThreads).toBe(1);
});
