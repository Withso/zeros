import { execFileSync } from "node:child_process";
import type { IPty } from "node-pty";

/** Close uses the existing PTY host's descendant-before-parent ordering. The
 * resident namespace's cgroup remains the authoritative cleanup boundary for
 * double-forked jobs and host crashes; a process-group exit cannot prove that. */
export function closeResidentPty(proc: IPty): void {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8", timeout: 1_000, maxBuffer: 8 * 1024 * 1024,
    });
    const children = new Map<number, number[]>();
    for (const row of rows.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
      if (!match) continue;
      const pid = Number(match[1]), parent = Number(match[2]);
      children.set(parent, [...children.get(parent) ?? [], pid]);
    }
    const descendants: number[] = [], seen = new Set([proc.pid]);
    const pending = [...children.get(proc.pid) ?? []];
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid); descendants.push(pid); pending.push(...children.get(pid) ?? []);
    }
    for (const pid of descendants.reverse()) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  } catch { /* namespace/cgroup retirement is the final cleanup authority */ }
  try { proc.kill(); } catch { /* already exited */ }
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* group already exited */ }
}
