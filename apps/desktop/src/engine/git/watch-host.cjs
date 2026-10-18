#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Zeros watch host — native recursive worktree watching for a packaged engine
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// The packaged engine is a bun-compiled binary whose main event loop deadlocks
// after a native FSEvents watcher is armed (see the gitWatcher block in
// zeros-engine.ts). It therefore watched every worktree with Chokidar's stat
// poller, which installs one poller per file and directory: a single checkout
// of this repository is ~8,300 pollers, re-stat'ed every 1.5 s, for every
// non-archived workspace. This Node subprocess (run by the Electron binary as
// Node, like pty-host.cjs) holds ONE native recursive watch per root instead,
// so an idle worktree costs no periodic work at all.
//
// The engine keeps every policy decision: targets, Git-ignored folders, nested
// tool worktrees, suspension and debouncing. This host only reports paths.
// Paths inside `.git` and `node_modules` are dropped here as well, because the
// engine always ignores them and a dependency install would otherwise send
// thousands of lines over the pipe.
//
// PROTOCOL (newline-delimited JSON, one object per line)
//   engine → host (stdin):
//     {"t":"watch","id":7,"root":"/abs/worktree"}
//     {"t":"unwatch","id":7}
//   host → engine (stdout):
//     {"t":"ready"}                                    (once, on startup)
//     {"t":"watching","id":7}                          (root armed)
//     {"t":"events","id":7,"events":[["add","/abs/f"],["change","/abs/g"]]}
//     {"t":"error","id":7,"code":"ENOENT"}             (root unavailable)
// Event names follow Chokidar's: add, addDir, change, unlink, unlinkDir. A
// removed path is a directory when this host knew it as one: each root keeps
// the set of its directories (one directory-only walk when armed, then added
// and removed from events), as Chokidar's own watched tree does.
// "rescan" names the root itself when the platform could not name a path.
// Batches are flushed every 25 ms, or at once when they reach 2,000 paths, so
// no observed path is ever dropped.
//
// stdout is RESERVED for the protocol — this process must never console.log.
// It exits when the engine closes stdin (clean shutdown or crash) and, as a
// backstop, when its parent process is gone.
// ──────────────────────────────────────────────────────────

"use strict";

const fs = require("fs");
const path = require("path");
const { setImmediate } = require("timers");

const FLUSH_MS = 25;
const MAX_BATCH_PATHS = 2_000;
const IGNORED_SEGMENT = /(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/;

/** @type {Map<number, {root: string, watcher: fs.FSWatcher | null, pending: Map<string, string>, timer: NodeJS.Timeout | null, directories: Set<string>}>} */
const roots = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function flush(id) {
  const entry = roots.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.pending.size === 0) return;
  const events = [...entry.pending].map(([filePath, event]) => [event, filePath]);
  entry.pending.clear();
  send({ t: "events", id, events });
}

function record(id, filePath, event) {
  const entry = roots.get(id);
  if (!entry) return;
  // A later observation of the same path wins; an add followed by a change
  // inside one window is still an add.
  const previous = entry.pending.get(filePath);
  entry.pending.set(filePath, previous === "add" && event === "change" ? "add" : event);
  if (entry.pending.size >= MAX_BATCH_PATHS) flush(id);
  else if (!entry.timer) entry.timer = setTimeout(() => flush(id), FLUSH_MS);
}

function classify(id, filePath, eventType) {
  if (eventType === "change") {
    record(id, filePath, "change");
    return;
  }
  // "rename" covers create, delete and move on every platform. Observe the
  // path once to report the same names Chokidar would.
  fs.lstat(filePath, (error, stats) => {
    const entry = roots.get(id);
    if (!entry) return;
    if (!error) {
      const directory = stats.isDirectory();
      if (directory) entry.directories.add(filePath);
      record(id, filePath, directory ? "addDir" : "add");
      return;
    }
    if (!entry.directories.has(filePath)) {
      record(id, filePath, "unlink");
      return;
    }
    const prefix = filePath + path.sep;
    for (const directory of entry.directories) {
      if (directory === filePath || directory.startsWith(prefix)) entry.directories.delete(directory);
    }
    record(id, filePath, "unlinkDir");
  });
}

/** Directory-only walk, never a per-file stat. Runs once per armed root. */
function learnDirectories(id, entry) {
  const queue = [entry.root];
  const next = () => {
    if (roots.get(id) !== entry) return;
    const directory = queue.pop();
    if (directory === undefined) return;
    fs.readdir(directory, { withFileTypes: true }, (error, children) => {
      if (roots.get(id) !== entry) return;
      if (!error) {
        for (const child of children) {
          if (!child.isDirectory() || child.name === ".git" || child.name === "node_modules") continue;
          const childPath = path.join(directory, child.name);
          entry.directories.add(childPath);
          queue.push(childPath);
        }
      }
      setImmediate(next);
    });
  };
  next();
}

function watch(id, root) {
  unwatch(id);
  const entry = { root, watcher: null, pending: new Map(), timer: null, directories: new Set() };
  roots.set(id, entry);
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true, persistent: true });
  } catch (error) {
    roots.delete(id);
    send({ t: "error", id, code: (error && error.code) || "EWATCH" });
    return;
  }
  entry.watcher = watcher;
  watcher.on("change", (eventType, filename) => {
    if (roots.get(id) !== entry) return;
    if (filename == null) {
      // The platform could not name the path; the engine rescans this root.
      record(id, root, "rescan");
      return;
    }
    const relativePath = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
    if (IGNORED_SEGMENT.test(relativePath)) return;
    classify(id, path.join(root, relativePath), eventType);
  });
  watcher.on("error", (error) => {
    if (roots.get(id) !== entry) return;
    unwatch(id);
    send({ t: "error", id, code: (error && error.code) || "EWATCH" });
  });
  send({ t: "watching", id });
  learnDirectories(id, entry);
}

function unwatch(id) {
  const entry = roots.get(id);
  if (!entry) return;
  roots.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher?.close();
  } catch {
    /* already closed */
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("watch-host: ignored a malformed command\n");
      continue;
    }
    if (!message || !Number.isSafeInteger(message.id)) continue;
    if (message.t === "watch" && typeof message.root === "string" && path.isAbsolute(message.root)) {
      watch(message.id, message.root);
    } else if (message.t === "unwatch") {
      unwatch(message.id);
    }
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of [...roots.keys()]) unwatch(id);
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);

// Backstop for a parent that died without closing our stdin (for example when
// another descendant inherited the pipe). Unref'd: it never keeps us alive.
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    shutdown();
  }
  if (process.ppid !== parentPid) shutdown();
}, 10_000);
parentCheck.unref();

send({ t: "ready" });
