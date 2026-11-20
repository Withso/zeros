#!/usr/bin/env node
// Bun 1.3.13 loaded node-pty but failed to deliver PTY I/O, so Node owns the PTYs. Stdout is reserved for the client's line-delimited JSON protocol; PTY data is base64 and diagnostics go to stderr.

"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

// Packaged builds point to the ABI-matching copy outside app.asar because native modules cannot load from inside it.
const ptyModulePath = process.env.ZEROS_PTY_NODE_PTY;
let pty;
try {
  pty = require(
    ptyModulePath && ptyModulePath.length > 0 ? ptyModulePath : "node-pty",
  );
} catch (err) {
  try {
    // Write synchronously before process.exit() so the client can latch the fatal startup error.
    fs.writeSync(
      1,
      JSON.stringify({
        t: "fatal",
        message: `node-pty load failed: ${err && err.message ? err.message : String(err)}`,
      }) + "\n",
    );
  } catch {
    /* parent stdout already gone */
  }
  process.exit(1);
}

const sessions = new Map();

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {
    /* stdout closed — the parent is gone; nothing we can do */
  }
}

/** Use ps -A rather than BSD -ax so process discovery works on both macOS and Linux. */
function readProcessTree() {
  let rows = "";
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const children = new Map();
  for (const line of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) || [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  return children;
}

/** Interactive jobs can have separate process groups; find them through parent links before killing the shell. */
function killDescendants(rootPid, tree) {
  if (
    process.platform === "win32" ||
    typeof rootPid !== "number" ||
    rootPid <= 0
  ) {
    return;
  }
  const children = tree || readProcessTree();
  if (!children) return;
  const descendants = [];
  const pending = [...(children.get(rootPid) || [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  // Kill children first so killing a wrapper cannot reparent its subprocess before we signal it.
  for (const pid of descendants.reverse()) {
    if (pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function killProc(p, tree) {
  killDescendants(p.pid, tree);
  try {
    p.kill();
  } catch {
    /* already dead */
  }
  try {
    if (process.platform !== "win32" && typeof p.pid === "number") {
      process.kill(-p.pid, "SIGKILL");
    }
  } catch {
    /* group already gone */
  }
}

function handleSpawn(m) {
  let proc;
  try {
    const args = Array.isArray(m.args) ? [...m.args] : [];
    if (m.immediateParentPidArgIndex !== undefined) {
      const index = m.immediateParentPidArgIndex;
      if (
        !Number.isSafeInteger(index) ||
        index <= 0 ||
        index >= args.length ||
        args[index - 1] !== "--parent-pid" ||
        typeof args[index] !== "string" ||
        !/^\d+$/.test(args[index])
      ) {
        throw new Error("invalid trusted-launcher parent pid binding");
      }
      args[index] = String(process.pid);
    }
    proc = pty.spawn(m.shell, args, {
      name: typeof m.name === "string" && m.name ? m.name : "xterm-256color",
      cwd: m.cwd,
      cols: typeof m.cols === "number" && m.cols > 0 ? m.cols : 80,
      rows: typeof m.rows === "number" && m.rows > 0 ? m.rows : 24,
      // Use the engine-owned environment as supplied; adding host variables would defeat the remote allowlist.
      env: m.env && typeof m.env === "object" ? m.env : process.env,
    });
  } catch (err) {
    send({
      t: "error",
      id: m.id,
      message: err && err.message ? err.message : String(err),
    });
    // Send a terminal exit after a failed spawn so the client does not wait for a process that never started.
    send({ t: "exit", id: m.id, exitCode: null, signal: null });
    return;
  }
  sessions.set(m.id, proc);
  send({ t: "spawned", id: m.id, pid: proc.pid });
  proc.onData((data) => {
    send({
      t: "data",
      id: m.id,
      data: Buffer.from(data, "utf8").toString("base64"),
    });
  });
  proc.onExit((e) => {
    sessions.delete(m.id);
    const exitCode = e && typeof e.exitCode === "number" ? e.exitCode : null;
    const signal = e && typeof e.signal === "number" ? e.signal : null;
    send({ t: "exit", id: m.id, exitCode, signal });
  });
}

function handle(m) {
  switch (m.t) {
    case "spawn":
      handleSpawn(m);
      return;
    case "write": {
      const p = sessions.get(m.id);
      if (p && typeof m.data === "string") {
        try {
          p.write(Buffer.from(m.data, "base64").toString("utf8"));
        } catch {
          /* pty already exited — drop */
        }
      }
      return;
    }
    case "resize": {
      const p = sessions.get(m.id);
      if (p && typeof m.cols === "number" && typeof m.rows === "number") {
        try {
          p.resize(m.cols, m.rows);
        } catch {
          /* pty already exited */
        }
      }
      return;
    }
    case "kill": {
      const p = sessions.get(m.id);
      if (p) {
        killProc(p);
        sessions.delete(m.id);
      }
      return;
    }
    default:
      return;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.length > 0) {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (msg && typeof msg.t === "string") handle(msg);
    }
    nl = buf.indexOf("\n");
  }
});

// Stdin closing also covers engine crashes; do not leave the host's shells behind.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Share one ps sweep so shutdown does not block once per terminal.
  const tree = sessions.size > 0 ? readProcessTree() : null;
  for (const p of sessions.values()) killProc(p, tree);
  sessions.clear();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);

send({ t: "ready" });
