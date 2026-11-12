import type { CloudV2BootCleanRefusal } from "@zeros/protocol/cloud-v2-relay";
import { readdir, readFile } from "node:fs/promises";

/** One process's identity, read from /proc. start is in clock ticks since the VM booted. */
export interface ProcIdentity { pid: number; ppid: number; uid: number; start: number; comm: string; cmdline: string; cgroup: string }
export interface BootCleanDeps {
  self: number; uid: number;
  pids(): Promise<number[]>;
  /** undefined: the process is gone. A throw: its identity is unreadable (cleanup unproven). */
  identity(pid: number): Promise<ProcIdentity | undefined>;
  /** Every pid in this cgroup v2 path; a throw means unreadable. */
  cgroupProcs(path: string): Promise<number[]>;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Erase everything under ~/.zeros/contexts. */
  erase(): Promise<void>;
  now?(): number; sleep?(ms: number): Promise<void>;
  deadlineMs?: number; termMs?: number; intervalMs?: number;
  /** Each class that left the boot unproven, for the boot-clean diagnostics (no paths, pids or values). */
  note?(refusal: CloudV2BootCleanRefusal): void;
}

const SESSION_SCOPE = /^0::\/user\.slice\/user-\d+\.slice\/session-[^/]+\.scope(?:\/|$)/m;

function parseIdentity(pid: number, stat: string, status: string, cmdline: string, cgroup: string): ProcIdentity {
  // comm is parenthesised and may hold spaces or parentheses: fields follow the last ')'.
  const close = stat.lastIndexOf(")");
  const comm = stat.slice(stat.indexOf("(") + 1, close), fields = stat.slice(close + 2).split(" ");
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (close < 0 || fields.length < 20 || uid === undefined) throw new Error("Unreadable process identity.");
  return { pid, ppid: Number(fields[1]), start: Number(fields[19]), uid: Number(uid), comm, cmdline: cmdline.replaceAll("\0", " ").trim(), cgroup };
}

export function procDeps(erase: () => Promise<void>): BootCleanDeps {
  return {
    self: process.pid, uid: process.getuid?.() ?? -1, erase,
    pids: async () => (await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(Number),
    identity: async pid => {
      try {
        const [stat, status, cmdline, cgroup] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8"),
          readFile(`/proc/${pid}/cmdline`, "latin1").catch(() => ""), readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "")]);
        return parseIdentity(pid, stat, status, cmdline, cgroup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
        throw error;
      }
    },
    cgroupProcs: async path => (await readFile(`/sys/fs/cgroup${path}/cgroup.procs`, "utf8")).split("\n").filter(Boolean).map(Number),
    kill: (pid, signal) => { try { process.kill(pid, signal); } catch { /* Gone, or not ours: the recheck decides. */ } },
  };
}

/** Team sharing §7a: before this boot's first begin or lease, prove that no
 * process from an earlier boot survives, whatever its environment, session,
 * parentage or cgroup: every process of the VM user that started before this
 * worker is ended, except provable infrastructure. Returns the count that
 * could not be ended or proven (0 is the attestation). */
export async function bootClean(deps: BootCleanDeps): Promise<number> {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (deps.deadlineMs ?? 10_000);
  let unproven = 0;
  const self = await deps.identity(deps.self).catch(() => undefined);
  const note = (refusal: CloudV2BootCleanRefusal) => deps.note?.(refusal);
  if (!self) { note("proc_unreadable"); return 1; }

  const table = async () => {
    const found = new Map<number, ProcIdentity>();
    for (const pid of await deps.pids()) {
      const identity = await deps.identity(pid);
      if (identity) found.set(pid, identity);
    }
    return found;
  };
  let processes: Map<number, ProcIdentity>;
  try { processes = await table(); } catch { note("proc_unreadable"); return 1; }

  // This worker's own chain (its launcher included), by parentage.
  const ancestors = new Set<number>();
  for (let current: ProcIdentity | undefined = self; current && !ancestors.has(current.pid); current = processes.get(current.ppid)) ancestors.add(current.pid);
  const rootOwned = (pid: number) => processes.get(pid)?.uid === 0;
  const exempt = (process: ProcIdentity): boolean => {
    if (ancestors.has(process.pid)) return true;
    // The genuine user manager: systemd --user started by root's pid 1; its own helpers are its children.
    const manager = (candidate?: ProcIdentity) => !!candidate && candidate.uid === deps.uid && candidate.comm === "systemd" &&
      candidate.cmdline.split(/[\0\s]+/).includes("--user") && candidate.ppid === 1 && rootOwned(1);
    if (manager(process)) return true;
    if (["(sd-pam)", "systemd-executor"].includes(process.comm) && manager(processes.get(process.ppid))) return true;
    // An owner-attached SSH login: in a login session scope, below a root-owned sshd.
    if (SESSION_SCOPE.test(process.cgroup)) {
      const seen = new Set<number>();
      for (let parent = processes.get(process.ppid); parent && !seen.has(parent.pid); parent = processes.get(parent.ppid)) {
        seen.add(parent.pid);
        if (parent.uid === 0 && parent.comm === "sshd") return true;
      }
    }
    return false;
  };
  const preBoot = (process: ProcIdentity) => process.start < self.start;

  // (1) The worker's own control group: unified v2, its own (not the root), holding nothing from before this boot.
  const path = /^0::(\/\S*)$/m.exec(self.cgroup)?.[1];
  const groupTargets = new Set<number>();
  if (!path || path === "/") { unproven++; note(path ? "cgroup_root" : "cgroup_unavailable"); }
  else {
    try {
      for (const pid of await deps.cgroupProcs(path)) {
        const process = processes.get(pid);
        if (process && preBoot(process) && !ancestors.has(pid)) groupTargets.add(pid);
      }
    } catch { unproven++; note("cgroup_unreadable"); }
  }

  // (2) Every pre-boot process of the VM user (and anything pre-boot in the worker's group), SIGTERM then SIGKILL.
  const targets = new Map<number, number>();   // pid -> start: a reused pid is a new process, never the old one
  for (const process of processes.values())
    if (process.pid !== deps.self && preBoot(process) && (groupTargets.has(process.pid) || (process.uid === deps.uid && !exempt(process))))
      targets.set(process.pid, process.start);
  const alive = async () => {
    for (const [pid, start] of [...targets]) {
      let identity: ProcIdentity | undefined;
      try { identity = await deps.identity(pid); } catch { continue; }   // unreadable: still counted
      if (!identity || identity.start !== start) targets.delete(pid);
    }
    return targets.size;
  };
  for (const pid of targets.keys()) deps.kill(pid, "SIGTERM");
  const termUntil = Math.min(deadline, now() + (deps.termMs ?? 3_000));
  while (await alive() && now() < termUntil) await sleep(deps.intervalMs ?? 50);
  while (await alive() && now() < deadline) {
    for (const pid of targets.keys()) deps.kill(pid, "SIGKILL");
    await sleep(deps.intervalMs ?? 50);
  }
  unproven += targets.size;
  if (targets.size) note("survivors");

  // (3) No person's files survive the boot.
  try { await deps.erase(); } catch { unproven++; note("contexts_erase_failed"); }
  return unproven;
}
