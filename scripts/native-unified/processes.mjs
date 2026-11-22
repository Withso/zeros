// The native check's processes: every descendant of what it started, their sockets, and a teardown that leaves
// none behind. macOS reads ps and lsof; Linux (the sandbox the script is developed in) reads ps and /proc.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { isLoopbackAddress } from "./report.mjs";

const exec = promisify(execFile);

/** Every process: pid, parent, group and command line. */
export async function processTable() {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,command="], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, pgid, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command }));
}

/** The roots and everything below them. */
export function descendants(table, roots) {
  const children = new Map();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found = new Map(), queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) if (!found.has(child.pid)) { found.set(child.pid, child); queue.push(child.pid); }
  }
  for (const row of table) if (roots.includes(row.pid)) found.set(row.pid, row);
  return [...found.values()];
}

/** Processes that belong to this run: below its roots, or naming its folder (a child that was reparented). */
export async function runProcesses(roots, root) {
  const table = await processTable();
  // Never this script or anything above it (the shell that started it may name the folder too).
  const parents = new Map(table.map(row => [row.pid, row.ppid])), ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = parents.get(pid) ?? 0) ancestors.add(pid);
  const own = new Map(descendants(table, roots.filter(Boolean)).map(row => [row.pid, row]));
  for (const row of table) if (root && row.command.includes(root) && !own.has(row.pid)) own.set(row.pid, row);
  for (const pid of ancestors) own.delete(pid);
  return [...own.values()];
}

/** Stop every process of the run: their groups first (TERM, then KILL), then any stragglers by pid. */
export async function killRun(roots, root, { graceMs = 3000 } = {}) {
  const before = await runProcesses(roots, root);
  // Their process groups, never this script's own (nor its shell's).
  const table = await processTable();
  const parentsGroups = new Set(); for (let pid = process.pid, row; (row = table.find(entry => entry.pid === pid)); pid = row.ppid) { parentsGroups.add(row.pgid); if (!row.ppid) break; }
  const groups = new Set(before.map(row => row.pgid).filter(group => group > 1 && !parentsGroups.has(group)));
  const signal = (sig) => {
    for (const group of groups) { try { process.kill(-group, sig); } catch { /* gone */ } }
    for (const row of before) { if (parentsGroups.has(row.pgid)) try { process.kill(row.pid, sig); } catch { /* gone */ } }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (await runProcesses(roots, root)).length) await new Promise(resolve => setTimeout(resolve, 200));
  signal("SIGKILL");
  for (const row of await runProcesses(roots, root)) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } }
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
