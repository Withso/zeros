// One exclusive lock file shared by the development launchers and the instance
// registry. Node built-ins only: storage:inventory runs without node_modules.
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

/** The text of a small private file, or null when it does not exist. Opening
 * never blocks (a FIFO in its place) and never follows a link; anything but a
 * regular file throws. */
export function readRegularFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: "ENOTREG" });
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

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

function readCommandLine(pid) {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
}

/** Lock classification for a launcher whose command line contains any of
 * `markers`: a recycled PID (including after reboot) is not a launcher owner.
 * A live PID whose command line cannot be read stays live. */
export function launcherOwnerClassifier(markers, incompleteMessage, invalidMessage, { readCommand = readCommandLine } = {}) {
  const names = Array.isArray(markers) ? markers : [markers];
  return ({ owner }) => {
    if (!owner) throw new Error(incompleteMessage);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(invalidMessage);
    if (!pidAlive(owner.pid)) return "stale";
    let command;
    try {
      command = readCommand(owner.pid);
    } catch {
      return pidAlive(owner.pid) ? "live" : "stale";
    }
    return names.some((marker) => command.includes(marker)) ? "live" : "stale";
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
    const raw = readRegularFile(file);
    if (raw === null) return null;
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
    let ownedTemporary = false;
    try {
      fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
      ownedTemporary = true;
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
      if (ownedTemporary) fs.rmSync(temporary, { force: true });
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
        fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const abandoned = fs.lstatSync(recovery);
          // A fence whose recorded owner is alive is never abandoned.
          // An unusable fence (not a regular file) is never read or removed.
          if (!abandoned.isFile()) break;
          let fenceOwner = null;
          try {
            fenceOwner = JSON.parse(readRegularFile(recovery) ?? "null")?.pid ?? null;
          } catch {
            fenceOwner = null;
          }
          if (Number.isSafeInteger(fenceOwner) && fenceOwner > 0 ? pidAlive(fenceOwner) : Date.now() - abandoned.mtimeMs <= 30_000) break;
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
    raw = readRegularFile(file);
  } catch {
    return "unknown";
  }
  if (raw === null) return "absent";
  try {
    const owner = JSON.parse(raw);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return "unknown";
    return pidAlive(owner.pid) ? "live" : "absent";
  } catch {
    return "unknown";
  }
}

const LAUNCHER_MARKERS = ["electron-local.mjs", "dev-environment/launcher.mjs"];

/** One lock per checkout, shared by `electron:local` and `electron:alpha`:
 * both rebuild the checkout's dist-electron and dist-engine. */
export function acquireCheckoutLauncherLock(root, record = {}) {
  return acquireExclusiveLock({
    file: path.join(root, ".context", "zeros-local", "launcher.lock"),
    record,
    classify: launcherOwnerClassifier(
      LAUNCHER_MARKERS,
      "Zeros Local launcher lock is incomplete; stop Local before removing .context/zeros-local/launcher.lock.",
      "Invalid Zeros Local launcher lock.",
    ),
    busyMessage: "A Zeros launcher (electron:local or electron:alpha) is already running from this checkout. Stop it before launching again.",
    recoveryBusyMessage: "Zeros Local lock recovery is already in progress; retry after it completes.",
    changedMessage: "Zeros Local launcher lock changed; retry.",
  });
}

/** An identity lock for a launcher, recognised as live while either launcher
 * holds it. */
export function acquireLauncherLock(file, { record = {}, busyMessage }) {
  return acquireExclusiveLock({
    file,
    record,
    classify: launcherOwnerClassifier(LAUNCHER_MARKERS, `The launcher lock at ${file} is incomplete; stop that launcher before removing it.`, "Invalid launcher lock."),
    busyMessage,
    recoveryBusyMessage: "Lock recovery is already in progress; retry after it completes.",
    changedMessage: "The launcher lock changed; retry.",
  });
}
