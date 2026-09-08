// ──────────────────────────────────────────────────────────
// Per-worktree dev instance launcher (`pnpm electron:dev`)
// ──────────────────────────────────────────────────────────
//
// One name derives everything. From a single instance slug (an explicit
// $ZEROS_INSTANCE, else the git branch/worktree name) this picks free ports and
// exports the env that makes a `pnpm electron:dev` in each linked git worktree its
// OWN app — distinct Vite port, engine port block, data dir (com.zeros.dev.<slug>),
// Chromium cache, userData/single-instance lock, and (on macOS) a distinct
// Dock/Cmd-Tab bundle. Several worktree instances then run at once, alongside the
// Beta and Production apps, none sharing data.
//
// The PRIMARY checkout (git main worktree, or `.git` is a directory) stays the
// plain "Zeros Dev" app on the pinned 5193 / 24293 with the com.zeros.dev data
// dir — no surprise data migration for the everyday dev loop. Only LINKED
// worktrees (`git worktree add`, or whatever agent runner creates them for you)
// become named instances.
//
// Assumes `pnpm electron:dev:prep` already built dist-electron / dist-engine
// (the package scripts chain it before this launcher). Then it runs the same
// concurrently block the repo has always used (vite / engine tsup / main tsup /
// wait-on + electron), just parameterized by the derived ports + env.
// ──────────────────────────────────────────────────────────

import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDevAuthEnvironment } from "./dev-auth-profile.mjs";
import { portFree } from "./dev-ports.mjs";
import { pruneStaleDevCaches } from "./dev-cache-prune.mjs";

const require = createRequire(import.meta.url);
const bundle = require("./dev-electron-bundle.cjs");

const WATCH = process.argv.includes("--watch");
// Run-only mode: for a worktree you're just RUNNING (not editing the main/engine
// TypeScript of), skip the two `tsup --watch` esbuild services and disable engine
// HMR. electron:dev:prep already one-shot-built dist-engine + dist-electron, so
// [vite, app] alone boots a runnable app — saving ~80-150MB of resident esbuild
// per instance and removing the FSEvents-driven engine respawn trigger. This is
// the heaviest lever for the "N parallel worktrees each ~550MB" baseline: point
// each worktree's run command at `pnpm electron:run` (which sets ZEROS_RUN_ONLY=1)
// for worktrees you only run, and keep `pnpm electron:dev` for the one you're
// editing.
const RUN_ONLY =
  process.env.ZEROS_RUN_ONLY === "1" || process.argv.includes("--run-only");
// pnpm runs package scripts from the repo root, so cwd is the worktree root.
const REPO_ROOT = process.cwd();

// Every worktree inherits one user-level PUBLIC Alpha profile. Explicit shell
// variables remain available for a deliberate one-run override, but a
// checkout-local env file cannot drift behind the shared profile after a client
// rotation. Only the seven public-client fields are read; WorkOS management
// credentials cannot enter through the profile. Electron main independently
// repeats the exact Alpha-only validation at the browser boundary.
const devAuth = await ensureDevAuthEnvironment();
if (devAuth.source !== "none" && devAuth.issue) {
  throw new Error(
    `Unsafe Zeros Dev auth configuration (${devAuth.issue}). ` +
      `Use the complete Alpha public-client profile at ${devAuth.sharedProfilePath}.`,
  );
}
if (devAuth.source === "none") {
  console.warn(
    `[dev-instance] Alpha WorkOS profile is missing at ${devAuth.sharedProfilePath}; sign-in will remain disabled`,
  );
} else {
  console.log(
    `[dev-instance] Alpha WorkOS auth configuration validated (source=${devAuth.source})`,
  );
}
if (devAuth.cachedOffline) {
  console.warn(
    "[dev-instance] Alpha configuration service unavailable; using the last validated public profile",
  );
}

// Engine port grid — must match apps/desktop/src/engine/runtime.ts. Instance blocks are laid
// on a stride wider than the walk span so the walk range AND the MCP gateway
// ports (base+8 / base+9) of adjacent instances never overlap.
const ENGINE_BASE_DEV = 24293;
const ENGINE_STRIDE = 10; // ENGINE_PORT_SPAN(8) + 2 gateway ports
const VITE_BASE = 5193;

// ── 1. Resolve the instance slug + human label ─────────────

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
}

/** A LINKED git worktree has a `.git` FILE ("gitdir: …"); the main
 *  worktree has a `.git` DIRECTORY. Only linked worktrees become named instances,
 *  so the primary checkout keeps the default identity/ports/data dir. */
