import { readdir, readFile } from "node:fs/promises";

export interface SweepDeps {
  self?: number; waitMs?: number; intervalMs?: number;
  pids?(): Promise<number[]>;
  environ?(pid: number): Promise<string>;
  kill?(pid: number): void;
}
const listPids = async () => (await readdir("/proc").catch(() => [] as string[])).filter(name => /^\d+$/.test(name)).map(Number);
// Another user's process, or one that just exited, is unreadable: it is not this worker's to count.
const readEnviron = (pid: number) => readFile(`/proc/${pid}/environ`, "latin1").catch(() => "");
const killPid = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } };

/** Team sharing retirement proof: every process that inherited this context
 * (agent, MCP server, shell, Git, their descendants) carries its
 * ZEROS_EXECUTION_CONTEXT. Kill them all, wait for them to go, and return how
 * many remain: 0 is the worker's attestation that the context's processes are gone. */
export async function sweepContext(contextId: string, deps: SweepDeps = {}): Promise<number> {
  const marker = `\0ZEROS_EXECUTION_CONTEXT=${contextId}\0`;
  const self = deps.self ?? process.pid, pids = deps.pids ?? listPids, environ = deps.environ ?? readEnviron, kill = deps.kill ?? killPid;
  const holders = async () => {
    const found: number[] = [];
    for (const pid of await pids()) if (pid !== self && `\0${await environ(pid)}`.includes(marker)) found.push(pid);
    return found;
  };
  const deadline = Date.now() + (deps.waitMs ?? 2_000);
  let remaining = await holders();
  while (remaining.length) {
    for (const pid of remaining) kill(pid);
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, deps.intervalMs ?? 50));
    remaining = await holders();
  }
  return remaining.length;
}
