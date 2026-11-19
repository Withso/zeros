// One exclusive lock file shared by the development launchers and the instance
// registry. Node built-ins only: storage:sweep must run without node_modules.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class LockBusyError extends Error {
  constructor(message) {
    super(message);
    this.code = "ELOCKBUSY";
  }
}

const activeLockTokens = new Set();

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM: a live process owned by someone else.
    return true;
  }
}

/** Lock classification for a launcher whose command line contains `marker`:
 * a recycled PID (including after reboot) is not a launcher owner. */
export function launcherOwnerClassifier(marker, incompleteMessage, invalidMessage) {
  return ({ owner }) => {
    if (!owner) throw new Error(incompleteMessage);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(invalidMessage);
    if (!pidAlive(owner.pid)) return "stale";
    try {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(owner.pid)], {
        encoding: "utf8",
        timeout: 2000,
      });
      return command.includes(marker) ? "live" : "stale";
    } catch {
      // The PID can disappear between kill(0) and this read-only probe.
      return "stale";
    }
  };
}

/** True while this process itself still holds `owner`'s lock. */
export function heldByThisProcess(owner) {
  return owner?.pid === process.pid && activeLockTokens.has(owner.token);
}

/**
 * Publish complete private JSON with link(2) so a reader never sees a partial
 * owner and a second owner can never overwrite the first. `classify(snapshot)`
 * returns "live" or "stale" for the current holder (or throws). A stale holder
 * is retired under a per-generation recovery fence, so two recoverers cannot
 * both remove it and release never removes a replacement owner's record.
 */
export function acquireExclusiveLock({
  file,
  record = {},
  classify,
  busyMessage = "The lock is held by another process.",
  recoveryBusyMessage = "Lock recovery is already in progress; retry after it completes.",
  changedMessage = "The lock changed; retry.",
}) {
  const directory = path.dirname(file);
  const stem = path.basename(file, ".lock");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const body = JSON.stringify({ ...record, pid: process.pid, token, at: Date.now() });
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    let owner = null;
    try {
      owner = JSON.parse(raw);
    } catch {
      owner = null;
    }
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    return { raw, owner, stat };
  };
  acquire: for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = path.join(directory, `${stem}-${token}.tmp`);
    try {
      fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
      try {
        fs.linkSync(temporary, file);
        activeLockTokens.add(token);
        return () => {
          try {
            if (read()?.owner?.token === token) fs.unlinkSync(file);
          } finally {
            activeLockTokens.delete(token);
          }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const snapshot = read();
    if (!snapshot) continue;
    if (heldByThisProcess(snapshot.owner) || classify(snapshot) !== "stale")
      throw new LockBusyError(busyMessage);
    const generation = createHash("sha256").update(snapshot.raw).digest("hex");
    const recovery = path.join(directory, `recovery-${generation}.lock`);
    let fd;
    for (let fenceAttempt = 0; fenceAttempt < 3; fenceAttempt++) {
      try {
        fd = fs.openSync(recovery, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const abandoned = fs.statSync(recovery);
          if (Date.now() - abandoned.mtimeMs <= 30_000) break;
          if (read()?.raw !== snapshot.raw) continue acquire;
          const current = fs.statSync(recovery);
          if (current.ino === abandoned.ino && current.mtimeMs === abandoned.mtimeMs)
            fs.unlinkSync(recovery);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    if (fd === undefined) throw new LockBusyError(recoveryBusyMessage);
    try {
      // Retire only the stale generation inspected before taking the fence.
      if (read()?.raw === snapshot.raw) fs.unlinkSync(file);
    } finally {
      const held = fs.fstatSync(fd);
      fs.closeSync(fd);
      try {
        if (fs.statSync(recovery).ino === held.ino) fs.unlinkSync(recovery);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error(changedMessage);
}

/** Read a lock's owner without taking it: "absent", "live" or "unknown"
 * (unreadable is never proof that nobody holds it). */
export function lockOwnerState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : "unknown";
  }
  try {
    const owner = JSON.parse(raw);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return "unknown";
    return pidAlive(owner.pid) ? "live" : "absent";
  } catch {
    return "unknown";
  }
}
