import { readFile, readdir, readlink, writeFile } from "node:fs/promises";

const MiB = 1024 * 1024;
// A runaway can exhaust a VM in a few seconds (1.7 GB/s observed), so the
// kernel must not win the race for ordinary ones. One meminfo sample is about
// 80 µs; the /proc scan below 15 % is about 2.6 ms for 70 processes.
const NORMAL_INTERVAL_MS = 1_000, TIGHT_INTERVAL_MS = 200, KILL_SPACING_MS = 2_000;
const RAISED_OOM_SCORE = 800;

export interface ProcessInfo {
  pid: number; ppid: number; uid: number; rssBytes: number;
  /** /proc/<pid>/stat starttime: with the pid, identifies one process instance. */
  startTime: string;
  comm: string; exe?: string; argv: string[];
}
export interface ProcReader {
  meminfo(): Promise<string>;
  processes(): Promise<ProcessInfo[]>;
  startTime(pid: number): Promise<string | undefined>;
  environ(pid: number): Promise<Record<string, string> | undefined>;
  oomScoreAdj(pid: number): Promise<number | undefined>;
  setOomScoreAdj(pid: number, value: number): Promise<void>;
}
interface ProtectionFacts { self: number; uid: number; runtimeRoots: readonly string[]; loginShells: ReadonlySet<number>; minimumBytes: number }
export type KillOwner = { kind: "chat"; chatId: string } | { kind: "terminal"; shellPid: number } | { kind: "unknown" };
export interface KillReport { pid: number; name: string; rssBytes: number; owner: KillOwner }

/** What a person would call the process. The kernel name is usually right,
 * including for multi-call binaries whose executable is coreutils or busybox;
 * Node renames its main thread to "MainThread", so then name the executable. */
export function processName(item: Pick<ProcessInfo, "comm" | "exe" | "argv">): string {
  if (item.comm !== "MainThread") return item.comm;
  const base = (path: string | undefined) => path?.replace(/ \(deleted\)$/, "").split("/").pop();
  return base(item.exe) || base(item.argv[0]) || item.comm;
}

const inside = (path: string | undefined, roots: readonly string[]) => !!path && roots.some(root => !!root && (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)));

/** Candidates are the worker's own-user descendants that are not the worker,
 * an ancestor, a direct child (agent CLIs, the Cursor host, PTY login shells,
 * setup, Git, MCP servers), anything run from the runtime, or a login shell. */
function classify(processes: readonly ProcessInfo[], facts: Omit<ProtectionFacts, "minimumBytes">) {
  const byPid = new Map(processes.map(item => [item.pid, item]));
  const ancestors = new Set<number>();
  for (let cursor = byPid.get(facts.self)?.ppid; cursor && !ancestors.has(cursor); cursor = byPid.get(cursor)?.ppid) ancestors.add(cursor);
  const descends = (item: ProcessInfo) => {
    const seen = new Set<number>();
    for (let cursor = item.ppid; cursor && !seen.has(cursor); cursor = byPid.get(cursor)?.ppid ?? 0) {
      if (cursor === facts.self) return true;
      seen.add(cursor);
    }
    return false;
  };
  const isProtected = (item: ProcessInfo) => item.pid === facts.self || ancestors.has(item.pid) || item.ppid === facts.self ||
    inside(item.exe, facts.runtimeRoots) || item.argv.slice(0, 2).some(arg => inside(arg, facts.runtimeRoots)) ||
    facts.loginShells.has(item.pid) || item.argv[0]?.startsWith("-") === true;
  return { byPid, candidates: processes.filter(item => item.uid === facts.uid && descends(item) && !isProtected(item)) };
}

export function chooseVictim(processes: readonly ProcessInfo[], facts: ProtectionFacts): ProcessInfo | undefined {
  return classify(processes, facts).candidates.filter(item => item.rssBytes >= facts.minimumBytes)
    .sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid)[0];
}

export interface MemoryWatchdogOptions {
  self: number; uid: number; runtimeRoots: readonly string[];
  loginShells(): ReadonlySet<number>;
  minimumBytes?: number;
  reader?: ProcReader;
  kill?(pid: number, signal: "SIGKILL"): void;
  now?(): number;
  onKilled?(report: KillReport): void;
  /** Once per pressure episode in which nothing could be stopped. */
  onPressure?(event: { killed: false }): void;
}

/** Keeps the worker and agent CLIs alive when a child exhausts the VM's
 * memory. Reads only /proc/meminfo until memory is actually short. */
export class MemoryWatchdog {
  private lowSamples = 0;
  private lastKillAt = -Infinity;
  private reported = false;
  private readonly raised = new Map<number, { startTime: string; previous: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly options: MemoryWatchdogOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = (delay: number) => {
      this.timer = setTimeout(() => { void this.check().catch(() => NORMAL_INTERVAL_MS).then(next => { if (!this.stopped) tick(next); }); }, delay);
      this.timer.unref?.();
    };
    tick(NORMAL_INTERVAL_MS);
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }

