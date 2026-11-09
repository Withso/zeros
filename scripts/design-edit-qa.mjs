#!/usr/bin/env node
// QA only: Design editing in the production app on macOS, driven by command
// files. It launches the production renderer and compiled engine in an isolated
// account-free profile, opens a disposable Design project, then runs each
// `<n>.mjs` dropped into the inbox (default export: async (ctx) => result) and
// writes `<n>.json` (plus any screenshots) to the outbox. Input is CDP-dispatched
// into the page; the window floats, ignores OS mouse input and never takes focus,
// so the operator keeps working. A probe samples every painted frame for
// document swaps, loading rows and empty inspectors. Stop with a `stop` file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { buildNativeProduction, productionProbeSource, serveNativeProductionAssets } from "./design-native-production.mjs";
import { nativeProductionViteConfiguration } from "./design-native-vite.mjs";
import { readNativeDesignCoverage } from "./design-native-view.mjs";
import { withNativeRendererModules, waitForNativeRenderer } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab, prepareNativeWorkspaceCatalog } from "./design-native-workbench.mjs";
import { observeNativeApplicationProcesses } from "./design-native-memory.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

const option = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const STYLE = `
:root { --ink: #1d1b19; --muted: #6f6a64; --line: #e7e2dc; --accent: #2f6fed; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: var(--ink); background: #fbfaf8; }
.card { display: flex; flex-direction: column; gap: 16px; padding: 32px; background: #ffffff; min-height: 100vh; }
.row { display: flex; flex-direction: row; gap: 12px; align-items: center; }
.btn { padding: 10px 18px; border-radius: 10px; background: var(--accent); color: #fff; font-weight: 600; }
.btn.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.tile { width: 120px; height: 84px; border-radius: 12px; background: #efeae4; }
h1 { margin: 0; font-size: 40px; line-height: 1.1; }
p { margin: 0; font-size: 17px; line-height: 1.5; color: var(--muted); }
.hero { position: relative; width: 100%; height: 100vh; background: #13203b; color: #fff; overflow: hidden; }
.hero .title { position: absolute; left: 48px; top: 64px; font-size: 56px; font-weight: 700; margin: 0; }
.hero .sub { position: absolute; left: 48px; top: 150px; width: 420px; color: #c9d3ea; }
.hero .badge { position: absolute; right: 48px; top: 48px; padding: 6px 12px; border-radius: 999px; background: #2f6fed; }
.list { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 24px; }
.item { display: flex; flex-direction: column; gap: 6px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; }
`;

