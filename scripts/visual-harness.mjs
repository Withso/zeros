#!/usr/bin/env node
// ============================================================
// Zeros Visual Harness
//
// Boots the Vite dev server, drives a headless Chromium to a
// set of known routes/states, and writes PNG screenshots to
// /snapshots/. Use alongside Cursor 3 reference images to do
// a side-by-side visual QA.
//
// Usage:
//   node scripts/visual-harness.mjs
//   node scripts/visual-harness.mjs --update   # overwrite baselines
//
// Output:
//   snapshots/current/<name>.png   fresh captures
//   snapshots/baseline/<name>.png  committed baselines (manual)
//   snapshots/diff/<name>.png      (future) pixel diffs
// ============================================================

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// `--update` promotes the captures to the committed baselines
// (snapshots/baseline/); the default run writes fresh captures
// (snapshots/current/, gitignored) for side-by-side comparison.
const UPDATE = process.argv.includes("--update");
const OUT_DIR = resolve(ROOT, UPDATE ? "snapshots/baseline" : "snapshots/current");

// Viewport sized to match a Cursor 3 Agents window docked
// to the right third of a 16" MBP. Adjust as needed.
const VIEWPORT = { width: 1280, height: 800 };

// Routes / app states we want to capture. Each entry is a named
// screenshot with an optional `prepare` callback that can drive
// the page into the desired UI state before the capture.
const SCENARIOS = [
  {
    name: "01-home-empty",
    url: "/",
    prepare: async () => {},
  },
  {
    name: "02-home-demo-route",
    url: "/?demo=1",
    prepare: async () => {},
  },
  {
    name: "03-login-email",
    url: "/",
    // The account login screen — AuthGate renders it whenever there's no
    // session, which this headless harness never has. Clear any seeded
    // session/offer and reload so the baseline is deterministically the
    // logged-out email view, independent of scenario order.
    prepare: async (page) => {
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {}
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(350);
    },
  },
];

async function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  const hosts = ["127.0.0.1", "::1", "localhost"];
  while (Date.now() - start < timeoutMs) {
    for (const host of hosts) {
      const ok = await new Promise((resolvePort) => {
        const s = net.connect({ port, host });
        const onDone = (v) => {
          s.removeAllListeners();
          try { s.end(); } catch {}
          try { s.destroy(); } catch {}
          resolvePort(v);
        };
        s.once("connect", () => onDone(true));
        s.once("error", () => onDone(false));
      });
      if (ok) return host;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Port ${port} not ready within ${timeoutMs}ms`);
}

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[harness] writing ${UPDATE ? "BASELINES" : "current captures"} → ${OUT_DIR}`,
  );

  // Boot the dev server on a dedicated port so we don't clash
  // with an editor-running instance.
  const PORT = 5199;
  console.log(`[harness] launching Vite on :${PORT} ...`);
  const vite = spawn("pnpm", ["dev", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let shuttingDown = false;
  const kill = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      vite.kill("SIGTERM");
    } catch {}
  };
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(143);
  });

  // Surface Vite errors but keep stdout quiet.
  vite.stderr.on("data", (b) => process.stderr.write(`[vite] ${b}`));

  try {
    const host = await waitForPort(PORT);
    console.log(`[harness] Vite up on ${host}:${PORT}. Launching Chromium ...`);

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });

    for (const scenario of SCENARIOS) {
      const page = await context.newPage();
      const hostForUrl = host === "::1" ? "[::1]" : host;
      const url = `http://${hostForUrl}:${PORT}${scenario.url}`;
      console.log(`[harness] → ${scenario.name} (${url})`);
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      // Let fonts / CSS variables settle.
      await page.waitForTimeout(350);
      await scenario.prepare(page);
      const out = resolve(OUT_DIR, `${scenario.name}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`[harness]   saved ${out}`);

      if (errors.length) {
        console.warn(`[harness]   ⚠ ${errors.length} console/page errors:`);
        for (const e of errors.slice(0, 5)) console.warn(`           ${e}`);
      }
      await page.close();
    }

    await browser.close();
    console.log("[harness] done.");
  } finally {
    kill();
  }
}

run().catch((err) => {
  console.error("[harness] failed:", err);
  process.exitCode = 1;
});
