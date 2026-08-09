#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Zeros PTY host — a tiny Node subprocess that owns node-pty
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// The Zeros engine runs under **bun** (dev: `bun apps/desktop/src/cli.ts`; packaged: a
// bun-compiled standalone binary — see apps/desktop/electron/sidecar.ts). node-pty loads
// fine under bun (it's N-API), but its PTY I/O is BROKEN there: `pty.spawn`
// returns a pid and never throws, yet the shell emits zero bytes and ignores
// writes (reproduced on bun 1.3.13; works perfectly under Node). That made
// every terminal that rides the engine-owned PTY —
// open a dead, blank shell.
//
// The fix keeps the engine on bun (it needs bun:sqlite + the Claude Agent SDK)
// but moves the actual node-pty spawns into this Node subprocess. The engine
// drives it over stdio; node-pty runs under Node, where it works.
//
// PROTOCOL (newline-delimited JSON, one object per line)
//   engine → host (this process's stdin):
//     {"t":"spawn","id":"<id>","shell":"/bin/zsh","args":["-l"],"cwd":"…",
//      "cols":80,"rows":24,"env":{…},"name":"xterm-256color"}
//     {"t":"write","id":"<id>","data":"<base64>"}
//     {"t":"resize","id":"<id>","cols":100,"rows":40}
//     {"t":"kill","id":"<id>"}
//   host → engine (this process's stdout):
//     {"t":"ready"}                                   (once, on startup)
//     {"t":"spawned","id":"<id>","pid":12345}
//     {"t":"data","id":"<id>","data":"<base64>"}
//     {"t":"exit","id":"<id>","exitCode":0,"signal":null}
//     {"t":"error","id":"<id>","message":"…"}         (spawn failed)
//     {"t":"fatal","message":"…"}                     (node-pty unloadable)
//
// PTY data/keystrokes are base64-encoded so a line never contains a raw
// newline; every other field is JSON-escaped. node-pty's onData yields whole
// UTF-8 strings (it uses an internal StringDecoder, so multibyte chars are
// never split across chunks), so base64(utf8)→decode round-trips exactly.
//
// stdout is RESERVED for the protocol — this process must never console.log.
// Diagnostics go to stderr, which the engine forwards to its log.
// ──────────────────────────────────────────────────────────

"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

// node-pty location: the engine passes an absolute path (ZEROS_PTY_NODE_PTY)
// resolved to the ABI-matching copy — in a packaged app that's the
// app.asar.unpacked copy (a .node can't be dlopen'd from inside asar). When
// unset (engine run from source with no Electron host) fall back to ordinary
// module resolution, which walks up to the repo node_modules.
const ptyModulePath = process.env.ZEROS_PTY_NODE_PTY;
let pty;
try {
  pty = require(
    ptyModulePath && ptyModulePath.length > 0 ? ptyModulePath : "node-pty",
  );
} catch (err) {
  try {
    // `process.exit()` does not wait for asynchronous stdout writes. This fatal
    // record determines whether the parent blocks a useless key-restart loop,
    // so put the small protocol line into the pipe synchronously before exit.
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

/** id → IPty */
const sessions = new Map();

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {
    /* stdout closed — the parent is gone; nothing we can do */
  }
}

/** SIGKILL every process still descended from the PTY shell. Interactive job
 *  control gives background jobs their OWN process groups, so killing only the
 *  shell's group misses `cmd &`, `nohup`, and `disown`. Walk parent links BEFORE
 *  killing the shell, while those jobs still have an attributable owner.
 *  Best-effort POSIX fallback; Windows retains node-pty's own teardown. */
function killDescendants(rootPid) {
  if (
    process.platform === "win32" ||
    typeof rootPid !== "number" ||
    rootPid <= 0
  ) {
    return;
  }
  let rows = "";
  try {
    rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return;
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
  const descendants = [];
  const pending = [...(children.get(rootPid) || [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  // Children first so a wrapper cannot reparent its own subprocess between
  // our signals and escape attribution.
  for (const pid of descendants.reverse()) {
    if (pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Terminate one PTY COMPLETELY. `p.kill()` SIGHUPs the shell — that fells the
 *  foreground child. The process-group kill covers non-interactive commands;
 *  the descendant sweep above also covers interactive background job groups.
 *  Both are best-effort. Used by BOTH the interactive `kill`
 *  message (the × button) AND shutdown, so a user-closed terminal is torn down
 *  exactly as thoroughly as app-quit — they must never drift apart. */
function killProc(p) {
  killDescendants(p.pid);
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
    proc = pty.spawn(m.shell, Array.isArray(m.args) ? m.args : [], {
      name: typeof m.name === "string" && m.name ? m.name : "xterm-256color",
      cwd: m.cwd,
      cols: typeof m.cols === "number" && m.cols > 0 ? m.cols : 80,
      rows: typeof m.rows === "number" && m.rows > 0 ? m.rows : 24,
      // The engine computes the full resolved env (Zeros ZDOTDIR, scrubbed
      // allowlist for remote clients, per-worktree PWD); use it verbatim.
      env: m.env && typeof m.env === "object" ? m.env : process.env,
    });
  } catch (err) {
    send({
      t: "error",
      id: m.id,
      message: err && err.message ? err.message : String(err),
    });
    // Surface as an immediate exit so the client can classify this as a spawn
    // infrastructure failure instead of leaving the terminal hanging.
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

// The parent (engine) closing our stdin — a clean shutdown OR a crash — means
// we must tear down every shell and exit so we never linger as an orphan PTY
// host holding shells (and their child processes) open.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Same complete teardown as the interactive × (killProc): SIGHUP the shell +
  // SIGKILL its process group, so no shell or backgrounded child lingers when
  // the engine goes away.
  for (const p of sessions.values()) killProc(p);
  sessions.clear();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);

send({ t: "ready" });
