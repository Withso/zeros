import { execFileSync } from "node:child_process";

export function groupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function groupHasLiveMember(table, pid) {
  return table
    .trim()
    .split("\n")
    .some((row) => {
      const [, group, status = ""] = row.trim().split(/\s+/);
      // Zombies cannot own files or listeners. Neither can a member stuck
      // exiting with no task left ("?E"), which the kernel may never reap.
      const gone =
        status.startsWith("Z") ||
        (status.startsWith("?") && status.includes("E"));
      return Number(group) === pid && !gone;
    });
}

export function groupAlive(pid) {
  if (!pid) return false;
  try {
    // Never inspect argv or environment.
    return groupHasLiveMember(
      execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
        encoding: "utf8",
        timeout: 2000,
      }),
      pid,
    );
  } catch {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  }
}

export function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