function isLinkedWorktree() {
  try {
    return fs.statSync(path.join(REPO_ROOT, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Short hash of the worktree's real path — the uniqueness tiebreaker for slugs. */
function shortPathHash(p) {
  let real = p;
  try {
    real = fs.realpathSync(p);
  } catch {
    /* path may not resolve — hash the literal */
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 4);
}

function resolveInstance() {
  // The human display name ALWAYS comes from the worktree branch/folder, so the
  // Dock shows "zeros-<worktree>" even when the caller passes an opaque
  // ZEROS_INSTANCE (e.g. a worktree runner's per-workspace UUID) purely for data
  // uniqueness. Branch `feat/san-francisco` → `san-francisco`; fall back to
  // the worktree folder basename for detached HEAD or a branch with no scope.
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const fromBranch = branch && branch !== "HEAD" ? branch.split("/").pop() : "";
  const human = slugify(fromBranch || path.basename(REPO_ROOT)) || "ws";

  const explicit = (process.env.ZEROS_INSTANCE ?? "").trim();
  if (explicit) return { slug: slugify(explicit), human }; // caller owns uniqueness
  if (!isLinkedWorktree()) return { slug: "", human: "" }; // primary → no instance
  // Append a short realpath hash to the SLUG (identity only — never shown) so two
  // worktrees whose branch tails (or basenames) COLLIDE never resolve to the same
  // userData — otherwise the second to launch loses the single-instance lock
  // (keyed off userData, see apps/desktop/electron/deep-link.ts) and silently quits. The human
  // name stays clean ("san-francisco") for the "zeros-<worktree>" Dock name.
  const slug = slugify(`${human}-${shortPathHash(REPO_ROOT)}`).slice(0, 40);
  return { slug, human };
}

const { slug: SLUG, human: HUMAN } = resolveInstance();

// Reclaim caches left behind by dead worktrees (each ~200-300MB, previously
// leaked forever — far enough gone on 2026-08-06 to ENOSPC the installed
// alpha's auto-update staging). See scripts/dev-cache-prune.mjs.
const prunedProfiles = pruneStaleDevCaches({ currentSlug: SLUG });
if (prunedProfiles.length) {
  console.log(
    `[dev-instance] pruned regenerable Chromium data from ${prunedProfiles.length} stale dev instance profile(s)`,
  );
}
// The Dock/window name: "zeros-<worktree>" for a linked worktree; the primary
// checkout stays the plain "Zeros Dev" bundle (NAME empty → no rename). A leading
// "zeros" in the branch is dropped so a branch literally named "zeros-*" doesn't
// double up into "zeros-zeros-*".
const NAME = SLUG
  ? ("zeros-" + HUMAN.replace(/^zeros[-_]?/, "")).replace(/-+$/, "")
  : "";

// ── 2. Free-port selection ─────────────────────────────────

// portFree() lives in ./dev-ports.mjs so it can be unit-tested against a real
// listener (this file spawns the dev stack at import time). It probes both
// loopback stacks AND the wildcard — read the comment there for the two ways a
// narrower probe hands Vite a port that is already taken.

/** Deterministic non-negative hash so distinct instances start probing from
 *  different offsets — two worktrees launched at once rarely land on the same
 *  slot even before either binds. */
function hashSlug(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function pickVitePort() {
  if (!SLUG) return VITE_BASE; // primary owns the pinned port
  let p = VITE_BASE + 1 + (hashSlug(SLUG) % 200);
  for (let i = 0; i < 800; i++, p++) {
    if (p > 65000) p = VITE_BASE + 1;
    if (await portFree(p)) return p;
  }
  return VITE_BASE + 1;
}

async function pickEngineBasePort() {
  if (!SLUG) return ENGINE_BASE_DEV; // primary owns the default block
  const SLOTS = 256;
  const start = 1 + (hashSlug(SLUG) % SLOTS);
  for (let i = 0; i < SLOTS; i++) {
    const k = ((start - 1 + i) % SLOTS) + 1; // slot 0 is the primary's
    const base = ENGINE_BASE_DEV + k * ENGINE_STRIDE;
    if (base + ENGINE_STRIDE > 65000) continue;
    if (await portFree(base)) return base;
  }
  return ENGINE_BASE_DEV + ENGINE_STRIDE;
}

// ── 3. macOS Dock/Cmd-Tab bundle identity ──────────────────

/** Returns the absolute Electron binary to launch, or null to use `electron`
 *  (the shared node_modules bundle). Never throws — bundle identity is cosmetic;
 *  data/port isolation comes from the env below regardless. */
function prepareBundle() {
  try {
    // Always brand the shared base bundle first: it's what a named instance is
    // cloned from, AND the fallback the launcher uses if the clone fails — so the
    // Dock never shows the stock "Electron".
    bundle.prepareSharedDevBundle();
    if (SLUG) {
      const r = bundle.prepareInstanceBundle({ slug: SLUG, name: NAME });
      if (r.ok && r.binPath) return r.binPath;
      // fall through to the shared "Zeros Dev" bundle on any failure
    }
  } catch (err) {
    console.warn(
      `[dev-instance] bundle prep failed: ${err && err.message ? err.message : err}`,
    );
  }
  return null;
}

// ── 4. Assemble env + run the concurrently block ───────────

const vitePort = await pickVitePort();
const engineBase = await pickEngineBasePort();
const binPath = prepareBundle();

// Every var below describes THIS app instance, not the worktree it was launched
// from — so none of it may be inherited by shells the app itself spawns.
// buildPtyEnv (apps/desktop/src/engine/pty/shell-setup.ts) deletes them by name for exactly
// that reason: a terminal inside the app inherits the full env, and a nested
// `pnpm electron:dev` that finds ZEROS_INSTANCE set takes the "caller owns
// uniqueness" branch of resolveInstance() below and adopts the PARENT's identity
// (ports, data dir, single-instance lock) wholesale. ADD ANY NEW INSTANCE-SCOPED
// VAR TO THAT DROP LIST TOO.
const env = {
  ...process.env,
  // Re-apply the normalized public values. Explicit shell overrides are already
  // represented in devAuth.env, so they keep precedence without reintroducing
  // whitespace or another unvalidated representation from process.env.
  ...devAuth.env,
  ZEROS_DEV: "1",
  ZEROS_VITE_PORT: String(vitePort),
  ELECTRON_RENDERER_URL: `http://localhost:${vitePort}`,
  ZEROS_ENGINE_BASE_PORT: String(engineBase),
};
if (SLUG) {
  env.ZEROS_INSTANCE = SLUG;
  env.ZEROS_INSTANCE_NAME = NAME; // "zeros-<worktree>" for the Dock/window name
}
// Run-only instances don't rebuild the engine, so there's nothing for the engine
// source watcher to react to — turn its respawn path off outright (still
// overridable) so it can never storm on FSEvents/remote-sync churn.
if (RUN_ONLY && env.ZEROS_NO_ENGINE_HMR == null) env.ZEROS_NO_ENGINE_HMR = "1";

// A named instance launches its own bundle binary (for a distinct Dock/Cmd-Tab
// identity — dev-electron-bundle.cjs), so it can't hand off to electronmon the
// way the primary does. That's the historical reason editing apps/desktop/electron/** left a
// worktree instance with a STALE main ("unknown command" until you re-run) while
// renderer HMR + engine HMR kept working. Under --watch we now wrap that binary
// in scripts/dev-main-supervisor.mjs, which watches dist-electron and restarts
// the main process on rebuild — electronmon's behavior, minus electronmon, so
// the dedicated binary survives. Both `pnpm electron:dev` and the explicit
// `electron:dev:watch` alias use this path; `electron:run` remains the
// low-overhead no-HMR launch. ZEROS_NO_MAIN_HMR=1 forces a direct launch when
// diagnosing restart behavior (mirrors ZEROS_NO_ENGINE_HMR). The primary
// (no binPath) uses electronmon under --watch.
const NO_MAIN_HMR = process.env.ZEROS_NO_MAIN_HMR === "1";
const useMainSupervisor =
  Boolean(binPath) && WATCH && !RUN_ONLY && !NO_MAIN_HMR;
const launchBin = binPath ? `"${binPath}"` : WATCH ? "electronmon" : "electron";
const launchExpr = useMainSupervisor
  ? `node scripts/dev-main-supervisor.mjs "${binPath}"`
  : `env -u ELECTRON_RUN_AS_NODE ${launchBin} .`;
const appCmd =
  `wait-on -d 750 http://localhost:${vitePort} ` +
  `dist-electron/main.cjs dist-electron/preload.cjs dist-engine/cli.js && ` +
  launchExpr;

console.log(
  `[dev-instance] ${SLUG ? `instance "${NAME}" (${SLUG})` : "primary dev (Zeros Dev)"} · ` +
    `vite=${vitePort} · engine=${engineBase}-${engineBase + ENGINE_STRIDE - 1} · ` +
    `bundle=${binPath ? "dedicated" : "shared"} · mode=${RUN_ONLY ? "run-only" : "develop"}`,
);

// In develop mode we run four jobs (vite + engine tsup watch + main tsup watch +
// app); run-only mode drops the two tsup watchers — the two resident esbuild
// services and the FSEvents respawn trigger are exactly the per-instance overhead
// you don't want on a worktree you're only running.
const jobs = RUN_ONLY
  ? [
      ["vite", "cyan", "pnpm dev"],
      ["app", "green", appCmd],
    ]
  : [
      ["vite", "cyan", "pnpm dev"],
      ["engine", "yellow", "tsup --watch"],
      [
        "main",
        "magenta",
        "tsup --config apps/desktop/electron/tsup.config.ts --watch",
      ],
      ["app", "green", appCmd],
    ];

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "-k",
    "-n",
    jobs.map((j) => j[0]).join(","),
    "-c",
    jobs.map((j) => j[1]).join(","),
    ...jobs.map((j) => j[2]),
  ],
  { stdio: "inherit", env },
);

child.on("exit", (code) => process.exit(code ?? 0));
// Forward Ctrl-C so concurrently's -k tears the whole block down cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}
