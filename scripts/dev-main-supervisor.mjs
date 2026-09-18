// Development Electron main hot restart for primary and named instances.
//
// Watch dist-electron/{main,preload}.cjs while preserving a named instance's
// dedicated bundle identity. Once both outputs are ready and changed, ask the
// running main over private child IPC whether its engine is idle. Busy or
// unknown replies defer the restart without a duration limit on a healthy turn.
// SIGTERM enters normal Electron quit cleanup; bounded escalation waits for the
// old process to exit before launching its replacement.
//
// Both electron:dev and electron:dev:watch use this supervisor. electron:run
// builds once without backend reloaders. ZEROS_NO_MAIN_HMR=1 disables this
// watcher independently of engine HMR. Restart the development command once
// after changing the launcher or supervisor itself.
// See docs/development-restarts.md for lifecycle and recovery behavior.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const binPath = process.argv[2];
if (!binPath) {
  console.error("[dev-main-supervisor] missing electron binary path (argv[2])");
  process.exit(1);
}

const REPO_ROOT = process.cwd();
const DIST_DIR = path.join(REPO_ROOT, "dist-electron");
// The two tsup outputs whose staleness causes "unknown command" / "command not
// permitted". Sourcemaps (.cjs.map) are deliberately ignored — they don't change
// runtime behavior and would just add restart churn.
const TRIGGER_FILES = new Set(["main.cjs", "preload.cjs"]);
const RESTART_DEBOUNCE_MS = 300; // coalesce the burst of writes for one rebuild
const SIGTERM_GRACE_MS = 15_000; // includes before-quit + engine shutdown
const SIGKILL_GRACE_MS = 1500;
const RESTART_CHECK_MS = 2000;
const BUSY_POLL_MS = 1500;

// Mirror the shell's `env -u ELECTRON_RUN_AS_NODE` — the child must boot as the
// Electron app, not as a Node script.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let child = null;
let restarting = false;
let checking = false;
let shuttingDown = false;
let restartTimer = null;
let requestId = 0;
let deferredReason = null;
let launchedBuild = null;

function readyBuild() {
  try {
    const hash = createHash("sha256");
    for (const name of TRIGGER_FILES) {
      const file = path.join(DIST_DIR, name);
      if (!fs.statSync(file).isFile()) return null;
      const contents = fs.readFileSync(file);
      if (contents.length === 0) return null;
      hash.update(name).update(contents);
    }
    return hash.digest("hex");
  } catch {
    // tsup can remove outputs during a clean build. Keep the working app until
    // both replacements are present; a deletion is not a runnable build.
    return null;
  }
}

/** Launch the Electron binary. Its stdio is inherited so console output flows
 *  through concurrently exactly as the direct launch did. */
function launch() {
  launchedBuild = readyBuild();
  child = spawn(binPath, ["."], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: childEnv,
  });
  const launched = child;
  launched.on("exit", (code) => {
    // Ignore exits we caused (a restart) or a supervisor teardown.
    if (shuttingDown || restarting || launched !== child) return;
    // The app quit on its own (Cmd+Q, crash, window-all-closed). Mirror a
    // direct launch: propagate the code so concurrently -k tears the dev block
    // down instead of leaving a headless supervisor behind.
    process.exit(code ?? 0);
  });
  launched.on("error", (err) => {
    console.error("[dev-main-supervisor] failed to spawn electron:", err);
    if (!shuttingDown) process.exit(1);
  });
}

/** Resolve once `proc` emits "exit", or after `ms` (→ false = still alive). */
function waitForExit(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    proc.once("exit", onExit);
  });
}

/** Read readiness from this child only. Silence, malformed replies and channel
 * failure are unknown, never permission to terminate a possibly active turn. */
function restartStatus(proc) {
  const id = ++requestId;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("message", onMessage);
      proc.off("exit", onExit);
      resolve(status);
    };
    const onMessage = (message) => {
      if (
        message?.type !== "zeros:dev-main-restart-status" ||
        message.requestId !== id ||
        typeof message.busy !== "boolean"
      )
        return;
      finish(message.busy ? "busy" : "idle");
    };
    const onExit = () => finish("unknown");
    const timer = setTimeout(() => finish("unknown"), RESTART_CHECK_MS);
    proc.on("message", onMessage);
    proc.once("exit", onExit);
    try {
      proc.send(
        { type: "zeros:dev-main-restart-check", requestId: id },
        (error) => {
          if (error) finish("unknown");
        },
      );
    } catch {
      finish("unknown");
    }
  });
}

