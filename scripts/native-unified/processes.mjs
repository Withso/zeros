// The native check's processes: every descendant of what it started, their sockets, and a teardown that leaves
// none behind. macOS reads ps and lsof; Linux (the sandbox the script is developed in) reads ps and /proc.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { isLoopbackAddress } from "./report.mjs";

const exec = promisify(execFile);

/** Every process: pid, parent, group, start time and command line. The start time is what tells a process apart from
 * a later one that was given the same pid (Linux reuses pids quickly). */
export async function processTable() {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart=,command="], { maxBuffer: 16 * 1024 * 1024 });
  return parseProcessTable(stdout);
}

export function parseProcessTable(stdout) {
  return stdout.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line))
    .filter(Boolean).map(([, pid, ppid, pgid, started, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid),
      started: started.replace(/\s+/g, " "), command }));
}

/** A process as it is now ({ pid, started }), to name it later as a root; null once it is gone. */
export async function identify(pid) {
  if (!pid) return null;
  const row = (await processTable()).find(entry => entry.pid === pid);
  return row ? { pid: row.pid, started: row.started } : null;
}

/** The roots that are still the same processes, and everything below them. A root whose pid now belongs to a process
 * that started at another time is someone else's, and is ignored with everything below it. */
export function descendants(table, roots) {
  const live = roots.filter(Boolean).filter(root => table.some(row => row.pid === root.pid && row.started === root.started)).map(root => root.pid);
  const children = new Map();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found = new Map(), queue = [...live];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) if (!found.has(child.pid)) { found.set(child.pid, child); queue.push(child.pid); }
  }
  for (const row of table) if (live.includes(row.pid)) found.set(row.pid, row);
  return [...found.values()];
}

/** The run's folder named as a folder: `<root>/…` or `<root>` alone, never `<root>-other/…` beside it. */
export function namesRunFolder(command, root) {
  if (!root) return false;
  for (let at = command.indexOf(root); at >= 0; at = command.indexOf(root, at + 1)) {
    const next = command[at + root.length];
    if (next === undefined || next === "/" || /\s/.test(next)) return true;
  }
  return false;
}

/** A shell (or timeout) whose command line only names the run's folder: whoever started the run, never the app's
 * (the app's own shells are found as its descendants). The run's stub login shell is the app's. */
export function isLauncherCommand(command, root) {
  return /^(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s|$)|^(?:\S*\/)?(?:coreutils\s+\S*\s+\S*\/)?timeout\s/.test(command) && !command.includes(`${root}/bin/login-shell`);
}

/** The run's processes in a table: below its live roots, or naming its folder (a child that was reparented), never
 * this script or anything above it (the shell that started it may name the folder too). */
export function selectRunProcesses(table, roots, root, self = process.pid) {
  const parents = new Map(table.map(row => [row.pid, row.ppid])), ancestors = new Set();
  for (let pid = self; pid && !ancestors.has(pid); pid = parents.get(pid) ?? 0) ancestors.add(pid);
  const own = new Map(descendants(table, roots).map(row => [row.pid, row]));
  for (const row of table) if (namesRunFolder(row.command, root) && !own.has(row.pid) && !isLauncherCommand(row.command, root)) own.set(row.pid, row);
  for (const pid of ancestors) own.delete(pid);
  return [...own.values()];
}

export async function runProcesses(roots, root) {
  return selectRunProcesses(await processTable(), roots, root);
}

/** What to signal: whole groups only when a run process leads them (never a group it merely sits in, nor this
 * script's), and every other run process by its own pid. */
export function signalTargets(before, table, self = process.pid) {
  const ancestorsGroups = new Set();
  for (let pid = self, row; (row = table.find(entry => entry.pid === pid)); pid = row.ppid) { ancestorsGroups.add(row.pgid); if (!row.ppid) break; }
  const groups = new Set(before.filter(row => row.pgid > 1 && row.pgid === row.pid && !ancestorsGroups.has(row.pgid)).map(row => row.pgid));
  const singles = before.filter(row => !groups.has(row.pgid));
  return { groups: [...groups], singles };
}

