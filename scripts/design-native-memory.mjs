import { assertNativeMemoryBudget, nativeProcessSample, readNativePhysicalFootprints } from "./design-native-baseline.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const observedChildren = new WeakMap();
const observedProcesses = new WeakMap();
const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

export function nativeApplicationProcessIdentities(app) {
  return [...(observedProcesses.get(app)?.values() ?? [])].map(identity => ({ ...identity }));
}

/** A terminated app/engine root does not prove that its helpers stopped. Retain
 * every sampled identity, including reparented children, but never adopt a PID
 * reused by a different process. Missing live identity remains unverified.
 * This only observes retirement; it never signals an unrelated process. */
export async function waitForNativeProcessRetirement(processes, { requiredPids = [], timeoutMs = 10000,
  readProcessTree = nativeProcessTree, isProcessAlive = processAlive, now = Date.now, pause = delay } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000 ||
      !Array.isArray(processes) || processes.length === 0 || processes.some(row =>
        !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.startedAt !== "string" || !row.startedAt) ||
      requiredPids.some(pid => !processes.some(row => row.pid === pid)))
    throw new Error("Native retirement requires observed app and engine identities.");
  const deadline = now() + timeoutMs;
  for (;;) {
    const current = new Map((await readProcessTree()).map(row => [row.pid, row]));
    const remaining = [], unknown = [];
    for (const row of processes) {
      const candidate = current.get(row.pid);
      if (candidate?.startedAt === row.startedAt) remaining.push(row);
      else if ((!candidate || !candidate.startedAt) && await isProcessAlive(row.pid)) unknown.push(row);
    }
    const retired = remaining.length === 0 && unknown.length === 0;
    if (retired || now() >= deadline) return { retired, processes, remaining, unknown };
    await pause(Math.min(100, Math.max(0, deadline - now())));
  }
}

/** Retention compares like-for-like quiescence. Navigation samples include
 * warm hidden documents and renderer handoffs until the 10 s retirement grace
 * expires; they remain peak evidence, not the settled-memory baseline. */
export async function sampleNativeMemoryPlateau({ throughCycle, sample, pause }) {
  if (!Number.isSafeInteger(throughCycle) || throughCycle < 0 || throughCycle % 10)
    throw new Error("A memory plateau must end a complete ten-cycle block.");
  await pause(11_000);
  const samples = [];
  for (let i = 0; i < 10; i++) {
    samples.push(await sample());
    if (i < 9) await pause(1000);
  }
  return { throughCycle, samples };
}

async function nativeProcessTree() {
  // No argv: an unrelated process's command line may contain credentials.
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,stat=,lstart="], { timeout: 3000, maxBuffer: 1024 * 1024 });
  return stdout.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Native process ownership is unavailable.");
    return { pid: Number(match[1]), ppid: Number(match[2]), state: match[3], startedAt: match[4].replace(/\s+/g, " ") };
  });
}

/** Record ownership as soon as the host launches, before a renderer or engine
 * handshake can fail. This OS-only read also works after the main debugger
 * disconnects, and retains orphan identities for final retirement checks. */
export async function observeNativeApplicationProcesses(app, { readProcessTree = nativeProcessTree } = {}) {
  const mainPid = app.process()?.pid;
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) throw new Error("Native application root is unavailable.");
  const tree = await readProcessTree(), current = new Map(tree.map(row => [row.pid, row]));
  const owned = observedProcesses.get(app) ?? new Map();
  observedProcesses.set(app, owned);
  const earlierRoot = [...owned.values()].find(row => row.pid === mainPid), root = current.get(mainPid);
  if (!earlierRoot && !root?.startedAt) throw new Error("Native application start identity is unavailable.");
  const descendants = new Set();
  if (root?.startedAt && (!earlierRoot || earlierRoot.startedAt === root.startedAt)) descendants.add(mainPid);
  for (const identity of owned.values())
    if (current.get(identity.pid)?.startedAt === identity.startedAt) descendants.add(identity.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of tree) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
      descendants.add(row.pid); changed = true;
    }
  }
  for (const pid of descendants) {
    const row = current.get(pid);
    if (!row?.startedAt) throw new Error("Native descendant start identity is unavailable.");
    const key = `${pid}:${row.startedAt}`;
    owned.set(key, { pid, startedAt: row.startedAt,
      role: owned.get(key)?.role ?? (pid === mainPid ? "Browser" : "native-child") });
  }
  return nativeApplicationProcessIdentities(app);
}

/** Electron's working set excludes graphics allocations on macOS. Preserve it
 * as a separate diagnostic, joining the OS footprint by exact process ID. */
