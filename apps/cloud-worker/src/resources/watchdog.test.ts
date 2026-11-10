import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MemoryWatchdog, chooseVictim, procReader, processName, type ProcessInfo, type ProcReader } from "./watchdog";

const MiB = 1024 * 1024, WORKER = 100, UID = 1000, RUNTIME = "/opt/zeros/runtime/abc";
const proc = (pid: number, ppid: number, rssMiB: number, extra: Partial<ProcessInfo> = {}): ProcessInfo =>
  ({ pid, ppid, uid: UID, rssBytes: rssMiB * MiB, startTime: `${pid}0`, comm: `p${pid}`, argv: [`/usr/bin/p${pid}`], ...extra });
/** worker(100) ← agent CLI(200, in the runtime) ← bash tool(300) ← tests(400)
 *  worker(100) ← login shell(500) ← build(600); worker(100) ← setup(700) */
const tree = (sizes: Partial<Record<number, number>> = {}) => [
  proc(1, 0, 10), proc(50, 1, 10), proc(WORKER, 50, sizes[100] ?? 300),
  proc(200, WORKER, sizes[200] ?? 900, { argv: ["node", `${RUNTIME}/node_modules/@openai/codex/bin/codex.js`], exe: "/usr/bin/node" }),
  proc(300, 200, sizes[300] ?? 20, { argv: ["bash", "-c", "pnpm test"], exe: "/usr/bin/bash" }),
  proc(400, 300, sizes[400] ?? 700),
  proc(500, WORKER, sizes[500] ?? 30, { argv: ["/bin/bash", "-l"], exe: "/usr/bin/bash" }),
  proc(600, 500, sizes[600] ?? 400),
  proc(700, WORKER, sizes[700] ?? 2000, { argv: ["/bin/bash", "-lc", "setup"] }),
  proc(800, 1, 5000),
  proc(900, 500, 3000, { uid: 0 }),
];
const facts = { self: WORKER, uid: UID, runtimeRoots: [RUNTIME], loginShells: new Set([500]), minimumBytes: 128 * MiB };