  /** One sample; resolves to the delay before the next one. */
  async check(): Promise<number> {
    const reader = this.reader;
    const meminfo = await reader.meminfo();
    const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m").exec(meminfo)?.[1] ?? NaN) * 1024;
    const total = field("MemTotal"), available = field("MemAvailable");
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return NORMAL_INTERVAL_MS;
    const floor = Math.max(total * 0.05, 256 * MiB);
    const low = available < floor, tight = available < Math.max(total * 0.15, floor);
    if (!low) { this.lowSamples = 0; this.reported = false; }
    if (!tight) { await this.restore(); return NORMAL_INTERVAL_MS; }
    // Tight: candidates carry a raised oom_score_adj, so if the kernel wins
    // the race it still picks one of them, never a protected process.
    const now = (this.options.now ?? Date.now)();
    const processes = await reader.processes();
    const facts = { self: this.options.self, uid: this.options.uid, runtimeRoots: this.options.runtimeRoots, loginShells: this.options.loginShells() };
    const { byPid, candidates } = classify(processes, facts);
    await this.raise(candidates);
    if (!low || ++this.lowSamples < 2) return TIGHT_INTERVAL_MS;
    if (now - this.lastKillAt < KILL_SPACING_MS) return TIGHT_INTERVAL_MS;
    const victim = chooseVictim(processes, { ...facts, minimumBytes: this.options.minimumBytes ?? 128 * MiB });
    if (!victim) {
      if (!this.reported) { this.reported = true; this.options.onPressure?.({ killed: false }); }
      return TIGHT_INTERVAL_MS;
    }
    if (await reader.startTime(victim.pid) !== victim.startTime) return TIGHT_INTERVAL_MS;
    const owner = await this.owner(victim, byPid, facts.loginShells);
    try { (this.options.kill ?? ((pid, signal) => process.kill(pid, signal)))(victim.pid, "SIGKILL"); }
    catch { return TIGHT_INTERVAL_MS; }
    this.lastKillAt = now; this.raised.delete(victim.pid);
    this.options.onKilled?.({ pid: victim.pid, name: processName(victim), rssBytes: victim.rssBytes, owner });
    return TIGHT_INTERVAL_MS;
  }

  private get reader(): ProcReader { return this.options.reader ?? procReader(); }

  private async owner(victim: ProcessInfo, byPid: Map<number, ProcessInfo>, shells: ReadonlySet<number>): Promise<KillOwner> {
    const seen = new Set<number>();
    for (let cursor: ProcessInfo | undefined = victim; cursor && cursor.pid !== this.options.self && !seen.has(cursor.pid); cursor = byPid.get(cursor.ppid)) {
      seen.add(cursor.pid);
      if (shells.has(cursor.pid)) return { kind: "terminal", shellPid: cursor.pid };
      const chatId = (await this.reader.environ(cursor.pid).catch(() => undefined))?.ZEROS_SESSION_ID;
      if (chatId) return { kind: "chat", chatId };
    }
    return { kind: "unknown" };
  }

  /** Only candidates are ever written, so a protected process keeps its score. */
  private async raise(candidates: readonly ProcessInfo[]): Promise<void> {
    for (const item of candidates) {
      if (this.raised.has(item.pid)) continue;
      const previous = await this.reader.oomScoreAdj(item.pid).catch(() => undefined);
      if (previous === undefined || previous >= RAISED_OOM_SCORE) continue;
      try { await this.reader.setOomScoreAdj(item.pid, RAISED_OOM_SCORE); this.raised.set(item.pid, { startTime: item.startTime, previous }); }
      catch { /* Gone, or not ours. */ }
    }
  }

  private async restore(): Promise<void> {
    for (const [pid, entry] of [...this.raised]) {
      this.raised.delete(pid);
      if (await this.reader.startTime(pid).catch(() => undefined) !== entry.startTime) continue;
      await this.reader.setOomScoreAdj(pid, entry.previous).catch(() => {});
    }
  }
}

const pageSize = 4096;
interface Facts { key: string; uid: number; exe?: string; argv: string[] }
/** One stat read per process; uid, exe and argv are read again only when the
 * process is new to the cache or its start time or name changed (exec renames). */
async function readProcess(pid: number, cache: Map<number, Facts>): Promise<ProcessInfo | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close), fields = stat.slice(close + 2).split(" ");
    const startTime = fields[19] ?? "", key = `${startTime}:${comm}`;
    let facts = cache.get(pid);
    if (facts?.key !== key) {
      const [status, cmdline, exe] = await Promise.all([readFile(`/proc/${pid}/status`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8"),
        readlink(`/proc/${pid}/exe`).catch(() => undefined)]);
      facts = { key, uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), ...(exe ? { exe } : {}), argv: cmdline.split("\0").filter(Boolean) };
      cache.set(pid, facts);
    }
    return { pid, ppid: Number(fields[1]), uid: facts.uid, rssBytes: Number(fields[21] ?? 0) * pageSize,
      startTime, comm, ...(facts.exe ? { exe: facts.exe } : {}), argv: facts.argv };
  } catch { return undefined; }
}

export function procReader(): ProcReader {
  const cache = new Map<number, Facts>();
  return {
    meminfo: () => readFile("/proc/meminfo", "utf8"),
    processes: async () => {
      const pids = (await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(Number), live = new Set(pids);
      for (const pid of cache.keys()) if (!live.has(pid)) cache.delete(pid);
      return (await Promise.all(pids.map(pid => readProcess(pid, cache)))).filter((item): item is ProcessInfo => !!item);
    },
    startTime: async pid => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
      return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    },
    environ: async pid => {
      const raw = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => undefined);
      if (raw === undefined) return undefined;
      return Object.fromEntries(raw.split("\0").filter(Boolean).flatMap(entry => {
        const index = entry.indexOf("=");
        // Attribution needs only the chat id; never hold the rest of a child's environment.
        return index > 0 && entry.slice(0, index) === "ZEROS_SESSION_ID" ? [[entry.slice(0, index), entry.slice(index + 1)]] : [];
      }));
    },
    oomScoreAdj: async pid => Number((await readFile(`/proc/${pid}/oom_score_adj`, "utf8")).trim()),
    setOomScoreAdj: (pid, value) => writeFile(`/proc/${pid}/oom_score_adj`, `${value}\n`),
  };
}