export async function sampleNativeApplicationMemory({ app, enginePid,
  readFootprints = readNativePhysicalFootprints, readProcess = nativeProcessSample,
  readProcessTree = nativeProcessTree, pause = delay,
  isProcessAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  } }) {
  const rows = await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
    pid, role: type, cpuSeconds: cpu.cumulativeCPUUsage, cpuSource: "electron",
    rssBytes: memory.workingSetSize * 1024, lifetimePeakRssBytes: memory.peakWorkingSetSize * 1024,
  })));
  if (enginePid && !rows.some(row => row.pid === enginePid))
    rows.push({ ...(await readProcess(enginePid)), role: "local-engine", lifetimePeakRssBytes: null });
  const known = new Set(rows.map(row => row.pid)), descendants = new Set(known);
  const tree = await readProcessTree();
  const identities = new Map(tree.map(row => [row.pid, row]));
  const observed = observedChildren.get(app) ?? new Map();
  observedChildren.set(app, observed);
  for (const [pid, startedAt] of observed) {
    const current = identities.get(pid);
    if (current?.startedAt === startedAt) descendants.add(pid);
    else if (current || !await isProcessAlive(pid)) observed.delete(pid);
    else throw new Error("Previously owned process identity is unavailable.");
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, ppid } of tree) if (descendants.has(ppid) && !descendants.has(pid)) {
      descendants.add(pid); changed = true;
    }
  }
  // Cursor/provider/PTY host children are not Electron app metrics. Count
  // their actual OS footprint and CPU once, while preserving the root set.
  for (const pid of descendants) if (!known.has(pid))
    rows.push({ ...(await readProcess(pid)), role: "native-child", lifetimePeakRssBytes: null });
  for (const pid of descendants) if (!known.has(pid) && identities.get(pid)?.startedAt)
    observed.set(pid, identities.get(pid).startedAt);
  const owned = observedProcesses.get(app) ?? new Map();
  observedProcesses.set(app, owned);
  for (const row of rows) {
    const identity = identities.get(row.pid);
    if (identity?.startedAt) owned.set(`${row.pid}:${identity.startedAt}`, {
      pid: row.pid, role: row.role, startedAt: identity.startedAt,
    });
  }
  const footprints = await readFootprints(rows.map(row => row.pid));
  const samples = [];
  for (const row of rows) {
    let physicalFootprintBytes = footprints.get(row.pid);
    // Temporary renderers can exit between Electron's enumeration and libproc's
    // read. Only an OS-confirmed exit removes them from the live process set.
    // A missing live reading (or the app/GPU/engine disappearing) still fails
    // acceptance; never substitute RSS or an invented zero footprint.
    if (physicalFootprintBytes === undefined && ["Tab", "Utility", "native-child"].includes(row.role)) {
      // A child may have released its resources but still await waitpid in
      // its parent: kill(pid, 0) succeeds for that zombie. Require fresh OS
      // state for the same start identity; a live/missing/foreign row still
      // fails with unavailable evidence, never a zero or RSS substitution.
      const original = identities.get(row.pid);
      const identityState = async () => {
        if (!await isProcessAlive(row.pid)) return "retired";
        const current = (await readProcessTree()).find(process => process.pid === row.pid);
        const same = original?.startedAt && current?.startedAt === original.startedAt;
        if (same && current.state?.startsWith("Z")) return "retired";
        // The tree read can cross the helper's reaping; confirm the exit.
        if (!await isProcessAlive(row.pid)) return "retired";
        return same && current.state ? "same" : "unknown";
      };
      let state = await identityState();
      // libproc can race a newly spawned or exiting helper. Retry only twice,
      // and bind both sides of each OS read to its original start identity.
      // Persistent live failures stay null and fail the memory guard.
      for (const waitMs of [25, 50]) {
        if (state !== "same") break;
        await pause(waitMs);
        state = await identityState();
        if (state !== "same") break;
        const retried = await readFootprints([row.pid]);
        state = await identityState();
        if (state === "same" && retried.has(row.pid)) {
          physicalFootprintBytes = retried.get(row.pid);
          break;
        }
      }
      if (state === "retired") continue;
    }
    samples.push({ ...row, physicalFootprintBytes: physicalFootprintBytes ?? null });
  }
  return samples;
}

/** Observe loading and interaction, not just settled snapshots. A failed sample
 * is recorded before the caller retires its owned app. This is a sampled safety
 * guard, not an OS quota or a guarantee that every transient peak was observed. */
export async function startNativeMemoryGuard({ sample, budget, onSample, onFailure, intervalMs = 1000 }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("Invalid memory sampling interval.");
  let stopped = false, failure, wake;
  const inspect = async () => {
    const processes = await sample();
    await onSample({ at: new Date().toISOString(), processes });
    assertNativeMemoryBudget(processes, budget);
  };
  const fail = async error => {
    failure = error;
    try { await onFailure(error); }
    catch (retirementError) { failure = new AggregateError([error, retirementError], "Native memory guard and retirement failed."); }
  };
  try { await inspect(); }
  catch (error) { await fail(error); throw failure; }
  const running = (async () => {
    while (!stopped) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      if (stopped) return;
      try { await inspect(); }
      catch (error) { await fail(error); return; }
    }
  })();
  return {
    assertHealthy() { if (failure) throw failure; },
    async stop() { stopped = true; wake?.(); await running; if (failure) throw failure; },
  };
}