/** Stop every process of the run: the groups its processes lead (TERM, then KILL), then the rest by pid. Each pid
 * is checked to be the same process (same start time) right before it is signalled. */
export async function killRun(roots, root, { graceMs = 3000 } = {}) {
  const before = await runProcesses(roots, root);
  const { groups, singles } = signalTargets(before, await processTable());
  const signal = async (sig) => {
    const now = await processTable();
    const same = (row) => now.some(entry => entry.pid === row.pid && entry.started === row.started);
    for (const group of groups) { const leader = before.find(row => row.pid === group); if (leader && same(leader)) try { process.kill(-group, sig); } catch { /* gone */ } }
    for (const row of singles) if (same(row)) try { process.kill(row.pid, sig); } catch { /* gone */ }
  };
  await signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (await runProcesses(roots, root)).length) await new Promise(resolve => setTimeout(resolve, 200));
  await signal("SIGKILL");
  const left = await runProcesses(roots, root);
  const now = await processTable();
  for (const row of left) if (now.some(entry => entry.pid === row.pid && entry.started === row.started)) try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ }
  await new Promise(resolve => setTimeout(resolve, 300));
  return { stopped: before.length, left: (await runProcesses(roots, root)).length };
}

const hexAddress = (hex) => {
  // /proc/net/tcp: little-endian IPv4 words, or four little-endian words of IPv6.
  const [addr, port] = hex.split(":");
  const bytes = Buffer.from(addr, "hex");
  if (bytes.length === 4) return { host: [...bytes].reverse().join("."), port: parseInt(port, 16) };
  const words = [];
  for (let i = 0; i < 16; i += 4) words.push(...[...bytes.subarray(i, i + 4)].reverse());
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(((words[i] << 8) | words[i + 1]).toString(16));
  const text = parts.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
  return { host: text.startsWith("::ffff:7f") || text === "::ffff:7f00:1" ? "127.0.0.1" : text, port: parseInt(port, 16) };
};

/** Every TCP socket the run's processes hold: listening ones and connections, with their addresses. */
export async function runSockets(pids) {
  if (!pids.length) return [];
  if (process.platform === "darwin") {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP"], { maxBuffer: 16 * 1024 * 1024 }).catch(error => ({ stdout: error.stdout ?? "" }));
    return stdout.split("\n").slice(1).filter(Boolean).map(line => {
      const name = line.trim().split(/\s+/).slice(8).join(" ");
      const state = /\((\w+)\)/.exec(name)?.[1] ?? "";
      const [local, remote] = name.replace(/\s*\(\w+\)$/, "").split("->");
      const host = (value) => value?.slice(0, value.lastIndexOf(":")).replace(/^\[|\]$/g, "");
      return { pid: Number(line.trim().split(/\s+/)[1]), state, local: host(local), remote: remote ? host(remote) : null };
    });
  }
  const inodes = new Map();
  for (const pid of pids) {
    let fds = [];
    try { fds = await fs.readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) inodes.set(inode, pid);
    }
  }
  const sockets = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || !inodes.has(parts[9])) continue;
      const local = hexAddress(parts[1]), remote = hexAddress(parts[2]);
      const state = parts[3] === "0A" ? "LISTEN" : parts[3] === "01" ? "ESTABLISHED" : parts[3];
      sockets.push({ pid: inodes.get(parts[9]), state, local: local.host, remote: state === "LISTEN" ? null : remote.host });
    }
  }
  return sockets;
}

/** The socket facts N12 judges: any listener or peer that is not loopback. */
export function foreignSockets(sockets) {
  return sockets.filter(socket => socket.state === "LISTEN" ? !isLoopbackAddress(socket.local)
    : socket.remote && !isLoopbackAddress(socket.remote));
}

/** One variable of a run process's environment (ps shows it for this user's own processes on macOS and Linux). */
export async function processVariable(pid, name) {
  const { stdout } = await exec("ps", ["eww", "-o", "command=", "-p", String(pid)], { maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  return new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(stdout)?.[1] ?? null;
}
