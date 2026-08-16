// ──────────────────────────────────────────────────────────
// Named-instance Electron main hot-restart (`pnpm electron:dev:watch`)
// ──────────────────────────────────────────────────────────
//
// The gap this closes: the PRIMARY dev checkout launches Electron via
// `electronmon`, which watches dist-electron and restarts the main process when
// it's rebuilt. A NAMED worktree instance instead launches its
// own renamed bundle binary DIRECTLY (for a distinct Dock/Cmd-Tab identity — see
// scripts/dev-electron-bundle.cjs), so it forgoes electronmon. Result: the
// renderer hot-reloads (Vite) and the engine hot-reloads (source watcher), but
// the Electron MAIN process keeps the stale main.cjs it launched with. Edit
// anything under apps/desktop/electron/ — add an IPC command, change preload — and the
// renderer calls it while the stale main answers "unknown command" until you
// manually quit and re-run. (That exact trap produced the "Couldn't copy the app
// logs" failure: logs_recent was added to main, the renderer picked it up, the
// running main hadn't.)
//
// This supervisor gives a named instance the SAME hot-restart electronmon gives
// the primary, without losing the dedicated binary: launch <binPath> ., watch
// dist-electron/{main,preload}.cjs, and on a rebuild gracefully restart —
// SIGTERM, wait for the old process to FULLY exit (so the single-instance lock
// is released before the new one asks for it), escalate to SIGKILL only if it
// ignores SIGTERM, then relaunch. A restart can briefly orphan the engine child
// (it's a detached process-group leader killed only by main's before-quit), but
// the respawned main's reapOrphanEngines() SIGKILLs any engine left in its port
// range on boot — so the restart self-heals, exactly as the primary's
// electronmon path already relies on.
//
// Best-effort throughout: if the watcher can't be established the app still
// runs without main-process hot restart. The default `electron:dev` and its
// explicit `:watch` alias both route named instances through here so renderer
// HMR can never outrun main/preload IPC. `electron:run` remains the no-HMR path.
// Set ZEROS_NO_MAIN_HMR=1 to force a direct launch while diagnosing restarts.
// ──────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
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
const SIGTERM_GRACE_MS = 4000; // clean shutdown budget (before-quit + engine kill)
const SIGKILL_GRACE_MS = 1500;

// Mirror the shell's `env -u ELECTRON_RUN_AS_NODE` — the child must boot as the
// Electron app, not as a Node script.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let child = null;
let restarting = false;
let shuttingDown = false;
let restartTimer = null;

/** Launch the Electron binary. Its stdio is inherited so console output flows
 *  through concurrently exactly as the direct launch did. */
function launch() {
  child = spawn(binPath, ["."], { stdio: "inherit", env: childEnv });
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
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      resolve(exited);
    };
    proc.once("exit", () => done(true));
    setTimeout(() => done(false), ms);
  });
}

async function restart() {
  if (restarting || shuttingDown || !child) return;
  restarting = true;
  const dying = child;
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
      await waitForExit(dying, SIGKILL_GRACE_MS);
    }
  } catch (err) {
    console.error("[dev-main-supervisor] error during restart:", err);
  } finally {
    restarting = false;
  }
  if (!shuttingDown) launch();
}

function scheduleRestart() {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restart();
  }, RESTART_DEBOUNCE_MS);
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
    // Wait for the app to quit on the signal so we don't leave it orphaned;
    // force-exit as a backstop if it wedges.
    const force = setTimeout(() => process.exit(0), 2500);
    dying.once("exit", () => {
      clearTimeout(force);
      process.exit(0);
    });
    try {
      dying.kill("SIGTERM");
    } catch {
      process.exit(0);
    }
  });
}

console.log(
  `[dev-main-supervisor] main hot-restart ON (watching dist-electron/{main,preload}.cjs)`,
);
startWatch();
launch();