describe("victim choice", () => {
  it("chooses the largest unprotected descendant, never the worker, an agent CLI, a login shell, a direct child or a foreign process", () => {
    expect(chooseVictim(tree(), facts)?.pid).toBe(400);
  });

  it("skips a protected process that is the largest and takes the next candidate", () => {
    const processes = tree({ 200: 9000, 400: 150, 600: 300 });
    expect(chooseVictim(processes, facts)?.pid).toBe(600);
    const inRuntime = [...processes, proc(1000, 300, 8000, { exe: `${RUNTIME}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, argv: ["claude"] })];
    expect(chooseVictim(inRuntime, facts)?.pid).toBe(600);
    const loginByName = [...processes, proc(1100, 300, 8000, { argv: ["-bash"] })];
    expect(chooseVictim(loginByName, facts)?.pid).toBe(600);
  });

  it("chooses nothing when no candidate reaches 128 MiB", () => {
    expect(chooseVictim(tree({ 400: 127, 600: 100 }), facts)).toBeUndefined();
  });
});

function harness(options: { processes?: ProcessInfo[]; environ?: Record<number, Record<string, string>> } = {}) {
  let available = 4000, now = 0;
  const processes = options.processes ?? tree();
  const adjustments = new Map<number, number>();
  const reader: ProcReader = {
    meminfo: async () => `MemTotal: ${8000 * 1024} kB\nMemAvailable: ${available * 1024} kB\n`,
    processes: async () => processes,
    startTime: async pid => processes.find(item => item.pid === pid)?.startTime,
    environ: async pid => options.environ?.[pid],
    oomScoreAdj: async pid => adjustments.get(pid) ?? 0,
    setOomScoreAdj: async (pid, value) => { adjustments.set(pid, value); },
  };
  const kill = vi.fn((pid: number) => { const index = processes.findIndex(item => item.pid === pid); if (index >= 0) processes.splice(index, 1); });
  const killed = vi.fn(), pressure = vi.fn();
  const watchdog = new MemoryWatchdog({ ...facts, loginShells: () => facts.loginShells, reader, kill, now: () => now, onKilled: killed, onPressure: pressure });
  return { watchdog, kill, killed, pressure, adjustments, processes, setAvailable: (mib: number) => { available = mib; }, advance: (ms: number) => { now += ms; } };
}

describe("stopped process names", () => {
  it("names Node by its executable instead of its MainThread kernel name, and keeps the kernel name otherwise", () => {
    expect(processName(proc(1, 0, 1, { comm: "MainThread", argv: ["/usr/local/bin/node", "build.js"], exe: "/usr/local/bin/node" }))).toBe("node");
    expect(processName(proc(1, 0, 1, { comm: "MainThread", argv: ["node"], exe: "/usr/bin/node (deleted)" }))).toBe("node");
    expect(processName(proc(1, 0, 1, { comm: "MainThread", argv: ["/opt/bin/node", "x.js"] }))).toBe("node");
    expect(processName(proc(1, 0, 1, { comm: "MainThread", argv: [] }))).toBe("MainThread");
    // A coreutils shebang runs `sleep` with argv[0] and exe both /usr/bin/coreutils.
    expect(processName(proc(1, 0, 1, { comm: "sleep", argv: ["/usr/bin/coreutils", "--coreutils-prog-shebang=sleep"], exe: "/usr/bin/coreutils" }))).toBe("sleep");
  });
});

describe("memory watchdog", () => {
  it("acts only on a second consecutive low sample, kills one victim at a time and tells the chat it belonged to", async () => {
    const h = harness({ environ: { 400: { ZEROS_SESSION_ID: "chat-a", ZEROS_WORKSPACE_ID: "w" } } });
    h.setAvailable(200);
    expect(await h.watchdog.check()).toBe(200);
    expect(h.kill).not.toHaveBeenCalled();
    h.advance(1_000); await h.watchdog.check();
    expect(h.kill).toHaveBeenCalledExactlyOnceWith(400, "SIGKILL");
    expect(h.killed).toHaveBeenCalledWith({ pid: 400, name: "p400", rssBytes: 700 * MiB, owner: { kind: "chat", chatId: "chat-a" } });
    h.advance(500); await h.watchdog.check();
    expect(h.kill).toHaveBeenCalledTimes(1);
    h.advance(2_000); await h.watchdog.check();
    expect(h.kill).toHaveBeenLastCalledWith(600, "SIGKILL");
    expect(h.killed).toHaveBeenLastCalledWith(expect.objectContaining({ pid: 600, owner: { kind: "terminal", shellPid: 500 } }));
  });

  it("raises only candidates' oom_score_adj under pressure and restores them when it clears", async () => {
    const h = harness({ processes: tree({ 400: 100, 600: 100 }) });
    h.setAvailable(200);
    await h.watchdog.check(); h.advance(1_000); await h.watchdog.check();
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.pressure).toHaveBeenCalledWith({ killed: false });
    expect([...h.adjustments.entries()].sort()).toEqual([[300, 800], [400, 800], [600, 800]]);
    h.setAvailable(4000); h.advance(1_000);
    expect(await h.watchdog.check()).toBe(1_000);
    expect([...h.adjustments.entries()].sort()).toEqual([[300, 0], [400, 0], [600, 0]]);
  });

  it("raises candidates as soon as memory is tight, without killing until it is low twice, and restores them when it eases", async () => {
    const h = harness(), processes = vi.spyOn((h.watchdog as unknown as { options: { reader: ProcReader } }).options.reader, "processes");
    h.setAvailable(4000);
    for (let i = 0; i < 5; i++) { expect(await h.watchdog.check()).toBe(1_000); h.advance(1_000); }
    expect(processes).not.toHaveBeenCalled();
    expect(h.adjustments.size).toBe(0);
    h.setAvailable(1000); // 12.5 %: tight, not low
    expect(await h.watchdog.check()).toBe(200);
    expect([...h.adjustments.entries()].sort()).toEqual([[300, 800], [400, 800], [600, 800]]);
    for (let i = 0; i < 10; i++) { h.advance(200); expect(await h.watchdog.check()).toBe(200); }
    expect(h.kill).not.toHaveBeenCalled();
    for (const pid of [WORKER, 200, 500, 700]) expect(h.adjustments.has(pid)).toBe(false);
    h.setAvailable(1300); // above 15 %
    expect(await h.watchdog.check()).toBe(1_000);
    expect([...h.adjustments.values()]).toEqual([0, 0, 0]);
  });

  it("treats the absolute low floor as tight too on a small VM", async () => {
    const h = harness();
    const reader = (h.watchdog as unknown as { options: { reader: ProcReader } }).options.reader;
    reader.meminfo = async () => `MemTotal: ${1024 * 1024} kB\nMemAvailable: ${200 * 1024} kB\n`; // 1 GiB total, 200 MiB free (19.5 %)
    expect(await h.watchdog.check()).toBe(200);
    h.advance(200); await h.watchdog.check();
    expect(h.kill).toHaveBeenCalledWith(400, "SIGKILL");
  });

  it("samples every second while healthy and every 200 ms while tight, and stops when told", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(), reader = (h.watchdog as unknown as { options: { reader: ProcReader } }).options.reader;
      const samples = vi.spyOn(reader, "meminfo");
      h.setAvailable(4000);
      h.watchdog.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(samples).toHaveBeenCalledTimes(10);
      h.setAvailable(1000);
      await vi.advanceTimersByTimeAsync(1_000); // the next sample sees it, then 200 ms cadence
      samples.mockClear();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(samples).toHaveBeenCalledTimes(10);
      h.watchdog.stop();
      samples.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(samples).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not kill a process whose pid was reused before the signal", async () => {
    const h = harness();
    h.setAvailable(200);
    await h.watchdog.check(); h.advance(1_000);
    h.processes.find(item => item.pid === 400)!.startTime = "reused";
    const reader = (h.watchdog as unknown as { options: { reader: ProcReader } }).options.reader;
    reader.startTime = async pid => pid === 400 ? "different" : h.processes.find(item => item.pid === pid)?.startTime;
    await h.watchdog.check();
    expect(h.kill).not.toHaveBeenCalledWith(400, "SIGKILL");
  });
});

describe.skipIf(process.platform !== "linux")("memory watchdog on this machine's /proc", () => {
  it("kills a grandchild and leaves the direct child and this process alone", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; wait; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const [line] = await once(child.stdout!, "data") as [Buffer];
      const grandchild = Number(line.toString().trim());
      const real = procReader();
      let available = 100;
      const killed = vi.fn();
      const watchdog = new MemoryWatchdog({ self: process.pid, uid: process.getuid!(), runtimeRoots: ["/nonexistent-runtime"], loginShells: () => new Set(),
        minimumBytes: 0, reader: { ...real, meminfo: async () => `MemTotal: 8000000 kB\nMemAvailable: ${available} kB\n`, setOomScoreAdj: async () => {} },
        onKilled: killed, now: (() => { let clock = 0; return () => (clock += 5_000); })() });
      await watchdog.check(); await watchdog.check();
      expect(killed).toHaveBeenCalledWith(expect.objectContaining({ pid: grandchild, name: "sleep" }));
      await expect.poll(async () => readFile(`/proc/${grandchild}/stat`, "utf8").then(stat => stat.split(") ")[1]?.[0], () => "gone")).toMatch(/gone|Z/);
      expect(child.exitCode).toBeNull();
      available = 7_000_000; await watchdog.check();
    } finally { child.kill("SIGKILL"); }
  });
});

it.skipIf(process.platform !== "linux")("names a live Node child node, not MainThread, through the real /proc reader", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await expect.poll(async () => (await procReader().processes()).find(item => item.pid === child.pid)?.comm).toBe("MainThread");
    const info = (await procReader().processes()).find(item => item.pid === child.pid)!;
    expect(processName(info)).toBe("node");
  } finally { child.kill("SIGKILL"); }
});
