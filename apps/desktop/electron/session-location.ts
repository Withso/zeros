// Chooses this launch's Chromium profile before `app` is ready. The whole old
// profile moves to `<data dir>/electron` in one rename(2), or nothing moves and
// the launch keeps using the old location: a launch always runs on one coherent
// profile. Nothing is merged, copied, filled in, deleted or left half-moved.
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSION_MOVED_MARKER } from "../src/engine/db/local-development-paths.cjs";

export { SESSION_MOVED_MARKER };

type ChooserFs = Pick<typeof nodeFs, "lstatSync" | "readdirSync" | "readlinkSync" | "renameSync" | "mkdirSync" | "writeFileSync">;

export interface SessionChoice {
  dir: string;
  outcome: "marked" | "fresh" | "moved" | "kept-old" | "unchanged";
  reason?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function chooseSessionDataDir({
  target,
  old,
  userDataDir,
  pid = process.pid,
  hostname = os.hostname(),
  fs = nodeFs,
  alive = processAlive,
  log,
}: {
  /** zerosSessionDataDir(): where the profile lives once moved. */
  target: string;
  /** zerosOldSessionDataDir(): the one old profile, or null when nothing moves. */
  old: string | null;
  /** Electron's userData, where Chromium keeps the profile's SingletonLock. */
  userDataDir: string;
  pid?: number;
  hostname?: string;
  fs?: ChooserFs;
  alive?: (pid: number) => boolean;
  /** Durable: the GUI log hook is installed after this runs. */
  log: (line: string) => void;
}): SessionChoice {
  const lstat = (file: string): nodeFs.Stats | null => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const marked = (): boolean => lstat(path.join(target, SESSION_MOVED_MARKER))?.isFile() === true;
  const mark = () => {
    try {
      fs.writeFileSync(path.join(target, SESSION_MOVED_MARKER), new Date().toISOString(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      // Without it the next launch finds no old profile and writes it then.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") log(`session data: marker not written (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  };
  const keepOld = (reason: string): SessionChoice => {
    log(`session data stays at its old location this launch: ${reason}`);
    return { dir: old ?? target, outcome: "kept-old", reason };
  };

  try {
    if (marked()) return { dir: target, outcome: "marked" };
    if (old === null || path.resolve(old) === path.resolve(target)) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      return { dir: target, outcome: "unchanged" };
    }
    const resolvedOld = path.resolve(old), resolvedTarget = path.resolve(target);
    if (resolvedTarget.startsWith(`${resolvedOld}${path.sep}`) || resolvedOld.startsWith(`${resolvedTarget}${path.sep}`))
      return keepOld("the old and new locations overlap");
    const oldStat = lstat(old);
    if (!oldStat) {
      try {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      } catch (error) {
        return keepOld(`cannot create the new location (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      }
      mark();
      return { dir: target, outcome: "fresh" };
    }
    const owner = foreignOwner(fs, userDataDir, pid, hostname, alive);
    if (owner) return keepOld(owner);
    if (hasLinkedComponent(fs, old) || hasLinkedComponent(fs, target)) return keepOld("a path component is a symlink");
    if (!oldStat.isDirectory()) return keepOld("the old location is not a folder");
    // A relative link (`Local Storage -> ../offloaded`) would resolve elsewhere
    // under the new parent. Chromium itself creates none in a profile.
    if (fs.readdirSync(old, { withFileTypes: true }).some((entry) => entry.isSymbolicLink()))
      return keepOld("the old profile links to a store outside it");
    const targetStat = lstat(target);
    if (targetStat && (!targetStat.isDirectory() || fs.readdirSync(target).length > 0))
      return keepOld("the new location already holds something");
    const parent = path.dirname(target);
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    } catch (error) {
      return keepOld(`cannot create the data folder (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (lstat(parent)?.dev !== oldStat.dev) return keepOld("the old and new locations are on different volumes");
    try {
      fs.renameSync(old, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another process starting at the same moment moved it first.
      if (code === "ENOENT" && !lstat(old) && lstat(target)?.isDirectory()) {
        mark();
        return { dir: target, outcome: "moved" };
      }
      return keepOld(`the move failed (${code ?? "error"})`);
    }
    mark();
    return { dir: target, outcome: "moved" };
  } catch (error) {
    return keepOld(`unexpected ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

/** A reason when Chromium's SingletonLock (`<host>-<pid>`) names someone else
 * who may still have the profile open; an unreadable lock is someone else. */
function foreignOwner(fs: ChooserFs, userDataDir: string, pid: number, hostname: string, alive: (pid: number) => boolean): string | null {
  let link: string;
  try {
    link = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "the profile lock cannot be read";
  }
  const match = /^(.+)-(\d+)$/.exec(link);
  if (!match) return "the profile lock cannot be parsed";
  if (match[1] !== hostname) return "the profile lock names another computer";
  const owner = Number(match[2]);
  if (owner === pid || !alive(owner)) return null;
  return "another Zeros process has the profile open";
}

/** True if any existing component of `file`, from the filesystem root down,
 * is a symlink, or cannot be inspected. */
function hasLinkedComponent(fs: ChooserFs, file: string): boolean {
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}
