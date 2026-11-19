// The `pnpm electron:alpha` app stack: the one hosted `alpha` development
// instance (scripts/alpha-instance.mjs), on the dev channel's pinned ports.
// scripts/dev-environment/launcher.mjs takes its single-instance lock and runs
// electron:dev:prep (engine and main builds) before this starts.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { ensureDevAuthEnvironment } from "./dev-auth-profile.mjs";
import { ALPHA_NAME, alphaInstanceEnvironment, prepareAlphaBundle } from "./alpha-instance.mjs";

const require = createRequire(import.meta.url);

const WATCH = process.argv.includes("--watch");
// Run-only reuses prepared builds, avoiding resident tsup watchers and
// source-triggered engine restarts.
const RUN_ONLY =
  process.env.ZEROS_RUN_ONLY === "1" || process.argv.includes("--run-only");

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

// The dev channel's pinned ports (apps/desktop/src/engine/runtime.ts); one
// alpha instance runs at a time, so it owns them.
const VITE_PORT = 5193;
const ENGINE_BASE = 24293;
const ENGINE_STRIDE = 10; // ENGINE_PORT_SPAN(8) + 2 gateway ports

const binPath = prepareAlphaBundle();

// Keep instance-scoped variables in buildPtyEnv's drop list. Otherwise a
// nested dev launch inherits its parent's identity, ports and single-instance lock.
const env = alphaInstanceEnvironment({
  ...process.env,
  // Re-apply the normalized public values. Explicit shell overrides are already
  // represented in devAuth.env, so they keep precedence without reintroducing
  // whitespace or another unvalidated representation from process.env.
  ...devAuth.env,
  ZEROS_DEV: "1",
  // The shell PATH loaded by Electron may choose a different (or broken) Node.
  // Pin the runtime that successfully reached this launcher, for this app only.
  ZEROS_DEV_NODE_EXECUTABLE: process.execPath,
  ZEROS_VITE_PORT: String(VITE_PORT),
  ELECTRON_RENDERER_URL: `http://localhost:${VITE_PORT}`,
  ZEROS_ENGINE_BASE_PORT: String(ENGINE_BASE),
});
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
  `wait-on -d 750 http://localhost:${VITE_PORT} ` +
  `dist-electron/main.cjs dist-electron/preload.cjs dist-engine/cli.js && ` +
  launchExpr;

console.log(
  `[dev-instance] ${ALPHA_NAME} · vite=${VITE_PORT} · ` +
    `engine=${ENGINE_BASE}-${ENGINE_BASE + ENGINE_STRIDE - 1} · ` +
    `bundle=${binPath ? "dedicated" : "stock Electron"} · mode=${RUN_ONLY ? "run-only" : "develop"}`,
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
