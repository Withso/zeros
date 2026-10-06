#!/usr/bin/env node
// ============================================================
// Composer + GitHub settings UI smoke — real-browser interaction contract
//
// Boots the Vite dev server, opens the ModelPill harness page
// (the colocated harness-model-menu HTML/TSX entry pair — the real
// ModelPill/AgentModelMenu tree with the agent-chat "always focused
// composer" guardian wired in), then the real GitHub settings section, and
// drives both with headless Chromium.
//
// This exists because the 2026-07-24 "model dropdown flashes open and
// instantly closes" regression was invisible to every other gate: the
// vitest suite only covers pure helpers (no DOM), and the visual
// harness only screenshots static routes. The failure was an event-
// timing interaction (document-capture click listener + microtask vs
// Radix's open/focus sequence) that only a real browser reproduces.
//
// Contract asserted here:
//   1. Clicking the pill OPENS the menu, and it STAYS open (no
//      guardian-induced instant dismiss).
//   2. Clicking a model row selects it (onChange fires) and closes
//      the menu.
//   3. The menu can be re-opened after closing (no toggle desync).
//   4. No uncaught page errors anywhere in the run.
//   5. The GitHub method overflow obeys click/Escape focus semantics.
//   6. Its disconnect dialog itemizes consequences, initially focuses Cancel,
//      closes with Escape, and returns focus to the originating trigger.
//   7. A confirmed-empty GitHub App inventory exposes a recovery CTA whose IPC
//      request explicitly forces the installation URL.
//   8. Edit and turn-footer diff hover previews open, survive pointer travel,
//      support keyboard focus, and never attach themselves to Read rows.
//   9. File/diff reading surfaces wrap long lines, keep 450×350 hover geometry,
//      and never expose horizontal scrolling.
//  10. Design keeps its full-bleed canvas and floating chrome in the shared
//      workbench beside the existing agent conversation.
//  11. File Edit mode hangs soft-wrapped continuation rows at the line's own
//      indentation instead of dropping them to column 0.
//  12. The Files-tab tree keeps its indent guides visible without hover and
//      nests ~15.5px per level.
//  13. The Files tab's Search action opens a persistent base-surface sidebar
//      (not a floating popup), starts with an input-only state, filters on
//      demand, follows the shared sidebar width, survives result/outside clicks,
//      and closes via double Escape or its active toggle.
//  14. A file editor is ALREADY syntax-colored on its first painted frame, with
//      the code theme's own base foreground — the "opens white, then repaints"
//      flash. Only a real browser can prove this: the editor is mounted inside
//      flushSync (CodeMirror's creating layout effect runs before paint) and the
//      DOM is inspected in that same task, so no paint can have intervened.
//  15. Browser-tab A → B → A switching retains each iframe document in its
//      original DOM position, preserving form state, scroll, and JS heap without
//      another load.
//  16. The app sidebar groups workspaces by repository by default, offers only
//      Grouped/Ungrouped, persists per-repository collapse without hiding the
//      selection, and routes the repository actions (+, settings, ⋯). Its Go
//      back / Go forward retrace sidebar destinations, never Settings.
//
// Usage: pnpm test:ui-smoke [--shard=k/3]
//        pnpm test:ui-smoke --list [--shard=k/3] --format=json
// ============================================================

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { createSmokeIncidentLog } from "./ui-smoke-incidents.mjs";
import { parseSmokeArgs } from "./ui-smoke/cli.mjs";
import {
  selectScenarios,
  validateSmokePartition,
  SHARD_COUNT,
} from "./ui-smoke/scenarios.mjs";
import { runSmokeScenarios } from "./ui-smoke/runner.mjs";

let options;
try {
  options = parseSmokeArgs(process.argv.slice(2));
  validateSmokePartition();
} catch (err) {
  console.error(`ui-smoke-composer: ${err.message}`);
  process.exit(1);
}
if (options.list) {
  const ids = selectScenarios(options.shard).map(({ id }) => id);
  console.log(options.format === "json" ? JSON.stringify(ids) : ids.join("\n"));
  process.exit(0);
}
const { chromium } = await import("@playwright/test");
const runLabel =
  options.shard === undefined
    ? "ui-smoke-composer"
    : `ui-smoke-composer (shard ${options.shard}/${SHARD_COUNT})`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function freePort() {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolveFn(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite dev server did not answer at ${url}`);
}

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "ok" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// Out-of-scenario disturbances (dev-server reloads, renderer navigations,
// crashes, uncaught errors, runner stalls) are printed if the run fails.
const incidents = createSmokeIncidentLog();
const stopWatchingEventLoop = incidents.watchEventLoop();

const port = await freePort();
// detached → its own process GROUP, so teardown can kill pnpm AND the vite
// child it execs. Killing just the wrapper leaves vite alive holding our
// stdio pipes — node then never exits and the run hangs after "all checks
// passed" (observed here and it would hang the CI job the same way).
const vite = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "--mode",
    "ui-smoke",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // Keep API-backed browser contracts deterministic even without a local
    // .env. Each exercised endpoint is intercepted by its smoke test.
    env: {
      ...process.env,
      VITE_CONTROL_PLANE_URL: "https://api.example.test",
      VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES: "preview.example.test",
    },
    detached: true,
  },
);
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
// Vite reports dependency re-optimization and page reloads on stdout. Reading
// it also keeps an unread pipe from ever back-pressuring the dev server.
incidents.watchDevServerOutput(vite.stdout);

let browser = null;
try {
  const devServerOrigin = `http://127.0.0.1:${port}`;
  const harnessBase = `${devServerOrigin}/apps/desktop/src/renderer/harnesses`;
  const pageUrl = `${harnessBase}/harness-model-menu.html`;
  await waitForHttp(pageUrl);

  browser = await chromium.launch();
  const newPage = async (options) => {
    const created = await browser.newPage(options);
    await incidents.watchPage(created, { devServerOrigin });
    return created;
  };
  const pageErrors = [];
  await runSmokeScenarios({
    shard: options.shard,
    newPage,
    harnessBase,
    pageUrl,
    check,
    pageErrors,
  });
} catch (err) {
  failures.push("harness run crashed");
  console.error(err);
} finally {
  stopWatchingEventLoop();
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    vite.kill("SIGTERM");
  }
}

if (failures.length > 0) {
  incidents.report("ui-smoke incidents recorded during this run");
  console.error(
    `\n${runLabel}: ${failures.length} failure(s): ${failures.join(", ")}`,
  );
  process.exit(1);
}
console.log(`\n${runLabel}: all checks passed`);
// Explicit exit: a straggler child (or its pipes) must not keep a green run
// alive past its result — CI treats a hang as a timeout, not a pass.
process.exit(0);