async function restart() {
  if (shuttingDown || !child) return;
  if (checking || restarting) {
    scheduleRestart(BUSY_POLL_MS);
    return;
  }
  const build = readyBuild();
  if (!build) {
    scheduleRestart(BUSY_POLL_MS);
    return;
  }
  if (build === launchedBuild) return;
  const dying = child;
  checking = true;
  const status = await restartStatus(dying);
  checking = false;
  if (
    shuttingDown ||
    dying !== child ||
    dying.exitCode !== null ||
    dying.signalCode !== null
  )
    return;
  if (readyBuild() !== build) {
    scheduleRestart();
    return;
  }
  if (status !== "idle") {
    if (deferredReason !== status) {
      console.log(
        status === "busy"
          ? "[dev-main-supervisor] rebuild ready — waiting for the active agent turn to finish"
          : "[dev-main-supervisor] restart readiness unavailable — keeping the running app; restart manually if needed",
      );
      deferredReason = status;
    }
    scheduleRestart(BUSY_POLL_MS);
    return;
  }
  deferredReason = null;
  restarting = true;
  console.log(
    "\n[dev-main-supervisor] dist-electron changed → restarting main process…",
  );
  try {
    dying.kill("SIGTERM");
    // Wait for a clean exit (before-quit runs shutdownSidecar → kills the engine
    // tree) so ports + the single-instance lock are released before relaunch.
    const exited = await waitForExit(dying, SIGTERM_GRACE_MS);
    if (!exited) {
      console.log(
        "[dev-main-supervisor] main ignored SIGTERM after " +
          `${SIGTERM_GRACE_MS}ms → SIGKILL`,
      );
      try {
        dying.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (!(await waitForExit(dying, SIGKILL_GRACE_MS))) {
        console.error(
          "[dev-main-supervisor] old main has not exited; deferring replacement",
        );
        scheduleRestart(BUSY_POLL_MS);
        return;
      }
    }
  } catch (err) {
    console.error("[dev-main-supervisor] error during restart:", err);
    scheduleRestart(BUSY_POLL_MS);
    return;
  } finally {
    // Keep exit ownership while a concurrent rebuild replaces its outputs.
    while (!shuttingDown && !readyBuild()) {
      await new Promise((resolve) => setTimeout(resolve, RESTART_DEBOUNCE_MS));
    }
    restarting = false;
  }
  if (!shuttingDown) launch();
}

function scheduleRestart(delay = RESTART_DEBOUNCE_MS) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, delay);
}

/** Watch dist-electron for main/preload rebuilds. Non-fatal: on failure the app
 *  still runs, just without auto-restart. Re-arms once if the watcher drops
 *  (tsup can momentarily replace files). */
function startWatch(reArm = true) {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(
      `[dev-main-supervisor] ${DIST_DIR} missing — auto-restart disabled`,
    );
    return;
  }
  try {
    const watcher = fs.watch(DIST_DIR, (_event, filename) => {
      if (filename && TRIGGER_FILES.has(String(filename))) scheduleRestart();
    });
    watcher.on("error", (err) => {
      console.error(
        "[dev-main-supervisor] watcher error:",
        err?.message ?? err,
      );
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      if (reArm && !shuttingDown) setTimeout(() => startWatch(false), 500);
    });
  } catch (err) {
    console.error(
      "[dev-main-supervisor] could not watch dist-electron (auto-restart off):",
      err?.message ?? err,
    );
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    const dying = child;
    if (!dying || dying.exitCode !== null || dying.signalCode !== null) {
      process.exit(0);
    }
    // The parent's lifetime must cover normal Electron/engine cleanup too.
    // Exiting after 2.5 s used to orphan a still-shutting-down app.
    void (async () => {
      try {
        dying.kill("SIGTERM");
        if (!(await waitForExit(dying, SIGTERM_GRACE_MS))) {
          dying.kill("SIGKILL");
          await waitForExit(dying, SIGKILL_GRACE_MS);
        }
      } finally {
        process.exit(0);
      }
    })();
  });
}

console.log(
  `[dev-main-supervisor] main hot-restart ON (watching dist-electron/{main,preload}.cjs)`,
);
startWatch();
launch();
