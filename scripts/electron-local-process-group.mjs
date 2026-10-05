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

export function groupAlive(pid) {
  if (!pid) return false;
  try {
    // Zombies cannot own files or listeners. Never inspect argv or environment.
    return execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 2000,
    })
      .trim()
      .split("\n")
      .some((row) => {
        const [, group, status] = row.trim().split(/\s+/);
        return Number(group) === pid && !status?.startsWith("Z");
      });
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
