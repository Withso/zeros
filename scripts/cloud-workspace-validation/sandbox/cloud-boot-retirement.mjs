import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";

const refused = () => new Error("Cloud boot original retirement unconfirmed");
const check = value => { if (!value) throw refused(); };
const same = (stat, expected) => String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
function root() { check(process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0); }

/** Capture the original common tree BEFORE launching the short probe. Writes
 * and population reads use retained kernel descriptors, never a fresh lookup
 * of a potentially replaced path. Unknown cleanup retains these descriptors
 * and the caller's view/custody record. No general retirement caller changes. */
export function pinCloudBootRetirement(expected, { io = fs, requireRoot = root, now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  requireRoot();
  check(expected?.directory === "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime" &&
    /^(0|[1-9][0-9]{0,19})$/.test(expected.dev) && /^[1-9][0-9]{0,19}$/.test(expected.ino));
  expected = Object.freeze({ ...expected });
  let directory, kill, events, retired = false, closed = false;
  const close = () => {
    for (const fd of [events, kill, directory]) if (fd !== undefined) io.closeSync(fd);
    events = kill = directory = undefined; closed = true;
  };
  const validateDirectory = (fd, required) => {
    const stat = io.fstatSync(fd);
    check(stat.isDirectory() && stat.uid === 10003 && stat.gid === 10003 && !(stat.mode & 0o022) &&
      io.statfsSync(`/proc/self/fd/${fd}`).type === 0x63677270 && (!required || same(stat, required)));
    return stat;
  };
  const current = () => {
    check(!closed && !retired); validateDirectory(directory, expected);
    const stat = io.lstatSync(expected.directory);
    check(!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === 10003 && stat.gid === 10003 &&
      !(stat.mode & 0o022) && same(stat, expected) && io.realpathSync(expected.directory) === expected.directory);
  };
  const openControl = (fd, name, write) => {
    const control = io.openSync(`/proc/self/fd/${fd}/${name}`, fs.constants.O_NOFOLLOW | (write ? fs.constants.O_WRONLY : fs.constants.O_RDONLY));
    try {
      const stat = io.fstatSync(control);
      check(stat.isFile() && stat.nlink === 1 && (stat.uid === 0 || !write && stat.uid === 10003) && !(stat.mode & 0o022) &&
        io.statfsSync(`/proc/self/fd/${control}`).type === 0x63677270);
      return control;
    } catch (error) { io.closeSync(control); throw error; }
  };
  const populated = fd => {
    const bytes = Buffer.alloc(4097); let size = 0;
    while (size < bytes.length) {
      const count = io.readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break; size += count;
    }
    check(size <= 4096);
    const lines = bytes.toString("utf8", 0, size).split("\n").filter(line => line.startsWith("populated "));
    check(lines.length === 1 && /^populated [01]$/.test(lines[0]));
    return lines[0] === "populated 1";
  };
  try {
    for (let cursor = path.dirname(expected.directory); ; cursor = path.dirname(cursor)) {
      const stat = io.lstatSync(cursor);
      const kernelAncestor = ["/sys", "/sys/fs"].includes(cursor) && stat.uid === 65534 && io.statfsSync(cursor).type === 0x62656572;
      check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === 0 || kernelAncestor) && !(stat.mode & 0o022) && io.realpathSync(cursor) === cursor);
      if (cursor === "/") break;
    }
    directory = io.openSync(expected.directory, fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY | fs.constants.O_RDONLY);
    current(); kill = openControl(directory, "cgroup.kill", true); events = openControl(directory, "cgroup.events", false); current();
  } catch (error) { close(); throw error; }
  return {
    assertCurrent: current,
    async retire(timeoutMs = 5000) {
      check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000); current();
      check(io.writeSync(kill, "1") === 1);
      const deadline = now() + timeoutMs;
      while (populated(events)) {
        current(); check(now() < deadline); await pause(Math.min(25, Math.max(1, deadline - now())));
      }
      current();
      const budget = { remaining: 8192 };
      const prune = (fd, depth) => {
        check(--budget.remaining >= 0 && depth <= 128); validateDirectory(fd);
        const anchor = `/proc/self/fd/${fd}`;
        const children = io.readdirSync(anchor, { withFileTypes: true }).filter(entry => entry.isDirectory());
        for (const child of children) {
          check(child.name && child.name.length <= 255 && ![".", ".."].includes(child.name) && !/[/\0]/.test(child.name));
          const file = `${anchor}/${child.name}`, childFd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
          try {
            const stat = validateDirectory(childFd); prune(childFd, depth + 1); current();
            check(same(io.lstatSync(file), { dev: String(stat.dev), ino: String(stat.ino) })); io.rmdirSync(file);
          } finally { io.closeSync(childFd); }
        }
        const population = openControl(fd, "cgroup.events", false);
        try { check(!populated(population)); } finally { io.closeSync(population); }
      };
      prune(directory, 0); current(); io.rmdirSync(expected.directory); retired = true;
      return Object.freeze({ ...expected, populated: 0, pruned: true });
    },
    close() { check(retired); close(); },
  };
}
