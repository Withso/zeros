// Linked worktrees need distinct ports, data, cache and native bundle IDs.
// Keep the primary checkout on its existing 5193 / 24293 ports and com.zeros.dev
// data directory so the ordinary dev loop does not migrate user state.
// electron:dev:prep must build the engine and main process before launch.

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
// Run-only worktrees reuse prepared builds, avoiding resident tsup watchers
// and source-triggered engine restarts.
const RUN_ONLY =
  process.env.ZEROS_RUN_ONLY === "1" || process.argv.includes("--run-only");
const REPO_ROOT = process.cwd();

// Read only the shared profile's public Alpha client fields; shell overrides
// remain explicit. Never admit WorkOS management credentials through it.
// Electron independently repeats validation at the browser boundary.
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
    `[dev-instance] ${devAuth.source === "workspace" ? "Workspace" : "Alpha"} WorkOS auth configuration validated (source=${devAuth.source})`,
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

/** Only linked worktrees get a new identity; the primary keeps its data and ports. */
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
  // Display names stay human-readable even when an explicit ZEROS_INSTANCE
  // is an opaque uniqueness key; detached HEAD falls back to the folder name.
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const fromBranch = branch && branch !== "HEAD" ? branch.split("/").pop() : "";
  const human = slugify(fromBranch || path.basename(REPO_ROOT)) || "ws";

  const explicit = (process.env.ZEROS_INSTANCE ?? "").trim();
  if (explicit) return { slug: slugify(explicit), human }; // caller owns uniqueness
  if (!isLinkedWorktree()) return { slug: "", human: "" }; // primary → no instance
  // Equal branch tails must not share userData or its single-instance lock.
  // Keep the realpath hash in the identity slug, out of the displayed name.
  const slug = slugify(`${human}-${shortPathHash(REPO_ROOT)}`).slice(0, 40);
  return { slug, human };
}

const { slug: SLUG, human: HUMAN } = resolveInstance();

const prunedProfiles = pruneStaleDevCaches({ currentSlug: SLUG });
if (prunedProfiles.length) {
  console.log(
    `[dev-instance] pruned regenerable Chromium data from ${prunedProfiles.length} stale dev instance profile(s)`,
  );
}
// Drop a leading zeros from the branch to avoid a doubled display prefix.
const NAME = SLUG
  ? ("zeros-" + HUMAN.replace(/^zeros[-_]?/, "")).replace(/-+$/, "")
  : "";

// Port probes must cover both loopback stacks and wildcard listeners; see dev-ports.mjs.

/** Spread concurrent instances across initial probe offsets before either binds. */
function hashSlug(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const portAttempt = Number(process.env.ZEROS_DEV_PORT_ATTEMPT ?? 0);
if (!Number.isSafeInteger(portAttempt) || portAttempt < 0 || portAttempt > 2) throw new Error("Invalid Dev port retry");
delete process.env.ZEROS_DEV_PORT_ATTEMPT;
async function pickVitePort() {
  if (!SLUG && !portAttempt) return VITE_BASE; // primary owns the pinned port
  let p = VITE_BASE + 1 + (hashSlug(portAttempt ? `${SLUG}:${portAttempt}` : SLUG) % 200);
  for (let i = 0; i < 800; i++, p++) {
    if (p > 65000) p = VITE_BASE + 1;
    if (await portFree(p)) return p;
  }
  return VITE_BASE + 1;
}

async function pickEngineBasePort() {
  if (!SLUG && !portAttempt) return ENGINE_BASE_DEV; // primary owns the default block
  const SLOTS = 256;
  const start = 1 + (hashSlug(portAttempt ? `${SLUG}:${portAttempt}` : SLUG) % SLOTS);
  for (let i = 0; i < SLOTS; i++) {
    const k = ((start - 1 + i) % SLOTS) + 1; // slot 0 is the primary's
    const base = ENGINE_BASE_DEV + k * ENGINE_STRIDE;
    if (base + ENGINE_STRIDE > 65000) continue;
    if (await portFree(base)) return base;
  }
  return ENGINE_BASE_DEV + ENGINE_STRIDE;
}


/** Bundle identity is cosmetic; environment still isolates data and ports
 * if preparation fails and launch falls back to shared Electron. */
function prepareBundle() {
  try {
    // Brand the shared base first: it is both the clone source and fallback.
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


const vitePort = await pickVitePort();
const engineBase = await pickEngineBasePort();
const binPath = prepareBundle();

// Keep instance-scoped variables in buildPtyEnv's drop list. Otherwise a
// nested dev launch inherits its parent's identity, ports and single-instance lock.
const env = {
  ...process.env,
  // Re-apply the normalized public values. Explicit shell overrides are already
  // represented in devAuth.env, so they keep precedence without reintroducing
  // whitespace or another unvalidated representation from process.env.
  ...devAuth.env,
  ZEROS_DEV: "1",
  // The shell PATH loaded by Electron may choose a different (or broken) Node.
  // Pin the runtime that successfully reached this launcher, for this app only.
  ZEROS_DEV_NODE_EXECUTABLE: process.execPath,
  ZEROS_VITE_PORT: String(vitePort),
  ELECTRON_RENDERER_URL: `http://localhost:${vitePort}`,
  ZEROS_ENGINE_BASE_PORT: String(engineBase),
};
if (SLUG) {
  env.ZEROS_INSTANCE = SLUG;
  env.ZEROS_INSTANCE_NAME = NAME; // "zeros-<worktree>" for the Dock/window name
}
// Run-only builds have no engine edits to reload; disable source-driven
// respawns unless explicitly overridden.
if (RUN_ONLY && env.ZEROS_NO_ENGINE_HMR == null) env.ZEROS_NO_ENGINE_HMR = "1";

// The main supervisor restarts the selected bundle after rebuild while
// respecting active turns. Run-only and ZEROS_NO_MAIN_HMR opt out.
const NO_MAIN_HMR = process.env.ZEROS_NO_MAIN_HMR === "1";
const useMainSupervisor =
  WATCH && !RUN_ONLY && !NO_MAIN_HMR;
const launchBin = binPath ? `"${binPath}"` : "electron";
const launchExpr = useMainSupervisor
  ? `node scripts/dev-main-supervisor.mjs "${binPath ?? require("electron")}"`
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
  { stdio: ["inherit", "pipe", "pipe"], env },
);

let portCollision = false, recentOutput = "";
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on("data", chunk => {
    target.write(chunk);
    recentOutput = (recentOutput + chunk.toString()).slice(-4096);
    if (/EADDRINUSE|Port [0-9]+ is already in use/.test(recentOutput)) {
      portCollision = true; child.kill("SIGTERM");
    }
  });
}
child.on("exit", (code) => process.exit(portCollision ? 98 : code ?? 0));
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
