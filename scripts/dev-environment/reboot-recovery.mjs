import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveWorkspace } from "./state.mjs";

export const REBOOT_RECOVERED = "[zeros-dev] The previous launch ended when this machine restarted; nothing from it is running.";

/** This boot's identity, or null where the platform has none. A VM restored
 * from a memory snapshot keeps it, along with its processes. */
export function currentBoot() {
  try {
    if (process.platform === "linux") return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    if (process.platform === "darwin") return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch { /* An unknown boot never clears a recorded launch. */ }
  return null;
}

/** For receipts written before launches recorded their boot: every process a
 * launch started ends when the machine reboots, so a receipt last written
 * before the current boot has no surviving service. A boot within seconds of
 * that write is too close to prove and stays unconfirmed. */
export function launchPredatesBoot(file, { now = Date.now(), uptimeSeconds = os.uptime() } = {}) {
  let written;
  try { written = fs.statSync(file).mtimeMs; } catch { return false; }
  return now - uptimeSeconds * 1000 > written + 5_000;
}

/** Clears only a launch that ended with a reboot. Any other unconfirmed launch,
 * such as a crashed supervisor whose descendants may live, stays for --stop. */
export function recoverLaunchAfterReboot(workspace, { boot = currentBoot(), ...options } = {}) {
  const receipt = workspace.state.launcher;
  if (!receipt) return false;
  if (receipt.boot ? !boot || receipt.boot === boot : !launchPredatesBoot(workspace.file, options)) return false;
  delete workspace.state.launcher;
  fs.rmSync(path.join(workspace.directory, "run.lock"), { force: true });
  saveWorkspace(workspace);
  return true;
}
