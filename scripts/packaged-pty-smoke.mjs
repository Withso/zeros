#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Packaged PTY smoke — exercise the exact .app terminal runtime
// ──────────────────────────────────────────────────────────
//
// Loading `node-pty` is not enough: beta.58 loaded its signed native addon but
// every pty.spawn failed with `posix_spawnp failed`. This probe runs the shipped
// Electron executable as Node, loads the runtime-safe node-pty resource through
// the shipped pty-host.cjs, spawns /bin/sh in a real PTY, and requires output +
// a clean exit. Run only on macOS after electron-builder has produced the .app.
// ──────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "ZEROS_PACKAGED_PTY_OK_7f9c";
const TIMEOUT_MS = 12_000;

function appCandidates(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        found.push(full);
      } else if (entry.isDirectory()) {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return found;
}

function resolveAppPath(input) {
  if (input) return path.resolve(input);
  const apps = appCandidates(path.resolve("release"));
  if (apps.length !== 1) {
    throw new Error(
      `expected exactly one packaged .app under release/ (found ${apps.length}); pass its path explicitly`,
    );
  }
  return apps[0];
}

function onlyFile(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
  if (files.length !== 1) {
    throw new Error(
      `expected one app executable in ${dir}, found ${files.length}`,
    );
  }
  return files[0];
}

async function smoke(appPath) {
  if (process.platform !== "darwin") {
    throw new Error("packaged PTY smoke must run on macOS");
  }
  if (!fs.statSync(appPath).isDirectory()) {
    throw new Error(`packaged app not found: ${appPath}`);
  }

  const resources = path.join(appPath, "Contents", "Resources");
  const executable = onlyFile(path.join(appPath, "Contents", "MacOS"));
  const hostScript = path.join(resources, "pty-host.cjs");
  const nodePtyEntry = path.join(
    resources,
    "node-pty",
    "lib",
    "index.js",
  );
  for (const required of [executable, hostScript, nodePtyEntry]) {
    if (!fs.existsSync(required))
      throw new Error(`missing packaged PTY file: ${required}`);
  }

  const child = spawn(executable, [hostScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ZEROS_PTY_NODE_PTY: nodePtyEntry,
    },
  });

  let stdout = "";
  let stderr = "";
  let protocolBuffer = "";
  let spawned = false;
  let cleanExit = false;
  let output = "";

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${TIMEOUT_MS}ms`));
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    const finish = (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    child.once("error", finish);
    child.stdin.once("error", finish);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      protocolBuffer += chunk;
      let newline = protocolBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = protocolBuffer.slice(0, newline);
        protocolBuffer = protocolBuffer.slice(newline + 1);
        newline = protocolBuffer.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.t === "error" || message.t === "fatal") {
          finish(
            new Error(
              `${message.t}: ${message.message || "unknown PTY error"}`,
            ),
          );
          child.kill("SIGKILL");
          return;
        }
        if (message.t === "spawned" && message.id === "smoke") spawned = true;
        if (message.t === "data" && message.id === "smoke") {
          output += Buffer.from(String(message.data || ""), "base64").toString(
            "utf8",
          );
        }
        if (message.t === "exit" && message.id === "smoke") {
          cleanExit = message.exitCode === 0;
          child.stdin.end();
        }
      }
    });
    child.once("exit", (code, signal) => {
      const ok = spawned && cleanExit && output.includes(MARKER);
      if (ok) finish();
      else {
        finish(
          new Error(
            `probe failed (host code=${code}, signal=${signal || "none"}, spawned=${spawned}, cleanExit=${cleanExit}, marker=${output.includes(MARKER)})\nstdout=${stdout.slice(-2000)}\nstderr=${stderr.slice(-2000)}`,
          ),
        );
      }
    });
  });

  child.stdin.write(
    `${JSON.stringify({
      t: "spawn",
      id: "smoke",
      shell: "/bin/sh",
      args: ["-c", `printf '${MARKER}\\n'`],
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: {
        HOME: os.homedir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
    })}\n`,
  );

  await completion;
}

try {
  const appPath = resolveAppPath(process.argv[2]);
  await smoke(appPath);
  console.log(
    `✓ packaged PTY spawned, streamed output, and exited cleanly: ${appPath}`,
  );
} catch (err) {
  console.error(
    `✖ packaged PTY smoke failed: ${err instanceof Error ? err.message : err}`,
  );
  process.exitCode = 1;
}