const FRAMES = {
  "page-1/card.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Card</title>
    <link rel="stylesheet" href="../qa.css" />
  </head>
  <body>
<main class="card" data-zeros-frame-root data-oid="card-root"><h1 data-oid="card-title">Pricing</h1><p data-oid="card-copy">Simple plans for teams of every size. Start free and upgrade when you grow.</p><div class="row" data-oid="card-actions"><span class="btn" data-oid="card-primary">Get started</span><span class="btn ghost" data-oid="card-secondary">Contact sales</span></div><section class="row" data-oid="card-tiles"><div class="tile" data-oid="card-tile-a"></div><div class="tile" data-oid="card-tile-b"></div><div class="tile" data-oid="card-tile-c"></div></section></main>
  </body>
</html>
`,
  "page-1/hero.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hero</title>
    <link rel="stylesheet" href="../qa.css" />
  </head>
  <body>
<section class="hero" data-oid="hero-root"><h1 class="title" data-oid="hero-title">Ship faster</h1><p class="sub" data-oid="hero-sub">Design, review and launch from one place, with every change in your repository.</p><span class="badge" data-oid="hero-badge">New</span></section>
  </body>
</html>
`,
  "page-1/list.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>List</title>
    <link rel="stylesheet" href="../qa.css" />
  </head>
  <body>
<main class="list" data-zeros-frame-root data-oid="list-root"><article class="item" data-oid="list-a"><h3 data-oid="list-a-title">Analytics</h3><p data-oid="list-a-copy">Track every release.</p></article><article class="item" data-oid="list-b"><h3 data-oid="list-b-title">Reviews</h3><p data-oid="list-b-copy">Comment on any frame.</p></article><article class="item" data-oid="list-c"><h3 data-oid="list-c-title">Tokens</h3><p data-oid="list-c-copy">One source of truth.</p></article><article class="item" data-oid="list-d"><h3 data-oid="list-d-title">Pages</h3><p data-oid="list-d-copy">Organize big projects.</p></article></main>
  </body>
</html>
`,
};


// The bench's build: the same production renderer and compiled engine, with a
// lighter staged copy when the disk is nearly full.
async function buildProduction({ repo, root, env, run }) {
  const disk = await fs.statfs(root), free = disk.bavail * disk.bsize;
  if (free >= 4 * 1024 ** 3) return buildNativeProduction({ repo, root, env, run });
  if (free < 2 * 1024 ** 3) throw new Error("The QA build needs at least 2 GiB free.");
  const stage = path.join(root, "app"); await fs.mkdir(stage);
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
    try { await fs.access(path.join(repo, directory)); await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const file of ["package.json", ".github/workflows/release.yml", "scripts/build-sidecar.mjs"]) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(repo, file), path.join(stage, file));
  }
  await fs.writeFile(path.join(root, "engine-build.log"), await run(process.execPath, [path.join(stage, "scripts/build-sidecar.mjs")], { env }));
  await fs.writeFile(path.join(root, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron")], { env }));
  await fs.unlink(path.join(stage, "apps"));
  await fs.mkdir(path.join(stage, "apps/desktop/src"), { recursive: true });
  await fs.symlink(path.join(repo, "apps/desktop/src/engine"), path.join(stage, "apps/desktop/src/engine"), "dir");
  const probe = path.join(root, "qualification.ts");
  await fs.writeFile(probe, productionProbeSource(repo), { flag: "wx" });
  const config = path.join(root, "vite.config.mjs"), output = path.join(stage, "dist");
  await fs.writeFile(config, nativeProductionViteConfiguration(repo, path.join(root, "vite-cache"), output, probe));
  await fs.writeFile(path.join(root, "renderer-build.log"), await run("pnpm", ["exec", "vite", "build", "--mode", "production", "--config", config], { env: { ...env, NODE_ENV: "production" } }));
  const manifest = JSON.parse(await fs.readFile(path.join(output, ".vite/manifest.json"), "utf8"));
  const entry = Object.values(manifest).find(item => item.isEntry && item.name === "qualification");
  if (!entry || typeof entry.file !== "string" || !entry.file.startsWith("assets/")) throw new Error("Production qualification entry is missing.");
  return { stage, output, modulePath: entry.file, diskFreeBytes: free };
}

async function writeFixture(folder, run) {
  const design = path.join(folder, "QA Design");
  await fs.mkdir(path.join(design, "meta"), { recursive: true });
  await fs.mkdir(path.join(design, "page-1"), { recursive: true });
  await fs.writeFile(path.join(design, "meta/design.toml"), 'format = "zeros-design"\nversion = 3\nid = "design_qa"\ncanvas = "canvas.json"\n');
  await fs.writeFile(path.join(design, "qa.css"), STYLE);
  for (const [file, html] of Object.entries(FRAMES)) await fs.writeFile(path.join(design, file), html);
  const canvas = { version: 2,
    pages: [{ id: "page_qa", title: "Page 1", folder: "page-1", frames: ["card", "hero", "list"] }],
    frames: {
      card: { kind: "html", source: "page-1/card.html", title: "Card", x: 0, y: 0, width: 480, height: 640 },
      hero: { kind: "html", source: "page-1/hero.html", title: "Hero", x: 560, y: 0, width: 720, height: 420 },
      list: { kind: "html", source: "page-1/list.html", title: "List", x: 560, y: 500, width: 560, height: 360 },
    } };
  await fs.writeFile(path.join(design, "meta/canvas.json"), JSON.stringify(canvas, null, 2));
  await run("git", ["init", "-q", "-b", "main", folder]);
  await run("git", ["-C", folder, "add", "-A"]);
  await run("git", ["-C", folder, "-c", "user.name=qa", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"]);
}

// Samples each painted frame: per canvas frame, how many document buffers it
// holds and whether its displayed document changed; Layers loading rows; the
// inspector's empty state. Events are kept, bounded; `reset` starts a window.
function installProbe() {
  const probe = globalThis.__qa = globalThis.__qa ?? { events: [], frames: 0, started: performance.now(), last: new Map(), layers: null, inspector: null };
  probe.reset = () => { probe.events = []; probe.frames = 0; probe.started = performance.now(); };
  const push = (kind, detail) => { if (probe.events.length < 4000) probe.events.push([Math.round(performance.now() - probe.started), kind, detail]); };
  if (probe.running) return;
  probe.running = true;
  const ids = new WeakMap(); let next = 1;
  const idOf = (node) => { if (!node) return 0; if (!ids.has(node)) ids.set(node, next++); return ids.get(node); };
  const tick = () => {
    probe.frames++;
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
    const seen = new Set();
    for (const frame of owner?.querySelectorAll("[data-design-frame]") ?? []) {
      const file = frame.getAttribute("data-design-frame");
      seen.add(file);
      const buffers = frame.querySelectorAll("iframe[data-design-document-buffer]");
      const displayed = frame.querySelector('iframe[data-design-document-buffer="displayed"]');
      const state = `${buffers.length}|${idOf(displayed)}|${displayed?.hasAttribute("data-design-document-ready") ? "r" : "-"}|${displayed && getComputedStyle(displayed).visibility === "hidden" ? "h" : "v"}`;
      const before = probe.last.get(file);
      if (before !== state) { push("frame", `${file} ${before ?? "new"} -> ${state}`); probe.last.set(file, state); }
    }
    for (const file of [...probe.last.keys()]) if (!seen.has(file)) { push("frame", `${file} removed`); probe.last.delete(file); }
    const layers = document.querySelector("[data-design-sidebar-panel]");
    const loading = [...(layers?.querySelectorAll("span") ?? [])].some((span) => /^Loading/.test(span.textContent ?? ""));
    if (loading !== probe.layers) { push("layers", loading ? "loading" : "ready"); probe.layers = loading; }
    const header = document.querySelector("[data-design-inspector-header]")?.getAttribute("data-design-selection-type") ?? "none";
    if (header !== probe.inspector) { push("inspector", header); probe.inspector = header; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(process.platform, "darwin", "This QA driver requires macOS.");
  const label = option(args, "--label", "qa");
  assert(/^[A-Za-z0-9._-]{1,40}$/.test(label), "Invalid --label.");
  const gpu = args.includes("--gpu");
  const reuseBuild = option(args, "--reuse-build", null);
  const queue = path.resolve(option(args, "--queue", path.join(os.homedir(), ".zeros-dev/qa")));
  const root = path.join(repo, ".context/design-edit-qa");
  const runId = `${label}-${new Date().toISOString().replace(/[^0-9T]/g, "").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
  const evidence = path.join(root, runId);
  await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
  const inbox = path.join(queue, "inbox"), outbox = path.join(queue, "outbox");
  await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
  await fs.mkdir(outbox, { recursive: true, mode: 0o700 });
  await fs.rm(path.join(queue, "stop"), { force: true });
  const log = (line) => console.log(`QA ${new Date().toISOString()} ${line}`);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("cancelled")));
  process.once("SIGTERM", () => controller.abort(new Error("cancelled")));
  const run = async (command, argv, options = {}) => (await exec(command, argv, { cwd: repo, timeout: 600_000,
    maxBuffer: 32 * 1024 ** 2, signal: controller.signal, ...options })).stdout;
  let app, server;
  try {
    const identity = { slug: `canvas-qa-${runId.slice(-6)}`, name: "Zeros Design QA" };
    const ports = await pickLocalPorts(identity.slug);
    const env = localEnvironment({ identity, ...ports });
    Object.assign(env, { NODE_ENV: "production", ZEROS_NO_MAIN_HMR: "1", ZEROS_NO_ENGINE_HMR: "1" });
    if (gpu) env.ZEROS_DESIGN_RECORDER = "1";
    const watchHostScript = path.join(repo, "apps/desktop/src/engine/git/watch-host.cjs");
    try { await fs.access(watchHostScript); env.ZEROS_WATCH_HOST_SCRIPT = watchHostScript; } catch {}
    log("build");
    const built = reuseBuild ? JSON.parse(await fs.readFile(path.join(reuseBuild, "build.json"), "utf8"))
      : await buildProduction({ repo, root: evidence, env, run });
    if (!reuseBuild) await fs.writeFile(path.join(evidence, "build.json"), JSON.stringify(built));
    server = await serveNativeProductionAssets(built.output, ports.vitePort);
    env.ELECTRON_RENDERER_URL = server.url;
    const folder = path.join(evidence, "project");
    await fs.mkdir(folder);
    await writeFixture(folder, run);
    const fixture = { path: folder, repoRoot: folder, repoSlug: "qa-design", branchName: "main" };
    log("launch");
    app = await launchNativeElectron({ args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", built.stage],
      cwd: folder, env, timeout: 90_000 });
    const mainLog = [];
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.trim() && mainLog.length < 2000) mainLog.push(line.replace(/token=[^\s&]+/g, "token=<redacted>").slice(0, 400));
    });
    await observeNativeApplicationProcesses(app);
    const rawPage = await app.firstWindow({ timeout: 60_000 });
    rawPage.setDefaultTimeout(15_000);
    await rawPage.addInitScript(({ gpu }) => {
      localStorage.setItem("zeros.column2.ratio", "0.1");
      if (gpu) {
        let flags = {};
        try { flags = JSON.parse(localStorage.getItem("zeros.internalFeatures") || "{}") ?? {}; } catch {}
        localStorage.setItem("zeros.internalFeatures", JSON.stringify({ ...flags, designGpuCanvas: true }));
      }
    }, { gpu });
    await rawPage.reload({ waitUntil: "domcontentloaded" });
    const consoleLines = [];
    rawPage.on("console", (message) => {
      if (!["error", "warning"].includes(message.type()) || consoleLines.length >= 2000) return;
      consoleLines.push([Date.now(), message.type(), message.text().slice(0, 500)]);
    });
    rawPage.on("pageerror", (error) => { if (consoleLines.length < 2000) consoleLines.push([Date.now(), "pageerror", String(error).slice(0, 500)]); });
    const page = await withNativeRendererModules(rawPage, { moduleUrl: `${server.url}/${built.modulePath}` });
    await waitForNativeRenderer(page, async () =>
      (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected", undefined, 60_000);
    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const display = screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay();
      const area = display.workArea;
      window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(900, area.height) });
      window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
      window.setAlwaysOnTop(true, "floating");
      window.setIgnoreMouseEvents(true);
      window.showInactive();
    });
    // Keyboard shortcuts need a focused document; the window itself never
    // takes OS focus, so keep Chromium's focus emulation on.
    const cdp = await rawPage.context().newCDPSession(rawPage);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    log("adopt");
    fixture.id = await page.evaluate(async (fixture) => {
      const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged, notifyWorkspacesChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const { workspaceAdoptExisting } = await import("/apps/desktop/src/renderer/platform/git.ts");
      const project = upsertProject({ repoRoot: fixture.path, repoSlug: fixture.repoSlug, isGitRepository: true });
      notifyProjectsChanged();
      const id = (await workspaceAdoptExisting({ repoRoot: fixture.path, worktreePath: fixture.path,
        branchName: fixture.branchName, repoSlug: project.repoSlug, organizationId: null })).workspaceId;
      notifyWorkspacesChanged(project.repoSlug);
      return id;
    }, fixture);
    await prepareNativeWorkspaceCatalog(page, [{ folder: fixture.path, workspaceId: fixture.id }]);
    await page.evaluate(async (fixture) => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: fixture.path, repoRoot: fixture.repoRoot, chatId: null });
    }, fixture);
    await activateNativeWorkbenchTab(page, fixture.path, "design");
    log("open");
    const ready = async (timeout = 60_000, frames = 3) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const coverage = await readNativeDesignCoverage(page).catch(() => null);
        if (coverage?.id === fixture.id && coverage.covered >= frames) return coverage;
        await delay(250);
      }
      return null;
    };
    const opened = await ready();
    log(`ready ${opened}`);
    await rawPage.evaluate(installProbe);
    await rawPage.addInitScript(installProbe);
    const shot = async (name) => {
      const file = path.join(outbox, `${name}.png`);
      await rawPage.screenshot({ path: file });
      return file;
    };
    // Screencast frames for a time window, saved as JPEGs: flicker and swaps
    // that no DOM state reveals still show in the painted frames.
    const screencast = async (name, during, { everyNthFrame = 1, max = 90 } = {}) => {
      const frames = [];
      const onFrame = async ({ data, sessionId, metadata }) => {
        if (frames.length < max) frames.push({ data, at: metadata?.timestamp });
        await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      };
      cdp.on("Page.screencastFrame", onFrame);
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame });
      let result;
      try { result = await during(); } finally {
        await delay(150);
        await cdp.send("Page.stopScreencast").catch(() => {});
        cdp.off("Page.screencastFrame", onFrame);
      }
      const files = [];
      const start = frames[0]?.at ?? 0;
      for (const [index, frame] of frames.entries()) {
        const file = path.join(outbox, `${name}-${String(index).padStart(3, "0")}-${Math.round(((frame.at ?? start) - start) * 1000)}ms.jpg`);
        await fs.writeFile(file, Buffer.from(frame.data, "base64"));
        files.push(path.basename(file));
      }
      return { result, frames: files };
    };
    const ctx = { app, page, rawPage, cdp, fixture, evidence, outbox, shot, screencast, delay, ready,
      console: () => consoleLines.splice(0), mainLog: () => mainLog.splice(0),
      probe: () => rawPage.evaluate(() => ({ events: globalThis.__qa?.events ?? [], frames: globalThis.__qa?.frames ?? 0 })),
      resetProbe: () => rawPage.evaluate(() => globalThis.__qa?.reset?.()),
      design: path.join(fixture.path, "QA Design") };
    await fs.writeFile(path.join(queue, "ready.json"), JSON.stringify({ runId, evidence, fixture, opened, at: new Date().toISOString() }));
    log("serving");
    const done = new Set();
    for (;;) {
      if (controller.signal.aborted) break;
      try { await fs.access(path.join(queue, "stop")); break; } catch {}
      const names = (await fs.readdir(inbox)).filter((name) => /^[A-Za-z0-9_-]+\.mjs$/.test(name) && !done.has(name)).sort();
      for (const name of names) {
        done.add(name);
        const base = name.replace(/\.mjs$/, "");
        const started = performance.now();
        let outcome;
        try {
          const module = await import(`${pathToFileURL(path.join(inbox, name)).href}?${Date.now()}`);
          const result = await Promise.race([module.default(ctx),
            delay(240_000, undefined, { signal: controller.signal }).then(() => { throw new Error("command timed out"); })]);
          outcome = { ok: true, result };
        } catch (error) {
          outcome = { ok: false, error: String(error?.stack ?? error).slice(0, 4000) };
        }
        outcome.ms = Math.round(performance.now() - started);
        outcome.console = consoleLines.splice(0);
        await fs.writeFile(path.join(outbox, `${base}.json`), JSON.stringify(outcome, null, 2));
        log(`ran ${name} ${outcome.ok ? "ok" : "failed"} ${outcome.ms}ms`);
      }
      await delay(300);
    }
  } finally {
    await app?.close().catch(() => {});
    await server?.close?.().catch?.(() => {});
    log("closed");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
