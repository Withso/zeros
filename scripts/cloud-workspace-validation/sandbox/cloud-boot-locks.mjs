import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const refused = () => new Error("Cloud boot admission lock refused");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink;
function metadata(file, fd) {
  for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022 || fs.realpathSync(cursor) !== cursor) throw refused();
    if (cursor === "/") break;
  }
  const stat = fs.fstatSync(fd), current = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || stat.size !== 0 ||
      ![0o600, 0o640, 0o644].includes(stat.mode & 0o7777) || current.isSymbolicLink() || !same(stat, current) || fs.realpathSync(file) !== file) throw refused();
  return stat;
}
function command(fd) {
  const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000, maxBuffer: 4096,
  });
  if (result.error || result.signal || result.stdout.length || result.stderr.length) throw refused();
  return result.status;
}
function held(file, fd, original) {
  if (!same(original, metadata(file, fd))) throw refused();
  const fileInfo = `/proc/self/fdinfo/${fd}`;
  if (fs.statfsSync(fileInfo).type !== 0x9fa0) throw refused();
  const source = fs.readFileSync(fileInfo, "utf8");
  if (source.length > 4096) throw refused();
  const lines = source.split("\n").filter(line => line.startsWith("lock:"));
  const lock = lines.length === 1 && /^lock:\s+[0-9]+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?[0-9]+\s+[a-f0-9]+:[a-f0-9]+:([0-9]+)\s+0\s+EOF$/.exec(lines[0]);
  if (!lock || lock[1] !== String(original.ino)) throw refused();
}

/** Acquire in the existing order, or validate an original held pair acquired
 * by the trusted launch caller in that order. Engine custody always requires
 * setup first; inherited FDs remain held for the caller's subsequent launch.
 * No lock descriptor crosses the native engine boundary. */
export async function withCloudBootLocks(operation, { setupLockFd, engineLockFd } = {}) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.getgid?.() !== 0) throw refused();
  if (engineLockFd !== undefined && setupLockFd === undefined) throw refused();
  const locks = [], owned = [];
  try {
    for (const [index, name] of ["setup", "engine"].entries()) {
      const file = `/run/zeros/${name}.lock`;
      const supplied = [setupLockFd, engineLockFd][index], inherited = supplied !== undefined;
      if (inherited && (!Number.isSafeInteger(supplied) || supplied < 3)) throw refused();
      const fd = inherited ? supplied : fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      if (!inherited) owned.push(fd);
      const original = metadata(file, fd);
      if (!inherited && command(fd) !== 0) throw refused();
      held(file, fd, original);
      // An independent opener must contend; another process's flock alone is
      // insufficient, since held() checks this open file description too.
      const contender = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { if (!same(original, metadata(file, contender)) || command(contender) !== 73) throw refused(); }
      finally { fs.closeSync(contender); }
      locks.push({ file, fd, original });
    }
    const assertCurrent = () => { for (const lock of locks) held(lock.file, lock.fd, lock.original); };
    assertCurrent();
    const result = await operation({ assertCurrent, setupLockFd: locks[0].fd, engineLockFd: locks[1].fd });
    assertCurrent();
    return result;
  } finally { for (const fd of owned.reverse()) fs.closeSync(fd); }
}
