import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { HarnessFailure } from "./assertions";

export function assertPrivatePidNamespace(outer: string, current: string, pid: number): void {
  if (!/^pid:\[\d+\]$/.test(outer) || !/^pid:\[\d+\]$/.test(current) || outer === current || pid !== 1)
    throw new HarnessFailure("private_pid_namespace_required");
}
export async function retirePrivateProcesses(io: { members(): number[]; kill(pid: number): void; pause(): Promise<void>; now(): number }, timeoutMs = 5000) {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const members = io.members().filter(pid => pid > 1);
    if (!members.length) return;
    for (const pid of members) io.kill(pid);
    if (io.now() >= deadline) throw new HarnessFailure("cleanup_unconfirmed");
    await io.pause();
  }
}
/** Explicitly test-only: real CPU membership, no memory/pids cgroup limits.
 * Full process ownership is the guarded private PID namespace, covering
 * setsid, double-fork and new user/PID namespace descendants. */
export class CpuPrivatePidFixtureScope {
  retired = false;
  readonly directory: string;
  constructor(private readonly root: string, instanceId: string, outerPidNamespace: string) {
    assertPrivatePidNamespace(outerPidNamespace, readlinkSync("/proc/self/ns/pid"), process.pid);
    if (!/^\/sys\/fs\/cgroup\/zeros-agent-e2e-[A-Za-z0-9-]+\/zeros-host\.service$/.test(root) || !/^[a-f0-9-]{36}$/.test(instanceId))
      throw new HarnessFailure("fixture_contract_invalid");
    this.directory = `${root}/engine-${instanceId}`;
  }
  prepare() {
    mkdirSync(this.directory, { mode: 0o755 });
    writeFileSync(`${this.directory}/cgroup.type`, "threaded");
    writeFileSync(`${this.directory}/cpu.max`, "400000 100000");
    if (readFileSync(`${this.directory}/cpu.max`, "utf8").trim() !== "400000 100000") throw new HarnessFailure("cgroup_unavailable");
  }
  attach(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new HarnessFailure("fixture_contract_invalid");
    writeFileSync(`${this.directory}/cgroup.procs`, String(pid));
    if (!readFileSync(`${this.directory}/cgroup.threads`, "utf8").trim().split(/\s+/).includes(String(pid))) throw new HarnessFailure("cgroup_unavailable");
  }
  async retire() {
    await retirePrivateProcesses({ members: () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
      if (pid <= 1) return false;
      try { const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0); return state !== "Z"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }), kill: pid => { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } },
      pause: () => new Promise(resolve => setTimeout(resolve, 25)), now: Date.now });
    // Task removal can lag the process exit observation. Preserve a positive,
    // bounded kernel-membership proof instead of guessing after the kill.
    const deadline = Date.now() + 5000;
    while (readFileSync(`${this.directory}/cgroup.threads`, "utf8").trim()) {
      if (Date.now() >= deadline) throw new HarnessFailure("cleanup_unconfirmed");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    rmdirSync(this.directory); this.retired = true;
  }
}
